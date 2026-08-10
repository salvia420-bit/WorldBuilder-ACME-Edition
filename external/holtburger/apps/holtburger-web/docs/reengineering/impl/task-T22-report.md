# T22 — ST9: draw pools + scheduler B/C + closed-class prewarm (`?drawPools`)

Staged landing, in the T15 shape: the ST9 **substrate** is complete, battery-green and
bisectable; the **producer swap** (statics/buildings/cells feeding pools instead of the
legacy stack) is the recorded remainder. Every acceptance bullet is scored below with
what it is scored on.

## Shipped

| file | commit | what |
|---|---|---|
| `scene3d/pool_class_key.js` (new) | `a62e1a22` | the pass-07 S3 class key, ONE producer for runtime + census + prewarm; tex axis = ARRAY-PAGE TIER per the T00 re-key |
| `harness/census-class.mjs`, `harness/test_census_class.mjs` | `a62e1a22` | re-pointed at the shared key; `programClasses` metric; BOUNDS re-baselined 72 / 48 / 300 |
| `scene3d/pool_registry.js` (new) | `3330a1d1` | the (sector × class) `PoolRegistry`; `?drawPools` + the F-11.3 chain; `__diag.pools` publish |
| `docs/url-flags.md` | `3330a1d1` | `?drawPools` §0 status row + §4 full row |
| `scene3d/tile_plan.js` (new), `scene3d/bake_worker.js` | `27ce4de3` | the TilePlan format + validator + pure builder + transfer codec; the worker's `tileBake` job |
| `scene3d/upload_stage.js` (new) | `c5214886` | stage C — `renderer.initTexture` staging, budgets, F-11.10 |
| `scene3d/pool_stream.js` (new) | `c5214886` | stage B — P4 feed/release relocation + the F-11.19 bake-dispatch queue |
| `scene3d/pool_prewarm.js` (new) | `56e63f33` | the closed-class boot prewarm incl. the CSM depth-variant warm RENDER |
| `harness/test_draw_pools.mjs` (new) | all five | the T22 battery, 333 checks over 16 PARTs |

Six bisectable commits: `a62e1a22` (class key + census) → `3330a1d1` (registry) →
`27ce4de3` (TilePlan) → `c5214886` (stage B + C, together by SPEC) → `56e63f33`
(prewarm). Nothing pushed.

**OFF-arm byte-identity.** Only ONE pre-existing production file is touched:
`scene3d/bake_worker.js`, additively — a doc block, one static import, one
`handleTileBake` function and one `case "tileBake":` in the message switch. No existing
code path is altered, no existing message changes shape, and every other production file
is NEW and imported by nothing on HEAD. The `?drawPools=off` arm is therefore today's
producer stack, unmodified; the full diff of that one file is in commit `27ce4de3` and
is 23 added lines, 0 removed. `harness/test_build_shell.mjs` re-run green (56/56) —
the bake worker still bundles with the new import, so the deployed shell's request
arithmetic is unchanged.

## Spec conformance

SPEC §3 T22's charge, item by item.

