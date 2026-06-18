#!/usr/bin/env bash
# worldsweep-driver.sh — self-sustaining driver for the full-world verify sweep
# (PIPE-1, reconstructed from FULL-WORLD-BAKE-VERIFY-HANDOFF.md).
#
# The driver loops: restart ACE fresh (its landblock cache is the main RAM hog →
# bound it by restarting every chunk) → run verify-sweep.mjs for one timeboxed
# chunk (resumable via its state dir) → clean browsers → repeat until every LB in
# the census has a verdict. 4 agents is the stable ceiling on an 8GB/4-core box.
#
# All inputs are env-overridable with laptop defaults; every path is guarded.
# Run `worldsweep-driver.sh --dry-run` to print the resolved config and exit 0
# WITHOUT requiring the (scratch, regenerable) artifacts to exist yet.
set -u

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $a (try --dry-run / --help)" >&2; exit 64 ;;
  esac
done

# ── Toolchain ────────────────────────────────────────────────────────────────
# ACE is net10.0, WBT is net8.0 — cross-runtime; roll forward so one dotnet runs both.
export DOTNET_ROLL_FORWARD="${DOTNET_ROLL_FORWARD:-LatestMajor}"
DOTNET="${DOTNET:-${DOTNET_ROOT:+$DOTNET_ROOT/dotnet}}"
[ -n "${DOTNET:-}" ] || DOTNET="$(command -v dotnet || true)"
NODE="${NODE:-$(command -v node || true)}"

# ── Paths (laptop defaults; override via env) ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$SCRIPT_DIR/verify-sweep.mjs"
ACE_DIR="${ACE_DIR:-$HOME/ace-server/Source/ACE.Server/bin/Release/net10.0}"
WSBRIDGE="${WSBRIDGE:-$SCRIPT_DIR/../../target/release/holtburger-wsbridge}"
SERVE_PY="${SERVE_PY:-$SCRIPT_DIR/../serve.py}"
# Active dist is /mnt/wbterminal2/holtburger-dist (serve.py DEFAULT_ROOT), NOT
# the legacy /home/wbterminal/holtburger-dist the older handoffs referenced.
HOLTBURGER_DIST="${HOLTBURGER_DIST:-/mnt/wbterminal2/holtburger-dist}"
SWEEPDIR="${SWEEPDIR:-/tmp/worldsweep}"
LBS="${LBS:-/mnt/wbterminal1/tmp/claude-scratch/census-2026-05-30/content-landblocks.txt}"
ORACLES="${ORACLES:-/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/oracles}"
ACCOUNTS="${ACCOUNTS:-/mnt/wbterminal1/tmp/claude-scratch/world-oracles-2026-06-01/dev-account-pool.txt}"
LABEL="${LABEL:-worldsweep}"
STATE="${STATE:-/mnt/wbterminal1/tmp/claude-scratch/verify-sweep/state-$LABEL}"

# ── Tunables ─────────────────────────────────────────────────────────────────
AGENTS="${AGENTS:-4}"            # 4 = stable ceiling on 8GB/4-core; 8 OOMs hard
CHUNK_SECS="${CHUNK_SECS:-1800}" # restart ACE every 30 min to bound its cache
SETTLE="${SETTLE:-6000}"
export HOLTBURGER_DIST

print_config() {
  cat <<CFG
worldsweep-driver config:
  DOTNET           = ${DOTNET:-<not found>}
  NODE             = ${NODE:-<not found>}
  DOTNET_ROLL_FORWARD = $DOTNET_ROLL_FORWARD
  VERIFY           = $VERIFY
  ACE_DIR          = $ACE_DIR
  WSBRIDGE         = $WSBRIDGE
  SERVE_PY         = $SERVE_PY
  HOLTBURGER_DIST  = $HOLTBURGER_DIST
  SWEEPDIR         = $SWEEPDIR
  LBS              = $LBS
  ORACLES          = $ORACLES
  ACCOUNTS         = $ACCOUNTS
  STATE            = $STATE
  LABEL            = $LABEL
  AGENTS           = $AGENTS
  CHUNK_SECS       = $CHUNK_SECS
  SETTLE           = $SETTLE
CFG
}

exists() { [ -e "$1" ] && echo "ok" || echo "MISSING"; }

if [ "$DRY_RUN" = 1 ]; then
  print_config
  echo "--- existence check (dry-run only; not enforced) ---"
  for p in "$DOTNET" "$NODE" "$VERIFY" "$ACE_DIR/ACE.Server.dll" "$WSBRIDGE" "$SERVE_PY" "$HOLTBURGER_DIST" "$LBS" "$ORACLES" "$ACCOUNTS"; do
    printf '  [%s] %s\n' "$(exists "$p")" "$p"
  done
  echo "dry-run OK"
  exit 0
