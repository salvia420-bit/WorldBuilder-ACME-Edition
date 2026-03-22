#!/usr/bin/env python3
"""
Scan Building Culture Map

Reads the weenie_summary.jsonl to find town NPCs/vendors with known positions,
then reads a building_placements.jsonl (extracted from retail DAT BuildingInfo)
and geocodes each building model to its nearest cultural town.

Output: building_culture_map.json
  Maps Setup ID -> { architecture, confidence, nearest_town, distance }

This script operates in two phases:
  Phase 1: Build a cultural town coordinate table from known town weenies
  Phase 2: (Requires building_placements.jsonl from C# scanner)

For Phase 1, we use hardcoded AC town coordinates (well-known from the game).
"""

import json
import math
import sys
import os
from collections import Counter, defaultdict

# ══════════════════════════════════════════════════════════════
#  Known AC town centers (world coordinates, NOT landblock coords)
#  These are well-established from the game. Units = AC world units.
#  1 landblock = 192 world units. Grid is 255×255 landblocks.
#  World spans from (0,0) to (255*192, 255*192) = (48960, 48960)
#
#  Coordinates sourced from AC wiki town pages (converted from
#  in-game map coordinates). Format: (worldX, worldY)
# ══════════════════════════════════════════════════════════════

TOWN_LOCATIONS = {
    # Aluvian towns
    "Holtburg":     (42.0 * 192, 174.8 * 192),   # ~(8064, 33562)
    "Lytelthorpe":  (51.2 * 192, 181.2 * 192),
    "Rithwic":      (49.5 * 192, 196.4 * 192),
    "Cragstone":    (27.4 * 192, 220.4 * 192),
    "Arwic":        (33.8 * 192, 219.0 * 192),
    "Eastham":      (20.9 * 192, 230.5 * 192),
    "Glenden Wood": (29.9 * 192, 243.9 * 192),
    "Stonehold":    (69.3 * 192, 246.1 * 192),
    "Dryreach":     (40.3 * 192, 215.9 * 192),
    "Plateau Village": (56.7 * 192, 218.2 * 192),
    # Sho towns
    "Shoushi":      (33.8 * 192, 137.2 * 192),
    "Yanshi":       (12.4 * 192, 146.4 * 192),
    "Mayoi":        (62.0 * 192, 122.4 * 192),
    "Nanto":        (51.8 * 192, 113.8 * 192),
    "Hebian-To":    (26.5 * 192, 129.5 * 192),
    "Sawato":       (26.7 * 192, 140.3 * 192),
    "Baishi":       (49.4 * 192, 124.3 * 192),
    "Lin":          (54.5 * 192, 140.1 * 192),
    "Kara":         (83.6 * 192, 132.8 * 192),
    # Gharu'ndim towns
    "Yaraq":        (21.5 * 192, 95.5 * 192),
    "Samsur":       (3.0 * 192, 105.6 * 192),
    "Al-Arqas":     (30.6 * 192, 106.5 * 192),
    "Al-Jalima":    (7.4 * 192, 94.1 * 192),
    "Tufa":         (14.1 * 192, 112.2 * 192),
    "Qalaba'r":     (74.2 * 192, 99.0 * 192),
    "Uziz":         (25.8 * 192, 92.3 * 192),
    "Xarabydun":    (41.7 * 192, 85.7 * 192),
    "Zaikhal":      (13.6 * 192, 125.1 * 192),
    "Khayyaban":    (43.3 * 192, 99.9 * 192),
    "Ayan Baqur":   (59.5 * 192, 101.2 * 192),
    # Viamontian towns
    "Sanamar":      (72.0 * 192, 211.5 * 192),
    "Silyun":       (63.7 * 192, 217.2 * 192),
    "Freehold":     (78.5 * 192, 220.3 * 192),
    # Empyrean locations
    "Candeth Keep": (87.7 * 192, 148.3 * 192),
    "Knorr":        (80.0 * 192, 84.0 * 192),
    "Aerlinthe":    (84.0 * 192, 169.0 * 192),
}

