# HANDOFF — GPU-resident static world ("no mesh objects"), research only (2026-10-22)

**This is a research handoff. Nothing was built.** It came out of a 20-minute read-only research session on HEAD
`2c7f4f0f`: the orchestrator plus three read-only agents (static draw path, static-mesh consumers, Rust/bake data side).
Every agent citation used below was re-read in code; one agent claim turned out wrong (§5 F8).
- Nothing ran on a GPU, in a browser, or through a build or the JS gate.
- Two targeted node tests were run to check that the substrate still works at HEAD: `harness/test_draw_pools.mjs`
  **448 passed / 0 failed** and `tests/batched_runs.test.mjs` **63 / 0**.
- No figure here is an fps prediction (charter D-01.5; walls ledger). Gains are stated as which measured term shrinks.
- Evidence tags follow the re-engineering docs: **[M]** measured (source named), **[D]** derived, **[A]** assumed.

## 1. Owner prompts (verbatim)

> i was reading a youtube comment for a game and was thinking for holtburger-web the meshes are demanding, and using a
> lot of cpu which is the bottkeneck, could something like this be possible "In this devlog I build a custom GPU-driven
> rendering pipeline using indirect rendering, upload vertex data straight to the GPU with no mesh objects at all, add
> octree-based frustum culling that runs entirely on the graphics card, and compress our vertex format down to a
> fraction of its original size. End result: a 10x performance boost, planets rendered at full detail, and over a
> billion vertices on screen at once". information only, if it takes long to build doesnt matter, probably wont work
> still asking

> create a handoff for the big one commit and push to origin/master, but research it for 20 minutes before making the
> handoff

"The big one" is the item from the chat answer: take the static world out of three's per-object scene graph and draw it
from GPU-resident buffers with very few real draws per material class.

## 2. Verdict

1. **The devlog's exact recipe is WebGPU-only.** It relies on compute-shader culling and indirect draws, and WebGL2 has
   neither.
   - WebGPU multi-draw-indirect is still an experimental Chrome feature behind `chrome://flags/#enable-unsafe-webgpu`.
   - three r184's own WebGPU backend still issues one `drawIndexed` per BatchedMesh instance from the CPU
     (`node_modules/three/src/renderers/webgpu/WebGPUBackend.js` ~1600-1627).
   - A WebGPU port would also mean rewriting 99 `onBeforeCompile` patch sites in 35 files and 34 custom shader
     materials, and replacing the WebGL-only postprocessing stack.
   - Not a near-term route.
2. **The part that carries over is "no per-object CPU work, few real draws".** In WebGL2 that means three things:
   - (a) an O(buckets) scene graph that does **zero per-instance JS on settled frames**;
   - (b) each bucket draws **one instanced range per distinct geometry**, so ANGLE issues one D3D11 draw per
     (bucket, geometry) instead of one per placement;
   - (c) optionally, **one draw per bucket** via vertex pulling.
3. **Most of (a) and (b) already exist, in two separate places that have never been joined:**
   - `?drawPools` (re-engineering ST9, built Aug 2026, DEV/off, never run on the 1070) does (a);
   - `?batchedRuns` (Oct 19, default on) does (b) for the legacy buckets.
4. **New finding: `?drawPools` as specified would most likely push cost into Chrome's GPU process** (§5 F1). Its opaque
   pools turn per-instance culling off, so three submits every LIVE member of a visible pool as its own multidraw range,
   and ANGLE D3D11 turns every range into a full draw. Pools are not wired to batchedRuns, and GATE-POOLS has no
   GPU-process criterion. The spec predates the Oct 19 discovery of ANGLE's multi-draw emulation.
5. **"GPU culling" is not available in WebGL2, and a vertex-shader cull is not a substitute** (§5 F5). Fine culling
   becomes coarse CPU culling per bucket, plus hardware clipping. The price is extra vertex work, which the GPU census
   can measure and the bucket's spatial size can tune.
6. **The vertex-compression piece is already designed and baked.** HBG1 geometry in the packs is indexed, at 24 B per
   vertex. Today's runtime path is non-indexed f32 soup at 32 B per triangle corner. The blocker is a rebake (§5 F7).
