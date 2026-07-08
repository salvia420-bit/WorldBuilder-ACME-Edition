# Statics-cull work — Town Network per-frame freeze (2026-07-07)

**Root cause (profiled, CDP through the freeze):** teleporting to a hub dungeon
("Town Network") makes the client crawl at sub-1fps for minutes. It is NOT the
spawn/decode burst — it is the **per-frame statics tick scaling O(total resident
statics)**: `scene3d.staticsGroup` is a flat list walked in full every frame by
`cullStaticsGroup` + `tickStaticsBillboards` + lighting `recordStatics`. At Town
Network the streamer makes **~65 landblocks resident** (`staticsBakedLbs.size`),
i.e. ~50k static nodes, each frustum-tested every frame.

## ✅ Step 1a — indoor PVS-ring gate (LANDED, the effective fix)

`scene3d/cells.js` `tickPvsLoadExpansion`: when `sessionHandle.isCurrentCellIndoor()`
is true, collapse the prefetch ring from the outdoor radius-5 (11×11 = 121 LBs)
to `INDOOR_PVS_RING_RADIUS` (default 1 = a 3×3 skirt). A dungeon has no
line-of-sight to the surface LBs the ring pulls; the render-set (`getRenderSet`)
is baked regardless of ring radius, so anything the PVS actually sees still
loads. Default-ON; `?indoorPvsRing=N` overrides (`=0` render-set only; `=N ≥
pvsRingRadius` disables). Zero effect outdoors.

**Verified (headless, Town Network, gate ON vs `indoorPvsRing=5`):** resident
landblocks **65 → 6 (−91%)**, sustained >100 ms hitches 9 → 2, entities
unaffected (177), 0 errors, `isCurrentCellIndoor: true` (gate fires). Because
every per-frame statics walk AND all bake work scale with resident-LB count,
this ~11× residency cut resolves the reported dungeon freeze at the source.
**Owed:** a 1070 pixel eye-test (nothing visibly missing at a dungeon
mouth/portal where surface is visible through the render-set).

## ❌ Step 2 — landblock-bucketed cull (ATTEMPTED, REVERTED — measured dead end)

The design (buildbox 16-agent `FINAL_DESIGN.md`, agents 05/06) recommended a
per-LB bucket index: one aggregate-sphere frustum test per landblock gates the
whole bucket → O(N_LBs + N_in_frustum). Implemented as a rebuild-on-drift index
in `cullStaticsGroup` with a conservative union sphere (exact visible set).

**It does not work for this scene — measured, not guessed.** At 65 resident LBs
(50,843 nodes): **only 52 buckets vs 49,092 nodes in the cross-LB tier (96%)**,
`perCallMs` unchanged (~7.9→9.0 ms). Reason: the statics are **cross-LB
INSTANCED** — the ~50k `InstancedMesh`/LOD consolidation nodes carry a
`coversLbKeys` **Set of size > 1** (one InstancedMesh spans many landblocks, the
statAtlas/cross-LB-consolidation trade of draw-calls for un-bucketable nodes),
not a single `userData.landblockId`. A salvage bucketing `coversLbKeys.size===1`
nodes moved almost nothing (they are genuinely multi-LB). Per-LB spatial
bucketing therefore cannot group them; the cost is ~50k individual frustum tests
on cross-LB aggregate spheres, 94% of which cull (so the cull is doing real
work — dropping ~46k draws — it is just O(nodes)).

Reverted (`git checkout statics.js`) to avoid shipping index-rebuild overhead
with no payoff. **This is the `verify-agent-leads` discipline paying off: the
design's per-LB-bucket premise was false for the real node structure.**

## Remaining levers for the per-frame cull (future, only matters for a large
## OUTDOOR view — the dungeon case is fixed by 1a)

1. **Residency is the real lever** (Step 1a already applies it indoors). An
   outdoor residency cap (size `maxResident` to the working set, not the ~203
   ring ceiling — `FINAL_DESIGN` secondary) would cut N outdoors too.
2. **Fewer instanced nodes** — coarser consolidation (fewer, larger
   `InstancedMesh`) cuts the per-node frustum-test count directly.
3. **Spatial hash on node aggregate-sphere CENTERS** (NOT landblockId) — the
   only hierarchical cull that fits cross-LB instanced nodes. Bigger redesign;
   large multi-LB spheres cull poorly, so payoff is uncertain — measure first.
4. Secondary (orthogonal, still open): missing-surface negative cache
   (`0x08F00001` warned 569×/90s — `FINAL_DESIGN` agent 11).

Full design corpus: `~/from-vm/statics-cull-wf/` (`FINAL_DESIGN.md` + 16 parts).

## ✅ 2026-07-07 follow-up outcomes (next-pass session)

Both remaining OUTDOOR levers were investigated **measure-first**. That overturned
the premise for each — one produced a shipped fix, one was declined.

