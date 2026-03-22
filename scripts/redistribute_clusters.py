#!/usr/bin/env python3
"""
Redistribute retail AC clusters evenly across the Vanquish pangea continent.

Uses Voronoi-style placement: divide the continent into N roughly-equal regions
(one per town/settlement), find cluster centroids via k-means-like approach,
then assign each cluster to the nearest centroid with random jitter so it
doesn't look like a perfect grid.

Non-town clusters (hunting, scenery, dungeon_entrance) fill in around towns.

Output: population_output/lb_remap.json
"""

import json, os, sys, random, math, time
import numpy as np
from collections import defaultdict
from typing import Dict, List, Tuple, Set

# ── Paths ──
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
ENVCELL_GRID = os.path.join(ROOT, "pipeline_data", "data", "envcell_grid.npy")
OUTPUT_DIR = os.path.join(ROOT, "pipeline_data", "population_output")
OUTPUT_JSON = os.path.join(OUTPUT_DIR, "lb_remap.json")

# Import cluster_shuffle_populate for parsing
sys.path.insert(0, SCRIPT_DIR)
import cluster_shuffle_populate as csp


def load_land_mask() -> Set[Tuple[int, int]]:
    """
    In the Vanquish world, V3 terrain generation filled the entire 255x255 grid
    with valid terrain. All landblocks are walkable land.
    We keep a 2-LB margin from edges to avoid boundary issues.
    """
    land = set()
    for x in range(2, 253):
        for y in range(2, 253):
            land.add((x, y))
    print(f"    Land LBs: {len(land)} (full grid minus 2-LB edge margin)")
    return land


def find_continent(land: Set[Tuple[int, int]]) -> Set[Tuple[int, int]]:
    """Find the largest connected component (the main continent)."""
    from collections import deque
    visited: Set[Tuple[int, int]] = set()
    best = []

    for lb in land:
        if lb in visited:
            continue
        comp = []
        q = deque([lb])
        while q:
            cur = q.popleft()
            if cur in visited:
                continue
            visited.add(cur)
            comp.append(cur)
            cx, cy = cur
            for dx in [-1, 0, 1]:
                for dy in [-1, 0, 1]:
                    if dx == 0 and dy == 0:
                        continue
                    n = (cx + dx, cy + dy)
                    if n in land and n not in visited:
                        q.append(n)
        if len(comp) > len(best):
            best = comp

    return set(best)


def generate_even_points(continent: Set[Tuple[int, int]], n_points: int,
                         seed: int = 42, jitter_pct: float = 0.15) -> List[Tuple[int, int]]:
    """
    Generate n_points evenly distributed across the continent.
    
    Uses a jittered grid approach:
    1. Compute bounding box of continent
    2. Create a grid with ~n_points cells
    3. For each cell that overlaps the continent, place a point at the center
       with random jitter
    4. If we have too many/few, adjust
    """
    rng = random.Random(seed)

    xs = [p[0] for p in continent]
    ys = [p[1] for p in continent]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    width = max_x - min_x + 1
    height = max_y - min_y + 1

    # Calculate grid dimensions to get ~n_points cells
    area = width * height
    cell_size = math.sqrt(area / n_points)
    cols = max(1, int(width / cell_size))
    rows = max(1, int(height / cell_size))

    # Adjust to get closer to n_points
    while cols * rows < n_points * 0.8:
        cell_size *= 0.95
        cols = max(1, int(width / cell_size))
        rows = max(1, int(height / cell_size))

    cell_w = width / cols
    cell_h = height / rows

    points = []
    for r in range(rows):
        for c in range(cols):
            # Center of cell with jitter
            cx = min_x + (c + 0.5) * cell_w
            cy = min_y + (r + 0.5) * cell_h

            # Add jitter (fraction of cell size)
            jx = rng.uniform(-jitter_pct, jitter_pct) * cell_w
            jy = rng.uniform(-jitter_pct, jitter_pct) * cell_h
            px = int(cx + jx)
            py = int(cy + jy)

            # Clamp to bounds
            px = max(min_x + 2, min(max_x - 2, px))
            py = max(min_y + 2, min(max_y - 2, py))

            # Only keep if it's on land
            if (px, py) in continent:
                points.append((px, py))

    # If too many, randomly sample down
    if len(points) > n_points:
        rng.shuffle(points)
        points = points[:n_points]

    return points


