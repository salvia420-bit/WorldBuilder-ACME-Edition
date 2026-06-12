# S15 — A13-W4 Design-Gate Resolution: does ACE consume TurnToEvent 0xF649?

Date: 2026-06-12 (W3+ deep-spec sweep, S15)
Type: design-gate resolution (not an implementation spec)
Searched trees: `~/WorldBuilder-ACME-Edition/external/ACE` (partial), `~/ace-server` (LIVE server, full),
`~/ac-headers/acclient.{c,h}` (retail decomp), `~/WorldBuilder-ACME-Edition/external/holtburger` (our client).

---

## 1. read-HEAD

`~/WorldBuilder-ACME-Edition` HEAD = **048573d0** "holtburger: W2 wave results" — matches the expected
W2-landed state (A9-Stage1 20a027d6, A7-R6 a1ac8c53, … A1-O1 656c8ef1 all present in `git log --oneline -15`).

ACE source HEADs (both repos): **a8ff29f** "[ci skip] Updating ServerBuildInfo_Dynamic.cs",
remote `https://github.com/ACEmulator/ACE.git` in both. See §6 for the structural difference between them.

## 2. VERDICT

**Handler: ABSENT.** ACE (the live `~/ace-server` build the user runs, commit a8ff29f) has the enum entry
`GameActionType.TurnTo = 0xF649` but **no registered handler** for it. A 0xF649 sent inside the 0xF7B1
GameAction wrapper falls through to `log.Warn("Received unhandled GameActionType: 0xF649 - TurnTo")` and is
discarded. Sent as a raw top-level fragment opcode it is equally dead (`0xF649` is not in `GameMessageOpcode`
→ "Received unhandled fragment opcode" warn).

**GO/NO-GO for sending 0xF649: NO-GO.**

