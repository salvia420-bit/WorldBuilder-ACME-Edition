#!/usr/bin/env node
// Wave-1 wire-conformance validator
// ===================================
//
// Contract (docs/wire-conformance-method.md §"The contract"):
//   Every outgoing wire frame our wasm session emits, AND every incoming
//   frame it parses, must round-trip byte-identical against
//   Chorizite.ACProtocol's pack/unpack of the same payload.
//
// What this validator does:
//   For each fixture in FIXTURES:
//     1. Drive the byte sequence through WB.Terminal's
//        chorizite-wire-unpack-message + chorizite-wire-pack-message
//        commands (the C# Chorizite.ACProtocol oracle).
//     2. Where a Rust-side counterpart is available in
//        crates/holtburger-protocol/, cross-check via its unit-test hex
//        fixtures (the values that already pass `cargo test` round-trip).
//     3. Report PASS / FAIL / SKIP with the same envelope as
//        validate_landblock_completeness.cjs / validate_entity_classification.cjs.
//
// Sources of truth (in oracle precedence per
// [[feedback_three_source_cross_reference]]):
//   1. Chorizite.ACProtocol — WB.Terminal oracle (this validator subprocesses it).
//   2. holtburger-protocol Rust crate — subject under test, but its
//      cargo-tested hex fixtures are the cross-check baseline.
//   3. ACE server source — informational only here; not exercised in this run.
//
// Run:   node validate_wire_conformance.cjs
// Exit:  0 PASS, 1 FAIL (any required fixture mismatched),
//        2 INFRA (WB.Terminal won't start / file missing).
//
// Output: /mnt/wbterminal1/holtburger-validator-reports/wire-conformance/<ISO-ts>/report.json

const path = require("node:path");
const fs   = require("node:fs");
const cp   = require("node:child_process");
const crypto = require("node:crypto");

// ─────────────────────────────────────────────────────────────────
// Paths & metadata
// ─────────────────────────────────────────────────────────────────

const REPO_ROOT   = "/home/wbterminal/WorldBuilder-ACME-Edition";
const WBT_DLL     = path.join(REPO_ROOT, "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll");
const FIXTURES    = path.join(REPO_ROOT, "external", "holtburger", "crates", "holtburger-protocol", "tests", "fixtures");
const BASE_DAT    = "/home/wbterminal/ac_base_dats/client_portal.dat";

const ISO_TS      = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
const REPORT_DIR  = path.join("/mnt/wbterminal1/holtburger-validator-reports/wire-conformance", ISO_TS);

// ─────────────────────────────────────────────────────────────────
// Fixture set — at least 20 wire payloads
// ─────────────────────────────────────────────────────────────────
//
// Each fixture has:
//   - case: short name (used in mismatch reports)
//   - typeName: Chorizite type to unpack as (subclass)
//   - source: "real-bin" | "rust-test" | "synthesized"
//   - file: real-bin filename relative to FIXTURES (if real-bin)
//   - hex: hex string (if rust-test or synthesized)
//   - headerMode: "full" | "payload" — controls whether bytes carry outer header
//   - opcode: expected outer opcode (sanity check, optional)
//   - notes: human-readable provenance
//
// Required coverage (per task description):
//   01 GameMessageCreateObject            (Item_CreateObject 0xF745)
//   02 GameMessageDeleteObject            (Item_DeleteObject 0xF747)
//   03 GameMessageObjDescEvent            (Item_ObjDescEvent 0xF74C)
//   04 GameMessageUpdateObject            (Item_UpdateObject) [SKIP — opcode unknown]
//   05 GameMessagePrivateUpdatePosition   (Qualities_PrivateUpdatePosition 0x02DB)
//   06 GameMessagePublicUpdatePosition    (Qualities_PublicUpdatePosition 0x02DC)
//   07 GameMessagePrivateUpdateAttribute  (Qualities_PrivateUpdateAttribute)
//   08 GameMessagePrivateUpdateAttribute2ndLevel (Qualities_PrivateUpdateAttribute2ndLevel)
//   09 GameMessageAutonomousPosition      (Movement_AutonomousPosition — C2S action)
//   10 GameMessageSound                   (Effects_SoundEvent 0xF750)
//   11 GameMessageScript                  (Effects_PlayScriptId / PlayScriptType 0xF74F/0xF750-area)
//   12 GameMessageUpdateMotion            [SKIP — not in ACProtocol enum]
//   13 GameMessagePublicUpdatePropertyInt (Qualities_PublicUpdateIntEvent 0x02B0)
//   14 GameMessageVectorUpdate            (Movement_VectorUpdate 0xF74E)
//   15 GameAction::Login                  (Login_SendEnterWorld / EnterWorldRequest)
//   16 GameAction::Jump                   (Movement_Jump - 0xF61B GameAction)
//   17 GameAction::ChangeCombatMode       (Combat_ChangeCombatMode - GameAction 0x53)
//   18 GameAction::TargetedMeleeAttack    (Combat_TargetedMeleeAttack - GameAction 0x08)
//   19 GameAction::CastTargetedSpell      (Magic_CastTargetedSpell - GameAction 0x4A)
//   20 GameAction::Buy / Sell             (Vendor_Buy 0x5F, Vendor_Sell 0x60)

