#!/usr/bin/env bash
# drive-perf.sh — drive the Playwright Firefox on the 1070 through a fixed
# 60-second WASD scenario while a page-side recorder captures rAF hitches,
# fps, draw-call counts, and player path length. Designed for A/B perf
# comparison across code changes: same URL, same movement pattern, same
# warmup → only the bits the user actually changed differ between runs.
#
# Read scripts/perf-worker/README.md for the full design notes.

set -uo pipefail

LABEL=""
QUALITY="low"   # default low preset for perf-test conditions (no CSM/bloom/POM/AA/etc.)
WARMUP_SEC=10
RUN_SEC=60
READY_TIMEOUT_SEC=120
DRIVER="http://127.0.0.1:9224"
APP_HOST_PORT="localhost:7080"
APP_PATH="/apps/holtburger-web/index.html"
ACCOUNT="tailnet1"
PASSWORD="tailnet1"
SPAWN="first"
KICK_DANCE=1
EXTRA_FLAGS=""  # no clouds/aurora by default — "low" means low
AGENTIC_LOW=1   # default ON — fast-boot mode for A/B iteration (commit 2000e67)
WIRE_MODE=0     # --wire = wire-agent (?wireframe=1) — skips atmosphere/composer/clouds/skydome/CSM, all materials wireframe
OUT_ROOT="/mnt/wbterminal1/tmp/claude-scratch/perf"
NO_CLEAR_CACHE=0
RELOAD_ONLY=0

usage() {
  cat <<USAGE
Usage: $0 --label NAME [opts]

Required:
  --label NAME           run identifier (used in output dir)

Optional:
  --quality PRESET       low|mid|high|ultra (default: low — low worker is low everything)
  --warmup-sec N         seconds to idle after boot 'ready' (default: 10)
  --run-sec N            (advisory; pattern is fixed at 60s)
  --ready-timeout-sec N  max wait for __bootState='ready' (default: 120)
  --driver URL           firefox-driver URL (default: http://127.0.0.1:9224)
  --app-host-port HP     e.g. localhost:7080 (default)
  --app-path PATH        URL path (default: /apps/holtburger-web/index.html)
  --account NAME         (default: tailnet1)
  --password PW          (default: tailnet1)
  --spawn NAME|first|0   autoSpawn param (default: first)
  --no-kick-dance        disable kickDance=1
  --extra-flags 'a=1&b=2' append to URL (default: '' — pass 'clouds=on&aurora=on' to opt in)
  --full-ring            disable ?agentic=low (use full 13×13 horizon, ~48s boot)
  --wire                 wire-agent mode (?wireframe=1 — strips atmosphere/composer/clouds/skydome/CSM, materials → MeshBasicMaterial wireframe)
  --out-root DIR         output base (default: /mnt/wbterminal1/tmp/claude-scratch/perf)
  --no-clear-cache       skip /clear-cache before navigate (faster re-runs)
  --reload-only          skip navigate; just /reload (preserves session)
USAGE
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --quality) QUALITY="$2"; shift 2 ;;
    --warmup-sec) WARMUP_SEC="$2"; shift 2 ;;
    --run-sec) RUN_SEC="$2"; shift 2 ;;
    --ready-timeout-sec) READY_TIMEOUT_SEC="$2"; shift 2 ;;
    --driver) DRIVER="$2"; shift 2 ;;
    --app-host-port) APP_HOST_PORT="$2"; shift 2 ;;
    --app-path) APP_PATH="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --spawn) SPAWN="$2"; shift 2 ;;
    --no-kick-dance) KICK_DANCE=0; shift ;;
    --extra-flags) EXTRA_FLAGS="$2"; shift 2 ;;
    --full-ring) AGENTIC_LOW=0; shift ;;
    --wire) WIRE_MODE=1; shift ;;
    --out-root) OUT_ROOT="$2"; shift 2 ;;
    --no-clear-cache) NO_CLEAR_CACHE=1; shift ;;
    --reload-only) RELOAD_ONLY=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

[[ -z "$LABEL" ]] && { echo "ERROR: --label is required" >&2; usage; }
SAFE_LABEL="$(printf %s "$LABEL" | tr -c 'A-Za-z0-9._-' '_')"
TS_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_ROOT}/${SAFE_LABEL}-${TS_UTC}"
mkdir -p "$OUT_DIR" || { echo "ERROR: mkdir $OUT_DIR failed" >&2; exit 1; }

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"

logf() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Helpers --------------------------------------------------------------------

b64fn() {
  # Encode a JS file (must contain a single arrow-fn expression) for /eval.
  base64 -w0 < "$1" | sed -e 's|+|%2B|g' -e 's|/|%2F|g' -e 's|=|%3D|g'
}

