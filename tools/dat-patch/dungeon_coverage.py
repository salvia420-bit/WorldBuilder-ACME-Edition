#!/usr/bin/env python3
"""dungeon_coverage.py -- Phase-4 coverage census (read-only, no lane run).

Quantifies the UN-BUILT dungeon-geometry coverage: how many indoor EnvCells /
Environments exist in the base dats vs how many the r5 env-variant run covered.
env_geo.py IS the dungeon lane (research 3a); this only measures its headroom.

  * total indoor EnvCells        = cell-dat records 0x____0100..0x____FFFD
  * total dungeon LandBlocks     = distinct (id>>16) among those
  * total Environments (0x0D)    = portal records 0x0D000000..0x0D00FFFF
  * r5 covered wall-cells/LBs    = read from the shipped variants.json stats

Usage:
  DATPATCH_PORTAL=<base portal> DATPATCH_CELL=<base cell> \
  python3 dungeon_coverage.py --variants <r5 variants.json> --out <json>
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datlib

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", default=os.environ.get("DATPATCH_CELL",
                    "/home/wbterminal/ac_base_dats/client_cell_1.dat"))
    ap.add_argument("--portal", default=os.environ.get("DATPATCH_PORTAL",
                    "/home/wbterminal/ac_base_dats/client_portal.dat"))
    ap.add_argument("--variants", required=True)
    ap.add_argument("--creature-candidates", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cd = datlib.Dat(args.cell)
    envcells = [i for i in cd.files if 0x0100 <= (i & 0xFFFF) <= 0xFFFD]
    dungeon_lbs = sorted(set(i >> 16 for i in envcells))
    # landblock 0x____FFFE = LandBlockInfo (outdoor). Indoor LBs are those that
    # own at least one EnvCell.
    pd = datlib.Dat(args.portal)
    envs = [i for i in pd.files if (i >> 24) == 0x0D]
    retail_envs = [i for i in envs if i <= 0x0D00FFFF]

    vj = json.load(open(args.variants))
    st = vj.get("stats", {})

    cov = dict(
        totalIndoorEnvCells=len(envcells),
        totalDungeonLandBlocks=len(dungeon_lbs),
        totalEnvironments0D=len(envs),
        retailEnvironments0D=len(retail_envs),
        r5=dict(
            wallEligibleCells=st.get("wallCells"),
            coveredWallCells=st.get("coveredWallCells"),
            uncoveredWallCells=(st.get("wallCells", 0) - st.get("coveredWallCells", 0)),
            wallSurfaceIds=st.get("wallSids"),
            distinctWallSlotSigs=st.get("distinctSigs"),
            clustersRaw=st.get("clustersRaw"),
            clustersSurviving=st.get("clustersSurviving"),
            pairsSelected=st.get("pairsSelected"),
            variantsMinted=st.get("variants"),
            retargets=st.get("retargets"),
            lbsTouched=st.get("lbsTouched"),
            lbsFullyCovered=st.get("lbsFullyCovered"),
            params=vj.get("params"),
        ),
    )
    wc = st.get("wallCells", 0) or 1
    cov["derived"] = dict(
        wallCellCoveragePct=round(100.0 * st.get("coveredWallCells", 0) / wc, 2),
        nonWallOrUncoveredCells=len(envcells) - st.get("coveredWallCells", 0),
        nonWallOrUncoveredPct=round(100.0 * (len(envcells) - st.get("coveredWallCells", 0)) / max(len(envcells), 1), 2),
        lbsTouchedButPartial=(st.get("lbsTouched", 0) - st.get("lbsFullyCovered", 0)),
        dungeonLbsNeverTouched=(len(dungeon_lbs) - st.get("lbsTouched", 0)),
        clustersLeftByTopCap=(st.get("clustersSurviving", 0) - st.get("pairsSelected", 0)),
    )
    if args.creature_candidates:
        cj = json.load(open(args.creature_candidates))
        cov["creatures"] = cj["summary"]

    json.dump(cov, open(args.out, "w"), indent=1)
    print(json.dumps(cov, indent=1))

if __name__ == "__main__":
    main()