TOWN_ARCHITECTURE = {
    "Holtburg": "Aluvian", "Lytelthorpe": "Aluvian", "Rithwic": "Aluvian",
    "Cragstone": "Aluvian", "Arwic": "Aluvian", "Eastham": "Aluvian",
    "Glenden Wood": "Aluvian", "Stonehold": "Aluvian", "Dryreach": "Aluvian",
    "Plateau Village": "Aluvian",
    "Shoushi": "Sho", "Yanshi": "Sho", "Mayoi": "Sho", "Nanto": "Sho",
    "Hebian-To": "Sho", "Sawato": "Sho", "Baishi": "Sho", "Lin": "Sho",
    "Kara": "Sho",
    "Yaraq": "Gharu'ndim", "Samsur": "Gharu'ndim", "Al-Arqas": "Gharu'ndim",
    "Al-Jalima": "Gharu'ndim", "Tufa": "Gharu'ndim", "Qalaba'r": "Gharu'ndim",
    "Uziz": "Gharu'ndim", "Xarabydun": "Gharu'ndim", "Zaikhal": "Gharu'ndim",
    "Khayyaban": "Gharu'ndim", "Ayan Baqur": "Gharu'ndim",
    "Sanamar": "Viamontian", "Silyun": "Viamontian", "Freehold": "Viamontian",
    "Candeth Keep": "Empyrean", "Knorr": "Empyrean", "Aerlinthe": "Empyrean",
}

# Max distance (in world units) to consider a building culturally affiliated
# 10 landblocks = 1920 units. Buildings within ~5 landblocks of a town center
# are very likely to share that town's culture.
MAX_CULTURE_RADIUS = 5 * 192   # 960 world units (~5 landblocks)
# Extended radius for weaker confidence
EXTENDED_RADIUS = 15 * 192     # 2880 world units (~15 landblocks)


def distance(x1, y1, x2, y2):
    return math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)


def find_nearest_town(world_x, world_y):
    """Find the nearest cultural town. Returns (town_name, architecture, distance)."""
    best_town = None
    best_arch = None
    best_dist = float('inf')

    for town_name, (tx, ty) in TOWN_LOCATIONS.items():
        d = distance(world_x, world_y, tx, ty)
        if d < best_dist:
            best_dist = d
            best_town = town_name
            best_arch = TOWN_ARCHITECTURE[town_name]

    return best_town, best_arch, best_dist


