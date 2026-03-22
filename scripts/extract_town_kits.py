#!/usr/bin/env python3
"""
extract_town_kits.py  –  Retail Town Kit Extractor for Vanquish World Builder
==============================================================================

Parses retail Asheron's Call data to produce relocatable "town kit" blueprints.
Each kit captures:
  • Buildings (from building_placements.jsonl) — setupId + relative offsets
  • NPCs, vendors, archmages, barkeeps (from spawnmap_summary.jsonl + canonical_enrichment.json)
  • Portals, signs, lifestones (from canonical_enrichment.json)
  • Relative positions from the computed town center

Output: town_kits/{town_name}.json  (one file per town)

Usage:
    python scripts/extract_town_kits.py
"""

import json
import math
import os
import sys
from collections import defaultdict

# ─── Configuration ───────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
LSD_DIR  = os.path.join(BASE_DIR, 'LSD-Partial-2025-02-23_16-15')
OUTPUT_DIR = os.path.join(BASE_DIR, 'town_kits')

BUILDING_FILE  = os.path.join(BASE_DIR, 'building_placements.jsonl')
SPAWN_FILE     = os.path.join(LSD_DIR, 'spawnmap_summary.jsonl')
ENRICHMENT_FILE = os.path.join(BASE_DIR, 'canonical_enrichment.json')
WEENIE_FILE    = os.path.join(LSD_DIR, 'weenie_summary.jsonl')

# Landblock size in world units (each LB is 192x192)
LB_SIZE = 192.0

# ─── Town Definitions ────────────────────────────────────────────────────────
# These are the towns we want to extract, with their canonical names and
# the core LB coordinates from spawnmap_summary.  We use the "desc" field
# matching to find all relevant spawn entries.
#
# "starter" flag marks the 4 starter towns (Holtburg, Shoushi, Yaraq, Sanamar)
# "culture" is the architectural culture for the town

TOWN_DEFS = {
    # ── 4 Starter Towns ──
    "Holtburg":       {"culture": "Aluvian",     "starter": True,  "lbCenter": (170, 179)},
    "Shoushi":        {"culture": "Sho",          "starter": True,  "lbCenter": (218, 85)},
    "Yaraq":          {"culture": "Gharu'ndim",   "starter": True,  "lbCenter": (126, 100)},
    "Sanamar":        {"culture": "Viamontian",   "starter": True,  "lbCenter": (50, 217)},

    # ── Major Aluvian Towns ──
    "Lytelthorpe":    {"culture": "Aluvian",     "starter": False, "lbCenter": (191, 128)},
    "Rithwic":        {"culture": "Aluvian",     "starter": False, "lbCenter": (200, 140)},
    "Cragstone":      {"culture": "Aluvian",     "starter": False, "lbCenter": (166, 150)},
    "Arwic":          {"culture": "Aluvian",     "starter": False, "lbCenter": (176, 159)},
    "Glenden Wood":   {"culture": "Aluvian",     "starter": False, "lbCenter": (162, 164)},
    "Eastham":        {"culture": "Aluvian",     "starter": False, "lbCenter": (206, 149)},
    "Stonehold":      {"culture": "Aluvian",     "starter": False, "lbCenter": (100, 213)},

    # ── Major Sho Towns ──
    "Hebian-To":      {"culture": "Sho",         "starter": False, "lbCenter": (231, 77)},
    "Mayoi":          {"culture": "Sho",         "starter": False, "lbCenter": (230, 50)},
    "Lin":            {"culture": "Sho",         "starter": False, "lbCenter": (219, 59)},
    "Nanto":          {"culture": "Sho",         "starter": False, "lbCenter": (229, 61)},
    "Baishi":         {"culture": "Sho",         "starter": False, "lbCenter": (210, 68)},
    "Sawato":         {"culture": "Sho",         "starter": False, "lbCenter": (199, 95)},
    "Yanshi":         {"culture": "Sho",         "starter": False, "lbCenter": (180, 112)},
    "Tou-Tou":        {"culture": "Sho",         "starter": False, "lbCenter": (247, 93)},

    # ── Major Gharu'ndim Towns ──
    "Al-Arqas":       {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (149, 113)},
    "Khayyaban":      {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (158, 68)},
    "Samsur":         {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (152, 124)},
    "Tufa":           {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (134, 109)},
    "Uziz":           {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (162, 96)},
    "Xarabydun":      {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (147, 75)},
    "Qalaba'r":       {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (151, 34)},
    "Zaikhal":        {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (128, 143)},
    "Al-Jalima":      {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (172, 79)},
    "Ayan Baqur":     {"culture": "Gharu'ndim",  "starter": False, "lbCenter": (162, 56)},

    # ── Viamontian / Other Towns ──
    "Redspire":       {"culture": "Viamontian",  "starter": False, "lbCenter": (24, 180)},
    "Silyun":         {"culture": "Viamontian",  "starter": False, "lbCenter": (39, 235)},
    "Fort Tethana":   {"culture": "Viamontian",  "starter": False, "lbCenter": (37, 129)},
    "Greenspire":     {"culture": "Viamontian",  "starter": False, "lbCenter": (43, 181)},
    "Timaru":         {"culture": "Viamontian",  "starter": False, "lbCenter": (30, 182)},
    "Neydisa":        {"culture": "Viamontian",  "starter": False, "lbCenter": (149, 214)},
    "Danby's Outpost": {"culture": "Neutral",    "starter": False, "lbCenter": (91, 156)},
    "Wai Jhou":       {"culture": "Sho",         "starter": False, "lbCenter": (63, 50)},
    "Plateau Village": {"culture": "Neutral",    "starter": False, "lbCenter": (73, 182)},
    "Kara":           {"culture": "Sho",         "starter": False, "lbCenter": (186, 23)},
    "Kryst":          {"culture": "Sho",         "starter": False, "lbCenter": (233, 34)},
    "MacNiall's Freehold": {"culture": "Aluvian","starter": False, "lbCenter": (242, 34)},
}


