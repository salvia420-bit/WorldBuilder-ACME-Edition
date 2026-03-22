#!/usr/bin/env python3
"""
generate_v3_world.py — Mutant Dereth: V3 Terrain Diffusion World Generator

Three-layer terrain blend that produces a world veteran AC players will find
recognizable but deeply wrong:
  1. Blend retail + quick-world heightmaps (50/50)
  2. V3 img2img (SDEdit at 50% mutation) smooths the blend
  3. Former-ocean blocks get pure V3 generation (100% mutation)

Four contiguous dungeon-storage regions remain ocean.
All other former-ocean gets new land.

Output: JSONL file matching retail_heightmaps.jsonl format.

Usage:
    .venv311\\Scripts\\python.exe scripts\\generate_v3_world.py [--mutation 0.5] [--batch 64] [--output mutant_heightmaps.jsonl]
"""

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from tqdm import tqdm

# =====================================================================
# Project paths
# =====================================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
RETAIL_FILE = PROJECT_ROOT / "retail_heightmaps.jsonl"
MODEL_FILE = PROJECT_ROOT / "models" / "v3" / "terrain_diffusion_v3.pt"
CONFIG_FILE = PROJECT_ROOT / "models" / "v3" / "terrain_v3_config.json"
BIOME_FILE = PROJECT_ROOT / "data" / "retail_biomes.npy"
BIOME_INFO_FILE = PROJECT_ROOT / "data" / "retail_biome_info.json"
ENVCELL_FILE = PROJECT_ROOT / "data" / "envcell_analysis.json"
ENVCELL_GRID_FILE = PROJECT_ROOT / "data" / "envcell_grid.npy"
PROJECT_DB = PROJECT_ROOT / "TestProject" / "project.db"

GRID_SIZE = 9
MAP_SIZE = 255
T_DIFFUSION = 1000

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# =====================================================================
# Import model classes from train_terrain_v3.py
# =====================================================================
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
from train_terrain_v3 import (
    DiffusionUNet,
    DiffusionSchedule,
    ddim_sample,
)


# =====================================================================
# DDIM img2img sampler (SDEdit: start from noised blend, not pure noise)
# =====================================================================
@torch.no_grad()
def ddim_img2img(model, schedule, x_start, cond, start_t, n_steps=50, eta=0.0):
    """
    SDEdit-style img2img: add noise to x_start at timestep start_t,
    then denoise with DDIM from that point.

    start_t: timestep to noise to (0=no change, T=pure generation)
             Typical: 500 for 50% mutation
    """
    B = cond.shape[0]
    device = cond.device

    # Create timestep subsequence
    step_size = schedule.T // n_steps
    all_timesteps = list(range(0, schedule.T, step_size))
    all_timesteps = list(reversed(all_timesteps))

    # Filter to only timesteps <= start_t
    timesteps = [t for t in all_timesteps if t <= start_t]
    if len(timesteps) == 0:
        return x_start  # No mutation needed

    # Add noise to x_start at start_t level
    noise = torch.randn_like(x_start)
    t_tensor = torch.full((B,), start_t, device=device, dtype=torch.long)
    x, _ = schedule.q_sample(x_start, t_tensor, noise=noise)

    # Denoise from start_t down to 0
    for i, t in enumerate(timesteps):
        t_batch = torch.full((B,), t, device=device, dtype=torch.long)

        # Predict noise
        eps_pred = model(x, t_batch, cond)

        # DDIM step
        alpha_t = schedule.alphas_cumprod[t]
        if i + 1 < len(timesteps):
            alpha_prev = schedule.alphas_cumprod[timesteps[i + 1]]
        else:
            alpha_prev = torch.tensor(1.0, device=device)

        # Predicted x0
        x0_pred = (x - torch.sqrt(1 - alpha_t) * eps_pred) / torch.sqrt(alpha_t)

        # Direction pointing to x_t
        sigma = eta * torch.sqrt((1 - alpha_prev) / (1 - alpha_t)) * torch.sqrt(1 - alpha_t / alpha_prev)
        dir_xt = torch.sqrt(1 - alpha_prev - sigma**2) * eps_pred

        noise_term = torch.randn_like(x) if eta > 0 and i < len(timesteps) - 1 else 0
        x = torch.sqrt(alpha_prev) * x0_pred + dir_xt + sigma * noise_term

    return x


