# Stage 2: the static world's residency, transforms and visibility in Rust (research lane R2, 2026-10-26)

Design and feasibility for stage 2 of `docs/2026-10-26-rust-scene-core.md`. No product code was written. Nothing
was compiled or run in a browser, and no git command was used. What did run: reading the code, and small read-only
Python passes over files already on disk:
- the three 1070 CPU profiles of 2026-10-23 (`/mnt/wbterminal1/tmp/claude-scratch/perf/gg-grass-gpu-2026-10-23/on-r{1,2,3}-run.cpuprofile`);
- the 1070 status dumps of 2026-10-25 (`.../perf/p0-gpu-resident-2026-10-25/{bare,chain}-status-*.json`);
- the laptop structure probes of 2026-10-23 (`/mnt/wbterminal1/tmp/gpu-resident/{cmp-after,head-bare-r2}.json`).

The method is in Appendix B.

Evidence tags: **[C]** code read (file:line, working tree on `rustcore-2026-10-26`), **[M]** measured (source
named), **[D]** derived (arithmetic or assumptions stated). R3's draw-list design
(`docs/2026-10-26-rust-draw-list-design.md`) was not on disk when this was written, so §2.8 proposes the interface
and R3 has to confirm or amend it.

---

## 0. Verdict

1. **Pools hold only a small part of today's static world.** The chunk batcher runs *before* the pool producer
   (`statics.js:3288` vs `:3345`). It takes every group of two or more nodes that share a material object
   (`static_batch_x.js:2987-2996`). The pools get only the leftovers.
   - At the first 1070 boot of the default-on chain, 238 of 1,343 offered nodes were pooled (1,105 refused,
     788 of them `bc7Pending`), in 76 pools [M chain-status-1.json].
   - On the laptop (Holtburg, ring 2), 3,292 instances sat in 178 chunk buckets [M cmp-after.json].
   - So "three.js holds only pooled draw objects" means merging four batch types (chunk buckets, pools, atlas
     buckets, building batches) and retiring the per-placement nodes. Finishing the pools alone would not get there.
2. **Moving residency buys almost no frame time.** Measured on the 1070 while running, residency costs about
   0.05 ms per frame in total: `tickEviction` 0.025, `tickPvsLoadExpansion` 0.011, park/unpark 0.008, `tickObjectRadius` ~0 [M, 3 profiles].
   Its value is elsewhere:
   - one owner for the bookkeeping;
   - no scans of the scene groups;
   - less heap and lower bake-time CPU;
   - it is the prerequisite for R3: a Rust draw list needs Rust-owned instance lists.
3. **The per-frame time stage 2 can remove at Holtburg is about 0.6–1.3 ms on the 1070 [D].**
   - The static world's share of the 2.39 ms scene walk is only ~0.3–0.5 ms. At Holtburg most of the scene's nodes
     are entity rigs, which belong to lane B: 66 % on the laptop census [M: 3,474 of 5,286], and ~52 % on the 1070
     if the entity count is the same there [D: 3,474 of 6,665].
   - The rest comes from the static-world JS outside the walk:
     - the BatchedMesh `onBeforeRender` family, 0.41 ms;
     - `syncBatchMatVariants`, 0.24 ms;
     - the billboard walk, 0.11 ms;
     - the cell-visibility JS, part of its 0.26 ms.
   - The statics cull walk (0.36 ms) is counted under lane C, not here.
   - Towns with heavy drizzle scenery are different. Linvak Tukal keeps 14,268 frozen script anchors in the scene
     graph [M `statics.js:5120-5133`], so the estimate there is ~1.3–2.6 ms [D].
   - The plan's 1.5–2 ms holds for Linvak-class towns, not Holtburg.
4. **"Same pixels" splits stage 2 in two.**
   - **2a (S1–S6)** moves ownership and leaves every placement in the draw object it uses today. It is pixel-identical
     by construction and provable on the laptop.
   - **2b (S7)** moves LOD wrappers and lone singletons into batched draw objects. It cannot be bit-identical: the
     vertex goes through an f32 `batchingMatrix` instead of a CPU f64 model-view, which moves vertices by about 1e-5 m
     once a pool is anchored at its sector origin. Today's world-origin chunk buckets already carry ~2 mm
     quantisation at 31 km [C `buildings.js:181-184`]. 2b therefore needs the owner's eye check, like every routing
     change before it.
5. **Recommended first step: S0 + S1.**
   - S0 is a per-group structural census plus an event recorder for parity fixtures.
   - S1 is three JS-only, pixel-identical changes:
     - (a) freeze static node matrices, as cells already do;
     - (b) take the frozen script anchors off the scene graph;
     - (c) size pools to their content.
   - Each needs only node tests and one SwiftShader smoke, and each carries its own `=off` escape.
   - S1c alone removes ~45 MB of empty pool vertex buffers, in both JS memory and the GPU [D], with no visible change.
6. **Heap: stage 2 saves about 50–70 MB at Holtburg [D]**, out of the ~350–450 MB by which the chain's heap
   exceeds the old stack's.
   - The pool vertex over-allocation is ~45 MB of that saving [D from the census].
   - The largest chain-only item is texture-side, outside stage 2: the pools' class pages, 196 MB allocated at the
     first 1070 chain boot [M chain-status `pools.classPages.pageBytes`]. The 10-26 `?nraSourceRes` fix targets
     most of that (`2026-10-25-pipeline-default-on.md` §10).
   - The BC7 record mirrors are not part of the gap: both arms carry them (181 MB bare, 130 MB chain [M
     `texStats.mirrors.bytes`]).
7. **Top risks.** Each is detailed in §5.
   - Two owners of residency during the migration: the dual-state history in `landblock_lru.js:870-945` and
     `:2409-2476` is the template for what breaks.
   - Coupling to three's BatchedMesh internals (`_multiDrawStarts`, `_indirectTexture`, `_instanceInfo`).
   - Lane overlap: statics.js with lane C, the anchors and emitter frames with lane A, animated scenery with lane D.
   - The measurement basis: the 10-23 profiles predate the chain going default-on on 10-25.

---

## 1. Today's static world, end to end

### 1.1 Producers, per landblock [C]

**Statics: `bakeStaticsForLandblock` (`statics.js:2706-3513`)**

1. **Placements.** `fetchLandblockObjectsShared` and `fetchAndDrainScenery` turn wasm records into plain JS records
   (`:2785-2810`).
   - Visual-ground z is baked into them (`:2818`).
   - Animated scenery is peeled off (`:2824-2830`), and so are wind trees (`:2843-2855`). Both are attached by their
     own paths (`:2886-2907`).
2. **Geometry.** `fetchPrimaryGeometries` (`:1118`). Under `?geomBundles` (default on) it calls
   `assembleGeomBundles`, which returns one JS buffer per call, and builds one `BufferGeometry` per (model, surface
   group) as views on it (`:1161-1190`). Degrade chains come from `fetchDegradedGeometries` (`:1563`), and the
   per-LB material preload runs alongside (`:2989-3014`).
3. **Nodes.** One `THREE.Mesh` per (placement × surface group), built by `buildSingletonNode` (`:1978-2154`, loop
   `:3106-3171`).
   - The mesh sits at the placement TRS: position `lbX·192 + x`, the full quaternion normalised (`:211-226`), and the
     uniform scale.
   - A model with a degrade chain gets a `THREE.LOD` wrapper plus one Mesh per band (`:2061-2153`).
   - The build is time-sliced at 6 ms (`:3080`, `:3163-3170`).
4. **Routing, in this order:**
   1. Chunk batcher: `consolidateStaticSingletonsCrossLb` (`:3288`, body `static_batch_x.js:2923-3154`). It takes
      every group of two or more nodes that share a material **object** into a `BatchedMesh` per (3×3-LB region,
      material). The bucket is created in `_getOrCreateBucket` (`:2580-2726`) and added to `staticsGroup` (`:2724`).
      Instance matrices are world-AC coordinates (`:3118`).
   2. Pools: `addSingletonsToPools` (`statics.js:3345`; `pool_producer.js:225-360`). They are offered the loners
      (groups of one) and the LOD wrappers the chunk batcher passed on (`static_batch_x.js:2935-2941`, `:2996`).
      They admit only plain single-material meshes with UVs, so LOD wrappers always pass through
      (`pool_producer.js:246-252`). The class registry admits or refuses each loner. A `bc7Pending` or `offPage`
      refusal is held for re-offer (`pool_producer.js:268-282`).
   3. Atlas: `addSingletonsToCrossLbAtlas` (`statics.js:3365-3408`).
   4. Whatever is left is attached as a node (`:3409`).
