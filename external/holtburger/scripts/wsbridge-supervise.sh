#!/bin/bash
# wsbridge-supervise.sh — keep the holtburger-wsbridge up (conn-fix 2026-07-18).
#
# The bridge used to run as an unsupervised `nohup … &` orphan logging to a
# session-scoped scratchpad: a crash silently killed every browser client's
# connectivity, and a reboot lost the bridge entirely (this box is sysvinit —
# no systemd units; the convention here is cron @reboot + nohup, see
# MEMORY.md BOX FACTS).
#
# Usage:
#   scripts/wsbridge-supervise.sh            # foreground supervise loop
#   setsid nohup scripts/wsbridge-supervise.sh >/dev/null 2>&1 &   # detached
#   crontab: @reboot <repo>/external/holtburger/scripts/wsbridge-supervise.sh
#
# Stop everything:  touch /mnt/wbterminal2/wsbridge.STOP  (checked each loop)
# Log:              /mnt/wbterminal2/wsbridge_console.log (persistent disk,
#                   NOT the ephemeral claude scratchpad)

set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$DIR/target/release/holtburger-wsbridge"
LOG=/mnt/wbterminal2/wsbridge_console.log
STOP=/mnt/wbterminal2/wsbridge.STOP
LISTEN="${WSBRIDGE_LISTEN:-0.0.0.0:8080}"

# Single-instance guard: if a bridge is already listening, do not fight it.
if ss -tlpn 2>/dev/null | grep -q ":${LISTEN##*:} .*holtburger-wsbr"; then
  echo "[supervise] a wsbridge is already listening on ${LISTEN##*:}; exiting" >> "$LOG"
  exit 0
fi

echo "[supervise] starting loop (bin=$BIN listen=$LISTEN) $(date -Is)" >> "$LOG"
while true; do
  [ -e "$STOP" ] && { echo "[supervise] STOP file present; exiting $(date -Is)" >> "$LOG"; exit 0; }
  if [ ! -x "$BIN" ]; then
    echo "[supervise] binary missing at $BIN; retry in 60s $(date -Is)" >> "$LOG"
    sleep 60
    continue
  fi
  echo "[supervise] launching wsbridge $(date -Is)" >> "$LOG"
  "$BIN" --listen "$LISTEN" >> "$LOG" 2>&1
  echo "[supervise] wsbridge exited rc=$? $(date -Is); restart in 5s" >> "$LOG"
  sleep 5
done
