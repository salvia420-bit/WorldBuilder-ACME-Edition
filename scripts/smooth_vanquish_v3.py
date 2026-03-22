#!/usr/bin/env python3
"""
smooth_vanquish_v3.py — Fix QuickWorld terrain using V3 Terrain Diffusion

Reads the vanquish heightmaps (extracted via extract-retail-heightmaps),
classifies each landblock by average height into terrain zones, and applies
V3 SDEdit (img2img) at variable strength per zone:

  Low       (h < 30)  — 15% strength  (coastal, already flat)
  Mid-low   (30-60)   — 35% strength  (plains, worst QuickWorld artifacts)
  Mid       (60-100)  — 25% strength  (rolling hills, smooth pixel edges)
  Mid-high  (100-150) — 20% strength  (foothills, preserve elevation)
  High      (h >= 150)— 10% strength  (mountains, preserve drama)

Output: vanquish_smoothed.jsonl — ready for apply via terminal.

Usage:
    .venv311\\Scripts\\python.exe scripts\\smooth_vanquish_v3.py [--batch 32] [--output vanquish_smoothed.jsonl]
"""

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

# =====================================================================
# Project paths
# =====================================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
INPUT_FILE = PROJECT_ROOT / "pipeline_data" / "heightmaps" / "vanquish_heightmaps.jsonl"
MODEL_FILE = PROJECT_ROOT / "pipeline_data" / "models" / "v3" / "terrain_diffusion_v3.pt"
CONFIG_FILE = PROJECT_ROOT / "pipeline_data" / "models" / "v3" / "terrain_v3_config.json"
BIOME_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "retail_biomes.npy"

GRID_SIZE = 9
MAP_SIZE = 255
T_DIFFUSION = 1000

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# =====================================================================
# Height-zone classification → V3 strength
# =====================================================================
# Terrain zones defined by average block height.
# Lower strength = more preservation of original features.
# Higher strength = more V3 smoothing (fixes QuickWorld pixel artifacts).
HEIGHT_BANDS = [
    # (max_height_exclusive, zone_name)
    (30, "low/coastal"),
    (60, "mid-low/plains"),
    (100, "mid/hills"),
    (150, "mid-high/foothills"),
    (256, "high/mountains"),
]


# =====================================================================
# Import model classes from train_terrain_v3.py
# =====================================================================
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
from train_terrain_v3 import (
    DiffusionUNet,
    DiffusionSchedule,
)


# =====================================================================
# DDIM img2img sampler (SDEdit)
# =====================================================================
@torch.no_grad()
def ddim_img2img(model, schedule, x_start, cond, start_t, n_steps=50):
    """
    SDEdit-style img2img: add noise to x_start at timestep start_t,
    then denoise with DDIM from that point.
    """
    B = cond.shape[0]
    device = cond.device

    step_size = schedule.T // n_steps
    all_timesteps = list(range(0, schedule.T, step_size))
    all_timesteps = list(reversed(all_timesteps))

    timesteps = [t for t in all_timesteps if t <= start_t]
    if len(timesteps) == 0:
        return x_start

    # Forward diffusion to start_t
    noise = torch.randn_like(x_start)
    t_tensor = torch.full((B,), start_t, device=device, dtype=torch.long)
    x, _ = schedule.q_sample(x_start, t_tensor, noise=noise)

    # DDIM denoise
    for i, t in enumerate(timesteps):
        t_batch = torch.full((B,), t, device=device, dtype=torch.long)
        eps_pred = model(x, t_batch, cond)

        alpha_t = schedule.alphas_cumprod[t]
        if i + 1 < len(timesteps):
            alpha_prev = schedule.alphas_cumprod[timesteps[i + 1]]
        else:
            alpha_prev = torch.tensor(1.0, device=device)

        x0_pred = (x - torch.sqrt(1 - alpha_t) * eps_pred) / torch.sqrt(alpha_t)
        dir_xt = torch.sqrt(1 - alpha_prev) * eps_pred
        x = torch.sqrt(alpha_prev) * x0_pred + dir_xt

    return x


