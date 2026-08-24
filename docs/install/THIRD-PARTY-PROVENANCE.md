# Third-party provenance — ACME release bundle

The ACME release archive bundles the **Chorizite** plugin runtime and its
dependencies. This document exists so that bundling is *transparent*, not opaque
— the exact thing the preservation community objects to is a mystery binary with
no stated origin, and the answer to that is provenance, not omission.

**Status:** the license audit that gated this document is complete —
see [`LICENSE-AUDIT-2026-08-24.md`](./LICENSE-AUDIT-2026-08-24.md). No blockers.
The tables below are the packaging-time manifest; per-file SHA-256 digests are
appended at packaging (§4).

## 1. Why we bundle (and why it's defensible)

- **We must.** The pack requires a *modified* Chorizite build (our attach-init
  fix, `tools/chorizite-patches/dx-attach-init.patch`, needed so plugins load
  when injected into an already-running client). A user downloading stock
  Chorizite from upstream would NOT have that fix — plugins wouldn't load. So
  "download it yourself" cannot work here.
- **It's license-clean.** Chorizite is **MIT** (`external/chorizite/Chorizite/
  LICENSE.md`, "Copyright 2024 Chorizite") — redistribution and modification are
  explicitly permitted with the notice retained.
- **Our modifications are published.** Every change we make to the vendored
  runtime lives as a reviewable patch in `tools/chorizite-patches/`. Nothing is
  hidden.

This is the opposite of the opaque-DLL pattern: an MIT open-source runtime, our
own build, with our delta published and provenance listed below.

**Project license:** the ACME work itself is **AGPL-3.0-only** (repo root
`LICENSE.md`). This is what qualifies the bundle for the free Apache-2.0 branch
of the Six Labors licensing¹ and what makes the LGPL-3.0 dependencies
straightforward — see the audit, §0.

## 2. Per-component provenance

Columns: **Component** = the file or file group as it appears in the archive ·
**Version** = the pinned version (from `.deps.json` / `.csproj`) ·
**Upstream** = canonical source · **License** = SPDX, or the granted branch where
**Role** = why it is in the bundle.

### 2a. Ours (this project) — AGPL-3.0

| Component | Version | Upstream | License | Role in the bundle |
|---|---|---|---|---|
| `zzpatcher.exe` | _(GitVersion at build)_ | this repo, `AcmeLauncher/` | AGPL-3.0-only | Player-facing launcher/configurator. Self-contained single-file WPF publish; **zero third-party NuGet dependencies** (embeds the .NET runtime — see 2e). |
| `AcmeInject.exe` + `.dll` | _(build)_ | this repo, `AcmeInject/` | AGPL-3.0-only | Base-aware x86 injector: CreateProcess-suspended → remote `LoadLibraryW` of the Chorizite bootstrapper → `Bootstrap` at `remoteBase + RVA`. **Zero third-party NuGet dependencies.** |
| `plugins/AcmeLights/AcmeLights.dll` | _(build)_ | this repo, `AcmeLights/` | AGPL-3.0-only | Chorizite plugin: lighting + P5 bloom on the client D3D9 device. |
| `plugins/AcmeSky/AcmeSky.dll` + `assets/sky/**` | _(build)_ | this repo, `AcmeSky/` | AGPL-3.0-only | Chorizite plugin: baked sky compositor (own D3D11 device). |
| `plugins/AcmeRagdoll/AcmeRagdoll.dll` + `ragdoll_profiles.json` | _(build)_ | this repo, `AcmeRagdoll/` | AGPL-3.0-only | Chorizite plugin: physics ragdoll deaths. |
| `plugins/AcmeRedline/AcmeRedline.dll` + `assets/**`, `manifest.json` | _(build)_ | this repo, `AcmeRedline/` | AGPL-3.0-only | Chorizite plugin: in-game art-annotation / redline queue (experimental). |
| `Chorizite.NativeClientBootstrapper.dll` | vendored + patched | github.com/Chorizite/Chorizite | MIT (modified work) | Chorizite's bootstrapper **patched by us** (`dx-attach-init.patch`, `per-pid-log.patch`). Modified MIT work; patches published in `tools/chorizite-patches/`. |

> **Sky asset provenance** (traced 2026-08-24, audit §7): weather masks derive
> from **NASA Blue Marble** imagery (public domain; credit in NOTICES); the star
> field from the **Yale Bright Star Catalog** (factual astronomical data) via
> @takram's MIT `stars.bin`; the sky palettes sample **Bruneton
> precomputed-scattering LUTs** (BSD-3-Clause reference, consumed through the
> MIT @takram/three-atmosphere ports our shaders cite in-file). All credited in
> `NOTICES.txt`.

### 2b. Chorizite project — MIT (© 2024 Chorizite)

Upstream for all: `https://github.com/Chorizite/Chorizite` (record the pinned
commit in §4). `Chorizite.DatReaderWriter` is © 2024 ACClientLib, also MIT.

| Component | Version | License | Role in the bundle |
|---|---|---|---|
| `Chorizite.Core.dll` | vendored | MIT | Plugin host: DI container, plugin ALC, DAT access, UI. |
| `Chorizite.Common.dll` | 1.0.3 (pkg) | MIT | Shared primitives for Core/ACProtocol. |
| `Chorizite.ACProtocol.dll` | 1.0.1 (pkg) | MIT | Typed AC network message classes; AcmeRagdoll subscribes to its parser. |
| `Chorizite.ACBindings.dll` | vendored | MIT | Retail client memory-layout bindings. **Ships inside each plugin folder** (not host-owned — the plugin ALC's resolver requires it beside the plugin). |
| `DatReaderWriter.dll` | 1.0.0 (pkg) | MIT | DAT file reader used by the host. |
| `SigScan.dll` | vendored binary | MIT per Chorizite repo license | Prebuilt **native** signature scanner, P/Invoked by `Lib/SigScanner.cs`. ⚠ **No upstream source located in-tree** — listed explicitly rather than shipped anonymously (audit §4b). |
| `acclient.map` | vendored data | ⚠ **EXCLUDED from the archive** | Link map of the retail Turbine `acclient.exe` in Chorizite.Core's build output. Its only runtime reader is disabled in the vendored build (audit §7), so packaging drops it — the row stays here so the exclusion is a recorded decision, not an accident. |

### 2c. Copyleft / footnoted — notice obligations apply

These are the two dependencies the pre-ship checklist flagged. Both cleared; both
require notices the archive must carry (audit §3, §5).

| Component | Version | Upstream | License | Role in the bundle |
|---|---|---|---|---|
| `Reloaded.Hooks.dll` | 4.3.3 | github.com/Reloaded-Project/Reloaded.Hooks | **LGPL-3.0-or-later** | Inline trampoline detour engine. The Chorizite bootstrapper hooks client C++ functions with it; all three ACME plugins bind to that single resident copy. |
| `Reloaded.Hooks.Definitions.dll` | 1.15.0 | github.com/Reloaded-Project/Reloaded.Hooks | **LGPL-3.0-or-later** | Interfaces/attributes for the above. |
| `Reloaded.Memory.dll` | 7.0.0 | github.com/Reloaded-Project/Reloaded.Memory | **LGPL-3.0-or-later** | Memory primitives used by the hook engine. |
| `Reloaded.Memory.Buffers.dll` | 2.0.0 | github.com/Reloaded-Project/Reloaded.Memory.Buffers | **LGPL-3.0-or-later** | Near-target buffer allocation for trampolines. |
| `Reloaded.Assembler.dll` | 1.0.14-mem-buffers-2.0 | github.com/Reloaded-Project/Reloaded.Assembler | **LGPL-3.0-or-later** | Managed wrapper over FASM; assembles trampoline stubs. |
| `SixLabors.ImageSharp.dll` | **3.1.11** | github.com/SixLabors/ImageSharp | **Apache-2.0**¹ | Image decode/encode for the host's UI/texture path. Transitive via Chorizite. |
| `SixLabors.ImageSharp.Drawing.dll` | 2.1.7 | github.com/SixLabors/ImageSharp.Drawing | **Apache-2.0**¹ | Drawing primitives over ImageSharp. |
| `SixLabors.Fonts.dll` | 2.1.3 | github.com/SixLabors/Fonts | **Apache-2.0**¹ | Font loading/shaping for the above. |

> **Reloaded reaches into the plugin folders.** `Reloaded.Assembler` pulls the
> native FASM binaries (§2d) into `plugins/AcmeLights`, `plugins/AcmeSky` and
> `plugins/AcmeRagdoll` as well as the host directory. The LGPL notice covers
> **all four** directories, not just `Chorizite/`.
>
> ¹ The SixLabors packages reach us under an **Apache-2.0** grant; per its terms,
> Apache-2.0 is the license this documentation references. The grant basis is
> recorded in the project's internal license audit (not shipped).

### 2d. Permissive transitive dependencies (redistributed as-is)

Pulled in by the vendored Chorizite host or by the ACME plugins. Full
determination method per package is in the audit, §2.

| Component | Version | Upstream | License | Role in the bundle |
|---|---|---|---|---|
| `FASM.DLL`, `FASMX64.DLL` | 1.73 | flatassembler.net (© Tomasz Grysztar) | custom permissive (BSD-2-like) | Native assembler backing `Reloaded.Assembler`. **`FASM-LICENSE.TXT` already ships beside them** in every plugin folder. |
| `Iced.dll` | 1.17.0 | github.com/icedland/iced | MIT | x86/x64 disassembler used by the hook engine. |
| `Autofac.dll` | 8.4.0 | autofac.org | MIT | DI container for the Chorizite host. |
| `Newtonsoft.Json.dll` | 13.0.3 | newtonsoft.com/json | MIT | JSON for host config/schema. |
| `NJsonSchema.dll`, `NJsonSchema.Annotations.dll` | 11.5.1 | njsonschema.org | MIT | Plugin-manifest schema validation. |
| `Namotion.Reflection.dll` | 3.4.3 | github.com/RicoSuter/Namotion.Reflection | MIT | Reflection helper for NJsonSchema. |
| `NAudio.dll`, `.Core`, `.Asio`, `.Midi`, `.Wasapi`, `.WinMM` | 2.2.1 | github.com/naudio/NAudio | MIT (© 2020 Mark Heath) | Audio playback in the bootstrapper. |
| `SharpDX.dll`, `SharpDX.Direct3D9.dll` | 4.2.0 | github.com/sharpdx/SharpDX | MIT (© 2010-2016 Alexandre Mutel) | D3D9 interop for the bootstrapper's client-device hooks. *(Package `licenseUrl` is dead; MIT confirmed upstream.)* |
| `SharpGen.Runtime.dll`, `SharpGen.Runtime.COM.dll` | 2.2.0-**beta** | github.com/SharpGenTools/SharpGenTools | MIT | COM interop runtime under Vortice. ⚠ prerelease pin (stability note, not a license issue). |
| `Vortice.Direct3D11.dll`, `Vortice.DXGI.dll`, `Vortice.D3DCompiler.dll`, `Vortice.DirectX.dll` | 3.6.2 | github.com/amerkoleci/Vortice.Windows | MIT | Managed D3D11/DXGI/D3DCompile bindings. **Ship inside the plugin folders** (AcmeSky's own D3D11 device; AcmeLights' runtime HLSL compile). |
| `Vortice.Mathematics.dll` | 1.9.2 | github.com/amerkoleci/Vortice.Mathematics | MIT | Math types for the above. |
| `FontStashSharp.dll`, `.Base`, `.Rasterizers.StbTrueTypeSharp` | 1.3.10 / 1.1.9 | github.com/FontStashSharp/FontStashSharp | **Zlib** | Font atlas/rendering for the host UI. |
| `StbImageSharp.dll` | 2.30.15 | github.com/StbSharp/StbImageSharp | **Public Domain or MIT** (our choice) | stb_image port. *(Package carries no license metadata; terms from the upstream repo.)* |
| `StbTrueTypeSharp.dll` | 1.26.12 | github.com/StbSharp/StbTrueTypeSharp | Public Domain or MIT (our choice) | stb_truetype port, backing FontStashSharp. *(No package metadata; terms from upstream.)* |
| `Cyotek.Drawing.BitmapFont.dll` | 2.0.4 | github.com/cyotek/Cyotek.Drawing.BitmapFont | MIT | Bitmap-font parsing. |
| `Medo.PcapRW.dll` | 1.2.0 | github.com/medo64/Medo.PcapRW | MIT (© 2020 Josip Medved) | pcap read/write for ACProtocol capture tooling. |
| `Microsoft.Diagnostics.Runtime.dll` (ClrMD) | 3.1.512801 | github.com/microsoft/clrmd | MIT | CLR introspection in the host. |
| `Microsoft.Diagnostics.NETCore.Client.dll` | 0.2.410101 | github.com/dotnet/diagnostics | MIT | Diagnostics IPC client. |
| `Microsoft.Extensions.Logging.Abstractions.dll`, `Microsoft.Extensions.DependencyInjection.Abstractions.dll` | 9.0.9 / 9.0.0 | github.com/dotnet/runtime | MIT | Logging/DI abstractions shared by host and plugins. |
| `Microsoft.Extensions.Configuration*.dll`, `.Logging.dll`, `.Options.dll`, `.Primitives.dll` | 2.1.1 | github.com/aspnet | **Apache-2.0** | Host configuration stack. |
| `Microsoft.Bcl.AsyncInterfaces.dll` | 1.1.0 / 9.0.0 | github.com/dotnet/runtime | MIT | Async interface polyfill. |
| `System.*.dll` (Text.Json, Collections.Immutable, Reflection.Metadata, IO.Pipelines, CodeDom, Diagnostics.DiagnosticSource, Text.Encodings.Web, Memory, Buffers, Numerics.Vectors, Runtime.CompilerServices.Unsafe, Threading.Tasks.Extensions) | 4.x – 9.0.9 | github.com/dotnet/runtime | MIT | BCL out-of-band packages carried by the host. |

**Build-only, does NOT ship:** `GitVersion.MsBuild` (6.1.0/6.3.0/6.4.0, MIT) —
build-time versioning task with no runtime assembly in the archive.

**Correction to earlier drafts:** `SDL2` / `SDL2-CS` are **not** in this bundle.
They belong to `Chorizite.OpenGLSDLBackend`, which the release archive does not
ship. Do not carry an SDL notice.

### 2e. Embedded .NET runtime (inside `zzpatcher.exe`)

| Component | Version | Upstream | License | Role in the bundle |
|---|---|---|---|---|
| `Microsoft.NETCore.App` + `Microsoft.WindowsDesktop.App` (WPF) | **8.0.26** | github.com/dotnet/runtime, github.com/dotnet/wpf | MIT (© .NET Foundation and Contributors) | `zzpatcher.exe` is a self-contained single-file publish, so the runtime (238 assemblies + `createdump.exe` + satellite resources) is embedded in the executable. Deliberate: the Install tab's own .NET-runtime check means the tool that tells you to install .NET must not itself require .NET. |

Ship the runtime pack's `LICENSE.TXT` **and** `THIRD-PARTY-NOTICES.TXT`.

## 3. Required license/notice files in the archive

Per the audit's minimum notice set (§5 there):

```
licenses/
  LICENSE-ACME.md                  # our AGPL-3.0 (repo root LICENSE.md)
  LGPL-3.0.txt                     # required by Reloaded.* (LGPL §4(b))
  GPL-3.0.txt                      # required: LGPLv3 incorporates GPLv3
  Apache-2.0.txt                   # SixLabors (granted branch) + MS.Extensions 2.1.1
  MIT.txt                          # consolidated MIT text
  Zlib.txt                         # FontStashSharp family
  FASM-LICENSE.TXT                 # already emitted by the build
  dotnet-LICENSE.TXT               # .NET 8.0.26 runtime
  dotnet-THIRD-PARTY-NOTICES.TXT   # .NET 8.0.26 runtime
NOTICES.txt                        # per-package attributions + granted-license statements
```

## 4. Build pin and per-file digests

Filled in by the packaging step. Do not hand-edit the digest block.

- Chorizite upstream commit this build derives from: `TBD-AT-PACKAGING`
- Patches applied: `tools/chorizite-patches/dx-attach-init.patch`,
  `tools/chorizite-patches/per-pid-log.patch`
  (re-validate with `git apply --check` against the pinned commit)
- Build host / SDK: `TBD-AT-PACKAGING`
- Archive name + version: `TBD-AT-PACKAGING`

### SHA-256 manifest

Every binary in the archive, one line per file, `<sha256>  <archive-relative path>`.
Mirrors `SHA256SUMS.txt` shipped alongside.

<!-- shas appended at packaging -->

## 5. Antivirus / EDR (must be surfaced to players)

The plugin pack injects code into the running client (`OpenProcess` +
`CreateRemoteThread` — the same technique all AC plugin loaders, incl. Decal,
use). Some antivirus/EDR will flag or block this. This is documented in the
install guides' troubleshooting. Mitigations: code-sign the injector before
release, and document an AV-allowlist step. A blocked injection degrades to
"full visual upgrade from the dats + exe patch, no plugins" — never a broken
game (the dats/patch layer does no injection).

## 6. Pre-ship checklist

License audit (was blocking — now cleared, see `LICENSE-AUDIT-2026-08-24.md`):

- [x] **Reloaded.*** — **LGPL-3.0-or-later** (not GPL), versions pinned in §2c.
      Compatible with our AGPL-3.0; shipped unmodified as separate DLLs.
      Obligation: LGPL + GPL texts, notice, upstream source pointer.
- [x] **SixLabors.ImageSharp** — ships **3.1.11** under **Apache-2.0**¹ (see
      §2c). No version change needed.

Remaining before packaging:

- [ ] Assemble `licenses/` + `NOTICES.txt` per §3.
- [ ] Generate per-file `sha256` into §4 and `SHA256SUMS.txt`.
- [ ] Record the pinned Chorizite upstream commit/version in §4.
- [ ] Re-validate `dx-attach-init` + `per-pid-log` patches (`git apply --check`).
- [ ] Owner decision on `acclient.map` (audit §4a) — drop it, or record a knowing
      acceptance.
- [ ] Confirm the AcmeSky baked-sky asset source + its terms (§2a note).
- [ ] Housekeeping: strip `Reloaded.Assembler.targets` from the three plugin
      folders (MSBuild build asset, no runtime role).
