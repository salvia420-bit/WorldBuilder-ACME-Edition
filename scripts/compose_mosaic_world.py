#!/usr/bin/env python3
"""
compose_mosaic_world.py -- Phase 4+5+6: Compose mosaic world, apply V3, smooth edges.

Takes the extracted features, shuffles their positions, applies V3 diffusion at
varying strengths, and produces a new world heightmap JSONL.

Strategy:
  1. Shuffle features to new positions (biome-aware placement)
  2. Mark each block with a V3 strength based on feature type
  3. Apply V3 SDEdit at variable strengths per block
  4. Smooth edges between mosaic pieces

Outputs:
  - data/mosaic_heightmaps.jsonl  (full world, WorldBuilder-compatible)
  - data/mosaic_layout.json       (layout metadata)
  - data/mosaic_visual.png        (visualization)

Usage:
    python scripts/compose_mosaic_world.py [--no-v3] [--seed 42]
"""

import json
import math
import sys
import time
import argparse
import numpy as np
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEIGHTMAP_FILE = PROJECT_ROOT / "retail_heightmaps.jsonl"
FEATURE_MAP_FILE = PROJECT_ROOT / "data" / "feature_map.npy"
CATALOG_FILE = PROJECT_ROOT / "data" / "feature_catalog.json"
PATCHES_FILE = PROJECT_ROOT / "data" / "feature_patches.npz"
BIOME_FILE = PROJECT_ROOT / "data" / "retail_biomes.npy"
ENVCELL_FILE = PROJECT_ROOT / "data" / "envcell_grid.npy"

OUTPUT_HEIGHTMAPS = PROJECT_ROOT / "data" / "mosaic_heightmaps.jsonl"
OUTPUT_LAYOUT = PROJECT_ROOT / "data" / "mosaic_layout.json"
OUTPUT_VISUAL = PROJECT_ROOT / "data" / "mosaic_visual.png"

# V3 model paths
V3_MODEL = PROJECT_ROOT / "models" / "v3" / "terrain_diffusion_v3.pt"

MAP_SIZE = 255
GRID_SIZE = 9

# V3 strength distribution
# Features get assigned a strength based on size and type
STRENGTH_TIERS = {
    'landmark': 0.0,    # Exact retail copy -- big wiki-named features
    'familiar': 0.15,   # Very light mutation -- recognizable
    'moderate': 0.30,   # Moderate smoothing -- wiki POIs
    'abstract': 0.50,   # Significantly different -- auto features
    'fill': 0.80,       # Heavy mutation -- small auto features / gap fill
}

BLEND_RADIUS = 2  # Blocks of edge blending


# =====================================================================
# Feature Shuffler
# =====================================================================

def shuffle_features(catalog, biome_grid, envcell_grid, rng):
    """
    Shuffle feature positions to create a new world layout.
    
    Strategy: 
    - Group features by dominant biome type
    - Within each biome group, randomly swap positions
    - This keeps mountains in mountain zones, deserts in desert zones, etc.
    - But rearranges which specific features go where
    """
    print("Shuffling feature positions...")
    
    features = catalog['features']
    
    # Group features by dominant biome
    biome_groups = defaultdict(list)
    for fid, fdata in features.items():
        biome_groups[fdata['dominant_biome_id']].append(fid)
    
    print(f"  Biome groups: {len(biome_groups)}")
    for bid, fids in sorted(biome_groups.items()):
        print(f"    Biome {bid}: {len(fids)} features")
    
    # For each biome group, create a shuffled mapping of original->new positions
    # We shuffle by swapping entire feature positions between features of the same biome
    placement = {}  # fid -> {'offset_x': dx, 'offset_y': dy, 'rotation': 0-3, 'flip': bool}
    
    for bid, fids in biome_groups.items():
        if len(fids) <= 1:
            # Only one feature in this biome - keep in place
            for fid in fids:
                placement[fid] = {'offset_x': 0, 'offset_y': 0, 'rotation': 0, 'flip': False}
            continue
        
        # Get centroids of all features in this group
        centroids = []
        for fid in fids:
            blocks = features[fid]['blocks']
            cx = int(np.mean([b[0] for b in blocks]))
            cy = int(np.mean([b[1] for b in blocks]))
            centroids.append((cx, cy))
        
        # Shuffle centroids
        shuffled_indices = list(range(len(fids)))
        rng.shuffle(shuffled_indices)
        
        for i, fid in enumerate(fids):
            j = shuffled_indices[i]
            orig_cx, orig_cy = centroids[i]
            new_cx, new_cy = centroids[j]
            
            # Offset = new centroid - original centroid
            dx = new_cx - orig_cx
            dy = new_cy - orig_cy
            
            # Random rotation and flip for variety
            rotation = rng.randint(0, 3)
            flip = rng.random() < 0.3  # 30% chance of flip
            
            placement[fid] = {
                'offset_x': int(dx),
                'offset_y': int(dy),
                'rotation': rotation,
                'flip': bool(flip),
            }
    
    print(f"  Placed {len(placement)} features")
    
    return placement


