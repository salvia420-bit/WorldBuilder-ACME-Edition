#!/bin/sh
# Build the unified RynthBrain .NET-wasm AppBundle and stage it at ./AppBundle
# (gitignored, like pkg/ for the Rust wasm — serve.py serves the live tree).
# Usage: ./build.sh   (~30-60 s incremental; single-project, memory-safe on this laptop)
set -eu
cd "$(dirname "$0")"
DOTNET="${DOTNET:-$HOME/.local/bin/dotnet}"
ART=/tmp/netbrain-art
env DOTNET_ROLL_FORWARD=LatestMajor "$DOTNET" publish RynthBrain.Wasm.csproj -c Release --artifacts-path "$ART"
SRC="$ART/bin/RynthBrain.Wasm/release_browser-wasm/AppBundle"
[ -d "$SRC" ] || { echo "AppBundle not found at $SRC" >&2; exit 1; }
# Rename-only swap: a live page mid-load sees either the old bundle or the
# new one, never a half-deleted directory. Per-PID staging dir so concurrent
# builds can't interleave a mixed-version bundle.
STAGE="AppBundle.new.$$"
rm -rf "$STAGE"
cp -r "$SRC" "$STAGE"
if [ -d AppBundle ]; then mv AppBundle "AppBundle.old.$$"; fi
mv "$STAGE" AppBundle
rm -rf "AppBundle.old.$$" AppBundle.new
echo "staged $(du -sh AppBundle | cut -f1) -> $(pwd)/AppBundle"