5. **Scripts.** `attachStaticDefaultScripts` (`:3415`) makes one `THREE.Group` anchor per scripted placement and adds
   it to `staticsGroup` (`:6090-6125`). The anchor is frozen and hidden (`:5143-5151`).
6. **Bookkeeping in the loader wrapper** (`index.js:4772-4831`):
   - LRU `track` with the per-LB disposables (`:4814-4821`);
   - the `?objRadius` late hide (`:4823`);
   - a full lights rescan over statics + buildings + cells + entities (`:4825`, `:4311-4341`).

**Buildings (`buildings.js`)**
- Each placement builds a tree: placement Group → hinge Group → Mesh.
- `_feedBuildingGroupsToAtlas` (`:468-541`) flattens it to world TRS: `updateMatrixWorld(true)`, then `decompose`
  (`:476-481`), then `matrixAutoUpdate = true` again.
- The pool pre-pass runs per LB (`:508-529`).
- `consolidateBuildingSurfaces` (`:305-447`) then makes one `BatchedMesh` per (LB, material, layer mask, shadow
  flags, attribute layout), anchored at the LB origin (`:358-367`).
- Loners stay as Meshes under `buildingsGroup`.

**Cells (`cells.js:1668` `buildEnvCellsForLandblock`)**
- Each cell is a container Group under `cellsGroup` on layer 1, holding fused surface meshes, cell static props,
  anchors and lights.
- The subtree's matrices are frozen (`FREEZE_STATIC_MATRIX` `:1450`, `_freezeCellSubtree` `:1460`).
- Visibility is a per-container diff against the wasm render set (`:3557-3584`).
- Envcell pooling (`pool_envcells.js`) pooled 0 surfaces at the measured Holtburg chain boot (`surfacesPooled 0`
  [M chain-status-1]).

**Terrain**
- One `BatchedMesh` plus hidden per-LB proxy meshes (`terrain_batch.js:1-81`).
- Out of scope for stage 2, except that residency drives its park/unpark/evict hooks (`landblock_lru.js:2104-2106`,
  `:2279-2281`, `:2493-2495`).

**Animated scenery (lane D)**
- One anchor Group per placement under `staticsGroup`, plus `InstancedMesh` buckets per (setup, part, surface)
  (`animated_scenery.js:879-886`, `:1103`).
- Eviction is found by an orphan-detecting reclaim (`:556-620`).

`bakeStaticsRing` (`statics.js:3573`) has no caller in `scene3d/` outside its own file [C: grep]. The boot rings
were retired on 2026-06-30 (`loop.js:3088-3092`), so it is dead weight a port should not carry.

### 1.2 Residency today [C]

- **The grid is the authority** (`?slotGrid`, default on since 10-25).
  - `SlotGrid` (`residency_grid.js:209-470`) manages 36 tile slots with the states
    EMPTY→FETCHING→STAGED→LIVE⇄PARKED, plus QUARANTINED. The legal transitions are at `:139-149`.
  - `GridResidencyAdapter` (`:583-1166`) translates grid events into the legacy per-LB machinery: `feeds.fireLb` →
    `loadTerrain/Statics/BuildingsForLandblock` (`index.js:7396-7415`), and `lru.parkLb` / `unparkLb` / `disposeLb`
    (`:7416-7427`).
  - `PressureLadder` (`residency_grid.js:476-558`) samples the heap and wasm sizes at 1 Hz.
  - Integrity counters: `shiftMismatches`, `slotDesyncs`, `pinLeaks` (`:302-337`, `:413-445`, `:941-954`).
- **The legacy LRU runs assert-only** (`landblock_lru.js:786-822`): it diffs its own would-be victims against the
  grid's claim and keeps the `gridLruDivergence` counter. Its **primitives** still do the work on every park, unpark
  and evict, and they operate on JS scene objects:
  - `park` (`:2221-2407`) scans `terrainGroup`, `buildingsGroup` and `staticsGroup` children by
    `userData.landblockId` (`_bucketGroupChildren` `:1694-1737`). It detaches what it finds, splices lights,
    filters registries, and hides the LB's instances in the chunk/atlas/terrain/pool batches through hooks.
  - `unpark` (`:2481-2575`) reverses that and rebuilds the static emitters from the stashed anchors.
  - `evict` (`:1777-2173`) disposes the disposables list (skipping `__cacheOwned`, `:1960-1980`), calls every
    excision hook, clears the baked marks, and purges the wasm collision.
- **Membership is kept in three separate places**, plus the BatchedMeshes' own per-instance state:
  - chunk buckets: `static_batch_x.js` `_lbMembership` (lbKey → [{bm, gid, iids}]) (`:2525`);
  - the atlas: its own `_lbMembership` and `_rsMembers` (`static_atlas.js:1177-1198`);
  - pools: membership records per (tile, pool) holding `instanceIds`, `gidRefs`, `gidByInstance`, `lbRanges`,
    `cellRanges`, `bands` and `hiddenCells` (`pool_registry.js:254-269`, `:916-919`).

### 1.3 What three does with each object, per frame [C three r184]

| Step | Where | Per node work |
|---|---|---|
| Matrix walk (`renderer.render` → `scene.updateMatrixWorld`) | patched by `skip_hidden_matrix.js:44-66` | A hidden node is marked stale and returns. Any other node composes if `matrixAutoUpdate` (the default for every static Mesh, LOD, chunk/atlas bucket and building batch: only pools, cells, anchors and animated scenery opt out, `pool_registry.js:501`, `cells.js:1460-1464`, `statics.js:5146-5147`, `animated_scenery.js:1050/1071/1106`). Then it multiplies by its parent, because the roots re-compose every frame and force their children. |
| `projectObject` (`three.module.js:17763-17880`) | every renderer.render | Visibility check, then layers test. A LOD calls `update(camera)` (`three.core.js:22020-22068`). A Mesh or BatchedMesh gets the frustum test (`intersectsObject`, a sphere copy plus `applyMatrix4`), `objects.update` (WeakMap lookups; an InstancedMesh with a dirty matrix also uploads it, `three.module.js:4698-4740`), and a push onto the render list. Children are always recursed. |
| Sort | `programSortStable` (`draw_sort_program.js:83`) + three | O(list) |
| `renderObject` → `onBeforeRender` | BatchedMesh `three.core.js:27214-27368` | Early-out if `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects` (`:27218`). Otherwise a full walk of `_instanceInfo`: per-instance sphere × matrix, frustum test, an optional sort, and a rewrite of `_multiDrawStarts/_multiDrawCounts/_indirectTexture` (sorted branch `:27266-27328`, unsorted `:27329-27362`). Wrapped by `runPerCamera` (`batched_indirect_per_camera.js:156-237`), by the memo overrides for the sorted chunk buckets (`static_batch_x.js:1633-1789`), and by the L1 epoch hook (`batched_runs.js:881-924`). |
| `renderBufferDirect` | wrappers `async_link_guard.js`, `batched_runs.js:779-828`, `skip_empty_multidraw.js` | Run regrouping per BatchedMesh draw (`_prepare` `:623-713`), then three's draw. |

Three also re-runs `onBeforeShadow` → `onBeforeRender` for every shadow camera (`three.core.js:27370-27374`).
`projectObject` runs before `shadowMap.render` within one `render()` (`three.module.js:17613` vs `:17638`), so the
shadow pass sees the same frame's LOD levels.

### 1.4 Counts [M]

**Scene size**

| Source | Nodes | Meshes | BatchedMesh calls / ranges asked / issued |
|---|---|---|---|
| 1070, Holtburg, ultra, **bare** (old stack), 10-25 | 6,665 | 3,641 | 192 / 6,693 / 1,003 |
| 1070, Holtburg, ultra, **chain** first boot (before the `?objRadius` fix: LRU 144 entries vs 121) | 7,621 | 3,808 | 256 / 7,677 / 1,129 |
| Laptop, Holtburg, ultra, ring 2, old stack, 10-23 | 5,286 | 3,153 | 128 / 1,523 / 267 |

Sources: [M `p0-gpu-resident-2026-10-25/{bare,chain}-status-1.json` `.renderDiag`], [M `cmp-after.json`].

**Nodes per world group (laptop, ring 2, old stack)**

| Town | statics | buildings | cells | terrain | entities |
|---|---|---|---|---|---|
| Holtburg | 543 | 86 | 932 | 27 | **3,474** |
| Linvak Tukal | **6,345** | 113 | 1,501 | 52 | 959 |