def assign_v3_strengths(catalog, placement, rng=None):
    """
    Assign V3 mutation strength to each feature using a three-tier
    random distribution for natural variety:
    
      ~33% of features at 10% strength (near-retail, very recognizable)
      ~33% of features at 20% strength (slightly smoothed, familiar)
      ~34% of features at 40% strength (noticeably different, more abstract)
    
    Gap-fill blocks (unplaced) stay at 80% strength for heavy V3 mutation.
    Strengths are randomly assigned regardless of feature type/size,
    so the variety is distributed organically across the whole world.
    """
    if rng is None:
        rng = np.random.RandomState(123)
    
    print("Assigning V3 strengths (three-tier random distribution)...")
    
    TIERS = [
        ('light',    0.10, 0.33),   # 33% at 10% strength
        ('medium',   0.20, 0.33),   # 33% at 20% strength
        ('strong',   0.40, 0.34),   # 34% at 40% strength
    ]
    
    fids = list(catalog['features'].keys())
    rng.shuffle(fids)
    
    strengths = {}
    tier_counts = defaultdict(int)
    
    n = len(fids)
    cut1 = int(n * TIERS[0][2])
    cut2 = cut1 + int(n * TIERS[1][2])
    
    for i, fid in enumerate(fids):
        if i < cut1:
            tier_name, strength, _ = TIERS[0]
        elif i < cut2:
            tier_name, strength, _ = TIERS[1]
        else:
            tier_name, strength, _ = TIERS[2]
        
        strengths[fid] = {
            'tier': tier_name,
            'strength': strength,
        }
        tier_counts[tier_name] += 1
    
    print("  Strength distribution:")
    for tier_name, strength, _ in TIERS:
        count = tier_counts[tier_name]
        pct = 100 * count / n
        print(f"    {tier_name:10s} (str={strength:.2f}): {count} features ({pct:.0f}%)")
    
    return strengths


# =====================================================================
# Build Mosaic World Grid
# =====================================================================

