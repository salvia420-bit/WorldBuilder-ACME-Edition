#!/bin/bash
# driver_buildbox.sh -- detached, resumable driver for a full tranche run.
#
#   enumerate -> build --jobs N -> WBT batch import+export -> validate -> package
#
# House rules honoured (memory/MEMORY.md, HANDOFF sections 3/5):
#   * sysv box: no systemd, no cron, no watchers.  ONE setsid+nohup re-exec, then
#     a straight-line script.  It starts NOTHING else and it never touches git.
#   * every path absolute; every phase logged to $LOG with a timestamp.
#   * resumable: each phase drops a stamp in $ROOT/stamps/, a re-run skips it.
#   * base dats are READ-ONLY; the run works on the copies under $ROOT/proj.
#   * the stale-project.db trap: project.db is reset at the START of the import
#     phase, so a re-run can never treat a previous batch's records as original.
#
# Usage (on the buildbox, from anywhere):
#   /home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch/driver_buildbox.sh
#   ROOT=/mnt/data/tranche JOBS=3 PLAN=/mnt/data/plan.json  ... driver_buildbox.sh
#   FORCE_PHASE=build driver_buildbox.sh        # re-run one phase (clears its stamp)
#
# Watch it:   tail -f $ROOT/driver.log
# Done when:  ~/TRANCHE_DONE exists (holds the tarball path + sha256).

set -u

REPO="${REPO:-/home/wbterminal/WorldBuilder-ACME-Edition}"
TOOLS="$REPO/tools/dat-patch"
ROOT="${ROOT:-/mnt/wbterminal2/tranche-run}"
BASE_DATS="${BASE_DATS:-$HOME/ac_base_dats}"
JOBS="${JOBS:-3}"
PLAN="${PLAN:-}"                      # optional plan.json from budget_planner.py
MIN_TRIS="${MIN_TRIS:-50}"
WINDOW="${WINDOW:-}"                  # empty = the whole world
PYTHON="${PYTHON:-python3}"
DOTNET="${DOTNET:-dotnet}"
WBT_DLL="${WBT_DLL:-$REPO/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll}"
PROJ="$ROOT/proj/tranche.wbproj"
LOG="$ROOT/driver.log"
STAMPS="$ROOT/stamps"
SENTINEL="${SENTINEL:-$HOME/TRANCHE_DONE}"

mkdir -p "$ROOT" "$STAMPS" || exit 1

# ---------------------------------------------------------------- detach once
if [ "${TRANCHE_CHILD:-0}" != "1" ]; then
    echo "driver: detaching (log: $LOG)"
    TRANCHE_CHILD=1 setsid nohup "$0" "$@" >>"$LOG" 2>&1 </dev/null &
    echo "driver: pid $!"
    exit 0
fi

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FATAL: $*"; exit 1; }

phase_done() { [ -f "$STAMPS/$1.done" ]; }
phase_stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ' > "$STAMPS/$1.done"; }
[ -n "${FORCE_PHASE:-}" ] && rm -f "$STAMPS/$FORCE_PHASE.done"

log "=========================================================="
log "driver start  ROOT=$ROOT JOBS=$JOBS PLAN=${PLAN:-none} WINDOW=${WINDOW:-world}"
log "repo=$REPO  base dats=$BASE_DATS"

# ------------------------------------------------------------------ preflight
mkdir -p "$ROOT/proj/dats/base"
for f in client_portal.dat client_cell_1.dat client_local_English.dat; do
    if [ ! -f "$ROOT/proj/dats/base/$f" ]; then
        [ -f "$BASE_DATS/$f" ] || die "no $f in $BASE_DATS"
        log "copying $f from the read-only base set"
        cp "$BASE_DATS/$f" "$ROOT/proj/dats/base/$f" || die "copy $f failed"
    fi
done
if [ ! -f "$PROJ" ]; then
    log "creating $PROJ"
    printf '{\n  "Name": "dat-patch-tranche",\n  "IsHosting": false,\n  "RemoteUrl": ""\n}\n' > "$PROJ"
fi

# ------------------------------------------------------------- phase 0: WBT
if phase_done wbt; then
    log "phase wbt: already done"
else
    if [ -f "$WBT_DLL" ]; then
        log "phase wbt: DLL present ($WBT_DLL)"
    else
        log "phase wbt: building WorldBuilder.Terminal (single project only)"
        ( cd "$REPO" && DOTNET_ROLL_FORWARD=LatestMajor "$DOTNET" build \
              WorldBuilder.Terminal -c Release ) || die "WBT build failed"
        [ -f "$WBT_DLL" ] || die "WBT built but $WBT_DLL is missing"
    fi
    phase_stamp wbt
fi

