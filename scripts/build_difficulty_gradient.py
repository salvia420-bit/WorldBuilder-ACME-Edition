#!/usr/bin/env python3
"""
Build Difficulty Gradient

Generates a 255x255 difficulty grid for a new world based on anchor points
(starter towns, mid-level hubs, endgame zones).

Difficulty tiers (matching canonical_enrichment.py):
  0 = Starter  (level 1-15)
  1 = Low      (level 16-40)
  2 = Medium   (level 41-80)
  3 = Hard     (level 81-130)
  4 = Elite    (level 131-200)
  5 = Legendary (level 200+)

Usage:
  python scripts/build_difficulty_gradient.py                    # Use defaults
  python scripts/build_difficulty_gradient.py config.json        # Use custom config
  python scripts/build_difficulty_gradient.py --retail           # Analyze retail spawns

Config format (JSON):
  {
    "anchors": [
      {"lbX": 42, "lbY": 175, "tier": 0, "label": "Starter Town Alpha"},
      {"lbX": 130, "lbY": 130, "tier": 4, "label": "Endgame Fortress"},
    ],
    "zone_widths": [8, 15, 25, 40, 60],
    "ocean_mask": "ocean_mask.png"
  }

zone_widths = landblock distance thresholds between tiers.
  e.g. [8, 15, 25, 40, 60] means:
    0-8 LBs from starter  = Starter
    8-15 LBs              = Low
    15-25 LBs             = Medium
    25-40 LBs             = Hard
    40-60 LBs             = Elite
    60+ LBs               = Legendary
"""

import json
import math
import os
import sys
import numpy as np

TIER_NAMES = ["Starter", "Low", "Medium", "Hard", "Elite", "Legendary"]
TIER_COLORS = [
    (0, 200, 0),       # Starter  - green
    (100, 200, 50),    # Low      - yellow-green
    (255, 200, 0),     # Medium   - gold
    (255, 120, 0),     # Hard     - orange
    (220, 40, 40),     # Elite    - red
    (150, 0, 200),     # Legendary - purple
]

# Default anchor points - three starter towns forming a triangle,
# similar to retail AC's Holtburg/Shoushi/Yaraq layout but generalized.
# User should customize these for their world.
DEFAULT_ANCHORS = [
    {"lbX": 42,  "lbY": 175, "tier": 0, "label": "Starter Town North (Aluvian)"},
    {"lbX": 34,  "lbY": 137, "tier": 0, "label": "Starter Town East (Sho)"},
    {"lbX": 22,  "lbY": 96,  "tier": 0, "label": "Starter Town South (Gharu'ndim)"},
    # Mid-level hubs
    {"lbX": 55,  "lbY": 140, "tier": 1, "label": "Mid-level Hub East"},
    {"lbX": 30,  "lbY": 220, "tier": 2, "label": "Mid-level Hub North"},
    # High-level areas
    {"lbX": 70,  "lbY": 246, "tier": 3, "label": "High-level Area NE"},
    {"lbX": 80,  "lbY": 100, "tier": 3, "label": "High-level Area SE"},
    # Endgame zones (edges of the world, remote areas)
    {"lbX": 127, "lbY": 127, "tier": 5, "label": "World Center (Legendary)"},
]

# Default zone widths: landblock distance between tier transitions
# From a tier-0 anchor:
#   0-8 LBs = Starter, 8-15 = Low, 15-25 = Medium, 25-40 = Hard, 40-60 = Elite, 60+ = Legendary
DEFAULT_ZONE_WIDTHS = [8, 15, 25, 40, 60]


def compute_gradient(anchors, zone_widths, ocean_mask=None):
    """
    Compute a 255x255 difficulty grid.

    For each cell, find the anchor that produces the LOWEST difficulty tier.
    An anchor at tier T creates a zone of tier T around itself, then
    the tier increases by 1 for each zone_width band outward.

    Returns a numpy array of shape (255, 255) with values 0-5.
    """
    grid = np.full((255, 255), 5, dtype=np.int8)  # Default: Legendary

    for x in range(255):
        for y in range(255):
            # Check ocean mask
            if ocean_mask is not None and ocean_mask[x, y] == 0:
                grid[x, y] = -1  # Ocean, skip
                continue

            best_tier = 5  # Start with highest difficulty

            for anchor in anchors:
                ax, ay = anchor["lbX"], anchor["lbY"]
                base_tier = anchor["tier"]

                dist = math.sqrt((x - ax) ** 2 + (y - ay) ** 2)

                # Compute tier from distance using zone widths
                tier = base_tier
                remaining_dist = dist
                for i in range(len(zone_widths)):
                    target_tier = base_tier + i
                    if target_tier >= len(TIER_NAMES):
                        break
                    if i == 0:
                        threshold = zone_widths[0]
                    else:
                        threshold = zone_widths[i] - zone_widths[i - 1]

                    if remaining_dist <= threshold:
                        tier = target_tier
                        break
                    remaining_dist -= threshold
                    tier = min(target_tier + 1, len(TIER_NAMES) - 1)

                # The anchor gives us a tier for this cell
                best_tier = min(best_tier, tier)

            grid[x, y] = best_tier

    return grid


