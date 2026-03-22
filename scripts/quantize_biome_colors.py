"""
Snaps every pixel in the AI-generated landmass to the nearest approved
biome palette color, using the ocean_mask to skip ocean pixels.
"""
from PIL import Image
import math

INPUT   = "pipeline_data/screenshots/world_map_ai.png"
MASK    = "pipeline_data/screenshots/ocean_mask.png"
OUTPUT  = "pipeline_data/screenshots/world_map_quantized.png"

# Canonical representative colors for each biome (approximate center of HSB range).
# These must fall within the ranges documented in the palette table.
PALETTE = {
    "forest":    (45,  90,  80),   # Dark teal
    "grassland": (80, 140, 110),   # Lighter green-teal
    "snow":      (230, 235, 240),  # Near-white
    "swamp":     (19,  45,  64),   # #132D40 - exact Blackmire dark blue
    "water":     (99, 149, 206),   # #6395CE - bright river blue
    "desert":    (180, 160, 90),   # Warm sandy olive
    "barren":    (140, 130, 120),  # Mid grey
    "obsidian":  (45,  40,  40),   # Very dark with slight tint
    "mountain":  (190, 185, 180),  # Bright desaturated grey
    "road":      (210, 155, 60),   # Orange-gold
}

PALETTE_COLORS = list(PALETTE.values())

def nearest_color(r, g, b):
    best, best_dist = None, float("inf")
    for color in PALETTE_COLORS:
        d = math.sqrt((r-color[0])**2 + (g-color[1])**2 + (b-color[2])**2)
        if d < best_dist:
            best_dist, best = d, color
    return best

img  = Image.open(INPUT).convert("RGB")
mask = Image.open(MASK).convert("L")
out  = img.copy()

px_img, px_mask, px_out = img.load(), mask.load(), out.load()
w, h = img.size

land_count = 0
ocean_count = 0
biome_counts = {name: 0 for name in PALETTE}

for y in range(h):
    for x in range(w):
        if px_mask[x, y] > 128:   # white = land, snap it
            r, g, b = px_img[x, y]
            nearest = nearest_color(r, g, b)
            px_out[x, y] = nearest
            # Count which biome it mapped to
            for name, color in PALETTE.items():
                if color == nearest:
                    biome_counts[name] += 1
                    break
            land_count += 1
        else:
            ocean_count += 1
        # black = ocean — leave pixel untouched

out.save(OUTPUT)
print(f"Saved -> {OUTPUT}")
print(f"  Land pixels:  {land_count:,}")
print(f"  Ocean pixels: {ocean_count:,}")
print(f"\n  Biome distribution:")
for name, count in sorted(biome_counts.items(), key=lambda x: -x[1]):
    if count > 0:
        pct = count / land_count * 100 if land_count else 0
        print(f"    {name:15s}: {count:8,}  ({pct:5.1f}%)")
