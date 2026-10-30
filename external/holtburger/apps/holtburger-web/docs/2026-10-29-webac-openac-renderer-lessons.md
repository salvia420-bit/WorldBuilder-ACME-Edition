# WebAC and OpenAC as renderer references for round 3

Date: 2026-10-29. Input to `docs/2026-10-29-round3-gpu-driven.md`.

**The owner's question:** "is there anything that OpenAC and WebAC can teach us in this regard [modern GPU-driven rendering and fps on the 1070], in absence of the holtburger Electron renderer, to supplement for the lack of that, or do they share our problems?"

**Sources.**
- Six reader reports: static world, entities/VFX, and frame pipeline, once for each client.
- Two adversarial verification passes. They checked 118 WebAC claims and 112 OpenAC claims. Anything they found wrong or unsupported is dropped or corrected here; Appendix A lists those claims.
- One runnability scout.
- Snapshots:
  - WebAC: the read-only mirror at `/mnt/wbterminal1/ac-refs/webac` (jakemmarsh/webac, AGPL-3.0, snapshot 2026-10-12).
  - OpenAC ("AcDream"): `external/OpenAC`.
- Earlier ledgers this builds on:
  - `docs/webac-comparison-2026-10-13/FINDINGS.md`. That ledger already took ProgramRetention, the opt-in retail degrade thresholds, RETAIL_DEG_MUL and the LOD duplicate-geometry collapse.
  - `docs/openac-comparison-2026-10-08/` (rounds 1 to 5).

**Citation roots.**
- **WebAC:** paths are relative to `packages/renderer/src/`. Paths starting `docs/`, `tools/` or `services/` are relative to the WebAC repo root.
- **OpenAC:** paths are relative to `src/AcDream.App/Rendering/`. Paths starting `AcDream.Core/`, `AcDream.App/` or `AcDream.UI.Abstractions/` are relative to `src/`. `docs/` paths and commit hashes are repo-level.
- **holtburger-web:** paths are relative to `apps/holtburger-web/`. `scripts/perf-worker/` is at the holtburger repo root.
- **Decomp:** `acclient.c` means `~/ac-headers/acclient.c`.
- **[D]** marks an estimate or a derivation. It is not a measurement.

**Our baseline** (1070, ultra, Holtburg, from the round-3 brief):
- About 40 fps with everything off, about 35 fps with the Rust scene-core defaults.
- Main thread about 20 ms per frame.
- About 1,079 `renderer.info` draws per frame:
  - about 289 cell-static Meshes;
  - about 370 entity part-surface draws over about 100 materials;
  - 86 occlusion-query proxies;
  - about 70 fused cell surfaces;
  - BatchedMesh static pools.
- three.js per-draw CPU about 7 ms per frame.
- GPU process about 14-15 ms per present.

One `renderer.info` call can be several real D3D11 draws on the 1070. ANGLE's D3D11 backend loops over every BatchedMesh multidraw range: settled Holtburg counted 1,921 calls but 5,838 ranges (`scene3d/batched_runs.js:5-18`).

---

## 1. Short answer

**Both clients share more of our problems than they solve. Neither can stand in for the missing upstream-renderer A/B, and neither has a GPU-driven path for creatures.**

**WebAC shares our CPU-side problems almost exactly.**
- **Same stack.** three.js ^0.186.1 `WebGLRenderer` on WebGL2, with every system on the main thread.
- **Same wall.** It hits the same per-draw submission cost we do.
- **Same entity shape.** Each creature is one Mesh per part-surface, and its own census flagged dynamic `part` meshes as the bucket that keeps growing.
- **It gets to about 800 draws by drawing less, not by submitting better:**
  - it builds objects only on retail's 3x3 full-detail ring;
  - it makes one `renderer.render()` call per frame, with no composer, shadows or post-processing;
  - it uses per-vertex retail lighting;
  - its numbers come from an Apple M3 Max.
- **It has never been measured on a 1070-class GPU.**
- **It is behind us on submission machinery:** no BatchedMesh, no texture arrays, no multi-draw, a per-frame JS LOD loop, and synchronous DAT decoding on the main thread.

**OpenAC shares about half of our problems.**
- **Draws are cheap there because of the API, not a design we can copy.** Vulkan 1.3 multi-draw-indirect (MDI) with bindless textures makes a draw a 20-byte command. WebGL2 has no equivalent.
- **Its in-world traversal is retail-shaped.** A CPU PView walk emits about 20,000 one-instance commands per frame at Sawato, and every visible instance is re-staged every frame.
- **Everything else runs on the CPU too:** no GPU culling, no compute shaders, no occlusion queries, CPU per-part animation and CPU particles.
- **So it is not GPU-driven in the owner's sense either.**

**Of the three clients, ours has the most GPU-driven animation technique:** `scene3d/anim_scenery_gpu.js` poses instances in the vertex shader from a pose texture.

**What each one can teach:**

| | Main lessons |
|---|---|
| **WebAC**: what to draw, and how to measure | 1. Retail draws statics, buildings and scenery only on the 3x3 full-detail ring. The decomp confirms this, and it contradicts our `scene3d/object_radius.js:13`. 2. Retail animation is stepped, so we can skip re-posing when the frame index has not changed. 3. Build interiors lazily. 4. Retail's per-part degrade is on by default there. 5. Measurement: per-frame `renderer.info` averaged by camera heading, a renderJs wrapper, a census by owner, and a diff of program cache keys. |
| **OpenAC**: material and per-object state as data | 1. Palette composites become texture-array layers, so a variety of outfits stops splitting materials. 2. Per-instance state lives in buffers instead of in cloned materials. 3. Opaque work is merged across retail's per-cell flush points (246 ranges down to 47). 4. Cell shells are deduplicated by (EnvironmentId, CellStructure, Surfaces). 5. Explicit per-pass GPU budgets with a hysteresis governor, and GPU timing by whole pass. |

**As a stand-in for the missing A/B:**
- **WebAC** can run on the 1070 today with no build, using two harness-side workarounds. It would give a same-stack, same-spot comparison (section 5).
- **OpenAC** first needs:
  - a .NET 10.0.3xx SDK;
  - a win-x64 publish;
  - a 2.25 GB DAT copy;
  - a bake to a ~570 MiB pack.

  Its off-screen mode is also unverified.

---

## 2. Side by side

**Shape tags:**
- **RS (retail-shaped):** a CPU walk decides per-object or per-part draws every frame.
- **CB (CPU-built batches):** modern submission (instancing, MDI or BatchedMesh), but the CPU rebuilds the instance or command list every frame.
- **GR (GPU-resident):** instance data persists, and frames where pool membership did not change cost no per-instance CPU.
- **GP (GPU-posed):** the shader computes per-instance state, such as the pose, from compact per-frame data.

No client in this comparison does GPU culling, GPU LOD selection or GPU-generated draw commands.

