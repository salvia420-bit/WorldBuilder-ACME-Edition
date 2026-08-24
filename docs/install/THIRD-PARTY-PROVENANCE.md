# Third-party provenance — ACME plugin pack

The plugin pack in the ACME release archive bundles the **Chorizite** plugin
runtime and its dependencies. This document exists so that bundling is
*transparent*, not opaque — the exact thing the preservation community objects to
is a mystery binary with no stated origin, and the answer to that is provenance,
not omission.

## Why we bundle (and why it's defensible)

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

## Binary inventory (grouped by origin)

Ours (this project):
- `AcmeInject.exe` / `.dll` — our base-aware injector (`AcmeInject/`).
- `plugins/AcmeLights`, `plugins/AcmeSky`, `plugins/AcmeRagdoll` — our plugins.
- `Chorizite.NativeClientBootstrapper.dll` — Chorizite's, **patched by us**
  (`dx-attach-init.patch`, and the per-PID log patch) — a modified MIT work.

Chorizite project (MIT, confirmed):
- `Chorizite.Core/Common/ACProtocol/Injector/Launcher/NativeClientBootstrapper/
  DocGen*.dll`, `Chorizite.ACBindings` (in a plugin).

Transitive dependencies (Chorizite's own NuGet deps, redistributed as-is):
- Microsoft.Extensions.*, System.*, Newtonsoft.Json, Autofac, NJsonSchema,
  Namotion.Reflection — established permissive (MIT / MIT-like). 
- Vortice.*, SharpDX.*, SharpGen.Runtime — MIT (Amer Koleci / SharpDX).
- Iced, StbImageSharp, StbTrueTypeSharp, FontStashSharp, Cyotek.* — permissive.
- NAudio — MIT. SDL2 / SDL2-CS — zlib / MIT.
- FASM.DLL / FASMX64.DLL — flat assembler (custom permissive license).

## ⚠ Pre-release license-audit checklist (DO NOT SHIP until cleared)

Two dependencies have non-obvious licenses that a redistributed archive must
confirm — flagged here rather than guessed:

- [ ] **Reloaded.* (Reloaded.Hooks / Memory / Assembler, by Sewer56)** — verify
      the exact license and version. Some Reloaded components have used copyleft
      terms; a copyleft dependency in a redistributed archive has obligations
      (source offer / license inclusion). Pin the version and record it.
- [ ] **SixLabors.ImageSharp (+ .Drawing, SixLabors.Fonts)** — ImageSharp moved
      to the "Six Labors Split License" at v2+/v3 (free for OSS/small use,
      commercial license otherwise). Confirm the bundled version's terms permit
      this redistribution, or pin an Apache-2.0-era version.

General checklist before packaging:
- [ ] Generate per-file `sha256` for every bundled binary into `SHA256SUMS.txt`.
- [ ] Include each dependency's LICENSE text (or a NOTICES file) in the archive.
- [ ] Record the pinned Chorizite upstream commit/version this build derives from.
- [ ] Confirm the `dx-attach-init` + per-PID-log patches still apply to that
      pinned Chorizite (re-validate via `git apply --check`).

## Antivirus / EDR (must be surfaced to players)

The plugin pack injects code into the running client (`OpenProcess` +
`CreateRemoteThread` — the same technique all AC plugin loaders, incl. Decal,
use). Some antivirus/EDR will flag or block this. This is documented in the
install guides' troubleshooting. Mitigations: code-sign the injector before
release, and document an AV-allowlist step. A blocked injection degrades to
"full visual upgrade from the dats + exe patch, no plugins" — never a broken
game (the dats/patch layer does no injection).
