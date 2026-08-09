# Pass 07 — Scene and draw architecture: persistent material-class pools, unified material keys, O(pools) scene graph

Pass 7 of 12. Governed by `TRACKING.md`'s protocol header. This pass fixes I5's break
(charter D-01.7: "BROKEN for statics/terrain/envcells; KEPT for entities … animated scenery
stays on the landed instanced path"): persistent material-class draw pools over pass 6's
resident set, the unified material key that targets the measured 71% material-switch rate,
the O(pools) scene-graph shape that attacks the traversal term, the integration of every
producer population, and — the key seam — the pool feed/release contract at slot-grid
transitions. Source classes per R7: **[M]** measured (doc named), **[D]** derived
(arithmetic shown), **[A]** assumed-pending-measurement.

**This pass lives closest to the walls, and every claimed improvement below is stated as
"which measured term it reduces, at what scale."** The binding measured facts (all [M],
frame-cost doc + survey §2 unless noted): 37.6 µs FIXED cost per draw with r² = 0.014
against instance count (frame-cost §5a); 71% of draws switch material; 160 program
switches for 79 distinct programs; the BatchedMesh multidraw rebuild is 5.72 ms/frame and
80% per-instance (0.348 µs/inst over ~13k instances in rendered buckets, frame-cost §5a);
traversal ~3.6 ms at 340–450 ns/node over ~4.4k nodes (survey §2); merging
resident-but-culled buckets measured 0.0 ms (`?statArrayMerge`, frame-cost §5a superseded
banner — DONE AND DEAD); draws-removed × µs/draw does NOT predict wins (same banner, decay
6.4 → 0.0 ms); parked wins can be moving losses (statBatchMemo, survey §6); three's
per-object glue is 70.7 ns (framework-overhead theories dead, survey §6); the transparent
pass is 8.70 ms for 212 draws vs opaque 4.28/215 (frame-cost §5b); the ClipMap eye-test
failure (frame-cost §5e) is the standing proof that pass-membership changes are invisible
to every harness metric. **No figure in this pass is a frame-time prediction; F-series
impact is term-denominated or qualitative, per the charter's derivation prohibition
(D-01.5).**

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all; I5, W2, walls §6).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; D-01.5
  derivation prohibition, D-01.7 I5 disposition, F/M-series).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all; tiles, PLACEMENTS
  rows, K-tier record placement).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; residency guarantee
  before decode, S1.4).
- `docs/reengineering/pass-04-geometry-spec.md` — lines 1–607 (all; HBG1 subsets/flags,
  GeometryBundle ABI, H-04.3: "whether pools consume subsets directly" is answered here).
- `docs/reengineering/pass-05-texture-spec.md` — lines 1–768 (all; TEXREF dims, array
  policy D-05.6, H-05.2: "whether pools subsume the atlas is pass 7's call" — answered).
- `docs/reengineering/pass-06-residency-architecture.md` — lines 1–686 (all; slot states
  S2, H-06.1 pool-membership mapping, Q6 animated-scenery boundary).
