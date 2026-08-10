# RELIEF-IN-BAKE — bake gfxRelief into HBG1 GEOM variants: implementation report

Agent: RELIEF-IN-BAKE implementation agent. Date: 2026-08-10. Stage: post-ST3
enhancement (closes T13 D3). Brief:
`docs/reengineering/queued/RELIEF-IN-BAKE-brief.md`.

Scope touched: `crates/holtburger-dat/src/hbg1.rs`,
`apps/holtburger-tools/src/{pack_format.rs,pack_bake.rs,bin/dat-shard.rs}` +
`tests/bake_ci.rs`, `crates/holtburger-resource-http/src/pack.rs`,
`apps/holtburger-web/src/{geom_bundles.rs,pack_source_glue.rs}`,
`scene3d/{geom_bundles.js,gfx_relief.js}`, `harness/test_geom_bundles.mjs`,
`harness/lib/diag_schema.mjs`, `docs/url-flags.md`. Recorded
out-of-scope-adjacent edit (I2, unavoidable + precedented by T13): `index.html`
(the relief-override block — the only place the interplay lives).

## Shipped

| commit | what |
|---|---|
| `60395dbc` | **Leg 1 — codec.** `hbg1::ReliefBake` + `encode_gfx_part_relief`; `encode_gfx_part` becomes a wrapper over a shared inner encoder with `None`, so the relief-free default (the byte-exact differ baseline) is untouched. `CornerKey` gains a `synth` ordinal (0 for every source-vertex corner ⇒ relief-free bytes unchanged); rail corners are synthetic and never merge, mirroring the runtime's de-indexed rail emission. Rails inherit the parent polygon's (pos_surface DID, sides_type, stippling) so every rail triangle lands in an EXISTING subset. 5 unit tests incl. the additive invariant. |
| `53c6e266` | **Leg 2 — bake.** `section_kind::GEOM_RELIEF` (`GEOMR`, 0x0C, same row layout as GEOM); `GeomBaker` variant pass + census; `dat-shard --emit-packs --geom-relief <SCALE>`; `--verify-closure` leg (e) (every GEOMR row is kind-0 for a 0x01 id with a co-located default row AND structurally additive over it); BAKE-CI arm `bake_ci_relief_variants`. Without the flag the bake is byte-identical. |
| `f7e8b48c` | **Leg 3 — PackSource + assembly.** GEOMR registration/eviction/`geom_relief_payload` + `geom_relief_rows` stat; `pack_geom_payload_relief` (variant-first, default-second); new wasm exports `assemble_model_geometry_relief` + `geom_relief_rows_resident`; fixture + real-DAT relief differs. Release wasm rebuilt (6,423,996 B) and rsync'd into `pkg/`. |
| `a4f94b7f` | **Leg 4 — consumer.** `?reliefBundles=on` DEFAULT-OFF with four loud arming legs; variant routing in `assembleModels`; `__diag.geometry.relief` registered; test_geom_bundles 54 → 78 checks; url-flags row + `geomBundles`/§0 amendments; `gfx_relief.js` "WHERE THE DECISION RUNS" section; index.html conditional override. |
| (this commit) | Report + IMPLEMENTATION.md status row. |

## Spec conformance

The brief's five local-acceptance bullets, each with evidence.

- **(a) bake emits relief-variant GEOM alongside the relief-free default for a
  bounded region (BAKE-CI-style leg); big artifacts off the source tree** —
  **MET.** `bake_ci_relief_variants` (`#[ignore]`, release) bakes the same
  bounded region T13/T10 use, to `/mnt/wbterminal2/reeng/relief-bake/`.
  Measured [M] @scale: bounded region (Holtburg 11×11 + densest-interior 3×3):
  GEOM unchanged at **1,927 rows / 2,238,672 B raw / max 23,036 B** — identical
  to the T13 report's numbers, i.e. the default emission did not move; GEOMR
  **125 rows / 83 distinct models changed / 713 unchanged (no row written) /
  +7,760 triangles / 1.32 MB raw / max payload 41,368 B**; variant key
  `rails-l0-s1.000-w0.060-h0.050-rw0.050-rh0.030-e1.000-c60.0`. Runtime 79 s.
  `--verify-closure` ran (incl. the new GEOMR additive leg).
