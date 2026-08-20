#!/usr/bin/env bash
# ceiling_watchdog.sh -- the dat format's hard ceiling is 2^31-1 (BTEntry offsets
# are signed; DiskDev::SyncRead has no high DWORD). WBT writes imported records
# UNCOMPRESSED, so a long import can walk the file straight through it and corrupt
# the dat. Stop the import at 2.00 GB and let finish_fill.sh compress and top-up:
# losing a chunk is recoverable, crossing the ceiling is not.
HR=/mnt/wbterminal2/fill-2026-08-20/r9/client_highres.dat
LIMIT=2000000000
while true; do
  [ -f "$HR" ] || exit 0
  S=$(stat -c%s "$HR")
  if [ "$S" -ge "$LIMIT" ]; then
    echo "[$(date -u +%H:%M:%S)] $S >= $LIMIT - halting the import stage"
    pkill -f 'build_r9_highres.sh' 2>/dev/null
    pkill -f 'WorldBuilder.Terminal.dll' 2>/dev/null
    echo "halted; finish_fill.sh will compress and top-up"
    exit 0
  fi
  grep -q 'DXT import done' /mnt/wbterminal2/fill-2026-08-20/logs/build-r9.log 2>/dev/null && {
    echo "[$(date -u +%H:%M:%S)] import finished on its own at $S"; exit 0; }
  pgrep -f 'WorldBuilder.Terminal.dll' >/dev/null || {
    echo "[$(date -u +%H:%M:%S)] WBT gone at $S"; exit 0; }
  sleep 10
done
