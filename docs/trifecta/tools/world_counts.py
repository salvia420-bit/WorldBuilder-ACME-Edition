#!/usr/bin/env python3
"""Reproduce the world counts used in docs 00 §2, 02 §2 and 06 §3.

Inputs (read-only):
  --dist   the served holtburger dist (default: external/holtburger/dist) with
           world/world_types.u8, world/world_height.u8, world/world_meta.json, world/world_trees.u8, spawns/*.jsonl
  --sql    the ACE world-database release SQL (default: ace_world_release/ACE-World-Database-v0.9.292.sql)

Run from the repository root:  python3 -I docs/trifecta/tools/world_counts.py
Definitions:
  water vertex = terrain type 16..20 or the 0x80 no-record bit; a "majority-land" landblock has >= 41 of 81 land vertices
  outdoor spawn = a dist/spawns row whose cell index is < 0x100 (outdoor cells are 0x01..0x40); indoor = >= 0x100
  authored outdoor content = outdoor rows of weenieType Portal(7), Vendor(12), Door(19), LifeStone(25), SlumLord(55)
  town = authored landblock with a vendor or a lifestone or >= 6 doors
  sanctuary = towns dilated by 1 landblock (Chebyshev) + every other authored landblock itself
"""
import argparse
import collections
import glob
import json
import os
import re
import statistics

W = 2041
WATER = {16, 17, 18, 19, 20}
AUTH = {7: "portal", 12: "vendor", 19: "door", 25: "lifestone", 55: "slumlord"}


def is_water(tt):
    return (tt & 0x1F) in WATER or (tt & 0x80) != 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default="external/holtburger/dist")
    ap.add_argument("--sql", default="ace_world_release/ACE-World-Database-v0.9.292.sql")
    a = ap.parse_args()
    types = open(os.path.join(a.dist, "world/world_types.u8"), "rb").read()
    heights = open(os.path.join(a.dist, "world/world_height.u8"), "rb").read()
    lht = json.load(open(os.path.join(a.dist, "world/world_meta.json")))["landHeightTable"]
    trees = open(os.path.join(a.dist, "world/world_trees.u8"), "rb").read()

    all_land = all_water = mixed = 0
    land_cells = flat_cells = road_cells = total_cells = 0
    majority_land = set()
    for lby in range(255):
        for lbx in range(255):
            nw = sum(is_water(types[(lby * 8 + vy) * W + lbx * 8 + vx]) for vy in range(9) for vx in range(9))
            if nw == 81:
                all_water += 1
            elif nw == 0:
                all_land += 1
            else:
                mixed += 1
            if 81 - nw >= 41:
                majority_land.add((lbx, lby))
            for cy in range(8):
                for cx in range(8):
                    total_cells += 1
                    idx = [(lby * 8 + cy + dy) * W + lbx * 8 + cx + dx for dy in (0, 1) for dx in (0, 1)]
                    if any(is_water(types[i]) for i in idx):
                        continue
                    land_cells += 1
                    hs = [lht[heights[i]] for i in idx]
                    if max(hs) - min(hs) <= 4:
                        flat_cells += 1
                    if any(types[i] & 0x60 for i in idx):
                        road_cells += 1
    print(f"landblocks: all-land {all_land}, coastal {mixed}, all-water {all_water}; majority-land {len(majority_land)}")
    print(f"cells: total {total_cells}, land {land_cells} ({land_cells / total_cells:.1%}, ~{land_cells * 576 / 1e6:.0f} km2), "
          f"flat<=4m {flat_cells} ({flat_cells / land_cells:.1%} of land), road-touching {road_cells}")
    print(f"trees: {sum(1 for x in trees if x)} landblocks with tall trees, {sum(trees)} trees")

    n = outdoor = 0
    per = collections.defaultdict(collections.Counter)
    for f in glob.glob(os.path.join(a.dist, "spawns/*.jsonl")):
        for line in open(f):
            d = json.loads(line)
            n += 1
            if d.get("cell", 0) < 0x100:
                outdoor += 1
                if d.get("weenieType") in AUTH:
                    lb = d["landblockId"]
                    per[((lb >> 8) & 0xFF, lb & 0xFF)][AUTH[d["weenieType"]]] += 1
    print(f"spawns: {n} rows, outdoor {outdoor}, indoor {n - outdoor} ({(n - outdoor) / max(1, n):.1%})")
    authored = set(per)
    towns = {k for k, c in per.items() if c["vendor"] or c["lifestone"] or c["door"] >= 6}
    housing = {k for k, c in per.items() if c["slumlord"]}
    sanct = set(authored)
    for (x, y) in towns:
        sanct |= {(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    sanct &= majority_land
    frontier = majority_land - sanct
    print(f"authored outdoor landblocks {len(authored)}, towns {len(towns)}, housing {len(housing)}; "
          f"sanctuary {len(sanct)}, frontier {len(frontier)} (~{len(frontier) * 0.192 * 0.192:.0f} km2)")

    if os.path.exists(a.sql):
        per_lb = collections.Counter()
        for line in open(a.sql, encoding="utf-8", errors="replace"):
            if line.startswith("INSERT INTO `encounter`"):
                for m in re.finditer(r"\((\d+),(\d+),(\d+),(\d+),(\d+),", line):
                    per_lb[int(m.group(2))] += 1
        v = sorted(per_lb.values())
        print(f"encounters: {sum(v)} in {len(v)} landblocks, median {statistics.median(v)}, p90 {v[int(len(v) * .9)]}, max {v[-1]}")


if __name__ == "__main__":
    main()