| Area | WebAC | OpenAC | holtburger-web |
|---|---|---|---|
| **World statics, scenery, buildings** | **CB.** One region-wide `InstancedMesh` per (GfxObj, submesh), about 56 pairs at Holtburg. No per-instance cull: measured +5% triangles for -885 draws. A JS `updateLod` loops over every instance every frame. Objects exist only on the retail 3x3 ring plus one hidden prefetch ring. `terrain/SceneryInstancePool.ts:11-33, :224-243`; `world/LandscapeDrawDistance.ts:94-116` | **RS walk submitted by MDI.** In-world, the PView walk appends one `OrderedDrawCommand` per surface batch with InstanceCount=1 (`Walk/WalkStaticStreamPopulator.cs:265`). Only far coarse blocks merge (`Walk/FarLandscapeDrawCache.cs:358`). About 20,000 commands per frame at Sawato (commit acc90af8). One `MultiDrawIndexedIndirect` per cull-mode run (`Wb/WbDrawDispatcher.Rhi.cs:756-787`). Objects are drawn when SideCellCount is 8 or Ring <= 4 (`Walk/RetailFrameWalk.cs:50, :145`). | **GR.** BatchedMesh sector pools, `scene3d/static_atlas.js` DataArrayTextures, and `scene3d/batched_runs.js` instanced regrouping. Opaque pools set `perObjectFrustumCulled=false` and do no per-instance work on unchanged frames (`scene3d/pool_registry.js:18-29, :579-583`). Objects reach `objRadius` 4, which is 81 landblocks (`scene3d/object_radius.js:45`). |
| **Terrain** | **RS.** One Mesh per landblock with one group (draw) per terrain type. Blend and road overlays are transparent quads, merged per key across the region, with a stencil punch. Retail block LOD 8/4/2/1 out to draw distance 8 (17x17 blocks). `terrain/TerrainRenderer.ts:817-861`; `terrain/OverlayMergePool.ts:13-17, :117-127`; `terrain/LandblockMesh.ts:403-410` | **CB.** One 384-vertex, world-baked slot per landblock in a global vertex buffer. Walk land cells are coalesced into one MDI per walk batch. `TerrainModernRenderer.cs:108-118, :217-260`; `TerrainModernRenderer.Rhi.cs:213` | **GR.** One BatchedMesh over the resident ring with a splat shader (`scene3d/terrain_batch.js:1-30`). ANGLE still loops one range per in-view landblock (`:86-93`). |
| **Interiors / EnvCells** | **RS.** One Group per cell, one Mesh per (surface, clamp, sidedness), each with a cloned material (`world/EnvCellRenderer.ts:346, :367`). Cell furniture goes in a per-cell InstancedMesh pool (`:571-581`). **Lazy build:** a landblock load builds only the cells in its building portals' stab lists; the rest are built when they enter the PVS (`world/LandblockObjectStreamer.ts:22-34, :886, :923`). | **RS walk submitted by MDI.** Shell geometry is shared by a hash of (EnvironmentId, CellStructure, Surfaces) (`Wb/EnvCellLandblockBuild.cs:135-138, :162-166`). Cells are drawn one at a time in portal-walk order (`RetailPViewPassExecutor.cs:146`). Retail's per-cell flush points are merged: about 246 ranges became about 47 at Sawato (commit 9747be79). | **RS.** `scene3d/cell_fusion.js` builds one geometry with groups per cell (about 70 draws), plus about 289 cell-static Meshes. `?cellStaticMerge` is default OFF (`scene3d/cell_static_merge.js:22-25`). EnvCells bake for render-set landblocks plus a radius-1 skirt (`scene3d/cells.js:930-948`), plus landblocks the LRU has not yet evicted. Every placement in those landblocks is built. |
| **Entities / rigs** | **RS.** One Mesh per (part, surface, clamp, sidedness). Every spawn gets new BufferGeometry, and the GfxObj is re-parsed on each `createMesh` (`models/ModelRenderer.ts:33-38, :94-149`). Paletted parts always get a fresh Material (`models/MaterialFactory.ts:311-323`). | **RS walk submitted by MDI.** In-world, every part-surface is its own command with InstanceCount=1 (PopulateCellDynamics, then ClassifyAndAppend; commands merge only when `AllowInstanceMerge` is set, `Wb/WbDrawDispatcher.OrderedStream.cs:101-127`). Cross-entity GroupKey instancing (`Wb/GroupKey.cs:7-17`) exists only on the flat, portal-tunnel and doll paths. A part is a `MeshRef` value, not a scene node. A palette composite is a (bindless slot, layer) pair. | **RS.** One `THREE.Mesh` per part-surface (`scene3d/setup_rig.js:186`), about 40 per humanoid (`scene3d/rig_cell_gate.js:18-20`). Geometry is shared per Setup. Paletted materials are cached by value key (`scene3d/materials.js:258`), but each palette signature is still its own material. |
| **Animation** | **RS.** JS with stepped keyframes (`animation/AnimationPlayer.ts:327-333`). `quaternion.set` is called on every part every frame (`animation/AnimatedEntity.ts:41-47`). No visibility gate (`world/ServerObjectManager.ts:2820-2850`). Animated statics are never instanced (`world/StaticAnimationDriver.ts:28-29`). | **RS.** CPU, rigid per part (`LiveEntityAnimationPresenter.cs:220-222`). Retail activity gate of 96 m (`AcDream.Core/Physics/RetailObjectActivityGate.cs:7`). One sequencer per static animating object (`RetailStaticAnimatingObjectScheduler.cs`). | **RS for rigs, GP for scenery.** The Rust MotionSequence plus `rustRig` makes one wasm call per entity (`scene3d/rust/rig.js`). Tick gate at 120 m (`scene3d/entities.js:3049-3057`). Anim-scenery is posed in the vertex shader from one RGBA32F row per (animation DID, part), about 30 rows per frame, default on (`scene3d/anim_scenery_gpu.js:1-30`). |
| **Particles** | **RS.** Closed-form JS simulation. One InstancedMesh per (GfxObj, surface) per emitter, with cloned geometry and material, `frustumCulled=false`, and a full upload every frame (`effects/ParticleSystem.ts:401-423, :1176-1185`). | **CB.** Closed-form C# simulation. Out-of-view infinite emitters freeze (`AcDream.Core/Vfx/ParticleSystem.cs:461-470, :974-1000`). The billboard batch key is only "additive or not", with the texture chosen per instance (`ParticleRenderer.cs:20, :35`). Global back-to-front sort. Retail-routed immediate particles cost one draw each (`ParticleRenderer.Rhi.cs:300-312`). | **CB.** Rust kernel, default on (`scene3d/rust/particles.js:6, :100-102`). Cross-emitter buckets keyed `gfx\|layer\|a\|sky` (`scene3d/particles/particle_manager.js:3187`). Uploads are limited to the live count (`:913-920`). |
| **Visibility / culling** | **RS (CPU only).** three's per-object frustum test. A per-doorway gate: the viewer must be on the doorway's enterable side and the doorway sphere must be in the frustum (`world/buildingCells.ts:260-282, :316-344`). Dungeons draw the current cell plus the DAT VisibleCells list (`world/DungeonRenderer.ts:279-291`). No occlusion queries. | **RS (CPU only).** Retail clip-height block tests (`Walk/WalkLandscape.cs:84-124`). Part spheres are tested against the portal views (`Wb/WbDrawDispatcher.WalkClassify.cs:466-490`). A building-portal BSP walk plus `ConstructBuildingView` (`Walk/WalkBuilding.cs:156-262`). `gl_ClipDistance` punch fans. `Building.QueryId` has no readers, and there is no compute. | **CPU plus GPU queries.** Rust frustum cull. `scene3d/interior_aperture_cull.js` (default on). `scene3d/occlusion_cull.js` ANY_SAMPLES queries: about 86 proxy draws per frame, results 1-2 frames late. Indoors: PVS BFS plus `scene3d/portal_clip.js`. This is the only one of the three that uses GPU visibility information. |
| **Residency / streaming** | Objects on the 3x3 ring plus one hidden prefetch ring; terrain to draw distance 8. A 6 ms generator scheduler with syncRadius 1 (`world/LandblockLoadScheduler.ts:42, :59`). DAT decode is synchronous on the main thread. | Near and Far tiers (Ultra 5/15, High 4/12). Unload at radius + 2 (`AcDream.App/Streaming/StreamingRegion.cs:140-141`). Per-frame caps of 2 ms, 64 completions and 8 MiB GPU upload (`AcDream.App/Streaming/StreamingWorkBudgetOptions.cs:17-25`). An offline-baked, memory-mapped `acdream.pak`. min(cores-2, 8) worker threads. | An 11x11 residency ring (`scene3d/residency.js:51`), objRadius 4, and the EnvCell 3x3 skirt. Rust/wasm decode plus a bake worker. A 6 ms frame_work cap. |
| **Frame passes / lighting** | One `renderer.render()` per frame (`scene/SceneManager.ts:269-278`). No composer, shadow map, SSAO or bloom. A per-vertex D3D8 lighting port; point lights are compiled only into cell-pass programs (`models/RetailLighting.ts:436-438`). Uncapped device pixel ratio with MSAA. | The default pack is "retail" with preset "off", so no shadows or post-processing (`AcDream.UI.Abstractions/Panels/Settings/DisplaySettings.cs:91-92`). The optional pack adds cascaded shadows with 2/3/4 cascades and GPU p50/p99 budgets, plus HDR, bloom and sun rays at 1/4 to 1/2 resolution, with a 180/900/300-frame governor. Per-instance lists of 8 light indices, Gouraud shading (`Shaders/mesh_modern.vert:142-150`). | A composer chain: sky, world, portal stencil/punch/seal, cells, SSAO, haze, particles, fx/bloom (`scene3d/atmosphere_pipeline.js:1362-1648`). Several direct-path `renderer.render` call sites (`scene3d/index.js:3307-3380`). Three-cascade shadows, with casters drawn once per cascade. A fixed pool of 16 point and 2 spot lights, per fragment (`scene3d/lighting.js:800-801`). `scene3d/adaptive_render_scale.js` adjusts resolution in a closed loop. |

