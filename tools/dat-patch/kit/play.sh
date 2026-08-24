#!/bin/sh
# play.sh - Linux/Wine twin of play.bat: fresh-install loud-fail, then launch.
# Same refusal rules as play.bat: every dat present at its kit-manifest size AND
# acclient.exe carrying the ACME patch set - an unpatched exe never mounts
# client_highres.dat, which after the HIFI split means silently missing textures.
# Run from your Asheron's Call install folder:
#   ./play.sh -h <server> -p 9000 -a <account> -v <password> -rodat
# ALL arguments are passed to acclient.exe verbatim (play.bat behaviour; add
# -rodat yourself as the install guide shows). Env:
#   WINEPREFIX  wine prefix       (default: ~/acwine)
#   WINE        wine binary       (default: wine)
#   ACME_KIT_CHECK_ONLY=1  verify and print KIT-OK, never launch (gate/CI mode)
set -eu
cd "$(dirname "$0")"

BAD=""
if [ ! -f kit-manifest.txt ]; then
    echo "LOUD-FAIL: kit-manifest.txt is missing - this install is incomplete. Re-download the kit." >&2
    exit 1
fi
while IFS='|' read -r name size; do
    name=$(printf '%s' "$name" | tr -d '\r'); size=$(printf '%s' "$size" | tr -d '\r')
    [ -n "$name" ] || continue
    if [ ! -f "$name" ]; then BAD="$BAD$name missing; "; continue; fi
    actual=$(stat -c%s "$name" 2>/dev/null || stat -f%z "$name")
    [ "$actual" = "$size" ] || BAD="$BAD$name wrong size $actual expected $size; "
done < kit-manifest.txt
if [ -n "$BAD" ]; then
    echo "LOUD-FAIL: this install is incomplete - the game will NOT start." >&2
    echo "  Problem: $BAD" >&2
    echo "  Re-download the kit or restore the named files." >&2
    exit 1
fi

# Exe patch state - mirrors play.bat: the check runs only when the patcher script
# is present; a failed check refuses with the patcher's own output shown.
if [ -f acme-patch-client.py ]; then
    if [ ! -f acclient.exe ]; then
        echo "LOUD-FAIL: acclient.exe is missing - copy the ACME kit files into your" >&2
        echo "  Asheron's Call install folder; don't run them from the download folder." >&2
        exit 1
    fi
    if command -v python3 >/dev/null 2>&1; then
        if ! VOUT=$(python3 acme-patch-client.py --verify 2>&1); then
            echo "LOUD-FAIL: your acclient.exe is not patched for this release - run" >&2
            echo "  python3 acme-patch-client.py   once, then start the game again." >&2
            echo "  Without the patch the client never loads client_highres.dat and most" >&2
            echo "  textures would be missing. Patcher output:" >&2
            printf '%s\n' "$VOUT" | sed 's/^/    /' >&2
            exit 1
        fi
    else
        # play.bat's spirit: if the check tool cannot run, proceed - but loudly.
        echo "WARNING: python3 not found - CANNOT verify the client patch. If textures" >&2
        echo "  are missing in-game, install python3 and run: python3 acme-patch-client.py" >&2
    fi
fi

if [ "${ACME_KIT_CHECK_ONLY:-}" = "1" ]; then
    echo "KIT-OK"
    exit 0
fi
WINEPREFIX="${WINEPREFIX:-$HOME/acwine}"
export WINEPREFIX
exec "${WINE:-wine}" acclient.exe "$@"