7. **Order:** P0 measure (one owner-run 1070 session) → P1 make every static range a run on the legacy path (small,
   pixel-identical) → P2 zero per-instance JS for opaque buckets → P3 revive drawPools with runs → P4 vertex pulling,
   only if the numbers still call for it. Details in §7.

## 3. What the measurements already say

| Fact | Source |
|---|---|
| 1070 at ultra, settled in a town: about 50 fps. The renderer main thread, Chrome's GPU-process main thread (CrGpuMain) and GPU fill are all near saturation in towns. | [M] HANDOFF-improvement-hunt-2026-10-20 §5; 2026-10-19-fps-review |
| CrGpuMain 79% busy (WebGL 15.2 ms/frame + DOM raster 4.7), renderer main thread 98% busy (10-06 `gpu.angle` trace, mid, first street sweep). | [M] fps-review finding 1 |
| ANGLE D3D11 emulates `WEBGL_multi_draw`. Each range becomes a full draw plus an uncached `gl_DrawID` uniform plus a re-upload of the whole vertex uniform buffer. Holtburg: 1,921 counted calls = **5,838 real draws**; 17,774 static instances over 324 geometries. | [M] `scene3d/batched_runs.js` header (ANGLE source read 10-19); net-review 2026-07-15 |
| **The per-range CrGpuMain cost has never been measured.** The 10-06 trace has no per-draw ANGLE events (checked this session: `WebGL` / `CommandBuffer::Flush` slices only). | this session → §7 P0 |
| Renderer main thread, 10-17 census (1070): 800 draws/frame, `renderBufferDirect` 12.0 ms/frame. The static world (statics + cells + buildings, colour + shadow) accounts for roughly 9 ms of that; entities about 1.2 ms. | [M] `/mnt/wbterminal1/tmp/fps-agent/census1.json` |
| Per world `render()`: draw funnel 11.0 ms, traversal (preProject + project) 4.1 ms, shadow 5.6 ms. CSM has been off on every preset since 10-17, so the shadow share is gone at default. | [M] `fps-agent/fsplit1.json`; `quality.js` csm:false |
| GPU (same day): 28.3 ms/frame. Post composite (clouds/AP/SSAO) 9.9, terrain 6.2, statics 4.5, cells 1.9. This work does not touch terrain or post, so once the CPU side drops, the GPU becomes the limit in towns. | [M] `fps-agent/gpucensus2.json` |
| August main-thread terms: 37.6 µs fixed per draw (r² = 0.014 vs instance count). BatchedMesh rebuild 5.72 ms/frame, 80% of it per-instance (0.348 µs/instance). Traversal ~3.6 ms over ~4.4k nodes. Transparent pass 8.70 ms / 212 draws vs opaque 4.28 / 215. | [M] 2026-08-06 frame-cost doc, via pass-07 |
| `?walkInInstance` cut true draws 63% (7,563 → 2,761) for −2.95 ms renderCPU (−10.5%), at a cost of +23% triangles. It lost per-placement LOD and degraded-leaf billboarding, and was declined 07-15. Its A/B measured only the main thread. | [M] url-flags `walkInInstance` |
| Nanto: 26,212 opaque + 2,094 translucent static instances over 11 sectors, 63 classes / 271 pools after the re-key. | [M] `docs/reengineering/impl/t00-class-census.json`, SPEC R-03 |

## 4. What already exists (build on it, do not rebuild)

