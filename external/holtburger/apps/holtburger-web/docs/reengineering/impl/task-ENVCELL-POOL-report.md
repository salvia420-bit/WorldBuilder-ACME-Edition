# ENVCELL-POOL-SWAP — the envcell producer into the draw-pool substrate (T22-PRODUCER D3)

T22-PRODUCER swapped statics and buildings onto the ST9 draw pools and recorded
the ENVCELL domain as its remainder, with three read-verified blockers. This
task closes all three and lands the interior producer: a cell's per-surface
groups are offered to (sector × class) pools **before** `cell_fusion.js`, only
what the pools refuse is fused, interiors pool into `cellsGroup` on
RENDER_LAYER_INDOOR, per-cell visibility rides the same PVS set the container
flips consume in the same tick, an LB rebuild releases its pooled cells first,
and `acBakedLight` survives pooling because the class material takes the patch.

**The live arm is honest and it is not the arm this task wanted.** The envcell
producer RAN end to end at Holtburg Redoubt — 745 cells offered, 1,852 surfaces
offered, 0 shape skips, 0 bake refusals, the visibility tick's set matching the
container set exactly (28 = 28), parked mutations 0/0, 0 console errors — but
**every one of the 1,852 surfaces was refused `offPage`** by the TEXREF page
gate that landed in T22-PRODUCER's leg 6, so **no pooled interior existed to
look at**. That gate is domain-independent and, on this pre-page-dim dist,
empties the pooled world for statics too. Evidence, mechanism and the two
unblock paths are Deviation D5 and Handoff 1. Nothing is smoothed: the pooled
interior itself is measured only by the node battery.

## Shipped

| file | commit | what |
|---|---|---|
| `scene3d/pool_registry.js` | `2c2c13d5` | **leg 1** — per-domain `groups`/`layers` (blocker a), the per-cell index + `setCellsVisible` DELTA (blocker b), `releaseCells`, `gidByInstance`, `census().cells` |
| `scene3d/pool_material.js` | `b7606821` | **leg 2** — `normalizeForPool` COMPACTS an indexed source to the vertices its own index uses (the T13 shared-stream shape), carries `acBakedLight`, and the class material takes `applyBakedVertexLightPatch` with a COMPOSED program cache key |
| `scene3d/pool_envcells.js` (new) | `c3c96050` | **leg 3** — the envcell producer: arming, the offer, the PVS delta incl. the born-visible arrival case, the per-LB release ledger, the `?portalStencil` disarm (blocker c), the census |
| `scene3d/cells.js` | `a8d5683c` | **leg 4** — the consumer swap: the offer on both legacy shapes, release-before-re-feed (+ the mid-build eviction abort), the pooled visibility tick |
| `scene3d/index.js`, `harness/lib/diag_schema.mjs` | `ac893196` | **leg 5** — `armEnvCellPoolGroups` at the arm site, `__diag.pools().envcells`, the registered `cells.*` rows, two drifted `evidence:` lines corrected |
| `docs/url-flags.md` | `e7622bb5` | **leg 6** — §0 status row + §4 `drawPools` row: the ec domain, the portalStencil interplay, `refused.offPage` |
| `harness/test_draw_pools.mjs` | legs 1–3 | battery **413 → 496** (PARTs 21–24) |
| `docs/reengineering/queue-1070/batch-C-2026-08-09.json` | (this commit) | E6 gains the `holtburg-redoubt-interior` vantage + the interior prereq checklist row |

Six bisectable commits in producer order: registry substrate → geometry/material
→ producer module → consumer swap → wiring → docs. Nothing pushed.

**OFF-arm argument.** `cells.js` gains three guarded blocks, every one behind
`envCellPoolsActive()`, which is false unless `initPoolWorld` armed the full
F-11.3 chain. `pool_envcells.js` is new and imported only by `cells.js` and
`index.js` (where its two calls are inert without a pooled world).
`pool_registry.js`/`pool_material.js` gain behaviour only on paths a pooled
world reaches; the new registry constructor options default to exactly the old
single-group behaviour. `index.js`'s additions are one guarded arming call and a
census merge that runs only when `poolWorldCensus().enabled`. Proof is the suite
set: 28 neighbour suites run the OFF path with no flags and are green, and
battery PART 24 asserts every envcell entry point is inert with no pooled world.
A live OFF boot was not run (one-browser budget).

