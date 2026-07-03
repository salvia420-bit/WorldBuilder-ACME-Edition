# Movement-port WAVE 1 — buildbox fan-out spec (2026-07-03)

You are ONE of 16 Opus agents translating the retail input layer + MoveTo tail
into holtburger. Your packet id (P01-P16) is in your prompt. Produce your ENTIRE
deliverable on STDOUT as one markdown document. Do NOT modify any file.

## Sources (all readable from this box)

- PRIMARY TRUTH: `~/ac-headers/acclient.c` (final client, Hex-Rays). Find bodies:
  `grep -n 'ClassName::Method(' ~/ac-headers/acclient.c` — definition lines have
  no trailing `;`. CRLF + huge lines: use `grep -a` / `rg -a` (ripgrep is
  installed by the driver).
- VTABLE RESOLVER + second opinion: `~/ac-headers/acclient_2013.bndb_pseudo_c.txt`
  (Binary Ninja, symbolized member calls — use whenever acclient.c shows
  `vfptr[N]` dispatch; also for era diffs).
- STRUCT LAYOUTS: `~/ac-headers/acclient.h`; byte offsets in `~/ac-headers/acclient.txt`.
- C# REFERENCE TRANSLATION (naming/semantics disambiguator — decomp wins on
  conflict): `external/ACE/Source/ACE.Server/Physics/Command/*.cs`,
  `Physics/Animation/MotionInterp.cs`, `Physics/Managers/MoveToManager.cs`.
- INDEPENDENT CROSS-CHECK, READ-ONLY: `external/GDL/PhatSDK/*.cpp/h`. AGPL —
  you may READ to disambiguate; you may NOT copy code or comments from it.
- HOUSE CONVENTIONS + the mechanism context you are porting toward:
  `external/holtburger/crates/holtburger-core/src/client/movement/*.rs`
  (read `interp_state.rs`, `raw_state.rs`, `system.rs` doc comments for style),
  `docs/strafecast-mechanism-analysis-2026-07-03.md` (the behavioral ground
  truth this port must reproduce), `docs/movement-port-feasibility-2026-07-03.md`.

## Rules

1. Decomp-primary: port from `acclient.c`; every function you port carries an
   inline `// acclient.c:NNNNNN` cite at its definition (find the line number
   with grep -n). Where you used the 2013 dump to resolve dispatch, cite that
   too (`acclient_2013...:VA`).
2. Field-for-field state: struct fields keep retail names (snake_cased) and
   you list each field's retail source. No invented state; no dropped state.
   If a field's purpose is unknown, port it anyway and mark `// UNKNOWN-USE`.
3. Behavior only, no integration: your module may reference existing
   holtburger types by path (e.g. `super::interp_state::InterpretedState`) and
   may DECLARE trait/callback seams where retail calls outward (physics obj,
   smartbox, weenie) — model those as small traits or enum commands, documented.
   The Fable integration pass on the laptop wires them; you make the seams
   explicit and minimal.
4. Rust, 2024-idiomatic but conservative: no async, no unsafe, no new deps.
   Match the crate's doc-comment style (dense, cited).
5. Tests are part of the packet: a `#[cfg(test)] mod tests` exercising every
   ported branch you can drive without the physics engine (list-stack behavior,
   flag algebra, dispatch selection, edge semantics). Tests must compile on
   plain rustc against your own module + std only where possible.
6. UNCERTAINTY IS DELIVERABLE: end with an **Open questions** table — every
   place the three sources disagree, every vfptr you could not resolve, every
   timing/ordering guess. The Fable pass adjudicates from your table; a wrong
   silent guess costs 10× a flagged one.
7. Budget your run: you have a 40-minute wall clock. Read your packet's
   functions FIRST (grep the bodies), then write. Completeness of YOUR packet
   beats commentary on the system.

## Output contract (markdown, stdout)

```
# PNN <packet name>
## Module source
```rust
<complete module file(s), each preceded by a `// FILE: <suggested path>` line>
```
## Port notes
<per-function: retail cite, what it does, deviations, seam decisions>
## Open questions
<table>
```

## Packets

- **P01 list-engine** — `CommandList` struct + `CommandList::{AddCommand,
  RemoveCommand,GetHead,HeadIsMouse}` (+ element struct), 
  `CommandInterpreter::WhichList` (:717402), `ApplyHoldKeysToCommand` (:716961).
  Foundation for P02-P08: define the three-list holder shape.
- **P02 stacks** — `CommandInterpreter::{AddCommand(:717429),NukeCommand(:717458),
  BookkeepCommandAndModifyIfNecessary(:717499),ClearAllCommands}` +
  `transient_state` semantics (set/clear/suppression trio — see analysis doc §2.8).
- **P03 dispatch** — `{HandleKeyboardCommand(:717243),MovePlayer(:717800),
  MovePlayer_NonAutonomous,HandleNewForwardMovement(:717689)}` + `CmdStruct`
  arg decode; the controlled_by_server press/release asymmetry (silent releases).
- **P04 apply** — `{ApplyCurrentMovement(:717027),ApplyListHeadMovement(:717102),
  StopListHeadMovement(:717170),MaybeStopCompletely,StopCompletely,StopDrift}`.
- **P05 control** — `{TakeControlFromServer(:716934),LoseControlToServer(:716832),
  UsePositionFromServer,SetAutonomyLevel}`. Port the FULL TakeControl tail
  (StopCompletely + StopInterpolating + hold_run re-assert + ApplyCurrentMovement)
  — this is FU-A in the analysis doc; it is the strafecast engine.