# =====================================================================
# Quick-world data decoder (MemoryPack binary from project.db)
# =====================================================================
def load_quickworld_heights(db_path):
    """
    Load quick-world heightmaps from project.db.

    The TerrainDocument is stored as MemoryPack-serialized TerrainData,
    which contains Dictionary<ushort, uint[]> Landblocks.

    Each uint encodes: Road | (Scenery << 8) | (Type << 16) | (Height << 24)
    We extract Height = (uint >> 24) & 0xFF.

    MemoryPack format for this structure:
    - TerrainData is a record with: Dictionary<ushort, uint[]> Landblocks, List<TerrainLayerBase>? RootItems
    - We need to parse the MemoryPack binary format.
    """
    import sqlite3

    if not db_path.exists():
        print(f"  WARNING: Quick-world DB not found at {db_path}")
        return {}

    conn = sqlite3.connect(str(db_path))
    cursor = conn.execute("SELECT Data FROM Documents WHERE Id='terrain'")
    row = cursor.fetchone()
    conn.close()

    if row is None:
        print("  WARNING: No terrain document in project.db")
        return {}

    blob = row[0]
    print(f"  Quick-world terrain blob: {len(blob):,} bytes")

    # Parse MemoryPack binary format
    # MemoryPack Dictionary<ushort, uint[]>:
    #   - 4 bytes: count (int32)
    #   - For each entry:
    #     - 2 bytes: key (ushort)
    #     - 4 bytes: array length (int32)
    #     - N * 4 bytes: array data (uint32[])
    #
    # TerrainData has two fields:
    #   1. Dictionary<ushort, uint[]> Landblocks
    #   2. List<TerrainLayerBase>? RootItems
    #
    # MemoryPack writes them in order. The dictionary comes first.

    grid = {}
    offset = 0

    try:
        # MemoryPack record header: first byte is member count (2 for TerrainData)
        member_count = blob[0]
        offset = 1
        print(f"  MemoryPack member count: {member_count}")

        # Read dictionary count (first field: Dictionary<ushort, uint[]> Landblocks)
        count = struct.unpack_from('<i', blob, offset)[0]
        offset += 4
        print(f"  Dictionary entries: {count}")

        for _ in range(count):
            # Read key (ushort = 2 bytes)
            key = struct.unpack_from('<H', blob, offset)[0]
            offset += 2

            # Read array length
            arr_len = struct.unpack_from('<i', blob, offset)[0]
            offset += 4

            # Read array data
            arr = struct.unpack_from(f'<{arr_len}I', blob, offset)
            offset += arr_len * 4

            # Decode heights: Height = (uint >> 24) & 0xFF
            lbX = (key >> 8) & 0xFF
            lbY = key & 0xFF
            heights = [(v >> 24) & 0xFF for v in arr]
            grid[(lbX, lbY)] = np.array(heights, dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)

        print(f"  Loaded {len(grid)} quick-world landblocks")

    except Exception as e:
        print(f"  WARNING: Failed to parse MemoryPack binary: {e}")
        print(f"  Offset at failure: {offset}")
        # Try alternative: treat entire blob as flat MemoryPack
        # This can happen if the format has extra header bytes
        return {}

    return grid


