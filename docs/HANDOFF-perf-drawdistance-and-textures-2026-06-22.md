# HANDOFF — Holtburger perf: draw-distance streaming + texture VRAM/decode (2026-06-22)

Two independent goals, both surfaced by a real-GPU (GTX 1070) perf probe. **Scope is
deliberately narrow:** this is *only* about (1) what gates draw distance and (2)
texture memory/decode cost. It intentionally excludes the terrain-appearance work
(blending, geometry rounding, cross-client envelope, geology/atmosphere) — that's
tracked separately.

> Status: **diagnosed, nothing built.** One probe number (resident texture VRAM) is
> still unmeasured — see "Re-probe" — but the directional findings are solid.

---

## Shared evidence — the 3-arm 1070 probe

Headless (session-0, real GPU) Playwright probe, three arms by URL flag. Verified:

- **GPU is real hardware:** `ANGLE NVIDIA GeForce GTX 1070 D3D11` on every arm — not swiftshader.
- **Steady-state, once loaded, is idle:** vanilla = 60 fps, main thread **99.4 % idle**. All cost is in *streaming/baking new terrain*, not in drawing it.

| metric | A: vanilla (`pvsRingRadius=6 lbCap=225`) | B: stress (`pvsRingRadius=10 lbCap=600`) |
|---|---|---|
| landblock fetches | 123 req / 1.8 MB | **1,465 req / 13.4 MB** (~12×) |
| total network | 381 req / 12 MB | 1,733 req / 24 MB |
| main-thread Script time | 4.8 s | **35 s** |
| frame time | 16.7 ms (60 fps) | **~4,500 ms (0.2 fps)** 💥 |
| Image (texture) bytes | 9.83 MB | 9.84 MB (**flat** — textures don't scale with distance) |

**Instrument caveats (don't trust these two):**
- Resident **texture VRAM (MB) and draw-calls/frame read 0** — the probe's page-side
  WebGL hook missed the real context because **rendering + decode run in a Web Worker +
  OffscreenCanvas** (`scene3d/bake_worker.js`, `scene3d/index.js:762`). VRAM is
  therefore *unmeasured*; see Re-probe.
- Arms A & C never logged in (`<account>` "Account In Use" ghost from a prior run) — so the
  vanilla-vs-cut-VRAM comparison did not actually run. Only B reached the world.

---

## GOAL 1 — Draw distance is gated by the landblock STREAMING/BAKE pipeline (not GPU, not VRAM)

**Problem.** Increasing draw distance floods the per-landblock fetch+bake pipeline and
stalls the **main thread**; the GPU is never the limit.

**Evidence.** Stress arm B (ring 6→10, lbCap 225→600) → **1,465** landblock fetches
(vs 123), 35 s of main-thread Script time, frames collapsed to **0.2 fps**. Texture
bytes stayed flat (9.8 MB) → textures are *not* the draw-distance cost. This is the
same "draw distance got destroyed" stall seen in prior ad-hoc tests; root cause is the
streaming pipeline, not a render-side limit.

> Note: B's main-thread CPU sampled only ~22 % busy *while* frames took 4.5 s — i.e. the
> stall is dominated by **fetch-flood + microtask/worker-message churn** (1,465 in-flight
> requests), not pure compute. The lever is throttling *concurrency*, not just CPU.

**The lever — throttle/budget the streaming pipeline.** There is already a per-frame
bake cap (`cells.js:60`, C1 2026-06-20) and an F3 time-slice budget (`cells.js:702`),
but they don't bound the **fetch fan-out**: a bigger `pvsRingRadius` issues O(ring²)
landblock fetches at once. Candidate work, roughly in order:
1. **Cap concurrent landblock fetches** (a request queue with a small in-flight limit) so ring size sets *eventual* coverage, not *instantaneous* request count.
2. **Distance-prioritized streaming** — nearest landblocks first, far ones trickle in.
3. **Push more decode/bake to the worker** (`bake_worker.js`) and keep the main thread for the render hand-off only; audit what still runs on main (the CPU profile showed wasm `surface_classify`/`normal_gen`/DXT decode on the main thread during load).
4. **Frame-budget the GPU upload/bake hand-off** so a burst of ready landblocks doesn't all upload in one frame.

**Risk.** This is the gnarly one — it's a streaming-architecture change touching
`cells.js` + the bake worker + the wasm `fetch_subdivided_landblocks` path, with the
known boot-bake-stall failure mode to avoid. Not a flag flip.

**Validation.** Re-run the probe's B arm (`pvsRingRadius=10&lbCap=600`) and confirm
frame time stays interactive while the ring fills in progressively; watch fetch
concurrency and main-thread Script time drop. Batch on the 1070, real GPU.

**Anchors:** `scene3d/cells.js` (per-frame bake cap :60, F3 time-slice :702,
`pvsRingRadius` :1089), `scene3d/bake_worker.js` + `scene3d/bake_worker_client.js`
(worker decoders), `apps/holtburger-web/src/lib.rs` `fetch_subdivided_landblocks`.

---

## GOAL 2 — Cut texture VRAM + load CPU by NOT throwing away source compression

**Problem.** Every texture on the GPU is **uncompressed RGBA8** (4 bytes/px). There is
**zero GPU texture compression** anywhere (no S3TC/DXT/KTX2/Basis — grep confirms none).
And AC's source textures in the `.dat` are *already block-compressed*: we **decode DXT
in wasm (CPU cost) then upload it uncompressed (VRAM cost)** — paying twice.

**Evidence.**
- Terrain atlas = 33 × 512² RGBA8 = **~33 MiB** (≈46 MiB with mips) — `adapter.js:126-127`.
- Object/building/monster surfaces = `THREE.DataTexture(…RGBAFormat, UnsignedByteType)` + mips + aniso — `adapter.js:904`. ~1.3 MiB per 512² skin, uncompressed.
- CPU profile's hottest wasm functions during load included **`decompress_dxt5_block`** and `surface_classify::compute_stats`. Source set per `crates/holtburger-dat/src/file_type/dxt.rs:8` ≈ **~50 DXT1 + ~10 DXT5** textures decoded.
- (Resident-VRAM total is unmeasured — instrument missed it; see Re-probe.)

**The lever — two tiers.**
- **Tier 1 (cheap, lossless): upload the ~60 source DXT1/DXT5 textures directly via
  `WEBGL_compressed_texture_s3tc`** (1070 supports it). Skip the wasm decode entirely
  and hand the block bytes straight to a `THREE.CompressedTexture`. Wins: **−decode CPU**
  (helps Goal 1's load stall too), **~4–6× less VRAM** on those textures, **lossless**
  (identical bytes to what legacy uses). Only covers DXT-sourced textures.
- **Tier 2 (bake pipeline): offline KTX2/Basis** for the *non*-DXT textures
  (palettized P8 / RGB) **and the 33-layer terrain atlas** — those can't be uploaded as
  S3TC without (re)compression, so bake them to KTX2 offline and load via
  three.js `KTX2Loader`. Broader VRAM win; needs a bake step + transcoder. Lossy on
  already-tiny palettized textures → per-format judgement.

**Payoff.** Lower VRAM/bandwidth headroom + lighter load CPU; raises the practical
texture budget (room for more/larger textures).

**Risks / notes.**
- Mips must be **precomputed** for compressed textures (can't `generateMipmaps` on them at runtime) → part of the bake/format step.
- Alpha textures need BC3/BC7 (or KTX2), not BC1.
- Rendering is in a worker (OffscreenCanvas) — the upload path lives there; the
  `CompressedTexture` / `KTX2Loader` wiring must go where textures are created
  (`adapter.js` `surfacePixelsToTexture` / atlas build, called from the worker side).
- Confirm `WEBGL_compressed_texture_s3tc` (and `_srgb`) is exposed in the worker's WebGL2 context.

**Validation.** After Tier 1, re-probe resident texture VRAM (should drop on the DXT
subset) and confirm load-time wasm DXT-decode CPU disappears from the profile, with no
visual regression vs the decoded version (it's lossless).

**Anchors:** `scene3d/adapter.js` (`surfacePixelsToTexture` :904, atlas build
`buildTerrainAtlasArrayBytes`, `ATLAS_TILE_PX` :149, downscale knobs
`setAdapterTextureDownscale`/`?textureScale`, `setAtlasTilePx`/`?atlasTilePx`),
`crates/holtburger-dat/src/file_type/dxt.rs` (decode that Tier-1 would bypass),
`scene3d/bake_worker_client.js:168` (`surfacePixelsFetcher` worker decode path).

---

## Re-probe (to get the missing VRAM number + a real A/B/C)

The probe script is at `/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/hb-perf-probe.cjs`
(launches Chrome on the 1070 via playwright-core, real GPU). Two fixes needed for a
trustworthy texture-VRAM/draw-call reading:
1. **Worker-aware GPU measurement** — the page-side `addInitScript` hook can't see the
   OffscreenCanvas context in the worker. Either inject the hook into the worker, or read
   three.js `renderer.info.memory.textures` / `render.calls` from inside the worker and
   postMessage it out.
2. **Ghost-login guard** — between arms, navigate to `about:blank` and wait ~18 s (or
   detect "Account In Use" and retry) so each arm actually logs in `<account>`.

Arms to use: A `pvsRingRadius=6&lbCap=225` (vanilla), B `pvsRingRadius=10&lbCap=600`
(stress draw distance), C `textureScale=2&atlasTilePx=256` (cut-VRAM A/B). Keep it
vanilla otherwise (no appearance flags).

---

## One-line summary

- **Goal 1 (draw distance):** gated by the landblock **streaming/bake pipeline** on the
  main thread (fetch-flood) — *not* GPU/VRAM. Lever = throttle concurrency + budget the
  bake/upload. Hard, architectural.
- **Goal 2 (texture cost):** we **decode DXT then upload uncompressed RGBA8**. Lever =
  upload source DXT **directly** (S3TC, lossless, cheap) + optionally bake KTX2 for the
  rest. Cuts VRAM ~4–6× and load CPU; raises the texture budget.
