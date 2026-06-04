# Movement-Protocol Retail-Parity Workflow — Phase A RESULTS

**Branch:** `feat/movement-protocol-parity-2026-06-04` (off `master` @ `190cf184`)
**Date:** 2026-06-04
**Scope:** Phase A only — code-only Rust items, cargo-verified per-crate, no wasm rebuild, no live eye-test.
**Spec:** `PROMPT.md` (this directory). Ground truth: `~/ac-headers/acclient.c` (zero drift at this HEAD), ACE `external/ACE/Source/`, chorizite `Chorizite.ACProtocol` (masks ported from acclient, NOT chorizite's buggy `&0x7F`).

---

## Phase A item map

| Item | Description | Commit SHA(s) | Crate | Cargo verdict | Deep-dive finding closed | Status |
|------|-------------|---------------|-------|---------------|--------------------------|--------|
| **A1** | `is_newer_u16` 0x8000 boundary made directional per `acclient.c:143002-143013` (`CPhysicsObj::is_newer`). New body: `delta != 0 && (delta < 0x8000 || (delta == 0x8000 && candidate < current))`. Function body + doc comment + renamed test `u16_half_range_is_directional`. `is_newer_u32` + u32 tests untouched (A1 is u16-only). | `fd81dbc6` | `holtburger-common` (also re-verified `holtburger-world` consumer) | **PASS** — `holtburger-common: 55 passed; 0 failed; 0 ignored`; `holtburger-world` (consumes helper): `357 passed; 0 failed; 0 ignored` | QW4 / RECON-3 / SEQ-4 | **done** |
| **A2** | Command-count masks: `RawMotionState::unpack` now `((packed_flags & 0xFFFF) >> 11)` (`acclient.c:333240`); `InterpretedMotionState::unpack` now `((raw_flags >> 7) & 0x1F)` (`acclient.c:333542`, NOT chorizite `&0x7F`). Inert for valid frames. | `86c1f470` | `holtburger-protocol` | **PASS** — `421 passed; 0 failed; 2 ignored` (lib 350; generated_parity 68; opcode_parity 2; doc-tests 1) | IR2 / RAWMOTION-2 + INTERP-2 | **done** |
| **A3** | VectorUpdate misnamed-field fix (`update_vector_sequence` → `record_vector_update_sequences`, still writes `instance_sequence` but now correctly named/documented) + real `vector_sequence` field on `PlayerState` and `Entity.sequences[3]` (`OBJECT_VECTOR_SEQUENCE_INDEX=3`) + DEFAULT-OFF `USE_VECTOR_SEQUENCE_GATE` (`is_newer_u16` accept-gate mirroring `acclient.c:143459-143480`). Both self VectorUpdate arms (`handlers/player.rs`, `handlers/movement.rs`) routed through the new path; gate threaded into the remote arm. | `2aed8a41` | `holtburger-world` | **PASS** — `360 passed; 0 failed; 0 ignored` (lib unittests; 0 doc-tests) | OQ-1 (gate ships **off** pending capture) | **done** (gate default-off) |
| **A4** | `0xF619 PositionAndMovementEvent` fully wired. **Part 1 (codec):** opcode uncommented + `GameMessage::PositionAndMovementEvent(Box<PositionAndMovementEventData>)` variant + unpack/pack dispatch + `PositionAndMovementEventData` struct (`ObjectId(Guid) + PositionPack + guid-less MovementData body`) + `unpack_movement_data_body`/`pack_movement_data_body` helpers + `test_dispatch_position_and_movement_event` (synthesized round-trip + byte-exact parity); `opcode_parity` gate green. **Part 2 (world handler):** explicit `GameMessage::PositionAndMovementEvent` arm in `handlers/movement.rs` applying BOTH the `PositionPack` half (player => `set_player_position`; remote => `apply_entity_position_pack`) AND `EntityMotionSnapshot::from_movement_event` (mirroring the `UpdateMotion` arm, incl. death-motion + TurnToHeading/TurnToObject), guarded by `if let Some(entity)` so position-half events are not dropped; world-level round-trip test `position_and_movement_event_applies_position_and_motion`. | `4971c37b` (codec / Part 1), `9774a926` (world handler / Part 2) | `holtburger-protocol` (Part 1) + `holtburger-world` (Part 2) | **PASS** — protocol `421 passed; 0 failed; 2 ignored`; world `360 passed; 0 failed; 0 ignored` | IR4 / OPC-1 | **done** |
| **A5** | MOVEDATA-1 over-read: VERIFY-THEN-DECIDE resolved to **a real fix** (over-read existed, NOT dropped). Pre-fix, `movement_type` 0-5 all routed to `MovementInvalid::unpack_ext` (unconditionally reads an `InterpretedMotionState` body ≥4 bytes); `acclient.c:339547 unpack_movement` reads that body ONLY in `case 0`, cases 1-5 fall to `default` no-op. Fix: only `movement_type 0` reads the body; types 1-5 default to empty `MovementInvalid` (0 bytes read); pack side mirrored for byte-parity. Test `test_movement_event_stop_completely_has_no_body` (16-byte StopCompletely frame, no over-read, 1:1 repack). | `86c1f470` (committed with A2) | `holtburger-protocol` | **PASS** — `421 passed; 0 failed; 2 ignored` | IR1 / MOVEDATA-1 (verdict: FIX, real latent over-read) | **done** |
| **A6** | Doc-only corrections (this RESULTS.md). No source edits. | (this file's commit) | n/a | n/a | QW1 / JUMP-1 / POS-* baseline | **done** |

---

## A6 — doc-only corrections (no source edits)

- **D1 "unconditional heartbeat" is CHANGED.** The deep-dive's "heartbeat fires unconditionally" claim no longer holds at this HEAD: a change-gate is already shipped at `system.rs:167` (`USE_AUTONOMOUS_POSITION_CHANGE_GATE`, default TRUE). The heartbeat is gated on `autonomous_pose_changed`, not unconditional. The *continuous-poll + window-split* refinement (poll every tick, retail's two-branch send) is deferred to **Phase B (B2 / SEND-3)** — it needs a wasm rebuild + A/B eye-test and MUST land after B1.
- **JUMP +8 (object_guid + spell_id) kept deliberately.** ACE's `Player.HandleActionJump` / reader expects the 32-byte JumpPack; removing the +8 trailer would break the ACE reader. Retail's JumpPack actually carries a *Position* block neither side has — fixtures are synthesized; this is documentation-only. **No wire bytes changed in Phase A.**
- **POS-1 / SEQ-* confirmed retail-correct — NO change.** `PositionPack` velocity-before-placement order is retail-correct (`acclient.c:323620` before `:323631`); it was NOT reordered to match ACE's placement-first `Position.cs` serializer (that is an off-wire server serializer). The sequence helpers (SEQ-* family) are retail-faithful; only the A1 0x8000 half-range boundary was hardened. `position.rs` is untouched in the entire Phase A diff.

---

## Buildbox gate TODO (skipped locally per the 8GB-laptop OOM rule — MUST run before merge)

- **`cargo clippy --workspace --all-targets --all-features -- -D warnings`** — clippy was intentionally NOT run on the laptop (heavy second compile; OOM rule forbids `--workspace`). Run on the buildbox. Notes for the gate:
  - Pre-existing crate warning `unused import: VendorItemEventData` exists on clean HEAD in `holtburger-protocol` — NOT in any file this workflow touched, NOT introduced here; a `-D warnings` gate may trip on it independent of these changes.
  - Local builds emitted **zero** warnings for the touched files; the new `pub(crate)` `Entity` accessors + `vector_sequence` field are all referenced (no dead-code expected).
- **`cargo fmt --all --check`** — fmt could NOT be fully validated locally: rustfmt was missing for the active stable toolchain on `holtburger-common`'s box (`cargo-fmt is not installed`); on the protocol/world boxes `cargo fmt -p <crate>` reflows the ENTIRE crate (the repo is NOT fmt-clean at HEAD — `build.rs`, `generated_parity.rs`, `unpack.rs`, `opcodes.rs`, `lib.rs`, `sky.rs`, `spatial/*`, `spell.rs`, `skill_formula.rs`, ~20+ files all reflow). **Each commit contains ONLY the intended logical edits** — unrelated formatter churn was surgically reverted (`git restore` / hand-reapply). **Do NOT `cargo fmt -p <crate>` and commit blindly on the buildbox** — it pulls in ~1800 lines of unrelated pre-existing reformat. A `cargo fmt --all --check` gate will flag those pre-existing files independently of this work; treat that drift as a separate cleanup.
- **`cargo test --workspace --all-targets --all-features`** — the full workspace gate was NOT run locally (OOM rule: never `cargo --workspace` on the laptop). Per-crate runs all green (`holtburger-common` 55, `holtburger-protocol` 421/2-ignored, `holtburger-world` 360). Run the full workspace gate on the buildbox as the final pre-merge check.

---

## Open for Phase B (wasm rebuild + live 1070 eye-test; HITL — NOT autonomous)

These carry real UX-regression risk and require a 1070 eye-test (perf-worker → firefox-driver `:9224`, or local chromium → `:8765` with `?nullRender=1`). Listed in dependency order per PROMPT.md:

- **B1 — D3-SNAP** force-position SNAP of the local working pose (RECON-1 + RECON-4 + RECON-5). HIGH risk; the central fix; GATES B2. Thread accepted force/teleport sequence-advance through `set_player_position` to select `AuthoritativeBodySync::Reset` vs `Snapshot`. NO velocity-zero on the force path (ACE-VELZERO-1 REFUTED). Reuses A1's hardened `is_newer_u16`.
- **B2 — D1-POLL** continuous-poll + window-split send gate (SEND-3). MED; MUST land AFTER B1. Refines the change-gate noted in A6/D1.
- **B3 — D6** single-predictor collapse / skill-derived JS speed (PRED-1). HIGH; do not co-test with B1.
- **B4 — D8** quantum subdivision — verify-then-extend (PRED-2). LOW at steady state; flag default-OFF.
- **B5 — QW2** VectorUpdate velocity → 3D remote tick (REMOTE-3 + REMOTE-1). MED value; JS-only, no wasm rebuild; biggest perceived-stutter win. Projectiles (OQ-2) are the live exerciser.
- **B6 — IR3** `position_sequence` newer-gate (SEQ-5). MED; flag DEFAULT-OFF. Reuses A1's `is_newer_u16`.
- **B7 — D4** remote interpolation queue (REMOTE-5). DEFER — over-engineering at ACE cadence.

### Captures that gate Phase A flags + B-item confidence (need a 1070 capture / ACE round-trip — see OPEN-QUESTIONS.md)

- **OQ-1** — Does ACE increment `ObjectVector` per broadcast? **Gates enabling A3's `USE_VECTOR_SEQUENCE_GATE`** (ships `false`). Until confirmed, A3's gate stays default-off and is inert (`set_player_vector_gated` == `set_player_vector`).
- **OQ-9** — Does ACE advance `position_sequence` per broadcast? **Gates B6's flag.**
- **OQ-5 / OQ-6** — z-hack ForcePosition reproduction; gates B1's snap-gate confidence.
- **CALIBRATION MAGNITUDE** — real retail run-speed (run ~1.9 vs ~7.6); timed-traverse capture; gates B3 magnitude.

---

## Out-of-scope follow-ups flagged during Phase A (route in a later crate-task)

1. **A5 duplicate over-read** — `crates/holtburger-world/src/entity.rs` (`EntityMotionSnapshot::from_object_description`) groups `movement_type` 1-5 → `MovementInvalid::unpack_ext` identically; same latent over-read. Route the same guard, or document that `from_object_description` only ever sees type 0/6-9. World-crate task.

---

## Constraint compliance (audited, all clear)

- No RECON-2 / ACE-VELZERO-1 / PRED-3 logic implemented.
- No wire bytes changed: JUMP +8 (object_guid+spell_id) and PositionPack velocity-before-placement order both untouched; `position.rs` not in the diff.
- No `--workspace` cargo; no second concurrent cargo; no wasm rebuild; no JS/`lib.rs`/`index.html`/`scene.rs`/`system.rs` edits — all changes are Rust crate source + tests. The only behavior-affecting addition (A3) ships behind a DEFAULT-OFF flag.
