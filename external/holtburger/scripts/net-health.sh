#!/bin/bash
# net-health.sh — measure the network link of the machine that hosts ACE and
# holtburger-wsbridge (net-health 2026-10-23).
#
# A browser playing from another machine reaches ACE over this machine's link
# (the WebSocket to the bridge on :8080, plus the page and assets from
# serve.py), so its quality decides how late the self-position echoes arrive.
# Run this before and after a change to the link (a better Wi-Fi spot, a cable
# to the modem) and compare the two files. It records:
#   - the link: default-route interface, Wi-Fi signal / bitrates / retries,
#     or Ethernet speed and duplex
#   - idle round trips to the gateway (1000 pings, 10 ms apart) and 1.1.1.1
#   - with --load: gateway round trips while the link carries a bulk download,
#     then a bulk upload (~9 s each against Cloudflare's speed endpoints, about
#     250 MB down and 120 MB up on Wi-Fi). Bulk traffic sharing the link is what
#     asset streaming does to the game socket's queue.
#   - tailscale's path to the 1070 (LAN, hairpin or DERP relay) if it is online
#   - the live bridge connections' TCP state (`ss -tin` on :8080)
# The bridge logs its own per-connection view ("link:" lines) in
# /mnt/wbterminal2/wsbridge_console.log.
#
# Usage:  scripts/net-health.sh [--load] [--label NAME]
# Output: /mnt/wbterminal2/net-health/<UTC time>-<label>.txt, and stdout.
# Not a heavy job (a few MB of RAM), but --load saturates the link for ~20 s:
# don't run it while someone is playing.

set -u
LOAD=0
LABEL=run
while [ $# -gt 0 ]; do
  case "$1" in
    --load) LOAD=1 ;;
    --label) LABEL="$2"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

OUT_DIR=/mnt/wbterminal2/net-health
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$LABEL.txt"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PEER_1070=100.127.215.75
BRIDGE_PORT=8080

# Round-trip statistics of a ping log: loss, min/p50/p90/p99/max, spikes.
pstats() {
  python3 - "$1" <<'EOF'
import re, sys
text = open(sys.argv[1]).read()
rtts = [float(x) for x in re.findall(r'time=([0-9.]+)', text)]
m = re.search(r'(\d+) packets transmitted, (\d+) received', text)
sent, recv = (int(m.group(1)), int(m.group(2))) if m else (0, len(rtts))
if not rtts:
    print("no replies"); sys.exit()
s = sorted(rtts)
q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
over = lambda ms: sum(1 for r in rtts if r > ms)
print(f"sent {sent} recv {recv} loss {100 * (sent - recv) / max(sent, 1):.1f}%  "
      f"min {s[0]:.2f} p50 {q(.5):.2f} p90 {q(.9):.2f} p99 {q(.99):.2f} max {s[-1]:.2f} ms  "
      f">20ms {over(20)} >50ms {over(50)} >100ms {over(100)}")
EOF
}

# $1 = down|up: four parallel ~9 s transfer loops; prints Mbit/s.
transfer() {
  local dir=$1 i
  for i in 1 2 3 4; do
    (
      end=$((SECONDS + 9)); tot=0
      while [ $SECONDS -lt $end ]; do
        if [ "$dir" = down ]; then
          b=$(curl -s -o /dev/null --max-time $((end - SECONDS + 1)) -w '%{size_download}' \
            'https://speed.cloudflare.com/__down?bytes=25000000')
        else
          b=$(head -c 25000000 /dev/zero | curl -s -o /dev/null --max-time $((end - SECONDS + 1)) \
            -X POST -H 'Content-Type: application/octet-stream' --data-binary @- \
            -w '%{size_upload}' 'https://speed.cloudflare.com/__up')
        fi
        b=${b%.*}
        tot=$((tot + ${b:-0}))
      done
      echo $tot > "$TMP/$dir.$i"
    ) &
  done
  local t0=$EPOCHREALTIME
  wait
  local t1=$EPOCHREALTIME
  python3 -c "import sys; b=sum(int(open(f).read()) for f in sys.argv[3:]); print(f'{b*8/(float(sys.argv[2])-float(sys.argv[1]))/1e6:.1f} Mbit/s ({b/1e6:.0f} MB)')" \
    "$t0" "$t1" "$TMP/$dir".?
}

{
  echo "# net-health $(date -Is) label=$LABEL host=$(hostname)"
  IF=$(ip route show default | awk '{print $5; exit}')
  GW=$(ip route show default | awk '{print $3; exit}')
  echo "default route: dev $IF via $GW"
  ip -br addr show dev "$IF"
  if [ -d "/sys/class/net/$IF/wireless" ] || iw dev "$IF" info >/dev/null 2>&1; then
    echo "link: Wi-Fi"
    iw dev "$IF" link | sed 's/^/  /'
    iw dev "$IF" station dump | grep -E 'signal|bitrate|tx retries|tx failed|beacon loss|rx drop misc|connected time' | sed 's/^/  /'
    echo "  power save: $(iw dev "$IF" get power_save 2>&1)"
  else
    echo "link: wired, speed $(cat /sys/class/net/$IF/speed 2>/dev/null) Mbit/s, duplex $(cat /sys/class/net/$IF/duplex 2>/dev/null)"
  fi
  for dev in $(ls /sys/class/net); do
    [ "$dev" = lo ] && continue
    printf '  %-12s %-8s' "$dev" "$(cat /sys/class/net/$dev/operstate)"
    ip -br -4 addr show dev "$dev" | awk '{printf " %s", $3}'
    echo
  done

  echo
  echo "## idle"
  ping -n -i 0.01 -c 1000 -W 1 "$GW" > "$TMP/gw_idle" 2>&1
  echo "gateway $GW:  $(pstats "$TMP/gw_idle")"
  ping -n -i 0.05 -c 200 -W 1 1.1.1.1 > "$TMP/wan_idle" 2>&1
  echo "1.1.1.1:       $(pstats "$TMP/wan_idle")"

  if [ $LOAD -eq 1 ]; then
    echo
    echo "## loaded (gateway pings every 20 ms during a 9 s bulk transfer)"
    for dir in down up; do
      ping -n -i 0.02 -w 11 -W 2 "$GW" > "$TMP/gw_$dir" 2>&1 &
      pp=$!
      sleep 1
      rate=$(transfer $dir)
      wait $pp
      echo "$dir $rate:  $(pstats "$TMP/gw_$dir")"
    done
    if iw dev "$IF" info >/dev/null 2>&1; then
      iw dev "$IF" station dump | grep -E 'tx retries|tx failed|tx bitrate' | sed 's/^/  after: /'
    fi
  fi

  echo
  echo "## tailscale path to the 1070 ($PEER_1070)"
  if tailscale status 2>/dev/null | grep -q "^$PEER_1070 .*offline"; then
    echo "offline"
  else
    timeout 30 tailscale ping -c 10 "$PEER_1070" 2>&1 | tail -10
  fi

  echo
  echo "## bridge connections (:$BRIDGE_PORT)"
  ss -tin "( sport = :$BRIDGE_PORT )" 2>/dev/null | tail -n +2 | grep -q . \
    && ss -tin "( sport = :$BRIDGE_PORT )" | tail -n +2 \
    || echo "none"
} 2>&1 | tee "$OUT"
echo "wrote $OUT"
