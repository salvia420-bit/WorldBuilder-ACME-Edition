#!/usr/bin/env python3
"""
Generate a one-off high-density scenery-only population plan for stress testing.

This is intentionally non-invasive: it does not modify WorldBuilder itself.
It emits a standard population_plan-style JSON file that can be applied with:

  apply-population <plan-path>

The plan focuses on static scenery only, using the same outdoor setup IDs that
QuickWorld already uses for biome-based scatter. The goal is to stress-test
client rendering with dense forests, rocks, and ambient scenery while keeping
clear lanes to run through.
"""

import argparse
import json
import os
import random
from collections import Counter


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
DEFAULT_BIOME_MAP = os.path.join(PROJECT_DIR, "pipeline_data", "enrichment", "biome_map.json")
DEFAULT_OUTPUT = os.path.join(PROJECT_DIR, "pipeline_data", "enrichment", "dense_scatter_stress_plan.json")


# Reuse the same trusted setup IDs that QuickWorld already scatters.
SCENERY_BY_BIOME = {
    "forest":    [0x02000B53, 0x02000B57, 0x02000BE0, 0x02000BDE, 0x02000B5B],
    "grassland": [0x02000B53, 0x02000B5B, 0x02000BD7, 0x02000BD8],
    "swamp":     [0x02000B53, 0x02000BD7],
    "snow":      [0x02000BDE, 0x02000B95],
    "desert":    [0x02000B95, 0x02000BD7],
    "barren":    [0x02000B95, 0x02000B97],
    "obsidian":  [0x02000B95, 0x02000B97],
    "mountain":  [0x02000B95, 0x02000B97, 0x02000B99],
    "road":      [0x02000B5B, 0x02000BD7],
}


DENSITY_PROFILES = {
    "high": {
        "forest":    (28, 44),
        "grassland": (18, 30),
        "swamp":     (18, 28),
        "snow":      (10, 18),
        "desert":    (8, 16),
        "barren":    (8, 16),
        "obsidian":  (8, 16),
        "mountain":  (8, 14),
        "road":      (4, 8),
    },
    "extreme": {
        "forest":    (48, 78),
        "grassland": (28, 48),
        "swamp":     (28, 44),
        "snow":      (16, 28),
        "desert":    (12, 24),
        "barren":    (12, 24),
        "obsidian":  (12, 24),
        "mountain":  (12, 20),
        "road":      (6, 12),
    },
}


NON_LAND_BIOMES = {"ocean", "water", "impassable_water"}


def load_biome_grid(path: str):
    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)

    if "biomeGrid" in data:
        return data["biomeGrid"]
    if "grid" in data:
        return data["grid"]
    raise ValueError(f"Biome map format not recognized: {path}")


def choose_count(profile_name: str, biome: str, multiplier: float) -> int:
    profile = DENSITY_PROFILES[profile_name]
    base_min, base_max = profile.get(biome, profile["barren"])
    scaled_min = max(0, int(round(base_min * multiplier)))
    scaled_max = max(scaled_min, int(round(base_max * multiplier)))
    return random.randint(scaled_min, scaled_max)


def sample_position(corridor_half_width: float, edge_margin: float):
    return (
        round(random.uniform(edge_margin, 192.0 - edge_margin), 1),
        round(random.uniform(edge_margin, 192.0 - edge_margin), 1),
    )


def in_corridor(x: float, y: float, corridor_half_width: float) -> bool:
    return abs(x - 96.0) < corridor_half_width or abs(y - 96.0) < corridor_half_width


def far_enough(x: float, y: float, points, min_spacing: float) -> bool:
    min_sq = min_spacing * min_spacing
    for px, py in points:
        dx = x - px
        dy = y - py
        if dx * dx + dy * dy < min_sq:
            return False
    return True


def build_landblock_objects(biome: str, count: int, corridor_half_width: float,
                            edge_margin: float, min_spacing: float, max_attempts: int):
    models = SCENERY_BY_BIOME.get(biome, SCENERY_BY_BIOME["barren"])
    points = []
    objects = []
    attempts = 0

    while len(objects) < count and attempts < max_attempts:
        attempts += 1
        x, y = sample_position(corridor_half_width, edge_margin)
        if corridor_half_width > 0 and in_corridor(x, y, corridor_half_width):
            continue
        if min_spacing > 0 and not far_enough(x, y, points, min_spacing):
            continue

        points.append((x, y))
        objects.append({
            "setupId": random.choice(models),
            "name": f"DenseScatter {biome}",
            "category": "Scenery",
            "localX": x,
            "localY": y,
            "localZ": 0.0,
        })

    return objects, attempts