def main():
    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    building_placements_path = os.path.join(project_dir, "pipeline_data", "enrichment", "building_placements.jsonl")
    output_path = os.path.join(project_dir, "pipeline_data", "enrichment", "building_culture_map.json")

    if not os.path.exists(building_placements_path):
        print("=" * 72)
        print("  Building Culture Scanner -- Phase 1")
        print("=" * 72)
        print()
        print(f"  WARNING: No building_placements.jsonl found at:")
        print(f"    {building_placements_path}")
        print()
        print("  This file must be generated by the C# building scanner.")
        print("  Run this command in the WorldBuilder terminal:")
        print()
        print("    scan-building-placements")
        print()
        print("  This scans all retail landblocks and extracts building")
        print("  Setup IDs with their world positions.")
        print()
        print("  After that, re-run this script to geocode them.")
        print("=" * 72)

        # Generate the town coordinate reference file for the C# scanner
        town_ref_path = os.path.join(project_dir, "town_coordinates.json")
        town_ref = {}
        for name, (x, y) in TOWN_LOCATIONS.items():
            town_ref[name] = {
                "worldX": round(x, 1),
                "worldY": round(y, 1),
                "lbX": round(x / 192, 1),
                "lbY": round(y / 192, 1),
                "architecture": TOWN_ARCHITECTURE[name]
            }
        with open(town_ref_path, "w") as f:
            json.dump(town_ref, f, indent=2)
        print(f"\n  -> Saved town coordinate reference: {town_ref_path}")
        return

    # ── Phase 2: Geocode buildings ─────────────────────────────────────
    print("=" * 72)
    print("  Building Culture Scanner -- Phase 2: Geocoding")
    print("=" * 72)
    print()

    # Read building placements
    placements = []
    with open(building_placements_path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            placements.append(json.loads(line))

    print(f"  Read {len(placements)} building placements")

    # Deduplicate: group by setupId, collect all positions
    setup_positions = defaultdict(list)
    for p in placements:
        setup_id = p["setupId"]
        world_x = p["worldX"]
        world_y = p["worldY"]
        setup_positions[setup_id].append((world_x, world_y))

    print(f"  Unique building Setup IDs: {len(setup_positions)}")

    # For each Setup ID, geocode all its positions and vote on culture
    results = {}
    arch_counts = Counter()
    confidence_counts = Counter()

    for setup_id, positions in setup_positions.items():
        # Geocode each placement
        votes = Counter()
        nearest_distances = {}

        for wx, wy in positions:
            town, arch, dist = find_nearest_town(wx, wy)

            if dist <= MAX_CULTURE_RADIUS:
                # High confidence: within 5 landblocks of a town
                votes[arch] += 3  # Strong vote
                nearest_distances.setdefault(arch, []).append((town, dist))
            elif dist <= EXTENDED_RADIUS:
                # Medium confidence: within 15 landblocks
                votes[arch] += 1  # Weak vote
                nearest_distances.setdefault(arch, []).append((town, dist))
            # else: too far from any town -> no vote (stays Neutral)

        if votes:
            # Winner takes all
            winner = votes.most_common(1)[0][0]
            total_votes = sum(votes.values())
            winner_votes = votes[winner]
            confidence = "high" if winner_votes >= 3 else "medium" if winner_votes >= 1 else "low"

            # Find the closest town of the winning culture
            closest_town = None
            closest_dist = float('inf')
            if winner in nearest_distances:
                for town, dist in nearest_distances[winner]:
                    if dist < closest_dist:
                        closest_dist = dist
                        closest_town = town

            results[str(setup_id)] = {
                "architecture": winner,
                "confidence": confidence,
                "nearest_town": closest_town,
                "distance_units": round(closest_dist, 1),
                "distance_landblocks": round(closest_dist / 192, 1),
                "placement_count": len(positions),
                "vote_breakdown": dict(votes),
            }
            arch_counts[winner] += 1
            confidence_counts[confidence] += 1
        else:
            # No nearby town -> culturally neutral
            results[str(setup_id)] = {
                "architecture": "Neutral",
                "confidence": "default",
                "nearest_town": None,
                "distance_units": None,
                "distance_landblocks": None,
                "placement_count": len(positions),
                "vote_breakdown": {},
            }
            arch_counts["Neutral"] += 1
            confidence_counts["default"] += 1

    # Write output
    output = {
        "description": "Building Setup ID -> Cultural Architecture mapping",
        "method": "Geocoded from retail landblock positions to nearest cultural town",
        "total_buildings": len(results),
        "architecture_distribution": dict(arch_counts.most_common()),
        "confidence_distribution": dict(confidence_counts.most_common()),
        "entries": results,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    # Report
    print()
    print("  -- RESULTS --")
    print(f"  Total unique building models: {len(results)}")
    print()
    print("  Architecture distribution:")
    for arch, count in arch_counts.most_common():
        print(f"    {arch:20s} {count:5d}")
    print()
    print("  Confidence distribution:")
    for conf, count in confidence_counts.most_common():
        print(f"    {conf:20s} {count:5d}")
    print()
    print(f"  -> Output: {output_path}")
    print("=" * 72)


if __name__ == "__main__":
    main()