# =====================================================================
# Build conditioning tensor
# =====================================================================
def build_condition(coords_batch, grid, biome_grid, height_mean, height_std, n_biomes):
    """Build conditioning tensor (8 neighbor heightmaps + biome one-hot)."""
    neighbor_offsets = [
        (0, 1), (1, 1), (1, 0), (1, -1),
        (0, -1), (-1, -1), (-1, 0), (-1, 1)
    ]

    batch_conds = []
    for (x, y) in coords_batch:
        cond_channels = []

        for dx, dy in neighbor_offsets:
            nx, ny = x + dx, y + dy
            if (nx, ny) in grid:
                h = grid[(nx, ny)].copy()
                h_norm = (h - height_mean) / height_std
            else:
                h_norm = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
            cond_channels.append(h_norm)

        # Biome one-hot
        bx = min(max(x, 0), biome_grid.shape[0] - 1)
        by = min(max(y, 0), biome_grid.shape[1] - 1)
        biome_id = max(0, int(biome_grid[bx, by]))
        for b in range(n_biomes):
            cond_channels.append(
                np.full((GRID_SIZE, GRID_SIZE), 1.0 if b == biome_id else 0.0, dtype=np.float32)
            )

        cond = np.stack(cond_channels, axis=0)
        batch_conds.append(cond)

    return torch.from_numpy(np.stack(batch_conds)).to(DEVICE)


# =====================================================================
# Classify height zone
# =====================================================================
def build_height_zones(args):
    return [
        # (max_height_exclusive, strength, zone_name)
        (30, args.strength_low, "low/coastal"),
        (60, args.strength_midlow, "mid-low/plains"),
        (100, args.strength_mid, "mid/hills"),
        (150, args.strength_midhigh, "mid-high/foothills"),
        (256, args.strength_high, "high/mountains"),
    ]


def classify_zone(avg_height, height_zones):
    """Return (strength, zone_name) for a block's average height."""
    for max_h, strength, name in height_zones:
        if avg_height < max_h:
            return strength, name
    return height_zones[-1][1], height_zones[-1][2]