- **(b) native differ: variant payload byte-matches a fresh variant encode, AND
  the relief-free default remains byte-identical to today's** — **MET,** both
  halves, at two layers.
  *Container layer* (`bake_ci_relief_variants`): all **796** default 0x01 rows
  re-encode byte-identically through `encode_gfx_part`, and all **125 GEOMR
  rows / 83 unique variants** byte-match a fresh `encode_gfx_part_relief`.
  *Codec layer* (`hbg1` unit tests): re-encode determinism; a no-op profile
  (`scale 0`, or any `subdiv_level != 0`) reproduces the default bytes exactly;
  a prop-scale model that fails `ModelGate` is byte-identical to its default.
  *Existing differs untouched and re-run green* — see Tests run.
- **(c) consumer behind its DEFAULT-OFF flag assembles the variant and the
  geometry differs from relief-free exactly by the relief** — **MET, in a
  STRONGER form than the brief's wording; see DEVIATION D1** (the delta is
  appended triangles, not a position-only delta — the shipped relief mechanism
  adds rails rather than displacing vertices). Asserted three ways:
  (i) `differ_relief_variant_matches_runtime_relief` (fixture, always-run): with
  relief resolved ON at the shipped preset the BAKED variant assembles to
  exactly the RUNTIME triangulation — same surface set, same triangle multiset,
  positions/uvs bit-exact; plus the relief-OFF control on the same model;
  (ii) the delta check in the same test: relief invents or drops no material,
  and every relief-free triangle is still present unmoved;
  (iii) `differ_real_dats_relief_variants` (`#[ignore]`, release,
  `--test-threads=1`): **120 GfxObjs EXACT** vs the runtime relief
  triangulation, 10 of them carrying a variant row (+1,968 tris).
  The same additive property is enforced at BAKE time by `verify_geom` leg (e),
  so a variant that moved a base triangle or invented a subset cannot ship.
