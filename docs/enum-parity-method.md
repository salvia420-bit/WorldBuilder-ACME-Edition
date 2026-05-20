# Enum-Parity Method (cross-port enum drift audit)

Companion to [`world-completeness-method.md`](world-completeness-method.md)
(placements), [`event-completeness-method.md`](event-completeness-method.md)
(sounds + particles), and [`entity-completeness-method.md`](entity-completeness-method.md)
(typed classification). This doc covers Wave 2.C of the
[diagnostic-toolset plan](diagnostic-toolset-plan-2026-05-19.md):
**cross-port enum parity**.

Status: **shipped 2026-05-19**, baseline audit run, follow-on PRs surface
the drift it found.

## The contract

For every enum that exists in BOTH ports:

* same variant name → same underlying integer value,
* every Chorizite variant has a Rust counterpart (and vice-versa).

`canonical_enum_value(name) ≡ chorizite_value(name) ≡ rust_value(name)`

If a Chorizite enum has no Rust counterpart at all (e.g. it ships in
Rust as a `bitflags!` macro-generated struct rather than a `pub enum`),
that's a **GAP row** — diagnostic, not failure. The validator reports it
honestly and moves on.

If the Rust enum exists but variant names or values diverge, that's a
**FAIL row** — the diagnostic emits a precise diff (missing-rust,
missing-chorizite, value-mismatch) and the validator exits non-zero.

## Why this matters

Holtburger receives wire bytes from ACE that carry integer enum values:
PropertyInt keys, MotionStance discriminators, AttackHeight, CombatMode,
DamageType, etc. If our Rust enum has the same name but a different
underlying value, every consumer downstream silently misclassifies. This
is the structural analog of "wire opcode parity" (opcode_parity.rs)
extended one layer deeper.

Same pattern as the other completeness methods:

* the **source of truth** is upstream Chorizite (which mirrors retail
  acclient.exe);
* our Rust crates are the **subject under test**;
* the validator emits a structured diff so drift is observable from a
  single artifact, not a runtime crash.

## Source files

### Chorizite (oracle)

* `external/chorizite/Chorizite.Common/Enums/*.cs` — 65 enums, 7,108
  lines, `namespace Chorizite.Common.Enums`. Reflection-readable in
  WB.Terminal.
* `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Enums/*.cs`
  — 73 generated enum files; `ObjectDescriptionFlag.generated.cs` is the
  one in our curated set (the other 72 are mostly protocol opcodes covered
  by `chorizite-dump-opcodes`).

### Holtburger Rust (subject)

* `external/holtburger/crates/holtburger-common/src/properties/property_keys/*.rs`
  — `PropertyBool`/`Float`/`Int`/`Int64`/`String`/`DataId`/`InstanceId`
* `external/holtburger/crates/holtburger-common/src/stats.rs` —
  `AttributeType`, `VitalType`, `SkillType`, `CreatureType`,
  `TrainingLevel`
* `external/holtburger/crates/holtburger-common/src/properties/inventory.rs`
  — `MaterialType`, `AttunedStatus`
* `external/holtburger/crates/holtburger-common/src/properties/object.rs`
  — `WeenieType`
* `external/holtburger/crates/holtburger-common/src/properties/radar.rs`
  — `RadarColor`, `RadarBehavior`
* `external/holtburger/crates/holtburger-protocol/src/messages/combat/types.rs`
  — `AttackHeight`, `CombatMode`, `DamageLocation`
* `external/holtburger/crates/holtburger-protocol/src/messages/movement/types.rs`
  — `MotionStance`, `MovementType`, `HoldKey`, `PositionType`
* `external/holtburger/crates/holtburger-protocol/src/messages/character/types.rs`
  — `SkillAdvancementClass`
* `external/holtburger/crates/holtburger-world/src/spell.rs` —
  `MagicSchool`, `SpellExtrasInfo`
* `external/holtburger/crates/holtburger-world/src/assessment.rs` —
  `WieldRequirement`, `HeritageGroup`
* `external/holtburger/crates/holtburger-world/src/player/skill_formula.rs`
  — `AttributeId`
* `external/holtburger/crates/holtburger-dat/src/file_type/mod.rs` —
  `DatFileType`

A complete mapping lives in
[`WorldBuilder.Terminal/CommandEngine.EnumParity.cs`](../WorldBuilder.Terminal/CommandEngine.EnumParity.cs)
`ManualEnumMapping`.

## The classifier (the load-bearing piece)

`CommandEngine.EnumParityReportCommand` does three things, in order:

1. **Build the Chorizite-side dump** via the existing
   `ChoriziteDumpEnumValues(null)` — reflection over
   `Chorizite.Common.Enums.*` + regex-parse of
   `Chorizite.ACProtocol/Enums/ObjectDescriptionFlag.generated.cs`.
   Emits a 66-row list of `ChoriziteEnumDump { EnumName, UnderlyingType,
   IsFlags, Members[] }`.

2. **Resolve the Rust counterpart** for each Chorizite enum, in order:
   - check `ManualEnumMapping` (hand-curated 1:1 + name-mismatch entries),
   - else scan `external/holtburger/crates/**/*.rs` for `pub enum
     <ChoriziteName>`.
   When neither hits, the enum is a GAP row (`status: "missing-rust"`).

