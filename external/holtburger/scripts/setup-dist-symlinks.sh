#!/usr/bin/env bash
# setup-dist-symlinks.sh — (re)create the per-output symlinks that expose the
# large baked data (spawns / scenery / events) under the web-served dist/.
#
# WHY THIS EXISTS
# ---------------
# The big per-landblock bake outputs are staged onto /mnt to keep multiple GB
# off the chronically-full system disk (see the "holtburger bake disk-trap"
# note). The layout is two-level:
#   external/holtburger/dist          -> /mnt/wbterminal2/holtburger-dist  (dat-shard bake: manifest/, shards/ are REAL dirs here)
#   external/holtburger/dist/spawns   -> /mnt/wbterminal1/holtburger-dist-v2/spawns
#   external/holtburger/dist/scenery  -> /mnt/wbterminal1/holtburger-dist-v2/scenery
#   external/holtburger/dist/events   -> /mnt/wbterminal1/holtburger-dist-v2/events
#
# Those per-output symlinks are machine-local (they point at absolute /mnt
# paths) and therefore CANNOT be committed. Pre-2026-05-29 they were created
# by hand, one `ln -s` at a time — and the `scenery` one was simply forgotten,
# so the web app's fail-soft fetch 404'd and ALL outdoor scenery silently
# vanished with no error. `events` was missing the same way. This script makes
# recreating the full set one idempotent command, so a single forgotten symlink
# can't silently drop an entire data layer again. Run it after a fresh
# checkout, after a re-bake, or on any new host.
#
# USAGE
#   scripts/setup-dist-symlinks.sh           # create/repair the symlinks
#   scripts/setup-dist-symlinks.sh --check   # report only; exit 1 if any missing/wrong
#
# ENV
#   HOLTBURGER_DIST_V2   staging root (default /mnt/wbterminal1/holtburger-dist-v2)
#                        mirrors the existing HOLTBURGER_DIST_V2_MANIFEST convention.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/../dist"   # external/holtburger/dist (itself a symlink to /mnt)
STAGE_ROOT="${HOLTBURGER_DIST_V2:-/mnt/wbterminal1/holtburger-dist-v2}"

# Output kinds that live on the staging drive and must be exposed under dist/.
# NOTE: manifest/ and shards/ come from the dat-shard bake on the OTHER drive
# (dist/ -> /mnt/wbterminal2/holtburger-dist) and are real dirs — do NOT list
# them here or the loop would try to clobber them.
KINDS=(spawns scenery events)

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

note() { printf '%s\n' "$*"; }
fail=0

# --- sanity: dist/ must resolve (normally onto /mnt, to dodge the disk-trap) ---
if [ ! -d "$DIST_DIR" ]; then
  note "ERROR: dist dir not found/resolvable at $DIST_DIR"
  note "       dist/ should symlink to /mnt/<drive>/holtburger-dist — see the bake recipe in docs/emit-dynamic-site.md."
  exit 2
fi
resolved_dist="$(readlink -f "$DIST_DIR")"
case "$resolved_dist" in
  /mnt/*) : ;;
  *) note "WARN: dist/ resolves to '$resolved_dist' (not under /mnt) — multi-GB bakes here can fill the system disk." ;;
esac

# --- sanity: staging root must be present (mounted) ---
if [ ! -d "$STAGE_ROOT" ]; then
  note "ERROR: staging root '$STAGE_ROOT' not present — is /mnt/wbterminal1 mounted?"
  note "       Set HOLTBURGER_DIST_V2 to override the staging-root path."
  exit 2
fi

for kind in "${KINDS[@]}"; do
  target="$STAGE_ROOT/$kind"
  link="$DIST_DIR/$kind"

  if [ ! -d "$target" ]; then
    note "skip   $kind   (not staged at $target — nothing to expose)"
    continue
  fi

  # Already a correct symlink → nothing to do.
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    note "ok     $kind   -> $target"
    continue
  fi

  # A real (non-symlink) path is in the way — never clobber baked data.
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    note "WARN   $kind   exists as a REAL path at $link — leaving it untouched (remove by hand if you meant the symlink)."
    fail=1
    continue
  fi

  # Missing, or a symlink pointing at the wrong place.
  if [ "$CHECK_ONLY" = 1 ]; then
    note "MISSING $kind  (would link $link -> $target)"
    fail=1
    continue
  fi
  ln -sfn "$target" "$link"
  note "linked $kind   -> $target"
done

if [ "$CHECK_ONLY" = 1 ] && [ "$fail" = 1 ]; then
  note "--- one or more dist symlinks are missing/wrong; run without --check to repair ---"
  exit 1
fi
note "done."
exit 0