def assign_clusters_to_points(
    clusters: List[csp.Cluster],
    anchor_points: List[Tuple[int, int]],
    continent: Set[Tuple[int, int]],
    seed: int = 42
) -> None:
    """
    Assign each cluster to a placement point.
    
    Towns get first pick of anchor points (closest match).
    Other clusters fill in around their assigned anchor.
    """
    rng = random.Random(seed)

    # Separate by classification
    towns = [c for c in clusters if c.classification in ("town", "settlement")]
    others = [c for c in clusters if c.classification not in ("town", "settlement")]

    # Sort towns by size (larger towns get priority)
    towns.sort(key=lambda c: c.instance_count, reverse=True)

    # Available anchor points
    available = list(anchor_points)
    rng.shuffle(available)

    # Track occupied landblocks
    occupied: Set[Tuple[int, int]] = set()

    def try_place(cluster: csp.Cluster, target_x: int, target_y: int) -> bool:
        """Try to place cluster centered at (target_x, target_y)."""
        if not cluster.landblocks:
            return False

        lbs = sorted(cluster.landblocks)
        # Cluster's own center
        src_cx = sum(lb[0] for lb in lbs) / len(lbs)
        src_cy = sum(lb[1] for lb in lbs) / len(lbs)

        # Offset to move cluster center to target
        off_x = int(target_x - src_cx)
        off_y = int(target_y - src_cy)

        # Check all destination LBs
        dest_lbs = set()
        for lb in lbs:
            dx, dy = lb[0] + off_x, lb[1] + off_y
            if dx < 1 or dx > 253 or dy < 1 or dy > 253:
                return False
            if (dx, dy) not in continent:
                return False
            if (dx, dy) in occupied:
                return False
            dest_lbs.add((dx, dy))

        # Place it
        cluster.target_offset_x = off_x
        cluster.target_offset_y = off_y
        occupied.update(dest_lbs)
        return True

    # ── Place towns at anchor points ──
    placed_towns = 0
    unplaced_towns = []
    used_anchors = set()

    for town in towns:
        # Find closest available anchor
        best_dist = float("inf")
        best_anchor = None
        best_idx = -1

        for i, ap in enumerate(available):
            if i in used_anchors:
                continue
            dist = math.sqrt((ap[0] - town.center_lb[0]) ** 2 +
                             (ap[1] - town.center_lb[1]) ** 2)
            if dist < best_dist:
                best_dist = dist
                best_anchor = ap
                best_idx = i

        if best_anchor is not None:
            if try_place(town, best_anchor[0], best_anchor[1]):
                used_anchors.add(best_idx)
                placed_towns += 1
                continue
            # Try nearby positions with spiral search
            placed_nearby = False
            for radius in range(1, 15):
                for ddx in range(-radius, radius + 1):
                    for ddy in range(-radius, radius + 1):
                        if abs(ddx) != radius and abs(ddy) != radius:
                            continue
                        nx, ny = best_anchor[0] + ddx, best_anchor[1] + ddy
                        if try_place(town, nx, ny):
                            used_anchors.add(best_idx)
                            placed_towns += 1
                            placed_nearby = True
                            break
                    if placed_nearby:
                        break
                if placed_nearby:
                    break
            if not placed_nearby:
                unplaced_towns.append(town)
        else:
            unplaced_towns.append(town)

    print(f"    Towns placed: {placed_towns}, unplaced: {len(unplaced_towns)}")

    # ── Place remaining clusters (others + unplaced towns) ──
    # Spread evenly across the continent, avoiding occupied areas
    all_remaining = unplaced_towns + others
    rng.shuffle(all_remaining)

    placed_other = 0
    failed_other = 0

    for cluster in all_remaining:
        if not cluster.landblocks:
            cluster.target_offset_x = 0
            cluster.target_offset_y = 0
            continue

        # Try random locations on the continent
        placed_ok = False
        candidates = list(continent - occupied)
        if not candidates:
            failed_other += 1
            cluster.target_offset_x = 0
            cluster.target_offset_y = 0
            continue

        # Sample 200 random candidates and pick the one farthest from occupied
        sample = rng.sample(candidates, min(200, len(candidates)))
        for sx, sy in sample:
            if try_place(cluster, sx, sy):
                placed_other += 1
                placed_ok = True
                break

        if not placed_ok:
            # Fallback: just offset to avoid overlap
            for sx, sy in candidates[:500]:
                if try_place(cluster, sx, sy):
                    placed_other += 1
                    placed_ok = True
                    break

        if not placed_ok:
            failed_other += 1
            cluster.target_offset_x = 0
            cluster.target_offset_y = 0

    print(f"    Other clusters placed: {placed_other}, failed: {failed_other}")


