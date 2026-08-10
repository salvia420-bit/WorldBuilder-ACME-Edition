# RSID-MARKER — closing the `bc7Pending` hold-out class

T22-PRODUCER's live arm refused **363 of 815** offered nodes with reason
`bc7Pending` and read **`holdoutRsIds = 0`** in the same census. Both numbers
were true: the members were held out, and none of them could be filed under a
key, so `atlasRefeed(rsId)` had nothing to re-offer and they stayed on the
legacy producer for the session unless their landblock happened to re-stream.
That task's Handoff #3 asked for "one look by whoever owns the ST5 markers".

The cause is a **marker gap**, read-verified this session: `__pvwRsId` is
written only for preview-BORN materials (`materials.js:5826`) and `__bc7RsId`
only after a full tier LANDS (`bc7_textures.js` full phase, `materials.js`
`_upgradeCompressedFull`). A material sitting in `__bc7Pending` — *precisely*
the state that gets it refused — carried **neither**.

Two legs: the texture lane stamps the identity at the point it asks for the
surface and fires the existing re-home seam when the verdict settles; the pool
feed's already-built (and until now unreachable) hold-out/re-offer path becomes
total and counted.

## Shipped

| file | commit | what |
|---|---|---|
| `scene3d/bc7_textures.js` | `2e4c4018` | `stampRsId` / `materialRsId` (the universal `__texRsId` marker + the ONE reader); `upgradeMaterialToBc7` stamps in the same breath as `__bc7Pending` and calls `atlasRefeed(rsId)` on EVERY settled verdict; `tiers.rsIdStamped` / `rsVerdictsResolved` / `rsRefeedsFired` on `__texStats` |
| `scene3d/materials.js` | `2e4c4018` | stamp at `_maybeUpgradeToBc7` **before** the ask-once gate (a rebuilt material never reaches the upgrade) and on the ST5 preview-born path alongside `__pvwRsId` |
| `harness/lib/diag_schema.mjs` | `2e4c4018`, `47205788` | `__texStats` stamp/seam rows; `__diag.pools` hold-out ledger rows; 3 `evidence:` lines re-verified against the shifted `bc7_textures.js` |
| `scene3d/pool_producer.js` | `47205788` | `_rsIdOf` → `materialRsId` (the one line that turns `holdoutRsIds = 0` into a real ledger); the counted hold-out/re-offer ledger; the STALE drop; the re-file ordering |
| `scene3d/pool_material.js` | `47205788` | layer records file their `rsId` through `materialRsId`; `refeedRsId` gains the FORMAT-mismatch guard |
| `harness/test_rsid_marker.mjs` (new) | `47205788` | 87-check battery, 9 parts (texture family) |

Two bisectable commits; leg 1's tree passes the full suite set on its own
(`test_draw_pools` 484/484 at that point — the `__diag.pools` registry rows
land with the counters they describe, in leg 2). Nothing pushed. No new URL
flag: the wiring rides the existing `?drawPools` chain exactly as instructed,
so `lint-url-flags` owes no row and `audit-flag-defaults` is unchanged
(`drawPools OFF`, `texCompressedOnly OFF`).

### The OFF-arm argument

The stamp is one property write per surface-backed material and is read by
nobody on the OFF arm. The seam is the load-bearing half, and its OFF-arm
identity is a **read-verified structural argument**, not an assertion:

* `?texBc7` is DEFAULT-ON, so `upgradeMaterialToBc7` — and therefore the new
  `atlasRefeed(rsId)` call — runs on the bare-default client.
* The registered handler on that arm is `static_atlas.js#_atlasRefeedImpl`,
  whose first act is `_rsMembers.get(rs)` with an early `return 0`.
* `_rsMembers` is populated at exactly two sites (`static_atlas.js:1540` and
  `:1700`), **both guarded by `texCompressedOnlyActive() && __texFullPending`**.
  Neither marker exists on the default arm.

