# T13 — ST3: HBG1 geometry bundles + consumer swap (`?geomBundles`): implementation report

Agent: T13 implementation agent. Date: 2026-08-09. Scope:
`crates/holtburger-dat/src/hbg1.rs` (new) + `lib.rs` (mod decl),
`apps/holtburger-tools/src/pack_bake.rs` + `tests/bake_ci.rs`,
`crates/holtburger-resource-http/src/pack.rs`,
`apps/holtburger-web/src/{lib.rs,geom_bundles.rs,pack_source_glue.rs}`,
`scene3d/{geom_bundles.js,statics.js,buildings.js,animated_scenery.js,cells.js}`,
`harness/**`, `docs/url-flags.md`, queue-1070 prereq strings, S7.3 register row.
Recorded out-of-scope-adjacent edit (I2, unavoidable + precedented): `index.html`
(arming + the relief override — the T12/T15 arming-site precedent).

## Shipped

| commit | what |
|---|---|
| `9d6f5205` | **HBG1 codec** (`crates/holtburger-dat/src/hbg1.rs`): encoder + decoder for GEOM encoding 0x0001 — kind 0 PART (indexed, corner-dedup `(vertex_id, effective_uv_index, side, quantized_normal)`, subsets by (surface, sidedness, stipple), snorm8 normals, source-order winding, u16/u32 indices), kind 1 SETUP directory (pose chain idle-anim → retail placement 0x65→0→first, per-part scale, hinge chain 0→1→first, fused bbox, bake-resolved single-part degrade), kind 2 ENV directory (per-cellstruct blocks, SLOT refs, zero-filled baked-light stream, unconditional back faces + pair-slot for the per-cell DID rule); GEOM section codec. 4 unit tests. |
| `01667d23` | **Bake emission + BAKE-CI**: `GeomBaker` (encode-once memo + census) adds a GEOM section co-located with every pack's model-class records (CORE/META/ENV/interior/tile); `--verify-closure` gains `verify_geom` (co-location, kind-vs-prefix, kind-1 part coverage, kind-2 envcell coverage); report census fields. BAKE-CI HBG1 differ leg: every GEOM row re-encodes byte-identically from the base DATs. |
| `2ff4b1a6` | **Wasm half**: PackSource GEOM registration (admission/eviction/`geom_payload`, T15 PVW pattern + unit test); `src/geom_bundles.rs` — `assemble_models` (kind-0 pass-through; kind-1 fusion with the runtime's exact scale→rotate→translate order, per-part + hinge + model-wide index rebase; missing part ⇒ whole model `missing`) and `assemble_envcells` (slot→DID remap, per-cell back-face DID rule, vertex light bake over UNIQUE verts via the shared vertex_bake port); `assemble_model_geometry`/`assemble_envcell_geometry` exports (one buffer + JSON descriptor); the 3-fixture + real-DAT runtime differs. Release wasm 6,404,273 B rsync'd into `pkg/`. |
| `4c6b703a` | **JS adapter**: `scene3d/geom_bundles.js` (`geomBundlesEnabled` EXACT-MATCH DEFAULT-OFF, `initGeomBundles` 6-leg loud arming, `bundleToGeometryGroups`/`bundleToPartGroups`/`cellToGeometryGroups`, assemble wrappers, `__diag.geometry` current); index.html ON-arm-only arming + the relief force-off; `harness/test_geom_bundles.mjs` (54); registry reserved→current; url-flags row + §0 adjudication row. |
| `2d39b630` | **Consumer swap 1 — statics**: `fetchPrimaryGeometries` + `fetchDegradedGeometries` bundle-first with counted legacy residue; starvation classes structurally absent for bundle-served models. |
| `df28e4a8` + `7252efdb` | **Consumer swap 2 — buildings**: `bakeBuildingPlacement` per-part + hinge from the kind-1 descriptor; `incomplete` impossible by construction on the bundle arm. The fixup commit converts the two consumer imports to single-line (the splice-loader contract) and corrects the swap-2 commit message's test claims. |
| `2e2b3b79` | **Consumer swap 3 — animated scenery**: `_getSharedSetupGeom` decode-once from the bundle (same cache shape, memcpy-scale). |
| `5865018c` | **Consumer swap 4 — cells**: one sync `assemble_envcell_geometry` per LB; bundle-served cells build groups (incl. normalized `acBakedLight`) from the descriptor; per-cell takeMesh fallback counted. |
| (this commit) | Report + status row + queue-1070 prereq strings (E1 + P-ASSEMBLE, surgical) + the S7.3 register note on the statics starvation machinery. |

## Spec conformance

SPEC §3 T13: *"HBG1 emission (encoding 0x0001), `assemble_model_geometry` /
`assemble_envcell_geometry` exports, `bundleToGeometryGroups`; consumers swap in fixed
order (statics → buildings → animated-scenery decode-once → cells), one commit each so
defects bisect. Deps: T12. Acceptance: GATE-GEOM — differ green (mechanical bake
correctness), E1 eye item CLEAN (Batch A), P-ASSEMBLE sanity, parked-mid p50
non-regression (PC-2 interleaved arms). Kill: K2."*

- **HBG1 emission (encoding 0x0001)** — **MET.** Kind 0/1/2 payloads per pass 4 S1
  (layout deviations D1 below), emitted into a GEOM section co-located with each pack's
  model-class records; `--verify-closure` covers co-location + part/envcell closure;
  deterministic (pure function of the parsed records; cross-run tree identity green).
  Bounded region [M]: 1,927 rows / 1,209 unique payloads / 2.24 MB raw / 0 soft-cap
  hits / max payload 23,036 B (u16 indices sufficed everywhere — the pass 4 Q2 census);
  ring tile packs 1.78 → 2.20 MB, inside S6.2's +0.37× projection, p99 restatement
  trigger untouched. The queued overnight full-world bake emits GEOM with no CLI change
  (`--emit-packs` unchanged; the pack step stays additive-only, BAKE-CI-pinned).
- **`assemble_model_geometry` / `assemble_envcell_geometry` exports** — **MET.** Sync
  over resident packs, ONE JS-owned buffer + descriptor per call (pass 4 D-04.5: no
  wasm-bindgen handles, no `free()`, transferable by construction); missing payloads are
  per-entry `missing` (JS fallback, counted) — never a partial mesh. Setups fuse with
  bit-identical positions (same `quat_rotate` expansion, scale pre-rotation); envcells
  remap slots, apply the per-cell back-face DID rule, and light-bake over unique verts
  (0.38× arithmetic, D-04.7). Exports verified in `pkg/holtburger_web.d.ts` (release,
  6,404,273 B).
- **`bundleToGeometryGroups`** — **MET.** Returns the `meshToGeometryGroups` shape
  exactly (default arm buckets by surface with `doubleSided: true`; `?perPolyCull` arm
  splits by (surface, sides); per-surface stipple OR; fallback-0 bucket; per-part +
  hinge and cell variants) with shared-attribute views + per-group compact index
  arrays, `setIndex` present. Suite-pinned equivalence vs `meshToGeometryGroups` on a
  shared triangle fixture, both arms (harness/test_geom_bundles.mjs, 54 checks).
- **Consumer swap in fixed order, one commit each** — **MET.** statics `2d39b630` →
  buildings `df28e4a8` → animated scenery `2e2b3b79` → cells `5865018c`, each with the
  counted-never-silent runtime fallback and the OFF arm behind `geomBundlesActive()`.
- **GATE-GEOM: differ green (mechanical bake correctness)** — **MET.**
  (a) BAKE-CI HBG1 differ: every GEOM row in every bounded-region pack re-encodes
  byte-identically from the base DATs (1,209 unique payloads).
  (b) Runtime differ (H-04.6d), native tests in holtburger-web: 3 fixture differs pin
  bundle-vs-runtime equality (0x01 exact — positions/uvs bit-exact, normals ==
  quant→dequant; setup positions bit-exact + normals ≤ 1 quant step + hinge contract;
  envcell vs `append_environment_tris` under BOTH a distinct-DID and a same-DID palette
  — back face kept/dropped per cell — + the black no-light bake). REAL-DAT differ
  (`--ignored`, release): **300 GfxObjs EXACT + 150 setups position-exact** against
  `~/ac_base_dats` (setup arm caveat: D5).
- **GATE-GEOM: E1 eye item CLEAN** — **DEFERRED-TO-BATCH** (Batch A; queue prereq
  updated with the verified flag spelling + the relief-parity note — see D3).
- **GATE-GEOM: P-ASSEMBLE sanity** — **DEFERRED-TO-BATCH** (Batch A; queue prereq
  updated with the verified export names; `__diag.geometry.bundles.msAssemble` is now
  readable directly).
- **GATE-GEOM: parked-mid p50 non-regression (PC-2 interleaved arms)** —
  **DEFERRED-TO-BATCH** (browser + 1070; PC rules forbid cross-boot single shots; no
  browser was launched this session per the task directive).
- **Flag lifecycle (I7)** — **MET.** `?geomBundles` DEFAULT OFF, EXACT-MATCH opt-in,
  requires `?packSource` (structural: assembly reads PackSource payloads; arming gate
  loud on every leg). OFF arm byte-identical at the behavioral level: consumers read
  `geomBundlesActive()` (false unless index.html armed it), index.html does not even
  import the module, and every touched-family suite passes unmodified (Tests run).
  `lint-url-flags --strict` adds 0 findings (the 2 pre-existing presence-guards only);
  `audit-flag-defaults` exit 0. Kill-cascade: the packSource url-flags row already
  names `geomBundles` in its cascade list; the structural gate disarms it when the
  controller is unarmed.

## Deviations

- **D1 — DEVIATION: pass 4 S1 declared sizes because** the spec's own field lists do
  not sum to its declared row sizes (the T10-D1 class): subset rows are **16 B**
  (declared 12; fields sum 16), MeshHeader is padded to its declared 44 with a trailing
  reserved u32 (fields sum 40), and the kind-1 part row is **72 B** (declared 40;
  fields sum 32) because two load-bearing per-part values the runtime consumes are
  otherwise unrepresentable: `default_scale` (applied PRE-rotation,
  walk_setup_parts lib.rs:7174-7193) and the hinge frame, whose fallback chain
  (0→1→first, `compute_hinge_frames`) DIFFERS from the pose chain (idle-anim →
  0x65→0→first). Byte-truth documented in the hbg1.rs module header.
- **D2 — DEVIATION: pass 4 S3 "normal/uv/[baked] offsets derived from the fixed S1
  layout" because** shipping snorm8/padded streams to JS would change every consumer's
  attribute shapes (interleaved normalized Int8 attributes) — a three-interop risk
  class this task has no eye coverage for. The BUNDLE carries f32 normals + tight u8×3
  baked light (assembly dequantizes, memcpy-scale); S1's snorm8/padded forms remain
  the WIRE format byte-for-byte. Pool-owned quantized storage is the declared pass-7
  revisit (H-04.3) — ST9 may adopt the raw streams then.
- **D3 — DEVIATION-class interplay pass 4 does not address: `gfxRelief`.** Relief
  (rails; preset-ON at mid/high/ultra since 2026-07-30) mutates triangulation OUTPUT
  per-instance; HBG1 bakes the relief-free default (the config is a client knob —
  unbakeable). Minimal sound thing: `?geomBundles=on` forces relief OFF instance-wide
  (a mixed railed/flat world is incoherent; fallback models must match bundle models);
  an explicit `?gfxRelief=on` wins and DISARMS bundles loudly. Consequence for E1:
  the OFF arm at quality mid renders rails — the queue prereq now instructs authoring
  `&gfxRelief=off` on the OFF arm for an apples-to-apples pair. Orchestrator note:
  if relief is meant to survive into the pooled world, ST9 needs a relief-aware
  bundle answer (bake variant or runtime rail overlay) — flagged, not designed here.
- **D4 — ENV back-face bake/load split (recorded design decision):** the runtime emits
  a distinct back face only when the CELL-resolved pos/neg DIDs differ
  (append_environment_tris lib.rs:19651-19661; palette-dependent per F14-2), which no
  per-cellstruct bake can decide. HBG1 kind-2 blocks carry back-face subsets
  UNCONDITIONALLY (flag bit 3 + paired positive slot in the reserved bytes;
  `ENV_SLOT_NONE = 0xFFFFFFFF` because slot 0 is legitimate) and the per-cell assembly
  drops a back subset whose resolved DID is 0 or equals its paired front — differ-pinned
  under both palettes. Wire cost: the dropped side's indices ride the payload (zstd'd).