def save_gradient_json(grid, anchors, zone_widths, output_path):
    """Save the gradient as a JSON file consumable by C#."""
    tier_counts = {}
    for t in range(len(TIER_NAMES)):
        tier_counts[TIER_NAMES[t]] = int(np.sum(grid == t))
    tier_counts["Ocean"] = int(np.sum(grid == -1))

    output = {
        "description": "Difficulty gradient for world population",
        "grid_size": 255,
        "tier_names": TIER_NAMES,
        "tier_distribution": tier_counts,
        "anchors": anchors,
        "zone_widths": zone_widths,
        # Store as list of rows (255 rows of 255 values each)
        # Values: -1=ocean, 0=Starter, 1=Low, 2=Medium, 3=Hard, 4=Elite, 5=Legendary
        "grid": grid.tolist(),
    }

    with open(output_path, "w") as f:
        json.dump(output, f)

    print(f"  -> Saved gradient JSON: {output_path}")
    sz = os.path.getsize(output_path)
    print(f"     Size: {sz / 1024:.0f} KB")


def save_gradient_image(grid, output_path):
    """Save the gradient as a colored PNG for visual inspection."""
    try:
        from PIL import Image
    except ImportError:
        print("  WARNING: Pillow not installed, skipping image output.")
        print("  Install with: pip install Pillow")
        return

    img = Image.new("RGB", (255, 255), (20, 20, 40))
    pixels = img.load()

    for x in range(255):
        for y in range(255):
            t = grid[x, y]
            if t == -1:
                pixels[x, y] = (20, 20, 40)  # Ocean - dark
            elif 0 <= t < len(TIER_COLORS):
                pixels[x, y] = TIER_COLORS[t]
            else:
                pixels[x, y] = TIER_COLORS[-1]

    # Scale up for visibility
    img = img.resize((1020, 1020), Image.NEAREST)
    img.save(output_path)
    print(f"  -> Saved gradient image: {output_path}")


