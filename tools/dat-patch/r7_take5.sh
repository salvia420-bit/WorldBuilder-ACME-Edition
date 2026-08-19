#!/bin/bash
# r7_take5.sh -- the r7.1 TAKE-5 driver (successor to /mnt/wbterminal2/dat-patch-r7/
# r7_driver4.sh, which is take 4 and stays on disk for provenance).
#
# What take 5 adds over take 4:
#   1. DEBLOCK REBAKE (I4, adopted 2026-08-17) -- the texture lanes re-encode from
#      the corpus-wide deblocked A-arm instead of the old rewrap corpus.
#   2. COLOUR ANCHOR + COLOUR LEDGER (I8, 2026-08-18) -- the retail anchor is
#      explicitly selected (rgb+sat) and the take now carries a NUMERIC colour
#      tripwire vs retail, so "the bakes went dark/flat" can never again be an
#      eye-only catch.  Gate stage runs before a single byte is imported.
#   3. DEGRADE-CHAIN FOLD (I3) -- fix_degrade_chains --fix after the lanes and
#      BEFORE the final compress/compact, plus a read-only --check on the
#      PACKAGED portal (tools/dat-patch/README.md "The degrade-chain invariant").
#
# House rules: no daemons, no cron, no git.  Base dats are read-only; every dat
# write lands on a COPY under $R7/export.  Every phase logs.  Stages are
# fail-loud (`set -e` + explicit die) and the whole driver is idempotent: it
# rebuilds the portal from the canonical r6 copy on every run, and both
# fix_degrade_chains --fix and the WBT collapse it delegates to are no-ops on an
# already-correct file (status ALREADY-SINGLE).
#
# Run:   nohup ./r7_take5.sh >> /mnt/wbterminal2/dat-patch-r7/r7_take5.log 2>&1
# (detached with `setsid nohup` if you must -- and then `pgrep -af r7_take5` and
# kill the extras: gcloud/ssh can double-execute a detached launch.)
set -eu

R7="${R7:-/mnt/wbterminal2/dat-patch-r7}"
REPO="${REPO:-/home/wbterminal/WorldBuilder-ACME-Edition}"
TOOLS="$REPO/tools/dat-patch"
TL="$TOOLS/texture_lane.py"
FDC="$TOOLS/fix_degrade_chains.py"
CL="$TOOLS/color_ledger.py"
WK="$TOOLS/walk_check.py"
DC="$TOOLS/DatCompress/bin/Release/net8.0/DatCompress.dll"
CPT="$TOOLS/DatCompact/bin/Release/net8.0/DatCompact.dll"
WBT="${WBT:-$REPO/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll}"
BASE="${BASE:-/home/wbterminal/ac_base_dats/client_portal.dat}"     # RETAIL, read-only
R6="${R6:-/mnt/wbterminal2/dat-patch-scenery/export/client_portal.dat}"   # canonical r6
PORTAL="$R7/export/client_portal.dat"
DOTNET="${DOTNET:-/home/wbterminal/.local/bin/dotnet}"
EXPECT_ENTRIES="${EXPECT_ENTRIES:-83618}"
CEILING_GUARD="${CEILING_GUARD:-2040000000}"

# ---- bake inputs ------------------------------------------------------------
export DOTNET_ROLL_FORWARD=LatestMajor
export DATPATCH_TEX_BASE="${DATPATCH_TEX_BASE:-/mnt/wbterminal2/tex-reexport-2026-07-30/}"
# THE DEBLOCK REBAKE: r7.1's texture source is the A-arm (deblocked input ->
# Remacri), adopted in reports/deblock-ab-2026-08-17.md.
export DATPATCH_REMACRI="${DATPATCH_REMACRI:-/mnt/wbterminal2/deblock-ab/out-remacri-full/}"
export DATPATCH_WRAPPED_CORPUS=1          # A-arm was baked wrap-padded (16 px)
export DATPATCH_BAKE_MAX_SIDE=4096
# THE COLOUR ANCHOR: explicit, never inherited.  "lum" is r7's semantics
# (scalar mean-luminance match to 1.15x retail); "rgb+sat" additionally matches
# retail's per-channel means and mean saturation -- measured on 2026-08-18 to
# take median satRatio 0.939 -> 0.991 and p90 castDrift 0.069 -> 0.003.
export DATPATCH_COLOR_ANCHOR="${DATPATCH_COLOR_ANCHOR:-rgb+sat}"
# Bake cache OFF by default for a colour-critical take: a warm baked/ dir from
# take 4 would silently re-ship the OLD pixels.  texture_lane's bake-config
# guard also refuses a cache stamped with a different corpus/anchor, but the
# cheapest correct answer is a fresh bake root.
export DATPATCH_BAKE_CACHE="${DATPATCH_BAKE_CACHE:-0}"