# =====================================================================
# Ocean mask: identify contiguous dungeon-storage regions
# =====================================================================
def build_ocean_mask(envcell_file, envcell_grid_file):
    """
    Build a 255x255 boolean mask where True = ocean (keep as water).

    Only the large contiguous dungeon-storage regions stay as ocean.
    The two largest regions from envcell_analysis.json (size >= 100) are the
    "left border strip" and "inner sea L-shape". Plus any border bars.
    """
    mask = np.zeros((MAP_SIZE, MAP_SIZE), dtype=bool)

    with open(envcell_file) as f:
        analysis = json.load(f)

    # Load the actual env cell grid to identify which cells belong to large regions
    envcell_grid = np.load(envcell_grid_file)

    # The large contiguous dungeon-storage regions
    # From the analysis: regions with size >= 100 are the major zones
    # Region 0: size=1027, x=0-6, y=0-254 (left border strip)
    # Region 1: size=681, x=77-102, y=66-122 (inner sea L-shape)
    # Region 2: size=176, x=114-153, y=0-4 (bottom border bar)
    major_regions = [r for r in analysis["regions"] if r["size"] >= 100]

    print(f"\n  Ocean mask: {len(major_regions)} major dungeon-storage regions")
    ocean_count = 0

    for region in major_regions:
        min_x, max_x = region["min_x"], region["max_x"]
        min_y, max_y = region["min_y"], region["max_y"]
        size = region["size"]
        print(f"    Region: x=[{min_x},{max_x}] y=[{min_y},{max_y}] size={size} type={region['type']}")

        # Mark all env-cell blocks within this region's bounding box as ocean
        for x in range(min_x, min(max_x + 1, MAP_SIZE)):
            for y in range(min_y, min(max_y + 1, MAP_SIZE)):
                if x < envcell_grid.shape[0] and y < envcell_grid.shape[1]:
                    if envcell_grid[x, y]:
                        mask[x, y] = True
                        ocean_count += 1

    print(f"  Total ocean blocks: {ocean_count}")
    return mask


# =====================================================================
# Biome propagation for former-ocean blocks
# =====================================================================
def propagate_biomes(biome_grid, ocean_mask, retail_grid):
    """
    For blocks that were ocean in retail (no data) and aren't in our ocean mask,
    assign biome from nearest land neighbor. Uses BFS flood-fill.
    """
    extended = biome_grid.copy()
    needs_biome = set()

    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if (x, y) not in retail_grid and not ocean_mask[x, y]:
                needs_biome.add((x, y))

    if not needs_biome:
        return extended

    print(f"\n  Propagating biomes to {len(needs_biome)} former-ocean blocks...")

    # BFS from all land blocks
    from collections import deque
    queue = deque()
    visited = set()

    # Seed with all blocks that have retail data
    for (x, y) in retail_grid:
        if x < MAP_SIZE and y < MAP_SIZE:
            queue.append((x, y))
            visited.add((x, y))

    while queue and needs_biome:
        cx, cy = queue.popleft()
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE and (nx, ny) not in visited:
                visited.add((nx, ny))
                bx = min(cx, biome_grid.shape[0] - 1)
                by = min(cy, biome_grid.shape[1] - 1)
                extended[min(nx, MAP_SIZE - 1), min(ny, MAP_SIZE - 1)] = extended[bx, by]
                needs_biome.discard((nx, ny))
                queue.append((nx, ny))

    print(f"  Remaining unassigned: {len(needs_biome)}")
    return extended


