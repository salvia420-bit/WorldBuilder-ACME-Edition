#!/usr/bin/env python3
"""
Build Population Plan

Generates a population_plan.json that specifies what objects to place in each
empty/sparse landblock of a new world. Uses:
  - canonical_enrichment.json  (12,648 tagged objects)
  - difficulty_gradient.json   (255x255 tier grid)
  - building_culture_map.json  (398 building models -> culture)
  - (optional) cultural_zones.json (user-defined cultural zones)

Output: population_plan.json
  A list of placements per landblock, ready for the C# apply-population command.

Usage:
  python scripts/PopulationPipeline/Planning/build_population_plan.py                    # defaults
  python scripts/PopulationPipeline/Planning/build_population_plan.py --config plan.json # custom config
"""

import json
import math
import os
import sys
import random
from collections import defaultdict

TIER_NAMES = ["Starter", "Low", "Medium", "Hard", "Elite", "Legendary"]

# ═══════════════════════════════════════════════════════════
#  Density profiles: how many objects per landblock by tier
#  Format: (min_objects, max_objects) per category
# ═══════════════════════════════════════════════════════════
DENSITY = {
    # tier: {category: (min, max)}
    0: {"Scenery": (4, 8),  "Creature": (2, 4), "Structure": (0, 1), "Interactive": (0, 1)},  # Starter
    1: {"Scenery": (3, 7),  "Creature": (2, 5), "Structure": (0, 1), "Interactive": (0, 1)},  # Low
    2: {"Scenery": (3, 6),  "Creature": (3, 6), "Structure": (0, 1), "Interactive": (0, 1)},  # Medium
    3: {"Scenery": (2, 5),  "Creature": (3, 7), "Structure": (0, 1), "Interactive": (0, 0)},  # Hard
    4: {"Scenery": (2, 4),  "Creature": (4, 8), "Structure": (0, 0), "Interactive": (0, 0)},  # Elite
    5: {"Scenery": (1, 3),  "Creature": (4, 9), "Structure": (0, 0), "Interactive": (0, 0)},  # Legendary
}

# Spawn probability per landblock (not every landblock gets populated)
SPAWN_PROBABILITY = {
    0: 0.7,   # Starter: 70% of landblocks populated
    1: 0.5,   # Low: 50%
    2: 0.4,   # Medium: 40%
    3: 0.3,   # Hard: 30%
    4: 0.2,   # Elite: 20%
    5: 0.15,  # Legendary: 15%
}


def load_canonical_enrichment(project_dir):
    """Load and index the canonical enrichment data."""
    path = os.path.join(project_dir, "pipeline_data", "enrichment", "canonical_enrichment.json")
    if not os.path.exists(path):
        print(f"  ERROR: {path} not found")
        return None

    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)

    # Handle both list format and dict-with-entries format
    if isinstance(data, list):
        entries = data
    elif isinstance(data, dict) and "entries" in data:
        entries = data["entries"]
    else:
        print(f"  ERROR: Unexpected format in {path}")
        return None

    # Build indices for fast lookup
    index = {
        "by_tier": defaultdict(list),       # tier -> [entries]
        "by_biome": defaultdict(list),      # biome -> [entries]
        "by_arch": defaultdict(list),       # architecture -> [entries]
        "by_type": defaultdict(list),       # type -> [entries]
        "by_behavior": defaultdict(list),   # behavior -> [entries]
        "creatures": [],
        "scenery": [],
        "structures": [],
        "interactive": [],
        "all": entries,
    }

    for e in entries:
        tier = e.get("difficulty_tier", "")
        biome_list = e.get("biome", [])
        if isinstance(biome_list, str):
            biome_list = [biome_list]
        arch = e.get("architecture", "Neutral")
        obj_type = e.get("type", "")
        behavior = e.get("behavior", "")
        setup_did = e.get("setupDid")

        if not setup_did:
            continue

        if tier:
            index["by_tier"][tier].append(e)
        for b in biome_list:
            index["by_biome"][b].append(e)
        if arch:
            index["by_arch"][arch].append(e)
        if obj_type:
            index["by_type"][obj_type].append(e)
        if behavior:
            index["by_behavior"][behavior].append(e)

        # Classify into broad categories
        type_lower = obj_type.lower() if obj_type else ""
        if "creature" in type_lower or behavior in ("Melee", "Missile", "Magic", "Mixed"):
            index["creatures"].append(e)
        elif "scenery" in type_lower or "prop" in type_lower or "furniture" in type_lower:
            index["scenery"].append(e)
        elif "structure" in type_lower:
            index["structures"].append(e)
        elif "portal" in type_lower or "sign" in type_lower or "chest" in type_lower:
            index["interactive"].append(e)

    return index