3. **Diff name-by-name + value-by-value.** Each mismatch row carries a
   `Kind` discriminator:
   - `missing-rust`           — variant in Chorizite, absent from Rust
   - `missing-chorizite`      — variant in Rust, absent from Chorizite
   - `value-mismatch`         — same name, different integer
   - `missing-rust-enum`      — entire Rust enum absent (synthetic row;
                                drives the GAP classification)
   - `rust-source-missing`    — manual mapping points at a non-existent
                                file (mapping table stale)
   - `rust-enum-not-found`    — file exists, named enum doesn't (mapping
                                stale or upstream rename)

## The validator

`external/holtburger/apps/holtburger-web/validate_enum_parity.cjs`
drives `enum-parity-report` via a stdin subprocess; emits a
`report.json` at
`/mnt/wbterminal1/holtburger-validator-reports/enum-parity/<ts>/` matching
the §4.4 envelope shape from the diagnostic-toolset plan.

Exit codes:

* `0` — every Rust-mapped enum passes (GAP rows non-blocking)
* `1` — at least one FAIL row (true parity drift; orchestrator must fix
        the Rust side or update the mapping)
* `2` — infra error (subprocess crashed, dispatch not wired,
        Chorizite vendoring unreadable)

## Phase plan + bake

| Phase | Brick | Status | Owner |
|---|---|---|---|
| W2.C.1 | Expand `CuratedEnumAllowlist` from 11 → 65 (all `Chorizite.Common.Enums`) | shipped 2026-05-19 | this agent |
| W2.C.2 | Implement `enum-parity-report` engine method | shipped 2026-05-19 | this agent |
| W2.C.3 | `validate_enum_parity.cjs` validator | shipped 2026-05-19 | this agent |
| W2.C.4 | Regen `data/chorizite/chorizite-common-enums.json` | shipped 2026-05-19 | this agent |
| W2.C.5 | Method doc (this file) | shipped 2026-05-19 | this agent |
| W2.D.1 | Triage the 16 FAIL rows from baseline run | open | Wave 2.D candidate |
| W2.D.2 | Port the 45 GAP rows that aren't bitflags-style | open | Wave 2.D candidate |

## Baseline run (2026-05-19)

```
Checked:   66
Pass:       5
Fail:      16  (true parity drift — Wave 2.D follow-on)
Gap:       45  (Chorizite-only; mostly bitflags! macro-backed Rust
                types — not parity bugs, but missing-enum diagnostics)
```

PASS rows (no work to do): AttackHeight, HeritageGroup, MagicSchool,
PropertyInt64, RadarColor.

Most surprising drift in the FAIL set: **MotionStance** —
`holtburger-protocol/src/messages/movement/types.rs::MotionStance` adds
`0x80000000` to every value (e.g. `HandCombat = 0x8000003C` vs Chorizite
`HandCombat = 0x3C`). Looking at the source, this is intentional — the
high bit is the "combat-mode-active" flag added on the wire. Either:

* the Rust enum should NOT include the high bit (and Rust callers OR the
  value when emitting on the wire), OR
* the parity mapping should mark this as an allowlisted-divergence
  (similar to `opcode_parity.rs::CATEGORIZATION_GATE_ALLOWLIST`).

This is exactly the kind of "drift on a load-bearing surface" the
diagnostic exists to find.

## Scope limits

What this method does NOT cover:

* **`bitflags!` macro-backed structs.** A handful of Chorizite [Flags]
  enums (ItemType, SpellFlags, WeenieHeaderFlag, PhysicsState,
  ObjectDescriptionFlag, etc.) ship in Rust as
  `bitflags! { pub struct Foo: u32 { … } }`, not as `pub enum`. The
  validator can't compare them by the current diff path; they surface as
  GAP rows. Resolving them is Wave 2.D territory — either port the
  bitflags as a `pub enum` (rare; usually we don't want that), OR extend
  the parity validator to also scan `bitflags! { … }` blocks.

* **Same-name-different-meaning collisions.** Chorizite's `AttunedStatus`
  is a stats enum with 4 levels; Rust has `AttunedStatus` as a
  3-variant enum in `holtburger-world/src/assessment.rs`. The validator
  reports value-mismatches faithfully; deciding which one is "right" is
  out of scope. The `ManualEnumMapping` table is the place to override.

* **Cross-port semantic equivalence.** Some Chorizite `[Flags]` enums
  with `None = 0` get reported as missing-chorizite in Rust if Rust
  doesn't define `None`. That's a stylistic divergence (Rust idiom
  prefers `Option<T>` over an explicit None variant); humans should
  judge if it matters per-case. The validator's job is to surface the
  difference, not paper over it.

## Provenance

Method doc by the Wave 2.C agent on 2026-05-19. Drift surfaced by the
baseline run is the diagnostic toolset's job to REPORT, not to fix; the
Rust crate gaps it found are tracked separately as Wave 2.D follow-ons.
See [`reference_chorizite_org`](../README.md) (memory) for the upstream
Chorizite ecosystem layout, and [`reference_external_drive_layout`] for
the report-storage paths.

Cross-references:

* [`diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md)
  §3 row 6 + §6 Wave 2 + §5 command row 7.
* [`world-completeness-method.md`](world-completeness-method.md) §0 (sibling
  validator pattern).
* `external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md` §12.4
  (this command joined the WB.Terminal absorption layer).

*End of method doc.*
