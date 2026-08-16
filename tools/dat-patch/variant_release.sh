#!/usr/bin/env bash
# variant_release.sh — one-command environment-VARIANT release run
# (HANDOFF-env-variant-design-2026-08-16 §3; the r5 lane driver).
#
# Prereqs: env_geo.py cluster + variant-build already run under <root>
# (variants.json, variant_imports.jsonl, retargets.jsonl, obj/), and
# <export-dir> staged with the release copies:
#   client_portal.dat  = the PRE-envgeo portal (variants supersede the r4
#                        7-shell pilot — cloning pilot-appended sources would
#                        double-shell; use client_portal.dat.pre-envgeo)
#   client_cell_1.dat  = base cell dat copy
#
# usage: variant_release.sh <root> <export-dir> <version-tag>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:?usage: variant_release.sh <root> <export-dir> <tag>}"
EXPORT="${2:?usage: variant_release.sh <root> <export-dir> <tag>}"
TAG="${3:?usage: variant_release.sh <root> <export-dir> <tag>}"
PORTAL="$EXPORT/client_portal.dat"
CELL="$EXPORT/client_cell_1.dat"
WBT="${WBT:-/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll}"
[ -f "$PORTAL" ] && [ -f "$CELL" ] || { echo "export dir missing dats" >&2; exit 2; }
[ -f "$ROOT/variants.json" ] && [ -f "$ROOT/retargets.jsonl" ] \
    || { echo "root missing variants.json/retargets.jsonl (run cluster + variant-build)" >&2; exit 2; }

echo "== prep portal free arena (clones+appends grow the dat; DRW allocator workaround) =="
# clone bytes measured ~45 MB at top=1000 — 128k blocks (128 MiB) is 2.5x slack
python3 - "$PORTAL" <<'EOF'
import sys
sys.path.insert(0, "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch")
import texture_lane
texture_lane.prep_dat(sys.argv[1], 131072)
EOF

echo "== variant-apply (environment-clone -> append-geometry -> envcell-retarget) =="
python3 "$HERE/env_geo.py" variant-apply --root "$ROOT" \
    --patched-portal "$PORTAL" --patched-cell "$CELL" --wbt "$WBT"

echo "== fixup both dats (mandatory after every DRW write run) =="
python3 - "$PORTAL" "$CELL" <<'EOF'
import sys
sys.path.insert(0, "/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch")
import texture_lane
texture_lane.fixup_dat(sys.argv[1])
texture_lane.fixup_dat(sys.argv[2])
EOF

echo "== variant_verify (strict parses, source-prefix match, retargets landed, LB list) =="
python3 "$HERE/variant_verify.py" --root "$ROOT" --portal "$PORTAL" --cell "$CELL"

echo "== cell-portal-graph-sweep over affected LBs =="
python3 - "$ROOT" "$CELL" "$WBT" <<'EOF'
import json, subprocess, sys
root, cell, wbt = sys.argv[1:4]
lbs = json.load(open(root + "/lbids.json"))["lbIds"]
cmds = []
for i in range(0, len(lbs), 200):
    cmds.append(json.dumps(dict(command="cell-portal-graph-sweep", datPath=cell,
                                lbIds=lbs[i:i + 200])))
p = subprocess.run("DOTNET_ROLL_FORWARD=LatestMajor dotnet %s --stdin" % wbt,
                   shell=True, input=("\n".join(cmds) + "\n").encode(),
                   capture_output=True, timeout=7200)
clean = dirty = 0
for line in p.stdout.decode(errors="replace").splitlines():
    line = line.strip()
    if not (line.startswith("{") and '"cell-portal-graph-sweep"' in line):
        continue
    o = json.loads(line)
    if o.get("success") and o.get("clean"):
        clean += 1
    else:
        dirty += 1
        print("  DIRTY batch:", json.dumps(o)[:400])
print("sweep: %d/%d batches clean over %d LBs" % (clean, clean + dirty, len(lbs)))
sys.exit(1 if dirty else 0)
EOF

echo "== release.sh (polyfix audit, ACE walks, strict walks, package) =="
"$HERE/release.sh" "$EXPORT" "$TAG"
echo "variant release $TAG complete — 1070 in-client gate still mandatory"
