#!/usr/bin/env bash
# build_kit_with_meta.sh -- assemble an ACME kit AND drop the AcmeRedline
# plugin sidecar (acme-meta.json) into it, WITHOUT editing assemble_kit.sh.
#
# This is a thin wrapper: it calls the existing tools/dat-patch/kit/assemble_kit.sh
# UNCHANGED with every argument you pass, then runs gen_kit_meta.py against the
# dats the kit actually shipped (the copies inside the produced kit dir, so the
# sidecar's shas match SHA256SUMS.txt). The kit build is the source of truth for
# where things land; this script only adds a file next to them.
#
# usage: build_kit_with_meta.sh --tag <tag> --portal <dat> [--highres <dat>] \
#                               [--cell <dat>] --out <dir> [--package] [assemble args...]
#
# Every flag is forwarded verbatim to assemble_kit.sh; --tag and --out are also
# read here so we can find the produced kit dir ($OUT/acme-$TAG) afterwards.
#
# Fail-loud: if assemble_kit.sh exits nonzero we stop before touching meta; if
# gen_kit_meta.py fails the whole script fails (a kit without its sidecar is a
# kit the plugin cannot pre-flight against).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ASSEMBLE="$HERE/../kit/assemble_kit.sh"
GENMETA="$HERE/gen_kit_meta.py"

[ -f "$ASSEMBLE" ] || { echo "assemble_kit.sh not found at $ASSEMBLE" >&2; exit 2; }
[ -f "$GENMETA" ]  || { echo "gen_kit_meta.py not found at $GENMETA" >&2; exit 2; }

# Pull --tag / --out / --highres out of the args WITHOUT consuming them: they are
# still forwarded to assemble_kit.sh in full.
TAG=""; OUT=""; HIGHRES=""
args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    --tag)     TAG="${args[$((i+1))]}"; i=$((i+2));;
    --out)     OUT="${args[$((i+1))]}"; i=$((i+2));;
    --highres) HIGHRES="${args[$((i+1))]}"; i=$((i+2));;
    *) i=$((i+1));;
  esac
done
[ -n "$TAG" ] && [ -n "$OUT" ] || {
  echo "usage: build_kit_with_meta.sh --tag <tag> --portal <dat> [--highres <dat>] --out <dir> [assemble args...]" >&2
  exit 2; }

echo "== [1/2] assemble_kit.sh (unchanged) =="
bash "$ASSEMBLE" "$@"

KIT="$OUT/acme-$TAG"
[ -d "$KIT" ] || { echo "expected kit dir not found: $KIT" >&2; exit 1; }
[ -f "$KIT/client_portal.dat" ] || { echo "kit has no client_portal.dat: $KIT" >&2; exit 1; }

echo
echo "== [2/2] gen_kit_meta.py -> $KIT/acme-meta.json =="
META_ARGS=(--tag "acme-$TAG" --portal "$KIT/client_portal.dat" --out "$KIT/acme-meta.json")
if [ -n "$HIGHRES" ] && [ -f "$KIT/client_highres.dat" ]; then
  META_ARGS+=(--highres "$KIT/client_highres.dat")
fi
python3 "$GENMETA" "${META_ARGS[@]}"

# Fold the sidecar into the kit's own checksum manifest so a tampered/renamed
# meta is caught by `sha256sum -c SHA256SUMS.txt` like every other kit file.
# (assemble_kit.sh wrote SHA256SUMS.txt before this file existed; we append.)
if [ -f "$KIT/SHA256SUMS.txt" ]; then
  ( cd "$KIT" && sha256sum acme-meta.json >> SHA256SUMS.txt )
  echo "   added acme-meta.json to SHA256SUMS.txt"
fi

echo
echo "KIT + META READY: $KIT"
echo "  acme-meta.json is the plugin sidecar (terrainProtectedRs[], paletteRouteRs[],"
echo "  portalSha256, highresSha256). See docs/redline/DESIGN.md section 9 for the"
echo "  proposed inline assemble_kit.sh hook if you would rather not wrap."
