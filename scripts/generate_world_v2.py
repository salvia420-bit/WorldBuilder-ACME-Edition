#!/usr/bin/env python3
"""
generate_world_v2.py -- Generate a full 255x255 world using Terrain U-Net V2.

Uses the biome_map.json to drive generation, producing heightmaps and terrain
types for every land block. Renders the result as a world map image.

Usage:
    .venv311\Scripts\python.exe scripts\generate_world_v2.py
"""

import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# =====================================================================
# Paths
# =====================================================================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BIOME_FILE = PROJECT_ROOT / "pipeline_data" / "enrichment" / "biome_map.json"
MODEL_DIR = PROJECT_ROOT / "pipeline_data" / "models" / "v2"
MODEL_PATH = MODEL_DIR / "terrain_unet_v2.pt"
CONFIG_PATH = MODEL_DIR / "terrain_unet_v2_config.json"
OUTPUT_DIR = PROJECT_ROOT / "output_demo"

GRID_SIZE = 9
MAP_SIZE = 255
NUM_TERRAIN_TYPES = 32
NUM_BIOMES = 10

BIOME_NAMES = {
    "ocean": 0, "water": 1, "impassable_water": 2,
    "grassland": 3, "forest": 4, "desert": 5,
    "snow": 6, "swamp": 7, "barren": 8, "obsidian": 9,
}
OCEAN_BIOME_IDS = {0, 1, 2}

# Terrain type colors (from AC -- approximate visual palette)
TERRAIN_COLORS = {
    0: (30, 80, 30),     # BarrenRock - dark grey-green
    1: (60, 130, 50),    # Grassland - green
    2: (85, 155, 70),    # IceFields - ice-green (also forest)
    3: (170, 140, 80),   # LushGrass - desert/sand
    4: (200, 200, 220),  # Snow - white
    5: (70, 100, 45),    # DarkMud - dark green
    6: (120, 160, 90),   # Swamp - olive green
    7: (80, 70, 50),     # Mud - brown
    8: (50, 45, 35),     # DarkRock - dark brown
    9: (90, 80, 60),     # Desert - tan
    10: (80, 50, 35),    # Road - reddish brown
    11: (100, 110, 80),  # DirtRoad - dirt
}

# Biome colors for the overview map
BIOME_COLORS = {
    0: (20, 40, 120),    # ocean - deep blue
    1: (40, 80, 160),    # water - lighter blue
    2: (10, 20, 80),     # impassable_water - dark blue
    3: (100, 180, 60),   # grassland - bright green
    4: (30, 100, 30),    # forest - dark green
    5: (210, 180, 100),  # desert - sand
    6: (220, 230, 245),  # snow - near-white
    7: (80, 100, 50),    # swamp - olive
    8: (140, 120, 90),   # barren - tan-grey
    9: (40, 35, 40),     # obsidian - near-black
}


# =====================================================================
# Model (must match V2 architecture exactly)
# =====================================================================
class ResBlockV2(nn.Module):
    def __init__(self, channels, dropout=0.0):
        super().__init__()
        self.norm1 = nn.GroupNorm(min(8, channels), channels)
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1)
        self.norm2 = nn.GroupNorm(min(8, channels), channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1)
        self.drop = nn.Dropout2d(dropout) if dropout > 0 else nn.Identity()

    def forward(self, x):
        h = self.conv1(F.silu(self.norm1(x)))
        h = self.drop(h)
        h = self.conv2(F.silu(self.norm2(h)))
        return x + h


