"""
generate_ocean_mask.py  (v2 — flood-fill based)
================================================
Generates a strict black-and-white ocean mask from the Dereth world_map.png.

  BLACK (0,0,0)       = ocean / impassable water  (IsLand = false)
  WHITE (255,255,255) = land                       (IsLand = true)

STRATEGY
--------
Version 1 used per-pixel HSB rules for ocean detection. The problem: the
dominant Dereth land color (dark teal forest, H≈190° S≈0.40-0.50) falls
squarely inside the "coastal grey" HSB range, causing massive false positives
on inland terrain.

Version 2 uses a two-pass approach:

  Pass A – Flood-fill from the image border
    The ocean wraps the entire exterior of the map. A BFS/flood-fill starting
    at every border pixel that matches the ocean color will grow through all
    connected ocean pixels — no inland pixel can be reached, regardless of
    its color. This is completely immune to false positives.

  Pass B – Exact color match for impassable inland water
    The second impassable type (#363C1D olive-dark-green) exists as isolated
    inland bodies, disconnected from the ocean border. It is matched by exact
    RGB with a tight tolerance.

  Pass C – Pure black border padding
    Edge pixels that are pure black (image padding) are ocean.

The broad coastal-grey HSB rule from v1 is removed entirely.

Output:
  ocean_mask.png      — 1-bit mask  (black=ocean, white=land)
  ocean_mask_preview.png — RGB preview (dark red=ocean, forest green=land)

Usage:
  pip install Pillow
  python scripts/generate_ocean_mask.py [input_image] [output_mask]

  Defaults: screenshots/world_map.png  ->  screenshots/ocean_mask.png
"""

import sys
from collections import deque
from pathlib import Path
from PIL import Image

# ── Config ───────────────────────────────────────────────────────────────────
INPUT_PATH   = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("screenshots/world_map.png")
OUTPUT_PATH  = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots/ocean_mask.png")
OUTPUT_PREVIEW = OUTPUT_PATH.with_name(OUTPUT_PATH.stem + "_preview.png")

# Exact ocean color (#3B211D) and flood-fill tolerance
# Tightened from ±8 to ±5: the passable boundary pixel #412722 has delta 6
# from ocean, so ±5 excludes it while still catching true ocean pixels.
OCEAN_R, OCEAN_G, OCEAN_B, OCEAN_TOL = 59, 33, 29, 5

# Exact impassable inland water (#363C1D) — isolated bodies, not flood-filled
IW_R, IW_G, IW_B, IW_TOL = 54, 60, 29, 10

# ── Helpers ──────────────────────────────────────────────────────────────────
def matches_ocean(r: int, g: int, b: int) -> bool:
    """True if pixel is within ocean color tolerance."""
    return (abs(r - OCEAN_R) <= OCEAN_TOL and
            abs(g - OCEAN_G) <= OCEAN_TOL and
            abs(b - OCEAN_B) <= OCEAN_TOL)

def matches_impassable_water(r: int, g: int, b: int) -> bool:
    """True if pixel is the impassable inland water color."""
    return (abs(r - IW_R) <= IW_TOL and
            abs(g - IW_G) <= IW_TOL and
            abs(b - IW_B) <= IW_TOL)

