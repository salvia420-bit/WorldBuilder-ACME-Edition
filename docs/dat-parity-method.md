# DAT-Parity Method (cross-port DAT-record drift audit)

Companion to [`world-completeness-method.md`](world-completeness-method.md)
(placements), [`event-completeness-method.md`](event-completeness-method.md)
(sounds + particles), [`entity-completeness-method.md`](entity-completeness-method.md)
(typed classification), [`wire-conformance-method.md`](wire-conformance-method.md)
(Wave 1), and [`enum-parity-method.md`](enum-parity-method.md) (Wave 2.C).
This doc covers **Wave 2.A + 2.B** of the
[diagnostic-toolset plan](diagnostic-toolset-plan-2026-05-19.md):
**DAT parser parity**.

Status: **shipped 2026-05-19** (first ship is structural / canonical-oracle
parse parity; field-level Rust-vs-Chorizite shape comparison is the Wave 2.D
follow-on bucket — see §"Wave 2.D follow-ons" below).

**Status update (2026-05-25):** the W2.D EnvCell FAIL row closed in commit
`7b17c17d` ("EnvCell CellPortal fix + Wave 4 cold sweep") — the flagmask
bug (`ENVCELL_FLAG_HAS_STATIC_OBJS = 0x02` etc., not `0x01`) and the
missing `polygon_id` field on `CellPortal` were both patched. Counts
should now read 11 PASS / 13 GAP / 0 FAIL. The remaining Wave 2.D
follow-ons (field-level drift sweep over the 22 production-shape parsers)
are still deferred per the original go/no-go.

## The contract

Every record byte under `~/ac_base_dats/{client_portal,client_cell_1,client_local_English}.dat`:

1. Parses cleanly via the **canonical oracle** (`Chorizite.DatReaderWriter`
   v2.1.2, embedded in WB.Terminal as a NuGet ProjectReference and driven
   via `chorizite-parse-dat-record`).
2. Resolves to the same `DBObjType` discriminator on both ports
   (`Chorizite.Enums.DBObjType` ↔ `holtburger_dat::DatFileType`).
3. The DAT SHA-256s match the canonical base-bake oracle (per
   [[feedback_base_dats_only_for_bake]]):
   - `client_portal.dat` `dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4`
   - `client_cell_1.dat` `6db0abf00fbceed62c3f1ee842ee7c1f423d732bed77a5b7c102ee89a52ab99e`
   - `client_local_English.dat` `e85c820280c88fac7df6c8043f5e24596e9c8774193af4123d756546f78fb2bb`

If either (1) or (3) fails for any sampled record, the validator exits
non-zero (1 for parse failure, 2 for SHA mismatch). The first-ship contract
deliberately does NOT enforce (2) at the field level — Wave 2.D
will.

`canonical_dat_record_parse(id) ≡ chorizite_parse(bytes) ≡ holtburger_dat_parse(bytes)`

## Why this matters

