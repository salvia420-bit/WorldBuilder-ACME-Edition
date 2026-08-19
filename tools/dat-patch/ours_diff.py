#!/usr/bin/env python3
"""ours_diff.py — enumerate OUR baked 0x06 payload in a release portal by direct
byte-diff against the retail base portal (r8 HIFI split input; PLAN Phase 3.1).

For every 0x06 RenderSurface id in the candidate portal, inflate both copies and
byte-compare against the retail base. Ids that differ (or exist only in the
candidate) are OURS — the set DatHifiSplit moves into client_highres.dat and
deletes from the portal. Writes ours-ids.txt (one 0x-hex id per line) and
ours-summary.json with the re-measured variant-B size math.

usage: ours_diff.py <candidate_portal> <retail_portal> <outdir>
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datlib import Dat


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    cand_path, retail_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)

    cand = Dat(cand_path)
    ret = Dat(retail_path)

    tex = lambda d: sorted(i for i in d.files if 0x06000000 <= i <= 0x06FFFFFF)
    ctex, rtex = tex(cand), tex(ret)
    print(f"candidate 0x06 records: {len(ctex)}  retail: {len(rtex)}", flush=True)

    ours, added, identical = [], [], 0
    stored_ours = 0          # stored (compressed) bytes freed from the portal
    plain_ours = 0           # uncompressed payload size
    for n, oid in enumerate(ctex, 1):
        if n % 2000 == 0:
            print(f"  ... {n}/{len(ctex)}", flush=True)
        stored = cand.files[oid][1]
        if oid not in ret.files:
            added.append(oid)
            ours.append(oid)
            stored_ours += stored
            plain_ours += len(cand.get(oid))
            continue
        a = cand.get(oid)
        if a == ret.get(oid):
            identical += 1
        else:
            ours.append(oid)
            stored_ours += stored
            plain_ours += len(a)

    removed = [i for i in rtex if i not in cand.files]

    with open(f"{out}/ours-ids.txt", "w") as f:
        for oid in ours:
            f.write(f"0x{oid:08X}\n")

    summary = {
        "candidate_portal": cand_path, "retail_portal": retail_path,
        "candidate_tex": len(ctex), "retail_tex": len(rtex),
        "ours_total": len(ours), "ours_added_ids": len(added),
        "retail_identical": identical,
        "retail_ids_missing_from_candidate": len(removed),
        "ours_stored_bytes": stored_ours, "ours_plain_bytes": plain_ours,
    }
    json.dump(summary, open(f"{out}/ours-summary.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
