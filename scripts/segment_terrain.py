#!/usr/bin/env python3
"""
segment_terrain.py -- Phase 2: Terrain Segmentation via Marker-Based Watershed

Segments the 255x255 retail heightmap grid into irregularly-shaped geographic
features using wiki POI locations as seeds and topographic analysis for boundaries.

Outputs:
  - data/feature_map.npy        (255x255 int array, feature IDs)
  - data/feature_catalog.json   (metadata per feature)
  - data/feature_map_visual.png (colored visualization)

Usage:
    python scripts/segment_terrain.py
"""

import json
import numpy as np
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEIGHTMAP_FILE = PROJECT_ROOT / "retail_heightmaps.jsonl"
BIOME_FILE = PROJECT_ROOT / "data" / "retail_biomes.npy"
BIOME_INFO_FILE = PROJECT_ROOT / "data" / "retail_biome_info.json"
WIKI_FEATURES_FILE = PROJECT_ROOT / "data" / "wiki_features.json"
OCEAN_MASK_FILE = PROJECT_ROOT / "data" / "envcell_grid.npy"

OUTPUT_MAP = PROJECT_ROOT / "data" / "feature_map.npy"
OUTPUT_CATALOG = PROJECT_ROOT / "data" / "feature_catalog.json"
OUTPUT_VISUAL = PROJECT_ROOT / "data" / "feature_map_visual.png"

MAP_SIZE = 255
GRID_SIZE = 9

# Tunable parameters
MIN_FEATURE_SIZE = 6       # Minimum blocks per feature
EDGE_SENSITIVITY = 1.5     # How much weight to give height gradients (higher = more segments)
ROUGHNESS_WEIGHT = 0.3     # Weight for roughness in edge calculation
HEIGHT_WEIGHT = 0.5        # Weight for height difference
BIOME_WEIGHT = 0.4         # Weight for biome boundary (binary)


# =====================================================================
# Step 1: Load all data
# =====================================================================