Every visual, audio, and behavioural surface in `emit-dynamic-site` is
driven by a parser running over `client_portal.dat` or `client_cell_1.dat`
bytes. If our Rust parser silently emits a different field tree than retail
intended, every downstream consumer is wrong-by-construction. Most of those
wrongness modes don't crash — they just render slightly off. The only way
to catch them is a bit-for-bit comparison against an oracle that's also
parsing the same bytes — i.e. Chorizite.DatReaderWriter (which was
validated against retail acclient.exe by an independent C# author).

The DAT-parity validator is the structural backstop for every later wave:
once we know our parsers see the same records Chorizite sees, the
mesh-parity / texture-parity / cell-portal-graph validators can stop
worrying about "did we miss a record?" and focus on "do the field values
agree?".

## Source files

### Oracle (canonical Chorizite parsers)

- `Chorizite.DatReaderWriter` v2.1.2 — NuGet ref in
  `WorldBuilder.Terminal.csproj:18`. Generated DBObj types under
  `DatReaderWriter.DBObjs.*` (~53 concrete types reflected via
  `IDBObj`).
- `WorldBuilder.Terminal/CommandEngine.DatParity.cs` — the
  `chorizite-list-dat-records` + `chorizite-parse-dat-record` +
  `chorizite-list-dat-types` commands. ~470 LoC.

### Subject (holtburger-dat Rust parsers)

- `external/holtburger/crates/holtburger-dat/src/file_type/*.rs` — 26
  parser modules, 22 emit production-shape types (see Wave 2.D below for
  the missing four).
- Covered (24 of the 26 modules):
  - 0x01 `GfxObj` · 0x02 `Setup` · 0x03 `Animation` · 0x04 `Palette`
  - 0x05 `SurfaceTexture` · 0x06+0x07 `Texture` (mapped to Chorizite
    `RenderSurface`) · 0x08 `Surface` · 0x09 `MotionTable`
  - 0x0A `Wave` · 0x0D `EnvCell` · 0x0E sub-tables (`CharGen`,
    `ChatPoseTable`, `SkillTable`, `SpellTable`, `ExperienceTable`,
    `Environment`)
  - 0x12 `Scene` · 0x13 `Region` · 0x20 `SoundTable` ·
    0x32 `ParticleEmitter` · 0x33 `PhysicsScript` ·
    0x34 `PhysicsScriptTable`
  - Cell DAT: `LandBlock` · `LandBlockInfo`
- Not yet sampled by the validator (Wave 2.D candidates): 0x0E
  `SpellComponentTable`, 0x0E `XpTable` (Chorizite has none), 0x0E
  `VitalTable`, 0x30 `CombatTable`. See §"Wave 2.D follow-ons".

### Validator

- `external/holtburger/apps/holtburger-web/validate_dat_parity.cjs` — node
  driver; persistent WB.Terminal subprocess (multiplexed); reads
  `fixtures/dat/seeds.json` and drives `chorizite-parse-dat-record`
  per-record.
- `external/holtburger/apps/holtburger-web/fixtures/dat/seeds.json` —
  deterministic sample IDs (sha256(id)→sort, take N) + per-DAT SHA-256s.
  Default sample size: 50 per type. Total: 906 records (24 types × 50 -
  56 singular-type records that have 1-record max).
- `external/holtburger/apps/holtburger-web/fixtures/dat/generate_seeds.cjs`
  — regenerator. Run only when adding a new parser to `holtburger-dat`
  (DAT bytes are immutable per
  [[feedback_base_dats_only_for_bake]]).

## The classifier (the load-bearing piece)

`CommandEngine.ChoriziteParseDatRecord` does three things, in order:

1. **Resolve the DBObj type** for the record's ID. Range-based types
   (`GfxObj`, `Setup`, …) use `FirstId`/`LastId` reflected off
   `DBObjTypeAttribute`; cell-DAT types (`LandBlock`,
   `LandBlockInfo`, `EnvCell`) use mask/suffix discrimination
   (`XXYYFFFF`, `XXYYFFFE`, `XXYY0001-XXYYFFFD`).
2. **Open the canonical DAT file** for the type (Portal/Cell/Local)
   via `DatReaderWriter.DatDatabase` (mmap by default). The DAT path is
   sourced from `~/ac_base_dats/` per
   [[feedback_base_dats_only_for_bake]]; the SHA-256 is cached
   (`{path, length, mtime}` keyed) to avoid re-scanning 884 MB on every
   validator invocation.
3. **Parse via `DatDatabase.TryGet<T>(id, out T)`** + serialise the
   resulting object graph with `System.Text.Json`. Custom converters
   handle `Vector3`/`Quaternion`/`StringBase` types (the latter needs a
   key-converter because `AC1LegacyPStringBase<byte>` is a dictionary key
   in `ChatPoseTable.ChatPoses`).

The validator drives the parser per-record + records pass/fail per type.

## What constitutes "drift"?

A record can fail the validator in three ways:

* **FAIL row**: Chorizite throws while parsing the record bytes. Either the
  DAT is corrupt (rejected by sha-pre-flight), the parser has a bug
  (Chorizite drift from retail), or the JSON-serialise step can't handle
  the field tree (added converters resolve the known cases — `StringBase`,
  `Vector3`, `Quaternion`).
* **DAT-SHA mismatch**: the local DAT bytes don't match the canonical
  base-bake oracle. Pre-flight; refuses to run if this fails.
* **Wave 2.D follow-on row (deferred drift)**: structural pass on both
  sides, but the field trees aren't byte-equal. This is what 2.D will
  bucket.

## Wave 2.D follow-ons (deferred from 2.A/2.B first ship)

The 2.A/2.B brick lands the canonical Chorizite oracle + a deterministic
sample. The Rust-vs-Chorizite field-tree comparison is **deferred** because
the holtburger-dat parsers use `binrw`-derived types WITHOUT
`#[derive(Serialize)]` — so a structural JSON comparison requires either
(a) adding serde-Serialize derives on every parser type, or (b) writing
hand-rolled JSON formatters that mirror Chorizite's shape. Both are
out-of-scope for one agent in one session.

The Wave 2.D bricks (next session):

1. **`#[derive(Serialize)]` on every holtburger-dat type** — 22 file_type
   modules + sub-types. Field naming must match Chorizite's STJ
   camelCase output (cite the C#-side property name, then `#[serde(rename
   = ...)]` if the Rust name diverges). Estimated 200-300 LOC.
2. **Add a Rust example binary** at
   `crates/holtburger-dat/examples/parse_dat_record.rs` — takes
   `(dat_path, id_hex, type_hint)`, dumps JSON via serde_json. Pattern
   mirrors WB.Terminal's `chorizite-parse-dat-record`. Estimated 150 LOC.
3. **Extend `validate_dat_parity.cjs`** with Phase B: for each sampled
   record run both Chorizite + Rust binaries; diff the two JSON trees;
   classify mismatches as PASS / FAIL (value drift) / GAP (field in one,
   missing in other). Estimated 200 LOC of validator logic.
4. **Document the four missing parsers** that holtburger-dat lacks vs
   Chorizite: `VitalTable`, `SpellComponentTable`, `XpTable`,
   `CombatTable`. None are blocking for the runtime visible surfaces; they
   show up as "Chorizite-only" rows in the parity report. Document as
   bitflags!-style gaps per the W2.C enum-parity precedent.

Estimated 6-9 hours one agent, fully unblocked by 2.A/2.B's foundation.

## What's deliberately NOT covered (yet)

* **Round-trip pack/unpack**: re-pack the parsed tree, assert byte equality.
  Each parser would need a corresponding writer. Chorizite has writers; the
  holtburger-dat side currently writes for HBA bundling only. Wave 2.E
  candidate.
* **Texture pixel-level decode parity**: Surface → RenderSurface →
  Texture chain. Covered by Wave 4 (mesh + texture parity sweep) which
  reads the parser output structurally and walks down to pixels.
* **`StringTable` / `LanguageInfo`**: live in `client_local_English.dat`
  which isn't yet wired to the validator's pre-flight SHA table. Wave 2.D
  follow-on.
* **`Iteration` metadata** (0xFFFF0001): a singular record per DAT;
  parsable, but not exercised by the validator's sample loop (it's the
  metadata, not the content). The DRW source already validates it
  implicitly on every `DatDatabase` open.

## Baseline result (2026-05-19, first ship)

```
24 types checked  ·  906 records sampled (50 per type, deterministic sha-mod-N)
24/24 types PASS  ·  906/906 records parse cleanly
DAT SHA-256:      client_portal.dat ✓   client_cell_1.dat ✓
```

This is the floor; Wave 2.D extends it to field-level Rust-vs-Chorizite
parity. **Surprising finding 2026-05-19**: the System.Text.Json serializer
needed a custom `StringBaseConverterFactory` to handle DRW's
`AC1LegacyPStringBase<byte>` dictionary keys (used in
`ChatPoseTable.ChatPoses`). Surfaced as a 1/24 FAIL on the first run;
fixed in-flight before declaring shipped.

## How a future agent picks this up (Wave 2.D)

1. Re-read this method doc (5 min).
2. Open `external/holtburger/crates/holtburger-dat/src/file_type/region.rs`
   as the canonical worked example. Add `#[derive(Serialize)]` + `serde`
   feature flag.
