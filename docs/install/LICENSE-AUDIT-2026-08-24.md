# License audit — ACME release bundle (2026-08-24)

Gates item 5 of `docs/install/HANDOFF-2026-08-24-zzpatcher.md` ("clear the
license-audit checklist before shipping"). Clears the two open checkboxes in
`docs/install/THIRD-PARTY-PROVENANCE.md`.

**Method — offline-first.** Every license below was determined from artifacts on
this machine: the extracted NuGet cache (`~/.nuget/packages/<id>/<ver>/`), the
`.nuspec` metadata, the `LICENSE`/`LICENSE.md` files the packages themselves
carry, the vendored Chorizite sources, and the **build output on disk** — the
DLL set in `*/bin/` is the ground truth for what actually ships, and the
`.deps.json` files enumerate the transitive closure. Two packages ship with no
license metadata whatsoever (`StbImageSharp`, `StbTrueTypeSharp`) plus one with
a dead `licenseUrl` (`SharpDX`); those three were resolved upstream and are
marked as such.

**Headline result: no BLOCKER.** Both flagged suspects resolve in our favour,
but *both* impose notice obligations that the archive does not yet satisfy.

---

## 0. Our own license, and why it decides the two hard cases

Repo root `LICENSE.md` is the **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`). This is load-bearing twice over:

- It makes AGPL↔LGPL compatibility the question for `Reloaded.*` (answer: fine).
- It is what *qualifies* us for ImageSharp's free Apache-2.0 grant (answer: fine).

An AGPL project is the *easy* case for copyleft deps and the *easy* case for
"free for open-source" split licenses. A proprietary build of this same bundle
would have failed both.

---

## 1. What actually ships (verified on disk)

Four binary groups. Component-level provenance lives in
`docs/install/THIRD-PARTY-PROVENANCE.md`; this section is only the license-
relevant shape of the bundle.

### 1a. `zzpatcher.exe` — AcmeLauncher

`AcmeLauncher/AcmeLauncher.csproj` declares **zero `PackageReference`s**, and
`AcmeLauncher/bin/Release/net8.0-windows/win-x64/zzpatcher.deps.json` confirms
**0 entries of `"type": "package"`**. It has no third-party NuGet surface at all.

It is, however, a `SelfContained` + `PublishSingleFile` win-x64 publish, so the
single `zzpatcher.exe` **embeds the .NET runtime** — 238 DLLs from
`Microsoft.NETCore.App` + `Microsoft.WindowsDesktop.App` (WPF) **8.0.26**, plus
`createdump.exe` and satellite resource folders. That is a redistribution of
Microsoft's runtime and carries its own (trivially satisfiable) notice duty.

### 1b. `AcmeInject.exe`

`AcmeInject/AcmeInject.csproj` — zero `PackageReference`s;
`AcmeInject.deps.json` — 0 packages. Framework-dependent win-x86. Output is four
files (`.exe`, `.dll`, `.deps.json`, `.runtimeconfig.json`). **No third-party
code ships here.**

### 1c. The ACME plugins

Verified contents of `Acme{Lights,Sky,Ragdoll}/bin/net8.0/`. All three reference
`Chorizite.Core`, `Reloaded.Hooks`, `Autofac` and `Logging.Abstractions` with
`ExcludeAssets="runtime"` — i.e. **compile-only; the managed DLLs are not copied
into the plugin folders**, they bind to the host's resident copies. That is a
*technical* fact about duplication, **not** a license escape: the host folder
ships those same assemblies (§1d), so the bundle distributes them regardless.

What the plugins *do* carry:

| Plugin | Third-party files present |
|---|---|
| AcmeLights | `Chorizite.ACBindings.dll`, `Vortice.D3DCompiler/DirectX/Mathematics.dll`, `SharpGen.Runtime[.COM].dll`, `FASM.DLL`, `FASMX64.DLL`, `FASM-LICENSE.TXT`, `Reloaded.Assembler.targets` |
| AcmeSky | as above **+** `Vortice.Direct3D11.dll`, `Vortice.DXGI.dll` |
| AcmeRagdoll | `Chorizite.ACBindings.dll`, `FASM.DLL`, `FASMX64.DLL`, `FASM-LICENSE.TXT`, `Reloaded.Assembler.targets` |

Note the native **FASM assembler DLLs ship in every plugin folder** (pulled in by
`Reloaded.Assembler`, deliberately kept — see the AcmeSky csproj comment). Good
news: `FASM-LICENSE.TXT` is *already* copied next to them, so that one obligation
is pre-satisfied by the build.

`Reloaded.Assembler.targets` is an MSBuild build asset that leaks into the output
folder. Harmless, but it is dead weight in a player archive — see §5 housekeeping.

### 1c2. The two STOCK Chorizite plugins (added 2026-08-25) — `plugins/RmlUi`, `plugins/Lua`

**Not ours, and not built here.** These are the unmodified upstream release
archives, fetched and SHA-256-verified by
`tools/plugin-pack/fetch_stock_plugins.sh` against the digests the Chorizite
plugin index itself publishes:

| Folder | Package | Version | Archive SHA-256 (index-published, verified on download) |
|---|---|---|---|
| `plugins/RmlUi` | `Chorizite.Plugins.RmlUi` | 0.0.10 | `44cbc9a7006278502d28276533c6fceaef2d79fd563d181cc90b3a0301441850` |
| `plugins/Lua` | `Chorizite.Plugins.Lua` | 0.0.13 | `885e7530edc07539365fa97fffb72b8fd1fb3f809d77b83f768980cf5e25a9c8` |

They ship because **AcmeRedline's panel is an RmlUi document**, and RmlUi's own
manifest declares `Lua@0.0.13` non-optionally. Both `Chorizite.Plugins.*` nuspecs
carry `<license type="expression">MIT</license>`; note that neither GitHub repo
(`Chorizite/RmlUiPlugin`, `Chorizite/LuaPlugin`) contains a `LICENSE` file, so the
MIT determination rests on the publisher's package metadata plus the
repository-wide MIT of the parent `Chorizite/Chorizite` project. Recorded rather
than smoothed over.

What those two folders drag in — this is where the interesting findings are, and
**not all of it is MIT**:

| File in the folder | Component | Version | License | How determined |
|---|---|---|---|---|
| `RmlUi/RmlUi.Net.dll` | RmlUi.Net | 1.0.1 | MIT | nuspec SPDX expression |
| `RmlUi/runtimes/win-{x86,x64}/native/RmlUiNative.dll` | RmlUi (C++) | bundled | MIT | upstream `mikke89/RmlUi` |
| ↳ **statically linked into that blob** | **FreeType 2** | bundled | **FTL** (dual FTL/GPLv2) | string scan of the shipped x86 blob: `FREETYPE_PROPERTIES` present, **no** `freetype.dll` import ⇒ static link |
| ↳ **embedded font in that blob** | Courier Prime Code | bundled | **SIL OFL 1.1** | the OFL text is embedded in the binary beside the font; © 2015 Quote-Unquote Apps |
| `RmlUi/Cortex.Net.dll` | Cortex.Net | 0.4.1 | MIT | package `LICENSE.txt`, © 2019 Michel Weststrate, Jan-Willem Spuij |
| `RmlUi/Fizzler.dll` | Fizzler | 1.3.1 | ⚠ **LGPL-3.0-or-later** | nuspec `<license type="expression">LGPL-3.0-or-later</license>` **and** package `COPYING.txt` = verbatim LGPLv3 |
| `RmlUi/Fizzler.Systems.HtmlAgilityPack.dll` | Fizzler.Systems.HtmlAgilityPack | 1.2.1 | ⚠ **LGPL-3.0-or-later** | package `COPYING.txt` = verbatim LGPLv3 (nuspec is `type="file"`) |
| `RmlUi/HtmlAgilityPack.dll` | HtmlAgilityPack | 1.5.1 | MIT | `licenseUrl` → `zzzprojects/html-agility-pack/LICENSE`, fetched: MIT |
| `RmlUi/System.Drawing.Common.dll`, `System.Private.Windows.Core.dll` | System.Drawing.Common | 9.0.2 | MIT | nuspec SPDX expression (dotnet/winforms) |
| `RmlUi/Microsoft.Win32.SystemEvents.dll` (+ `runtimes/win/lib/`) | Microsoft.Win32.SystemEvents | 9.0.2 | MIT | nuspec SPDX expression |
| `RmlUi/System.Xml.XPath.XmlDocument.dll` | System.Xml.XPath.XmlDocument | 4.3.0 | MIT | same 4.x `System.*` family as §2's consolidated row |
| `RmlUi/assets/LatoLatin-Regular.ttf` | Lato | 2.015 | **SIL OFL 1.1** | font `name` table: © 2011-2015 tyPoland Lukasz Dziedzic, Reserved Font Name "Lato" |
| `Lua/runtimes/win-x86/native/xlua.dll` | Tencent xLua | bundled | MIT | `Tencent/xLua` `LICENSE.TXT`, © 2016 THL A29 Limited |
| ↳ **embedded in that blob** | Lua interpreter | **5.4.1** | MIT | version banner in the blob: `Lua 5.4.1 Copyright (C) 1994-2020 Lua.org, PUC-Rio` |

**Correction to the working brief this section was written from,** which asserted
all of the above were MIT: the two Fizzler packages are **LGPL-3.0-or-later**.
That is not a new blocker — it is the same posture as `Reloaded.*` in §3a
(unmodified, separate, replaceable DLLs; LGPL-3.0 is compatible with our
AGPL-3.0) and the LGPL/GPL texts already ship — but the NOTICES entry is a real
obligation and the audit must not record them as MIT.

The RmlUi folder also carries upstream's **sample content** (`Breakout.rml`,
`Test.rml`, `Logs.rml`, `pizza.png`, `coin.png`, `acsprites.png`). Shipping the
release archive byte-for-byte is the provenance-clean choice and is what we do;
pruning the samples would be housekeeping only, at the cost of no longer matching
the published SHA-256.

### 1d. The vendored Chorizite host — where all the risk lives

`external/chorizite/Chorizite/bin/net8.0/` is the plugin host that the injector
loads, and it is the only place in the bundle with license-interesting binaries.
Confirmed present on disk:

- `Reloaded.Hooks.dll`, `Reloaded.Hooks.Definitions.dll`, `Reloaded.Memory.dll`,
  `Reloaded.Memory.Buffers.dll`, `Reloaded.Assembler.dll` ← **suspect #1**
- `SixLabors.ImageSharp.dll`, `SixLabors.ImageSharp.Drawing.dll`,
  `SixLabors.Fonts.dll` ← **suspect #2**
- `SigScan.dll` — a prebuilt **native** DLL with no source in-tree (§4)
- `acclient.map` — a link map of the retail Turbine client (§4)
- ~50 further permissive-licensed managed assemblies (§2)

---

## 2. Package inventory (transitive closure from `.deps.json`)

Union of the package closures of `Chorizite.Core`,
`Chorizite.NativeClientBootstrapper`, `Chorizite.ACBindings`,
`Chorizite.ACProtocol` and the three plugins. **"How determined"** legend:
`LICENSE-file` = the license text file inside the extracted package;
`nuspec` = SPDX expression in `<license type="expression">`;
`upstream` = fetched from the project repo (only where local metadata was absent).

| Package | Version | SPDX | How determined | Flag |
|---|---|---|---|---|
| **Reloaded.Hooks** | 4.3.3 | **LGPL-3.0-or-later** | LICENSE-file (`LICENSE.md` = full LGPLv3 text, 166 lines) | ⚠ **copyleft** |
| **Reloaded.Hooks.Definitions** | 1.15.0 | **LGPL-3.0-or-later** | LICENSE-file (`LICENSE.md` = LGPLv3) | ⚠ **copyleft** |
| **Reloaded.Memory** | 7.0.0 | **LGPL-3.0-or-later** | LICENSE-file (`LICENSE` = LGPLv3) | ⚠ **copyleft** |
| **Reloaded.Memory.Buffers** | 2.0.0 | **LGPL-3.0-or-later** | LICENSE-file (`LICENSE` = LGPLv3) | ⚠ **copyleft** |
| **Reloaded.Assembler** | 1.0.14-mem-buffers-2.0 | **LGPL-3.0-or-later** | LICENSE-file (`LICENSE` = LGPLv3) | ⚠ **copyleft** |
| **SixLabors.ImageSharp** | **3.1.11** | **Six Labors Split License v1.0** → Apache-2.0 for us | LICENSE-file (verbatim split license, 43 lines) | ⚠ **split** |
| **SixLabors.ImageSharp.Drawing** | 2.1.7 | Six Labors Split License v1.0 → Apache-2.0 for us | LICENSE-file | ⚠ **split** |
| **SixLabors.Fonts** | 2.1.3 | Six Labors Split License v1.0 → Apache-2.0 for us | LICENSE-file | ⚠ **split** |
| FASM (`FASM.DLL`, `FASMX64.DLL`) | 1.73 | custom permissive, BSD-2-like | `FASM-LICENSE.TXT` shipped in output | notice ✓ already shipped |
| Iced | 1.17.0 | MIT | nuspec + `LICENSE.txt` | — |
| Autofac | 8.4.0 | MIT | nuspec | — |
| Newtonsoft.Json | 13.0.3 | MIT | nuspec + `LICENSE.md` | — |
| NJsonSchema | 11.5.1 | MIT | nuspec | — |
| NJsonSchema.Annotations | 11.5.1 | MIT | nuspec | — |
| Namotion.Reflection | 3.4.3 | MIT | nuspec | — |
| NAudio | 2.2.1 | MIT | LICENSE-file (`license.txt`, © 2020 Mark Heath) | — |
| NAudio.Core / .Asio / .Midi / .Wasapi / .WinMM | 2.2.1 | MIT | nuspec | — |
| SharpDX | 4.2.0 | MIT | upstream (nuspec `licenseUrl` is dead: `sharpdx.org/License.txt`) | dead-URL, resolved |
| SharpDX.Direct3D9 | 4.2.0 | MIT | upstream (same dead URL) | dead-URL, resolved |
| SharpGen.Runtime | 2.2.0-beta | MIT | nuspec | prerelease pin |
| SharpGen.Runtime.COM | 2.2.0-beta | MIT | nuspec | prerelease pin |
| Vortice.Direct3D11 / DXGI / D3DCompiler / DirectX | 3.6.2 | MIT | nuspec | — |
| Vortice.Mathematics | 1.9.2 | MIT | nuspec | — |
| FontStashSharp | 1.3.10 | **Zlib** | nuspec | permissive, notice-only |
| FontStashSharp.Base | 1.1.9 | Zlib | nuspec | permissive, notice-only |
| FontStashSharp.Rasterizers.StbTrueTypeSharp | 1.1.9 | Zlib | nuspec | permissive, notice-only |
| Cyotek.Drawing.BitmapFont | 2.0.4 | MIT | nuspec | — |
| StbImageSharp | 2.30.15 | **Public Domain or MIT** (dual, licensee's choice) | upstream — package has **no** license metadata at all | metadata gap, resolved |
| StbTrueTypeSharp | 1.26.12 | Public Domain or MIT (same StbSharp family) | upstream — no package metadata | metadata gap, resolved |
| Medo.PcapRW | 1.2.0 | MIT | LICENSE-file (`LICENSE.md`, © 2020 Josip Medved) | — |
| Chorizite.ACProtocol | 1.0.1 | MIT | nuspec + `external/chorizite/Chorizite.ACProtocol/LICENSE` | — |
| Chorizite.Common | 1.0.0 / 1.0.3 | MIT | nuspec + vendored `LICENSE` | — |
| Chorizite.DatReaderWriter | 1.0.0 | MIT | nuspec (© 2024 ACClientLib) | — |
| Chorizite.Core / .NativeClientBootstrapper / .ACBindings | vendored | MIT | `external/chorizite/Chorizite/LICENSE.md`, © 2024 Chorizite | **modified by us** — §4 |
| Microsoft.Extensions.* | 2.1.1 | Apache-2.0 | nuspec `licenseUrl` → aspnet/Home 2.0.0 LICENSE.txt | — |
| Microsoft.Extensions.Logging.Abstractions / DependencyInjection.Abstractions | 9.0.0 / 9.0.9 | MIT | nuspec + bundled `LICENSE.TXT` | — |
| Microsoft.Bcl.AsyncInterfaces | 1.1.0 / 9.0.0 | MIT | nuspec + `LICENSE.TXT` | — |
| Microsoft.Diagnostics.Runtime (ClrMD) | 3.1.512801 | MIT | nuspec | — |
| Microsoft.Diagnostics.NETCore.Client | 0.2.410101 | MIT | nuspec | — |
| System.* (Text.Json, Collections.Immutable, Reflection.Metadata, IO.Pipelines, CodeDom, Diagnostics.DiagnosticSource, Text.Encodings.Web, Memory, Buffers, Numerics.Vectors, Runtime.CompilerServices.Unsafe, Threading.Tasks.Extensions) | 4.x–9.0.9 | MIT | nuspec + bundled `LICENSE.TXT` | — |
| .NET 8 runtime embedded in `zzpatcher.exe` (`Microsoft.NETCore.App` + `Microsoft.WindowsDesktop.App`) | 8.0.26 | MIT | `~/.nuget/packages/microsoft.netcore.app.runtime.win-x64/8.0.26/LICENSE.TXT` ("The MIT License (MIT), © .NET Foundation and Contributors") | notice: ship its `THIRD-PARTY-NOTICES.TXT` |

**Build-only, does NOT ship** (present in `.deps.json` but not in output):
`GitVersion.MsBuild` 6.1.0/6.3.0/6.4.0 (MIT) — a build-time versioning task with
no runtime assembly in the bundle. Out of scope.

---

## 3. The two named suspects, resolved

### 3a. `Reloaded.*` — **LGPL-3.0, not GPL. Not a blocker.**

The provenance checklist guessed "some Reloaded components have used copyleft
terms". That guess was right about copyleft and wrong about severity. All five
shipped Reloaded packages carry the **full GNU Lesser General Public License
v3.0** text as their package license file — verified byte-for-byte, not inferred
from a badge:

```
~/.nuget/packages/reloaded.hooks/4.3.3/LICENSE.md               (LGPLv3, 166 lines)
~/.nuget/packages/reloaded.hooks.definitions/1.15.0/LICENSE.md  (LGPLv3, 166 lines)
~/.nuget/packages/reloaded.memory/7.0.0/LICENSE                 (LGPLv3, 165 lines)
~/.nuget/packages/reloaded.memory.buffers/2.0.0/LICENSE         (LGPLv3, 165 lines)
~/.nuget/packages/reloaded.assembler/1.0.14-mem-buffers-2.0/LICENSE (LGPLv3, 166 lines)
```

Upstream statement embedded in the package: `<repository url=` →
`https://github.com/Reloaded-Project/Reloaded.Hooks`, author `Sewer56`,
`<license type="file">LICENSE.md</license>`, `requireLicenseAcceptance=true`.

**Why this ships cleanly:**

1. **Compatibility.** LGPL-3.0 is GPL-3.0 plus additional permissions, and the
   FSF lists it as compatible with AGPL-3.0. Our AGPL-3.0 work may link it. (The
   converse worry — AGPL "infecting" Reloaded — does not arise: we ship it
   **unmodified**.)
2. **Linking form.** The Reloaded assemblies ship as **separate, unmodified
   `.dll` files** loaded by the .NET assembly loader. Nothing is ILMerged or
   statically linked into an ACME assembly. This is textbook LGPL §4 "Combined
   Work" territory, and the separate-DLL form is what makes §4(d) easy.
3. **Source availability.** LGPL §4(d)(1) wants the user able to relink against a
   modified Library. Because the entire ACME work is AGPL-3.0 with published
   source, and Reloaded is consumed as an unmodified separate assembly that the
   user can simply swap on disk, the relink requirement is satisfied in
   substance and by the strongest available means.

**Obligations we must actually discharge** (LGPL §4(a)/(b) — currently unmet):

- Prominent notice in the archive that the work uses Reloaded.* and that
  Reloaded.* is LGPL-3.0.
- Ship a **copy of the LGPL-3.0 text and a copy of the GPL-3.0 text** in the
  archive (LGPLv3 incorporates GPLv3 by reference; §4(b) asks for both).
- Point to the upstream source: `https://github.com/Reloaded-Project/Reloaded.Hooks`
  (and `/Reloaded.Memory`, `/Reloaded.Memory.Buffers`, `/Reloaded.Assembler`),
  with the exact versions pinned in §2.

> **Note the reach.** `Reloaded.Assembler` also drags the native FASM binaries
> into all three *plugin* folders, so the LGPL notice covers files outside the
> Chorizite host directory. Any "which folders have copyleft in them" answer is:
> **all four** (`Chorizite/`, `plugins/AcmeLights/`, `plugins/AcmeSky/`,
> `plugins/AcmeRagdoll/`).

### 3b. `SixLabors.ImageSharp` — **3.1.11, split-licensed, and we qualify for Apache-2.0. Not a blocker.**

The shipped version is **3.1.11** — pinned twice in the vendored host
(`Chorizite.Core.csproj` and `Chorizite.NativeClientBootstrapper.csproj`),
confirmed by both `.deps.json` closures, and the DLL is physically present at
`external/chorizite/Chorizite/bin/net8.0/SixLabors.ImageSharp.dll`. So this is
squarely the **post-Apache era**: `~/.nuget/packages/sixlabors.imagesharp/3.1.11/LICENSE`
is the **Six Labors Split License, Version 1.0, June 2022**, verbatim. The same
license file ships with `SixLabors.ImageSharp.Drawing` 2.1.7 and
`SixLabors.Fonts` 2.1.3.

What the split license says (quoted from the shipped LICENSE file):

> Works in Source or Object form are split licensed and may be licensed under the
> Apache License, Version 2.0 or a Six Labors Commercial Use License.
> […] Works in Source or Object form are licensed to You under the Apache
> License, Version 2.0 if.
> - You are consuming the Work in for use in software licensed under an Open
>   Source or Source Available license.
> - You are consuming the Work as a Transitive Package Dependency.
> - […] For-profit company/individual with less than 1M USD annual gross revenue.
> - […] Non-profit organization or Registered Charity.
>
> For all other scenarios, Works […] are licensed to You under the Six Labors
> Commercial License […]

**We qualify on two independent grounds, either of which suffices:**

1. **Open-source consumption** — ACME is AGPL-3.0, an OSI open-source license.
2. **Transitive Package Dependency** — no ACME `.csproj` references any
   `SixLabors.*` package. It arrives only through the vendored Chorizite host.
   (Note the license's own definition scopes "Transitive" to *"a third party
   dependency unrelated to Six Labors"* — Chorizite is exactly that.)

Therefore **ImageSharp/Drawing/Fonts are licensed to us under Apache-2.0**, and
Apache-2.0 is compatible with AGPL-3.0 (Apache-2.0 → GPLv3-family is a
one-directional but permitted combination).

**What Apache-2.0 requires of a binary redistribution** (§4 of Apache-2.0 —
currently unmet):

- Include a **copy of the Apache-2.0 license text** in the archive.
- Retain copyright/attribution notices: `Copyright (c) Six Labors`.
- If a `NOTICE` file were distributed with the work, reproduce it. (The NuGet
  packages ship `LICENSE` only, no separate `NOTICE` file — so nothing extra to
  carry beyond the attribution line.)

Plus one clause specific to the split license, easy to miss:

> Once granted, **You must reference the granted license only in all
> documentation.**

That is a positive documentation duty: our NOTICES must say ImageSharp is under
**Apache-2.0** (the branch we were granted) — **not** "Six Labors Split License",
and not both. Stating it ambiguously is itself non-compliance.

**Remediation is NOT required.** Pinning back to an Apache-2.0-era ImageSharp
(1.0.x) would mean patching the vendored Chorizite's package pins for zero legal
gain and real API-break risk. Do not do it. Recorded here only so the option is
on the table if the project ever relicenses away from AGPL.

---

## 4. Additional findings not on the original checklist

These surfaced from the on-disk sweep. None blocks shipping, but two are worse
provenance risks than either named suspect, and neither was previously tracked.

### 4a. `acclient.map` — the real exposure is copyright, not OSS licensing

`external/chorizite/Chorizite/bin/net8.0/acclient.map` ships with the host
(copied via `Chorizite.Core.csproj:63`). It is a **link map of the retail Turbine
`acclient.exe`** — symbol names and addresses derived from a proprietary binary
owned by Turbine/WB Games. Chorizite's MIT LICENSE covers Chorizite's own code;
it cannot grant rights in a third party's binary that Chorizite did not own.

This is not an open-source license question and no NOTICES file fixes it. It is
the same category of risk the project already accepts elsewhere (the whole
enterprise targets a decompiled client), and it is upstream Chorizite's file
shipped unmodified — but it should be a *conscious* acceptance, recorded, rather
than an unnoticed passenger. **Verdict: SHIP-WITH-NOTICE**, flagged to the owner
as a judgement call, not a legal clearance. Cheapest mitigation if the owner
wants it gone: `acclient.map` is a Chorizite.Core content file — check whether
the host actually reads it at runtime and, if not, exclude it from the archive.

### 4b. `SigScan.dll` — prebuilt native binary, no source, no license

`external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/SigScan.dll` is
committed as a binary. In-tree there is only the P/Invoke side
(`Lib/SigScanner.cs` → `InitializeSigScan` / `SigScan` / `FinalizeSigScan`); the
csproj explicitly hand-copies it (`<None Update="SigScan.dll">`) and removes it
from `NativeLibs`. **No C/C++ source, no separate license file.**

Formally it is covered by the repo-wide Chorizite MIT `LICENSE.md`. Practically
it is an opaque native DLL of unknown authorship inside an archive whose entire
defence (per `THIRD-PARTY-PROVENANCE.md`) is "the opposite of the opaque-DLL
pattern". **Verdict: SHIP-WITH-NOTICE** — list it explicitly in the provenance
manifest as "Chorizite-supplied prebuilt native helper, MIT per Chorizite's repo
license, no upstream source located" rather than letting it ride anonymously.

### 4c. Our modified Chorizite — MIT attribution must survive the patching

We ship a **modified** `Chorizite.NativeClientBootstrapper.dll`
(`tools/chorizite-patches/dx-attach-init.patch` + `per-pid-log.patch`). MIT
permits this outright; the only duty is retaining the copyright notice
(`Copyright 2024 Chorizite`). Already the plan in `THIRD-PARTY-PROVENANCE.md`.
**SHIP-OK**, provided the MIT text lands in the archive and the pinned upstream
commit is recorded.

### 4d. Prerelease pin: `SharpGen.Runtime` 2.2.0-**beta**

MIT, so no license issue — noted only because shipping a `-beta` transitive
dependency to players is a supply-chain/stability smell worth a deliberate
decision. Not a license finding.

---

## 5. Verdict table

| # | Component | License | Verdict | Required action |
|---|---|---|---|---|
| 1 | **Reloaded.Hooks 4.3.3, Reloaded.Hooks.Definitions 1.15.0, Reloaded.Memory 7.0.0, Reloaded.Memory.Buffers 2.0.0, Reloaded.Assembler 1.0.14-mem-buffers-2.0** | **LGPL-3.0-or-later** | **SHIP-WITH-NOTICE** | Ship **full LGPL-3.0 text + full GPL-3.0 text** in the archive. State in NOTICES: "This product uses Reloaded.Hooks / .Memory / .Memory.Buffers / .Assembler by Sewer56, licensed LGPL-3.0-or-later; sources at github.com/Reloaded-Project. The libraries are unmodified and ship as separate DLLs; you may replace them." Applies to the Chorizite host **and all three plugin folders** (FASM travels with Reloaded.Assembler). |
| 2 | **SixLabors.ImageSharp 3.1.11, ImageSharp.Drawing 2.1.7, Fonts 2.1.3** | Six Labors Split License v1.0 → **Apache-2.0 grant applies to us** | **SHIP-WITH-NOTICE** | Ship **Apache-2.0 license text** + `Copyright (c) Six Labors`. NOTICES must name **Apache-2.0 only** (split-license clause: "reference the granted license only in all documentation"). Record the qualifying basis: AGPL-3.0 open-source consumption **and** transitive dependency. **Do not** downgrade to an Apache-era ImageSharp — no benefit, real API risk. |
| 3 | FASM 1.73 (`FASM.DLL`, `FASMX64.DLL`) | custom permissive (BSD-2-like) | **SHIP-OK** | None — the build already copies `FASM-LICENSE.TXT` next to the DLLs in every plugin folder. Verify it survives archive assembly. |
| 4 | MIT set — Chorizite.*, Autofac, Newtonsoft.Json, NJsonSchema, Namotion.Reflection, NAudio.*, SharpDX.*, SharpGen.Runtime.*, Vortice.*, Cyotek, Iced, Medo.PcapRW, Microsoft.Extensions.* (9.x), Microsoft.Bcl.*, Microsoft.Diagnostics.*, System.* | MIT | **SHIP-WITH-NOTICE** | Standard MIT: reproduce copyright + permission notice. One consolidated `NOTICES.txt` section covers the whole set. |
| 5 | Apache-2.0 set — Microsoft.Extensions.Configuration/Logging/Options/Primitives **2.1.1** | Apache-2.0 | **SHIP-WITH-NOTICE** | Include Apache-2.0 text (shared with #2 — one copy serves both). |
| 6 | Zlib set — FontStashSharp 1.3.10, .Base 1.1.9, .Rasterizers.StbTrueTypeSharp 1.1.9 | Zlib | **SHIP-OK** | Attribution line in NOTICES; Zlib imposes no file-inclusion duty on binary distribution. |
| 7 | StbImageSharp 2.30.15, StbTrueTypeSharp 1.26.12 | Public Domain **or** MIT (our choice) | **SHIP-OK** | None. Record in provenance that the packages carry no license metadata and the terms come from the upstream StbSharp repos. |
| 8 | .NET 8.0.26 runtime embedded in `zzpatcher.exe` (NETCore.App + WindowsDesktop.App/WPF) | MIT | **SHIP-WITH-NOTICE** | Copy `~/.nuget/packages/microsoft.netcore.app.runtime.win-x64/8.0.26/LICENSE.TXT` and `THIRD-PARTY-NOTICES.TXT` into the archive. |
| 9 | `acclient.map` (retail client link map) | **not an OSS question** — third-party proprietary derivative | **SHIP-WITH-NOTICE ⚠ owner judgement** | Not clearable by any license file. Either drop it if the host does not read it at runtime, or record it as a knowing acceptance alongside the project's existing decomp posture. |
| 10 | `SigScan.dll` (prebuilt native, no source) | MIT by Chorizite repo license; **no upstream source located** | **SHIP-WITH-NOTICE** | List explicitly in the provenance manifest as a prebuilt native helper with no located source, rather than shipping it anonymously. |
| 11 | AcmeLauncher / AcmeInject own code | AGPL-3.0 (ours) | **SHIP-OK** | Ship root `LICENSE.md`. Zero third-party NuGet surface in either — verified via both `.deps.json` (0 packages each). |
| 12 | **Fizzler 1.3.1, Fizzler.Systems.HtmlAgilityPack 1.2.1** (inside `plugins/RmlUi`) | **LGPL-3.0-or-later** | **SHIP-WITH-NOTICE** | Same treatment as row 1. NOTICES must name them, state LGPL-3.0-or-later, point at `github.com/atifaziz/Fizzler` and `github.com/atifaziz/Hazz`, and record that they are unmodified separate DLLs the user may replace. LGPL/GPL texts already ship for row 1 — one copy serves both. **Do not record these as MIT.** |
| 13 | **FreeType 2**, statically linked into `RmlUiNative.dll` | **FTL** (dual FTL/GPLv2; FTL branch taken) | **SHIP-WITH-NOTICE** | FTL §1 requires, for redistribution **in binary form**, "a disclaimer that states that the software is based in part of the work of the FreeType Team, in the distribution documentation"; a URL is encouraged, not required. §2's duty to carry `FTL.TXT` applies to **source** redistribution, and no FreeType source ships. ⇒ NOTICES disclaimer + `https://www.freetype.org`; **no** `licenses/FTL.TXT`. |
| 14 | **Lato** (`plugins/RmlUi/assets/LatoLatin-Regular.ttf`) and **Courier Prime Code** (embedded in `RmlUiNative.dll`) | **SIL OFL 1.1** | **SHIP-WITH-NOTICE** | Unlike the FTL, the OFL *does* require its text to accompany the fonts ⇒ ship `licenses/OFL-1.1.txt` and credit both copyright holders in NOTICES. Neither font is sold on its own and neither uses a Reserved Font Name in a modified form, so no other clause bites. |
| 15 | **Tencent xLua** + the **Lua 5.4.1** interpreter inside `plugins/Lua/runtimes/win-x86/native/xlua.dll` | MIT / MIT | **SHIP-WITH-NOTICE** | Name both in the consolidated MIT section rather than shipping a native blob anonymously (same principle as row 10). © 2016 THL A29 Limited; © 1994-2020 Lua.org, PUC-Rio. |
| 16 | **Chorizite.Plugins.RmlUi 0.0.10, Chorizite.Plugins.Lua 0.0.13, RmlUi.Net 1.0.1, RmlUi (C++), Cortex.Net 0.4.1, HtmlAgilityPack 1.5.1, System.Drawing.Common 9.0.2, System.Private.Windows.Core, Microsoft.Win32.SystemEvents 9.0.2, System.Xml.XPath.XmlDocument 4.3.0** | MIT | **SHIP-WITH-NOTICE** | Fold into the consolidated MIT section (row 4). ⚠ The two `Chorizite.Plugins.*` **repos carry no LICENSE file**; the MIT determination is the publisher's nuspec SPDX expression plus the parent project's repo-wide MIT. Recorded as a metadata note, not a gap. |

### BLOCKERS

**None.** Both flagged suspects clear:

- `Reloaded.*` is **LGPL-3.0, not GPL-3.0** — and LGPL-3.0 is compatible with our
  AGPL-3.0, consumed as unmodified separate DLLs.
- `SixLabors.ImageSharp 3.1.11` is split-licensed, and we **qualify for the free
  Apache-2.0 branch twice over** (AGPL open-source consumption; transitive
  dependency).

The bundle is **shippable once the notice set below is assembled**. Until then
the state is *"no blocker, but not yet compliant"* — the LGPL §4(b) and
Apache-2.0 §4 duties are real and currently unsatisfied by the archive.

### Minimum notice set to add to the release archive

```
licenses/
  LICENSE-ACME.md                  # our AGPL-3.0 (repo root LICENSE.md)
  LGPL-3.0.txt                     # required by Reloaded.* (LGPL §4(b))
  GPL-3.0.txt                      # required: LGPLv3 incorporates GPLv3
  Apache-2.0.txt                   # SixLabors (granted branch) + MS.Extensions 2.1.1
  MIT.txt                          # consolidated MIT text
  Zlib.txt                         # FontStashSharp family
  OFL-1.1.txt                      # Lato + Courier Prime Code (rows 14) — the OFL
                                   #   REQUIRES its text to travel with the fonts
  FASM-LICENSE.TXT                 # already emitted by the build
  dotnet-LICENSE.TXT               # .NET 8.0.26 runtime
  dotnet-THIRD-PARTY-NOTICES.TXT   # .NET 8.0.26 runtime
NOTICES.txt                        # per-package attributions + granted-license statements
THIRD-PARTY-PROVENANCE.md          # component provenance + SHA-256 manifest
```

Housekeeping (not licensing): strip `Reloaded.Assembler.targets` from the three
plugin folders — an MSBuild build asset with no runtime role in a player archive.

---

## 6. Checklist status vs. `THIRD-PARTY-PROVENANCE.md`

- [x] **Reloaded.*** — resolved: **LGPL-3.0-or-later**, versions pinned in §2.
      Not GPL. Compatible with AGPL-3.0. Obligations = notice + LGPL/GPL texts +
      upstream source pointer.
- [x] **SixLabors.ImageSharp** — resolved: ships **3.1.11**, Six Labors Split
      License v1.0; we qualify for the **Apache-2.0** branch. No version pin
      change needed.
- [ ] Per-file `sha256` → `SHA256SUMS.txt` (packaging step).
- [ ] Assemble `licenses/` + `NOTICES.txt` per §5.
- [ ] Record the pinned Chorizite upstream commit this build derives from.
- [ ] Re-validate `dx-attach-init` + `per-pid-log` patches (`git apply --check`).
- [ ] Owner decision on `acclient.map` (§4a).

---

## 7. Post-audit resolutions (orchestrator, same day)

- **`acclient.map` → EXCLUDE from the archive (evidence, not judgement).** Its only
  reader is `SymbolResolver.ResolveACClientSymbol` (crash-log symbolication), and the
  crash-handler registration that reaches it is **commented out** in the vendored build
  (`Chorizite/Chorizite.Core/Chorizite.cs:79`); the read is also try/caught → "unknown".
  Excluding the file costs nothing but symbol names in a code path that never runs.
  Remove it from the runtime folder at packaging; keep it out of SHA256SUMS.
- **AcmeSky baked assets → SHIP with credits (provenance traced,
  `/mnt/wbterminal2/dat-patch-sky/PROVENANCE.txt`):**
  - weather masks: **NASA Blue Marble** crop (`local_weather_nasa`) — NASA imagery is
    public domain; add credit line "Cloud coverage derived from NASA Blue Marble
    imagery" to NOTICES (no endorsement implication).
  - stars: **Yale Bright Star Catalog** (9,096 stars, via takram `stars.bin`) — factual
    astronomical catalog, freely redistributable; credit line suffices.
  - palettes: sampled from **Bruneton precomputed-scattering LUTs** — reference
    implementation BSD-3-Clause (Eric Bruneton), consumed via **@takram/three-atmosphere
    / three-clouds (MIT)**, whose ports our shaders cite in-file. Add both to NOTICES:
    MIT text for takram, BSD-3 attribution for Bruneton.
- These close §6's "Owner decision on acclient.map" and the audit's sky-assets open
  item; the remaining unchecked boxes are the packaging-time mechanical steps.

---

## 8. Addendum — the two stock Chorizite plugins (2026-08-25)

`plugins/RmlUi` and `plugins/Lua` were added to the pack so AcmeRedline's panel
can exist at all (before this the plugin could not start: `PluginManager.cs:196-203`
aborts a plugin whose declared dependency has no manifest in `plugins/`). Full
component table in §1c2; verdict rows 12–16 in §5.

**Verdict: still no BLOCKER.** One correction and two additions to the obligation
set:

1. **Fizzler and Fizzler.Systems.HtmlAgilityPack are LGPL-3.0-or-later, not MIT.**
   No new licence text is needed — `LGPL-3.0.txt` and `GPL-3.0.txt` already ship
   for `Reloaded.*` — but they must be named in NOTICES with the same
   unmodified/separate/replaceable statement.
2. **FreeType 2 is statically linked into `RmlUiNative.dll`.** Binary
   redistribution under the FTL needs the disclaimer in the documentation, which
   NOTICES now carries; the licence file itself is a source-redistribution duty
   and does not apply.
3. **Two OFL-1.1 fonts ship**, one loose and one embedded. `licenses/OFL-1.1.txt`
   is new and is enforced by the assembler's verify pass.

**Enforcement.** These are not prose promises. `tools/plugin-pack/assemble_plugin_pack.sh`
fails its verify pass if `licenses/OFL-1.1.txt` is missing, if either stock plugin
folder or its `win-x86` native blob is absent, or if `NOTICES.txt` stops naming
`Fizzler`, `FreeType` or the `Open Font License`.

**Provenance mechanism.** The two folders are *not* committed. They are fetched by
`tools/plugin-pack/fetch_stock_plugins.sh`, which pins the URL and version and
verifies each archive against the SHA-256 published by the Chorizite plugin index
— the same index the runtime reads at `PluginManager.cs:108,126`. Re-running the
script is the reproduction step; a per-file digest manifest lands beside the
folders as `STOCK-PLUGINS.sha256`.

### 8a. Open item for the owner — the leak gate now fails on PRE-EXISTING files

Not caused by this work, but found by it, and it blocks cutting a pack. The
widened `tools/leak_scan.py` (commits `ffb8e324`, `f467da35`, 2026-08-24) had not
been run end-to-end against a full pack. It now fails with **18 hits, none of them
in anything added here** — the stock plugin folders, `AcmeRedline` and
`licenses/OFL-1.1.txt` all scan clean, in both encodings, with `--all-files`:

| File | Hits | What it is |
|---|---|---|
| `licenses/dotnet-THIRD-PARTY-NOTICES.TXT` | 9 | attribution e-mail addresses inside **Microsoft's own** notices file (`dotnet@microsoft.com`, `jloup@gzip.org`, …). Required by row 8; cannot be edited. |
| `AcmeLauncher/…/System.Printing.dll` (pre-bundle scan) | 7 | **false positives**: the e-mail regex matching C++/CLI mangled names such as `?A0x132e1b53@vc.cppcli.attributes@SA_Yes@@YMXXZ`. |
| `Chorizite/SigScan.dll` | 1 | `Aikar@Windower.net` in the prebuilt native helper's VERSIONINFO `LegalCopyright` (row 10). |
| `Chorizite/Chorizite.Injector.dll` | 1 | upstream's `C:\Users\…\AppData\Local\Temp\SymbolCache` string. |

All four are third-party content or scanner false positives; none discloses
anything about this project or its users, and each falls in the allowlist
category the scanner already documents ("paths belonging to the AUTHORS of
packages we consume"). Fixing them means adding allowlist entries (or a
licence-text file class) to a gate that was deliberately hardened the day before,
so it is left as an **owner decision** rather than taken unilaterally.

One thing that is *not* an open item: the `/home/wbterminal/...` RSDS hits seen on
a first `--no-build` run were stale build output only. Rebuilding every shipped
project with the assembler's own `-p:PathMap` removes all of them, confirming
`f467da35` works as intended.
