# T22-PRODUCER — the producer swap (ST9, `?drawPools`)

T22 landed the ST9 **substrate** with nothing feeding it. This task is the
**producer swap**: the live world producers now build (sector × class)
`BatchedMesh` pools, so **an actual pooled world exists** — the honest
prerequisite E6 was missing. A headless SwiftShader arm on the deployed pack
dist reads **51 pools / 17 classes / 33 resident tiles,
`classesCreatedPostBoot = 0`, parked `mutationsThisFrame = 0`, 0 console
errors**.

Two residues stay on the LEGACY producer, counted and rendered, never dropped:
members whose texture is not at their class's PAGE dims (the D2 gate — a
concurrent task owns the bake/transcode resample) and the whole ENVCELL domain
(recorded remainder, with its three read-verified blockers below).

## Shipped

| file | commit | what |
|---|---|---|
| `scene3d/pool_material.js` (new) | `473c056b` | the class-material tier: classKey → ONE array PAGE at page dims + ONE `makeArrayMaterial` material + a refcounted layer per member surface; the **D2 `needsResample` gate** and every other refusal counted |
| `scene3d/tile_plan.js`, `scene3d/pool_registry.js` | `473c056b` | additive: D-07.6's pool-uniform shadow flags on the plan member + stamped on the pool `BatchedMesh` |
| `scene3d/pool_producer.js` (new) | `52f8d82d` | `addSingletonsToPools` (the atlas's own seam), the grid's four event hooks, `poolTickP4`, the pool `atlasRefeed` handler, `poolWorldCensus` |
| `harness/test_draw_pools.mjs` | `52f8d82d`, `d7a035ba` | battery 333 → **396** (PARTs 17–19 + the PART 10 split) |
| `scene3d/statics.js` | `cfd4bc1d` | **swap 1/3** — the per-LB baker feeds pools ahead of the `?statAtlas` seam |
| `scene3d/buildings.js` | `3340c79f` | **swap 2/3** — `_feedBuildingGroupsToAtlas` feeds pools first (covers both call sites) |
| `scene3d/index.js` | `d7a035ba` | arm the pooled world; **the four SlotGrid hooks, unwired since T20**; `poolTickP4` in the P4 slot (rAF + `?netDrainHz` drivers); prewarm + `sealClassSet()` when the boot ring settles; `__diag.pools` = the producer census |
| `harness/lib/diag_schema.mjs`, `harness/test_diag_schema.mjs` | `d7a035ba` | **T22 D6 closed**: `__diag.pools` + `__prewarmStats` reserved → current (+ the producer's own rows); 5 drifted `evidence:` lines corrected |
| `docs/url-flags.md` | `d7a035ba` | §0 status row + §4 `drawPools` row restated |
| `scene3d/pool_producer.js`, `scene3d/static_atlas.js` | `0b8d98e8` | **three live-arm fixes** (below); `static_atlas.js` gains one word (`export`) and no behaviour |
| `scene3d/pool_producer.js`, `scene3d/pool_material.js`, battery | `4d9ddbd8` | **the TEXREF page stitch** (PAGE-RESAMPLE Handoff #2): pooled members key on the DECLARED page dims, `FULL_PAGE_DIMS` as authority; battery 396 → **413** |

Seven bisectable commits, in producer order: `473c056b` → `52f8d82d` →
`cfd4bc1d` (statics) → `3340c79f` (buildings) → `d7a035ba` (wiring) →
`0b8d98e8` (live-arm fixes) → `4d9ddbd8` (the TEXREF page stitch). Nothing pushed. The concurrent PAGE-RESAMPLE
task's commits interleave; none of its files were staged by this task.

**OFF-arm argument.** Every new call in a pre-existing production file is
behind `poolWorldActive()`, which is false unless `initPoolWorld` armed —
and `initPoolWorld` refuses unless the full F-11.3 chain is authored.
`statics.js` and `buildings.js` gain only guarded blocks; two `buildings.js`
gate expressions widen by `|| poolWorldActive()`, which with pools inactive
evaluate to exactly their old expression. `index.js`'s additions are
unconditional but inert: `initPoolWorld` returns null and constructs nothing,
`__diag.pools()` reads `{enabled:false}`, `poolTickP4()` returns on its first
line, and the SlotGrid hooks only exist when `?slotGrid` is armed and no-op
without pools. The proof that the OFF path is unchanged is the suite set: every
neighbour suite listed under "Tests run" runs the OFF path (no flags) and is
green, and battery PART 18 asserts a disarmed world passes every node through
untouched. A live OFF boot was **not** run — the task's one-browser budget was
spent on the ON arm.

## Spec conformance

The orchestrator's acceptance list for T22-PRODUCER:

| bullet | status | evidence |
|---|---|---|
| per-producer bisectable commits | **MET** | one commit per consumer in the T13 shape: `cfd4bc1d` statics, `3340c79f` buildings; envcells is the recorded remainder (Deviation D3) |
| T22 battery extended — `classesCreatedPostBoot === 0` on a settled arm | **MET** (battery + LIVE) | PART 19 asserts it after `sealClassSet()` + a stream of an existing class; the live arm reads `createdPostBoot=0, sealed=true` |
| … parked `poolMutationsPerFrame === 0` | **MET** (battery + LIVE) | PART 19 asserts it on a settled frame AND after a bare `poolTickP4()`; the live arm reads `mutationsThisFrame` 0 and 0 on two reads 1.2 s apart on a settled scene |
| … `needsResample` members counted on the legacy path | **MET** (battery + LIVE) | PART 17/18 assert the refusal, its counter and the passthrough return; the live arm reads `classPages.refused.needsResample = 85` with the nodes rendering on the atlas/singleton path |
| OFF arm proven | **MET by suites + diff, live OFF arm NOT run** | see the OFF-arm argument above; honest limitation stated |
| ONE headless SwiftShader live arm, full flag chain, agentp09, no `renderOnDemand`, registry diag read | **MET** | `/mnt/wbterminal2/reeng/T22P/live-on-nanto-2026-08-101638.json`; chromium closed by the harness, verified no stray process |
| census sanity: classes ≤ ~63, pools ≤ ~300 | **MET at this scale** | **17 classes / 51 pools** over 33 resident tiles — well inside both bounds, but see Deviation D4: these are the counts of the POOLED SUBSET, not of the whole world, so they are a floor, not the T00 comparison |
| E6 / benches | **DEFERRED-TO-BATCH** | owner eye + 1070 (unchanged); E6 is now *runnable* for the first time — a pooled world exists |

SPEC §3 T22's own charge items that this task closes, from the T22 report's
Handoffs list: **2** (`getClassMaterial` class tier — landed as
`ClassMaterialRegistry`), **4** (grid → pool wiring — the four hooks),
**5** (the producer swap — statics + buildings), **6** (`atlasRefeed` pool
handler), **7** (the diag registry flips). **1** (page-dim resample) is the
concurrent task's. **3** (the worker-side record → axis ladder) stays open —
see D1.

## Deviations

**D1 — the class is derived on the MAIN thread, not in the bake worker
(pass-07 D-07.5).**
D-07.5's sentence is "the main thread never derives a class". T22's own D1
recorded why the worker half is a task of its own: resolving a pack surface
record into an axis record off-thread means reproducing `materials.js`'s
builder ladder (`applyClipMapRenderState`, the `_patchSetCacheKey` installers,
the MECH-B VFX `set#config` token) in the worker, whose failure mode is SILENT
visual divergence between arms. Minimal sound thing done: `addSingletonsToPools`
builds the axis record with `axisRecordOf(mat, …)` from **the resolved material
the legacy producer would itself have used**, so the pooled arm and the legacy
arm cannot disagree about render state — they read the same object. The class
KEY is still produced only by `classKeyOf`, through the landed `buildTilePlan`,
so census / prewarm / runtime agree byte-for-byte. The relocation off-thread is
now a *relocation with a live pooled world to differ against* rather than a
rewrite with nothing to check it. `tile_plan.js`'s injected `resolveAxes` seam
is unchanged and is where the worker half will plug in.

**D2 — class-page layers are SESSION-RESIDENT in v1 (never recycled).**
The registry's membership record refcounts by rsId, not by source-texture uuid,
so a tile release cannot name the layers it held without a second ledger. A
layer handed back while another tile's instances still sample it renders someone
else's texture — precisely the failure the layer-write invariant exists to
prevent. v1 therefore keeps layers for the session: bounded by the unique-surface
population, ceilinged by `_layerCapacityFor`, and the ceiling's `layerFull`
refusal is the counted fail-soft (**0** on the live arm). `release()` is
implemented and documented; the uuid ledger lands with the tile-scoped release.

**D3 — the ENVCELL swap is NOT landed; it is the recorded remainder.**
Read-verified this session, three blockers make it a task of its own rather
than a third one-line call site:
(a) `cellsGroup.layers.set(RENDER_LAYER_INDOOR)` (`index.js:1441`) and
`container.traverse((o) => o.layers.set(1))` (`cells.js:1642`) — pooled meshes
attach to the registry's single `group` (staticsGroup, layer 0), so an
interior pool on layer 0 breaks the depth-clear split
`atmosphere_pipeline.js` performs between layers;
(b) per-cell visibility is `container.visible` per cellId
(`cells.js:2233-2237`), and its pooled equivalent is
`registry.cellSetChanged(tileKey, renderSet)` — which EXISTS (D-07.8, battery
PART 8) but is unwired;
(c) `tickPortalStencil` / `tickPortalPunch` / `tickPortalSeal` walk cell
containers.
Designed shape for the follow-up: a `groupFor(domain)` dependency on the
registry (a second, layer-1 pool group under `cellsGroup`), `__poolCellId`
stamped by `buildEnvCellsForLandblock` (the producer already reads it —
`pool_producer.js` passes it straight into the plan), and the renderSet tick
calling `cellSetChanged`. Landing it unvalidated behind a flag I could not
eye-test (one-browser budget spent) would have been the papered-over kind of
"done"; I9 says report it.

**D4 — the live census counts the POOLED SUBSET, so it is a floor, not the T00
comparison.**
17 classes / 51 pools are the classes and pools that pooled MEMBERS created.
666 of 815 offered nodes were refused (bc7Pending 363, deformed 218,
needsResample 85) and render legacy, and the envcell domain never reached the
producer at all. T00's 63 classes / 271 pools counted the WHOLE resident
population. The two numbers are not comparable until the residues close; what
the live arm establishes is that the pooled population is *within* the bounds
and that the closed-class law holds on it. The GATE-POOLS 1070 confirm arm
should re-read this after the resample + envcell swap land.

**D5 — the arm's settle detector never plateaued (`settled: false`), while the
GRID reports the boot ring settled.**
The harness's signature (`lbs|meshes|pools|classes`) still moved at 148 s
(terrain streaming under SwiftShader at ~1 fps). The grid's own criterion —
zero FETCHING, zero STAGED, ≥1 LIVE — DID fire, which is what drove the prewarm
and `sealClassSet()` (`sealed: true`, `prewarm.complete: true`, 36/36 slots
LIVE). The counters that matter for this task (`createdPostBoot`,
`mutationsThisFrame`) were read after the seal, on a scene whose pool population
had stopped changing. Recorded rather than smoothed: the run is tainted
`settled:false` for any figure that needs a plateau, and none is claimed.

**D7 — the TEXREF page stitch takes two deliberate refinements on the shape
PAGE-RESAMPLE prescribed** (commit `4d9ddbd8`; its Handoff #2 asked for
`texRef: { w, h, compressed: true }` and for `onPage === false` to force the
legacy path).
(a) The `f7|f8` format bit comes from the LIVE texture (`isBc7AtlasTexture`),
not asserted `true`: that axis must match what the class PAGE actually
allocates, or two members could share a class key while needing different
`texStorage3D` internal formats — the one thing D-07.2 says a class must never
do. Since a member is admitted only when its resident dims equal its declared
dims, and the compressed-only arm's world materials are born BC7, this reads
`true` in every admitted production case anyway.
(b) `onPage === false` does not by itself route legacy; **DECLARED ≠ RESIDENT**
does, whichever way the bit reads. That is the hazard the report actually names
— a member whose dims will move when its full tier lands must not take a page
layer now, or the refeed reads a dims mismatch and it keeps its preview texels
for the session. Refusing on the bit alone would instead have collapsed the
pooled world to ~0 on today's PRE-resample dist, where the bit is clear
everywhere: it would have zeroed the 51-pool arm measured above. The trap the
report warns about (a 1096² member whose byte rounds to a convincing 2048²) is
closed either way, because the declared dims are read ONLY when the bit is set.
The refusal has its own reason, `offPage`, so it is never conflated with the D2
`needsResample` residue, and four counters (`producer.texRefPageKeyed /
texRefOffPage / texRefAbsent / texRefDimsWillMove`) publish the populations —
which is how a future page-dim dist will be seen to work. **NOT live-verified**:
the one-browser budget was spent before this landed. On today's dist
`texRefPageKeyed` is expected to be 0 and behaviour unchanged, which is what the
neighbour suites show.

**D6 — one out-of-scope edit.** `scene3d/static_atlas.js` gains the word
`export` on `_atlasRefeedImpl` (live-arm fix 1). No behaviour changes; the
reason is in the file.

## Tests run

Node, from `apps/holtburger-web/`, all on this HEAD.

| command | result |
|---|---|
| `node harness/test_draw_pools.mjs` | **413 passed, 0 failed** — DRAW-POOLS ✅ (20 PARTs; 333 → 413) |
| `node harness/test_diag_schema.mjs` | **69 passed, 0 failed** ✅ (the `evidence:` re-verification caught all 5 of my line drifts) |
| `node harness/test_build_shell.mjs` | 56 passed, 0 failed ✅ (proves the new modules bundle) |
| `node test_static_batch.mjs` / `test_static_batch_x.mjs` / `test_static_callpes.mjs` / `test_stat_batch_walk.mjs` / `test_dead_batch_skip.mjs` | 13/0 · 40/0 · 22/0 · 98/0 · 33/0 |
| `node test_landblock_lru_evict.mjs` / `_park_storm` / `_pool_scan` / `_geom_governor` | 39/0 · 36/0 · 12/0 · 21/0 |
| `node test_static_atlas_growth.mjs` / `test_atlas_bc7_pre_gate.mjs` / `test_adapter_atlas_guard.mjs` | 73/0 · ALL PASS · 4/4 |
| `node test_first_bake_batch_flags.mjs` / `test_cell_lights.mjs` / `test_static_merge_projection.mjs` | 84/0 · 18/0 · 71/0 |
| `node harness/test_tex_compressed_only.mjs` / `test_geom_bundles` / `test_residency_grid` / `test_slotgrid_lru_assert` / `test_frame_work` / `test_census_class` / `test_terrain_tier_ladder` / `test_console_allowlist` / `test_report_v2` | 112/0 · ✅ · ✅ · ✅ · ✅ · ✅ · 105/0 · ✅ · ✅ |
| `node scripts/lint-url-flags.mjs --app apps/holtburger-web` (repo root) | 0 undocumented readers owed docs rows |
| `node scripts/audit-flag-defaults.mjs --all` (repo root) | `drawPools  OFF  opt-IN exact-match — absent resolves OFF` |
| `node test_envcell_guard.mjs` | **FAILS — pre-existing.** Verified by `git stash -u`: it fails identically on clean HEAD, as T13's report recorded |

### The live arm — ONE headless SwiftShader boot @in-world

`HARNESS_ACCOUNT=agentp09 node /mnt/wbterminal2/reeng/T22P/live_pool_arm.mjs --scene nanto`
· serve.py :8765 over `/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2` (the
pack dist; `--check` OK) · live ACE :9000 · release wasm 6,423,996 B (the
RELIEF-BAKE build; `src/`/`crates/` untouched by this task) · flags
`drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on&frameWork=on`
+ `nosw=1&quality=mid&agent=1&netDrainHz=30`.
Taint: `nullRender=1` (mandatory headless — `harness/lib/boot.mjs`), SwiftShader,
`settled:false` (D5). No `renderOnDemand`. Artifact:
`/mnt/wbterminal2/reeng/T22P/live-on-nanto-2026-08-101638.json`.

| reading | value |
|---|---|
| in-world | 11,065 ms |
| pools@resident / classes@resident | **51 / 17** (bounds ≤ ~300 / ≤ ~63) |
| `classes.createdPostBoot` / `sealed` | **0** / true |
| parked `events.mutationsThisFrame`, two reads | **0 / 0** |
| tiles resident / grid slots | 33 / 36 LIVE, 0 FETCHING, 0 STAGED |
| `shiftMismatches` / `slotDesyncs` | 0 / 0 |
| pass split | 49 opaque · 2 translucent · 0 additive |
| `fix.applied` (F-11.18 at pool scale) | **true** |
| producer | nodesIn 815 · pooled 149 · passthrough 291 · refused 666 · plans 61 · **planErrors 0** · normFails 0 |
| refusals | needsResample **85** · bc7Pending 363 · deformed 218 · layerFull 0 · layerWriteFail 0 |
| class pages | 17 pages, 36 layer allocs / 113 dedup hits / 9 growths / 0 grow-fails |
| prewarm | 17 classes, 17 colour programs in 14.2 ms, depth 0 (1 cascade, `complete:true`) |
| scheduler (stage B live) | W1 ran 18 (max 3.2 ms) · W3 ran 103 (max 1.6 ms) · W4 ran 89 · 0 forced runs |
| `errors` | `unresolvedGeometry 0, unpooledMembers 0, lastError null` |
| console errors | **0** |

**Two numbers worth the orchestrator's attention, both [M] from this arm:**

- **M6 on pools reads ~55× at this scale.** `geometry.allocatedBytes` 22.3 MiB
  vs `usedBytes` 0.4 MiB — 51 pools × the `POOL_INIT_VERTS = 16_384` /
  `POOL_INIT_INSTANCES = 256` initial capacity, against a population that is
  mostly a handful of instances per pool. `pool_registry.js` labels those
  constants `[A] — re-classed by the first soak`; **this is the first soak**,
  and they want re-classing downward (or a lazy first-grow) before M6 is scored.
- **Class pages allocate 127.8 MiB (used 122.3).** 17 pages, dominated by
  2048²/1024² BC7 chain arrays. That is inside the pass-5 per-class budgets by
  construction (the pages use `_layerCapacityFor`'s own ceiling), but it is a
  real M4 rider once envcells and the resample residue join.

## Handoffs & risks

1. **The envcell swap (D3)** — designed shape and the three blockers are above.
   Until it lands, `producer.byDomain.ec` reads 0 and interiors are wholly
   legacy.
2. **The page-dim resample (the concurrent task)** closes the `needsResample`
   refusal by construction. When it lands, `classPages.refused.needsResample`
   should read 0 and the pooled share should jump; that counter is the
   migration's progress meter and needs no code change to read. Its CLIENT-side
   stitch is now landed (`4d9ddbd8`, D7): the feed keys on the TEXREF-declared
   page dims with `FULL_PAGE_DIMS` as authority, so the first page-dim dist will
   show `producer.texRefPageKeyed` climbing off 0. PAGE-RESAMPLE's own
   Handoff #3 (the preview-feed decision) is what still keeps `needsResample`
   from reaching 0 from the bake alone; its option (b) — upsample the preview
   into the member's FINAL page layer at transcode — is also what would drive
   `texRefDimsWillMove` to 0 and let the pooled world cover preview-resident
   members.
3. **`refused.bc7Pending = 363` is the biggest residue** and is NOT the D2 gate:
   it is `bc7AtlasShouldDefer`'s in-flight-verdict hold-out. The held-out nodes
   are re-offered by the pool `atlasRefeed` handler — but only when the material
   carries `__bc7RsId`/`__pvwRsId`; the live arm read `holdoutRsIds = 0`, i.e.
   none of the 363 carried one, so today they stay legacy for the session unless
   their LB re-streams. Worth one look by whoever owns the ST5 markers.
4. **Live-arm fixes 1–3 (`0b8d98e8`) are node-tested but not live re-verified** —
   the one-browser budget was spent on the arm that found them. None touches the
   feed path.
5. **E6 is now runnable.** Batch C's entry should be re-read: it will look at a
   world where statics and buildings are pooled and interiors, wind trees
   (`deformed`), preview-pending surfaces and off-page surfaces are legacy — so
   the vantages must be chosen knowing the arm is a MIXED producer, not a pure
   pooled one. The ClipMap and shadowed-town vantages are still the right ones.
6. **`?frameWork` remains required for stage B/C** and the full arm is the same
   SIX-flag URL T22 recorded.
7. **Working tree**: the concurrent PAGE-RESAMPLE task's files
   (`apps/holtburger-tools/**`, `Cargo.*`) were never staged by this task.
   `docs/RESULTS-shell-requests-2026-08-09.json` was regenerated by
   `test_build_shell.mjs` and **restored**, for the reason T22 recorded (it is
   T11's measurement record).
