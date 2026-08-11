#!/usr/bin/env bash
# tunnel-up.sh — laptop side of the oracle transport.
#
# Carries the buildbox's retail client to the ACE server running on this
# laptop. ACE speaks UDP on 9000 (login) and 9001 (world); ssh forwards only
# TCP; so each UDP port rides a framed TCP tunnel (see udp_tcp_relay.py for
# why a bare socat pipe silently corrupts this traffic).
#
#   [box] acclient --UDP:9000--> relay(box) --TCP:19000--> ssh -R
#                                                            |
#   [laptop] ACE :9000 <--UDP-- relay(host) <--TCP:19000-----+
#
# `ssh -R` is opened FROM here TO the box, so the listener lives on the BOX
# and forwards inbound connections down the tunnel to this host. Both ports
# get their own relay pair.
#
# Usage:
#   ./tunnel-up.sh up      # start host relays + the ssh -R tunnel
#   ./tunnel-up.sh down
#   ./tunnel-up.sh status
#
# Env: ORACLE_BOX_IP (default reads it from gcloud), ORACLE_SSH_KEY.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY="$HERE/udp_tcp_relay.py"
KEY="${ORACLE_SSH_KEY:-$HOME/.ssh/google_compute_engine}"
BOX_USER="${ORACLE_BOX_USER:-wbterminal}"
RUN_DIR="${ORACLE_RUN_DIR:-/tmp/holtburger-oracle}"
PORTS=(9000 9001)

mkdir -p "$RUN_DIR"
log() { printf '[tunnel] %s\n' "$*" >&2; }

box_ip() {
  if [ -n "${ORACLE_BOX_IP:-}" ]; then
    echo "$ORACLE_BOX_IP"
    return
  fi
  # The box is a spot VM with an EPHEMERAL IP: it changes on every restart,
  # so resolve it fresh rather than caching it in a file that goes stale.
  gcloud compute instances describe buildbox --zone us-central1-a \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null
}

cmd_up() {
  local ip; ip="$(box_ip)"
  [ -n "$ip" ] || { log "cannot resolve buildbox IP (is it TERMINATED?)"; exit 1; }
  log "buildbox at $ip"

  for p in "${PORTS[@]}"; do
    local tcp=$((p + 10000))
    if pgrep -f "udp_tcp_relay.py --mode host --tcp-port $tcp" >/dev/null; then
      log "host relay for $p already up"
      continue
    fi
    setsid python3 "$RELAY" --mode host --tcp-port "$tcp" --udp-port "$p" \
      </dev/null >"$RUN_DIR/relay-host-$p.log" 2>&1 &
    log "host relay: TCP 127.0.0.1:$tcp -> UDP 127.0.0.1:$p"
  done
  sleep 1

  if pgrep -f "ssh -N -R 19000" >/dev/null; then
    log "ssh -R tunnel already up"
  else
    # -N: no remote command. ServerAlive*: a spot VM's network can stall;
    # without these the tunnel wedges silently and the client just times out.
    setsid ssh -N \
      -R "19000:127.0.0.1:19000" \
      -R "19001:127.0.0.1:19001" \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -o StrictHostKeyChecking=no \
      -i "$KEY" "$BOX_USER@$ip" \
      </dev/null >"$RUN_DIR/ssh-tunnel.log" 2>&1 &
    sleep 3
    log "ssh -R tunnel opened (box:19000/19001 -> laptop)"
  fi
  cmd_status
}

cmd_down() {
  pkill -f 'udp_tcp_relay.py --mode hos[t]' 2>/dev/null && log "host relays stopped"
  pkill -f 'ssh -N -R 1900[0]' 2>/dev/null && log "ssh tunnel stopped"
  true
}

cmd_status() {
  for p in "${PORTS[@]}"; do
    local tcp=$((p + 10000))
    printf 'host relay %s: %s\n' "$p" \
      "$(pgrep -f "udp_tcp_relay.py --mode host --tcp-port $tcp" >/dev/null && echo UP || echo DOWN)"
  done
  printf 'ssh -R tunnel: %s\n' \
    "$(pgrep -f 'ssh -N -R 1900[0]' >/dev/null && echo UP || echo DOWN)"
  printf 'ACE listening: %s\n' \
    "$(ss -ulpn 2>/dev/null | grep -cE ':900[01]') socket(s)"
}

case "${1:-status}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) log "usage: tunnel-up.sh (up|down|status)"; exit 2 ;;
esac