| charge item | status | evidence |
|---|---|---|
| `pool_registry.js` | **MET** | `scene3d/pool_registry.js`; battery PARTs 4–12 (pool creation, D-07.4 early-out pair on opaque / D-07.3 sorted semantics on additive+translucent, one material per class shared across sector pools, exact-key dedup, S2 transition table, PVS ranges, band tick, M6 allocated/used, reap) |
| class-key material tier | **MET**, and **measured before sizing** (R-03) | `pool_class_key.js`; the RE-KEYED array-page tier read and applied from `impl/t00-rekey-proposal-2026-08-09.md` + commit `24de3936`. Offline re-reduction of the two REAL T00 snapshots reproduces the proposal exactly: **nanto 63 classes / 271 pools / 24 program classes**, **townnetwork 51 / 238 / 23**, verdict WITHIN-BOUNDS, axis table matching to the unit (tex +33/+25, alphaTest +18/+12, patchBias +9/+3, patchVfx +8/+9, texFormat +6/+3, all other axes +0) |
| TilePlan production in the bake worker | **PARTIAL** | format + validator + pure builder + one-buffer transfer codec + the worker's `tileBake` job all landed and covered (PART 13). **Remainder:** resolving raw pack records into axis records INSIDE the worker — see Deviations D1 |
| P4 relocation of eviction/feeds (stage B) | **MET for the pool path** | `pool_stream.js`: feeds are W3 (W1 urgent), park/adopt/release/optimize are W4, uploads one coalesced W2 item, P1 events RECORD only. The LEGACY inline eviction stays a W6 client exactly as T21 landed it — correct until the producer swap makes the pool release path the authority (PART 15) |
| upload staging via `initTexture` (stage C, lands WITH the feed) | **MET** | `upload_stage.js` + the shared LIVE-flip ordering: `pool_stream._runFeedStep` holds a tile's flip until every rsId it needs `isStaged()`, and `enqueueRepoint` defers rather than exposing an unuploaded texture (PART 14 + PART 15) |
| bake-job dispatch items (F-11.19) | **MET** | `BakeDispatchQueue`: P1 records, P4 posts, concurrency 1, player-tile → interior → Chebyshev ordering, vacate purges the queued dispatch *and* the tile's queued scheduler items *and* its queued uploads (PART 15) |
| nullRender marking rule (F-11.10) | **MET** | `UploadStager` marks `needsUpdate` + layer marks in BOTH arms and NEVER calls `initTexture` under `nullRender`; `marksOnly` counted (PART 14) |
| boot prewarm incl. the CSM depth-variant warm RENDER | **MET** | `pool_prewarm.js`: colour via `withWarmTarget(guardedCompileAsync)`, depth via ONE `renderer.render` over the castShadow subset + N cascade lights with `shadowMap.needsUpdate`. Proxies are REAL `BatchedMesh`es (the `batching` program axis is derived from the OBJECT — a plain Mesh warms the wrong depth variant), asserted in PART 16. Warm scenes PARKED, never disposed |
| `three_batchedmesh_colortexture_fix.js` verified applied at pool scale (F-11.18) | **MET** | `PoolRegistry._verifyColorTextureFix()` probes `BatchedMesh.prototype.colorTexture` before the first pool is constructed; a miss is a loud `console.error` and `census().fix.applied` reads false for the session. PART 4 asserts applied, PART 12 asserts it held for all 54 pools of the ring battery. `test_bm_colortexture_fix.mjs` re-run green (13/13) |

GATE-POOLS acceptance:

| gate bullet | status | evidence |
|---|---|---|
| **E6 CLEAN** (Batch C, incl. the ClipMap item and the shadowed-town `receiveShadow` vantage) | **DEFERRED-TO-BATCH** | owner-eye, 1070, Batch C. Not simulated. Also: with the producer swap outstanding there is no pooled world to look at yet — E6 is not merely un-run, it is not yet *runnable* |
| class census sane — `classesCreatedPostBoot = 0`, pools ≤ ~300 | **MET offline / live DEFERRED** | pools **271** (Nanto) / **238** (TN) ≤ 300 under the amended key, measured by re-reducing the real snapshots; `classesCreatedPostBoot` is implemented (`sealClassSet()` + counter + warn) and asserted in PART 11 (streaming an existing class mints nothing; a post-seal mint is counted). A live census on this HEAD would still measure the LEGACY population — see Deviations D3 |
| parked `poolMutationsPerFrame = 0` | **MET on the battery / live DEFERRED** | PART 11: after a settled `beginFrame()`, a band tick + an unchanged renderSet + an optimize tick leave `events.mutationsThisFrame === 0` |
| MOVE-FIX (creates the F3/F4 baselines, scores the kill) | **DEFERRED-TO-BATCH** | 1070 + a pooled world; Batch C |
| TAIL-ULTRA F5 `linkStatusMs = 0` | **DEFERRED-TO-BATCH** | 1070; the prewarm is the mechanism, the walk is the measurement |
| ktris + GPU-boundedness re-check | **DEFERRED-TO-BATCH** | 1070; pass-07 Q3's open question, unchanged by this landing |

