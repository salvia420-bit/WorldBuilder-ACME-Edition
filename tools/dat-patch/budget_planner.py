#!/usr/bin/env python3
"""budget_planner.py -- headroom-aware budget knobs for the dat patcher.

The client's DAT ceiling is a hard 2 GiB per file (bit 31 of every block offset
is the free-block flag and DiskDev::SyncRead seeks signed-32; overflow FAILS
SILENTLY -- see docs/dat-patch/reports/client-headroom-dossier.md).  Server
operators run CUSTOM dats of unknown size (+30 MB or +300 MB over base), so the
patcher must never assume base sizes: this planner MEASURES the target dat set
and turns "how much can we add" into knobs.

    budget = ceiling - measured_size - reserve

Knobs (all overridable; defaults are the project's shipping recipe):
  --dats DIR            target dat set to measure (REQUIRED; point at the
                        server's actual dats, never assume base)
  --ceiling-mb 2000     hard per-file ceiling. 2000 MiB leaves ~48 MiB of
                        structural margin under the signed-int32 wall for
                        block alignment and directory growth.
  --reserve-mb 300      headroom left untouched for the operator's own future
                        content.  Raise for servers that patch aggressively.
  --tris N              planned added triangles (geometry lane), costed at
  --bytes-per-tri 106   the pilot's measured ~106 B/added-tri.
  --compression-factor 1.0
                        set ~0.50 for portal.dat if the trevis zlib patch is
                        shipped (measured 49.97% portal saving; cell_1 only
                        compresses 10.8% -- keep 1.0 there).  Applied to the
                        ADDED bytes only; conservative by design.
  --texture-tiers 1024,512,256
                        candidate max texture sides, best first.  The planner
                        recommends the best tier whose estimated corpus cost
                        fits the remaining budget.
  --texture-count N     number of textures the texture lane will re-encode
                        (default 2931 = the Remacri statics corpus).

Texture tier cost model: DXT1 = side*side/2 bytes + 1/3 for mips; DXT5 doubles.
We assume the corpus splits ~80% DXT1 / 20% DXT5 (opaque vs alpha) -- override
with --dxt5-share.  This is an ESTIMATE for planning; the encoder reports real
bytes and the plan is re-checked at import time (the importer refuses to write
past the ceiling regardless).

Output: plan.json (stdout summary + --out FILE) consumed by the tranche runner.
"""
import argparse
import json
import os
import sys

MIB = 1024 * 1024
DAT_NAMES = ("client_portal.dat", "client_cell_1.dat", "client_highres.dat",
             "client_local_English.dat")


def tier_cost_bytes(side, count, dxt5_share):
    dxt1 = side * side // 2
    per = dxt1 * (1.0 + dxt5_share)          # dxt5 = 2x dxt1
    per *= 4.0 / 3.0                          # mip chain
    return int(per * count)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dats", required=True)
    ap.add_argument("--ceiling-mb", type=float, default=2000.0)
    ap.add_argument("--reserve-mb", type=float, default=300.0)
    ap.add_argument("--tris", type=int, default=0)
    ap.add_argument("--bytes-per-tri", type=float, default=106.0)
    ap.add_argument("--compression-factor", type=float, default=1.0)
    ap.add_argument("--texture-tiers", default="1024,512,256")
    ap.add_argument("--texture-count", type=int, default=2931)
    ap.add_argument("--dxt5-share", type=float, default=0.20)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    ceiling = int(a.ceiling_mb * MIB)
    reserve = int(a.reserve_mb * MIB)
    plan = {"knobs": vars(a).copy(), "dats": {}, "portal": None}

    found = False
    for name in DAT_NAMES:
        p = os.path.join(a.dats, name)
        if not os.path.exists(p):
            continue
        found = True
        size = os.path.getsize(p)
        avail = ceiling - size - reserve
        plan["dats"][name] = {
            "size_bytes": size,
            "size_mib": round(size / MIB, 1),
            "headroom_to_ceiling_mib": round((ceiling - size) / MIB, 1),
            "budget_after_reserve_mib": round(avail / MIB, 1),
            "over_ceiling": size > ceiling,
        }
    if not found:
        sys.exit(f"no known dats in {a.dats} (expected one of {DAT_NAMES})")

    portal = plan["dats"].get("client_portal.dat")
    if portal:
        if portal["over_ceiling"]:
            sys.exit("client_portal.dat already exceeds the ceiling -- refuse")
        budget = int(portal["budget_after_reserve_mib"] * MIB)
        geo = int(a.tris * a.bytes_per_tri * a.compression_factor)
        tex_budget = budget - geo
        chosen = None
        tiers = [int(t) for t in a.texture_tiers.split(",")]
        costs = {}
        for t in tiers:
            c = int(tier_cost_bytes(t, a.texture_count, a.dxt5_share)
                    * a.compression_factor)
            costs[t] = c
            if chosen is None and c <= tex_budget:
                chosen = t
        plan["portal"] = {
            "budget_bytes": budget,
            "geometry_bytes_est": geo,
            "texture_budget_bytes": tex_budget,
            "tier_costs_mib": {t: round(c / MIB, 1) for t, c in costs.items()},
            "recommended_texture_tier": chosen,
            "note": ("no tier fits -- geometry lane alone, or raise ceiling "
                     "via compression patch") if chosen is None else
                    f"ship textures at {chosen}px max side",
        }

    js = json.dumps(plan, indent=2)
    print(js)
    if a.out:
        with open(a.out, "w") as f:
            f.write(js)


if __name__ == "__main__":
    main()