Sources: [M `cmp-after.json`, `head-bare-r2.json` `.census.scene.groups`]

**Batch populations**

| Kind | Holtburg (laptop r2) nodes / instances / geometries | Linvak (laptop r2) | Other |
|---|---|---|---|
| Chunk buckets | 178 / 3,292 / 498 (10 sorted, 256 sorted instances) | 223 / 10,292 / 756 | 1070 mid 10-06: 348 Holtburg buckets of 3-14 instances each, 182 MB allocated before init sizing (`PERF-LOG-1070-2026-10-06.md:205`); Holtburg 07-15: 17,774 batched instances over 324 distinct geometries (`statics.js:2465-2467`) |
| Building batches | 12 / 49 / 45 | 28 / 253 / 249 | |
| Atlas buckets | 19 / 44 / 31 | 22 / 67 / 67 | 1070 chain: 21 buckets, 80 live instances [M chain-status texStats.arrays] |
| Pools | — (old stack) | — | 1070 chain: 76 pools, 18 classes, 238 pooled, `allocatedBytes` 34,865,152 vs `usedBytes` 287,466 |
| Script anchors (frozen, hidden) | not split out | most of the 6,345 statics nodes | 1070 Linvak 9×9 object ring: **14,268** (`statics.js:5123`); ~14k `staticsGroup` children (`landblock_lru.js:56-60`) |
| Statics children, 1070 | | | ~1,700 at LB 0xE632 (`statics.js:4674`); singleton statics draws 55/frame at 1.27 ms (`/mnt/wbterminal1/tmp/fps-agent/census1.json` 10-17) |
| Hidden nodes, 1070 Holtburg | | | ~2,000-2,500 of ~7,800 (`skip_hidden_matrix.js:5-7`) |

Holtburg draws per frame by owner (laptop r2) [M `cmp-after.json`]:

| Owner | Calls | Ranges |
|---|---|---|
| Entities | 626 | 626 |
| Cells | 494 | 494 |
| Statics | 176 | 1,539 |
| Occlusion proxies | 60 | 60 |
| Buildings | 36 | 58 |

### 1.5 What it costs per frame (1070, ultra, running, 2026-10-23, old stack) [M]

Three profiles, frames = profile seconds × run fps (Appendix B). Mean of runs r1/r2/r3.

| Term | ms/frame | Notes |
|---|---|---|
| Busy main thread | 20.57 (21.56 / 19.37 / 20.79) | reproduces the plan's 20.6 |
| Matrix walk | 0.78 | inside the walk, r1: patched visit 0.39, `multiplyMatrices` 0.22, `updateMatrix` (compose) 0.18 |
| `projectObject` | 1.29 | self 0.66; r1: `WebGLObjects.update` 0.21, instanced-attribute `bufferSubData` 0.21 (particle / animated buckets, not the static world); `intersectsObject` 0.12-0.15 |
| Render-list sort | 0.32 | `programSortStable` 0.19 + three 0.15 |
| BatchedMesh `onBeforeRender` family | 0.41 | three + memo + per-camera + L1 hook; every BatchedMesh is a static-world object (or the terrain batch) |
| `batched_runs` draw wrapper (self) | 0.30 | per draw; R3's |
| `async_link_guard` draw wrapper (self) | 0.25 | per draw; R3's |
| `syncBatchMatVariants` | 0.24 | `batched_material_variant.js:109-125` |
| `cullStaticsGroup` | 0.36 | lane C |
| Billboard walk (`_bbLoop`) | 0.11 | |
| `tickCellVisibility3D` | 0.26 | aperture gate 0.065 inside |
| `tickStatBatchXOptimize` | 0.05 | 10 Hz, bucket iteration |
| Residency (eviction, PVS ring, park/unpark, objRadius) | ~0.05 | `tickEviction` 0.025 |
| Envcell builds while running | 0.04 | |
| `tickShadowReceiveGate` | 0.000 | early-returns on this configuration (`loop.js:2691-2697`) |

**Static-world share of the 2.39 ms scene walk at Holtburg [D]: about 0.3–0.5 ms.**

- Visited static nodes are roughly:
  - 300–450 chunk buckets (from the ring-2 count of 178, at the 81-LB object ring);
  - ~100 building, atlas and pool nodes;
  - ~100–300 visible singletons and LOD nodes;
  - ~200–400 nodes of visible cell containers.
- That is ~800–1,200 nodes at ~0.25–0.4 µs each. The per-node figure is derived from the profile leaves: about 126 ns
  of `projectObject` self time per visited node, plus a frustum test and `objects.update`, plus ~180 ns of
  compose + multiply + visit in the matrix walk for a non-frozen node.
- On top come ~1,500–2,500 hidden-node checks at ~40 ns each.
- The remaining ~1.9 ms is entity rigs (lane B).
- At Linvak, the 14,268 anchors add ~0.7–1.3 ms on their own: 14k × 50–90 ns over the two walks plus the cull-walk
  iteration.

### 1.6 Premises that did not hold

| Claim | Where | What is true |
|---|---|---|
| Under pools, statics singletons become pool members and the per-placement nodes go away | pass-07 D-07.1 | Pools get only the chunk batcher's loners and LOD wrappers (§0.1) [C, M]. |
| The scene walk is 2.54 ms | plan §1 | Reproduced at 2.39 ms (matrix walk 0.78 + `projectObject` 1.29 + sort 0.32) on the same profiles, but those are the **old stack**. The URL had no chain flags, and `PIPELINE_DEFAULT_ON` flipped on 10-25 (`pipeline_flags.js:27`). The chain adds 76 pool nodes. Re-profile on the chain. |
| `POOL_VERTEX_BYTES = 24` (M6 `allocatedBytes`) | `pool_registry.js:235-237` | A pool vertex is 12 (position) + 12 (normal) + 8 (uv) + 4 (aLayer) = 36 B, or +3 with baked light (`pool_material.js:681-704`). The 34.9 MB reported is ~49.8 MB of typed arrays (76 × 655,360 B) [D]. |
| The grid must stay in JS because every event crosses outward to JS subscribers | pass-06 D-06.2 | True while pool membership and item visibility live in JS. After S4–S6 the main subscribers are Rust-side, and the PackStore pins are already Rust (`index.js:7385-7390`). The other half stands: the grid costs ~0 per frame [M]. |
| Stage 2 saves 1.5–2 ms | plan §2 table | ~0.6–1.3 ms at Holtburg, ~1.3–2.6 ms at Linvak [D] (§5). |
| The per-LB baker emits ~5 statics per LB | `statics.js:2403-2409`, `:3024-3031` header comments | Stale: a town LB carries hundreds of placements, and the consolidators turn them into buckets. |
| Animated scenery is InstancedMesh buckets | HANDOFF-gpu-resident §4 | True, but each placement also owns an anchor Group under `staticsGroup` (`animated_scenery.js:879-886`, `:1103`): a node population the census must count. |
| The shadow-receive gate walk is a cost | pass-07 D-07.6 | 0.000 ms/frame on the 1070 ultra default [M]. |

---

## 2. The Rust world model

### 2.1 Principles

- **A data move, not a code move** (plan §2). Rust owns the records and the decisions; JS owns the three.js objects
  and executes batched commands.
- **No call per object per frame.** There is one per-frame call (`SceneWorld.frame`), plus event calls when
  residency, routing or hides change. Each event call returns a command list that JS executes in one loop.
- **One refcount discipline, entirely inside Rust** (pass-06 D-06.7). JS never holds a Rust refcount. Rust never
  disposes a JS object; it emits a command naming one.
- **2a never changes which draw object a placement uses**, nor the bytes written into it. Routing rules stay
  bit-for-bit today's (§2.4). Only S7 consolidates.
- **Pure kernel:** `crates/holtburger-scene/src/world/`, with no I/O and no clocks (time comes in as an argument).
  The glue is `apps/holtburger-web/src/scene_wasm/world.rs`. It may read the pack source and DAT placements inside
  the same wasm instance, which removes the per-placement wasm-bindgen getters that `drainPlacements` pays today. The
  bridge is `scene3d/rust/world.js`.

### 2.2 What Rust owns

Structure-of-arrays tables with u32 handles. Sizes are per entry [D].

