#!/usr/bin/env bash
# assemble_kit.sh — build a shippable ACME kit directory from BUILT dat artifacts.
#
# The r8 kit is the first release where the dats alone are not sufficient: after
# the HIFI split the superseded texture records live in client_highres.dat, which
# only a patched client mounts. So the kit ships, alongside the dats:
#   * acme-patch-client.ps1 + patch-my-client.bat — the player patches their OWN
#     retail acclient.exe (no client bytes are redistributed: community norm,
#     docs/dat-patch/community-norms.md);
#   * play.bat + kit-manifest.txt — the fresh-install loud-fail gate (mechanism B,
#     DESIGN-fresh-install-loud-fail-2026-08-19.md): refuses to launch on a
#     missing/short dat or an unpatched exe, rather than rendering silently
#     broken textures.
#
# usage: assemble_kit.sh --tag r8 --portal <dat> --highres <dat> --cell <dat> \
#                        --out <dir> [--package] [--no-verify]
# The script is fail-loud: every copy is sha256-verified, the manifest is
# re-checked with play.bat's own rule, and any mismatch aborts nonzero.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

TAG=""; PORTAL=""; HIGHRES=""; CELL=""; OUT=""; PACKAGE=0; VERIFY=1
SHIPPED_EXE="${SHIPPED_EXE:-/mnt/wbterminal2/ac-eor-patch/acclient.eor.patched.exe}"
RETAIL_EXE="${RETAIL_EXE:-/mnt/wbterminal2/ac-eor-patch/acclient.eor.orig.exe}"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --portal) PORTAL="$2"; shift 2;;
    --highres) HIGHRES="$2"; shift 2;;
    --cell) CELL="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --package) PACKAGE=1; shift;;
    --no-verify) VERIFY=0; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$TAG" ] && [ -n "$PORTAL" ] && [ -n "$OUT" ] || {
  echo "usage: assemble_kit.sh --tag <tag> --portal <dat> [--highres <dat>] [--cell <dat>] --out <dir> [--package]" >&2
  exit 2; }
for f in "$PORTAL" ${HIGHRES:+"$HIGHRES"} ${CELL:+"$CELL"}; do
  [ -f "$f" ] || { echo "missing input: $f" >&2; exit 2; }
done

# PRECONDITION: the kit's patcher carries a hand-copied table of the (untracked)
# patch registry. Gate it before anything is copied — a drifted table would ship
# either an ungated byte change or an exe that isn't the one we gated in-client.
if [ "$VERIFY" = 1 ]; then
  echo "== patcher table + artifact parity (check_ps1_table.py)"
  python3 "$HERE/check_ps1_table.py" | sed 's/^/   /' || {
    echo "PATCHER GATE FAILED — refusing to assemble a kit" >&2; exit 1; }
fi

KIT="$OUT/acme-$TAG"
echo "== kit dir: $KIT"
mkdir -p "$KIT"

copy_in() {   # <src> <dest-name>
  local src="$1" name="$2"
  local sz; sz=$(stat -c%s "$src")
  echo "-- $name  ($(numfmt --to=iec --format='%.1f' "$sz"), $sz B)"
  cp -f "$src" "$KIT/$name"
  if [ "$VERIFY" = 1 ]; then
    local a b
    a=$(sha256sum "$src" | cut -d' ' -f1)
    b=$(sha256sum "$KIT/$name" | cut -d' ' -f1)
    [ "$a" = "$b" ] || { echo "COPY MISMATCH for $name ($a != $b)" >&2; exit 1; }
    echo "   sha256 $a (copy verified)"
  fi
}

copy_in "$PORTAL" client_portal.dat
[ -n "$HIGHRES" ] && copy_in "$HIGHRES" client_highres.dat
[ -n "$CELL" ] && copy_in "$CELL" client_cell_1.dat

echo "== launcher + patcher"
for f in play.bat patch-my-client.bat acme-patch-client.ps1 acme-patch-client.py; do
  cp -f "$HERE/$f" "$KIT/$f"
  echo "-- $f"
done

echo "== kit-manifest.txt (play.bat reads this: <file>|<exact size>)"
: > "$KIT/kit-manifest.txt"
for name in client_portal.dat client_highres.dat client_cell_1.dat; do
  [ -f "$KIT/$name" ] || continue
  printf '%s|%s\r\n' "$name" "$(stat -c%s "$KIT/$name")" >> "$KIT/kit-manifest.txt"
done
sed -e 's/\r$//' "$KIT/kit-manifest.txt" | sed 's/^/   /'

