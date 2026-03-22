#!/usr/bin/env python3
"""
generate_v3_polish.py — V3 Terrain Polish: Add Retail Micro-Detail to Quick-World Heights

Strategy:
  1. Regenerate quick-world heights from world_map_final.png brightness
     (same logic as CommandEngine.QuickWorld: brightness → height 15–200, ±5 noise)
  2. Feed those heights into V3 img2img at LOW mutation (10–20%)
     → V3 adds natural ridges, slopes, and micro-detail
     → But the macro elevation (which blocks are high/low) is preserved
  3. Output JSONL for apply_mutant_world.py

Think of it like this:
  - Quick-world = sculptor's rough clay (right shape, wrong texture)
  - V3 at 15%  = fine sandpaper (smooths into natural terrain feel)

Usage:
    .venv311\\Scripts\\python.exe scripts\\generate_v3_polish.py [--mutation 0.15] [--seed 42]
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
from tqdm import tqdm

# =====================================================================
# Paths
# =====================================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_FILE = PROJECT_ROOT / "pipeline_data" / "models" / "v3" / "terrain_diffusion_v3.pt"
CONFIG_FILE = PROJECT_ROOT / "pipeline_data" / "models" / "v3" / "terrain_v3_config.json"
BIOME_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "retail_biomes.npy"
BIOME_INFO_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "retail_biome_info.json"
BIOME_MAP_FILE = PROJECT_ROOT / "pipeline_data" / "enrichment" / "biome_map.json"
RETAIL_FILE = PROJECT_ROOT / "pipeline_data" / "heightmaps" / "retail_heightmaps.jsonl"
WORLD_MAP_FILE = PROJECT_ROOT / "pipeline_data" / "screenshots" / "world_map_final.png"
ENVCELL_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "envcell_analysis.json"
ENVCELL_GRID_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "envcell_grid.npy"

GRID_SIZE = 9
MAP_SIZE = 255
T_DIFFUSION = 1000
HEIGHT_MIN = 15
HEIGHT_MAX = 200

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# =====================================================================
# Import from training script
# =====================================================================
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
from train_terrain_v3 import DiffusionUNet, DiffusionSchedule, ddim_sample
from generate_v3_world import ddim_img2img, build_ocean_mask, propagate_biomes


# =====================================================================
# Regenerate quick-world heights from image brightness
# =====================================================================
def generate_quickworld_heights(world_map_path, biome_map_path, seed=42):
    """
    Replicate CommandEngine.QuickWorld height logic:
      brightness 0.0–1.0 → height index 15–200
      Per-vertex noise: ±5
    
    Returns dict of (x,y) → np.array(9,9) of raw height indices.
    """
    from PIL import Image

    rng = np.random.RandomState(seed)

    # Load biome map to know which blocks are land
    with open(biome_map_path, encoding="utf-8-sig") as f:
        biome_data = json.load(f)

    land_cells = set()
    for cell in biome_data["cells"]:
        land_cells.add((cell["lbX"], cell["lbY"]))

    print(f"  Biome map: {len(land_cells)} land cells")

    # Load world map image and compute brightness
    img = Image.open(world_map_path).convert("RGB")
    imgW, imgH = img.size
    scaleX = imgW / 2041.0
    scaleY = imgH / 2041.0
    pixels = img.load()
    print(f"  World map: {imgW}x{imgH}, scale: {scaleX:.3f}x{scaleY:.3f}")

    brightness_map = {}
    for lbX in range(MAP_SIZE):
        for lbY in range(MAP_SIZE):
            pixStartX = int(round(lbX * 8 * scaleX))
            pixStartY = int(round((254 - lbY) * 8 * scaleY))

            totalR, totalG, totalB, count = 0, 0, 0, 0
            sampleSize = max(1, int(round(8 * min(scaleX, scaleY))))
            for dx in range(sampleSize):
                for dy in range(sampleSize):
                    px = pixStartX + dx
                    py = pixStartY + dy
                    if 0 <= px < imgW and 0 <= py < imgH:
                        r, g, b = pixels[px, py]
                        totalR += r
                        totalG += g
                        totalB += b
                        count += 1

            if count > 0:
                bri = (totalR + totalG + totalB) / (3.0 * 255.0 * count)
                brightness_map[(lbX, lbY)] = bri

    print(f"  Brightness computed for {len(brightness_map)} blocks")

    # Generate heights
    heights = {}
    for (lbX, lbY) in land_cells:
        bri = brightness_map.get((lbX, lbY), 0.3)
        baseHeight = int(np.clip(HEIGHT_MIN + bri * (HEIGHT_MAX - HEIGHT_MIN),
                                  HEIGHT_MIN, HEIGHT_MAX))

        block = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
        for i in range(GRID_SIZE):
            for j in range(GRID_SIZE):
                variation = rng.randint(-5, 6)
                h = int(np.clip(baseHeight + variation, HEIGHT_MIN, HEIGHT_MAX))
                block[i, j] = h

        heights[(lbX, lbY)] = block

    print(f"  Generated {len(heights)} quick-world height blocks")

    # Stats
    all_h = np.concatenate([h.flatten() for h in heights.values()])
    print(f"  Height stats: mean={np.mean(all_h):.1f}, std={np.std(all_h):.1f}, "
          f"range=[{np.min(all_h):.0f}, {np.max(all_h):.0f}]")

    return heights


# =====================================================================
# Build conditioning from the quick-world data itself + biome grid
# =====================================================================
def build_condition_from_qw(coords_batch, qw_grid, generated_grid, biome_grid,
                             height_mean, height_std, n_biomes):
    """
    Build conditioning using quick-world heights (NOT retail).
    Falls back to already-generated blocks, then quick-world neighbors, then zeros.
    """
    batch_conds = []
    neighbor_offsets = [
        (0, 1), (1, 1), (1, 0), (1, -1),
        (0, -1), (-1, -1), (-1, 0), (-1, 1)
    ]

    for (x, y) in coords_batch:
        cond_channels = []

        for dx, dy in neighbor_offsets:
            nx, ny = x + dx, y + dy
            if (nx, ny) in generated_grid:
                h = generated_grid[(nx, ny)].copy()
                h_norm = (h - height_mean) / height_std
            elif (nx, ny) in qw_grid:
                h = qw_grid[(nx, ny)].copy()
                h_norm = (h - height_mean) / height_std
            else:
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

        cond = np.stack(cond_channels, axis=0)
        batch_conds.append(cond)

    return torch.from_numpy(np.stack(batch_conds)).to(DEVICE)


# =====================================================================
# Main
# =====================================================================
def generate(args):
    print("=" * 70)
    print("  V3 TERRAIN POLISH — Retail + Quick-World Blend")
    print("=" * 70)

    # ── Load V3 config ──
    with open(CONFIG_FILE) as f:
        config = json.load(f)

    height_mean = config["height_mean"]
    height_std = config["height_std"]
    n_biomes = config["n_biomes"]

    print(f"\n  V3 Config:")
    print(f"    Height norm: mean={height_mean:.2f}, std={height_std:.2f}")
    print(f"    Blend:       {args.blend*100:.0f}% retail / {(1-args.blend)*100:.0f}% quick-world")
    print(f"    Mutation:    {args.mutation * 100:.0f}% V3 smoothing")
    print(f"    Seed:        {args.seed}")

    # ── Load V3 model ──
    print(f"\n  Loading V3 model...")
    model = DiffusionUNet(
        cond_channels=config["cond_channels"],
        base_channels=config["base_channels"],
        time_dim=config["time_dim"],
        dropout=0.0,
    ).to(DEVICE)

    checkpoint = torch.load(MODEL_FILE, map_location=DEVICE, weights_only=True)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()
    print(f"    Loaded from epoch {checkpoint['epoch']}, val_loss={checkpoint['val_loss']:.6f}")

    schedule = DiffusionSchedule(T_DIFFUSION, DEVICE)
    mutation_t = int(args.mutation * T_DIFFUSION)
    print(f"    Mutation timestep: {mutation_t}/{T_DIFFUSION}")

    # ── Load biome grid ──
    print(f"\n  Loading biome grid...")
    biome_grid = np.load(BIOME_FILE)

    # ── Generate quick-world heights from image ──
    print(f"\n  Generating quick-world heights from {WORLD_MAP_FILE.name}...")
    qw_grid = generate_quickworld_heights(WORLD_MAP_FILE, BIOME_MAP_FILE, seed=args.seed)

    # ── Load retail heightmaps ──
    print(f"\n  Loading retail heightmaps...")
    retail_grid = {}
    retail_terrain_types = {}
    with open(RETAIL_FILE, "r", encoding="utf-8-sig") as f:
        for line in f:
            rec = json.loads(line)
            retail_grid[(rec["lbX"], rec["lbY"])] = np.array(
                rec["heightIndices"], dtype=np.float32).reshape(9, 9)
            if "terrainTypes" in rec:
                retail_terrain_types[(rec["lbX"], rec["lbY"])] = rec["terrainTypes"]
    print(f"    {len(retail_grid)} retail blocks loaded")
    print(f"    {len(retail_terrain_types)} blocks with terrain types")

    # ── Blend retail + quick-world ──
    blend_ratio = args.blend
    print(f"\n  Blending: {blend_ratio*100:.0f}% retail + {(1-blend_ratio)*100:.0f}% quick-world...")
    blend_grid = {}
    blend_only_retail = 0
    blend_only_qw = 0
    blend_both = 0

    # All blocks that exist in either grid
    all_coords = set(retail_grid.keys()) | set(qw_grid.keys())
    for coord in all_coords:
        has_retail = coord in retail_grid
        has_qw = coord in qw_grid

        if has_retail and has_qw:
            # Blend: retail micro-detail + quick-world macro elevation
            blend_grid[coord] = blend_ratio * retail_grid[coord] + (1 - blend_ratio) * qw_grid[coord]
            blend_both += 1
        elif has_retail:
            # Ocean/retail-only: keep retail unchanged
            blend_grid[coord] = retail_grid[coord]
            blend_only_retail += 1
        else:
            # QW-only (new land not in retail): use QW
            blend_grid[coord] = qw_grid[coord]
            blend_only_qw += 1

    print(f"    Blended (both):     {blend_both}")
    print(f"    Retail only (ocean): {blend_only_retail}")
    print(f"    QW only (new land):  {blend_only_qw}")
    print(f"    Total:               {len(blend_grid)}")

    # ── Load biome terrain type mapping ──
    biome_terrain_map = {}
    with open(BIOME_MAP_FILE, encoding="utf-8-sig") as f:
        bm = json.load(f)
    for cell in bm["cells"]:
        biome_terrain_map[(cell["lbX"], cell["lbY"])] = cell.get("terrainTypeId", 3)

    # ── Identify land blocks for V3 polish ──
    land_blocks = [c for c in sorted(blend_grid.keys()) if c in qw_grid]
    ocean_blocks = [c for c in sorted(blend_grid.keys()) if c not in qw_grid]

    print(f"\n  Block classification:")
    print(f"    Land (V3 polish):    {len(land_blocks)}")
    print(f"    Ocean (keep as-is):  {len(ocean_blocks)}")

    # ── Polish with V3 ──
    print(f"\n{'='*70}")
    print(f"  Polishing {len(land_blocks)} land blocks with V3 at {args.mutation*100:.0f}% mutation")
    print(f"  Blend: {blend_ratio*100:.0f}% retail + {(1-blend_ratio)*100:.0f}% quick-world")
    print(f"{'='*70}")

    generated_grid = {}
    # Pre-add ocean blocks (unchanged)
    for coord in ocean_blocks:
        generated_grid[coord] = blend_grid[coord]

    center = MAP_SIZE // 2
    land_blocks.sort(key=lambda c: abs(c[0] - center) + abs(c[1] - center))

    t0 = time.time()
    for batch_start in tqdm(range(0, len(land_blocks), args.batch),
                            desc="  polishing", 
                            total=(len(land_blocks) + args.batch - 1) // args.batch):
        batch_coords = land_blocks[batch_start:batch_start + args.batch]

        # Build input from BLENDED heights
        input_batch = []
        for (x, y) in batch_coords:
            blended_h = blend_grid[(x, y)]
            blended_norm = (blended_h - height_mean) / height_std
            input_batch.append(blended_norm)

        input_tensor = torch.from_numpy(
            np.stack([b[None] for b in input_batch])
        ).to(DEVICE)

        # Build conditioning from blended neighbors
        cond = build_condition_from_qw(
            batch_coords, blend_grid, generated_grid, biome_grid,
            height_mean, height_std, n_biomes
        )

        # V3 img2img at low mutation
        result = ddim_img2img(model, schedule, input_tensor, cond,
                               start_t=mutation_t, n_steps=50)

        # Denormalize and store
        for i, (x, y) in enumerate(batch_coords):
            h_norm = result[i, 0].cpu().numpy()
            h_raw = h_norm * height_std + height_mean
            h_raw = np.clip(np.round(h_raw), 0, 255).astype(np.uint8)
            generated_grid[(x, y)] = h_raw.astype(np.float32)

    elapsed = time.time() - t0

    # ── Write output ──
    output_path = PROJECT_ROOT / args.output
    print(f"\n  Writing {len(generated_grid)} blocks to {output_path}...")

    with open(output_path, "w", encoding="utf-8") as f:
        for (x, y) in sorted(generated_grid.keys()):
            h_raw = generated_grid[(x, y)]

            # Terrain types: use biome_map.json types (matches new world layout),
            # fall back to retail types only for blocks not in biome map
            if (x, y) in biome_terrain_map:
                tt = biome_terrain_map[(x, y)]
                terrain_types = [tt] * 81
            elif (x, y) in retail_terrain_types:
                terrain_types = retail_terrain_types[(x, y)]
            else:
                terrain_types = [3] * 81  # default LushGrass

            rec = {
                "lbX": x,
                "lbY": y,
                "lbKey": (x << 8) | y,
                "heightIndices": h_raw.flatten().astype(int).tolist(),
                "terrainTypes": terrain_types,
            }
            f.write(json.dumps(rec) + "\n")

    # ── Stats ──
    land_h = np.concatenate([generated_grid[c].flatten() for c in land_blocks if c in generated_grid])
    blend_h = np.concatenate([blend_grid[c].flatten() for c in land_blocks if c in blend_grid])

    gen_stds = [np.std(generated_grid[c]) for c in land_blocks if c in generated_grid]
    blend_stds = [np.std(blend_grid[c]) for c in land_blocks if c in blend_grid]

    print(f"\n{'='*70}")
    print(f"  Polish complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"{'='*70}")
    print(f"\n  Blend input (land blocks):")
    print(f"    Mean height:     {np.mean(blend_h):.1f}")
    print(f"    Mean block std:  {np.mean(blend_stds):.2f}")
    print(f"\n  V3 polished output (land blocks):")
    print(f"    Mean height:     {np.mean(land_h):.1f}")
    print(f"    Mean block std:  {np.mean(gen_stds):.2f}")
    print(f"    Height range:    [{np.min(land_h):.0f}, {np.max(land_h):.0f}]")
    print(f"\n  Total output: {len(generated_grid)} blocks")
    print(f"    Land (polished):   {len(land_blocks)}")
    print(f"    Ocean (unchanged): {len(ocean_blocks)}")

    print(f"\n  Next steps:")
    print(f"    .venv311\\Scripts\\python.exe scripts\\apply_mutant_world.py")
    print(f"    Then: export, boot ACE server, fly around!")


def main():
    parser = argparse.ArgumentParser(description="V3 Terrain Polish")
    parser.add_argument("--blend", type=float, default=0.5,
                        help="Blend ratio. 0.5=50/50 retail+QW, 0.7=70%% retail, 0.3=30%% retail. Default: 0.5")
    parser.add_argument("--mutation", type=float, default=0.15,
                        help="V3 smoothing strength. 0.10=very light, 0.20=moderate. Default: 0.15")
    parser.add_argument("--batch", type=int, default=64,
                        help="Batch size for GPU. Default: 64")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for quick-world height noise. Default: 42")
    parser.add_argument("--output", type=str, default="mutant_heightmaps.jsonl",
                        help="Output file. Default: mutant_heightmaps.jsonl")
    args = parser.parse_args()

    assert 0.0 <= args.blend <= 1.0, "Blend must be 0-1"
    assert 0.0 <= args.mutation <= 1.0, "Mutation must be 0-1"
    generate(args)


if __name__ == "__main__":
    main()
