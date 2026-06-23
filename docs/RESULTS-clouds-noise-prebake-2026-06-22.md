# RESULTS — Cloud noise prebake (Lever A): implemented + verified on the GTX 1070 (2026-06-22)

Follow-up to `docs/HANDOFF-perf-followups-3-levers-2026-06-22.md` (Lever A) and
`docs/RESULTS-clouds-default-on-1070-steady-state-ab-2026-06-22.md`. The steady-state A/B showed
clouds add ~0 fps on the 1070 (CPU-bound world, idle GPU), so the **only** remaining barrier to
shipping clouds default-on was **cold-load shader compile**. This implements the prebake that removes
it, and verifies it on the real 1070.

## TL;DR

Clouds now load their four noise textures from **pre-baked assets** (default) instead of generating
them on the GPU at boot. Verified on the real 1070: the prebaked path compiles **exactly 4 fewer
shader programs** (the noise bakes), still has all four noise textures (loaded from assets), and
renders clouds **identically**. The seconds-level cold-load win is **not measurable on headless
Chromium** (ANGLE compiles fast there) — it lands on the user's *headed* Chrome-desktop 1070 where
shader link is synchronous.

> **★ CORRECTION 2026-06-23 (this section originally understated the win at "~6–13s").** Cross-
> referencing the goal1 72-program manifest (`shader-manifest-full.json`, real-1070 synchronous,
> KHR `maxThreads=null`) with the per-program GLSL analysis (`all-analyses.json`) shows the 4 programs
> this prebake removes are manifest **#0 LocalWeather (25.9s) + #1 turbulence/curl (6.1s) + #23
> CloudShape/CloudShapeDetail (0.8s) = ~33s** of synchronous cold-link. I had wrongly attributed #0's
> 26s to "relocatable driver warmup" — but a dedicated goal1 agent read prog-00's GLSL and identified
> it as the LocalWeather bake itself (an unrolled 8-octave Perlin + 27-iter Worley ALU kernel that
> stresses the D3D11 fxc optimizer), removed outright by `proceduralTextures=false`. So **the real
> saving is ~33s** (the handoff's original "~33s noise bake" estimate was correct), not ~6–13s. A few
> seconds of unavoidable first-link driver init relocates to whatever program links first, so net is
> ~25–33s. The 2 cloud *render* programs (CloudsMaterial 2.7s + CloudsResolveMaterial 2.8s) remain.
> This makes clouds-default-on far more viable on the *cold-load* front too, not just steady-state.

## What was implemented

- **Assets** (`apps/holtburger-web/assets/clouds/`, committed): takram's canonical noise for this
  vendored `ref` (`vendor/.../constants.ts` = `45a1c6c1`) — `shape.bin` (128³ R8, 2 MB),
  `shape_detail.bin` (32³ R8), `local_weather.png` (512² RGBA), `turbulence.png` (128² RGBA). These
  are the noise the procedural shaders generate, so the output is equivalent by construction.
- **`scene3d/cloud_overlay.js`**: a prebaked loader (default) that `fetch`es the assets and assigns
  plain `Data3DTexture`/`Texture` (matching the procedural texture config exactly: RedFormat / linear /
  repeat for the `.bin`, mipmapped RGBA for the `.png`). Assigning a plain texture routes through the
  CloudsEffect setters' non-procedural branch, so the 4 GPU noise-bake programs are never created.
  Procedural path kept as fallback (auto on load failure) and via `?cloudProcedural=on`. The cloud
  **layer config + 0.5 coverage** were moved out of the (previously procedural-only) block so they
  apply to both paths — otherwise prebaked would have silently dropped the alto deck + coverage.
- **`scene3d/index.js`**: `?cloudProcedural=on` escape; the `[clouds-d]` log reports `noise=prebaked|procedural`.
- All four procedural textures are **one-shot** (`Procedural*Base` sets `needsRender=false` after the
  first bake, nothing resets it), so static prebaked textures are behaviour-identical, not a quality change.

## Verification (real GTX 1070, headless, ANGLE/D3D11 — renderer string NVIDIA confirmed)

Two arms, `?clouds=on&quality=mid`, outdoor Holtburg, fresh browser each (cold shader cache):

| arm | total programs linked | fullscreen-quad programs | cloudInfo |
|---|---:|---:|---|
| `?cloudProcedural=on` | **49** | 14 | `procedural:true`, all 4 noise textures GPU-generated |
| default (prebaked) | **45** (−4) | 10 (−4) | `prebakedLoaded:true, procedural:false`, all 4 textures loaded, `lastError:null` |

- **Structural saving confirmed:** both counts drop by exactly **4** — the four noise-bake programs.
  The ~10 shared fullscreen cloud-pipeline passes (raymarch/resolve/shadow) remain in both.
- **Functional + visual parity:** both arms render clouds correctly. See
  `cloud-prebake-1070-2026-06-22/parity-{procedural,prebaked}.png` (same dusk, same framing — the
  cloud structure matches; the minor rain-streak difference is weather animation, not the noise).

## Cold-load magnitude — honest accounting

The **seconds saved are not measurable on headless Chromium**: there `getProgramParameter(LINK_STATUS)`
does not block — ~0 ms across all 49 programs, even with `KHR_parallel_shader_compile` force-disabled —
so ANGLE links fast and there is no stall to cut. The cold-load **stall goal1 measured lives on the
user's *headed* Chrome-desktop 1070** (goal1: "KHR present but maxThreads=null" → synchronous link),
which the "1070 tests never on screen" rule forbids running headless.

From goal1's breakdown of clouds' ~38.9 s `?clouds=on` cold contribution (manifest + per-program
GLSL analysis, real-1070 synchronous link) — see the ★CORRECTION at the top, which supersedes the
original "driver warmup" reading here:
- **#0 LocalWeather noise bake = 25.9 s** — a one-time offscreen `RawShaderMaterial` bake of an
  unrolled 8-octave Perlin + 27-iter Worley ALU kernel; the cost is D3D11 fxc optimizing the giant
  arithmetic DAG, **not** driver warmup. Removed outright by `proceduralTextures=false`.
- **#1 turbulence/curl noise = 6.1 s** + **#23 CloudShape/CloudShapeDetail = 0.8 s** — the sibling
  bakes, also removed by the prebake. (Plus the noise **bake** run itself — the 3D layer draws.)
- Total removed = **~33 s**. A few seconds of unavoidable first-link driver init relocates to whatever
  program links first, so net ≈ **~25–33 s**.
- The 2 cloud **render** programs (`CloudsMaterial` ~2.7 s + `CloudsResolveMaterial` ~2.8 s) remain.

So: **the prebake cuts ~33 s of synchronous cold-link** on the real 1070 (clouds=on) — the handoff's
original "~33 s noise bake" was correct — while keeping clouds visually identical. Combined with the
light-pool trim (surface family 59.6 s → ~14 s), the two shipped fixes take the clouds=on cold shader-
link from ~100 s → ~22 s.

## Risk / rollback

Low. Assets are the canonical version-matched noise; the loader auto-falls-back to procedural if a
fetch fails (clouds never silently break), and `?cloudProcedural=on` forces the old path. Combined with
the steady-state result, **clouds default-on is now unblocked on both fronts** (≈0 fps cost + reduced
cold load).

## Artifacts

`cloud-prebake-1070-2026-06-22/`: `parity-{procedural,prebaked}.png`, `cloud-prebake-verify.mjs`
(the on-1070 harness), `cloud-prebake-report.json`. Assets under
`external/holtburger/apps/holtburger-web/assets/clouds/`.