call_eval_file() {
  local label="$1" file="$2" timeout="${3:-10}"
  local b64; b64="$(b64fn "$file")"
  local resp; resp="$(curl -sS --max-time "$timeout" "${DRIVER}/eval?fn=${b64}" 2>&1)"
  local ec=$?
  if [[ $ec -ne 0 ]]; then
    logf "  eval[$label] FAILED (curl exit $ec): $resp"
    return $ec
  fi
  printf '%s' "$resp"
}

call_get() {
  # Generic GET. usage: call_get TIMEOUT URL [OUT_FILE]
  local timeout="$1" url="$2" outfile="${3:-}"
  if [[ -n "$outfile" ]]; then
    curl -sS --max-time "$timeout" --output "$outfile" "$url"
  else
    curl -sS --max-time "$timeout" "$url"
  fi
}

# Cleanup trap: if user kills the script mid-run, make sure the browser
# isn't left holding W+Shift forever.
EXIT_CLEAN_RAN=0
cleanup_on_exit() {
  [[ $EXIT_CLEAN_RAN -eq 1 ]] && return
  EXIT_CLEAN_RAN=1
  if [[ -f "$LIB_DIR/cleanup.js" ]]; then
    logf "trap: releasing held keys + clearing recorder"
    call_eval_file cleanup "$LIB_DIR/cleanup.js" 5 >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_exit EXIT INT TERM

# Pre-flight ----------------------------------------------------------------

MODE_STR=$([ "$AGENTIC_LOW" -eq 1 ] && echo "agentic=low (fast-boot)" || echo "full-ring (13×13)")
[[ "$WIRE_MODE" -eq 1 ]] && MODE_STR="${MODE_STR}+wireframe"
logf "OUT_DIR  = $OUT_DIR"
logf "DRIVER   = $DRIVER"
logf "label    = $LABEL  quality=$QUALITY  mode=$MODE_STR  warmup=${WARMUP_SEC}s"

status_json="$(call_get 6 "${DRIVER}/status" || true)"
if ! grep -q '"ok":true' <<< "$status_json"; then
  logf "ERROR: driver /status not OK — got: $status_json"
  logf "  Tunnel may be down. Try:"
  logf "    pkill -f 'ssh.*100.127.215.75'; sleep 1; \\"
  logf "    ssh -fN -R 7080:127.0.0.1:8765 -R 8080:127.0.0.1:8080 \\"
  logf "      -L 9223:127.0.0.1:9222 -L 9224:127.0.0.1:9224 \\"
  logf "      young@100.127.215.75"
  exit 2
fi
logf "driver OK: $status_json"

# Meta — record what we're about to run so A/B has provenance.
META_JSON="$OUT_DIR/meta.json"
HOLT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
GIT_HEAD="$(cd "$HOLT_DIR" && git rev-parse HEAD 2>/dev/null || echo none)"
GIT_BRANCH="$(cd "$HOLT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)"
GIT_DIRTY="$(cd "$HOLT_DIR" && [ -n "$(git status --porcelain 2>/dev/null)" ] && echo true || echo false)"
URL_QUERY="autoLogin=1&account=${ACCOUNT}&password=${PASSWORD}&autoSpawn=${SPAWN}&renderer=3d&quality=${QUALITY}"
[[ -n "$EXTRA_FLAGS" ]] && URL_QUERY="${URL_QUERY}&${EXTRA_FLAGS}"
[[ "$KICK_DANCE" -eq 1 ]] && URL_QUERY="${URL_QUERY}&kickDance=1"
[[ "$AGENTIC_LOW" -eq 1 ]] && URL_QUERY="${URL_QUERY}&agentic=low"
[[ "$WIRE_MODE" -eq 1 ]] && URL_QUERY="${URL_QUERY}&wireframe=1"
APP_URL="http://${APP_HOST_PORT}${APP_PATH}?${URL_QUERY}"

cat > "$META_JSON" <<META
{
  "label": "${LABEL}",
  "safeLabel": "${SAFE_LABEL}",
  "startedAt": "${TS_UTC}",
  "quality": "${QUALITY}",
  "agenticLow": $([ "$AGENTIC_LOW" -eq 1 ] && echo true || echo false),
  "warmupSec": ${WARMUP_SEC},
  "runSec": ${RUN_SEC},
  "url": "${APP_URL}",
  "driver": "${DRIVER}",
  "patternVersion": "movement-pattern-v1",
  "git": {
    "head": "${GIT_HEAD}",
    "branch": "${GIT_BRANCH}",
    "dirty": ${GIT_DIRTY}
  }
}
META
logf "meta saved → $META_JSON"