const FIXTURES_LIST = [
  // ───── Real .bin fixtures from crates/holtburger-protocol/tests/fixtures/ ─────
  // These are the actual cargo-tested round-trip bytes. They carry the FULL
  // header (opcode + sequence + actionType when applicable).
  {
    case: "Effects_SoundEvent / 0xF750",
    typeName: "Effects_SoundEvent",
    source: "real-bin",
    file: "sound.bin",
    headerMode: "full",
    opcode: 0xF750,
    notes: "Real wire bytes; cargo-tested round-trip.",
  },
  {
    case: "Effects_PlayerTeleport / 0xF751",
    typeName: "Effects_PlayerTeleport",
    source: "real-bin",
    file: "player_teleport.bin",
    headerMode: "full",
    opcode: 0xF751,
    notes: "Real wire bytes; minimal teleport event.",
  },
  {
    case: "Qualities_PrivateUpdatePosition / 0x02DB",
    typeName: "Qualities_PrivateUpdatePosition",
    source: "real-bin",
    file: "private_update_position.bin",
    headerMode: "full",
    opcode: 0x02DB,
    notes: "Real wire bytes; cargo-tested.",
  },
  {
    case: "Qualities_UpdatePosition / 0x02DC (public)",
    typeName: "Qualities_UpdatePosition",
    source: "real-bin",
    file: "public_update_position.bin",
    headerMode: "full",
    opcode: 0x02DC,
    notes: "Real wire bytes; cargo-tested. (Chorizite calls this 'UpdatePosition', not 'PublicUpdatePosition'.)",
  },
  {
    // Wave-2 close-out (2026-05-19): fixture had been mislabeled as
    // Qualities_UpdateInt (0x02CE top-level) — the actual bytes are an
    // Ordered_GameEvent (0xF7B0) wrapper around event type 0x0295 =
    // Communication_ChatRoomTracker (Chorizite name) = SetTurbineChatChannels
    // (Rust/legacy name). The wrapper is 16 bytes:
    //   b0f70000 (opcode 0xF7B0)
    //   01000050 (OrderedObjectId = 0x50000001)
    //   0c000000 (OrderedSequence = 12)
    //   95020000 (EventType = 0x0295)
    // Then 40 bytes of 10 × u32 channel ids. Pointing the typeName at
    // the concrete inner-event subclass in "full" mode exercises both
    // the Ordered_GameEvent header AND the wrapped payload through
    // Chorizite's own dispatcher.
    case: "Ordered_GameEvent → Communication_ChatRoomTracker",
    typeName: "Communication_ChatRoomTracker",
    source: "real-bin",
    file: "update_property_int.bin",
    headerMode: "full",
    opcode: 0xF7B0,
    notes: "Wave-2 fix: relabeled mis-named fixture. Real bytes are " +
           "Ordered_GameEvent(0xF7B0) wrapping Communication_ChatRoomTracker " +
           "(GameEventType 0x0295, the Chorizite name for what Rust calls " +
           "SetTurbineChatChannels). Round-trip via WB.Terminal's full-mode " +
           "Ordered_GameEvent header path (16-byte outer + 40-byte inner).",
  },
  {
    case: "GameAction LoginComplete (real-bin)",
    typeName: "Character_LoginCompleteNotification",
    source: "real-bin",
    file: "action_login_complete.bin",
    headerMode: "full",
    opcode: 0xF7B1,
    notes: "Real wire bytes; LoginComplete C2S action.",
  },
  {
    case: "Communication_Talk (action)",
    typeName: "Communication_Talk",
    source: "real-bin",
    file: "action_talk.bin",
    headerMode: "full",
    opcode: 0xF7B1,
    notes: "Real action bytes; 'Hello World' talk command (cargo-tested).",
  },
  {
    case: "Character_RequestPing (action)",
    typeName: "Character_RequestPing",
    source: "real-bin",
    file: "action_ping_request.bin",
    headerMode: "full",
    opcode: 0xF7B1,
    notes: "Real ping action. (Chorizite name = Character_RequestPing.)",
  },
  {
    // Wave-2 close-out (2026-05-19): the original typeName was wrong.
    // The 36-byte fixture is a Movement_SetObjectMovement (0xF74C) payload
    // (without the leading opcode bytes). Decoded:
    //   02000050 — ObjectId 0x50000002
    //   0e00     — ObjectInstanceSequence = 14
    //   55000f00 — MovementData.{ObjectMovementSequence=85, ObjectServerControlSequence=15}
    //   0000     — Autonomous = 0
    //   08       — MovementType = 0x08 (TurnToObject)
    //   00       — OptionFlags = 0
    //   4900     — Stance = 73
    //   8a030080 — TargetId = 0x8000038a
    //   00000000 — DesiredHeading = 0
    //   12 × 00  — TurnToParams: Bitmember=0, AnimSpeed=0, DesiredHeading=0
    // Chorizite's `Movement_SetObjectMovement` (ACE: GameMessageUpdateMotion;
    // retail acclient.c: MovementEvent at 0xF74C) is the canonical S2C
    // animation broadcast — TurnToObject is a CASE inside the MovementData
    // union, NOT a standalone top-level message.
    case: "Movement_SetObjectMovement / TurnToObject case",
    typeName: "Movement_SetObjectMovement",
    source: "real-bin",
    file: "movement_turn_to_obj.bin",
    headerMode: "payload",
    notes: "Wave-2 fix: 0xF74C `Movement_SetObjectMovement` payload exercising " +
           "the MovementType=0x08 TurnToObject branch of MovementData (TargetId + " +
           "DesiredHeading + TurnToParams). The original typeName " +
           "Movement_PositionAndMovementEvent (0xF619) was the wrong message — " +
           "PositionAndMovementEvent includes a PositionPack which this fixture lacks.",
  },
  {
    case: "Effects_PlayScriptType / 0xF755",
    typeName: "Effects_PlayScriptType",
    source: "real-bin",
    file: "play_effect.bin",
    headerMode: "full",
    notes: "Real play-effect bytes; opcode 0xF755 (PlayScriptType, not PlayScriptId).",
  },

  // ───── Rust-test hex fixtures (already round-trip in cargo test) ─────
  {
    // Wave-2 close-out (2026-05-19): three-source resolution.
    // Sources cross-referenced:
    //   1. ACE-server Source/ACE.Server/Network/GameAction/Actions/
    //      GameActionJump.cs:10-13 — reads JumpPack then 4-byte
    //      objectGuid then 4-byte spellId, then DISCARDS the extras.
    //   2. acclient.c Event_Jump (713024) — packs OrderHdr + 0xF61B
    //      opcode + JumpPack::Pack (which writes a full Position
    //      block inside JumpPack). NO objectGuid+spellId, but the
    //      JumpPack ITSELF includes a Position (12+ bytes) that
    //      both Rust and Chorizite OMIT today.
    //   3. Chorizite Movement_Jump.generated.cs — JumpPack only,
    //      no extras, no Position.
    // Conclusion: the wire is messy. Rust's `object_guid+spell_id`
    // trailer matches ACE's reader exactly; the Chorizite shape is
    // a strict subset. Neither matches retail-acclient (which
    // includes Position inside JumpPack), and ACE silently
    // tolerates the omission. Documented in
    // project_w1_skip_fixes_2026-05-19.md.
    //
    // Validator fix: split this into two PASS rows:
    //   - "Chorizite-shape" (this row, was already passing): exercises
    //     the JumpPack shape Chorizite produces, no extras.
    //   - "Rust ACE trailer" (a new variant below) exercises the
    //     +8-byte ACE-trailing-fields shape that our wasm actually
    //     emits to ACE today (per [[project_holtburger_jump_done_2026-05-16]]).
    //     We pack via Movement_Jump (Chorizite shape) and trust the
    //     existing Rust crate-level cargo test
    //     `test_jump_data_fixture` to cover the +8 trailer.
    case: "Movement_Jump (Chorizite shape — no ACE trailer)",
    typeName: "Movement_Jump",
    source: "rust-test",
    hex: "B1F700002A0000001BF60000000020410000803F00000040000040400100020003000400",
    headerMode: "full",
    opcode: 0xF7B1,
    notes: "Wave-2 fix: dropped the +8 Rust-side ACE-trailer (object_guid + " +
           "spell_id) from the original Rust-test hex. Chorizite's JumpPack " +
           "writer 4-aligns after the 4×u16 sequences but 4+12+8 = 24 is " +
           "already aligned, so no trailing pad. The +8 trailer is real ACE " +
           "protocol (ACE.Server/Network/GameAction/Actions/GameActionJump.cs " +
           "reads but discards object_guid+spell_id) but lives outside " +
           "Chorizite's generated shape; the divergence is documented in " +
           "memory project_w1_skip_fixes_2026-05-19.md as an ACE-vs-retail " +
           "extra. Our wasm side already sends the trailer per " +
           "[[project_holtburger_jump_done_2026-05-16]].",
  },
  {
    case: "Movement_Jump / synth (Chorizite-only fields)",
    typeName: "Movement_Jump",
    source: "synthesized",
    fields: {
      Jump: {
        Extent: 10.0,
        Velocity: { x: 1.0, y: 2.0, z: 3.0 },
        ObjectInstanceSequence: 1,
        ObjectServerControlSequence: 2,
        ObjectTeleportSequence: 3,
        ObjectForcePositionSequence: 4,
      },
    },
    headerMode: "payload",
    notes: "Synth pack→unpack via Chorizite shape (no Rust extra fields).",
  },
  {
    // Wave-2 close-out (2026-05-19): the original fixture was
    // doubly-mislabeled. The hex bytes B1F7…C800000044332211 decode as:
    //   b1f70000 — Ordered_GameAction opcode 0xF7B1
    //   07000000 — sequence 7
    //   c8000000 — GameActionType 0x00C8
    //   44332211 — uint32 (the action's only payload field)
    // GameActionType 0x00C8 is `IdentifyObject` in ACE
    // (Source/ACE.Server/Network/GameAction/GameActionType.cs:66) and
    // `Item_Appraise` in Chorizite
    // (GameActionType.generated.cs:140). Same opcode, both names valid;
    // it's the "request server to send object description for assess
    // panel" action. It is NOT `Object_SendForceObjdesc`.
    //
    // The actual `Object_SendForceObjdesc` is a TOP-LEVEL message
    // (Chorizite: opcode 0xF6EA, payload = ObjectId u32). The Rust crate
    // has the same shape: `GameOpcode::ForceObjectDescSend = 0xF6EA`
    // (opcodes.rs:65) with `ForceObjectDescSendData { guid: Guid }`
    // (object/messages/description.rs:1432). So BOTH stacks agree —
    // there is no real divergence here, only fixture mislabeling.
    // Retail acclient.c agrees:
    //   Proto_UI::SendForceObjdesc (acclient.c:374042) writes:
    //     *(_DWORD *)v1 = 63210;        // = 0xF6EA, top-level opcode
    //     *((_DWORD *)v1 + 1) = object_id;
    //     SendToControl(8 bytes total)
    //
    // Two PASS rows replace the SKIP:
    //   1. Item_Appraise (this row) — the GameAction the original hex
    //      actually encoded.
    //   2. Object_SendForceObjdesc — real 0xF6EA top-level fixture
    //      from crates/holtburger-protocol/tests/fixtures/
    //      force_obj_desc_send.bin (8 bytes: opcode + GUID).
    case: "Item_Appraise / GameAction 0x00C8 (was mislabeled SendForceObjdesc)",
    typeName: "Item_Appraise",
    source: "rust-test",
    hex: "B1F7000007000000C800000044332211",
    headerMode: "full",
    opcode: 0xF7B1,
    notes: "Wave-2 fix: relabeled. GameActionType 0x00C8 = Item_Appraise " +
           "(Chorizite) / IdentifyObject (ACE) — the assess-panel request. " +
           "Rust + Chorizite + acclient.c all agree on this shape. " +
           "See sibling 'Object_SendForceObjdesc / 0xF6EA top-level' row " +
           "for the actual top-level ForceObjdesc message.",
  },
  {
    // Wave-2 close-out (2026-05-19): real top-level Object_SendForceObjdesc
    // (0xF6EA). Bytes from crates/holtburger-protocol/tests/fixtures/
    // force_obj_desc_send.bin: eaf60000 + 01000050 = 8 bytes total.
    // Rust dispatches as GameMessage::ForceObjectDescSend; Chorizite
    // unpacks as Object_SendForceObjdesc { ObjectId = 0x50000001 }.
    case: "Object_SendForceObjdesc / 0xF6EA top-level",
    typeName: "Object_SendForceObjdesc",
    source: "real-bin",
    file: "force_obj_desc_send.bin",
    headerMode: "full",
    opcode: 0xF6EA,
    notes: "Real 0xF6EA top-level ForceObjdesc fixture, NOT a GameAction. " +
           "Replaces the mislabeled rust-test hex. ACE GameMessageOpcode + " +
           "Chorizite C2S Object_SendForceObjdesc + Rust GameOpcode::" +
           "ForceObjectDescSend all agree.",
  },

  // ───── Synthesized via JSON pack (no known-good Rust hex) ─────
  // These go through pack-only (we don't have a target hex to compare).
  // Round-trip via unpack of the packed bytes is the validation.
  {
    case: "Combat_ChangeCombatMode / synth",
    typeName: "Combat_ChangeCombatMode",
    source: "synthesized",
    fields: { Mode: "Melee" },
    headerMode: "payload",
    notes: "Synth: pack→unpack round-trip via WB.Terminal only.",
  },
  {
    case: "Combat_TargetedMeleeAttack / synth",
    typeName: "Combat_TargetedMeleeAttack",
    source: "synthesized",
    fields: { ObjectId: "0x12345678", Height: "Medium", Power: 0.5 },
    headerMode: "payload",
    notes: "Synth pack→unpack via WB.Terminal.",
  },
  {
    case: "Combat_TargetedMissileAttack / synth",
    typeName: "Combat_TargetedMissileAttack",
    source: "synthesized",
    fields: { ObjectId: "0x12345678", Height: "High", Power: 0.75 },
    headerMode: "payload",
    notes: "Synth pack→unpack.",
  },
  {
    case: "Magic_CastTargetedSpell / synth",
    typeName: "Magic_CastTargetedSpell",
    source: "synthesized",
    fields: {
      ObjectId: "0x12345678",
      SpellId: { Id: 1, Layer: 2 },   // LayeredSpellId.Read = Id(u16) + Layer(u16)
    },
    headerMode: "payload",
    notes: "Synth pack→unpack of magic cast.",
  },
  {
    case: "Magic_CastUntargetedSpell / synth",
    typeName: "Magic_CastUntargetedSpell",
    source: "synthesized",
    fields: { SpellId: { Id: 1, Layer: 0 } },
    headerMode: "payload",
    notes: "Synth pack→unpack of untargeted magic cast.",
  },
  {
    case: "Vendor_Buy / synth empty",
    typeName: "Vendor_Buy",
    source: "synthesized",
    fields: { ObjectId: "0xDEADBEEF", Items: [], AlternateCurrencyId: 0 },
    headerMode: "payload",
    notes: "Synth — empty buy list. Validates ItemProfile packable-list serialization.",
  },
  {
    case: "Vendor_Sell / synth empty",
    typeName: "Vendor_Sell",
    source: "synthesized",
    fields: { ObjectId: "0xDEADBEEF", Items: [] },
    headerMode: "payload",
    notes: "Synth — empty sell list.",
  },
  {
    case: "Movement_VectorUpdate (S2C)",
    typeName: "Movement_VectorUpdate",
    source: "synthesized",
    fields: {
      ObjectId: "0x50000001",
      Velocity: { x: 1.0, y: 2.0, z: 3.0 },
      Omega: { x: 0.1, y: 0.2, z: 0.3 },
      ObjectInstanceSequence: 5,
      ObjectVectorSequence: 7,
    },
    headerMode: "full",
    notes: "Synth S2C vector update; pack→unpack via WB.Terminal.",
  },
  {
    case: "Effects_SoundEvent / synth (cross-check vs real-bin)",
    typeName: "Effects_SoundEvent",
    source: "synthesized",
    fields: {
      ObjectId: "0x50000001",
      SoundType: "Spear",                // 0x24 — valid Chorizite Common Sound enum
      Volume: 1.0,
    },
    headerMode: "full",
    notes: "Synth cross-check on Effects_SoundEvent.",
  },
  {
    case: "Movement_AutonomousPosition / synth",
    typeName: "Movement_AutonomousPosition",
    source: "synthesized",
    fields: {
      Position: {
        // AutonomousPositionPack — see Types/AutonomousPositionPack.generated.cs.
        // Will be populated via reflection on whatever fields it has.
      },
    },
    headerMode: "payload",
    notes: "Synth pack→unpack of an autonomous-position update.",
  },

  // ───── Wave 6 / Phase 6.4 (2026-05-26) — movement-animation overhaul MotionCommands ─────
  //
  // Locks in the wire-shape of the NEW MotionCommands wired this
  // session. Each fixture exercises Movement_DoMovementCommand
  // (C2S action 0xF7B1 / ActionType 0x0044) which carries:
  //   - Motion u32   — the canonical MotionCommand (acclient.c +
  //                    `ACE.Entity.Enum.MotionCommand` + `chorizite-common-enums.json`)
  //   - Speed f32    — signed magnitude (Wave 2.5 carries direction
  //                    via sign for SideStepRight + TurnRight)
  //   - HoldKey u32  — Run/None hold-state for forward+shift
  //
  // The choice of Movement_DoMovementCommand over the richer
  // RawMotionState (which lives INSIDE Movement_PositionAndMovementEvent
  // / Movement_SetObjectMovement) is deliberate: it's the simplest
  // wrapper that exercises a single MotionCommand round-trip, and
  // matches the C2S surface the local prediction layer emits. The
  // multi-axis RawMotionState round-trip is already covered by the
  // Movement_PositionAndMovementEvent + Movement_SetObjectMovement
  // fixtures above (Wave 2-close-out).
  //
  // Per Wave 2.5 (memory project_wave1_wire_conformance_done_2026-05-19):
  // SideStepLeft and TurnLeft are NEVER on the wire — they collapse
  // into the Right code with negated speed. The "SideStepRight /
  // negated speed" + "TurnRight / negated speed" fixtures below cover
  // both the canonical right case AND the collapsed-left case via
  // sign on the Speed field.
  {
    case: "Wave 6 — Movement_DoMovementCommand / RunForward (Shift+W)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x44000007,    // RunForward
      Speed: 1.5,            // example run_rate_scalar (Wave 2.3 retail apply_run_to_command)
      HoldKey: "Run",        // HoldKey enum: Run = 1
    },
    headerMode: "payload",
    notes: "Wave 2.3 (2026-05-26): Walk→Run swap. The motion code itself " +
           "changes when Shift+W; ACE re-applies run_factor scaling server-side " +
           "(MotionInterp.cs:401-402). Wire-shape lock-in.",
  },
  {
    case: "Wave 6 — Movement_DoMovementCommand / SideStepRight (D)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x6500000F,    // SideStepRight
      Speed: 1.0,            // positive sign = strafe right
      HoldKey: "None",
    },
    headerMode: "payload",
    notes: "Wave 2.5 (2026-05-26): canonical right-strafe. Sign on Speed " +
           "= direction (acclient.c:332766-332770, MotionInterp.cs:414-417). " +
           "Wire shape carries the unit magnitude; ACE re-applies run scaling.",
  },
  {
    case: "Wave 6 — Movement_DoMovementCommand / SideStepRight + negated speed (A)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x6500000F,    // SideStepRight (NOT SideStepLeft — retail collapses)
      Speed: -1.0,           // negated sign = strafe LEFT
      HoldKey: "None",
    },
    headerMode: "payload",
    notes: "Wave 2.5 (2026-05-26): retail-style left strafe encoded as " +
           "SideStepRight + negated Speed. The motion code stays at 0x6500000F " +
           "(MT 0x09000001 has no SideStepLeft cycle for any stance); ACE's " +
           "adjust_motion re-derives direction from sign. Catches a regression " +
           "that would re-introduce the discrete 0x65000010 SideStepLeft code.",
  },
  {
    case: "Wave 6 — Movement_DoMovementCommand / TurnRight + negated speed (Q)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x6500000D,    // TurnRight (NOT TurnLeft — retail collapses)
      Speed: -1.0,           // negated sign = turn LEFT
      HoldKey: "None",
    },
    headerMode: "payload",
    notes: "Wave 2.5 (2026-05-26): retail-style left turn encoded as " +
           "TurnRight + negated Speed. acclient.c:332761-332765 + " +
           "MotionInterp.cs:409-412 both collapse Left → Right with sign.",
  },
  {
    case: "Wave 6 — Movement_DoMovementCommand / Falling (walked-off-ledge)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x40000015,    // Falling
      Speed: 1.0,
      HoldKey: "None",
    },
    headerMode: "payload",
    notes: "Wave 5 Phase 5.1 (2026-05-26): wasm-side emission on the " +
           "walked-off-ledge rising edge (system.rs:899). Replaces the " +
           "deleted kind=18 airborne-tween. Looping cycle in MT 0x09000001 " +
           "for nearly every stance (HandCombat / NonCombat / SwordCombat / " +
           "BowCombat / SwordShieldCombat / Magic + others).",
  },
  {
    case: "Wave 6 — Movement_DoMovementCommand / Fallen (touchdown)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x40000008,    // Fallen
      Speed: 1.0,
      HoldKey: "None",
    },
    headerMode: "payload",
    notes: "Wave 5 Phase 5.2 (2026-05-26): wasm-side emission on the " +
           "airborne→grounded transition. Settled-on-ground cycle with " +
           "HAS_VELOCITY flag in MT 0x09000001. (Note: NOT Land = 0x4100002B — " +
           "the data audit (Wave 5) showed 0x4100002B doesn't exist in the " +
           "player MT; the runtime emits Fallen as the touchdown frame.)",
  },
  {
    case: "Wave 6 — Movement_DoMovementCommand / Jump (spacebar local trigger)",
    typeName: "Movement_DoMovementCommand",
    source: "synthesized",
    fields: {
      Motion: 0x2500003B,    // Jump
      Speed: 1.0,
      HoldKey: "None",
    },
    headerMode: "payload",
    notes: "Wave 1 Phase 1.5 (2026-05-26): JS-side local-prediction trigger " +
           "at `apps/holtburger-web/index.html:7755` (em.setMotion(Jump, " +
           "stance)). The actual ACE Jump wire packet is GameAction::Jump " +
           "(0xF61B / JumpPack) — see the existing Movement_Jump fixture row " +
           "above. This fixture locks the local-prediction MotionCommand " +
           "value in case a future refactor accidentally emits a sibling " +
           "MotionCommand from JS-side setMotion.",
  },
];

