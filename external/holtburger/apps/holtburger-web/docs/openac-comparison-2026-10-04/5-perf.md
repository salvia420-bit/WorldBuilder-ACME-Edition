# 5 — Perf architecture: OpenAC (C#/Vulkan) vs holtburger-web (three.js/WebGL2 + wasm)

Read-only study, 2026-10-04. Every file:line below was opened this session.
Paths: `OA = external/OpenAC/src`, `HB = external/holtburger/apps/holtburger-web`.
OpenAC perf numbers are from its own commit messages (Sawato benchmark spot, desktop, Release);
holtburger numbers are from `HB/docs/2026-08-06-*.md` and `2026-08-08-pipeline-reengineering-survey.md`
(GTX 1070, quality mid; frame **CPU-bound**: 8.2x pixel sweep moved p50 25.8 -> 26.3 ms).

**Context to read first:** holtburger already has a 12-pass re-engineering SPEC
(`HB/docs/reengineering/SPEC.md`). Its slices are landed but every one is a DEV flag that is off by
default: `?packSource ?geomBundles ?texCompressedOnly ?slotGrid ?frameWork ?drawPools`
(url-flags.md:40-47). Most of OpenAC's ideas already appear in that SPEC in some form. This report
therefore focuses on **where OpenAC's proven shape differs from the SPEC's shape**, because those
differences are the real lessons.

---

## 1. Side-by-side architecture

