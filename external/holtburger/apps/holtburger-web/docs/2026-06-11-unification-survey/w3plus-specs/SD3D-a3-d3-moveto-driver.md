# SD3D — A3-D3 "base Stage-3" MoveToManager DRIVER (the S6 deferred follow-on)

Execution-grade spec for the per-frame MoveTo driver S6 deliberately deferred
(`move_to.rs:121-126` "deliberately a no-op until the base Stage-3 driver lands").
This is retail `MoveToManager::UseTime` + the node walk + arrival/completion surface,
and it is the **hard dependency S10/A14-I2 is blocked on** (W3-RESULTS.md "S10
(blocked on more A3-D3 surface)"). Authored 2026-06-12, read-only laptop agent.
All repo paths relative to `external/holtburger/` unless rooted. Retail truth
`/home/wbterminal/ac-headers/acclient.c`; ACE cross-check `~/ace-server/Source/`
(`ACE.Server/Physics/Managers/MoveToManager.cs` — 1:1 with the decomp, verified on
`FailProgressCount` :23/:76/:459/:475/:591/:611/:619).

**DUAL-CITATION RULE**: behavioral claims cite acclient.c:line AND our file:line;
single-sourced claims live in §7 OPEN QUESTIONS.

---

## 1. Read-HEAD + landed-state facts

**Read HEAD: `ac384af7`** ("holtburger: w3plus close-out…"). W3/w3plus wave fully
landed (W3-RESULTS.md, 9 commits `9568fc0a..08ad6563`). Verified in-tree at read time:

- **S6 (`9568fc0a`) skeleton**: `crates/holtburger-core/src/client/movement/move_to.rs`
  — `MoveToDirective` enum (move_to.rs:24-47), one-slot store + `cancel_moveto` +
  `hit_ground` re-begin marker + `handle_update_target` anchor (move_to.rs:53-166);
  `use_time()` is the documented no-op (move_to.rs:121-126).
- **MovementManager facade** (movement_manager.rs): master gate
  `USE_UNPACK_MOVEMENT_SEMANTICS: bool = false` (:40), `perform_movement` 9-type
  dispatch (:152-212), `use_time` → moveto only (:247-253), `hit_ground` → both
  (:258-270), `apply_unpacked_movement` core deliverable (:375-473) incl. case-6
  missing-target LABEL_15 fallback (:441-446) and case-6/7 `my_run_rate` install
  (:439, :449).
- **Registry + consumer**: `MovementSystem.movement_managers: HashMap<Guid,
  MovementManager>` (system.rs:952), populated in `apply_movement_world_events`
  (system.rs:3954-3992; `_ungated` test seam :3968), pruned on `EntityDespawned`
  (:3986-3988). Local player rides `WorldEvent::SelfServerControlledMotion`
  (handlers/player.rs:96-107, accepted-&&-!autonomous structural gate;
  events.rs:221), remotes ride `WorldEvent::EntityMovementEvent` with
  caller-computed `target_exists` (handlers/movement.rs:14-27, events.rs:111).
  NOTE: the local lane currently passes `target_exists = false` with an explicit
  "revisit when the Stage-3 driver lands" comment (system.rs:3940-3952 doc).
- **Params**: runtime `MovementParameters` is COMPLETE (params.rs:34-46 — all 10
  retail ctor fields incl. `distance_to_object`/`min_distance`/`fail_distance`/
  `walk_run_threshhold`/`speed`/`hold_key_to_apply`), default bitfield `0x1EE0F`
  (params.rs:26, retail ctor literal acclient.c:339455-339461), named bit accessors
  incl. `sticky()` 0x80 (params.rs:100-102). What it does NOT carry — correctly —
  is object radius/height (see §3 contract resolution).
- **Adjacent machinery to REUSE, not duplicate**:
  - per-entity `MotionTableManager` on the facade (movement_manager.rs:116) + the
    local A4-Q1/A3-D2 pump (`USE_MOTION_TABLE_QUEUE`, system.rs:1487-1510);
  - `MotionInterp::do_interpreted_motion`/`stop_interpreted_motion` +
    `adjust_motion` + `motions_pending` (motion_interp.rs:608-610, the
    acclient.c:343728 port) — the landed lattice the driver's `_DoMotion` routes
    through;
  - A2-P1 position-manager queue + S9 `StickyManager`
    (`crates/holtburger-world/src/spatial/position_manager.rs`: `USE_STICKY_MANAGER`
    :52, `stick_to(target, target_radius)` :556, `use_time(quantum)` :589) and the
    deferred sticky-timeout cell (system.rs:957-976, consumed at tick start
    :1440-1442);
  - S7 transition pipeline (`crates/holtburger-world/src/spatial/transition.rs`,
    `USE_UNIFIED_TRANSITION`) — the actual position step stays there / in the
    integrator; the driver NEVER moves the avatar directly;
  - the autonomous drive lane: `AutonomousDriveIntent` (movement_types.rs:48-54),
    `execute_autonomous_drive_intent` (system.rs:4209-4242),
    `autonomous_wire_motion_state` (system.rs:1369-1424 — emits the SAME wire
    `MotionState` bytes as manual input), one-tick expiry `expire_active_drive`
    (system.rs:1347);
  - S11 jump-charge + A13 single-send boundary (`movement/common.rs`: single pulse
    ctor :156, single Jump ctor :192) — any wire emission the driver causes goes
    through the EXISTING senders only.
- **S15 NO-GO (RULINGS.md item 5, CLOSED)**: never send TurnToEvent 0xF649 — ACE
  registers no handler; heading reaches the server via MoveToState 0xF61C +
  AutonomousPosition 0xF753 only. Already documented at the emit hook
  (move_to.rs:101-106). The driver adds NO new sends.
- **Manifest**: `WASM_EXPORT_MANIFEST_VERSION = 4` (apps/holtburger-web/src/lib.rs:530);
  rule of record (W3-RESULTS.md "S11 manifest deviation"): additive exports RIDE v4,
  bump only on breaking/expected-by-default changes; index.html EXPECTED stays 1.
- **Wave context**: ROADMAP W4 (`A6-T0/T1/T2 · A3-D3 · A2-P2 · A14-I2`, ROADMAP.md:128)
  — gate "Stage-1 eye-test PASS + W2"; 1070 currently down, buildbox OFF; this work
  lands flag-off and joins the batched-rebuild + batched-eye-test sets.

### Retail driver shape (the thing being ported — full read, this pass)

Entry/storage (per-call object dims, NOT params):
- `MoveToManager::MoveToObject(object_id, top_level_id, object_radius,
  object_height, params)` (decl acclient.c:7145; body :345184-345240): StopCompletely,
  stamp `starting_position`, store sought id/radius/height + `movement_type = 6` +
  full params copy; `top_level_id != self` → `set_target` and WAIT (`initialized=0`)
  for `HandleUpdateTarget`. Radius/height are resolved by the CALLER from the
  target's physics dims: `CPhysicsObj::MoveToObject` (:319767-319825) reads
  `CPartArray::GetHeight/GetRadius` (:319808-319817, 0.0 fallback) before calling
  `MoveToObject_Internal` (:317483-317530) → `MovementManager::PerformMovement` type 6.
- `MoveToPosition(p, params)` (:345790-345857): StopCompletely; set
  `current_target_position`; `get_command` probe; if a command results →
  `AddTurnToHeadingNode(heading_to_target)` + `AddMoveToPositionNode` (:345828-345833);
  `bitfield & 0x40` (UseFinalHeading) → trailing `AddTurnToHeadingNode(desired_heading)`
  (:345835-345836); store type 7 + params with **sticky bit cleared**
  (`bitfield &= 0xFFFFFF7F`, :345852); `BeginNextNode`.
- `TurnToObject(object_id, top_level_id, params)` (:345242-345295): type 8, defers to
  `HandleUpdateTarget` → `TurnToObject_Internal` (:345911-345951: heading-to-target
  + stored desired offset, fmod 360, push type-9 node).
- `TurnToHeading(params)` (:345954-346016): params copy, sticky cleared (:345990),
  type 9, push one type-9 node, `BeginNextNode`.
- Nodes: heap list of `{type, payload}` — type 9 = TurnToHeading(heading)
  (`AddTurnToHeadingNode` :345096-345118), type 7 = MoveToPosition
  (`AddMoveToPositionNode` :345120-345141).

Per-frame pump:
- `UseTime` (:346018-346049): gated on `physics_obj->transient_state & 1` (on-ground
  contact) AND a pending node AND (`!top_level_object_id || movement_type == 0 ||
  initialized`); dispatch head node: type 7 → `HandleMoveToPosition`, type 9 →
  `HandleTurnToHeading`.
- `BeginNextNode` (:345521-345567): head type 9 → `BeginTurnToHeading`; type 7 →
  `BeginMoveForward`; EMPTY list → arrival: sticky bit clear (`SLOBYTE(bitfield) >= 0`)
  → `CleanUp` + `StopCompletely`; sticky bit SET → CleanUp + StopCompletely +
  `PositionManager::StickTo(top_level_id, radius, height)` (:345553-345566).
- `BeginMoveForward` (:345371-345452): `GetCurrentDistance`; heading-to-target delta
  (degrees, epsilon 0.0002, +360 wrap, :345400-345405);
  `MovementParameters::get_command(dist, heading, &motion, &hold_key, &move_away)`;
  command → `_DoMotion` with a FRESH default params (`bitfield &= 0xFFFF7FFF` —
  CancelMoveTo bit stripped, :345412-345414) carrying stored `speed`+`hold_key`;
  on error → `CancelMoveTo(err)`; on success stamp `current_command`/`moving_away`/
  `previous_distance(+time)`/`original_distance(+time)` (:345419-345434); NO command
  → pop node + `BeginNextNode` (:345439-345446).
- `BeginTurnToHeading` (:345456-345518): bail if `motions_pending` (:345480-345481);
  `heading_diff(node_heading, curr_heading, motion)` (:344738-344752: degrees,
  0.0002 epsilon, direction-folded); already there → pop + `BeginNextNode`
  (:345493-345494); else pick TurnRight `0x6500000D`/TurnLeft `0x6500000E`
  (1694498829/1694498830, shortest arc, :345487-345498) → `_DoMotion`, stamp
  `current_command` + `previous_heading`.
- `HandleMoveToPosition` (:345577-345709): (a) aux-turn-while-walking — desired
  heading = heading-to-target + `get_desired_heading(current_command, moving_away)`
  (0/180 table, :346224-346239); |delta| > 20° and < 340° → keep an aux turn command
  `_DoMotion`'d alongside the walk, else `_StopMotion` the aux (:345620-345651);
  (b) progress: `GetCurrentDistance` + `CheckProgressMade` (:344833-344854: <0.25
  units/s over >1s windows vs both previous and original stamps → no-progress);
  no progress AND not interpolating AND no motions pending → `fail_progress_count++`
  (:345657-345659 — **bookkeeping only**, no threshold consumer exists in the decomp
  or in ACE MoveToManager.cs); (c) arrival: `moving_away ? dist >= min_distance :
  dist <= distance_to_object` → pop node, `_StopMotion` current + aux,
  `BeginNextNode` (:345663-345686); else fail-distance:
  `Position::distance(starting, current) > fail_distance` → `CancelMoveTo(0x3D)`
  (:345689-345692); (d) target-quantum hint (:345695-345707) — interpolation-rate
  plumbing, N/A for us (A2 lane owns remote interpolation).
- `HandleTurnToHeading` (:345712-345787): current command must be a turn (else
  `BeginTurnToHeading`, :345778-345780); `heading_greater(curr, node_heading, motion)`
  (:344715-344736, overshoot test) → **`set_heading(node_heading)` SNAP** + pop +
  `_StopMotion` + `BeginNextNode` (:345739-345760); else stall detection via
  `heading_diff(curr, previous_heading)` ≥180 or ≤0.0002 → `fail_progress_count++`
  when not interpolating/no motions pending (:345762-345774).
- `_DoMotion`/`_StopMotion` (:344753-344831): `minterp->adjust_motion(motion, speed,
  hold_key)` then `DoInterpretedMotion`/`StopInterpretedMotion` — i.e. straight into
  the lattice we landed (motion_interp.rs; facade split-borrow pattern
  movement_manager.rs:160-174). Errors: 8 no-physics-obj, 11 no-minterp.
- `GetCurrentDistance` (:344856-344893): bitfield UseSpheres bit `0x400`
  (`BYTE1 & 4`) → `Position::cylinder_distance(self_radius, self_height, self_pos,
  sought_radius, sought_height, target_pos)`; else point `Position::distance`.
  **DEFAULT params have 0x400 SET** (`0x1EE0F`, params.rs:26) — cylinder is the
  default metric. This is exactly F6-5's semantics (S10 §2.3).
- `get_command` (:346175-346222): MoveTowards `0x200` / MoveAway `0x100` bits select
  towards / away / both (`towards_and_away`, :346153 — see §7 Q6); towards: command
  = WalkForward `0x45000005` iff `dist > distance_to_object`; away: iff
  `dist < min_distance` with `moving_away=1`; hold_key = Run(2) iff `bitfield & 0x10`
  or (`CanRun 0x2` && (`!CanWalk 0x1` || `dist - distance_to_object >
  walk_run_threshhold`)) else 1 (:346213-346221).
- Completion/abort: `CleanUpAndCallWeenie(status)` (:345171-345181) = `CleanUp`
  (:345143-345168: `_StopMotion` current+aux with CancelMoveTo bit stripped,
  `clear_target`, `InitializeLocalVariables`) + `StopCompletely`. In the client decomp
  the weenie callback is compiled away — status is DROPPED. Status codes actually
  produced: 0x36 PerformMovement preamble cancel (:346123-346127), 8 missing physics
  obj, 0x3D fail-distance (:345692), 0x37/0x38 target-update failure
  (`HandleUpdateTarget` :346086/:346108-346110), 0 target-is-self arrival (:346093).
  `is_moving_to` = `movement_type != 0` (:344895-344898).
- `HitGround` → `BeginNextNode` iff `movement_type` (:345570-345574) — the skeleton's
  `pending_hit_ground_rebegin` marker (move_to.rs:131-135) is the recorded half.

---

## 2. Current-state map (what exists vs what the driver adds)

| concern | landed (HEAD ac384af7) | driver adds |
|---|---|---|
| directive entry | one-slot store, wire + typed entry (move_to.rs:75-109; movement_manager.rs:152-212, :375-473) | retail entry BODIES: node-list build, starting-position stamp, sticky-bit strip, target-deferral |
| params | full runtime `MovementParameters` + bit accessors (params.rs) | `get_command`/`get_desired_heading`/`heading_diff`/`heading_greater` ports |
| object dims | ABSENT (S10 §2.4 gap) | radius/height as entry args + manager fields (§3) |
| per-frame pump | `use_time()` no-op (move_to.rs:126); facade routes (movement_manager.rs:247-253) | UseTime/Begin*/Handle* state machine, pure-return house style |
| steering output | none | `MoveToDriveOutput` → existing autonomous drive lane (system.rs:1369-1424, :4209) |
| completion | `last_cancel_error` diagnostic only (move_to.rs:150-154) | `is_active()` + `take_completion() -> Option<u32>` read-clear latch (S10 contract) |
| arrival metric | none | cylinder under UseSpheres 0x400 (F6-5 parity) |
| sticky on arrival | S9 `StickyManager` exists, decoupled | sticky-bit completion → `stick_to` handoff (gated USE_STICKY_MANAGER) |
| local-player loop | tick + A4-Q1 pump (system.rs:1426+, :1487-1510) | driver shim after the pump, LOCAL PLAYER ONLY |
| remote MoveTo | render-side hints (KIND_TURN lib.rs:18236-area; handlers/movement.rs:98-135 heading-set) — F3-2 deliberately deferred (DESIGN.md Stage-3 tests note) | NOTHING (out of scope; remotes keep the render lane) |
| legacy local double-driver | none possible today (skeleton stores, never acts — move_to.rs:9-11) | containment required once the driver acts (§4 M5) |

---

## 3. S10 consumer contract — exact signatures provided (incl. the radius/height resolution)

**Resolution of the params gap**: retail does NOT carry object radius/height in
`MovementParameters` either — they are separate `MoveToObject` arguments
(acclient.c:7145) resolved by the caller from the target's physics dims
(acclient.c:319808-319817) and stored as manager fields `sought_object_radius/height`
(InitializeLocalVariables acclient.c:344957-344958), consumed only by
`GetCurrentDistance` under the UseSpheres bit (acclient.c:344873-344884). So:
**`MovementParameters` stays untouched; the entry signature and the directive grow
the two floats.** This matches S10 §2.4's indicative signature verbatim and keeps
params.rs a pure retail-ctor transcription.

What lands on `MoveToManager` (move_to.rs), consumed via `MovementManager` and the
`MovementSystem`/handle passthroughs S10 Stage A.2-A.4 plugs into:

```rust
// move_to.rs — the S10/A14-I2 binding contract (names final):
pub(crate) fn move_to_object(&mut self, target: Guid, origin: Origin,
    object_radius: f32, object_height: f32, params: MovementParameters);
    // acclient.c:7145/:345184; BREAKING for the 2 in-tree callers
    // (movement_manager.rs:183, :443) — same-change update, wire case 6
    // passes caller-resolved dims (0.0/0.0 when unresolvable, the retail
    // CPartArray-null fallback acclient.c:319810-319815).
pub(crate) fn turn_to_object(&mut self, target: Guid, params: MovementParameters);
    // unchanged shape (move_to.rs:96); gains a real body. acclient.c:7146/:345242.
pub(crate) fn turn_to_heading(&mut self, params: MovementParameters);
    // unchanged shape (move_to.rs:107). acclient.c:7158/:345954.
pub(crate) fn cancel_moveto(&mut self, error: u32);
    // unchanged shape (move_to.rs:113); now ALSO latches completion =
    // Some(error) when a movement was active (retail CancelMoveTo acts only
    // if movement_type != 0, acclient.c:345297-345303).
pub(crate) fn is_active(&self) -> bool;
    // retail is_moving_to: movement_type != 0 (acclient.c:344895-344898) —
    // ours: directive/node-list non-empty.
pub(crate) fn take_completion(&mut self) -> Option<u32>;
    // read-clear latch. Some(0) = arrived (BeginNextNode empty-queue,
    // acclient.c:345544-345560; HandleUpdateTarget self-target
    // CleanUpAndCallWeenie(0), :346093). Some(err) = failure/abort:
    // 0x36 cancelled (new directive preamble / manual input / S10 CancelPursuit),
    // 0x3D fail_distance (acclient.c:345692), 0x37/0x38 target lost
    // (:346086/:346108), 8 target/pose unresolvable. Retail drops the status
    // client-side (CleanUpAndCallWeenie body :345171-345181 calls no weenie);
    // the latch is our poll-shaped analog (S10 §6.5 acknowledges this).
pub(crate) fn use_time(&mut self, view: &MoveToView) -> MoveToDriveOutput;
    // the real per-frame driver (§4 M3). Pure: no world access, no sends.
```

S10's `pursueEntity(guid, radiusM, heightM, run)` forwards radius/height into
`move_to_object` and maps `run` to params (`bitfield |= 0x10` forces Run in
`get_command`, acclient.c:346213-346215 — note the retail-vs-ACE bit-4 delta already
documented at params.rs:23-25; forcing via 0x10 reproduces today's `run=true`
charge behavior exactly). `is_active`/`take_completion` reach S10's A.3/A.4 through
`MovementManager::{is_moveto_active, take_moveto_completion}` facade passthroughs +
`MovementSystem` accessors next to the registry seam (system.rs:4031-4034 pattern).

`MoveToView`/`MoveToDriveOutput` (new, move_to.rs — the house pure-return pattern,
mirror of `UnpackEffects` movement_manager.rs:88-104):

```rust
pub(crate) struct MoveToView {
    pub on_walkable_contact: bool,      // retail transient_state & 1 gate (acclient.c:346024)
    pub self_pos: WorldPosition,        // position + heading
    pub self_radius: f32, pub self_height: f32, // cylinder metric self half (acclient.c:344877-344878)
    pub target_pos: Option<WorldPosition>, // refreshed per tick by the shim (HandleUpdateTarget analog)
    pub motions_pending: bool,          // MotionInterp::motions_pending (motion_interp.rs:608 ↔ acclient.c:343728)
    pub is_interpolating: bool,         // position-manager queue active (position_manager.rs:167)
    pub now: Instant,                   // CheckProgressMade clock (acclient.c:344833)
}
pub(crate) struct MoveToDriveOutput {
    pub do_motion: Option<(u32, MovementParameters)>,   // _DoMotion request (walk/turn cmd)
    pub stop_motions: Vec<(u32, MovementParameters)>,   // _StopMotion requests
    pub set_heading: Option<f32>,       // HandleTurnToHeading arrival snap (acclient.c:345746)
    pub stop_completely: bool,          // CleanUp/arrival edge (acclient.c:345179-345180)
    pub stick_to: Option<(Guid, f32, f32)>, // sticky-bit arrival (acclient.c:345553-345566)
    pub completion: Option<u32>,        // mirrors the latch, for same-tick consumers
}
```

---

## 4. Staged implementation plan (one const, default-OFF, wasm-rebuild batch, NO manifest change)

**Flag**: `pub(crate) const USE_MOVETO_DRIVER: bool = false`, top of
`movement/move_to.rs`, const-gate pattern (movement_manager.rs:30-40;
url-flags.md const section). Gates ONLY the `MovementSystem` tick shim (M4) — the
pure state machine itself ships ungated (inert: nothing calls `use_time` with a view
unless the shim runs; the `_ungated` test-seam house pattern, system.rs:3964-3967).
Wasm-rebuild to flip; **no new wasm exports** in this item (S10 owns its exports and
they ride manifest v4 additive — lib.rs:530; W3-RESULTS rides rule), so **no
`WASM_EXPORT_MANIFEST_VERSION` change** here. Reachability coupling, document in
url-flags.md: wire-lane directives flow only under `USE_UNPACK_MOVEMENT_SEMANTICS`
(+ `?wireStatePacks=stage1` on wasm, movement_manager.rs:34-39); the S10 input lane
flows under `?wasmPursuit=on` independently — the driver serves both.

### M1 — state + params math port (move_to.rs, params.rs; pure, no callers change behavior)

1. Manager fields per `InitializeLocalVariables` (acclient.c:344913-344959):
   `movement_type` (subsumed by the directive enum), `sought_position`,
   `current_target_position`, `starting_position` (WorldPosition), `previous_distance`
   `+_time`, `original_distance` `+_time` (f32::MAX seed = `2139095039` bits,
   acclient.c:344922-344927), `previous_heading`, `fail_progress_count`,
   `current_command`, `aux_command`, `moving_away`, `initialized`,
   `sought_object_radius/height`, `pending_nodes: VecDeque<MoveToNode>` where
   `MoveToNode = TurnToHeading(f32) | MoveToPosition` (retail node types 9/7,
   acclient.c:345096-345141).
2. `MoveToDirective::MoveToObject` gains `object_radius: f32, object_height: f32`
   (§3); update the two constructors (movement_manager.rs:183/:443 — wire case 6
   resolves dims caller-side, see M4.3) and `MovementStruct::MoveToObject`
   (movement_manager.rs:61-66) to carry them (S10's typed entry).
3. `MovementParameters` methods (params.rs):
   `get_command(&self, curr_distance, curr_heading_deg) -> (Option<u32>, HoldKey,
   bool /*moving_away*/)` (acclient.c:346175-346222 incl. the hold-key rule
   :346213-346221); `get_desired_heading(command, moving_away) -> f32`
   (:346224-346239: 0x44000007/0x45000005 → 180 iff away; 0x45000006 → 180 iff
   towards); free fns `heading_diff(x, y, motion)` (:344738-344752) and
   `heading_greater(x, y, motion)` (:344715-344736) — **degrees domain, epsilon
   0.0002, +360 wrap**, exactly as decompiled (our pose headings are radians:
   convert at the view boundary, one site, unit-tested both ways).
   `towards_and_away` (:346153) transcribed for the both-bits arm (§7 Q6 if skipped).
4. `GetCurrentDistance` analog `current_distance(&self, view) -> f32`
   (acclient.c:344856-344893): UseSpheres `0x400` → cylinder distance
   (`Position::cylinder_distance` r1,h1,p1,r2,h2,p2 — port next to the existing
   cylinder collision helpers, `crates/holtburger-world/src/spatial/entity_collision.rs`
   has the cylinder primitives; keep the math in core if the dependency direction
   demands, mirroring how S6 kept core types off `holtburger_world::Entity`,
   S6 spec §D3-1); else point distance. `CheckProgressMade` port
   (acclient.c:344833-344854: 1s window, 0.25 rate, dual previous/original stamps).

### M2 — entry bodies (move_to.rs; replaces the store-only bodies, same signatures + §3 deltas)

- `move_to_object`: retail :345184-345240 — `stop_completely` request, stamp
  `starting_position` from view at first `use_time` (we have no pose at entry; retail
  stamps from `physics_obj` — ours defers the stamp to the first driven frame,
  recorded as a deliberate one-frame deviation), store dims/params/directive,
  `initialized = false` → first `use_time` with a resolved `target_pos` runs the
  `MoveToObject_Internal` node build (:345859-345909: heading-to-target node +
  MoveToPosition node via `get_command` probe; UseFinalHeading `0x40` → trailing
  heading node with `+desired_heading` offset fmod 360, :345893-345901).
  We collapse retail's `top_level_id` to the target guid (no part-owner hierarchy
  in our entity model; the equipped-weapon case S10 cares about targets creatures —
  §7 Q5).
- `move_to_position`: retail :345790-345857 — immediate node build (target pose is
  the directive's own origin), sticky bit cleared (:345852), `BeginNextNode`.
- `turn_to_object` / `turn_to_heading`: :345242-345295 / :345954-346016 —
  conditional StopCompletely on the `0x10000`-region bit (`*((BYTE*)&params+2)&1` =
  StopCompletely bit 16, our `bitfield & 0x1_0000`), heading node push, sticky clear
  (turn_to_heading :345990), `BeginNextNode`. TurnToObject defers like MoveToObject
  (`TurnToObject_Internal` :345911-345951 on first resolved target pose).
- `cancel_moveto(error)`: extend the landed body (move_to.rs:113-119) — drain
  `pending_nodes`, run the CleanUp `_StopMotion` requests (CancelMoveTo bit stripped,
  acclient.c:345148-345164 — surfaced through the next `use_time` output or an
  immediate `MoveToDriveOutput` return from a `&mut` cancel — pick ONE: spec says
  cancel returns the stop-effects struct so callers apply them synchronously,
  matching retail's inline `_StopMotion`), latch completion. The unpack preamble
  (movement_manager.rs:392-394) keeps calling it — a new server directive auto-cancels
  the old one with 0x36, retail PerformMovement parity (acclient.c:346123-346127).
- `hit_ground`: consume the landed marker — `pending_hit_ground_rebegin` →
  `BeginNextNode` on the next `use_time` (acclient.c:345570-345574 ↔ move_to.rs:131-135).
- `handle_update_target`: upgrade from record-only (move_to.rs:140-142) to the retail
  body (:346051-346118): matching target + initialized → refresh
  `current_target_position` + reset progress stamps (type 6, :346088-346101);
  not initialized → run the deferred `*_Internal` node build; target failure →
  `cancel_moveto(0x37/0x38)`.

### M3 — the per-frame driver (move_to.rs; pure fns over `MoveToView`)

`use_time(&mut self, view) -> MoveToDriveOutput` (acclient.c:346018-346049):
- contact gate `view.on_walkable_contact` (retail `transient_state & 1`, :346024) —
  off-ground: no-op (HitGround re-begins on touchdown, M2);
- pending head + (`initialized || untargeted`) gate (:346030);
- dispatch: `MoveToPosition` node → `handle_move_to_position` (port of
  :345577-345709: aux-turn 20°/340° band, progress/fail bookkeeping, arrival pop,
  fail-distance `cancel 0x3D`; the target-quantum tail :345695-345707 is N/A —
  document, don't port); `TurnToHeading` node → `handle_turn_to_heading`
  (:345712-345787 incl. the `set_heading` snap + stall bookkeeping);
- `begin_next_node` / `begin_move_forward` / `begin_turn_to_heading` ports
  (:345371-345567) — `_DoMotion`/`_StopMotion` become `MoveToDriveOutput` entries;
  the FACADE applies them through the landed lattice (`MovementManager::use_time`
  grows the application step: split-borrow `adjust_motion` +
  `do_interpreted_motion`/`stop_interpreted_motion` + the per-entity
  `motion_table_manager`, exactly the `do_motion` pattern at
  movement_manager.rs:398-419 ↔ acclient.c:344753-344831). A lattice error from
  `_DoMotion` → `cancel_moveto(err)` (acclient.c:345417-345418);
- empty queue → arrival: completion latch `Some(0)`, `stop_completely`, sticky-bit →
  `stick_to: Some((target, radius, height))` (acclient.c:345544-345566).

### M4 — MovementSystem shim + consumer surface (system.rs, handle.rs; the only gated code)

1. **Pump site**: in `tick`, immediately after the A4-Q1 pump (system.rs:1487-1510),
   under `USE_MOVETO_DRIVER`: local player only — `movement_managers` entry for
   `world.player.guid`. Build `MoveToView` from `world.local_player_runtime_pose()`
   (the autonomous lane's own pose source, system.rs:1374-1377), target pose from
   `world` entity lookup by the directive's target guid (refreshing per tick = the
   client-side `HandleUpdateTarget` cadence; target gone → `cancel_moveto(0x37)`),
   contact from the system's grounded state (§7 Q3), `motions_pending` from the
   facade's minterp, `is_interpolating` from the A2 lane.
2. **Output translation** (the steering bridge — entry-point-only boundary, S10 §2.4):
   - walk command active → feed `PlayerDriveIntent::Autonomous(AutonomousDriveIntent {
     desired_world_delta: unit-forward-toward-target, desired_heading:
     Some(target_heading), gait: hold_key==Run → Run, force_grounded: false,
     target_hint: Some(target_pos) })` through the EXISTING
     `enqueue_drive_intent`→`execute_autonomous_drive_intent` lane
     (system.rs:983-998, :4209-4242). The lane already (a) emits byte-identical
     MoveToState via the single A13-W3 builder (autonomous_wire_motion_state
     system.rs:1369-1424 + common.rs:156 — A13/S11 single-send boundary respected,
     ZERO new send sites), (b) expires per tick (expire_active_drive system.rs:1347)
     matching the per-frame re-supply, (c) realizes locally through the shared
     solver/S7 transition step — the driver never writes a position;
   - turn-only command → same intent with zero delta + `desired_heading` (the lane's
     turning realization, system.rs:1396-1409). Turn omega magnitude = integrator
     policy (the pending `turnOmega` flag work), NOT re-derived here — DESIGN.md
     Stage-3 "turn omega rate-limited to retail turn rate × params.speed" is the
     integrator-side refinement, §7 Q4;
   - `set_heading` snap → the existing snap path (`execute_snap_facing`-equivalent,
     S10 cites system.rs:3354) — retail snaps exactly at turn arrival
     (acclient.c:345746);
   - `stop_completely`/arrival → the existing stop edge (`execute_stop_at`,
     system.rs cite in S10 §3 A.3 — ACE must see the stop; do NOT hand-roll a sender);
   - `stick_to` → `world.scene` sticky owner under `USE_STICKY_MANAGER`
     (StickyManager::stick_to position_manager.rs:556; height param gap §7 Q2).
3. **Wire case 6 dims**: `WorldEvent::EntityMovementEvent` (events.rs:111) gains
   `object_radius: f32, object_height: f32` next to `target_exists`, computed at the
   SAME caller that computes `target_exists` (handlers/movement.rs:14-27) from the
   entity snapshot's physics dims, 0.0 fallback (retail acclient.c:319810-319815).
   The local lane (handlers/player.rs:96-107) gains the same resolution + a real
   `target_exists` — closing the documented `false` placeholder
   (system.rs:3944-3951). Additive event fields, Default-safe.
4. **Consumer surface**: `MovementSystem::{moveto_is_active, take_moveto_completion}`
   (+ handle passthroughs next to handle.rs:181) reading the local player's manager —
   the exact S10 A.3/A.4 hook points. No exports here (S10 Stage B owns
   `pursuitStatus` etc.).
5. **Manual-cancel parity**: a non-idle `ManualSet` while `is_active()` →
   `cancel_moveto(0x36)` (retail raw input cancels MoveTo:
   `CMotionInterp::apply_raw_movement` → `CPhysicsObj::cancel_moveto` →
   `MovementManager::CancelMoveTo(0x36)`, acclient.c:344259-region → :317421-317427 →
   :339240-339246). One arm in `ingest_drive_command` (system.rs:1318), inert without
   an active directive. (S10's idle-ManualSet/stomp arbitration stays S10's — this
   item only guarantees the cancel hook exists.)

### M5 — local double-driver containment (smallest possible, flag-on only)

With the driver ON, the local player's legacy server-MoveTo render reactions must not
double-steer. Landed reality check: the skeleton "no double-driver" guarantee rests on
never acting (move_to.rs:9-11); once we act, audit the TWO legacy lanes:
(a) `handlers/movement.rs` TurnTo heading-set — REMOTE entities only (guid lookups
against `state.entities`; the local player's UpdateMotion short-circuits in
handlers/player.rs:96-107 before the entity path) — verified no local overlap, no
change; (b) the wasm KIND_TURN JS ease (lib.rs:18236-area emit; S10 §1 cites
loop.js/entities.js consumers) — whether the LOCAL guid is already skipped there is
unverified (§7 Q1); if not, gate the local-guid emit behind `!USE_MOVETO_DRIVER`
(one-line, same rebuild). Retiring the remote lanes stays F3-2/A2 territory — NOT
this change (S6 spec §5 "those must be retired IN THAT change" refers to the
LOCAL-acting driver only; remotes keep their driver-less render path).

**Shipping shape**: M1→M2→M3 are move_to.rs/params.rs (new+existing files, no W4
conflicts); M4 touches system.rs/handle.rs/events.rs/handlers — serialize against
A6-T1 and A14-I2 in W4 dispatch order (ROADMAP.md:139 system.rs row; this item
BEFORE A14-I2, which consumes it — ROADMAP.md:116). Commits hunk-selective. One wasm
rebuild batch with the other pending W4 R-items; buildbox OFF → lands inert.

---

## 5. Test plan

### Headless-now (Lane A — land flag-off with these green; laptop capped-build per-package, never --workspace)

Unit (move_to.rs / params.rs):
1. `get_command` table: towards/away/none × distance bands; hold-key rule incl. the
   `0x10` force-run and the walk_run_threshhold crossover (acclient.c:346175-346222);
   `get_desired_heading` 0/180 matrix (:346224-346239); `heading_diff`/
   `heading_greater` epsilon + wrap + direction-fold (:344715-344752), radians↔degrees
   boundary round-trip.
2. `current_distance`: UseSpheres set (default 0x1EE0F) → cylinder; cleared → point;
   degenerate dims (0.0 radius/height) = point-equivalent (acclient.c:344856-344893).
3. `CheckProgressMade`: <1s window always true; stalled >1s false; both-stamp reset
   semantics (:344833-344854).
4. Entry node-build fixtures: move_to_position near/far (no-command → no nodes →
   immediate arrival; far → heading+position nodes); UseFinalHeading trailing node
   (:345828-345836); turn_to_heading single node + sticky clear (:345990);
   move_to_object deferred until target pose then `*_Internal` build
   (:345859-345909); directive replace = preamble cancel latches 0x36.
5. Driver state walk: turn node → TurnRight/TurnLeft shortest arc → overshoot →
   `set_heading` snap + pop (:345739-345760); move node → walk command + progress
   stamps → arrival inside `distance_to_object` → stop + pop (:345663-345686);
   moving_away arrival at `min_distance`; aux-turn engages >20° and stops ≤20°
   (:345620-345651); fail-distance → completion Some(0x3D) (:345689-345692);
   stall → fail_progress_count++ only when !interpolating && !motions_pending
   (:345657-345659, :345762-345774); empty queue → Some(0) + stop_completely;
   sticky-bit empty queue → stick_to(target, r, h) (:345544-345566).
6. Contract lifecycle: `is_active` false→true→false; `take_completion` read-clear
   (second read None); completion survives until read across ticks; cancel during
   turn vs during walk both emit the CleanUp stop set with CancelMoveTo bit stripped
   (:345148-345164).
7. `hit_ground` re-begin consumes the landed marker (move_to.rs:131-135 ↔ :345570).
8. Off-ground `use_time` no-op (contact gate, :346024).

System-level (`_ungated` seam, system/tests.rs):
9. Shim translates walk→Autonomous intent through the real ingest (the
   `simulation_build_request_carries_active_autonomous_drive` pattern S10 cites);
   arrival → stop edge exactly once; manual non-idle cancel → 0x36 latch.
10. Wire case 6 with dims: EntityMovementEvent carries resolved radius/height;
    local lane real `target_exists` (regression for the documented placeholder).
11. Pins: A13-W2 golden echo-chain test UNCHANGED with the const ON (driver writes
    none of the sequence quartet); default-off byte/behavior identity (const false →
    `cargo test -p holtburger-core -p holtburger-world` suites pass unmodified —
    current counts 389/448, W3-RESULTS); sticky decode + run_rate install pins from
    the S6 suite stay green (movement_manager.rs tests :669-703).

Wire-agent (laptop, post-rebuild, no GPU): Playwright chromium → `127.0.0.1:8765`,
`?nullRender=1` mandatory + `?wireStatePacks=stage1`; spawn Academy; inject a
MoveToPosition directive (test seam or S10's `pursueEntity` once landed), read pose
getters in `page.evaluate` per tick: pose converges, `take_completion`-backed status
flips, MoveToState sends remain well-formed (server accepts, no 0xF649 EVER on the
wire — S15 pin).

### 1070-gated (BATCHED with the standing pending-eye-test list — no per-item sitting)

- charge-pursuit feel via S10 (`?wasmPursuit=on`): approach + arrival + stop, no
  rubber-band vs ACE; cylinder stop vs F6-5 JS metric agreement;
- turn-to-face: rate-limited turn (vs today's bang-bang), no visible off-bearing fire;
- sticky arrival (`USE_STICKY_MANAGER` + sticky-bit MoveTo): melee lock engages on
  arrival, releases on action end (F3-4 no-regress);
- W-held manual cancel: tapping W mid-pursuit aborts cleanly (0x36), no double-drive
  drag;
- remote entities UNCHANGED (driver is local-only): NPC MoveTo tempo/turn identical
  to pre-driver build.
Run hidden/off-screen per the 1070 rule.

---

## 6. Risks + rollback

- **Rollback**: `USE_MOVETO_DRIVER = false` → shim dead, state machine unreachable
  (directive store behaves exactly as the landed skeleton: entries store, preamble
  cancels, nothing acts). Event-field additions (M4.3) are additive/Default-safe and
  flag-independent — the only always-on delta, one hunk per handler file.
- **Double-driver** (the S6-documented hazard, move_to.rs:9-11 / S6 spec §5): driver
  steers through the SAME `active_drive` arbitration as every other intent — a second
  steering source is structurally excluded for the local player except the KIND_TURN
  JS ease (§7 Q1, M5 containment). Remote entities never enter the shim.
- **Wire regression**: zero new send sites; steering rides the lane that already
  passes the A13-W2 golden test; stop edges ride `execute_stop_at`. Test 11 pins it.
- **Degrees/radians seam**: the retail math is degrees with 0.0002 epsilons; our
  poses are radians. One conversion boundary (M1.3) + round-trip tests — the classic
  silent-failure spot, called out for review.
- **W4 file conflicts**: system.rs is the hottest movement file (ROADMAP.md:139) —
  M4 serializes behind/around A6-T1 per dispatcher order; M1-M3 are conflict-free.
  A14-I2 hard-depends on this item (S10 §2.4 "blocked — stop and report"): land this
  FIRST in-wave.
- **Per-tick cost**: one HashMap lookup + O(1) state machine for the local player
  only; remote managers continue to pay only the landed unpack path. Negligible.
- **Stale-pkg**: no new exports → no manifest interaction; flag flips require the
  batched rebuild like every other pending Rust const (W3-RESULTS rebuild note).

---

## 7. OPEN QUESTIONS

1. **KIND_TURN local-guid emit** (M5b): whether the wasm KIND_TURN emit
   (lib.rs:18236-area) already excludes the local player guid is unverified — the
   F1-style "local-guid skip" exists for KIND_MOTION in loop.js (movement-fixes
   memory), but the TurnTo kind=9 path was not traced this pass. Single-sourced;
   resolve by grep at implementation time and add the `!USE_MOVETO_DRIVER` gate only
   if needed.
2. **StickyManager height param**: retail arrival-sticky passes radius AND height
   (`PositionManager::StickTo(id, radius, height)`, acclient.c:345565); landed S9
   `stick_to(target, target_radius)` takes radius only (position_manager.rs:556).
   Whether S9's internal follow math needs the height (cylinder offset) or
   deliberately flattened it is S9's call — extend the signature or document the
   drop in the M4.2 handoff.
3. **Contact-gate source**: retail gates UseTime on `transient_state & 1`
   (acclient.c:346024); our authoritative "on walkable contact" bit for the local
   player (integrator grounded state vs the wire `last_contact` byte vs
   `force_grounded`) has multiple candidates in system.rs — pick one with a cite at
   implementation time; wrong choice = driver stalls while airborne-flagged on
   stairs. (S6 made the same note for the lattice's contact arg,
   movement_manager.rs:366-368 doc.)
4. **Turn omega magnitude parity**: DESIGN.md Stage-3 calls for "retail turn rate ×
   MoveToParameters.speed" replacing the fixed-K ease (DESIGN.md:528-529). The
   driver passes `speed` into the turn `_DoMotion` params (acclient.c:345503-345505);
   whether our integrator's realized omega then matches retail
   (MotionTable-derived turn rate — the pending `turnOmega` flag work) is
   unmeasured. Eye-test list item; not a driver blocker.
5. **top_level_id collapse**: retail resolves a part-owner top-level object
   (acclient.c:319818-319822) and compares `top_level_id != physics_obj->id` for the
   self-target arrival short-circuit (:345230, :346091-346093). We collapse
   top_level to the target guid (no part hierarchy). Breaks only for MoveTo-to-a-
   held-item targets; no known consumer. Revisit if S10 ever pursues equipped objects.
6. **`towards_and_away` body** (acclient.c:346153-346173): the both-bits
   (0x100|0x200) band-following arm was located but not transcribed this pass —
   implementer transcribes it in M1.3 (it is reachable: wire params could set both
   bits even though our S10 entries won't).
7. **Local-player MoveToObject from ACE**: whether ACE ever sends the LOCAL player a
   case-6/8 UpdateMotion that should drive (vs only remotes + the S10 input lane) is
   uncaptured; the local lane's structural accepted-&&-!autonomous gate (S6 spec OPEN
   Q1) carries over. The driver handles it correctly either way once M4.3 lands real
   dims/target_exists; flag for the next live capture session.
8. **Starting-position stamp deferral** (M2): retail stamps `starting_position` at
   entry from `physics_obj->m_position` (acclient.c:345196-345198); ours stamps at
   the first driven frame (entry has no view). One-frame fail_distance baseline skew,
   bounded by one tick of motion; documented deviation — promote to a fix (pass a
   pose into the entry points) if review objects, at the cost of widening the S10
   contract signatures.