- `docs/2026-08-06-frame-cost-structure-measured.md` — lines 1–629 (all): §1 CPU-bound,
  §2 per-owner µs/draw table, §5/5a bucket-cost split + statArrayMerge superseded banner,
  §5b transparent split + 7-opaque-programs/42-switches, §5c allocated-vs-used, §5d/5e/5f
  ClipMap provenance + eye-test checklist, §6 order-on-evidence (item 4: value-merge
  KILLED — the floorBias/staticBias/cellBaked/VFX clones "exist precisely because they
  must render differently"), §7 end-to-end.
- `docs/2026-08-06-p99-stall-attribution.md` — lines 1–431 (all): #1 CSM depth-variant
  link population (43 programs × 172–849 ms mid-walk [M]), #3 governor churn, #5
  statBatchMemo single-state-slot vs 4 cameras at ultra (lines 202–217).
- `scene3d/statics.js` — lines 1740–1900 (statArrayMerge VFX provider incl. the
  68-deformed/60-plain submitted census at 1754–1756; `consolidateStaticSingletons`
  material-object keying 1827–1840), 2220–2560 (build loop + `STATICS_BUILD_BUDGET_MS = 6`
  at 2233, walkInInstance pass 2236–2257, feed seams: crossLb 2442–2444, per-LB 2449–2452,
  atlas 2497–2540, attach 2541, `attachStaticDefaultScripts` 2547), 470–471 (static
  ParticleManager scene = staticsGroup).
- `scene3d/static_batch_x.js` — lines 1–260 (v1/v2 history, statGeomDedup rationale:
  17,774 instances over 324 distinct geometries at 84–85; statArrayMerge submitted census
  128 nodes at 176–186), 330–610 (three's early-out condition quoted at 348; pOFC/sort
  reachability 352–354; statBatchMemo default "slack" 482–506, −4.00 ms parked / moving
  unmeasured 456–480; sphere-cache streaming degradation 587–600), 1380–1800
  (`_INIT_VERTS` 1403, bucket map keyed by material OBJECT 1409, region key 1421–1425,
  `_getOrCreateBucket` 1440–1510 incl. sort/pOFC at 1450–1451 and the shared-material
  sort-adjacency note 1435–1438, `_reapBucketIfEmpty` 1533–1568, `_addGeometryGrowLayered`
  1615–1624, feed loop 1651–1800), `_shouldSortBucket` (additive-commutes + depthWrite
  arguments, read in full), `_installMemo` sites 1285/1507.
- `scene3d/static_atlas.js` — lines 1060–1189 (`bc7AtlasShouldDefer` 1073–1075,
  `_bucketKeyFor` w×h|stateKey|format 1097–1100, layer capacity/start/grow 1108–1174,
  `_getOrCreateBucket` 1181–1189), 479–520 (`_stateKeyOf`: transparent | alphaTest |
  depthWrite | blend(+custom triple) | wrap, and `_applyStateKey`), 1209/1240 (bucket =
  BatchedMesh named `stat-atlas-x-…`).
- `scene3d/buildings.js` — lines 1–170 (topology Group→hinge-Group→Mesh 8–13; InstancedMesh
  rejection history 25–41; `BUILDING_BATCH` default-ON 118–124; receiveShadow trade
  112–115; `_feedBuildingGroupsToAtlas` 134–151), 100–102 (`?buildingBatch !== "off"`).
- `scene3d/animated_scenery.js` — lines 440–620 (instanced path: `_getSharedSetupGeom`
  decode-once 515–559, one InstancedMesh per (setupId, part, group) 561–582, no
  landblockId / `frustumCulled = false` 571–572, capacity-doubling swap 585–607).
- `scene3d/cells.js` — lines 255–268 (layer-1 consumers: lights, raycasters), 610–654
  (sealedEvict; `FREEZE_STATIC_MATRIX` default-ON 646–654, cellsGroup ≈ 1,100 of ~2,900
  nodes at Town Network 638–640), 1250–1300 + 1490–1530 (per-cell container build), 1566,
  1793–1794, 2199–2265 (visibility: `cellContainer.visible = renderSet.has(cellId)`,
  group-level indoor/outdoor flips).
- `scene3d/terrain_batch.js` — lines 1–92 (design: ONE BatchedMesh, per-LB slot →
  DataArrayTexture layers, proxy meshes as hidden data-carriers 34–43, park ghost fix
  53–60), 510–520 (`frustumCulled = false` — spans the ring), 831.
- `scene3d/materials.js` — lines 540–659 (`_patchSetCacheKey` axes d/c/p/l/a/b/f/s/k/v
  553–583, installer 586–595, `_chainBeforeCompile` 626–638, VFX_GLOBALS 645–651),
  747–786 (floor/static depth-bias variants), 1824 (`__baseTranslucency` stamp), 2110
  (`applyClipMapRenderState`), 2739–2759 (clone keep-list + `__cacheOwned`), 2769–2920 +
  3062 + 3119 (MaterialCache maps: floorBias/staticBias/cellBaked/vfx variants,
  didMaterials), 3521–3650 (getCached + FrontSide clone 3521–3535, getCachedFloorBias /
  CellBaked / StaticBias / Variant 3550–3642).
- `scene3d/picking.js` — lines 450–478 (raycaster layers), 800–840 (entity-roots-only
  picking; "statics are NOT in `roots` at all" 826–827).
- `scene3d/ragdoll_env.js` — lines 120–150 (scratch raycaster layers), 295–330
  (`_collectTargets`: batched/instanced meshes accepted whole, 318–320).
- `scene3d/loop.js` — lines 2008–2060 (`tickShadowReceiveGate`: walks building children on
  a 200 ms + move gate), 1236–1260 (terrain Gouraud tick — reads terrain data carriers).
- `scene3d/lighting.js` — lines 16, 1966 (`attachSetupModelLights` — the whole-scene
  rescan the p99 doc's #3 names).
- `scene3d/index.js` — lines 1398–1407 (the five world groups), 5920–6000 (LRU sizing,
  read for pass 6 continuity).

## Decisions

### D-07.1 — Pool substrate: persistent `THREE.BatchedMesh` pools keyed (world-sector, material-class); statics + buildings + envcells collapse into them; terrain and animated scenery keep their landed shapes; entities excluded

A **pool** is one `THREE.BatchedMesh` holding every resident placement of one
**material class** (D-07.2) within one **world-sector** (2×2 tiles = 4×4 LBs = 768 m
square, world-absolute lattice `s(t) = floor(tile/2)` — NOT grid-relative, so a pass-6
anchor shift never re-homes an instance). Pools are created on first member, persist
across all residency churn, and are reaped when empty (the `_reapBucketIfEmpty` lifecycle,
static_batch_x.js:1533–1568, kept verbatim in spirit). The resident 6×6-tile grid spans
≤ 16 sectors (3–4 per axis depending on anchor phase [D]).

Producer disposition:

| population | today (read-verified) | under pools |
|---|---|---|
| statics/scenery singletons | per-LB Meshes → region×material-OBJECT BatchedMesh buckets + atlas leftovers + LOD wrappers (statics.js:2259–2321, 2434–2540) | pool members; no per-placement nodes |
| buildings | per-placement Group→hinge-Group→Mesh trees + atlas feed (buildings.js:8–13, 134–151) | pool members (parts are static since the door-part retirement, buildings.js:109–111; doors are entities) |
| envcells | per-cell Group containers + per-cell meshes (cells.js:1276–1300) | interior pools with per-cell instance ranges (D-07.8) |
| terrain | ONE BatchedMesh multidraw, per-LB slots (terrain_batch.js:15–17, 510) | **kept as-is** — already the pool shape; only its feed events re-source to pass 6's grid |
| animated scenery | InstancedMesh per (setupId, part, surface), 4–6 draws, default-ON (animated_scenery.js:561–582) | **kept** (charter I5-kept: "stays on the landed instanced path"); materials re-keyed under D-07.2; residency events per D-07.5 |
| entities | per-entity rig meshes, 27 draws at 12.7 µs [M, frame-cost §2] | **excluded** (charter I5-kept; the cost does not live there) |
| VFX/particles, decals, nameplates, sky | own systems | untouched (28 statics-particle draws at 10.5 µs [M]) |

*Rationale.* BatchedMesh is the only substrate in the tree with proven multidraw,
matrices-texture, shadow, raycast (ragdoll_env.js:318–320 already consumes it) and
material integration; the terrain batch is the live proof of the "one persistent node,
slot-fed" shape at ring scale. The (sector, class) partition is the synthesis of two
measured verdicts: v1 ring-spanning-per-material CLOSED-NEGATIVE because it forfeited
node culling AND paid a per-frame ~36k-instance walk (static_batch_x.js:4–10) — D-07.4
removes the walk, and the sector partition restores node-level culling; per-LB and
region×material-object partitions are the churn+fragmentation engine I5 names (survey
§4). *Rejected:* one global pool per class (v1's measured failure mode on the culling
half); per-model InstancedMesh as the primary shape (the ~5,400-singleton / 4,576-draw /
89 ms wall, frame-cost §3c); a hand-rolled multidraw renderer outside three (forfeits
shadow/CSM/material machinery and re-derives BatchedMesh); pooling entities (charter
D-01.7 rejected it with rationale; nothing here re-opens it).

### D-07.2 — Unified material key: value-defined classes over the load-bearing axes; ONE material object per class; the key's soundness inherits row 31's verdict

**The class key (normative encoding in S3):**

```
MatClassKey = domain | passClass | renderState | programPatchSet | textureArrayPage | shadowPair
  domain          outdoor-static · envcell · (terrain, animscenery: reserved labels)
  passClass       opaque · additive · translucent      (derived from renderState; D-07.3)
  renderState     transparent, alphaTest (exact string), depthWrite,
                  blending (mode | custom src.dst.eq triple), wrapS, side
  programPatchSet the _patchSetCacheKey axes verbatim: d,c,p,l,a,b,f,s,k bits
                  + vfxSetKey#configKey token (materials.js:553–583; statics.js:1782–1818)
  textureArrayPage  array-page tier: square pow2 page 256²–2048² (clamp-ceil of the
                  max TEXREF dim) + format (f7|f8); members resampled to page dims
                  (T00 re-key 2026-08-09 — raw dims retired from the key)
  shadowPair      castShadow, receiveShadow (node-level flags → pool-level)
```

**Load-bearing vs accidental axes — the charge's central question, answered from the
record:**

- **Load-bearing (every axis above):** `renderState` is `_stateKeyOf`'s proven axis set
  (static_atlas.js:479–498 — including the wrap-mode field, RND-33, and the exact-string
  alphaTest rule) plus `side` (the FrontSide clone population, materials.js:3521–3535).
  `programPatchSet` is exactly what killed value-merging: **ledger row 31 / frame-cost §6
  item 4 — the 95-objects-vs-76-values gap is floorBias / staticBias / cellBaked / VFX
  clones which "exist precisely because they must render differently"; a key without the
  patch-set discriminator fuses a depth-biased floor into an unbiased bucket.** The
  unified key carries every `_patchSetCacheKey` bit BY CONSTRUCTION, so the row-31
  failure is unrepresentable: a floorBias variant is a different class, full stop.
  `textureArrayPage` is forced by `texStorage3D` (format/w/h/depth fixed at allocation —
  the frame-cost §5 banner's own correction: "7 render states is not the floor").
  `shadowPair` is forced by three (cast/receive are node flags; one pool = one value —
  the trade buildings already accepted, buildings.js:112–115).
- **Accidental (deleted):** material OBJECT identity as the bucket key
  (static_batch_x.js:1409 — the 95-vs-76 gap's other half: identical values failing to
  share); texture OBJECT identity (subsumed by TEXREF-declared dims+format+layer, pass 5
  D-05.6.2 — bucket identity known before any payload arrives); per-LB and
  3×3-region spatial keying (replaced by the world-sector partition + per-tile membership
  records inside the pool); `__bc7Pending` verdict state as a bucketing input (pass 5
  deleted the race).

**One material object per class, cache-owned.** `MaterialCache` grows a
`getClassMaterial(classKey)` tier above the per-DID maps: per-DID materials remain the
DECODE product (they carry the scalar surface facts — `__baseTranslucency`, luminosity,
per-DID textures for the singleton/legacy population) but pool membership binds to the
CLASS material, whose map is the class's array texture. Every sector pool of a class
shares that ONE object — which is the measured mechanism behind the two best per-draw
numbers in the frame table: three sorts the opaque pass by `material.id`, so a class's
sector pools sort adjacent and bind their program/material once
(static_batch_x.js:1435–1438 states this; buildings' 9.8 µs/draw [M, frame-cost §2] is
the live demonstration — 81 draws over a handful of shared cache materials, most draws
switching nothing).

**Term reduction stated (R5 discipline):** this decision attacks the **71%
material-switch rate and the 160-programs-switches-for-79-programs term** — the measured
signature inside the 37.6 µs fixed draw cost (frame-cost §5a: "per-draw state validation
and binding dominating"). Scale: statics/buildings/cells material binds per frame fall
from O(distinct DID materials drawn) to O(classes drawn) (tens — census gate S5.3);
program switches bound by class count. It is deliberately NOT priced in ms: the
statArrayMerge wall proves that removing cheap draws moves nothing, and the opaque pass
already measures only 42 switches over 7 programs (frame-cost §5b) — the headroom is
real but modest at parked-mid, and the moving/ultra case (where streaming manufactures
material churn) is where the term actually bites. Pass 10 measures.

*Rejected:* value-keyed merging WITHOUT the patch axes (row 31 — killed, not re-derived);
an uber-shader collapsing patch variants into runtime branches (D-07.9 — new giant
variants are the p99 enemy, and alphaTest/blending are pipeline state that must differ
per class anyway); keying pools by DID (re-creates today's fragmentation with extra
steps).

### D-07.3 — Pass structure: v1 pools OPAQUE only (incl. the shipped pure-ClipMap class); additive/translucent keep today's sorted-bucket semantics at sector partition; additive-unsort is a reserved eye-gated flag

- **Opaque pools** (the overwhelming statics/buildings/cells mass after `?clipMapOpaque`,
  which is DEFAULT-ON shipped, frame-cost §5e): `transparent = false`, includes the
  50-material pure-ClipMap class (alphaTest 0.784/0.392, depthWrite true) as its own
  class(es). The pass-membership ladder that keeps ClipMap+Translucent (`0x14`) OUT of
  the opaque pass is enforced structurally by the class key (`renderState.transparent`
  comes from the material AFTER `applyClipMapRenderState`/ladder ordering,
  materials.js:2110 + frame-cost §5e provenance) — the failed 77-material arm is
  unrepresentable without changing the ladder itself.
- **Additive and translucent pools** keep `sortObjects = true` +
  `perObjectFrustumCulled = true` — today's sorted-bucket semantics exactly
  (static_batch_x.js:1450–1451), partitioned at sector scale. Blend behavior is
  bit-identical by construction; no eye-test is owed for v1 pass structure.
- **Reserved, NOT v1:** `?poolAdditiveNoSort` — additive blending commutes
  (`_shouldSortBucket`'s own argument), so additive pools could drop the sort and reach
  the D-07.4 early-out; but pooling coarsens the cross-population z-interleave against
  true translucents, which is a structural render change. It ships only through a pass-9
  eye-gate with the §5f checklist shape. The cautionary tale is cited by name: the
  ClipMap eye-test failure (frame-cost §5e) — a large translucent object went fully
  opaque while draws, triangles, materials, heap and p50 all read fine. **The
  "all movable" arm (+1.5 ms, p95 32 → 50.6) is the measured proof that widening pass
  membership by predicate is actively harmful (frame-cost §5d Lead 1); particles stay in
  the sorted pass, permanently.**

**Term reduction stated:** none claimed for v1 pass structure (it is deliberately
neutral). The transparent-pass term (8.70 ms / 212 draws, 2× per draw [M, §5b]) is
attacked only by the reserved additive flag and by pass 5's population changes; the
translucent residue keeps paying the z-sort because its blend order is load-bearing —
that is a correctness floor, not an oversight.

### D-07.4 — Culling and the rebuild term: sector-level node culling; per-instance frustum cull OFF and sort OFF for opaque pools ⇒ three's own early-out; multidraw arrays become event-driven; the statBatchMemo family is OBSOLETE

The charge requires a position on culling granularity. **Position: per-pool (sector)
node-level culling; per-slot-tile residency masks; NO per-frame per-instance frustum
culling for opaque/additive-class pools.**

1. **Node level:** pools set `frustumCulled = true` with sector-bounded geometry — three
   culls the whole pool by its bounding sphere before any instance work (the v2 "core
   win", static_batch_x.js:12–20). ≤16 resident sectors × classes ⇒ O(pools) sphere
   tests, done by three itself.
2. **Instance level:** opaque pools set `perObjectFrustumCulled = false` and
   `sortObjects = false`. Three's `onBeforeRender` then hits its first-statement
   early-out — `if (!this._visibilityChanged && !this.perObjectFrustumCulled &&
   !this.sortObjects) return;` (read-verified quotation, static_batch_x.js:348, from
   three.core.js r184) — **on every frame in which the pool's membership/visibility did
   not change, for EVERY camera, CSM shadow cascades included.**
3. **Residency level:** per-instance visibility flags (`setVisibleAt`) encode ONLY slot
   state (LIVE vs PARKED tiles, per-cell PVS, LOD bands — D-07.5/D-07.8), never the
   camera frustum. They change on residency/PVS/band EVENTS (a few per second while
   moving, zero parked), each change costing one `_visibilityChanged` rebuild of that
   pool that frame.

**Term reduction stated:** this attacks the **multidraw-rebuild term — 5.72 ms/frame,
80% per-instance, 0.348 µs × ~13k instances [M, frame-cost §5a]** — at its own scale:
the per-frame per-instance walk is deleted for the opaque/additive population
(rebuilds become O(changed-pool instances) on events), and — unlike `?statBatchMemo` —
the early-out is camera-independent, so the ultra/CSM case where the memo's single state
slot thrashes across 4 alternating cameras (hit rate ~0, p99 doc #5, lines 202–217) is
covered by construction. The residual per-frame walk is the translucent-class share only
(population census: pass 10).

**The measured trade, stated with its numbers:** dropping per-instance culling was A/B'd:
**−0.40 ms CPU and +420k tris/frame (+81%)** (frame-cost §3d). The CPU side is a small
WIN on the 1070 (and the frame is CPU-bound and not close — §1's 8.2× pixel sweep moved
nothing); the tri side is why §3d said "do not ship this" for weaker hardware. Two
mitigations bound the tri inflation below the +81% worst case: sector-level node culling
still discards behind-camera sectors wholesale (the +81% arm culled NOTHING per-instance
while keeping today's region-node culling — sector granularity is comparable), and
PARKED-tile masks keep out-of-ring instances out of the multidraw entirely (today's
buckets carry parked LBs' instances until eviction). T2 carries no frame targets
(charter D-01.1) and its bot modes skip rendering (`?nullRender`); if a real low-GPU
tier ever materializes, `?poolPerInstanceCull=on` restores three's walk per pool class —
the escape is one property pair.

**statBatchMemo disposition (the charge's explicit question): OBSOLETE, not subsumed.**
The memo, the slack tier, the sphere cache and `?statBatchNoSort`
(static_batch_x.js:332–610) are compensations for `pOFC = true` + `sortObjects` making
the early-out unreachable (the file says so itself, :352–354). Pools remove the
condition rather than memoize around it: settled frames take three's own zero-state
early-out; event frames do the honest rebuild once. The −4.00 ms parked figure the memo
earned (static_batch_x.js:456–468) is the measured size of the term being structurally
removed — quoted as the term's scale, NOT as this design's predicted win (parked wins
can be moving losses; the moving case was never measured for the memo and is not
inherited by this design's claim). The whole flag family retires with the producers
(pass 9 stages; S6 ledger).

*Rejected:* per-frame per-instance frustum culling with a faster loop (the sphere cache
measured 5–7× per instance but degrades under streaming at bucket granularity —
static_batch_x.js:587–600 — and any per-frame per-instance walk keeps the term on the
books); camera-driven tile masks (re-couples visibility flags to the camera ⇒
`_visibilityChanged` every rotation frame ⇒ rebuild storms — the exact failure mode the
early-out exists to avoid); slot-tile-granular POOLS (36 tiles × classes ⇒ hundreds of
nodes and per-tile draw fragmentation — the sector is the culling unit, the tile is the
residency unit, and conflating them re-creates today's per-LB shape).

### D-07.5 — The feed/release contract at slot transitions (pass 6 S2 discharged; H-06.1 adopted): what happens at each transition, what is precomputed where, what the per-frame path touches

**Precomputation ladder:**

- **At bake (offline, pass 2/4):** geometry indexed + subset-partitioned by
  (surface, sidedness) with flags (HBG1); placements as 44 B binary rows (PLACEMENTS);
  TEXREF dims/format per rsId. Everything the pool feed needs to KEY a member is in the
  pack before any decode runs.
- **At STAGED (bake-worker job, off-thread):** the worker emits, alongside pass 4's
  GeometryBundle, a **TilePlan** (S2 format): for every (placement × subset) the resolved
  `classKey`, the content key `(modelId|partId, subsetIdx)`, the world matrix (placement
  × part frame, precomposed), the layer requirement (rsId), and per-cell grouping for
  envcells. Class resolution runs off-thread against the pack's records (surface flags →
  renderState; VFX plan → set#config token; TEXREF → arrayId). The main thread never
  derives a class.
- **At STAGED → LIVE (main thread, pass 8's budget):** per pool touched: geometry
  ensure (content-key lookup in the pool's dedup map → hit reuses the gid; miss =
  `addGeometry` copy from the bundle buffer — the statGeomDedup mechanism promoted to
  default and keyed on exact bake IDs instead of FNV fingerprints, since
  `--verify-closure` guarantees complete decodes), then `addInstance` + `setMatrixAt`
  per placement, layer writes only for rsIds not yet resident in the class array
  (pass 5/8 budgets), ONE epoch bump per pool at batch end. Membership is recorded as
  **one record per (tile, pool)**: `{gidRefs: Map<gid, count>, instanceIds: u32[],
  layerRefs, cellRanges?}` — the refcount-by-tile rule static_batch_x already proved
  (:114–121), one record instead of per-placement bookkeeping.
- **LIVE → PARKED** (2 s hysteresis, pass 6 D-06.3): `setVisibleAt(id, false)` over the
  tile's instanceIds. **No GPU or heap release — park is GPU-free by construction**
  (pass 6 H-06.1's proposed default, adopted verbatim). Cost: one rebuild of the
  affected pools on the transition frame.
- **PARKED → LIVE:** `setVisibleAt(id, true)` — pointer re-adopt, zero fetch/decode/
  upload, one rebuild. This is the retail-freelist behavior the pass-6 floors protect.
- **PARKED → EMPTY** (pressure/teleport-ageout, amortized ≤1 tile/tick under the 6 ms
  budget, pass 6 D-06.3): `deleteInstance` per id; gidRefs decrement, `deleteGeometry`
  at last tile ref; layer refs released; pool marked dirty; `optimize()` runs lazily at
  >30% dead extent (the `_OPTIMIZE_FRAC` discipline, static_batch_x.js:1405); empty pool
  reaped (+ class-array teardown when its last pool goes — the ordered
  layer-then-bucket release, static_batch_x.js:1556–1563).
- **STAGED but vacated before bake completes:** nothing entered any pool; drop the
  TilePlan (pass 6 S2 already routes this to EMPTY).
- **QUARANTINED:** pools never see the tile.

**The per-frame path touches NOTHING per-instance and NOTHING per-placement.** Frame
work for the pooled world = three's projectObject over O(pools + entities) nodes +
per-pool draw submission. All membership mutation is event-driven off the pass 6 grid
events (`onShift`/`onSlotState`), all under pass 8's phase budgets. **Term reduction
stated:** this attacks (a) the rebuild term as in D-07.4, (b) the **crossing-churn
engine** — today a crossing re-runs material lookup, re-buckets, re-copies geometry
into buckets per LB feed (statics.js:2434–2540; the multidraw rebuild's 80%-per-instance
cost is re-paid continuously while moving) whereas a pool crossing is
range-activation + O(new-tile placements) adds; and (c) the p99 #3 feed
(governor-churn → cold re-bakes manufacturing first-sight work) jointly with pass 6.
Moving-case gains are the design target but are UNMEASURED — the fixed-pose moving
bench (pass 10, charter Q2) is where this claim is scored; no number is offered here
(walls: parked-vs-moving).

### D-07.6 — Node-count design: the scene graph is O(pools) + O(dynamic), transforms live in pool instance storage, and every node-walking system gets a named home

**Target scene shape (Nanto-class reference):**

```
worldRoot
 ├ terrain: 1 BatchedMesh (+ per-LB hidden data-carrier proxies — retained, see below)
 ├ statics: opaque/additive/translucent pools ≤ ~150 nodes [A, census-gated S5.3]
 │          + animated-scenery InstancedMesh buckets (4–6) + anchor Groups
 │          + particle systems (~30) + translucent singleton residue
 ├ buildings: (dissolved into statics pools; group retained empty for API continuity)
 ├ cells: interior pools (≤ ~40 [A]) — per-cell Groups deleted
 └ entities: per-entity rigs — UNCHANGED (O(entities × parts))
```

**Where per-placement transforms live (the charge's explicit question):** in the pools'
own instance storage — BatchedMesh's matrices texture, written once at feed from the
TilePlan's precomposed world matrices (pass 2 PLACEMENTS row × pass 4 part frame,
composed in the bake worker). NOT in pass 4's buffers (those are geometry-only by
design) and NOT in retained JS arrays beyond the (tile, pool) membership records — the
TilePlan is dropped after feed; re-derivation on any future need re-reads the resident
pack (pass 6 T2). Pools sit at world identity with `matrixAutoUpdate = false`; there is
no per-placement matrix for three to update, which is why the matrix-freeze ceiling
(0.48 ms [M, survey §6]) does not bound this design — node COUNT reduction does the
work, exactly as the wall requires ("only node-count reduction attacks traversal").

**Term reduction stated:** the **traversal term — ~3.6 ms at 340–450 ns/node over
~4.4k nodes [M, survey §2]** — shrinks by the world-static share of the node
population. Measured composition anchor: cellsGroup alone ≈ 1,100 of ~2,900 nodes at
Town Network (cells.js:638–640); statics singletons/LOD wrappers/building part trees are
the bulk of the remainder. The entity share (O(entities × rig parts)) is charter-kept
and NOT reduced — stated plainly so the term's floor is honest. Scale: world-static
nodes go from thousands to ≤ ~250 [A]; the term's reduction is proportional to the
share, validated by pass 10's node census, not predicted in ms.

**Every system that walks nodes today — enumerated, each with a home:**

| walker (read-verified) | today | home under pools |
|---|---|---|
| click picking (picking.js:800–837) | raycasts ENTITY roots only; "statics are NOT in roots" | unchanged (entities kept) |
| ragdoll/decal env probes (ragdoll_env.js:301–330) | walks groups, accepts Instanced/BatchedMesh whole, distance-prunes plain meshes | unchanged mechanically — pools ARE BatchedMeshes and are already accepted; fewer, bigger targets. three's BatchedMesh raycast serves per-instance hits (already exercised via today's buckets) |
| walking/collision | Rust-side records, never scene raycast (pass 4 D-04.4) | unchanged |
| per-cell PVS visibility (cells.js:1793–1794, 2243–2265) | `cellContainer.visible = renderSet.has(cellId)` | per-cell instance RANGES in interior pools (D-07.8); flips are event-driven `setVisibleAt` batches on renderSet change |
| indoor/outdoor collapse (cells.js:2199–2205) | group-level `visible` flips | pool-level `visible` flips (same three mechanism, O(pools)) |
| LOD selection | THREE.LOD wrappers per placement, evaluated per frame in projectObject | per-instance gid choice + throttled band tick (D-07.8) |
| VFX attachment (statics.js:2547, 470–471) | default-script emitters parented to staticsGroup at placement positions | unchanged — emitters were never children of the prop meshes; they read the TilePlan's placement transforms at attach |
| nameplates (entities.js:1042, 5511) | entity-subtree sprites/DOM | unchanged |
| shadow receive gate (loop.js:2008–2060) | walks buildingsGroup children per 200 ms + move | RETIRED for pooled buildings — receiveShadow is a class axis (D-07.2), pool-level uniform; the per-placement distance gate dies with the per-placement nodes (the trade buildings.js:112–115 already accepted and shipped for the batched population) |
| setup-model lights (lighting.js:1966) | whole-scene rescan on spawn/despawn (p99 #3's unbudgeted cost) | event-driven from grid `onSlotState` + TilePlan light lists — no scene walk (joint with pass 6) |
| ambient audio / terrain Gouraud / capture probes (terrain_batch.js:34–43; loop.js:1236–1260) | read hidden per-LB terrain proxy meshes' userData | terrain proxies RETAINED v1 (visible=false data carriers, ~150–200 nodes — bounded, priced at the measured ~400 ns/node ≈ 0.06–0.08 ms [D]); their replacement by plain JS records is a pass-9 cleanup, not a v1 dependency |
| eviction walkers (landblock_lru statics scan) | scan by `userData.landblockId` | replaced wholesale by pass 6 grid events + (tile, pool) membership records — nothing to scan |

*Rejected:* keeping hidden per-placement proxy nodes for statics (terrain's proxy trick
at statics scale would re-create thousands of nodes — the term being attacked);
per-placement JS mirror objects for picking (nothing needs them: the two raycast
consumers are entity-only and pool-whole respectively).

### D-07.7 — The atlas question (pass 5 H-05.2 discharged): pools SUBSUME static_atlas wholesale; array policy is pass 5's verbatim; geometry dedup is default and exact-keyed; layer identity stays vertex-stamped in v1

- The static atlas — the measured WORST per-draw class (54 µs [M, frame-cost §2]) and
  the weaker merger on volume (§3c: 23,563 nodes → 4,576 draws when leaned on) — is
  **retired as a system**. Its proven parts are promoted into the pool substrate: the
  `sampler2DArray` material machinery (`makeArrayMaterial`, static_atlas.js:537), the
  layer pools with X7 capacity/start/grow arithmetic (:1108–1174), and the state-key
  axes (:479–498) all become class-material internals. The singleton leftovers class
  (`statics | Mesh`, 49 draws at 43 µs [M]) and the `bc7AtlasShouldDefer` hold-out
  (:1073–1075; 79% held out [M, survey §2]) die with it — under pass 5 D-05.6 the class
  array is TEXREF-keyed and preview-committed, so there is no verdict to wait on.
- **Array policy:** pass 5 D-05.6 verbatim — full mip chains + aniso, ×1.5 growth,
  TEXREF-declared dims as the bucket axis, per-class VRAM budgets (D-05.8). The
  preview-commit/re-home contract maps onto pools as: a member whose full tier is not
  resident feeds the 128²-dims class pool immediately (correct pixels, soft);
  `atlasRefeed(rsId)` becomes a pool-to-pool member transfer (deleteInstance/addInstance
  + layer write) — event-driven, budgeted by pass 8, bounded by the upgrade rate.
- **Geometry dedup:** default-ON inside pools, keyed `(modelId|partId, subsetIdx,
  layer)` — exact bake identities replace statGeomDedup's FNV fingerprint (the
  fingerprint existed to guard against partial decodes, static_batch_x.js:96–99;
  pass 2's `--verify-closure` + pass 3's loud-skew contract delete that failure class).
  Measured motivation: 17,774 batched instances over 324 distinct geometries
  (static_batch_x.js:84–85) — the per-region re-copy tax dies with the persistent pool.
- **Layer identity stays per-vertex `aLayer` in v1** (the `_addGeometryGrowLayered`
  stamp-on-copy mechanism, static_batch_x.js:1615–1624), so a geometry used under two
  layers is two pool geometries — proven, shader-risk-free. The per-instance layer
  channel (BatchedMesh color-texture channel read in the class shader) would collapse
  those copies and is reserved as a measured refinement (Open Q4): it is a new shader
  variant, and new variants are the p99 enemy (D-07.9).
- The windSway/VFX MECH-B reproduction rules ride over unchanged: vertex-stage sets
  only, set#config token in the class key, `installVfxComponentPatch` on the class
  material (statics.js:1766–1818 — the provider already proves pool-material
  reproduction and the "trunk sways, foliage frozen" guard); per-instance `vVfxHash`
  derives from `batchingMatrix[3].xy` under `USE_BATCHING` (statics.js:1758–1762) and
  works in pools by construction.

### D-07.8 — Per-placement features without per-placement nodes: LOD bands, per-cell PVS ranges, envcell specifics

- **LOD (did_degrade):** pass 4 resolves the chain at bake (D-04.6); both full and
  degraded geometries are pool-resident gids of the same class (same surface ⇒ same
  class by construction). A member's active gid is chosen at feed by distance band and
  re-chosen by a **throttled band tick** (default 2 Hz + player-moved-≥8 m gate — the
  `tickShadowReceiveGate` throttle shape, loop.js:2024–2046) that walks the (tile, pool)
  membership records (JS arrays, not scene nodes), swapping gid via
  deleteInstance/addInstance for band-crossers only. Event-driven: parked cost 0; moving
  cost O(band-crossings), a few per second at the ~100 m band radius. THREE.LOD wrappers
  are deleted. Hysteresis ±10% on the band edge prevents flapping. [A on the tick rate —
  pass 10 tunes.]
- **EnvCells:** interior pools are keyed like outdoor pools but partitioned per
  interior-LB (interiors are pass 2 interior packs; a dungeon is its own pool set —
  sector partition is meaningless indoors). Members carry their cell id in the
  membership record's `cellRanges`; the PVS tick's renderSet delta (cells.js:2243–2265's
  event, not its per-container walk) issues `setVisibleAt` batches for cells entering/
  leaving the set. Slot remap + vertex-light bake stay per pass 4 D-04.7 (the baked-light
  stream rides the vertex format; `acBakedLight` is a class key bit — key bit `k`,
  materials.js:566–577, so interior classes never share programs with plain surfaces:
  the 2026-07-28 collapsed-program lighting regression stays structurally fixed).
  Depth-bias variants (floorBias/cellBaked/staticBias) are distinct classes via their
  patch bits — row 31 honored again where it was earned.
- **Animated scenery boundary (pass 6 Q6 answered):** it does NOT move deeper into
  pools. The landed InstancedMesh buckets stay (charter I5-kept); integration is
  limited to (a) class-keyed materials from the D-07.2 cache, (b) membership add/remove
  driven by grid slot events instead of the LRU orphan-reclaim scan, (c) its buckets
  remain `frustumCulled = false` (animated_scenery.js:572 — instances scatter beyond
  shared-geometry bounds; population is 4–6 draws, not worth sector partitioning).

### D-07.9 — Program population: a CLOSED class set; variant count is owned here and it is the streaming-tail lever; no uber-shader

- **Variant consolidation, not uber-shader.** Classes reuse the existing patched
  `MeshStandardMaterial` + `customProgramCacheKey` arrangement (materials.js:586–595)
  with class-level materials. Expected program population: O(distinct programPatchSet ×
  state-parameter combinations live in a scene) — the same 79-programs world, minus the
  per-DID fragmentation. An uber-shader is rejected on three grounds: alphaTest/blend/
  depth state are pipeline state (not shader-branchable) and already force per-class
  pipelines; runtime branching taxes every fragment for every feature on a frame whose
  GPU is idle but whose SHADER LINKS are the p99 tail (172–849 ms per mid-walk link
  [M, p99 #1]); and one giant program is itself a new worst-case link.
- **The closed-set property is the tail claim, term-denominated:** because pool
  materials exist per CLASS and the class set is fixed by content statics (not by which
  tile streamed in), **streaming a new tile creates ZERO new materials and ZERO new
  programs** for the pooled world. The p99 #1 population — "programs newly reached by a
  draw or shadow pass in that frame", 43 programs force-linking mid-walk at 172–849 ms
  each [M] — is removed at its mechanism for statics/buildings/cells: every class
  program (including its CSM depth variant, the population `renderer.compile` never
  touches — p99 #1) is enumerable at boot and prewarmable ONCE. Pass 8 owns the prewarm
  mechanics; **this pass owns the count: the class census (S5.3) IS the prewarm work
  list, and a class set that grows during a walk is a class-key bug by definition
  (census counter `classesCreatedPostBoot` MUST stay 0 after the boot ring settles —
  entity/legacy-lane materials excepted).**
- **Shadow/side constraints (the charge's last clause):** `side` is a class axis (the
  FrontSide clone tier, materials.js:3521–3535, maps to distinct classes; HBG1 subset
  `doubleSided` flags route members); `castShadow` is a class property derived by
  `materialCanCastShadow`; `receiveShadow` is pool-uniform (D-07.6 table). CSM depth
  variants: pool geometry uses batching (`USE_BATCHING`) and VFX vertex sets keep the
  shadow_guard exemption (statics.js:1808–1811 — depth material never carries the
  displacement, so sway never perturbs silhouettes); depth-variant count = classes ×
  {castShadow=true}, a boot-enumerable list handed to pass 8.

### D-07.10 — What is NOT pooled, and migration coexistence

Not pooled, with reasons: entities (charter; 12.7 µs/draw — not the cost); particles
(measured actively harmful to move, §5d); translucent singleton residue (blend order
load-bearing; population census pass 10); the legacy per-record lane's runtime-decoded
content (admin-spawned, no-BPTC fallback — renders via today's singleton path);
nameplates/decals/sky/UI. Coexistence: pools ship behind `?drawPools` (default-OFF until
the test battery + 1070 eye-gate, then default-ON with `=off` escape — house rule,
matching pass 6's `?slotGrid` staging); the escape arm is TODAY'S producer stack
unchanged (statics.js feed seams, static_batch_x, static_atlas, buildings, cells), so
kill criteria are one-flag reversions. The two flags compose: `?slotGrid` without
`?drawPools` runs grid events into the legacy LRU adapters (pass 6's migration state);
`?drawPools` requires `?slotGrid` (pools consume grid events; no reactive-LRU adapter is
built for them — one seam, not two).

## Spec

### S1 — Modules and data flow

```
pass 6 grid events (onSeed/onShift/onSlotState/onTeleport)
        │
        ▼
scene3d/pool_registry.js  (NEW — the only writer of pool membership)
  · classKeyOf(resolved surface state, patch set, texref, shadow)   [S3]
  · poolFor(sectorKey, classKey) -> BatchedMesh (create-on-first-member)
  · feedTile(tilePlan, bundles)      STAGED→LIVE   (pass 8 budget)
  · parkTile(tile) / adoptTile(tile) LIVE⇄PARKED   (setVisibleAt batches)
  · releaseTile(tile)                PARKED→EMPTY  (amortized)
  · bandTick(playerPos) / cellSetChanged(lb, renderSet)             [D-07.8]
  · census() -> S5 shape
        │ members, layers
        ▼
materials.js MaterialCache.getClassMaterial(classKey)   (NEW tier; per-DID tiers kept
        │                                                for singleton/entity/legacy)
        ▼
class arrays (pass 5 D-05.6 policy; former static_atlas machinery, relocated)
```

**TilePlan** (bake-worker product, structured-clone + the pass 4 bundle transferable):

```
{ tile, lbs: [u32],
  members: [{ classKey: string,            // S3 canonical form, resolved off-thread
              contentKey: u32|u32 pair,    // (modelId|partId, subsetIdx)
              matrix: Float32Array(16),    // placement × part frame, precomposed
              rsId: u32,                   // layer requirement (0 = untextured class)
              cellId?: u16,                // envcell members only
              bandGids?: [gid pair],       // did_degrade alternative, if any
              lightList?: […] }],          // for the lighting event feed (D-07.6)
  counts: { byClass: Map<classKey, n> } }  // pre-aggregated for budget planning
```

**Membership record** (JS, one per (tile, pool)): `{ pool, instanceIds: Uint32Array,
gidRefs: Map<gid, u16>, layerRefs: [], cellRanges?: Map<cellId, [start, end]>,
bands?: compact per-member band state }`. This is the ONLY retained per-tile scene
bookkeeping; the TilePlan is dropped after feed.

### S2 — Slot-transition contract (normative; discharges pass 6 S2's executor column for pools)

| transition | pool operation | GPU traffic | rebuild cost | budget owner |
|---|---|---|---|---|
| EMPTY→FETCHING→STAGED | none (worker builds TilePlan + bundles) | none | none | pass 3/6 |
| STAGED→LIVE | geometry ensure (dedup-hit or addGeometry copy) + addInstance/setMatrixAt + missing layer writes + ONE epoch bump/pool | bundle copies + layer subimages | O(new members) once | pass 8 (feed budget) |
| LIVE→PARKED (2 s hysteresis) | setVisibleAt(false) batch | none | O(pool instances) once, affected pools only | park scheduler tick |
| PARKED→LIVE | setVisibleAt(true) batch | none | same, once | immediate (re-adopt) |
| PARKED→EMPTY | deleteInstance batch; gid deref → deleteGeometry at zero; layer deref; lazy optimize() at >30% dead | none until optimize (buffer compaction) | O(tile members) amortized ≤1 tile/tick, 6 ms cap | pressure pass (pass 6 S4) |
| teleport | park-drain per pass 6 D-06.10 (250 ms first burst), then ageout | none | bounded by drain budget | pass 6 |
| PVS renderSet change | setVisibleAt over entering/leaving cellRanges | none | O(changed cells' instances) once | event |
| LOD band crossing | deleteInstance+addInstance (gid swap) per crosser | none | O(crossers) once | band tick (2 Hz) |
| full-tier texture upgrade (pass 5) | pool-to-pool transfer at dims boundary, else layer write in place | one layer subimage | O(members of rsId) once | pass 8 (upload budget) |

Invariant (the anti-churn law, joint with pass 6): **no pool operation of any kind runs
on a frame without a triggering event.** A settled parked frame performs zero pool
mutations, zero per-instance work, and every opaque/additive pool takes three's
early-out. Counter `poolMutationsPerFrame` (S5) exists to make violations visible.

### S3 — Class key canonical form (normative)

String form (order fixed; produced only by `classKeyOf`, never hand-built):

```
"<domain>|<state>|<patch>|<tex>|<shadow>"
 domain = "st" | "ec"                       (outdoor-static, envcell)
 state  = t{0|1} a{exact alphaTest string} w{0|1} b{mode | cS.D.E} r{w|c} s{f|d}
          — the _stateKeyOf axes (static_atlas.js:479–498) + side; alphaTest keeps
            full-precision string equality (the 100/255 non-terminating rule)
 patch  = _patchSetCacheKey(material) verbatim (materials.js:553–583), which already
          canonicalizes d,c,p,l,a,b,f,s,k + "|v"+vfxSetKey; the pool key appends
          "#"+configKey for MECH-B sets (statics.js:1793 token rule)
 tex    = x{t}{f7|f8}   (ARRAY-PAGE TIER + format; t = log2 page edge ∈ {8,9,10,11}
          — square pow2 pages 256²/512²/1024²/2048²,
          t = clamp(ceil(log2(max(TEXREF w, TEXREF h))), 8, 11). Members whose
          native dims ≠ page dims are stored RESAMPLED (upscaled) to page dims at
          bake/transcode time — every layer fully covered, so wrap, full mip
          chains and aniso stay legal. Raw-dims keying is RETIRED from the class
          key: it fragmented the census (+92 classes at Nanto; T00 re-key
          2026-08-09). Tier derives from TEXREF-DECLARED dims (D-05.6.2: identity
          before payload; class identity stable across preview→full).)
 shadow = c{0|1}r{0|1}
```

Sector key: `"s<sx>x<sy>"`, `sx = floor(tile_x/2)` world-absolute. Pool node name:
`pool-<sectorKey>-<hash8(classKey)>` (census joins on the full key, names stay short).

Soundness argument (one paragraph, per the charge): the key is a strict superset of the
three key systems that exist today — `_stateKeyOf` (atlas), `_patchSetCacheKey`
(three's program cache), and the bucket-format axis (`f7|f8`) — plus the two axes today
enforced by object identity (side, shadow). Every clone family the row-31 verdict
protects (floorBias `f`, staticBias `s`, cellBaked, acBakedLight `k`, VFX `v#config`,
depth-biased `b`) is a distinct key by its existing bit. Two materials with equal keys
are therefore interchangeable for rendering BY THE SAME ARGUMENT that lets three share a
program between them today — with the one addition (documented trade) that
pool-uniform receiveShadow coarsens the per-placement shadow-receive gate to class
level, exactly as `?buildingBatch` shipped it (buildings.js:112–115).

### S4 — Per-frame cost model (term-denominated; no ms predictions)

| measured term [M] | current scale | pooled scale | mechanism |
|---|---|---|---|
| draw-funnel fixed cost, 37.6 µs/draw, 90% fixed | ~430–510 submitted draws; 71% switch material; 160 program switches / 79 programs | submitted draws = visible (sector, class) pools + kept populations; material binds ≈ classes (shared class material + material.id sort adjacency); program switches bounded by class census | D-07.1/D-07.2 — attacks the SWITCH component, explicitly not priced by draw-count deltas (walls: statArrayMerge 0.0 ms; draws-removed × µs/draw non-predictive) |
| multidraw rebuild, 5.72 ms, 0.348 µs/inst × ~13k, ×4 cameras at ultra | per-frame, every rendered bucket | ZERO on settled frames (three's early-out, all cameras); O(changed instances) on events; translucent share keeps the sorted walk | D-07.4 |
| traversal, 340–450 ns/node × ~4.4k | per-frame | world-static nodes → ≤ ~250 [A]; entity share unchanged (stated floor) | D-07.6 |
| transparent pass 41 µs/draw × 212 | per-frame | v1 unchanged (deliberate); additive-unsort reserved behind eye-gate | D-07.3 |
| p99 link storms, 172–849 ms/link × 43 mid-walk | first-sight materials per streamed LB | class set CLOSED at boot for pooled world; depth variants enumerable; prewarm list = class census | D-07.9 (pass 8 executes) |
| crossing churn (I4/I5 joint) | per-LB re-bucket/re-copy/re-upload | range ops + O(new members) adds | D-07.5 (scored on pass 10's moving bench — no figure claimed) |

### S5 — Storage, budgets, census

1. **Pool geometry storage:** BatchedMesh buffers per pool, `_INIT` sizing per
   static_batch_x (16,384 verts / 256 instances, doubling growth, static_batch_x.js:
   1403–1404) but with pass 4's 24 B/vert indexed layout. Sizing anchor [M+D]: today's
   resident ring carries ~26.6k batched instances over ~324 distinct geometries
   (static_batch_x.js:84–85; frame-cost §5) at mean 66 verts/model (pass 4 S5) ⇒
   deduped pool geometry ≈ 324 × 66 × 24 B ≈ **0.5 MB-class per region worth of unique
   verts** — allocation is dominated by headroom, not content, which is why:
2. **M6 binding:** every pool publishes `allocatedBytes` (buffer capacity) and
   `usedBytes` (used extent — never `position.count`, the §5c allocated-vs-used lesson)
   into `__diag.residency()` per pass 6 H-06.1; allocated ≤ 1.5× used at steady state is
   the M6 gate, enforced by the lazy optimize() compaction threshold.
3. **Census gates (pass 10 wiring):** `pools.count ≤ 300` at settled Nanto (else the
   class key is fragmenting — investigate before shipping) [M: 271 Nanto / 238 TN
   under the page-tier key, T00 re-key 2026-08-09]; `classes.count ≤ ~72` [A;
   measured 63/51 late-burst] with `programClasses.count ≤ ~48` (the class key modulo
   the tex axis — the D-07.9 program population; measured 24/23); `classes.count` reported
   and `classesCreatedPostBoot = 0` after ring settle (D-07.9); `poolMutationsPerFrame
   = 0` on parked frames (S2 invariant); `switchRate` (fraction of draws changing
   material — the 71% baseline) and `programSwitches` (the 160 baseline) sampled by the
   existing renderer instrumentation.
4. **Class arrays:** pass 5 D-05.8 budgets verbatim (≤256 MiB atlas-class total,
   ×1.5 growth, X7 ceilings); pool-array staging mirrors kept (context-loss restore,
   pass 5 D-05.7 table).

### S6 — Deletion ledger (evidence anchors read this session; all staged via pass 9)

| retired | anchor | replaced by |
|---|---|---|
| per-LB consolidation + region×material-object buckets | statics.js:2434–2458; static_batch_x.js:1409 | (sector, class) pools |
| static_atlas as a system (buckets, defer gate, singleton leftovers) | static_atlas.js:1073–1075, 1181–1248; frame-cost §2 54 µs row | class arrays inside pools (D-07.7) |
| statBatchMemo / slack / sphere cache / noSort family | static_batch_x.js:332–610, 1285–1330 | three's early-out (D-07.4) — OBSOLETE |
| statGeomDedup flag + FNV content keys | static_batch_x.js:72–145 | default exact-key dedup (D-07.7) |
| statArrayMerge module + provider (DONE AND DEAD as a frame lever) | static_batch_x.js:164–246; frame-cost §5a banner | class-key unification (different mechanism: state/program terms, not draw count) |
| ?walkInInstance pre-grouping | statics.js:2236–2257 | pools (instancing is intrinsic) |
| building per-placement Group trees + atlas feed + shadow-receive walk | buildings.js:8–13, 134–151; loop.js:2008–2060 | pool members + class-level shadow |
| per-cell Group containers + per-container visibility walk | cells.js:1276–1300, 2243–2265 | per-cell ranges (D-07.8) |
| THREE.LOD wrappers on statics | statics.js:2294 (buildSingletonNode isLod) | band-tick gid swap (D-07.8) |
| LRU statics/atlas/batchX eviction walkers | static_batch_x.js:1651–1690 (membership excise) | (tile, pool) records + grid events |

### S7 — Diag (minimal; pass 10 owns the full spec)

`__diag.pools()`: `{pools: {count, byClass, byPass}, classes: {count,
createdPostBoot}, nodes: {scene, worldStatic, entity}, geometry: {allocated, used,
dedupHits}, events: {feeds, parks, adopts, releases, bandSwaps, cellFlips,
mutationsThisFrame}, draws: {submitted, switchRate, programSwitches}}`. All cumulative
counters diffable by the stall probe (its ring's `d` mechanism, p99 doc).

## Handoffs to later passes

- **H-07.1 (→ pass 8):** Phase order and budgets for: TilePlan feed (STAGED→LIVE
  batches), layer writes, epoch bumps, band tick and cell-flip placement in the frame;
  the closed-class prewarm (color + CSM depth variants, the p99 #1 fix) executed once at
  boot/class-creation — the work list is S5.3's class census; upload scheduling for
  pool buffer growth and optimize() compaction.
- **H-07.2 (→ pass 9):** `?drawPools` staging (default-OFF → battery + 1070 eye-gate →
  default-ON with escape; requires `?slotGrid`); eye-gates owed: first pooled world
  (structural render change — winding/keying classes), building receiveShadow
  coarsening, and the reserved `?poolAdditiveNoSort` arm (frame-cost §5f checklist
  shape); retirement sequencing for the S6 ledger; doc-propagation duty — the
  statBatchMemo/atlas/url-flags rows and static_batch_x's long headers describe the
  superseded world and must be rewritten the day pools flip default-ON (walls: verdicts
  must reach the files agents read).
- **H-07.3 (→ pass 10):** Measurements this pass owes its [A] labels: class-count and
  pool-count census at Nanto + Town Network; switch-rate/program-switch counters vs the
  71%/160 baselines; parked-frame `mutationsThisFrame = 0` gate; sector-cull tri
  inflation vs today (bounded-by +81% claim); translucent-residue population; band-tick
  rate tuning; the fixed-pose MOVING bench as the primary scorecard for D-07.5 (no
  moving figure exists or is claimed — charter Q2).
- **H-07.4 (→ pass 11):** Attack surface flagged deliberately: the ≤300-pool and
  ≤48-class budgets are [A]; the "closed class set" claim assumes surface statics don't
  mint unbounded VFX config tokens (statics.js:1793's configKey — if configs are
  per-DID-diverse the class set fragments; the census gate is the tripwire); the
  sector-cull tri-inflation bound rests on one A/B (§3d) at one site; the traversal
  claim's entity floor.

## Self-check

- **Walls — draws-removed × µs/draw / draw-count proxy:** no ms figure anywhere is
  derived from a draw-count delta; D-07.2/S4 attack the switch/state terms and say so;
  statArrayMerge is cited as DEAD and its mechanism explicitly distinguished. PASS.
- **Walls — merging resident-culled buckets = 0.0 ms:** the pool case is argued on the
  rebuild/traversal/switch/tail terms, never on bucket-count reduction; resident vs
  submitted vs drawn labeled throughout (S4, S5). PASS.
- **Walls — parked-vs-moving:** the memo's −4.00 ms is quoted as term scale with its
  moving-unmeasured caveat restated; D-07.5's moving benefit is explicitly unscored
  pending pass 10's bench. PASS.
- **Walls — 70 ns glue:** no framework-overhead claim; node-count work is aimed at the
  measured traversal term with the entity floor stated. PASS.
- **Walls — allocated ≠ used:** S5.2 mandates used-extent reporting (the §5c lesson
  cited); M6 gate defined. PASS.
- **Walls — flag-bit ≠ predicate / ClipMap:** pass membership is derived from
  post-ladder material state, the failed 77-material arm shown unrepresentable; every
  structural render change (pools flip, additive-unsort, receiveShadow) rides a named
  eye-gate; new flags are exact-match with escapes. PASS.
- **Walls — GPU theories on a CPU-bound frame:** the one GPU-relevant trade
  (tri inflation) is taken WITH its measured numbers and a re-check obligation via
  pass 10; boundedness re-measurement after structural change is inherited from charter
  D-01.5. PASS.
- **Walls — boot variance:** no boot or frame timing claimed measured here. PASS.
- **R1:** read order followed; no prior decision contradicted — D-07.5 adopts pass 6
  H-06.1's proposed default verbatim; D-07.7 discharges pass 5 H-05.2; D-07.8 answers
  pass 6 Q6; pass 4 H-04.3's "pools consume subsets directly" is answered (yes — via
  TilePlan + bundle, no per-model BufferGeometry on the pooled path); charter I5
  kept-degrees restated verbatim (entities excluded, animated scenery on the landed
  path). No SUPERSEDES blocks needed. PASS.
- **R2:** frame phases/upload budgets/prewarm mechanics (8), staging/gates (9), bench
  protocol (10) deferred with proposed defaults. PASS.
- **R3:** writes = this file + own TRACKING.md row. PASS.
- **R4:** every current-code claim carries file:line opened THIS session (Inputs read);
  the flag-trap was live this session — statics.js:2435's comment says statBatchChunk is
  "default OFF" while `statBatchChunkEnabled()` is default-ON (static_batch_x.js:38);
  the `*Enabled()` was trusted per the R4 rule. The wasm-crate trap not touched (no wasm
  internals claimed). PASS.
- **R6:** six sections in order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** concrete module (`pool_registry.js`), key encoding, TilePlan/membership
  formats, transition table, numeric budgets with [M]/[D]/[A] classes. PASS.
- **R8:** unmeasured load-bearers declared (class census, tri inflation bound,
  translucent residue, band tick, VFX config cardinality); no moving figure invented.
  PASS.

## Open questions

- **Q1 — Class cardinality is the load-bearing unknown.** The ≤48-class / ≤300-pool
  budgets are [A]. The measured anchors (7 render states scene-wide, 76 material
  values, 79 programs [M, frame-cost §5/§2]) suggest tens, but the dims axis (pass 5
  TEXREF) and VFX config tokens multiply. One census run over a settled Nanto +
  Town Network session (the S5.3 counters against today's materials) re-classes this
  [M] before implementation sizes anything. [Owner: pass 10 / first implementation
  spike.]
- **Q2 — Translucent residue population.** How many draws remain in the sorted
  translucent path after pooling (and after pass 5's texture changes) determines the
  leftover rebuild + transparent-pass terms. Unmeasured; census with Q1. [Owner:
  pass 10.]
- **Q3 — Sector-cull tri inflation on the real workload.** Bounded-by-+81% is argued
  from one A/B (frame-cost §3d) whose arm disabled per-instance culling WITHOUT
  removing parked instances; pools remove parked instances from the multidraw, so the
  real inflation should be smaller — but "should" is not a measurement. One
  `?drawPools` arm with ktris logged settles it; if T1 ktris regresses the frame into
  GPU-bound territory, re-measure boundedness first (charter D-01.5). [Owner: pass 10.]
- **Q4 — Per-instance layer channel** (D-07.7): would collapse per-(content, layer)
  geometry copies and free the vertex stamp, at the cost of one new shader read + a
  variant. Reserved until the closed-class prewarm is proven (a new variant is a new
  link). [Owner: post-v1, with pass 8.]
- **Q5 — Envcell range-flip cost at dense hubs.** A Town-Network-class renderSet delta
  flips O(cells' instances) visibility bits in one event (1,100+ containers today,
  cells.js:638–640). Amortization (spread flips across ≤2 frames) is trivial to add but
  only if measured necessary. [Owner: pass 10 dense-hub probe.]
- **Q6 — Band-tick parameters** (2 Hz, 8 m move gate, ±10% hysteresis) are engineering
  guesses [A]; the failure mode is visible LOD pop or band-flap churn, both countable
  (`bandSwaps`). [Owner: pass 10.]
- **Q7 — The buildings receiveShadow coarsening** was accepted for the batched
  population in 2026-07 (buildings.js:112–115) but pools extend it to ALL buildings;
  the eye-gate (H-07.2) should include a shadowed-town vantage to confirm the
  already-shipped trade generalizes. [Owner: pass 9 gate.]