LANES="${LANES:-texture-remacri doors props dungeons creatures scenery}"
TAG="${TAG:-r71}"

cd "$TOOLS"
log(){ echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die(){ log "FATAL: $*"; exit 1; }

guard(){ sz=$(stat -c%s "$PORTAL"); log "portal file: $sz"
         [ "$sz" -gt "$CEILING_GUARD" ] && { log "CEILING GUARD TRIPPED"; exit 9; } || true; }
walk(){ python3 "$WK" "$PORTAL" --expect "$EXPECT_ENTRIES" \
          || { log "WALK TRIPWIRE FAILED"; exit 8; }; }
compress(){ log "== DatCompress =="; "$DOTNET" "$DC" "$PORTAL" --verify 2>&1 | tail -2; guard; walk; }
compact(){ log "== DatCompact =="
  rm -f "$R7/export/portal.compact.tmp"
  "$DOTNET" "$CPT" "$PORTAL" "$BASE" "$R7/export/portal.compact.tmp" --verify 2>&1 | tail -4
  python3 "$WK" "$R7/export/portal.compact.tmp" --expect "$EXPECT_ENTRIES" \
    || { log "COMPACT WALK FAILED"; exit 8; }
  mv "$PORTAL" "$PORTAL.pre-compact" && mv "$R7/export/portal.compact.tmp" "$PORTAL"
  rm -f "$PORTAL.pre-compact"
  guard; }

log "===== r7.1 take 5 (deblock rebake + colour anchor $DATPATCH_COLOR_ANCHOR + degrade fold) ====="
[ -f "$WBT" ] || die "no WorldBuilder.Terminal.dll at $WBT"
[ -d "$DATPATCH_REMACRI" ] || die "no remacri corpus at $DATPATCH_REMACRI"
[ -d "$DATPATCH_TEX_BASE" ] || die "no retail re-export at $DATPATCH_TEX_BASE"
mkdir -p "$R7/export"
sha256sum "$R6" | tee "$R7/r6-source.sha256"
cp "$R6" "$PORTAL"
walk
compress    # pass 1: frees the record bytes as interior slack
compact     # reclaim that slack into file size

run_lane(){ lane="$1"; ids="$2"; tag="$3"
  log "== lane $lane ($tag) =="
  python3 "$TL" run --root "$R7/$lane" --base "$BASE" --patched "$PORTAL" \
      --ids-file "$ids" --wbt "$WBT" --remacri --tag "$tag" 2>&1 | tail -5
  guard; walk
  compress
}

# ---- STAGE 1: bake+import the texture lanes --------------------------------
for lane in $LANES; do
  case "$lane" in
    scenery) run_lane scenery "$R7/scenery/ids_chunk_aa" "${TAG}1"
             run_lane scenery "$R7/scenery/ids_chunk_ab" "${TAG}2" ;;
    *)       run_lane "$lane" "$R7/$lane/ids_r7.txt" "$TAG" ;;
  esac
done

# ---- STAGE 2: COLOUR LEDGER (I8) -------------------------------------------
# Read-only, on the bake artefacts the lanes just wrote.  Placed here, after
# every lane and before the structural fixup, because a colour regression is a
# BAKE fault: catching it now costs a re-bake, catching it at the eye-test
# costs the whole take.  Thresholds tightened past the tool defaults because
# this take ships the rgb+sat anchor, whose contract is stricter than "lum".
log "== colour ledger vs retail =="
LEDGER_DIRS=""
for lane in $LANES; do
  [ -d "$R7/$lane/baked" ] && LEDGER_DIRS="${LEDGER_DIRS:+$LEDGER_DIRS,}$R7/$lane/baked"
done
[ -n "$LEDGER_DIRS" ] || die "colour ledger has no bake dirs -- the lanes wrote nothing"
CL_ARGS="--baked $LEDGER_DIRS --retail-dir $DATPATCH_TEX_BASE --jobs 3 \
  --json $R7/color-ledger.json --label r7.1-take5 --gate --min-records 1500"
