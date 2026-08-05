#!/bin/sh
# Build bc7cli. The binary is gitignored (platform-specific ELF); the sources
# next to it are committed, so this is the one step a fresh clone needs before
# a tex-bc7 / terrain-bc7 bake.
#
# Named explicitly rather than left as a README line because the encoder's
# default path has now died twice by pointing at a session scratchpad
# (docs/HANDOFF-texture-pipeline-2026-08-04.md), and the third failure mode
# would have been a fresh clone finding no binary at all.
set -eu
cd "$(dirname "$0")"
g++ -O2 -o bc7cli bc7cli.cpp bc7enc.cpp lodepng.cpp
echo "built: $(pwd)/bc7cli"
./bc7cli 2>&1 | head -1 || true