def matches_black_void(r: int, g: int, b: int) -> bool:
    # NOTE: Not used in flood-fill. The world_map.png has NO pure black padding;
    # border pixels are #3B211D (ocean) or #455562 (grey-blue). This threshold
    # was destroying obsidian/volcanic terrain (darkest at R=14 G=9 B=12).
    return r < 5 and g < 5 and b < 5  # Only truly black pixels (almost never hit)

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    print(f"Loading: {INPUT_PATH}")
    img = Image.open(INPUT_PATH).convert("RGB")
    w, h = img.size
    print(f"Image size: {w}x{h}")

    pixels = img.load()

    # Output mask: 0 = ocean (black), 255 = land (white). Start all as land.
    mask_data = bytearray(w * h)  # flat array, all 0 initially

    # ── Pass A: Flood-fill ocean from all border pixels ──────────────────────
    print("Pass A: Flood-fill ocean from border...")
    visited = bytearray(w * h)  # 0 = unvisited
    queue = deque()

    def try_seed(x, y):
        idx = y * w + x
        if visited[idx]:
            return
        r, g, b = pixels[x, y]
        if matches_ocean(r, g, b):
            visited[idx] = 1
            queue.append((x, y))

    # Seed from all four borders
    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)

    flood_count = 0
    while queue:
        cx, cy = queue.popleft()
        mask_data[cy * w + cx] = 0   # ocean = black
        flood_count += 1

        for nx, ny in ((cx-1, cy), (cx+1, cy), (cx, cy-1), (cx, cy+1)):
            if 0 <= nx < w and 0 <= ny < h:
                nidx = ny * w + nx
                if not visited[nidx]:
                    nr, ng, nb = pixels[nx, ny]
                    if matches_ocean(nr, ng, nb):
                        visited[nidx] = 1
                        queue.append((nx, ny))

    print(f"  Border flood-fill marked {flood_count:,} ocean pixels")

    # ── Pass A2: Interior ocean bodies ────────────────────────────────────────
    # The border flood catches the exterior ocean, but large interior ocean
    # bodies (e.g. the 458K-pixel inland sea at x=[480,1164] y=[798,1855])
    # are completely enclosed by land. Scan for unvisited ocean-colored pixels,
    # flood-fill each cluster, and mark as ocean if >= MIN_INTERIOR_OCEAN_SIZE.
    MIN_INTERIOR_OCEAN_SIZE = 1000  # pixels; small specks stay as land
    print(f"Pass A2: Interior ocean bodies (min {MIN_INTERIOR_OCEAN_SIZE} px)...")
    interior_ocean_count = 0
    interior_bodies = 0

    for sy in range(h):
        for sx in range(w):
            sidx = sy * w + sx
            if visited[sidx]:
                continue
            r, g, b = pixels[sx, sy]
            if not matches_ocean(r, g, b):
                continue
            # Found an unvisited ocean-colored pixel — flood-fill to measure cluster
            cluster = []
            q2 = deque([(sx, sy)])
            visited[sidx] = 1
            while q2:
                cx, cy = q2.popleft()
                cluster.append((cx, cy))
                for nx, ny in ((cx-1, cy), (cx+1, cy), (cx, cy-1), (cx, cy+1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        nidx = ny * w + nx
                        if not visited[nidx]:
                            nr, ng, nb = pixels[nx, ny]
                            if matches_ocean(nr, ng, nb):
                                visited[nidx] = 1
                                q2.append((nx, ny))
            # Mark as ocean only if cluster is large enough
            if len(cluster) >= MIN_INTERIOR_OCEAN_SIZE:
                for cx, cy in cluster:
                    mask_data[cy * w + cx] = 0  # ocean
                interior_ocean_count += len(cluster)
                interior_bodies += 1
                print(f"    Interior body #{interior_bodies}: {len(cluster):,} pixels")

    print(f"  Interior ocean: {interior_ocean_count:,} pixels in {interior_bodies} bodies")
    flood_count += interior_ocean_count


    # ── Pass B: Mark all unvisited pixels as land, then check impassable water ─
    print("Pass B: Impassable inland water exact-color pass...")
    iw_count = 0
    land_count = 0
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            if visited[idx]:
                mask_data[idx] = 0   # ocean (flood-filled)
            else:
                r, g, b = pixels[x, y]
                if matches_impassable_water(r, g, b):
                    mask_data[idx] = 0   # impassable inland water = black
                    iw_count += 1
                else:
                    mask_data[idx] = 255  # land = white
                    land_count += 1

    ocean_total = flood_count + iw_count
    total = w * h
    print(f"  Impassable water pixels: {iw_count:,}")
    print(f"  Ocean total  : {ocean_total:,}  ({100*ocean_total/total:.1f}%)")
    print(f"  Land total   : {land_count:,}  ({100*land_count/total:.1f}%)")

    # ── Write outputs ─────────────────────────────────────────────────────────
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    mask_img = Image.frombytes("L", (w, h), bytes(mask_data))
    mask_img.save(OUTPUT_PATH)

    # Color preview
    preview = Image.new("RGB", (w, h))
    preview_px = preview.load()
    for y in range(h):
        for x in range(w):
            preview_px[x, y] = (34, 139, 34) if mask_data[y * w + x] == 255 else (139, 0, 0)
    preview.save(OUTPUT_PREVIEW)

    print(f"\nSaved mask    : {OUTPUT_PATH}")
    print(f"Saved preview : {OUTPUT_PREVIEW}")
    print("\nDone.")
    print("  BLACK = ocean/impassable (do NOT paint here)")
    print("  WHITE = land             (inpaint here)")

if __name__ == "__main__":
    main()