3. Inspect Chorizite's JSON output for a Region record to learn the
   canonical field names + nesting; align Rust struct names + use
   `#[serde(rename = "...")]` where they diverge.
4. Repeat across the other 21 modules. Use the validator's PASS rows as a
   work-completion gate: every PASS row should also be a Wave-2.D PASS once
   the Rust side serialises.
5. Add the `parse_dat_record` example binary + extend
   `validate_dat_parity.cjs` Phase B.
6. Document the field-level drift findings in
   [[feedback_dat_parity_drift_2026-05-XX]] (the four known DRW-vs-acclient
   schema mislabels per [[feedback_dat_parser_mislabels]] should surface
   as the first wave of drift).

## Memory cross-references

- [[reference_ac_dat_file_types]] — canonical 0x01-0x78 prefix table.
- [[project_emit_dynamic_site]] — Phase 6 parser inventory.
- [[feedback_base_dats_only_for_bake]] — DAT integrity discipline.
- [[feedback_dat_parser_mislabels]] — DRW schema mislabels caught
  2026-05-19 (acclient.c-vs-DRW); Wave 2.D should drift-detect at least 4.
- [[feedback_ground_in_real_wire_data]] — same precedent extended to DAT
  bytes.
- [[reference_worldbuilder_terminal]] — add the three new command rows.

---

*End of method doc. Companion patch: `WorldBuilder.Terminal/WAVE2AB_DISPATCH_PENDING.patch` (orchestrator splice for `JsonCommandProcessor.cs`).*
