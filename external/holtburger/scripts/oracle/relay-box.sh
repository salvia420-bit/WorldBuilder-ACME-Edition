#!/usr/bin/env bash
# relay-box.sh — buildbox side of the oracle transport.
#
# Binds UDP 9000/9001 on the box (what the retail client talks to) and pushes
# each datagram, length-framed, down the ssh -R tunnel to the laptop where ACE
# actually lives. Run `tunnel-up.sh up` on the laptop FIRST — this script
# connects to the tunnel's listener, so without it every relay child fails to
# reach 127.0.0.1:19000.
#
# ACE uses TWO ports: 9000 for login and 9001 for the world server, and the
# client is told to switch mid-session. Relaying only 9000 gets you a
# successful login followed by a mysterious timeout, so both are always up.
#
# Usage: ./relay-box.sh (up|down|status)
#
# Why a launcher script instead of `setsid python3 ... &` inline over ssh:
# a backgrounded pipeline started inside a non-interactive `ssh host '...'`
# dies when the session tears down. Wrapping the launch in its own script and
# setsid-ing THAT reliably detaches it.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY="${ORACLE_RELAY_PY:-$HERE/udp_tcp_relay.py}"
LOG_DIR="${ORACLE_LOG_DIR:-$HOME/oracle-logs}"
PORTS=(9000 9001)

mkdir -p "$LOG_DIR"
log() { printf '[relay-box] %s\n' "$*" >&2; }

cmd_up() {
  [ -f "$RELAY" ] || { log "missing $RELAY"; exit 1; }
  for p in "${PORTS[@]}"; do
    local tcp=$((p + 10000))
    if pgrep -f "udp_tcp_relay.py --mode box --udp-port $p" >/dev/null; then
      log "relay for $p already up"
      continue
    fi
    # Fail loudly if the tunnel is not there yet — otherwise the client just
    # times out and you go looking in the wrong place.
    if ! timeout 2 bash -c "</dev/tcp/127.0.0.1/$tcp" 2>/dev/null; then
      log "WARN: nothing listening on 127.0.0.1:$tcp — run tunnel-up.sh up on the laptop"
    fi
    setsid "$RELAY" --mode box --udp-port "$p" --tcp-port "$tcp" \
      </dev/null >"$LOG_DIR/relay-box-$p.log" 2>&1 &
    disown 2>/dev/null
    log "relay: UDP :$p -> TCP 127.0.0.1:$tcp"
  done
  sleep 2
  cmd_status
}

cmd_down() {
  pkill -f 'udp_tcp_relay.py --mode bo[x]' 2>/dev/null && log "relays stopped"
  true
}

cmd_status() {
  for p in "${PORTS[@]}"; do
    printf 'relay %s: %s\n' "$p" \
      "$(pgrep -f "udp_tcp_relay.py --mode box --udp-port $p" >/dev/null && echo UP || echo DOWN)"
  done
  printf 'udp bound: %s\n' "$(ss -ulpn 2>/dev/null | grep -cE ':900[01]')"
}

case "${1:-status}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) log "usage: relay-box.sh (up|down|status)"; exit 2 ;;
esac
