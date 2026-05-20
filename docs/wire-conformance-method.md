# Wire-Conformance Method (pack/unpack parity)

Companion to [`world-completeness-method.md`](world-completeness-method.md) (placements),
[`event-completeness-method.md`](event-completeness-method.md) (sounds + particles), and
[`entity-completeness-method.md`](entity-completeness-method.md) (typed classification).
This doc covers the fourth axis: **wire-packet pack/unpack parity** — answering "do the
bytes our wasm session emits and consumes round-trip byte-identical against the
Chorizite.ACProtocol canonical pack/unpack?"

Status: **shipped 2026-05-19** as Wave 1 of the
[diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md). One brick gating five.

If this method's contract or scope looks wrong — especially the **headerMode contract** or
the **divergence-flag-don't-fudge discipline** — flag it before Wave 2 starts.

## The contract

For any wire-packet payload `p`:

```
chorizite_pack(typeName, fields_of(p)) ≡ holtburger_pack(typeName, fields_of(p))
chorizite_unpack(bytes_of(p)).fields  ≡ holtburger_unpack(bytes_of(p)).fields
```

Both directions: byte-identical output for byte-identical input. Determinism: same
JSON fields → same bytes → same JSON fields. **No tolerance** for length mismatch
or single-byte diffs in the comparison: a passing case must produce a SHA-256
match against the canonical bytes.