class TerrainUNetV2(nn.Module):
    def __init__(self, in_channels=17, base_channels=32, dropout=0.15):
        super().__init__()
        C = base_channels
        self.enc1 = nn.Sequential(nn.Conv2d(in_channels, C, 3, padding=1), nn.SiLU(), ResBlockV2(C, dropout))
        self.down1 = nn.Conv2d(C, C * 2, 3, stride=2, padding=1)
        self.enc2 = nn.Sequential(nn.SiLU(), ResBlockV2(C * 2, dropout))
        self.down2 = nn.Conv2d(C * 2, C * 4, 3, stride=2, padding=1)
        self.bottleneck = nn.Sequential(ResBlockV2(C * 4, dropout), ResBlockV2(C * 4, dropout))
        self.up2 = nn.ConvTranspose2d(C * 4, C * 2, 3, stride=2, padding=1, output_padding=0)
        self.dec2 = nn.Sequential(ResBlockV2(C * 2 + C * 2, dropout), nn.Conv2d(C * 2 + C * 2, C * 2, 1), ResBlockV2(C * 2, dropout))
        self.up1 = nn.ConvTranspose2d(C * 2, C, 4, stride=2, padding=1, output_padding=1)
        self.dec1 = nn.Sequential(ResBlockV2(C + C, dropout), nn.Conv2d(C + C, C, 1), ResBlockV2(C, dropout))
        self.height_head = nn.Sequential(nn.Conv2d(C, C // 2, 1), nn.SiLU(), nn.Dropout2d(dropout), nn.Conv2d(C // 2, 1, 1))
        self.terrain_head = nn.Sequential(nn.Conv2d(C, C // 2, 1), nn.SiLU(), nn.Dropout2d(dropout), nn.Conv2d(C // 2, NUM_TERRAIN_TYPES, 1))

    def forward(self, x):
        e1 = self.enc1(x)
        e2 = self.enc2(self.down1(e1))
        b = self.bottleneck(self.down2(e2))
        d2 = self.up2(b)
        d2 = self.dec2(torch.cat([d2, e2], dim=1))
        d1 = self.up1(d2)
        if d1.shape[-2:] != e1.shape[-2:]:
            d1 = F.interpolate(d1, size=e1.shape[-2:], mode='bilinear', align_corners=False)
        d1 = self.dec1(torch.cat([d1, e1], dim=1))
        return self.height_head(d1), self.terrain_head(d1)


# =====================================================================
# World Generator
# =====================================================================
class WorldGenerator:
    def __init__(self, model_path, config_path, device="cuda"):
        with open(config_path) as f:
            self.config = json.load(f)

        self.height_mean = self.config["height_mean"]
        self.height_std = self.config["height_std"]
        self.device = device

        self.model = TerrainUNetV2(
            in_channels=17,
            base_channels=self.config["base_channels"],
            dropout=0.0  # No dropout at inference
        ).to(device)

        ckpt = torch.load(model_path, map_location=device, weights_only=True)
        self.model.load_state_dict(ckpt["model_state_dict"])
        self.model.eval()

        # Generated world storage
        self.heightmaps = {}   # (x, y) -> (9, 9) height indices
        self.terrain_maps = {} # (x, y) -> (9, 9) terrain type IDs

    def _get_height(self, x, y):
        """Get normalized heightmap for a cell (zeros if not yet generated)."""
        if (x, y) in self.heightmaps:
            h = self.heightmaps[(x, y)].astype(np.float32)
            return (h - self.height_mean) / self.height_std
        return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)

    def _get_terrain(self, x, y):
        """Get terrain map for a cell (zeros if not yet generated)."""
        if (x, y) in self.terrain_maps:
            return self.terrain_maps[(x, y)].astype(np.float32) / NUM_TERRAIN_TYPES
        return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)

    def generate_block(self, x, y, biome_id):
        """Generate a single landblock using neighbor context."""
        neighbor_offsets = [
            (0, 1), (1, 1), (1, 0), (1, -1),
            (0, -1), (-1, -1), (-1, 0), (-1, 1)
        ]

        cond_channels = []
        for dx, dy in neighbor_offsets:
            cond_channels.append(self._get_height(x + dx, y + dy))
        for dx, dy in neighbor_offsets:
            cond_channels.append(self._get_terrain(x + dx, y + dy))

        biome_ch = np.full((GRID_SIZE, GRID_SIZE), biome_id / NUM_BIOMES, dtype=np.float32)
        cond_channels.append(biome_ch)

        cond = torch.from_numpy(np.stack(cond_channels)).unsqueeze(0).to(self.device)

        with torch.no_grad():
            h_pred, t_pred = self.model(cond)

        # Denormalize and clamp heights
        heightmap = h_pred.squeeze().cpu().numpy() * self.height_std + self.height_mean
        heightmap = np.clip(np.round(heightmap), 0, 255).astype(np.uint8)

        terrain = t_pred.squeeze().cpu().argmax(0).numpy().astype(np.uint8)

        self.heightmaps[(x, y)] = heightmap
        self.terrain_maps[(x, y)] = terrain

        return heightmap, terrain

    def generate_world(self, biome_grid):
        """
        Generate the full world using a spiral-out pattern from center.
        This ensures maximum neighbor context for each block.
        """
        center = MAP_SIZE // 2

        # Build generation order: spiral from center outward
        # This maximizes the number of already-generated neighbors
        order = []
        visited = set()

        # BFS spiral from center
        from collections import deque
        queue = deque()

        # Find a land cell near center to start from
        start = None
        for r in range(MAP_SIZE):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    cx, cy = center + dx, center + dy
                    if 0 <= cx < MAP_SIZE and 0 <= cy < MAP_SIZE:
                        bid = int(biome_grid[cx, cy])
                        if bid not in OCEAN_BIOME_IDS:
                            start = (cx, cy)
                            break
                if start:
                    break
            if start:
                break

        if start is None:
            print("  ERROR: No land found!")
            return

        print(f"  Starting from ({start[0]}, {start[1]})")

        # BFS to get generation order (land blocks only, spreading outward)
        queue.append(start)
        visited.add(start)
        land_count = 0
        total_land = 0

        # Count total land blocks
        for x in range(MAP_SIZE):
            for y in range(MAP_SIZE):
                if int(biome_grid[x, y]) not in OCEAN_BIOME_IDS:
                    total_land += 1

        while queue:
            x, y = queue.popleft()
            bid = int(biome_grid[x, y])

            if bid not in OCEAN_BIOME_IDS:
                order.append((x, y, bid))
                land_count += 1

            # Expand to all 8 neighbors
            for dx, dy in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < MAP_SIZE and 0 <= ny < MAP_SIZE and (nx, ny) not in visited:
                    visited.add((nx, ny))
                    queue.append((nx, ny))

        print(f"  Generating {land_count} land blocks (spiral from center)...")

        # Also set ocean blocks to flat height=0
        for x in range(MAP_SIZE):
            for y in range(MAP_SIZE):
                bid = int(biome_grid[x, y])
                if bid in OCEAN_BIOME_IDS:
                    self.heightmaps[(x, y)] = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.uint8)
                    self.terrain_maps[(x, y)] = np.full((GRID_SIZE, GRID_SIZE), 0, dtype=np.uint8)

        # Generate land blocks in spiral order
        t0 = time.time()
        for i, (x, y, bid) in enumerate(order):
            self.generate_block(x, y, bid)
            if (i + 1) % 2000 == 0 or i == len(order) - 1:
                elapsed = time.time() - t0
                pct = (i + 1) / len(order) * 100
                rate = (i + 1) / elapsed if elapsed > 0 else 0
                eta = (len(order) - i - 1) / rate if rate > 0 else 0
                print(f"    {i+1}/{len(order)} ({pct:.0f}%) - {rate:.0f} blocks/s - ETA {eta:.0f}s")

        total = time.time() - t0
        print(f"  Generation complete in {total:.0f}s ({total/60:.1f} min)")


# =====================================================================
# Visualization
# =====================================================================
def render_world_maps(generator, biome_grid, output_dir):
    """Render heightmap, terrain type, and biome overview images."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Heightmap (each block's average height as a pixel)
    print("\n  Rendering heightmap...")
    height_img = np.zeros((MAP_SIZE, MAP_SIZE), dtype=np.float32)
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if (x, y) in generator.heightmaps:
                height_img[x, y] = generator.heightmaps[(x, y)].mean()
            else:
                height_img[x, y] = 0

    # 2. Detailed heightmap (full resolution: 255*9 = 2295 pixels)
    print("  Rendering high-res heightmap...")
    hires_h = MAP_SIZE * GRID_SIZE
    height_hires = np.zeros((hires_h, hires_h), dtype=np.float32)
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if (x, y) in generator.heightmaps:
                hm = generator.heightmaps[(x, y)]
                height_hires[x*9:(x+1)*9, y*9:(y+1)*9] = hm

    # 3. Terrain type image (full resolution)
    print("  Rendering terrain type map...")
    terrain_rgb = np.zeros((hires_h, hires_h, 3), dtype=np.uint8)
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            if (x, y) in generator.terrain_maps:
                tm = generator.terrain_maps[(x, y)]
                bid = int(biome_grid[x, y])
                for i in range(9):
                    for j in range(9):
                        tid = int(tm[i, j])
                        if bid in OCEAN_BIOME_IDS:
                            terrain_rgb[x*9+i, y*9+j] = BIOME_COLORS.get(bid, (20, 40, 120))
                        else:
                            terrain_rgb[x*9+i, y*9+j] = TERRAIN_COLORS.get(tid, (100, 100, 100))

    # 4. Biome overview (1 pixel per block)
    print("  Rendering biome overview...")
    biome_rgb = np.zeros((MAP_SIZE, MAP_SIZE, 3), dtype=np.uint8)
    for x in range(MAP_SIZE):
        for y in range(MAP_SIZE):
            bid = int(biome_grid[x, y])
            biome_rgb[x, y] = BIOME_COLORS.get(bid, (128, 128, 128))

    # -- Save images -------------------------------------------------------
    # Composite map: 2x2 grid
    fig, axes = plt.subplots(2, 2, figsize=(20, 20))

    # Top-left: biome overview
    axes[0, 0].imshow(biome_rgb, origin='lower')
    axes[0, 0].set_title("Biome Map (from biome_map.json)", fontsize=14)
    axes[0, 0].axis('off')

    # Top-right: average heightmap
    im = axes[0, 1].imshow(height_img, origin='lower', cmap='terrain', vmin=0, vmax=128)
    axes[0, 1].set_title("Generated Heightmap (avg per block)", fontsize=14)
    axes[0, 1].axis('off')
    plt.colorbar(im, ax=axes[0, 1], shrink=0.7, label="Height Index")

    # Bottom-left: hi-res heightmap
    axes[1, 0].imshow(height_hires, origin='lower', cmap='terrain', vmin=0, vmax=160)
    axes[1, 0].set_title("Hi-Res Heightmap (9x9 per block)", fontsize=14)
    axes[1, 0].axis('off')

    # Bottom-right: terrain types
    axes[1, 1].imshow(terrain_rgb, origin='lower')
    axes[1, 1].set_title("Terrain Types (V2 Model)", fontsize=14)
    axes[1, 1].axis('off')

    fig.suptitle("World Generated by Terrain U-Net V2 -- GTX 1070", fontsize=18, fontweight='bold')
    fig.tight_layout()
    composite_path = output_dir / "world_v2_composite.png"
    fig.savefig(composite_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f"  Saved: {composite_path}")

    # Individual hi-res images
    from PIL import Image

    # Hi-res heightmap as grayscale
    hmap_path = output_dir / "world_v2_heightmap.png"
    hmap_img = Image.fromarray(np.clip(height_hires * 2, 0, 255).astype(np.uint8).T, mode='L')
    hmap_img.save(hmap_path)
    print(f"  Saved: {hmap_path}")

    # Hi-res terrain as RGB
    terrain_path = output_dir / "world_v2_terrain.png"
    # Transpose so X is horizontal
    terrain_save = np.transpose(terrain_rgb, (1, 0, 2))
    terrain_img = Image.fromarray(terrain_save, mode='RGB')
    terrain_img.save(terrain_path)
    print(f"  Saved: {terrain_path}")

    # Biome overview
    biome_path = output_dir / "world_v2_biome.png"
    biome_save = np.transpose(biome_rgb, (1, 0, 2))
    biome_img = Image.fromarray(biome_save, mode='RGB')
    biome_img.save(biome_path)
    print(f"  Saved: {biome_path}")

    print(f"\n  All outputs in: {output_dir}")


# =====================================================================
# Main
# =====================================================================
def main():
    print("=" * 70)
    print("  WORLD GENERATION -- Terrain U-Net V2")
    print("=" * 70)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  Device: {device}")

    # Load biome grid
    print("\n  Loading biome map...")
    with open(BIOME_FILE, "r", encoding="utf-8-sig") as f:
        biome_data = json.load(f)
    biome_list = biome_data["biomeGrid"]

    def biome_to_int(val):
        return BIOME_NAMES.get(val, 0) if isinstance(val, str) else int(val)

    if isinstance(biome_list[0], list):
        biome_grid = np.array(
            [[biome_to_int(v) for v in row] for row in biome_list], dtype=np.int32
        )
    else:
        side = int(np.sqrt(len(biome_list)))
        biome_grid = np.array(
            [biome_to_int(v) for v in biome_list], dtype=np.int32
        ).reshape(side, side)

    land_count = np.sum(~np.isin(biome_grid, list(OCEAN_BIOME_IDS)))
    print(f"  Biome grid: {biome_grid.shape}, land blocks: {land_count}")

    # Load model
    print(f"  Loading model from {MODEL_PATH}...")
    gen = WorldGenerator(MODEL_PATH, CONFIG_PATH, device=device)

    # Generate world
    gen.generate_world(biome_grid)

    # Render maps
    render_world_maps(gen, biome_grid, OUTPUT_DIR)

    print(f"\n{'=' * 70}")
    print("  Done! Check output_demo/ for the generated world maps.")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