- **D5 — sub-spec note (differ methodology):** the real-DAT setup differ drives the
  runtime walk with the directory-resolved pose because NATIVE builds hardcode
  `placement_id_flag() == false` (legacy 0→1→first) while the live wasm default is the
  retail chain (0x65→0→first) the bake mirrors — a bare native `triangulate_model`
  compares the wrong chain. The transform path stays independently exercised; chain
  semantics are pinned by the fixture differ + hbg1 unit tests. (The JS arming gate
  disarms bundles under `?placementId=off` for the same reason.)
- **D6 — sub-spec notes:** (a) assembly runs on the MAIN wasm instance only — worker
  pack leases remain ST7/T22 scope (T12 D5 / T20 D5 carried forward); the bake-worker
  path is untouched. (b) cells: `fetchEnvCellsInLandblock` still triangulates
  internally for collision/AABB/portal products at ST3 — the bundle replaces the
  render-mesh drain + boundary copies; retiring the producer is ST9/ST10 (pass 4
  D-04.4 keeps collision record-based regardless). (c) `__diag.geometry.entityDecode`
  fields read 0 until the entity-path instrumentation lands (registry note updated) —
  named remainder. (d) terrain's bundle-form export (pass 4 S4 terrain row — getter-
  clone retirement) is NOT in the T13 card's consumer list and did not land — named
  remainder. (e) the corner-dedup key extends pass 4 D-04.1's `(vertex_id, uv_index,
  side)` with the quantized normal (per-tri face-normal FALLBACK would otherwise merge
  corners with different normals) — hbg1.rs header. (f) bundle groups share ONE set of
  attribute views per entry; disposing one group's geometry can force three to
  re-upload a sibling's shared attribute if lifetimes ever diverge — today every
  consumer disposes a model's groups together per LB, and ST9's pools replace this
  ownership entirely; risk noted for the interim.

## Tests run

Rust via `capped-build`, rust-analyzer killed first (I5); node direct; NO browser (E1 /
P-ASSEMBLE / p50 are Batch-A legs — I9). No @scale-tagged perf figures claimed; counter
values are correctness reads.

```
capped-build cargo test -p holtburger-dat --lib                 684 passed, 1 PRE-EXISTING failure
                                                                (terrain_subdiv triangle_corner_ring — T10 report,
                                                                verified on clean HEAD, untouched)
