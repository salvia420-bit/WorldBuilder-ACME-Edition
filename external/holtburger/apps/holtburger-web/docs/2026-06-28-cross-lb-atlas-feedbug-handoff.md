# Handoff — cross-LB static texture-atlas: implemented (default-off), under-delivers (FEED BUG) — 2026-06-28

## TL;DR
An ultracode workflow (15 agents) implemented the cross-LB texture-array static batcher (the real-win design from the 2026-06-27 perf handoff). It is behind `?statAtlas=on` (DEFAULT-OFF; flag-off byte-identical — review PASS), the eviction mechanism is verified-correct against three r184 BatchedMesh source, and the shader is visually correct on the 1070. **BUT it currently under-delivers**: only ~115 singletons get atlased; ~6,136 atlas-able singletons stay unbatched (fps ~9, no real gain). Root cause is a **FEED bug**, not capacity. Fix the feed and this should deliver the cross-LB win (~5,400 draws → dozens).

## What's implemented (behind `?statAtlas=on`, default-off)
- `scene3d/static_atlas.js` (+292): cross-LB `BatchedMesh` per **global size bucket** (`stat-atlas-x-WxH|transparent|alphaTest`). `addSingletonsToCrossLbAtlas(nodes, scene3d)` feeds buckets; per-vertex `aLayer` shader reused unchanged (BatchedMesh applies the per-instance matrix, so the `applyMatrix4` bake was dropped). `_addInstanceGrow`/`_addGeometryGrow` grow on demand. `evictStaticAtlasForLb(lbKey)` → `bm.deleteGeometry(gid)` per member (same-frame drop, no orphan; `_lbMembership` index). `tickStatAtlasOptimize()` lazy `bm.optimize()` compaction.
- `scene3d/statics.js`: ring feed (`addSingletonsToCrossLbAtlas(ringSingletons,...)`) + a per-LB walk-in seam (gated `!hasAtlasLb(lbKey)`).
- `scene3d/landblock_lru.js` (+8): `_evictStaticAtlasForLb(lbKey)` hook called on LB evict (after `_evictStaticParticlesForLb`).
- `scene3d/loop.js` (+7): `tickStatAtlasOptimize()` off the ~10 Hz PVS path.

## Validation (1070, `?statAtlas=on`, Holtburg via teleport)
- Flag-off byte-identical (review PASS); shader visually correct; eviction verified.
- **Bucket query (scratchpad/q.mjs):** 21 buckets, **totalInst=115**, **unbatchedSingletons=6,136**. Buckets are NOT capacity-limited (`maxInstanceCount=1024`, `nextLayer < capacity`). Per-size counts ~12-20 ≈ **a single landblock's worth**.

## ROOT CAUSE = feed, not capacity
Only ~one LB's singletons reached the atlas. The buckets exist and have room; the bulk of singletons never get fed. Strong hypothesis: the test **teleported** into Holtburg, so the boot **ring** (`bakeStaticsRing` → `ringSingletons` feed) built at the autoSpawn location, not Holtburg; the teleport triggered **per-LB** baking (`bakeStaticsForLandblock`), and the per-LB walk-in seam fed only ~115 (a few LBs) — the rest stayed plain.

### Next steps (do these)
1. **Confirm the ring feed works**: load spawning DIRECTLY at Holtburg (no teleport) and re-run q.mjs — expect totalInst ≈ ~5,400 if the ring feed is correct. If yes, the ring path is fine and only the per-LB seam under-feeds.
2. **Fix the per-LB seam** (`statics.js` ~1990, the `if (statAtlasEnabled() && !hasAtlasLb(lbKey))` block): verify it routes ALL of that LB's atlas-able singletons (the qualify filter), and that `bakeStaticsForLandblock` actually runs for every resident LB after a teleport (only ~115 reached it — check whether most resident LBs are baked via the ring vs per-LB, and whether `hasAtlasLb`/`staticsBakedLbs` short-circuits suppress the feed).
3. Re-validate: q.mjs totalInst should approach the unbatched count; meshNodes should drop toward ~1,500; fps should rise.

## Review CONCERNS to also fix (from the workflow's adversarial pass)
- **Medium — hook-identity gap:** `_evictStaticAtlasForLb` is installed on the `scene3d` the baker received; install it on the object the LRU actually reads (or `window.liveScene3d`) so aggressive eviction can't orphan. (`evictStaticAtlasForLb` itself uses module state, so it's just which object carries the property.)
- **Low — `?staticBatch=on` + `?statAtlas=on` collide:** the atlas seam may receive already-`BatchedMesh` nodes; skip `node.isBatchedMesh`/`__staticBatch` in the atlas filter.
- **Low — optimize trigger** compares dead vs buffer CAPACITY not used-extent; use `_nextVertexStart`/used extent.
- **Info — albedo-only:** atlased path drops normalMap (slightly flatter); add a parallel normal DataArrayTexture as a follow-up.

## Harness
`?statAtlas=on&renderDiag=on`; bucket query `scratchpad/q.mjs` (counts `__statAtlasCrossLb` BatchedMesh `_instanceInfo` active + scene unbatched singletons). LB-crossing leak test: teleport away+back, watch `renderer.info.memory.geometries` (stayed ~stable in test → no obvious leak). 1070 driving recipe: see MEMORY.md §1 "1070" / the 2026-06-27 perf handoff. Full workflow result (design rationale, eviction proof vs r184): the `static-stream-rearch` workflow run `wf_5410af9d-711`.
