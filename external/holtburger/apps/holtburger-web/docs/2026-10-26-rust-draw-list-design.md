# Stage 3: a Rust-built draw list and a thin executor for the static world (research lane R3, 2026-10-26)

Ask (plan `2026-10-26-rust-scene-core.md`, stage 3): can three.js's per-draw submission for the static world move to a
Rust-built, state-sorted draw list run by a thin executor that reuses three's own compiled programs, with
byte-identical rendering? This lane is design and feasibility only. It changes no product code.

What was done, and what was not:
- Code read: three r184 and every renderer patch in this tree.
- Profiles re-analysed: the three 1070 run profiles of 10-23.
- A node-only scratch prototype of the executor was built and run over the repo's fake WebGL2. It is not committed;
  §10 has the results and the code that matters.
- A census probe was written for the next 1070 session: `external/holtburger/scripts/perf-worker/drawlist-census.eval.js`
  and `drawlist_kind_split.py`, both new files, smoke-tested in node.
- Nothing ran in a browser, under cargo or wasm-pack, or through the JS gate. Nothing ran on the 1070.

Evidence tags:
- **[M]** measured, with its source;
- **[M-node]** measured in node on this laptop (i5-6300U) over the fake WebGL2;
- **[C]** code read;
- **[D]** derived;
- **[A]** assumed.

Line numbers:
- three: `node_modules/three/src/...` (r184). The profile line numbers refer to the identical CDN
  `build/three.module.js`.
- Repo files: `apps/holtburger-web/...` unless the path says otherwise.

---

## 0. Verdict

1. **Feasible, exactly.** The prototype executor reproduces stock three draw for draw. Over 6 frames with a moving
   camera, every draw had the same program, every active uniform, every sampler's texture (UBO light blocks
   included), the same VAO, the same effective fixed-function state and the same draw arguments [M-node, §10]. All
   six prototype arms were checked.
   - It needs no fork of three. It uses three's own `WebGLProgram`s, uniform setter objects, `renderer.state`,
     `renderer.properties` and BatchedMesh fields.
   - Three's private trackers (the bound VAO, the current material, the current camera) are kept coherent by small
     mechanisms (§5.5).
   - `renderer.resetState()` is not usable mid-frame. Its `state.reset()` turns reversed-Z off
     (`WebGLState.js:1230`).
