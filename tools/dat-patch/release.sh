#!/usr/bin/env bash
# release.sh — one-command dat-patch release assembly (roadmap §5.5).
#
# Takes an already-BUILT lane export (the bake/import lanes stay per-lane:
# texture_lane.py / terrain_lane.py runs) and drives every structural gate the
# lanes have accumulated, then packages. The IN-CLIENT 1070 gate stays manual —
# tooling proves structure, only the retail client proves render semantics.
#
# usage: release.sh <export-dir> <version-tag>
#   <export-dir> must hold client_portal.dat (+ cell/highres/local copies).
# env: BASE_PORTAL (default ~/ac_base_dats/client_portal.dat)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXPORT="${1:?usage: release.sh <export-dir> <version-tag>}"
TAG="${2:?usage: release.sh <export-dir> <version-tag>}"
BASE="${BASE_PORTAL:-$HOME/ac_base_dats/client_portal.dat}"
PORTAL="$EXPORT/client_portal.dat"
[ -f "$PORTAL" ] || { echo "no client_portal.dat in $EXPORT" >&2; exit 2; }

echo "== fixup (DRW leaf sentinels + arena compaction) =="
python3 "$HERE/texture_lane.py" fixup --root "$EXPORT" --base "$BASE" --patched "$PORTAL"

echo "== polyfix audit (ConstructMesh sides/stip defect) =="
python3 "$HERE/polyfix.py" audit --dat "$PORTAL" | tail -1

echo "== ACE.DatLoader full walk + byte-diff vs retail base =="
DOTNET_ROLL_FORWARD=LatestMajor dotnet "$HERE/AceDatWalk/bin/Release/net8.0/AceDatWalk.dll" \
    "$PORTAL" "$BASE" | tail -2

echo "== strict python b-tree walk =="
python3 /mnt/wbterminal2/btree-fix-agent/strict_btree_walk.py "$PORTAL" | tail -1 | grep -q CLEAN \
    || { echo "strict walk NOT CLEAN" >&2; exit 1; }
echo "VERDICT         : CLEAN"

echo "== package =="
SIZE=$(stat -c%s "$PORTAL")
[ "$SIZE" -lt $((2000*1024*1024)) ] || { echo "portal over 2 GiB ceiling" >&2; exit 1; }
( cd "$EXPORT" && sha256sum client_portal.dat > client_portal.dat.sha256 )
PKG="$EXPORT/../acme-dats-$TAG.tgz"
tar czf "$PKG" -C "$EXPORT" client_portal.dat client_portal.dat.sha256 \
    $( [ -f "$EXPORT/client_cell_1.dat" ] && echo client_cell_1.dat )
sha256sum "$PKG" > "$PKG.sha256"
cat > "$EXPORT/../RELEASE-$TAG-README.txt" << EOF
ACME dat patch $TAG
===================
1. BACK UP your existing client_portal.dat (and client_cell_1.dat if included).
2. Copy the .dat files from this archive into your AC install directory.
3. REQUIRED: merge into your UserPreferences.ini (install dir or Documents):
     [Render]
     EnvironmentTextureDetail=0
     LandscapeTextureDetail=0
   (the boot default halves every texture — without this you see half the patch)
4. Your server must run the same dats (ACE Config.js DatFilesDirectory) or
   DDD must be off with matched iterations.
sha256: $(cut -d' ' -f1 "$EXPORT/client_portal.dat.sha256")
EOF
echo "packaged: $PKG"
echo "REMINDER: the 1070 in-client gate (entry + soak + tour + eyeball) is still"
echo "mandatory before announcing — see docs/dat-patch/1070-acclient-driving.md"
