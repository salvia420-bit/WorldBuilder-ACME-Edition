# T10 — ST1: dual-emit bake + serve rules — implementation report

Date: 2026-08-09 (session start 2026-08-08). Agent: T10 implementation.
Charge: SPEC.md §3 T10 (size L, no client flag). All file paths repo-relative
(`external/holtburger/`).

## Shipped

Commits (in landing order; hashes in the status row commit):

1. **walk-widening + additive manifest fields** —
   `crates/holtburger-dat/src/walk.rs` (NEW `collect_model_dependencies_widened`
   + `collect_surface_dependencies`; the classic visual walk is UNTOUCHED —
   it is what boot.hba/legacy layers build from),
   `crates/holtburger-manifest/src/v2.rs` (`WorldIndexRef`,
   `DEFAULT_PACK_URL_TEMPLATE`, additive `world_index`/`pack_url_template`
   Options with `skip_serializing_if` + `default`; new test
   `pack_fields_are_additive_and_presence_routed`),
   `crates/holtburger-manifest/src/catalog.rs` (`crc32_ieee` made pub — HBP1/
   HBSI1 reuse the HBNS footer convention),
   `apps/holtburger-tools/src/dat_shard.rs` (ManifestV2 literal gains the two
   `None` fields — serializes byte-identically to pre-T10).
2. **HBP1/HBSI1 pack emitter (dual-emit)** —
   `apps/holtburger-tools/src/pack_format.rs` (NEW: HBP1 container + HBSI1
   index writers/readers, record-stream/REFS/TEXREF/PVW codecs, unit tests),
   `apps/holtburger-tools/src/pack_bake.rs` (NEW: partition, widened closure,
   K-tiering, preview derivation, t128 slices, HBSI1, manifest amendment,
   bake-source.sha256, pack-report.json, `--verify-closure` /
   `--verify-deterministic`),
   `apps/holtburger-tools/src/bin/dat-shard.rs` (`--emit-packs
   --legacy-layers --scenery-dir --spawns-dir --events-dir --tex-pvw-extra
   --terrain-bc7-dir --pack-region --pack-zstd-level --verify-closure
   --verify-deterministic`; legacy path unchanged, extracted verbatim into
   `run_legacy_bake`),
   `apps/holtburger-tools/scripts/derive-pvw-xu7.mjs` (NEW: offline xu7→HBC7
   preview deriver via the vendored basis transcoder),
   `apps/holtburger-tools/Cargo.toml` + `Cargo.lock` (workspace `zstd`).
3. **serve rules + BAKE-CI** —
   `scripts/serve.py` (packs/index immutable+no-transform tier, 200-gated;
   identity-only for the CAS tier — compression path-gated off; `--check` /
   `_health.json` pack-tree validation, presence-routed on `world_index`),
   `apps/holtburger-tools/tests/bake_ci.rs` (NEW: GATE-BAKE laptop arm),
   this report + the T10 status row.

Test-bake artifacts (per I5, outside the source tree):
`/mnt/wbterminal2/reeng/T10/{ci-run1,ci-run2,pvw-extra,bake-ci-report.json,ab-old,ab-new}`.

## Spec conformance

Acceptance bullets from SPEC §3 T10, each with evidence:

- **HBP1/HBSI1 emission (pass 2 S2–S5, as §1.1 amends)** — **MET.**
  Tile packs (2×2 LB; TERRAIN/LBINFO/ENVCELLS/PLACEMENTS/SPAWNS/EVENTS/
  RECORDS/REFS/TEXREF sections), interior packs (> 32 KiB EnvCells),
  CORE / META-COMMONS / META-REGIONAL / ENV-COMMONS / ENV-REGIONAL /
  PVW-COMMONS / PVW-REGIONAL, content-addressed at pack level
  (truncated-sha256-16 CAS names, `packs/{p2}/{hash32}.hbp`), per-section
  zstd level 19, CRC32+`1PBH` footer, sorted deterministic emission, no
  timestamps. HBSI1: pack table + 128×128 tile grid + interior table +
  shared directory + CRC footer (34,224 B on the bounded region [M]).
  GEOM sections are absent = pass 2 D-02.7's encoding-0x0000 migration
  state (HBG1 is T13). Bounded-region shape: 56 packs / 38 tiles /
  4 interiors / 127 LBs / 10.46 MB packs total [M].