## Spec conformance

The orchestrator's acceptance list:

| bullet | status | evidence |
|---|---|---|
| blocker 1 — pooled meshes reach the cells layer (layer 1 / the atmosphere_pipeline depth-clear split) | **MET** | `PoolRegistry` takes `groups`/`layers`; the pool MESH is stamped (masks never inherit); `armEnvCellPoolGroups` wires `cellsGroup` + layer 1 at the arm site. Read-verified against `index.js:1455-1459` (cellsGroup/entitiesGroup on RENDER_LAYER_INDOOR), `cells.js:1642` (`traverse(o => o.layers.set(1))`) and `atmosphere_pipeline`'s layer-0/depth-clear/layer-1 order. Battery PART 21 asserts placement AND the negative (`NOT on layer 0`); PART 23 asserts it on a really-fed cell. **Not live-verified** — no pool was constructed on the arm (D5) |
| blocker 2 — per-cell visibility wired, pooled instances toggle exactly as containers do | **MET (battery) + LIVE for the SET, not the instances** | `poolCellVisibilityTick` is called from `tickCellVisibility3D` on the same `visibleSet`, immediately beside the container loop. Battery PART 23: born-visible → hidden on arrival, enter/leave flips, hidden-survives-park-adopt (PART 21), and an unchanged set performing ZERO mutations. LIVE: `envcells.visible` = 28 and `containersVisible` = 28 on the same read, `shows` 29 / `hides` 1 — the tick consumed the identical set, though with 0 pooled instances to flip |
| blocker 3 — the three portal ticks keep working on OFF, drive the pooled path on ON (adapter, not rewrite) | **MET, with a recorded scope limit** | None of the three files is touched. `tickCellVisibility3D` gains one guarded call (the adapter). `tickPortalPunch`/`tickPortalSeal` need nothing: they walk apertures and reveal whatever is on layer 1, which is where the pools are. `tickPortalStencil` MOVES containers to RENDER_LAYER_PORTAL_CELL, which a pool cannot follow — so envcell pooling DISARMS under `?portalStencil` (default-OFF, documented UNVALIDATED), loudly and counted. Recorded as D7 |
| envcell geometry via `cellToGeometryGroups` — no non-indexed assumptions on indexed shared-stream groups | **MET** | `normalizeForPool` now remaps an indexed source to the vertices its own index references. Battery PART 22 replays the source index and compares every drawn vertex (position/uv AND the raw normalised baked bytes) — a shuffled remap fails there. Without it, a cell's whole vertex stream entered the pool once per surface |
| baked light survives pooling, or the cell refuses pooling COUNTED | **MET** | Class material takes `applyBakedVertexLightPatch` (composed cache key, so the array material's wrap/nra axes are not collapsed); `acBakedLight` rides through compaction; a baked material whose geometry lacks the attribute is refused `bakedMissing`. LIVE: 1,852 surfaces offered, `refusedBakedMissing = 0`, `_acVertexBakeActive = true` — i.e. every real Holtburg-Redoubt surface satisfied the invariant |
| portal-punch/stencil interplay read-only | **MET** | `portal_stencil.js`, `portal_punch.js`, `portal_clip.js`, `atmosphere_pipeline.js` untouched (`git show --stat` on all six commits) |
| needsResample / offPage refusal semantics identical to D7's statics shape | **MET** | The envcell feed goes through `addSingletonsToPools`, i.e. the same `_axisRecordFor` + `ClassMaterialRegistry.admit` gates, unmodified. LIVE proof of identity: interiors were refused by the same `offPage` rule that governs statics, with the same counters |
| bisectable commits | **MET** | six, one concern each |
| battery extended (visibility-toggle parity, baked-light survival, layer correctness, OFF-arm identity) | **MET** | 413 → 496 checks; PARTs 21–24 cover exactly those four |
| ONE headless SwiftShader live arm, agentp10, full chain, no renderOnDemand, `@teledungeon holtburg redoubt`, registry + cell diag read, chromium killed | **MET as an ARM; the pooled-interior READ is BLOCKED** | `/mnt/wbterminal2/reeng/ENVCELL-POOL/live-on-2026-08-101750.json`; browser closed by the harness. See D5 |
| interior eye pair DEFERRED-TO-BATCH with a queue note | **DEFERRED-TO-BATCH (queued)** | `queue-1070/batch-C-2026-08-09.json` E6 gains `holtburg-redoubt-interior` (four named judgements) + a prereq checklist row that stops an owner judging a legacy interior by mistake |

## Deviations

**D1 — the envcell producer is a NEW module, and the cells-group arming is set
post-construction, because `pool_producer.js` was owned by a concurrent task.**
I2 forbids touching another in-flight task's scope. The RSID-MARKER task held
uncommitted work in `pool_producer.js`, `pool_material.js`, `bc7_textures.js`,
`materials.js` and `harness/lib/diag_schema.mjs` for most of this task. So:
(a) everything the envcell half needs that could live outside `pool_producer.js`
does — `scene3d/pool_envcells.js` consumes only its exported
`poolWorldActive`/`getPoolWorld`/`addSingletonsToPools`; (b)
`armEnvCellPoolGroups` sets `registry.groups`/`registry.layers` after arming
rather than threading them through `initPoolWorld`'s deps (the registry reads
both lazily, at first pool creation, which is always later); (c) the two
`pool_material.js` hunks this task needed were committed by reconstructing a
HEAD-based patch of MY edits only and `git apply --cached`-ing it, so the
concurrent task's uncommitted hunks in that file were never staged by me —
verified after each commit with `git diff --cached --stat` vs `git diff --stat`.
Folding the groups/layers into `initPoolWorld` is a one-line follow-up now that
that task has landed (Handoff 3).

