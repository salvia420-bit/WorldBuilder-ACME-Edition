# Handoff: vitaeum-parity follow-on work

**For:** historical reference — MOSTLY CLOSED.
**Session that produced this:** 2026-05-23, ~17 commits on master,
ending at `54c3c085`.
**Status (2026-05-25 update):** the "Downstream work the parser
coverage unlocks" list at the bottom of this doc has been largely
closed by Wave 7 (commits `54bbe206` → `68562a6e`) and the
layout-port wave (commits `e606604a` → `0c5e26b0`). See the
"Status — closed" section at the bottom of
`docs/vitaeum-parity-plan-2026-05-23.md` for the canonical record of
what shipped.

Brief summary of remaining open follow-ons (the only items still
matching this handoff's scope):
- **Full-world bake 13×13 → 255×255 (65,025 LBs)** — original §"Downstream" #1. Still open. Ops/storage work.
- **G3 states emission reland** — re-introduce StateDesc/BaseProperty/MediaDesc in `fetch_layout` (the layout-port G3 was temporarily reverted in `4f7f5033`).
- **Long-tail font wirings** — CJK fallback `0x40000017`, scrolling battle text `0x40000031`, 3D damage popups `0x4000000F` / `0x40000010`.
- **LanguageString consumer in character-creation** — `loadLanguageString` runtime ships; no character-create consumer.

The "Skipped during this push" list is unchanged — those parsers
remain skipped per the original go/no-go (write only on concrete
consumer demand).

## Don't read everything inline — use Explore agents

This codebase is big (Rust workspace + C# ACE server + DRW upstream +
acclient.h decomps + Chorizite vendored, totalling well over a million
lines of source across `/home/wbterminal/`). Reading files
one-at-a-time will burn your context fast. **Use the Explore agent
(`subagent_type: "Explore"`) for any open-ended discovery work** —
it's a read-only fast-search agent whose context doesn't pollute yours.

Concrete examples:
- "Find all callers of `BaseProperty::read_with_master` in the
  workspace and report which crates use them and what they pass for
  the master ref."
- "Survey ACE's `Source/ACE.DatLoader/FileTypes/` and report which
  file types ACE handles that holtburger-dat does NOT yet have a
  parser for."
- "Find every reference to `DRW` or `dats.xml` in the holtburger
  workspace and report whether each one is still load-bearing or
  could be removed now that ACE is the authoritative source."

Direct `Bash`/`Read`/`grep` is fine for **targeted** lookups (you know
the file path, you know the symbol). Anything broader: Explore.

## Required reading (single Read each)

In priority order, the things you actually need in YOUR context:

1. **`docs/vitaeum-parity-plan-2026-05-23.md`** — the canonical plan
   doc. Status of every Milestone (A, C1–C4, B1, B2, B1.b, D)
   including what's deferred and why. **Read this first.**
2. **`~/.claude/projects/-home-wbterminal/memory/MEMORY.md`** —
   auto-loaded but read the entries tagged "feedback" for AC dat
   discipline:
   - `feedback_dat_format_ace_over_drw.md` — **the load-bearing
     lesson from this session**. ACE > DRW for DAT wire formats.
     Read this in full.
   - `feedback_dat_parser_mislabels.md` — parallel rule for scalar
     widths (acclient.c truth).
   - `feedback_ground_in_real_wire_data.md` — discipline.
   - `feedback_test_fixtures_real_data.md` — discipline.
3. **`crates/holtburger-dat/src/file_type/mod.rs`** — see the full
   parser surface and re-exports. Don't read every parser; spot-read
   the one closest to what you're adding.

## Source-of-truth priority for any new DAT parser

When you need to know the wire format of a DAT type:

1. **First:** ACE's `Source/ACE.DatLoader/{FileTypes,Entity}/{TypeName}.cs`
   — find via `find /home/wbterminal/ace-server/Source -name "{TypeName}.cs"`.
   The `Unpack(BinaryReader reader)` method is canonical. ACE has a
   parity test (`UnpackLocalEnglishDatFiles_NoExceptions` /
   `UnpackPortalDatFiles_NoExceptions`) that asserts byte-exact
   consumption against retail.
2. **Cross-reference only if missing:** DRW's
   `external/DatReaderWriter/DatReaderWriter/dats.xml` and
   `Types/{TypeName}.cs`. **Assume any disagreement with ACE is
   DRW's bug.** This session caught 7+ such bugs in `LayoutDesc` /
   `ElementDesc` / `StateDesc` / `MasterProperty` / `BasePropertyDesc`.
3. **acclient.h** at `/home/wbterminal/ac-headers/acclient.h`: useful
   for confirming a *field exists* and what its in-memory C++ type
   was, but **NOT for on-wire byte layout**. Runtime structs contain
   pointers and HashTables that don't serialize literally.
4. **WB.Terminal** at
   `/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/`
   — useful as a "what does retail say this byte represents" oracle
   when you need a known-correlated example.

For gameplay semantics (not wire format), see
`feedback_three_source_cross_reference.md` for the broader
ACE + RynthSuite + acclient.h triangulation rule.

## What's done

See plan doc for the full table. Summary: the kind-aware DAT
classifier landed, 8 parsers + 9 parity tests across Milestones
A–D, including Milestone D's full Layout chain (101/101 retail
records parse). Approximately 10,300 retail records now parse with
byte-exact size accounting.