So on the default arm the new call is one Map miss per full-tier verdict and no
behaviour at all. Battery PART 8 pins this end to end (atlas defers the pending
node exactly as before, does not track it, and the verdict's refeed leaves
`refeeds`/`rehomedNodes` at 0), and every neighbour suite listed below runs the
OFF path. A live OFF boot was **not** run — this task spent no browser budget
(see Tests run).

## Spec conformance

The orchestrator's acceptance list:

| bullet | status | evidence |
|---|---|---|
| rsId threaded onto materials/nodes at the point the texture lane knows it | **MET** | `stampRsId` at `upgradeMaterialToBc7`'s pending write (the earliest moment the id exists and strictly before any hold-out can be taken) + `_maybeUpgradeToBc7` before the ask-once gate + the preview-born path. Battery PART 2/2b. |
| stamp presence on **every** bc7-born material class | **MET** | PART 2 covers: pending (X6), already-cached (X6), the rebuilt material past `_bc7Asked`, ST5 preview-born, and variant clones (inherited through the `{...base.userData}` re-seat every clone site performs — pinned against real `THREE.Material.clone()`). |
| re-offer fires on upgrade completion | **MET** | PART 3: fires on landed, on ABSENT, on FAILED, and **not** on the pre-phase swap. PART 4 runs it end to end through the pool feed. This is pass-05 S8 point 3 verbatim, which T15 landed on the ST5 lane only. |
| admitted members leave the legacy path | **MET** | PART 4: after the verdict the node is `parent === null`, absent from the group, and present as one instance of one pool. |
| counted-never-silent (`stamped`, `reOffered`, `reOfferAdmitted`, `reOfferRefused` per reason) | **MET** | `__texStats.tiers.rsIdStamped` + `__diag.pools.producer.{heldOut,heldOutNoRsId,heldOutDupes,reOffered,reOfferAdmitted,reOfferStale,reOfferRefused}`, all registered in `diag_schema` (additive rows only) and re-verified by `test_draw_pools`' own registry check, which asserts the census publishes every registered `producer.*` / `classPages.*` path. |
| OFF-arm identity | **MET by structure + suites, live OFF boot NOT run** | argument above + PART 8 + 15 neighbour suites green |
| neighbours green (`test_tex_compressed_only`, `test_draw_pools`, diag-schema, atlas suites) | **MET** | table below |
| the live `bc7Pending`-shrink measurement | **DEFERRED-TO-BATCH** | as charged — needs the 1070 pooled arm. The counter to read is `__diag.pools().producer.heldOut` vs `reOfferAdmitted` against `classPages.refused.bc7Pending`; `producer.heldOutNoRsId` must read **0** or the stamp missed a material class. |

## Deviations

**D1 — `pool_producer.js` and `pool_material.js` were edited, though a
re-offer entry point exists.**
The brief allowed pool_producer edits "ONLY if a re-offer entry point
genuinely does not exist". `poolAtlasRefeed(rsId)` and `_holdOut` **do** exist
— T22-PRODUCER built them — but `_holdOut` began `const rs = _rsIdOf(mat); if
(!rs) return;` with `_rsIdOf` reading only the two tier-specific markers, so
the entry point was **unreachable by construction**: the ledger it feeds was
empty on the live arm and empty in every test. Making it reachable is one line
(`_rsIdOf` → `materialRsId`); the rest of the edit is the counters the charge
requires, which can only be produced where the re-offer happens. Total: 4
hunks in `pool_producer.js`, 3 in `pool_material.js`. Recorded rather than
smuggled. The concurrent ENVCELL-POOL-SWAP task's files were never staged
(`cells.js`, `pool_envcells.js` left dirty in the tree; `pool_registry.js`,
`pool_stream.js`, `upload_stage.js`, `cell_fusion.js` untouched).