# The exe the player ends up with (we ship the delta, not the binary) — quoted in
# the README so anyone can audit their patched client against the gated artifact.
PATCHED_SHA="(unknown)"; RETAIL_SHA="(unknown)"
[ -f "$SHIPPED_EXE" ] && PATCHED_SHA=$(sha256sum "$SHIPPED_EXE" | cut -d' ' -f1)
[ -f "$RETAIL_EXE" ] && RETAIL_SHA=$(sha256sum "$RETAIL_EXE" | cut -d' ' -f1)

PSZ=$(stat -c%s "$KIT/client_portal.dat")
HSZ=$([ -f "$KIT/client_highres.dat" ] && stat -c%s "$KIT/client_highres.dat" || echo 0)
CSZ=$([ -f "$KIT/client_cell_1.dat" ] && stat -c%s "$KIT/client_cell_1.dat" || echo 0)

echo "== README.txt"
cat > "$KIT/README.txt" <<EOF
ACME dat patch $TAG - Asheron's Call high-resolution texture set
================================================================

This package patches an Asheron's Call install you already own. It contains no
retail files and no game executable: the dats here are derived from your own
client's content, and the client patch is applied to your own acclient.exe.

WHAT'S IN THE BOX
  client_portal.dat        $(numfmt --to=iec --format='%.1f' "$PSZ") ($PSZ bytes)
  client_highres.dat       $(numfmt --to=iec --format='%.1f' "$HSZ") ($HSZ bytes)   <- REQUIRED, see below
  client_cell_1.dat        $(numfmt --to=iec --format='%.1f' "$CSZ") ($CSZ bytes)
  play.bat                 start the game, checks the install first  [Windows]
  patch-my-client.bat      one-time client patch, run once           [Windows]
  acme-patch-client.ps1    the patch itself - plain text, auditable  [Windows]
  acme-patch-client.py     the same patch + install check            [Linux/wine]
  kit-manifest.txt         file sizes the launcher verifies
  SHA256SUMS.txt           checksums for everything above

INSTALL
  1. BACK UP your existing client_portal.dat, client_cell_1.dat and acclient.exe.
     (patch-my-client.bat also keeps its own backup, acclient.exe.acme-orig.bak.)
  2. Copy every file from this archive into your Asheron's Call install folder.
  3. Run patch-my-client.bat once. It patches YOUR acclient.exe in place and
     refuses to touch anything if it doesn't recognise the file.
  4. In your UserPreferences.ini (install folder or Documents), set these two
     keys in the [Render] section - spell the words out, do NOT use numbers:
         [Render]
         EnvironmentTextureDetail=VeryHigh
         LandscapeTextureDetail=VeryHigh
     A NUMBER here is read as a worst-first list index: =0 selects VeryLow
     (quarter detail), the opposite of what it looks like. The boot default is
     only Medium - without VeryHigh you see a fraction of the patch. Edit the
     two keys in your existing ini; do not replace the whole file (it holds your
     keybinds and audio).
  5. Start the game with play.bat (not acclient.exe directly).

ON LINUX / macOS / WINE
  Steps 1, 2 and 4 are the same. Instead of steps 3 and 5:
     python3 acme-patch-client.py              patches your acclient.exe once
     python3 acme-patch-client.py --check-kit  before you play: verifies the
                                               dats and the client patch
  then launch acclient.exe through wine the way you normally do.

IF YOU USE ANOTHER LAUNCHER (ThwargLauncher, Decal, a shortcut...)
  Those start acclient.exe directly, so the install check never runs. The game
  will still start - but if client_highres.dat is missing or the client is not
  patched, textures are silently absent instead of erroring. Run play.bat, or
  acme-patch-client.py --check-kit, once after installing to confirm the kit is
  complete - and again after any client re-install or file verification, which
  will overwrite your patched acclient.exe.

WHY client_highres.dat IS REQUIRED
  This release moves the upgraded textures out of client_portal.dat into
  client_highres.dat, which keeps the portal well under its 2 GiB format
  ceiling and leaves room for future content. The retail client only mounts
  client_highres.dat when patched, and if the file is missing it carries on
  silently with textures absent. So: both dats, and the client patch. play.bat
  checks all three and refuses to start rather than let you play a broken install.

WHAT THE CLIENT PATCH DOES (9 logical patches, all documented in the .ps1)
  * palette leak + double-free fix (3 sites) - the community leak fix plus the
    mandatory third site; without it the client corrupts its heap at world entry.
  * DAT version-preserve - lets the client read compressed dat records.
  * high-res mount + advertise cap - mounts client_highres.dat, and does NOT
    advertise it to servers that never asked for it (your server sees the same
    three dats retail does, so it will not try to patch you).
  * 4K resolution unlock (2 sites) - UI resize clamps removed.
  * DAT parser alignment (dat-align-lfa, 189 sites, one logical patch) - fixes
    the client's unaligned DAT reads so dat files past 2 GB parse correctly.
  Retail acclient.exe   sha256 $RETAIL_SHA
  After patching        sha256 $PATCHED_SHA