- **Walk-widening (D-12.5), K-tier sized, per-tier byte report** — **MET.**
  New widened walk adds Setup→MotionTable/SoundTable/PhysicsScript/
  PhysicsScriptTable, MotionTable→Animation, SoundTable→Wave,
  PhysicsScript→(SoundHook waves, particle emitters), ParticleEmitter→GfxObj,
  and GfxObj→did_degrade→LOD-GfxObj edges. `pack-report.json.class_tiers`
  carries records + inline/regional/commons bytes per class (widened classes
  suffixed `*`). Bounded region [M]: degrade_info* 345 recs / 24.9 KB,
  animation* 6 / 38.9 KB, particle_emitter* 49 / 8.6 KB, physics_script* 58,
  sound_table* 1, wave* 1; `widened_commons_bytes = 0` at this scope (no
  record crosses the 64-tile commons threshold inside a 2-region bake —
  the B1-margin check re-scores at the full-world buildbox bake; see risks).
- **Preview coverage incl. non-square + xu7-only derivation** — **MET.**
  In-bake mip-slicing to the ≤128 cap (larger axis for non-square — unit
  test `slice_non_square_caps_larger_axis`), source order pre → full →
  extra; xu7-only rsIds derived OFFLINE by `derive-pvw-xu7.mjs` (the KTX2
  payload is opaque to Rust — see Deviations D2) and fed back via
  `--tex-pvw-extra`. Bounded region [M]: 462 TEXREF rows; previews 374
  from pre + 32 sliced from full + 14 xu7-derived; `texrefMissingPvw = 0`;
  42 legacy-only (no compressed tier exists — raw-record lane by design);
  0 unsliceable.
- **t128 single-file terrain slice per channel (D-12.6)** — **MET.**
  One CAS file per channel, HBP1-wrapped (pack kinds 6/7, single PVW
  stream of 29 rsId-keyed HBC7 chains), mip-sliced from the t1024 payload
  dir with no re-encode, listed in the HBSI1 shared directory
  (kinds 7/8). 635,340 B per channel [M] — matches pass 5's 0.63 MB [D].
- **manifest.json additive v2+ fields** — **MET.** `version` stays 2;
  `world_index {url,size,sha256_16}` + `pack_url_template` added only by
  the pack emitter; presence-routed. Legacy bakes emit NO new keys
  (serde `skip_serializing_if` + unit tests + the A/B below). T02's sweep
  already proved every reader tolerates additive fields (no
  `deny_unknown_fields` anywhere).
- **serve.py packs/index rules + `--check`/`_health.json`** — **MET.**
  `/dist/packs/` + `/dist/index/` get `public, max-age=31536000, immutable,
  no-transform` (200-gated) and are excluded from response compression
  (identity — hash = bytes, pass 3 S6.1/S6.3). `--check` validates the
  pack tree iff manifest.json declares `world_index` (index present +
  size + sha256_16 verified; packs bucket count) and fails loud on a
  declared-but-missing tree; legacy dists are untouched (verified: live
  dist `--check` output unchanged; pack CI dist shows `index=1 packs=53`).
