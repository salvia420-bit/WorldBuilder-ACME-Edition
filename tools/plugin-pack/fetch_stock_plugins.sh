#!/usr/bin/env bash
# fetch_stock_plugins.sh — fetch the STOCK upstream Chorizite plugins the pack ships
# alongside ours (RmlUi + its Lua dependency), into external/chorizite-plugins/.
#
# WHY A SCRIPT AND NOT COMMITTED BLOBS
#   `external/*` is gitignored (see .gitignore) — every vendored upstream tree in this
#   repo lives there untracked, and `external/chorizite/` already works exactly this way.
#   Committing ~17 MB of somebody else's signed release binaries would also make the
#   licence audit harder, not easier: what an auditor needs is the URL, the version and
#   the digest, which is what this script pins. Re-running it is the reproduction step.
#
# PROVENANCE — every URL and digest below was read from the same index the Chorizite
# runtime itself uses at run time
# (external/chorizite/Chorizite/Chorizite.Core/Plugins/PluginManager.cs:108,126):
#     https://chorizite.github.io/plugin-index/index.json
#     https://chorizite.github.io/plugin-index/plugins/RmlUi.json
#     https://chorizite.github.io/plugin-index/plugins/Lua.json
# The SHA-256s are the index's OWN published digests, verified byte-for-byte against the
# downloaded archives on 2026-08-25. They are NOT hashes we computed and then declared.
#
# These are UNMODIFIED upstream release archives. We never hand-author their manifest.json
# — the id/version/dependencies each folder declares are upstream's, which is the whole
# point (PluginManager matches dependency ids case-insensitively at PluginManager.cs:197).
#
# usage: fetch_stock_plugins.sh [--dest <dir>] [--verify-only]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST="$REPO/external/chorizite-plugins"
VERIFY_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2;;
    --verify-only) VERIFY_ONLY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "== $*"; }

# id | version | url | sha256   (sha256 = the plugin index's published digest)
PLUGINS=(
"RmlUi|0.0.10|https://github.com/Chorizite/RmlUiPlugin/releases/download/release/0.0.10/Chorizite.Plugins.RmlUi.0.0.10.zip|44cbc9a7006278502d28276533c6fceaef2d79fd563d181cc90b3a0301441850"
"Lua|0.0.13|https://github.com/Chorizite/LuaPlugin/releases/download/release/0.0.13/Chorizite.Plugins.Lua.0.0.13.zip|885e7530edc07539365fa97fffb72b8fd1fb3f809d77b83f768980cf5e25a9c8"
)

# Which version of RmlUi? 0.0.10, not the index's newest 0.0.11, because AcmeRedline
# COMPILES against Chorizite.Plugins.RmlUi 0.0.10 (AcmeRedline/AcmeRedline.csproj
# PackageReference). Ship the assembly we built against.

verify_folder() { # <dir> <expected-id> <expected-version>
  local d="$1" id="$2" ver="$3"
  [ -f "$d/manifest.json" ] || die "$d has no manifest.json — a nupkg's lib/ folder is NOT a loadable plugin"
  python3 - "$d/manifest.json" "$id" "$ver" <<'PY' || die "$d/manifest.json does not declare id=$id version=$ver"
import json, sys
m = json.load(open(sys.argv[1]))
ok = m.get("id", "").lower() == sys.argv[2].lower() and m.get("version") == sys.argv[3]
ok = ok and m.get("entryfile")
sys.exit(0 if ok else 1)
PY
  local entry; entry=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['entryfile'])" "$d/manifest.json")
  [ -f "$d/$entry" ] || die "$d/manifest.json names entryfile '$entry' which is not present"
}

if [ "$VERIFY_ONLY" = 1 ]; then
  say "verify-only: $DEST"
  for row in "${PLUGINS[@]}"; do
    IFS='|' read -r id ver url sha <<<"$row"
    verify_folder "$DEST/$id" "$id" "$ver"
    echo "   $id $ver OK ($(find "$DEST/$id" -type f | wc -l) files)"
  done
  exit 0
fi

command -v curl >/dev/null || die "curl not found"
command -v unzip >/dev/null || die "unzip not found"

mkdir -p "$DEST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

for row in "${PLUGINS[@]}"; do
  IFS='|' read -r id ver url sha <<<"$row"
  say "$id $ver"
  zip="$TMP/$id.zip"
  curl -fsSL --max-time 300 -o "$zip" "$url" || die "download failed: $url"
  got=$(sha256sum "$zip" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || die "sha256 mismatch for $id: expected $sha got $got"
  echo "   sha256 OK  $sha"

  rm -rf "$DEST/$id"
  mkdir -p "$DEST/$id"
  unzip -oq "$zip" -d "$DEST/$id"
  verify_folder "$DEST/$id" "$id" "$ver"
  echo "   -> $DEST/$id  ($(find "$DEST/$id" -type f | wc -l) files)"
done

# Per-file digest manifest, so the pack's provenance table can be reproduced without
# re-downloading. Written INTO the (untracked) vendored tree, not into the repo.
( cd "$DEST" && find . -type f ! -name STOCK-PLUGINS.sha256 -print0 | sort -z \
    | xargs -0 sha256sum | sed 's#\./##' > STOCK-PLUGINS.sha256 )
echo "== wrote $DEST/STOCK-PLUGINS.sha256 ($(wc -l < "$DEST/STOCK-PLUGINS.sha256") files)"
echo "== DONE"