**Measured numbers (not comparable hardware):**

| Client | Machine | Spot | Result | Source |
|---|---|---|---|---|
| WebAC | Apple M3 Max, ANGLE Metal, headless --gpu | Holtburg, draw distance 8 | 76.8 / 67.1 / 70.7 fps (idle / turning / running); 806 / 950 / 788 draws; 106k triangles; renderJs p50 6.5 ms | `docs/performance-budgets.md:136` |
| WebAC | same | Holtburg, draw distance 3 | 120 / 108.7 / 119 fps (vsync cap); 421 / 580 / 431 draws; renderJs p50 3.6 ms | `:135` |
| WebAC | owner's Mac, before pooling (2026-08-29) | Holtburg | 11 fps; 10,704 draws; 0 InstancedMesh | `:95-99` |
| OpenAC | unnamed (the CI Vulkan lane is an NVIDIA box) | Sawato / Arwic / Northwatch | CPU p50 5.04 / 5.21 / 0.53 ms; GPU p50 2.37 / 1.93 / 0.15 ms | commit 662ca87a |
| holtburger-web | GTX 1070, ultra | Holtburg | about 35-40 fps; about 1,079 draws; about 7 ms per-draw CPU; main thread about 20 ms; GPU process about 14-15 ms per present | round-3 brief |

Neither reference client has a 1070-class run.

What the per-draw figures mean:
- **WebAC's 8.5 µs per draw** (`tools/perf-ratchet-lib.ts:154-163`) is whole-frame time divided by draws on a frame with no instancing. It is not a pure JS submission cost.
- **WebAC's instanced M3 Max numbers** give about 8 µs of renderJs per draw [D: 6.5 ms / 806].
- **Ours is about 10 µs per three.js draw** on the 1070 (`scene3d/occlusion_cull.js:5-6`).

---

## 3. Lessons ranked for round 3

**Ground rule for the 1070.** On Chrome/Windows, ANGLE D3D11 turns every multidraw range into a full `drawElements`. Before each range it also re-uploads the stage's whole default uniform buffer, all on CrGpuMain (`scene3d/batched_runs.js:5-18`; `scene3d/pool_registry.js:34-40`). So:
- **What carries over from OpenAC's MDI is fewer ranges,** through instanced runs (one `drawElementsInstanced` per distinct geometry), not more BatchedMesh ranges.
- **True GPU-generated draws** (indirect commands written by a compute cull) would need WebGPU. This comparison did not evaluate that [D].

The lessons are in suggested order: cheap prerequisites first, then by expected effect on the 1070.

### 1. Measure the way they do, before and after every round-3 change (prerequisite, cheap)

**The technique**
- **WebAC `tools/measure-perf.ts`:**
  - reads `renderer.info` every frame together with the camera yaw, and averages 12 heading sectors (PERF.6). Point samples at one spot swung 93 / 239 / 929 draws (`docs/performance-budgets.md:239`);
  - wraps `renderer.render` to time renderJs (`:412-419`);
  - builds a census by named ancestor with 300 m and 600 m distance buckets (`:372-408`);
  - with `--program-keys`, diffs program cacheKey fields. That diff found `numPointLights` churning (`docs/performance-budgets.md:188-213`).
- **OpenAC:**
  - brackets **whole passes only** with GPU timestamps. Ranges nested inside a pass read about a seventh of the real cost (0.16 ms vs 1.7 ms; `AcDream.App/Diagnostics/GpuStageProfiler.cs:15-20`, commit a712be21). Cost inside a pass is attributed by ablation;
  - reports p50/p95/p99 plus allocations and GC per 5 s window (`AcDream.App/Diagnostics/FrameProfiler.cs`).

**Mapping to ours**
- We already have:
  - a median-of-3 ratchet (`harness/perf-ratchet.mjs`);
  - Long Animation Frame (LoAF) attribution (`scripts/perf-worker/loaf-stalls.eval.js`);
  - draw censuses (`scripts/perf-worker/drawcensus.js`, `glcensus.js`);
  - interleaved flag-bench;
  - a whole-frame timer query (`?vfxGauge`, `scene3d/index.js`).
- Add:
  - heading-binned per-frame sampling;
  - a renderJs wrapper;
  - one census row per owner: entity part-surfaces, particle buckets, cell statics, cell surfaces, occlusion proxies, each pool;
  - **multidraw range counts next to `info.calls`**;
  - whole-pass timer queries around each composer pass;
  - a dated 1070 µs-per-draw calibration.
- Pin server state between arms. In WebAC, creature spawns plus two extra streamed landblocks moved the census by 706 part meshes.

