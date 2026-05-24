# Vitaeum-Parity Plan — DAT Coverage Closeout

**Started:** 2026-05-23
**Baseline:** commit `c32a6f8f` (kind-aware classifier landed; vitaeum stat parity proven)
**Working tree:** `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/`
**Base DATs (reference):** `/home/wbterminal/ac_base_dats/{client_portal,client_cell_1,client_local_English}.dat`

## Context

A closed competitor client ("vitaeum") publishes per-type DAT record counts that initially looked like coverage we lacked. Investigation showed our counts were wrong, not our coverage: `DatFileType::from_id` was DAT-context-blind and misclassified ~195k cell entries as portal types plus dropped ~7k portal types into Unknown/IndoorCell. Baseline commit fixes classification and adds 20 missing variants. This doc plans the follow-on parser work to actually decode what we now identify.

Three milestones, sequenced A → C → B with explicit go/no-go gates. Skip-or-continue decisions live with the user, not the agent.

---

## Milestone A — Caller migration

**Goal:** Move bake-pipeline and test callers off the legacy `from_id` onto `from_id_in_dat`, so misclassification can't silently affect output anywhere downstream.

**Risk:** LOW (signature change, no parser logic). The biggest exposure is uncovering pre-existing latent bugs that the misclassification was hiding.

**Estimate:** 1–2 hours.

### Call-site triage (already done)

| File | Needs migration? | Why |
|---|---|---|
| `apps/holtburger-tools/src/dat2hba.rs:282,554` | YES | dispatches by type for HBA pack; iterates all DAT IDs |
| `apps/holtburger-tools/src/bin/scenery-bake.rs:214` | YES | scenery bake iterates and classifies |
| `apps/holtburger-tools/src/bin/event-bake.rs:199` | YES | event bake iterates and classifies |
| `crates/holtburger-dat/benches/provider_bench.rs:24` | YES | `is_essential()` filter when reading DATs |
| `crates/holtburger-dat/tests/parity_tests.rs:27` | YES | fixture-test with known DAT origin |
| `crates/holtburger-content/src/repository.rs:304,341` | NO | `as u32` on known-unambiguous IDs (ChatPoseTable, Iteration) |
| `crates/holtburger-core/src/client/builder.rs:318,337` | NO | same pattern |
| `crates/holtburger-world/src/state/tests.rs:83` | NO | synthetic test fixture, no real DAT |

### Acceptance test

Re-bake one **low-X-coord** landblock (Yaraq region around X=0x20) before and after migration. Pre-migration should show different per-type counts in the bake log; post-migration counts should match the cell-DAT IndoorCell total for that LB. If anything else changes (output structure, sha256 of baked files for a high-X-coord LB control), STOP and triage — that's a real bug hiding behind the misclassification.

Control LBs:
- High-X (must be identical pre/post): 0xA9B4 (Holtburg)
- Low-X (must change for the better): pick something with X in 0x01-0x40 from cell.dat scan; verify the new bake parses indoor cells where the old one bailed

### Commit shape

One commit: `fix(bake,tests): migrate from legacy from_id to kind-aware from_id_in_dat`

### Exit criteria

- All five YES-row callers migrated and compiling
- Sanity bakes match expectations (high-X identical, low-X improved)
- Full test suite green: `cargo test --release` (whole workspace)
- Commit + push

### Go/no-go

If sanity bake reveals latent bug → STOP, escalate, fix before continuing. Otherwise → roll into Milestone C.

---

## Milestone C — Four foundational parsers

**Goal:** Add parsers for file types whose enum variants exist but where no parser body has been written. Ordered ascending by complexity; each gets its own commit.

**Risk:** MEDIUM per parser. Format reverse-engineering can hide gotchas (e.g. `[[feedback_dat_parser_mislabels]]`).

**Estimate:** ~1 day total, ~2 hours per parser plus integration validation.

### Discipline (load-bearing per memory)

