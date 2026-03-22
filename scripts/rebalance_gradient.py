#!/usr/bin/env python3
"""
rebalance_gradient.py — Create a properly balanced difficulty gradient
=====================================================================

The current gradient is 72% Legendary (Tier 5), which is absurd.
This script creates a balanced gradient based on AC retail distribution:
  - Starter areas near coast/towns
  - Gradual difficulty increase toward interior
  - Legendary only in truly dangerous zones
"""
import json
import math
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRADIENT_PATH = os.path.join(BASE_DIR, "pipeline_data", "enrichment", "difficulty_gradient.json")
GRID_SIZE = 255

def main():
    # Load existing gradient for anchors
    with open(GRADIENT_PATH) as f:
        old = json.load(f)

    print(f"Old distribution: {old['tier_distribution']}")

    # Target distribution (inspired by AC retail):
    # Tier 0 (Starter 1-20):    ~5% of land  — safe starter zones near towns
    # Tier 1 (Low 20-40):       ~15% of land — relatively safe, beginner areas
    # Tier 2 (Medium 40-80):    ~25% of land — moderate challenge, mid game
    # Tier 3 (Hard 80-120):     ~25% of land — serious combat, high level
    # Tier 4 (Elite 120-175):   ~20% of land — endgame content
    # Tier 5 (Legendary 175+):  ~10% of land — hardest areas, deep wilderness

    # Anchors: starter towns plus additional mid-level hubs
    anchors = [
        # Four starter towns (Tier 0) — near edges/coast
        {"lbX": 42, "lbY": 175, "tier": 0, "label": "Starter Town North (Aluvian)", "radius": 25},
        {"lbX": 34, "lbY": 137, "tier": 0, "label": "Starter Town East (Sho)", "radius": 25},
        {"lbX": 22, "lbY": 96, "tier": 0, "label": "Starter Town South (Gharu'ndim)", "radius": 25},
        {"lbX": 10, "lbY": 200, "tier": 0, "label": "Starter Town West (Viamontian)", "radius": 25},

        # Low-tier hubs (Tier 1) — around starter areas
        {"lbX": 55, "lbY": 160, "tier": 1, "label": "Low Hub NE", "radius": 20},
        {"lbX": 50, "lbY": 120, "tier": 1, "label": "Low Hub E", "radius": 20},
        {"lbX": 30, "lbY": 60, "tier": 1, "label": "Low Hub S", "radius": 20},
        {"lbX": 30, "lbY": 220, "tier": 1, "label": "Low Hub NW", "radius": 20},

        # Medium hubs (Tier 2)
        {"lbX": 70, "lbY": 180, "tier": 2, "label": "Medium Hub N", "radius": 20},
        {"lbX": 65, "lbY": 80, "tier": 2, "label": "Medium Hub SE", "radius": 20},
        {"lbX": 50, "lbY": 50, "tier": 2, "label": "Medium Hub S", "radius": 20},

        # Hard zones (Tier 3)
        {"lbX": 90, "lbY": 150, "tier": 3, "label": "Hard Zone Central", "radius": 25},
        {"lbX": 80, "lbY": 200, "tier": 3, "label": "Hard Zone N", "radius": 20},
        {"lbX": 85, "lbY": 60, "tier": 3, "label": "Hard Zone S", "radius": 20},

        # Elite zones (Tier 4) — deeper interior
        {"lbX": 110, "lbY": 127, "tier": 4, "label": "Elite Zone Central", "radius": 25},
        {"lbX": 100, "lbY": 200, "tier": 4, "label": "Elite Zone N", "radius": 20},

        # Legendary (Tier 5) — world center and far corners
        {"lbX": 127, "lbY": 127, "tier": 5, "label": "Legendary Center", "radius": 20},
    ]

    # Build gradient using distance-weighted blending from anchors
    grid = [[5] * GRID_SIZE for _ in range(GRID_SIZE)]  # default to highest tier

    # For each cell, compute the tier based on the nearest anchor influence
    for y in range(GRID_SIZE):
        for x in range(GRID_SIZE):
            weighted_tier = 0.0
            total_weight = 0.0

            for anchor in anchors:
                dx = x - anchor["lbX"]
                dy = y - anchor["lbY"]
                dist = math.sqrt(dx*dx + dy*dy)
                radius = anchor["radius"]

                # Gaussian-like influence
                if dist < radius * 3:
                    weight = math.exp(-(dist / radius) ** 2)
                    weighted_tier += anchor["tier"] * weight
                    total_weight += weight

            if total_weight > 0:
                raw_tier = weighted_tier / total_weight
            else:
                # Default: use distance from edge to determine tier
                # Closer to edge = lower tier
                edge_dist = min(x, y, GRID_SIZE - 1 - x, GRID_SIZE - 1 - y)
                raw_tier = min(5, edge_dist / 20)

            grid[y][x] = max(0, min(5, round(raw_tier)))

    # Count distribution
    tier_count = {}
    for row in grid:
        for cell in row:
            tier_count[cell] = tier_count.get(cell, 0) + 1

    tier_names = ["Starter", "Low", "Medium", "Hard", "Elite", "Legendary"]
    tier_dist = {}
    total = GRID_SIZE * GRID_SIZE
    for t in range(6):
        count = tier_count.get(t, 0)
        tier_dist[tier_names[t]] = count
        pct = count / total * 100
        print(f"  Tier {t} ({tier_names[t]:12s}): {count:>6} cells ({pct:>5.1f}%)")

    # Save
    gradient = {
        "description": "Balanced difficulty gradient for Vanquish world population",
        "grid_size": GRID_SIZE,
        "tier_names": tier_names,
        "tier_distribution": tier_dist,
        "anchors": [{"lbX": a["lbX"], "lbY": a["lbY"], "tier": a["tier"], "label": a["label"]} for a in anchors],
        "zone_widths": {"Starter": 25, "Low": 20, "Medium": 20, "Hard": 25, "Elite": 25, "Legendary": 20},
        "grid": grid
    }

    with open(GRADIENT_PATH, 'w') as f:
        json.dump(gradient, f, indent=2)

    print(f"\nSaved rebalanced gradient to {GRADIENT_PATH}")
    print(f"Total cells: {total}")

if __name__ == "__main__":
    main()
