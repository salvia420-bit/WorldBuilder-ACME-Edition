# Movement-port WAVE 2 — buildbox research fan-out spec (2026-07-03; +P11-P16 2026-07-04)

You are ONE of 16 Opus agents. Packets P01-P10 map the retail AC
client's POSITION ARBITRATION + CAST/TARGETING layer (decomp research);
packets P11-P16 are LIVE-BUG DIAGNOSES on the current tree (user-reported
defects — root-cause hunts through OUR code + ACE + the decomp). Your
packet id is in your prompt. This wave is RESEARCH/DIAGNOSIS ONLY:
produce your ENTIRE deliverable on STDOUT as one markdown document. Do
NOT modify any file. Do NOT write Rust/JS code beyond short illustrative
excerpts of EXISTING code.

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

## Live-bug diagnosis packets (P11-P16, added 2026-07-04)

USER-REPORTED defects from live 1070 play (real render, vanilla ACE).
You have no live client — diagnose by tracing code: our client
(holtburger crates + scene3d JS), ACE server source, decomp for the
retail-correct shape. Deliverable per packet: the root-cause hypothesis
chain (ranked if multiple), symbol-anchored cites at every hop, the
SMALLEST fix direction (no code), and a concrete live-verification
recipe the laptop integrator can run (what to click/watch, which diag
counters or console lines confirm/refute).

**Session-6 context (2026-07-04) you should weigh as candidate
mechanisms — verify, don't assume:**
- Mid-session spawn hydration gap: an `@create`-spawned creature landed
  server-side (audit line) but NEVER entered the JS `EntityManager`
  (`entityMap`/`findGuidByName` empty of it) on a
  `?nullRender=1&renderOnDemand=1&netDrainHz=30` bot page — login-time
  entities hydrated fine. Unknown whether flag-specific or a general
  mid-session CreateObject path defect. (scene3d/loop.js drain →
  `dispatchEntityUpdate` → entities.js `_spawnImpl` — spawn success and
  the name index land only after the async mesh fetch.)
- The completion-clock shim: every 1-anim motion node drains at
  `RENDERER_DONE_FALLBACK_SECS = 2.0` (motion_table_manager.rs, session
  5) — anything that "reverts after ~2 seconds" should be checked
  against it FIRST.
- Defaults flipped 2026-07-04: `?slideCast` now DEFAULT-OFF (authentic
  burst — held strafe/turn die at cast-gesture stomps, tap revives;
  forward is NEVER persisted), `?leashEchoGate` DEFAULT-ON,
  `?cmdInterp` has been default-ON since step 5. The user's "there are
  some catches" note on slideCast=off is unexplored — P16 likely
  touches it.
- Backward walk (S) is a FORWARD-slot command: `WalkBackwards` is
  REWRITTEN to `WalkForward` with negative speed by `adjust_motion`
  (interp_state.rs:12/:27/:58) — interpreter stomps and forward-slot
  rules apply to it verbatim.

- **P11 corpse drops missing for some creatures (e.g. tuskers)** — the
  user sees fragments (e.g. Obsidian/crystal fragment creatures) leave
  corpses but tuskers do not. ACE side: `Creature_Death.cs` corpse
  creation (`CreateCorpse`), the no-corpse conditions
  (`TreasureType`/NoCorpse property, destroy-on-death), corpse setup
  id/scale inheritance from the source creature. Client side: corpse
  CreateObject → EntityManager spawn — could SPECIFIC setups fail the
  async mesh/palette fetch (spawn-success gate = invisible entity), and
  does the mid-session hydration gap (context above) apply on a REAL
  render page? Deliver: the decision tree "creature dies → corpse
  visible on our client", where tusker-class corpses diverge, and what
  distinguishes them (setup DID, palette ops, scale) from fragment
  corpses. Cross-check the tusker + fragment weenies in
  `external/LSD-Partial-2025-02-23_16-15/` for corpse-relevant
  properties.
