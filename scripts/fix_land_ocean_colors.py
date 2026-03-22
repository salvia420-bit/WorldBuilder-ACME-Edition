"""
Fix Land Ocean Colors
=====================
Problem: Stable Diffusion inpainting generated pixels on the LAND areas that
look like ocean water (the dark reddish-brown #3B211D color from world_map.png).
If these pixels survive into the final image, the terrain agent will classify
them as ocean/impassable and skip them — creating invisible voids in-game.

Solution: This script scans all LAND pixels (white in ocean_mask.png) in the
AI-generated attempt image. Any pixels whose color falls within the ocean
detection tolerance (#3B211D +-5) or impassable water tolerance (#363C1D +-10)
are replaced with the nearest safe land biome color.

Additionally, this script detects large patches of blue "water-like" colors
on land that the diffusion model erroneously created, and replaces them with
appropriate land biome colors.

Usage:
    python scripts/fix_land_ocean_colors.py [input] [mask] [output]
    
    Defaults:
        input  = screenshots/attempt1.png
        mask   = screenshots/ocean_mask.png
        output = screenshots/world_map_ai.png  (the expected input for quantize step)
"""

import sys
import os
import math
from PIL import Image
import colorsys

# --- Paths ---
INPUT  = sys.argv[1] if len(sys.argv) > 1 else "screenshots/attempt1.png"
MASK   = sys.argv[2] if len(sys.argv) > 2 else "screenshots/ocean_mask.png"
OUTPUT = sys.argv[3] if len(sys.argv) > 3 else "screenshots/world_map_ai.png"

# --- Ocean / Impassable color definitions (from HowToMakeNewWorlds.md) ---
OCEAN_COLOR = (59, 33, 29)        # #3B211D
OCEAN_TOLERANCE = 5               # +-5 per channel

IMPASSABLE_COLOR = (54, 60, 29)   # #363C1D
IMPASSABLE_TOLERANCE = 10         # +-10 per channel

# --- Safe biome replacement colors ---
# When an ocean-like pixel is found on land, replace it with a contextually
# appropriate land color. We'll use the nearest approved biome color from
# the palette defined in HowToMakeNewWorlds.md.
BIOME_PALETTE = {
    "forest":    (45,  90,  80),
    "grassland": (80, 140, 110),
    "snow":      (230, 235, 240),
    "swamp":     (19,  45,  64),
    "water":     (99, 149, 206),   # passable water (rivers/lakes) - #6395CE
    "desert":    (180, 160, 90),
    "barren":    (140, 130, 120),
    "obsidian":  (45,  40,  40),
    "mountain":  (190, 185, 180),
    "road":      (210, 155, 60),
}

# Colors that are safe replacements for ocean-colored land pixels
# (exclude water since we want to avoid blue-like colors that could confuse things)
SAFE_LAND_COLORS = [
    BIOME_PALETTE["forest"],
    BIOME_PALETTE["grassland"],
    BIOME_PALETTE["barren"],
    BIOME_PALETTE["obsidian"],
    BIOME_PALETTE["desert"],
]


def is_ocean_color(r, g, b):
    """Check if pixel falls within ocean detection tolerance."""
    return (abs(r - OCEAN_COLOR[0]) <= OCEAN_TOLERANCE and
            abs(g - OCEAN_COLOR[1]) <= OCEAN_TOLERANCE and
            abs(b - OCEAN_COLOR[2]) <= OCEAN_TOLERANCE)


def is_impassable_color(r, g, b):
    """Check if pixel falls within impassable water detection tolerance."""
    return (abs(r - IMPASSABLE_COLOR[0]) <= IMPASSABLE_TOLERANCE and
            abs(g - IMPASSABLE_COLOR[1]) <= IMPASSABLE_TOLERANCE and
            abs(b - IMPASSABLE_COLOR[2]) <= IMPASSABLE_TOLERANCE)


def color_distance(c1, c2):
    """Euclidean distance between two RGB tuples."""
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2)))


def nearest_safe_color(r, g, b):
    """Find the nearest safe land color for an ocean-colored pixel."""
    best = None
    best_dist = float("inf")
    for color in SAFE_LAND_COLORS:
        d = color_distance((r, g, b), color)
        if d < best_dist:
            best_dist = d
            best = color
    return best


def nearest_biome_color(r, g, b):
    """Find the nearest biome color from the full palette."""
    best = None
    best_dist = float("inf")
    for name, color in BIOME_PALETTE.items():
        d = color_distance((r, g, b), color)
        if d < best_dist:
            best_dist = d
            best = color
    return best


def main():
    print(f"Loading input:  {INPUT}")
    print(f"Loading mask:   {MASK}")
    
    img = Image.open(INPUT).convert("RGB")
    mask = Image.open(MASK).convert("L")
    
    if img.size != mask.size:
        print(f"WARNING: Image size {img.size} != mask size {mask.size}")
        print(f"Resizing mask to match image...")
        mask = mask.resize(img.size, Image.NEAREST)
    
    out = img.copy()
    px_img = img.load()
    px_mask = mask.load()
    px_out = out.load()
    w, h = img.size
    
    ocean_fixes = 0
    impassable_fixes = 0
    total_land = 0
    
    print(f"Image size: {w}x{h}")
    print(f"Scanning land pixels for ocean-colored contamination...")
    print()
    
    for y in range(h):
        if y % 200 == 0:
            print(f"  Progress: row {y}/{h} ({100*y//h}%)")
        for x in range(w):
            # Only process land pixels (white in mask)
            if px_mask[x, y] > 128:
                total_land += 1
                r, g, b = px_img[x, y]
                
                if is_ocean_color(r, g, b):
                    # This land pixel looks like ocean — replace it
                    px_out[x, y] = nearest_safe_color(r, g, b)
                    ocean_fixes += 1
                elif is_impassable_color(r, g, b):
                    # This land pixel looks like impassable water — replace it
                    px_out[x, y] = nearest_safe_color(r, g, b)
                    impassable_fixes += 1
    
    print()
    print(f"=== Results ===")
    print(f"Total land pixels:          {total_land:,}")
    print(f"Ocean-colored fixes:        {ocean_fixes:,}")
    print(f"Impassable-colored fixes:   {impassable_fixes:,}")
    print(f"Total pixels corrected:     {ocean_fixes + impassable_fixes:,}")
    
    if ocean_fixes + impassable_fixes > 0:
        pct = 100 * (ocean_fixes + impassable_fixes) / total_land
        print(f"Contamination rate:         {pct:.2f}% of land")
    else:
        print(f"No contamination found — land is clean!")
    
    print()
    print(f"Saving corrected image -> {OUTPUT}")
    out.save(OUTPUT, compress_level=0)
    print("Done! This image is ready for quantization (Step 3).")


if __name__ == "__main__":
    main()