def analyze_retail_spawns(project_dir):
    """
    Analyze retail spawn data to compute actual retail difficulty gradient.
    Uses spawn_map_summary.jsonl + canonical_enrichment.json.
    """
    spawn_path = os.path.join(project_dir, "spawn_map_summary.jsonl")
    canonical_path = os.path.join(project_dir, "pipeline_data", "enrichment", "canonical_enrichment.json")

    if not os.path.exists(spawn_path):
        print(f"  ERROR: {spawn_path} not found.")
        print("  Run: ingest-spawn-maps <lsd-path>")
        return None

    if not os.path.exists(canonical_path):
        print(f"  ERROR: {canonical_path} not found.")
        print("  Run: python scripts/build_ontology_enrichment.py")
        return None

    # Load canonical enrichment for tier data
    print("  Loading canonical enrichment...")
    with open(canonical_path, encoding="utf-8-sig") as f:
        canonical = json.load(f)

    # Build wcid -> tier lookup from canonical entries
    wcid_to_tier = {}
    tier_name_to_int = {n: i for i, n in enumerate(TIER_NAMES)}
    for entry in canonical:
        wcid = entry.get("weenieClassId")
        tier = entry.get("difficultyTier", "")
        if wcid and tier in tier_name_to_int:
            wcid_to_tier[wcid] = tier_name_to_int[tier]

    print(f"  Loaded {len(wcid_to_tier)} WCIDs with tier data")

    # Load spawn maps - extract creature positions + tiers
    print("  Loading spawn map data...")
    grid_tiers = [[[] for _ in range(255)] for _ in range(255)]

    with open(spawn_path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            spawn = json.loads(line)
            wcid = spawn.get("wcid")
            if wcid not in wcid_to_tier:
                continue

            # Get landblock position
            lb_id = spawn.get("landblockId")
            if lb_id is None:
                continue

            lbX = (lb_id >> 8) & 0xFF
            lbY = lb_id & 0xFF
            if 0 <= lbX < 255 and 0 <= lbY < 255:
                grid_tiers[lbX][lbY].append(wcid_to_tier[wcid])

    # Compute average tier per landblock
    grid = np.full((255, 255), -1, dtype=np.int8)
    populated = 0
    for x in range(255):
        for y in range(255):
            if grid_tiers[x][y]:
                avg_tier = sum(grid_tiers[x][y]) / len(grid_tiers[x][y])
                grid[x, y] = min(int(round(avg_tier)), 5)
                populated += 1

    print(f"  Populated landblocks with spawn tier data: {populated}")
    return grid


def main():
    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_json = os.path.join(project_dir, "pipeline_data", "enrichment", "difficulty_gradient.json")
    output_image = os.path.join(project_dir, "pipeline_data", "enrichment", "difficulty_gradient.png")

    print("=" * 72)
    print("  Difficulty Gradient Generator")
    print("=" * 72)
    print()

    # Check for retail analysis mode
    if len(sys.argv) > 1 and sys.argv[1] == "--retail":
        print("  Mode: Retail spawn analysis")
        print()
        grid = analyze_retail_spawns(project_dir)
        if grid is not None:
            retail_json = os.path.join(project_dir, "pipeline_data", "enrichment", "retail_difficulty_gradient.json")
            retail_image = os.path.join(project_dir, "pipeline_data", "enrichment", "retail_difficulty_gradient.png")
            save_gradient_json(grid, [], [], retail_json)
            save_gradient_image(grid, retail_image)
        return

    # Load config if provided
    anchors = DEFAULT_ANCHORS
    zone_widths = DEFAULT_ZONE_WIDTHS
    ocean_mask = None

    if len(sys.argv) > 1 and sys.argv[1] != "--retail":
        config_path = sys.argv[1]
        if os.path.exists(config_path):
            print(f"  Loading config: {config_path}")
            with open(config_path) as f:
                config = json.load(f)
            anchors = config.get("anchors", DEFAULT_ANCHORS)
            zone_widths = config.get("zone_widths", DEFAULT_ZONE_WIDTHS)

            # Load ocean mask if specified
            ocean_mask_path = config.get("ocean_mask")
            if ocean_mask_path:
                try:
                    from PIL import Image
                    mask_img = Image.open(ocean_mask_path).convert("L")
                    mask_img = mask_img.resize((255, 255), Image.NEAREST)
                    ocean_mask = np.array(mask_img)
                    ocean_count = np.sum(ocean_mask == 0)
                    print(f"  Loaded ocean mask: {ocean_count} ocean cells")
                except Exception as e:
                    print(f"  WARNING: Could not load ocean mask: {e}")
        else:
            print(f"  WARNING: Config file not found: {config_path}")
            print("  Using defaults.")

    # Also try auto-loading ocean mask
    if ocean_mask is None:
        auto_mask = os.path.join(project_dir, "ocean_mask.png")
        if os.path.exists(auto_mask):
            try:
                from PIL import Image
                mask_img = Image.open(auto_mask).convert("L")
                mask_img = mask_img.resize((255, 255), Image.NEAREST)
                ocean_mask = np.array(mask_img)
                ocean_count = np.sum(ocean_mask == 0)
                print(f"  Auto-loaded ocean mask: {ocean_count} ocean cells")
            except Exception:
                pass

    print()
    print(f"  Anchors: {len(anchors)}")
    for a in anchors:
        tier_name = TIER_NAMES[a['tier']] if a['tier'] < len(TIER_NAMES) else f"Tier {a['tier']}"
        print(f"    ({a['lbX']:3d}, {a['lbY']:3d})  {tier_name:10s}  {a.get('label', '')}")
    print()
    print(f"  Zone widths: {zone_widths}")
    print(f"    Starter zone: 0-{zone_widths[0]} LBs from anchor")
    for i in range(1, len(zone_widths)):
        print(f"    {TIER_NAMES[i]:10s} zone: {zone_widths[i-1]}-{zone_widths[i]} LBs from anchor")
    print(f"    {TIER_NAMES[len(zone_widths)]:10s} zone: {zone_widths[-1]}+ LBs from anchor")
    print()

    # Compute gradient
    print("  Computing difficulty gradient...")
    grid = compute_gradient(anchors, zone_widths, ocean_mask)

    # Report
    print()
    print("  -- RESULTS --")
    total_land = np.sum(grid >= 0)
    for i, name in enumerate(TIER_NAMES):
        count = int(np.sum(grid == i))
        pct = 100.0 * count / total_land if total_land > 0 else 0
        print(f"    {name:12s}  {count:6d} landblocks  ({pct:5.1f}%)")
    ocean = int(np.sum(grid == -1))
    if ocean > 0:
        print(f"    {'Ocean':12s}  {ocean:6d} landblocks")
    print()

    # Save outputs
    save_gradient_json(grid, anchors, zone_widths, output_json)
    save_gradient_image(grid, output_image)

    print()
    print("  The gradient is ready for PopulateEmptyAreas.")
    print("  Edit the anchors and re-run to adjust difficulty zones.")
    print("=" * 72)


if __name__ == "__main__":
    main()