def build_mosaic_grid(catalog, patches_data, placement, strengths, biome_grid):
    """
    Place features at their shuffled positions, building the new world grid.
    
    Returns:
      world_heights: (255, 255, 9, 9) height data
      world_terrains: (255, 255, 9, 9) terrain type data
      world_strength: (255, 255) V3 strength per block
      world_feature: (255, 255) which feature ID each block belongs to
    """
    print("Building mosaic world grid...")
    
    world_heights = np.zeros((MAP_SIZE, MAP_SIZE, GRID_SIZE, GRID_SIZE), dtype=np.float32)
    world_terrains = np.zeros((MAP_SIZE, MAP_SIZE, GRID_SIZE, GRID_SIZE), dtype=np.int32)
    world_strength = np.full((MAP_SIZE, MAP_SIZE), 0.80, dtype=np.float32)  # Gap fill = 80% V3
    world_feature = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)
    placed_mask = np.zeros((MAP_SIZE, MAP_SIZE), dtype=bool)
    
    features = catalog['features']
    placed_count = 0
    overlap_count = 0
    oob_count = 0
    
    for fid, fdata in features.items():
        p = placement[fid]
        s = strengths[fid]
        
        # Get patch data
        h_key = f"h_{fid}"
        t_key = f"t_{fid}"
        c_key = f"c_{fid}"
        
        if h_key not in patches_data or c_key not in patches_data:
            continue
        
        heights = patches_data[h_key]
        terrains = patches_data[t_key]
        coords = patches_data[c_key]
        
        dx, dy = p['offset_x'], p['offset_y']
        rotation = p['rotation']
        flip = p['flip']
        
        for i in range(len(coords)):
            ox, oy = coords[i]
            
            # Apply offset
            nx = ox + dx
            ny = oy + dy
            
            # Clamp to map bounds
            if nx < 0 or nx >= MAP_SIZE or ny < 0 or ny >= MAP_SIZE:
                oob_count += 1
                continue
            
            # Handle overlaps: first feature placed wins
            if placed_mask[nx, ny]:
                overlap_count += 1
                continue
            
            # Get height data, apply rotation/flip
            h = heights[i].copy()
            t = terrains[i].copy()
            
            if rotation > 0:
                h = np.rot90(h, k=rotation)
                t = np.rot90(t, k=rotation)
            if flip:
                h = np.fliplr(h).copy()
                t = np.fliplr(t).copy()
            
            world_heights[nx, ny] = h
            world_terrains[nx, ny] = t
            world_strength[nx, ny] = s['strength']
            world_feature[nx, ny] = int(fid)
            placed_mask[nx, ny] = True
            placed_count += 1
    
    # Fill unplaced blocks with neighboring data or zeros
    unplaced = np.sum(~placed_mask)
    print(f"  Placed: {placed_count} blocks")
    print(f"  Overlaps (skipped): {overlap_count}")
    print(f"  Out of bounds: {oob_count}")
    print(f"  Unplaced (gap fill): {unplaced}")
    
    # For unplaced blocks, grab retail data as base (V3 will heavily mutate these)
    return world_heights, world_terrains, world_strength, world_feature, placed_mask