**Effect:** none on fps. It makes the 5-10% deltas from the lessons below measurable.

**Look risk:** none.

### 2. Skip re-posing when the stepped frame index has not changed (cheap, byte-identical)

**The technique.** Retail poses whole keyframes:
- `CSequence::get_curr_animframe` takes `_floor(this->frame_number)` (`acclient.c:339745-339758`).
- WebAC copies that (`animation/AnimationPlayer.ts:327-333`).
- We pose `f = globalFrame | 0` (`scene3d/motion/motion_sequence.js:151`).
- Neither client skips work when the floored frame has not changed.

**Mapping to ours**
- Keep a per-entity dirty key of (motion descriptor, floored frame, in-place mode).
- When the key is unchanged, skip the `rustRig` pose call and the part-local matrix writes. The root transform still updates.
- In the instanced design (lesson 3), an unchanged key means no pose-row write.

**Effect** [D]: rig posing CPU drops on every frame without a frame advance. The skip rate depends on each animation's DAT framerate relative to the display rate. Our 100-rig x 17-part pose plus scene walk benchmark costs 1,392 µs per frame (`docs/2026-10-26-rust-rig.md:38`, node/V8 on the laptop), and the pose part of that is the ceiling for this saving.

**Look risk:** none if the key is complete. Pin it with the existing rig parity tests.

### 3. Draw creatures as instanced, GPU-posed batches with materials as data (the big one)

**The problem.** About 370 part-surface draws over about 100 materials, at about 10 µs each on the 1070 (about 3.7 ms of three.js CPU [D]), plus per-part Object3D matrix work. All three clients have this one-draw-per-part-surface shape; OpenAC hides it behind MDI.

**Where the pieces live elsewhere**
- **Palette composites as texture-array layers (OpenAC):**
  - `CompositeTextureArrayCache.cs:236-240`: arrays of about 4 MiB with at most 64 layers, and at most 16 uploads or 8 MiB per frame;
  - value-keyed `CompositeTextureKey` (`TextureCache.cs:445-449`);
  - the shader samples (slot, layer) (`Shaders/mesh_modern.frag:59`).
- **WebAC's content-hash palette key** (`models/TextureManager.ts:286`): different subpalette lists that compose to the same colours share one texture.
- **Per-instance state arrays instead of material clones (OpenAC):** opacity, flags, selection lighting and indoor flag are bound as storage-buffer sections (`Wb/WbDrawDispatcher.Rhi.cs:320-357`). By contrast, both WebAC (`models/MaterialOwnership.ts:5-24`) and we (`_getOrCloneEntityMaterial` in `scene3d/entities.js`) clone a material for every fade or hook, which knocks the part out of any batch.
- **Our own `scene3d/anim_scenery_gpu.js`:** pose rows in an RGBA32F texture, composed in the vertex shader.
- **Existence proof that a key with no entity field collapses identical parts:** OpenAC's flat path (`Wb/GroupKey.cs:7-17`; `Wb/WbDrawDispatcher.cs:2264-2265`).

**Mapping to three.js r184 / WebGL2**
1. Keep the CPU-decoded RGBA composite, so texels are identical. Upload composites into size-bucketed `THREE.DataArrayTexture`s, the way `scene3d/static_atlas.js` does for statics. Use one material per (array bucket, blend class, sidedness).
2. Use one `InstancedMesh` (or instanced run) per (part GfxObj surface-group geometry, material bucket). Per-instance attributes:
   - entity or pose row index;
   - part index;
   - texture layer;
   - opacity/fade;
   - luminosity.
3. The Rust rig kernel writes per-(entity, part) matrices, or shared (animation DID, frame, part) rows, into a Float32 data texture with one `texSubImage2D` per frame. The vertex shader composes the pose as anim_scenery_gpu does.
4. Use instanced draws, not BatchedMesh ranges (see the ground rule).
5. Keep the existing gates (tick distance, `?rigCellGate`, occlusion) by compacting the instance list on the CPU each frame. That is O(visible rigs), which is cheap [D].
6. Translucent and fading parts stay on a sorted path until per-instance sorting is solved [D].

**Effect** [D]:
- Entity draws fall from about 370 toward the number of distinct (part geometry, material bucket) pairs in view.
- Per-part Object3D compose and the per-draw three.js cost go away for opaque parts.

**Look risk:** medium.
- Texels and matrices are unchanged if the work is done right.
- The risks are:
  - the alpha-test threshold on paletted textures (WebAC uses a separate threshold for palettized textures, `models/MaterialFactory.ts:98-103`);
  - transparency ordering;
  - landscape versus cell lighting variants;
  - the shadow-caster path.
- Needs a 1070 eye test.
- A later GPU palette lookup (R8 index plus a palette row) is a further look risk because filtering must match. Defer it.

**Neither reference has this.** Validate it the way anim_scenery_gpu was validated.

### 4. Retail's 3x3 object ring: correct our fidelity note, then put a price on objRadius

**Decomp, verified:**
- `LScape::get_block_orient` gives size 1 only at Chebyshev distance 1 or less (`acclient.c:306681` ff.).
- `CLandBlock::init_buildings` (`:352134`) and `CLandBlock::init_static_objs` (`:352811`) are gated on `side_cell_count == 8`.
- `get_land_scenes` sits inside that gate (`:352887-352888`).
- `update_block` calls `notify_change_size` when a block leaves full detail (`:308183-308185`), and that destroys statics and buildings (`:352430-352438`).

**Ours contradicts it.**
- `scene3d/object_radius.js:13-15` says retail draws objects "across the whole `mid_width = 11` grid".
- The `objRadius` row in `docs/url-flags.md` says `?objRadius=off` restores "retail's full-ring objects".

Both are wrong. Our default of 4 means 81 object landblocks; retail uses 9.

**The two references.**
- **WebAC ships retail's ring** (`world/LandscapeDrawDistance.ts:94-116`). Its Holtburg census:
  - statics 787 to 223;
  - buildings 60 to 16;
  - scenery instances 32,066 to 383 (`docs/performance-budgets.md:180`).
- **OpenAC goes beyond retail on purpose.** It uses `ObjectRingLimit = 4` (`Walk/RetailFrameWalk.cs:50, :145`), and our default of 4 was chosen to match OpenAC's High near tier (`scene3d/object_radius.js:14`).

**Mapping.**
1. Fix the comment and the url-flags row.
2. Run interleaved 1070 arms `?objRadius=1`, `2` and `4`, parked at Holtburg and at a hilltop.
3. The owner decides whether a radius above 1 is a deliberate beyond-retail horizon.

**Effect** [D]: static pool instance counts, triangles and bake churn per landblock crossing scale with ring area (9, 25 or 81 landblocks). Per-frame CPU scales less than area because opaque pools do nothing on unchanged frames. Draws at the Holtburg town centre should change only modestly, because most of the town is inside the 3x3.

**Look risk:** high at radius 1, because buildings and trees beyond the neighbouring landblocks disappear from the horizon. That is the owner's call.

### 5. Interior cells: merge across cells and deduplicate shells

**The technique.**
- **OpenAC keeps retail's per-cell visibility but stops flushing per cell:** about 246 ranges became about 47 at Sawato, and CPU p50 went from 5.2 to 4.9 ms (commit 9747be79; `Walk/WalkFrameDriver.cs:575-580`).
- **Shells are keyed by (EnvironmentId, CellStructure, Surfaces)** (`Wb/EnvCellLandblockBuild.cs:135-138`).

