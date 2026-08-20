#!/usr/bin/env bash
# finish_fill.sh -- DETACHED finisher for the Phase-4 coverage fill (2026-08-20).
#
# Picks up where build_r9_highres.sh's DXT stage ends and carries the release to
# a packaged kit without a session attached. Ordered so the file never crosses
# the 2 GiB hard ceiling: compress the freshly imported (uncompressed) DXT
# records BEFORE inserting the palette records, then compress again.
#
# Run:  setsid nohup tools/dat-patch/finish_fill.sh > <log> 2>&1 &
# Ends by writing RESULTS.md and committing exactly two doc files (never -A).
set -u
FILL=/mnt/wbterminal2/fill-2026-08-20
REPO=/home/wbterminal/WorldBuilder-ACME-Edition
TOOLS="$REPO/tools/dat-patch"
WBT="$REPO/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll"
R8KIT=/mnt/wbterminal2/dat-patch-r8/kit/acme-r8
HR="$FILL/r9/client_highres.dat"
GUARD=2040000000
CEIL=2147483647
export DOTNET_ROLL_FORWARD=LatestMajor
log(){ echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
size(){ stat -c%s "$HR"; }
guard(){ sz=$(size); log "highres size: $sz ($(numfmt --to=iec "$sz"))"
         if [ "$sz" -ge "$CEIL" ]; then log "HARD CEILING EXCEEDED - stopping"; exit 9; fi
         if [ "$sz" -ge "$GUARD" ]; then log "WARN: past the 2.04 GB lane guard"; fi; }

log "=== finisher armed; waiting for the DXT import stage ==="
for i in $(seq 1 720); do            # up to 6 h
  grep -q 'DXT import done' "$FILL/logs/build-r9.log" 2>/dev/null && break
  if ! pgrep -f 'build_r9_highres.sh' >/dev/null && ! pgrep -f 'WorldBuilder.Terminal.dll' >/dev/null; then
    log "build script and WBT both gone without a DONE line - continuing with whatever landed"
    break
  fi
  sleep 30
done
grep -E 'written=|DXT import done' "$FILL/logs/build-r9.log" | tail -3

# the parent build script must not run its own (wrongly ordered) insert stage
pkill -f 'build_r9_highres.sh' 2>/dev/null
sleep 3
for i in $(seq 1 60); do pgrep -f 'WorldBuilder.Terminal.dll' >/dev/null || break; sleep 10; done
guard

log "== compress: the DXT records WBT just wrote (they land uncompressed) =="
dotnet "$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll" "$HR" --verify 2>&1 | tail -4
guard

# TOP-UP: the DXT stage may not have landed every record — WBT writes them
# UNCOMPRESSED, so a long import walks the file toward the 2 GiB ceiling and the
# tail chunk can fail or be cut short. Now that the file has been compressed and
# has room again, re-import whatever the manifests list but the dat does not hold.
log "== top-up: import any DXT records that did not land =="
python3 - "$HR" "$WBT" "$FILL"/bake-s0 "$FILL"/bake-s1 "$FILL"/bake-s2 <<'PY'
import json, os, subprocess, sys
sys.path.insert(0, '/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch')
import datlib
hr, wbt = sys.argv[1], sys.argv[2]
imports = []
for r in sys.argv[3:]:
    imports += json.load(open(os.path.join(r, 'fill-manifest.json')))['imports']
have = set(datlib.Dat(hr).files)
todo = [i for i in imports if int(i['idHex'], 16) not in have]
print("manifest %d, missing from the dat: %d" % (len(imports), len(todo)))
if not todo:
    sys.exit(0)
CH, written, failed, fails = 200, 0, 0, []
for i in range(0, len(todo), CH):
    chunk = todo[i:i+CH]
    cmd = dict(command="render-surface-import", datPath=hr, allowCreate=True, imports=chunk)
    p = subprocess.run(["dotnet", wbt, "--stdin"], input=json.dumps(cmd) + "\n",
                       capture_output=True, text=True, timeout=7200)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    res = next((o for o in out if o.get("command") == "render-surface-import"), None)
    if not res or not res.get("success"):
        print("TOP-UP CHUNK FAILED:", (p.stdout or p.stderr)[-300:]); break
    written += res.get("writtenCount", 0); failed += res.get("failCount", 0)
    for r in res.get("records", []):
        if r.get("status") == "FAIL" or r.get("error"):
            fails.append({k: r.get(k) for k in ("didHex", "status", "error")})
    print("  top-up %d/%d written=%d failed=%d" % (i+len(chunk), len(todo), written, failed), flush=True)
if fails:
    json.dump(fails, open(os.path.join(os.path.dirname(hr), "import-fails.json"), "w"), indent=1)
    print("  failures -> import-fails.json")
PY
guard

log "== compress: the top-up records =="
dotnet "$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll" "$HR" --verify 2>&1 | tail -3
guard

log "== palette inserts =="
python3 - "$FILL/r9/palette-manifest.json" "$FILL"/bake-s0 "$FILL"/bake-s1 "$FILL"/bake-s2 <<'PY'
import json, os, sys
out = sys.argv[1]; roots = sys.argv[2:]
ins = []
for r in roots:
    ins += json.load(open(os.path.join(r, 'fill-manifest.json')))['inserts']
json.dump(dict(inserts=ins), open(out, 'w'))
print("palette inserts: %d" % len(ins))
PY
dotnet "$TOOLS/DatRecordInsert/bin/Release/net8.0/DatRecordInsert.dll" "$HR" "$FILL/r9/palette-manifest.json" 2>&1 | tail -4
guard

log "== compress: the palette records just inserted =="
dotnet "$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll" "$HR" --verify 2>&1 | tail -4
guard

log "== walk_check =="
python3 "$TOOLS/walk_check.py" "$HR" | tee "$FILL/r9/walk.txt"

log "== dims ledger vs the r8 highres =="
python3 "$TOOLS/dims_ledger.py" "$HR" --previous "$R8KIT/client_highres.dat" \
    --json "$FILL/r9/dims-ledger-r9.json" 2>&1 | tail -8

log "== coverage count =="
python3 - "$HR" "$R8KIT/client_highres.dat" <<'PY'
import sys
sys.path.insert(0, '/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch')
import datlib
new = datlib.Dat(sys.argv[1]); old = datlib.Dat(sys.argv[2])
n = len([i for i in new.files if (i >> 24) == 0x06])
o = len([i for i in old.files if (i >> 24) == 0x06])
print("0x06 records in highres: %d -> %d  (+%d)" % (o, n, n - o))
PY

log "== assemble the r9 kit (tgz + zip) =="
bash "$TOOLS/kit/assemble_kit.sh" --tag r9 \
    --portal "$R8KIT/client_portal.dat" \
    --highres "$HR" \
    --cell "$R8KIT/client_cell_1.dat" \
    --out /mnt/wbterminal2/dat-patch-r9/kit --package 2>&1 | tail -25

log "== results =="
{
  echo "# Phase-4 fill - detached finisher results ($(date -u '+%Y-%m-%d %H:%MZ'))"
  echo
  echo '```'
  echo "highres: $(stat -c%s "$HR") bytes ($(numfmt --to=iec "$(size)"))"
  cat "$FILL/r9/walk.txt" 2>/dev/null
  echo
  grep -E 'KIT READY|packaged|acme-r9' "$FILL/logs/finish.log" 2>/dev/null | tail -5
  ls -la /mnt/wbterminal2/dat-patch-r9/kit/ 2>/dev/null | awk '{print $5, $9}'
  echo '```'
} > "$REPO/docs/dat-patch/reports/phase4-fill-RESULTS.md"

cd "$REPO"
git add docs/dat-patch/reports/phase4-fill-RESULTS.md docs/dat-patch/reports/phase4-coverage-fill-2026-08-20.md
git -c user.email=salvia420@gmail.com -c user.name=wbterminal commit -q -m "dat-patch: Phase-4 fill finisher results (detached run)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" || true
git push origin integ/all-20260813 || log "PUSH FAILED - results are committed locally"
log "=== FINISHER DONE ==="
touch "$FILL/FINISH_DONE"
