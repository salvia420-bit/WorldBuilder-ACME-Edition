# A13 wire-state-packs — unification survey

Date: 2026-06-11 · Agent: A13 · Scope: JumpPack / MoveToStatePack / AutonomousPositionPack /
TurnToEventPack, the instance/server_control/teleport/force_position timestamp quartet, and the
`ACCmdInterp::Send*Event` boundary, vs our pack codecs and send/receive sites.

Seam notes: A3/DESIGN.md Stage 3 owns MoveToManager *semantics* (when packs fire); A13 owns the
pack **codecs**, the **timestamp quartet plumbing**, and the **send boundary**. A14 owns the
input side that feeds RawMotionState.

## 1. Retail map

Pack classes (struct layouts, acclient.h):

| pack | layout | cite |
|---|---|---|
| MoveToStatePack | RawMotionState + Position + contact + longjump_mode + 4×u16 quartet | acclient.h:45663-45674 |
| AutonomousPositionPack | Position + contact + 4×u16 quartet | acclient.h:45676-45684 |
| TurnToEventPack | `{ float absolute_degrees; int run; }` | acclient.h:45687-45691 |
| JumpPack | extent + Vector3 velocity + **Position** + 4×u16 quartet | acclient.h:54020-54029 |

Pack/UnPack bodies (all write the quartet as 4 consecutive u16 then ALIGN_PTR(4)):
- `MoveToStatePack::Pack` acclient.c:323814-323851 (raw_motion_state, position, quartet, then a
  single byte `contact|longjump<<1` at :323845, pad). `UnPack` :323854-323901 splits the byte back
  into `contact = b & 1`, `longjump_mode = b & 2` (:323888-323890).
- `AutonomousPositionPack::Pack` acclient.c:323934-323978 (position, quartet, contact byte, pad);
  `UnPack` :323981-324035.
- `JumpPack::Pack` acclient.c:324068-324126 — order: extent (:324104), velocity x/y/z
  (:324108-324115), **Position block** (:324117), quartet (:324118-324124), pad. `UnPack`
  :324128-324195.
- `PhysicsTimestampPack` (2×u16) acclient.c:516EF0/:324200-324246 — the S2C timestamp sibling.

Quartet single source: both C2S position packs are constructed from the SAME
`CPhysicsObj::update_times[]` slots —
- `CommandInterpreter::SendMovementEvent` acclient.c:718141-718196: reads
  `update_times[4]/[5]/[6]/[8]` (:718175-718178) plus `minterp->standing_longjump` (:718180) and
  `transient_state & 1 && & 2` for contact (:718182-718183), constructs MoveToStatePack
  (:718187), dispatches via `vfptr[20]` (the Send*Event callback, :718188), stamps
  `last_sent_position_time` (:718190-718191).
- `CommandInterpreter::SendPositionEvent` acclient.c:718201-718250: same `update_times` slots
  (:718225-718228), constructs AutonomousPositionPack (:718239), dispatches (:718240), records
  `last_sent_position` + `last_sent_contact_plane` (:718244-718245).
- Send gate `CommandInterpreter::ShouldSendPositionEvent` acclient.c:718107-718139 requires
  `autonomy_level == 2` (:718117) before any position event fires.

Send boundary (one funnel): `ACCmdInterp::SendMoveToStateEvent` acclient.c:435899-435901,
`SendAutonomousPositionEvent` :435905-435907, `SendTurnToEvent` :435911-435913 — thin shims to
`CM_Movement::Event_*`, each of which packs `OrderHdr { stamp = Proto_UI::GetNextUICounter() }` +
a 4-byte opcode + the pack body, then `Proto_UI::SendToWeenie`:
- `Event_MoveToState` opcode **63004 = 0xF61C** (acclient.c:713128 area, opcode write at the
  `*(_DWORD *)buf = 63004` line in the 712832-block listing).
