#!/usr/bin/env python3
"""creature_enum.py -- Phase-4 4.P4 creature-geometry ENUMERATOR (POC).

Creatures have NO cell-dat placement list (tranche's LBInfo walk and env_geo's
EnvCell walk both miss them entirely -- creatures spawn from weenies at runtime,
research-doc geometry-lanes-research.md section 3b).  So this is the one lane
that must start from the WEENIE census rather than a dat placement list.

Pipeline (all read-only, reuses the core lane as a black box):
  1. LSD weenie_summary.jsonl  -> creature weenies (weenieType==10) + setupDid.
  2. LSD spawnMaps/*.json      -> per-wcid spawn-placement count (= exposure
                                  proxy; creatures have no instance count).
  3. setupDid -> part GfxObjs  via pilot.resolve_gfx (datlib.parse_setup).
  4. dedupe part GfxObjs across all creature setups (parts are heavily shared).
  5. per part: tri count (gfxlib), degrade band0-not-self guard (Portal.degrade),
     the set of weenies/setups that use it, summed spawn exposure.
  6. rank deduped GfxObjs by summed exposure -> creature-candidates.json.

Nothing here writes a dat.  DATPATCH_PORTAL must point at a base portal.

Usage:
  DATPATCH_PORTAL=/home/wbterminal/ac_base_dats/client_portal.dat \
  python3 creature_enum.py --out <dir>/creature-candidates.json [--limit-setups N]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datlib          # noqa: E402
import gfxlib          # noqa: E402
import pilot           # noqa: E402
import pipeline        # noqa: E402

LSD = os.environ.get(
    "LSD_ROOT",
    "/home/wbterminal/WorldBuilder-ACME-Edition/external/LSD-Partial-2025-02-23_16-15")
WEENIE_SUMMARY = os.path.join(LSD, "weenie_summary.jsonl")
SPAWNMAPS = os.path.join(LSD, "spawnMaps")

CREATURE_WEENIETYPE = 10


def load_creature_weenies():
    """-> {wcid: {name, setupDid, level, creatureType}} for weenieType==10 rows
    that carry a setupDid.  weenie_summary.jsonl line 1 has a BOM (utf-8-sig)."""
    out = {}
    with open(WEENIE_SUMMARY, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("weenieType") != CREATURE_WEENIETYPE:
                continue
            sd = d.get("setupDid")
            if not sd:
                continue
            out[d["wcid"]] = dict(name=d.get("name"), setupDid=sd,
                                  level=d.get("level"),
                                  creatureType=d.get("creatureType"))
    return out


def load_spawn_exposure():
    """-> {wcid: spawn_placement_count} summed over every spawnMap.  This is the
    exposure proxy that replaces tranche's per-record instance count."""
    exp = {}
    nmaps = 0
    for fn in os.listdir(SPAWNMAPS):
        if not fn.endswith(".json"):
            continue
        try:
            d = json.load(open(os.path.join(SPAWNMAPS, fn), encoding="utf-8-sig"))
        except Exception:
            continue
        nmaps += 1
        for w in (d.get("value") or {}).get("weenies") or []:
            wc = w.get("wcid")
            if wc is not None:
                exp[wc] = exp.get(wc, 0) + 1
    return exp, nmaps


