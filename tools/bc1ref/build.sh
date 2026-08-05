#!/bin/sh
# Build bc1ref. The BINARY is gitignored (bin/ + obj/); the sources here are
# committed, so this is the one step a fresh clone needs before running the
# render-surface-import round-trip comparers:
#   /mnt/wbterminal2/pbr-terrain/bake/full/decode_compare_full.py
#   /mnt/wbterminal2/pbr-terrain/bake/agentL/decode_compare.py
# Both default to the path this produces and honour BC1REF_DLL to override.
#
# Named as a file rather than a README line for the same reason bc7cli got one:
# the previous copy of this tool lived in a session scratchpad, the scratchpad
# was reaped, and both comparers were silently broken from then until
# 2026-08-05 because nothing runs them on a schedule.
set -eu
cd "$(dirname "$0")"
DOTNET_ROLL_FORWARD=LatestMajor dotnet build -c Release .
echo "built: $(pwd)/bin/Release/net8.0/bc1ref.dll"
