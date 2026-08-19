#!/usr/bin/env python3
"""dims_ledger.py -- the RESOLUTION TRIPWIRE for a texture take (2026-08-18).

Why this exists
---------------
The r7.1 take-5 build passed every gate it had (walk, colour ledger, degrade
chains, record counts) while silently shipping 711 of its 2,192 rebaked 0x06
RenderSurface records at 4x LOWER resolution than r7: the adopted deblock
corpus (1,630 files, scoped by the block-artifact census) replaced the r7
rewrap corpus (4,041 files), and every lane whose corpus png was missing fell
back to a 1x bake.  `missing-corpus-triage.json` caught 95 of the 711; the
rest regressed without a line of log.  Root-cause:
reports/eyetest-ab-review-2026-08-18.md.

This tool is the missing tripwire, sibling to color_ledger.py: compare every
0x06 record's header (width, height, format) in a CANDIDATE portal against
the PREVIOUS RELEASE portal and fail the take on any downscale or format
change that is not explicitly whitelisted.

Usage
-----
    # gate a packaged candidate against the previous shipped release
    python3 dims_ledger.py CANDIDATE.dat --previous PREVIOUS.dat \
        --json dims-ledger.json --gate

    # allow specific ids to shrink / change format (one hex id per line, # comments)
    ... --allow allow-downscale.txt

Reads the b-tree plus each 0x06 record's header (full-record inflate when the
entry carries IsCompressed — the zlib stream doesn't seek), so a pair of
~1.5 GB portals gates in ~6 minutes on the laptop.

Exit codes: 0 clean (or report-only), 1 gate violation, 2 usage/hard error.
"""
import argparse
import json
import struct
import sys

import datlib


def tex_headers(dat):
    """{id: (w, h, fmt)} for every 0x06 RenderSurface record."""
    out = {}
    for oid in dat.files:
        if (oid >> 24) != 0x06:
            continue
        b = dat.get(oid)
        if b is None or len(b) < 24:
            raise ValueError("0x%08X: short record (%d bytes)" % (oid, 0 if b is None else len(b)))
        _rid, _dc, w, h, fmt = struct.unpack_from("<2I2iI", b, 0)
        out[oid] = (w, h, fmt)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("candidate")
    ap.add_argument("--previous", required=True, help="previous release portal.dat")
    ap.add_argument("--candidate-highres",
                    help="candidate client_highres.dat: overlay its 0x06 headers over "
                         "the candidate portal's (client precedence — CLCache probes "
                         "slot 3 first). REQUIRED to gate an r8 HIFI-split pair, where "
                         "the portal no longer carries the moved records.")
    ap.add_argument("--previous-highres",
                    help="previous release highres, overlaid the same way (r8+ baselines)")
    ap.add_argument("--json", help="write the full ledger here")
    ap.add_argument("--gate", action="store_true", help="exit 1 on violation")
    ap.add_argument("--allow", help="file of hex ids allowed to downscale/reformat")
    args = ap.parse_args()

    allow = set()
    if args.allow:
        for line in open(args.allow):
            line = line.split("#")[0].strip()
            if line:
                allow.add(int(line, 16))

    cand = tex_headers(datlib.Dat(args.candidate))
    if args.candidate_highres:
        cand.update(tex_headers(datlib.Dat(args.candidate_highres)))
    prev = tex_headers(datlib.Dat(args.previous))
    if args.previous_highres:
        prev.update(tex_headers(datlib.Dat(args.previous_highres)))

    downscales, upscales, fmt_changes = [], [], []
    missing = sorted(set(prev) - set(cand))
    added = sorted(set(cand) - set(prev))
    for oid in sorted(set(cand) & set(prev)):
        (wc, hc, fc), (wp, hp, fp) = cand[oid], prev[oid]
        row = dict(id="0x%08X" % oid, prev=[wp, hp], cand=[wc, hc],
                   prevFmt="0x%X" % fp, candFmt="0x%X" % fc,
                   allowed=oid in allow)
        if wc * hc < wp * hp:
            downscales.append(row)
        elif wc * hc > wp * hp:
            upscales.append(row)
        if fc != fp:
            fmt_changes.append(row)

    bad_down = [r for r in downscales if not r["allowed"]]
    bad_fmt = [r for r in fmt_changes if not r["allowed"]]
    bad_missing = [oid for oid in missing if oid not in allow]

    summary = dict(candidate=args.candidate, previous=args.previous,
                   candTextures=len(cand), prevTextures=len(prev),
                   downscales=len(downscales), upscales=len(upscales),
                   formatChanges=len(fmt_changes),
                   missing=["0x%08X" % o for o in missing],
                   added=["0x%08X" % o for o in added],
                   violations=len(bad_down) + len(bad_fmt) + len(bad_missing))
    if args.json:
        json.dump(dict(summary=summary, downscales=downscales,
                       upscales=upscales, formatChanges=fmt_changes),
                  open(args.json, "w"), indent=1)

    print("dims ledger: %d textures vs %d previous | downscales %d "
          "(unallowed %d) | upscales %d | format changes %d (unallowed %d) | "
          "missing %d (unallowed %d) | added %d"
          % (len(cand), len(prev), len(downscales), len(bad_down),
             len(upscales), len(fmt_changes), len(bad_fmt),
             len(missing), len(bad_missing), len(added)))
    for r in bad_down[:20]:
        print("  DOWNSCALE %s %dx%d -> %dx%d"
              % (r["id"], r["prev"][0], r["prev"][1], r["cand"][0], r["cand"][1]))
    if len(bad_down) > 20:
        print("  ... %d more downscales (see --json)" % (len(bad_down) - 20))
    for r in bad_fmt[:10]:
        print("  FORMAT %s %s -> %s" % (r["id"], r["prevFmt"], r["candFmt"]))
    for oid in bad_missing[:10]:
        print("  MISSING 0x%08X" % oid)

    if args.gate and (bad_down or bad_fmt or bad_missing):
        print("DIMS LEDGER GATE: FAIL")
        return 1
    if args.gate:
        print("DIMS LEDGER GATE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
