"""
Find suitable town locations on the Vanquish map.
Criteria:
  - Flat terrain (low height variance within the landblock and neighbors)
  - Moderate altitude (not peaks, not valleys)
  - Well-distributed across the map
  - Avoid edges (margin of 5 LBs)
  - Starter towns near corners/cardinal edges for easy access
"""
import json, math, os, random
import numpy as np

# ─── Load height data ────────────────────────────────────────────────────
heights_path = "pipeline_data/population_output/vanquish_heights.json"
raw = json.load(open(heights_path))

# Build 255x255 grid of average heights per landblock
grid = np.zeros((255, 255), dtype=np.float32)
for key, vals in raw.items():
    parts = key.split(",")
    x, y = int(parts[0]), int(parts[1])
    if 0 <= x < 255 and 0 <= y < 255:
        grid[x, y] = np.mean(vals)  # average of the 81 height values

print(f"Height grid: {grid.shape}, range [{grid.min():.1f}, {grid.max():.1f}], mean={grid.mean():.1f}")

# ─── Compute flatness (low variance = flat) ──────────────────────────────
# For each LB, compute variance over a 3x3 neighborhood
flatness = np.full((255, 255), np.inf, dtype=np.float32)
for x in range(1, 254):
    for y in range(1, 254):
        patch = grid[x-1:x+2, y-1:y+2]
        flatness[x, y] = np.std(patch)

print(f"Flatness range: [{flatness[flatness < np.inf].min():.2f}, {flatness[flatness < np.inf].max():.2f}]")

# ─── Score each landblock ────────────────────────────────────────────────
# Good town spot = flat + moderate height + not at edge
MARGIN = 8
scores = np.full((255, 255), -np.inf, dtype=np.float32)

# Height preference: prefer mid-range heights (not too high, not too low)
h_min, h_max = grid[MARGIN:-MARGIN, MARGIN:-MARGIN].min(), grid[MARGIN:-MARGIN, MARGIN:-MARGIN].max()
h_mid = (h_min + h_max) / 2
h_range = (h_max - h_min) / 2 if h_max > h_min else 1.0

for x in range(MARGIN, 255 - MARGIN):
    for y in range(MARGIN, 255 - MARGIN):
        f = flatness[x, y]
        if f == np.inf:
            continue
        
        # Flatness score (lower variance = better, exponential decay)
        flat_score = math.exp(-f / 5.0) * 100
        
        # Height preference (slight preference for moderate heights)
        h = grid[x, y]
        height_score = max(0, 1 - abs(h - h_mid) / h_range) * 20
        
        # Distance from center bonus (spread out is better)
        scores[x, y] = flat_score + height_score

print(f"Score range: [{scores[scores > -np.inf].min():.1f}, {scores[scores > -np.inf].max():.1f}]")

