#!/bin/bash
# texture_driver.sh -- the TEXTURE LEGIBILITY LANE driver (buildbox).
#
#   prep   -> copy geometry-tranche export dats into a COPY + derive matched
#             surface set + pick a validation slice
#   slice  -> bake+encode+import+collapse+roundtrip the slice, render A/B boards
#   full   -> same over the whole matched set (run ONLY after the slice gate passes)
#   package-> tar + sha256 + TEXTURE_DONE
#
# House rules (memory/MEMORY.md): sysv box, no daemons/cron/watchers; every path
# absolute; base dats read-only; work on copies; every phase logged.  Unlike the
# tranche driver this is NOT self-detaching -- the slice gate needs a human eye
# between `slice` and `full`, so each phase is invoked explicitly.
#
# Usage:  texture_driver.sh {prep|slice|full|package}
set -u

REPO="${REPO:-/home/wbterminal/WorldBuilder-ACME-Edition}"
TOOLS="$REPO/tools/dat-patch"
ROOT="${ROOT:-$HOME/texture-run}"
TRANCHE="${TRANCHE:-$HOME/tranche-run}"
BASE_DATS="${BASE_DATS:-$HOME/ac_base_dats}"
PYTHON="${PYTHON:-python3}"
WBT_DLL="${WBT_DLL:-$REPO/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll}"
BASE_PORTAL="$BASE_DATS/client_portal.dat"
PATCHED="$ROOT/export/client_portal.dat"
LOG="$ROOT/texture_driver.log"

export DATPATCH_PORTAL="${DATPATCH_PORTAL:-$BASE_PORTAL}"
export DATPATCH_CURATED_JSON="${DATPATCH_CURATED_JSON:-$TOOLS/data/table.json}"
export DATPATCH_TEX_BASE="${DATPATCH_TEX_BASE:-$HOME/tex-reexport-2026-07-30/}"
export DATPATCH_HCACHE="${DATPATCH_HCACHE:-$ROOT/hcache/}"
export DATPATCH_DBCACHE="${DATPATCH_DBCACHE:-$ROOT/dbcache/}"
export DATPATCH_CELL="${DATPATCH_CELL:-$ROOT/export/client_cell_1.dat}"
export DOTNET_ROLL_FORWARD=LatestMajor

mkdir -p "$ROOT" "$DATPATCH_HCACHE" "$DATPATCH_DBCACHE" || exit 1
log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }
die() { log "FATAL: $*"; exit 1; }

PHASE="${1:-prep}"
BOARDS="${BOARDS:-}"        # optional override "0xGID,0xGID"

case "$PHASE" in
prep)
    log "=== prep: copy tranche export dats into $ROOT/export (working copies) ==="
    mkdir -p "$ROOT/export"
    for f in client_portal.dat client_cell_1.dat client_highres.dat client_local_English.dat; do
        if [ -f "$TRANCHE/export/$f" ]; then
            cp -f "$TRANCHE/export/$f" "$ROOT/export/$f" || die "copy $f"
        elif [ -f "$BASE_DATS/$f" ]; then
            log "prep: $f absent in tranche export, taking base copy"
            cp -f "$BASE_DATS/$f" "$ROOT/export/$f" || die "copy base $f"
        fi
    done
    log "prep: portal copy $(du -h "$PATCHED" | cut -f1)"
    log "prep: derive matched surface set"
    "$PYTHON" "$TOOLS/texture_lane.py" derive --root "$ROOT" --base "$BASE_PORTAL" || die "derive"
    log "prep: pick validation slice"
    "$PYTHON" "$TOOLS/texture_lane.py" slice --root "$ROOT" --base "$BASE_PORTAL" || die "slice"
    "$PYTHON" "$TOOLS/texture_lane.py" allids --root "$ROOT" --base "$BASE_PORTAL" || die "allids"
    # probe on the first slice rsId for the layout self-check
    FIRST=$(head -1 "$ROOT/slice_ids.txt")
    RS=$("$PYTHON" - "$ROOT" "$FIRST" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]+"/surfaces.json"))["surfaces"]
print(s[sys.argv[2]]["renderSurface"])
PY
)
    log "prep: probe rs=$RS"
    "$PYTHON" "$TOOLS/texture_lane.py" probe --base "$BASE_PORTAL" --rsid "$RS" --wbt "$WBT_DLL" 2>&1 | tee -a "$LOG"
    log "prep: done"
    ;;
slice)
    log "=== slice: bake+import+collapse+roundtrip the slice ==="
    BG="${BOARDS:-$("$PYTHON" -c "import json;print(','.join(json.load(open('$ROOT/slice.json'))['board_gids']))")}"
    log "slice: board gids = $BG"
    "$PYTHON" "$TOOLS/texture_lane.py" run --root "$ROOT" --base "$BASE_PORTAL" \
        --patched "$PATCHED" --ids-file "$ROOT/slice_ids.txt" --board "$BG" \
        --tag slice --wbt "$WBT_DLL" 2>&1 | tee -a "$LOG" || die "slice run"
    for g in ${BG//,/ }; do
        log "slice: board $g"
        "$PYTHON" "$TOOLS/texture_lane.py" board --root "$ROOT" --base "$BASE_PORTAL" \
            --patched "$PATCHED" --gid "$g" 2>&1 | tee -a "$LOG" || log "board $g FAILED"
    done
    log "slice: done -> $ROOT/run_slice.json + $ROOT/boards/"
    ;;
full)
    log "=== full: bake+import+collapse+roundtrip the whole matched set ==="
    BG="${BOARDS:-$("$PYTHON" -c "import json;print(','.join(json.load(open('$ROOT/slice.json'))['board_gids']))")}"
    "$PYTHON" "$TOOLS/texture_lane.py" run --root "$ROOT" --base "$BASE_PORTAL" \
        --patched "$PATCHED" --ids-file "$ROOT/all_ids.txt" --board "$BG" \
        --tag full --wbt "$WBT_DLL" 2>&1 | tee -a "$LOG" || die "full run"
    for g in ${BG//,/ }; do
        "$PYTHON" "$TOOLS/texture_lane.py" board --root "$ROOT" --base "$BASE_PORTAL" \
            --patched "$PATCHED" --gid "$g" 2>&1 | tee -a "$LOG" || log "board $g FAILED"
    done
    log "full: done -> $ROOT/run_full.json"
    ;;
package)
    log "=== package ==="
    TGZ="$ROOT/texture.tgz"
    rm -f "$TGZ" "$TGZ.sha256"
    ( cd "$ROOT" && tar czf "$TGZ" export results.json \
        $( [ -f run_slice.json ] && echo run_slice.json ) \
        $( [ -f run_full.json ] && echo run_full.json ) \
        surfaces.json slice.json boards texture_driver.log ) || die "tar"
    ( cd "$ROOT" && sha256sum texture.tgz > texture.tgz.sha256 )
    log "package: $(cat "$TGZ.sha256")"
    touch "$HOME/TEXTURE_DONE"
    log "package: TEXTURE_DONE written"
    ;;
*)
    die "unknown phase $PHASE (prep|slice|full|package)"
    ;;
esac