def load_heightmap_grid():
    """Load retail heightmaps into a grid of per-block statistics."""
    print("Loading retail heightmaps...")
    
    # Per-block stats arrays
    mean_height = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    std_height = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    roughness = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    height_range = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    min_height = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    max_height = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    
    # Also store raw first-row/last-row/first-col/last-col for edge matching
    # These will be used for edge gradient computation between blocks
    edge_N = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)  # Mean of top row
    edge_S = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)  # Mean of bottom row
    edge_E = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)  # Mean of right col
    edge_W = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)  # Mean of left col
    
    count = 0
    with open(HEIGHTMAP_FILE, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            x, y = rec["lbX"], rec["lbY"]
            if x >= MAP_SIZE or y >= MAP_SIZE:
                continue
            
            h = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
            
            mean_height[x, y] = h.mean()
            std_height[x, y] = h.std()
            height_range[x, y] = h.max() - h.min()
            min_height[x, y] = h.min()
            max_height[x, y] = h.max()
            
            # Roughness = mean absolute gradient
            dx = np.abs(np.diff(h, axis=1)).mean()
            dy = np.abs(np.diff(h, axis=0)).mean()
            roughness[x, y] = (dx + dy) / 2
            
            # Edge means for boundary gradient
            edge_N[x, y] = h[0, :].mean()   # Top row
            edge_S[x, y] = h[-1, :].mean()  # Bottom row
            edge_W[x, y] = h[:, 0].mean()   # Left col
            edge_E[x, y] = h[:, -1].mean()  # Right col
            
            count += 1
    
    print(f"  Loaded {count} blocks")
    
    return {
        'mean_height': mean_height,
        'std_height': std_height,
        'roughness': roughness,
        'height_range': height_range,
        'min_height': min_height,
        'max_height': max_height,
        'edge_N': edge_N, 'edge_S': edge_S,
        'edge_E': edge_E, 'edge_W': edge_W,
    }


# =====================================================================
# Step 2: Compute edge weight map
# =====================================================================

def compute_edge_weights(stats, biome_grid):
    """
    Compute edge weights between adjacent blocks.
    High weight = strong boundary (different terrain character).
    
    Returns:
      edge_h: (MAP_SIZE, MAP_SIZE) - edge weight to right neighbor (horizontal)
      edge_v: (MAP_SIZE, MAP_SIZE) - edge weight to bottom neighbor (vertical)
    """
    print("Computing edge weights...")
    
    edge_h = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)  # Weight between (x,y) and (x+1,y)
    edge_v = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)  # Weight between (x,y) and (x,y+1)
    
    mh = stats['mean_height']
    sh = stats['std_height']
    rg = stats['roughness']
    hr = stats['height_range']
    
    # Normalize features for comparison
    mh_norm = (mh - mh.mean()) / (mh.std() + 1e-8)
    sh_norm = (sh - sh.mean()) / (sh.std() + 1e-8)
    rg_norm = (rg - rg.mean()) / (rg.std() + 1e-8)
    hr_norm = (hr - hr.mean()) / (hr.std() + 1e-8)
    
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            # Horizontal edge (x,y) <-> (x+1,y)
            if x + 1 < MAP_SIZE:
                # Height difference at shared boundary
                boundary_grad = abs(stats['edge_E'][x, y] - stats['edge_W'][x+1, y])
                
                # Feature vector difference
                feat_diff = (
                    HEIGHT_WEIGHT * abs(mh_norm[x,y] - mh_norm[x+1,y]) +
                    ROUGHNESS_WEIGHT * abs(rg_norm[x,y] - rg_norm[x+1,y]) +
                    0.2 * abs(sh_norm[x,y] - sh_norm[x+1,y]) +
                    0.1 * abs(hr_norm[x,y] - hr_norm[x+1,y])
                )
                
                # Biome boundary penalty
                biome_boundary = BIOME_WEIGHT if biome_grid[x, y] != biome_grid[x+1, y] else 0.0
                
                edge_h[x, y] = EDGE_SENSITIVITY * boundary_grad + feat_diff + biome_boundary
            
            # Vertical edge (x,y) <-> (x,y+1)
            if y + 1 < MAP_SIZE:
                boundary_grad = abs(stats['edge_S'][x, y] - stats['edge_N'][x, y+1])
                
                feat_diff = (
                    HEIGHT_WEIGHT * abs(mh_norm[x,y] - mh_norm[x,y+1]) +
                    ROUGHNESS_WEIGHT * abs(rg_norm[x,y] - rg_norm[x,y+1]) +
                    0.2 * abs(sh_norm[x,y] - sh_norm[x,y+1]) +
                    0.1 * abs(hr_norm[x,y] - hr_norm[x,y+1])
                )
                
                biome_boundary = BIOME_WEIGHT if biome_grid[x, y] != biome_grid[x, y+1] else 0.0
                
                edge_v[x, y] = EDGE_SENSITIVITY * boundary_grad + feat_diff + biome_boundary
    
    print(f"  Edge weight stats: H mean={edge_h.mean():.3f}, V mean={edge_v.mean():.3f}")
    print(f"  Edge weight range: [{min(edge_h.min(), edge_v.min()):.3f}, {max(edge_h.max(), edge_v.max()):.3f}]")
    
    return edge_h, edge_v


# =====================================================================
# Step 3: Plant seeds (markers)
# =====================================================================