| Table | Fields | Bytes | Notes |
|---|---|---|---|
| **Placement** | lbKey, cellId (0 outdoor), source kind (stab / scenery / building / cell-static), modelId, pos f64×3 (= `lbX·192 + x` exactly as `statics.js:1930-1934`), quat f64×4 (`set(qx,qy,qz,qw).normalize()`, `:211-226`), scale f64, defaultScriptId, defaultAnimId, flags (lights, scripted, animated, wind, building) | ~96 | Ingested at bake from the same records `fetch_landblock_objects` and scenery produce today |
| **DrawItem** (placement × part × surface group) | placement, route (draw object, or NODE), gid per band (≤ 4), band distances + degrade mode per band (index into a per-model chain table), slot (instance id in the draw object), instance matrix f32×16 (the exact value `setMatrixAt` stores today), local sphere per band, visibility bits | ~130 | Holtburg ring 5 ≈ 15–20k items, Linvak ≈ 35k [D from §1.4] → 2–5 MB |
| **Visibility bits** (u32 per item) | LIVE / PARKED (tile), OBJR (per-LB sticky `?objRadius`), FILM, CELL (per-cell PVS), PENDING (born invisible until the feed commits), DEAD (draw object renders nothing), FRUSTUM (node routes only), ANCHOR (never drawn) | 4 | Effective visible = no hide bit set: a pure function, so no ordering between owners |
| **DrawObject** | JS handle, kind (chunk / pool / atlas / building / node / anchor), sorted?, layer mask, shadow flags, anchor origin f64×3, gid table (gid → start, count, local sphere; refreshed by JS after add/delete/optimize), slot → item map, refcount per gid, dead extent, list epoch, node sphere | ~200 + 12 per slot | Mirrors what three holds, so lists and spheres are computed in Rust |
| **Geometry ref** | (draw object, content key) → gid, refcount | 16 | Content key = exact bake identity (modelId, group index, sides, relief variant) under bundles. The runtime-decode residue keeps JS's byte hash |
| **LB / tile residency** | tile state + timers (sinceMs, parkedAtMs), pins, per-LB baked kinds, bake epoch, exclusive bytes (from the refcounts), sealed core membership | ~64 per LB | Port of `residency_grid.js`. The UseTime floor, ≤ 1 tile per tick, and never-shed rules are kept verbatim |
| **Anchor** (scripted placement) | exact frozen world matrix f64×16, scriptId, epoch, part frames ref | ~160 | Today a hidden Group per placement (§1.4) |
| **Light list** | per light-owning placement: light descriptor index (JS owns the `THREE.Light` carrier) | 8 | Removes the scene rescan (`index.js:4311-4341`) |

### 2.3 What JS keeps

- **Materials and textures**: `MaterialCache`, class materials, the class pages, BC7 and texture upgrades, the
  variants, and the `UploadStager`.
- **Geometry bytes.** The bundle buffer and the `BatchedMesh` vertex and index arrays stay in JS. `addGeometry`
  copies from bundle views on Rust's command.
- **The draw objects**: every `BatchedMesh` and `InstancedMesh`, plus the residue that remains a node:
  - light carriers;
  - env-detail shells (`buildings.js:487-499`);
  - ShaderMaterial members;
  - wireframe;
  - everything 2a does not move.
- **Unchanged JS-side systems**: the terrain batch, entities, particles, the cell containers (as objects),
  group-level visibility (the sealed cull, `cells.js:3440-3460`), and the stream bake guard as the bake executor.

### 2.4 Routing: who decides which draw object

The route of a (model, surface group) depends on the **resolved JS material**:
- the member object for chunk buckets (`static_batch_x.js:2936`);
- the class key from the material for pools (`pool_producer.js:410-436`);
- BC7 pending and page state for holdouts (`:277-280`);
- `_shouldSortBucket`, `materialCanCastShadow` and dead-batch.

Resolving that off-thread is exactly what pass-07 D-07.5 wanted and T22 declined, because it would reproduce
`materials.js`'s ladder with silent divergence as the failure mode (`pool_producer.js:27-43`). So routing stays in JS:

- On bake, JS resolves each (model, surface) to a route and passes Rust a compact route table:
  - `(modelId, groupIndex) → {kind, materialId, classKey?}`.
- Rust applies the spatial half of the key: the 3×3-LB region for chunk buckets (`_regionKeyOfId`
  `static_batch_x.js:2561`), the 768 m sector for pools (`pool_class_key.js`), and the LB for building batches.
- Rust emits `CREATE_OBJECT` when a (spatial, route) pair has no draw object yet. JS creates the `BatchedMesh` exactly
  as today: same constructor arguments, same flags, same `markBatchedRuns` and `applyStaticEarlyOut`.
- The ≥ 2-per-material rule of the chunk batcher is a per-LB-feed property (`static_batch_x.js:2996`). Rust evaluates
  it on the same per-LB grouping, so the same nodes land in the same buckets.

### 2.5 The residency state machine in Rust (S5)

- **A straight port** of `SlotGrid`, `GridResidencyAdapter` and `PressureLadder` (`residency_grid.js`): the same
  states, transition table, anchor function, hysteresis (2 s), park budgets (40 tiles / 128 MiB), floors (30 s, R4
  lowers to 5 s, never 0), teleport drain (250 ms first burst, 6 ms after) and sealed freeze with its pinned core.
  - Time and the heap/wasm samples come in as arguments.
  - The drains take a JS-supplied deadline. JS calls `drainStep()` once per tile until the deadline: per event, not
    per object.
- **Output is a command list**, executed by JS in one loop:
  - FETCH(tile) to the pack controller;
  - FEED(lb, kinds);
  - PARK / UNPARK / RELEASE(lb);
  - per-kind follow-ups:
    - static items: visibility-bit changes only, with nothing to detach;
    - node routes: detach/attach lists;
    - terrain hooks;
    - static particle teardown and rebuild;
    - light splice, detach and re-register;
    - wasm collision purge and per-LB world caches. These are Rust-internal: same instance, no JS hop.
- **"Warm park" is a bit.** PARKED → LIVE flips bits and emits node re-attach commands: no fetch, no decode, no
  upload, as today.
- **Release** (PARKED → EMPTY) emits `deleteInstance` / `deleteGeometry` at refcount zero, plus `optimize` past 30 %
  dead extent (the `pool_registry.js:990-1043` rule, applied to every kind), plus reaping of empty draw objects.
  - Per-LB "exclusive bytes" come from the refcounts, which is better than the LRU's per-LB geometry estimate
    (`landblock_lru.js:2181-2213`).
- **Integrity counters ported and asserted 0 in cargo tests**: `shiftMismatches`, `slotDesyncs`, `pinLeaks`,
  `gridLruDivergence`. Rust has no second LB container, so dual state cannot be represented.

### 2.6 The per-frame kernel

`SceneWorld.frame()` reads one input block and writes one output header (§2.7).

1. **Node routes**: the frustum and visibility decision for every node route (singleton Mesh, LOD wrapper, building
   loner, cell container), merged with the hide bits.
   - This is lane C's kernel, applied to records instead of `staticsGroup.children`: the same AC-space frustum and
     the same cull spheres (`statics.js:4524-4622`).
   - It keeps the exemptions: light owners (`:4811-4816`), anchors, particles and animated buckets (`:4755-4763`).
   - Output: a flip list.
2. **Billboards**: for every LOD node whose degraded leaf is showing, the leaf quaternion and position, computed with
   `_orientBillboardLeaf`'s exact arithmetic (`statics.js:4270-4325`: atan2, then the Euler → quaternion).
   - Run only when the camera pose changed, using the same gate as `staticsBillboardTickDue` (`:4920-4950`).
   - In 2a, THREE.LOD keeps choosing the level itself, because `projectObject` calls `LOD.update`. Rust reads which
     level was active from the previous frame, as the JS walk does today (`:4356-4368`).
3. **Lists** (S4): for each draw object whose epoch moved:
   - the active list: visible ∧ active slots in ascending slot order, which is exactly three's unsorted rebuild order
     (`three.core.js:27329-27362`);
   - the run layout, with exact `buildRuns` semantics (`batched_runs.js:371-416`): runs in first-seen order, ids in
   canonical order within a run.
   - Sorted (translucent) objects stay on three's path until S8.
4. **Node spheres** for objects whose membership changed, in three's `computeBoundingSphere` order (union over active
   instances, ascending).
5. **LOD bands** (S7 only): `THREE.LOD.update` reproduced exactly (`three.core.js:22020-22068`): distance from the
   colour camera's `matrixWorld` translation, divided by `zoom`, with per-level hysteresis. Only for items drawn this
   frame, as three only updates visited LODs.

A settled frame does one call, reads one header, finds every length 0, and returns.

### 2.7 What crosses the boundary each frame

