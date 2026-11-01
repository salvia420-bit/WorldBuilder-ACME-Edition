#!/bin/sh
# Copy the canonical HBV1 fixtures (and the flight-model golden file) into ACE's test project, or --check that the
# copies are identical. Canonical = this folder (generated from vehicles.protocol.xml by gen_fixtures.py).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ACE_TESTS=${ACE_TESTS:-/home/wbterminal/ace-server/Source/ACE.Server.Tests/Vehicles}
GOLDEN="$HERE/../flight/flight-golden.json"
mkdir -p "$ACE_TESTS"
for f in "$HERE/vehicle-wire-fixtures.json" "$GOLDEN"; do
  [ -f "$f" ] || continue
  dst="$ACE_TESTS/$(basename "$f")"
  if [ "$1" = "--check" ]; then
    cmp -s "$f" "$dst" && echo "ok   $(basename "$f")" || { echo "STALE $(basename "$f") (run sync-ace-fixtures.sh)"; exit 1; }
  else
    cp "$f" "$dst" && echo "copied $(basename "$f") -> $ACE_TESTS"
  fi
done