| Piece | Where | State |
|---|---|---|
| **Draw pools**: one `THREE.BatchedMesh` per (768 m world sector × material class) | `scene3d/pool_registry.js`: opaque early-out pair at :355-383, exact (content, layer) geometry dedup at :458-482, event-driven membership, `setVisibleAt` park. Also `pool_class_key.js`, `pool_material.js` (array-page materials), `pool_producer.js`, `pool_envcells.js`, `pool_prewarm.js`, `pool_stream.js`, `tile_plan.js`. Spec: `docs/reengineering/pass-07-scene-and-draw-architecture.md`, SPEC.md T22, GATE-POOLS at SPEC.md ~:587 | DEV, off. Needs `slotGrid` + `packSource` + `geomBundles` + `texCompressedOnly` (+ `frameWork`) (F-11.3). Node battery green at HEAD. Never run on the 1070 (E6 queued in `queue-1070/batch-C-2026-08-09.json`). |
| **batchedRuns**: per-geometry instanced runs. The run layout lives in the indirect texture; draws go through `multiDraw*InstancedWEBGL`. | `scene3d/batched_runs.js`. Marked only by `static_batch_x.js:2388` and `static_atlas.js:1470`. Steps aside for sorted buckets and for buckets whose ranges never repeat. | Default on. GPU smoke: `harness/glsl_smoke/batched_runs_smoke.mjs` (pixel-identical vs `=off`). |
| Other BatchedMesh patches | `batched_indirect_per_camera.js`, `skip_empty_multidraw.js`, `three_batchedmesh_colortexture_fix.js` (load-bearing for pools, F-11.18), `batched_material_variant.js` | Default on |
| One persistent node fed by slots (the precedent) | `scene3d/terrain_batch.js`: one BatchedMesh, per-LB slots, DataArrayTexture layers | Default on |
| Animated scenery | `scene3d/animated_scenery.js`: InstancedMesh per (setup, part, surface) | Stays (charter I5-kept) |
| **Indexed, compact geometry (HBG1)** | Pack section 0x09: **16,107 model rows, 30.3 MB raw / 9.1 MB stored for the whole world** ([M] `dist/pack-report.json`). 24 B/vertex (f32 position, snorm8 normal, f32 uv) + u16/u32 indices (pass-04 layout). Consumer: `scene3d/geom_bundles.js` (`setIndex`). The runtime path today is non-indexed f32 soup (`adapter.js meshToGeometryGroups` :877). pass-04 S6.4 estimates a JS geometry heap ~2.9× smaller per resident triangle [D]. | Gated by `?geomBundles` (off) and blocked by `?negFace` (§5 F7) |
| Diagnostics | `__diag.render.{batchedCalls, subDraws, issuedSubDraws}` (`?renderDiag=on`), `__batchedRuns.stats` / `.frame()`, `__statBatchXStats()` (per-bucket `sorted`, `slots`, and the `walk` block), `__atlasStats()`, `__diag.pools()` | Live |
| Bench | `scripts/perf-worker/`: `hbbench.mjs --uncapped`, `gputrace.mjs` + `gpu_thread_split.py` (categories `gpu.angle,gpu,toplevel`; never `gpu.service`/`decoder`, which inflate ~10×). Bench URLs add `targetFps=0` via `lib/bench-url.mjs`; check `__frameCapState().fps === 0`. | Live |

## 5. Findings from this research (none of these are in the 10-20 ledger)

- **F1. drawPools would multiply ANGLE ranges.**
  - What three does: `BatchedMesh.onBeforeRender` with `perObjectFrustumCulled = false` writes one multidraw range for
    every visible, active instance (`node_modules/three/src/objects/BatchedMesh.js` ~1634-1660). The early-out
    (:1522) only saves the JS rebuild; the GPU process still loops the ranges.
  - Scale: Nanto's ~2.4k opaque instances per sector means a handful of visible sectors submit thousands to tens of
    thousands of ranges per pass [D]. For comparison, Holtburg measured 5,838 ranges in July, before batchedRuns; no
    town reading exists since (P0 arm 1).
  - Gap: `rg markBatchedRuns scene3d/pool_*.js` finds nothing, so pools never draw as runs. Pools DO dedup geometry
    by (content, layer), so runs would regroup them well.
  - **Required before any pools flip:**
    - wire runs into opaque pools;
    - add a GPU-process criterion to GATE-POOLS: `issuedSubDraws` ≤ the legacy arm, and CrGpuMain WebGL ms/frame
      (`gpu_thread_split.py`) not worse than the legacy arm.
