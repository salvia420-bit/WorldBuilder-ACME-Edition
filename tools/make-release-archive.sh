#!/usr/bin/env bash
# make-release-archive.sh — combine the dat kit + the plugin pack into THE release archive.
#
#   make-release-archive.sh --kit <kit-dir> --plugins <pack-dir> --tag <tag> --out <dir> [--package]
#
# Layout (the single archive players download):
#   <out>/acme-<tag>/
#     ├─ <every kit file at the ROOT>      # INSTALL-WINDOWS "copy every file into your
#     │                                    # install folder" contract stays true
#     ├─ acme-plugins/                     # the optional plugin pack, as a subfolder
#     ├─ INSTALL-WINDOWS.md                # S1: both install guides ride at the root —
#     ├─ INSTALL-LINUX-WINE.md             # they document BOTH halves, so they belong to
#     │                                    # the combined archive, not to either assembler
#     ├─ README.txt                        # the KIT readme + an appended plugin-pack section
#     └─ SHA256SUMS.txt                    # ONE unified sums file over everything (see below)
#
# SHA256SUMS policy (documented decision): the ROOT SHA256SUMS.txt is regenerated
# over the ENTIRE archive and REPLACES the kit's root-level sums file (it is a
# strict superset, so the kit README's "SHA256SUMS.txt" pointer stays true and
# `sha256sum -c` still verifies every kit file). The plugin pack KEEPS its own
# SHA256SUMS.txt inside acme-plugins/ — that half is also distributed standalone
# and its provenance doc references its internal sums.
set -euo pipefail

KIT=""; PLUGINS=""; TAG=""; OUT=""; PACKAGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kit) KIT="$2"; shift 2;;
    --plugins) PLUGINS="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --package) PACKAGE=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$KIT" ] && [ -n "$PLUGINS" ] && [ -n "$TAG" ] && [ -n "$OUT" ] || {
  echo "usage: make-release-archive.sh --kit <kit-dir> --plugins <pack-dir> --tag <tag> --out <dir> [--package]" >&2; exit 2; }
[ -d "$KIT" ] || { echo "no such kit dir: $KIT" >&2; exit 2; }
[ -d "$PLUGINS" ] || { echo "no such plugin-pack dir: $PLUGINS" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/.." && pwd)"
die() { echo "FATAL: $*" >&2; exit 1; }

# preconditions: both halves verify against their OWN sums before we combine
echo "== pre-verify both halves"
( cd "$KIT" && sha256sum -c --quiet SHA256SUMS.txt ) || die "kit fails its own SHA256SUMS"
( cd "$PLUGINS" && sha256sum -c --quiet SHA256SUMS.txt ) || die "plugin pack fails its own SHA256SUMS"
echo "   both halves verify clean"

ARCH="$OUT/acme-$TAG"
echo "== archive dir: $ARCH"
rm -rf "$ARCH"; mkdir -p "$ARCH"

echo "== kit files -> archive root"
cp -a "$KIT/." "$ARCH/"
rm -f "$ARCH/SHA256SUMS.txt"          # replaced by the unified root sums (see header)

echo "== plugin pack -> acme-plugins/"
mkdir -p "$ARCH/acme-plugins"
cp -a "$PLUGINS/." "$ARCH/acme-plugins/"

echo "== install guides -> archive root (S1)"
cp -f "$REPO/docs/install/INSTALL-WINDOWS.md" "$ARCH/INSTALL-WINDOWS.md"
cp -f "$REPO/docs/install/INSTALL-LINUX-WINE.md" "$ARCH/INSTALL-LINUX-WINE.md"

echo "== README.txt (append the plugin-pack section to the KIT readme - never clobber it)"
# B2 decision: the kit README carries load-bearing install steps (the VeryHigh
# recipe, rollback, server notes). The wrapper only APPENDS a clearly-delimited
# optional-plugin-pack section; CRLF+ASCII to match the kit text gate.
python3 - "$ARCH/README.txt" <<'PY2'
import sys
p = sys.argv[1]
d = open(p, "rb").read().decode("ascii")
assert "VeryHigh" in d, "kit README lost its VeryHigh recipe?!"
extra = """
==========================================================================
OPTIONAL: THE ACME PLUGIN PACK  [acme-plugins folder in this archive]
==========================================================================
  Modern lighting/bloom, a volumetric sky, ragdoll deaths, the Redline
  annotation tool, and the zzpatcher control panel (GUI + command line).
  ENTIRELY OPTIONAL - the dats above work fine without it.

  The acme-plugins folder does NOT go into the game folder: copy it
  anywhere you like and read section 4 of INSTALL-WINDOWS.md (in this
  archive) - INSTALL-LINUX-WINE.md covers wine, where the supported
  posture is the plain client.
"""
bad = sorted({c for c in extra if ord(c) > 127}); assert not bad, bad
open(p, "wb").write((d.rstrip("\r\n") + "\r\n" + extra.replace("\n", "\r\n") + "\r\n").encode("ascii"))
PY2

# B2 verify: the archive README must carry BOTH the kit recipe and the pack note
grep -q "VeryHigh" "$ARCH/README.txt" || die "archive README lost the VeryHigh recipe"
grep -q "acme-plugins" "$ARCH/README.txt" || die "archive README lacks the plugin-pack note"
echo "   kit README preserved + plugin-pack section appended (VeryHigh + acme-plugins verified)"

echo "== internal-leak gate (archive root text files)"
if grep -lEI '/mnt/|/home/|buildbox|wbterminal' "$ARCH"/*.md "$ARCH"/*.txt 2>/dev/null; then
  die "internal path/host leaked into archive-root text (files above)"
fi
echo "   clean"

echo "== unified SHA256SUMS.txt (root, over everything)"
( cd "$ARCH" && find . -type f ! -path ./SHA256SUMS.txt -print0 | sort -z \
  | xargs -0 sha256sum | sed 's#\./##' > SHA256SUMS.txt )
( cd "$ARCH" && sha256sum -c --quiet SHA256SUMS.txt ) || die "unified sums re-verify failed"
NF=$(find "$ARCH" -type f | wc -l); SZ=$(du -sh "$ARCH" | cut -f1)
echo "   $NF files, $SZ, sums re-verified"

if [ "$PACKAGE" = 1 ]; then
  TARZ="gzip -1"; command -v pigz >/dev/null && TARZ="pigz -1"
  PKG="$OUT/acme-$TAG.tgz"
  echo "== package -> $PKG"
  tar -I "$TARZ" -cf "$PKG" -C "$OUT" "acme-$TAG"
  sha256sum "$PKG" | sed "s#$OUT/##" > "$PKG.sha256"
  ls -l "$PKG"; cat "$PKG.sha256"
  if command -v zip >/dev/null; then
    ZPKG="$OUT/acme-$TAG.zip"
    echo "== package -> $ZPKG"
    ( cd "$OUT" && zip -1 -r -q "acme-$TAG.zip" "acme-$TAG" )
    sha256sum "$ZPKG" | sed "s#$OUT/##" > "$ZPKG.sha256"
    ls -l "$ZPKG"; cat "$ZPKG.sha256"
  else
    echo "   (zip not installed - .zip skipped)" >&2
  fi
fi
echo "== DONE"