def main():
    print("=" * 70)
    print("  Redistribute Clusters Across Vanquish Continent")
    print("=" * 70)
    print()

    # Step 0: Load weenie types
    wcid_types = csp.load_wcid_types()
    print()

    # Step 1: Parse retail SQL
    print("[Step 1] Parsing retail SQL...")
    instances_by_lb, links = csp.parse_retail_sql(csp.RETAIL_SQL)
    interior_instances = instances_by_lb.pop((-1, -1), [])
    print()

    # Step 2: Detect & classify clusters
    print("[Step 2] Detecting clusters...")
    clusters = csp.find_clusters(instances_by_lb)
    print()

    print("[Step 3] Classifying clusters...")
    csp.classify_clusters(clusters, wcid_types)
    print()

    # Step 3: Load terrain
    print("[Step 4] Loading Vanquish terrain...")
    land = load_land_mask()
    continent = find_continent(land)
    print(f"    Main continent: {len(continent)} landblocks")
    print()

    # Count towns
    towns = [c for c in clusters if c.classification in ("town", "settlement")]
    other = [c for c in clusters if c.classification not in ("town", "settlement")]
    print(f"    Towns/settlements: {len(towns)}")
    print(f"    Other clusters: {len(other)}")
    print()

    # Step 4: Generate anchor points for towns
    n_anchors = max(len(towns), 50)  # at least 50 anchor points
    print(f"[Step 5] Generating {n_anchors} anchor points...")
    anchor_points = generate_even_points(continent, n_anchors, seed=2026, jitter_pct=0.20)
    print(f"    Generated {len(anchor_points)} valid anchor points")
    print()

    # Step 5: Assign clusters to anchor points
    print("[Step 6] Assigning clusters to anchor points...")
    assign_clusters_to_points(clusters, anchor_points, continent, seed=2026)
    print()

    # Step 6: Build lb_remap
    print("[Step 7] Building lb_remap...")
    lb_remap = csp.build_lb_remap(clusters)
    print(f"    LB remap entries: {len(lb_remap)}")

    # Verify distribution
    dest_lbs = [(v[0], v[1]) for v in lb_remap.values()]
    if dest_lbs:
        xs = [p[0] for p in dest_lbs]
        ys = [p[1] for p in dest_lbs]
        print(f"    Dest X range: {min(xs)}-{max(xs)} (spread: {max(xs)-min(xs)})")
        print(f"    Dest Y range: {min(ys)}-{max(ys)} (spread: {max(ys)-min(ys)})")
    print()

    # Step 7: Save
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    remap_dict = {f"{ox},{oy}": f"{vx},{vy}" for (ox, oy), (vx, vy) in lb_remap.items()}
    with open(OUTPUT_JSON, "w") as f:
        json.dump(remap_dict, f)
    print(f"    Saved to {OUTPUT_JSON}")

    # Also save cluster report
    report_path = os.path.join(OUTPUT_DIR, "cluster_report.json")
    csp.save_cluster_report(clusters, report_path, wcid_types)
    print()

    # Summary
    print("=" * 70)
    print("  Summary")
    print("=" * 70)
    print(f"  Clusters: {len(clusters)}")
    print(f"  LB remap entries: {len(lb_remap)}")
    print(f"  Output: {OUTPUT_JSON}")
    print()
    print("  Next: re-run the building remap pipeline (Stage 1-4)")
    print()


if __name__ == "__main__":
    main()
