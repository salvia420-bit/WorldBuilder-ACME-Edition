#!/usr/bin/env bash
# assemble_plugin_pack.sh — build + assemble the shippable ACME plugin pack.
#
# Produces  <out>/acme-plugins-<tag>/  ready to drop into the release archive next
# to the dat kit (assemble_kit.sh builds that half). The pack is the OPTIONAL,
# injection-based half: zzpatcher (the control panel/tuner/patcher-front-end), the
# vendored Chorizite plugin runtime + AcmeInject, the three Acme plugins, and the
# full licence/provenance set the audit requires (LICENSE-AUDIT-2026-08-24.md).
#
# WHAT THIS PACK DOES (and does NOT) w.r.t. "patching":
#   * It ships NO retail client bytes. The *dat* patcher (kit) has the player patch
#     their OWN acclient.exe in place; this plugin pack does not touch the exe at
#     all. Its "patching" is RUNTIME: AcmeInject injects the Chorizite runtime into
#     an already-running client, which installs in-memory hooks; the plugins read
#     the DATs the player already has and overlay lighting/sky/ragdoll behaviour.
#     Nothing here is a persistent binary edit — pull the plugin folder and the
#     client is byte-stock again.
#
# Fail-loud: every copy is sha256-verified, the patcher/knob gates run before any
# copy, and the post-assembly verify pass refuses to emit a pack that violates a
# licence-audit invariant (FASM licence beside every FASM.DLL, acclient.map absent,
# no pdb/xml, NOTICES names Apache-2.0 and never the split licence, SHA256SUMS
# re-verifies clean).
#
# usage: assemble_plugin_pack.sh --tag <tag> --out <dir> [--package] [--no-build]
#   --no-build  assemble from existing Release output without rebuilding (still gated)
#   --package   tar.gz the pack + emit .sha256
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CHORIZITE="$REPO/external/chorizite"
CZ_BIN="$CHORIZITE/Chorizite/bin/net8.0"
NUGET="$HOME/.nuget/packages"
COMMON_LIC="/usr/share/common-licenses"
DOTNET_RT_VER="8.0.26"
export PATH="$HOME/.local/bin:$PATH"
export DOTNET_ROLL_FORWARD=LatestMajor

TAG=""; OUT=""; PACKAGE=0; BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --package) PACKAGE=1; shift;;
    --no-build) BUILD=0; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$TAG" ] && [ -n "$OUT" ] || { echo "usage: assemble_plugin_pack.sh --tag <tag> --out <dir> [--package] [--no-build]" >&2; exit 2; }

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "== $*"; }

# ── 1. Preconditions ────────────────────────────────────────────────────────
say "preconditions"

# 1a. Chorizite patches present in the vendored SOURCE (the tree is a plain,
# non-git vendored copy — verify by patched-source signature, not git apply).
DXH="$CHORIZITE/Chorizite/Chorizite.NativeClientBootstrapper/Hooks/DirectXHooks.cs"
LOGF="$CHORIZITE/Chorizite/Chorizite.Core/Logging/ChoriziteLogger.cs"
[ -f "$DXH" ] || die "missing $DXH"
[ -f "$LOGF" ] || die "missing $LOGF"
grep -q '_didInit' "$DXH" || die "dx-attach-init.patch NOT applied (no _didInit gate in DirectXHooks.cs)"
grep -q 'EndScene' "$DXH" || die "dx-attach-init.patch NOT applied (no EndScene drive in DirectXHooks.cs)"
grep -q 'log-{System.Environment.ProcessId}' "$LOGF" || die "per-pid-log.patch NOT applied (ChoriziteLogger.cs still writes shared log.txt)"
echo "   dx-attach-init + per-pid-log signatures present in vendored source"

# 1b. knob metadata gate (fail-loud counts 84/35/28)
python3 "$REPO/AcmeLauncher/tools/gen_knobs.py" >/dev/null || die "gen_knobs.py gate failed"
echo "   gen_knobs.py OK (84/35/28)"

# ── 2. Build Release ────────────────────────────────────────────────────────
build_proj() { # <project-dir-or-csproj> <extra-args...>
  local p="$1"; shift
  echo "   build $p"
  dotnet build "$REPO/$p" -c Release -p:EnableWindowsTargeting=true --nologo "$@" >/tmp/pp-build.log 2>&1 \
    || { tail -25 /tmp/pp-build.log >&2; die "build failed: $p"; }
}

