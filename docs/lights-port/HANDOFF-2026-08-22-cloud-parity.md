# HANDOFF — AcmeSky cloud parity vs holtburger-web (2026-08-22, evening session)

Owner-driven session on the 1070: direct A/B of the patcher's takram cloud port against
holtburger-web (same ACE server, matched position / weather offset / time via
`setSkyTimeOverride` + freecam). Five real divergences found and fixed; one subsystem
drafted and SHELVED by owner decision. All on `integ/all-20260813`, uncommitted.

## Fixed and live-validated (all in the deployed AcmeSky.dll on the 1070)

1. **Weather-map V-flip** (`CloudShader.cs sampleWeatherC` + turbulence UV): holtburger loads
   weather/turbulence via `THREE.TextureLoader` (flipY=true, V=0 = image bottom); our D3D bake
   uploads rows top-first. The patcher sampled the entire weather GEOGRAPHY mirrored. Proven
   numerically (matched UV read R=1.0 vs holtburger R=0.0), fixed by negating V at the two
   sample sites.
2. **Tileize retired** (`Tools/bake_cloud_assets.py`): the roll-blend band gutted real deck
   content in the outer 96 texels (raw G=0.45-0.60 vs 0.07 measured) and imprinted a razor
   band-edge line. Weather .bins are now byte-parity RAW (holtburger's hard wrap seam and all).
3. **THE LINE / "hemisphere orientation" — root-caused by decomp agent**: the client view
   matrix is LANDBLOCK-LOCAL (`Render::update_viewpoint` runs `Frame::globaltolocal`), so
   invView's translation wraps 0..192 m — the cloud ECEF camera sat pinned at the pole =
   the weather tile CORNER, drawing the wrap seam as a permanent razor great-circle and
   compressing the map into concentric "latitude ring" fake-altocumulus. Fix: viewer cell id
   → global offset `((lbx,lby)*192)` for all ECEF/weather math; ray directions stay local
   (axes parallel). ⚠ Cell-id source: `SmartBox::smartbox->viewer.objcell_id` (0x0083DA58).
   The `Render::update_viewpoint` global (0x0081EF04) is UNUSABLE at our hook point — the
   character-panel 3D preview renders last and leaves it at its synthetic cell (measured
   0xFFFF0002 stuck through in-world frames). `ClientState.Camera` now carries CellId;
   0xFFFF____ is treated as "no offset".
4. **Output dithering** (`AtmosphereShader.cs DitherColor`, three final outputs): holtburger's
   composer runs takram `DitheringEffect` (three.js `dithering()`) after tonemap; the patcher
   quantized undithered → banding on smooth spherical gradients.
5. **Weather mip scale**: vendor clouds.frag multiplies `getMipLevel(...)` by the
   `mipLevelScale` UNIFORM (0.25, live-read from holtburger) at the call site; the port had
   only the inner 0.1 constant → 4× coarser weather mips banding across thin veils.

## Ported but DEFAULT-OFF (known artifact)

**M2.2 temporal resolve** (takram cloudsResolve TAA path: velocity MRT from cloud-front
reprojection, variance clipping, ping-pong history; knobs `cloudtaa`/`cloudtaagamma`/
`cloudtaaalpha`). Live A/B showed it introduces VERTICAL SLAB SECTIONS through cumulus
(raw march with STBN grain looks better) → `cloudtaa=0` is the shipped default. The
reprojection velocity path needs debugging before re-enabling (suspect: prevWorldToClip /
velocity sign or the landblock-crossing frame; the raw-vs-taa A/B captures are in the
session scratchpad `cloudcmp/sky-{frag,notaa}.png`).

## DRAFTED, NOT INTEGRATED — owner decision "don't add anything, stay ≥60 fps"

Opus-drafted **Beer Shadow Map + light shafts port** (the last big holtburger gap — shaded
cloud interiors + crepuscular rays):
- `docs/lights-port/DESIGN-2026-08-22-cloud-bsm-shafts.md` — full design + the four fenced
  diffs for AtmosphereShader/CloudShader/SkyConfig/LiveSkyCompositor (apply-ready).
- `AcmeSky/Services/LiveSky/CloudShadowShader.cs` (HLSL, compiles) and
  `CloudShadowCascades.cs` (CascadedShadowMaps.ts math in global-AC space).
Budget: cascades ~0.6-1.5 ms; the risk is the light-shaft march (cap via `shaftiters=150`).
Do NOT wire in without the owner revisiting the 60 fps floor.

## Perf verdict (owner-witnessed)

Clean conditions, 1080p, full storm veil, `cloudminstep=10` (takram ULTRA, now default):
**65 fps**. The earlier "30 fps" scare was measurement tooling: AcmeLights `dump=1`
(full-backbuffer GetRenderTargetData sync + 8 MB BMP writes, 31 fps) plus an off-screen
holtburger Chrome sharing the GPU (~5 fps). minstep 50→10 measured FREE (31/31 and 60/65
windows) — the march is not the bottleneck; suspected structural cost is the compositor's
per-frame full-res readback→D3D9 upload sync (unmeasured, next perf lane).

## Ops notes

- Capture scripts (`scratchpad cloudcmp/skyvar.sh` + `cleancfg.sh`) now AUTO-RESTORE the
  clean sky.cfg — three separate user-visible incidents today came from leaving
  `campitch`/`dump` hot after captures ("sky turns with camera" = campitch pitch).
- sky.cfg current defaults: `time=0.5` (noon pin — set `time=-1` for real server time),
  `cloudtaa=0`, `cloudminstep=10`, `storm=-1` (auto; `storm=0` forces the FAIR look with
  the 3.5 km alto deck = the legitimate high-cloud detail).
- Two acclient crashes today were the ENV-GEO TEST DATS, not plugins: `AnimData::UnPack`
  +0x16 AV (16:26) and a stack-range unknown-module AV (17:02) — dat-patch lane should
  audit the animation records in the r10/env-geo portal on `D:\ac-dat-test`.
- The wine doc's black-sky prediction was confirmed: the 1070 ran a pre-`9e625712` AcmeSky;
  warmup fix deployed early in the session (sky no longer black).