## What's left in the plan doc

### Skipped during this push (low-value, easy to add if needed)
- `RenderTexture`, `RenderMaterial`, `MaterialModifier`,
  `MaterialInstance`, `RenderMesh` — modern-pipeline AC2-era types,
  mostly unused in retail-1.6.
- `DataIDMapper`, `DualDataIDMapper`, `EnumMapper` — ~67 generic
  lookup tables. Write only if a specific consumer needs them.
- `DatabaseProperties`, `MasterProperty` standalone, `StringState`,
  `StringTableString`, `BSPNodeType`, `MutateFilter` — rare/system.

For each: ACE has a parser, follow the recipe in the previous
section.

### Still deferred — needs RE work
- **`ActionMap` (DAT 0x26)** — DRW's dats.xml body is literally
  empty; the single retail record is 12,303 bytes. ACE *probably*
  has a parser (`find /home/wbterminal/ace-server/Source -name "ActionMap.cs"`);
  check there first. If ACE doesn't have one either, this is a
  genuine RE spike against acclient.h `struct InputManager` /
  `struct ActionMap`.

### Downstream work the parser coverage unlocks
These weren't in the original plan but make sense as follow-ons:

1. **Full-world bake** — extend `scenery-bake` / `event-bake` /
   `dat-shard` from the current 13×13 Holtburg ring (169 LBs) to
   the full 255×255 Dereth (65025 LBs). See vitaeum's stats — that
   was their headline number. Infrastructure exists, just needs
   compute + storage planning. Memory:
   `project_holtburger_bake_disk_trap.md` for the disk landing-zone
   convention.
2. **Wire newly-parsed types into the live client.** Most of the
   parsers ship as standalone decoders. Consumers that would actually
   USE them:
   - `Font` + `LanguageString` + `StringTable` → real AC font/text
     rendering in holtburger-web (currently uses browser system
     fonts).
   - `ClothingTable` + `PaletteSet` → equipment visuals on player /
     NPC meshes.
   - `CombatManeuverTable` → replace hand-coded combat move dispatch
     in the combat plugin.
   - `LayoutDesc` + `MasterProperty` → real AC UI port (the
     Chorizite plan §13 browser-skeleton work).
   - `GfxObjDegradeInfo` → wire into the LOD work
     (`project_visual_fidelity_wave1_done_2026-05-13.md`).

## Stay grounded — discipline notes

- **Don't ship a parser without a retail-data parity test.** Pattern:
  `crates/holtburger-dat/tests/{type}_parity.rs`, gated on
  `HOLTBURGER_PORTAL_DAT` (or `HOLTBURGER_LOCAL_DAT`) env var, walks
  every retail record of that type and asserts byte-exact
  consumption. Multiple examples in the tests directory; copy one.
- **Allocation safety:** if your parser reads a count from the wire
  and uses it with `HashMap::with_capacity` / `Vec::with_capacity`,
  add a sanity cap (see existing `LAYOUT_DICT_COUNT_CAP` pattern).
  A misread CompressedUInt can produce ~268M-element allocations
  that OOM-kill the test process.
- **Test fixtures from real bytes:** for unit tests, embed actual
  bytes from a known retail record (extract via
  `target/release/dat-tool export ... -o`) rather than synthesizing.
- **Never PhatSDK** (`feedback_no_phatac.md`). ACE-only for
  server-side cross-references.

## Base DAT location
`/home/wbterminal/ac_base_dats/{client_portal,client_cell_1,client_local_English}.dat`
plus `acclient.exe`. See `feedback_base_dats_only_for_bake.md` for
the determinism rule.

## Where to leave artifacts
Per `feedback_use_external_drives_for_scratch.md`:
`/mnt/wbterminal1/tmp/claude-scratch/` for any byte dumps, traces,
intermediate files. **Not** the system drive (it fluctuates 85–96%).

## Workflow

1. Read this file + the plan doc.
2. Pick a follow-on (parser to add, full-world bake, consumer
   wiring, ActionMap RE).
3. Spawn an Explore agent for any context-heavy discovery.
4. Cross-check ACE first, DRW second (per the new memory).
5. Add the parser + parity test + commit.
6. Update the plan doc's status log when you ship a milestone.

Good luck. The pump is primed.