- **Ground in real wire data** — `[[feedback_ground_in_real_wire_data]]`: parse against actual DAT bytes before claiming structure correctness.
- **Trust acclient.c for widths** — `[[feedback_dat_parser_mislabels]]`: DRW labels and the wiki are docs; acclient.h decomp is truth for scalar widths + vector/scalar distinctions.
- **Three-source cross-reference** — `[[feedback_three_source_cross_reference]]`: for each new type, sanity-check against ACE (server) + DRW (client C# decomp) + acclient.h (retail). Avoid PhatSDK per `[[feedback_no_phatac]]`.
- **WB.Terminal first for verification** — `[[reference_worldbuilder_terminal]]`: WB.Terminal can dump retail records; use it to cross-check our parser output against the canonical decode.

### Files to touch per parser

1. `crates/holtburger-dat/src/file_type/<name>.rs` — new parser module
2. `crates/holtburger-dat/src/file_type/mod.rs` — `pub mod <name>;` + `pub use <name>::*;`
3. `crates/holtburger-dat/tests/` — at least one fixture test against real bytes
4. (optional) `apps/holtburger-tools/src/bin/dat-tool.rs` `Commands::Extract` arm if there's a useful per-type extraction

### C1 — Font (0x40, 49 records)

**Why:** Real AC font rendering for retail-faithful UI. Currently fall back to browser system fonts.

**Reference order:**
1. acclient.h decomp — search for `Font`, `CFont`, `FontTable`, glyph struct
2. DRW upstream — `external/DatReaderWriter/DatReaderWriter/DBObjs/` may not have a Font.cs; check `Types/` for FontData
3. acpedia/fandom — `[[reference_ac_wikis]]` for human-readable shape

**Acceptance:** Parse all 49 records without error; dump glyph count + atlas dimensions; spot-check 3 fonts against WB.Terminal hex dump.

**Out of scope (here):** glyph atlas integration into holtburger-web renderer. Parser only — wire it in a follow-on.

### C2 — LanguageString (0x31, 28 records)

**Why:** Localized text records (vendor banter, NPC dialog tags, item-name keys).

**Reference order:**
1. DRW — search for `LanguageString.cs` or `String.cs`
2. acclient.h — look for `StringInfo` / `LanguageString` / `_String`
3. Likely shape: header + count + array of PackedString (16-bit length-prefixed UTF-16 or codepage)

**Acceptance:** Parse all 28 records; sample 3 known strings (find via dat-tool extract); verify decoded text matches WB.Terminal output.

### C3 — CombatManeuverTable (0x30, 71 records)

**Why:** Server-correct combat move dispatch. Combat Phases B–J ship without it (`[[project_holtburger_combat_phase_b_done_2026-05-17]]`); having the parser is prereq for proper attack-motion validation.

**Reference order:**
1. ACE `Server/Network/Structure/CombatManeuverTable.cs` (definitive — server uses this for move legality)
2. DRW `Types/CombatTable.cs` if present
3. acclient.h `CombatTable`

**Acceptance:** Parse all 71 records; cross-check the player-melee table against ACE's parse for the same WCID; confirm move-id → animation mapping resolves cleanly.

### C4 — Clothing (0x10, 1917 records)

**Why:** Equipment visuals (armor/clothing rendering on character meshes). Largest gameplay-visible payoff.

**Reference order:**
1. DRW `DBObjs/ClothingTable.cs` or similar — most thoroughly documented
2. ACE `WorldObjects/ClothingTable` companion
3. acclient.h `ClothingBase` / `ClothingTable`

**Format shape (rough):** WCID setup map + palette templates + ClothingBaseEffect per body-part + sub-palette effects per slot. **Heaviest parser of the four.**

**Acceptance:** Parse all 1917 records; cross-check 3 representative WCIDs against WB.Terminal (e.g. starter outfit, drudge skin, named NPC outfit).

**Out of scope (here):** wiring parsed clothing into the holtburger-web entity renderer.

### Exit criteria for Milestone C

- All four parsers land as separate commits
- Per-parser test parses all retail records without error
- Per-parser test cross-checks at least 3 specific records
- Plan-doc updated noting any format gotchas discovered

### Go/no-go

If two or more parsers reveal that a downstream consumer wasn't actually planning to use the data → STOP, defer the rest. We do not pile up dead code.

---

## Milestone B — Newly-identified portal-DAT parsers

**Goal:** Add parsers for the 20 types we now correctly classify but never decoded. Triaged HIGH / MEDIUM / SKIP by holtburger value.

**Estimate:** ~½ day for HIGH+MEDIUM batches; SKIP triaged out unless a consumer demands.

### B1 — HIGH batch (UI / input infrastructure)

Scope discovery during execution forced a split — not all four are
shippable at the same depth, so B1 was reduced to **StringTable only**
with the rest documented as follow-on work:

| Type | Prefix | Count | Status |
|---|---|---|---|
| StringTable | 0x23 | 15 | ✅ **Shipped** in B1 — clean schema, full parity test |
| KeyMap (MasterInputMap) | 0x14 | 2 | ✅ **Shipped** in B1.b — `guid` as 16-byte array, "Dictionary" wire format is just N (key, value) pairs with no header, full parity test (2/2 records, every byte consumed) |
| Layout (LayoutDesc) | 0x21 | 101 | ⏸ **Deferred with larger scope** — discovered during B1.b that `BaseProperty`'s on-wire format is `u32 MasterPropertyId + typed_value_bytes` (DRW's dats.xml `_propertyType` field is misleading). The value type comes from looking up `MasterPropertyId` in the **MasterProperty** record (DAT 0x39). Requires shipping MasterProperty as a prerequisite, which itself drags in `BasePropertyDesc` with recursive Default/Max/Min `BaseProperty` values. Realistic scope: ~4–6 hours of careful work + cross-validation. Tracked as Milestone D. |
| ActionMap | 0x26 | 1 | ✅ **Shipped 2026-05-23** (post-D close, commit `36628df7`). DRW's body was empty but ACE had a working parser at `Source/ACE.DatLoader/FileTypes/ActionMap.cs` all along — 15-min follow-the-recipe instead of an RE spike. Parses cleanly: 27 input_maps + 389 ActionMapValues + 16 conflict groups, `string_table_data_id=0x23000005` matches ACE's known value, every byte consumed. |