# =====================================================================
# Main
# =====================================================================
def main():
    parser = argparse.ArgumentParser(description="Smooth Vanquish terrain with V3 diffusion")
    parser.add_argument("--batch", type=int, default=32,
                        help="Batch size for GPU inference (default: 32)")
    parser.add_argument("--output", type=str, default="vanquish_smoothed.jsonl",
                        help="Output JSONL file (default: vanquish_smoothed.jsonl)")
    parser.add_argument("--input", type=str, default=None,
                        help="Input JSONL file (default: vanquish_heightmaps.jsonl)")
    parser.add_argument("--strength-low", type=float, default=0.15,
                        help="V3 strength for low/coastal blocks (avg h < 30)")
    parser.add_argument("--strength-midlow", type=float, default=0.35,
                        help="V3 strength for plains blocks (30 <= avg h < 60)")
    parser.add_argument("--strength-mid", type=float, default=0.25,
                        help="V3 strength for rolling hills (60 <= avg h < 100)")
    parser.add_argument("--strength-midhigh", type=float, default=0.20,
                        help="V3 strength for foothills (100 <= avg h < 150)")
    parser.add_argument("--strength-high", type=float, default=0.10,
                        help="V3 strength for mountains (avg h >= 150)")
    args = parser.parse_args()

    input_file = Path(args.input) if args.input else INPUT_FILE
    output_path = PROJECT_ROOT / args.output
    height_zones = build_height_zones(args)

    print("=" * 70)
    print("  VANQUISH V3 TERRAIN SMOOTHER")
    print("=" * 70)
    print(f"  Zone strengths: low={args.strength_low:.2f}, plains={args.strength_midlow:.2f}, "
          f"hills={args.strength_mid:.2f}, foothills={args.strength_midhigh:.2f}, "
          f"mountains={args.strength_high:.2f}")

    # ── Load V3 config ──
    with open(CONFIG_FILE) as f:
        config = json.load(f)

    height_mean = config["height_mean"]
    height_std = config["height_std"]
    n_biomes = config["n_biomes"]
    cond_channels = config["cond_channels"]
    base_channels = config["base_channels"]
    time_dim = config["time_dim"]

    print(f"\n  V3 Config:")
    print(f"    Height norm:    mean={height_mean:.2f}, std={height_std:.2f}")
    print(f"    Biomes:         {n_biomes}")
    print(f"    Device:         {DEVICE}")

    # ── Load model ──
    print(f"\n  Loading V3 model...")
    model = DiffusionUNet(
        cond_channels=cond_channels,
        base_channels=base_channels,
        time_dim=time_dim,
        dropout=0.0,
    ).to(DEVICE)

    checkpoint = torch.load(MODEL_FILE, map_location=DEVICE, weights_only=True)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()
    print(f"    Loaded from epoch {checkpoint['epoch']}, val_loss={checkpoint['val_loss']:.6f}")
    n_params = sum(p.numel() for p in model.parameters())
    print(f"    Parameters: {n_params/1e6:.1f}M")

    if DEVICE == "cuda":
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"    GPU: {torch.cuda.get_device_name(0)} ({vram:.1f} GB)")

    # ── Load diffusion schedule ──
    schedule = DiffusionSchedule(T_DIFFUSION, DEVICE)

    # ── Load biome grid ──
    print(f"\n  Loading biome grid...")
    if BIOME_FILE.exists():
        biome_grid = np.load(BIOME_FILE)
        print(f"    Shape: {biome_grid.shape}")
    else:
        print(f"    WARNING: {BIOME_FILE} not found, using zeros")
        biome_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)

    # ── Load vanquish heightmaps ──
    print(f"\n  Loading vanquish heightmaps from {input_file}...")
    grid = {}  # (x, y) -> np.array(9, 9) float32
    records = {}  # (x, y) -> full JSONL record (for terrain types, road flags, etc.)

    with open(input_file, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            x, y = rec["lbX"], rec["lbY"]
            heights = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
            grid[(x, y)] = heights
            records[(x, y)] = rec

    print(f"    Loaded {len(grid)} landblocks")

    # ── Classify by height zone ──
    zone_groups = defaultdict(list)  # (strength, zone_name) -> [(x, y), ...]
    for (x, y), heights in grid.items():
        avg_h = np.mean(heights)
        strength, zone_name = classify_zone(avg_h, height_zones)
        zone_groups[(strength, zone_name)].append((x, y))

    print(f"\n  Height zone classification:")
    total_blocks = 0
    for (strength, zone_name), blocks in sorted(zone_groups.items()):
        pct = 100 * len(blocks) / len(grid)
        print(f"    {zone_name:20s} (str={strength:.2f}): {len(blocks):6d} blocks ({pct:5.1f}%)")
        total_blocks += len(blocks)
    print(f"    {'Total':20s}             : {total_blocks:6d} blocks")

    # ── Apply V3 smoothing ──
    smoothed_grid = {}
    t0 = time.time()
    total_processed = 0

    # Process zone by zone, from lowest to highest strength
    # (so neighbors get updated progressively)
    with torch.no_grad():
        for (strength, zone_name), block_list in sorted(zone_groups.items()):
            start_t = int(strength * T_DIFFUSION)

            if start_t < 20:
                # Too low, skip
                for (x, y) in block_list:
                    smoothed_grid[(x, y)] = grid[(x, y)].copy()
                total_processed += len(block_list)
                print(f"\n  {zone_name}: {len(block_list)} blocks — skipped (str too low)")
                continue

            n_steps = max(10, start_t // 20)
            print(f"\n  {zone_name}: {len(block_list)} blocks, "
                  f"str={strength:.2f}, start_t={start_t}, steps={n_steps}")

            # Sort by spiral from center for better neighbor conditioning
            center = MAP_SIZE // 2
            block_list.sort(key=lambda c: abs(c[0] - center) + abs(c[1] - center))

            for batch_start in range(0, len(block_list), args.batch):
                batch_coords = block_list[batch_start:batch_start + args.batch]
                B = len(batch_coords)

                # Build input tensor (normalized heights)
                x0_list = []
                for (x, y) in batch_coords:
                    h = grid[(x, y)]
                    h_norm = (h - height_mean) / height_std
                    x0_list.append(h_norm[None])  # (1, 9, 9)

                x0_batch = torch.from_numpy(np.stack(x0_list)).to(DEVICE)

                # Use smoothed neighbors if available, else original
                merged_grid = {**grid, **smoothed_grid}
                cond = build_condition(
                    batch_coords, merged_grid, biome_grid,
                    height_mean, height_std, n_biomes
                )

                # SDEdit: noise to start_t then denoise
                result = ddim_img2img(model, schedule, x0_batch, cond,
                                      start_t=start_t, n_steps=n_steps)

                # Denormalize and store
                for i, (x, y) in enumerate(batch_coords):
                    h_norm = result[i, 0].cpu().numpy()
                    h_raw = h_norm * height_std + height_mean
                    h_raw = np.clip(np.round(h_raw), 0, 255).astype(np.float32)
                    smoothed_grid[(x, y)] = h_raw

                total_processed += B

                if total_processed % 2000 < args.batch:
                    elapsed = time.time() - t0
                    rate = total_processed / elapsed if elapsed > 0 else 0
                    eta = (len(grid) - total_processed) / rate if rate > 0 else 0
                    print(f"    ...{total_processed}/{len(grid)} blocks "
                          f"({elapsed:.0f}s, ~{eta:.0f}s remaining)")

    elapsed = time.time() - t0
    print(f"\n{'='*70}")
    print(f"  V3 smoothing complete: {total_processed} blocks in {elapsed:.0f}s "
          f"({elapsed/60:.1f} min)")
    print(f"{'='*70}")

    # ── Write output JSONL ──
    print(f"\n  Writing output to {output_path}...")
    count = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for (x, y) in sorted(smoothed_grid.keys()):
            h_raw = smoothed_grid[(x, y)]
            heights = h_raw.flatten().astype(int).tolist()

            # Preserve original terrain types, road flags, etc.
            orig = records.get((x, y), {})

            rec = {
                "lbX": x,
                "lbY": y,
                "lbKey": orig.get("lbKey", f"0x{x:02X}{y:02X}"),
                "heightIndices": heights,
            }

            # Carry forward terrain types if present
            if "terrainTypes" in orig:
                rec["terrainTypes"] = orig["terrainTypes"]
            if "roadFlags" in orig:
                rec["roadFlags"] = orig["roadFlags"]

            f.write(json.dumps(rec) + "\n")
            count += 1

    print(f"  Wrote {count} landblocks")

    # ── Stats comparison ──
    orig_h = np.array([grid[(x, y)].flatten() for (x, y) in sorted(grid.keys())]).flatten()
    smooth_h = np.array([smoothed_grid[(x, y)].flatten() for (x, y) in sorted(smoothed_grid.keys())]).flatten()

    print(f"\n  Height stats comparison:")
    print(f"    {'':12s} {'Original':>10s}  {'Smoothed':>10s}")
    print(f"    {'Mean':12s} {np.mean(orig_h):10.1f}  {np.mean(smooth_h):10.1f}")
    print(f"    {'Std':12s} {np.std(orig_h):10.1f}  {np.std(smooth_h):10.1f}")
    print(f"    {'Min':12s} {np.min(orig_h):10.0f}  {np.min(smooth_h):10.0f}")
    print(f"    {'Max':12s} {np.max(orig_h):10.0f}  {np.max(smooth_h):10.0f}")

    # Per-block difference
    diffs = []
    for (x, y) in grid:
        if (x, y) in smoothed_grid:
            diff = np.mean(np.abs(grid[(x, y)] - smoothed_grid[(x, y)]))
            diffs.append(diff)
    diffs = np.array(diffs)
    print(f"\n  Per-block avg |delta|:")
    print(f"    Mean: {np.mean(diffs):.2f}")
    print(f"    Std:  {np.std(diffs):.2f}")
    print(f"    Max:  {np.max(diffs):.2f}")

    if DEVICE == "cuda":
        alloc = torch.cuda.max_memory_allocated() / 1024**3
        print(f"\n  GPU peak memory: {alloc:.2f} GB")

    print(f"\n  Next steps:")
    print(f"    1. Set up vanquishtest project and apply:")
    print(f"       Use apply_mosaic_world.py pattern or terminal REPL")
    print(f"    2. Export to vanquishtest/")
    print(f"    3. Compare in ACViewer")


if __name__ == "__main__":
    main()