- **P12 corpses not lootable (no loot panel on click)** — clicking a
  corpse should open the container HUD to collect items. Trace our
  click → action path (scene3d/picking.js entity-click branches; does a
  CORPSE class object even get a use/open action or only select?), the
  wire action retail used (GameAction Use 0x0036 / UseWithTarget —
  confirm via chorizite + decomp `CM_Inventory`/UseManager), ACE's
  `Corpse.Open`/looting permission gates (killer/fellowship,
  `CorpseGeneratedRarity`, kill-task), and the client's ViewContents
  (0x0196) → container-panel wiring (a vendor/chest panel path exists —
  diff corpse vs vendor container flows). Deliver: where the chain
  breaks (no action sent? action rejected? ViewContents unhandled for
  corpse containers? panel not wired?), with the fix direction per
  break point.
- **P13 animation drops to peace/idle ~2 s after walking backwards** —
  repro: hold S (most reliable), also A+S / S+D, in-world on vanilla
  ACE; ~2 s in, the character's ANIM reverts to peace-mode idle while
  still moving. PRIME SUSPECT: the 2.0 s completion-clock shim draining
  a backward-walk motion node and the anim lane re-resolving to stance
  idle (motion_table_manager.rs + the renderer consumers in
  entities.js/loop.js — who re-picks the clip when a node drains?).
  Also weigh: ACE's motion echo for backward walk (stance field on the
  echo), the M1 wire shape for WalkBackwards (forward slot, negative
  speed?), and what retail plays for sustained backward walk
  (MotionTable walk_backward loop — confirm the retail loop exists via
  the 0x09 MotionTable for the human setup, DatReaderWriter dats.xml
  field order). Deliver: the exact 2 s clock owner, the anim re-resolve
  path, and the smallest correction (real authored lengths? loop-class
  nodes exempt from the shim? echo stance handling?).
- **P14 portals not appearing** — portal objects (swirling purple
  vortices) are not visible in-world. They arrive as landblock-static
  CreateObjects (verify: ACE LandblockInstances → CreateObject on
  login-time streaming vs mid-session). Trace: does the portal object
  reach the client entity stream (wire category "spawn"), does its
  setup (portal gfx = particle-heavy, possibly zero solid parts +
  alpha/additive surfaces) survive `_spawnImpl`'s mesh fetch and the
  spawn-success gate, do the portal particle emitters attach
  (particle_manager.js + fetchPhysicsScript/emitter path), or is the
  mesh there but the MATERIAL invisible (additive/alpha surface decode
  — RenderSurfaceExtensions PFID paths)? Diff vs static objects that DO
  render (signs, lifestones). Deliver: the first broken hop + fix
  direction; note whether the P11 hydration gap is the same defect.
- **P15 ground items cannot be picked up** — clicking an item on the
  ground does nothing (expected: pickup into inventory, or at least an
  attempt + animation). Trace picking.js's item-vs-creature click
  branches (is there a pickup action at all, or select-only?), the
  retail action (`PutItemInContainer` 0x0019 with the player as
  container — confirm opcode via chorizite GameActionType), our wasm
  action surface (does SessionHandle expose a pickup/move-item call?
  Is the inventory HUD's pickup path wired only for container-to-
  container?), ACE's `HandleActionPutItemInContainer` distance/motion
  gates. Deliver: whether the client never SENDS, sends wrong, or
  drops the response; fix direction per case.
- **P16 move-backward misbehavior in casting (magic) mode** — the user
  reports backward movement (S) misbehaving in magic stance ("move
  backward bug in casting mode"); likely one of the ADJ-8 "catches".
  Backward walk rides the FORWARD slot, so every ACE cast-gesture
  stomp kills held-S, and with slideCast now DEFAULT-OFF nothing
  persists it; `?castMove`'s rule = held FORWARD-slot commands stay
  dead until a fresh forward EDGE. Map the full interplay: held-S
  through a cast chain under (a) burst default, (b) slideCast=on
  (persistence never covered forward — confirm), (c) what RETAIL did
  (client-authored gestures never stomped the caster — held backward
  kept flowing, cf. P06). Also check backward-specific stance motion
  (walk_backward in Magic stance — does the magic-stance MotionTable
  even carry it, or does the client fall to NonCombat for the clip —
  ties into P13's revert). Deliver: the precise mechanism the user
  feels, whether it is a DEFECT or the authentic-burst tradeoff, and
  the retail-faithful fix direction (e.g. backward exempt from
  gesture-stomp? edge-revive parity?).