def enumerate_creatures(limit_setups=None):
    P = pipeline.P
    weenies = load_creature_weenies()
    exposure, nmaps = load_spawn_exposure()

    # setupDid -> list of wcids that use it
    setup_wcids = {}
    for wc, w in weenies.items():
        setup_wcids.setdefault(w["setupDid"], []).append(wc)

    setups = sorted(setup_wcids)
    if limit_setups:
        # rank setups by their summed exposure first, so a limited run still
        # takes the highest-exposure ones
        setups.sort(key=lambda sd: -sum(exposure.get(wc, 0)
                                        for wc in setup_wcids[sd]))
        setups = setups[:limit_setups]

    # part GfxObj -> aggregate
    gids = {}
    setup_ok = setup_missing = setup_err = 0
    for sd in setups:
        raw = None
        try:
            raw = P.dat.get(sd)
        except Exception:
            raw = None
        if raw is None:
            setup_missing += 1
            continue
        try:
            parts = pilot.resolve_gfx(sd, P)   # 0x02 -> parts, 0x01 -> [self]
        except Exception:
            setup_err += 1
            continue
        setup_ok += 1
        wcids = setup_wcids[sd]
        setup_exp = sum(exposure.get(wc, 0) for wc in wcids)
        for slot, gid in enumerate(parts):
            e = gids.setdefault(gid, dict(setups=set(), wcids=set(),
                                          exposure=0, slots=set()))
            e["setups"].add(sd)
            e["wcids"].update(wcids)
            e["slots"].add(slot)
    # exposure is summed over the DISTINCT wcids that reference the part (a wcid
    # counted once even if it uses the part in several slots)
    for gid, e in gids.items():
        e["exposure"] = sum(exposure.get(wc, 0) for wc in e["wcids"])

    # per-GfxObj geometry + degrade guard
    rows = []
    n_missing_gfx = n_degrade_defer = n_shared = 0
    for gid, e in gids.items():
        row = dict(gfxObj="0x%08X" % gid,
                   setups=len(e["setups"]),
                   wcids=len(e["wcids"]),
                   exposure=e["exposure"],
                   sharedAcrossSlots=len(e["slots"]) > 1)
        if row["sharedAcrossSlots"]:
            n_shared += 1
        if (gid >> 24) != 0x01:
            row["route"] = "skip-not-gfxobj"
            rows.append(row)
            continue
        try:
            rec = P.gfx(gid)
        except Exception as ex:
            row["route"] = "skip-missing"
            row["why"] = str(ex)[:120]
            n_missing_gfx += 1
            rows.append(row)
            continue
        # drawn tri count = fan-triangulation of non-NoPos polys (matches tranche)
        tris = sum(len(q["v"]) - 2 for q in rec["polys"] if not (q["stip"] & 0x4))
        row["tris"] = tris
        row["parts"] = len(rec["polys"])
        # THE DEGRADE GUARD, per part (research 1c)
        bands = P.degrade(gid)
        row["degradeBands"] = len(bands)
        if bands and bands[0]["id"] != gid:
            row["route"] = "skip-degrade"
            row["why"] = ("degrade band0 is 0x%08X, not self -- client never "
                          "draws the root mesh (dossier 5a)" % bands[0]["id"])
            row["bandObjects"] = ["0x%08X" % b["id"] for b in bands if b["id"]]
            n_degrade_defer += 1
            rows.append(row)
            continue
        row["degradeBand0Self"] = bool(bands)
        row["route"] = "candidate"
        rows.append(row)

    rows.sort(key=lambda r: (-r.get("exposure", 0), -r.get("tris", 0)))
    n_cand = sum(1 for r in rows if r["route"] == "candidate")
    summary = dict(
        creatureWeeniesWithSetup=len(weenies),
        spawnMapsRead=nmaps,
        distinctSetups=len(setup_wcids),
        setupsExamined=len(setups),
        setupsParsed=setup_ok, setupsMissingFromPortal=setup_missing,
        setupsParseError=setup_err,
        distinctPartGfxObjs=len(gids),
        partsMissingFromPortal=n_missing_gfx,
        partsSharedAcrossSlots=n_shared,
        candidates=n_cand,
        degradeDeferred=n_degrade_defer)
    return dict(summary=summary, candidates=rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit-setups", type=int, default=None)
    args = ap.parse_args()
    js = enumerate_creatures(args.limit_setups)
    with open(args.out, "w") as f:
        json.dump(js, f, indent=1)
    s = js["summary"]
    print("[creature_enum] portal:", pipeline.P.path)
    for k, v in s.items():
        print("   %-28s %s" % (k, v))
    print("[creature_enum] wrote", args.out)
    print("[creature_enum] top 10 candidates by exposure:")
    n = 0
    for r in js["candidates"]:
        if r["route"] != "candidate":
            continue
        print("   %s  tris=%-5d exposure=%-5d setups=%-3d wcids=%-3d%s"
              % (r["gfxObj"], r["tris"], r["exposure"], r["setups"],
                 r["wcids"], "  [shared-slot]" if r["sharedAcrossSlots"] else ""))
        n += 1
        if n >= 10:
            break


if __name__ == "__main__":
    main()