**D2 — the hold-out is scoped to `bc7Pending`; `offPage` was deliberately NOT
added, though the marker now makes it re-offerable.**
T22-PRODUCER's D7 names a second re-offerable residue: a member whose declared
dims will move when its full tier lands (`texRefDimsWillMove` → `offPage`).
The marker makes filing it possible, and the ST5 upgrade would re-offer it.
It is still out, for a reason the `bc7Pending` class does not share: **a
pending BC7 verdict ALWAYS settles** (the promise resolves or rejects, and all
three outcomes now fire the seam), so a `bc7Pending` hold-out list is drained
by construction and holds no node reference past its verdict. An `offPage`
refusal has no such guarantee — a member off-page because of a bake skew has
no pending event at all, so filing it would retain a node (and its geometry
and material) for the session, and after its landblock evicted, forever. That
is a leak I would be creating, not closing. It becomes safe the moment the
refusal is tied to an event; recorded as the follow-up.

**D3 — one behaviour that is a fix, not a no-op, on the ST5 arm.**
Firing the seam from the X6 path can reach an rsId whose ST5 members are still
`__texFullPending` (possible when a palette-substituted DID legacy-routes while
another DID of the same rsId is preview-born). Traced through
`_atlasRefeedImpl`: those members are excised and re-fed, the feed path
re-tracks them in `_rsMembers` (`static_atlas.js:1700`) because
`__texFullPending` is still set, and they re-commit into the same preview-dim
bucket. Net effect is bounded churn with identical pixels and **no lost
tracking** — the re-feed re-arms the ledger. Left as is rather than adding a
guard to `static_atlas.js` (a file this task has no business editing), and
recorded because it is a real, if narrow, arm difference.

**D4 — two correctness guards landed that the charge did not ask for**, both
found by reasoning about the loop this task makes reachable for the first time:
(a) `refeedRsId` now refuses a FORMAT-mismatched layer rewrite as it already
refused a dims-mismatched one. A member admitted while its BC7 record was
already cached takes an RGBA8 page layer and then upgrades its `map` to a
`CompressedTexture`; writing that into an RGBA8 page finds no `image.data`,
and the layer-write invariant's "zero rather than inherit" rule would have
turned the member **black**. Counted `refeedFormatMismatch`, layer untouched
(PART 7 pins the bytes).
(b) the hold-out mark is cleared BEFORE the re-offer, so a member re-offered
while still pending is **re-filed** instead of dropped — otherwise the real
verdict would find nothing to re-offer and the member would be stranded
exactly the way the missing marker stranded it. This is F-11.17's "nothing can
stick" applied to the pool ledger itself; PART 4's last three checks pin it.

## Tests run

Node, from `apps/holtburger-web/`, on HEAD `47205788`.

| command | result |
|---|---|
| `node harness/test_rsid_marker.mjs` | **87 passed, 0 failed** — RSID-MARKER ✅ (new; 9 parts) |
| `node harness/test_tex_compressed_only.mjs` | 112 / 0 ✅ |
| `node harness/test_draw_pools.mjs` | **494 / 0** ✅ (includes the concurrent envcell legs on this HEAD) |
| `node harness/test_diag_schema.mjs` | 69 / 0 ✅ (the 3 `evidence:` drifts my edits caused are corrected) |
| `node test_atlas_bc7_pre_gate.mjs` / `test_bc7_pre_phase.mjs` | ALL PASS · ALL PASS (the two suites that drive `upgradeMaterialToBc7` directly) |
| `node test_static_atlas_growth.mjs` / `test_adapter_atlas_guard.mjs` / `test_mat_budget_lru.mjs` | 73/0 · 4/4 · 123/0 |
| `node harness/test_texture_worker.mjs` / `test_terrain_tier_ladder.mjs` / `test_page_resample_texref.mjs` | 69/0 · 105/0 · ✅ |
| `node test_static_batch.mjs` / `_x` / `_callpes` / `test_stat_batch_walk.mjs` / `test_dead_batch_skip.mjs` / `test_static_merge_projection.mjs` / `test_cell_lights.mjs` / `test_first_bake_batch_flags.mjs` / `test_p1_alias_split.mjs` | 13/0 · 40/0 · 22/0 · 98/0 · 33/0 · 71/0 · 18/0 · 84/0 · 9/9 |
| `node harness/test_build_shell.mjs` / `test_console_allowlist.mjs` / `test_report_v2.mjs` / `test_census_class.mjs` / `test_residency_grid.mjs` / `test_slotgrid_lru_assert.mjs` / `test_frame_work.mjs` / `test_geom_bundles.mjs` / `test_cell_fusion.mjs` | 56/0 · ✅ · ✅ · ✅ · ✅ · ✅ · ✅ · ✅ · 20/0 |
| `node scripts/lint-url-flags.mjs --app apps/holtburger-web` (repo root) | 0 undocumented readers owed docs rows (no new flag) |
| `node scripts/audit-flag-defaults.mjs --all` (repo root) | `drawPools OFF` / `texCompressedOnly OFF` — unchanged |