fi

# ── Hard guards (real run) ───────────────────────────────────────────────────
[ -n "${DOTNET:-}" ] && [ -x "$DOTNET" ] || { echo "FAIL: dotnet not found (set DOTNET / DOTNET_ROOT)" >&2; exit 2; }
[ -n "${NODE:-}" ]   || { echo "FAIL: node not found" >&2; exit 2; }
[ -e "$VERIFY" ]              || { echo "FAIL: verify-sweep.mjs missing at $VERIFY" >&2; exit 2; }
[ -e "$ACE_DIR/ACE.Server.dll" ] || { echo "FAIL: ACE.Server.dll missing in $ACE_DIR" >&2; exit 2; }
[ -e "$WSBRIDGE" ]           || { echo "FAIL: wsbridge missing at $WSBRIDGE (cargo build -p holtburger-wsbridge --release)" >&2; exit 2; }
[ -e "$SERVE_PY" ]           || { echo "FAIL: serve.py missing at $SERVE_PY" >&2; exit 2; }
[ -e "$HOLTBURGER_DIST" ]    || { echo "FAIL: dist missing at $HOLTBURGER_DIST" >&2; exit 2; }
[ -e "$LBS" ]                || { echo "FAIL: landblock census missing at $LBS" >&2; exit 2; }
[ -e "$ORACLES" ]            || { echo "FAIL: oracle dir missing at $ORACLES" >&2; exit 2; }
[ -e "$ACCOUNTS" ]           || { echo "FAIL: account pool missing at $ACCOUNTS" >&2; exit 2; }

mkdir -p "$SWEEPDIR" "$STATE"
DRIVER_LOG="$SWEEPDIR/worldsweep-driver.log"
TOTAL=$(grep -cE '0x[0-9A-Fa-f]{4}' "$LBS" 2>/dev/null || wc -l < "$LBS")
echo "[driver] $(date -u +%FT%TZ) start — $TOTAL LBs, $AGENTS agents, ${CHUNK_SECS}s chunks" | tee -a "$DRIVER_LOG"

start_ace() {
  pkill -f "ACE.Server.dll" 2>/dev/null; sleep 3
  ( cd "$ACE_DIR" && ACE_NONINTERACTIVE_CONSOLE=true setsid nohup "$DOTNET" ACE.Server.dll </dev/null \
      > "$SWEEPDIR/ace.log" 2>&1 & )
  echo "[driver] waiting for ACE 'World is now open'…" | tee -a "$DRIVER_LOG"
  for _ in $(seq 1 60); do grep -q "World is now open" "$SWEEPDIR/ace.log" 2>/dev/null && return 0; sleep 2; done
  echo "[driver] WARN: ACE open-marker not seen in 120s; continuing" | tee -a "$DRIVER_LOG"
}

ensure_support() {
  pgrep -f "holtburger-wsbridge" >/dev/null || ( setsid nohup "$WSBRIDGE" --listen 127.0.0.1:8080 >"$SWEEPDIR/wsbridge.log" 2>&1 & )
  pgrep -f "serve.py" >/dev/null || ( HOLTBURGER_DIST="$HOLTBURGER_DIST" setsid nohup python3 "$SERVE_PY" --port 8765 --bind 127.0.0.1 >"$SWEEPDIR/serve.log" 2>&1 & )
}

done_count() { find "$STATE" -name '*.json' 2>/dev/null | wc -l; }

while :; do
  DONE=$(done_count)
  echo "[driver] $(date -u +%FT%TZ) progress: $DONE / $TOTAL" | tee -a "$DRIVER_LOG"
  [ "$DONE" -ge "$TOTAL" ] && { echo "[driver] queue drained — done." | tee -a "$DRIVER_LOG"; break; }

  start_ace
  ensure_support

  # One resumable chunk (verify-sweep skips LBs already in $STATE). timeboxed so
  # the loop reclaims ACE/browser RAM between chunks.
  timeout "$CHUNK_SECS" "$NODE" "$VERIFY" \
    --agents="$AGENTS" --lbs="$LBS" --oracles="$ORACLES" \
    --accounts="$ACCOUNTS" --label="$LABEL" --state="$STATE" --settle="$SETTLE" \
    >>"$DRIVER_LOG" 2>&1
  rc=$?
  echo "[driver] chunk exit=$rc (124=timeout, expected)" | tee -a "$DRIVER_LOG"

  # Clean browsers between chunks (RAM).
  pkill -f "headless_shell" 2>/dev/null; pkill -x node 2>/dev/null; sleep 3
done

echo "[driver] aggregate matrix in /mnt/wbterminal1/tmp/claude-scratch/verify-sweep/$LABEL-*/matrix.json or from $STATE" | tee -a "$DRIVER_LOG"