def load_building_culture_map(project_dir):
    """Load the building culture map."""
    path = os.path.join(project_dir, "pipeline_data", "enrichment", "building_culture_map.json")
    if not os.path.exists(path):
        return {}

    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)

    # Index by architecture
    by_arch = defaultdict(list)
    for setup_id_str, info in data.get("entries", {}).items():
        arch = info.get("architecture", "Neutral")
        by_arch[arch].append({
            "setupId": int(setup_id_str),
            "architecture": arch,
            "confidence": info.get("confidence", "default"),
            "placement_count": info.get("placement_count", 0),
        })

    return by_arch


def load_difficulty_gradient(project_dir):
    """Load the 255x255 difficulty grid."""
    path = os.path.join(project_dir, "pipeline_data", "enrichment", "difficulty_gradient.json")
    if not os.path.exists(path):
        print(f"  ERROR: {path} not found")
        return None

    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)

    return data.get("grid")


def load_cultural_zones(project_dir):
    """
    Load or generate cultural zone assignments.
    Returns a 255x255 grid where each cell is an architecture string.
    """
    path = os.path.join(project_dir, "cultural_zones.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
        return data.get("grid")

    # Generate default: voronoi from the starter town positions
    # Same towns as the difficulty gradient defaults
    culture_centers = [
        (42,  175, "Aluvian"),
        (34,  137, "Sho"),
        (22,   96, "Gharu'ndim"),
        (70,  246, "Viamontian"),
        (87,  148, "Empyrean"),
    ]

    grid = [["Neutral"] * 255 for _ in range(255)]
    for x in range(255):
        for y in range(255):
            best_dist = float('inf')
            best_culture = "Neutral"
            for cx, cy, culture in culture_centers:
                dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
                if dist < best_dist and dist < 80:  # Max cultural reach: 80 LBs
                    best_dist = dist
                    best_culture = culture
            grid[x][y] = best_culture

    return grid


def select_creatures(index, tier, biome, culture, count):
    """Select appropriate creatures for a landblock."""
    candidates = []

    # Filter by tier first
    tier_entries = index["by_tier"].get(tier, [])
    for e in tier_entries:
        # Check if creature
        obj_type = e.get("type", "").lower()
        behavior = e.get("behavior", "")
        if not ("creature" in obj_type or behavior in ("Melee", "Missile", "Magic", "Mixed")):
            continue

        # Score by biome match
        score = 1
        entry_biomes = e.get("biome", [])
        if isinstance(entry_biomes, str):
            entry_biomes = [entry_biomes]
        if biome in entry_biomes or "Any" in entry_biomes:
            score += 5
        elif not entry_biomes:
            score += 1  # No biome restriction

        # Score by culture match
        entry_arch = e.get("architecture", "Neutral")
        if entry_arch == culture or entry_arch == "Neutral":
            score += 2

        candidates.append((e, score))

    if not candidates:
        # Fallback: any creature at this tier
        for e in index["creatures"]:
            if e.get("difficulty_tier") == tier:
                candidates.append((e, 1))

    if not candidates:
        return []

    # Weighted random selection
    candidates.sort(key=lambda x: x[1], reverse=True)
    selected = []
    for _ in range(min(count, len(candidates))):
        # Top-heavy weighted: prefer higher scores
        weights = [c[1] for c in candidates]
        total = sum(weights)
        r = random.uniform(0, total)
        cumulative = 0
        for i, (entry, score) in enumerate(candidates):
            cumulative += score
            if r <= cumulative:
                selected.append(entry)
                break

    return selected


def select_scenery(index, biome, culture, count):
    """Select appropriate scenery for a landblock."""
    candidates = []

    for e in index["scenery"]:
        score = 1
        entry_biomes = e.get("biome", [])
        if isinstance(entry_biomes, str):
            entry_biomes = [entry_biomes]
        if biome in entry_biomes or "Any" in entry_biomes:
            score += 3
        elif not entry_biomes:
            score += 1

        entry_arch = e.get("architecture", "Neutral")
        if entry_arch == "Neutral":
            score += 2  # Neutral scenery goes everywhere
        elif entry_arch == culture:
            score += 3  # Cultural match bonus

        candidates.append((e, score))

    if not candidates:
        return []

    selected = []
    for _ in range(min(count, len(candidates))):
        weights = [c[1] for c in candidates]
        total = sum(weights)
        r = random.uniform(0, total)
        cumulative = 0
        for i, (entry, score) in enumerate(candidates):
            cumulative += score
            if r <= cumulative:
                selected.append(entry)
                break

    return selected


def random_position_in_landblock():
    """Generate a random position within a 192x192 landblock."""
    # Avoid edges (first/last 12 units) and prefer middle areas
    x = random.uniform(12.0, 180.0)
    y = random.uniform(12.0, 180.0)
    z = 0.0  # Will be height-snapped by the C# applier
    return round(x, 1), round(y, 1), round(z, 1)


def main():
    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_path = os.path.join(project_dir, "pipeline_data", "enrichment", "population_plan.json")

    print("=" * 72)
    print("  Population Plan Generator")
    print("=" * 72)
    print()

    # Seed for reproducibility (can be overridden in config)
    seed = 42
    if len(sys.argv) > 2 and sys.argv[1] == "--seed":
        seed = int(sys.argv[2])
    random.seed(seed)
    print(f"  Random seed: {seed}")
    print()

    # Load all data sources
    print("  Loading canonical enrichment...")
    index = load_canonical_enrichment(project_dir)
    if index is None:
        return
    print(f"    Loaded {len(index['all'])} entries")
    print(f"    Creatures: {len(index['creatures'])}")
    print(f"    Scenery:   {len(index['scenery'])}")
    print(f"    Structures: {len(index['structures'])}")
    print(f"    Interactive: {len(index['interactive'])}")
    print()

    print("  Loading building culture map...")
    building_cultures = load_building_culture_map(project_dir)
    total_buildings = sum(len(v) for v in building_cultures.values())
    print(f"    Loaded {total_buildings} building models across {len(building_cultures)} cultures")
    print()

    print("  Loading difficulty gradient...")
    gradient = load_difficulty_gradient(project_dir)
    if gradient is None:
        return
    print(f"    Grid loaded: 255x255")
    print()

    print("  Loading cultural zones...")
    cultural_zones = load_cultural_zones(project_dir)
    print(f"    Grid loaded: 255x255")
    print()

    # Generate plan
    print("  Generating population plan...")
    plan = {
        "description": "World population plan - objects to place in each landblock",
        "seed": seed,
        "total_landblocks": 0,
        "total_objects": 0,
        "tier_stats": {t: {"landblocks": 0, "objects": 0} for t in TIER_NAMES},
        "category_stats": {"Creature": 0, "Scenery": 0, "Structure": 0, "Interactive": 0},
        "placements": [],
    }

    for x in range(255):
        for y in range(255):
            tier_val = gradient[x][y]
            if tier_val < 0:  # Ocean
                continue
            if tier_val > 5:
                tier_val = 5

            tier_name = TIER_NAMES[tier_val]
            culture = cultural_zones[x][y] if cultural_zones else "Neutral"

            # Roll spawn probability
            if random.random() > SPAWN_PROBABILITY.get(tier_val, 0.3):
                continue

            # Determine biome (simplified — in a real scenario, read from biome_map.json)
            # For now, infer from Y position (rough latitude):
            #   Bottom (y < 85) = Arid/Desert
            #   Middle (85-170) = Temperate
            #   Top (y > 170) = Cold/Forest
            if y < 85:
                biome = "Arid"
            elif y < 130:
                biome = "Temperate"
            elif y < 200:
                biome = "Temperate"
            else:
                biome = "Snowy"

            # Get density for this tier
            density = DENSITY.get(tier_val, DENSITY[2])
            lb_objects = []

            # Select creatures
            n_creatures = random.randint(*density["Creature"])
            creatures = select_creatures(index, tier_name, biome, culture, n_creatures)
            for c in creatures:
                px, py, pz = random_position_in_landblock()
                lb_objects.append({
                    "setupId": c.get("setupDid"),
                    "name": c.get("name", "Unknown"),
                    "category": "Creature",
                    "tier": tier_name,
                    "localX": px,
                    "localY": py,
                    "localZ": pz,
                })

            # Select scenery
            n_scenery = random.randint(*density["Scenery"])
            scenery = select_scenery(index, biome, culture, n_scenery)
            for s in scenery:
                px, py, pz = random_position_in_landblock()
                lb_objects.append({
                    "setupId": s.get("setupDid"),
                    "name": s.get("name", "Unknown"),
                    "category": "Scenery",
                    "localX": px,
                    "localY": py,
                    "localZ": pz,
                })

            # Select structures (buildings from building_culture_map)
            n_structures = random.randint(*density["Structure"])
            if n_structures > 0 and culture in building_cultures:
                culture_buildings = building_cultures[culture]
                if not culture_buildings:
                    culture_buildings = building_cultures.get("Neutral", [])
                if culture_buildings:
                    for _ in range(n_structures):
                        bldg = random.choice(culture_buildings)
                        px, py, pz = random_position_in_landblock()
                        lb_objects.append({
                            "setupId": bldg["setupId"],
                            "name": f"Building ({culture})",
                            "category": "Structure",
                            "localX": px,
                            "localY": py,
                            "localZ": pz,
                        })

            if not lb_objects:
                continue

            plan["placements"].append({
                "lbX": x,
                "lbY": y,
                "tier": tier_name,
                "culture": culture,
                "biome": biome,
                "objects": lb_objects,
            })
            plan["total_landblocks"] += 1
            plan["total_objects"] += len(lb_objects)
            plan["tier_stats"][tier_name]["landblocks"] += 1
            plan["tier_stats"][tier_name]["objects"] += len(lb_objects)
            for obj in lb_objects:
                cat = obj.get("category", "Scenery")
                plan["category_stats"][cat] = plan["category_stats"].get(cat, 0) + 1

        if (x + 1) % 50 == 0:
            print(f"    ...{x + 1}/255 rows processed, {plan['total_landblocks']} populated")

    # Save plan
    with open(output_path, "w") as f:
        json.dump(plan, f, indent=2)

    # Report
    print()
    print("  -- RESULTS --")
    print(f"  Total populated landblocks: {plan['total_landblocks']}")
    print(f"  Total objects to place:     {plan['total_objects']}")
    print()
    print("  By difficulty tier:")
    for t in TIER_NAMES:
        stats = plan["tier_stats"][t]
        print(f"    {t:12s}  {stats['landblocks']:5d} LBs, {stats['objects']:6d} objects")
    print()
    print("  By category:")
    for cat, count in sorted(plan["category_stats"].items()):
        print(f"    {cat:12s}  {count:6d}")
    print()
    sz = os.path.getsize(output_path)
    print(f"  -> Output: {output_path} ({sz / 1024 / 1024:.1f} MB)")
    print()
    print("  Next: apply the plan with 'apply-population population_plan.json'")
    print("=" * 72)


if __name__ == "__main__":
    main()