def plant_seeds(wiki_features, stats, biome_grid):
    """
    Plant watershed seeds from wiki POIs + automatically detected local extrema.
    
    Returns: seeds array (MAP_SIZE, MAP_SIZE) where 0 = no seed, >0 = seed ID
    """
    print("Planting seeds...")
    
    seeds = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)
    seed_names = {}
    next_id = 1
    
    # 1. Wiki-sourced seeds: towns and POIs with known coordinates
    towns = wiki_features.get('towns', [])
    for t in towns:
        if t.get('location_match'):
            lm = t['location_match']
            x, y = lm['lbX'], lm['lbY']
            if 0 <= x < MAP_SIZE and 0 <= y < MAP_SIZE and seeds[x, y] == 0:
                seeds[x, y] = next_id
                seed_names[next_id] = t['name']
                next_id += 1
    
    # Named POIs from wiki
    pois = wiki_features.get('points_of_interest', [])
    for p in pois:
        coord = None
        if p.get('location_match'):
            coord = (p['location_match']['lbX'], p['location_match']['lbY'])
        elif p.get('derived_coords'):
            dc = p['derived_coords'][0]
            coord = (dc['lbX'], dc['lbY'])
        elif p.get('wiki_coords'):
            coord = tuple(p['wiki_coords'][0])
        
        if coord:
            x, y = coord
            if 0 <= x < MAP_SIZE and 0 <= y < MAP_SIZE and seeds[x, y] == 0:
                seeds[x, y] = next_id
                seed_names[next_id] = p['name']
                next_id += 1
    
    wiki_seed_count = next_id - 1
    print(f"  Wiki seeds planted: {wiki_seed_count}")
    
    # 2. Automatic seeds: local height maxima and minima
    # These fill areas without wiki POIs
    mh = stats['mean_height']
    
    # Grid-based auto-seeding: place a seed every N blocks if no nearby seed exists
    auto_spacing = 8  # blocks between auto-seeds
    
    for x in range(auto_spacing // 2, MAP_SIZE, auto_spacing):
        for y in range(auto_spacing // 2, MAP_SIZE, auto_spacing):
            # Check if any seed within spacing radius
            x_lo = max(0, x - auto_spacing // 2)
            x_hi = min(MAP_SIZE, x + auto_spacing // 2 + 1)
            y_lo = max(0, y - auto_spacing // 2)
            y_hi = min(MAP_SIZE, y + auto_spacing // 2 + 1)
            
            if seeds[x_lo:x_hi, y_lo:y_hi].max() > 0:
                continue  # Already a seed nearby
            
            # Find the most "distinctive" block in this local area
            # (highest roughness or most extreme height)
            local_mh = mh[x_lo:x_hi, y_lo:y_hi]
            local_rg = stats['roughness'][x_lo:x_hi, y_lo:y_hi]
            
            # Use roughness as distinctiveness metric
            local_score = local_rg + 0.3 * np.abs(local_mh - mh.mean())
            best_idx = np.unravel_index(local_score.argmax(), local_score.shape)
            
            bx = x_lo + best_idx[0]
            by = y_lo + best_idx[1]
            
            if seeds[bx, by] == 0:
                seeds[bx, by] = next_id
                biome_id = int(biome_grid[bx, by])
                seed_names[next_id] = f"auto_{biome_id}_{bx}_{by}"
                next_id += 1
    
    auto_seed_count = next_id - 1 - wiki_seed_count
    print(f"  Auto seeds planted: {auto_seed_count}")
    print(f"  Total seeds: {next_id - 1}")
    
    return seeds, seed_names


# =====================================================================
# Step 4: Watershed segmentation
# =====================================================================

def watershed_segment(seeds, edge_h, edge_v):
    """
    Priority-queue watershed segmentation.
    
    Grows regions from seeds, with growth priority determined by edge weights.
    Low edge weight = easy to grow through (similar terrain).
    High edge weight = barrier (terrain boundary).
    """
    import heapq
    
    print("Running watershed segmentation...")
    
    labels = seeds.copy()
    visited = labels > 0
    
    # Initialize priority queue with neighbors of seeds
    # (priority, x, y, source_label)
    pq = []
    
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if labels[x, y] > 0:
                # Add unvisited neighbors
                for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE and not visited[nx, ny]:
                        # Edge weight for this boundary
                        if dx == 1:
                            w = edge_h[x, y]
                        elif dx == -1:
                            w = edge_h[nx, ny]
                        elif dy == 1:
                            w = edge_v[x, y]
                        else:
                            w = edge_v[nx, ny]
                        
                        heapq.heappush(pq, (w, nx, ny, labels[x, y]))
    
    processed = 0
    while pq:
        priority, x, y, source_label = heapq.heappop(pq)
        
        if visited[x, y]:
            continue
        
        labels[x, y] = source_label
        visited[x, y] = True
        processed += 1
        
        # Add unvisited neighbors
        for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            nx, ny = x + dx, y + dy
            if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE and not visited[nx, ny]:
                if dx == 1:
                    w = edge_h[x, y]
                elif dx == -1:
                    w = edge_h[nx, ny]
                elif dy == 1:
                    w = edge_v[x, y]
                else:
                    w = edge_v[nx, ny]
                
                # Accumulate priority (further from seed = higher cost)
                heapq.heappush(pq, (priority + w, nx, ny, source_label))
        
        if processed % 10000 == 0:
            print(f"  ...{processed} blocks assigned")
    
    n_labels = len(set(labels.flatten()) - {0})
    print(f"  Watershed complete: {n_labels} regions, {processed} blocks assigned")
    
    return labels


# =====================================================================
# Step 5: Merge small regions
# =====================================================================

def merge_small_regions(labels, stats, biome_grid, seed_names, min_size=MIN_FEATURE_SIZE):
    """
    Merge regions smaller than min_size into their most similar neighbor.
    """
    print(f"Merging regions smaller than {min_size} blocks...")
    
    # Count region sizes
    unique_labels = set(labels.flatten()) - {0}
    region_sizes = {}
    for label in unique_labels:
        region_sizes[label] = int(np.sum(labels == label))
    
    small_regions = [l for l, s in region_sizes.items() if s < min_size]
    print(f"  Small regions to merge: {len(small_regions)} / {len(unique_labels)}")
    
    merged_labels = labels.copy()
    merge_map = {}  # old_label -> new_label
    
    for label in small_regions:
        # Find all blocks in this region
        mask = merged_labels == label
        region_coords = list(zip(*np.where(mask)))
        
        if not region_coords:
            continue
        
        # Find neighboring labels
        neighbor_labels = set()
        for x, y in region_coords:
            for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE:
                    nl = merged_labels[nx, ny]
                    if nl != label and nl != 0:
                        neighbor_labels.add(nl)
        
        if not neighbor_labels:
            continue
        
        # Find most similar neighbor (by mean height)
        region_height = stats['mean_height'][mask].mean()
        
        best_neighbor = None
        best_diff = float('inf')
        for nl in neighbor_labels:
            nl_mask = merged_labels == nl
            nl_height = stats['mean_height'][nl_mask].mean()
            diff = abs(region_height - nl_height)
            if diff < best_diff:
                best_diff = diff
                best_neighbor = nl
        
        if best_neighbor is not None:
            merged_labels[mask] = best_neighbor
            merge_map[label] = best_neighbor
    
    # Relabel to contiguous IDs
    remaining = sorted(set(merged_labels.flatten()) - {0})
    new_labels = np.zeros_like(merged_labels)
    label_remap = {}
    for i, old_label in enumerate(remaining, 1):
        new_labels[merged_labels == old_label] = i
        label_remap[old_label] = i
    
    # Rebuild seed names with new IDs
    new_seed_names = {}
    for old_id, name in seed_names.items():
        if old_id in merge_map:
            target = merge_map[old_id]
            # Follow merge chain
            while target in merge_map:
                target = merge_map[target]
            if target in label_remap:
                new_id = label_remap[target]
                # Keep the wiki name if we're merging into a wiki-seeded region
                if new_id not in new_seed_names or not new_seed_names[new_id].startswith('auto_'):
                    pass  # Target already has a better name
                else:
                    new_seed_names[new_id] = name
        elif old_id in label_remap:
            new_id = label_remap[old_id]
            if new_id not in new_seed_names:
                new_seed_names[new_id] = name
            elif new_seed_names[new_id].startswith('auto_') and not name.startswith('auto_'):
                new_seed_names[new_id] = name  # Prefer wiki names
    
    final_count = len(set(new_labels.flatten()) - {0})
    print(f"  After merge: {final_count} regions")
    
    return new_labels, new_seed_names


# =====================================================================
# Step 6: Build feature catalog
# =====================================================================

def build_catalog(labels, stats, biome_grid, seed_names, biome_info):
    """Build metadata catalog for each feature."""
    print("Building feature catalog...")
    
    cluster_names = {}
    for cid, info in biome_info['clusters'].items():
        cluster_names[int(cid)] = info['name']
    
    features = {}
    unique_labels = sorted(set(labels.flatten()) - {0})
    
    for label in unique_labels:
        mask = labels == label
        coords = list(zip(*np.where(mask)))
        
        if not coords:
            continue
        
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        
        # Biome analysis
        biome_vals = biome_grid[mask]
        biome_counts = defaultdict(int)
        for b in biome_vals:
            biome_counts[int(b)] += 1
        dominant_biome = max(biome_counts, key=biome_counts.get)
        
        name = seed_names.get(label, f"feature_{label}")
        source = "wiki" if not name.startswith("auto_") and not name.startswith("feature_") else "auto"
        
        features[str(label)] = {
            'name': name,
            'source': source,
            'block_count': len(coords),
            'blocks': [[int(x), int(y)] for x, y in coords],
            'bounding_box': [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            'mean_height': float(stats['mean_height'][mask].mean()),
            'std_height': float(stats['std_height'][mask].mean()),
            'roughness': float(stats['roughness'][mask].mean()),
            'height_range': float(stats['height_range'][mask].mean()),
            'dominant_biome_id': dominant_biome,
            'dominant_biome': cluster_names.get(dominant_biome, f"biome_{dominant_biome}"),
            'biome_composition': {
                cluster_names.get(k, f"biome_{k}"): v 
                for k, v in sorted(biome_counts.items(), key=lambda x: -x[1])
            },
        }
    
    # Summary stats
    sizes = [f['block_count'] for f in features.values()]
    wiki_count = sum(1 for f in features.values() if f['source'] == 'wiki')
    
    print(f"  Total features: {len(features)}")
    print(f"  Wiki-named: {wiki_count}")
    print(f"  Auto-detected: {len(features) - wiki_count}")
    print(f"  Size range: {min(sizes)} - {max(sizes)} blocks")
    print(f"  Mean size: {np.mean(sizes):.1f} blocks")
    print(f"  Median size: {np.median(sizes):.1f} blocks")
    
    return features


# =====================================================================
# Step 7: Visualization
# =====================================================================

def visualize(labels, features, biome_grid):
    """Create colored visualization of the feature map."""
    print("Creating visualization...")
    
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from matplotlib.colors import ListedColormap
        
        fig, axes = plt.subplots(1, 2, figsize=(24, 12))
        
        # Generate random colors for each feature
        n_features = int(labels.max())
        np.random.seed(42)
        colors = np.random.rand(n_features + 1, 3)
        colors[0] = [0, 0, 0]  # Background = black
        
        # Feature map
        ax = axes[0]
        display = labels.T  # Transpose for correct orientation
        ax.imshow(display, cmap=ListedColormap(colors), interpolation='nearest', origin='lower')
        ax.set_title(f'Feature Map ({n_features} features)', fontsize=14)
        ax.set_xlabel('lbX')
        ax.set_ylabel('lbY')
        
        # Annotate wiki-named features
        for fid, fdata in features.items():
            if fdata['source'] == 'wiki':
                blocks = fdata['blocks']
                cx = np.mean([b[0] for b in blocks])
                cy = np.mean([b[1] for b in blocks])
                name = fdata['name']
                if len(name) > 20:
                    name = name[:18] + '..'
                ax.annotate(name, (cx, cy), fontsize=5, color='white',
                          ha='center', va='center',
                          bbox=dict(boxstyle='round,pad=0.2', fc='black', alpha=0.6))
        
        # Feature size distribution
        ax = axes[1]
        sizes = [f['block_count'] for f in features.values()]
        ax.hist(sizes, bins=50, color='steelblue', edgecolor='black', alpha=0.7)
        ax.set_xlabel('Feature size (blocks)')
        ax.set_ylabel('Count')
        ax.set_title('Feature Size Distribution')
        ax.axvline(np.median(sizes), color='red', linestyle='--', label=f'Median: {np.median(sizes):.0f}')
        ax.legend()
        
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
    print("=" * 70)
    print("  PHASE 2: Terrain Segmentation -- Smart Freeform Selection")
    print("=" * 70)
    
    # Load data
    stats = load_heightmap_grid()
    
    print("\nLoading biome grid...")
    biome_grid = np.load(BIOME_FILE)
    with open(BIOME_INFO_FILE) as f:
        biome_info = json.load(f)
    print(f"  Biome grid shape: {biome_grid.shape}, {biome_info['n_clusters']} clusters")
    
    print("\nLoading wiki features...")
    with open(WIKI_FEATURES_FILE, 'r', encoding='utf-8') as f:
        wiki_features = json.load(f)
    print(f"  {wiki_features['stats']['geographic_regions']} regions, "
          f"{wiki_features['stats']['pois']} POIs, "
          f"{wiki_features['stats']['towns']} towns")
    
    # Compute edge weights
    edge_h, edge_v = compute_edge_weights(stats, biome_grid)
    
    # Plant seeds
    seeds, seed_names = plant_seeds(wiki_features, stats, biome_grid)
    
    # Watershed segmentation
    labels = watershed_segment(seeds, edge_h, edge_v)
    
    # Merge small regions
    labels, seed_names = merge_small_regions(labels, stats, biome_grid, seed_names)
    
    # Build catalog
    features = build_catalog(labels, stats, biome_grid, seed_names, biome_info)
    
    # Save outputs
    np.save(OUTPUT_MAP, labels)
    print(f"\nSaved feature map: {OUTPUT_MAP}")
    
    catalog = {
        'total_features': len(features),
        'wiki_features': sum(1 for f in features.values() if f['source'] == 'wiki'),
        'auto_features': sum(1 for f in features.values() if f['source'] == 'auto'),
        'features': features,
    }
    with open(OUTPUT_CATALOG, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    print(f"Saved feature catalog: {OUTPUT_CATALOG}")
    
    # Visualize
    visualize(labels, features, biome_grid)
    
    # Print top features
    print(f"\n{'=' * 70}")
    print(f"  TOP 20 FEATURES BY SIZE")
    print(f"{'=' * 70}")
    sorted_features = sorted(features.items(), key=lambda x: -x[1]['block_count'])
    for fid, fdata in sorted_features[:20]:
        print(f"  #{fid:4s} {fdata['name'][:40]:40s} "
              f"{fdata['block_count']:5d} blocks  "
              f"h={fdata['mean_height']:5.1f}  "
              f"biome={fdata['dominant_biome']}")
    
    print(f"\n  TOP WIKI-NAMED FEATURES")
    print(f"  {'-' * 60}")
    wiki_features_list = [(fid, f) for fid, f in sorted_features if f['source'] == 'wiki']
    for fid, fdata in wiki_features_list[:20]:
        print(f"  #{fid:4s} {fdata['name'][:40]:40s} "
              f"{fdata['block_count']:5d} blocks  "
              f"biome={fdata['dominant_biome']}")
    
    print(f"\n{'=' * 70}")
    print(f"  DONE: {catalog['total_features']} features extracted")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
