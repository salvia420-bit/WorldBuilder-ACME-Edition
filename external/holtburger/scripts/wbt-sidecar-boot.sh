#!/bin/sh
# wbt-sidecar-boot.sh — idempotent boot for the WorldBuilder.Terminal oracle
# sidecar (apps/wbt-sidecar) on the SYSVINIT laptop, mirroring
# rynthnav-sidecar-boot.sh: no systemd units, lifecycle is cron @reboot +
# this script.
#
#   # crontab -e
#   @reboot /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/wbt-sidecar-boot.sh >> /mnt/wbterminal2/wbt_sidecar_boot.log 2>&1
#
# Idempotent: exits 0 immediately if the listen port already answers /health.
# This script is the SINGLE spawn owner. Absolute paths only (cron @reboot has
# a minimal environment). Overridable via env: WBT_HOME, WBT_NODE, WBT_DIR,
# WBT_LISTEN, WBT_LOG, plus everything wbt_sidecar.cjs itself reads
# (WBT_DOTNET, WBT_DLL, WBT_PROJECT, WBT_TICKETS_DIR, WBT_ALLOW, WBT_DENY).
set -u

HOME_DIR="${WBT_HOME:-/home/wbterminal}"
NODE="${WBT_NODE:-/usr/bin/node}"
SIDECAR_DIR="${WBT_DIR:-$HOME_DIR/WorldBuilder-ACME-Edition/external/holtburger/apps/wbt-sidecar}"
SCRIPT="$SIDECAR_DIR/wbt_sidecar.cjs"
LISTEN="${WBT_LISTEN:-127.0.0.1:8768}"
HEALTH_URL="http://$LISTEN/health"
LOG="${WBT_LOG:-/mnt/wbterminal2/wbt_sidecar_console.log}"
LOG_DIR=$(dirname "$LOG")
DLL="${WBT_DLL:-$HOME_DIR/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll}"

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ── idempotence gate: already healthy -> nothing to do ──────────────────────
if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
  echo "$(stamp) wbt-sidecar already healthy on $LISTEN — nothing to do"
  exit 0
fi

# Port taken but /health dead = wedged sidecar or squatter; refuse to stack
# (port-listen check, NOT pgrep — see rynthnav-sidecar-boot.sh for why).
PORT="${LISTEN##*:}"
port_taken() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"
  else
    return 1
  fi
}
if port_taken; then
  echo "$(stamp) ERROR: something is listening on :$PORT but $HEALTH_URL is not answering ok — wedged sidecar or port squatter. Inspect: ss -ltnp | grep :$PORT" >&2
  exit 1
fi

# cron @reboot can fire before /mnt/wbterminal2 settles; wait up to 120s.
i=0
while [ ! -d "$LOG_DIR" ] && [ "$i" -lt 24 ]; do sleep 5; i=$((i + 1)); done
if [ ! -d "$LOG_DIR" ]; then
  echo "$(stamp) ERROR: $LOG_DIR not mounted/present after 120s" >&2
  exit 1
fi

[ -x "$NODE" ] || { echo "$(stamp) ERROR: node not found/executable at $NODE (override: WBT_NODE)" >&2; exit 1; }
[ -f "$SCRIPT" ] || { echo "$(stamp) ERROR: $SCRIPT missing" >&2; exit 1; }
[ -f "$DLL" ] || { echo "$(stamp) ERROR: $DLL missing — build first: DOTNET_ROLL_FORWARD=LatestMajor dotnet build WorldBuilder.Terminal -c Release (override: WBT_DLL)" >&2; exit 1; }

# ── launch, detached ────────────────────────────────────────────────────────
echo "$(stamp) wbt-sidecar-boot: launching on $LISTEN (project=${WBT_PROJECT:-none})" >> "$LOG"
WBT_LISTEN="$LISTEN" setsid nohup "$NODE" "$SCRIPT" >> "$LOG" 2>&1 &

# ── verify it comes up (60s budget — dotnet cold start is slow) ─────────────
i=0
while [ "$i" -lt 30 ]; do
  sleep 2
  if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ready":true'; then
    echo "$(stamp) wbt-sidecar up on $LISTEN: $(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null)"
    exit 0
  fi
  i=$((i + 1))
done
echo "$(stamp) ERROR: sidecar did not answer ready on $HEALTH_URL within 60s — tail of $LOG:" >&2
tail -n 20 "$LOG" >&2 2>/dev/null || true
exit 1
