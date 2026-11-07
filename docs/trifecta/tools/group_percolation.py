#!/usr/bin/env python3
"""Estimate how ACE's landblock groups merge as the number of loaded landblocks grows (doc 10, H17; doc 17, R23).

ACE puts loaded landblocks in the same group (= the same thread) when their Chebyshev distance is < 4
(LandblockGroup.LandblockGroupMinSpacing = 4; < 3 when dormant), transitively (Entity/LandblockGroup.cs,
Managers/LandblockManager.cs). This script places N loaded landblocks on land, uniformly or around hubs, and
reports the largest group's share: the fraction of all landblock work that one thread must do.

Run from the repository root:  python3 -I docs/trifecta/tools/group_percolation.py
"""
import argparse
import os
import random
from collections import Counter

W = 2041
WATER = {16, 17, 18, 19, 20}


def land_landblocks(dist):
    t = open(os.path.join(dist, "world/world_types.u8"), "rb").read()
    out = []
    for lby in range(255):
        for lbx in range(255):
            if any(not ((t[(lby * 8 + vy) * W + lbx * 8 + vx] & 0x1F) in WATER or t[(lby * 8 + vy) * W + lbx * 8 + vx] & 0x80)
                   for vy in range(9) for vx in range(9)):
                out.append((lbx, lby))
    return out


def largest_group(points, spacing=4):
    s = set(points)
    parent = {p: p for p in s}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    r = spacing - 1
    for (x, y) in s:
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                q = (x + dx, y + dy)
                if q in s:
                    ra, rb = find((x, y)), find(q)
                    if ra != rb:
                        parent[ra] = rb
    c = Counter(find(p) for p in s)
    return max(c.values()) / len(s), len(c)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default="external/holtburger/dist")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    random.seed(a.seed)
    land = land_landblocks(a.dist)
    landset = set(land)
    print(f"land landblocks: {len(land)}")
    for n in (1000, 2000, 3000, 4000, 5000, 8700):
        share, groups = largest_group(random.sample(land, n))
        print(f"uniform {n:5d}: largest group {share:6.1%} of loaded landblocks, {groups} groups")
    hubs = random.sample(land, 40)
    for n in (2000, 5000, 8700):
        pts = set()
        while len(pts) < n:
            hx, hy = random.choice(hubs)
            p = (int(random.gauss(hx, 6)), int(random.gauss(hy, 6)))
            if p in landset:
                pts.add(p)
        share, groups = largest_group(list(pts))
        print(f"40 hubs (sigma 6 landblocks) {n:5d}: largest group {share:6.1%}, {groups} groups")


if __name__ == "__main__":
    main()
