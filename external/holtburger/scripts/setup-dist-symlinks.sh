#!/usr/bin/env bash
# setup-dist-symlinks.sh — ensure the single dist binding + validate baked layers.
#
# HISTORY / WHY THIS IS NOW A THIN WRAPPER
# ----------------------------------------
# This script used to hand-create a FAN-OUT of per-output symlinks
# (dist/{spawns,scenery,events} -> /mnt/wbterminal1/holtburger-dist-v2/...) on top
# of the outer dist -> /mnt/wbterminal2 symlink. Four machine-local, uncommitted,
# cross-drive symlinks. A single forgotten one silently 404'd a whole data layer
# (scenery vanished this way more than once), because the renderer treats a
# per-landblock 404 as "0 placements here".
#
# That fan-out is GONE. The baked layers are now consolidated as REAL dirs under
# one canonical root ($HOLTBURGER_DIST, default /mnt/wbterminal2/holtburger-dist),
# so only the single `external/holtburger/dist` symlink is needed — and creating
# it + validating that every layer is present is exactly what `serve.py` does on
# startup. This script just forwards to it so old muscle-memory / CI invocations
# keep working.
#
# USAGE
#   scripts/setup-dist-symlinks.sh            # create/repair the dist symlink + validate (exit 1 if a layer is missing)
#   scripts/setup-dist-symlinks.sh --check    # same (serve.py --check never starts a server)
#   scripts/setup-dist-symlinks.sh --allow-missing   # create the symlink but don't fail on absent layers
#
# ENV
#   HOLTBURGER_DIST   canonical baked-data root (default /mnt/wbterminal2/holtburger-dist)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `--check` is the default and only mode (serve.py --check ensures the symlink and
# validates without serving); drop it from the forwarded args so it isn't doubled,
# but pass through everything else (e.g. --allow-missing).
args=()
for a in "$@"; do
  [ "$a" = "--check" ] && continue
  args+=("$a")
done

exec python3 "$SCRIPT_DIR/serve.py" --check "${args[@]+"${args[@]}"}"