- **BAKE-CI** — **MET on the bounded region** (`bake_ci_bounded_region`,
  release, 344 s):
  - closure completeness: `--verify-closure` green (every REFS edge +
    declared preview resolves), `texrefMissingPvw = 0` after the xu7
    derive arm;
  - determinism: intra-run re-emit check + two full runs with `packs/` +
    `index/` byte-identical (tree-hash compare);
  - byte-identity differ: **2,022 unique models + 3,365 EnvCells**
    byte-verified pack-decode vs DAT-decode (≥ 50 / ≥ 10 required); pack
    CAS names re-verified against content hashes;
  - zstd ratio report (re-scores B1 slack / R-01) [M]: RECORDS 0.292,
    TERRAIN 0.310, ENVCELLS 0.501, PLACEMENTS 0.542, SPAWNS 0.091,
    EVENTS 0.033, LBINFO 0.494 — the 0.41 gzip floor from pass 2 S1.6 is
    beaten on the dominant sections;
  - POST-coverage ring preview re-score (F-11.16) [M]: 36 ring tiles,
    1.78 MB tile packs, **3.49 MB ring previews** — see Handoffs (this is
    a bounded-scope number; commons/radius-invariance effects need the
    full-world bake before it is compared to pass 5's 1.6 MB figure).
- **Legacy layers pass unchanged checks (dual-emit acceptance)** — **MET.**
  (a) Binary A/B: pre-change binary (built from clean HEAD via stash) vs
  post-change binary on the same input (`--eor-local` bake) — `diff -r`
  over the full output trees shows the ONLY difference is manifest.json's
  `generated_at` timestamp; field-wise manifest compare (ex generated_at)
  equal, and the new manifest carries NO pack keys.
  (b) The pack step is additive-only: BAKE-CI snapshots the output dir
  before/after pack emission and asserts nothing but `packs/`, `index/`,
  `pack-report.json`, `bake-source.sha256` appears, and the manifest edit
  is exactly the two added keys.
  (c) The pre-existing legacy suites (`tests/sharding.rs`,
  `boot_reachability_cli.rs`, dat-shard CLI unit tests) all pass unchanged.
- **GATE-BAKE all green** — **MET at the bounded-region scale**; the
  full-world bake (absolute commons sizes, world tier split, walk-widening
  B-ledger rows) is a buildbox job per I5 and is the explicitly-scoped
  remainder (SPEC §3 T10 acceptance reads "widened-commons bytes within
  B1's meta margin" — scored at the full-world bake; see Handoffs).
- **Bake inputs** — MET: `~/ac_base_dats/` DATs only; `0x__FFxxxx`
  patch-pattern guard active (0 rejects on base DATs — see Deviations D3);
  `bake-source.sha256` emitted with DAT shas + input-dir provenance.

## Deviations

- **D1 (layout ambiguity resolved, recorded not spec-breaking):**
  pass 2 S3 declares PLACEMENTS rows "44 B" but its D-02.9 field list sums
  to 40 B. Emitted rows are 44 B = field list + 4 reserved zero bytes, so
  both statements hold. Similarly HBSI1 pack-table rows are declared 24 B
  but the field list sums to 22 — 2 zero pad bytes at the row tail.
  SPAWNS/EVENTS sections carry a 16 B per-LB byte-length preamble before
  the verbatim JSONL (the "grouped by LB" analogue of the PLACEMENTS
  preamble) — needed because scenery rows carry no landblockId. Documented
  in `pack_format.rs` / `pack_bake.rs` headers; T12's consumer should read
  those headers as the byte-truth alongside pass 2.
- **D2 (DEVIATION: pass 5 D-05.5 "the bake fills the gap by
  slicing/encoding previews for all" — the encoding half cannot run
  inside the Rust bake) because** XUBC7 KTX2 payloads are opaque to
  native code by design: unregistered supercompression scheme 6, "treat
  as opaque … the client's transcoder wasm is the authority"
  (docs/HANDOFF-texture-pipeline-2026-08-04.md:107–116, read-verified;
  `dat_shard.rs` TEX_XU7_NAMESPACE docs agree), and XUBC7 cannot ingest or
  emit its BC7 without the basis transcoder. Minimal sound thing done: an
  offline node deriver using the SAME vendored transcoder the client uses
  (`scripts/derive-pvw-xu7.mjs` → `--tex-pvw-extra`), wired into BAKE-CI so
  `texrefMissingPvw = 0` remains a hard gate (proven: 14/14 derived, 0
  failed). The invariant's operative form during migration: an rsId with a
  compressed full tier and no preview counts as MISSING (gate = 0); an
  rsId with no compressed tier at all is `texrefLegacyOnly` (the raw-0x06
  legacy lane pass 3 D-03.10 keeps) — not a coverage violation.
- **D3 (patch-id pattern precision):** the `0x__FFxxxx` reject pattern
  excludes the `0xFF______` bookkeeping range — the base portal DAT
  legitimately contains Iteration record `0xFFFF0001`, which is DAT
  metadata, not patch content (probed directly this session). Guard is
  second-byte==0xFF AND top-byte!=0xFF; base DATs score 0 rejects.
- **D4 (supergrid cell count):** pass 2 D-02.4 says "one per 32×32-LB
  supergrid cell (256 cells)" — 256×256 LBs / 32 = 8×8 = **64** cells; the
  "256" parenthetical is internally inconsistent with its own cell size.
  Implemented 32×32-LB cells / 64 ordinals (matches SPEC §1.1's
  "32×32-LB supergrid" wording).
- **D5 (packs-only mode needs an existing manifest):** `--emit-packs`
  without `--legacy-layers` amends the output dir's existing
  `manifest.json` and errors loudly if none exists (a v2 manifest's
  required fields — boot_pack etc. — belong to the legacy emitter; a
  pack-only dist has no boot.hba to describe). The dual-emit invocation
  SPEC names (`--emit-packs --legacy-layers`) is unaffected.

## Tests run

All Rust runs via `capped-build` with rust-analyzer killed first (I5).

- `cargo test -p holtburger-manifest` — **ok, 16 passed** (incl. new
  additive-fields test). @scale: unit.
- `cargo test -p holtburger-dat --lib` — 680 passed, **1 pre-existing
  failure**: `terrain_subdiv::tests::triangle_corner_ring_matches_height_sampler`
  — verified failing on clean HEAD with my changes stashed (same panic,
  terrain_subdiv.rs:1787); unrelated to walk.rs; NOT fixed (out of scope),
  flagged to the orchestrator. All walk tests pass. @scale: unit.
- `cargo test -p holtburger-tools` — **all targets ok** (38 lib incl. 13
  new pack_format/pack_bake units; sharding/boot-reachability/CLI suites
  unchanged and green). @scale: unit/fixture.
- `cargo test -p holtburger-tools --release --test bake_ci -- --ignored
  --nocapture` — **ok in 344 s** on this laptop. @scale:
  **bounded-region** (Holtburg 11×11 boot neighborhood `0xA4AF:0xAEB9` +
  auto-selected densest-interior 3×3 ring `0x00AD:0x01AF`); the
  full-world bake is deliberately NOT run on this 8 GB machine — buildbox
  job, tracked in Handoffs.
- Legacy A/B (pre-change vs post-change release binaries, `--eor-local`
  bake): `diff -r` = generated_at only. @scale: small-real-input.
- `serve.py --check` on the live legacy dist (unchanged output, OK) and on
  the pack CI dist (`index=1` sha-verified, `packs=53` buckets; legacy
  layers correctly reported missing there). Symlink restored to the
  canonical root afterwards.

## Handoffs & risks

- **Full-world bake = buildbox.** Absolute tier splits (commons/regional),
  `widened_commons_bytes` vs B1's meta margin (SPEC Q3/R-01 lever), and
  the honest F-11.16 ring re-score all need the full-world run:
  region-bounded usage counts cannot cross the 64-tile commons or 1024-LB
  PVW-commons thresholds (this bake: meta-commons 133 B = empty pack,
  everything regional/inline). Command shape:
  `dat-shard --emit-packs --legacy-layers --eor-portal … --eor-cell …
  --scenery-dir … --spawns-dir … --events-dir … --tex-bc7 … --tex-bc7-pre …
  --tex-xu7 … --tex-pvw-extra … --terrain-bc7-dir … --verify-closure
  --verify-deterministic`.
- **Ring previews 3.49 MB POST-coverage (bounded scope)** vs pass 5's
  1.6 MB [D] ring figure: not yet comparable — the bounded bake has no
  PVW-COMMONS tier and my ring set counts every ring TEXREF (incl. the
  in-ring interiors). R-01 stays open until the full-world BAKE-CI ring
  re-score lands; if it still overshoots, pass 5's named levers apply
  (t64 slice −0.47, PVW-regional deferral).
- **T12 inputs:** container byte-truth = `pack_format.rs` module docs
  (incl. D1's preamble/padding notes); TEXREF `pvw_pack_ord` indexes the
  owning pack's REFS pack list (`0xFFFE` = own PVW section, `0xFFFF` =
  none); tile grid is row-major tile_x-major; shared-directory kind codes
  in `pack_format::shared_kind` (terrain slices = kinds 7/8, pack kinds
  6/7). The widened closure means animated-scenery support records ride
  packs from day one (ST10's retirement criterion reachable, per D-12.5).
- **No client flag** (per SPEC): nothing client-visible changed; url-flags
  table untouched. serve.py changes are additive and presence-routed.
- **Pre-existing red test** in holtburger-dat (terrain_subdiv, above) —
  owner/orchestrator attention, not T10's.
- **Concurrent-agent note:** the working tree also carried another
  agent's uncommitted edits (`scene3d/xu7_textures.js`,
  `scene3d/terrain_bc7.js` — texture-family scope, not T10's); left
  strictly unstaged per I6.
- **Cargo.lock** committed with the emitter commit (single new workspace
  dep resolution: `zstd` for holtburger-tools — shared file, required for
  a reproducible build).