capped-build cargo test -p holtburger-tools --lib               38 passed, 0 failed
capped-build cargo test -p holtburger-resource-http --lib       25 passed, 0 failed (incl. NEW geom_register_serve_and_evict)
capped-build cargo test -p holtburger-tools --release --test bake_ci -- --ignored --nocapture
    ok in 214 s @scale: bounded region (T10's Holtburg 11x11 + densest-interior 3x3):
    56 packs / 38 tiles / 4 interiors / 127 LBs; legacy differ 2,022 models + 3,365
    envcells byte-identical (unchanged); HBG1 differ 1,209 unique payloads / 1,927 rows
    byte-identical re-encode; GEOM census 2.24 MB raw / 0 soft-cap / max 23,036 B;
    determinism + closure + verify_geom + texrefMissingPvw=0 green
capped-build cargo test -p holtburger-web --lib geom_bundles    3 passed (fixture differs), 1 ignored
capped-build cargo test -p holtburger-web --lib --release geom_bundles::tests::differ_real_dats_models -- --ignored
    ok: 300 GfxObjs EXACT + 150 setups position-exact vs ~/ac_base_dats
capped-build wasm-pack build --target web --out-dir pkg-t13 --release
    ok; 6,404,273 B (release-class); rsync -a --delete pkg-t13/ pkg/;
    assemble_model_geometry + assemble_envcell_geometry verified in pkg/holtburger_web.d.ts;
    pre-T13 release wasm backed up to the session scratchpad (one session)

node harness/test_geom_bundles.mjs        54 passed, 0 failed   GEOM-BUNDLES ✅ (NEW)
node harness/test_diag_schema.mjs         67 passed, 0 failed   (__diag.geometry landed current)
node harness/test_pack_fetch_controller.mjs  92/0 · test_pack_fetch_region.mjs 22/0 (wire figures unchanged)
node harness/test_residency_grid.mjs      RESIDENCY-GRID ✅ · test_slotgrid_lru_assert 25/0
node harness/test_tex_compressed_only.mjs 84/0 · harness/test_frame_work.mjs FRAME-WORK ✅
node harness/test_console_allowlist.mjs   ✅ · harness/test_texture_worker.mjs 69/0
node test_xu7_budget.mjs 49/0 · test_static_atlas_growth.mjs 73/0
statics family:  test_landblock_lru_evict 39/0 · test_landblock_lru_park_storm 36/0 ·
                 test_dead_batch_skip 33/0 · test_stat_array_merge 115/0
buildings family: test_walkin_instance_guard 7/0 · test_walkin_instance_evict 7/0
anim-scenery:    test_animated_scenery 16/0 · test_animated_scenery_park 12/0 · test_wind_off_frozen 11/0
cells family:    test_cell_lights 18/0 · test_portal_stencil_alloc 20/0;
                 test_envcell_guard FAILS IDENTICALLY ON CLEAN HEAD (verified by
                 stash/run — pre-existing splice-stub gap around the portal_clip
                 import; NOT a T13 defect; orchestrator attention)
node scripts/lint-url-flags.mjs --strict  exit 1 PRE-EXISTING (fogRingCap, stableDepthShare
                                          presence-guards only; T13 adds 0 findings)
node scripts/audit-flag-defaults.mjs --mismatch  exit 0 (geomBundles row agrees with its reader)
```

## Handoffs & risks

- **Batch A (T30) is unblocked**: E1 + P-ASSEMBLE prereq strings updated in
  `queue-1070/batch-A-2026-08-09.json` with the verified spellings (`?geomBundles`,
  `assemble_model_geometry`/`assemble_envcell_geometry`) + the D3 relief-parity
  instruction for the E1 arms. The parked-mid p50 PC-2 arms ride the same batch.
- **Tonight's full-world bake** emits GEOM with no invocation change; its
  pack-report gains `geom_rows`/`geom_bytes_raw`/`geom_soft_cap_hits`/
  `geom_max_payload_bytes` — read them against pass 4 Q2 (u16 tail census) and S6.3's
  B1 arithmetic. Any GEOM emission failure fails the bake LOUDLY (no silent partial
  GEOM coverage possible); if the full-world bake trips it, the fastest unblock is
  reverting `01667d23` (emission is a self-contained commit) — K3-class, the dist
  simply ships encoding-0x0000 again and the flag disarms into runtime decode.
- **T22 (ST9) consumes**: `bundleToGeometryGroups`'s shared-stream + subset shape is
  pool-feed-ready (H-04.3); the atlas/BatchedMesh copies remain per-consumer at ST3
  (BatchedMesh.addGeometry copies whole shared attributes per group — a bounded
  overallocation class vs today's exact-size non-indexed copies; pools replace both).
  D2's raw-stream adoption + D3's relief answer land there.
- **Named remainders**: terrain bundle-form export (S4 terrain row); entityDecode
  counters (D-04.8 gate data); the ST9/ST10 deletion of the geom-audit/starvation
  machinery (register row annotated in statics.js at ST3, not deleted).
- **Risk — assembly currently main-thread sync**: memcpy-scale by design and
  P-ASSEMBLE measures it; if a ring-scale assembly ever shows up in frame traces the
  escape is chunking the batch through W3 (T21's scheduler is live) — no design change.
- **pkg/ backup**: pre-T13 release wasm at the session scratchpad `pkg-backup/` for one
  session.
- **Unrelated dirty state**: `docs/reengineering/ORCHESTRATOR-HANDOFF.md` was already
  modified before this task started — left untouched and unstaged throughout.
