#!/usr/bin/env python3
"""
analyze_envcells.py -- Analyze image.webp to map red pixels (env/dungeon cells).

Reads image.webp (the megadat world visualization from Advan), identifies all red
pixels which represent EnvCells (dungeon interiors, building interiors, apartments),
and produces:
  1. A mask image showing only the red regions
  2. A 255x255 grid marking which landblocks contain env cells
  3. Classification of red regions (inner sea L-shape, left bar, bottom bars, scattered)
  4. Statistics and a JSON export of cell locations

Usage:
    .venv311\Scripts\python.exe scripts\analyze_envcells.py
"""

import json
from pathlib import Path
import numpy as np
from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
IMAGE_PATH = PROJECT_ROOT / "image.webp"
OUTPUT_DIR = PROJECT_ROOT / "data"
MAP_SIZE = 255

def main():
    print("=" * 70)
    print("  ENV CELL ANALYSIS -- image.webp red pixel extraction")
    print("=" * 70)

    # Load image
    img = Image.open(IMAGE_PATH)
    w, h = img.size
    print(f"  Image size: {w} x {h}")
    pixels = np.array(img)
    print(f"  Pixel array shape: {pixels.shape}, dtype: {pixels.dtype}")

    # Identify red pixels
    # Red = high R, low G, low B (accounting for JPEG/WebP compression artifacts)
    if pixels.shape[2] >= 3:
        r, g, b = pixels[:,:,0], pixels[:,:,1], pixels[:,:,2]
    else:
        print("  ERROR: image doesn't have RGB channels")
        return

    # Red detection: R > 150, G < 80, B < 80 (fairly aggressive)
    red_mask = (r > 150) & (g < 100) & (b < 100)
    # Also catch brighter reds
    red_mask2 = (r > 180) & (g < 120) & (b < 120) & (r > g * 2) & (r > b * 2)
    red_mask = red_mask | red_mask2

    red_count = red_mask.sum()
    total_pixels = red_mask.size
    print(f"  Red pixels: {red_count:,} ({red_count*100/total_pixels:.2f}%)")

    # Save red mask visualization
    mask_img = np.zeros((h, w, 3), dtype=np.uint8)
    mask_img[red_mask] = [255, 0, 0]
    # Also show non-red as dark gray for context
    non_red = ~red_mask
    mask_img[non_red, 0] = pixels[non_red, 0] // 4
    mask_img[non_red, 1] = pixels[non_red, 1] // 4
    mask_img[non_red, 2] = pixels[non_red, 2] // 4
    Image.fromarray(mask_img).save(OUTPUT_DIR / "envcell_mask.png")
    print(f"  Saved: {OUTPUT_DIR / 'envcell_mask.png'}")

    # Map to 255x255 landblock grid
    # Each landblock covers a region of the image
    scale_x = w / MAP_SIZE
    scale_y = h / MAP_SIZE

    envcell_grid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.int32)
    envcell_density = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)

    for lbx in range(MAP_SIZE):
        for lby in range(MAP_SIZE):
            # Image region for this landblock
            # Note: image Y is typically inverted from game Y
            x0 = int(lbx * scale_x)
            x1 = int((lbx + 1) * scale_x)
            y0 = int((MAP_SIZE - 1 - lby) * scale_y)  # flip Y
            y1 = int((MAP_SIZE - lby) * scale_y)

            x0, x1 = max(0, x0), min(w, x1)
            y0, y1 = max(0, y0), min(h, y1)

            if x1 > x0 and y1 > y0:
                region = red_mask[y0:y1, x0:x1]
                red_in_region = region.sum()
                region_size = region.size
                density = red_in_region / region_size if region_size > 0 else 0

                if density > 0.1:  # >10% red pixels = env cell present
                    envcell_grid[lbx, lby] = 1
                    envcell_density[lbx, lby] = density

    env_blocks = envcell_grid.sum()
    print(f"  Landblocks with env cells: {env_blocks} ({env_blocks*100/MAP_SIZE**2:.1f}%)")

    # Classify regions using connected components (simple flood fill)
    print("\n  Analyzing regions...")
    visited = np.zeros_like(envcell_grid, dtype=bool)
    regions = []

    def flood_fill(sx, sy):
        """Simple BFS flood fill to find connected components."""
        from collections import deque
        queue = deque([(sx, sy)])
        visited[sx, sy] = True
        cells = [(sx, sy)]
        while queue:
            x, y = queue.popleft()
            for dx, dy in [(-1,0),(1,0),(0,-1),(0,1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE:
                    if not visited[nx, ny] and envcell_grid[nx, ny] == 1:
                        visited[nx, ny] = True
                        queue.append((nx, ny))
                        cells.append((nx, ny))
        return cells

    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if envcell_grid[x, y] == 1 and not visited[x, y]:
                cells = flood_fill(x, y)
                if len(cells) >= 2:  # Ignore isolated single pixels
                    xs = [c[0] for c in cells]
                    ys = [c[1] for c in cells]
                    region_info = {
                        "size": len(cells),
                        "min_x": min(xs), "max_x": max(xs),
                        "min_y": min(ys), "max_y": max(ys),
                        "center_x": sum(xs) / len(xs),
                        "center_y": sum(ys) / len(ys),
                    }

                    # Classify
                    width = region_info["max_x"] - region_info["min_x"]
                    height = region_info["max_y"] - region_info["min_y"]

                    if len(cells) > 500:
                        region_info["type"] = "major_dungeon_zone"
                    elif len(cells) > 100:
                        region_info["type"] = "large_cluster"
                    elif len(cells) > 20:
                        region_info["type"] = "medium_cluster"
                    elif width > height * 3:
                        region_info["type"] = "horizontal_bar"
                    elif height > width * 3:
                        region_info["type"] = "vertical_bar"
                    else:
                        region_info["type"] = "small_cluster"

                    regions.append(region_info)

    # Sort by size
    regions.sort(key=lambda r: -r["size"])

    print(f"\n  Found {len(regions)} connected regions:")
    for i, r in enumerate(regions[:20]):
        print(
            f"    Region {i+1}: {r['size']:5d} blocks, "
            f"type={r['type']:20s}, "
            f"x=[{r['min_x']:3d}-{r['max_x']:3d}], "
            f"y=[{r['min_y']:3d}-{r['max_y']:3d}], "
            f"center=({r['center_x']:.0f},{r['center_y']:.0f})"
        )

    # Summary by quadrant
    print("\n  Distribution by quadrant:")
    quadrants = {"NW": 0, "NE": 0, "SW": 0, "SE": 0, "center": 0}
    mid = MAP_SIZE // 2
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if envcell_grid[x, y] == 1:
                if abs(x - mid) < 30 and abs(y - mid) < 30:
                    quadrants["center"] += 1
                elif x < mid and y >= mid:
                    quadrants["NW"] += 1
                elif x >= mid and y >= mid:
                    quadrants["NE"] += 1
                elif x < mid and y < mid:
                    quadrants["SW"] += 1
                else:
                    quadrants["SE"] += 1

    for quad, count in quadrants.items():
        print(f"    {quad}: {count} blocks")

    # Save outputs
    np.save(OUTPUT_DIR / "envcell_grid.npy", envcell_grid)
    print(f"\n  Saved: {OUTPUT_DIR / 'envcell_grid.npy'}")

    save_data = {
        "total_env_blocks": int(env_blocks),
        "total_landblocks": MAP_SIZE * MAP_SIZE,
        "pct_env": float(env_blocks * 100 / MAP_SIZE**2),
        "regions": regions[:50],  # Top 50
        "quadrant_distribution": quadrants,
        "source": "image.webp (megadat visualization from Advan)",
        "notes": [
            "Red pixels in image.webp represent EnvCells (dungeon/interior cells)",
            "Major zones: inner sea L-shape, left border bar, bottom border bars",
            "These landblocks must NOT be overwritten with surface terrain",
            "Megadat adds islands not in retail, but dungeon cell locations should match EOR",
        ],
    }
    with open(OUTPUT_DIR / "envcell_analysis.json", "w") as f:
        json.dump(save_data, f, indent=2)
    print(f"  Saved: {OUTPUT_DIR / 'envcell_analysis.json'}")

    # Visualization
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(1, 3, figsize=(24, 8))

        # Red mask on original (downsampled)
        axes[0].imshow(mask_img)
        axes[0].set_title("Red Pixels (Env Cells) in image.webp", fontsize=12)
        axes[0].axis('off')

        # Landblock grid
        grid_rgb = np.zeros((MAP_SIZE, MAP_SIZE, 3), dtype=np.uint8)
        grid_rgb[:, :, 2] = 40  # dark blue background
        grid_rgb[envcell_grid == 1, 0] = 255  # red for env cells
        grid_rgb[envcell_grid == 1, 1] = 0
        grid_rgb[envcell_grid == 1, 2] = 0
        axes[1].imshow(grid_rgb, origin='lower')
        axes[1].set_title(f"Env Cell Grid (255x255) -- {env_blocks} blocks", fontsize=12)
        axes[1].axis('off')

        # Density heatmap
        im = axes[2].imshow(envcell_density.T, origin='lower', cmap='hot', vmin=0, vmax=1)
        axes[2].set_title("Env Cell Density per Landblock", fontsize=12)
        plt.colorbar(im, ax=axes[2], shrink=0.7)
        axes[2].axis('off')

        fig.suptitle("Asheron's Call Env Cell Analysis", fontsize=14, fontweight='bold')
        fig.tight_layout()
        fig.savefig(OUTPUT_DIR / "envcell_analysis.png", dpi=150)
        plt.close()
        print(f"  Saved: {OUTPUT_DIR / 'envcell_analysis.png'}")
    except Exception as e:
        print(f"  Could not create visualization: {e}")

    print(f"\n{'=' * 70}")
    print("  Done! Env cell data ready for world generation planning.")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
