# Completeness + Chorizite — Wave 1 Shipping Record (2026-05-19)

Tracking docket for the multi-wave verifiable-work push spanning `docs/world-completeness-method.md`, `docs/entity-completeness-method.md`, `docs/event-completeness-method.md`, and `apps/holtburger-web/CHORIZITE_PORTING_PLAN.md`. Wave 1 ran 6 agents in parallel against non-overlapping surfaces; all 6 passed their verification gates.

Constraint: every deliverable must be verifiable on the agent side — cargo test, byte-for-byte hash, JSON diff. No visual eye-tests, no runtime logs from the live browser.

## Wave 1 — completed (6/6 PASS)

| Item | Surface | Verification | Status |
|---|---|---|---|
| **1A** AnimationHook 27-variant parity | `crates/holtburger-dat/src/file_type/setup_model.rs` + new `tests/animation_hook_parity.rs` | cargo test: 12,249 retail files / 18,687 hooks round-trip byte-equal; per-variant coverage table printed | DONE |
| **1B** CreateParticle (type=13) payload parity | `crates/holtburger-dat/src/file_type/physics_script.rs` + `setup_model.rs` + new `tests/create_particle_hook_parity.rs` | cargo test: 4,248 PhysicsScripts round-trip; 10,743 CreateParticle hooks; golden sha256 pinned for sky + moon scripts | DONE |
| **1D** Region 0x13 sound_info parity | `crates/holtburger-dat/src/file_type/region.rs` + new `tests/region_sound_info_parity.rs` | cargo test: 37 STBs / 383 ambient slots; golden sha256 `42cdd2ff94c71161eb6480318b393531cc86c284a25ceb0a64c9df55bf14d755` pinned | DONE |
| **2D** SkillFormula Rust port | new `crates/holtburger-world/src/player/skill_formula.rs` + mod.rs wiring | cargo test: 6 cases including `HasAttribute2 == 0` upstream-bug-preservation case | DONE |
| **2E** Opcode parity audit (Chorizite vs holtburger-protocol) | new `chorizite-dump-opcodes` WB.Terminal command + new `crates/holtburger-protocol/tests/opcode_parity.rs` | 5 enums / 363 members dumped to `apps/holtburger-web/data/chorizite/chorizite-acprotocol-opcodes.json`; audit-only `#[ignore]` test surfaces 179 diffs | DONE (drift triage = Wave 1.5) |
| **3C** scenery-bake pre-flight integrity gate test | new `apps/holtburger-tools/tests/scenery_bake_preflight.rs` (synthetic-DAT fixture) | cargo test: REJECT (`0x__FFxxxx`) + ACCEPT+sidecar paths both green | DONE |

## Bugs caught and fixed (in-band)

1. **ReplaceObject (hook type 5) `part_index` width** — was reading `u16` (2 bytes), retail `AnimPartChange::UnPack` (`acclient.c:471699`) reads a single `u8`. DRW schema labels it `ushort`; the label is wrong. Fixed in `setup_model.rs::read_replace_object_payload`. **Would have silently desynced any AnimFrame/PhysicsScript containing a ReplaceObject hook.**

2. **Missing 4-byte alignment pad after every AnimationHook** — retail `CAnimHook::UnPackHook` (`acclient.c:343027`) and `PackHook` (`acclient.c:342168`) emit 0..3 zero pad bytes after each hook to keep the stream `ALIGN_PTR`-aligned. Only `ReplaceObject` produces a non-aligned payload (3 or 5 bytes), so the omission only desynced streams containing that hook. Fix captures padding into `data` so `write()` byte-equally re-emits. Cited inline.

Both fixes are unit-test guarded by the 12,249-file sweep in `animation_hook_parity.rs`.

## Non-clean findings (logged, not silently fixed)

### Opcode drift (Task #1 — Wave 1.5 triage in tracker)

`chorizite-dump-opcodes` produced canonical JSON for 5 Chorizite.ACProtocol enums (C2SMessageType=15, S2CMessageType=92, GameActionType=156, GameEventType=100, GameMessageGroup=10). Cross-port test against `holtburger-protocol/src/opcodes.rs` reveals **179 differences**:

- **174 Chorizite-but-not-Rust** — curated-subset gaps. Most have commented reference stubs already in `opcodes.rs`. Categories: Property/Quality remove events (15), Allegiance/House housekeeping (~35), Admin/Friends/AFK/Squelch/Channel admin (~25), Book/Inscription/Title/Barber/Chess/Portalstorm misc (~30), DDD details (4), Allegiance sub-ops + Char options (~20), PK arena / advocate / contracts / fellowship openness (~15). Plan: un-comment as messages get wired up, not en-masse.
- **5 Rust-but-not-Chorizite**, of which 3 are likely real categorization mismatches:
  - `GameOpcode::AutonomyLevel = 0xF752` — Chorizite places at `GameActionType::Movement_AutonomyLevel` (not top-level GameMessageType)
  - `GameOpcode::AutonomousPosition = 0xF753` — same pattern (`GameActionType::Movement_AutonomousPosition`)
  - `GameActionOpcode::RemovePlayerPermission = 0x021A` — possible off-by-one; Chorizite has it at `0x0220` (`Character_RemovePlayerPermission`)
  - `GameEventOpcode::InventoryServerSaveFailed = 0x00A0` — Chorizite categorizes as `S2CMessageType::Character_ServerSaysAttemptFailed` (top-level not event)
  - `GameOpcode::None = 0x0000` — internal sentinel, expected gap (not a bug)

Test is `#[ignore]` with a documenting comment. No opcodes silently changed during the audit. Un-ignore once mismatches are resolved.

### DRW schema mislabels (Task #11 — upstream-PR decision pending)

Three documentation-only mislabels in `external/DatReaderWriter/DatReaderWriter/dats.xml`, all correctly handled in our parser per `acclient.c` retail:

- `ReplaceObjectHook.PartIndex` — labeled `ushort`, retail uses `u8`
- `CreateParticleHook.EmitterInfoId` — labeled `<vector>` of `QualifiedDataId`, retail packs scalar `u32` (memory `reference_ac_particle_emitter_format.md` already notes this for GfxObjId/HwGfxObjId — same pattern bites here)
- `SoundTweakedHook` field order — labeled `Priority, Probability, Volume`, retail `UnPack` reads `prob, prio, vol`. No on-wire impact (struct vs decode label mismatch).

### Other notes

- **ACE C# `RegionDesc.cs` is a stub.** Full parser shape for Region 0x13 sound_info lives in DRW `dats.xml:2856-2871` + PhatSDK `SoundDesc.cpp:27-85`. Memory note: when DRW schema and PhatSDK agree and acclient.c confirms, the schema is authoritative for shape but check retail for scalar widths.
- **`0x33000455` is a 2-hook script, not a multi-CreateParticle.** The "Sky-J chain" framing in memory `project_holtburger_sky_particles_probe_2026-05-12` refers to a sky-particle subsystem, not to that DID having many emit hooks.

## Pending (Wave 2 — 7 work units)

Dispatched after this docket commit. Acceptance: cargo test green / Node test green / pytest green; no visual checks.

| # | Item | Stream |
|---|---|---|
| **1C** | SoundTable.resolveSound cross-port (WB.Terminal + Rust + JS) | Event |
| **2A** | Event taxonomy audit (`ACPlugin/*EventArgs.cs` → `plugins/api.js`) | Chorizite |
| **2C** | WorldObject property-dict audit (8 typed accessors) | Chorizite |
| **2F** | Enum table sync (add ObjectDescriptionFlag + WeenieHeaderFlag) | Chorizite |
| **3A** | F.35 prefetch dedup (`manifest_source.rs::prefetch`) | World |
| **3B** | SoA wasm export hash parity (169 LBs) | World |
| **3D** | Spawn-stager determinism (pytest on shuffle) | World |

## Pending (Wave 3 — 2 work units, depend on Wave 2)

| # | Item | Depends on |
|---|---|---|
| **1E** | Event-bake prototype (new `holtburger-event-bake` crate) | 1A + 1B + 1C |
| **2B** | Dispatch parity test (20 synthetic GetObjectClass tuples) | 2C |

## Verification evidence

All Wave 1 cargo tests + the WB.Terminal `dotnet build` were run by the dispatched agents. Per-task verbatim output is captured in the agent run reports (this session's transcript). Test commands ready to re-run:

```sh
cd external/holtburger
cargo test -p holtburger-dat --release animation_hook_parity
cargo test -p holtburger-dat --release create_particle_hook_parity
cargo test -p holtburger-dat --release region_sound_info_parity
cargo test -p holtburger-world skill_formula
cargo test -p holtburger-protocol --test opcode_parity                    # passes (sanity); audit gated behind --ignored
cargo test -p holtburger-protocol --test opcode_parity -- --ignored       # 179-diff report
cargo test -p holtburger-tools --release scenery_bake_preflight
```

```sh
cd WorldBuilder.Terminal && dotnet build           # chorizite-dump-opcodes available
```