SERVERS
  Your server must serve these same dats (ACE: DatFilesDirectory) or have DDD
  turned off. The portal keeps retail's iteration record, so a vanilla server
  answers "no update required" and leaves your files alone.

ROLLBACK
  Restore your backed-up client_portal.dat / client_cell_1.dat, delete
  client_highres.dat, and copy acclient.exe.acme-orig.bak back over acclient.exe.
  Both patchers keep that backup the first time they run.

Each ACME release is self-contained - you can install it over retail or over an
earlier ACME release; it is not a delta.
EOF
# Windows text files: CRLF, and ASCII only (old Notepad and a non-UTF8
# console both mangle typographic punctuation).
python3 - "$KIT/README.txt" <<'PY'
import sys
p = sys.argv[1]
d = open(p, encoding="utf-8").read()
d = d.replace("\u2014", "-").replace("\u2013", "-").replace("\u2026", "...").replace("\u2019", "'")
bad = sorted({c for c in d if ord(c) > 127})
assert not bad, f"non-ASCII left in README: {bad}"
open(p, "wb").write(d.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii"))
PY
sed 's/^/   | /' "$KIT/README.txt" | head -12

echo "== SHA256SUMS.txt"
( cd "$KIT" && sha256sum client_portal.dat \
    $( [ -f client_highres.dat ] && echo client_highres.dat ) \
    $( [ -f client_cell_1.dat ] && echo client_cell_1.dat ) \
    play.bat patch-my-client.bat acme-patch-client.ps1 acme-patch-client.py kit-manifest.txt \
    README.txt > SHA256SUMS.txt )
cut -c1-8,66- "$KIT/SHA256SUMS.txt" | sed 's/^/   /'

# --- self-gate: play.bat's own rule, run here so a broken kit never ships ----
if [ "$VERIFY" = 1 ]; then
  echo "== self-gate (play.bat manifest rule, emulated)"
  rc=0
  while IFS='|' read -r name size; do
    name=${name%$'\r'}; size=${size%$'\r'}
    [ -n "$name" ] || continue
    if [ ! -f "$KIT/$name" ]; then echo "   MISSING $name"; rc=1; continue; fi
    actual=$(stat -c%s "$KIT/$name")
    if [ "$actual" != "$size" ]; then echo "   SIZE $name $actual != $size"; rc=1; continue; fi
    echo "   ok $name ($size)"
  done < "$KIT/kit-manifest.txt"
  ( cd "$KIT" && sha256sum -c --quiet SHA256SUMS.txt ) || rc=1
  echo "   SHA256SUMS re-check: $([ $rc = 0 ] && echo OK || echo FAIL)"
  [ $rc = 0 ] || { echo "SELF-GATE FAILED" >&2; exit 1; }
  echo "   SELF-GATE PASS"
fi

if [ "$PACKAGE" = 1 ]; then
  PKG="$OUT/acme-$TAG.tgz"
  echo "== package -> $PKG"
  TARZ="gzip -1"; command -v pigz >/dev/null && TARZ="pigz -1"
  tar -I "$TARZ" -cf "$PKG" -C "$OUT" "acme-$TAG"
  sha256sum "$PKG" > "$PKG.sha256"
  ls -l "$PKG"; cat "$PKG.sha256"
  # .zip alongside the .tgz: the kit is Windows-first now (play.bat, the .ps1
  # patcher), and Windows has no built-in tgz. -1 because the payload is dats
  # that are already compressed inside.
  if command -v zip >/dev/null; then
    ZPKG="$OUT/acme-$TAG.zip"
    echo "== package -> $ZPKG"
    ( cd "$OUT" && zip -1 -r -q "acme-$TAG.zip" "acme-$TAG" )
    sha256sum "$ZPKG" > "$ZPKG.sha256"
    ls -l "$ZPKG"; cat "$ZPKG.sha256"
  else
    echo "   zip not installed - skipping the .zip (tgz written)" >&2
  fi
fi

echo
echo "KIT READY: $KIT"
echo "REMINDER: the in-client 1070 gate (fresh-install loud-fail arm + patch-my-client"
echo "arm + world entry) is mandatory before announcing — docs/dat-patch/1070-acclient-driving.md"