Local acceptance the orchestrator asked for:

- **suites green** — MET (13 neighbour suites + the T22 battery + build-shell, all listed below).
- **OFF arm byte-identical proven** — MET, by the diff argument above (one file, additive only, 23 lines).
- **class census sane on a local SwiftShader arm if feasible** — **NOT RUN, deliberately.** See Deviations D3.

## Deviations

**D1 — SPEC §3 T22 "TilePlan production in the bake worker" is landed as a CONTRACT plus
a pure builder, not as a self-sufficient worker producer.**
Evidence: producing a plan from pack records inside the worker requires resolving each
surface record into an axis record — i.e. reproducing `materials.js`'s builder ladder
off-thread. Read-verified this session, that ladder is: `applyClipMapRenderState`
(`materials.js:2131`, with the three retail alpha refs at `:2080-2082` and the
default-ON `?clipMapOpaque` arm at `:2111`), the patch installers behind
`_patchSetCacheKey` (`:574-605`) and `_chainBeforeCompile` (`:647`), and the MECH-B VFX
`set#config` token built in `statics.js:1863-1877`. Reproducing that off-thread without
drift is a task-sized job whose failure mode is silent visual divergence between arms.
Minimal sound thing done: the plan format, the validator, the builder, the transfer
codec and the worker message are landed; the builder takes its axis facts from an
injected `resolveAxes`, so the seam is real and the missing half is one function.
Recorded in `tile_plan.js`'s header and in Handoffs below.

**D2 — the page-tier class key is CORRECT ONLY ONCE MEMBERS ARE RESAMPLED TO PAGE DIMS,
and that resample does not exist yet.**
The T00 re-key's correctness half (proposal §4) is: "a member whose native dims ≠ its
page dims is stored RESAMPLED (upscaled) to page dims at bake/transcode time", which is
what makes "any two members of a class share any layer of the one `texStorage3D`
allocation" a theorem rather than a hope. T22 lands the KEY; the resample is a
bake/transcode-pipeline change (ST5/ST6 territory) and is not landed. Consequence: the
key as shipped is sound as a *census* key today (which is all anything uses it for on
HEAD), and becomes sound as an *allocation* key only when the resample lands. This is a
hard prerequisite of the producer swap, not a nicety, and is repeated in Handoffs.
`pageDimsOf()`/`needsResample()` are exported so the transcode side has the exact
predicate.

**D3 — no live SwiftShader census arm was run.**
Reasoning, not convenience: (a) R-03's own instruction is that candidate keys are
evaluable OFFLINE via `census-class --reduce` over the `/mnt/wbterminal2/reeng/T00`
snapshots, and that is what was done — reproducing the proposal's figures exactly on
REAL captured data; (b) with the producer swap outstanding, a fresh boot would census
the LEGACY producer population, i.e. it would re-measure the same thing the snapshots
already hold, on a noisier sample (T00's own snapshots carry `settled:false`); (c) the
meaningful confirmation is the GATE-POOLS 1070 arm, which R-03 still owes. Running one
headless chromium to re-derive a number I already have from the same population would
have bought nothing and spent the agent's one-browser budget.

**D4 — a resumable scheduler item must not re-enqueue into its own class.**
Found by the battery, which HUNG. `FrameWorkScheduler.run` drains a class with
`while (q.length > 0)` and breaks only on the ms budget (`frame_work.js:471-475`), so an
item that re-enqueues itself is re-served within the same slot until the budget expires
— and on a frozen test clock, forever. `pool_stream._runFeedStep` therefore signals
continuation with a FLAG that `tickP4` re-arms once per pending tile per frame. This is
worth propagating: any future W1–W5 producer that wants to resume must use the same
shape, and T21's scheduler is not at fault (a self-re-enqueueing item is simply outside
its contract).

