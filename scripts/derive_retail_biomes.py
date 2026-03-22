#!/usr/bin/env python3
"""
derive_retail_biomes.py -- Cluster retail heightmap blocks into meaningful biomes.

Instead of using biome_map.json (which describes a different world), this derives
biome labels from the ACTUAL retail terrain data: height distribution, roughness,
terrain type composition, and spatial features.

Outputs:
  - data/retail_biomes.npy   (255x255 int32 grid of biome cluster IDs)
  - data/retail_biome_info.json (cluster stats and descriptions)
  - data/retail_biome_map.png (visualization)
"""

import json
import time
import sys
from pathlib import Path

import numpy as np
from collections import Counter

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HEIGHTMAP_FILE = PROJECT_ROOT / "retail_heightmaps.jsonl"
OUTPUT_DIR = PROJECT_ROOT / "data"

MAP_SIZE = 255
GRID_SIZE = 9
N_CLUSTERS = 12  # Number of biome clusters


def extract_block_features(blocks):
    """Extract feature vector per landblock for clustering."""
    print("  Extracting features from each block...")
    n = len(blocks)
    # Features per block:
    # [mean_h, std_h, min_h, max_h, range_h, median_h,
    #  roughness_x, roughness_y, roughness_total,
    #  terrain_type_2_frac, terrain_type_1_frac, terrain_type_8_frac,
    #  normalized_x, normalized_y]
    features = np.zeros((n, 14), dtype=np.float32)
    coords = []

    for i, (key, rec) in enumerate(blocks.items()):
        x, y = rec["lbX"], rec["lbY"]
        coords.append((x, y))

        h = np.array(rec["heightIndices"], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
        tt = np.array(rec["terrainTypes"], dtype=np.int32).reshape(GRID_SIZE, GRID_SIZE)

        # Height statistics
        features[i, 0] = h.mean()
        features[i, 1] = h.std()
        features[i, 2] = h.min()
        features[i, 3] = h.max()
        features[i, 4] = h.max() - h.min()  # range
        features[i, 5] = np.median(h)

        # Roughness (gradient magnitude)
        grad_x = np.diff(h, axis=0)  # (8, 9)
        grad_y = np.diff(h, axis=1)  # (9, 8)
        features[i, 6] = np.abs(grad_x).mean()
        features[i, 7] = np.abs(grad_y).mean()
        features[i, 8] = np.sqrt(grad_x.mean()**2 + grad_y.mean()**2)  # net gradient

        # Terrain type composition
        total = tt.size
        features[i, 9] = np.sum(tt == 2) / total   # type 2 fraction
        features[i, 10] = np.sum(tt == 1) / total   # type 1 fraction
        features[i, 11] = np.sum(tt == 8) / total   # type 8 fraction

        # Spatial position (normalized 0-1)
        features[i, 12] = x / MAP_SIZE
        features[i, 13] = y / MAP_SIZE

    return features, coords


def kmeans_clustering(features, n_clusters, max_iter=300, n_init=10):
    """K-means clustering using numpy (no sklearn dependency)."""
    print(f"  Running K-means (k={n_clusters}, {n_init} inits, max {max_iter} iters)...")
    n, d = features.shape
    best_labels = None
    best_inertia = float("inf")

    for init_i in range(n_init):
        rng = np.random.RandomState(init_i * 42)

        # K-means++ initialization
        centers = np.zeros((n_clusters, d), dtype=np.float32)
        centers[0] = features[rng.randint(n)]
        for c in range(1, n_clusters):
            dists = np.min([np.sum((features - centers[j])**2, axis=1) for j in range(c)], axis=0)
            probs = dists / dists.sum()
            centers[c] = features[rng.choice(n, p=probs)]

        # Iterate
        for iteration in range(max_iter):
            # Assign
            dists = np.zeros((n, n_clusters), dtype=np.float32)
            for c in range(n_clusters):
                dists[:, c] = np.sum((features - centers[c])**2, axis=1)
            labels = np.argmin(dists, axis=1)

            # Update
            new_centers = np.zeros_like(centers)
            for c in range(n_clusters):
                mask = labels == c
                if mask.any():
                    new_centers[c] = features[mask].mean(axis=0)
                else:
                    new_centers[c] = centers[c]

            if np.allclose(centers, new_centers, atol=1e-6):
                break
            centers = new_centers

        inertia = sum(np.sum((features[labels == c] - centers[c])**2) for c in range(n_clusters))
        if inertia < best_inertia:
            best_inertia = inertia
            best_labels = labels.copy()
            best_centers = centers.copy()
        sys.stdout.write(f"\r    Init {init_i+1}/{n_init}, inertia={inertia:.0f} (best={best_inertia:.0f})")
        sys.stdout.flush()

    print()
    return best_labels, best_centers


def main():
    print("=" * 70)
    print("  RETAIL BIOME DERIVATION -- K-Means Clustering")
    print("=" * 70)

    # Load all blocks
    print("\nLoading retail heightmaps...")
    blocks = {}
    with open(HEIGHTMAP_FILE, "r", encoding="utf-8-sig") as f:
        for line in f:
            rec = json.loads(line)
            key = (rec["lbX"], rec["lbY"])
            blocks[key] = rec
    print(f"  Loaded {len(blocks)} blocks")

    # Extract features
    features, coords = extract_block_features(blocks)

    # Normalize features for clustering (z-score)
    feat_mean = features.mean(axis=0)
    feat_std = features.std(axis=0) + 1e-8
    features_norm = (features - feat_mean) / feat_std

    # Weight important features higher
    weights = np.array([
        2.0,  # mean_h -- height is very important
        3.0,  # std_h -- variance matters a lot (flat vs mountainous)
        1.0,  # min_h
        1.0,  # max_h
        2.0,  # range_h
        1.0,  # median_h
        3.0,  # roughness_x -- terrain roughness is key
        3.0,  # roughness_y
        2.0,  # roughness_total
        2.0,  # terrain_type_2_frac
        2.0,  # terrain_type_1_frac
        2.0,  # terrain_type_8_frac
        0.5,  # x position (light weight -- geography matters but shouldn't dominate)
        0.5,  # y position
    ], dtype=np.float32)
    features_weighted = features_norm * weights

    # Cluster
    t0 = time.time()
    labels, centers = kmeans_clustering(features_weighted, N_CLUSTERS, max_iter=500, n_init=20)
    print(f"  Clustering done in {time.time() - t0:.1f}s")

    # Build biome grid
    biome_grid = np.full((MAP_SIZE, MAP_SIZE), -1, dtype=np.int32)
    for i, (x, y) in enumerate(coords):
        if 0 <= x < MAP_SIZE and 0 <= y < MAP_SIZE:
            biome_grid[x, y] = labels[i]

    # Analyze clusters
    print("\nCluster analysis:")
    cluster_info = {}
    for c in range(N_CLUSTERS):
        mask = labels == c
        count = mask.sum()
        feats = features[mask]  # un-normalized features

        info = {
            "count": int(count),
            "pct": float(count / len(labels) * 100),
            "mean_height": float(feats[:, 0].mean()),
            "std_height": float(feats[:, 1].mean()),
            "roughness": float(feats[:, 6].mean() + feats[:, 7].mean()),
            "height_range": float(feats[:, 4].mean()),
            "terrain_type2_frac": float(feats[:, 9].mean()),
            "terrain_type1_frac": float(feats[:, 10].mean()),
            "terrain_type8_frac": float(feats[:, 11].mean()),
        }

        # Auto-name based on properties
        if info["std_height"] < 3.0 and info["mean_height"] < 30:
            name = "flat_lowland"
        elif info["std_height"] < 3.0 and info["mean_height"] > 80:
            name = "flat_highland"
        elif info["std_height"] < 3.0:
            name = "flat_midland"
        elif info["roughness"] > 8.0:
            name = "rugged_mountain"
        elif info["roughness"] > 5.0:
            name = "rolling_hills"
        elif info["height_range"] > 30:
            name = "mountain"
        elif info["terrain_type8_frac"] > 0.3:
            name = "special_terrain"
        elif info["mean_height"] > 90:
            name = "highland"
        elif info["mean_height"] < 40:
            name = "lowland"
        elif info["terrain_type1_frac"] > 0.5:
            name = "transition_zone"
        else:
            name = f"mixed_{c}"

        # Disambiguate
        count_suffix = 0
        base_name = name
        while name in [v.get("name") for v in cluster_info.values()]:
            count_suffix += 1
            name = f"{base_name}_{count_suffix}"

        info["name"] = name
        cluster_info[str(c)] = info

        print(
            f"  Cluster {c:2d} ({name:20s}): "
            f"{count:5d} blocks ({info['pct']:4.1f}%) | "
            f"h={info['mean_height']:5.1f} +/-{info['std_height']:4.1f} | "
            f"rough={info['roughness']:4.1f} | "
            f"range={info['height_range']:4.1f}"
        )

    # Save outputs
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    np.save(OUTPUT_DIR / "retail_biomes.npy", biome_grid)
    print(f"\n  Saved biome grid: {OUTPUT_DIR / 'retail_biomes.npy'}")

    # Save feature normalization stats (needed for inference)
    save_info = {
        "n_clusters": N_CLUSTERS,
        "clusters": cluster_info,
        "feature_names": [
            "mean_h", "std_h", "min_h", "max_h", "range_h", "median_h",
            "roughness_x", "roughness_y", "roughness_total",
            "terrain_type_2_frac", "terrain_type_1_frac", "terrain_type_8_frac",
            "norm_x", "norm_y"
        ],
    }
    with open(OUTPUT_DIR / "retail_biome_info.json", "w") as f:
        json.dump(save_info, f, indent=2)
    print(f"  Saved biome info: {OUTPUT_DIR / 'retail_biome_info.json'}")

    # Visualization
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.colors import ListedColormap

        # Color palette for clusters
        palette = [
            (0.12, 0.47, 0.71), (1.0, 0.5, 0.05), (0.17, 0.63, 0.17),
            (0.84, 0.15, 0.16), (0.58, 0.4, 0.74), (0.55, 0.34, 0.29),
            (0.89, 0.47, 0.76), (0.5, 0.5, 0.5), (0.74, 0.74, 0.13),
            (0.09, 0.75, 0.81), (0.4, 0.2, 0.6), (0.9, 0.8, 0.3),
        ]

        fig, axes = plt.subplots(2, 2, figsize=(18, 18))

        # Biome map
        cmap = ListedColormap(palette[:N_CLUSTERS])
        im = axes[0, 0].imshow(biome_grid.T, origin='lower', cmap=cmap, vmin=0, vmax=N_CLUSTERS-1)
        axes[0, 0].set_title("Derived Biomes (K-means clusters)", fontsize=14)
        cbar = plt.colorbar(im, ax=axes[0, 0], shrink=0.7)
        cbar.set_ticks(range(N_CLUSTERS))
        cbar.set_ticklabels([cluster_info[str(i)]["name"] for i in range(N_CLUSTERS)])

        # Mean height per block
        height_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
        for i, (x, y) in enumerate(coords):
            if 0 <= x < MAP_SIZE and 0 <= y < MAP_SIZE:
                height_grid[x, y] = features[i, 0]
        im2 = axes[0, 1].imshow(height_grid.T, origin='lower', cmap='terrain', vmin=0, vmax=130)
        axes[0, 1].set_title("Mean Height per Block", fontsize=14)
        plt.colorbar(im2, ax=axes[0, 1], shrink=0.7)

        # Roughness per block
        rough_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
        for i, (x, y) in enumerate(coords):
            if 0 <= x < MAP_SIZE and 0 <= y < MAP_SIZE:
                rough_grid[x, y] = features[i, 6] + features[i, 7]
        im3 = axes[1, 0].imshow(rough_grid.T, origin='lower', cmap='hot', vmin=0)
        axes[1, 0].set_title("Terrain Roughness", fontsize=14)
        plt.colorbar(im3, ax=axes[1, 0], shrink=0.7)

        # Height variance per block
        var_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
        for i, (x, y) in enumerate(coords):
            if 0 <= x < MAP_SIZE and 0 <= y < MAP_SIZE:
                var_grid[x, y] = features[i, 1]
        im4 = axes[1, 1].imshow(var_grid.T, origin='lower', cmap='viridis')
        axes[1, 1].set_title("Height Variance (std dev)", fontsize=14)
        plt.colorbar(im4, ax=axes[1, 1], shrink=0.7)

        for ax in axes.flat:
            ax.axis('off')

        fig.suptitle("Retail AC Terrain Analysis & Derived Biomes", fontsize=16, fontweight='bold')
        fig.tight_layout()
        fig.savefig(OUTPUT_DIR / "retail_biome_map.png", dpi=150)
        plt.close()
        print(f"  Saved visualization: {OUTPUT_DIR / 'retail_biome_map.png'}")

    except Exception as e:
        print(f"  Could not create visualization: {e}")

    print(f"\n{'=' * 70}")
    print("  Done! Biome data ready for V3 training.")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