Rationale: the routing in ACE is structural and exhaustively enumerable — handlers are reflection-registered
off `[GameAction(GameActionType.X)]` attributes, and a full enumeration of all 149 such attributes in the
live server contains no `TurnTo` (and also no `DoMovementCommand`, `StopMovementCommand`, or
`JumpNonAutonomous`). Implementing A13-W4's TurnToEventPack codec + send would produce bytes the server
provably drops, plus one `log.Warn` line of server log spam per autonomous turn. ACE already gets the
player's heading through the two channels it *does* handle — `MoveToState` (0xF61C) and
`AutonomousPosition` (0xF753), both of which carry a full `Position` (incl. heading) into
`Player.SetRequestedLocation` (§3.4). A13-W4 should be closed **wire-parity-blocked (ACE handler gap)** —
exactly the contingency the A13 spec itself pre-declared (A13-wire-state-packs.md:197 "if ACE has no
handler, record as …"). The only future re-open trigger is an upstream ACE patch adding the handler.

## 3. Evidence: opcode routing walk-through in ACE

All paths below are in `~/ace-server` (live server; see §6 for why `external/ACE` could not satisfy the
"Network/GameAction tree" search — that tree is sparse-checked-out away there).

### 3.1 The only two inbound routes

1. **Fragment → message handler.** `NetworkSession.cs:552` calls
   `InboundMessageManager.HandleClientMessage(message, session)`
   (`Source/ACE.Server/Network/Managers/InboundMessageManager.cs:89-119`). It casts the fragment opcode to
   `GameMessageOpcode` and looks it up in `messageHandlers`; a miss hits the `else` at
   `InboundMessageManager.cs:115-118`: `log.Warn($"Received unhandled fragment opcode: …")` — message dropped.
   `messageHandlers` is built purely by reflection over `[GameMessage]` attributes
   (`InboundMessageManager.cs:44-64`). `0xF649` does **not** appear anywhere in
   `Source/ACE.Server/Network/GameMessages/GameMessageOpcode.cs` (verified by grep; the only movement-family
   entries are `AutonomousPosition = 0xF753` at :62 and `GameAction = 0xF7B1` at :66).

2. **GameAction sub-dispatch.** The single `[GameMessage(GameMessageOpcode.GameAction, …)]` handler is
   `GameActionPacket.HandleGameAction` (`Source/ACE.Server/Network/GameAction/GameActionPacket.cs:9-17`):
   reads `uint sequence` then `uint opcode` and calls
   `InboundMessageManager.HandleGameAction((GameActionType)opcode, …)` (:16). That lands at
   `InboundMessageManager.cs:126-149`: lookup in `actionHandlers`; a miss hits
   `InboundMessageManager.cs:147`: `log.Warn($"Received unhandled GameActionType: …")` — dropped.
   `actionHandlers` is built purely by reflection over `[GameAction]` attributes
   (`InboundMessageManager.cs:66-87`). The cast at GameActionPacket.cs:16 is the **only**
   `(GameActionType)` cast in the entire server (verified: repo-wide grep for `GameActionType)` returns
   exactly that one production line) — so there is no side door.

### 3.2 Exhaustive handler enumeration

Method: `grep -rhn '\[GameAction(GameActionType\.' Source/ACE.Server --include='*.cs'` over the whole live
tree → **149 registrations** (matching the 149 files in `Source/ACE.Server/Network/GameAction/Actions/`).
Sorted list contains, movement-wise, only: `AutonomousPosition`, `Jump`, `MoveToState`. Zero hits for
`TurnTo` (case-insensitive). Cross-grep `GameActionType.TurnTo\b` over all of `Source/` → **zero** hits
outside the enum definition itself.

### 3.3 The enum entry exists but is dead

- `Source/ACE.Server/Network/GameAction/GameActionType.cs:157`: `TurnTo = 0xF649,` — declaration only.
- `Source/ACE.Entity/PacketOpCodeNames.cs:509`: `{63049,"Evt_Movement__TurnToEvent_ID"}` — a *name table*
  used for logging/diagnostics, not dispatch. (63049 = 0xF649.)
- These two lines are the **complete** set of `F649|63049|TurnToEvent` hits in the entire ACE source
  (case-insensitive, whole `Source/` tree, both repos). The S2C-direction helpers
  `Network/Motion/TurnToHeading.cs`, `TurnToObject.cs`, `TurnToParameters.cs`, `MovementData.cs` are
  serializers for the server→client `MovementEvent` (0xF74C) family — outbound only, unrelated to consuming
  a client 0xF649.

### 3.4 What ACE actually does with a turning client

Heading reaches the server through both handled movement actions, so 0xF649 is informationally redundant
for ACE:

- **MoveToState 0xF61C** — `GameActionMoveToState.Handle`
  (`Source/ACE.Server/Network/GameAction/Actions/GameActionMoveToState.cs:12-37`): parses `MoveToState`
  (`Source/ACE.Server/Network/Motion/MoveToState.cs:35-36` — `RawMotionState` incl. TurnCommand, then a
  full `Position` incl. heading), then `session.Player.SetRequestedLocation(moveToState.Position, false)`
  (GameActionMoveToState.cs:33) and `BroadcastMovement(moveToState)` (:36). Client turn key press/release
  arrives here.
- **AutonomousPosition 0xF753** — `GameActionAutonomousPosition.Handle`
  (`Source/ACE.Server/Network/GameAction/Actions/GameActionAutonomousPosition.cs:14-33`): ~1 Hz
  `Position` (incl. heading quaternion) → `SetRequestedLocation(position)` (:31).
- `SetRequestedLocation` (`Source/ACE.Server/WorldObjects/Player_Networking.cs:300-304`) stores
  `RequestedLocation` for the physics tick — that is the *entire* server-side notion of "where/which way
  the client says it is". There is no separate heading-only ingestion point that 0xF649 would feed.

Consequence (matches A13 row 1's impact note): heading-sensitive server logic sees a turn only at the next
MoveToState/AutonomousPosition, i.e. with up to ~1 s lag — but sending 0xF649 to *this* server cannot fix
that, because the server discards it.

## 4. Wire shape of TurnToEvent 0xF649 (retail) + our serializer state

Retail decomp (`~/ac-headers`):

- **Payload struct** — `acclient.h:45687-45691`:
  `struct TurnToEventPack : PackObj { float absolute_degrees; int run; };` (8 bytes payload).
- **Send shim** — `ACCmdInterp::SendTurnToEvent(TurnToEventPack*)` `acclient.c:435911-435913` (decl :9201),
  a thin forward to `CM_Movement::Event_TurnToEvent`.
- **On-wire assembly** — `CM_Movement::Event_TurnToEvent` `acclient.c:713221-713251`:
  1. `OrderHdr` with `stamp_ = Proto_UI::GetNextUICounter()` (:713233) — the ordered-event sequence stamp;
  2. `OrderHdr::Pack` then `*(_DWORD*)buf = 63049` (:713242) — the 0xF649 dword;
  3. `TurnToEventPack::Pack` (the `{float absolute_degrees; int run}` body, :713246);
  4. `Proto_UI::SendToWeenie(v4, v3)` (:713248) — the ordered/weenie channel, which is exactly what ACE
     receives as `GameMessageOpcode.GameAction` 0xF7B1 (sequence + opcode + body), matching
     `GameActionPacket.cs:13-16`'s read order.
  So full client→server bytes inside the 0xF7B1 fragment: `u32 sequence, u32 0x0000F649, f32
  absolute_degrees, u32 run`.
- Caller context: dispatched from the command-interpreter turn-to machinery (`CommandInterpreter::UseTime`
  arbitration region, acclient.c:713221 sits in the CM_Movement event family; A14 row 2 cites the
  `SendTurnToEvent` shim at :435911 from the same complex). Only the vtable'd dispatch site exists in the
  decomp; no standalone `TurnToEventPack::Pack` body (consistent with A13's prior OPEN note,
  A13-wire-state-packs.md:241-244 — the field list at acclient.h:45687-45691 is the authoritative shape).

Our client serializer state (`~/WorldBuilder-ACME-Edition/external/holtburger`):

- **None exists.** `crates/holtburger-protocol/src/opcodes.rs:96`: `// TurnTo = 0xF649,` — commented out in
  `GameOpcode` with the (slightly wrong-direction) note "appears to be an invalid or unused opcode"; it is
  also absent from `GameActionOpcode` (enum at opcodes.rs:353; movement members present: `MoveToState =
  0xF61C` :509, `Jump = 0xF61B` :511, `AutonomousPosition = 0xF753` :513, `AutonomyLevel = 0xF752` :518).
- Repo-wide grep (`*.rs`/`*.js`/`*.ts`) for `TurnToEvent|0xF649`: only the commented opcode line and the
  2026-06-11 survey docs (A13/A14/ROADMAP/LAPTOP-REGREP). No codec, no send site — A13 row 1's "codec
  absent" claim re-verified at HEAD 048573d0.

## 5. RULINGS item 4 cross-check: ACE StickyManager local-player handling

Ruling text (`external/holtburger/apps/holtburger-web/docs/2026-06-11-unification-survey/RULINGS.md:23-27`):
retail melee sticky DOES lock the local player to its attack target; our loop.js:1855 local-player exclusion
is a real divergence; the ruling notes "the ACE-side single-citation gap is resolved by user testimony."

**ACE-side evidence now closes that citation gap in code — the ruling is CONFIRMED:**

- **ACE runs sticky on the player's own server PhysicsObj.** `Player_Melee.cs` (in `DoSwingMotion`,
  `Source/ACE.Server/WorldObjects/Player_Melee.cs:419-427`): for a player melee swing ACE sets
  `motion.MotionFlags |= MotionFlags.StickToObject` (:420) + `motion.TargetGuid = target.Guid` (:421),
  broadcasts it (:423 `EnqueueBroadcastMotion(motion)`), and — under `FastTick` — calls
  `PhysicsObj.stick_to_object(target.Guid.Full)` (:427) on the *attacking player's* physics object.
  (Monster path is symmetric: `Monster_Melee.cs:71`, :374.)
- **The sticky motion message is sent to the attacker's OWN client.**
  `EnqueueBroadcastMotion` (`Source/ACE.Server/WorldObjects/WorldObject_Networking.cs:1306-1321`) →
  `EnqueueBroadcast(msg)` (:1319) → `EnqueueBroadcast(params …)` (:1413-1415) defaults `sendSelf = true` →
  `EnqueueBroadcast(bool sendSelf, …)` (:1418-1432) does `if (this is Player self)
  self.Session.Network.EnqueueSend(msgs)` (:1428-1431) *before* fanning out to known players. So the server
  explicitly expects the local client to receive and execute the StickToObject motion on itself.
- **The sticky target goes on the wire.** `Source/ACE.Server/Network/Motion/MovementInvalid.cs:26-27`
  (capture `StickyObject = motion.TargetGuid` when `MotionFlags.StickToObject` set) and :44-46
  (`writer.WriteGuid(movement.StickyObject)` in the serializer).
- **Server-side sticky mechanics** (`Source/ACE.Server/Physics/Managers/StickyManager.cs`):
  `StickTo` :71-81 (`StickyRadius = 0.3f` :20, `StickyTime = 1.0f` timeout :22, `set_target(0, id, 0.5,
  0.5)` :80), `adjust_offset` :89-133 (pulls the object toward the target at `minterp.get_max_speed() *
  5.0f` :110, fallback 15.0 :114, and force-sets heading toward target :122-131), wired into the position
  frame via `PositionManager.AdjustOffset` (`Managers/PositionManager.cs:24-25`) and entered through
  `PhysicsObj.stick_to_object` (`Physics/PhysicsObj.cs:3999-4013`).

Net: ACE both simulates sticky on the player server-side (FastTick) and tells the player's own client to
stick (sendSelf broadcast of MotionFlags.StickToObject). Our client-side local-player exclusion at
loop.js:1855 is therefore a genuine divergence on BOTH the retail axis (user ruling) and the ACE axis
(code above) — A2-P3 must include the local player, as ruled.

## 6. ~/ace-server divergence notes

- **Same commit, different completeness.** Both `external/ACE` and `~/ace-server` are at **a8ff29f** from
  `https://github.com/ACEmulator/ACE.git`. But `external/ACE` is a **shallow, blob:none partial clone with a
  sparse checkout** (`git sparse-checkout list` → `Source/ACE.Entity/Enum`, `Source/ACE.Server/Physics`,
  `Source/ACE.Server/WorldObjects` only; `git rev-parse --is-shallow-repository` → true). The entire
  `Source/ACE.Server/Network/` tree — including `GameAction/`, the routing core of this design gate —
  **does not exist in external/ACE's working tree.** The S15 mission's "search external/ACE
  Network/GameAction tree" is therefore unsatisfiable as written; all Network-tree evidence in §3 comes
  from `~/ace-server`, which is the LIVE server anyway and at the identical upstream commit, so the
  findings apply to the running server with no version skew.
- **File-level identity check:** `diff` of `StickyManager.cs` between the two trees → **IDENTICAL** (the
  only §5 file present in both). Files cited from `Network/` and most `WorldObjects/` partials exist only
  in `~/ace-server`.
- This also retro-explains the earlier "external/ACE OnTeleportComplete is dead code" memory item: code
  read in external/ACE may be absent or unconsulted relative to what actually runs; **`~/ace-server` is the
  authoritative source for server-behavior claims** and future specs should cite it directly.

## 7. Implications for A13-W4 and S10/S9 specs

- **A13-W4 (TurnToEvent codec + `?sendTurnToEvent=on`): CLOSE as wire-parity-blocked.** Per the spec's own
  contingency (A13-wire-state-packs.md:197-199) and §2 above: do not build the codec/send path; mark the
  ROADMAP §8 design gate (ROADMAP.md:251) RESOLVED-NEGATIVE with this document as the citation. Optionally
  keep a one-line tombstone in opcodes.rs replacing the misleading ":96 invalid or unused" comment with
  "C2S in retail; ACE a8ff29f has GameActionType.TurnTo but no [GameAction] handler — see S15 gate doc."
- **The codec knowledge is not wasted:** the wire shape in §4 (`u32 seq, u32 0xF649, f32 absolute_degrees,
  u32 run` inside 0xF7B1) is fully pinned, so if upstream ACE ever adds
  `[GameAction(GameActionType.TurnTo)]`, W4 can be revived as a small, golden-bytes-testable codec with no
  new research.
- **A13 row 1 impact rewording:** the residual gap is not "we should send 0xF649" but "heading freshness
  to ACE is bounded by MoveToState/AutonomousPosition cadence (~1 Hz autonomous pulse,
  GameActionAutonomousPosition.cs:11-13)". Any spec (S9/S10 family — MoveToManager / turn-to unification)
  that needs the server to track an in-progress client turn should ensure a MoveToState is emitted on
  turn-command transitions (it is the handled channel that carries TurnCommand + heading), rather than
  introducing 0xF649.
- **A3 Stage-3 note** (A13-wire-state-packs.md:221 says W4 "unblocks A3 Stage-3 — MoveToManager needs a
  TurnToEvent"): that dependency should be re-pointed at the *internal* turn-to event/queue, not the wire
  packet — the wire half is dead against ACE.
- **S5/S9/S10 sticky work:** §5 gives the concrete ACE contract for sticky (StickToObject motion flag +
  guid on the UpdateMotion wire, sendSelf=true): the client-side A2-P3 sticky implementation has a real
  inbound wire trigger to key off — no new C2S message needed there either.

## 8. OPEN QUESTIONS

1. **Retail TurnToEventPack::Pack body** — still only the vtable'd dispatch (acclient.c:713237, :713246);
   no standalone `Pack` body found in the decomp (same residual as A13-wire-state-packs.md:241-244). Field
   order/width is taken from the struct (acclient.h:45687-45691: `float` then `int`); a captured retail
   0xF649 fragment would be the only stronger artifact, and none exists in our captures (ACE never elicits
   one from us, and our client never sends it).
2. **Exact retail trigger set for SendTurnToEvent** — only the shim (acclient.c:435911) and its
   CM_Movement target are directly greppable; the full caller graph runs through `ACCmdInterp`/
   `CommandInterpreter` vtables (e.g. `CommandInterpreter::UseTime` acclient.c:717595ff) and was not
   exhaustively reconstructed. Irrelevant to the NO-GO (server-side absence decides), but would matter if
   W4 is ever revived against a patched server.
3. **Upstream ACE drift** — verdict is pinned to commit a8ff29f (what the live `~/ace-server` runs).
   Whether ACEmulator master has since added a TurnTo handler was not checked (no network access assumed);
   re-grep `[GameAction(GameActionType.TurnTo` on any future server upgrade.
4. **`run` field semantics** (walk-vs-run flag vs run-rate int) — acclient.h gives only `int run`; with no
   consumer on either side today, semantics were not chased further.
