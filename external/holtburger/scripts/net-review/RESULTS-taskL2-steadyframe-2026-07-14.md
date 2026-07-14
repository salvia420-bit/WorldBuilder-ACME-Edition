# RESULTS — L2: steady in-town frame profile (the sustained-fps ceiling)

**Date:** 2026-07-14 · **Box:** 1070 real-GPU (`ANGLE NVIDIA GTX 1070 Direct3D11`) ·
**Probe:** `scripts/net-review/steadyframe-profile.mjs` (CDP CPU profile + `?vfxGauge=on` +
`?renderDiag=on`; **no product-code edits** — a sampling profiler attributes ms to named
phases without touching the delicate ordered `tickPerFrame`) ·
**Raw:** `/mnt/wbterminal2/tmp/steadyframe-cragstone.json` ·
**Answers L2** from `HANDOFF-perf-next-fps-levers-2026-07-14.md`.

## TL;DR — the fps ceiling is render SUBMISSION, not heap and not the deferrable ticks
A **settled** Cragstone frame costs **~27 ms CPU + ~21 ms GPU** on a GTX 1070 (vfxGauge,
741 frames) → a **streaming-independent ~21-23 fps ceiling**. **72% of the CPU self-time is
three.js's render/draw path**; the deferrable ticks the handoff flagged (nameplate, static
walks, particles) are **<2% combined**. The driver is **draw-call / mesh-node count**:
**2896 mesh nodes / 78 programs** resident at a town, of which **1868 are entity part
meshes** (146 entity roots). This **reframes L1**: entity work is worth doing — but as a
**draw-call reduction (instancing/batching)**, NOT the geometry-heap dedup it was pitched as
(heap was already refuted small in task11b).

## Numbers (settled Cragstone `0xBB9F0040`, terr≈123 LBs, heap 1606 MB)
**Frame cost (vfxGauge, real 1070 timer-query, 741 frames):** `tCpuMs = 26.9`, `tGpuMs = 20.9`.
Both are over the 16.7 ms/60 fps budget → sustained fps is capped **independent of streaming**.

**CPU self-time by bucket (5 s CPU profile, ~1.7 s of samples):**
| bucket | selfMs | % |
|---|---|---|
| **three-render** | **1229** | **72.2** |
| native/gc/vm | 222 | 13.0 |
| other | 108 | 6.4 |
| wasm | 81 | 4.8 |
| statics | 31 | 1.8 |
| entities (JS tick) | 12 | 0.7 |
| particles | 10.6 | 0.6 |
| loop-tick (all deferrables) | 8 | 0.5 |
| **nameplate/HUD** | **0.4** | **0.0** |

**Top functions (all three.js render path):** `getParameters` 13.9% (per-draw program
cache-key), `getProgram` 5.6% + `setProgram` 4.2% (program select/bind), `updateMatrixWorld`
5.0% + `multiplyMatrices` 2.4% + `setFromEuler` 1.3% (full-scene matrix walk), `projectObject`
3.3% + `renderObjects` 2.1% + `traverse` 2.1% + `painterSortStable` 1.2% (render traversal +
sort), `renderBufferDirect` 2.4%, uniform uploads (`setValue`/`setValueV3f`/`uniformMatrix4fv`)
~3%.

**Structural counts (renderDiag):** `sceneNodes 6180`, `meshNodes 2896`, `programs 78`,
`geometries 2597`, `textures 1386`. `entMeshes 1868` from `entRoots 146` → **entities are
~65% of the mesh-node (≈draw-call) population**.

## Interpretation
The steady frame is **submission-bound**: three.js walks ~2896 mesh nodes every frame, and
for each draw it (a) resolves/binds a program (`getParameters`+`getProgram`+`setProgram` ≈
**24%** of CPU) and (b) updates & multiplies matrices (`updateMatrixWorld` chain ≈ **9%**),
then sorts and submits (`projectObject`/`renderObjects`/`traverse`/`painterSort` ≈ **8%**).
These all scale with **draw-call count and material-permutation count**, which is why the
per-frame deferrable ticks (nameplate 0.4 ms, all of loop-tick 8 ms) are irrelevant to the
ceiling. Entities dominate the draw population, so the lever that moves this number is
**fewer entity draws** (instancing/batching), not evicting entity *heap* (bounded, task11b).

## ⭐ SIZED (measured payoff — this SUPERSEDES the ranked list below)
Second 1070 session (`steadyframe-sizing.mjs`, TRUE-steady: entRoots stable ≈51, terrain
121 LBs) measured each lever's payoff instead of guessing. **Two of the reframe's own
hypotheses died.** Raw: `/mnt/wbterminal2/tmp/steadyframe-sizing-cragstone.json`,
`steadyframe-census-cragstone.json`.