# ─── Weenie type categories we care about for town kits ──────────────────────

TOWN_WEENIE_TYPES = {
    'NPC', 'NPC_Vendor', 'NPC_Archmage', 'NPC_Barkeep',
    'Sign_Town', 'Interactive_Lifestone', 'Interactive_Portal',
    'Furniture_Light', 'Furniture_Storage', 'Furniture_Table', 'Furniture_Bed',
    'Structure',
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def lb_to_world(lbX, lbY):
    """Convert landblock coords to world center coords."""
    return (lbX * LB_SIZE + LB_SIZE / 2, lbY * LB_SIZE + LB_SIZE / 2)


def distance_2d(x1, y1, x2, y2):
    """2D Euclidean distance."""
    return math.sqrt((x1 - x2)**2 + (y1 - y2)**2)


def load_jsonl(filepath, encoding='utf-8-sig'):
    """Load a JSONL file, skipping bad lines."""
    results = []
    with open(filepath, 'r', encoding=encoding) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                results.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return results


# ─── Step 1: Load Canonical Enrichment (wcid -> type/name lookup) ─────────────

def load_enrichment_index(filepath):
    """Build a wcid -> enrichment entry lookup."""
    print(f"  Loading canonical enrichment from {os.path.basename(filepath)}...")
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    index = {}
    for entry in data.get('entries', []):
        index[entry['wcid']] = {
            'name': entry.get('name', ''),
            'type': entry.get('type', 'Unknown'),
            'architecture': entry.get('architecture', 'Neutral'),
            'biome': entry.get('biome', ['Any']),
            'creature_family': entry.get('creature_family'),
            'difficulty_tier': entry.get('difficulty_tier'),
            'behavior': entry.get('behavior', 'Passive'),
            'setupDid': entry.get('setupDid'),
        }
    print(f"    -> Indexed {len(index)} weenie entries")
    return index


# ─── Step 2: Load Weenie Summary (for names not in enrichment) ────────────────

def load_weenie_names(filepath):
    """Build a wcid -> name lookup from weenie_summary."""
    print(f"  Loading weenie names from {os.path.basename(filepath)}...")
    records = load_jsonl(filepath)
    index = {}
    for rec in records:
        index[rec['wcid']] = rec.get('name', f"wcid_{rec['wcid']}")
    print(f"    -> Indexed {len(index)} weenie names")
    return index


# ─── Step 3: Load Building Placements ─────────────────────────────────────────

def load_buildings(filepath):
    """Load all building placements, indexed by (lbX, lbY)."""
    print(f"  Loading buildings from {os.path.basename(filepath)}...")
    records = load_jsonl(filepath)

    by_lb = defaultdict(list)
    for rec in records:
        key = (rec['lbX'], rec['lbY'])
        by_lb[key].append({
            'setupId': rec['setupId'],
            'setupIdHex': rec.get('setupIdHex', hex(rec['setupId'])),
            'worldX': rec['worldX'],
            'worldY': rec['worldY'],
            'worldZ': rec['worldZ'],
            'numLeaves': rec.get('numLeaves', 0),
            'portalCount': rec.get('portalCount', 0),
        })
    print(f"    -> {len(records)} buildings across {len(by_lb)} landblocks")
    return by_lb


# ─── Step 4: Load Spawn Map Summary ──────────────────────────────────────────

def load_spawn_map(filepath):
    """Load spawnmap_summary, return list of records."""
    print(f"  Loading spawn map from {os.path.basename(filepath)}...")
    records = load_jsonl(filepath)
    print(f"    -> {len(records)} spawn entries")
    return records


# ─── Step 5: Extract Town Kit ─────────────────────────────────────────────────

def extract_town_kit(town_name, town_def, spawn_records, buildings_by_lb,
                     enrichment, weenie_names):
    """
    Extract a single town kit by:
      1. Finding all spawnmap entries whose desc matches the town name
      2. Gathering buildings from nearby landblocks
      3. Classifying all wcids into roles (NPC, vendor, portal, etc.)
      4. Computing relative offsets from town center
    """
    center_lb = town_def['lbCenter']
    center_world = lb_to_world(*center_lb)
    culture = town_def['culture']
    is_starter = town_def['starter']

    # ── Find matching spawn entries ──
    town_lower = town_name.lower()
    matched_spawns = []
    matched_lbs = set()

    for rec in spawn_records:
        desc = rec.get('desc', '')
        if ' - ' not in desc:
            continue
        location = desc.split(' - ', 1)[1].strip()

        # Match town name (exclude obvious non-town entries like dungeons/caves)
        if town_lower in location.lower():
            # Skip training academies, dungeons, meeting halls, etc.
            loc_lower = location.lower()
            skip_keywords = ['training academy', 'dungeon', 'meeting hall',
                             'crypt', 'cave', 'sewer', 'hideout',
                             'gambling den', 'fort ', 'moarsman', 'prison',
                             'library', 'pumpkin', 'windmill', 'outpost',
                             'lower undermine', 'fledgling', 'casino',
                             'chapterhouse', 'castle', 'empyrean',
                             'node pyramid', 'entryway', 'floating city',
                             'wilderness', 'cages', 'royal hall',
                             'bandit fort', 'redoubt']

            # Only skip if the full location name != the town name itself
            if location.lower() != town_lower:
                if any(kw in loc_lower for kw in skip_keywords):
                    continue

            key = rec['key']
            lbX = (key >> 24) & 0xFF
            lbY = (key >> 16) & 0xFF

            # Only include outdoor landblocks (LB IDs with lbX > 0)
            # Indoor dungeons have lbX in [0, 1, 2]
            if lbX < 3:
                continue

            matched_spawns.append(rec)
            matched_lbs.add((lbX, lbY))

    if not matched_spawns:
        return None

    # ── Classify weenies from spawn entries ──
    npcs = []
    vendors = []
    portals = []
    lifestones = []
    signs = []
    creatures = []
    furniture = []
    other = []

    seen_wcids = set()  # track unique placements

    for spawn in matched_spawns:
        for wcid in spawn.get('wcids', []):
            info = enrichment.get(wcid, {})
            wtype = info.get('type', 'Unknown')
            wname = info.get('name') or weenie_names.get(wcid, f'wcid_{wcid}')

            entry = {
                'wcid': wcid,
                'name': wname,
                'type': wtype,
            }

            if wtype == 'NPC':
                npcs.append(entry)
            elif wtype in ('NPC_Vendor', 'NPC_Archmage', 'NPC_Barkeep'):
                vendors.append(entry)
            elif wtype == 'Interactive_Portal':
                portals.append(entry)
            elif wtype == 'Interactive_Lifestone':
                lifestones.append(entry)
            elif wtype == 'Sign_Town':
                signs.append(entry)
            elif wtype == 'Creature':
                creatures.append(entry)
            elif wtype.startswith('Furniture'):
                furniture.append(entry)
            else:
                other.append(entry)

    # ── Gather buildings from town landblocks + neighbors ──
    town_buildings = []
    search_radius = 2  # search ±2 LBs around each matched LB

    checked_lbs = set()
    for lb in matched_lbs:
        for dx in range(-search_radius, search_radius + 1):
            for dy in range(-search_radius, search_radius + 1):
                check_lb = (lb[0] + dx, lb[1] + dy)
                if check_lb in checked_lbs:
                    continue
                checked_lbs.add(check_lb)

                for bld in buildings_by_lb.get(check_lb, []):
                    # Compute relative offset from town center
                    rel_x = bld['worldX'] - center_world[0]
                    rel_y = bld['worldY'] - center_world[1]

                    # Only include buildings reasonably close to town center
                    dist = distance_2d(bld['worldX'], bld['worldY'],
                                      center_world[0], center_world[1])
                    if dist > LB_SIZE * 4:  # max ~4 LBs away
                        continue

                    town_buildings.append({
                        'setupId': bld['setupId'],
                        'setupIdHex': bld['setupIdHex'],
                        'relativeX': round(rel_x, 1),
                        'relativeY': round(rel_y, 1),
                        'worldZ': bld['worldZ'],
                        'numLeaves': bld['numLeaves'],
                        'portalCount': bld['portalCount'],
                    })

    # ── Assemble the kit ──
    kit = {
        'townName': town_name,
        'culture': culture,
        'isStarter': is_starter,
        'retailCenter': {
            'lbX': center_lb[0],
            'lbY': center_lb[1],
            'worldX': round(center_world[0], 1),
            'worldY': round(center_world[1], 1),
        },
        'landblocks': sorted([list(lb) for lb in matched_lbs]),
        'summary': {
            'totalBuildings': len(town_buildings),
            'totalNPCs': len(npcs),
            'totalVendors': len(vendors),
            'totalPortals': len(portals),
            'totalLifestones': len(lifestones),
            'totalSigns': len(signs),
            'totalCreatures': len(creatures),
            'totalFurniture': len(furniture),
            'totalOther': len(other),
        },
        'buildings': town_buildings,
        'npcs': npcs,
        'vendors': vendors,
        'portals': portals,
        'lifestones': lifestones,
        'signs': signs,
        'creatures': creatures,
        'furniture': furniture,
        'other': other,
    }

    return kit


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("  Town Kit Extractor – Vanquish World Builder")
    print("=" * 70)
    print()

    # Load all data sources
    print("Loading data sources...")
    enrichment = load_enrichment_index(ENRICHMENT_FILE)
    weenie_names = load_weenie_names(WEENIE_FILE)
    buildings_by_lb = load_buildings(BUILDING_FILE)
    spawn_records = load_spawn_map(SPAWN_FILE)
    print()

    # Create output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Extract each town
    print(f"Extracting {len(TOWN_DEFS)} town kits...")
    print("-" * 70)

    total_extracted = 0
    summary_rows = []

    for town_name, town_def in sorted(TOWN_DEFS.items()):
        kit = extract_town_kit(
            town_name, town_def,
            spawn_records, buildings_by_lb,
            enrichment, weenie_names
        )

        if kit is None:
            print(f"  [!!]  {town_name}: No matching spawn data found")
            continue

        # Write the kit
        safe_name = town_name.lower().replace("'", "").replace(" ", "_")
        out_path = os.path.join(OUTPUT_DIR, f"{safe_name}.json")
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(kit, f, indent=2, ensure_ascii=False)

        s = kit['summary']
        line = (f"  [OK]  {town_name:25s}  "
                f"B={s['totalBuildings']:3d}  "
                f"NPC={s['totalNPCs']:3d}  "
                f"V={s['totalVendors']:2d}  "
                f"P={s['totalPortals']:2d}  "
                f"LS={s['totalLifestones']:d}  "
                f"LBs={len(kit['landblocks'])}")
        print(line)
        summary_rows.append(line)
        total_extracted += 1

    print("-" * 70)
    print(f"\nExtracted {total_extracted}/{len(TOWN_DEFS)} town kits to: {OUTPUT_DIR}")

    # Write a summary index
    index = {
        'version': '1.0',
        'totalTowns': total_extracted,
        'starterTowns': sum(1 for d in TOWN_DEFS.values() if d['starter']),
        'towns': {}
    }
    for fname in sorted(os.listdir(OUTPUT_DIR)):
        if fname.endswith('.json') and fname != 'index.json':
            fpath = os.path.join(OUTPUT_DIR, fname)
            with open(fpath, 'r', encoding='utf-8') as f:
                kit = json.load(f)
            index['towns'][kit['townName']] = {
                'file': fname,
                'culture': kit['culture'],
                'isStarter': kit['isStarter'],
                'lbCenter': [kit['retailCenter']['lbX'], kit['retailCenter']['lbY']],
                'summary': kit['summary'],
            }

    index_path = os.path.join(OUTPUT_DIR, 'index.json')
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    print(f"Written town index to: {index_path}")
    print("\nDone!")


if __name__ == '__main__':
    main()