**D2 — cell STATIC props stay on the legacy container path.** Furniture,
braziers and banners are per-placement nodes whose animated and scripted
siblings resolve their parent BY CONTAINER (`cells.js:1684`
`resolveParent: (item) => cellContainerById.get(...)`, the particle anchors, the
re-freeze path). Pooling them would need those three systems re-homed as well.
Interiors' SURFACE geometry is the mass; the props are the tail. Recorded, not
counted separately (they never reach this module).

**D3 — the offer builds throwaway `THREE.Mesh` nodes.** `addSingletonsToPools`
is the atlas's seam (nodes in, `{passthrough}` out) and T22-PRODUCER made that
seam the producer contract deliberately. Rather than add a second entry shape to
a contended file, the envcell offer constructs one short-lived Mesh per surface
group, reads back which ones the pools took, and lets the rest fuse. The nodes
are garbage after the call; the geometry objects are the cell's own.

**D4 — pooled cell surfaces carry PER-SURFACE shadow flags, where the fused path
carries a bucket-wide OR.** `cells.js`'s fused build ORs `materialCanCastShadow`
across a bucket and documents the artifact ("shadow-on-glass" for
translucent-bearing cells). Shadow flags are class-key axes (D-07.6), so a pool
expresses them per member — which is also the `?envcellFusion=off` path's exact
semantics. The pooled arm is therefore MORE exact here, not less; it is a
visible-in-principle difference and belongs on the E6 eye list.