- `Event_Jump` opcode **63003 = 0xF61B** (same block, `= 63003`).
- `Event_AutonomousPosition` opcode **63315 = 0xF753** (acclient.c:712832-712864, `= 63315`).
- `Event_AutonomyLevel` opcode **63314 = 0xF752** (:712866+, `= 63314`).
- `Event_TurnToEvent` opcode **63049 = 0xF649** (acclient.c:713221-713249, `= 63049` at :713238).
- `Event_DoMovementCommand` 63006 = 0xF61E, `Event_StopMovementCommand` 63073 = 0xF661
  (same listing — A14's seam, noted for completeness).

Jump construction: `ClientCombatSystem::DoJump` acclient.c:408141-408196 — extent from charge,
`CPhysicsObj::get_local_physics_velocity` (:408181), JumpPack ctor with `update_times` quartet,
`CM_Movement::Event_Jump(&jp)` at :408193.

## 2. Ours map

Rust (canonical, shared by cli and wasm):
- **Codecs** — `crates/holtburger-protocol/src/messages/movement/actions.rs`:
  MoveToStateActionData pack/unpack :20-70; JumpActionData :84-139;
  AutonomousPositionActionData :151-189; AutonomyLevelActionData :196-211. Opcode registry
  `crates/holtburger-protocol/src/opcodes.rs`: MoveToState=0xF61C :509, Jump=0xF61B :511,
  AutonomousPosition=0xF753 :513, AutonomyLevel=0xF752 :518; `TurnTo = 0xF649` **commented out**
  :96; DoMovementCommand/StopMovementCommand commented out :688/:690. GameAction wrapper
  pack/unpack `messages/game_action.rs`:146-162 (decode), :452-481 (encode).
- **Second (generated) codec** — `crates/holtburger-protocol/src/lib.rs:40` `pub mod generated`
  (Chorizite protocol.xml codegen) emits its own `JumpPack` / `Action_Movement_AutonomyLevel`
  etc.; exercised only by tests (`crates/holtburger-protocol/tests/generated_parity.rs:189-201`)
  and the JS validator (`apps/holtburger-web/validate_wire_conformance.cjs:218-262`). Not used at
  runtime.
- **Send boundary** — single funnel `Session::send_action`
  `crates/holtburger-session/src/session/send.rs:321-329`: increments `game_action_sequence`
  (retail's `Proto_UI::GetNextUICounter` OrderHdr stamp) and wraps in `GameActionMessage`.
- **Outbound builders** — `crates/holtburger-core/src/client/movement/system.rs`:
  `send_motion_state_pulse` :3311-3338, `send_transient_motion_pulse` :3341-3357,
  `send_stop_pulse` :3359-3381 (three inline MoveToStateActionData constructions, quartet read
  from `world.player.*` each time); AutonomousPosition builder
  `crates/holtburger-core/src/client/movement/common.rs:152-168`
  (`build_autonomous_position`, quartet from `world.player.*`), contact/longjump byte encoders
  :131-142; heartbeat gate (retail ShouldSendPositionEvent port, cites :718107-718141 in its doc)
  `system.rs:3123-3186`; two AutonomousPosition send sites `system.rs:3262-3267` (heartbeat) and
  :3288-3296 (explicit flush).
- **Quartet receive-side (cli path)** — `crates/holtburger-world/src/player/mutations.rs`:
  `update_position_from_server` :190-220 (writes all 4 + emits ForcedReposition on
  `is_newer_u16`), `set_teleport_sequence` :360-362, `record_vector_update_sequences` :356-358,
  `should_accept_server_controlled_motion` :283-289, `apply_self_update_motion` :293-304;
  dispatched from `crates/holtburger-world/src/handlers/player.rs:33-114` (UpdatePosition,
  VectorUpdate, UpdateMotion, PlayerTeleport arms). The movement system's own sequence records:
  `crates/holtburger-core/src/client/messages.rs:57-99` consumes
  `WorldEvent::SelfServerControlledMotion` / `SelfUpdatePosition` / `SelfAutonomousPosition` →
  `movement.record_server_control_sequence` / `record_force_position_sequence` /
  `record_autonomous_position_sequences` (`system.rs:2902-2924`).
- cli app: drives `ClientRuntime` (`apps/holtburger-cli/src/bin/tui.rs:16,553`) — no pack code of
  its own. cli TurnTo is local-only: `apps/holtburger-cli/src/pages/game/combat.rs:971-975`
  (`SnapHeading`), no wire TurnToEvent. wsbridge is transport-only
  (`apps/holtburger-wsbridge/src/frame.rs:5-15`).

wasm (`apps/holtburger-web/src/lib.rs` — the known dual-site):
- Outbound MoveToState/AutonomousPosition: unified onto the same core
  `MovementSystemHandle` (`SetMovementInput` arm :38485-38524 → `TickMovement` :38526+) — the
  pre-3.6 hand-built MoveToState path is gone.
- Outbound **Jump is wasm-only**: built inline in the recv loop :38292-38483
  (`JumpActionData` construction :38460-38470, quartet read from `w.player.*` :38433-38437).
  The cli has no jump at all (grep `GameAction::Jump` in crates/apps: only doc comments).
- Receive-side quartet is **hand-mirrored, not routed**: `should_route_message_to_world`
  :21933-22018 routes only 27 stat/property/effect messages — UpdatePosition, UpdateMotion,
  VectorUpdate, PlayerTeleport are NOT routed to `holtburger_world::handlers`. Instead:
  - UpdatePosition arm :31722-31963 writes `local_player.{instance,teleport,force_position}_
    sequence` :31736-31740 AND `w.player.{instance,teleport,force_position}_sequence`
    :31948-31954 ("Mirror the four sequences" comment — only three are mirrored).
  - PlayerTeleport arm :31468-31476 hand-mirrors `set_teleport_sequence` + suspend
    (doc :31420-31466 admits it mirrors `handlers/player.rs:71-78`).
  - `server_control_sequence` is **never advanced** in wasm — `LocalPlayerSnapshot` doc
    :28786-28791: "initialise it to 0 and let it ride"; the UpdateMotion arm :33341+ contains no
    `apply_self_update_motion` / `record_server_control_sequence` call (grep over lib.rs: zero
    `WorldEvent::Self*` handling, zero `record_server_control_sequence`).
  - F2-3 LoginComplete-defer duplicated: core `messages.rs:74-87` AND wasm :31490-31510 +
    :31741-31763.
  - `LocalPlayerSnapshot` quartet copy is write-only (writes :31736-31740, :32021, :32151; no
    reads) — dead third copy.

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | TurnToEvent (0xF649) never sent; codec absent. Retail sends absolute_degrees+run on autonomous turn-to | acclient.h:45687-45691; acclient.c:713221-713249 (`= 63049`), 435911 | opcodes.rs:96 (commented out); cli local-only SnapHeading combat.rs:971-975 | MISSING | server never told the client is executing a turn-to; ACE infers heading from AutonomousPosition only — heading-sensitive server logic (attack arcs) can lag | untracked |
| 2 | JumpPack wire shape: retail embeds Position; ours omits it and appends object_guid+spell_id (ACE-reader shape) | acclient.c:324068-324126 (Position written between velocity and quartet) | actions.rs:122-138; validate_wire_conformance.cjs:218-262 (three-source resolution) | DIFF-ALGO (ACE-sanctioned) | none vs ACE (reads+discards trailer, tolerates missing Position); would break vs retail server | project_w1_skip_fixes_2026-05-19 memo (cjs:237-243) |
| 3 | Quartet receive: cli routes through one canonical mutator (`update_position_from_server`, `is_newer_u16` gating, events); wasm hand-mirrors 3 of 4 sequences in its own recv arms | retail single owner `CPhysicsObj::update_times[4/5/6/8]` read by both pack ctors, acclient.c:718175-718187, :718225-718239 | mutations.rs:190-220 + handlers/player.rs:33-114 (cli) vs lib.rs:31736-31740, :31948-31954, :31468-31476 (wasm) | SPLIT-BRAIN (3 wasm sites + unused canonical path) | wasm-only sequence-handling fixes don't reach cli and vice versa; PlayerTeleport mirror bug (lib.rs:31420-31466) was exactly this class | F2-3 sibling; mirror itself untracked |
| 4 | `server_control_sequence` echo: retail echoes update_times[5] in every MoveToState/AutonomousPosition; wasm sends 0 forever (UpdateMotion never advances it) | acclient.c:718176 (v5=update_times[5]) → :718187; :718227 → :718239 | lib.rs:28786-28791 ("let it ride"), UpdateMotion arm :33341+ (no record call); cli correct path messages.rs:57-59 + mutations.rs:326-331 | SPLIT-BRAIN / MISSING (wasm half) | ACE currently lenient (doc'd assumption); any server-side staleness check on ServerControlSequence would reject wasm moves while cli works | untracked (self-documented TODO) |
| 5 | F2-3 deferred-LoginComplete implemented twice (core event path + wasm recv arm) | retail gate: `CPlayerSystem::SendLoginCompleteNotification` acclient.c 0x562E90 (per lib.rs:31484 doc) sends only after destination load | messages.rs:74-87 AND lib.rs:31490-31510 + :31741-31763 | SPLIT-BRAIN (2 sites) | flag/logic drift between cli and wasm teleport flows | F2-3 (movement bughunt 2026-06-09) |
| 6 | Two pack codecs exist for the same wire types (hand-written runtime codec + Chorizite-generated codec) | retail: one Pack/UnPack body per pack class (acclient.c:323814+ etc.) | actions.rs:20-189 (live) vs protocol/src/lib.rs:40 `mod generated` + generated_parity.rs:189-201 (test-only) | EXTRA (latent SPLIT-BRAIN) | none today; risk = someone wires generated types into runtime and shapes drift (JumpPack field names already differ) | untracked |
| 7 | Dead third quartet copy: `LocalPlayerSnapshot` written, never read | n/a (retail has one owner) | lib.rs:28793-28800 (struct), writes :31736-31740/:32021/:32151, zero reads | EXTRA | misleads readers into "fixing" the dead copy (the doc block still describes it as feeding MoveToState) | untracked |
| 8 | MoveToStateActionData constructed inline at 3 sites in one module (quartet read repeated) | retail single ctor site SendMovementEvent acclient.c:718187 | system.rs:3319-3334, :3343-3356, :3363-3380 | SPLIT-BRAIN (3 sites, same file) | low — a quartet-source change must touch 3 sites | untracked |
| 9 | AutonomyLevel (0xF752) codec exists but is never sent; retail sets autonomy_level=2 and gates all position events on it | acclient.c:712866+ (`= 63314`); ShouldSendPositionEvent gate :718117 (`autonomy_level == 2`) | opcodes.rs:518 + actions.rs:196-211 (codec); zero construction sites (grep AutonomyLevel in core/world/cli/wasm: none) | MISSING | ACE doesn't require it today; retail-server or stricter forks would never grant client autonomy → all our autonomous moves invalid | untracked |
| 10 | Pack byte-level shapes for MoveToState/AutonomousPosition: field order, quartet u16×4, contact/longjump bit byte, 4-align | acclient.c:323814-323851, :323934-323978 | actions.rs:53-69 (incl. `contact_long_jump` byte = retail's `(contact)|(longjump<<1)`, pad_to_4), :175-188 | PARITY | — | F5-3 (0xF753 decode shift) already fixed |
| 11 | Send boundary: one counter-stamped funnel | OrderHdr stamp `Proto_UI::GetNextUICounter` acclient.c:713161-713172; Send*Event shims :435899-435913 | send.rs:321-329 (single `send_action`, `game_action_sequence` += 1) | PARITY | — | — |

## 4. Staged unification plan

Target shape: **one pack codec module (already true — keep `actions.rs` canonical), one
quartet owner (`world.player`), one receive route (world handlers on both cli and wasm), one
send boundary (already true)**. The work is almost entirely on the wasm receive side.

### Stage W1 — route movement messages to world handlers in wasm (kills rows 3, 5, partially 4)
- Scope: add `UpdatePosition`, `PrivateUpdatePosition`, `PublicUpdatePosition`, `VectorUpdate`,
  `UpdateMotion`, `PlayerTeleport` to `should_route_message_to_world` (lib.rs:21933) and delete
  the hand-mirrors (:31468-31476 teleport mirror, :31948-31954 sequence mirror) in favor of the
  canonical `holtburger_world::handlers::routing::handle_message` path the cli uses. The wasm
  recv arms keep their JS-facing EntityUpdate emission but stop mutating `w.player` sequences
  directly. Consume `WorldEvent::Self*` in the wasm loop exactly as `messages.rs:50-105` does
  (move that match into a shared `holtburger-core` helper so cli and wasm call ONE function —
  e.g. `movement::apply_self_movement_world_events(&mut movement, events)`).
- Files: `apps/holtburger-web/src/lib.rs`, `crates/holtburger-core/src/client/messages.rs`
  (extract helper), `crates/holtburger-core/src/client/movement/system.rs` (no shape change).
- Flag: `?wireStatePacks=stage1` URL flag → wasm const (style of docs/url-flags.md), default-off;
  legacy mirror path retained behind the flag's off branch.
- wasm-rebuild (Rust). Rollback: flag off.
- Tests: headless-now — cli integration tests already cover the handler path; add a wasm-target
  unit test asserting the routed set; replay a captured UpdateMotion/UpdatePosition session and
  assert `w.player` quartet equals the cli runtime's quartet for the same byte stream.
  1070-gated — teleport eye-test (Holtburg ring) since the PlayerTeleport mirror was
  load-bearing for the academy-rubberband fix (lib.rs:31420-31466).

### Stage W2 — server_control_sequence parity in wasm (closes row 4)
- Scope: with W1's routing in place, `UpdateMotion` flows through
  `apply_self_update_motion` (mutations.rs:293-304) so `w.player.server_control_sequence`
  advances; the Jump/MoveToState/AutonomousPosition builders then echo a live value (they
  already read `w.player.*`). Delete the "let it ride" `LocalPlayerSnapshot` quartet fields
  and the dead writes (row 7) in the same change.
- Files: `apps/holtburger-web/src/lib.rs` only. Same flag as W1 (stage1 implies this once
  UpdateMotion is routed; keep as separate commit for bisectability).
- Tests: headless-now — unit: feed a non-autonomous UpdateMotion with server_control_sequence=N,
  assert next built MoveToStateActionData echoes N (compare against cli runtime on same bytes).
- wasm-rebuild. Rollback: flag off.

### Stage W3 — single MoveToState builder (closes row 8)
- Scope: extract one `fn build_move_to_state(world, raw_motion_state, metadata) ->
  MoveToStateActionData` in `movement/common.rs` (next to `build_autonomous_position`,
  mirroring retail's single MoveToStatePack ctor at acclient.c:718187); the three system.rs
  sites call it. Pure refactor, no wire change.
- Files: `crates/holtburger-core/src/client/movement/{common.rs,system.rs}`.
- Flag: none needed (byte-identical output; pin with a golden-bytes test). wasm-rebuild.
- Tests: headless-now — golden-bytes equality of the three pulse kinds before/after.

### Stage W4 — TurnToEvent codec + send (closes row 1) — design-gated
- Scope: add `TurnToEventActionData { absolute_degrees: f32, run: u32 }` to actions.rs +
  `GameActionOpcode::TurnTo = 0xF649` (uncomment opcodes.rs:96), and fire it from the same place
  the cli/web snap heading for combat turn-to (cli combat.rs:971; A3/Stage-3 MoveToManager will
  be the retail-correct emitter — coordinate with A3 before wiring). **Check ACE consumes
  0xF649 first** (rule §2.6: server owns acceptance); if ACE has no handler, record as
  do-not-do in ROADMAP.
- Flag: `?sendTurnToEvent=on` default-off. wasm-rebuild + cli.
- Tests: headless-now — codec round-trip vs retail layout (acclient.h:45687); ACE-source grep for
  the GameActionType. 1070-gated — none (server-visible only).
- Depends-on: A3 Stage 3 (MoveToManager) for the retail-correct trigger point.

### Stage W5 — quarantine the generated codec (closes row 6)
- Scope: documentation + lint, not code motion: mark `protocol/src/lib.rs:40` `mod generated` as
  `#[doc = "TEST-ONLY — runtime codec is messages/movement/actions.rs"]`, and add a
  `generated_parity.rs` test asserting the generated JumpPack shape stays byte-compatible with
  `JumpActionData` minus the ACE trailer (turns the latent drift into a failing test).
- Files: `crates/holtburger-protocol/src/lib.rs`, `tests/generated_parity.rs`. No flag.
- Tests: headless-now (cargo test, but rule §2.8 — written for later execution, not run now).

Row 2 (Jump position omission) and row 9 (AutonomyLevel never sent): **NO WORK** while ACE is
the target server — ACE discards/never reads them (validate_wire_conformance.cjs:218-243;
ACE GameActionJump.cs reads+discards per the same memo). List both in ROADMAP's do-not-do with
a "revisit if non-ACE server" note.

## 5. Scores

- Leverage: subsumes/locks-in **F2-3** (dual-site collapses to one), hardens **F5-2/F2-1**
  encoding rules (single MoveToState builder carries the doc), prevents recurrence-class of
  **F5-3** (one codec, golden bytes). Unblocks A3 Stage-3 (MoveToManager needs a TurnToEvent/
  MoveToState send surface) and A14 (input funnel lands on one builder).
- Regression-risk reduction: **H** — the wasm hand-mirror recv path is the exact pattern that
  produced the teleport-pose-stick bug (lib.rs:31420-31466) and the F2-3 dual-site.
- Implementation risk: **M** — W1 touches the wasm recv loop's most load-bearing arms
  (UpdatePosition feeds the 3D camera EntityUpdate stream); W2/W3/W5 are **L**; W4 is **L** code
  / **M** behavior (server acceptance unknown).
- 1070-dependency: W1 **Y** (teleport eye-test); W2/W3/W5 **N** (byte-level assertions);
  W4 **N**.
- Depends-on: Stage 1 eye-test PASS (W1 changes the same player-pose reconcile surface
  `USE_INTERPRETED_VELOCITY` feeds); A3's DESIGN.md delta for W4's trigger point; A1's frame
  ordering does not block (send boundary is tick-driven either way).

## 6. SPECULATIVE / UNRESOLVED

- **ACE handling of 0xF649 TurnToEvent**: not verified — `external/ACE` here lacks a
  `Network/GameAction` tree (`/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/
  ACE.Server/Network/GameAction` does not exist on this checkout; only `Player.cs:866
  HandleActionJump` was greppable). W4 is gated on confirming a server-side handler. Patterns
  tried: `grep -rn "F649|TurnToEvent|GameActionType" external/ACE/Source --include=*.cs`.
- **Retail TurnToEventPack::Pack body**: only the dispatch site (Event_TurnToEvent
  :713237-713246, virtual `Pack`) was found; no standalone `TurnToEventPack::Pack` body in
  acclient.c (likely inherits a trivial 2-field writer). Layout claim rests on acclient.h:45687.
  Patterns tried: `grep -n "TurnToEventPack::" acclient.c`, bndb pseudo-C grep.
- **update_times[] slot→timestamp mapping**: the ctor argument ORDER proves instance=[8],
  server_control=[5], teleport=[4], force_position=[6] at both call sites (:718175-718187,
  :718225-718239), but I did not independently confirm which PhysicsTimestampPack S2C messages
  feed each slot (that's CPhysicsObj::handle_timestamps territory — A1/A3 adjacent). Single-cited
  on the inbound half.
- **Backlog docs unavailable on this host**: `~/out/bughunt86-combat-render-loop-items-2026-06-09.md`
  and `~/out/grind-loop-2026-06-11.md` do not exist on the buildbox; F2-3/F5-2/F5-3 IDs were
  cross-checked against `~/out/movement-combat-render-bughunt-2026-06-09.raw.json` (:1277, :2146)
  and the in-code references. G-item dedupe is therefore incomplete.
- The wasm UpdateMotion arm (lib.rs:33341+) was scanned only for sequence handling; whether it
  duplicates other cli-side motion acceptance logic is A4/A5 territory.