case "$DATPATCH_COLOR_ANCHOR" in
  rgb+sat) CL_ARGS="$CL_ARGS --sat-median-lo 0.95 --cast-p99 0.05" ;;
esac
# shellcheck disable=SC2086
python3 "$CL" $CL_ARGS || { log "COLOUR LEDGER TRIPWIRE FAILED"; exit 7; }

# ---- STAGE 3: structural fixup ---------------------------------------------
log "== fixup (leaf sentinels + arena compaction) =="
python3 "$TL" fixup --base "$BASE" --patched "$PORTAL" 2>&1 | tail -2
walk

# ---- STAGE 4: DEGRADE-CHAIN FIX (I3) ---------------------------------------
# Placement is the whole point (README "The degrade-chain invariant"): AFTER
# every lane has written -- the baked set is only complete then -- and BEFORE
# the final compress/compact, so the block churn from the rewrite is absorbed
# by the compact.  Idempotent: chains already collapsed report ALREADY-SINGLE,
# and the tool re-checks itself after writing and exits nonzero on any residue.
log "== degrade-chain fixup =="
python3 "$FDC" "$PORTAL" --fix --retail "$BASE" --wbt "$WBT" \
    --json "$R7/degrade-fix.json" || { log "DEGRADE-CHAIN FIXUP FAILED"; exit 8; }
walk

compress
compact     # ship file dense

# ---- STAGE 4b: DIMS LEDGER (resolution tripwire, 2026-08-18) ---------------
# Compare every shipped 0x06 header against the PREVIOUS RELEASE: any
# downscale or format change fails the take.  Added after take 5 shipped 711
# textures at 4x lower resolution than r7 when the adopted deblock corpus
# (1,630 files) silently missed ids the r7 rewrap corpus (4,041) served —
# reports/eyetest-ab-review-2026-08-18.md.  Whitelist deliberate changes via
# DATPATCH_DIMS_ALLOW (hex ids, one per line).
log "== dims ledger vs previous release =="
PREV_RELEASE="${DATPATCH_PREV_RELEASE:-/mnt/wbterminal2/dat-patch-r7/degrade-fix-proof/client_portal.dat}"
DL_ARGS="$PORTAL --previous $PREV_RELEASE --json $R7/dims-ledger.json --gate"
[ -n "${DATPATCH_DIMS_ALLOW:-}" ] && DL_ARGS="$DL_ARGS --allow $DATPATCH_DIMS_ALLOW"
# shellcheck disable=SC2086
python3 "$TOOLS/dims_ledger.py" $DL_ARGS || { log "DIMS LEDGER TRIPWIRE FAILED"; exit 7; }

# ---- STAGE 5: final validation ---------------------------------------------
log "== final validation =="
python3 - "$PORTAL" "$EXPECT_ENTRIES" <<'EOF'
import sys
sys.path.insert(0, '/home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch')
import datlib
d = datlib.Dat(sys.argv[1])
n = sum(1 for _ in d.files)
assert n == int(sys.argv[2]), (n, sys.argv[2])
print('datlib strict walk entries:', n, 'OK')
EOF

# The SHIP GATE for the invariant: read-only, on the file that will be packaged.
log "== degrade-chain ship gate (packaged portal) =="
python3 "$FDC" "$PORTAL" --check --retail "$BASE" \
    --json "$R7/degrade-check.json" \
    || { log "DEGRADE-CHAIN TRIPWIRE FAILED"; exit 8; }

# ---- STAGE 6: package ------------------------------------------------------
log "== package =="
cd "$R7/export"
sha256sum client_portal.dat > client_portal.dat.sha256
sha256sum client_cell_1.dat > client_cell_1.dat.sha256
cd "$R7"
tar czf acme-dats-r71.tgz -C export client_portal.dat client_cell_1.dat \
    client_portal.dat.sha256 client_cell_1.dat.sha256
sha256sum acme-dats-r71.tgz > acme-dats-r71.tgz.sha256
log "DONE"
touch "$R7/R71_BAKE_DONE"
echo "REMINDER: in-client gate at VeryHigh (wine box / 1070) is mandatory before announcing."
echo "REMINDER: colour ledger -> $R7/color-ledger.json ; degrade -> $R7/degrade-{fix,check}.json"