**D5 — `?drawPools`'s prerequisite check is local, not a central cascade.**
F-11.3 describes OFF-forcing propagating along `packSource → {geomBundles,
texCompressedOnly, slotGrid} → drawPools`. Read-verified: no central enforcer exists —
each dependent disarms itself at arm time (`index.js:6196` for `?slotGrid`,
`geom_bundles.js:78-140` for `?geomBundles`, `bc7_textures.js:231` for
`?texCompressedOnly`). T22 follows the loudest landed precedent (`index.js:6196`):
`checkDrawPoolsPrereqs` names EVERY unmet flag and `initDrawPools` returns `null`, so
the flag does nothing and says so. A central cascade remains unbuilt and unowned.

**D6 — `__diag.pools` and `__prewarmStats` stay `reserved` in the diag registry.**
Both surfaces are installed by the code that lands here (`initDrawPools`,
`initPoolPrewarm`), but nothing in `index.js` calls either yet, so no real run has them
live. Flipping them to `current` would assert a liveness that does not exist and would
make `test_diag_schema.mjs`'s evidence re-verification vouch for an unreachable line.
The flip lands with the producer swap. The `__atlasStats → __diag.pools` successor edge
is untouched and still green.

## Tests run

All node, all standalone, from `apps/holtburger-web/`.

| command | result |
|---|---|
| `node harness/test_draw_pools.mjs` | **333 passed, 0 failed** — DRAW-POOLS ✅ (16 PARTs) |
| `node harness/test_census_class.mjs` | 42 passed, 0 failed — CENSUS-CLASS-TEST ✅ |
| `node harness/census-class.mjs --reduce …census-class-nanto-2026-08-09.json` | 63 classes / 24 program classes / **271 pools** @resident — WITHIN-BOUNDS |
| `node harness/census-class.mjs --reduce …census-class-townnetwork-2026-08-09.json` | 51 / 23 / **238** @resident — WITHIN-BOUNDS |
| `node harness/test_diag_schema.mjs` | DIAG-SCHEMA ✅ |
| `node harness/test_frame_work.mjs` | FRAME-WORK ✅ |
| `node harness/test_residency_grid.mjs` | RESIDENCY-GRID ✅ |
| `node harness/test_slotgrid_lru_assert.mjs` | SLOTGRID-LRU-ASSERT ✅ |
| `node harness/test_geom_bundles.mjs` | GEOM-BUNDLES ✅ |
| `node harness/test_cell_fusion.mjs` | 20 passed, 0 failed |
| `node harness/test_tex_compressed_only.mjs` | 112 passed, 0 failed ✅ |
| `node harness/test_pack_fetch_controller.mjs` | 92 passed, 0 failed ✅ |
| `node harness/test_texture_worker.mjs` | 69 passed, 0 failed |
| `node harness/test_nra_derive.mjs` | 41 passed, 0 failed |
| `node harness/test_report_v2.mjs` | REPORT-V2 ✅ |
| `node harness/test_console_allowlist.mjs` | CONSOLE-ALLOWLIST ✅ |
| `node harness/test_build_shell.mjs` | BUILD-SHELL ✅ 56 passed (proves the bake worker still bundles) |
| `node test_bm_colortexture_fix.mjs` | 13 passed, 0 failed (F-11.18's module) |
| `node scripts/lint-url-flags.mjs --app apps/holtburger-web` (repo root) | `drawPools → scene3d/pool_registry.js:77`; the one UNDOCUMENTED finding is `terrainT1024` (the concurrent terrain-ladder task's scope, not T22's) |
| `node scripts/audit-flag-defaults.mjs --all` (repo root) | `drawPools  OFF  opt-IN exact-match — absent resolves OFF` — doc and reader agree; 0 comment-vs-reader mismatches |

The battery uses REAL `THREE.BatchedMesh` instances (three resolves in node; every
operation under test is CPU-side, no GL context involved), a real `FrameWorkScheduler`
with a mocked clock, and a stubbed renderer for the prewarm — so the mechanism is
asserted, never the pixels.

No wasm was rebuilt: nothing in `src/` or `crates/` was touched, and `pkg/` is untouched
(release, 6.40 MB, from T13).

**Scale tags.** Every figure above is `@resident`-scale offline census data or node-unit
counts. No frame-time figure is claimed, derived or implied by this task.

## Handoffs & risks

**The remainder, precisely — what a follow-up task must do to make `?drawPools` build a
world.** In dependency order:

1. **Page-dim RESAMPLE at bake/transcode (D2).** Hard prerequisite of the class key's
   allocation soundness. Predicate is exported: `pageDimsOf(rec)` / `needsResample(rec)`.
   Owner: the texture pipeline (ST5/ST6 territory), not the pools task.
2. **`MaterialCache.getClassMaterial(classKey)`** — the class tier above the per-DID maps
   (pass-07 D-07.2). The registry takes it as an injected `materialFactory`; the seam is
   one function. The class's map is the class's array page.
3. **The worker-side record → axis-record ladder (D1)** — makes `tileBake`
   self-sufficient and discharges "the main thread never derives a class".
4. **Grid → pool wiring.** `SlotGrid`'s four event hooks (`onSeed`/`onShift`/
   `onSlotState`/`onTeleport`) are **entirely unwired today** — `index.js:6306`
   constructs `new rg.SlotGrid({ now })` and passes none of them. They are the intended
   attach points for `PoolStreamController.onAdmit`/`onVacate`/`onTeleport`, and the
   controller was written against exactly that vocabulary.