- **P06 modifiers** — `{SetHoldRun(:717000ish),UpdateToggleRun,ToggleAutoRun,
  SetAutoRun(:718254),SetHoldSidestep(:717023)}` + `ACCmdInterp::UITogglesRun`.
- **P07 mouse/turn** — `{HandleMouseMovementCommand,HandleSelectLeft(:717196),
  SetMouseLeftDown,GetMouseLeftDown,SetMouseLookActive,GetMouseLookActive,
  TurnToHeading}`.
- **P08 session** — `{ctor(:717720ish),NewPlayer,SetSmartBox,Enable,Disable,
  IsActive,IsEnabled,LoseKeyboardFocus,HandleLogOff,PlayerIsDead(:717695),
  PlayerTeleported,HandleExhaustion,IsStandingStill,UseTime,
  ShouldSendPositionEvent,SendPositionEvent(:718225),SendMovementEvent(:718175)}`.
- **P09 ACCmdInterp** — the derived shim layer: `{ctor,CommenceJump,DoJump,
  SetMotion,OnAction,RecvNotice_PlayerOptionChanged,
  InitializeEmoteInputActionHash,HandleNewForwardMovement,TakeControlFromServer,
  SendMoveToStateEvent,SendAutonomousPositionEvent,SendDoMovementEvent,
  SendStopMovementEvent,SendTurnToEvent,SendAutonomyLevelEvent}`. Map each
  Send* onto the EXISTING A13 builders in
  `crates/holtburger-core/src/client/movement/common.rs` (do not re-invent the
  packs; document the mapping).
- **P10 moveto-nodes** — `MoveToManager::{ctor,dtor,Create,Destroy,
  SetPhysicsObject,SetWeenieObject,InitializeLocalVariables,
  AddMoveToPositionNode,AddTurnToHeadingNode}` + node/queue shapes; reconcile
  with the EXISTING partial port in `movement/move_to.rs` (extend, don't fork).
- **P11 moveto-begin** — `{BeginNextNode,BeginMoveForward,BeginTurnToHeading,
  HandleMoveToPosition,HandleTurnToHeading}`.
- **P12 moveto-progress** — `{CheckProgressMade,GetCurrentDistance,is_moving_to,
  CleanUp,CleanUpAndCallWeenie,RemovePendingActionsHead,_StopMotion,
  MoveToObject_Internal,TurnToObject_Internal}` (fail codes, progress radii,
  the 0x36/0x37/0x40 WeenieError family). (ERRATUM 2026-07-03 wave-1 ADJ-9/P12
  Q1: no `CancelMoveTo(0x40)` exists — the moveto WeenieError family is
  {8, 0x0B, 0x36, 0x37, 0x38, 0x3D}; the "0x40" at MoveToObject_Internal
  :345893 is the `UseFinalHeading` PARAM bit, not a WeenieError.)
- **P13 tails** — `CMotionInterp::{get_jump_v_z,get_max_speed,
  jump_charge_is_allowed,jump_is_allowed,is_standing_still,set_hold_run,
  SetPhysicsObject,SetWeenieObject}` + `MovementManager::{Create,get_minterp,
  InqInterpretedMotionState,InqRawMotionState,HandleEnterWorld,
  HandleUpdateTarget,HitGround,LeaveGround,IsMovingTo,MakeMoveToManager,
  motions_pending,SetWeenieObject,UseTime}` — diff each against the existing
  ports in `motion_interp.rs`/`movement_manager.rs` first; port only what's
  missing, list what already exists.
- **P14 integration spine (DESIGN, not port)** — the JS→wasm input boundary:
  replace the `__axisValue` keystate reader (apps/holtburger-web/index.html
  ~:8395/:8624) with raw key-event forwarding into a wasm-side
  CommandInterpreter; where the interpreter sits relative to `MovementSystem`
  (system.rs) and the `?castMove`/`?slideCast` flags (which become
  interpreter-native — migration table); SmartBox seam (SetObjectMovement →
  latch/control writes); the send cadence (ShouldSendPositionEvent/action
  stamps) vs today's sig-diffed setMovementInput. Deliver: design doc + Rust
  skeleton (types + fn signatures + wiring pseudocode) + a staged migration
  plan that keeps every existing test green at each stage.
- **P15 retail-behavior test suite** — fixtures-as-tests from
  `docs/strafecast-mechanism-analysis-2026-07-03.md`: the caster's sequences
  A-F′ as key-event scripts; pins for head-wins pop-through, silent releases
  under server control, transient_state wedge, TakeControl full-list re-apply,
  latch stamping at stomp time, per-axis single dispatch. Write them against
  the P01-P05 seam signatures from this spec (they will be compiled together
  in the Fable pass; where a signature is uncertain, define the minimal trait
  you need and note it).
- **P16 divergence audit (ANALYSIS, no code)** — for CommandInterpreter,
  CMotionInterp, MoveToManager: 2013-vs-final decomp diffs (behavioral, not
  cosmetic), ACE-vs-decomp deviations (list each with cites — ACE is known to
  drift), PhatSDK-vs-decomp disagreements. Output: adjudication table
  (function, sources, verdict-recommendation, risk) for the integration pass.

## After the run (laptop side, not your concern)

parts/*.md are tarballed to `~/from-vm/` on the laptop; a Fable-model pass
compiles, adjudicates open questions, integrates behind flags, and runs the
golden/live-bot rigs. The VM is powered off after tarball verification.
