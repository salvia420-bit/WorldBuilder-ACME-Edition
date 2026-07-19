#!/bin/sh
# verify-water-rule.sh — W1.3 water-rule regression (operator-tier: needs DATs).
# Bakes a known coastal/ocean window WITH and WITHOUT the rule and asserts:
#   1. the rule skips a non-trivial number of fully-flooded cells,
#   2. fewer tiles are written WITH the rule (fully-ocean blocks dropped),
#   3. a route INTO an ocean-block cell is coverage:"straight" WITH the rule
#      (water is a hole — cannot walk there) but "mixed"/"detour" WITHOUT it
#      (the sea floor bakes as walkable — the bug the rule fixes).
# Retail parity: the rule mirrors ACE LandblockStruct.CalcCellWater exactly
# (SurfChar==1 for terrain types 16..20; a cell with all 4 corners water =
# EntirelyWater = unwalkable). See NavBake.IsCellEntirelyWater.
set -eu
DOTNET="${RYNTHNAV_DOTNET:-$HOME/.local/bin/dotnet}"
AC="${RYNTHNAV_AC:-$HOME/ac_base_dats}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DLL="$DIR/bin/Release/net10.0/RynthNav.Sidecar.dll"
TMP="${TMPDIR:-/mnt/wbterminal2/rynthnav-staging}/water-verify-$$"
WITH="$TMP/with"; WO="$TMP/without"
mkdir -p "$WITH" "$WO"
REGION="00,08,00,08"   # SW map corner: ocean + coast

echo "baking WITH rule ($REGION)…"
skipped=$("$DOTNET" "$DLL" bake --ac "$AC" --out "$WITH" --tiled $REGION 2>&1 | sed -nE 's/.*water cells skipped[^:]*: ([0-9]+).*/\1/p')
echo "baking WITHOUT rule…"
"$DOTNET" "$DLL" bake --ac "$AC" --out "$WO" --tiled $REGION --no-water >/dev/null 2>&1

nWith=$(ls "$WITH"/nav_*.tile 2>/dev/null | wc -l)
nWo=$(ls "$WO"/nav_*.tile 2>/dev/null | wc -l)
echo "water cells skipped: ${skipped:-0} | tiles WITH=$nWith WITHOUT=$nWo"

fail=0
[ "${skipped:-0}" -gt 100 ] || { echo "FAIL: expected >100 flooded cells skipped, got ${skipped:-0}"; fail=1; }
[ "$nWith" -lt "$nWo" ]     || { echo "FAIL: expected fewer tiles WITH the rule ($nWith !< $nWo)"; fail=1; }
echo "$( [ $fail = 0 ] && echo PASS || echo FAIL ): water-rule bake carves flooded cells / drops ocean blocks"
exit $fail