The three deferred types are tracked as a follow-on B1.b commit and
should not block B2.

**Why StringTable went first:** clean DRW schema (DBObj header +
`u32 language` + `HashTable<u32, StringTableString>`), straightforward
nested `StringTableString` shape (data_id + UTF-16 strings + variables +
flag), and an existing HashTable-style helper pattern from `skill_table`.
Real-DAT parity validated against all 15 retail records (6899 entries,
7050 string variants).

### B2 — MEDIUM batch (rendering / LOD)

Single commit covering both:

| Type | Prefix | Count | Why |
|---|---|---|---|
| PaletteSet | 0x0F | 2681 | Color/dye variant palette overrides — pairs with C4 Clothing |
| DegradeInfo | 0x11 | 4131 | Per-asset LOD selection — complements visual-fidelity work |

**Why batched:** Both are about retail visual fidelity beyond the base mesh.

### Skipped (low value at current scope)

- RenderTexture (2), RenderMaterial (1), MaterialModifier (1), MaterialInstance (1), RenderMesh (?), MutateFilter (?) — modern-pipeline/AC2-era types, mostly unused in retail-1.6 timeframe
- DataIDMapper (22), DualDataIDMapper (5), EnumMapper (40) — generic lookup tables, write only if a consumer demands
- DatabaseProperties (2), MasterProperty (1), StringState (1), StringTableString (?), BSPNodeType (?) — rare system records

Document why each is skipped if a future audit asks.

### Exit criteria for Milestone B

- B1 commit lands with all four parsers + at least one cross-decode per type
- B2 commit lands with both parsers + at least one cross-decode per type
- Skipped types list documented in this doc with a reason

### Go/no-go

Stop after B2 unless a concrete consumer materializes for a SKIP type. Don't roll into low-value parsing for completeness alone.

---

## Cross-cutting acceptance

When all three milestones land:

1. `cargo test --release` workspace-wide PASS
2. `dat-tool list` bucket-counts match `vitaeum-parity-2026-05-23` snapshot (already captured in this commit's message)
3. No new "Unknown" buckets appear from retail base DATs (subject to the documented SKIP list)
4. README / ARCHITECTURE update: holtburger-dat parser coverage table refreshed

## Scratch / artifacts

- Bucket-count outputs: `/mnt/wbterminal1/tmp/claude-scratch/vitaeum-compare/{portal,cell,local}.v2.list`
- Pre-fix outputs (for diffs): `/mnt/wbterminal1/tmp/claude-scratch/vitaeum-compare/{portal,cell,local}.list`
- Always write logs/intermediates under `/mnt/wbterminal1/tmp/claude-scratch/` per `[[feedback_use_external_drives_for_scratch]]`.

## Milestone D (proposed follow-on — Layout chain)

Discovered while pushing into B1.b. To unlock the Layout parser we need
to ship a chain of prerequisites first:

1. **MasterProperty** (DAT 0x39, 1 record) — EnumMapperData + Dictionary
   of `BasePropertyDesc`. The single record acts as a runtime type table
   that BaseProperty values look themselves up against.
2. **BasePropertyDesc** — per-property metadata (Type, Group, Provider,
   Default/Max/Min BaseProperty, PatchFlags, etc.).
3. **BaseProperty** (with MasterProperty context) — on the wire it's
   `u32 MasterPropertyId + typed_value_bytes`; the value width comes
   from `master_property.properties[id].type`. Recursive: Array and
   Struct variants embed nested BaseProperty.
4. **MediaDesc** — small typeswitch (Movie, Alpha, Animation, Cursor,
   Image, Jump, Message), all simple sub-types.
5. **StateDesc** — composed of Properties (`BaseProperty[]`) and Media
   (`MediaDesc[]`).
6. **ElementDesc** — conditional maskmap fields on
   `StateDesc.IncorporationFlags` (X/Y/Width/Height/ZLevel), recursive
   States (Dictionary<UIStateId, StateDesc>), recursive Children
   (Dictionary<u32, ElementDesc>).
7. **LayoutDesc** — top-level: id + Width + Height +
   HashTable<u32, ElementDesc>.

Estimated effort: 4–6 hours with proper cross-validation against retail
records and the DRW EOR-test suite.

## Status log

- 2026-05-23 — Baseline `c32a6f8f` pushed. This doc created. Milestones
  A, C1–C4, B1 (StringTable), B2 (PaletteSet + DegradeInfo) shipped.
  B1.b: KeyMap shipped. Layout + ActionMap deferred with explicit
  scope notes — see Milestone D above for the Layout chain.
- 2026-05-23 — Milestone D (Layout chain) pushed:
  - D1: MasterProperty + BasePropertyDesc + BaseProperty (commit
    `a9b068fd`). Retail 0x39000001 parses identically to DRW's EOR
    test (384 IdToStringMap entries + 383 BasePropertyDesc records,
    102 with defaults, 27 with available_properties). Caught a
    missing u8 bucket-size byte between EnumMapperData and
    num_properties that's nowhere in dats.xml or acclient.h —
    `MasterProperty.cs:33` was the only source.
  - D2: MediaDesc (11 of 13 MediaType variants) + StateDesc with
    composed BaseProperty/MediaDesc lists (commit `166a79be`). All
    unit tests pass; no retail-DAT parity here because StateDesc
    only exists inside Layout.
  - D3: ElementDesc (recursive Children + States, conditional
    maskmap fields on IncorporationFlags) + LayoutDesc (this
    commit). Parser is structurally complete; retail parity test
    is `#[ignore]`-d pending a StringInfo wire-format spike (see
    "Milestone D StringInfo follow-on" below).

## Milestone D — FULL parity (2026-05-23)

**Status: 101/101 retail Layouts parse cleanly.** Every wire-format
unknown closed by cross-referencing ACE source instead of trusting DRW
or guessing.

The breakthrough: **ACE has working parsers for everything** in
`/home/wbterminal/ace-server/Source/ACE.DatLoader/`, including a
test (`UnpackLocalEnglishDatFiles_NoExceptions`) that asserts every
local-English DAT record consumes exactly its file size. DRW's
`dats.xml` schemas disagree with ACE on the load-bearing details and
were leading me wrong.

Wire-format corrections that landed:

| Field | DRW said | ACE / retail says |
|---|---|---|
| `StateDesc.num_properties` | CompressedUInt | u8 byte |
| `StateDesc.Properties` | `List<BaseProperty>` | `Dictionary<u32, BaseProperty>` (each entry: u32 dict_key + u32 BaseProperty.Id + value) |
| `StateDesc.num_media` | CompressedUInt (with bucket prefix) | u8 byte (no bucket prefix) |
| `ElementDesc.num_states` | CompressedUInt | u8 byte |
| `ElementDesc.num_children` | CompressedUInt | u8 byte |
| `LayoutDesc.num_elements` | CompressedUInt | u8 byte |
| `BasePropertyDesc` trailing layout | 4 type bytes + 8 booleans + 2 size bytes (= 14 bytes) | 3 type bytes + 10 booleans + 1 numItems byte (= 14 bytes; same total, different field assignments) |
| `BaseProperty::StringInfo` width | "TODO" | **12 bytes** (1 + 4 + 4 + 1 + 1 + 1) — DRW's schema number was correct, our previous failures were caused by the *Properties = List vs Dictionary* mismatch downstream |

Validated against full retail:

```
Layout parity: 101/101 records fully parsed.
Totals: 372 top-level elements, 1790 child elements (recursive),
        1142 states, 4161 BaseProperty overrides, 1451 MediaDescs
```

Layout parity test no longer `#[ignore]`'d.

## Milestone D StringInfo follow-on — partial (superseded, kept for history)

First spike on StringInfo wire-format RE. Partial progress shipped;
the schema is not fully resolved but the failure surface is now
correctly observable.

What landed (partial):
- StringInfo decode placeholder: 16 bytes as four little-endian u32
  words. This isn't a derivation from a documented source — it's an
  alignment-based guess. The evidence: in retail Layout 0x21000000,
  consuming 16 bytes after the StringInfo's master_id makes
  child-element 1's `element_id` field at offset 0xE6 align exactly
  to `0x1000041C`, which is the dict-key that wraps that ElementDesc.
  No other consume-length (4, 8, 12, 17, 20, 24) produces that
  alignment.
- Sanity caps in `layout::checked_count`, `state_desc::checked_count`,
  and `master_property.rs`'s Array variant. Without these, a misread
  CompressedUInt from an upstream StringInfo desync produces a
  ~268-million-element HashMap::with_capacity that OOM-kills the
  test process. Caps surface a clear error instead.
- `tests/string_info_probe.rs` dumps every StringInfo BasePropertyDesc
  from MasterProperty (20 in retail) — useful for the next spike to
  correlate keys with actual UI text.
- `tests/layout_parity.rs` extended to bucket "exceeds sanity cap"
  errors alongside "unknown MediaType" / "unknown MasterProperty key"
  as downstream symptoms of an upstream StringInfo desync.

Result on retail (Layout parity test, run via
`cargo test -- --ignored --nocapture`):
- 2/101 layouts fully parse (the no-StringInfo ones)
- 94/101 blocked on downstream desync (the StringInfo-bearing ones)
- 5/101 parse but with size mismatch (separate Layout-level shape gap)

What's still wrong: the 16-byte assumption only holds for Layout
0x21000000. Other layouts immediately desync, indicating StringInfo
is variable-length on the wire. Most likely candidates:

1. `m_strToken` is a real `PStringBase<char>` (CompressedUInt length
   + bytes) and the 16-byte layout we observed in 0x21000000 was
   coincidentally a fixed-binary-token form. Length byte 0x17 = 23
   would mean the 23 bytes following are the token (binary or
   ASCII).
2. `m_variables` HashTable is non-empty in some StringInfos and
   adds bytes proportional to its count.
3. Some other PStringBase field (m_LiteralValue, m_strEnglish,
   m_strComment) is non-trivially long.

Next steps for the deeper RE:
- Diff several StringInfo records (across multiple Layout records)
  byte-by-byte and look for a length-prefixed pattern.
- Try implementing StringInfo as the full acclient.h `struct
  StringInfo` (8 fields including PStrings and a HashTable) and see
  if it works.
- Cross-check against Chorizite `ACBindings.Generated.Game.Properties`
  StringInfoBaseProperty if it has wire-format hints.
- If all else fails, fuzz-search: try every length 4-128, for each
  scan retail layouts, find the one length that maximizes successful
  parses.

## Milestone D StringInfo follow-on (deferred RE)

D3's parity test exposed that `BaseProperty::StringInfo` is the last
wire-format unknown blocking full Layout retail parity. Three knowns
gathered during D3 execution:

1. DRW dats.xml declares StringInfo as 12 bytes
   (byte + u32 + u32 + byte + byte + byte) but explicitly marks the
   schema `TODO: this doesn't match dats`. We confirmed it doesn't
   match — implementing the 12-byte schema and parsing retail
   Layout 0x21000000 desyncs at the next MediaDesc (reads invalid
   type 0x100).
2. acclient.h `struct StringInfo` (line 30308) is 8 fields:
   `PStringBase<char> m_strToken`, `u32 m_stringID`,
   `IDClass<DataID> m_tableID`, `HashTable<u32, StringInfoData*>
   m_variables`, `PStringBase<u16> m_LiteralValue`, `char
   m_Override`, `PStringBase<char> m_strEnglish`,
   `PStringBase<char> m_strComment`. This is the runtime in-memory
   form — wire serialization isn't guaranteed to mirror it.
3. The downstream symptoms of an unresolved StringInfo are
   `unknown MasterProperty key 0x00000000`,
   `unknown MediaType 0x...`, `duplicate-type mismatch` errors, and
   absurd allocation sizes from misread CompressedUInt counts in
   recursive ElementDesc.Children — all of which the parity test
   buckets as "blocked on StringInfo".

Suggested approach: probe a small Layout with exactly one StringInfo
BaseProperty (Layout 0x21000000 with 1 StringInfo at offset 0xD1 is
the simplest), enumerate plausible wire layouts (DRW 12-byte,
acclient-runtime 24-byte+, RynthSuite/Chorizite C# decomps if any),
and find the one where the immediately-following bytes parse as a
valid MediaDesc. Then validate against all 101 retail Layout
records. Estimated effort: 2-3 hours.