**No browser was launched.** The optional headless SwiftShader arm was not
needed: the node seams prove the whole flow (the refusal, the filing, the
verdict, the re-offer, the admission, the scene-graph exit) against the real
`upgradeMaterialToBc7`, the real `MaterialCache`, the real
`ClassMaterialRegistry` and real `THREE.BatchedMesh` pools. The one thing node
cannot show is the live population, which is the DEFERRED-TO-BATCH item anyway.

**Transient during the run, not mine:** `test_draw_pools` briefly read 492/2
while the concurrent ENVCELL-POOL-SWAP task was mid-leg (both failures inside
its then-untracked `pool_envcells.js`, PARTs 23–24). It reads 494/0 on the
HEAD reported here. `docs/RESULTS-shell-requests-2026-08-09.json`, regenerated
by `test_build_shell.mjs`, was **restored** (it is T11's measurement record —
T22's precedent).

## Handoffs & risks

1. **The live measurement (DEFERRED-TO-BATCH).** On the next pooled 1070/
   SwiftShader arm read, in one census: `producer.heldOut`,
   `producer.reOfferAdmitted`, `producer.heldOutNoRsId` (**must be 0**), and
   `classPages.refused.bc7Pending`. The prediction this task makes falsifiable:
   the 363 become filed hold-outs that convert to pooled members as their
   verdicts land, so `reOfferAdmitted` should approach the refusal count and
   the pooled share should climb off 149/815 without any bake change.
   `tiers.rsRefeedsFired` should equal `rsVerdictsResolved` on any armed arm.
2. **`offPage` is the next re-offerable residue (D2)** — the marker already
   supports it; what it needs is an event to hang the drain on, so that a
   filing cannot outlive its landblock. Natural owner: whoever lands the
   page-dim dist, since `texRefDimsWillMove` is that dist's own progress meter.
3. **`refeedFormatMismatch > 0` on a live arm means the already-cached-record
   race is real** (a member took an RGBA8 page layer and then upgraded to BC7).
   It is now fail-soft and counted rather than black, but the fix is to hold
   that member out too — it is the same shape as `bc7Pending`, minus the
   marker, and it wants the same treatment.
4. **The atlas-side throwaway is now exercised on the X6 path too** (D3). When
   `static_atlas.js`'s re-home implementation retires at ST9 (F-11.17 says it
   is a conscious throwaway), the churn described in D3 retires with it.
5. **Working tree:** the concurrent ENVCELL-POOL-SWAP task's `cells.js` and
   `pool_envcells.js` were dirty throughout and were never staged. Its
   `pool_material.js` / `pool_producer.js` edits and mine interleaved cleanly;
   both files are shared between the two tasks and the orchestrator should know
   that if it sequences further work in them.