| Direction | Content | Layout | Size, settled | Size, moving at Holtburg [D] |
|---|---|---|---|---|
| JS → Rust (input block, fixed pointer) | colour camera `matrixWorld` and `projectionMatrix` (f64×32), `zoom`, coordinate system and reversed-depth flags, player AC position, player LB set (≤ 4), wall time, flag mask; CSM camera matrices only from S8 | `Float64Array` view, ~45 f64 | 360 B | 360 B |
| JS → Rust (when changed) | cell render set (u32 ids) | `Uint32Array` | 0 | 10–200 ids on a PVS change |
| Rust → JS (output header) | pointer and length of each list below + flags | `Uint32Array` 16 words | 64 B | 64 B |
| Rust → JS: node flips | (nodeIndex, visible) | `Uint32Array` pairs | 0 | 10–100 per frame while turning (frustum crossings) |
| Rust → JS: billboard leaves | (nodeIndex, qx, qy, qz, qw, px, py, pz) | `Float32Array` stride 8 | 0 | count unknown (census owed); ≤ 500 × 32 B ≈ 16 KB when the camera moves |
| Rust → JS: dirty lists (S4) | per object: header (handle, n, R, offsets) + starts i32[n] + counts i32[n] + ids u32[n] + layout u32[1+R+n] + run arrays i32[3R] | one `Int32Array` / `Uint32Array` arena | 0 | event-driven: a park/unpark or band swap rewrites the affected objects, e.g. a 2k-instance pool ≈ 40 KB, a few per second while crossing tiles |
| Rust → JS: instance flag sync (S4) | (object, slot, visible), so `_instanceInfo[slot].visible` stays true for raycast and film (`three.core.js:27100-27104`) | `Uint32Array` triples | 0 | same events |

JS must copy a view before the next wasm call, and re-fetch views after any call that can grow memory
(`scene3d/rust/scene_core.js:16-21`). All per-frame pointers and lengths come back in one header, so the frame costs
one wasm call and not one getter call per buffer.

### 2.8 Feeding R3's draw list (stage 3), proposed interface

For an opaque draw object, the S4 list **is** the draw-list input, and it does not depend on the camera: per-instance
frustum culling is off, as under `?staticEarlyOut` and the pools. What R3 needs from stage 2, per frame:

