#!/usr/bin/env python3
"""
extract_feature_patches.py -- Phase 3: Extract heightmap patches for each feature.

For each segmented feature, extracts the raw 9x9 heightmap data and terrain types
for every landblock in its mask. Stores as a single numpy archive.

Outputs: data/feature_patches.npz (all features in one file)

Usage:
    python scripts/extract_feature_patches.py
"""

import json
import numpy as np
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEIGHTMAP_FILE = PROJECT_ROOT / "pipeline_data" / "heightmaps" / "retail_heightmaps.jsonl"
FEATURE_MAP_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "feature_map.npy"
CATALOG_FILE = PROJECT_ROOT / "pipeline_data" / "data" / "feature_catalog.json"
OUTPUT = PROJECT_ROOT / "pipeline_data" / "data" / "feature_patches.npz"

MAP_SIZE = 255
GRID_SIZE = 9


def main():
    print("=" * 70)
    print("  PHASE 3: Extract Feature Heightmap Patches")
    print("=" * 70)

    # Load feature map
    feature_map = np.load(FEATURE_MAP_FILE)
    with open(CATALOG_FILE, 'r', encoding='utf-8') as f:
        catalog = json.load(f)
    
    n_features = catalog['total_features']
    print(f"  Features: {n_features}")

    # Load all retail heightmaps into grid
    print("\nLoading retail heightmaps...")
    height_grid = {}  # (x,y) -> 9x9 array
    terrain_grid = {}  # (x,y) -> 9x9 array
    
    with open(HEIGHTMAP_FILE, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            x, y = rec["lbX"], rec["lbY"]
            height_grid[(x, y)] = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
            terrain_grid[(x, y)] = np.array(rec["terrainTypes"], dtype=np.int32).reshape(GRID_SIZE, GRID_SIZE)
    
    print(f"  Loaded {len(height_grid)} blocks")

    # Extract patches per feature
    # Store as: heights_<fid>, coords_<fid>, terrain_<fid>
    print("\nExtracting patches...")
    
    arrays = {}
    total_blocks = 0
    
    for fid, fdata in catalog['features'].items():
        blocks = fdata['blocks']
        n = len(blocks)
        
        heights = np.zeros((n, GRID_SIZE, GRID_SIZE), dtype=np.float32)
        terrains = np.zeros((n, GRID_SIZE, GRID_SIZE), dtype=np.int32)
        coords = np.array(blocks, dtype=np.int32)  # (n, 2)
        
        for i, (x, y) in enumerate(blocks):
            if (x, y) in height_grid:
                heights[i] = height_grid[(x, y)]
                terrains[i] = terrain_grid[(x, y)]
        
        arrays[f"h_{fid}"] = heights
        arrays[f"t_{fid}"] = terrains
        arrays[f"c_{fid}"] = coords
        
        total_blocks += n
    
    print(f"  Extracted {total_blocks} blocks across {len(catalog['features'])} features")

    # Save
    print(f"\nSaving to {OUTPUT}...")
    np.savez_compressed(OUTPUT, **arrays)
    
    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    print(f"  Saved: {size_mb:.1f} MB")
    
    print(f"\n{'=' * 70}")
    print(f"  DONE: {total_blocks} blocks extracted, {size_mb:.1f} MB")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
