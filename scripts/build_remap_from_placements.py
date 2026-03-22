"""
Build lb_remap.json from building_old_cells.json + town_placements.json.

Strategy:
  - For each retail LB that has buildings, find the nearest town
  - Compute the offset from that town's retail position to its Vanquish position
  - Apply the offset to get the new LB position
  - Skip mega-structures (>100 cells per building)
  - Also include the LBs that have instances (NPCs, vendors) near each town
"""
import json, os, re, math
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- Load data ----
with open(os.path.join(BASE_DIR, "pipeline_data", "population_output", "town_placements.json")) as f:
    pdata = json.load(f)
    town_placements = pdata.get("towns", pdata)

print(f"Loaded {len(town_placements)} town placements")

# Building data
old_cells_path = os.path.join(BASE_DIR, "projects", "vanquishtest", "building_old_cells.json")
old_cells = json.load(open(old_cells_path))
print(f"Loaded {len(old_cells)} building entries")

# These are the 6 massive dungeon/apartment storage blocks that should NOT be moved.
# They are accessed via portals and take up enormous cell ID space. Moving them caused
# cell count mismatches and ACE server crashes.
# Everything else (fortresses, castles, regular buildings) SHOULD be moved.
SKIP_MODEL_IDS = {
    0x01002BEF,  # Apartment/housing block (2426 cells, 15 copies)
    0x01003414,  # Large dungeon storage (852 cells, 2 copies)
    0x010029E2,  # Large dungeon storage (749 cells, 4 copies)
    0x01003D00,  # Large dungeon storage (712 cells, 4 copies)
    0x01004031,  # Large dungeon storage (650 cells, 7 copies)
    0x010045CD,  # Large dungeon storage (208 cells, 1 copy)
}

# Group buildings by retail LB, filtering out the mega-structures
buildings_by_lb = defaultdict(list)
skipped_mega = 0
for k, v in old_cells.items():
    mid = v["modelId"]
    if mid in SKIP_MODEL_IDS:
        skipped_mega += 1
        continue
    olb = v["oldLbKey"]
    lbx = (olb >> 8) & 0xFF
    lby = olb & 0xFF
    buildings_by_lb[(lbx, lby)].append(v)

print(f"  {len(buildings_by_lb)} retail LBs have movable buildings")
print(f"  Skipped {skipped_mega} mega-structure entries (apartment/dungeon storage)")

# Known retail town positions
RETAIL_TOWNS = {
    "Holtburg":            (170, 180),  # 42.1N, 33.6E
    "Shoushi":             (220,  85),  # 34.2S, 73.6E
    "Yaraq":               (125, 100),  # 21.6S, 1.7W
    "Sanamar":             ( 51, 218),  # 72.0N, 61.4W
    "Al-Arqas":            (145,  88),  # 31.2S, 13.7E
    "Al-Jalima":           (134, 137),  # 7.4N, 4.8E
    "Arwic":               (198, 170),  # 33.6N, 56.8E
    "Ayan Baqur":          ( 18,  52),  # 60.0S, 88.0W
    "Baishi":              (206,  66),  # 49.3S, 62.9E
    "Cragstone":           (188, 160),  # 26.0N, 48.4E
    "Dryreach":            (219, 117),  # 08.1S, 73.0E
    "Eastham":             (207, 149),  # 17.5N, 63.4E
    "Glenden Wood":        (161, 165),  # 29.7N, 26.5E
    "Hebian-To":           (231,  79),  # 38.9S, 82.6E
    "Kara":                (187,  23),  # 83.5S, 47.6E
    "Khayyaban":           (158,  68),  # 47.6S, 24.7E
    "Lin":                 (219,  59),  # 54.5S, 73.1E
    "Lytelthorpe":         (191, 129),  # 0.9N, 51.1E
    "Mar'uun":             (149, 114),  # 10.6S, 17.1E
    "Mayoi":               (230,  50),  # 61.6S, 81.9E
    "Nanto":               (230,  62),  # 52.5S, 82.1E
    "Qalaba'r":            (152,  34),  # 74.6S, 19.6E
    "Rithwic":             (202, 141),  # 10.8N, 59.3E
    "Samsur":              (151, 124),  # 3.2S, 19.0E
    "Sawato":              (202,  92),  # 28.7S, 59.3E
    "Stonehold":           (100, 213),  # 68.7N, 21.8W
    "Tou-Tou":             (248,  88),  # 31.7S, 96.1E
    "Tufa":                (134, 110),  # 13.9S, 5.0E
    "Uziz":                (163,  96),  # 25.2S, 28.3E
    "Wai Jhou":            ( 63,  50),  # 62.0S, 51.4W
    "Yanshi":              (180, 112),  # 12.1S, 42.4E
    "Zaikhal":             (128, 145),  # 13.7N, 0.6E
    "Silyun":              ( 39, 237),  # 87.4N, 70.5W
    "Timaru":              ( 30, 183),  # 44.2N, 78.0W
    "Bandit Castle":       (202, 168),  # 32.8N, 59.5E
    "Beach Fort":          ( 66, 222),  # 76.0N, 49.1W
    "Candeth Keep":        ( 44,  18),  # 87.5S, 67.1W
    "Danby's Outpost":     ( 92, 157),  # 23.4N, 28.7W
    "Fort Tethana":        ( 38, 129),  # 1.5N, 71.8W
    "MacNiall's Freehold": (243,  34),  # 75.2S, 92.3E
    "Neydisa Castle":      (150, 215),  # 69.7N, 17.6E
    "Ahurenga":            ( 15, 186),  # 47.0N, 90.3W
    "Bluespire":           ( 33, 177),  # 39.4N, 75.4W
    "Greenspire":          ( 44, 181),  # 42.9N, 66.9W
    "Redspire":            ( 24, 178),  # 40.8N, 83.1W
    "Eastwatch":           ( 74, 240),  # 90.3N, 43.1W
    "Westwatch":           ( 36, 218),  # 72.8N, 73.3W
    "Fiun Outpost":        ( 57, 247),  # 95.9N, 56.8W
    "Kor-Gursha":          (166, 212),  # 67.4N, 30.5E
    "Kryst":               (233,  35),  # 74.3S, 84.6E
    "Linvak Tukal":        (162,  30),  # 77.8S, 28.0E
    "Martine's Retreat":   (200, 141),  # 10.6N, 58.3E
    "Oolutanga's Refuge":  (247, 130),  # 2.3N, 95.4E
    "Plateau Village":     ( 74, 183),  # 44.5N, 43.1W
    "Xarabydun":           (148,  75),  # 41.9S, 16.1E
    "Crater Lake Village": (144, 209),  # 64.9N, 13.5E
    "Merwart Village":     (201, 227),  # 79.9N, 59.0E
    "Underground City":    (195, 154),  # 21.4N, 54.0E
}