# Navigate ------------------------------------------------------------------

if [[ "$RELOAD_ONLY" -eq 1 ]]; then
  logf "reload-only: /reload?ignoreCache=1"
  call_get 10 "${DRIVER}/reload?ignoreCache=1" >/dev/null
else
  if [[ "$NO_CLEAR_CACHE" -ne 1 ]]; then
    logf "clearing browser cache"
    call_get 12 "${DRIVER}/clear-cache" >/dev/null
  fi
  # URL-encode the full app URL for /goto
  encoded_url="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$APP_URL")"
  logf "navigating → $APP_URL"
  call_get 15 "${DRIVER}/goto?url=${encoded_url}" >/dev/null
fi

# Poll for __bootState === 'ready' ------------------------------------------

logf "waiting for __bootState='ready' (timeout=${READY_TIMEOUT_SEC}s)"
poll_b64="$(b64fn "$LIB_DIR/poll-state.js")"
deadline=$(( $(date +%s) + READY_TIMEOUT_SEC ))
ready_state="unknown"
last_state=""
while (( $(date +%s) < deadline )); do
  poll_resp="$(curl -sS --max-time 5 "${DRIVER}/eval?fn=${poll_b64}" 2>/dev/null || true)"
  state="$(printf '%s' "$poll_resp" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print((d.get("result") or {}).get("state") or "")
except Exception: print("")' 2>/dev/null)"
  if [[ "$state" != "$last_state" ]]; then
    logf "  __bootState = ${state:-<none>}"
    last_state="$state"
  fi
  if [[ "$state" == "ready" ]]; then
    ready_state="ready"
    break
  fi
  if [[ "$state" == "error" ]]; then
    ready_state="error"
    break
  fi
  sleep 2
done

if [[ "$ready_state" != "ready" ]]; then
  logf "ERROR: never reached __bootState='ready' (last='${last_state}')"
  call_get 10 "${DRIVER}/console?n=200" > "$OUT_DIR/console-failed.txt" || true
  call_get 15 "${DRIVER}/screenshot" "$OUT_DIR/failed.png" || true
  exit 3
fi
logf "ready ✓"

# Teleport to Holtburg for consistent run-to-run scene state ---------------

logf "teleporting → Holtburg (@telepoi via sendChat)"
tp_resp="$(call_eval_file teleport "$LIB_DIR/teleport-and-settle.js" 25)"
echo "$tp_resp" > "$OUT_DIR/teleport.json"
if grep -q '"ok":true' <<< "$tp_resp"; then
  python3 - "$OUT_DIR/teleport.json" <<'PY' | while IFS= read -r line; do logf "  $line"; done
import sys, json
with open(sys.argv[1]) as f: d = json.load(f)
r = d.get("result") or {}
a = r.get("after") or {}
print(f"moved={r.get('moved')}m  already={r.get('alreadyAtHoltburg')}  elapsed={r.get('elapsedMs')}ms")
print(f"pose after: x={a.get('x')} y={a.get('y')} z={a.get('z')}")
PY
else
  logf "WARN: teleport response not ok — continuing anyway: $(head -c 200 <<< "$tp_resp")"
fi

# Warm-up -------------------------------------------------------------------

logf "warm-up: ${WARMUP_SEC}s idle (post-teleport)"
sleep "$WARMUP_SEC"

# Snapshot pre-run --------------------------------------------------------

logf "snapshot pre-run"
call_get 20 "${DRIVER}/screenshot" "$OUT_DIR/before.png" || true

# Install recorder + movement loop -----------------------------------------

logf "installing recorder"
recorder_resp="$(call_eval_file install-recorder "$LIB_DIR/install-recorder.js" 10)"
echo "$recorder_resp" > "$OUT_DIR/install-recorder.json"
if ! grep -q '"ok":true' <<< "$recorder_resp"; then
  logf "ERROR: recorder install failed: $recorder_resp"
  exit 4
fi

logf "starting movement loop (movement-pattern-v1, ~60s)"
mover_resp="$(call_eval_file install-movement "$LIB_DIR/install-movement.js" 10)"
echo "$mover_resp" > "$OUT_DIR/install-movement.json"
if ! grep -q '"ok":true' <<< "$mover_resp"; then
  logf "ERROR: movement install failed: $mover_resp"
  call_eval_file cleanup "$LIB_DIR/cleanup.js" 5 >/dev/null 2>&1 || true
  exit 5