Where they don't match, the validator **flags the divergence**. We do not
modify Chorizite to match holtburger-protocol (it's the oracle), nor silently
adapt the test to make it pass. The whole point is to surface mismatches with
provenance: which side has which fields, where does the divergence start,
and what wire-trace evidence settles which is correct.

## Why this method exists

The browser AC client (`external/holtburger/apps/holtburger-web`) emits and
consumes packets through a Rust crate (`holtburger-protocol`) that ports
acclient.exe's wire layer. We have no in-tree mechanism to detect when the
Rust port has silently diverged from the canonical wire format —
[`feedback_dat_parser_mislabels`] caught four such drifts in our DAT readers
on 2026-05-19, where DRW schema labels and acclient.c widths disagreed and
the parsers carried the bug for months.

The wire layer is even more load-bearing than the DAT layer (every player
action touches it on every tick) and even more prone to silent drift
(opcode dispatch keeps working when one byte goes wrong; the symptom is
a desync three seconds later, not a parse error). Per
[`feedback_ground_in_real_wire_data`], we need **captured wire bytes +
canonical decode** to validate.

Wave 1's job is to provide that capability and shake out the divergences
that exist today. Wave 1 does NOT fix them — fixes land in Wave 2+ once
we know which side is wrong.

## The four sources

Per [`feedback_three_source_cross_reference`], in oracle precedence order:

1. **ACE server source** — `~/ace-server/Source/ACE.Server/Network/GameMessages/*.cs`
   for what an authoritative server emits today. **Not exercised in Wave 1**
   (would need a live capture loop). Wave 3 brings this in via live ACE on
   `100.116.47.66:9000`.

2. **Retail decomp** — `~/ac-headers/acclient.c` for what the retail client
   parsed (the binary's actual behavior). Used as the dispute resolver
   when Chorizite and holtburger-protocol disagree about a field's width
   or order.

3. **Chorizite C# stack** — `external/chorizite/Chorizite.ACProtocol/`
   (368 generated message types, source-generator-driven from
   `protocol.xml`). **This is the Wave-1 oracle.** Vendored as a
   ProjectReference per the spike outcome on 2026-05-19 — see
   [`reference_chorizite_acprotocol_dep_graph_2026-05-19`].

4. **holtburger-protocol Rust crate** — the subject under test. Its
   cargo-tested hex fixtures (`crates/holtburger-protocol/src/messages/**/*.rs`)
   are the cross-check baseline alongside the real `.bin` fixtures in
   `crates/holtburger-protocol/tests/fixtures/`.

## The headerMode contract

The Chorizite-style `Write(BinaryWriter)` on a top-level message subclass
emits **only the body**. The opcode header (`uint32 LE`) is read by
`S2CMessageHandler.ProcessS2CMessage(BinaryReader)` BEFORE dispatch — the
subclass's Read inherits a BinaryReader positioned past the opcode.

For game actions and game events, an extra envelope wraps the payload:

- `Ordered_GameAction` (`0xF7B1`) prefixes `sequence(u32) + actionType(u32)`
  before each action subclass body.
- `Ordered_GameEvent` (`0xF7B0`) prefixes `objectId(u32) + sequence(u32) +
  eventType(u32)` before each event subclass body.

The Rust `holtburger-protocol::messages::game_action::GameActionMessage::pack`
emits `sequence(u32) + actionType(u32) + payload` — that is, no outer opcode.

The validator therefore supports two header modes:

- **`headerMode: "full"`** — emit / consume the full Chorizite-side bytes
  (opcode + action/event envelope + payload). Use when comparing against
  raw `.bin` fixtures captured from a real session.
- **`headerMode: "payload"`** — emit / consume only the body (and game-action
  payload, no outer opcode). Use when comparing against `holtburger-protocol`
  packed bytes.

For non-action / non-event top-level messages (e.g.
`Effects_SoundEvent`, `Qualities_PrivateUpdatePosition`), `"full"` means
opcode + body; `"payload"` means just the body.

## The commands

Three new commands in `WorldBuilder.Terminal`, partial
`CommandEngine.WireConformance.cs`:

### `chorizite-wire-pack-message`

```jsonc
{
  "command": "chorizite-wire-pack-message",
  "typeName": "Combat_TargetedMeleeAttack",
  "fields": { "ObjectId": "0x12345678", "Height": "Medium", "Power": 0.5 },
  "headerMode": "payload"                  // optional: "payload" (default) | "full"
}
```

→ `{ messageType, fullName, headerMode, opCode, hexBytes, byteLen, sha256 }`.

`fields` is a recursive JSON object that maps to the public fields of the
resolved Chorizite type. Enums accept symbolic names ("Medium") or hex
strings ("0x01") or integers. Numeric types accept "0x…" hex strings or
numeric literals. `Vector3` accepts `{ x, y, z }`. Nested `IACDataType`
classes recurse.

### `chorizite-wire-unpack-message`

```jsonc
{
  "command": "chorizite-wire-unpack-message",
  "hexBytes": "78563412020000000000003f",
  "typeName": "Combat_TargetedMeleeAttack",   // optional in "full" mode
  "headerMode": "payload"                      // default: "payload"
}
```

→ `{ messageType, fullName, headerMode, fields, roundtrip, roundtripDiff }`.

Auto-roundtrips: re-packs and reports `roundtrip:true` if the bytes
match; otherwise emits `roundtripDiff: "len-orig=N len-repack=M
firstDiff@HEX"`.

### `chorizite-wire-list-message-types`

```jsonc
{ "command": "chorizite-wire-list-message-types" }
```

→ `{ count, types: [{ typeName, fullName, direction, opCode }, ...] }`.

Discoverability helper — confirms a typeName is resolvable before
authoring a fixture. As of 2026-05-19 reports 349 concrete message types.

## The validator

`apps/holtburger-web/validate_wire_conformance.cjs`. Pure-function pattern
matching `validate_entity_classification.cjs` (no Playwright); spawns a
single persistent `dotnet WorldBuilder.Terminal.dll --stdin` subprocess
and pipes fixture commands through it.

Fixture set (23 entries):

- **10 real `.bin` fixtures** from
  `crates/holtburger-protocol/tests/fixtures/` — actual bytes from
  cargo-tested round-trips of the Rust crate. These are the load-bearing
  cross-port checks.
- **2 Rust-test hex fixtures** — inline hex strings from
  `holtburger-protocol/src/messages/**/*.rs` `#[test]` blocks; chosen
  to exercise specific Rust-side struct shapes (e.g. `JumpActionData`
  with its extra `object_guid + spell_id` fields).
- **11 synthesized fixtures** — JSON inputs that go through `pack` →
  `unpack` → byte equality. Validates the round-trip path for shapes
  we don't have real captures for yet.

Each fixture reports `PASS | FAIL | SKIP` with provenance. Result envelope
matches the §4.4 shape of the diagnostic-toolset plan.

## Phase plan

| Phase | Status | Description |
|---|---|---|
| **W1.A0 — ProjectReference spike** | SHIPPED 2026-05-19 | 30-min spike; ACProtocol added cleanly (+1 MB, no RmlUi/Lua/Autofac). See memory [[reference_chorizite_acprotocol_dep_graph_2026-05-19]]. |
| **W1.A — Land the chosen path** | SHIPPED | ProjectReference path; reflection-based pack/unpack via Chorizite's source-generated `Read/Write(BinaryReader/Writer)`. |
| **W1.B — `chorizite-wire-pack-message`** | SHIPPED | `CommandEngine.WireConformance.cs:ChoriziteWirePackMessage`. Auto-infers `ActionType` / `EventType` from subclass name. Normalize-stream handles Chorizite's `Seek`-based align-pad bug. |
| **W1.C — `chorizite-wire-unpack-message`** | SHIPPED | `CommandEngine.WireConformance.cs:ChoriziteWireUnpackMessage`. Save-restore action/event header to survive the subclass's `base.Read` overwrite. |
| **W1.D — `validate_wire_conformance.cjs`** | SHIPPED | 23 fixtures: 19 PASS, 0 FAIL, 4 SKIP (all documented Wave-2 follow-ons). |
| **W1.E — Method doc** | SHIPPED (this doc). | |

## Scope limits

What this method explicitly does NOT cover:

- **Server-authoritative state** — what ACE picks for action sequence numbers,
  combat damage roll, etc. The validator checks bytes for a given
  (typeName, fields) — it does not assert which fields ACE would emit.
- **Network jitter / packet loss** — wire-conformance is payload correctness
  only. Transport-layer (fragmentation, retransmit, checksums) is orthogonal
  and untested here.
- **Live capture fixtures from `100.116.47.66:9000`** — Wave 1 uses only
  baked `.bin` and Rust-side hex. Live captures land via Wave 3 physics-replay
  infrastructure.
- **Encrypted / compressed wire** — Chorizite operates on already-decrypted
  bytes (post-XOR, post-PacketReader). Same here. Encryption gates are
  Wave 5 if at all.
- **Auto-fix on mismatch** — a mismatched fixture is a Wave-2+ investigation
  item, never a "let's adapt the test" item.

## The 4 SKIPs (Wave-2 follow-ons)

Documented divergences flagged by the W1.D run (`validate_wire_conformance.cjs`
output 2026-05-19):

1. **`Ordered_GameEvent (PublicUpdateInt wrapper)`** — `update_property_int.bin`
   starts with the `0xF7B0` Ordered_GameEvent wrapper opcode. Our validator
   currently dispatches by `typeName` and the wrapped GameEventType subtype
   inside; reaching the inner type requires opcode-driven dispatch through
   Chorizite's `S2CMessageHandler.ProcessS2CMessage`. Add this in Wave 2
   alongside the DAT-parity work, where dispatch infrastructure is more
   developed.

2. **`Movement_TurnTo` (headerless fragment)** — `movement_turn_to_obj.bin`
   has no opcode prefix; the first 4 bytes are an `ObjectGuid`, meaning
   the fixture was captured AFTER the dispatcher consumed the opcode.
   Chorizite has no top-level `Movement_TurnToObject` matching the
   Rust side. Wave-2 follow-on: reconcile the naming (Chorizite calls
   the closest equivalent `Movement_PositionAndMovementEvent`).

3. **`Movement_Jump rust-fixture (extra-fields divergence)`** — The Rust
   `JumpActionData` has additional `object_guid (4 B) + spell_id (4 B)`
   fields appended after the 4×u16 sequences. Chorizite's `JumpPack`
   stops there + adds 4-byte align-pad. Rust is +8 bytes longer than
   Chorizite. Wave-2 follow-on: read `acclient.c::CMotionInterp::get_jump_v_z`
   (per the
   [diagnostic plan](diagnostic-toolset-plan-2026-05-19.md) §6 Wave 3.B
   target) and determine which side is correct — likely Chorizite,
   because its source-generator targets the original protocol.xml.

4. **`Object_SendForceObjdesc (Chorizite vs Rust divergence)`** — Rust
   packs `Object_SendForceObjdesc` as an `Ordered_GameAction (0xF7B1)` +
   GameActionType 0xC8. Chorizite has `Object_SendForceObjdesc` as a
   top-level C2S message with opcode `0xF6EA` — NOT a GameAction.
   Both can coexist on the wire (different opcodes), so the question
   becomes which one acclient.exe actually uses. Wave-2 follow-on.

## Provenance

- **Code:**
  - `WorldBuilder.Terminal/CommandEngine.WireConformance.cs` (engine partial).
  - `WorldBuilder.Terminal/JsonCommandProcessor.cs` (dispatch entries near line 304).
  - `WorldBuilder.Terminal/WorldBuilder.Terminal.csproj` (ProjectReference on `Chorizite.ACProtocol.csproj`).
  - `external/holtburger/apps/holtburger-web/validate_wire_conformance.cjs`.
- **Build clean:** `dotnet build WorldBuilder.Terminal/WorldBuilder.Terminal.csproj -c Release` PASS,
  bin size delta from baseline +1 MB (118 → 119 MB).
- **First validator run:** 2026-05-19, 19/23 PASS, 0 FAIL, 4 SKIP-w-reason.
  Report at `/mnt/wbterminal1/holtburger-validator-reports/wire-conformance/<ts>/report.json`.
- **Memory cross-refs:**
  - [[reference_chorizite_acprotocol_dep_graph_2026-05-19]] — spike outcome.
  - [[project_chorizite_porting_plan_2026-05-19]] — §12.4 marked complete.
  - [[reference_worldbuilder_terminal]] — new commands listed.

## Open follow-ons (Wave-2 hooks)

Per the
[diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md) §6 Wave 2 + §7:

- **Drive a live ACE session** via the Phase-K.1 wasm bundle, capture
  wire frames into the validator's report dir, run the validator against
  those captures. Wave 3's `physics-replay-trace` infrastructure produces
  the needed capture mechanism; piggy-back on it.
- **Resolve the 4 SKIPs above** through the three-source cross-reference
  (ACE + acclient.c + Chorizite). Each is a discrete unit of work.
- **Add a GameEvent dispatch helper** (`chorizite-wire-unpack-wrapped-event`)
  that peeks the inner GameEventType and dispatches to the correct
  subclass. Unblocks the `Ordered_GameEvent` SKIP.
- **Cross-port harness:** spawn the Rust crate's pack functions via a
  small `cargo run --release` driver (or wasm export from the existing
  `holtburger-web` build) and compare bytes side-by-side instead of
  relying on hand-curated hex test fixtures. This is the W1.D follow-on
  that closes the "Rust vs Chorizite" loop for every synth fixture.