# ------------------------------------------------------- phase 1: enumerate
if phase_done enumerate; then
    log "phase enumerate: already done ($ROOT/models.json)"
else
    log "phase enumerate: starting"
    WINARG=""
    [ -n "$WINDOW" ] && WINARG="--window $WINDOW"
    # shellcheck disable=SC2086
    "$PYTHON" "$TOOLS/tranche.py" enumerate --root "$ROOT" --jobs "$JOBS" \
        --min-tris "$MIN_TRIS" $WINARG || die "enumerate failed"
    phase_stamp enumerate
    log "phase enumerate: done"
fi

# ----------------------------------------------------------- phase 2: build
if phase_done build; then
    log "phase build: already done ($ROOT/imports.jsonl)"
else
    log "phase build: starting with --jobs $JOBS"
    PLANARG=""
    [ -n "$PLAN" ] && PLANARG="--plan $PLAN"
    # tranche.py build is itself resumable (state/<gid>.json + input hash), so a
    # killed run resumes here without redoing finished records.
    # shellcheck disable=SC2086
    "$PYTHON" "$TOOLS/tranche.py" build --root "$ROOT" --jobs "$JOBS" $PLANARG
    rc=$?
    [ $rc -eq 0 ] || log "phase build: $rc failure(s) reported (build_failures.json) -- continuing with what built"
    [ -s "$ROOT/imports.jsonl" ] || die "build produced no imports.jsonl"
    phase_stamp build
    log "phase build: done ($(wc -l < "$ROOT/imports.jsonl") lines incl. export)"
fi

# ---------------------------------------------------------- phase 3: import
if phase_done import; then
    log "phase import: already done ($ROOT/export)"
else
    log "phase import: resetting staged project state (stale project.db trap)"
    rm -f "$ROOT/proj/project.db" "$ROOT/proj/project.db-wal" "$ROOT/proj/project.db-shm"
    rm -rf "$ROOT/export"
    log "phase import: WBT batch import + export"
    DOTNET_ROLL_FORWARD=LatestMajor "$DOTNET" "$WBT_DLL" --stdin -p "$PROJ" \
        < "$ROOT/imports.jsonl" > "$ROOT/import.log" 2> "$ROOT/import.err"
    rc=$?
    log "phase import: exit $rc"
    if grep -q '"success":false' "$ROOT/import.log" 2>/dev/null; then
        log "phase import: WARNING -- import.log contains failures:"
        grep -m 20 '"success":false' "$ROOT/import.log" | sed 's/^/    /'
    fi
    [ -f "$ROOT/export/client_portal.dat" ] || die "no export/client_portal.dat"
    phase_stamp import
    log "phase import: done"
fi

# -------------------------------------------------------- phase 4: validate
if phase_done validate; then
    log "phase validate: already done"
else
    log "phase validate: running the validation contract over the whole tranche"
    "$PYTHON" "$TOOLS/validate.py" --root "$ROOT" > "$ROOT/validate.log" 2>&1
    vrc=$?
    tail -5 "$ROOT/validate.log" | sed 's/^/    /'
    if [ $vrc -ne 0 ]; then
        log "phase validate: FAILURES -- see $ROOT/validation.json"
        log "packaging anyway so the failures can be inspected off-box"
    fi
    phase_stamp validate
fi

# --------------------------------------------------------- phase 5: package
if phase_done package; then
    log "phase package: already done"
else
    TGZ="$ROOT/tranche.tgz"
    log "phase package: tar czf $TGZ (export + validation + logs)"
    rm -f "$TGZ" "$TGZ.sha256"
    tar czf "$TGZ" -C "$ROOT" \
        export validation.json validate.log models.json degrade_deferred.json \
        tranche_report.json build_stats.json imports.jsonl import.log driver.log \
        $( [ -f "$ROOT/budget_dropped.json" ] && echo budget_dropped.json ) \
        $( [ -f "$ROOT/build_failures.json" ] && echo build_failures.json ) \
        || die "tar failed"
    ( cd "$ROOT" && sha256sum "$(basename "$TGZ")" > "$TGZ.sha256" ) || die "sha256 failed"
    log "phase package: $(cat "$TGZ.sha256")"
    phase_stamp package
    {
        echo "tarball: $TGZ"
        cat "$TGZ.sha256"
        [ -f "$ROOT/validation.json" ] && \
            "$PYTHON" -c "import json,sys;r=json.load(open('$ROOT/validation.json'));print('models OK: %d/%d failures=%d'%(sum(1 for m in r['models'].values() if m.get('OK')),len(r['models']),r['failures']))"
    } > "$SENTINEL"
    log "sentinel written: $SENTINEL"
fi

log "driver finished"