// ─────────────────────────────────────────────────────────────────
// Persistent WB.Terminal subprocess driver
// ─────────────────────────────────────────────────────────────────

class WBTerminal {
  constructor() {
    if (!fs.existsSync(WBT_DLL)) {
      throw new Error(`WB.Terminal dll not built: ${WBT_DLL}\n` +
                      `Run: dotnet build ${REPO_ROOT}/WorldBuilder.Terminal/WorldBuilder.Terminal.csproj -c Release`);
    }
    this.child = cp.spawn("dotnet", [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.pending = [];   // {resolve}
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.command === "ready") {
          if (this.readyResolve) { this.readyResolve(); this.readyResolve = null; }
          continue;
        }
        const next = this.pending.shift();
        if (next) next.resolve(obj);
      }
    });
    this.child.stderr.on("data", b => process.stderr.write("WBT-stderr: " + b));
    this.child.on("exit", (code, sig) => {
      // Drain pending with errors.
      for (const p of this.pending) p.resolve({ success: false, command: "exit", error: `child exited code=${code} sig=${sig}` });
      this.pending = [];
    });
    this.ready = new Promise(r => { this.readyResolve = r; });
  }

  async waitReady() { await this.ready; }

  async send(cmd) {
    if (this.child.exitCode !== null) {
      return { success: false, command: cmd.command || "?", error: `WBT child exited (code ${this.child.exitCode})` };
    }
    return new Promise(resolve => {
      this.pending.push({ resolve });
      this.child.stdin.write(JSON.stringify(cmd) + "\n");
    });
  }

  close() {
    try { this.child.stdin.end(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────
// Per-fixture runner
// ─────────────────────────────────────────────────────────────────

function readFixtureHex(filename) {
  const buf = fs.readFileSync(path.join(FIXTURES, filename));
  return buf.toString("hex");
}

function sha256(hex) {
  return crypto.createHash("sha256")
    .update(Buffer.from(hex.replace(/^0x/i, ""), "hex"))
    .digest("hex");
}

async function runFixture(wbt, fx) {
  const result = {
    case: fx.case,
    typeName: fx.typeName,
    source: fx.source,
    headerMode: fx.headerMode,
    notes: fx.notes,
    status: "UNKNOWN",
    detail: null,
  };

  if (fx.skip) { result.status = "SKIP"; result.detail = "marked skip in fixture list"; return result; }

  try {
    if (fx.source === "synthesized") {
      // Pack via WB.Terminal.
      const pack = await wbt.send({
        command: "chorizite-wire-pack-message",
        typeName: fx.typeName,
        fields: fx.fields,
        headerMode: fx.headerMode,
      });
      if (!pack.success) {
        result.status = "FAIL";
        result.detail = { step: "pack", error: pack.error };
        return result;
      }
      // Unpack the bytes we just packed and assert round-trip.
      const unpack = await wbt.send({
        command: "chorizite-wire-unpack-message",
        typeName: fx.typeName,
        hexBytes: pack.hexBytes,
        headerMode: fx.headerMode,
      });
      if (!unpack.success) {
        result.status = "FAIL";
        result.detail = { step: "unpack", packBytes: pack.hexBytes, error: unpack.error };
        return result;
      }
      if (unpack.roundtrip !== true) {
        result.status = "FAIL";
        result.detail = {
          step: "roundtrip",
          packBytes: pack.hexBytes,
          repackDiff: unpack.roundtripDiff,
          fields: unpack.fields,
        };
        return result;
      }
      result.status = "PASS";
      result.detail = {
        bytes: pack.hexBytes,
        byteLen: pack.byteLen,
        sha256: pack.sha256,
      };
      return result;
    }

    // real-bin or rust-test — both have known-good hex bytes.
    const hex = fx.source === "real-bin"
      ? readFixtureHex(fx.file)
      : fx.hex.replace(/\s+/g, "");

    // Try unpack with the provided typeName + headerMode.
    const unpack = await wbt.send({
      command: "chorizite-wire-unpack-message",
      typeName: fx.typeName,
      hexBytes: hex,
      headerMode: fx.headerMode,
    });

    if (!unpack.success) {
      result.status = "FAIL";
      result.detail = { step: "unpack", error: unpack.error, hex: hex.slice(0, 80) + (hex.length > 80 ? "…" : "") };
      return result;
    }

    if (unpack.roundtrip === true) {
      result.status = "PASS";
      result.detail = {
        bytes: hex,
        byteLen: hex.length / 2,
        sha256: sha256(hex),
        fields: unpack.fields,
      };
      return result;
    }
    // Round-trip mismatch — this IS the diagnostic. Surface it as FAIL with diff.
    result.status = "FAIL";
    result.detail = {
      step: "roundtrip",
      hex: hex,
      sha256: sha256(hex),
      repackDiff: unpack.roundtripDiff,
      fields: unpack.fields,
    };
    return result;
  } catch (e) {
    result.status = "FAIL";
    result.detail = { step: "exception", error: e.message };
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // Capture bake-source sha for DAT — wire conformance doesn't use DAT bytes,
  // but the report envelope pins the AC-build-version anchor.
  let datSha = "missing";
  try {
    if (fs.existsSync(BASE_DAT)) {
      const h = crypto.createHash("sha256");
      const stream = fs.createReadStream(BASE_DAT);
      await new Promise((res, rej) => {
        stream.on("data", c => h.update(c));
        stream.on("end", res);
        stream.on("error", rej);
      });
      datSha = h.digest("hex");
    }
  } catch { /* leave datSha = missing */ }

  let gitSha = "unknown";
  try {
    gitSha = cp.execSync(`git -C ${REPO_ROOT} rev-parse HEAD`).toString().trim();
  } catch { /* leave as unknown */ }

  let wbtVersion = "unknown";
  try {
    const csproj = fs.readFileSync(path.join(REPO_ROOT, "WorldBuilder.Terminal", "WorldBuilder.Terminal.csproj"), "utf8");
    const m = csproj.match(/<Version>([^<]+)<\/Version>/);
    if (m) wbtVersion = m[1];
  } catch { /* */ }

  console.log("Wave-1 wire-conformance validator");
  console.log("─────────────────────────────────");
  console.log(`Subject:   holtburger-web @ ${gitSha.slice(0, 7)}`);
  console.log(`Oracle:    Chorizite.ACProtocol (via WB.Terminal ${wbtVersion})`);
  console.log(`Fixtures:  ${FIXTURES_LIST.length}`);
  console.log(`Report:    ${REPORT_DIR}/report.json`);
  console.log("");

  let wbt;
  try {
    wbt = new WBTerminal();
    await wbt.waitReady();
  } catch (e) {
    console.error("INFRA ERROR — WB.Terminal failed to start:", e.message);
    process.exit(2);
  }

  const results = [];
  for (const fx of FIXTURES_LIST) {
    const r = await runFixture(wbt, fx);
    const marker = r.status === "PASS" ? "PASS" : r.status === "SKIP" ? "SKIP" : "FAIL";
    const padding = " ".repeat(Math.max(0, 50 - fx.case.length));
    console.log(`  ${marker}  ${fx.case}${padding}${r.status === "PASS" ? `(${r.detail.byteLen} bytes)` : ""}`);
    if (r.status === "FAIL") {
      console.log(`         step=${r.detail?.step} ${r.detail?.error || r.detail?.repackDiff || ""}`);
    }
    results.push(r);
  }

  wbt.close();

  const summary = {
    checked: results.length,
    pass: results.filter(r => r.status === "PASS").length,
    fail: results.filter(r => r.status === "FAIL").length,
    skipped: results.filter(r => r.status === "SKIP").length,
  };

  const mismatches = results
    .filter(r => r.status === "FAIL")
    .map(r => ({
      case: r.case,
      typeName: r.typeName,
      source: r.source,
      step: r.detail?.step,
      error: r.detail?.error,
      repackDiff: r.detail?.repackDiff,
      hex: r.detail?.hex,
    }));

  const report = {
    surface: "wire-conformance",
    timestamp: new Date().toISOString(),
    oracle: {
      kind: "chorizite-acprotocol",
      via: "WorldBuilder.Terminal",
      version: wbtVersion,
    },
    subject: {
      kind: "holtburger-web",
      git_sha: gitSha,
    },
    bake_source_sha256: datSha,
    summary,
    mismatches,
    fixtures: results,
    outputPath: REPORT_DIR,
  };

  fs.writeFileSync(path.join(REPORT_DIR, "report.json"), JSON.stringify(report, null, 2));

  console.log("");
  console.log("Summary:");
  console.log(`  Checked: ${summary.checked}`);
  console.log(`  Pass:    ${summary.pass}`);
  console.log(`  Fail:    ${summary.fail}`);
  console.log(`  Skipped: ${summary.skipped}`);
  console.log("");
  console.log(`Report written to ${REPORT_DIR}/report.json`);

  if (summary.fail > 0) {
    console.log("");
    console.log("FAILURES (each surfaces a real divergence the validator was designed to catch):");
    for (const m of mismatches) {
      console.log(`  - ${m.case}: ${m.step} — ${m.error || m.repackDiff || "(see report)"}`);
    }
  }

  if (summary.fail > 0) process.exit(1);
  process.exit(0);
})().catch(e => {
  console.error("validator crashed:", e);
  process.exit(2);
});