### "Missing-surface negative cache" (lever 4 / secondary) — SHIPPED, as a Rust in-wasm cache
Surfaces confirmed GENUINELY absent (base DAT `chorizite-parse-dat-record` →
`0x08F00001` / `0x08F0000A` / `0x08F000B3` "not present"), so memoising them is
safe. **The JS-only `MaterialCache.missingSurfaces` cache (the corpus / agent-11
recommendation) is measured INEFFECTIVE:** the dominant spam is the
**bake_worker decoding statics in its OWN wasm instance**, which the main-thread
cache structurally cannot reach (isolated `surfaceNegCache` ON: 162 warns /
`missingSize 0`, identical to OFF). Instrumentation: **673 worker warns vs only
~12 zero-dim results reaching main-thread `_installFromPixels`**. Root fix: an
in-wasm `thread_local HashSet<u32>` in `fetch_surface(s)_pixels`, populated only
at final decode (`!in_discovery_walk()`), so it fires **per-wasm-instance —
worker included**. Validated (worker on, release wasm): warns now **equal
distinct-DIDs** (once each; was 2.8× avg / 14× max), **0 warns on a warmed
revisit**, 0 errors, **zero visual change** (byte-identical empty fallback for
DAT-absent records). Landed in `src/lib.rs` (`MISSING_SURFACES` +
`surface_neg_cache_contains`/`_insert` in both surface impls) and
`scene3d/materials.js` (the JS twin, kept as the main-thread/entity complement);
`?surfaceNegCache=off` escape. The Rust memo is unconditional (provably safe).
**Needed a wasm rebuild.**

### Lever 1 "outdoor residency cap" — MEASURED, NO ROI, declined
**The O(total-resident) / ~7.7 ms cull is a Town-Network-DUNGEON artifact**
(indoor un-consolidated cell statics — 52,766 nodes, only 3.3% with
`landblockId`), already resolved by Step 1a. A REAL outdoor town (Arwic,
isolated single-teleport) stabilises at **121 resident LBs / ~3,230 nodes** (500
cross-LB `BatchedMesh` + 736 plain + ~2k containers; 68% carry `landblockId`)
with `cullStaticsGroup` = **0.17 ms** — reproducible, no thrash, 0 errors.
Outdoor statics CONSOLIDATE, so the outdoor cull is already negligible; the
handoff's "outdoor → ~50k nodes → ~9 ms" was an untested extrapolation from the
dungeon census. Capping outdoor residency below the radius-5 (121-LB) ring would
trim an already-negligible 0.17 ms while risking visible pop, and the F2/Goal-1
`lbCap` already self-sizes to 203. **Not implemented** — same
`verify-agent-leads` outcome as the Step-2 dead-end.

## 🔴 THE REAL leak — default_script particle billboards (found by a POI battery, FIXED)

A follow-up **62-POI `@telepoi` battery** (one continuous session, per-stop
main-thread-freeze + residency + cull diagnostics; script kept at
`scripts/perf-worker/` / scratchpad `poi_battery.mjs`) surfaced the true
pathology the earlier per-frame-cull analysis had circled: **a statics-node
LEAK**. As you roam, resident landblocks stay pinned at the LRU cap (203) but
`scene3d.staticsGroup.children` grows **MONOTONICALLY, 573 → ~114,000**, driving
`cullStaticsGroup` **1 → 25 ms/frame** and the teleport freeze **150 ms → 5.2 s**
— and it keeps worsening the longer you play (revisiting a town did NOT reclaim:
Holtburg 573 → 70,672 on revisit).

**Root cause (workflow-mapped, live-probe-confirmed — NOT the initial guesses of
plain Meshes / cross-LB BatchedMesh buckets):** the leaked nodes are 100%
`particle-unlit-*` billboard quads from **`default_script` ambient emitters**
(braziers/torches/fountains/gemSparkle). The static `ParticleManager`'s scene IS
`staticsGroup` (statics.js:3579), so emitter billboards are direct
`staticsGroup` children; `attachStaticDefaultScripts` / `…World` registered them
under a per-anchor monotonic owner key `static:${++_staticOwnerSeq}` instead of
`staticOwnerKeyForLb(landblockId)`. The per-LB teardown `_evictStaticParticlesForLb`
destroys owner `static:<lbKey>`, which **never matches** `static:<seq>` → billboards
never reaped. (The sibling `attachParticleEmitters` seam already keys correctly.)

**Fix (SHIPPED, default-on `?staticParticleEvict`):** re-key the `default_script`
emitters to `staticOwnerKeyForLb(landblockId)` (statics.js outdoor + interior;
`cells.js` threads `landblockId` into the interior data) so LB eviction reaps them
via the tested `destroyAllForOwner` → `destroyParticleEmitter` path (which disposes
the per-slot material + syncs the particle table — a raw `staticsGroup.remove`
would leak both, so approaches A/B were rejected). An adversarial review
(ship-with-fixes) caught one production gap: emitter registration into
`ownerRegistry` was gated by `particleOwnerOn()`, which is **false on a bare URL**
(empty `location.search`) → fix inert in production; closed by also routing through
the registry when `_staticParticleEvictEnabled()` is on.

**Verified (headless, both `particleOwner` on AND off):** node growth now RISES
AND FALLS with the per-town working set (reclaims to ~5–10k) instead of the
monotonic ratchet; 62-POI battery bounded at 5–14k (was stuck 70k+ climbing to
114k), cull 0.17–1.4 ms (was 15–25 ms), 0 particle-teardown errors, revisit
bounded. Residual: transient dense-town spikes (~30–59k) during *rapid* back-to-back
teleports (eviction lag before old LBs roll out of the 203-window) that drop the
moment you move on — much smaller in real walking play, and the peak freeze
(~1.9 s transient) is well under the pre-fix 5.2 s that kept worsening.