5. **The producer swap**, in the T13 shape (one commit per consumer so defects bisect):
   statics → buildings → envcells, each routing its resolved placements into a TilePlan
   instead of the legacy bucket feed, with `?drawPools=off` keeping the legacy path
   byte-identical.
6. **`atlasRefeed` pool handler.** `bc7_textures.js:266` `registerAtlasRefeed` is the
   producer-agnostic seam F-11.17 reserved; the atlas-side implementation
   (`static_atlas.js:1863`) is the declared throwaway that retires here.
7. **The diag registry flips (D6)** + adding `__diag.pools` to
   `test_diag_schema.mjs`'s landed-current list.

**Risks carried.**

- **R-03 is closed-as-measured only offline.** 271/238 come from snapshots that carry
  `settled:false`; the pools margin is ~10%. The GATE-POOLS 1070 confirm arm is still
  owed and should re-run the census with the amended key — the harness now produces the
  amended key by construction, so that run needs no code change.
- **R-11 (`three_batchedmesh_colortexture_fix`) is now checked, not just documented.**
  Any three bump past the upstream fix will make `applyBatchedMeshColorTextureFix`
  self-retire (it no-ops when three ships the property) and `census().fix.applied` will
  read TRUE via the native property — which is correct. A three bump that *renames*
  `_colorsTexture` would silently break the shim; that is the case worth re-reading on
  any bump.
- **D-07.6's "world-static nodes ≤ ~250 [A]" vs 271 projected pools** — flagged by the
  re-key proposal §6 as owed a look "when T22 sizes". Looked at: the registry publishes
  `nodes.worldStatic = pools.count`, so the figure is now *measurable* rather than
  assumed, and 271 exceeds the ~250 [A] by 8%. The census sector spread at Nanto (11–12)
  is well inside the ≤16 ceiling, so this is a re-baseline of an [A], not a design
  breach — but it is an open number for the orchestrator, and it is the same 8% that a
  settled (rather than late-burst) capture could move either way.
- **`?frameWork` is required for stages B/C** and is itself DEV/default-OFF. An armed
  `?drawPools` without it warns and runs stage-A pools only (feeds on the caller's
  cadence). The full T22 arm is therefore a SIX-flag URL:
  `?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on&frameWork=on`.
- **Batch C's E6 item should be re-read before it is queued** — it presumes a pooled
  world exists. Until the producer swap lands, E6 is not runnable and the queue entry's
  prerequisite line needs that stated (T32's card lists T22 as its prereq; the honest
  prereq is now "T22 + the producer swap").
