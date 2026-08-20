#!/usr/bin/env bash
# build_r9_highres.sh -- land the Phase-4 coverage fill into a new client_highres.dat.
#
# The fill is purely ADDITIVE to the highres dat (the client prefers highres over
# the portal), so the r8 portal ships unchanged and nothing is ever deleted:
# no re-split, no reconstruction, no TryDelete.
#
# stages: copy r8 highres -> WBT DXT imports (allowCreate) -> palette inserts ->
#         compress -> walk -> dims ledger vs r8 -> size guard
set -euo pipefail
FILL="${FILL:-/mnt/wbterminal2/fill-2026-08-20}"
REPO="${REPO:-/home/wbterminal/WorldBuilder-ACME-Edition}"
TOOLS="$REPO/tools/dat-patch"
WBT="${WBT:-$REPO/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll}"
R8HR="${R8HR:-/mnt/wbterminal2/dat-patch-r8/kit/acme-r8/client_highres.dat}"
OUT="${OUT:-$FILL/r9}"
GUARD="${GUARD:-2040000000}"
export DOTNET_ROLL_FORWARD=LatestMajor
mkdir -p "$OUT"
HR="$OUT/client_highres.dat"

log(){ echo "[$(date -u '+%H:%M:%S')] $*"; }
guard(){ sz=$(stat -c%s "$HR"); log "highres size: $sz ($(numfmt --to=iec $sz))"
         [ "$sz" -lt "$GUARD" ] || { log "CEILING GUARD TRIPPED ($sz >= $GUARD)"; exit 9; }; }

log "== copy r8 highres =="
cp -f "$R8HR" "$HR"
guard

# Compress FIRST: the r8 highres carries its 1,283 lane records uncompressed, and
# compressing them frees interior blocks that the new records can then reuse
# instead of extending the file. (Compressed records are already proven live —
# the r8 "ours" records ship compressed and passed the in-client gate, and the
# dat-version-preserve patch is in the shipping exe.)
log "== compress pass 1 (existing records) =="
dotnet "$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll" "$HR" --verify 2>&1 | tail -3
guard

log "== DXT imports (WBT render-surface-import, allowCreate) =="
python3 - "$HR" "$WBT" "$@" <<'PY'
import json, os, subprocess, sys
hr, wbt = sys.argv[1], sys.argv[2]
roots = sys.argv[3:]
imports = []
for r in roots:
    m = json.load(open(os.path.join(r, 'fill-manifest.json')))
    imports += m['imports']
print(f"DXT imports: {len(imports)}")
CH = 400
written = failed = 0
for i in range(0, len(imports), CH):
    chunk = imports[i:i+CH]
    cmd = dict(command="render-surface-import", datPath=hr, allowCreate=True, imports=chunk)
    p = subprocess.run(["dotnet", wbt, "--stdin"], input=json.dumps(cmd) + "\n",
                       capture_output=True, text=True, timeout=3600)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    res = next((o for o in out if o.get("command") == "render-surface-import"), None)
    if not res or not res.get("success"):
        print("CHUNK FAILED:", (p.stdout or p.stderr)[-400:]); sys.exit(1)
    written += res.get("writtenCount", 0); failed += res.get("failCount", 0)
    print(f"  {i+len(chunk)}/{len(imports)}  written={written} failed={failed}", flush=True)
print(f"DXT import done: written={written} failed={failed}")
if failed: sys.exit(1)
PY
guard

# WBT writes imported records UNCOMPRESSED. On a full coverage fill that is
# ~1 GB of raw DXT, which would push the file past the 2 GiB HARD ceiling before
# the final compress could reclaim it. So compress between the two write stages,
# not just at the end. (Found the hard way on the first r9 build: projected
# 2,219 MB at the insert stage against a 2,147 MB ceiling.)
log "== compress pass 2 (the DXT records just imported) =="
dotnet "$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll" "$HR" --verify 2>&1 | tail -3
guard

log "== palette inserts (DatRecordInsert) =="
python3 - "$OUT/palette-manifest.json" "$@" <<'PY'
import json, os, sys
out = sys.argv[1]; roots = sys.argv[2:]
ins = []
for r in roots:
    ins += json.load(open(os.path.join(r, 'fill-manifest.json')))['inserts']
json.dump(dict(inserts=ins), open(out, 'w'))
print(f"palette inserts: {len(ins)}")
PY
dotnet "$TOOLS/DatRecordInsert/bin/Release/net8.0/DatRecordInsert.dll" "$HR" "$OUT/palette-manifest.json" | tail -3
guard

log "== compress pass 3 (the palette records just inserted) =="
dotnet "$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll" "$HR" --verify 2>&1 | tail -3
guard

log "== walk_check =="
python3 "$TOOLS/walk_check.py" "$HR"

log "== dims ledger vs the r8 highres (no downscales, no format changes) =="
python3 "$TOOLS/dims_ledger.py" "$HR" --previous "$R8HR" --json "$OUT/dims-ledger-r9.json" --gate || {
  log "DIMS LEDGER TRIPWIRE FAILED"; exit 7; }

log "DONE -> $HR"
stat -c '%s %n' "$HR"
