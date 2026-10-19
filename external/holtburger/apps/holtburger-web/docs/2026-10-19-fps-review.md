# FPS review — the "2× gotcha" hunt (2026-10-19)

Owner question: is there a gotcha that could take ~50 fps to a solid ~100? Code review plus the 1070
measurements already on disk (`/mnt/wbterminal1/tmp/fps-agent/` from 2026-10-17, the 2026-10-06
traces under `/mnt/wbterminal1/tmp/claude-scratch/perf/`) and the vendor docs/sources. Nothing was run
live on the 1070. This file records what was found, what shipped, and what is still owed.

## Findings

**No single bug doubles fps everywhere.** At the 1070's default (`ultra` since 2026-10-17) both the
renderer main thread and the GPU are close to their limits, and a THIRD stage the perf tooling did not
measure is near saturation too:

1. **Chrome's GPU-process main thread (CrGpuMain).** Every WebGL call is decoded there and turned into
   D3D11 by ANGLE; the DOM/HUD raster runs on the same thread. The 2026-10-06 `gpu.angle` trace
   (`firstturn-angle-ll.json`, mid, first street sweep): CrGpuMain 79% busy — WebGL 15.2 ms/frame +
   DOM raster 4.7 ms/frame — with CrRendererMain 98% busy (`scripts/perf-worker/gpu_thread_split.py`).
   Two of its biggest loads are invisible to `renderer.info` and to the CPU profile:
   - **BatchedMesh sub-draws.** three r184 draws a BatchedMesh as one multidraw with a range per
     visible instance and counts it as one call. ANGLE's D3D11 backend emulates multi-draw: it loops
     the ranges (`Context11::multiDrawElements` → `MULTI_DRAW_BLOCK`), sets the gl_DrawID uniform
     before each (`ProgramExecutable::setDrawIDUniform`, uncached) and issues a full draw, re-uploading
     the vertex stage's whole uniform buffer (`StateManager11::applyUniforms` → `UpdateSubresource`).
     2026-07-15 Holtburg: 1,921 counted calls vs **5,838 sub-draws**; 17,774 static instances over 324
     geometries. The July `?walkInInstance` A/B that "refuted the draw-count model" measured only the
     main thread (renderCPU), which cannot see this cost.
   - **DOM/HUD raster** (vitals orbs' display-rate CSS loops under blur/blend, the radar canvas, the
     minimap's per-frame style writes).
2. **GPU fill at ultra in towns.** The log depth buffer makes every program write `gl_FragDepth`,
   which turns early-Z off for every opaque draw (three's own docs say so); three's opaque sort orders
   by `material.id` before distance, and `?punchRetail` draws the terrain first. Linvak Tukal:
   buildings 6.3 ms GPU, 2.4 ms at half resolution (fill-bound). The June "log depth is a no-win" A/B
   was taken at 22 fps with the GPU at idle clocks (CPU-bound) and does not apply.
3. **Volumetric clouds at full resolution.** takram `high` defaults (resolutionScale 1, light shafts,
   3 × 512² shadow cascades marched in full every frame): ~4.3–4.6 ms GPU, over half a 120 Hz frame.
4. **Measurement traps.** The 1070's display is 120 Hz: rAF intervals sit on an 8.33 ms grid, so a
   saving that does not cross a grid line reads as +0 fps; GPU timer queries around a CPU-bound pass
   report the submit span (world pass 18.1 ms "GPU" vs 19.1 ms CPU in `anat1.json`).

## What shipped (each with an escape)

| Change | Flag | Default | Tests |
|---|---|---|---|
| Opted-in unsorted static buckets (`static_batch_x`, `static_atlas`) draw one INSTANCED range per geometry (`scene3d/batched_runs.js`) | `?batchedRuns` | ON | `tests/batched_runs.test.mjs`, GPU smoke `harness/glsl_smoke/batched_runs_smoke.mjs` (pixel-identical to `=off`) |
| True draw counts: `__diag.render.{batchedCalls, subDraws, issuedSubDraws}` (`?renderDiag=on`), `__batchedRuns.frame()` | — | — | same |
| Reversed-Z instead of the log buffer (early-Z back) | `?reversedZ` | ON (flipped from opt-in) | `tests/reversed_z.test.mjs`, GPU smoke `reversed_z_smoke.mjs` (both modes pass) |
| Terrain sorts after its occluders when no doorway punch draws (reversed-Z only) | `?terrainLast` | ON | `tests/terrain_last.test.mjs` |
| Cloud render resolution knob + `__setCloudResScale(n)` | `?cloudResScale=N` | 1 (unchanged) | `tests/cloud_res_scale.test.mjs` |
| Vitals orbs' infinite CSS loops sampled at the orb cadence (30 Hz), not display rate | `?orbAnimSync` | ON | `tests/hud_orb_anim_sync.test.mjs` |
| Minimap writes marker styles only on change; radar repaints only on change (`__radar.paintStats()`) | — (HUD fixes apply direct) | — | `tests/hud_map_marks.test.mjs`, `tests/hud_radar_paint.test.mjs` |
| Scene-walk census `await __skipHiddenMatrix.census(120)` | — | — | `tests/matrix_walk_census.test.mjs` |
| Bench: `hbbench.mjs --uncapped` (launchers add `--disable-frame-rate-limit --disable-gpu-vsync` via `D:\Temp\hbbench\uncapped.txt` — deploy `box/*.bat`) and `scripts/perf-worker/gpu_thread_split.py` (CrGpuMain WebGL / raster / present per frame) | — | — | validated on the 2026-10-06 trace |

## Declined, with the reason

- **Freezing Scene / worldRoot / the five world groups** (stop the root's per-frame `force` cascade).
  Not exact: manual-matrix FX meshes under frozen script anchors (fx_ribbons, fx_showcase) get their
  world matrix only from that cascade and would stay at identity. And it saves little: every
  `matrixAutoUpdate` node (the animated rigs) composes and forces its own subtree anyway, and the frozen
  cell / anchor subtrees already skip their multiplies. The census (`forcedOnly`) gives the number
  that would have to be large to reopen it.
- **A front-to-back depth band ahead of the program key in the opaque sort.** Trades program switches
  (CPU) for early-Z (GPU) with neither side measured; terrain-last takes the largest case (the terrain
  under everything) at zero CPU cost.
- **`depth: false` on the canvas** (pmndrs' recommended renderer settings): the direct render path
  (the pre-bake window, `?wireframe=1`, `?atmosphere=off`) draws the world to the canvas and needs it.

## Owed on the 1070 (one session, MODE T, fresh profile per arm)

Town at ultra (Holtburg / Linvak Tukal), `hbbench.mjs --uncapped` so fps is continuous, plus one
`gputrace.mjs` trace per arm read with `gpu_thread_split.py`:

1. bare URL (all of the above on)
2. `&batchedRuns=off` — CrGpuMain WebGL ms/frame and `__batchedRuns.frame()` (subDraws vs issued)
3. `&reversedZ=off` — world-pass GPU ms (per-draw census) and fps
4. `&orbAnimSync=off` — CrGpuMain raster ms/frame
5. `&cloudResScale=0.5` and `&cloudShadowRes=256` — clouds+AP GPU ms
6. `await __skipHiddenMatrix.census(120)` in arm 1 — `forcedOnly` vs `composed`

Eye checks owed by the flips: `reversedZ` (distant z-fighting, sky/cloud brightness, doorway punch,
decals, soft particles), `terrainLast` (no change expected; town with and without a door in view),
`batchedRuns` (static scenery identical to `=off`), `orbAnimSync` (orbs look the same).

Laptop check so far (SwiftShader, rendering on): the bare URL reaches the world with 0 console errors
and reversed depth active. At the spawn point no opted-in bucket drew more than one range, so the run
regroup has so far been exercised only by the GPU smoke — arm 2's `__batchedRuns.frame()` in a town is
the first live reading.