# Build lookup: for each town, get offset
town_offsets = {}
for name, target in town_placements.items():
    if name not in RETAIL_TOWNS:
        continue
    rx, ry = RETAIL_TOWNS[name]
    tx, ty = target["lbX"], target["lbY"]
    town_offsets[name] = {
        "retail": (rx, ry),
        "target": (tx, ty),
        "offset": (tx - rx, ty - ry)
    }

# ---- For each retail building LB, find nearest town and apply offset ----
lb_remap = {}
stats = defaultdict(int)
skipped_no_town = 0

for (lbx, lby), bldgs in buildings_by_lb.items():
    # Find nearest town
    best_town = None
    best_dist = float("inf")
    for name, info in town_offsets.items():
        rx, ry = info["retail"]
        d = math.sqrt((lbx - rx)**2 + (lby - ry)**2)
        if d < best_dist:
            best_dist = d
            best_town = name

    if best_town is None or best_dist > 15:
        skipped_no_town += 1
        continue

    ox, oy = town_offsets[best_town]["offset"]
    new_x = max(1, min(253, lbx + ox))
    new_y = max(1, min(253, lby + oy))

    lb_remap[f"{lbx},{lby}"] = f"{new_x},{new_y}"
    stats[best_town] += 1

# Also include instance LBs near each town (NPCs, vendors, etc.)
# Scan retail SQL for instances
RETAIL_SQL = r"D:\ACE\world-db\ACE-World-Database-v0.9.292.sql"
print("\nScanning retail SQL for instance landblocks near towns...")

instance_lbs = defaultdict(int)
INSERT_RE = re.compile(
    r"INSERT\s+INTO\s+`landblock_instance`\s+\(`guid`.*?VALUES\s*(.*?);",
    re.IGNORECASE | re.DOTALL
)
ROW_RE = re.compile(r"\(([^)]+)\)")

with open(RETAIL_SQL, "r", encoding="utf-8", errors="replace") as f:
    sql_text = f.read()

for block_match in INSERT_RE.finditer(sql_text):
    values_block = block_match.group(1)
    for row_match in ROW_RE.finditer(values_block):
        fields = row_match.group(1).split(",")
        if len(fields) < 3:
            continue
        try:
            obj_cell_id = int(fields[2].strip())
        except ValueError:
            continue
        lbx = (obj_cell_id >> 24) & 0xFF
        lby = (obj_cell_id >> 16) & 0xFF
        cell = obj_cell_id & 0xFFFF
        if cell < 0x100 and lbx >= 1 and lby >= 1:
            instance_lbs[(lbx, lby)] += 1

# For each town, find instance LBs within radius 3 of its retail center
TOWN_RADIUS = 3
for name, info in town_offsets.items():
    rx, ry = info["retail"]
    ox, oy = info["offset"]
    added = 0
    for dx in range(-TOWN_RADIUS, TOWN_RADIUS + 1):
        for dy in range(-TOWN_RADIUS, TOWN_RADIUS + 1):
            lbx, lby = rx + dx, ry + dy
            key = f"{lbx},{lby}"
            if key in lb_remap:
                continue
            if instance_lbs.get((lbx, lby), 0) == 0:
                continue
            new_x = max(1, min(253, lbx + ox))
            new_y = max(1, min(253, lby + oy))
            lb_remap[key] = f"{new_x},{new_y}"
            added += 1
    if added > 0:
        stats[name] = stats.get(name, 0) + added

# ---- Summary ----
print("\nTown remap summary:")
for name in sorted(stats.keys()):
    info = town_offsets[name]
    ox, oy = info["offset"]
    print(f"  {name:30s}: {stats[name]:3d} LBs  offset=({ox:+d},{oy:+d})")

print(f"\nTotal LB remaps: {len(lb_remap)}")
print(f"Mega-structures filtered by model ID: {skipped_mega}")
print(f"Building LBs too far from any town: {skipped_no_town}")

# ---- Save ----
output_path = os.path.join(BASE_DIR, "pipeline_data", "population_output", "lb_remap.json")
with open(output_path, "w") as f:
    json.dump(lb_remap, f, indent=2)

print(f"Saved to {output_path}")