- **(d) OFF arm byte-identical** — **MET.** Four independent OFF arms, each
  asserted rather than argued:
  *bake* — no `--geom-relief` ⇒ `GeomBaker.relief = None`, no GEOMR section, and
  the GEOM census numbers above are identical to T13's;
  *dist* — a pre-relief dist has no 0x0C section; PackSource's registration loop
  never runs and `geom_relief_rows = 0`;
  *wasm* — `assemble_model_geometry` is untouched; the variant is a SEPARATE
  export, so no caller can pass a stray truthy argument;
  *JS* — `?reliefBundles` absent ⇒ `_state.relief === false` ⇒ `assembleModels`
  calls the relief-free export (suite check "OFF arm calls the relief-FREE
  export"), and index.html still force-disables relief under `?geomBundles`.
  `lint-url-flags --strict` exit 0 (2 pre-existing presence-guards only);
  `audit-flag-defaults --mismatch` exit 0.
- **(e) JS battery per house style** — **MET.** `harness/test_geom_bundles.mjs`
  54 → **78 checks**, new PART 7: flag grammar (9 cases, EXACT-MATCH), the four
  arming legs each disarming loudly, the OFF-arm routing invariant, variant
  routing when armed, the `0 GEOMR rows resident` loud warning, and the
  `_testArm({relief:true})` seam. `test_diag_schema` 67 green with the three new
  `__diag.geometry.relief` fields registered.
- **Eye pair on real GPU** — **DEFERRED-TO-BATCH** (next 1070 session). Queue
  item spelled out under Handoffs; nothing was simulated (I9).
- **Flag lifecycle (I7)** — **MET.** `?reliefBundles` DEFAULT-OFF, EXACT-MATCH,
  requires `?geomBundles` + `?packSource` + relief resolving ON + subdivLevel 0.
  No default was flipped. The url-flags row states the flip is a migration event
  gated on the eye pair.
- **Retirement rationale untouched** — **MET.** The per-texel/luminance height
  path is not re-implemented, not re-enabled and not re-argued anywhere in this
  change. `ReliefBake::is_noop()` actively REFUSES any `subdiv_level != 0`
  profile, and the JS arm refuses to engage when `gfxSubdivLevel > 0`, precisely
  so nobody can accidentally claim a level the bake cannot reproduce.
- **Shadow policy unchanged** — **MET.** Presets keep `gfxSubdivLevel 0`; the
  baked rails are the same triangles the runtime already emits at that level, so
  the shadow-pass vertex bill is unchanged by construction (this task moves
  where they are produced, not how many there are).

## Deviations

- **D1 — DEVIATION: the brief's acceptance (c) "position-only delta;
  normals/uv/indices identical" because** read-verification of the shipped
  relief mechanism contradicts that shape. The brief describes relief as
  "subdivision + outward displacement, `gfx_subdiv.rs`". That module's
  *displacement* API (`weld_vertex_amplitudes` /
  `subdivide_displaced_triangle`) has **no caller outside its own tests**
  (`rg` over `apps/` + `crates/`), and the runtime's only `gfx_subdiv` call
  site is `subdivide_displaced_triangle_sampled`, gated on
  `relief_cfg.filter(|c| c.subdiv.level > 0)` **and** a decoded surface height
  field — the per-TEXEL path retired 2026-07-30. At the shipped presets
  (`gfxSubdivLevel = 0` on every tier) the ONLY live relief is
  `gfx_remodel`'s OP1 convex-edge + OP3 material-boundary **rails**
  (`apps/holtburger-web/src/lib.rs`, the "OP1 — texture-blind convex-edge
  rails" block), which are ADDITIVE triangles inheriting their parent
  polygon's material identity. So the honest invariant is *"same subset table
  (same materials, same flags, same order) + appended whole triangles + every
  base vertex bit-identical"*, and that is what is asserted — at bake
  (`verify_geom` leg (e)), in the codec unit tests, and in both consumer
  differs. It is strictly stronger than a position-only delta claim would have
  been, because the fixture/real-DAT differs compare against the RUNTIME's own
  relief output rather than against a derived expectation. Baking the unused
  displacement API instead would have matched the brief's wording while
  producing geometry the client never renders.
- **D2 — DEVIATION-class scope note: kind-2 ENV (interior) variants are NOT
  baked, because** the runtime's interior rails are computed per CELL, not per
  cellstruct: `append_environment_tris` builds
  `ModelTopology::build(&cell.polygons, surfaces, &cell.portal_poly_ids, …)`
  where `surfaces` is the **EnvCell's own resolved DID list**, and OP3 fires on
  *material boundaries*. Two slots can resolve to the same DID in one cell and
  to different DIDs in another, so "these two polygons carry different
  materials" is not a property of the shared cellstruct that HBG1 kind-2 blocks
  encode. The designed shape for closing it is the T13-D4 pattern already in the
  format (emit rails tagged with their slot PAIR in the reserved bytes; drop
  them per cell when the pair resolves equal) — named remainder, not attempted
  here. Consequence for the eye pair: on the relief arm, exterior architecture
  is railed and interiors are flat, where the legacy relief arm rails both. The
  queue item says so explicitly.
- **D3 — sub-spec note: kind-1 SETUP directories have no variant** and need
  none — they carry part DIDs, frames, scales and hinges, no vertex data. A
  fused setup picks relief up through its parts, which is why the variant read
  is keyed on 0x01 ids only.
- **D4 — sub-spec note: no manifest change.** Variant selection is by SECTION
  PRESENCE (a pack either carries GEOMR rows or does not), not by a manifest
  field, so a relief dist and a relief-free dist are the same wire contract and
  a client can be pointed at either. `geom_relief_rows_resident()` is the
  readback, and 0 rows warns loudly at arm rather than silently rendering flat.
  The bake report records `geom_relief_variant` (the resolved profile key) so a
  dist's variant identity is auditable.
- **D5 — sub-spec note (test methodology):** `differ_real_dats_relief_variants`
  writes the crate-global relief atomics directly (`set_gfx_relief` is
  `#[cfg(target_arch = "wasm32")]`), so it MUST run with `--test-threads=1` —
  documented on the test. This is why it is a separate `#[ignore]` test rather
  than an extension of `differ_real_dats_models`.

## Tests run

Rust via `capped-build`, single package, rust-analyzer killed first (I5); node
direct; NO browser (the eye pair is 1070 work — I9). Counter values are
correctness reads; the one @scale figure is tagged.

```
capped-build cargo test -p holtburger-dat --lib hbg1          9 passed, 0 failed (5 NEW)
capped-build cargo test -p holtburger-dat --lib               689 passed, 1 PRE-EXISTING failure
                                                              (terrain_subdiv::triangle_corner_ring_matches_height_sampler
                                                               — T10/T13 reports, untouched)
capped-build cargo test -p holtburger-tools --lib             38 passed, 0 failed
capped-build cargo test -p holtburger-resource-http --lib     26 passed, 0 failed
                                                              (incl. NEW geom_relief_variants_register_sparsely_and_evict)
capped-build cargo test -p holtburger-tools --release --test bake_ci -- --ignored --nocapture bake_ci_relief_variants
    ok in 79 s  @scale: bounded region (Holtburg 11x11 + densest-interior 3x3)
    variant=rails-l0-s1.000-w0.060-h0.050-rw0.050-rh0.030-e1.000-c60.0
    796 default 0x01 rows byte-identical | 83 unique variants / 125 rows byte-identical re-encode
    report: changed 83 / identical 713 / +7,760 tris / 1.32 MB raw / max 41,368 B
    GEOM unchanged: 1,927 rows / 2,238,672 B / max 23,036 B (== the T13 report)
capped-build cargo test -p holtburger-web --lib geom_bundles  4 passed (1 NEW fixture relief differ), 4 ignored
capped-build cargo test -p holtburger-web --lib --release geom_bundles::tests::differ_real_dats_relief_variants
    -- --ignored --nocapture --test-threads=1
    ok in 97 s: 120 GfxObjs EXACT vs runtime relief; 10 carry a variant row (+1,968 tris)
capped-build cargo test -p holtburger-web --lib --release geom_bundles::tests::differ_real_dats_models
    -- --ignored --nocapture --test-threads=1
    ok: 300 GfxObjs EXACT + 150 setups position-exact (UNCHANGED by this task)
capped-build cargo test -p holtburger-web --lib               230 passed, 1 PRE-EXISTING failure
                                                              (tests_substitution::resolve_static_placement_frame_orders —
                                                               VERIFIED identical at pre-task commit 63ffea2c by
                                                               checkout/run/restore of the four Rust files)
capped-build wasm-pack build --target web --out-dir pkg-relief --release
    ok; 6,423,996 B (release-class; pre-relief 6,404,273 B backed up to
    /mnt/wbterminal2/reeng/relief-bake/pkg-backup-pre-relief.wasm); rsync -a --delete pkg-relief/ pkg/;
    assemble_model_geometry_relief + geom_relief_rows_resident verified in pkg/holtburger_web.d.ts

node harness/test_geom_bundles.mjs        78 passed, 0 failed   GEOM-BUNDLES ✅  (was 54)
node harness/test_diag_schema.mjs         67 passed, 0 failed   (21 surfaces; __diag.geometry.relief registered)
node harness/test_cell_fusion.mjs         20/0 · test_pack_fetch_controller.mjs 92/0
node harness/test_draw_pools.mjs ✅ · test_tex_compressed_only.mjs 112/0
node harness/test_console_allowlist.mjs ✅ · test_residency_grid.mjs ✅ · test_frame_work.mjs ✅
node harness/test_texture_worker.mjs      69/0
statics family:   test_landblock_lru_evict 39/0 · test_dead_batch_skip 33/0 · test_stat_array_merge 115/0
buildings family: test_walkin_instance_guard 7/0 · test_walkin_instance_evict 7/0
anim-scenery:     test_animated_scenery 16/0 · test_animated_scenery_park 12/0
cells family:     test_cell_lights 18/0 · test_portal_stencil_alloc 20/0;
                  test_envcell_guard FAILS IDENTICALLY WITH HEAD's index.html (verified by
                  swapping in `git show HEAD:…/index.html` and re-running) — the pre-existing
                  splice-stub gap T13 recorded; NOT this task's defect
node scripts/lint-url-flags.mjs --strict         exit 0 (2 pre-existing presence-guards; 0 new findings)
node scripts/audit-flag-defaults.mjs --mismatch  exit 0 (reliefBundles row agrees with its reader)
```

## Handoffs & risks

- **1070 QUEUE ITEM — E-RELIEF eye pair (DEFERRED-TO-BATCH).** The pair, with
  verified spellings:
  - arm A (baked relief):
    `?packSource=on&geomBundles=on&reliefBundles=on&gfxRelief=on&gfxSubdivLevel=0`
  - arm B (runtime relief, bundles off): `?gfxRelief=on&gfxSubdivLevel=0`
  Prereqs the queue MUST carry: (1) the dist must be baked with
  `dat-shard --emit-packs --geom-relief 1.0` — against a relief-free dist the
  arm warns `0 GEOMR rows resident` and renders flat, which would score a false
  CLEAN; assert `__diag.geometry.relief.variantRowsResident > 0` before
  judging. (2) **Interiors are expected to differ** — arm A rails exteriors only
  (D2), so score exterior architecture and treat interiors as known-flat until
  the ENV variant lands. (3) `__diag.geometry.relief.armed === true` and
  `window.__gfxRelief` both read on. Fresh Chrome per arm; the walls forbid
  cross-boot comparison.
- **Full-world bake** emits GEOMR only when `--geom-relief` is passed — the
  invocation is otherwise unchanged and the relief-free dist stays the default.
  Cost signal from the bounded region: +1.32 MB raw for 83 models; ~10% of
  distinct GfxObjs carry a variant, so the whole-world variant section should
  stay a small fraction of GEOM. Re-read `geom_relief_*` from
  `pack-report.json` before any B1 restatement.
- **Named remainders**: (1) ENV/interior relief variants (D2 — the slot-pair
  drop rule is designed, not built); (2) a t-level ladder of variants
  (`subdiv_level > 0`) is representable in `ReliefBake` but not producible
  without a bakeable height source — it is deliberately refused today; (3) the
  bake-worker wasm instance still resolves relief for its own runtime decode
  path, untouched here (assembly is main-instance only, T13 D6a).
- **Risk — variant/default skew across packs.** A model inlined into several
  tile packs writes its variant row into each; the encode-once memo makes the
  bytes identical and PackSource keeps the first copy, same discipline as GEOM.
  `verify_geom` leg (e) re-checks every row in every pack, so skew fails the
  bake rather than the frame.
- **Unrelated dirty state**: none left by this task. A sibling agent's terrain
  tier ladder work (`scene3d/terrain_bc7.js`, `harness/test_terrain_tier_ladder.mjs`)
  was in flight at task start and had landed by the time the shared files
  (`diag_schema.mjs`, `url-flags.md`) were edited; both were re-read clean
  immediately before editing, and only additive rows were inserted.
