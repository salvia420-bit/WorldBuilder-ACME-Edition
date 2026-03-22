"""
Cleanup script for world_map_quantized.png:
  1) Any pixel that falls in the BLACK region of ocean_mask.png is replaced
     with the original ocean pixel from world_map.png (ocean enforcement).
  2) Any LAND pixel (white in mask) that is too close to the ocean color
     (#3B211D) or impassable water color (#363C1D) is re-snapped to the
     nearest *non-ocean* biome palette color.

This ensures no ocean-like colors survive on the landmass.
"""
from PIL import Image
import math, sys

QUANTIZED = "screenshots/world_map_quantized.png"
MASK      = "screenshots/ocean_mask.png"
ORIGINAL  = "screenshots/world_map.png"
OUTPUT    = "screenshots/world_map_quantized.png"   # overwrite in-place

# ── Ocean / impassable water reference colors ────────────────────────
OCEAN_RGB           = (59, 33, 29)     # #3B211D
OCEAN_TOLERANCE     = 15               # generous to catch any near-ocean shades
IMPASSABLE_RGB      = (54, 60, 29)     # #363C1D
IMPASSABLE_TOLERANCE = 15

# ── Land biome palette (same as quantize_biome_colors.py) ────────────
PALETTE = {
    "forest":    (45,  90,  80),
    "grassland": (80, 140, 110),
    "snow":      (230, 235, 240),
    "swamp":     (19,  45,  64),
    "water":     (99, 149, 206),
    "desert":    (180, 160, 90),
    "barren":    (140, 130, 120),
    "obsidian":  (45,  40,  40),
    "mountain":  (190, 185, 180),
    "road":      (210, 155, 60),
}

# Pre-filter: palette entries that are themselves too close to ocean
# (obsidian is dark but distinct enough; still, let's check)
def _color_dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))

SAFE_PALETTE = {}
for name, rgb in PALETTE.items():
    dist_ocean = _color_dist(rgb, OCEAN_RGB)
    dist_impass = _color_dist(rgb, IMPASSABLE_RGB)
    if dist_ocean > 30 and dist_impass > 30:
        SAFE_PALETTE[name] = rgb
    else:
        print(f"  [!] Palette '{name}' {rgb} is close to ocean (d={dist_ocean:.1f}) "
              f"or impassable (d={dist_impass:.1f}) — EXCLUDED from safe palette")

SAFE_COLORS = list(SAFE_PALETTE.values())

if not SAFE_COLORS:
    print("ERROR: No safe palette colors remain. Check tolerances.")
    sys.exit(1)

print(f"Safe palette has {len(SAFE_COLORS)} biomes: {list(SAFE_PALETTE.keys())}")


def nearest_safe_color(r, g, b):
    """Find the nearest palette color that is NOT ocean-like."""
    best, best_dist = None, float("inf")
    for color in SAFE_COLORS:
        d = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2
        if d < best_dist:
            best_dist, best = d, color
    return best


def is_ocean_like(r, g, b):
    """Return True if the color is within tolerance of ocean or impassable water."""
    d_ocean = abs(r - OCEAN_RGB[0]) + abs(g - OCEAN_RGB[1]) + abs(b - OCEAN_RGB[2])
    d_impass = abs(r - IMPASSABLE_RGB[0]) + abs(g - IMPASSABLE_RGB[1]) + abs(b - IMPASSABLE_RGB[2])
    # Per-channel check (like the game engine uses)
    ocean_match = (abs(r - OCEAN_RGB[0]) <= OCEAN_TOLERANCE and
                   abs(g - OCEAN_RGB[1]) <= OCEAN_TOLERANCE and
                   abs(b - OCEAN_RGB[2]) <= OCEAN_TOLERANCE)
    impass_match = (abs(r - IMPASSABLE_RGB[0]) <= IMPASSABLE_TOLERANCE and
                    abs(g - IMPASSABLE_RGB[1]) <= IMPASSABLE_TOLERANCE and
                    abs(b - IMPASSABLE_RGB[2]) <= IMPASSABLE_TOLERANCE)
    return ocean_match or impass_match


# ── Load images ──────────────────────────────────────────────────────
print("Loading images...")
quantized = Image.open(QUANTIZED).convert("RGB")
mask      = Image.open(MASK).convert("L")
original  = Image.open(ORIGINAL).convert("RGB")

# Verify sizes match
assert quantized.size == mask.size, \
    f"Quantized {quantized.size} != Mask {mask.size}"
assert quantized.size == original.size or True, \
    f"Quantized {quantized.size} != Original {original.size} (will skip ocean restore)"

w, h = quantized.size
out = quantized.copy()

px_q    = quantized.load()
px_mask = mask.load()
px_orig = original.load()
px_out  = out.load()

# ── Pass 1: Enforce ocean mask (black region -> original pixels) ─────
ocean_restored = 0
# ── Pass 2: Fix ocean-colored land pixels ────────────────────────────
ocean_land_fixed = 0
land_pixels = 0

print(f"Processing {w}x{h} = {w*h:,} pixels...")

for y in range(h):
    if y % 200 == 0:
        print(f"  Row {y}/{h}...")
    for x in range(w):
        m = px_mask[x, y]
        if m <= 128:
            # OCEAN region (black in mask) -> restore original pixel
            if original.size == quantized.size:
                px_out[x, y] = px_orig[x, y]
                ocean_restored += 1
        else:
            # LAND region (white in mask)
            land_pixels += 1
            r, g, b = px_q[x, y]
            if is_ocean_like(r, g, b):
                # This land pixel looks like ocean — re-snap to safe biome
                new_color = nearest_safe_color(r, g, b)
                px_out[x, y] = new_color
                ocean_land_fixed += 1

# ── Save ─────────────────────────────────────────────────────────────
out.save(OUTPUT, compress_level=0)
print(f"\nDone! Saved -> {OUTPUT}")
print(f"  Ocean pixels restored from original: {ocean_restored:,}")
print(f"  Land pixels checked:                 {land_pixels:,}")
print(f"  Land pixels re-snapped (were ocean-like): {ocean_land_fixed:,}")