**D5 — the live arm found the pooled world EMPTY, for a reason that is not this
task's and is not envcell-specific.** All 1,852 offered interior surfaces were
refused with reason `offPage`, and the producer counters read
`texRefOffPage = 1852`, `texRefDimsWillMove = 1852`, `texRefAbsent = 0`,
`texRefPageKeyed = 0`. Mechanism, read-verified: `_axisRecordFor`
(`pool_producer.js`) marks `rec.texOffPage = true` whenever a material's LIVE
`map` dims differ from the TEXREF-DECLARED dims, and `admit()` refuses on that
mark. Under `?texCompressedOnly` world materials are PREVIEW-born, so live dims
differ from the declared full-tier dims for essentially every member of a
pre-page-dim dist. T22-PRODUCER's own D7 anticipated the shape of this ("a
member whose dims will move must not take a page layer now") and expected
`texRefPageKeyed` to read 0 on today's dist — what the arm adds is that the
complement is not "keyed on live dims" but "refused", i.e. **`?drawPools` builds
an empty world on this dist**. The gate lives in `_axisRecordFor`/`admit`,
neither of which branches on domain, so statics are governed identically (this
arm cannot show statics: it went straight to a sealed dungeon, where
`nodesIn = 1852` were all `ec`). T22-PRODUCER's 51-pool Nanto arm was measured
BEFORE leg 6 landed and its report states leg 6 was never live-verified. The two
unblock paths are Handoff 1. **Consequence for this task:** the pooled interior
— layer placement, baked shading, instance toggling at scale — is proven by the
node battery and by construction, not by pixels or by a live pooled census. I9
says report it.

**D6 — `normalizeForPool`'s compaction changes the STATICS pooled arm too.**
It is shared substrate. Statics' bundle groups share vertex streams by the same
`_subsetsToGroups` mechanism, so they were paying the same multiplier; the change
is a strict improvement (identical drawn triangles, fewer stored vertices) and is
one candidate explanation for the ~55× allocated:used T22-PRODUCER's first soak
read. It is NOT measured live here (no pools existed on the arm), so no figure is
claimed.

**D7 — `?portalStencil=on` disarms envcell pooling entirely.** SPEC §1.5 says
envcells "collapse in" without qualification. `tickPortalStencil` moves whole
cell containers between layer 1 and RENDER_LAYER_PORTAL_CELL per frame, and a
pool is ONE object shared across cells and tiles: it cannot be on two layers, and
splitting a pool per portal-visibility state would mint classes at runtime (the
one thing D-07.9 forbids). The flag is DEFAULT-OFF and `docs/url-flags.md:256`
records it as UNVALIDATED and gated on a 1070 measurement that has not happened.
Minimal sound thing: interiors stay wholly legacy under it, said once loudly and
counted (`envcells.disarmedPortalStencil`), so the stencil path is exactly what
it is today. If `?portalStencil` is ever validated and flipped, its pooled story
is a design task (candidate: a second `ec` group whose pools are the portal-layer
population, keyed by a class axis rather than moved per frame).

**D8 — one file edited outside the named scope.** `harness/lib/diag_schema.mjs`
(the registered `cells.*` rows + the two `evidence:` line-number corrections my
`index.js` edit forced — the schema test re-verifies those lines and went RED
until they were fixed). Registry rows are the declared home for new diag fields.

## Tests run

Node, from `apps/holtburger-web/`, all on this HEAD.

