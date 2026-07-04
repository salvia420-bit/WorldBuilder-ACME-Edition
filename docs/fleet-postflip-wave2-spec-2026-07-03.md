# Movement-port WAVE 2 — buildbox research fan-out spec (2026-07-03)

You are ONE of 10 Opus agents mapping the retail AC client's POSITION
ARBITRATION + CAST/TARGETING layer. Your packet id (P01-P10) is in your
prompt. This wave is RESEARCH ONLY: produce your ENTIRE deliverable on
STDOUT as one markdown document. Do NOT modify any file. Do NOT write
Rust/JS code beyond short illustrative excerpts of EXISTING code.

## Why this wave (context you need, then stop reading context)

Bug A (the casting snapback) was root-caused to a mis-decoded vtable slot:
our reconcile leash arm gated its InterpolateTo echo-pull on the
`controlled_by_server` mirror, but retail gates it on
`CommandInterpreter::UsePositionFromServer()` (autonomy_level != 2,
acclient.c:717529 — vtable slot 8 = 0x803cc0+0x60 = 0x803d20 at call site
:145213; retail's ctor pins `controlled_by_server` TRUE from login at
0x6b3e46). One wrong slot identity cost three live-capture rounds. This
wave buys the decomp truth for every neighboring seam BEFORE we port
further: position sequence spaces, force/teleport arbitration, cast-flow
gesture authorship, targeting/facing conventions, stance echo.

Bug C (for P07): our `picking.js:820-900` fires `castTargetedSpell`
directly on entity click with an armed spell and turns the caster with
suspect heading math (user reports a consistent RIGHT turn). Retail click
was SELECT-only.

## Sources (all readable from this box)

- PRIMARY TRUTH: `~/ac-headers/acclient.c` (final client, Hex-Rays). Find
  bodies: `grep -an 'ClassName::Method(' ~/ac-headers/acclient.c` —
  definition lines have no trailing `;`. CRLF + huge lines: ALWAYS
  `grep -a` / `rg -a`.
- VTABLE RESOLVER + second opinion: `~/ac-headers/acclient_2013.bndb_pseudo_c.txt`
  (Binary Ninja, symbolized). RESOLVE EVERY `vfptr[N].member` YOU CITE:
  find the class vftable VA (`this->vtable = 0xNNNNNN` in a ctor, or
  `rg -an "ClassName::\`vftable' ="`), dump the table
  (`rg -an -m1 -A60 '00NNNNNN  struct .*VTable'`), then flat slot =
  N*3 + member_index (IDA typed these through a 3-member base Vtbl:
  `.__vecDelDtor`=+0, `.OnAction`=+1, `.OnLoseFocus`=+2; byte offset =
  flat_slot*4 from the table base). A slot you assert without the dump is
  a HYPOTHESIS and must be marked as such.
- STRUCT LAYOUTS: `~/ac-headers/acclient.h`; byte offsets/enums in
  `~/ac-headers/acclient.txt` (PDB dump, `rg -a`).
- C# REFERENCE (naming/semantics disambiguator — decomp wins on conflict):
  `external/ACE/Source/ACE.Server/Physics/**` (PositionManager.cs,
  SmartBox equivalents, Managers/), and for SERVER-side cast flow
  `external/ACE/Source/ACE.Server/WorldObjects/Player_Magic.cs`.
- INDEPENDENT CROSS-CHECK, READ-ONLY: `external/GDL/PhatSDK/*.cpp/h`.
  AGPL — you may READ to disambiguate; you may NOT copy code or comments.
- OUR PORT (for the mandatory diff section):
  `external/holtburger/crates/holtburger-world/src/spatial/scene.rs`
  (`reconcile_authoritative_body_with_remote` — the local leash arm +
  remote MoveOrTeleport lattice),
  `external/holtburger/crates/holtburger-world/src/spatial/position_manager.rs`,
  `external/holtburger/crates/holtburger-world/src/spatial/force_position_interp.rs`,
  `external/holtburger/crates/holtburger-core/src/client/movement/*.rs`
  (`command_interpreter.rs`, `motion_interp.rs`, `move_to.rs` if present,
  `system.rs`),
  `external/holtburger/crates/holtburger-world/src/handlers/player.rs`
  (position/motion wire handlers),
  `external/holtburger/crates/holtburger-world/src/state/mutations.rs`
  (`apply_entity_position_sync`, `set_player_position*`),
  `external/holtburger/apps/holtburger-web/scene3d/picking.js` (P07).
- CONTEXT DOCS (skim, ≤10 min):
  `docs/BUGA-snapback-capture-2026-07-03.md`,
  `docs/HANDOFF-postflip2-leashgate-fleet-2026-07-03.md`,
  `docs/strafecast-mechanism-analysis-2026-07-03.md`.

## EXCLUSION LIST — familiar ground, do NOT re-derive (waves 1 + session 5 own these)

- `CommandInterpreter` / `CommandList` / `HandleKeyboardCommand` / M1
  input flow (wave-1 16-packet fan-out).
- `CMotionInterp` / `MotionTableManager` / `MoveToManager` motion
  internals (wave 1) — EXCEPT the TurnTo directive path P08 names.