if [ "$BUILD" = 1 ]; then
  say "build (Release, single-project, EnableWindowsTargeting)"
  # zzpatcher: self-contained single-file publish
  echo "   publish AcmeLauncher (zzpatcher, self-contained single file)"
  dotnet publish "$REPO/AcmeLauncher" -c Release --nologo >/tmp/pp-build.log 2>&1 \
    || { tail -25 /tmp/pp-build.log >&2; die "publish AcmeLauncher failed"; }
  build_proj AcmeInject
  # Chorizite runtime: the Launcher project is the full runtime; NativeClientBootstrapper
  # carries the dx-attach patch, Core carries the per-pid-log patch. Build all three so
  # bin/net8.0 is the complete, freshly-patched runtime set (Launcher pulls Core transitively
  # but building it explicitly makes the patch presence unambiguous in the verify pass).
  build_proj external/chorizite/Chorizite/Chorizite.Core/Chorizite.Core.csproj
  build_proj external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Chorizite.NativeClientBootstrapper.csproj
  build_proj external/chorizite/Chorizite/Chorizite.Launcher/Chorizite.Launcher.csproj
  build_proj AcmeLights
  build_proj AcmeSky
  build_proj AcmeRagdoll
  build_proj AcmeRedline
else
  say "skip build (--no-build); using existing Release output"
fi

# Resolve the built artifacts.
ZZP="$REPO/AcmeLauncher/bin/Release/net8.0-windows/win-x64/publish/zzpatcher.exe"
INJ_DIR="$REPO/AcmeInject/bin/Release/net8.0/win-x86"
[ -f "$ZZP" ] || die "zzpatcher.exe not built at $ZZP"
[ -f "$INJ_DIR/AcmeInject.exe" ] || die "AcmeInject.exe not built at $INJ_DIR"
[ -f "$CZ_BIN/Chorizite.Launcher.dll" ] || die "Chorizite runtime not built at $CZ_BIN"

# Prove the per-pid-log patch is in the built Core.dll (raw UTF-16-LE literal scan:
# the patched interpolation stores 'log-' + '.txt'; the old 'log.txt' literal is gone).
python3 - "$CZ_BIN/Chorizite.Core.dll" <<'PY' || die "built Chorizite.Core.dll does NOT carry the per-pid-log patch"
import sys
d=open(sys.argv[1],'rb').read()
ok = 'log-'.encode('utf-16-le') in d and '.txt'.encode('utf-16-le') in d
old = 'log.txt'.encode('utf-16-le') in d
sys.exit(0 if (ok and not old) else 1)
PY
echo "   built Chorizite.Core.dll carries the per-pid-log patch (log-<pid>.txt, no shared log.txt)"

# ── 3. Assemble ─────────────────────────────────────────────────────────────
PACK="$OUT/acme-plugins-$TAG"
say "pack dir: $PACK"
rm -rf "$PACK"; mkdir -p "$PACK/Chorizite/plugins" "$PACK/licenses"

# manifest accumulator (name|size|sha256) for the provenance table
MANIFEST="$(mktemp)"; trap 'rm -f "$MANIFEST"' EXIT

copy_in() { # <src> <dest-abs>
  local src="$1" dst="$2"
  [ -f "$src" ] || die "copy_in: missing source $src"
  mkdir -p "$(dirname "$dst")"
  cp -p "$src" "$dst"
  local a b; a=$(sha256sum "$src" | cut -d' ' -f1); b=$(sha256sum "$dst" | cut -d' ' -f1)
  [ "$a" = "$b" ] || die "sha mismatch copying $src"
}

# exclusion predicate: pdb/xml docs, the MSBuild-only Reloaded targets, acclient.map,
# DocGen tooling. Applied when mirroring a build-output dir.
excluded() {
  case "$(basename "$1")" in
    *.pdb|*.xml) return 0;;
    Reloaded.Assembler.targets) return 0;;
    acclient.map) return 0;;
    Chorizite.DocGen.*) return 0;;
    *) return 1;;
  esac
}