| Axis | OpenAC | holtburger-web |
|---|---|---|
| **Streaming radius** | Two tiers. Objects use a NEAR radius and terrain alone uses a FAR radius. Presets: Low 2/5, Med 3/8, High 4/12, Ultra 5/15 (`OA/AcDream.UI.Abstractions/Settings/QualityPreset.cs:22-26`). Far-tier jobs read the heightmap only, with "no entity layer" (`OA/AcDream.App/Streaming/LandblockStreamTier.cs:12-16`). | One radius, `RESIDENCY_RADIUS_LB = 5` (11x11 = 121 LB), for statics, buildings and terrain alike (`HB/scene3d/residency.js:51`). `?staticsRadius` sizes the LRU only and does not set draw distance (`index.js:484`). Far terrain beyond the ring comes from the FCR albedo patches (`far_terrain.js`). |
| **Unload hysteresis** | Spatial: unload at radius+2 for both tiers (`StreamingRegion.cs:140-141`). | Temporal: a 2 s park hysteresis plus a 30 s UseTime floor (`residency_grid.js:91,96`). The geometry-COUNT governor `MAX_LIVE_GEOM = 8000` bypasses that floor (`landblock_lru.js:294`, comment at `:120-130`) and drains the warm pool (p99 cause #3). |
| **Slot grid** | Retail LScape grid, `MidWidth = 11` (`Walk/WalkLandscape.cs:39`; retail `mid_width = 11`, acclient.c:306944). Terrain is held in fixed slots of one buffer (`OA/AcDream.Core/Terrain/TerrainSlotAllocator.cs:6-45`). | 6x6 tile slot grid (`residency_grid.js:84-88`), behind `?slotGrid` (DEV, off). |
| **Background work** | `min(cores-2, 8)` dedicated threads with one channel per lane (`LandblockStreamer.cs:14-15, 49-54, 126-135`). Decoded meshes come from a memory-mapped pak keyed **per asset** (`GfxObjMesh / SetupMesh / EnvCellMesh / TexturePayload`, `OA/AcDream.Content/Pak/PakKey.cs:3-17`). | One bake web-worker with its own wasm instance. XU7/BC7 transcode runs on the main thread by default (p99 #2). Bundles (`src/geom_bundles.rs`) and the texture worker are DEV-flagged. Decode happens per LB, with a 64 MiB tri memo whose hits deep-copy (`src/lib.rs:9293-9300`). |
| **Main-thread admission** | One budget for the whole frame: 2 ms, 64 completions, 8 MiB adopted CPU, 4096 entity ops, 8 MiB GPU upload, 64 retire ops (`StreamingWorkBudgetOptions.cs:18-26`). Mesh uploads: 8 objects, 8 MiB, **at most 1 new texture array and 1 new buffer per frame** (`Rendering/Wb/WbMeshAdapter.cs:16-34`). Retirement advances **one stage per reservation** (`LandblockRetirementCoordinator.cs:790-825`). | Each family has its own private 6 ms budget, and the budgets add up. `evict` per LB is "one unchunked synchronous body" running inside rAF (p99 doc #3). A single 6 ms scheduler exists (`scene3d/frame_work.js:160,212`) behind `?frameWork`, which is off. |
| **Mesh residency** | Refcount per **GfxObj id** (`ObjectMeshManager.cs:467` Increment, `:558-595` Decrement). At refcount 0 the mesh moves to an unowned **LRU** instead of being freed. Eviction runs only when over the GPU-byte budget or the count cap (`:640-680`). Everything lives in one global VB/IB arena with a range allocator: 384 MiB VB / 128 MiB IB caps, growth quanta 256K verts / 1M idx (`GlobalMeshBuffer.cs:57-68`). | Geometry belongs to its LB (bake -> park -> evict). Returning to a parked LB after the pool drained means a full cold re-bake. Pools (`pool_registry.js`) measured ~55x allocated:used (22.3 vs 0.4 MiB, IMPLEMENTATION.md T22P). |
| **Statics draw** | Instanced by **value key** `GroupKey(FirstIndex, BaseVertex, IndexCount, TextureSlot, Layer, translucency, material state, cull)` (`Wb/GroupKey.cs:7-17`). Each command is an indirect `DrawElementsIndirectCommand` with BaseInstance into a transform SSBO (`WbDrawDispatcher.OrderedStream.cs:138-145`). | `BatchedMesh` buckets keyed by (3x3-LB region, material **object identity**) (`static_batch_x.js:1440-1451`). That gives 396 buckets / 95 material objects / 7 render states (frame-cost doc §5). The SPEC's (sector x class) pools are DEV. |
| **Per-frame statics work** | `FarLandscapeDrawCache` keeps each entry's grouped opaque command **block, camera-independent: every batch has a slot whether visible or not**. Per frame the visibility walk only picks *runs* of visible slots (`Walk/FarLandscapeDrawCache.cs:8-9, 55-95`). Rebuilds happen only when a per-record **write revision** or a per-landblock write stamp moves. | `BatchedMesh.onBeforeRender` costs 5.72 ms = 5.9 us/bucket + 0.348 us/instance over ~13k instances (per-instance-walk doc). `?statBatchMemo` cut 4.00 ms parked. The SPEC pools turn per-object culling **off** to hit three's early-out (`pool_registry.js:373-383`), which costs +81% tris when measured on buckets (frame-cost doc §3d). |
| **Culling** | Hierarchical: LB AABB, then 24 m land-cell `CellInView` (`WalkLandscape.cs:16-20`), plus retail PView portal walk for interiors. Terrain is frustum-culled per slot and drawn with one multi-draw-indirect (`TerrainModernRenderer.cs:176-198`). | Node-level frustum cull, per-instance sphere cull inside BatchedMesh, and a portal/PVS system for envcells. |
| **Distance LOD** | Retail building degrade ladder, scaled by an FPS-adaptive multiplier with an 8/10/20 fps band (`BuildingDegradeController.cs:7-11`; applied at `Walk/RetailFrameWalk.cs:176-178`). | Degrade is consulted for entities (`lod_prewarm.js`). Buildings only audit `didDegrade` (`buildings.js:1366-1370`). Statics have no distance degrade (`statics.js` has 0 hits). |
| **Textures** | Texture arrays keyed (w,h,format) with per-layer refcounts. Each array is fixed at about **8 MiB / at most 32 layers** (`Wb/TextureAtlasManager.cs:38-52, 97-98`) and **never grows**: a new array is allocated instead, at most 1 per frame. DAT **DXT1/3/5 upload as BC1/2/3 natively** (`Wb/WorldTextureArray.cs:274-276`). Bindless sampling. | RGBA8 first, then a BC7/XU7 upgrade (the double build). Atlas arrays **grow by reallocate+copy** (`static_atlas.js:50,171-190`; p99 #4: 20-250 ms per grow). Class pages grow x1.5 (17 classes = 127.8 MiB). There is **no s3tc path anywhere** in `scene3d/` or `src/lib.rs`. |
| **Animated statics** | The scheduler hands the scene **only owners written since the last handover**, about 200 of ~1500 at Sawato (`RetailStaticAnimatingObjectScheduler.cs:315-344`). | Instanced (`?animSceneryInstanced`, 4-6 draws). Every dirty bucket re-uploads its whole `instanceMatrix` (`animated_scenery.js:724-727`). |
| **Shaders** | SPIR-V compiled ahead of time and hash-checked against the manifest in CI (`docs/architecture.md:89-93`). There is no first-sight compile. | The 172-849 ms sync links (p99 #1) are mitigated by `shaderPrewarm`, which brought MAX from 2131 to 369 ms. The closed-class seal is in `?drawPools` (DEV). |

---

## 2. Most transferable techniques (ranked by fit to holtburger's measured walls)

**Status (2026-10-04, same day; none of it measured on a GPU yet):**
T9 landed (`animated_scenery.js` dirty-span upload). T5 landed ARMED (`?statAtlasPages`).
T10 landed opt-in (`?drawSortProgram`, with the `__drawSort.probe` A/B). T4 landed inside the
DEV `?frameWork` (byte/alloc caps, destination reserve, slot-bounded LRU loops). T6 measured and
NOT built (see its note). T1 landed opt-in for the default static batch path (`?statBatchRuns`),
exact-set rather than run-granular; the `?drawPools` pools still turn culling off.
T2 landed opt-in in its narrow form (`?statBatchMemoSlots=N`): one memo slot per camera so CSM cascades
stop evicting the colour pass's answer; the bucket epoch is the per-record stamp. A per-LB stamp for
the light rescans is not built.

### T1. Camera-independent cached draw blocks with per-frame *run selection* (do not drop culling)
- **OpenAC:** `Walk/FarLandscapeDrawCache.cs:55-95` (per-entry `Block`, "every batch has a slot, visible or not, so the block does not depend on where the camera is looking"). Grouping and ordering are at `:600-630`. Commit `193f6138` took Sawato CPU p50 from 5.11 to 4.42 ms and p99 from 6.73 to 5.29 ms by removing 22.5k per-frame command rebuilds.
- **holtburger:** `static_batch_x.js:1451` sets `perObjectFrustumCulled = true` on every bucket, which costs 5.72 ms of per-instance rebuild. The SPEC answer at `pool_registry.js:377-378` sets `perObjectFrustumCulled=false` and relies on 768 m sector node culling. The frame-cost doc §3d measured that trade at **+420k tris/frame (+81%)** on buckets, and the trade "would invert on weaker hardware".
- **WebGL2 shape:** this needs a subclassed or forked BatchedMesh, or a raw `WEBGL_multi_draw` pass. Lay each pool's multidraw arrays out **sorted by land cell (24 m) or LB**, so each cell owns a contiguous run of `starts/counts`. Each frame, cull at LB AABB and then cell AABB (the OpenAC hierarchy, `WalkLandscape.cs:16-20`), and emit the visible runs with `Int32Array.set` of subarrays. The work becomes O(visible cells), not O(instances), and no instance-level rebuild happens.
- **Expected:** keeps the pools' early-out win (the structural removal of most of the 5.72 ms term) and recovers most of the 81% culled-triangle regression. Cell granularity is coarser than per-instance, so a few % of tris come back. **Effort M-L** (touches `pool_registry.js` plus a three r184 BatchedMesh override).

### T2. Per-record / per-landblock write-revision stamps instead of re-reading or diffing
- **OpenAC:** commit `e7e18ac2` (scene records stamped with a monotonic revision, so the far cache compares one number per object): **CPU p50 10.5 -> 7.2 ms, ~93 -> ~135 FPS**. Commit `fb8678f7` adds a per-landblock write stamp so an entry asks once, not once per record.
- **holtburger:** traversal remainder is ~3.6 ms over ~4.4k nodes (survey §2). `?statBatchMemo` is a single-slot epoch that thrashes with multiple cameras or CSM, and was measured +0.5 ms *worse* while moving (`object-glue-census.md:249`).
- **Expected:** the gate under T1, and the way to make settled frames do zero work for every camera and cascade. Holtburger's pool "parked `mutationsThisFrame=0`" invariant is the same idea at pool level, but nothing generalizes it to a per-LB stamp that the CSM/shadow passes and the light rescans (`attachSetupModelLights`) can check. **Effort S-M.**

### T3. Object-granular refcounted mesh cache with an unowned LRU under a byte budget
- **OpenAC:** `Wb/ObjectMeshManager.cs:558-595` ("Instead of unloading, move resident data to LRU"). Eviction is budgeted at `:640-680` (bytes and count, per-frame reclaim cap `WbMeshAdapter.cs:32-33`: 8 meshes / 64 MiB). Mesh source is a per-asset pak (`PakKey.cs:3-17`), never per-landblock.
- **holtburger:** per-LB ownership plus a park pool. The **geometry-count** governor (`landblock_lru.js:294`) counts geometry the LRU does not own and zeroes the UseTime floor (`:120-130`). Result: 332 adds / 329 removes in 30 s, cold re-bakes, which then manufacture first-sight programs (p99 #1) and transcodes (p99 #2). The survey's invariant **I4** names this.
- **Expected:** this is the durable fix for p99 cause #3, the engine that feeds #1 and #2. Re-entering an LB becomes a refcount bump plus instance re-add, with no decode, no upload and no compile. Do it in Rust/wasm, per the MEMORY rule "system work in Rust": key by GfxObj/Setup id, byte-budget the decoded `Vec`, hand out shared views and stop deep-copying (`lib.rs:9293`). The GPU side keys `BufferGeometry` by content id with refcount. **Effort L** (it is the SPEC's W2 end-state; OpenAC shows the granularity should be the *asset*, not the tile).

### T4. Single frame-wide streaming budget across every kind of work, with staged retirement
- **OpenAC:** `StreamingWorkBudgetOptions.cs:18-26` (2 ms total with separate caps on completions, CPU bytes, entity ops, GPU bytes and retire ops; a 0.75 destination-reserve fraction for teleports). Retirement goes ticket by ticket, one stage per reservation (`LandblockRetirementCoordinator.cs:790-825`). Uploads are capped at 1 new array and 1 new buffer per frame (`WbMeshAdapter.cs:16-34`).
- **holtburger:** budgets add up per family. `evict` is unchunked inside rAF, and the sealed purge has a deliberate 250 ms first burst (`residency_grid.js:101`, p99 doc). `frame_work.js` already implements one 6 ms scheduler but is DEV/off.
- **Expected:** removes the synchronous evict/bake/allocation spikes from the p99 tail (moving p99 1,630 ms; MAX 369 ms after prewarm). OpenAC's lessons beyond what `frame_work.js` has: (a) budget **bytes and allocation count**, not only ms, because a single texStorage3D or buffer allocation is the indivisible spike; (b) split eviction into **stages** that are each charged to the budget; (c) reserve a fraction for destination work. **Effort S-M** (mostly flipping and extending `?frameWork`).

### T5. Fixed-size texture-array pages that never grow, at most one new page per frame
- **OpenAC:** `Wb/TextureAtlasManager.cs:51-52, 97-98` (8 MiB target, at most 32 layers per array, arrays keyed (w,h,format), refcounted layers). `MaximumNewArraysPerFrame = 1` (`WbMeshAdapter.cs:21`).
- **holtburger:** `static_atlas.js:50,171-190` grows on demand by reallocate and copy (p99 #4: 20-250 ms per grow, ~123 MB session traffic). Class pages grow x1.5 (T15). 17 class pages allocate 127.8 MiB (T22P).
- **Expected:** removes the atlas-grow hitch class entirely (no copy and no doubled peak VRAM; fewer context losses, with 7 per session recorded). The cost is that a class can span several pages, so an extra draw is needed per extra page. At holtburger's 37.6 us/draw fixed cost, 1-2 extra draws per class is cheap compared with a 250 ms grow. **Effort S.**

### T6. Native DXT upload (`WEBGL_compressed_texture_s3tc`) for the base tier
- **OpenAC:** `Wb/WorldTextureArray.cs:274-276` maps DXT1/3/5 to BC1/2/3, uploaded as-is with no decode.
- **holtburger:** no s3tc path exists. Every surface is decoded to RGBA8, uploaded with driver mipgen, then re-fetched as BC7/XU7 and transcoded on the main thread at ~32 ms per 1024² (p99 #2), leaving ~1.3 GB of CPU mirrors (survey §2). A clip-map census at `materials.js:2077-2079` shows DXT is the majority of non-paletted surfaces (DXT5 97, DXT1 27, DXT3 5 of 203).
- **Expected:** for DXT-native surfaces, frame-1 is 4-8 bpp with **zero** decode or transcode. That makes it an ideal preview/base tier in place of RGBA8 (the I3 fix), and the CPU mirror becomes the raw DAT bytes. s3tc is available on desktop Chrome/ANGLE (both owner GPUs) but not on mobile, so keep RGBA8 as the fallback. The Remacri hi-res tier stays BC7/XU7. **Effort S-M.**

- **Measured 2026-10-04 (before building it) — the premise does not hold as written.**
  `crates/holtburger-dat/examples/surface_mip_census.rs` over `client_portal.dat`: 2,130
  textured surfaces are DXT at the top level (DXT1 1,987, DXT5 138, DXT3 5; all power-of-two;
  129 ClipMap; none recoloured). **None carries a mip chain**: the SurfaceTexture level list
  holds 1 entry (1,085) or 2 (1,045), and the second entry is the SAME size
  (`256x256:Dxt1 > 256x256:Dxt1`), never a halving chain; the smallest level is never below 8 px.
  WebGL cannot generate mips for a compressed texture, so "upload the DAT bytes, zero decode"
  means no mipmaps (minification shimmer) unless the client decodes, downsamples and
  re-encodes the lower levels itself. Sizes: 74.7 MiB of DXT blocks vs 507 MiB of RGBA8 top
  levels today (before driver mips). The wasm decode also cannot be skipped today: the
  normal/height planes are derived from the decoded RGBA (`normal_and_height_pixels`), and the
  statics atlas copies RGBA8 layers from those planes. And the frame-1 role is already designed
  in, BC7-shaped: survey I3's fix, the baked preview tier in place of RGBA8, is
  `?texCompressedOnly` (ST5, DEV). Both owner GPUs have BPTC. DXT would only add a third path
  for GPUs with s3tc but no BPTC. **Status: not built**; finishing the `?texCompressedOnly` gate
  covers the same wall.

### T7. Separate near (object) radius from far (terrain) radius
- **OpenAC:** `QualityPreset.cs:22-26` (High = 4 for objects / 12 for terrain; Medium 3/8) and `LandblockStreamTier.cs:12-16`.
- **holtburger:** objects use the full radius 5 (`residency.js:51`): 26,586 resident static instances, 381-677 ktris. The FCR already covers the far terrain look.
- **Expected:** resident object population scales with ring area. Radius 4 is 81/121 = 67% and radius 3 is 49/121 = 40%. That cuts the per-instance terms (0.348 us/instance), bake/evict churn per crossing (one edge row is 9 LBs, not 11) and memory. Statics far away could also use T8 instead of vanishing. This is a fidelity call for the owner (retail draws objects across `mid_width=11`). Ship it as a quality preset, not a new default. **Effort S** (the knob plus decoupling statics from `RESIDENCY_RADIUS_LB`).

### T8. Retail degrade ladder for static buildings/props, with an FPS-adaptive multiplier
- **OpenAC:** `BuildingDegradeController.cs:7-11` (retail 8/10/20 fps band, 20-frame history) and `Walk/RetailFrameWalk.cs:176-178`. Ladder entries that "draw nothing at this distance" remove the draw entirely.
- **holtburger:** statics are drawn at close LOD at every distance. Buildings only audit `didDegrade` (`buildings.js:1366-1370`).
- **Expected:** fewer tris, and in this CPU-bound frame, fewer **draws/instances** at range. Note that the docs warn draws-removed x us does not predict wins. The real value is that degrade-to-nothing at distance cuts population, which compounds with T1. **Effort M.**

### T9. Dirty-only handoff for animated statics, plus partial instance uploads
- **OpenAC:** `RetailStaticAnimatingObjectScheduler.cs:315-344` (offers about 200 of ~1500 per frame).
- **holtburger:** `animated_scenery.js:724-727` flags the whole `instanceMatrix` of each dirty bucket, so the whole buffer is uploaded. Use `instanceMatrix.addUpdateRange` (three r159+) over contiguous dirty slots, and skip distance/frustum-culled owners. The tick-cull radius already exists (`:76-82`).
- **Expected:** small (sub-ms) but cheap. **Effort S.**

### T10. Order draws for state locality and skip redundant binds
- **OpenAC:** `b5b01a89` sorts groups by (cull mode, detail category, translucency) and the encoder elides redundant binds: **CPU p50 7.2 -> 6.4 ms**. `9747be79` coalesces flush marks so ~246 ranges become ~47.
- **holtburger:** 71% of draws switch material, at 37.6 us fixed per draw (r²=0.014 vs instances), so the cost is state validation, not geometry. Set `renderOrder` and `groupOrder` by program/class key so three's opaque sort clusters programs. The structural form is a raw-WebGL2 statics pass with a tiny state cache (survey I5). **Effort S** for the ordering, **L** for a raw pass.

---

## 3. Not transferable (Vulkan / native-only)
- **Bindless textures** (descriptor indexing). Use array textures plus a per-instance layer instead; holtburger's class pages already do this.
- **Multi-draw *indirect* with GPU-resident commands, BaseInstance and transform SSBOs** (`WorldTransformFrameArena.cs`, 64 B matrices in a storage buffer). WebGL2 has no SSBO and no indirect draws, and `WEBGL_draw_instanced_base_vertex_base_instance` is not broadly shipped. Use `WEBGL_multi_draw` plus a matrix data texture plus `gl_DrawID`, which is what BatchedMesh does. **BaseVertex is also missing**, so OpenAC's single ushort-indexed global arena (`GlobalMeshBuffer.cs:57-68`) maps to uint32 absolute indices, or one arena per vertex format.
- **Explicit frame-in-flight retirement ledgers** (`GpuRetiredRangeAllocator`, retirement tickets). WebGL synchronizes implicitly. Only the *budgeting* part transfers (T4).
- **Memory-mapped pak plus 8 OS worker threads sharing memory.** Browsers would need COOP/COEP and wasm threads. The transferable form is per-asset bundles via HTTP ranges plus N workers with transferables, which the SPEC's W1/packs already provide.
- **Ahead-of-time SPIR-V** removing all runtime compiles. WebGL always links at runtime. The best available is a closed program set plus explicit prewarm (`shaderPrewarm`, `pool_prewarm.js`) and `KHR_parallel_shader_compile`.
- **GPU timestamp-driven auto quality** (render packs). Partly possible via `EXT_disjoint_timer_query_webgl2`, which holtburger already uses.

## 4. Caveats
- OpenAC's frame is ~4-7 ms of C# CPU. Holtburger's ~20-25 ms is dominated by three.js per-draw overhead (12.78 ms draw funnel). OpenAC's gains measure *relative* structure (what stops being O(instances) per frame), and absolute ms do not carry over.
- Holtburger's docs repeatedly warn that resident ≠ drawn ≠ submitted, and that draw-count cuts do not predict ms. T1, T2 and T3 attack per-instance and per-churn work, which the docs show is where the time is. T8 and T10 are the most likely to under-deliver.
- Several of these overlap DEV-flagged SPEC slices. The cheapest real gain may be finishing the gates (`?frameWork`, `?slotGrid`, `?drawPools`) with the OpenAC deltas folded in: run-selection culling (T1), asset-granular refcount (T3), fixed pages (T5) and byte-budgeted admission (T4).