**`StaticDrawFrame`** (Rust-owned, one per frame)
- `objects[]`, one entry per draw object:
  - handle (to find three's program and material) and epoch;
  - kind, sorted flag, layer mask, castShadow/receiveShadow;
  - world node sphere (f32×4);
  - offsets into the arenas: `list` (n), `runs` (R), `layout` (1 + R + n).
- `cameras[]`: colour, then each CSM cascade, each with a visibility bitset over `objects`. Node-level frustum only,
  which is today's node culling.
- **Arenas**, in exactly the layout `batched_runs.js` builds per draw:
  - starts i32, counts i32, ids u32;
  - run starts / counts / instance counts;
  - the indirect layout `[0xFFFFFFFF, runStart_0..R-1, ids…]` (`batched_runs.js:21-38`, `:371-416`).
- **Matrices**: Rust owns the f32 rows, and the dirty row ranges are reported. R3's executor can then upload changed
  rows (`texSubImage2D` from a wasm view) instead of the whole `_matricesTexture` that three re-sends on any
  `setMatrixAt`.
- **Sorted objects** (S8): per-camera back-to-front lists with three's exact `sortTransparent` semantics:
  - z = (sphereCentre − camLocal)·forwardLocal, with the camera transformed into the object's local frame
    (`three.core.js:27266-27310`);
  - a stable sort on ties.
  - These become consecutive runs (`buildConsecutiveRuns`, `batched_runs.js:429-467`).

Stage 2's three adapter (S4) and R3's executor read the same arrays. The adapter writes them into three's
`BatchedMesh` fields; the executor issues `multiDrawElementsInstancedWEBGL` itself. ANGLE therefore sees the same
(range, id) multiset either way, and `issuedSubDraws` must not change between the two.

---

## 3. Invariants a port must keep

| # | Invariant | Where it lives today [C] | How the Rust model keeps it |
|---|---|---|---|
| 1 | **Dispose ownership / `__cacheOwned`**: shared materials, geometries and textures are never disposed per LB | `landblock_lru.js:1960-1980` (evict skips cache-owned), `:2460-2470` (stale pool copy); `buildings.js:626-670` (both-flags assert); `statics.js:3453-3465` (per-LB geometry list) | Residency commands name only draw-object slots and gids, per-feed temporaries, and lights; never a material. Refcounts are Rust-internal. Test: no evict command ever names a material. |
| 2 | **An LB is in `entries` XOR `parkPool`**; a late `track` merges into the parked copy | `landblock_lru.js:912-962`, `:2221-2236`, `:2409-2476` | One LB state field. A feed landing for a PARKED LB is born PARKED (the pool commit-into-parked rule, `pool_registry.js:762-829`). Replay the TN-storm sequences from S0 fixtures. |
| 3 | **In-flight bakes vs park/evict**: evicted-during-build bails; a vacated plan goes to passthrough; abandon | `landblock_lru.js:870-889`; `statics.js:3239-3274`, `:3318-3332`; `pool_producer.js:338-350`, `:772-792`; `pool_registry.js:830-847` | A per-LB bake epoch. Ingest with a stale epoch is refused and JS keeps the legacy route for that bake. |
| 4 | **Re-feed idempotence**: a re-bake replaces the LB's contribution | `static_batch_x.js:2957-2966`; `pool_registry.js:785-819` | `ingest_lb` on a present LB diffs and replaces. |
| 5 | **LIVE flip last**, after textures stage | `pool_registry.js:716-728`, `:767-829`; `pool_stream.js:34-40` | The PENDING bit clears only on JS's "committed" (after the UploadStager reports staged). |
| 6 | **`?objRadius` hides are sticky**, survive park/unpark and adopt, and the cell PVS cannot override them | `object_radius.js:102-200` (`_hide` 124, `_show` 138, `afterUnpark` 203); `pool_registry.js:1045-1108`, `_lbHides` at `:775/:961/:1133/:1203` | An independent per-LB OBJR bit; visibility is an AND, so no precedence code is needed. Replay the object_radius suite. |
| 7 | **Park is GPU-free; unpark is a pointer re-adopt**; terrain-batch ghost fix | `landblock_lru.js:2221-2407`, `:2481-2575`; `static_batch_x.js:3244-3285`; `static_atlas.js:2570-2603`; `terrain_batch.js:53-81` | PARKED bit; node detach/attach commands; the terrain hooks are called exactly as today. |
| 8 | **Floors never zero**, pressure ≤ 1 tile per tick, never shed the player's 3×3 or the sealed core, teleport drain | `residency_grid.js:93-127`, `:976-992`, `:996-1057`, `:1087-1127` | Ported; cargo tests pin it. |
| 9 | **Integrity counters stay 0**: `shiftMismatches`, `slotDesyncs`, `pinLeaks`, `gridLruDivergence` | `residency_grid.js:302-337`, `:413-445`, `:941-954`; `landblock_lru.js:786-822` | Same counters; CI asserts 0. |
| 10 | **BC7 `bc7Pending` / `offPage` holdouts**, re-offer on settle, retire after a post-settle refusal | `pool_producer.js:268-282`, `:453-493`, `:813-894`; `bc7_textures.js:346-360`, `:2162`, `:2417`; `static_atlas.js:1198` | JS keeps the decision (material state). Rust keeps the holdout ledger by rsId and executes a re-route as an item move (delete A / add B) in one batch. A holdout whose LB left is dropped by LB state, replacing the `!h.node.parent` test (`pool_producer.js:842-846`). |
| 11 | **Pool page uploads move the texture version**; nra pages at source resolution | `2026-10-25-pipeline-default-on.md` §9-10; `pool_material.js:333` `refeedRsId` | Texture-side, unchanged (JS). |
| 12 | **The texture-upgrade queue's visibility index** walks `staticsGroup` / `buildingsGroup` | `tex_upgrade_queue.js:255-520` | It keeps working on whatever nodes remain. From S6, Rust can answer "nearest visible holder per rsId" from item tables (an optional replacement). |
| 13 | **Sealed-dungeon collapse**: hide the outdoor groups, purge residency, skip sealed bakes | `cells.js:3440-3475`; `statics.js:5105-5117`, `index.js:4782-4784`; `residency_grid.js:996-1057`; `landblock_lru.js:91-264` | The group flips stay JS. Freeze, pins and drain move to Rust (S5). |
| 14 | **Film-mode hides**, restored exactly; static fade targets | `film/runtime/take_player.js:2190-2345`; `film/scene/world_query.js:1580-1625`; `statics.js:4790-4804`, `:4704` | A FILM bit per item. Restore clears only that bit: other owners' bits are independent, so the setVisibleAt watch becomes unnecessary. Fade targets become a Rust query by placement. |
| 15 | **Light ownership**: lights parented to a static mesh or part group; never cull a light owner; LRU splice / detach / dispose / re-register | `lighting.js:3523-3544`, `:3753`, `:3767` (pool carriers invisible), `:3280`; `statics.js:4636-4652`, `:4811-4816`; `landblock_lru.js:1929-1958`, `:2330-2354`, `:2508-2517`; `index.js:4311-4341` | Light owners stay node routes in 2a (or a frozen invisible carrier Object3D from S7). Rust supplies per-LB light lists, so no rescan, and the light commands come with residency commands. |
| 16 | **Frozen anchors and emitter frames**: a null parent makes RP6 fail open; the frozen fast path; part frames | `statics.js:5134-5151`, `:5279-5300`, `:6090-6125`; `particles/particle_manager.js:1640-1700`; `landblock_lru.js:2539-2555` | S1b keeps a non-null parent and exact matrices (§4). Later, anchors are records with exact f64 frozen matrices. |
| 17 | **Dead batches** never draw; re-derived on the optimize tick | `static_batch_x.js:354`; `statics.js:4783-4788` | A DEAD flag per draw object (JS re-derives it and tells Rust). |
| 18 | **RP6 is the single writer of particle visibility** | `statics.js:4739-4756` | Particles are not world items; Rust never flips them. |
| 19 | **Animated-scenery bucket visibility** is lane D's | `statics.js:4760-4763`; `animated_scenery.js:556-620` | Animated placements are records, sent as per-LB add/remove events to lane D's kernel. |
| 20 | **A BatchedMesh node sphere is cached once and never cleared by three** | `pool_registry.js:580-631`; `static_batch_x.js:882-893` | Rust computes the sphere in three's order and JS sets `bm.boundingSphere` on membership change. |
| 21 | **`setGeometryIdAt` does not raise `_visibilityChanged`** | `pool_registry.js:1321-1329` | Rust owns the list, so the flag is not relied on. |
| 22 | **`three_batchedmesh_colortexture_fix`** applied at pool scale | `pool_registry.js:106-113`, `:435-459` | Unchanged. |
| 23 | **Indoor layers**: envcell pools on layer 1; split re-layering of top-level nodes | `pool_registry.js:404-433`; `cells.js:593-669` | Draw objects carry the layer; unchanged. |
| 24 | **Shadow flags** per bucket (template), per pool (class axis), per singleton; the receive gate | `static_batch_x.js:2648-2651`; `pool_registry.js:508-513`; `statics.js:2039-2050`; `loop.js:2685-2797` | Unchanged in 2a. |
| 25 | **Variant RULE**: never write `bm.material`; holders | `batched_material_variant.js:18-23`, `:62-76`, `:109-125` | Rust never touches materials. S7 retires a variant only where no plain draw shares its member. |
| 26 | **L1 list-writer contract**: every writer of `_multiDrawStarts/_multiDrawCounts/_multiDrawCount/_indirectTexture` is on the list | `batched_runs.js:113-162`, `:938-962` | The S4 adapter is a new writer. It either cooperates (`markBatchedRunsOwnHook` + `reportBatchedRunsList`) or hands batched_runs a Rust run state through a new external-runs API, so `_prepare` never compares. |
| 27 | **`bmIndirectPerCamera` passes camera-independent buckets through** | `batched_indirect_per_camera.js:38-45`, `:156-160` | S4 lists are camera-independent, so this holds. |
| 28 | **`skipEmptyMultiDraw` keys on `_multiDrawCount === 0`** | `skip_empty_multidraw.js:20-24` | S4 writes it, so this holds. |
| 29 | **Raycast, film and decals read `_instanceInfo[i].visible` and `getMatrixAt`** | `three.core.js:27078-27118`; `take_player.js:2218-2230`; `world_query.js:1583-1605` | S4 keeps three's per-instance flags in sync on events (§2.7). |
| 30 | **THREE.LOD semantics and billboards** | `three.core.js:22020-22068`; `three.module.js:17613`/`:17638`; `statics.js:4264-4378`, `:4893-4950` | 2a leaves LOD to three. S7 reproduces it exactly (distance / zoom, hysteresis, same-frame shadows). |
| 31 | **Exact world matrices**: placement compose; building flatten `decompose` → compose; anchor `updateWorldMatrix(true, true)`; LB-origin anchoring | `statics.js:1923-1950`, `:2018-2030`, `:211-226`; `buildings.js:476-481`, `:358-367`; `statics.js:5143-5151` | `math.rs` mirrors three operation for operation; parity tests on the f32 store. |
| 32 | **`skipHiddenMatrix` stale-on-hidden rule** and direct `matrixWorld` readers | `skip_hidden_matrix.js:12-26` | Frozen static matrices (S1a) remove the hazard class for statics. |
| 33 | **Closed class set**: `classesCreatedPostBoot = 0` | `pool_registry.js:343-348`, `:461-482`; `index.js:7612-7636` | Unchanged. S7 must keep it at 0. |
| 34 | **Optimize at dead extent > 30 %; reap empty objects** | `pool_registry.js:633-642`, `:1018-1043`; `static_batch_x.js:3287`; `static_atlas.js:2652` | Rust tracks the dead extent. JS runs `optimize` on command and reports the new (start, count) table. |
| 35 | **`?nullRender` / `?renderOnDemand`**: never depend on a render having happened | `loop.js:3036-3054` | The kernel takes time and camera as arguments, never three's state. |
| 36 | **The stream bake guard is a skip-cap semaphore**; STAGED re-fire | `stream_bake_guard.js:159-216`; `residency_grid.js:827-867` | The JS guard stays the bake executor. S5's FEED commands keep the 250 ms re-fire. |
| 37 | **Context loss** | `2026-10-25-pipeline-default-on.md` §6 | The vertex and matrix arrays stay JS-side, so three re-uploads them. Rust lists are unaffected. |

---

## 4. Incremental path

**Flags**
- JS prep steps use the house grammar: an `=off` escape, default OFF while in development.
- Rust steps use `rustFlag()` under a cascade: `?rustWorld` → `rustWorldVis` → `rustWorldLists` →
  `rustWorldResidency` → `rustWorldBake`, with `rustWorldPools` for S7. Each step needs its predecessor, like
  `pipeline_flags.js`. Every Rust step keeps the JS path intact (plan §3).

**Ownership**
- Proposed lane W owns `crates/holtburger-scene/src/world/*`, `src/scene_wasm/world.rs`, `scene3d/rust/world.js`,
  `tools/rust_parity/gen_world*.mjs` and `tests/rust_world_*.test.mjs`.
- `pool_*.js`, `residency_grid.js`, `landblock_lru.js`, `static_batch_x.js`, `static_atlas.js` and `buildings.js` are
  claimed by no lane today, so the orchestrator assigns them.
- `statics.js` changes go through lane C, `particles/*` through lane A, `animated_scenery.js` through lane D.

**Expected gains**: ms are at Holtburg on the 1070 at ultra, Linvak in brackets, all [D].

**S0 — census and recorder** (no behaviour change)
- What:
  - A per-group structural census: extend `frameSplitCensus` (`frame_split.js:1579-1700`) to report per
    world-group root the resident, visited and composing nodes, LODs (and billboard-tagged LODs), anchors, singleton
    meshes, and batch objects / instances per kind.
  - A JS event recorder for grid events, park/unpark/evict, objRadius, film, cell PVS deltas, and bucket/pool
    add/delete with matrices. It feeds `tools/rust_parity/gen_world.mjs`, which drives the real `residency_grid.js`,
    `pool_registry.js`, `object_radius.js` and the chunk feed in node, with three headless as `test_draw_pools.mjs`
    already does.
- Files: frame_split.js and new tool files.
- Proof on the laptop: node tests; the orchestrator runs one SwiftShader census.
- Gain: 0 ms. Heap 0.
- Owed on the 1070: the census at Holtburg and Linvak on the chain default.

**S1a `?staticMatrixFreeze`** (JS, pixel-identical)
- What: after attach, call `updateWorldMatrix(true, true)` once, then set `matrixAutoUpdate` and
  `matrixWorldAutoUpdate` false on:
  - static singletons and LOD wrappers and their levels, except billboard leaves;
  - chunk and atlas buckets;
  - building batches and loners.
  This is the cells pattern (`cells.js:1460-1464`). The world matrices are bit-identical: same operands, computed
  once.
- Files: statics.js (lane C), static_batch_x.js, static_atlas.js, buildings.js.
- Proof on the laptop: a node test in the shape of `tests/freeze_world_roots.test.mjs`, asserting every visible
  world matrix is bit-equal to the unfrozen run over N frames with park, unpark, hide and LB crossings; plus one
  SwiftShader frame diff (max channel diff 0).
- Gain: −0.08 to −0.2 ms (600–1,000 visible composing static nodes × ~125 ns). Heap 0.
- Owed on the 1070: `__skipHiddenMatrix.census()` composed/multiplied before and after; renderCPU A/B.

**S1b `?anchorOffGraph`** (JS, pixel-identical)
- What: the frozen script anchors move to an off-graph root that is never added to the scene. The root's
  `matrixWorld` is a frozen copy of `staticsGroup.matrixWorld`: copied, not recomposed from `worldRoot`, so even the
  signs of zero match. Two properties make this safe:
  - `parent` stays non-null, because `rp6CullSphere` fails open on a null parent
    (`particle_manager.js:1640-1641`);
  - `anchor.matrixWorld` is bit-identical, because it multiplies the same two operands (root `matrixWorld` ×
    `anchor.matrix`). The partFrames walk stops at the frozen root.
  A per-LB anchor registry replaces the `staticsGroup` scans in park, unpark, evict, the radius tick
  (`statics.js:5279-5300`) and objRadius.
- Files: statics.js (lane C), landblock_lru.js; lane A reviews.
- Proof on the laptop: a node test that each emitter's world centre and cull sphere is equal before and after the
  move, for every anchor of a recorded LB; the park → unpark → rebuild emitters path; a particle-count smoke.
- Gain: −0.02 to −0.1 ms [Linvak −0.7 to −1.3 ms]. Heap 0. Also takes ~14k-child scans out of park
  (`landblock_lru.js:1694-1737`) at Linvak.
- Owed on the 1070: the Linvak A/B (renderCPU, `sceneNodes`, RP6 drawn-particle count unchanged).

**S1c `?poolSizeToContent`** (JS, pixel-identical)
- What: the first pool allocation is sized from the first plan with the chunk rule (`_initialBucketVerts`,
  `static_batch_x.js:2495-2510`: twice the need, rounded up to a power of two, clamped to [1,024, 16,384]). Fix
  `POOL_VERTEX_BYTES` to 36/39 so M6 reports the truth.
- Files: pool_registry.js.
- Proof on the laptop: `harness/test_draw_pools.mjs` (475) and `tests/pool_runs.test.mjs`; a census assertion that
  allocated stays ≤ 2–4 × used.
- Gain: 0 ms. Heap −40 to −48 MB of JS memory and the same on the GPU (76 × 655 KB → ~76 × 40–60 KB).
- Owed on the 1070: a heap snapshot of the chain; `__diag.pools().geometry`.

**S2 `?rustWorld=shadow`** (Rust mirror, no behaviour change)
- What: the producers post the events they already perform. Rust keeps its tables. A 1 Hz audit compares Rust's
  per-object visible-instance lists against three's `_instanceInfo`, per-LB park state against the LRU, and tile
  states against `SlotGrid`. The counter `rustWorld.mismatches` must stay 0.
- Files: lane W, plus one-line hooks in the producers.
- Proof on the laptop: cargo tests replaying the S0 fixtures; `tests/rust_world_shadow.test.mjs` through the wasm
  bridge; one SwiftShader boot with 0 mismatches.
- Gain: 0 ms (+0.02–0.05 ms while auditing). Heap +2–5 MB of wasm memory.
- Owed on the 1070: a 30-minute tour with 0 mismatches.

**S3 `?rustWorldVis`** (Rust visibility for node routes, pixel-identical)
- What: one call per frame decides the node-route flips (lane C's cull kernel applied to records), the billboard
  quaternions and positions, the objRadius / film / dead / anchor marks, and the cell-container flips from the render
  set. It replaces `cullStaticsGroup`'s walk, `tickStaticsBillboards`, the objRadius node loops and the JS half of
  the container diff.
- Files: lane W + lane C (shared kernel); statics.js and cells.js hooks.
- Proof on the laptop: fixtures from the JS walk; flips, quaternions and positions bit-equal (1 ulp after atan2,
  sin and cos).
- Gain: −0.1 to −0.25 ms (billboards 0.11, the JS of the cell visibility tick, node marks), beyond lane C's cull
  walk. Heap 0.
- Owed on the 1070: renderCPU A/B; the billboard leaf count.

**S4 `?rustWorldLists`** (Rust-owned lists for opaque batched objects, pixel-identical)
- What: for chunk buckets, pools, atlas buckets and building batches:
  - Rust holds slot → (gid, bits).
  - Park, unpark, objRadius, film and cell flips become bit flips.
  - JS writes the Rust list and runs into the BatchedMesh fields when the epoch moves, and leaves
    `_visibilityChanged` false.
  - The early-out stays permanent.
  - batched_runs takes external runs.
  - Three's per-instance flags are synced on events. Sorted objects stay on three's path.
- Files: lane W; pool_registry.js, static_batch_x.js, static_atlas.js and buildings.js (adapters); batched_runs.js
  (external-runs API).
- Proof on the laptop: node parity over the S0 traces (lists and layouts bit-equal to three's own rebuild plus
  `buildRuns`); `batched_runs_smoke` and `pool_runs_smoke` pixel-identical on SwiftShader; `issuedSubDraws`
  unchanged.
- Gain: −0.15 to −0.3 ms (the opaque part of the 0.41 ms onBeforeRender family). Heap −2 to −5 MB (JS membership
  ledgers).
- Owed on the 1070: renderCPU; CrGpuMain unchanged (gputrace); issuedSubDraws equal.

**S5 `?rustWorldResidency`** (grid and LRU bookkeeping in Rust, pixel-identical)
- What: the state machine of §2.5. JS's LRU becomes a command executor and stops scanning groups.
- Files: lane W; residency_grid.js and landblock_lru.js (executor); index.js wiring (orchestrator).
- Proof on the laptop: the `test_residency_grid` suite (409) replayed against Rust; the `@teleloc` hop battery on
  SwiftShader with the integrity counters at 0.
- Gain: ~0 ms per frame. Heap −2 to −5 MB. Park and unpark stop scanning ~1.7k–14k children per LB.
- Owed on the 1070: the E5-class walk (seams, holes, ghosts); park and unpark timings.

**S6 `?rustWorldBake`** (placements stay in Rust, pixel-identical)
- What:
  - No transient Mesh per (placement × surface) for batched routes.
  - Matrices come from Rust as a `Float32Array` per LB.
  - Content dedup by exact bake identity, with no byte hashing (`pool_producer.js:495-695`).
  - Per-LB source geometries are not retained.
  - The holdout ledger moves to Rust.
- Files: lane W; statics.js (lane C) and buildings.js bake paths; lib.rs glue (orchestrator).
- Proof on the laptop: a node test that the Rust matrices are bit-equal to the f32 `node.matrix` path per placement
  (including the buildings' decompose → compose); `test_draw_pools`; SwiftShader frame diff 0.
- Gain: ~0 ms steady; lower per-LB bake cost (owed). Heap −8 to −12 MB (bundle views held by disposables) plus
  less GC churn.
- Owed on the 1070: per-LB bake ms and `frame_work` W3/W6 `maxItemMs` while running; tour jank.

**S7 `?rustWorldPools`** (eye-gated, NOT bit-identical: routing consolidation)
- What:
  - LOD placements and lone singletons go into sector-anchored batched objects.
  - The Rust band tick replaces THREE.LOD.
  - Billboards become Rust-written instance rows in small dedicated objects.
  - Variants are retired where no plain draw remains.
  - Chunk buckets optionally move to the sector partition.
- Files: lane W + lane C; materials (variants).
- Proof on the laptop: SwiftShader frame diffs reported, not asserted to be 0; LOD band parity tests (exact).
- Gain: −0.2 to −0.5 ms on the scene walk, up to −0.24 ms of variant sync, plus fewer singleton draws. The draw term
  is not predicted (walls 29/107/137): 55 singleton draws cost 1.27 ms in the 10-17 census [M]. Heap −2 to −5 MB.
- Owed on the 1070: an owner eye check (precision and z-fight vantages, LOD pops, billboard foliage), then an A/B.

**S8** (R3 hand-off)
- What: `StaticDrawFrame` (§2.8), per-camera node bits, and sorted lists for translucent objects.
- Files: lane W + R3.
- Proof on the laptop: R3's executor smoke.
- Gain and owed measurements: R3's.

**Ordering**
- S1a, S1b and S1c are independent and can land today.
- S2 must precede S3–S6: shadow first, then one population flipped at a time, and never two writers.
- S4 is the step R3 needs.
- S5 and S6 move structure and heap rather than frame time, so they can trail S4.
- S7 waits for the owner.

---

## 5. Ceiling and risks

**What stage 2 can remove** (1070, ultra, Holtburg, against the 20.6 ms frame) [D]:

| Term | Today | Stage 2 removes | What stays |
|---|---|---|---|
| Scene walk (2.39 ms) | static share ~0.3–0.5; entities ~1.9 | 0.3–0.5 with S1 + S7; ~0.15–0.3 in 2a only | the entity walk (lane B and later) |
| `onBeforeRender` family (0.41) | all static objects | ~0.15–0.3 (opaque, S4) | sorted buckets until S8 |
| Variant sync (0.24) | | up to 0.24 (S7 only) | building batches unless pooled |
| Billboards, cell visibility JS, node marks | ~0.25 | 0.1–0.25 | the wasm BFS (already Rust) |
| Cull walk (0.36) | | lane C's | |
| Residency (~0.05) | | ~0 | |
| Draw loop (6.98) | | R3's | |
| **Total** | | **~0.6–1.3 ms** (2a alone ~0.4–0.85) | |

- **Linvak-class towns**: add ~0.7–1.3 ms for the anchors (S1b), so ~1.3–2.6 ms.
- **What that is worth in fps**: if stage 1 lands its 2–3 ms first, stage 2 takes the 1070 from ~51 to ~53–54 fps at
  Holtburg. That is short of the plan's ~57, which assumed 1.5–2 ms at every town.
- **The GPU-process cap** (~67–69 fps, plan §1) is untouched by stages 1–2.
- **Heap**: −50 to −70 MB at Holtburg. S1c is most of it; S5 and S6 add about 10–17 MB. The rest of the chain's
  ~350–450 MB heap gap over the old stack is mostly the class pages (texture-side, §0.6).

**Risks**

1. **Two owners during the migration.** The repo's worst residency bugs were dual state: the TN park↔unpark storm
   and the dual-state `track` (`landblock_lru.js:103-130`, `:870-945`).
   - Mitigation: S2's shadow mode with mismatch counters, then flip one population at a time. JS and Rust never write
     the same population.
2. **Coupling to three's internals.** S4 writes `_multiDrawStarts/_multiDrawCounts/_multiDrawCount` and
   `_indirectTexture.image.data`, and keeps `_instanceInfo[].visible` in sync. A three upgrade can break it.
   - Mitigation: one adapter module with a boot self-test that disarms S4 loudly, the `_verifyColorTextureFix`
     pattern (`pool_registry.js:435-459`). Pin it in the three-bump checklist.
3. **Pixel identity.** Only S7 changes routing, and it changes vertex precision (§0.4).
   - Mitigation: sector anchoring plus the owner's eye. Record the exact differences; never call them identical.
4. **wasm memory.** Growth detaches views and Rust reallocations move pointers.
   - Mitigation: the bridge rules (`scene_core.js:16-21`) and a single output header per call.
5. **Raycast, film and decal consumers read three's per-instance state** (invariant 29).
   - Mitigation: event-time sync.
6. **Lane overlap.**
   - statics.js (lane C) for S1a, S1b, S3 and S6;
   - anchors and emitter frames (lane A);
   - animated scenery anchors (lane D).
   - Mitigation: S1b and S3 land after or with lane C, through the orchestrator.
7. **The measurement basis.** The 10-23 profiles are from the old stack. Re-profile on the chain default before
   believing any of §5. The census may move the static share of the walk either way.
8. **Bake-time synchronous Rust** (S6). A per-LB ingest is synchronous wasm on the main thread.
   - Mitigation: chunk it under the W3/W6 budgets (`frame_work`), as the JS build is today (`statics.js:3080`,
     `:3163-3170`).
9. **Holdout re-routing** (invariant 10). Getting it wrong shrinks the pooled world silently.
   - Mitigation: carry `heldOut`, `reOfferAdmitted` and `heldOutRetired` as Rust counters with the same meaning.
10. **Sorted objects** need per-camera lists, including the CSM cascades. They stay on three's path until S8, so the
    memo (0.2 ms) remains in 2a.
11. **ANGLE per-range cost.** S4 must keep the (range, id) multiset; `issuedSubDraws` is the gate.

---

## 6. Measurements owed on the 1070

1. **The per-group structural census** (S0) at Holtburg and Linvak, chain default, ultra:
   - resident, visited and composing nodes per world group;
   - anchors;
   - LODs, and LODs with billboard tags;
   - singletons;
   - objects and instances per batch kind;
   - `__skipHiddenMatrix.census()`.
2. **A CPU profile on the chain default**, running and standing at Holtburg and Linvak, split with
   `tools/rust_parity/profile_systems.py` and §1.5's terms. The 10-23 profiles predate the chain.
3. **A heap snapshot on the chain default.** It answers whether `usedJSHeapSize` counts typed-array stores, and
   splits the heap into pool buffers, class pages, BC7 mirrors, BatchedMesh arrays and node objects.
4. **Per-LB bake cost while running**: `frame_work` W3/W6 `maxItemMs`, LoAF, tour jank. This is S6's baseline.
5. **Per step**, an `=off` A/B with these reads:
   - renderCPU / frame time;
   - `__diag.render.sceneNodes`;
   - `issuedSubDraws`, which must be unchanged for S1–S6;
   - CrGpuMain via `gputrace` + `gpu_thread_split.py`, also unchanged.
6. **S7**: the owner's eye check — coplanar floors and decals, distant towns, LOD swaps, billboard foliage — then an
   A/B.

---

## Appendix A — API sketch (lane W)

**Kernel** (`crates/holtburger-scene/src/world/`)

| Module | Role |
|---|---|
| `mod.rs` | `World` |
| `placement.rs` | the placement table |
| `route.rs` | the route table and draw objects |
| `residency.rs` | the slot grid, LB state and commands |
| `visibility.rs` | bits, node flips, billboards |
| `lists.rs` | active lists, runs, node spheres |
| `lod.rs` | S7 |

**Glue** (`src/scene_wasm/world.rs`): `#[wasm_bindgen] pub struct SceneWorld`.

| Kind | Methods |
|---|---|
| Event calls (return a command count; commands land in an arena) | `ingestLb(lbKey, epoch, rowsPtr, n, routesPtr, m)`, `routeResolved(…)`, `objectCreated(handle, kind, …)`, `geometryTable(handle, gidsPtr, startsPtr, countsPtr, n)`, `instanceIds(handle, idsPtr, n)`, `tileEvent(kind, tile, nowMs)`, `drainStep(nowMs)`, `hideLb(lb, bit, on)`, `cellDelta(inPtr, nIn, outPtr, nOut)`, `filmHide(itemOrKey, on)`, `committed(lb, epoch)`, `evictLb(lb)` |
| Per frame | `inputPtr()` (written by JS), then `frame() -> u32` (writes the output header at `headerPtr()`; the pointer is fetched once and re-fetched after memory growth) |
| Census and audit | `census() -> String` (JSON, 1 Hz at most), `auditObject(handle, idsPtr, n) -> u32` (S2) |

**Bridge** (`scene3d/rust/world.js`)
- `armRustWorld(scene3d)`.
- `rustWorldFrame(camera, player)`: called once from `loop.js` `_tickPerFrameBody`, right after
  `tickCellVisibility3D` and in place of the statics sub-pass of `tickFrustumCull` (`loop.js:3064-3086`). It must
  run before `syncBatchMatVariants` (`index.js:3134`) and before render.
- One command executor for the event arenas.

## Appendix B — profile method (reproducible)

The scripts are small Python functions over the V8 `.cpuprofile` JSON:
- samples under `recordRenderDiag` are excluded, as `profile_systems.py` does;
- frames = (endTime − startTime) / 1e6 × run fps, from the run json: 43.1 / 47.9 / 44.6 → 407 / 445 / 416 frames;
- inclusive time per `functionName@file` counts a function once per sample (the outermost occurrence);
- self time is the leaf frame.

The run-1 targets reproduce the plan's 20.6 ms/frame and 2.4–2.5 ms scene walk. That is the check that the frame
count is right: dividing by the run's 860 frames, instead of the profile's 9.45 s × 43.1 fps, halves every figure.