# =====================================================================
# Build conditioning tensor for a batch of blocks
# =====================================================================
def build_condition(coords_batch, generated_grid, retail_grid, biome_grid,
                    height_mean, height_std, n_biomes):
    """
    Build conditioning tensor (8 neighbor heightmaps + biome one-hot) for a batch.

    Uses already-generated blocks as neighbors when available, falls back to
    retail data, then zeros for still-ungenerated neighbors.
    """
    batch_conds = []

    neighbor_offsets = [
        (0, 1), (1, 1), (1, 0), (1, -1),
        (0, -1), (-1, -1), (-1, 0), (-1, 1)
    ]

    for (x, y) in coords_batch:
        cond_channels = []

        # 8 neighbor heightmaps (normalized)
        for dx, dy in neighbor_offsets:
            nx, ny = x + dx, y + dy
            if (nx, ny) in generated_grid:
                # Already generated — use that
                h = generated_grid[(nx, ny)].copy()
                h_norm = (h - height_mean) / height_std
            elif (nx, ny) in retail_grid:
                # Use retail data
                h = np.array(retail_grid[(nx, ny)]["heightIndices"],
                             dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
                h_norm = (h - height_mean) / height_std
            else:
                # No data (ocean or out of bounds)
                h_norm = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)

            cond_channels.append(h_norm)

        # Biome one-hot
        bx = min(x, biome_grid.shape[0] - 1)
        by = min(y, biome_grid.shape[1] - 1)
        biome_id = max(0, int(biome_grid[bx, by]))
        biome_onehot = np.zeros(n_biomes, dtype=np.float32)
        biome_onehot[biome_id] = 1.0

        for b in range(n_biomes):
            cond_channels.append(
                np.full((GRID_SIZE, GRID_SIZE), biome_onehot[b], dtype=np.float32)
            )

        cond = np.stack(cond_channels, axis=0)  # (20, 9, 9)
        batch_conds.append(cond)

    return torch.from_numpy(np.stack(batch_conds)).to(DEVICE)