def fill_gaps_with_retail(world_heights, world_terrains, placed_mask):
    """Fill unplaced blocks with retail heightmap data as a starting point for V3 fill."""
    print("Filling gaps with retail data (for V3 mutation base)...")
    
    with open(HEIGHTMAP_FILE, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            x, y = rec["lbX"], rec["lbY"]
            if x >= MAP_SIZE or y >= MAP_SIZE:
                continue
            if not placed_mask[x, y]:
                world_heights[x, y] = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
                world_terrains[x, y] = np.array(rec["terrainTypes"], dtype=np.int32).reshape(GRID_SIZE, GRID_SIZE)
    
    print("  Done")


# =====================================================================
# Edge Smoothing
# =====================================================================

def smooth_edges(world_heights, world_feature, placed_mask, blend_radius=BLEND_RADIUS):
    """
    Smooth edges between mosaic features.
    
    For blocks at the boundary of two different features, blend the
    heightmaps with a distance-weighted interpolation.
    """
    print(f"Smoothing edges (blend radius={blend_radius})...")
    
    smoothed = world_heights.copy()
    smooth_count = 0
    
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if not placed_mask[x, y]:
                continue
            
            my_feature = world_feature[x, y]
            
            # Check if this is a boundary block
            is_boundary = False
            for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE:
                    if world_feature[nx, ny] != my_feature:
                        is_boundary = True
                        break
            
            if not is_boundary:
                continue
            
            # Collect neighbor heights for blending
            neighbor_heights = []
            for dx in range(-blend_radius, blend_radius + 1):
                for dy in range(-blend_radius, blend_radius + 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE:
                        dist = max(abs(dx), abs(dy))
                        weight = 1.0 / (dist + 1)
                        neighbor_heights.append((world_heights[nx, ny], weight))
            
            if neighbor_heights:
                # Weighted blend of current block with neighbors
                total_weight = 0.7  # Weight for original
                blended = smoothed[x, y] * total_weight
                
                for nh, w in neighbor_heights:
                    blended += nh * (w * 0.3 / len(neighbor_heights))
                    total_weight += w * 0.3 / len(neighbor_heights)
                
                smoothed[x, y] = blended / total_weight
                smooth_count += 1
    
    # Also smooth 9x9 vertex edges within each block at feature boundaries
    vertex_smoothed = 0
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            my_feature = world_feature[x, y]
            
            # Smooth right edge with left edge of (x+1, y)
            if x + 1 < MAP_SIZE and world_feature[x+1, y] != my_feature:
                # Blend rightmost column of (x,y) with leftmost column of (x+1,y)
                right_col = smoothed[x, y, :, -1].copy()
                left_col = smoothed[x+1, y, :, 0].copy()
                avg = (right_col + left_col) / 2
                smoothed[x, y, :, -1] = 0.7 * right_col + 0.3 * avg
                smoothed[x+1, y, :, 0] = 0.7 * left_col + 0.3 * avg
                vertex_smoothed += 1
            
            # Smooth bottom edge with top edge of (x, y+1)
            if y + 1 < MAP_SIZE and world_feature[x, y+1] != my_feature:
                bottom_row = smoothed[x, y, -1, :].copy()
                top_row = smoothed[x, y+1, 0, :].copy()
                avg = (bottom_row + top_row) / 2
                smoothed[x, y, -1, :] = 0.7 * bottom_row + 0.3 * avg
                smoothed[x, y+1, 0, :] = 0.7 * top_row + 0.3 * avg
                vertex_smoothed += 1
    
    print(f"  Block-level blending: {smooth_count} boundary blocks")
    print(f"  Vertex-level stitching: {vertex_smoothed} edges")
    
    return smoothed


# =====================================================================
# V3 Application (SDEdit at variable strength)
# =====================================================================

def apply_v3(world_heights, world_strength, biome_grid, use_v3=True):
    """
    Apply V3 diffusion model at variable strength per block.
    
    Uses BATCHED inference for speed — groups blocks by strength tier,
    processes BATCH_SIZE blocks per GPU call.
    
    Three passes (one per strength tier):
      1. 10% strength blocks (light touch)
      2. 20% strength blocks (medium)
      3. 40% strength blocks (strong)
      4. 80% strength blocks (gap fill)
    """
    if not use_v3:
        print("V3 application SKIPPED (--no-v3 flag)")
        return world_heights
    
    if not V3_MODEL.exists():
        print("V3 model not found, skipping V3 application")
        return world_heights
    
    print("Applying V3 diffusion at variable strengths (BATCHED)...")
    
    try:
        import torch
        import torch.nn.functional as F
    except ImportError:
        print("  PyTorch not available, skipping V3")
        return world_heights
    
    # Load V3 model
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  Device: {device}")
    
    checkpoint = torch.load(V3_MODEL, map_location=device, weights_only=False)
    height_mean = checkpoint['height_mean']
    height_std = checkpoint['height_std']
    n_biomes = checkpoint['n_biomes']
    cond_channels = checkpoint['cond_channels']
    base_channels = checkpoint['base_channels']
    time_dim = checkpoint.get('time_dim', 512)
    
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
    from train_terrain_v3 import DiffusionUNet, DiffusionSchedule, GRID_SIZE as GS, T_DIFFUSION
    
    model = DiffusionUNet(
        cond_channels=cond_channels,
        base_channels=base_channels,
        time_dim=time_dim,
        dropout=0.0,
    ).to(device)
    model.load_state_dict(checkpoint['model_state_dict'])
    model.eval()
    
    schedule = DiffusionSchedule(T_DIFFUSION, device)
    
    n_params = sum(p.numel() for p in model.parameters())
    print(f"  Model loaded: {n_params/1e6:.1f}M params")
    
    if device == "cuda":
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"  GPU VRAM: {vram:.1f} GB")
    
    # Group blocks by strength
    strength_groups = defaultdict(list)
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            s = float(world_strength[x, y])
            if s > 0.01:
                strength_groups[s].append((x, y))
    
    print(f"  Strength groups: {len(strength_groups)}")
    for s, blocks in sorted(strength_groups.items()):
        print(f"    str={s:.2f}: {len(blocks)} blocks")
    
    output_heights = world_heights.copy()
    total_processed = 0
    t0 = time.time()
    BATCH_SIZE = 32  # Tuned for GTX 1070 VRAM
    
    neighbor_offsets = [
        (0, 1), (1, 1), (1, 0), (1, -1),
        (0, -1), (-1, -1), (-1, 0), (-1, 1)
    ]
    
    with torch.no_grad():
        for strength, block_list in sorted(strength_groups.items()):
            start_t = int(strength * T_DIFFUSION)
            
            if start_t < 20:
                total_processed += len(block_list)
                print(f"  str={strength:.2f}: skipped (too low)")
                continue
            
            # DDIM schedule for this strength
            n_steps = max(5, start_t // 40)  # Fewer steps for speed
            step_size = max(1, start_t // n_steps)
            timesteps = list(range(0, start_t, step_size))
            timesteps = list(reversed(timesteps))
            
            print(f"  str={strength:.2f}: {len(block_list)} blocks, "
                  f"start_t={start_t}, {len(timesteps)} DDIM steps, "
                  f"batch_size={BATCH_SIZE}")
            
            # Process in batches
            for batch_start in range(0, len(block_list), BATCH_SIZE):
                batch_coords = block_list[batch_start:batch_start + BATCH_SIZE]
                B = len(batch_coords)
                
                # Build condition tensors for entire batch
                cond_list = []
                x0_list = []
                
                for (bx, by) in batch_coords:
                    channels = []
                    for dx, dy in neighbor_offsets:
                        nx, ny = bx + dx, by + dy
                        if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE:
                            nh = (output_heights[nx, ny] - height_mean) / height_std
                        else:
                            nh = np.zeros((GS, GS), dtype=np.float32)
                        channels.append(nh)
                    
                    # Biome one-hot
                    biome_id = max(0, int(biome_grid[min(bx, MAP_SIZE-1), min(by, MAP_SIZE-1)]))
                    for b in range(n_biomes):
                        channels.append(
                            np.full((GS, GS), 1.0 if b == biome_id else 0.0, dtype=np.float32)
                        )
                    
                    cond_list.append(np.stack(channels, axis=0))
                    h_norm = (output_heights[bx, by] - height_mean) / height_std
                    x0_list.append(h_norm[None])
                
                cond_batch = torch.from_numpy(np.stack(cond_list, axis=0)).to(device)
                x0_batch = torch.from_numpy(np.stack(x0_list, axis=0)).to(device)
                
                # Forward diffusion to start_t
                t_tensor = torch.full((B,), start_t, device=device, dtype=torch.long)
                noise = torch.randn_like(x0_batch)
                noised = schedule.q_sample(x0_batch, t_tensor, noise)[0]
                
                # DDIM denoise loop
                x_t = noised
                for i, t_val in enumerate(timesteps):
                    t_batch = torch.full((B,), t_val, device=device, dtype=torch.long)
                    eps_pred = model(x_t, t_batch, cond_batch)
                    
                    alpha_t = schedule.alphas_cumprod[t_val]
                    if i + 1 < len(timesteps):
                        alpha_prev = schedule.alphas_cumprod[timesteps[i + 1]]
                    else:
                        alpha_prev = torch.tensor(1.0, device=device)
                    
                    x0_pred = (x_t - torch.sqrt(1 - alpha_t) * eps_pred) / torch.sqrt(alpha_t)
                    dir_xt = torch.sqrt(1 - alpha_prev) * eps_pred
                    x_t = torch.sqrt(alpha_prev) * x0_pred + dir_xt
                
                # Store results
                results = x_t.squeeze(1).cpu().numpy()
                for j, (bx, by) in enumerate(batch_coords):
                    result = results[j] * height_std + height_mean
                    output_heights[bx, by] = np.clip(result, 0, 255)
                
                total_processed += B
                
                if total_processed % 1000 < BATCH_SIZE:
                    elapsed = time.time() - t0
                    total_blocks = sum(len(bl) for bl in strength_groups.values())
                    rate = total_processed / elapsed if elapsed > 0 else 0
                    eta = (total_blocks - total_processed) / rate if rate > 0 else 0
                    print(f"    ...{total_processed}/{total_blocks} blocks "
                          f"({elapsed:.0f}s, ~{eta:.0f}s remaining)")
            
            elapsed = time.time() - t0
            print(f"    Done str={strength:.2f} ({elapsed:.0f}s elapsed)")
    
    elapsed = time.time() - t0
    print(f"  V3 complete: {total_processed} blocks in {elapsed:.0f}s "
          f"({total_processed/elapsed:.0f} blocks/s)")
    
    return output_heights


# =====================================================================
# Export to JSONL
# =====================================================================

def export_jsonl(world_heights, world_terrains, output_path):
    """Export world to WorldBuilder-compatible JSONL format."""
    print(f"Exporting to {output_path}...")
    
    # Load original data for road flags and world heights
    road_flags = {}
    heights_world = {}
    with open(HEIGHTMAP_FILE, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            x, y = rec["lbX"], rec["lbY"]
            road_flags[(x, y)] = rec.get("roadFlags", [0] * 81)
            heights_world[(x, y)] = rec.get("heightsWorld", [0.0] * 81)
    
    count = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for x in range(MAP_SIZE):
            for y in range(MAP_SIZE):
                h = world_heights[x, y].flatten().astype(int).tolist()
                t = world_terrains[x, y].flatten().astype(int).tolist()
                
                # Reconstruct world heights from indices
                # Each index maps to a height value (index * 2.0 for AC)
                hw = [float(v * 2.0) for v in h]
                
                rec = {
                    "lbX": x,
                    "lbY": y,
                    "lbKey": f"0x{x:02X}{y:02X}",
                    "heightIndices": h,
                    "heightsWorld": heights_world.get((x, y), hw),
                    "terrainTypes": t,
                    "roadFlags": road_flags.get((x, y), [0] * 81),
                }
                
                f.write(json.dumps(rec) + "\n")
                count += 1
    
    print(f"  Exported {count} blocks")


# =====================================================================
# Visualization
# =====================================================================

def visualize(world_heights, world_strength, world_feature, placed_mask):
    """Create visualization of the mosaic world."""
    print("Creating visualization...")
    
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        
        fig, axes = plt.subplots(2, 2, figsize=(20, 20))
        
        # 1. Heightmap
        ax = axes[0, 0]
        mean_h = np.mean(world_heights, axis=(2, 3))
        ax.imshow(mean_h.T, cmap='terrain', origin='lower')
        ax.set_title('Mosaic Heightmap')
        
        # 2. V3 strength map
        ax = axes[0, 1]
        ax.imshow(world_strength.T, cmap='RdYlGn_r', origin='lower', vmin=0, vmax=1)
        ax.set_title('V3 Strength (0=retail, 1=full mutation)')
        
        # 3. Feature boundaries
        ax = axes[1, 0]
        # Edge detect on feature map
        fx = np.abs(np.diff(world_feature, axis=0, prepend=0))
        fy = np.abs(np.diff(world_feature, axis=1, prepend=0))
        edges = ((fx + fy) > 0).astype(float)
        ax.imshow(mean_h.T, cmap='terrain', origin='lower', alpha=0.7)
        ax.imshow(edges.T, cmap='Reds', origin='lower', alpha=0.3)
        ax.set_title('Feature Boundaries')
        
        # 4. Placement coverage
        ax = axes[1, 1]
        ax.imshow(placed_mask.T.astype(float), cmap='Greens', origin='lower')
        ax.set_title(f'Placed Coverage ({placed_mask.sum()}/{MAP_SIZE**2} blocks)')
        
        fig.tight_layout()
        fig.savefig(OUTPUT_VISUAL, dpi=150)
        plt.close()
        print(f"  Saved: {OUTPUT_VISUAL}")
    except Exception as e:
        print(f"  Could not save visualization: {e}")


# =====================================================================
# Main
# =====================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-v3', action='store_true', help='Skip V3 application')
    parser.add_argument('--seed', type=int, default=42, help='Random seed for shuffling')
    args = parser.parse_args()
    
    print("=" * 70)
    print("  PHASE 4+5+6: Mosaic World Composition")
    print("=" * 70)
    
    rng = np.random.RandomState(args.seed)
    
    # Load catalog
    with open(CATALOG_FILE, 'r', encoding='utf-8') as f:
        catalog = json.load(f)
    print(f"  Features: {catalog['total_features']}")
    
    # Load patches
    print("Loading patches...")
    patches = dict(np.load(PATCHES_FILE, allow_pickle=True))
    print(f"  Loaded {len(patches)} arrays")
    
    # Load biome grid
    biome_grid = np.load(BIOME_FILE)
    
    # Load envcell grid
    envcell_grid = np.load(ENVCELL_FILE) if ENVCELL_FILE.exists() else np.zeros((MAP_SIZE, MAP_SIZE))
    
    # Phase 4: Shuffle and compose
    placement = shuffle_features(catalog, biome_grid, envcell_grid, rng)
    strengths = assign_v3_strengths(catalog, placement, rng=rng)
    
    world_heights, world_terrains, world_strength, world_feature, placed_mask = \
        build_mosaic_grid(catalog, patches, placement, strengths, biome_grid)
    
    # Fill gaps
    fill_gaps_with_retail(world_heights, world_terrains, placed_mask)
    
    # Phase 6: Edge smoothing (before V3 so V3 can work on smooth data)
    world_heights = smooth_edges(world_heights, world_feature, placed_mask)
    
    # Phase 5: Apply V3 at variable strengths
    world_heights = apply_v3(world_heights, world_strength, biome_grid, use_v3=not args.no_v3)
    
    # Export
    export_jsonl(world_heights, world_terrains, OUTPUT_HEIGHTMAPS)
    
    # Save layout metadata
    layout = {
        'seed': args.seed,
        'total_features': catalog['total_features'],
        'placement': placement,
        'strengths': strengths,
        'placed_blocks': int(placed_mask.sum()),
        'gap_blocks': int((~placed_mask).sum()),
        'v3_applied': not args.no_v3,
    }
    with open(OUTPUT_LAYOUT, 'w', encoding='utf-8') as f:
        json.dump(layout, f, indent=2)
    print(f"\nSaved layout: {OUTPUT_LAYOUT}")
    
    # Visualize
    visualize(world_heights, world_strength, world_feature, placed_mask)
    
    print(f"\n{'=' * 70}")
    print(f"  MOSAIC WORLD COMPLETE")
    print(f"  Output: {OUTPUT_HEIGHTMAPS}")
    print(f"  Placed: {placed_mask.sum()} blocks, Gaps: {(~placed_mask).sum()}")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