fi
TOTAL_MS=$(python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print((d.get("result") or {}).get("totalMs") or 60000)
except Exception: print(60000)' <<< "$mover_resp")
WAIT_S=$(( (TOTAL_MS / 1000) + 1 ))

# Heartbeat every 10 seconds so the operator sees progress.
logf "running movement for ${WAIT_S}s (will heartbeat every 10s)"
END_TS=$(( $(date +%s) + WAIT_S ))
while (( $(date +%s) < END_TS )); do
  REM=$(( END_TS - $(date +%s) ))
  (( REM <= 0 )) && break
  STEP=10
  (( REM < STEP )) && STEP=$REM
  sleep $STEP
  logf "  ... ${REM}s remaining"
done

# Stop + summarize ---------------------------------------------------------

logf "stopping recorder + summarizing"
summary_resp="$(call_eval_file stop-and-summarize "$LIB_DIR/stop-and-summarize.js" 20)"
echo "$summary_resp" > "$OUT_DIR/summary.json"
if ! grep -q '"ok":true' <<< "$summary_resp"; then
  logf "ERROR: summarize failed (response saved): $(head -c 400 <<< "$summary_resp")"
  call_eval_file cleanup "$LIB_DIR/cleanup.js" 5 >/dev/null 2>&1 || true
  exit 6
fi

logf "dumping raw frame intervals"
raw_resp="$(call_eval_file dump-raw "$LIB_DIR/dump-raw.js" 30)"
echo "$raw_resp" > "$OUT_DIR/frames.json"

logf "cleanup (delete window.__perfRec / __moveLoop)"
call_eval_file cleanup "$LIB_DIR/cleanup.js" 8 >/dev/null

# Post artifacts ----------------------------------------------------------

logf "console tail"
call_get 15 "${DRIVER}/console?n=500" > "$OUT_DIR/console.txt" || true

logf "snapshot post-run"
call_get 20 "${DRIVER}/screenshot" "$OUT_DIR/after.png" || true

# Pretty-print summary line ------------------------------------------------
python3 - "$OUT_DIR/summary.json" "$OUT_DIR/meta.json" <<'PY'
import json, sys, os

sf, mf = sys.argv[1], sys.argv[2]
with open(sf) as f: r = json.load(f).get("result") or {}
with open(mf) as f: m = json.load(f)

ft = r.get("frameTimeMs") or {}
hc = r.get("hitchCounts") or {}
ht = r.get("hitchTimeMs") or {}
po = r.get("pose") or {}
rs = r.get("renderer") or {}
rs0 = rs.get("start") or {}
rs1 = rs.get("end") or {}
lt = r.get("longTask") or {}

print()
print("=" * 72)
print(f"  RUN  label={m['label']!r}  quality={m['quality']}  git={m['git']['head'][:7]} ({'dirty' if m['git']['dirty'] else 'clean'})")
print("=" * 72)
print(f"  fps avg      : {r.get('avgFps')}")
print(f"  frame time   : p50={ft.get('p50')}ms  p95={ft.get('p95')}ms  p99={ft.get('p99')}ms  max={ft.get('max')}ms")
print(f"  hitches      : >=50ms: {hc.get('>=50ms')}  >=100ms: {hc.get('>=100ms')}  >=250ms: {hc.get('>=250ms')}  >=500ms: {hc.get('>=500ms')}  >=1s: {hc.get('>=1000ms')}")
print(f"  hitch time   : >=100ms: {ht.get('>=100ms')}ms  >=250ms: {ht.get('>=250ms')}ms  >=500ms: {ht.get('>=500ms')}ms")
print(f"  long-tasks   : count={lt.get('count')}  max={lt.get('maxMs')}ms  sum={lt.get('sumMs')}ms (Firefox-only)")
print(f"  duration     : {r.get('durationMs')}ms  frames={r.get('frameCount')}")
print(f"  path moved   : {po.get('pathLengthM')}m  (snaps={po.get('snapCount')})")
print(f"  draws/frame  : start={rs0.get('callsPerFrame')}  end={rs1.get('callsPerFrame')}  (avg incl all composer passes)")
print(f"  tris/frame   : start={rs0.get('trianglesPerFrame')}  end={rs1.get('trianglesPerFrame')}")
print(f"  meshes       : start={rs0.get('meshes')}  end={rs1.get('meshes')}")
print(f"  textures     : start={rs0.get('textures')}  end={rs1.get('textures')}")
print(f"  geometries   : start={rs0.get('geometries')}  end={rs1.get('geometries')}")
print(f"  programs     : start={rs0.get('programs')}  end={rs1.get('programs')}")
print()
print(f"  Out dir: {os.path.dirname(sf)}")
print("=" * 72)
PY

logf "done."
exit 0
