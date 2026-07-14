#!/usr/bin/env bash
# Recycling wrapper for the 1070 real-GPU outdoor-run battery (v2).
# The continuous single-session run collapsed to <1 fps by ~POI 13 as the JS/wasm
# heap grew unbounded (no eviction). This version bounds each session to
# MAXSTOPS POIs (heap resets on the fresh page), and — crucially — waits for ACE
# to actually RELEASE the single-login account before each (re)login, so the
# recycle never hits "Account In Use" (which would exit 2 and stop the run).
# Detached (setsid nohup) so it survives Claude-session / SSH disconnect.
set -u

ND=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/net-review
OUT=/mnt/wbterminal2/tmp/outdoor-1070.json
SHOTS=/mnt/wbterminal2/tmp/outdoor-1070-shots
LOG=/mnt/wbterminal2/tmp/outdoor-1070-wrapper.log
ACELOG=/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE_Log.txt
CDP=http://127.0.0.1:9333
PLANS=$ND/outdoor-run-plans.json
MAXSTOPS=5
FREE_CAP=220   # seconds to wait for ACE to release the account

mkdir -p "$SHOTS"
cd "$ND" || exit 99

# free == last tailnet1 event in ACE log is a LOGOUT (not a more-recent LOGIN)
account_free() {
  local li lo
  li=$(grep -nE '\[LOGIN\] Account tailnet1 entered' "$ACELOG" 2>/dev/null | tail -1 | cut -d: -f1)
  lo=$(grep -nE '\[LOGOUT\] Account tailnet1 exited' "$ACELOG" 2>/dev/null | tail -1 | cut -d: -f1)
  li=${li:-0}; lo=${lo:-0}
  [ "$lo" -ge "$li" ]
}
wait_account_free() {
  local waited=0
  while ! account_free; do
    if [ "$waited" -ge "$FREE_CAP" ]; then
      echo "[wrap] account-free wait hit cap ${FREE_CAP}s — proceeding anyway $(date -Is)" >> "$LOG"
      return 0
    fi
    sleep 5; waited=$((waited+5))
  done
  [ "$waited" -gt 0 ] && echo "[wrap] account freed after ${waited}s $(date -Is)" >> "$LOG"
  return 0
}

RESUME=""
i=0
MAX_ITERS=40
{
  echo "=== wrapper v2 (recycling, maxStops=$MAXSTOPS) start $(date -Is) pid=$$ ==="
  echo "OUT=$OUT CDP=$CDP"
} >> "$LOG"

# If a resume seed exists, we start in resume mode.
[ -s "$OUT" ] && RESUME="--resume"

while [ "$i" -lt "$MAX_ITERS" ]; do
  i=$((i+1))
  echo "[wrap] iter $i: waiting for account-free $(date -Is)" >> "$LOG"
  wait_account_free
  echo "--- iter $i launch $(date -Is) resume='$RESUME' ---" >> "$LOG"
  node battery-outdoor-run.mjs \
    --mode cdp --cdp "$CDP" \
    --plans "$PLANS" \
    --runS 300 --label 1070 --maxStops "$MAXSTOPS" \
    --out "$OUT" --shots "$SHOTS" \
    $RESUME >> "$LOG" 2>&1
  ec=$?
  echo "--- iter $i exit=$ec $(date -Is) ---" >> "$LOG"
  if [ "$ec" -eq 3 ]; then
    RESUME="--resume"
    continue
  fi
  echo "=== wrapper done exit=$ec after $i iters $(date -Is) ===" >> "$LOG"
  exit "$ec"
done
echo "=== wrapper hit MAX_ITERS=$MAX_ITERS, stopping $(date -Is) ===" >> "$LOG"
exit 98