# ─── Town definitions ───────────────────────────────────────────────────
towns = [
    # Starter towns - place in each quadrant
    {"name": "Holtburg",      "type": "overworld", "region": "NW", "starter": True},
    {"name": "Shoushi",       "type": "overworld", "region": "NE", "starter": True},
    {"name": "Yaraq",         "type": "overworld", "region": "SW", "starter": True},
    {"name": "Sanamar",       "type": "overworld", "region": "SE", "starter": True},
    
    # Major towns - distribute across regions
    {"name": "Cragstone",     "type": "overworld", "region": "N"},
    {"name": "Glenden Wood",  "type": "overworld", "region": "N"},
    {"name": "Arwic",         "type": "overworld", "region": "NC"},
    {"name": "Lytelthorpe",   "type": "overworld", "region": "NW"},
    {"name": "Rithwic",       "type": "overworld", "region": "NC"},
    {"name": "Eastham",       "type": "overworld", "region": "NE"},
    {"name": "Al-Arqas",      "type": "overworld", "region": "S"},
    {"name": "Al-Jalima",     "type": "overworld", "region": "SC"},
    {"name": "Samsur",        "type": "overworld", "region": "S"},
    {"name": "Tufa",          "type": "overworld", "region": "SC"},
    {"name": "Uziz",          "type": "overworld", "region": "SW"},
    {"name": "Yaraq",         "type": "overworld", "region": "SW"},
    {"name": "Zaikhal",       "type": "overworld", "region": "C"},
    {"name": "Qalaba'r",      "type": "overworld", "region": "SE"},
    {"name": "Khayyaban",     "type": "overworld", "region": "SE"},
    {"name": "Baishi",        "type": "overworld", "region": "E"},
    {"name": "Hebian-To",     "type": "overworld", "region": "E"},
    {"name": "Lin",           "type": "overworld", "region": "EC"},
    {"name": "Mayoi",         "type": "overworld", "region": "EC"},
    {"name": "Nanto",         "type": "overworld", "region": "EC"},
    {"name": "Shoushi",       "type": "overworld", "region": "NE"},
    {"name": "Sawato",        "type": "overworld", "region": "E"},
    {"name": "Wai Jhou",      "type": "overworld", "region": "EC"},
    {"name": "Yanshi",        "type": "overworld", "region": "E"},
    {"name": "Stonehold",     "type": "overworld", "region": "N"},
    {"name": "Dryreach",      "type": "overworld", "region": "NW"},
    {"name": "Kara",          "type": "overworld", "region": "NC"},
    {"name": "Mar'uun",       "type": "overworld", "region": "SC"},
    {"name": "Silyun",        "type": "overworld", "region": "C"},
    {"name": "Timaru",        "type": "overworld", "region": "W"},
    {"name": "Tou-Tou",       "type": "overworld", "region": "C"},
    {"name": "Ayan Baqur",    "type": "overworld", "region": "SC"},
    
    # Outposts / forts
    {"name": "Bandit Castle",      "type": "overworld", "region": "NW"},
    {"name": "Beach Fort",         "type": "overworld", "region": "NE"},
    {"name": "Candeth Keep",       "type": "overworld", "region": "S"},
    {"name": "Danby's Outpost",    "type": "overworld", "region": "W"},
    {"name": "Fort Tethana",       "type": "overworld", "region": "C"},
    {"name": "MacNiall's Freehold","type": "overworld", "region": "NC"},
    {"name": "Neydisa Castle",     "type": "overworld", "region": "SC"},
    {"name": "Ahurenga",           "type": "overworld", "region": "SW"},
    {"name": "Bluespire",          "type": "overworld", "region": "NE"},
    {"name": "Greenspire",         "type": "overworld", "region": "SE"},
    {"name": "Redspire",           "type": "overworld", "region": "W"},
    {"name": "Eastwatch",          "type": "overworld", "region": "E"},
    {"name": "Westwatch",          "type": "overworld", "region": "W"},
    {"name": "Fiun Outpost",       "type": "overworld", "region": "NW"},
    {"name": "Kor-Gursha",         "type": "overworld", "region": "S"},
    {"name": "Kryst",              "type": "overworld", "region": "NW"},
    {"name": "Linvak Tukal",       "type": "overworld", "region": "C"},
    {"name": "Martine's Retreat",  "type": "overworld", "region": "NC"},
    {"name": "Oolutanga's Refuge", "type": "overworld", "region": "SW"},
    {"name": "Plateau Village",    "type": "overworld", "region": "SE"},
    
    # EnvCell accessed (hole in ground)
    {"name": "Xarabydun",          "type": "envcell", "region": "S"},
    {"name": "Crater Lake Village","type": "envcell", "region": "NC"},
    {"name": "Merwart Village",    "type": "envcell", "region": "C"},
    
    # Portal accessed
    {"name": "Underground City",   "type": "portal", "region": "C"},
]

# Deduplicate by name (keep first occurrence)
seen = set()
unique_towns = []
for t in towns:
    if t["name"] not in seen:
        seen.add(t["name"])
        unique_towns.append(t)
towns = unique_towns

print(f"\n{len(towns)} unique towns to place")

