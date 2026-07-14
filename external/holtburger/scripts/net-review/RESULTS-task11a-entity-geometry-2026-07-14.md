# RESULTS — Task #11a: entity-geometry census

**Date:** 2026-07-14 · **Boxes:** wbterminal laptop (SwiftShader census) + 1070 real-GPU (growth walk) ·
**Continues:** `RESULTS-task2-geom-duplication-2026-07-14.md` (which promoted #11 to top lever).
**Probes:** `scripts/net-review/geom-census.mjs` (`entityCensus` pass), `walk-entgrowth.mjs` (1070 walk),
and an `entGeom` field added to `battery-outdoor-run.mjs`'s FULL sampler ·
**Raw:** `/mnt/wbterminal2/tmp/geom-census-entities.json`, `/mnt/wbterminal2/tmp/walk-entgrowth.json`.

## ⚠ CORRECTION (2026-07-14, superseded by the corridor walk — see RESULTS-task11b)
The first draft claimed entity geometry "grows unbounded, never evicted (579→2525,
4.4×)." **That was wrong** — a measurement artifact. The walk that produced it
**stalled on an obstacle after ~70 m / 1-2 LBs** (held-`w` with no nudge), so the
579→2525 rise was mostly the **spawn backlog draining** after the teleport, and the
"flat at 2525 while stationary" was **correct** behaviour (the player was still 1-2
LBs from those entities — they're in range, keep them), NOT an eviction failure.
A later obstacle-free **corridor walk** (RESULTS-task11b, 88 LBs traversed) shows the
reaper **does work**: at the shipped radius 8, entity geometry peaks ~3875 then drops
to ~1214 once the town falls 8 LBs behind. Entities are a large geometry *count* but a
**small heap fraction** (heap is terrain-dominated). Keep the two facts below (still
valid); ignore the growth/eviction claim.

## Still valid
Entities are the **largest single geometry population** (366–928 distinct
`BufferGeometry` at a bounded town) and entity geometry is **per-instance, not
shared** (same wcid in 2 LBs = 2 geometries). What was wrong was the *unbounded /
never-evicted* framing.

## Method
Extended `geom-census.mjs` with an `entityCensus` pass. Entity identity (`wcid`) is
on the entity ROOT group (`entities.js:3527`, `userData.modelId = wcid`); part
meshes carry `{guid, partIndex, surfaceDid}` (`entities.js:3923`). The pass
propagates the root wcid down to each descendant mesh and keys geometry by
`(wcid, partIndex, surfaceDid)`, tracking distinct `geometry.uuid`, instance count,
and distinct `landblockId` per key. "Reclaimable if shared by setup" = geometries
eliminable if one geometry per `(wcid,part,surface)` were shared across instances.

## Numbers (outdoor, 3 teleport slices)
| slice | LBs | entityRoots | meshes | uniqueWcids | distinctGeoms | reclaimable(by wcid) | maxDup |
|---|---|---|---|---|---|---|---|
| spawn | 6 | 175 | 826 | 175 | 784 | 0 | 1 |
| Rithwic | 15 | 175 | 826 | 175 | 784 | 0 | 1 |
| Cragstone | 24 | 33 | 416 | 16 | 366 | 37 | 2 |

## Findings
1. **Entity geometry is per-instance (not shared across spawns).** At Cragstone,
   wcid `0x168c` = 2 instances in 2 LBs → **2 distinct geometries** (`maxDup=2`).
   `animation.js`'s "shared across spawns of the same setupId" applies to the
   animation clip / skeleton, not the render `BufferGeometry` (or sharing is
   defeated by per-instance pose/motion-state baking). Empirically each spawn
   carries its own geometry.
2. **Entities dominate the geometry population.** 366–784 distinct entity
   `BufferGeometry` at a bounded town, several × the static+building total. Since
   #4's static/building duplication is already ~solved (RESULTS-task2), entities
   are the geometry/heap lever.
3. **Reclaimable-by-wcid is content-dependent.** A town is mostly *unique* NPCs
   (spawn: 175 roots / 175 wcids → 0 dedup), so wcid-sharing saves little there.
   But a monster field spawning one creature ×N would show high duplication
   (Cragstone already shows repeated wcids reclaiming 37). Dedup payoff scales
   with how many same-type creatures are co-resident.
4. **Unbounded across traversal.** Entities are not LRU-tracked
   (`reapStaleEntities` grace-gated), so each new area's NPCs add hundreds of
   geometries. The exact growth is unmeasured here because discrete teleports
   *despawn* (826→826→416, nondeterministic) rather than accumulate — a
   continuous held-W walk is required to see the monotonic curve.

## Growth curve — 1070 real-GPU continuous walk (`walk-entgrowth.json`)
`walk-entgrowth.mjs`: CDP-attach to the off-screen 1070 Chrome (asserted
`ANGLE (NVIDIA GeForce GTX 1070 Direct3D11)`), `@teleloc` Cragstone, hold `w`
(trusted `page.keyboard`) 150 s, sample every 2 s.

| t (s) | landblock | entGeoms | entRoots | resident LBs | heapMB |
|---|---|---|---|---|---|
| 0 | 0xbb9f0040 | 579 | 51 | 121 | 1209 |
| 11 | 0xbc9f0035 (…4 LBs crossed) | 2182 | ~130 | ~130 | ~1450 |
| 21 | 0xbc9f0035 | 2525 | 153 | 132 | ~1480 |
| 21→150 | **stuck** at (151.5,106.8) | **2525 (flat)** | 153 | 132 | 1340–1527 |

Read: ~250 m of walking across 6 LBs in ~21 s added **+1946 distinct entity
geometries (579→2525, 4.4×)** — ~**+325 geoms/LB** — while resident landblocks rose
only 121→132 (governor bounding them). The character then stalled on an obstacle
(held-`w` kept pressing; pose frozen); entity geometry **stayed at 2525 for 137 s**.
That flat-while-stationary segment is the key eviction proof: entities from LBs the
player already left are retained indefinitely. Extrapolating the ~325 geoms/LB slope,
an unobstructed cross-country run reaches many thousands of entity geometries — the
untracked-heap growth the landblock governor cannot bound.
(Caveat: the walk stalled at ~21 s, so the *slope* comes from the first 6 LBs; the
*no-eviction* result is independent and strong. A longer obstacle-free corridor —
via the battery driver's corridor picker once its 1070 teleport-land is fixed — would
extend the line but not change the conclusion.)

## Recommendation for #11b
Two complementary levers, size them on the growth measurement first:
- **(A) Bound entity residency** — an LRU/eviction budget for entities mirroring
  the shipped landblock geom governor (evict entities far from the player / in
  parked LBs). This directly caps the unbounded-growth failure and is the higher-
  value lever for continuous traversal.
- **(B) Share entity geometry by `(setupId, part, surface)`** — a refcounted cache
  so co-resident same-type creatures share one geometry. Payoff is content-
  dependent (high in monster fields, low in towns).
Also fold in `static_atlas.js:334` BatchedMesh grow-never-shrink (a separate
untracked contributor).

## Growth measurement — DONE (see curve above)
The monotonic-growth / no-eviction hypothesis is **confirmed** on the 1070.
`entGeom` is now wired into `battery-outdoor-run.mjs`'s FULL sampler, so a future
full battery run (once the driver's 1070 corridor teleport-land is fixed — it
reported `teleOk=false` this session, unrelated to the entity finding) will produce
an obstacle-free extended curve for the #19 A/B. Not required to proceed with #11b.

## Caveats
- Local SwiftShader, bounded residency, discrete teleports (despawn noise). The
  distinct-geometry *counts* are scene-graph facts (backend-independent); the
  *growth curve* is the piece that needs the continuous-walk run.
- Entity population varies run-to-run (streaming/backlog timing): treat the per-
  slice counts as order-of-magnitude, not exact.
