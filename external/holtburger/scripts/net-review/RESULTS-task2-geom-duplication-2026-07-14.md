# RESULTS — Task #2: memo hit-rate + per-model GPU-geometry duplication

**Date:** 2026-07-14 · **Box:** wbterminal laptop (local headless SwiftShader) ·
**Continues:** `HANDOFF-outdoor-run-perf-2.md` §1 (task #2, the gate on #3/#4).
**Probe:** `scripts/net-review/geom-census.mjs` (reusable; `CENSUS_POIS=indoor` variant).
**Raw:** `/mnt/wbterminal2/tmp/geom-census-v3.json` (outdoor), `…-indoor-v3.json` (interior).

## TL;DR — the measurement overturns the #4 premise
The two big static populations are **already de-duplicated**: buildings share one
`BufferGeometry` per `(modelId,partIndex,surfaceDid)` across all LBs via
`buildingBakeCache`, and the bulk of statics are consolidated into per-LB
atlas `BatchedMesh`es. The **true** cross-LB `BufferGeometry` duplication (#4's
target) is **~21 geometries at a 19-LB town** — non-atlased statics only — and
**0 in buildings/cells**. Meanwhile **untracked entity geometry is the dominant
population (825–928 distinct geometries) and grows with traversal** (entities are
not LRU-tracked). **#11 is decisively the top lever; #3/#4 as scoped are near-dead.**

## Method
Local SwiftShader boot (`harness/lib/boot.mjs`, `?nosw=1&nullRender=0`), settle
`terrainBakedLbs.size` to a plateau, then `scene.traverse()` census. Duplication is
keyed by the **full logical mesh identity `(modelId, partIndex, surfaceDid)`** — the
tuple stamped on every static/building mesh (`buildings.js:391`, `statics.js:1249`).
If one identity maps to >1 distinct `geometry.uuid`, those are per-LB rebuilds of the
same sub-mesh = the reclaimable duplication. Statics also carry `landblockId`, so
LB-spread is verified directly (`distinctGeoms == distinctLBs` for every offender).
Geometry duplication is a scene-graph property, independent of the GPU backend, so
SwiftShader is authoritative here (HANDOFF §3d). Iterated the key twice (per-DID →
per-part → full triple) because the coarser keys conflate multi-surface parts with
real duplication — see "Metric validity" below.

## Numbers (outdoor, definitive triple-key census)
| Slice | resident LBs | ri.geometries (GPU) | scene distinctGeoms | DID-tracked geoms | **#4 reclaimable** | entities distinctGeoms |
|---|---|---|---|---|---|---|
| spawn | 9 | 78 | 894 | 85 | **3** | 577 |
| Rithwic | 19 | 109 | 1224 | 116 | **12** | 669 |
| Cragstone | 19 | 116 | 1658 | 162 | **21** | 928 |

Per-group at Cragstone (19 LBs):
| group | meshes | withDid | noDid | distinctGeoms | **reclaimable** | maxDup/identity |
|---|---|---|---|---|---|---|
| statics | 1293 | 41 | 1252 (atlas `BatchedMesh`×209) | 543 | **21** | 4 |
| buildings | 207 | 207 | 0 | 92 | **0** | 1 |
| cells (envcell) | 110 | 67 | 43 | 72 | **0** | 1 |
| terrain | 20 | 0 | 20 | 20 | 0 | — |
| entities | 1147 | 0 | 1147 | 928 | 0 (untracked) | — |

Interior hubs (Marketplace 19 LBs, TownNetwork 25 LBs): statics 100% atlased,
buildings `{1:51}` (all shared), **reclaimable 0** everywhere; entities again dominate
(576 / 825 distinct). Real-dungeon envcells did not stream at those custom POIs (see Gap).

## Findings
1. **CPU triangulation is memoized — #3 is unnecessary for its stated purpose.**
   `MODEL_TRI_CACHE` (`src/lib.rs:8046`, 64 MiB `ByteBudgetLru`) returns the cached
   `Vec<Tri>` on the substitution-free path before any re-decode. No hit/miss counter
   exists (it lives in the bake-worker's wasm instance and isn't surfaced), but the
   code path + AUDIT confirm ~100% hits for repeated static/building decodes. Adding
   a counter needs a wasm rebuild and only *confirms* what the code already proves.

2. **Buildings are already optimally geometry-shared (0 reclaimable).**
   `histPerIdentity = {1: 92}` — every `(modelId,part,surface)` maps to exactly one
   geometry across all LBs. `opts.bakeCache` (`buildings.js:915`) works. The interim
   "77 reclaimable buildings" was an artifact of a per-DID-only key counting
   multi-surface parts as duplicates. **Handoff §2 was correct.**

3. **Statics: real but tiny cross-LB duplication (~21 geoms), and JS-fixable.**
   Proof: `0x020003ea/part0/surf0x800001e` → 4 geometries / 4 meshes / **4 distinct
   LBs** (1 rebuild per LB). But only ~20 static identities escape the atlas; the
   other 1252/1293 static meshes are already consolidated into 209 `BatchedMesh`es.
   The residual is the ~20 non-atlased statics — a JS-only fix (route them through the
   existing atlas / a per-`(id,surf)` shared geometry map), **no Rust refcount needed**.

4. **The geometry/heap mass is UNTRACKED entities — #11 is the top lever.**
   Entities are 928 distinct geometries at Cragstone (largest single population),
   carry no `modelId` the census can attribute, and are **not** LRU-tracked
   (`reapStaleEntities` is grace-gated) so they accumulate during traversal. This is
   ~40× the size of #4's entire universe. Terrain (1/LB) and the atlas source geoms
   are the next untracked contributors. All of this is #11.

## Recommendation (reprioritize the plan)
- **#3 (Rust `MODEL_TRI_CACHE` refcount): DROP.** Its premise (re-decode) is already
  solved; the residual duplication is GPU-side and tiny.
- **#4 (share `BufferGeometry` per model): DOWNSCOPE to a JS-only statics-atlas
  extension** for the ~20 non-atlased static identities (≤~30 geoms at bounded
  residency). Not the "top lever"; not worth cells.js rework or a wasm rebuild.
  The literal cells.js:301/849 envcell target showed 0 dup in every measured slice.
- **#11 (untracked entities + atlas heap): PROMOTE to top priority.** Its first
  sub-step is a *tracked* entity-geometry census (instrument entity mesh identity —
  they don't carry `modelId` today) to size how much entity geometry duplicates by
  setup/wcid and how far it grows across a continuous traversal.

## Metric validity (why the triple key)
A per-DID-only key over-counts: one model splits into many `(part,surface)` sub-meshes,
each a legitimate separate geometry shared across LBs. Coarse keys reported false
"reclaimable" (per-DID: 112; per-(DID,part): 72 for buildings). The full
`(modelId,partIndex,surfaceDid)` key + `landblockId` LB-spread check collapses those
to their true value (buildings 0, statics 21) — every remaining offender has
`distinctGeoms == distinctLBs`, i.e. one rebuild per landblock.

## Gap / caveats
- **Bounded residency, not a continuous 1070 traversal.** All slices are at the
  governor-bounded steady state (~9–25 LBs); the shipped geom governor caps resident
  LBs to ~35 even on the 1070, so the static/building geometry population is bounded
  similarly. The *entity* count is the streaming-dependent variable that grows (not
  LRU-evicted) — which only strengthens the #11 conclusion.
- **Real-dungeon envcells unmeasured.** Marketplace/TownNetwork are custom social
  hubs that render as statics/buildings, not streamed envcells; `?eagerDungeons=on`
  hit the SwiftShader 90 s boot timeout. If #4 is ever revisited for the cells.js
  path, run `geom-census.mjs` with `?eagerDungeons=on` on the 1070 (real GPU, no
  90 s timeout) or teleport into a real AC dungeon.