**Mapping.**
- (a) Run the 1070 look check for `?cellStaticMerge` and ship it. By the module's own count it takes about 351 cell-static draws down to about 200 (cell, material) pairs (`scene3d/cell_static_merge.js:6-9`).
- (b) Next, bucket cell statics and cell surfaces per material across all visible cells. Visibility per cell becomes an instance or range mask driven by the Rust render set. This is the WebGL form of OpenAC's merged ranges; prefer instanced runs or merged geometry to BatchedMesh ranges [D].
- (c) Check whether the wasm side caches cell geometry by the (env, struct, surfaces) triple. `src/geom_bundles.rs:2366-2378` builds geometry per cell, and no cache keyed on the triple was found. Add one for repeated dungeon rooms.

**Effect.**
- (a) About 150 fewer draws (module comment).
- (b) Fewer still, toward the number of visible materials [D].
- (c) Memory and bake time. It also saves draws once (b) instances the shells.

**Look risk.**
- Low for (a) and (c): the geometry is the same.
- Medium for (b): it must preserve the portal stencil, punch and seal ordering for cells seen through doorways.

### 6. Count and price `renderer.render()` walks per frame

**The technique.** WebAC makes exactly one `renderer.render()` call per frame (`scene/SceneManager.ts:269-278`).

**Our side.**
- We have composer passes (`scene3d/atmosphere_pipeline.js:1362-1648`) and several direct-path call sites (`scene3d/index.js:3307-3380`).
- Each full render re-runs three's `updateMatrixWorld`, `projectObject` and sort.
- That walk measured 2.39 ms on the old stack: 0.78 ms matrix walk, 1.29 ms projectObject, 0.32 ms sort (`docs/2026-10-26-rust-residency-design.md:276`).

**Mapping.**
1. Instrument the number of walks per pass.
2. Where passes render layer subsets of the same scene, project once and feed several pre-built render lists. three.js has no stock API for this; it needs a custom render-list path [D].
3. Skip passes whose layers are empty.

**Effect** [D]: up to about 1-2 ms of main thread per avoided full walk, scaled from the 2.39 ms figure.

**Look risk:** none if the lists are equivalent.

### 7. Particles: fewer buckets, and motion in the shader

**The technique.**
- OpenAC's billboard batch key is only "additive or not". The texture is per instance (`ParticleRenderer.cs:20, :35`), and particles are sorted globally back to front (`ParticleSubmissionOrdering.cs:59-62`).
- Retail particle motion is closed-form in particle age (`AcDream.Core/Vfx/ParticleSystem.cs:1100-1112`).

**Our side.** Buckets are keyed `gfx|layer|a|sky` (`scene3d/particles/particle_manager.js:3187`).

**Mapping.**
1. Put sprite textures in size-bucketed DataArrayTextures with a per-instance layer, and key buckets on (blend, render layer, sky) only.
2. Then go one step further than both references: upload each particle's spawn record once and evaluate the closed-form motion in the vertex shader from `uTime`. The spawn record holds origin, offset, a, b, c, spawn time, lifetime, and the size and alpha endpoints. The CPU then only spawns and kills particles.

**Effect** [D]: particle draws drop to a few per blend class, and per-particle CPU disappears for the closed-form types. How much this buys depends on how many buckets are live at Holtburg, so take a lesson-1 census first.

**Look risk:** medium.
- Sort order across GfxObjs changes when buckets merge; sort back to front within each bucket.
- The shader motion must be parity-tested against the Rust kernel.

### 8. Re-check whether the cell half of the occlusion queries still pays

**The references.** Neither uses occlusion queries.
- WebAC uses a per-doorway gate (`world/buildingCells.ts:260-282`).
- OpenAC uses a building-portal walk (`Walk/WalkBuilding.cs:156-262`).
- Both are portal-plus-frustum tests, not occlusion tests: a doorway hidden behind another building still admits its cells.

**Our side.**
- `?interiorApertureCull` (default on) now applies the same retail sidedness-and-on-screen rule.
- The queries cost about 86 proxy draws, with results 1-2 frames late.
- The measured upper bound was 1,973 to 1,188 draws and 24.5 to 30.5 fps (`scene3d/occlusion_cull.js:11-12`).

**Mapping:** an interleaved A/B on the 1070 of proxies for entities and cells versus entities only.

**Effect** [D]: up to 86 fewer proxy draws, minus any interior draws that come back.

**Look risk:** none. Removing a cull can only add draws.

### 9. Build interior cells lazily (bake time and VRAM, not draws)

**The technique: WebAC PERF.3** (`world/LandblockObjectStreamer.ts:22-34, :886, :923`).
- When a landblock loads, build only the cells in the building portals' stab lists.
- Build the others when they enter the current cell's PVS.
- Retire them when the player leaves the landblock.

WebAC's Holtburg census, with PERF.3 and the 3x3 ring cut (PERF.5) combined:
- cell meshes 665 to 197;
- area 0x0366: 18,886 to 0 (`docs/performance-budgets.md:172-181`).

**Our side.** The bake scope is already the 3x3 skirt (`scene3d/cells.js:930-948`), but every placement in each landblock is built.

**Mapping.** Pre-filter placements to the union of the building portals' stab lists and each portal's other_cell_id. Enqueue the rest on PVS demand.

**Effect** [D]: less bake time, less VRAM, and shorter AABB walks in the Rust render set. Draws stay the same at steady state.

**Look risk:** low. The risk is pop-in, so prefetch at PVS distance.

### 10. A/B `?partDegrade=on` for far creatures

**The technique.** WebAC runs retail's per-part degrade on every Setup part by default (`models/SetupModelRenderer.ts:130-137`). Retail stops drawing a human's body parts beyond about 134 m (`scene3d/part_degrade.js:22-24`).

**Our side.** Ours is opt-in, waiting for a 1070 look check (`scene3d/part_degrade.js:41, :180-189`). Keep our throttled interval; do not copy WebAC's per-frame `matrixWorld.decompose` of every part (`models/DegradeLod.ts:698`).

**Effect** [D]: removes far creature part draws. The size depends on the crowd.

**Look risk:** low; this is retail behaviour.

### 11. A governor with per-pass GPU budgets

**The technique (OpenAC).**
- Every shadow preset has GPU p50/p99 budgets: Low 2.0/3.0 ms, Medium 3.25/4.5 ms, High 4.5/6.0 ms (`DirectionalShadowQuality.cs:94-136`).
- The governor downgrades after 180 frames over budget, upgrades after 900 frames of headroom, and then cools down for 300 frames (`Packs/AtmosphericAutoQualityController.cs:39-41`).

**Our side.** `scene3d/adaptive_render_scale.js` is closed-loop on resolution only.

**Mapping.** Once lesson 1 gives whole-pass timer queries, let the shadow cascades and resolution, SSAO and clouds step down under load on 1070 ultra.

**Effect** [D]: holds a frame-time target instead of sitting at 35-40 fps. It does not make any given look cheaper.

**Look risk:** by design. The owner chooses which knobs it may turn.