# ─── Region definitions (bounding boxes in LB coords) ───────────────────
# Map is 255x255, origin bottom-left. Divide into regions.
regions = {
    "NW": (MARGIN, 128, 128, 254-MARGIN),      # x: left, y: top
    "N":  (60, 195, 195, 254-MARGIN),
    "NC": (80, 140, 175, 195),
    "NE": (128, 200, 254-MARGIN, 254-MARGIN),
    "W":  (MARGIN, 80, 80, 175),
    "C":  (80, 80, 175, 175),
    "EC": (128, 80, 200, 175),
    "E":  (175, 100, 254-MARGIN, 200),
    "SW": (MARGIN, MARGIN, 128, 100),
    "S":  (60, MARGIN, 195, 80),
    "SC": (80, 50, 175, 128),
    "SE": (128, MARGIN, 254-MARGIN, 100),
}

# ─── Place towns ─────────────────────────────────────────────────────────
MIN_DIST = 15  # minimum landblocks between towns

placements = {}
placed_coords = []

def find_best_spot(region_key, avoid_coords, prefer_flat=True):
    """Find the best unoccupied spot in a region."""
    if region_key not in regions:
        region_key = "C"
    x_min, y_min, x_max, y_max = regions[region_key]
    
    best_score = -np.inf
    best_pos = None
    
    for x in range(x_min, min(x_max+1, 255)):
        for y in range(y_min, min(y_max+1, 255)):
            s = scores[x, y]
            if s <= -np.inf:
                continue
            
            # Check minimum distance from already-placed towns
            too_close = False
            for ax, ay in avoid_coords:
                dist = math.sqrt((x - ax)**2 + (y - ay)**2)
                if dist < MIN_DIST:
                    too_close = True
                    break
            if too_close:
                continue
            
            if s > best_score:
                best_score = s
                best_pos = (x, y)
    
    return best_pos

# Place starter towns first (in quadrant centers)
for town in towns:
    if not town.get("starter"):
        continue
    pos = find_best_spot(town["region"], placed_coords)
    if pos:
        placements[town["name"]] = {"lbX": pos[0], "lbY": pos[1]}
        placed_coords.append(pos)
        print(f"  * {town['name']:30s} -> ({pos[0]}, {pos[1]})  h={grid[pos[0], pos[1]]:.1f}")

# Then place remaining towns
for town in towns:
    if town.get("starter") or town["name"] in placements:
        continue
    pos = find_best_spot(town["region"], placed_coords)
    if pos:
        placements[town["name"]] = {"lbX": pos[0], "lbY": pos[1]}
        placed_coords.append(pos)
        marker = "o" if town["type"] == "envcell" else ("#" if town["type"] == "portal" else ".")
        print(f"  {marker} {town['name']:30s} -> ({pos[0]}, {pos[1]})  h={grid[pos[0], pos[1]]:.1f}")
    else:
        print(f"  ! {town['name']:30s} -> NO SUITABLE SPOT in region {town['region']}")

# ─── Export ──────────────────────────────────────────────────────────────
output = {
    "_meta": {
        "tool": "auto_place_towns.py",
        "criteria": "flat terrain, moderate height, well-distributed",
        "min_distance_lbs": MIN_DIST,
        "total_placed": len(placements)
    },
    "towns": {}
}

for name, pos in placements.items():
    town = next((t for t in towns if t["name"] == name), {})
    output["towns"][name] = {
        "lbX": pos["lbX"],
        "lbY": pos["lbY"],
        "worldX": pos["lbX"] * 192,
        "worldY": pos["lbY"] * 192,
        "type": town.get("type", "overworld")
    }

out_path = "pipeline_data/population_output/town_placements.json"
with open(out_path, "w") as f:
    json.dump(output, f, indent=2)

print(f"\nPlaced {len(placements)}/{len(towns)} towns")
print(f"  Saved to {out_path}")
print(f"  Import this file into the Town Placer GUI to review/adjust")