2. **The prize is less than half of the plan's figure: about 1.3 ms/frame at Holtburg [D].** The planned ~3 ms does
   not hold, and an exact executor does not cut GL calls.
   - Range 0.9–1.7 ms, of which S3.1 + S3.2 are ~1.2 ms; assumptions in §5.10.
   - Of three's per-draw cost on our path (6.28 ms world-pass draw loop [M]), only part is removable while keeping the
     same pixels:
     - three's per-draw derivation JS, ~2 µs a draw;
     - our draw wrappers, ~0.5 ms/frame for the static world;
     - the loop and renderObject overhead.
   - The rest is state that must be re-applied between draws that differ, which any exact executor must also do:
     - material refresh and upload on a material switch, ~1.9 ms/frame over all draws [M];
     - GL calls, 1.31 ms/frame [M];
     - texture and VAO binds.
   - Prototype, continuation draws [M-node]: 2.96 → 2.03 µs. Material-switch draws: no gain (8.1–8.6 µs either way,
     even with three's refresh ported).
   - **Fewer GL calls only come with changed shaders** (§5.9, UBO blocks). The executor itself issues the same GL
     stream. CrGpuMain therefore does not move unless that step lands, and its gain needs a 1070 measurement first.
3. **Recommendation: build it in exact steps, each removing a known term, and measure before going further.**
   - **S3.0**, the probe (written; owed on the 1070). It measures per-kind draws, the continuation share, record
     stability and GL calls per draw, attributes CPU-profile time per kind, and prices one GL command on CrGpuMain.
   - **S3.E**, first and independent: a wrapper diet (`batched_runs._frameKey` once per `render()`, `async_link`'s
     `objectCombo` cached), 0.1–0.2 ms, exact (§6 option E). It comes out of S3.1's wrapper term, not on top of it.
   - **S3.1**, the JS executor `?drawExec`:
     - a continuation fast path;
     - a state-only three call for program/material switches;
     - VAO and draw issued by the executor;
     - it bypasses `batched_runs` / `skip_empty` / `async_link` for proven-stable static draws.
   - **S3.2**, sentinel runs: consecutive static items collapse into one render item, so three's renderObject and
     no-op hooks run once per run.
   - **S3.4**, the Rust static list on R2's `StaticDrawFrame` (`2026-10-26-rust-residency-design.md` §2.8): cull, sort
     keys and an O(n) merge with three's dynamic list.
   - **S3.3** (class-material snapshots) and **S3.5** (UBO blocks) only if the S3.0 numbers ask for them.
4. **Where the remaining draw cost lives (for the plan) [M, §2]:**
   - material switches: ~1.9 ms/frame all draws, ~0.9 static [D];
   - GL calls: 1.31 ms;
   - entity parts: ~40 % of town draws, with a low continuation share.
   - What attacks those is fewer materials and fewer draws (class materials, arrays, pools, instanced rig parts) and
     shader-side state (UBOs, a shared batching arena), not a faster loop.
5. **Biggest risks:**
   - coherence with three's private per-render state (the mitigations are proven in node, not yet in Chrome);
   - coupling to three r184 internals (`renderer.properties` fields, uniform `cache`/`addr`, BatchedMesh `_multiDraw*`);
   - a pinned three version (a bump re-runs the identity suite);
   - double-ownership bugs between the executor and `batched_runs` if both wrap runs;
   - the measurement basis: the 10-23 profiles predate the chain going default-on.

---

## 1. Evidence used

| Source | What | Notes |
|---|---|---|
| `/mnt/wbterminal1/tmp/claude-scratch/perf/gg-grass-gpu-2026-10-23/on-r{1,2,3}-run.cpuprofile` | 1070, ultra, running south from Holtburg, 43.1 / 47.9 / 44.6 fps, 1,268 frames together | The plan's §1 source. **Old stack:** no chain flags in the URL, and `PIPELINE_DEFAULT_ON` flipped on 10-25 (`scene3d/pipeline_flags.js:28`). `renderDiag=on` was in the URL; `recordRenderDiag` is outside `renderScene`, so the world-pass numbers here exclude it. |
| same dir, `on-r*-run.trace.json` | CrGpuMain 63–64 % busy, WEBGL 9.66–10.06 ms/present, RASTER 3.1–3.35 (`summary.json`, `gpu_thread_split.py`) | No per-command events: categories are `gpu,toplevel` plus 12 `gpu.angle` events. |
| `/mnt/wbterminal1/tmp/fps-agent/census1.json`, `fsplit1.json`, `gpucensus1/2.json` | 10-17, 1070, CSM on at the time, 800 draws/frame, per-owner instrumented draw times | Instrumented with ~1,865 clock reads per render (`fsplit1.json` `probeClockReadsPerCall`): use for counts and ratios, not absolute µs. |
| `docs/2026-10-26-rust-residency-design.md` (R2) | 1070 node and BatchedMesh census (bare / chain first boot), per-owner laptop tally, stage-2 costs, the `StaticDrawFrame` interface for R3 | R2 counts the BatchedMesh `onBeforeRender` family (0.41 ms) and the static share of the scene walk under stage 2. It leaves the `batched_runs` (0.30) and `async_link` (0.25) draw wrappers to R3. This doc follows that split, so nothing is counted twice. |
| `docs/2026-10-25-pipeline-default-on.md`, `HANDOFF-gpu-resident-statics-2026-10-22.md`, `2026-08-06-frame-cost-structure-measured.md` | draw totals (1,138–1,152 calls/frame at Holtburg ultra, chain and bare), pool counts, walls | The August per-draw prices (37.6 µs fixed per draw) do not describe today's frame (§11). |
| Node prototype (scratch, §10) | three r184 + fake WebGL2 (plain object) + this tree's `uniform_bind_patch` / program sort / colorTexture fix, 328 draws/frame | `tests/helpers/fake_webgl2.mjs` tracks per-program uniform values, texture units and UBO contents. Fake GL calls still cost ~0.5–1 µs a draw in node, in both arms. |

---

## 2. Where the world pass goes today [M, 1070 profiles, mean of three runs]

The world pass is `RenderPass.render` → `renderDepthBandCamera` (`scene3d/depth_band_sort.js:75`) → `WebGLRenderer.render`,
inside `MsaaWorldComposer.render` (`scene3d/msaa_world.js:174`). Analysis scripts: §10.

| Term | ms/frame |
|---|---|
| `WebGLRenderer.render`, world pass | **8.56** |
| ├ `renderScene` (the draw loop) | 6.28 |
| ├ `projectObject` | 1.16 |
| ├ `updateMatrixWorld` (`skip_hidden_matrix.js`) | 0.74 |
| └ render-list sort | 0.31 |
| All other `render()` calls (sky, post passes, IBL, trail map, cloud shadow, ...) | 0.99 |

The draw loop's 6.28 ms by SELF time of the leaf function:

| Bucket | ms/frame | Top entries |
|---|---|---|
| three per-draw JS | 2.55 | `renderBufferDirect` self 0.48, `setProgram` self 0.44, `getBindingState` 0.14, by-name `setValue` 0.13, `bindTexture` (WebGLState) 0.13, `copyArray` 0.11, `arraysEqual` 0.11, binding `needsUpdate` 0.11 |
| GL natives | 1.31 | `bindVertexArray` 0.26, `bindTexture` 0.23, `multiDrawArraysInstancedWEBGL` 0.20, `uniformMatrix4fv` 0.12, `activeTexture` 0.10, `endQuery`+`beginQuery` 0.07, `useProgram` 0.04 |
| three per-material-switch JS (self) | 0.97 | `upload` 0.32, `refreshUniformsCommon` 0.27, `refreshFogUniforms` 0.08, `refreshTransformUniform` 0.08, `refreshMaterialUniforms` 0.08, `flatten` 0.06, `markUniformsLightsNeedsUpdate` 0.06 |
| `batched_runs.js` | 0.34 | wrapper self 0.12, `_frameKey` 0.09 (a `document.timeline` read per BatchedMesh draw), L1 hook 0.07, `_prepare` 0.04 |
| three loop | 0.30 | `renderObjects` 0.20, `renderObject` 0.10 |
| three BatchedMesh rebuild | 0.30 | `onBeforeRender` 0.20 (per-object-culled and sorted buckets) |
| `async_link_guard.js` | 0.20 | wrapper fast path (`objectCombo` + three stamp compares per draw) |
| other hooks | 0.27 | `uniform_bind_patch` 0.07, `grass_gpu_place` 0.05, `batched_indirect_per_camera` 0.04, `skip_empty_multidraw` 0.04, `static_batch_x` 0.03, `terrain_field_gpu` 0.02, `occlusion_cull` 0.02 |

Inclusive view (world pass):
- `renderObject` 6.26
- ├ our draw-wrapper chain from `batched_runs` down 5.54
- │ └ three's `renderBufferDirect` 5.00
- │   ├ `setProgram` 3.30
- │   │ ├ `upload` 1.31
- │   │ ├ by-name `setValue` 0.76 (camera, per-draw matrices, BatchedMesh textures)
- │   │ ├ `refreshMaterialUniforms` 0.45
- │   │ └ `setProgram` self 0.45
- │   ├ `bindingStates.setup` 0.58
- │   ├ draw dispatch 0.33
- │   └ `setMaterial` 0.18
- └ `onBeforeRender` chains: L1 hook 0.36 ⊇ `runPerCamera` 0.34 ⊇ three's 0.27; `_memoOnBeforeRender` 0.20

**Reading.** Split by what an exact executor can remove [D]:
- **Removable (derivation and bookkeeping that recomputes the same answer every frame):**
  - the per-draw half of three's JS, ~2.0 ms over ~1,000 draws;
  - the draw-wrapper chain, ~0.55 ms;
  - the loop, ~0.3 ms.
- **Not removable without changing what is sent:**
  - material-switch work, ~1.9 ms inclusive: refresh, then a ~30–40-uniform upload walk and the map binds;
  - GL natives, 1.31 ms.

---

## 3. Census by owner (Q1)

### 3.1 The kinds [C]

The probe tag is the kind name `drawlist-census.eval.js` reports.

| Probe tag | Producer, code | Object, material | Per-frame dynamic state on a settled frame |
|---|---|---|---|
| `pool_opaque` / `pool_sorted` / `pool_cell` | `pool_registry.js:488-578` (`poolFor`); statics/buildings feed `statics.js:3345-3357`, `buildings.js:508-536`; envcells `pool_envcells.js` | `BatchedMesh`, one class material per class (`static_atlas.js:735` `makeArrayMaterial`: `MeshStandardMaterial`, `side: DoubleSide`, `sampler2DArray` patch). Opaque: `perObjectFrustumCulled = false`, `sortObjects = false` (`pool_registry.js:515-519`), marked for runs (`:529-541`). Cells: layer 1 | Camera only: three's early-out (`BatchedMesh.js:1522`); multidraw list and runs unchanged |
| `bucket_unsorted` / `bucket_sorted` | `static_batch_x.js` (name `static-batch-c-*` at `:2689-2691`, created `perObjectFrustumCulled = true` `:2654`). `?staticEarlyOut` (default on) flips unsorted buckets onto the early-out (`:1998-2030`); marked for runs (`:2648`) | `BatchedMesh`, one bucket per (3×3-LB region, material object). Its material is a `batchMatVariant` clone (`batched_material_variant.js`, synced once per frame) | Unsorted: camera only. Sorted (transparent): per-camera rebuild, indirect texture upload unless `bmIndirectPerCamera` rolls it back |
| `atlas` | `static_atlas.js:1644` | `BatchedMesh` + array material; ring-wide (`frustumCulled = false`) | Per-object-culled rebuild |
| `building_batch` / `building_mesh` | `buildings.js:406`, `:951` | `BatchedMesh` per (LB, surface), plain `Mesh` per surface | Camera (+ matrices for plain meshes) |
| `cellstatic` / `cell_surface` | `cells.js:2458`, `:2338`; under the chain envcell surfaces pool, props stay (`pool_envcells.js` header) | plain `Mesh`, shared per-DID materials, layer 1; `?cellStaticMerge` default OFF | Camera; per-draw model-view upload |
| `static_mesh` / `static_lod_child` | `statics.js` passthrough singletons, `THREE.LOD` children (`statics.js:2061`, `:2276`) | plain `Mesh`; LOD level picked in `projectObject` | Camera; LOD level switches |
| `terrain_batch` | `terrain_batch.js:836` | one `BatchedMesh` + `ShaderMaterial` (`:663`) | Camera; uniforms `uTime` etc. |
| `far_terrain` | `far_terrain.js:1586` | `Mesh` + `ShaderMaterial` per patch | Camera |
| `grass` | `terrain_grass.js:1123-1228` | instanced, own `onBeforeRender` (`cullRing`) | Per-frame tile cull |
| `anim_inst` | `animated_scenery.js:1045` | `InstancedMesh` per (setup, part, surface) | Per-frame instance matrices |
| `entity_part` | `setup_rig.js:183`, `entities.js:5603` | `Mesh` per part surface, materials per entity | Per-frame matrices (lane B) |
| `particle`, `nameplate`, `decal`, `occlusion` | `particle_manager.js:3110`, `nameplate_sprite.js:699`, `blood_decals.js:460`, `occlusion_cull.js:114-228` | instanced / sprites / proxies with query hooks | Dynamic |

The static world for this design is everything above `grass`:
- pools, buckets, atlas, building and cell draws;
- static meshes and LOD children;
- terrain and far terrain.

Grass, animated scenery and the instanced kinds stay on three (per-frame instance data, own hooks).

### 3.2 What is counted, at which scale

| Measurement | Scale | Numbers |
|---|---|---|
| 1070 bench, Holtburg ultra, chain vs bare (10-25) [M] | `renderer.info.render.calls` per displayed frame, all passes | 1,138–1,140 chain, 1,143–1,152 bare (`2026-10-25-pipeline-default-on.md` §4b-4c) |
| 1070 Holtburg ultra, BatchedMesh calls / ranges asked / issued [M, via R2 §1.4] | per frame | bare 192 / 6,693 / 1,003; chain first boot 256 / 7,677 / 1,129 |
| 1070 10-17 census, world pass (old stack, CSM on) [M] | instrumented, per frame | chunk buckets 187 draws over 41 materials; cell statics 78 / 40; fused cell surfaces 64 / 19; static singletons 55 / 17; entity parts 59 / 42; building surfaces 19 / 13; atlas ~23; far patches 11; grass 4; animated 4; terrain 1 |
| Laptop 10-23, Holtburg ring 2, old stack [M, via R2] | renderBufferDirect calls / frame | entities 626, cells 494, statics 176 (1,539 ranges), occlusion 60, buildings 36, sky 36 |
| 1070 chain first boot [M, via R2] | pools | 76 pools, 18 classes, 238 pooled members; pools hold only the chunk batcher's leftovers |

**Estimate for the stage-3 population under today's default [D]:** N_s ≈ 400–600 world-pass static draws, of which
~250 are BatchedMesh. The rest are cell statics, singletons, LOD children, building meshes and far patches.

**Continuation share [D].** The continuation share is the fraction drawn with the same program and material as the
draw before. Under the program sort (`draw_sort_program.js:83-97`, material id after program id) each material's
items are contiguous inside a sort group, so the share ≈ 1 − materials/draws:
- chunk buckets 0.78;
- cell statics 0.49;
- singletons 0.69;
- building surfaces 0.33;
- pools ~0.75 (18 classes over 76 pools);
- entity parts 0.29.

**Unknown, and what measures it:** the per-kind world-pass draws, the continuation share and the per-kind µs under
the chain default are all unknown. The probe (§7.1) measures them:
- **M1 counts:** draws, ranges, program/material/continuation split, record stability, GL calls per draw by type and
  visible nodes per owner, per pass;
- **M2 time:** the kind-tagged CPU profile.

---

## 4. What three r184 does per draw on our path (Q2)

### 4.1 The call chain, as installed

1. `renderObjects` (`WebGLRenderer.js:2089-2114`) iterates the sorted list and tests layers.
2. `renderObject` (`:2116-2145`) runs, in order:
   - `object.onBeforeRender`. For a BatchedMesh this is the L1 epoch hook (`batched_runs.js:894`), then the per-camera
     indirect texture (`batched_indirect_per_camera.js:266`, `:164`), then three's rebuild or early-out
     (`BatchedMesh.js:1518-1522`); `static_batch_x` memo overrides apply to sorted chunk buckets;
   - the model-view and normal matrices (`:2120-2121`);
   - `material.onBeforeRender` (never overridden here);
   - `_this.renderBufferDirect`;
   - `onAfterRender`.
3. Our `renderBufferDirect` wrappers, outermost first. They are installed in this order: `async_link_guard`
   (`index.js:1717`), `skip_empty` (`:1730`), `batched_runs` (`:1736`).
   - `batched_runs` (`batched_runs.js:779-864`): L1 `_stableObserve`, `_prepare` (run layout), `_countFrame` +
     `_frameKey`, the `_indirectTexture` swap (`:820-827`) and the patched multi-draw extension (`:491-519`).
   - `skip_empty_multidraw` (`skip_empty_multidraw.js:48-54`): returns early when `_multiDrawCount === 0`.
   - `async_link_guard` (`async_link_guard.js:514-576`): three stamp compares plus `objectCombo`, then a deferral
     when the program is new or still linking.
4. Three's `renderBufferDirect` (`WebGLRenderer.js:1176-1334`) does the per-draw work in §4.2.

### 4.2 Each step, classified

Columns: *frequency* = how often the inputs can change. *Settled frame* = the camera moved, nothing else did.

| Step (three r184) | Where | Frequency | GL calls | Redundant on a settled frame? |
|---|---|---|---|---|
| `frontFaceCW = determinant() < 0` | `:1180` | per object (static) | — | yes |
| `textures.resetTextureUnits()` | `:2330` | per draw | — | yes (same units) |
| environment / colorSpace / vertexAlphas / tangents / morph / toneMapping derivation | `:2332-2356` | per draw | — | yes |
| `needsProgramChange` chain (~20 compares incl. lights.state.version, batching flags, envMap, fog, clipping) | `:2380-2493` | per draw | — | yes |
| `state.useProgram` | `:2520` | per program switch | `useProgram` | needed when the program differs from the previous draw's |
| material switch test (`material.id !== _currentMaterialId`) | `:2528` | per draw | — | — |
| camera uniforms (projectionMatrix, viewMatrix, cameraPosition, isOrthographic; logDepthBufFC in log mode) | `:2549-2607` | per program × camera | uploads only the first time per program per frame (setter caches) | the JS repeats on every program switch |
| shadow-map samplers | `:2610-2631` | per draw when shadows exist | binds | inert at default (CSM off) |
| BatchedMesh `batchingTexture` / `batchingIdTexture` / `batchingColorTexture` | `:2654-2669` | **per draw** | activeTexture + bindTexture per texture that differs from the unit's | values identical frame to frame; binds needed because consecutive meshes differ |
| `receiveShadow` | `:2679-2684` | per material switch / per differing object | uniform1i | yes |
| `envMapIntensity` / `dfgLUT` value assignment | `:2686-2697` | per draw (value only) | — | yes |
| refreshMaterial block: `toneMappingExposure`, `markUniformsLightsNeedsUpdate`, `refreshFogUniforms` (a color-space conversion per switch), `refreshMaterialUniforms` (`WebGLMaterials.js:42-136`, `:138-278`, `:381-411`), `WebGLUniforms.upload` (`WebGLUniforms.js:1168-1184`) | `:2699-2743` | **per material switch** | uniform* for values that differ from the program's cache; every sampler re-set (`setValueT1` `WebGLUniforms.js:559-586`: unit alloc + uniform1i cache + `setTexture2D`) | the values equal last frame's; the uploads are needed because consecutive materials differ |
| model-view, normal, model matrices | `:2760-2762` | **per draw** | `uniformMatrix4fv`/`3fv` only when the cache differs (`setValueM4` `WebGLUniforms.js:329-355`); BatchedMesh with a shared parent matrix hits the cache | compares are redundant; uploads are not (plain meshes) |
| `state.setMaterial` | `:1184`, `WebGLState.js:754-792` | per draw | only changed state | yes for a continuation |
| draw range / group / index arithmetic | `:1188-1230` | per draw | — | yes |
| `bindingStates.setup`: `getBindingState` (four nested map lookups), `needsUpdate` (a loop over program attributes), `attributes.update(index)` | `:1234`, `WebGLBindingStates.js:13-52`, `:70-112`, `:149-192` | per draw | `bindVertexArray` on change | the lookups are; the bind is not |
| `setIndex` / `setMode` / multi-draw dispatch + `info.update` | `:1239-1332` | per draw | the draw | — |
| our light patches: `hbLightUbo` sentinel, `lightOnce`, `pinnedSampler` | `uniform_bind_patch.js:427-444`, `:304-320`, `:289-302` | per program switch / per pinned sampler | 1 `bufferSubData` per block per (render, camera) | already deduplicated |

Uniform GL calls per draw [M-node, `tests/uniform_bind_patch.test.mjs` world, 164 draws, all three patches]:
- 1,430 GL calls per frame, about 8.7 per draw;
- bindTexture 326 + activeTexture 283;
- uniformMatrix4fv 312;
- uniformMatrix3fv 151;
- draws 148 + 16 multi-draws;
- bindVertexArray 46;
- useProgram 33.

The probe measures the same split on the 1070 per kind.

**What changes between two settled frames for a static draw [C]:**
- the camera uniforms (once per program per frame);
- the model-view and normal matrices (once per plain-mesh draw);
- for per-object-culled or sorted buckets only, the multi-draw list.

Everything else is recomputed to the same answer: program choice, material values, texture versions, VAO identity,
fixed-function state. It must still be **re-applied** between consecutive different draws. The executor can delete
the recomputation, but not the re-application.

---

## 5. The design (Q3)

### 5.1 Principles

1. **Same command stream, by construction.** The executor applies, for each draw it owns, exactly the GL state three
   would have applied. It calls three's own uniform setter objects (their `cache` dedup included),
   `renderer.state.*` and three's texture paths, so every patch installed on those keeps working, and so do
   reversed-Z and the light UBOs. It skips only work whose result it has proven unchanged.
2. **Record, validate, fall back.** The first draw of an object goes through the full chain. The executor then
   records what three resolved: program, uniform objects, texture properties, VAO, draw parameters and flags. Every
   later draw validates the record with cheap stamps (§5.3). On any doubt the draw goes to the full chain and is
   re-recorded. Correctness never depends on the executor's coverage.
3. **Exact order.** S3.1 and S3.2 run inside three's sorted list, so they keep its exact draw order. S3.4 merges a
   Rust-sorted static list into three's dynamic list with the same total-order comparator. Never "a static block
   first": that is exact except at exact depth ties, which is not this lane's bar.
4. **No fork of three, no `resetState`, no new programs** until the optional UBO step (§5.9), which has its own
   pixel proof.

### 5.2 Architecture

```
 S3.4 (after R2 S4)    Rust holtburger-scene::draw_list    one wasm call per world pass
                       cull (Frustum mirror) + sort keys + order + run plan, over R2's StaticDrawFrame arenas
                               │ sorted static item ids, z keys (f64), per-draw model-view/normal (f32)
                               ▼
 S3.2                  list.sort hook (outermost): merge with three's sorted dynamic items,
                       collapse consecutive static items into sentinel render items
                               │
                               ▼
 S3.1                  draw_exec.js: renderBufferDirect (outermost wrapper; a sentinel or a static item)
                       ├ valid record + continuation → fast path: per-draw subset, VAO, draw
                       ├ valid record + switch       → three's state-only call (degenerate group), then VAO + draw
                       └ no / invalid record         → the full chain (batched_runs, skip_empty, async_link, three), re-record
```

Today (before R2's S4) three's `projectObject` still culls and pushes static items, and `objects.update` still
uploads geometry. S3.1 and S3.2 change nothing upstream of the draw.

### 5.3 The draw record and its validation

Per (object, material, group), in a JS array indexed by a small id stored on the object at record time. Use one fixed
own field on producer-created objects, not a WeakMap: the prototype's WeakMap lookups were measurable.

| Field | From | Validated by |
|---|---|---|
| `program` (`WebGLProgram`), `pu` (its `WebGLUniforms`) | `renderer.properties.get(material).currentProgram` | the previous draw's program (continuation) or a post-check after a state-only call |
| `mp` (material properties), `uniformsList` | `renderer.properties` | `material.version` stamp |
| `u_mv`, `u_nm`, `u_mm`, `u_rs`, `u_tme` | `pu.map.*` (null when inactive) | the program |
| batching texture units, texture property objects | `pu.map.batching*Texture.cache[0]`, `properties.get(tex)` | `tex.version === props.__version` (else an upload is due: state-only path) |
| `vao` | the VAO bound when three drew the recorded draw (tracked, §5.5) | a geometry epoch: the attribute objects and versions, index and version, drawRange. The prototype loops over the attributes; production gets one epoch from the producer (pool registry / bucket mutation counter) |
| draw parameters | index type and bytes per element (from the index array type), mode, drawRange | same |
| `frontFaceCW` | `matrixWorld.determinant() < 0` | a static matrix epoch (R2 S1a `?staticMatrixFreeze` gives one) |
| hook flags | whether `onBeforeRender` / `onAfterRender` are the prototype no-ops, early-out eligibility | per frame (cheap field reads) |
| run state (marked BatchedMesh) | `batched_runs` run layout for the canonical list | `batched_runs`' L1 epoch (needs an export, §8) |

Eligibility (S3.1, conservative):
- the object's kind is a static kind (§3.1);
- `isMesh` or `isBatchedMesh`, not `InstancedMesh`, `SkinnedMesh`, Points or Sprite;
- no morph attributes, no `uniformsGroups`;
- the scene is `liveScene3d.scene` (shadow-map draws pass `scene === null`, `WebGLShadowMap.js:537`, `:551`);
- no clipping planes, no transmission;
- the material is a built-in `Mesh*Material` or a `ShaderMaterial` with `uniformsNeedUpdate !== true`.

### 5.4 The executor paths

**Continuation** (same program, same material, same camera, same render call as the previous draw). This is three's
`setProgram` with `refreshProgram = refreshMaterial = refreshLights = false`, which reduces to:
- the BatchedMesh texture binds on their recorded units, through `renderer.state.bindTexture` (cached), or a fall
  back when a texture needs an upload;
- `receiveShadow` if it differs from the material's;
- the three matrix setters. They can be skipped when the previous draw on this program uploaded bit-equal matrices,
  which holds for BatchedMesh objects sharing a parent matrix;
- `state.setMaterial(material, frontFaceCW)`, or nothing when the flip sign is unchanged;
- then the VAO and the draw.

```js
// prototype (scratch) — continuation, after the O(1) record checks
if (rec.b0 !== undefined) {                        // BatchedMesh: three's setValueT1 minus unit alloc + uniform1i (cached)
  state.bindTexture(TEX2D, rec.tp0.__webglTexture, rec.unit0);
  state.bindTexture(TEX2D, rec.tp1.__webglTexture, rec.unit1);
}
if (rec.mp.receiveShadow !== object.receiveShadow) { rec.mp.receiveShadow = object.receiveShadow; rec.u_rs?.setValue(gl, object.receiveShadow); }
if (rec.mwKey !== lastMwKey) { rec.u_mv?.setValue(gl, object.modelViewMatrix); rec.u_nm?.setValue(gl, object.normalMatrix); rec.u_mm?.setValue(gl, object.matrixWorld); }
if (rec.frontFaceCW !== lastFF) state.setMaterial(material, rec.frontFaceCW);
drawOnly(rec, object);                             // VAO (tracked) + multiDraw / draw + renderer.info.update
```

For a marked mesh that draws runs, `tp1` / `unit1` carry the run-layout texture instead of the canonical indirect
texture, and `drawOnly` issues `multiDraw*InstancedWEBGL` with the run arrays (see "Batched runs" below).
`renderer.info` is still updated with the sum of the canonical counts, as three's `renderMultiDraw` does under
`batched_runs` today.

**Switch**, when the program, material or camera differs, or an upload is due:
- three's own renderBufferDirect is called with a degenerate group `{ start: 0, count: -1 }`;
- three then runs `setProgram` and `state.setMaterial` in full, and returns at `drawCount < 0`
  (`WebGLRenderer.js:1230`) before the VAO setup and the draw;
- every private tracker therefore stays three's own;
- the executor checks that `currentProgram` is still the recorded one, then binds the VAO and draws.
- This draw saves the VAO lookup, the dispatch and our wrappers, about 1 µs plus the wrapper cost. It keeps three's
  ~4.7 µs of state work.

**Executor-side material switch** (S3.3, optional). A port of three's `refreshUniformsCommon` + `refreshUniformsStandard`
+ fog + upload walk through three's setters:
- it is GL-identical in the prototype, but **no faster** (8.1 vs 8.3 µs [M-node]), because the work is the walk
  itself;
- it pays only with **snapshots**: skip the refresh when the material provably did not change, and upload only the
  uniforms that differ from the program's cache;
- that needs an exact writer model for the material;
- `batched_material_variant.js:45-60`, `:109-125` shows these materials ARE mutated at runtime (opacity fades, re-seated maps,
  quality pokes). It shares Color objects by reference, so an in-place `color.set*` is invisible to a property
  compare;
- that model therefore exists only for registry-owned class materials (pools), which are few (18 classes at
  Holtburg), so the gain there is ~0.05–0.1 ms.
- Deferred unless the probe shows many switches on immutable materials.

**Batched runs.** For a marked BatchedMesh the executor must draw what `batched_runs` draws: one instanced range per
distinct range, run-layout texture bound as `batchingIdTexture`, `multiDraw*InstancedWEBGL` (`batched_runs.js:491-519`).
- S3.1 asks `batched_runs` for the run state (an export of `_prepare` with the L1 record) instead of rebuilding it.
- On the state-only call, the run texture is swapped into `_indirectTexture` exactly as `batched_runs` does
  (`:820-827`).
- It counts into `_countFrame`, so `__diag.render` and `__batchedRuns.frame()` stay right.
- One owner per draw: a draw the executor takes never also enters the `batched_runs` wrapper.

**Empty multi-draw.** `_multiDrawCount === 0` returns without any state call, as `skip_empty` does today.

**Info.** `renderer.info.update(count, mode, instances)` after every executor draw, as three's buffer renderers do,
so the bench's `draws` column stays comparable.

### 5.5 Coherence with three's private state

| Three state | Where | Hazard | Mechanism | Prototype |
|---|---|---|---|---|
| WebGLState caches (program, blend/depth/cull/stencil/polygon offset, texture unit bindings, active unit) | `renderer.state` | raw GL calls would desync them | never call those GL entry points directly: use `state.useProgram`, `state.bindTexture`, `state.setMaterial` | yes |
| `bindingStates.currentState` (the VAO three believes is bound) | private (`WebGLBindingStates.js:9-10`) | three skips `bindVertexArray` when its own last state matches. If the executor bound another VAO in between, three would draw with the wrong buffers | an own-property `gl.bindVertexArray` wrapper remembers the last VAO bound outside the executor. Before ANY three call (full or state-only) re-bind it if the GL binding differs: at most one call per executor→three hand-over | yes |
| `_currentMaterialId` | private (`WebGLRenderer.js:305`) | after an executor-side material switch, three could skip a material refresh it needs | S3.1/S3.2 never switch materials on their own (state-only calls do), so there is no hazard. S3.3 resets it before the next three call with `setRenderTarget(sameTarget, face, mip)`, which ends with `_currentMaterialId = -1` (`:3049`). Precondition: viewport, scissor and scissor test equal the target's (true for the world pass; assert once per render) | yes (S3.3 arm) |
| `_currentCamera` | private (`:307`) | camera uniforms | the executor never handles a camera change (it falls back), so the values it relies on were uploaded by three for this camera | yes |
| `textures.textureUnits` counter | private | unit numbers | the executor uses the recorded `u.cache[0]`; three resets the counter at its next `setProgram` | yes |
| uniform value caches | `WebGLUniforms` `cache` arrays | duplicate uploads | the executor calls the setters, so the caches stay exact | yes |
| per-render trackers (end-of-render resets `:1783-1785`) | — | a stale continuation across `render()` calls | a serial bumped on every `render()` entry/exit and every `setRenderTarget` breaks the continuation chain | yes |

**Not `renderer.resetState()`.** It runs `state.reset()`:
- ~50 GL calls;
- `depthBuffer.setReversed(false)` (`WebGLState.js:1230`), which turns reversed-Z clip control off mid-frame;
- `bindingStates.reset()`;
- and forces every later draw to re-apply all state.

### 5.6 Passes and features

| Feature | Effect on the executor | Status |
|---|---|---|
| MSAA world target (`msaa_world.js`) | none: the executor draws into whatever three bound | [C] |
| Indoor split (world pass WORLD_ONLY, depth clear, cells pass INDOOR_ONLY, `atmosphere_pipeline.js:1435-1648`) | two `render()` calls: the serial separates them; layers are still tested by three (S3.1) or carried by the sentinel (S3.2) | [C] |
| `?punchRetail` phases, `?terrainLast`, `?depthBandSort` | order is three's (S3.1/S3.2). S3.4 must reproduce `_phaseOf` (`atmosphere_pipeline.js:822-860`) and, when banding is on, the band. Banding uses `Math.log2`, which may differ by 1 ulp from Rust: keep that key in JS, or refuse S3.4 under `?depthBandSort` | [C] |
| Reversed-Z | depth func through the patched `setFuncReversedFixed` (`shader_logdepth.js:514`); polygon-offset sign through `state.setMaterial`; sort keys negated by the push wrapper (`:534-568`). All inherited | [C] |
| Atmosphere / post passes | other scenes: never eligible | [C] |
| CSM / shadow maps (off at default) | shadow draws pass `scene === null`: not eligible. Three's `WebGLShadowMap` path unchanged | [C] |
| Occlusion queries | proxies have own hooks and run queries: not eligible | [C] |
| Transmission pass | eligibility excludes it; S3.2 does not collapse when `transmissive.length > 0` | [C] |
| LOD (`THREE.LOD` in `projectObject`) | children are ordinary items; a level switch changes which object draws | [C] |
| Film mode hides, pool park/adopt (`setVisibleAt`) | change the BatchedMesh lists, which the executor reads live, or `_visibilityChanged`, which takes a full rebuild draw | [C] |
| Picking / raycasts / decals | not rendering; untouched | [C] |

### 5.7 Lifecycle

Each change below already takes the fall-back, so it costs at most one full-chain draw and a re-record:
- **Material change.** `material.version` moves. Map swaps keep `version` but are not seen by a continuation either:
  they only take effect at a material switch, which three performs.
- **Texture upload due.** Version mismatch. A state-only call lets three upload through its own `setTexture2D`.
- **Geometry growth or mutation** (pool feed, bucket rebuild, `BatchedMesh` resize). Attribute or index identity and
  version, or the producer epoch.
- **Program change.** Light count, env, fog, colour space or async relink: the post-check after a state-only call.
- **Context loss / restore.** Every record holds dead handles. Clear all records on `webglcontextrestored`, and when
  `renderer.info.programs` is a new array (the same signal `uniform_bind_patch.js:686-696` uses).
- **Flag off mid-session.** A live `__drawExec.off = true` falls through to the full chain on the next draw. Nothing
  else holds state.

### 5.8 Where Rust fits (S3.4, after R2's S4)

Rust earns its place once static draw objects leave three's traversal (R2 S4 to S6). For that hand-off it owns:
- **The records**, SoA: node sphere (world), matrix epoch, sort keys (phase, groupOrder, renderOrder, programId,
  materialId, materialVariant, objectId), layer mask, shadow flags, and handles into R2's arenas (lists, runs,
  indirect layout).
- **Per world pass, one call: the cull.**
  - frustum from `_projScreenMatrix` with `reversedDepth` (`Frustum.js` `setFromProjectionMatrix`, the reversed branch
    for planes 4 and 5);
  - three's `intersectsObject` / `intersectsSphere`: sphere × matrixWorld, then `distanceToPoint < -radius`;
  - all in f64, in three's operation order (math.rs discipline), so the cull answer is bit-equal.
- **Per world pass, the z keys:** `center.applyMatrix4(matrixWorld).applyMatrix4(projScreen)`, Vector4, no divide,
  then negated under reversed-Z.
- **Per world pass, the sort:** the program comparator (`draw_sort_program.js:83-97`), a total order ending in `id`,
  so the result is unique.
- **Optionally, per-draw model-view and normal f32:** a `multiplyMatrices` f64 mirror and `getNormalMatrix`.

**JS: merge, collapse, draw.**
- The `list.sort` hook merges Rust's static order with three's sorted dynamic items, O(n), with the same comparator.
- Three keeps sorting only the dynamic items.
- Geometry uploads: an object whose epoch moved is **hot**. It returns to three's graph for that frame, so
  `objects.update` uploads it, and is drawn by the full chain. Cold objects are drawn by the executor.

Parity:
- `tools/rust_parity/gen_draw_list.mjs` records three's real cull decisions, z keys and sorted order on scripted
  scenes;
- `crates/holtburger-scene/tests/draw_list_parity.rs` asserts bit-equal cull and keys and an identical order;
- `tests/rust_draw_list_parity.test.mjs` compares the merged list with three's own.

A Rust-side GL executor (web-sys) is not proposed. Every GL call must still cross into JS: the wasm-bindgen glue
adds a hop per call, and the JS executor already holds the GL handles natively. Rust owns the data side.

### 5.9 Uniform blocks (S3.5, optional; the only route to fewer GL commands)

| Block | Members | Written | Saves (per frame) |
|---|---|---|---|
| frame / camera | projectionMatrix, viewMatrix, cameraPosition, isOrthographic, toneMappingExposure, fog | once per render() and camera | ~4–6 uniform calls and their cache compares per program switch (~150 switches/frame measured 10-05, `draw_sort_program.js:13`, `:40`) |
| object (plain static meshes) | modelViewMatrix, normalMatrix, modelMatrix | once per frame by Rust, all draws (one `bufferSubData`), then one `bindBufferRange` per draw | ~3 uniform calls per plain draw, and ANGLE's per-draw vertex default-block re-upload (`UpdateSubresource`, `batched_runs.js:10-13`) |
| class material (pools) | the class material's uniforms | on change | the per-switch upload walk for pools |

- Uses the `?lightUbo` method:
  - a chunk rewrite under a define injected only by the main renderer's `shaderSource`
    (`uniform_bind_patch.js:192-238`);
  - offsets read from the driver;
  - a fake-GL proof that reads block members back.
- **Pixels.** Block members carry the same f32 bits as `uniform*` uploads. Block members keep the default precision in
  force where they are declared, which is three's (highp float). The object block must hold the CPU-computed f64→f32
  model-view, never a shader-side `view × model`: that rounds differently, and R2 §0.4 says the same about
  `batchingMatrix`.
- **Cost.** New program variants (FXC link stalls, prewarm lists) and coupling to three's prefix declarations.
- **Gate.** Build only if the probe's `inject` phase shows that one redundant command costs CrGpuMain enough to matter
  (§7.4).
- Not measured anywhere yet [A].

A further shader-side option is a shared batching arena: one matrices/indirect texture for all static BatchedMesh
objects, with a per-draw base offset. It removes 2–3 texture binds (4–6 commands) per BatchedMesh draw, but it is a
`batching_pars_vertex` rewrite in the spirit of `batched_runs.js:279-338`. Same gate.

### 5.10 Estimates

Per static draw, 1070-equivalent [D]. Anchors:
- three per-draw JS ≈ 2.0 µs (§2: ~2.0 ms over ~1,000 draws);
- material-switch work ≈ +2.7 µs (1.9 ms over ~700 switches [A]);
- GL ≈ 1.0–1.3 µs;
- draw wrappers ≈ 1.55 µs per BatchedMesh draw (`batched_runs` 0.34 ms over ~250 BatchedMesh draws + `async_link`
  0.2 + `skip_empty`) and ≈ 0.25 µs per plain draw;
- loop/renderObject ≈ 0.3 µs;
- executor JS ≈ 0.6 µs per continuation ([M-node] 2.03 µs incl. ~1 µs fake GL, so ~1 µs; 0.6 assumes Chrome's lower
  per-call JS cost [A]).

| Static draw | Today | S3.1 | S3.2 | Floor (GL only) |
|---|---|---|---|---|
| BatchedMesh continuation (pool, early-out chunk bucket, runs) | 2.0 + 1.55 + 0.3 + 1.2 ≈ **5.0 µs** | 0.6 + 0 + 0.3 + 1.2 ≈ **2.1** | ≈ **1.9** | ~1.2 |
| plain mesh continuation (cell static, singleton) | 2.0 + 0.25 + 0.3 + 1.0 ≈ **3.6** | ≈ **1.9** | ≈ **1.7** | ~1.0 |
| program / material switch | ≈ **7–8** | ≈ **6–6.5** | ≈ **6** | — |

**ms/frame at Holtburg ultra [D].** Assumptions:
- N_s = 500 world-pass static draws (range 400–600);
- BatchedMesh share 0.5;
- continuation share 0.65 (range 0.5–0.75).

| Step | Saves | Range | CrGpuMain |
|---|---|---|---|
| S3.1 executor | 162 × 2.95 + 163 × 1.65 + 175 × 1.9 µs ≈ **1.1 ms** | 0.75–1.4 | 0 (same command stream) |
| S3.2 sentinel runs | 500 × ~0.25 µs ≈ **0.12 ms** | 0.08–0.2 | 0 |
| S3.4 Rust list | the static items' share of three's sort (~0.1 ms) + merge. The walk share (0.3–0.5 ms) and the `onBeforeRender` family (0.41 ms) are **R2's** | ~0.1 beyond R2 | 0 |
| S3.3 class-material snapshots | pools: ~0.05–0.1 ms; legacy materials not safely | — | small |
| S3.5 UBO blocks | main ~0.2–0.5 ms [A] | unknown | **unknown**: the probe's `inject` phase prices it |
| **Stage 3 total (S3.1 + S3.2 + S3.4)** | **~1.3 ms** | **0.9–1.7** | ~0 without S3.5 |

The plan's row 3 ("~3 ms + fewer GL calls") should read: **~1.3 ms main thread (0.9–1.7), the same GL calls; fewer
only with S3.5, CrGpuMain unpriced.**

At the plan's stage-3 position, 1.3 ms takes the main thread from ~17.2 ms to ~15.9 ms, about 58 → 63 fps. The
starting point is 20.6 ms minus stage 1's mid estimate (2.5 ms) and R2's Holtburg mid estimate for stage 2 (0.95 ms).
That leaves the main thread ~1 ms above the CrGpuMain floor (14.4–15.1 ms/present → 67–69 fps). Any further main-thread
win therefore runs into CrGpuMain, which is why S3.5's price matters.

---

## 6. Cheaper alternatives, compared (Q4)

| Option | Main-thread ms | CrGpuMain | Pixel risk | Effort | Notes |
|---|---|---|---|---|---|
| **A. S3.1 executor** (continuation fast path + state-only switches + VAO/draw + wrapper bypass) | 0.75–1.4 | 0 | low: same commands, proven in node | M | needs exports in `batched_runs.js` |
| **B. S3.2 sentinel runs** | +0.08–0.2 | 0 | low | S | a `list.sort` hook, outermost |
| **C. Frozen static render list** (skip `projectObject` + sort for settled static subtrees, re-push cached items) | 0.3–0.6 (the static walk share, R2's term) | 0 | medium: LOD levels, geometry uploads (`objects.update` runs in `projectObject`), lights under static nodes (placements carry source lights, but under the light pool they stay `.visible = false`, `lighting.js:739-762`, `:3767`; the rendered lights live in `lightsGroup`, `:262-279`; a frozen subtree must still be proven free of visible `isLight` nodes) | M | this is R2's S4–S6 done by hand. Prefer R2's path, with S3.4 on top |
| **D. Per-material uniform-upload caching** (snapshot, skip refresh) | 0.1–0.5 | small | **high** for legacy materials (in-place Color writes are undetectable, §5.4); low for pool class materials | M | only the pool part is safe, and it is small |
| **E. Wrapper diet without an executor:** `batched_runs._frameKey` once per `render()` instead of per draw; `async_link_guard`'s `objectCombo` (`async_link_guard.js:238-251`, ~10 property reads per draw) cached per object | 0.1–0.2 | 0 | none | S | cheap, independent, worth doing first. `_frameKey` reads `document.timeline.currentTime` per BatchedMesh draw (0.09 ms, §2). Overlaps A: what E saves, A no longer can |
| **F. Fewer materials per program** (class materials for chunk buckets and cell statics, more pooling) | largest structural lever: each material removed saves a ~2.7 µs switch plus its binds; draws merge | yes | medium: eye-test class (statArrayMerge history) | L | stage 2 / pools territory; walls 89/108 say re-derive nothing without a NEW mechanism |
| **G. S3.5 UBO blocks** | 0.2–0.5 [A] | the only lever here | low with proof | L | gate on probe `inject` |
| **H. Shared batching arena** | 0.1–0.3 [A] | yes | low with smoke | L | P4 territory |
| **I. Executor for entity rigid parts** (lane B matrices) | 0.4–0.8 [D: ~450 part draws, continuation share ~0.3] | 0 | low | M | the same executor; entities are ~40 % of town draws |

**Ranking** by (ms saved) ÷ (pixel risk × effort):
1. **E**: tiny, safe, now.
2. **A**.
3. **B**.
4. **I**: after A, with lane B.
5. **S3.4 on R2's S4**: needs R2.
6. **G**: if the probe says so.
7. **D**: pools only.
8. **F**: owner-gated, structural.
9. **C** and **H**.

---

## 7. Validation plan (Q5)

### 7.1 1070 census first (S3.0)

`external/holtburger/scripts/perf-worker/drawlist-census.eval.js`. It is new, and node-smoked against the fake GL
(phases, restore, injection). Phases, prepended as `window.__dlcPhase="..."` to a copy:
1. **"all"** (counts; do not read fps from it). Per pass and kind:
   - draws, ranges, early-out share and own-hook share;
   - program switches, material switches, continuations;
   - record stability vs the previous frame;
   - GL calls per draw by type;
   - visible nodes per owner.
2. **"install"** (tags only), then `node hbsess.mjs profile 8 OUT.cpuprofile`, then **"finish"**. Analyse with
   `python3 -I drawlist_kind_split.py OUT.cpuprofile FPS`: ms/frame per kind and its split (setProgram, upload,
   refresh, setup, dispatch, setMaterial, GL, our wrappers).
3. **"inject"** (CrGpuMain per-command price). See §7.4.

### 7.2 Node identity suite (laptop; the main correctness proof)

`tests/draw_exec.test.mjs`, modelled on `tests/uniform_bind_patch.test.mjs` and this lane's prototype:
- Setup: three's real renderer over `tests/helpers/fake_webgl2.mjs`, with every production install in `index.js`
  order:
  - colorTexture fix, light-UBO chunks, the uniform bind patch;
  - program sort with the punch phase;
  - batched-runs chunks + wrapper + L1;
  - per-camera indirect textures, skip_empty, async_link (with a fake main scene);
  - reversed-Z install;
  - the executor outermost.
- The fake context gets the prototype's additions: VAO identity per draw, and effective fixed-function state with
  default-off caps dropped.
- **Assertion:** per draw, stock vs executor, an identical normalised snapshot (program, all uniforms incl. UBO
  members, samplers → textures, VAO, state, draw arguments incl. multi-draw arrays), over ≥ 6 frames per scenario.
- Scenarios:
  - moving camera;
  - pools on the early-out with runs;
  - per-object-culled and sorted buckets (indirect uploads);
  - a material `needsUpdate` mid-run;
  - a texture version bump;
  - a pool add / delete (geometry growth);
  - a light-count change (program change);
  - two `render()` calls per frame (indoor split);
  - a nested render inside `onBeforeRender`;
  - a transparent DoubleSide two-pass material;
  - LOD switching;
  - `?depthBandSort` on;
  - context restore (`renderer.forceContextRestore` analogue: a new fake context);
  - the live off switch.
- Also: `renderer.info.render.calls` / `triangles` equal, and `__batchedRuns.frame()` equal.

### 7.3 SwiftShader pixel smoke (laptop, `capped-build`, one browser at a time)

`harness/glsl_smoke/draw_exec_smoke.mjs` + `draw_exec_page.html`, after `batched_runs_smoke.mjs`:
- local headless Chromium with `--use-angle=swiftshader`;
- three from `node_modules`, the real modules routed in;
- a scene with pools (array material), chunk-like buckets with runs, cell-static meshes and a transparent bucket;
- a reversed-Z renderer and an MSAA render target.
- Arms: `?drawExec=off`, `=on`, `=on&drawExecRuns=on`. **Max channel diff 0** over the frame, plus
  `gl.getError() === 0`.

Then a laptop app boot, bare URL plus `?drawExec=on`:
- 0 console errors;
- `__drawExec.stats` (fast / stateOnly / full / invalid / fallback reasons) sane;
- with the probe's "all" phase, `stableShare` ≈ the executor's fast + stateOnly share.

### 7.4 1070 protocol (owner-run, off-screen, muted, fresh `--user-data-dir` per arm, `?nosw=1`, uncapped)

1. **Census:** the probe's "all" and "install" + profile at Holtburg ultra:
   - orbit (`hbsess` default) and street;
   - Linvak Tukal;
   - one interior (indoor split).
   - This settles N_s, the continuation share and the per-kind µs before any build.
2. **CrGpuMain price:**
   - `window.__dlcInjectSpec = { mode: "uniformM4", perDraw: 4 }`, phase "inject";
   - alternate `window.__dlcState.inject.mode = "off" / "uniformM4" / "uniformM4dirty" / "vao" / "useProgram"`
     between 12 s `gputrace.mjs` runs in ONE session. `uniformM4` re-sends the unchanged value and prices the command;
     `uniformM4dirty` sends another value and then the current one back, so the next draw re-uploads ANGLE's default
     block. Both leave every draw's inputs unchanged;
   - `gpu_thread_split.py` gives WEBGL ms/present per arm;
   - per-command cost = Δ ÷ (`__dlcState.injected` per present).
   - Decides S3.5.
3. **A/B after S3.1 / S3.2:**
   - `hbbench.mjs --uncapped`, arms `drawExec=off` vs default-on build, 2–3 reps interleaved;
   - plus one `hbsess.mjs profile` per arm with the probe tags, and one `gputrace.mjs` per arm.
   - Kill if: any console error; still or moving not better than the rep spread; or CrGpuMain WEBGL worse.
4. **Eye frames:** pinned sky (`?skytime=12&clouds=off&cloudShadow=off`), the four poses of
   `2026-10-25-pipeline-default-on.md` §6, per arm.

---

## 8. Staged implementation plan (Q6)

Laptop rule for every lane agent, from CLAUDE.md, verbatim: "Parallel agents may read, edit and run TARGETED single
tests only (`node test_x.mjs`). They must NOT run the full JS gate, cargo, wasm-pack or browsers. The orchestrator
runs the full gate and builds ONCE, after merging, one at a time."

| Step | What | Files (owner) | Flag | Proof on the laptop | Owed on the 1070 |
|---|---|---|---|---|---|
| **S3.0** | Census probe + profile splitter | `scripts/perf-worker/drawlist-census.eval.js`, `drawlist_kind_split.py` (written by R3; orchestrator commits); queue entry in `docs/reengineering/queue-1070/` (orchestrator) | — | node smoke (done, scratch) | §7.4 items 1–2 |
| **S3.E** | Wrapper diet (option E): `_frameKey` once per frame; `async_link` fast path trimmed | `batched_runs.js`, `async_link_guard.js` (one lane) | none: exact; or under the existing flags | `tests/batched_runs*.test.mjs`, async_link suites | rides the next bench |
| **S3.1** | `draw_exec.js`: records, validation, continuation path, state-only switch, VAO tracking, run integration, info/diag counting, context-restore reset, live `off` seam | new `scene3d/draw_exec.js`, `tests/draw_exec.test.mjs` (lane R3-impl). **Small exports needed from:** `batched_runs.js` (`prepareRunDrawWithRecord` = `_stableObserve` + `_prepare`, and `countRunDraw` for `_countFrame`); `index.js` one install line after `installBatchedRuns` (orchestrator) | `?drawExec`: DEV, `=on` opt-in, `rustFlag`-style reader | §7.2 identity suite; §7.3 smoke run by the orchestrator | §7.4 item 3 |
| **S3.2** | Sentinel runs: an outermost `list.sort` hook collapses consecutive eligible opaque items; the run executes renderObject's steps (hooks only when non-trivial, matrices, draw) | `draw_exec.js` (same lane), suite arms | `?drawExecRuns` (needs `?drawExec`) | suite + smoke arm | with S3.1 |
| **S3.4** | Rust static list on R2's `StaticDrawFrame`: cull, keys, sort, merge plan; hot/cold objects | `crates/holtburger-scene/src/draw_list.rs`, `src/scene_wasm/draw_list.rs`, `scene3d/rust/draw_list.js`, `tools/rust_parity/gen_draw_list.mjs`, `tests/draw_list_parity.rs`, `tests/rust_draw_list_parity.test.mjs` | `?rustDrawList` (`rustFlag(name, false)`) | `cargo test -p holtburger-scene` (orchestrator), node parity after the wasm build | A/B vs S3.2 |
| **S3.3** | Class-material snapshots (pools only) | `draw_exec.js`, `pool_material.js` (version epoch on every registry write) | `?drawExecMatSnap` | suite: mutation scenarios | only if the census shows pool switches matter |
| **S3.5** | UBO blocks (frame / object / class material) | a new `scene3d/uniform_blocks.js` beside `uniform_bind_patch.js`; chunk edits under a define | `?uniformBlocks` | fake-GL block read-back suite + smoke | gate: §7.4 item 2; then A/B + eye frames |
| **S3.6** | Entity rigid parts through the executor | `draw_exec.js` + lane B's rig output | `?drawExecRigs` | suite (skinned and animated excluded) | A/B in town |

**Default flips** follow the house rule: same-pixels proof, a bare-URL boot with 0 errors, and a 1070 A/B. The
url-flags rows come from the orchestrator.

---

## 9. Measurements still owed from the 1070

1. Per-kind world-pass draws, ranges, program/material/continuation split, record stability and GL calls per draw on
   the **chain default** (the probe's "all"): Holtburg (orbit + street), Linvak Tukal, one interior.
2. Per-kind ms/frame from a tagged CPU profile ("install" + `hbsess profile` + `drawlist_kind_split.py`), and a fresh
   chain-default profile of the whole frame. The 10-23 profiles predate the chain.
3. Visible nodes per owner (the probe) and `__skipHiddenMatrix.census(120)`: the static share of the walk (R2's term,
   for the S3.4 budget).
4. CrGpuMain cost per redundant command (the probe's "inject", `uniformM4` / `uniformM4dirty` / `vao` / `useProgram`,
   `gputrace` + `gpu_thread_split.py`). This decides S3.5 and the batching arena.
5. After S3.1/S3.2: the `drawExec` A/B (fps still / moving / tour, jank), a CPU profile per arm, CrGpuMain per arm,
   and eye frames.

---

## 10. Feasibility prototype (node, scratch, not committed)

Scratch files (laptop; persistent copy of the session scratchpad): `/mnt/wbterminal1/tmp/claude-scratch/rustcore-2026-10-26-scratch/`:
- `exec_proto3.mjs`, the identity check;
- `exec_proto2p.mjs`, timing and per-kind;
- `drawsplit.py` / `drawcat.py` / `rendersplit.py`, the 1070 profile analysis of §2.

The world (deterministic), 328 draws per frame:
- 48 BatchedMesh "pools" on 8 class materials, on the early-out;
- 40 per-object-culled BatchedMesh "buckets" on 12 materials;
- 160 plain "cell statics" on 40 materials;
- 80 dynamic "entity parts" with unique materials;
- 16 point + 2 spot lights, a directional, ambient and hemisphere light, fog, a PMREM-shaped environment;
- the client's program sort, `texUnitPin` + `lightUploadOnce` + `lightUbo`, and the BatchedMesh colorTexture fix.

The context is the repo's fake WebGL2, copied into a plain object (its Proxy cost ~1 ms/frame otherwise).

| Arm | GL state per draw vs stock (6 frames) | render() p50, best of 5 | Note |
|---|---|---|---|
| stock | — | 1.98–2.00 ms (6.0 µs/draw incl. walk) | per kind (outer timer): continuation 2.96 µs, switch 8.3–8.6, entity 6.6–6.8 |
| v1: continuation fast path + state-only switch (`group {count:-1}`) | **identical** | 1.97 | continuation 2.56 µs |
| v1t: + record on the object, O(1) checks, cached texture properties, skip proven-equal matrices / setMaterial | **identical** | **1.90** | continuation **2.03 µs** |
| v2: + executor material switch (port of `refreshUniformsCommon`/`Standard`, fog, upload) + `_currentMaterialId` reset via `setRenderTarget` | **identical** | 1.95 | switch 8.1 µs (no gain) |
| v3t: v1t + v2 + sentinel runs + skipping no-op `onBeforeRender` | **identical** | **1.90** | the runs (248 static draws) cost 1.06 ms including renderObject's per-item work; stock's same draws cost 1.05 ms in `renderBufferDirect` alone, with their renderObject work outside that figure; frame −5 % |
| stock + production BatchedMesh hooks (`batched_runs` + per-camera + L1 + skip_empty) | — | 2.04 → 2.36 | +0.32 ms over 88 BatchedMesh draws, mostly in `onBeforeRender` chains (R2's term) |

What this establishes:
- the coherence mechanisms of §5.5 are sufficient for an exact command stream;
- the removable share per continuation is ~1 µs of JS in node;
- material switches are irreducible without snapshots;
- three's per-draw cost transfers [D]: in node, three's `renderBufferDirect` averages ≈ 4.8 µs a draw over all kinds,
  including ~1 µs of fake-GL bookkeeping. On the 1070 it averages ≈ 5.0 µs, including ~1.3 µs of real GL calls. So
  the ratios carry over.

What it does not establish:
- Chrome's real per-call costs;
- the production wrapper chain under the executor (only measured stock + hooks);
- batched runs through the executor;
- reversed-Z and MSAA targets;
- context loss.

These are §7.2–7.3's job.

---

## 11. Premises that did not hold, and caveats

| Claim | Where | What is true |
|---|---|---|
| Stage 3 saves ~3 ms and fewer GL calls | plan §2 | ~1.3 ms (0.9–1.7) with the same GL commands. Fewer only with shader-side changes (S3.5), unpriced. |
| "37.6 µs fixed per draw" / "static BatchedMesh draws ~26–30 µs each" | `2026-08-06-frame-cost-structure-measured.md` §5a; open lead 248 | Today's world-pass draw loop is 6.28 ms over ~1,000 draws, ~6 µs a draw [D from M]. The August figures were instrumented and predate the colorTexture fix (−3.35 ms), the uniform bind patch and batched runs. They cannot price an executor. |
| `setProgram` alone is ~3.5 ms/frame | orchestrator brief | Holds: 3.30 ms inclusive in the world pass, 3.75 in r1 alone [M]. But ~1.9 ms of it is material-switch refresh and upload that an exact executor must still perform. |
| An executor can cut CrGpuMain by issuing fewer GL calls | plan §2 | Not while it reproduces three's stream: three's setter and state caches already drop most redundant calls. What remains is needed between differing draws. |
| A hand-rolled renderer forfeits three's machinery | pass-07 D-07.1 "Rejected" | True of a renderer outside three. This design keeps three's programs, materials, BatchedMesh and shadow pass, and replaces only the per-draw submission of proven-stable draws. |
| `renderer.resetState()` keeps the cache coherent | orchestrator brief (option) | Correct but unusable mid-frame: it disables reversed-Z clip control (`WebGLState.js:1230`), costs ~50 GL calls and forces full re-application. |
| Laptop owner tally (entities 626, cells 494, ...) | `HANDOFF-gpu-resident-statics-2026-10-22.md` §0 | Old stack, ring 2. Under the chain the envcell surfaces pool, so cells drop. Re-census (§9). |
| The perf-worker scripts live in `apps/holtburger-web/scripts/perf-worker/` | brief | They live in `external/holtburger/scripts/perf-worker/` (beside `hbsess.mjs`, `hbbench.mjs`, `structure-p0.eval.js`). The probe went there. |

Caveats:
- All 1070 numbers here are the old stack (10-23).
- The per-kind populations and the continuation share are derived, not measured, until §9 items 1–2.
- The executor couples to three r184 internals: `properties` fields `currentProgram`, `uniformsList`, `uniforms`,
  `receiveShadow`, `envMap`; uniform `cache` and `addr`; BatchedMesh `_multiDraw*`, `_matricesTexture`,
  `_indirectTexture`, `_colorsTexture`.
- A three bump must re-run §7.2 before the flag stays on. This is the same exposure `uniform_bind_patch.js` and
  `batched_runs.js` already carry.