### 12. Small items

- **Play-time upload draw.** WebAC draws each newly arrived subtree once into a 1x1 scissor with an unlit override material (`scene/RendererWarmup.ts:49-57`). With a fixed light count and warm-up, its turning max frame went from 208 ms to 18.5-18.7 ms (`docs/performance-budgets.md:205-210`). Our ledger item render-perf-5 shipped only the zero-visual part. This fixes hitches, not fps.
- **CPU-backed 2D canvases.** Default `getContext('2d')` to `willReadFrequently: true` (`ui/CanvasBacking.ts:26-34`). Only 3 of our 29 `getContext('2d')` sites set it. The effect on the 1070 is unmeasured [D].
- **Never let the frame thread wait on a worker's whole job.** OpenAC's per-read content gate cut frame-thread waits from 36.9 ms to 0.3 ms (commit 97bc65e4). Audit how we adopt bake-worker results for whole-job blocking.
- **Byte-denominated per-frame upload caps.** OpenAC caps GPU upload at 8 MiB per frame (`AcDream.App/Streaming/StreamingWorkBudgetOptions.cs:17-25`); apply the same idea to `texSubImage3D` and BufferAttribute uploads.
- **Leaf transform freezing.** WebAC sets `matrixWorldAutoUpdate=false` on each static leaf and measured about 4% of the Holtburg main thread (`utils/freezeStatic.ts:6-20`). Our `?freezeWorldRoots` freezes 7 containers, which is not equivalent. Its town number on the 1070 is still owed (`docs/url-flags.md`).

---

## 4. What not to take

### From WebAC

- **Its terrain.** Per-landblock multi-group meshes, transparent overlay quads with a stencil punch, and a full region rebuild of every dirty overlay key on each stream event (`terrain/OverlayMergePool.ts:117-127`).
- **Per-frame JS LOD.**
  - It loops over every pooled instance with a whole-buffer re-upload (`terrain/SceneryInstancePool.ts:224-243`).
  - It decomposes every part's matrix every frame (`models/DegradeLod.ts:698`).
  - Our statics also run THREE.LOD in JS (`scene3d/statics.js:2066, :2281`), so we are not clean here either.
  - The GPU form exists in neither client: draw each LOD level's instanced mesh and let the vertex shader collapse instances outside that level's distance band [D].
- **Per-mesh material clones and per-spawn geometry.** Every cell mesh clones its material (`world/EnvCellRenderer.ts:367`). Every spawn gets its own BufferGeometry and re-parses the GfxObj (`models/ModelRenderer.ts:33-38, :94-149`).
- **Its particles.** One InstancedMesh per emitter with cloned geometry and material and `frustumCulled=false` (`effects/ParticleSystem.ts:401-423`).
- **Per-part `quaternion.set` every frame** (`animation/AnimatedEntity.ts:41-47`). The Euler re-derivation it triggers was about 40% of poseRigAt on the 1070 (`scene3d/rust/rig.js:9-13`). Also avoid its per-frame allocations: `frames.slice()`, `identityFrame()`, `new Set()`.
- **JS wrappers around `renderBufferDirect` and `setMaterial` on every draw** (`scene/WorldMirror.ts:83-96`).
- **Uncapped devicePixelRatio with MSAA** (`scene/SceneManager.ts:163-166`).
- **Synchronous DAT decode on the main thread.**
- **Its region-wide no-cull InstancedMesh pool as a replacement for our sector pools.** Our opaque pools already skip per-instance culling (`scene3d/pool_registry.js:579-583`). Swapping in WebAC's pool brings no measured gain and loses spatial culling per pool.
- **Its 8.5 µs per draw as a calibration for us.** It is whole-frame time divided by draws on a frame with no instancing, and the file itself warns that the per-call cost rises once instancing lands (`tools/perf-ratchet-lib.ts:154-163`).

### From OpenAC

- **Its command-count model.** About 20,000 one-instance commands per frame is cheap under MDI. Under ANGLE D3D11 it would be about 20,000 real draws.
- **More multidraw ranges as the way to cut draws.** Each range is a full draw on the 1070 (`scene3d/batched_runs.js:5-18`). Cut ranges with instanced runs instead.
- **Re-staging every visible static instance every frame** (`Wb/WbDrawDispatcher.Rhi.cs:294-360`). Our JS version of a per-frame walk across the whole ring was closed as a regression: 22.5 vs about 29 fps moving (`scene3d/static_batch_x.js:4-8`).
- **Retail's one-cell-at-a-time shell submission** (`RetailPViewPassExecutor.cs:146`).
- **Retail's fps-driven building degrade**, with targets of 8 / 10 / 20 fps (`BuildingDegradeController.cs:9-11`). These are CPU-era targets.
- **The immediate alpha path** that draws one particle per draw call (`ParticleRenderer.Rhi.cs:300-312`).
- **One sequencer per static animating object.** Our shared GPU pose rows are better.
- **Its building-portal walk as a replacement for occlusion queries.** It is portal plus frustum:
  - it still admits doorways hidden behind other buildings;
  - it does nothing for rigs;
  - every admitted portal adds a depth-punch draw (`Walk/WalkBuilding.cs:258-259`).
- **Multiview shadows.** OpenAC uses them only on Low (two cascades) when the atmospheric pack is active. Nobody has checked whether OVR_multiview2 works on Chrome/ANGLE D3D11 or whether three r184 has a multiview shadow path. Don't invest until that is checked.
- **Per-instance light-index lists as a batching fix.** three.js lights are scene-global uniforms, so they never split our batches, and the fixed 16+2 pool already stops relinks. OpenAC's 8-index list matters only if we want more lights in view at a bounded per-fragment cost. That is a fidelity lever, not an fps one.
- **Its look.** Gouraud shading only, with no shadows or post-processing in the default pack.

### Retail-shaped costs all three clients share (round 3 has to solve these without help)

- One draw per part-surface. WebAC and we draw it directly; OpenAC emits one command per part-surface in-world.
- CPU part posing every frame (all three).
- Material clones for per-object fades and hooks (WebAC and ours).
- CPU particle simulation (all three; ours runs in Rust).
- CPU visibility (all three; we add GPU queries).
- No client generates draw commands or culls on the GPU.

---

## 5. Measuring them on the 1070

### 5.1 WebAC: runnable, yes (no build, two harness-side workarounds)

**Why it is worth running:** same stack, same spot, same GPU. It is the closest we can get to the missing A/B.

**Laptop side.** Follow `~/CLAUDE.md`: check `free -m` first. `npm install` is network and disk work, not a listed heavy job, but run it while nothing heavy is running.

1. `cd /mnt/wbterminal1/ac-refs/webac && npm install`
   - Node v20.20.2 is present.
   - If the better-sqlite3 native build fails, `npm install --ignore-scripts` is enough; only tools and tests use it.
2. Link the base DATs:
   - `mkdir dat`
   - `ln -s /home/wbterminal/ac_base_dats/client_portal.dat /home/wbterminal/ac_base_dats/client_cell_1.dat /home/wbterminal/ac_base_dats/client_local_English.dat dat/`
   - There is no `client_highres.dat`, so Very High texture detail draws at High.