| command | result |
|---|---|
| `node harness/test_draw_pools.mjs` | **496 passed, 0 failed** — DRAW-POOLS ✅ (24 PARTs; 413 → 496) |
| `node harness/test_diag_schema.mjs` | 69 passed, 0 failed ✅ (evidence re-verification caught both of my line drifts) |
| `node harness/test_build_shell.mjs` | 56 passed, 0 failed ✅ — the new module bundles |
| `node harness/test_cell_fusion.mjs` | 20/0 (the E1-DIRTY seam the offer sits in front of) |
| `node test_cell_lights.mjs` | 18/0 (the RND-04 lighting handshake) |
| `node test_static_batch{,_x}.mjs` · `test_static_callpes` · `test_stat_batch_walk` · `test_dead_batch_skip` | 13/0 · 40/0 · 22/0 · 98/0 · 33/0 |
| `node test_landblock_lru_evict` · `_park_storm` · `_pool_scan` | 39/0 · 36/0 · 12/0 |
| `node test_static_atlas_growth` · `test_atlas_bc7_pre_gate` · `test_adapter_atlas_guard` · `test_bm_colortexture_fix` | 73/0 · ALL PASS · 4/4 · 13/0 |
| `node test_first_bake_batch_flags` · `test_static_merge_projection` | 84/0 · 71/0 |
| `node harness/test_tex_compressed_only` · `test_geom_bundles` · `test_residency_grid` · `test_slotgrid_lru_assert` · `test_frame_work` · `test_census_class` · `test_terrain_tier_ladder` · `test_console_allowlist` · `test_report_v2` · `test_pack_fetch_controller` · `test_texture_worker` | 112/0 · 78/0 · 394/0 · 25/0 · 144/0 · 42/0 · 105/0 · 20/0 · 39/0 · 92/0 · 69/0 |
| `node scripts/lint-url-flags.mjs --app apps/holtburger-web` (repo root) | 0 undocumented readers owed docs rows |
| `node scripts/audit-flag-defaults.mjs --all` (repo root) | `drawPools OFF opt-IN exact-match — absent resolves OFF` |
| `node test_envcell_guard.mjs` | **FAILS — pre-existing.** Verified by `git stash`: identical `ReferenceError: nodeInLandblock is not defined` on clean HEAD (the line-wise import-strip breakage T13 recorded). The new `cells.js` import is single-line, per the statics.js:80 rule, so it adds nothing to it |

`docs/RESULTS-shell-requests-2026-08-09.json` was regenerated by
`test_build_shell.mjs` and RESTORED — it is T11's measurement record.

### The live arm — ONE headless SwiftShader boot @in-world

`HARNESS_ACCOUNT=agentp10 HARNESS_PASSWORD=agentp10 node /mnt/wbterminal2/reeng/ENVCELL-POOL/live_envcell_arm.mjs --dungeon "holtburg redoubt"`
· serve.py :8765 over the repo + `dist` symlink · live ACE :9000 · flags
`drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on&frameWork=on`
+ `nosw=1&quality=mid&agent=1&netDrainHz=30`. Boot gate = `harness/lib/boot.mjs`
`launchAndEnter`, which is `rynth_boot_helper.cjs`'s gate exactly (in-world AND
`getLocalPlayerPose() !== undefined`, bootStateHistory scanned). Taints:
`nullRender=1` (mandatory headless), SwiftShader. **No `renderOnDemand`.**
Artifact: `/mnt/wbterminal2/reeng/ENVCELL-POOL/live-on-2026-08-101750.json`.
Chromium closed by the harness; no stray process.

| reading | value |
|---|---|
| in-world | 8,884 ms |
| interior reached | `indoor = true`, 2 envcell LBs, **746 cell containers** |
| envcell producer | `cellsOffered 745` · `surfacesOffered 1852` · `skippedShape 0` · `feedErrors 0` |
| **the bake invariant, on real dungeon data** | `refusedBakedMissing 0` · `bakeStripped 0` · `_acVertexBakeActive true` |
| **visibility parity** | `envcells.visible 28` vs `containersVisible 28` — the pooled tick consumed the SAME set, same tick (`shows 29`, `hides 1`) |
| pooled | **`surfacesPooled 0`, `pools 0`** — every member refused |
| refusals | **`offPage 1852`** · needsResample 0 · bc7Pending 0 · deformed 0 · noTexture 0 · layerFull 0 |
| producer TEXREF counters | `texRefOffPage 1852` · `texRefDimsWillMove 1852` · `texRefPageKeyed 0` · `texRefAbsent 0` |
| parked `events.mutationsThisFrame`, two reads | **0 / 0** |
| `planErrors` / `normFails` / `unresolvedGeometry` / `unpooledMembers` | 0 / 0 / 0 / 0 |
| console errors | **0** |