# =====================================================================
# Main generation
# =====================================================================
def generate(args):
    print("=" * 70)
    print("  MUTANT DERETH — V3 Terrain Diffusion World Generator")
    print("=" * 70)

    # ── Load config ──
    with open(CONFIG_FILE) as f:
        config = json.load(f)

    height_mean = config["height_mean"]
    height_std = config["height_std"]
    n_biomes = config["n_biomes"]
    cond_channels = config["cond_channels"]
    base_channels = config["base_channels"]
    time_dim = config["time_dim"]

    print(f"\n  V3 Config:")
    print(f"    Best val loss:  {config['best_val_loss']:.6f}")
    print(f"    Epochs trained: {config['epochs_trained']}")
    print(f"    Parameters:     {config['parameters']:,}")
    print(f"    Height norm:    mean={height_mean:.2f}, std={height_std:.2f}")
    print(f"    Biomes:         {n_biomes}")
    print(f"    Cond channels:  {cond_channels}")
    print(f"    Mutation:       {args.mutation * 100:.0f}%")
    print(f"    Device:         {DEVICE}")

    # ── Load model ──
    print(f"\n  Loading V3 model...")
    model = DiffusionUNet(
        cond_channels=cond_channels,
        base_channels=base_channels,
        time_dim=time_dim,
        dropout=0.0,  # No dropout for inference
    ).to(DEVICE)

    checkpoint = torch.load(MODEL_FILE, map_location=DEVICE, weights_only=True)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()
    print(f"    Loaded from epoch {checkpoint['epoch']}, val_loss={checkpoint['val_loss']:.6f}")

    if DEVICE == "cuda":
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"    GPU: {torch.cuda.get_device_name(0)} ({vram:.1f} GB)")

    # ── Load diffusion schedule ──
    schedule = DiffusionSchedule(T_DIFFUSION, DEVICE)

    # ── Calculate mutation timestep ──
    mutation_t = int(args.mutation * T_DIFFUSION)
    print(f"    Mutation timestep: {mutation_t}/{T_DIFFUSION}")

    # ── Load biome grid ──
    print(f"\n  Loading biome grid...")
    biome_grid = np.load(BIOME_FILE)
    with open(BIOME_INFO_FILE) as f:
        biome_info = json.load(f)
    print(f"    {biome_info['n_clusters']} biome clusters")

    # ── Load retail heightmaps ──
    print(f"\n  Loading retail heightmaps...")
    retail_grid = {}
    with open(RETAIL_FILE, "r", encoding="utf-8-sig") as f:
        for line in tqdm(f, desc="  Reading JSONL", total=65025):
            rec = json.loads(line)
            retail_grid[(rec["lbX"], rec["lbY"])] = rec
    print(f"    {len(retail_grid)} retail blocks loaded")

    # ── Load quick-world heightmaps ──
    print(f"\n  Loading quick-world heightmaps...")
    qw_grid = load_quickworld_heights(PROJECT_DB)
    print(f"    {len(qw_grid)} quick-world blocks loaded")

    # ── Build ocean mask ──
    print(f"\n  Building ocean mask...")
    ocean_mask = build_ocean_mask(ENVCELL_FILE, ENVCELL_GRID_FILE)

    # ── Propagate biomes to former-ocean ──
    extended_biomes = propagate_biomes(biome_grid, ocean_mask, retail_grid)

    # ── Classify all blocks ──
    blend_blocks = []       # Have retail + optional quick-world → img2img
    pure_gen_blocks = []    # Former ocean, not in ocean mask → pure generation
    ocean_blocks = []       # Stay as ocean (contiguous dungeon zones)

    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if ocean_mask[x, y]:
                ocean_blocks.append((x, y))
            elif (x, y) in retail_grid:
                blend_blocks.append((x, y))
            else:
                pure_gen_blocks.append((x, y))

    total = len(blend_blocks) + len(pure_gen_blocks) + len(ocean_blocks)
    print(f"\n  Block classification ({total} total):")
    print(f"    Blend (retail+QW -> img2img): {len(blend_blocks)}")
    print(f"    Pure V3 generation:          {len(pure_gen_blocks)}")
    print(f"    Ocean (dungeon storage):     {len(ocean_blocks)}")

    # ── Generate! ──
    generated_grid = {}  # (x,y) -> heights as np.array (9,9) raw values
    output_records = []
    t0 = time.time()

    # --- Pass 1: Blend + img2img for retail blocks ---
    if blend_blocks:
        print(f"\n{'='*70}")
        print(f"  Pass 1: Blend + V3 img2img  ({len(blend_blocks)} blocks)")
        print(f"{'='*70}")

        # Process in spiral order from center outward for better neighbor conditioning
        center = MAP_SIZE // 2
        blend_blocks.sort(key=lambda c: abs(c[0] - center) + abs(c[1] - center))

        for batch_start in tqdm(range(0, len(blend_blocks), args.batch),
                                desc="  img2img", total=(len(blend_blocks) + args.batch - 1) // args.batch):
            batch_coords = blend_blocks[batch_start:batch_start + args.batch]

            # Build blended input
            blended_batch = []
            for (x, y) in batch_coords:
                retail_h = np.array(retail_grid[(x, y)]["heightIndices"],
                                    dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)

                if (x, y) in qw_grid:
                    qw_h = qw_grid[(x, y)]
                    blended = 0.5 * retail_h + 0.5 * qw_h
                else:
                    blended = retail_h

                # Normalize
                blended_norm = (blended - height_mean) / height_std
                blended_batch.append(blended_norm)

            blended_tensor = torch.from_numpy(
                np.stack([b[None] for b in blended_batch])  # (B, 1, 9, 9)
            ).to(DEVICE)

            # Build conditioning
            cond = build_condition(batch_coords, generated_grid, retail_grid,
                                   extended_biomes, height_mean, height_std, n_biomes)

            # V3 img2img
            result = ddim_img2img(model, schedule, blended_tensor, cond,
                                  start_t=mutation_t, n_steps=50)

            # Denormalize and store
            for i, (x, y) in enumerate(batch_coords):
                h_norm = result[i, 0].cpu().numpy()
                h_raw = h_norm * height_std + height_mean
                h_raw = np.clip(np.round(h_raw), 0, 255).astype(np.uint8)
                generated_grid[(x, y)] = h_raw.astype(np.float32)

    # --- Pass 2: Pure generation for former-ocean blocks ---
    if pure_gen_blocks:
        print(f"\n{'='*70}")
        print(f"  Pass 2: Pure V3 generation  ({len(pure_gen_blocks)} blocks)")
        print(f"{'='*70}")

        # Sort so blocks adjacent to already-generated land come first
        def adjacency_score(coord):
            x, y = coord
            score = 0
            for dx in [-1, 0, 1]:
                for dy in [-1, 0, 1]:
                    if (dx, dy) == (0, 0):
                        continue
                    if (x + dx, y + dy) in generated_grid or (x + dx, y + dy) in retail_grid:
                        score += 1
            return -score  # Negative so higher adjacency comes first

        pure_gen_blocks.sort(key=adjacency_score)

        for batch_start in tqdm(range(0, len(pure_gen_blocks), args.batch),
                                desc="  pure gen", total=(len(pure_gen_blocks) + args.batch - 1) // args.batch):
            batch_coords = pure_gen_blocks[batch_start:batch_start + args.batch]

            # Build conditioning
            cond = build_condition(batch_coords, generated_grid, retail_grid,
                                   extended_biomes, height_mean, height_std, n_biomes)

            # Pure DDIM sampling (100% noise → full denoise)
            result = ddim_sample(model, schedule, cond, n_steps=50)

            # Denormalize and store
            for i, (x, y) in enumerate(batch_coords):
                h_norm = result[i, 0].cpu().numpy()
                h_raw = h_norm * height_std + height_mean
                h_raw = np.clip(np.round(h_raw), 0, 255).astype(np.uint8)
                generated_grid[(x, y)] = h_raw.astype(np.float32)

    # ── Write output JSONL ──
    elapsed = time.time() - t0
    print(f"\n{'='*70}")
    print(f"  Generation complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"{'='*70}")

    output_path = PROJECT_ROOT / args.output
    print(f"\n  Writing output to {output_path}...")

    count = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for (x, y) in sorted(generated_grid.keys()):
            h_raw = generated_grid[(x, y)]
            heights = h_raw.flatten().astype(int).tolist()

            # Compute lbKey (same as retail format)
            lb_key = (x << 8) | y

            rec = {
                "lbX": x,
                "lbY": y,
                "lbKey": lb_key,
                "heightIndices": heights,
            }
            f.write(json.dumps(rec) + "\n")
            count += 1

    print(f"  Wrote {count} landblocks to {args.output}")
    print(f"  Ocean blocks skipped: {len(ocean_blocks)}")

    # ── Stats ──
    all_h = []
    for h in generated_grid.values():
        all_h.extend(h.flatten().tolist())
    all_h = np.array(all_h)
    print(f"\n  Generated height stats:")
    print(f"    Mean:  {np.mean(all_h):.1f}")
    print(f"    Std:   {np.std(all_h):.1f}")
    print(f"    Range: [{np.min(all_h):.0f}, {np.max(all_h):.0f}]")

    if DEVICE == "cuda":
        alloc = torch.cuda.max_memory_allocated() / 1024**3
        print(f"\n  GPU peak memory: {alloc:.2f} GB")

    print(f"\n  Next steps:")
    print(f"    1. Load in WorldBuilder terminal:")
    print(f"       wb> load TestProject\\TestProject.wbproj")
    print(f"    2. Apply heightmaps from JSONL (use set-landblock-heightmap)")
    print(f"    3. wb> auto-paint")
    print(f"    4. wb> validate-terrain 128 128")
    print(f"    5. wb> ace-db reposition")
    print(f"    6. wb> export TestProject\\output")


def main():
    parser = argparse.ArgumentParser(description="Mutant Dereth V3 World Generator")
    parser.add_argument("--mutation", type=float, default=0.5,
                        help="Mutation strength (0.0=no change, 1.0=full rewrite). Default: 0.5")
    parser.add_argument("--batch", type=int, default=64,
                        help="Batch size for GPU inference. Default: 64")
    parser.add_argument("--output", type=str, default="mutant_heightmaps.jsonl",
                        help="Output JSONL filename. Default: mutant_heightmaps.jsonl")
    args = parser.parse_args()

    assert 0.0 <= args.mutation <= 1.0, "Mutation must be between 0 and 1"
    assert args.batch > 0, "Batch size must be positive"

    generate(args)


if __name__ == "__main__":
    main()