**The master number: ~826 draw calls/frame** (198 k tris) at steady Cragstone → ~29 ms CPU,
73% in three-render. This is the ceiling. Where the 826 draws / ~1800 resident mesh nodes come from:

| lever | measured payoff | verdict |
|---|---|---|
| **Buildings batching/instancing** | **301 building draws, 0% batched, 181 collapsible by instancing (→120); ~all collapsible via BatchedMesh** | ⭐ **TOP — real, sizable, un-done** |
| **Static-atlas coverage extension** | 854 individual statics (**all unique geom/mat → 0 dedup**) + 458 already-batched; the 854 need BatchedMesh (distinct-geom) not dedup | 2nd — bigger but harder (they're the atlas's excluded set) |
| **Static matrix-freeze** (`matrixWorldAutoUpdate=false`) | **measured Δ = 1.4 ms/frame (~5%)** freezing 12 045 static nodes | 3rd — cheap, small, independent |
| **Entity instancing (handoff L1 / L2 reframe)** | 699 entity meshes, **0 collapsible by guid**, 96 by wcid (14%) | ❌ **~0 town payoff — DEAD for towns** (content-only, monster fields) |
| `getParameters` "churn" fix | 24.3% at true steady, **light-churn=0** → per-draw *structural*, not churn | not a separate lever — shrinks with any draw cut |

**Reordered conclusion:** the fps ceiling is 826 draws → 73% three-render → `getParameters`
per-draw 24%. The draw population is **buildings + statics**, NOT entities. Entity work (the
handoff's #1) saves ~0 in the towns where fps matters. `getParameters` is structural per-draw,
so it falls out for free as draws drop. **Build buildings-batching first** (301→~120, currently
zero batched, on-screen-dominant), then extend the static atlas to its 854 excluded meshes;
matrix-freeze is a cheap +5% bolt-on. Instance entities only when the content is a monster field.

## Recommendation — reframed next levers (ranked) — SEE SIZED TABLE ABOVE (measured; this list was the pre-measurement guess)
1. **Instance/batch entity part meshes** ⭐. 1868 entity meshes → the biggest draw-call
   population and the direct cause of the `getParameters`/`setProgram`/`renderBufferDirect`
   72%. Retail batches; we mint one Mesh per part. An `InstancedMesh`/`BatchedMesh` per
   `(setupId, part, surface)` collapses N same-type creatures to one draw and shares the
   program. This is L1 **repurposed from heap-dedup to draw-reduction** — the same build,
   a validated payoff (fps, not just heap).
2. **`matrixWorldAutoUpdate = false` on baked static subtrees** (terrain/statics/buildings).
   They never move post-bake, yet `updateMatrixWorld`+`multiplyMatrices` (~7% of frame) walk
   them every frame. Cheap, JS-local, low-risk; measure the matrix-walk drop.
3. **Investigate `getParameters` 13.9%.** Confirm whether program cache-keys are being
   re-derived every frame (material `needsUpdate` churn — fixable) vs. simply 2896 distinct
   draws (needs #1). A one-line `renderer.info.programs`/needsUpdate check answers it.

## Caveats (measurement honesty)
- **Draw-call count not directly read** — `renderer.info.render.calls` came back `1`
  (the `autoReset=true` trap, memory §measurement-traps: it zeroes per frame). `meshNodes
  2896` is the proxy. **Cheap first step for whoever builds #1:** set `renderer.info.autoReset
  = false`, read `.render.calls` cumulative, ÷frames — sizes the lever exactly.
- **Not perfectly quiescent.** Best-effort settle (terrain stable 3× + 2 s gap) but the
  window still caught one 493 ms streaming blip and `quiesce2s.maxFrameMs=93`. The **741-frame
  vfxGauge average and the self-time proportions are robust** to this — a few streaming frames
  do not flip 72% render dominance. The absolute 27 ms wants a 2nd run to pin down.
- **entRoots drifted 146→68** during the profile (backlog drain / reaper), so the frame cost
  spans a range; render-submission dominated throughout.
- **Single run, single town.** Proportions (the deliverable — phase ranking) are stable;
  absolute ms would want a paired re-run per the handoff's noise-floor warning.

## Harness note
`steadyframe-profile.mjs` is reusable: `POI=Holtburg node steadyframe-profile.mjs out.json 5`.
It asserts the real GPU, telepois, settles, CPU-profiles, and dumps vfxGauge+renderDiag. Add
`renderer.info.autoReset=false` sampling to it before the next run to capture true draw-calls.