Read the top three rows together: the interior producer is wired and correct at
every step it was allowed to take — it saw every cell, resolved every surface,
agreed with the container tick to the instance, and refused nothing for its own
reasons — and then the shared texture gate declined all 1,852 members. `pools 0`
is that gate's verdict, not the envcell swap's.

## Handoffs & risks

1. **THE GATE DECISION, for the orchestrator (blocks E6 again).** On this dist
   `?drawPools` builds an EMPTY world: `refused.offPage` catches every member
   whose live dims differ from its TEXREF-declared dims, which under
   `?texCompressedOnly` is every preview-born member of a pre-page-dim dist. Two
   ways out, and they are not exclusive:
   (a) **land the page-dim dist** — PAGE-RESAMPLE's own "NEXT FULL-WORLD BAKE"
   recipe (`--tex-xu7 <page-dim ingest>` + `--require-page-dims`), after which
   declared == resident and the refusal is unreachable by construction;
   (b) **re-scope the refusal to the bit that is its own authority** — T22-PRODUCER
   D7(a) says the declared dims are trusted ONLY when `FULL_PAGE_DIMS` is set,
   yet D7(b)'s DECLARED≠RESIDENT test compares against those same untrusted dims
   when the bit is CLEAR, which is exactly the pre-resample case. Firing
   `texOffPage` only when `info.onPage` is true restores the pre-leg-6 behaviour
   (keyed on live dims — the 51-pool Nanto arm) at the cost D7 names: a member
   whose full tier later lands at different dims keeps its preview texels, which
   `refeedDimMismatch` already counts. This is a one-line change in
   `pool_producer.js#_axisRecordFor` and it is D7's author's call, not mine.
2. **`offPage` members are never re-offered — and the reason RSID-MARKER gave
   for not filing them has since been removed by RSID-MARKER itself.** `_holdOut`
   fires only for `REFUSE.BC7_PENDING`; that task's D2 declined to file `offPage`
   because "an off-page refusal has no event, so filing it would retain nodes for
   the session = a leak I would be creating". Its leg 1 then landed the event:
   `upgradeMaterialToBc7` now calls `atlasRefeed(rsId)` when the verdict SETTLES
   on all three outcomes, which is precisely when a member's dims stop moving. So
   the extension (file on `OFF_PAGE`, re-offer on `atlasRefeed`, drop on the same
   settle if it is still refused) now drains by construction exactly as the
   `bc7Pending` ledger does. The arm read `refeedCalls 335` with
   `refeedRehomed 0` and `holdoutRsIds 0` — 335 settled verdicts that could have
   re-offered members and had nothing filed to re-offer. Their file, their call.
3. **Fold `groups`/`layers` into `initPoolWorld`** and delete
   `armEnvCellPoolGroups`'s post-construction assignment (D1). Now that
   `pool_producer.js` is free, this is one line plus one call-site edit.
4. **The producer's `geomByContent` map never evicts.** It is keyed by geometry
   uuid and holds the SOURCE geometry alive for the session — for envcells that
   means whole-cell shared vertex streams (and, under `?geomBundles`, the bundle
   buffers they view). Bounded by unique geometries offered, but interiors are
   where that population is largest; it wants a release keyed to the same event
   as `releaseCells`. Not this task's file.
5. **Interior feeds ride W3, not W1.** SPEC §1.6 lists "interior feed on entry"
   as W1 URGENT; the offer passes no `urgent` flag because `cells.js` has no
   clean signal for "this is the player's own interior" at build time. The signal
   exists on the grid (player tile) — a one-line lookup once someone decides
   which side owns it.
6. **E6's interior vantage is queued** (`batch-C-2026-08-09.json`, item E6,
   vantage `holtburg-redoubt-interior`) with the four judgements that no harness
   metric can see: baked lighting, no double-draw after a re-approach, PVS
   toggling across doorways, and the doorway depth split. Its checklist row makes
   the pooled-interior prerequisite explicit so an owner cannot judge a legacy
   interior by mistake.
7. **Working tree**: the concurrent RSID-MARKER task's files were never staged by
   this task (D1c). Its commits interleave with these six.
