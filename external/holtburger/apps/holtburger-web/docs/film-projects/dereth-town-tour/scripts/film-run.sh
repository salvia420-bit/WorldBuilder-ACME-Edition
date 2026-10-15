#!/usr/bin/env bash
# Runs the film CLI with FILM_PASSWORD read at run time from the repo script that owns it (never printed/stored).
set -euo pipefail
HB=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
SRC=/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/net-review/walk-bake-probe.mjs
FILM_PASSWORD="$(sed -n 's/.*account: "phase4demo", password: "\([^"]*\)".*/\1/p' "$SRC" | head -1)"
[ -n "$FILM_PASSWORD" ] || { echo "film-run: could not read the film account password" >&2; exit 2; }
export FILM_PASSWORD
cd "$HB"
exec node --no-warnings tools/film/film.mjs "$@"