3. **Bridge.** Our `holtburger-wsbridge` cannot carry WebAC's traffic:
   - our bridge first requires a JSON hello, then expects frames prefixed with a port (`apps/holtburger-wsbridge/src/handshake.rs:3-11`; `crates/holtburger-transport-ws/src/frame.rs:19-37`);
   - WebAC sends bare AC datagrams.

   So run WebAC's own bridge alongside ours: `npx tsx services/ws-tcp-bridge/src/bridge.ts 9090 127.0.0.1 9000`. Start it with setsid nohup and log to `/mnt/wbterminal2`. It coexists with our bridge on :8080.
4. **Dev server:** `npx vite --host 127.0.0.1 --port 3000 --strictPort`. URL login, `?bridge=`, `window.__ac` and `acDebug` exist only in dev (`config/urlOverrides.ts:32-34`; `utils/debugTools.ts:19-22`). WebAC's own published numbers were also taken in dev mode.
5. **Tunnel:** add `-R 3000:127.0.0.1:3000 -R 9090:127.0.0.1:9090` to the box ssh. Keep the existing `-L 9333`, `-R 8765` and `-R 8080` forwards.

**Box side.** Use the existing MODE T test Chrome: off-screen, `--mute-audio`, `--user-data-dir C:\Temp\cdpwb-wls`, CDP :9333. Only one real-world tab at a time.

6. Open one tab with playwright-core `connectOverCDP('http://127.0.0.1:9333')`. Before navigating, `addInitScript` a shim that makes the connection report DAT iterations portal 2074 / cell 982 / language 994.
   - **Why:** ACE has DAT patching off and terminates clients that report older iterations (`ACE.Server/Network/Handlers/DDDHandler.cs:165-168`). The base DATs report portal 2072.
   - **Why not the r10 DATs:** WebAC's reader ignores the zlib flag (`packages/dat-parser/src/DatDatabase.ts:480-485`), so it cannot read them.
   - **Hook points:** the connection is exposed at `main.ts:7325`, iterations are assigned at `:7348`, and `connect()` runs at `:7396`.
   - **Shim:**

   ```js
   (()=>{let c=null;const F={portal:2074,cell:982,language:994};Object.defineProperty(window,'__aceConnection',{configurable:true,get(){return c},set(v){c=v;if(!v)return;let o=v,d;while(o&&!(d=Object.getOwnPropertyDescriptor(o,'datIterations')))o=Object.getPrototypeOf(o);if(d&&d.set){Object.defineProperty(v,'datIterations',{configurable:true,get:()=>d.get.call(v),set:x=>d.set.call(v,{...x,...F})})}else{let val=v.datIterations;Object.defineProperty(v,'datIterations',{configurable:true,get:()=>val,set:x=>{val={...x,...F}}})}}})})()
   ```

7. Navigate to `http://127.0.0.1:3000/?ace&bridge=ws://127.0.0.1:9090&account=<ACCT>&password=<PW>&degmul=1`.
   - The first load streams about 1.27 GB of DATs into OPFS. Never add `?nocache`.
   - Confirm that UNMASKED_RENDERER reports GTX 1070 / D3D11.
8. Park the character:
   1. Gate on `acDebug.collisionState().x > 0` and `window.__ac.sceneManager` being present.
   2. Run `acDebug.admin('@teleloc 0xA9B40001 96 96 80')`, then `acDebug.setPlayerYaw(0)`.
   3. Wait until the scene mesh count is stable to about 1% across 4 polls.
9. From the laptop, run `AC_URL='<same url>' npx tsx tools/measure-perf.ts --attach http://127.0.0.1:9333 --no-reset --secs 20`.
   - Output goes to `verification/perf/perf-<utc>.json`.
   - Quote only the idle phase as the same-spot number.
   - Record the landscape draw distance (default 8) and degmul.
10. Clean up:
    - close the tab;
    - stop vite and the bridge;
    - drop the two extra forwards.

    Never kill the box Chrome except by matching its user-data-dir.

**Blockers and caveats**
- **Account.** ACE boots an account that is already in world. Use a second Developer-level account (needed for `@teleloc`) or run the two clients one after the other. Put credentials only in the URL or environment at run time, never in docs.
- **Memory on the box.** The whole-DAT path keeps about 1.3 GB of ArrayBuffers in the tab and writes about 1.27 GB to OPFS on the box disk.
- **Content.** The base DATs are the same source holtburger bakes from. The ACE world itself is the r10 set.
- **Off-screen rAF.** Never minimize the window; measure-perf warns that hidden tabs throttle rAF.
- **Parking.** WebAC's own parking helper uses `@telepoi holtburg`, which is the same landblock but a different cell. That is why step 9 passes `--no-reset` and we park with our own `@teleloc`.

### 5.2 OpenAC: runnable, plausible but heavy, off-screen mode unverified

1. **Build the win-x64 app and bake tools.**
   - `global.json` pins SDK 10.0.300 (latestPatch). The laptop has only 8.0.420 and 10.0.203, so install a 10.0.3xx SDK first, on `/mnt/wbterminal1` with `NUGET_PACKAGES` there too (the system disk is about 87% full).
   - Publish:

     ```
     dotnet publish src/AcDream.App/AcDream.App.csproj -c Release -r win-x64 --self-contained true -p:PublishReadyToRun=true -o <out>/app
     ```

     and the same for `src/AcDream.Bake/AcDream.Bake.csproj` into `<out>/bake`.
   - **On the laptop this is a HEAVY job:** one at a time, `free -m` at 2.5 GB or more available, run under `capped-build`. Building on the 1070 instead loads a machine a person is using.
2. **Data.**
   - The base DATs do not work: there is no `client_highres.dat`, and the iteration is 2072.
   - Use ACE's r10 set:
     - portal, cell and local from `/home/wbterminal/ace-dats-ssd/ace-r10-dats`;
     - highres from `/mnt/wbterminal2/dat-patch-r10/ace-r10-dats`.
   - That is about 2.25 GB; copy it to the box with `rsync -aL`. OpenAC's DAT reader (DatReaderWriter 2.1.7) handles zlib records.
   - Bake once over plain ssh:

     ```
     bake\AcDream.Bake.exe --dat-dir <dir> --out <dir>\acdream.pak
     ```

     The pack is about 570 MiB.
3. **Capability check.** Run the app once with `ACDREAM_VULKAN_PROBE=1`, `ACDREAM_NO_AUDIO=1` and `ACDREAM_AUTOMATION_EXACT_FRAMEBUFFER=1`.
4. **Session config.** Write a session config JSON (schema in `AcDream.App/Headless/Configuration/HeadlessConfiguration.cs:40-55`) with:
   - endpoint 100.116.47.66:9000;
   - the account;
   - character index 0;
   - the password from an environment-variable provider;
   - `loginCommands: ["@teleloc 0xA9B40001 96 96 80"]`;
   - a `statusFile`.