- The AnimationDone → registry `motions_pending` route + completion-clock
  shim (session 5, `docs/HANDOFF-cmdinterp-postflip-animdone-2026-07-03.md`).
- The `ConstraintManager` budget/adjust_offset fix set already landed
  (url-flags.md `?retailLeash` row items a-g + foundation fixes) — cite,
  don't re-walk, UNLESS your packet finds them WRONG.

## Rules

1. Decomp-primary. EVERY mechanism claim carries `acclient.c:NNNNNN` (or
   `.h`/`acclient.txt`/binja VA) at the point of claim. Grep the line
   number yourself; do not trust this spec's seeds blindly — re-verify.
2. Resolve dispatch. Any `vfptr[N]` in a function you walk gets the
   binja-dump resolution (see Sources). List them in a slot table.
3. The DIFF SECTION IS THE DELIVERABLE'S POINT: for each retail behavior,
   state what our port does at file:line — same / different / absent —
   and if different, the smallest retail-shaped correction. NO code
   changes; describe.
4. Citations from you are HYPOTHESES to the integrator: prefer quoting
   3-8 line decomp excerpts (with line numbers) over paraphrase for every
   load-bearing claim.
5. UNCERTAINTY IS DELIVERABLE: end with an **Open questions** table —
   every place sources disagree, every unresolved slot, every timing
   guess. A wrong silent guess costs 10× a flagged one.
6. Budget ~40 min wall clock. Read your packet's functions FIRST, then
   write. Completeness of YOUR packet beats commentary on the system.
7. Wire shapes: when a packet touches the wire, name the message
   (`CM_Movement::…`/opcode) via
   `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/`
   generated enums/messages if needed.

## Output contract (markdown, stdout)

```
# PNN <packet name>
## Retail mechanism — symbol-anchored walkthrough
## Dispatch resolutions (vtable slot table: VA, flat slot, name)
## What our port does differently (table: retail behavior | cite | our file:line | verdict same/diff/absent | smallest correction)
## Open questions
```

## Packets

- **P01 CPositionManager internals** — `PositionManager` +
  `InterpolationManager` node queue/blip/fail semantics (the
  acclient.c:389140-389510 region: `InterpolateTo`, node drain,
  `node_fail_counter`, blip recovery velocity :389365-389368, completion
  :389274, `StopInterpolating` :389417 vs UnConstrain), `ConstraintManager`
  (`ConstrainTo`/`UnConstrain`/`adjust_offset` :388287-388304,
  `IsFullyConstrained`), `StickyManager` surface, and
  `PositionManager::UseTime` ordering inside `CPhysicsObj::update_object`
  (:320029/:322884-322886). WHO installs/clears each manager and WHEN
  (every call site). Diff vs `position_manager.rs` +
  `force_position_interp.rs`.
- **P02 SmartBox::HandlePositionEvent + the position sequence spaces** —
  the FULL arbitration: `update_times[]` slot meanings (position=0,
  vector=3, teleport=4, … — dump `PhysicsTimestampPack`/the enum from
  acclient.h/txt), `newer_event` wraparound compare, instance/force/
  teleport/server-control sequence spaces, the routine vs teleport local
  arms (:145125-145253), `SmartBox::DoVectorUpdate` velocity/omega gate
  (:143459-143480, gated on UsePositionFromServer for the local player —
  our port applies wire velocity to the local body unconditionally at
  scene.rs `reconcile…` entry: verify + verdict), `TeleportPlayer`,
  parent/child (`unset_parent`) handling. Which incoming position classes
  touch the local player at which autonomy levels. Diff vs
  `handlers/player.rs` + `mutations.rs` `apply_entity_position_sync`
  (Snapshot/Reset/ForceBlip mapping).
- **P03 UsePositionFromServer consumers + the autonomy lattice** — every
  read site of `CommandInterpreter::UsePositionFromServer` (:717529, slot
  0x803d20; known: :145213, :143474 — find the rest by dumping every
  `->vfptr[8]` on cmdinterp receivers + direct calls in both dumps),
  `SetAutonomyLevel` (:717569 → `SendAutonomyLevelEvent` slot 19 =
  0x803da4), `CM_Movement::Event_AutonomyLevel` (:712866),
  `command_line_autonomy_level = 2` (:44837, applied :146233), autonomy
  reads at :716838/:716882/:716901/:716940/:716992/:717983/:718117/:718173.
  What do autonomy levels 0/1/2 MEAN operationally (which behaviors flip
  at each read site)? What raises/lowers autonomy at runtime (any caller
  besides the command line)? Diff vs our pinned-2 ADJ-6 +
  `use_position_from_server()` (command_interpreter.rs:942) + the new
  scene `local_use_position_from_server` mirror.