mirror_dir() { # <src-dir> <dst-dir>   (top-level files + recurse subdirs, honouring excluded())
  local s="$1" d="$2" f rel
  while IFS= read -r -d '' f; do
    excluded "$f" && continue
    rel="${f#"$s"/}"
    copy_in "$f" "$d/$rel"
  done < <(find "$s" -type f -print0)
}

# 3a. pack root: zzpatcher + sample inject bat + our licence
copy_in "$ZZP" "$PACK/zzpatcher.exe"
copy_in "$REPO/LICENSE.md" "$PACK/LICENSE.md"
copy_in "$REPO/LICENSE.md" "$PACK/licenses/LICENSE-ACME.md"   # audit's licenses/ layout (row 11)
cat > "$PACK/acdt-inject.bat" <<'BAT'
@echo off
REM ── ACME plugin launch (attach-by-injection) ─────────────────────────────
REM  Start Asheron's Call however you normally do (ThwargLauncher, a shortcut,
REM  Decal). Then run this to attach the ACME plugins to the running client.
REM  Or just run zzpatcher.exe and use the Plugins tab. This NEVER logs you in
REM  and never launches the game — it only attaches to a client you started.
cd /d "%~dp0Chorizite"
REM Attach to every running client that isn't already patched:
AcmeInject.exe --attach-all
REM  (single client: AcmeInject.exe --attach <pid>   —   list: AcmeInject.exe --list)
BAT
echo "   root: zzpatcher.exe, acdt-inject.bat, LICENSE.md"

# 3b. Chorizite runtime (minus exclusions) + AcmeInject inside it
mirror_dir "$CZ_BIN" "$PACK/Chorizite"
for f in AcmeInject.exe AcmeInject.dll AcmeInject.deps.json AcmeInject.runtimeconfig.json; do
  copy_in "$INJ_DIR/$f" "$PACK/Chorizite/$f"
done
echo "   Chorizite/: runtime ($(find "$PACK/Chorizite" -maxdepth 1 -type f | wc -l) files) + AcmeInject"

# 3c. the three plugins (minus exclusions; assets + profiles ride along via mirror_dir)
for pl in AcmeLights AcmeSky AcmeRagdoll AcmeRedline; do
  mirror_dir "$REPO/$pl/bin/net8.0" "$PACK/Chorizite/plugins/$pl"
  echo "   plugins/$pl/: $(find "$PACK/Chorizite/plugins/$pl" -type f | wc -l) files"
done

# 3c2. published Chorizite patches (S2): the provenance/NOTICES docs promise the
# "published patches" for our modified MIT runtime build — ship them in the pack.
mkdir -p "$PACK/chorizite-patches"
for f in dx-attach-init.patch per-pid-log.patch; do
  copy_in "$REPO/tools/chorizite-patches/$f" "$PACK/chorizite-patches/$f"
done
# player-facing README (the repo's dev README documents internal workflow; this one
# documents what a player/auditor needs: what the patches do + how to apply them).
cat > "$PACK/chorizite-patches/README.md" <<'CPREADME'
# Chorizite patches (published sources of our runtime modifications)

