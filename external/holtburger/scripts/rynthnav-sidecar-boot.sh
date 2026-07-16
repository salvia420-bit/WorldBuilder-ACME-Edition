#!/bin/sh
# rynthnav-sidecar-boot.sh — idempotent boot for the RynthNav router sidecar
# (apps/rynthnav-sidecar) on the SYSVINIT laptop: no systemd units, process
# lifecycle is cron @reboot + this script. See the README "Lifecycle" section:
#
#   # crontab -e
#   @reboot /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/rynthnav-sidecar-boot.sh >> /mnt/wbterminal2/rynthnav_sidecar_boot.log 2>&1
#
# Idempotent: exits 0 immediately if :8767 already answers /health, so it is
# safe to run any time (cron @reboot, by hand after a crash, from a watchdog
# cron line). This script is the SINGLE spawn owner — rynth/supervisor.cjs
# (RYNTH_SIDECAR_URL) only OBSERVES sidecar health and never spawns it, so the
# two can't race each other into a double start.
#
# Absolute paths only: cron @reboot runs with a minimal environment (no
# interactive PATH; HOME may differ). Overridable via env for non-default
# layouts: RYNTHNAV_HOME, RYNTHNAV_DOTNET, RYNTHNAV_DIR, RYNTHNAV_NAV,
# RYNTHNAV_LISTEN, RYNTHNAV_LOG.
set -u

HOME_DIR="${RYNTHNAV_HOME:-/home/wbterminal}"
DOTNET="${RYNTHNAV_DOTNET:-$HOME_DIR/.local/bin/dotnet}"
SIDECAR_DIR="${RYNTHNAV_DIR:-$HOME_DIR/WorldBuilder-ACME-Edition/external/holtburger/apps/rynthnav-sidecar}"
DLL="$SIDECAR_DIR/bin/Release/net10.0/RynthNav.Sidecar.dll"
NAV_DIR="${RYNTHNAV_NAV:-/mnt/wbterminal2/rynthnav-data}"
PORTALS="$SIDECAR_DIR/data/portals.tsv"
LISTEN="${RYNTHNAV_LISTEN:-127.0.0.1:8767}"
HEALTH_URL="http://$LISTEN/health"
LOG="${RYNTHNAV_LOG:-/mnt/wbterminal2/rynthnav_sidecar_console.log}"
LOG_DIR=$(dirname "$LOG")

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ── idempotence gate: already healthy -> nothing to do ──────────────────────
if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
  echo "$(stamp) rynthnav-sidecar already healthy on $LISTEN — nothing to do"
  exit 0
fi

# Something LISTENING on the port but not answering /health = a wedged
# sidecar (or a squatter); refuse to stack a second one on top (the bind
# would fail and Kestrel aborts anyway). Port-listen is the right check —
# NOT pgrep -f 'RynthNav.Sidecar.dll serve': any process whose cmdline quotes
# that string (a Claude session carrying this README in its prompt, an
# editor, grep itself) is a false positive that blocks boot. Proven on the
# buildbox fan-out: 10 headless agents all matched.
PORT="${LISTEN##*:}"
port_taken() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$PORT\$"
  else
    return 1 # can't tell — proceed; a real conflict shows up as a bind abort in $LOG
  fi
}
if port_taken; then
  echo "$(stamp) ERROR: something is listening on :$PORT but $HEALTH_URL is not answering ok — wedged sidecar or port squatter. Inspect: ss -ltnp | grep :$PORT ; then kill it and re-run." >&2
  exit 1
fi

# cron @reboot can fire before local mounts settle; the log AND the nav tiles
# both live on /mnt/wbterminal2 by default. Wait up to 120s for the log dir.
i=0
while [ ! -d "$LOG_DIR" ] && [ "$i" -lt 24 ]; do sleep 5; i=$((i + 1)); done
if [ ! -d "$LOG_DIR" ]; then
  echo "$(stamp) ERROR: $LOG_DIR not mounted/present after 120s (console log + nav dir live there)" >&2
  exit 1
fi

[ -x "$DOTNET" ] || { echo "$(stamp) ERROR: dotnet not found/executable at $DOTNET (override: RYNTHNAV_DOTNET)" >&2; exit 1; }
[ -f "$DLL" ] || { echo "$(stamp) ERROR: $DLL missing — build first: (cd $SIDECAR_DIR && DOTNET_ROLL_FORWARD=LatestMajor $DOTNET build -c Release)" >&2; exit 1; }
[ -f "$PORTALS" ] || { echo "$(stamp) ERROR: $PORTALS missing" >&2; exit 1; }
if [ ! -d "$NAV_DIR" ]; then
  # Not fatal: the sidecar serves 0 tiles (straight-line routes only) — boot
  # anyway so /health is up, but say so loudly.
  echo "$(stamp) WARN: nav dir $NAV_DIR missing — sidecar will serve 0 tiles (straight-line routes only)" >&2
fi

# ── launch: the documented serve command (README Run section), detached ─────
echo "$(stamp) rynthnav-sidecar-boot: launching on $LISTEN (nav=$NAV_DIR)" >> "$LOG"
cd "$SIDECAR_DIR" || exit 1
DOTNET_ROLL_FORWARD=LatestMajor setsid nohup "$DOTNET" "$DLL" serve \
  --nav "$NAV_DIR" --portals "$PORTALS" --listen "$LISTEN" >> "$LOG" 2>&1 &

# ── verify it comes up (30s budget) ─────────────────────────────────────────
i=0
while [ "$i" -lt 15 ]; do
  sleep 2
  if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
    echo "$(stamp) rynthnav-sidecar up on $LISTEN: $(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null)"
    exit 0
  fi
  i=$((i + 1))
done
echo "$(stamp) ERROR: sidecar did not answer $HEALTH_URL within 30s — tail of $LOG:" >&2
tail -n 20 "$LOG" >&2 2>/dev/null || true
exit 1