- **P04 CPhysicsObj::SetPosition / ForcePosition / transition-failure
  snaps** — `SetPosition` family (which variants exist: SetPositionSimple,
  SetPositionInternal, `MoveOrTeleport` :323451-323498 already ported for
  remotes — verify), `ForcePosition` semantics, what a FAILED transition
  does to the local player client-side (the "failed transition" snap the
  fleet work order names), `SetPosition` vs the physics transition system
  (`transition`/`FindObjCollisions` only as far as position adoption goes
  — do NOT port the collision system). Where `m_position` vs the frame
  vs the cell update happen. Diff vs our `SpatialBody.pose` adoption
  arms in scene.rs (Reset/ForceBlip/Snapshot) + `constrain_local_pose_toward`.
- **P05 transient_state movement locks during casting/actions** — the
  `transient_state` field (CommandInterpreter, wave-1 P02 covered the
  stack semantics — EXCLUDED; your job is the CAST/ACTION interplay):
  what retail locks client-side during spell gestures/attacks (if
  anything), `CPhysicsObj::motions_pending`/`IsMovingTo` gates in
  `UseTime` (:6B3BF0 region — `UseTime` body at acclient.c around
  717595), the `TRANSIENT_STATE` enum (dump from acclient.h/txt), and
  whether ANY client-side movement suppression exists during windup/cast
  release (the godmoding evidence says NO server-side anchor existed —
  what did the CLIENT enforce?). Diff vs our cast-window behavior
  (system.rs cast lanes + the step-5 composite).
- **P06 Retail client cast-flow map** — `SpellcastingUI::Cast` (find it;
  also `CM_Magic::Event_CastTargetedSpell` / `CastUntargetedSpell` wire
  senders) → who plays the windup/cast gestures CLIENT-side (the
  client-authored gesture chain: `DoInterpretedMotion`? a direct
  MotionTable drive? which ids in which slots), what position/heading
  changes the client self-authors during a cast (turn-to-face?), and what
  (if anything) arrives FROM a retail server during a cast. Settles how a
  retail-faithful client should treat vanilla-ACE's TurnTo+StopCompletely
  cast flow (`Player_Magic.cs:373/:874/:1342/:1361` — read for the
  contrast section). Diff vs our `playCastSequence` (UI-predicted,
  entities.js:1210-1230 tagging contract) + the wire-driven gesture
  handling from session 5.
- **P07 Retail targeting/selection semantics (bug C)** — click = SELECT
  (`HandleSelectLeft` :717196 was wave-1 P07's — EXCLUDED except its
  select-vs-act boundary), the selection ring/halo, what retail did when
  a spell was ARMED and the player clicked a creature (select only?
  cast-on-double-click? nothing?), and the facing/turn conventions shared
  by melee/missile/magic: heading sign convention (CW-from-north?),
  `TurnToObject`/`TurnToHeading` direction choice (always shortest? sign
  of delta?), `MoveToState` turn fields. THE bug-C question: our
  `picking.js:820-900` turn-to-face block turns consistently RIGHT —
  find the retail heading-delta formula (quote it) so the integrator can
  audit our sign. Diff vs picking.js entity-click + F8-5 block.
- **P08 TurnTo directive end-to-end** — server-initiated TurnTo
  (`MovementType` TurnToObject/TurnToHeading wire shapes — decode via
  chorizite `MovementEvent`/`MoveToState` types), retail's receive path:
  which component consumes a TurnTo directive (`MoveToManager`'s TurnTo
  arm vs the interpreter's turn commands), who owns heading DURING the
  directive, does control transfer (`LoseControlToServer` — which
  MovementType classes raise it, cf. our FU5 arm in handlers/player.rs
  which raises the mirror for every non-Invalid non-autonomous
  UpdateMotion — verify against retail), and what position data a TurnTo
  may legally carry/apply (bug A adjacency: does a retail TurnTo ever
  move the player?). Diff vs handlers/player.rs FU5 + scene mirror +
  move_to/turn handling in holtburger-core.
- **P09 Stance / "initial position" display family** — the user reports
  the character showing standing/peace pose wrongly at times. Retail's
  stance echo → pose pipeline: `Motion_DoObjectDescription`-era stance
  fields, `InterpretedMotionState.current_style`/forward substate on
  APPEARANCE (which wire fields carry stance at object-create:
  `PublicWeenieDesc`/physics desc `placement_id` + stance), how a
  just-created object picks its standing frame (`SetPlacementFrame`
  :145192 region + `CPhysicsObj::HasAnims` gate), and combat-mode stance
  transitions (Peace↔Magic↔Melee motion ids). Diff vs our
  spawn-time stance handling (entities.js placement/stance + wasm
  `motion_table_manager` stance defaults).
- **P10 PositionManager::adjust_to_object / stick-to in combat** —
  `StickyManager` internals (`stick_to_object`, `adjust_to_object`, the
  per-UseTime chase), how retail kept MELEE attackers glued to moving
  targets without rubberbanding (interaction with ConstraintManager +
  InterpolationManager while sticky is armed — priority/ordering), when
  sticky arms/disarms (attack start/end? target death?), and the
  `MAX_INTERPOLATED_VELOCITY` 7.5 m/s floor (:389239-389240) interplay.
  Context for the leash gate's directive-consistency arm + our S8
  remote sticky (`remote_sticky_*` in scene.rs, `stick_local_player_to`).
  Diff vs position_manager.rs sticky surface.