def main():
    parser = argparse.ArgumentParser(description="Generate dense scenery stress-test population plan")
    parser.add_argument("--biome-map", default=DEFAULT_BIOME_MAP,
                        help="Path to biome_map.json from analyze-map-image")
    parser.add_argument("--output", default=DEFAULT_OUTPUT,
                        help="Output population plan JSON")
    parser.add_argument("--profile", choices=sorted(DENSITY_PROFILES.keys()), default="extreme")
    parser.add_argument("--density-multiplier", type=float, default=1.0,
                        help="Scale all density ranges up/down")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--corridor-width", type=float, default=18.0,
                        help="Width of the cross-shaped running lanes reserved in each landblock")
    parser.add_argument("--edge-margin", type=float, default=12.0,
                        help="Keep placements away from landblock edges")
    parser.add_argument("--min-spacing", type=float, default=7.0,
                        help="Minimum local XY spacing between objects")
    parser.add_argument("--max-attempts-per-landblock", type=int, default=3000)
    parser.add_argument("--lb-x-min", type=int, default=0)
    parser.add_argument("--lb-x-max", type=int, default=254)
    parser.add_argument("--lb-y-min", type=int, default=0)
    parser.add_argument("--lb-y-max", type=int, default=254)
    parser.add_argument("--clearings-every", type=int, default=7,
                        help="Every Nth landblock becomes a sparser clearing; 0 disables")
    parser.add_argument("--clearing-scale", type=float, default=0.2,
                        help="Density multiplier for clearing landblocks")
    args = parser.parse_args()

    random.seed(args.seed)
    biome_grid = load_biome_grid(args.biome_map)

    corridor_half_width = max(0.0, args.corridor_width / 2.0)
    plan = {
        "description": "One-off dense scenery stress test plan",
        "seed": args.seed,
        "generator": "generate_dense_scatter_plan.py",
        "profile": args.profile,
        "densityMultiplier": args.density_multiplier,
        "corridorWidth": args.corridor_width,
        "minSpacing": args.min_spacing,
        "total_landblocks": 0,
        "total_objects": 0,
        "category_stats": {"Scenery": 0},
        "biome_stats": {},
        "placements": [],
    }

    biome_counts = Counter()
    attempt_counts = Counter()

    for lb_x in range(max(0, args.lb_x_min), min(254, args.lb_x_max) + 1):
        for lb_y in range(max(0, args.lb_y_min), min(254, args.lb_y_max) + 1):
            biome = biome_grid[lb_x][lb_y]
            if biome in NON_LAND_BIOMES:
                continue

            density_scale = args.density_multiplier
            if args.clearings_every > 0 and ((lb_x + lb_y) % args.clearings_every == 0):
                density_scale *= args.clearing_scale

            count = choose_count(args.profile, biome, density_scale)
            if count <= 0:
                continue

            objects, attempts = build_landblock_objects(
                biome=biome,
                count=count,
                corridor_half_width=corridor_half_width,
                edge_margin=args.edge_margin,
                min_spacing=args.min_spacing,
                max_attempts=args.max_attempts_per_landblock,
            )

            if not objects:
                continue

            biome_counts[biome] += len(objects)
            attempt_counts[biome] += attempts

            plan["placements"].append({
                "lbX": lb_x,
                "lbY": lb_y,
                "biome": biome,
                "objects": objects,
            })
            plan["total_landblocks"] += 1
            plan["total_objects"] += len(objects)

    for biome, count in sorted(biome_counts.items()):
        plan["biome_stats"][biome] = {
            "objects": count,
            "avgAttemptsPerPopulatedLb": round(attempt_counts[biome] / max(1, sum(1 for p in plan["placements"] if p["biome"] == biome)), 1),
        }

    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=2)

    print("=" * 72)
    print("  Dense Scatter Stress Plan")
    print("=" * 72)
    print(f"  Biome map:            {args.biome_map}")
    print(f"  Output:               {args.output}")
    print(f"  Profile:              {args.profile}")
    print(f"  Density multiplier:   {args.density_multiplier}")
    print(f"  Corridor width:       {args.corridor_width}")
    print(f"  Min spacing:          {args.min_spacing}")
    print(f"  Populated landblocks: {plan['total_landblocks']}")
    print(f"  Total scenery objs:   {plan['total_objects']}")
    print()
    print("  Objects by biome:")
    for biome, stats in plan["biome_stats"].items():
        print(f"    {biome:12s} {stats['objects']:8d} objs")
    print()
    print("  Apply with:")
    print(f"    apply-population {args.output}")
    print("=" * 72)


if __name__ == "__main__":
    main()
