#!/usr/bin/env python3
"""variant_verify.py -- post-apply structural verification for the
environment-VARIANT lane (HANDOFF-env-variant-design-2026-08-16 step 5).

Run AFTER env_geo.py variant-apply AND texture_lane.fixup_dat on BOTH dats
(datlib refuses DRW-tainted b-trees, which is itself a useful tripwire).

Checks, per release copy pair (portal P, cell C):
  1. every minted variant env strict-parses (datlib.parse_environment) and its
     non-appended prefix matches the SOURCE record parsed from the base portal
     (same cellstruct keys; physics poly + portal counts identical per struct);
  2. every retargets.jsonl row landed: parse_envcell(cell).env == variant, and
     the cell's surface array covers the variant cellstruct's max pos index
     (drawn polys, appended shell included);
  3. no cell OUTSIDE retargets.jsonl points at a variant id;
  4. emits affected-LB list -> lbids.json for the cell-portal-graph-sweep and
     validate-dungeon batches.

usage: variant_verify.py --root R --portal P --cell C [--base-portal B]
exit 0 = all clean; 1 = findings (printed + verify_report.json).
"""
import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE_PORTAL = "/home/wbterminal/ac_base_dats/client_portal.dat"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--portal", required=True)
    ap.add_argument("--cell", required=True)
    ap.add_argument("--base-portal", default=BASE_PORTAL)
    a = ap.parse_args()

    import datlib
    pdat = datlib.Dat(a.portal)
    bdat = datlib.Dat(a.base_portal)
    cdat = datlib.Dat(a.cell)

    variants = json.load(open(os.path.join(a.root, "variants.json")))["variants"]
    retargets = {}
    with open(os.path.join(a.root, "retargets.jsonl")) as f:
        for line in f:
            j = json.loads(line)
            retargets[int(j["cellIdHex"], 16)] = int(j["environmentIdHex"], 16)

    findings = []

    # -- 1. minted envs: strict parse + source-prefix match ------------------
    variant16 = set()
    max_pos = {}          # (env16, cs) -> max drawn pos index (appended incl.)
    built = {int(v["newEnvIdHex"], 16): v for v in variants
             if int(v["newEnvIdHex"], 16) in pdat.files}
    for vid, v in sorted(built.items()):
        variant16.add(vid & 0xFFFF)
        src_id = int(v["sourceIdHex"], 16) if "sourceIdHex" in v else int(v["sourceEnvIdHex"], 16)
        try:
            _, cells = datlib.parse_environment(pdat.get(vid), strict=True)
        except Exception as e:
            findings.append(dict(kind="variant-parse", env="0x%08X" % vid, err=str(e)))
            continue
        _, scells = datlib.parse_environment(bdat.get(src_id), strict=True)
        if set(cells) != set(scells):
            findings.append(dict(kind="cellstruct-keys", env="0x%08X" % vid,
                                 err="clone %s vs source %s" % (sorted(cells), sorted(scells))))
            continue
        for k, c in cells.items():
            s = scells[k]
            if len(c["phys"]) != len(s["phys"]) or c["portals"] != s["portals"]:
                findings.append(dict(kind="physics-drift", env="0x%08X" % vid, cs=k,
                                     err="phys %d->%d portals %s->%s" % (
                                         len(s["phys"]), len(c["phys"]),
                                         s["portals"], c["portals"])))
            if len(c["polys"]) < len(s["polys"]):
                findings.append(dict(kind="drawn-shrank", env="0x%08X" % vid, cs=k,
                                     err="%d -> %d" % (len(s["polys"]), len(c["polys"]))))
            max_pos[(vid & 0xFFFF, k)] = max([p["pos"] for p in c["polys"]] + [-1])

    # A variant absent from the portal is only a finding if something needs it:
    # variant-build records legitimate skips (e.g. "no carveable polys") in
    # variant_build_stats.json, and a skipped variant that no retargets.jsonl
    # row references was never applied — waive it (r5: 4 such, all benign).
    known_failed = set()
    stats_path = os.path.join(a.root, "variant_build_stats.json")
    if os.path.exists(stats_path):
        known_failed = {int(s["newEnvIdHex"], 16)
                        for s in json.load(open(stats_path)) if not s.get("ok")}
    referenced16 = {v & 0xFFFF for v in retargets.values()}
    missing_built = []
    waived_missing = []
    for v in variants:
        vid = int(v["newEnvIdHex"], 16)
        if vid in pdat.files:
            continue
        if vid in known_failed and (vid & 0xFFFF) not in referenced16:
            waived_missing.append(v["newEnvIdHex"])
        else:
            missing_built.append(v["newEnvIdHex"])
    if waived_missing:
        print("  waived %d unreferenced known-failed variant(s): %s"
              % (len(waived_missing), ",".join(waived_missing[:10])))
    if missing_built:
        findings.append(dict(kind="variant-missing", count=len(missing_built),
                             err=",".join(missing_built[:10])))

    # -- 2/3. retargets landed; nothing extra points at a variant ------------
    lbs = set()
    landed = mismatched = 0
    for oid in cdat.files:
        if not (0x100 <= (oid & 0xFFFF) <= 0xFFFD):
            continue
        raw = cdat.get(oid)
        ns = raw[12]
        env16, cs = struct.unpack_from("<2H", raw, 16 + 2 * ns)
        want = retargets.get(oid)
        if want is not None:
            lbs.add(oid >> 16)
            if env16 != (want & 0xFFFF):
                mismatched += 1
                if mismatched <= 10:
                    findings.append(dict(kind="retarget-miss", cell="0x%08X" % oid,
                                         err="env 0x%04X want 0x%04X" % (env16, want)))
            else:
                landed += 1
                mp = max_pos.get((env16, cs))
                if mp is None:
                    findings.append(dict(kind="retarget-no-variant", cell="0x%08X" % oid,
                                         err="env 0x%04X cs %d not among built variants" % (env16, cs)))
                elif mp >= ns:
                    findings.append(dict(kind="surface-bounds", cell="0x%08X" % oid,
                                         err="variant pos %d >= nsurf %d" % (mp, ns)))
        elif env16 in variant16:
            findings.append(dict(kind="stray-variant-ref", cell="0x%08X" % oid,
                                 err="points at variant 0x%04X without a retarget row" % env16))
    if mismatched > 10:
        findings.append(dict(kind="retarget-miss", count=mismatched))

    # -- 4. affected-LB list for the sweep/validate batches ------------------
    json.dump(dict(lbIds=["0x%04X" % lb for lb in sorted(lbs)]),
              open(os.path.join(a.root, "lbids.json"), "w"), indent=1)

    report = dict(variants=len(variants), built=len(built),
                  retargetRows=len(retargets), landed=landed,
                  affectedLbs=len(lbs), findings=findings)
    json.dump(report, open(os.path.join(a.root, "verify_report.json"), "w"), indent=1)
    print("verify: %d/%d variants built+parsed, %d/%d retargets landed, %d LBs -> lbids.json"
          % (len(built), len(variants), landed, len(retargets), len(lbs)))
    if findings:
        for f_ in findings[:15]:
            print("  FINDING", f_)
        print("verify: %d findings -> verify_report.json" % len(findings))
        return 1
    print("verify: CLEAN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