The `Chorizite\` runtime in this pack is the open-source Chorizite plugin
runtime (MIT, https://github.com/Chorizite) built with the two small patches in
this folder. Shipping the patches is what makes our modified build auditable:
apply them to the upstream source at the pinned revision and you can rebuild
byte-equivalent assemblies yourself.

| patch | what it does |
|---|---|
| `dx-attach-init.patch` | lets the runtime finish its one-time plugin startup when it is injected into an ALREADY-RUNNING client (the attach path this pack uses), by also driving startup from the per-frame EndScene hook. The normal launch path is unchanged. |
| `per-pid-log.patch` | each client writes its own `log-<pid>.txt` instead of every client interleaving into one shared `log.txt` (matters when you multi-box). |

Apply to a Chorizite source checkout with:

    git apply dx-attach-init.patch per-pid-log.patch

Full per-file provenance (versions, licence, shas): `..\THIRD-PARTY-PROVENANCE.md`.
CPREADME
echo "   chorizite-patches/: player README + the two published patches"

# 3d. licenses/  (canonical texts from /usr/share/common-licenses; cache copies where exact)
copy_in "$COMMON_LIC/LGPL-3"    "$PACK/licenses/LGPL-3.0.txt"
copy_in "$COMMON_LIC/GPL-3"     "$PACK/licenses/GPL-3.0.txt"
copy_in "$COMMON_LIC/Apache-2.0" "$PACK/licenses/Apache-2.0.txt"
copy_in "$NUGET/microsoft.netcore.app.runtime.win-x64/$DOTNET_RT_VER/LICENSE.TXT" "$PACK/licenses/dotnet-LICENSE.TXT"
copy_in "$NUGET/microsoft.netcore.app.runtime.win-x64/$DOTNET_RT_VER/THIRD-PARTY-NOTICES.TXT" "$PACK/licenses/dotnet-THIRD-PARTY-NOTICES.TXT"
# FASM licence: one canonical copy in licenses/ (also travels beside each FASM.DLL from mirror_dir)
FASM_LIC="$(find "$PACK/Chorizite" -name FASM-LICENSE.TXT | head -1)"
[ -n "$FASM_LIC" ] || die "no FASM-LICENSE.TXT found in the assembled runtime/plugins"
copy_in "$FASM_LIC" "$PACK/licenses/FASM-LICENSE.TXT"
# MIT: canonical text (attribution is consolidated in NOTICES per the audit).
cat > "$PACK/licenses/MIT.txt" <<'MIT'
The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
MIT
# Zlib: canonical text (FontStashSharp family — audit row 6; not in common-licenses).
cat > "$PACK/licenses/Zlib.txt" <<'ZLIB'
The zlib License

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
ZLIB
echo "   licenses/: LICENSE-ACME, LGPL-3.0, GPL-3.0, Apache-2.0, MIT, Zlib, FASM, dotnet LICENSE + THIRD-PARTY-NOTICES"

# 3e. NOTICES.txt  (per audit §5 rows 1-8 + §7 asset credits)
cat > "$PACK/NOTICES.txt" <<'NOTICES'
ACME Edition — plugin pack THIRD-PARTY NOTICES
==============================================

This optional plugin pack bundles third-party components. Full licence texts are
in licenses/. Per-file provenance and SHA-256s are in THIRD-PARTY-PROVENANCE.md.
The ACME launcher, injector and plugins themselves are AGPL-3.0 (see LICENSE.md).

--------------------------------------------------------------------------------
Reloaded.Hooks, Reloaded.Hooks.Definitions, Reloaded.Memory,
Reloaded.Memory.Buffers, Reloaded.Assembler  —  LGPL-3.0-or-later
--------------------------------------------------------------------------------
This product uses Reloaded.Hooks / .Memory / .Memory.Buffers / .Assembler by
Sewer56, licensed LGPL-3.0-or-later; sources at github.com/Reloaded-Project. The
libraries are unmodified and ship as separate DLLs; you may replace them.
Full texts: licenses/LGPL-3.0.txt and licenses/GPL-3.0.txt (LGPLv3 incorporates
GPLv3 by reference). Reloaded.Assembler carries the FASM flat assembler
(FASM.DLL / FASMX64.DLL) into every plugin folder — see FASM below.

--------------------------------------------------------------------------------
SixLabors.ImageSharp, SixLabors.ImageSharp.Drawing, SixLabors.Fonts  —  Apache-2.0
--------------------------------------------------------------------------------
Copyright (c) Six Labors. Licensed under the Apache License, Version 2.0
(licenses/Apache-2.0.txt). This distribution is an open-source project and uses
these libraries under the Apache-2.0 grant.

--------------------------------------------------------------------------------
FASM (FASM.DLL, FASMX64.DLL) — flat assembler, custom permissive licence
--------------------------------------------------------------------------------
Copyright (c) Tomasz Grysztar. Full licence: licenses/FASM-LICENSE.TXT (a copy
also ships beside each FASM.DLL in the runtime and plugin folders).

--------------------------------------------------------------------------------
MIT-licensed components
--------------------------------------------------------------------------------
The following ship under the MIT License (licenses/MIT.txt):
  Chorizite runtime (Chorizite.Core, Chorizite.Common, Chorizite.ACProtocol,
    Chorizite.NativeClientBootstrapper, Chorizite.Launcher, Chorizite.Injector),
  Autofac, Newtonsoft.Json, NJsonSchema, Namotion.Reflection, NAudio (Core/
    Asio/Midi/Wasapi/WinMM), SharpDX / SharpDX.Direct3D9, SharpGen.Runtime(.COM),
    Vortice.* (D3DCompiler/Direct3D11/DXGI/Mathematics/DirectX), Cyotek.Drawing.
    BitmapFont, Iced, Medo.PcapRW, DatReaderWriter, Microsoft.Extensions.* (9.x),
    Microsoft.Bcl.AsyncInterfaces, Microsoft.Diagnostics.*, and the System.*
    facade assemblies.
Each is © its respective authors; the MIT permission notice above applies to all.

--------------------------------------------------------------------------------
Apache-2.0 (additional)
--------------------------------------------------------------------------------
Microsoft.Extensions.Configuration / Logging / Options / Primitives (2.1.1) are
licensed Apache-2.0 (licenses/Apache-2.0.txt, shared with Six Labors above).

--------------------------------------------------------------------------------
Zlib-licensed components
--------------------------------------------------------------------------------
FontStashSharp, FontStashSharp.Base, FontStashSharp.Rasterizers.StbTrueTypeSharp
are © Roman Shapiro (rds1983), licensed Zlib.

--------------------------------------------------------------------------------
StbImageSharp, StbTrueTypeSharp — Public Domain or MIT (recipient's choice)
--------------------------------------------------------------------------------
Ports by the StbSharp project of Sean Barrett's public-domain stb libraries. The
NuGet packages carry no licence metadata; terms are dual Public-Domain/MIT per
the upstream StbSharp repositories.

--------------------------------------------------------------------------------
SigScan.dll — prebuilt native helper
--------------------------------------------------------------------------------
A prebuilt native signature-scanning DLL that ships inside the Chorizite runtime.
Covered by Chorizite's repository-wide MIT licence; no separate upstream source
was located. Listed explicitly here rather than shipping anonymously.

--------------------------------------------------------------------------------
.NET 8 runtime (embedded in zzpatcher.exe)
--------------------------------------------------------------------------------
zzpatcher.exe is a self-contained single-file publish embedding the .NET 8.0.26
runtime (© Microsoft, MIT). See licenses/dotnet-LICENSE.TXT and
licenses/dotnet-THIRD-PARTY-NOTICES.TXT.

--------------------------------------------------------------------------------
AcmeSky baked sky assets (in plugins/AcmeSky/assets/sky/)
--------------------------------------------------------------------------------
Cloud coverage masks are derived from NASA Blue Marble imagery (public domain;
no endorsement implied). The star field is derived from the Yale Bright Star
Catalog (a factual astronomical catalog) via the takram three-atmosphere/three-
clouds project (MIT). Sky palettes are sampled from Eric Bruneton's precomputed
atmospheric-scattering reference implementation (BSD-3-Clause), consumed through
the takram MIT ports. Provenance: docs/install/LICENSE-AUDIT §7 and
/mnt/wbterminal2/dat-patch-sky/PROVENANCE.txt in the source tree.
NOTICES
echo "   NOTICES.txt written"

# ── 4. Provenance + checksums ───────────────────────────────────────────────
say "provenance + checksums"
# per-file SHA-256 table for the provenance doc + SHA256SUMS.txt at pack root
( cd "$PACK"
  # SHA256SUMS covers every file EXCEPT itself and the provenance doc we're about to write
  find . -type f ! -name SHA256SUMS.txt ! -name THIRD-PARTY-PROVENANCE.md -print0 \
    | sort -z | xargs -0 sha256sum | sed 's#\./##' > SHA256SUMS.txt
)

# THIRD-PARTY-PROVENANCE.md = the repo doc with its placeholder replaced by the pack table
PROV_SRC="$REPO/docs/install/THIRD-PARTY-PROVENANCE.md"
PROV_DST="$PACK/THIRD-PARTY-PROVENANCE.md"
{
  # everything up to (not including) the placeholder line
  awk '/<!-- shas appended at packaging -->/{exit} {print}' "$PROV_SRC"
  echo
  echo "## Per-file SHA-256 (pack acme-plugins-$TAG)"
  echo
  echo '| file | size | sha256 |'
  echo '|---|---:|---|'
  ( cd "$PACK"
    find . -type f ! -name THIRD-PARTY-PROVENANCE.md -print0 | sort -z | while IFS= read -r -d '' f; do
      rel="${f#./}"; sz=$(stat -c%s "$f"); sha=$(sha256sum "$f" | cut -d' ' -f1)
      printf '| `%s` | %s | `%s` |\n' "$rel" "$sz" "$sha"
    done )
  # tail after the placeholder line, if any
  awk 'f{print} /<!-- shas appended at packaging -->/{f=1}' "$PROV_SRC"
} > "$PROV_DST"
# M2: the repo doc points at tools/chorizite-patches/ -- in the SHIPPED copy the
# patches sit beside this document; phrase it so it is true in the standalone pack
# AND inside the release archive (acme-plugins/).
sed -i 's#tools/chorizite-patches/#chorizite-patches/#g' "$PROV_DST"
grep -q 'tools/chorizite-patches' "$PROV_DST" && die "provenance path rewrite incomplete"
# one clarifying line under the title so both contexts read true
sed -i '1a\\n> The `chorizite-patches/` folder referenced below ships in this pack, beside this document.' "$PROV_DST"
echo "   SHA256SUMS.txt + THIRD-PARTY-PROVENANCE.md (per-file table) written"

# ── 5. Verify pass ──────────────────────────────────────────────────────────
say "verify pass"
FAIL=0
# every FASM.DLL has FASM-LICENSE.TXT beside it
while IFS= read -r -d '' fasm; do
  [ -f "$(dirname "$fasm")/FASM-LICENSE.TXT" ] || { echo "   ✗ no FASM-LICENSE.TXT beside $fasm"; FAIL=1; }
done < <(find "$PACK" -name FASM.DLL -print0)
# acclient.map absent
if find "$PACK" -name acclient.map | grep -q .; then echo "   ✗ acclient.map present (must be excluded)"; FAIL=1; fi
# no pdb/xml
if find "$PACK" \( -name '*.pdb' -o -name '*.xml' \) | grep -q .; then echo "   ✗ pdb/xml leaked into pack"; FAIL=1; fi
# the audit's full licenses/ file set (LICENSE-AUDIT §"Minimum notice set")
for lic in LICENSE-ACME.md LGPL-3.0.txt GPL-3.0.txt Apache-2.0.txt MIT.txt Zlib.txt FASM-LICENSE.TXT dotnet-LICENSE.TXT dotnet-THIRD-PARTY-NOTICES.TXT; do
  [ -f "$PACK/licenses/$lic" ] || { echo "   ✗ licenses/$lic missing (audit minimum set)"; FAIL=1; }
done
# the split-licence wording rule applies to BOTH shipped text docs
if grep -qi 'Split License' "$PACK/THIRD-PARTY-PROVENANCE.md"; then echo "   ✗ THIRD-PARTY-PROVENANCE.md names the Six Labors Split License (granted-license-only wording required)"; FAIL=1; fi
# NOTICES names Apache-2.0 and NEVER the split licence
grep -q 'Apache-2.0' "$PACK/NOTICES.txt" || { echo "   ✗ NOTICES.txt does not name Apache-2.0"; FAIL=1; }
if grep -qi 'Split License' "$PACK/NOTICES.txt"; then echo "   ✗ NOTICES.txt names the Six Labors Split License (must reference Apache-2.0 only)"; FAIL=1; fi
# S2: the published patches must ship
for f in README.md dx-attach-init.patch per-pid-log.patch; do
  [ -f "$PACK/chorizite-patches/$f" ] || { echo "   ✗ chorizite-patches/$f missing"; FAIL=1; }
done
# S7/S8: the three cfg example files must ship with their plugins
[ -f "$PACK/Chorizite/plugins/AcmeSky/assets/sky/atmosphere/sky.cfg.example" ] || { echo "   ✗ sky.cfg.example missing from AcmeSky"; FAIL=1; }
[ -f "$PACK/Chorizite/plugins/AcmeLights/lights.cfg.example" ] || { echo "   ✗ lights.cfg.example missing from AcmeLights"; FAIL=1; }
[ -f "$PACK/Chorizite/plugins/AcmeRagdoll/ragdoll.cfg.example" ] || { echo "   ✗ ragdoll.cfg.example missing from AcmeRagdoll"; FAIL=1; }
# S8: the generated examples must be CURRENT vs Knobs.Generated. Regenerate into a
# TEMP dir and diff -- verify must NEVER write the tracked tree (a self-healing
# in-tree regenerate would mask a stale commit).
TMPEX=$(mktemp -d)
python3 "$REPO/tools/plugin-pack/gen_cfg_examples.py" "$TMPEX" >/dev/null 2>&1 || { echo "   ✗ gen_cfg_examples.py failed"; FAIL=1; }
cmp -s "$TMPEX/lights.cfg.example" "$PACK/Chorizite/plugins/AcmeLights/lights.cfg.example" || { echo "   ✗ lights.cfg.example is stale vs Knobs.Generated"; FAIL=1; }
cmp -s "$TMPEX/ragdoll.cfg.example" "$PACK/Chorizite/plugins/AcmeRagdoll/ragdoll.cfg.example" || { echo "   ✗ ragdoll.cfg.example is stale vs Knobs.Generated"; FAIL=1; }
rm -rf "$TMPEX"
# B3 gate: every UNcommented key=value in the shipped sky.cfg.example must equal
# the Knobs.Generated default (the hand-maintained file must not drift from ship).
python3 - "$PACK/Chorizite/plugins/AcmeSky/assets/sky/atmosphere/sky.cfg.example" "$REPO/AcmeLauncher/Knobs.Generated.cs" <<'SKYGATE' || { echo "   ✗ sky.cfg.example drifts from Knobs.Generated defaults"; FAIL=1; }
import re, sys
ex, gen = sys.argv[1], sys.argv[2]
defaults = {m.group(1): m.group(2) for m in re.finditer(
    r'new KnobDef\("Sky", "sky", "[^"]*", "([^"]*)", KnobType\.\w+, "([^"]*)"', open(gen).read())}
bad = []
for raw in open(ex):
    line = raw.split('#', 1)[0].split(';', 1)[0].strip()
    if not line or '=' not in line: continue
    k, v = (t.strip() for t in line.split('=', 1))
    if k not in defaults: bad.append(f"{k}: not a knob"); continue
    d = defaults[k]
    if k == "skyweatheroverride":
        # the plugin normalises the auto family to "" (SkyConfig.cs:290)
        norm = lambda x: "" if x.lower() in ("", "auto", "-1", "live", "off") else x.lower()
        same = norm(v) == norm(d)
    else:
        try: same = abs(float(v) - float(d)) < 1e-9
        except ValueError: same = v == d
    if not same: bad.append(f"{k}: example={v} default={d}")
for b in bad: print("   sky-example drift:", b)
sys.exit(1 if bad else 0)
SKYGATE
# SHA256SUMS re-verifies
( cd "$PACK" && sha256sum -c SHA256SUMS.txt >/tmp/pp-shacheck.log 2>&1 ) || { echo "   ✗ SHA256SUMS re-verify failed"; tail -5 /tmp/pp-shacheck.log; FAIL=1; }
[ "$FAIL" = 0 ] || die "verify pass FAILED — pack is not shippable"
echo "   all invariants hold (FASM licence sited, acclient.map absent, no pdb/xml, NOTICES Apache-only, SHA256SUMS clean)"

# ── 6. Summary + optional package ───────────────────────────────────────────
NFILES=$(find "$PACK" -type f | wc -l)
TOTSZ=$(du -sh "$PACK" | cut -f1)
RT_DLLS=$(find "$PACK/Chorizite" -maxdepth 1 -name '*.dll' | wc -l)
say "SUMMARY"
echo "   pack:        $PACK"
echo "   files:       $NFILES   size: $TOTSZ"
echo "   runtime DLLs (Chorizite/*.dll, excl. plugins): $RT_DLLS"
echo "   plugins:     $(find "$PACK/Chorizite/plugins" -maxdepth 1 -mindepth 1 -type d | wc -l)"
echo "   runtime-build path: $([ "$BUILD" = 1 ] && echo 'fresh Release build (patches verified in source AND built Core.dll)' || echo 'existing Release output (--no-build)')"

if [ "$PACKAGE" = 1 ]; then
  say "package"
  TARBALL="$OUT/acme-plugins-$TAG.tar.gz"
  tar -C "$OUT" -czf "$TARBALL" "acme-plugins-$TAG"
  sha256sum "$TARBALL" | sed "s#$OUT/##" > "$TARBALL.sha256"
  echo "   $TARBALL  ($(du -sh "$TARBALL" | cut -f1))"
  echo "   $(cat "$TARBALL.sha256")"
fi

echo "== DONE"