- **F2. The atlas path defeats batchedRuns.**
  - What it does: `static_atlas.js` clones and normalizes every member placement's geometry and adds it as its own
    geometry (`normalizeForMerge` :908, add loop ~:1917-1937). No two members share a range, so batchedRuns counts the
    bucket as `noGain`, and **every atlased placement is one ANGLE draw**.
  - Fix: key atlas geometry by (source geometry content, layer), as pools already do. Same pixels; the layer stays
    vertex-stamped.
  - Size unknown: no doc counts atlas members. P0 arm 1 reads `__atlasStats()` and `__batchedRuns.stats.noGain`.
    Not in the 10-20 ledger or findings.
- **F3. Chunk buckets hold up to 9 copies of a model**, one per LB of the 3×3 region, because geometry is decoded per LB
  feed (`statGeomCache` and `statGeomDedup` are off). So runs only merge within one LB's contribution. `?statGeomDedup`
  exists; it is off "pending the 1070 pinned-pose re-base" (url-flags).
- **F4. The August "per-object cull off saves only 0.40 ms" verdict rests on a premise that no longer holds.**
  - The claim: `static_batch_x.js` :378-402 attributes the small saving to sorted ClipMap buckets ("applyClipMapRenderState
    sets `transparent = true`"), because three's early-out also needs `!sortObjects`.
  - The history: that A/B is in the frame-cost doc, commit `1a059c8e` (2026-08-06 02:10). `?clipMapOpaque` landed in
    `f712c13f` (2026-08-06 11:33) and sets `transparent = false` (`materials.js applyClipMapRenderState` :2783). It has
    been default on since.
  - Consequence: unsorted buckets now hold the ClipMap mass, so per-object cull off WOULD reach three's early-out for
    them [D].
  - What remains to confirm: one read of `__statBatchXStats()` (per-bucket `sorted` / `slots`) in a town. Re-measure
    before trusting either verdict.
- **F5. A vertex-shader frustum cull is not a lever in WebGL2.**
  - Why: an off-screen instance still runs its vertex shader, then the hardware clips it. Collapsing it in the shader
    saves only primitive setup, not the vertex invocation, and there is no compute stage to compact instance lists
    without a readback.
  - What remains: coarse culling per bucket/pool on the CPU (O(buckets)), hardware clipping, and a tunable bucket size.
    Price it with the GPU census (`02:RenderPass / statics` GPU ms, ktris).
- **F6. Consumers a replacement must serve that pass-7's walker table does not list:**
  - Film mode reads BatchedMesh APIs. `scene3d/film/scene/world_query.js staticFadeTargets` :1615 reads `getMatrixAt` /
    `_instanceInfo` / `getVisibleAt`. `scene3d/film/runtime/take_player.js` :2198 hides and restores via `__filmHidden`,
    `setVisibleAt`, or a zero-scale matrix. BatchedMesh pools serve both; a P4 custom drawable must keep that facade.
  - Degraded-leaf billboarding (`statics.js tickStaticsBillboards` :4322) has no home in pass 7. It is the regression
    that sank walkInInstance. Proposal: a per-instance billboard flag and the rotation done in the vertex shader. That
    is GPU work with no per-frame matrix writes.
  - Static lights expect `light.parent === mesh` (`lighting.js recordStatics` :3523). Pass 7 D-07.6 moves them to
    TilePlan light lists, which is not built.
- **F7. The drawPools chain has three hard blockers, independent of the draw primitive:**
  - (a) `?negFace` (default on since 10-19) makes every model come back `missing` from `assemble_model_geometry`
    (`src/geom_bundles.rs` ~700-722) until the baked GEOM payloads carry a back-face marker. That needs a GEOM rebake.
  - (b) The page-dim texture corpus: PAGE-RESAMPLE says "corpus-wide encode = buildbox job", and the buildbox was
    deleted on 2026-10-05. The served dist reports `texref_off_page` 409 of 3,471 [M]; those members stay on the
    legacy producer.
  - (c) The E2–E6 1070 batches have never run.
- **F8. The served dist does carry packs.** `dist` → `~/hb-serve/dist/current` → `holtburger-dist-hires-bc7m-xu7t2`,
  with `world_index` in `manifest.json` and `packs/`. One agent reported otherwise; verified wrong.

## 6. The design: the WebGL2 version of the devlog

- **L0. Coarse culling, zero per-instance JS.**
  - Opaque buckets set `perObjectFrustumCulled = false` and `sortObjects = false`, so three's early-out fires every
    settled frame for every camera.
  - Node-level culling stays: spatially bounded buckets keep `frustumCulled = true`. The atlas buckets are ring-wide
    (`frustumCulled = false`) and must become spatial for this to hold.
  - Hardware clipping handles the rest. The cost knob is bucket size (3×3-LB region = 576 m today, pool sector 768 m).
  - Translucent buckets stay sorted (D-07.3).
- **L1. Runs.** Every opaque bucket draws one instanced range per distinct geometry. This needs shared geometry (F2, F3;
  pools already have it). Rebuild the run layout only when membership changes (a bucket mutation counter), instead of
  batchedRuns' per-draw `_sameCanonical` compare (`batched_runs.js` :309). That compare is O(ranges) of JS per draw,
  and it is the last per-instance cost once L0 holds.
- **L2. Per-instance features without per-instance CPU work.**
  - LOD: band choice by event (D-07.8 band tick).
  - Billboards: in the vertex shader (F6).
  - Hide/park: `setVisibleAt` batches.
  - VFX per-instance hash: already derived from the batching matrix (`vfx/per_instance.js`).
- **L3 (optional). One draw per bucket via vertex pulling.**
  - Data: the bucket keeps no geometry attributes. A global geometry arena (every resident HBG1 model once; the whole
    world is 30.3 MB raw) lives in data textures. Each bucket has a u32 pull stream with one entry per triangle corner
    (arena vertex + instance slot), drawn with `drawArrays`. That avoids index-range validation and `gl_DrawID` (and
    so ANGLE's per-range work) entirely.
  - three integration:
    - `#define`-redirect `position` / `normal` / `uv` after the shader prefix (unused attributes go inactive);
    - set `geometry.setDrawRange(0, corners)`, because `renderBufferDirect` returns early for non-indexed geometry
      with no `position` (`WebGLRenderer.js` :1230);
    - give it a manual `boundingSphere`;
    - keep a BatchedMesh-like facade (`getMatrixAt` / `setVisibleAt` / `_instanceInfo` / `raycast`) for film, decals
      and ragdoll.
  - Unknowns [A]:
    - vertex-texture-fetch cost per vertex (matrix 4 + arena 2-3) on weak GPUs;
    - the vertex sampler budget (16 on D3D11), shared with the batching textures and VFX;
    - 4-8 B per corner of stream memory.
- **Non-goals:** terrain (already one node), animated scenery (kept), entities (excluded here; see P5), translucent
  ordering.

## 7. Phases

**P0 — Measure (owner-run 1070 session, MODE T, a fresh profile per arm, `?nosw=1`, town at ultra: Holtburg and Linvak
Tukal, settled AND on a fixed `@teleloc` path).** Decision rules are written here, before the run.

1. **Bare URL.**
   - Reads: `__diag.render` (`renderDiag=on`), `__batchedRuns.stats` + `.frame()`, `__statBatchXStats()` (sorted vs
     unsorted split → settles F4), `__atlasStats()`.
   - Plus one CPU profile, and one `gputrace.mjs` trace read with `gpu_thread_split.py`.
2. **`&batchedRuns=off`.** This is the per-range ANGLE term, and is arm 2 of the 10-19 fps review.
   - **Rule:** if CrGpuMain WebGL ms/frame (on vs off) moves by less than the arm's own rep spread, the per-range term
     is not a lever. Stop P1 and L1, and re-plan.
3. **The drawPools chain armed:**
   `&packSource=on&geomBundles=on&texCompressedOnly=on&slotGrid=on&frameWork=on&drawPools=on&negFace=off`.
   - Does it boot on HEAD?
   - Read `__diag.pools()` (pools, classes, `mutationsThisFrame` = 0 parked), `subDraws` / `issuedSubDraws`, CrGpuMain
     WebGL ms, renderCPU.
   - `negFace=off` changes the look (back faces); this arm is for measurement only.
   - **Rule:** if `issuedSubDraws` or CrGpuMain WebGL ms rises against arm 1, F1 is confirmed and P3 must land L1
     before any GATE-POOLS run.

**P1 — Make every static range a run (legacy path).** Effort S each; pixel-identical. Check with node tests plus a GLSL
smoke under `capped-build`, modelled on `batched_runs_smoke.mjs`.
- 1a: atlas geometry dedup (F2), behind a new flag. Name it, document it in url-flags, default on after the pixel smoke.
- 1b: the `statGeomDedup` re-base (F3). Owner call; the flag exists.
- 1c: opt `buildingMatBatch` into batchedRuns (improvement-hunt B9). Small: its verifier priced it at tens of ANGLE
  sub-draws, roughly 1-2% of range work (findings-round1 `recent-render-diff-4`). Do it for completeness, not as the
  lever.
- 1d (related): terrain batch without `gl_DrawID` (B10).
- Score: `issuedSubDraws` / `subDraws`, CrGpuMain WebGL ms/frame, uncapped fps.

**P2 — Zero per-instance JS for opaque buckets (M; eye check).**
- Behind a flag: `perObjectFrustumCulled = false` on opaque chunk, atlas (made spatial) and building buckets.
- Event-driven run layouts (L1). Billboards in the vertex shader (F6).
- Score: renderCPU (the `onBeforeRender` share), ktris, GPU `statics` ms, CrGpuMain.
- Expect more triangles; shrink buckets if GPU statics ms rises.
- Kill: a GPU-bound regression in towns, or moving p99 worse than the off arm.
- The statBatchMemo / slack family steps aside by itself once per-object culling is off (it engages only with it on;
  `static_batch_x.js` ~895, ~1513).

**P3 — Revive drawPools with runs (L; several sessions).**
- Unblock F7:
  - rebake GEOM with a back-face marker. This is a heavy Rust job: laptop `capped-build`, one at a time;
  - encode the page-dim corpus. The buildbox is gone: laptop `capped-build` or the 1070, owner call;
  - run the E2–E6 batches.
- Wire L1 into opaque pools.
- Add the F1 criteria to GATE-POOLS alongside E6, MOVE-FIX and TAIL-ULTRA.
- What it buys over P1-P2: an O(pools) scene graph (the traversal term), a closed class set (link storms), and
  residency events instead of LRU scans.
- SPEC §0.1: the implementing agent never flips `drawPools`; that is the owner's migration event.

**P4 — Vertex pulling (L; spike S first).** Only if P0/P3 show the per-run cost is still a material share of CrGpuMain.
Spike: one GLSL smoke page drawing a pulled bucket against the same bucket as BatchedMesh runs, pixel-identical; then
one 1070 arm.

**P5 — Later.**
- Entity parts: open lead 242 — ~330-814 part draws per town frame, ~40 per humanoid, 593 unique materials. Rigid parts
  with per-frame matrices are a natural instancing target once part textures are arrays.
- WebGPU: only if multi-draw-indirect ships by default.

## 8. What a replacement must keep working (checklist)

- **Shader patches** (via `materials.js _chainBeforeCompile` ~:693, cache key `_patchSetCacheKey` ~:600):
  - light clamp, CSM receiver (C1: must read `batchingMatrix`), POM / detail, the depth biases (floor / static / fill,
    which write `gl_FragDepth`, plus their reversed-Z twins), envDetail, baked vertex light;
  - VFX components (`windSwayGpu`, wetness, frost, glint);
  - the atlas array material (`static_atlas.js makeArrayMaterial`);
  - global chunk rewrites: radial fog, light loops, light-pool UBO, reversed-Z packing, batching chunks.
- **Shadows:**
  - `castShadow` / `receiveShadow` per node vs per pool (the D-07.2 class axis);
  - `tickShadowReceiveGate` (`loop.js` :2662);
  - `shadow_caster_list.js` (static/dynamic split);
  - `sway_shadow.js` depth materials;
  - `interior_shadow_cull.js`.
- **Queries:**
  - blood decals raycast statics / buildings / cells (`blood_decals.js` ~598-630, ~713);
  - ragdoll env probes;
  - film fade and hide (F6);
  - `cullStaticsGroup` (`statics.js` :4647), which honours `__deadBatch` / `__filmHidden` and never culls a node that
    owns a light.
- **Passes:**
  - indoor split layers (`cells.js _stampSplitLayers` :593);
  - `?punchRetail` phase order (statics draw after the punch);
  - occlusion-cull proxies need static depth written first;
  - MSAA world target;
  - SSAO / haze / AP read reversed-Z depth.
- **Lifecycle:**
  - warm-park `setVisibleAt` (`landblock_lru.js` ~938);
  - evict by `userData.landblockId` / `coversLbKeys`;
  - texture-upgrade queue walk (`tex_upgrade_queue.js` ~506);
  - `attachStaticDefaultScripts` emitters (`statics.js` :6030).
- **Tests most coupled to today's structure:** `test_static_batch_x`, `test_stat_batch_walk`, `test_stat_geom_dedup`,
  `test_stat_batch_runs`, `test_static_atlas_*`, `test_bm_*`, `test_landblock_lru_evict`, `test_fixed_grid_park`,
  `tests/batched_runs`, `tests/building_mat_batch`, `tests/csm_receiver_worldpos`, `tests/film_runtime_capture`,
  `tests/statics_billboard_gate`, `tests/shadow_caster_sort`.

## 9. Walls — do not retrace

Line numbers are in `docs/improvement-hunt-2026-10-20/ledger-walls.txt`.
- Rows 29 / 107 / 137: draws removed × µs per draw does not predict ms. Score with renderCPU + CrGpuMain + GPU ms, never
  draw counts alone.
- Rows 89 / 108: statics bucket merging is **dead** (`statArrayMerge` measured 0.0 ms). This handoff does not propose
  merging buckets. Its mechanisms are different: per-range ANGLE work (runs) and the per-instance walk (early-out).
- Row 113 ("perObjectFrustumCulled must stay on"): its premise is stale (F4). Re-measure; do not cite it.
- Row 114: ring-wide merging forfeits node culling (22.5 vs 29 fps). This is why L0 keeps buckets spatial.
- Row 111: the matrix-freeze ceiling. Only cutting node count attacks traversal.
- Row 112: per-instance tests still walk the instance.
- Row 115: parked wins can be moving losses.
- Rows 82 / 83 / 118 / 206: `renderer.info` hides sub-draws, and main-thread-only A/Bs cannot see CrGpuMain.
- Row 31: MDI / SSBO / BaseVertex techniques do not exist in WebGL2. `WEBGL_multi_draw_instanced_base_vertex_base_instance`
  is a draft extension with negligible reach, so do not plan on base-instance.
- Row 130: global atlas pools are mandatory.
- Row 187: no per-bucket instanced attributes on shared geometry clones.

## 10. Laptop rules for whoever builds this (verbatim from `~/CLAUDE.md`; put them in every agent prompt)

"Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full JS
gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time."
"Headless Chrome: at most one tab of a real (non-wireframe) world at a time; close tabs when done."

Also:
- one heavy job at a time, inside `capped-build`, with ≥ 2.5 GB available;
- kill rust-analyzer before Rust builds;
- never `cargo … --workspace`;
- 1070 sessions are owner-run or owner-requested, off-screen and muted, never self-initiated.

## 11. Resume prompt

> Continue the GPU-resident statics work. Read docs/HANDOFF-gpu-resident-statics-2026-10-22.md (§5 findings, §7
> phases). First queue or run the P0 1070 session (bare / batchedRuns=off / drawPools chain armed) with the reads and
> decision rules in §7. If the owner has not asked for a 1070 run, start P1a (atlas geometry dedup by content+layer)
> behind a flag with a pixel-identical GLSL smoke, node tests only on the laptop.