5. **Launch .bat.** Set:
   - `ACDREAM_NO_AUDIO=1` (mandatory: no sound may reach the 1070's user);
   - `ACDREAM_FRAME_PROF=1`;
   - `ACDREAM_GPU_STAGE_PROF=1`;
   - `ACDREAM_FRAME_HISTORY=<csv>`;
   - `ACDREAM_AUTOMATION_EXACT_FRAMEBUFFER=1`;
   - `ACDREAM_CONFIG_DIR` and `ACDREAM_DATA_DIR` pointing at a scratch profile;
   - optionally `ACDREAM_UNCAPPED_RENDER=1`, for throughput numbers only.
6. **Run hidden** in the interactive session with `schtasks /create ... /it` plus the runbook's `hidden-run.vbs`. A GUI process launched from plain ssh lands in session 0.
7. **Read the numbers.**
   - Wait until `status.jsonl` shows the character in world and the teleloc applied.
   - Read the rolling `[frame-prof]` lines: cpu_ms p50/p95/p99, gpu_ms p50/p95, and per-stage update/upload/render/present (`AcDream.App/Diagnostics/FrameProfiler.cs:205-224`).
   - Read the `[gpu-stage]` lines. These now cover shadow, world, volumetric and post only; commit a712be21 removed the finer nested ranges.
8. **Stop it** by PID or image path, then delete the scheduled task. Never touch the box Chrome.

**Blockers and caveats**
- **SDK band and heavy publish** (step 1).
- **Off-screen presenting is unverified.** The only hide mechanism is the never-shown window (`GameWindow.cs:63, :72`). If the frame-prof frame count stops advancing, the window is not presenting. The fallbacks are an owner-present session or a one-line local window-position patch.
- **Firewall prompt.** A new exe's first UDP bind may raise a Windows Defender Firewall prompt on the person's desktop. Pre-add an allow rule for `AcDream.App.exe` over ssh before the first run.
- **Content mismatch.** The r10 set draws 4x-subdivided creature parts, which is more geometry than our base-DAT bake. The comparison is therefore conservative against OpenAC.
- **Frame-history CSV.** It is written only on a clean Dispose, so a hard kill loses it. Rely on the stdout lines.
- **Record the settings.** Note the QualityPreset (default High: Near 4 / Far 12) and the render pack (default retail/off).
- **Account conflict:** same as for WebAC.

### 5.3 What a Holtburg A/B would tell us

**Arms.** All at 0xA9B40001 (96, 96, 80), yaw 0, parked, on the same 120 Hz panel, with vsync state recorded.

| Arm | Client and settings |
|---|---|
| **H-default** | Ours, ultra defaults. |
| **H-retailscope** | Ours with `?objRadius=1` and the composer extras off: the closest match to WebAC's job. The exact flag set belongs to the round-3 plan. |
| **W** | WebAC, draw distance 8, `degmul=1`. |
| **O-retail** | OpenAC, retail pack (no shadows or post), High preset. |
| **O-atmo** | OpenAC with the atmospheric pack and shadows on. |

**Metrics:**
- heading-binned draws, plus multidraw ranges for ours;
- renderJs (ours needs the wrapper from lesson 1);
- main-thread busy;
- GPU ms (timer query for ours, `gpu_ms` for OpenAC);
- fps.

**Readings** [D]:
- **W vs H-retailscope** (same stack, similar scope):
  - If W's fps on the 1070 is about the same as H-retailscope, the remaining gap to 60 fps is three.js submission plus ANGLE on this machine. Round 3's main lever is then fewer real draws: lessons 3, 5 and 7.
  - If W is clearly faster, the extra cost is in our passes, shading and bookkeeping. Lessons 6 and 11 then come first.
- **W's renderJs p50 divided by its draws** gives a stock-three.js µs-per-draw figure for the 1070, taken with the same wrapper we will use on ours.
- **O-retail GPU ms vs our 14-15 ms GPU process per present** bounds how much of our GPU-process time is real GPU work, how much is ANGLE/CrGpuMain per-draw overhead, and how much is our shading.
- **OpenAC's CPU p50** bounds what a retail-shaped CPU walk costs in native code.
- **Neither number is a target.** WebAC renders Gouraud lighting with no post-processing; OpenAC renders r10 content natively with cheap draws. They are bounds that tell us which half of the frame to attack.

**Order.** Run WebAC first: it is cheap, needs no build, and shares our stack. Run OpenAC only if the owner wants the native ceiling and accepts the SDK install, the DAT copy and the bake.

---

## Appendix A: claims dropped or corrected after verification (do not reintroduce)

### OpenAC

- **"Instances identical parts across creatures in-world."** Wrong. That happens only on the flat, portal-tunnel and doll paths. In-world, every part-surface is a one-instance command.
- **"Animates every entity every frame with no gate."** Wrong. A retail activity gate applies at 96 m (`AcDream.Core/Physics/RetailObjectActivityGate.cs:7`).
- **"Animated entities skip frustum culling and are walked when their landblock is off-view."** That is the flat path only. In-world, part spheres are tested against the portal views.
- **"Terrain is equal to ours on draw count."** Not on the 1070: ANGLE loops our per-landblock ranges.
- **"The building-portal walk decides what our occlusion queries decide, with zero draws."** It is portal plus frustum, and it adds punch draws.
- **"Multiview shadows default off" and "all cascades in one multiview pass."** Both wrong. Multiview is on for Low (two cascades) whenever the pack is active; Medium and High draw each cascade separately.
- **"Halving allocations bought 0.15-0.3 ms p50 and cleaner p99s."** The p50 gain was at most 0.17 ms, and p99 got worse, within run-to-run noise (commit 94c2b4c9).
- **"Re-stages about 68k matrices per frame."** That is a capacity fixture, not a measurement.
- **"gpuDriven: true."** There is no compute, and indirect commands are built on the CPU.
- **Commit acc90af8 as a measured win.** The commit message calls the result neutral.

### WebAC

- **"WebAC's no-cull pool works only because its population is about 600."** It shipped with 32k scenery instances resident, before the 3x3 ring existed.
- **"Loops 78 point lights per lit vertex outdoors."** The point-light loop is compiled only into cell-pass programs.
- **"Its particles lack forceSinglePass."** WebAC does set it.
- **The census line "cell meshes 665 to 197 built / 9 drawn."** The 25 and 9 are landblock counts, and the 665 to 197 drop mixes the 3x3 cut with lazy building.
- **"+706 draws."** It is a SwiftShader mesh count, and it also includes two extra streamed landblocks.
- **8.5 µs as the JS submission cost per draw.** It is whole-frame time divided by draws on a frame with no instancing.

### Our side

- **"Ours bakes statics, buildings and EnvCells to radius 5."** Statics and buildings use objRadius 4; EnvCells use the 3x3 skirt plus LRU-retained landblocks.
- **"A hilltop over a town gains most from a Chebyshev-1 interior gate."** Interiors are already limited to the 3x3 skirt.
- **"We rejected perObjectFrustumCulled=false at 81 landblocks."** That A/B predates objRadius, and our opaque pools ship with the per-object cull off.
- **"Check that particle uploads are limited to the live count."** Already shipped (`scene3d/particles/particle_manager.js:913-920`).
- **"rustParticles is default off."** It is default on.
- **"We have no closed-loop governor."** `scene3d/adaptive_render_scale.js` is one.
- **"Our scripts only use plain longtask entries."** LoAF attribution already exists (`scripts/perf-worker/loaf-stalls.eval.js`).
- **"Static LOD is resolved in Rust."** Statics use THREE.LOD in JS; the Rust memo covers only entity dynLod.
