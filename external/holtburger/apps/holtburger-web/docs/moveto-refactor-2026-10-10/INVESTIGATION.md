# MoveTo: holtburger-web vs OpenAC vs the retail client (2026-10-10)

A read-only study, done to decide whether holtburger-web's MoveTo handling needs a structural refactor. Every
citation below was opened during the session. No code was changed.

Paths:
- `DEC` = `~/ac-headers/acclient.c` (`acclient.h` for structs, `acclient.txt` for the PDB dump). The decomp is the
  authority.
- `HC` = `external/holtburger/crates/holtburger-core/src/client`
- `HW` = `external/holtburger/crates/holtburger-world/src`
- `HWEB` = `external/holtburger/apps/holtburger-web`
- `OC` = `external/OpenAC/src/AcDream.Core/Physics`; `OR` = `external/OpenAC/src/AcDream.Runtime`
- `ACE` = `external/ACE/Source/ACE.Server`. `~/ace-server` has the `Network/Motion/*` files that this checkout lacks.

"MoveTo" means retail's `MoveToManager` family:
- wire movement types 6 MoveToObject, 7 MoveToPosition, 8 TurnToObject and 9 TurnToHeading;
- the sticky handoff at the end of a MoveToObject.

---

## 0. Summary

1. **The state machine is fine.** `HC/movement/move_to.rs` is a faithful port of retail's `MoveToManager`:
   - node queue, `get_command`, `heading_greater`, `CheckProgressMade`;
   - fail distance, sticky arrival, the cancel codes;
   - 21 unit tests.

   OpenAC's `MoveToManager.cs` is an equally close port. Keep holtburger's.

2. **What surrounds it is the problem.** In retail, MoveTo has no physics of its own. `MoveToManager::_DoMotion` puts
   a motion (TurnRight, RunForward, …) on the mover's own `CMotionInterp`, and the body moves because that motion
   moves it. That is the same sequence velocity, position manager and collision sweep as any other motion, for the
   player and every remote alike.

   holtburger has no such per-object motion authority. Its MoveToManager returns a steer descriptor, and separate code
   re-creates the motion:
   - **local player:** an "autonomous drive" lane, plus a legacy server-projection lane and a JS-issued pursuit lane;
   - **remote objects:** a scene drive with hard-coded speeds;
   - **rig animation:** JS hints, phase events and a heading gate.

   The local player alone carries three motion representations and three server-control latches (one of them
   default-off). Each MoveTo fix since June has added one more adapter.

3. **OpenAC shows the retail shape works in a modern client.** It has one `MovementManager` per body, local or remote:
   - MoveToManager writes into the body's `MotionInterpreter`;
   - the animation sequencer supplies root motion, then a full transition sweep runs;
   - a `TargetManager` sends voyeur updates, and sticky runs through `PositionManager`.

   Use OpenAC as the structural reference and the decomp for numbers. OpenAC has some numeric deviations (§2.4).

4. **Recommendation: refactor, scoped as "one per-object movement spine", not "rewrite MoveTo".** The phases are in
   §5.3. Three fixes in §3.5 (D-1, D-2, D-9) can land first, on their own.

---

## 1. Retail (the decomp)

### 1.1 Who owns what

| Retail object | Contents (acclient.h) | Role in MoveTo |
|---|---|---|
| `CPhysicsObj` | `movement_manager`, `position_manager`, `target_manager`, `part_array` | One per object: the player, monsters, NPCs, other players. |
| `MovementManager` (:30943) | `motion_interpreter`, `moveto_manager` | Types 1-5 go to the interp, 6-9 to MoveTo (`PerformMovement`, DEC:339175-339218). |
| `MoveToManager` (:31473-31496) | `movement_type`, `sought_position`, `current_target_position`, `starting_position`, `movement_params`, previous/original distance stamps, `fail_progress_count`, `sought_object_id`, `top_level_object_id`, `sought_object_radius`/`height`, `current_command`, `aux_command`, `moving_away`, `initialized`, `pending_actions` | Node queue + per-frame driver. |
| `PositionManager` (:30952) | `interpolation_manager`, `sticky_manager`, `constraint_manager` | Offset correctors applied every frame. |
| `TargetManager` (:31024) | `target_info`, `voyeur_table`, `last_update_time` | Tracks the object a MoveTo or sticky follows, and answers objects that follow this one. |
| `MovementParameters` (:31423-31465) | Bitfield plus distances; defaults below | — |

`MovementParameters` details:
- **Bitfield:** 0x40 UseFinalHeading, 0x80 Sticky, 0x100 MoveAway, 0x200 MoveTowards, 0x400 UseSpheres,
  0x8000 CancelMoveTo, 0x10000 StopCompletely.
- **Defaults** (ctor, DEC:339437-339463):
  - bitfield `0x1EE0F`;
  - `distance_to_object` 0.6, `min_distance` 0, `fail_distance` FLT_MAX;
  - `speed` 1.0, `walk_run_threshhold` 15.0.

### 1.2 From the wire to the MoveToManager

1. **`ACSmartBox::DispatchSmartBoxEvent`, 0xF74C (DEC:392812-392833).**
   - Looks up the object.
   - An older instance stamp queues the blob (`QueueBlobForObject`).
   - A matching stamp calls `CPhysics::SetObjectMovement`. When that returns 1, the dispatcher calls
     `cmdinterp->vfptr[8].OnAction`, which is `CommandInterpreter::LoseControlToServer`. That is vtable offset +100,
     checked against the PDB (`acclient.txt`, CommandInterpreter field list `0xc215`).
2. **`CPhysics::SetObjectMovement` (DEC:311149-311219).**
   - Applies a message only when its movement stamp is newer and its server-control stamp is not older.
   - Unpacks unless the message is both autonomous and addressed to the player (weenie vfptr[5]).
   - Returns 1 only for the player. So a non-autonomous MoveTo for the player IS applied to the player, and control
     passes to the server.
3. **`MovementManager::unpack_movement` (DEC:339492-339533).** Needs an existing motion interp.
   - **Preamble, on every message:** `cancel_moveto` (0x36) + `unstick_from_object`.
   - **Style:** DoMotion when the style changed.
   - **Case 0:** interpreted state; sticky guid when flag bit 0 is set; standing longjump `0x200`.
   - **Case 6:** object id + origin + `UnPackNet` + `my_run_rate`.
     - Known object → `CPhysicsObj::MoveToObject`, which resolves the top-level parent and the target's
       `CPartArray` radius/height (DEC:319767-319825).
     - Unknown object → `MoveToPosition(origin)`.
   - **Case 7:** MoveToPosition.
   - **Case 8:** `TurnToObject`; unknown object → `TurnToHeading` with the packed heading.
   - **Case 9:** TurnToHeading.
4. **`MoveToManager::PerformMovement` (DEC:346119-346145)** cancels (0x36) and unsticks again before installing.

### 1.3 The state machine (DEC:344753-346240)

**Entry points**
- `MoveToObject` (:345184):
  - StopCompletely; record the start position, target dims and params;
  - `initialized = 0`, then `set_target(0, top_level, 0.5, 0.0)`;
  - nothing moves until the first target update.
- `TurnToObject` (:345242) has the same shape.
- `MoveToPosition` (:345790) and `TurnToHeading` (:345954) build their nodes at once, then `BeginNextNode`. Both
  clear the sticky bit.

**Node build** (`MoveToObject_Internal` :345859 and `MoveToPosition`)
- If `get_command` returns a command, push TurnToHeading(heading to target), then MoveToPosition.
- With UseFinalHeading, push a final TurnToHeading: relative to the bearing for the object form, absolute for the
  position form.

**Turn nodes**
- `BeginTurnToHeading` (:345456) waits while `motions_pending`, then `_DoMotion(TurnRight/TurnLeft)` along the
  shortest arc.
- `HandleTurnToHeading` (:345712) completes only on OVERSHOOT: `heading_greater` (:344715), strict for TurnRight.
  It then snaps with `set_heading`, `_StopMotion`s and begins the next node.

**Move nodes**
- `BeginMoveForward` (:345371) calls `get_command` (:346175):
  - WalkForward, or WalkBackwards in the towards-and-away case;
  - hold key Run when `can_charge`, or when `can_run && (!can_walk || dist − distance_to_object >
    walk_run_threshhold)`.
- `HandleMoveToPosition` (:345577):
  - aux TurnRight/TurnLeft only when the facing error is outside ±20°;
  - `CheckProgressMade` (:344833) — a stalled frame skips the arrival check;
  - arrival at `dist <= distance_to_object` (or `>= min_distance` when moving away);
  - more than `fail_distance` from the start cancels with 0x3D;
  - the tail sets the target quantum (§1.5).

**Ending and gating**
- `BeginNextNode` (:345521) with an empty queue: CleanUp + StopCompletely. With Sticky (0x80) set it also calls
  `PositionManager::StickTo(top_level, radius, height)`.
- `UseTime` (:346018) runs only while the object has CONTACT (`transient_state & 1`).
- `HitGround` (:345570) re-begins the current node.

**Two client-build quirks**
- `fail_progress_count` is incremented but never read in the client. The retail client never gives up for lack of
  progress.
- `CleanUpAndCallWeenie` (:345171) calls no weenie.

### 1.4 How the body moves

There is no MoveTo-specific physics.
- `_DoMotion` (:344753) is `adjust_motion` + `CMotionInterp::DoInterpretedMotion` on the mover's own interp.
- The motion table then plays the cycle, and the `CSequence` carries its velocity and omega: MotionData × speed.
  `apply_run_to_command` multiplies by the run rate and by `params.speed`.

Every frame, for every object (DEC:319989-320031, :322719-322891):
1. `CPartArray::Update` → root-motion offset (× scale; only while on walkable).
2. `PositionManager::adjust_offset`:
   - an active interpolation node REPLACES the offset while on contact;
   - then sticky, then constraint.
3. `Frame::combine`, `UpdatePhysicsInternal`, then the collision `transition`.
4. `TargetManager::HandleTargetting`, `MovementManager::UseTime` (→ `MoveToManager::UseTime`),
   `CPartArray::HandleMovement`, `PositionManager::UseTime`.

`update_object` (DEC:323081) slices time at MAX_QUANTUM. Objects more than 96 m from the player go inactive.
`get_state_velocity` sets the leave-ground velocity (DEC:344455-344476, :343806); it does not drive walking.

### 1.5 Following a moving target (TargetManager, DEC:327974-328690)

**The target's side**
- It answers `AddVoyeur` at once (:328300).
- Every 0.5 s (`HandleTargetting` :328458), it sends an update when its predicted position — `pos + velocity ×
  quantum` (:328131) — has moved more than the voyeur radius (0.5) from the last one it sent (:328158).

**The mover's side**
- `HandleMoveToPosition`'s tail (:345695-345707) sets the quantum to `distance / |velocity|` when the quantum is off
  by more than 1 s. The target therefore reports where it will be when the mover arrives.
- If no answer arrives for 10 s, the mover's target info goes to status 6, TimedOut, and the MoveTo cancels.
- `MoveToManager::HandleUpdateTarget` (:346051):
  - the first OK builds the nodes;
  - later OKs on a MoveToObject refresh both positions and reset the progress stamps;
  - a non-OK status cancels with 0x37 (initialized) or 0x38.

Statuses (acclient.h:7264): Ok 1, ExitWorld 2, Teleported 3, Contained 4, Parented 5, TimedOut 6.

### 1.6 Sticky (StickyManager, DEC:388342-388722)

- **Installed by** MoveTo arrival with the Sticky bit, or by a case-0 sticky guid.
- **`StickTo`** arms `set_target(0, id, 0.5, 0.5)` and a 1.0 s timeout. `HandleUpdateTarget` (:388691) does NOT
  extend the timeout; only a fresh stick does.
- **`adjust_offset`** (:388519):
  - pulls toward `cylinder_distance_no_z − 0.3` at up to `5 × get_max_speed` (15 when there is no interp);
  - faces the target, with z zeroed.

### 1.7 What cancels a MoveTo

`CPhysicsObj::cancel_moveto` (0x36) is called from:
- the unpack preamble (:339518);
- `CMotionInterp::StopCompletely` (:343611), `StopMotion` (:344107) and `jump` (:344236);
- `move_to_interpreted_state` (:344391);
- every `DoMotion` whose params carry bit 0x8000 — that is all raw input (:344634);
- the StickyManager exits (:388514, :388619, :388679, :388711).

Other cancels: the teleport hook (0x3C), fail distance (0x3D), target loss (0x37/0x38) and a new directive (0x36).

All of these go through the object's ONE interp. That is why retail needs no per-lane cancel bookkeeping.

### 1.8 Handing the player to the server and back (CommandInterpreter)

Vtable slots were checked against the PDB.

**`LoseControlToServer` (DEC:716832)**
- Sets `controlled_by_server = 1`, then calls `SetAutoRun(0, 0)` (+204) and `FinishJump()` (+80).
- It does NOT clear the command lists. Held keys survive, and the reclaim re-applies them.

**`TakeControlFromServer` (DEC:716934)**
- Runs only if `controlled_by_server && autonomy && !PlayerIsDead`.
- Clears the flag and sets `last_move_was_autonomous = 1`.
- Calls `StopCompletely(player, 1)` and `StopInterpolating`.
- Calls `SetHoldRun(hold_run)` and `ApplyCurrentMovement`.

**Reclaim triggers**
- Any movement key: `MovePlayer` at LABEL_38 (DEC:717938).
- `UseTime` (DEC:717595), once `!motions_pending && !IsMovingTo` and a key-list head or autorun is set.

**Client-initiated MoveTo in retail:** only `CommandInterpreter::TurnToHeading` (DEC:718082). Melee and use
approaches are SERVER MoveTos:
- the ACE `Player.MoveTo` charge (`ACE/WorldObjects/Player_Move.cs:156-180`):
  CanCharge|FailWalk|UseFinalHeading|Sticky|MoveAway, `speed 1.5`, `fail_distance 15`;
- `CreateMoveToChain` (`:37-93`), with `distance_to_object = UseRadius` (`Player_Move2.cs:122`), polled server-side
  every 0.1 s;
- `Player_Melee.cs:170-212` picks between the two;
- ACE also simulates the charge on its own server physics (`MoveTo_Tick`).

---

## 2. OpenAC

### 2.1 Structure

- **`IPhysicsObjHost` / `EntityPhysicsHost`** (`OC/Motion/IPhysicsObjHost.cs`, `OR/Physics/EntityPhysicsHost.cs`):
  the CPhysicsObj seam — position, velocity, radius, contact, interp max speed, target/voyeur fan-out.
- **`MovementManager`** (`OC/Motion/MovementManager.cs`): types 1-5 → `MotionInterpreter`, 6-9 → `MoveToManager`,
  created lazily through a factory.
- **`MoveToManager`** (`OC/Motion/MoveToManager.cs`), an imperative line-by-line port:
  - `_DoMotion` = `adjust_motion` + `DoInterpretedMotion` on the body's interpreter (:869-878);
  - set-target / clear-target / target-quantum callbacks;
  - `StickTo`, `Unstick`, `MoveToComplete` and `MoveToCancelled` callbacks.
- **`TargetManager`** (`OC/Motion/TargetManager.cs`): voyeur table, 0.5 s throttle, 10 s staleness (:10-12, :162).
- **`StickyManager`, `PositionManager`, `RetailObjectManagerTail`** (`OC/RetailObjectManagerTail.cs`):
  HandleTargetting → `Movement.UseTime` → motion-table `UseTime` → `PositionManager.UseTime`.

### 2.2 Remote objects

**`RemoteInboundMotionDispatcher.Apply`** (`OR/Physics/RemoteInboundMotionDispatcher.cs:27-115`):
- runs the preamble (interrupt + unstick) and the style DoMotion;
- `RouteServerMoveTo` → `PerformMovement` for types 6-9;
- otherwise `MoveToInterpretedState` + the case-0 sticky.

**`RuntimeRemoteArming.EnsureRemoteMotionBindings`** (`OR/Physics/RuntimeRemoteArming.cs:214-298`): builds the
MoveToManager factory against the body (position, heading, contact, interp, velocity) and the host's TargetManager.

**`RuntimeRemotePhysicsUpdater.Tick`** (`OR/Physics/RuntimeRemotePhysicsUpdater.cs:125-519`), per frame:
1. root motion from the sequencer, × scale, on walkable (:176);
2. `ComposeOffset` with the InterpolationManager (:224), then `PositionManager.AdjustOffset`;
3. `UpdatePhysicsInternal`, then `ResolveWithTransition` — a full collision sweep (:279);
4. HitGround / LeaveGround;
5. `RetailObjectManagerTail` (:486), then `PositionManager.UseTime`.

### 2.3 The local player

- **`RuntimeServerControlledLocalMovement.TryApply`** (`OR/Session/RuntimeServerControlledLocalMovement.cs:51-102`):
  - skips the player's own autonomous echo;
  - sets `MyRunRate`, applies the style;
  - calls `PerformMovement` on the controller's `MovementManager`, the same interpreter keyboard input drives.
- **`PlayerMovementController`** (`OR/Gameplay/PlayerMovementController.cs`):
  - keeps a `_controlledByServer` flag; `TakeControlFromServer` (:919) runs on input edges and held keys (:1648);
  - movement comes from the animation sequencer's root motion, with state velocity as the fallback (:1882-1910).

### 2.4 OpenAC deviations from the decomp (don't copy these)

1. **`CylinderDistanceNoZ` is planar** (`OC/Motion/MoveToMath.cs:98-104`). Retail uses the 3-D distance minus the
   radii (`Position::cylinder_distance_no_z`). holtburger is right.
2. **`CylinderDistance` returns the radial gap** when the vertical gap is > 0 and the radial gap is ≤ 0
   (`MoveToMath.cs:81-96`). Retail returns the vertical gap. holtburger is right.
3. **`StickyManager.AdjustOffset` backs away** when deep inside the standoff (`else if (dist < 0f) delta = -delta`,
   `OC/Motion/StickyManager.cs:128`). Retail steps toward at the capped speed (DEC:388580-388591), and holtburger
   matches retail.
4. **The MoveTo contact gate is `body.OnWalkable`** (`OR/Physics/RuntimeRemoteArming.cs:262`). Retail uses CONTACT.
5. **`GetAdjustedMaxSpeed` formula** — see `openac-comparison-2026-10-04/4-remote-motion.md` D2.
6. **The top-level (parent) id is collapsed** to the target guid. holtburger does the same.
7. **`TakeControlFromServer` fires on any held persistent key** (:1648) without waiting for `!IsMovingTo`. Retail's
   `UseTime` waits; only `MovePlayer` reclaims at once, on a key press.

---

## 3. holtburger today

### 3.1 The pieces

| Layer | Where | What it does |
|---|---|---|
| Wire → world events | `HW/handlers/movement.rs:153-230`; `HW/handlers/player.rs:268-296` | **Remote:** stamp gates, an `EntityMovementEvent` per message, the motion snapshot, a direct heading set for TurnTo.<br>**Local:** `SelfServerControlledMotion` (non-autonomous only), plus `scene.set_local_server_controlled(true)` for non-Invalid directives. |
| Per-entity registry | `HC/movement/system.rs:1945`; `movement_manager.rs` | One `MovementManager { MotionInterp, MoveToManager, MotionTableManager }` per guid, the local player included. `apply_unpacked_movement` (:779) is retail's unpack_movement. |
| State machine | `HC/movement/move_to.rs` | Pure: `use_time(view) -> MoveToDriveOutput { do_motions, stop_motions, steer, set_heading, stick_to, completion, clear_target }`. Target pose polled each tick through `MoveToView::target_pos`. |
| Local realization | `system.rs:5215 drive_local_moveto`, `:5488 current_local_drive_control`; `HC/simulation.rs:282-392` | Steer → `AutonomousDriveIntent` (unit vector to the target, desired heading, turn omega) → transition. |
| Local extra lanes | `system.rs` `ServerControlledProjection` (:2514, :5515); pursuit queue (:4924); `HC/simulation.rs:599` | The projection fallback; JS/bot pursuits; the native-only server install with `ServerMoveToDrive`. |
| Remote realization | `system.rs:10316 drive_remote_movetos`; `HW/spatial/scene.rs:376-386, :5978-6010, :6199-6236`; `HW/spatial/types.rs:350` | Steer → `RemoteMoveToDrive` → the scene walks the body (4.0 × run rate / 3.12, × speed, along the facing, outdoors only) and turns it. |
| Remote idle motion | `HW/spatial/types.rs:461 state_velocity_local` | Computed from the WIRE snapshot (`body.motion_state`), not from the registry interp. |
| JS animation | `HWEB/src/lib.rs:8320 moveto_locomotion_hint`, `:27834` (kind 67); `scene3d/loop.js:3762 _armMotion`, `:3921 _armTurn`; `scene3d/entities.js:6492-6560, :11443, :12125, :12159`; `scene3d/remote_moveto_phase.js`; `app/local_auto_motion.js` | **Remote:** a hint at receipt + node phase events + hint re-apply + the COL-20 gate + the KIND_TURN ease.<br>**Local:** the packed autonomous-drive state replayed as clips. |
| JS behaviour | `scene3d/picking.js:596-640, :886, :1894-1900`; `scene3d/server_turn.js`; `scene3d/pursuit_monitor.js` | A sticky-melee approach + a 250 ms re-engage watch; legacy face loops (default off); a server-turn latch (default off); a pursuit monitor (flag defunct, reader still live). |

### 3.2 The local player: one directive, several lanes

**Web client today, all flags at their defaults:**
1. A non-autonomous `UpdateMotion` addressed to the player arrives.
2. `HW/handlers/player.rs` emits `SelfServerControlledMotion`.
3. `apply_movement_world_events_ungated` (`system.rs:9039`) installs the directive on the registry entry through
   `apply_unpacked_movement`, with the target's physics dims.
4. Every tick, `drive_local_moveto` (`:5215`) runs the state machine and converts its steer:
   - **Walk:** `desired_world_delta` = unit(target − self), `desired_heading` = the bearing, gait Run or Walk. The
     steer's `aux`, `backwards` and `speed` are ignored (the "R3 remote-only steer fields" comment at :5337).
   - **Turn:** zero delta + the node heading + an omega.
5. `current_local_drive_control` (:5488) scales by `resolved_manual_run_speed()` or `WALK_ANIM_SPEED`, unless
   `server_moveto_drive` is set.
6. `HC/simulation.rs:359-372` turns at that omega. Turn-only slices overshoot on purpose, so that `heading_greater`
   fires.
7. Animation: `localAutonomousMotion()` → `app/local_auto_motion.js`.

**The native CLI differs.** `ClientRuntime::handle_world_events` (`HC/messages.rs:84`) also calls
`simulation.handle_server_controlled_movement` (`HC/simulation.rs:599`). That queues a second install
(`enqueue_server_controlled_moveto`) carrying `ServerMoveToDrive` (wire run rate × `params.speed`), with the target's
`UseRadius` as its radius. When the driver is off or the target is unknown, it installs the legacy
`ServerControlledProjection` instead.

**Also running on the local player:**
- **JS-issued pursuits** — `pursueEntity`, `turnToEntity`, `moveToPosition`, used by the radial-menu Follow and the
  rynth bot. They reach the same registry manager through the pursuit queue (`system.rs:4924`), with synthesized
  params.
- **A client-side melee approach.** On a melee attack, picking.js engages the local StickyManager directly
  (`stickToEntity`, :603) and re-engages it from a 250 ms JS watch (:614). This runs in parallel with the server's
  own charge MoveTo.
- **Cancellation, re-implemented per lane:**
  - `manual_moveto_cancel_pending`, `local_pursuit_engaged`, the `last_manual_drive` restore;
  - the JS `cancelClientMove` helper, the teleport arm.

  Meanwhile the `MotionSideEffects.cancel_moveto` the interp computes is dropped: `let _effects =` at
  `system.rs:9053` and `:9107`, and the `effects` in `drive_local_moveto`/`drive_remote_movetos` are never read.

### 3.3 Remote objects: the scene moves the body, JS animates it

`drive_remote_movetos` (`system.rs:10316`) runs the same state machine for every registry entry. Its steer becomes a
`RemoteMoveToDrive` (`HW/spatial/types.rs:350`), which the scene carries out:
- **Walk:** along the body's facing at `4.0 × my_run_rate × speed` (run) or `3.12 × speed` (walk)
  (`scene.rs:376-386`) — the same constants for every creature.
- **Turn:** aux and node turns at the body's TurnRight omega × speed, × 1.5 when running (:6199-6236).
- **Limits:**
  - outdoors only: `ground_moves` skips `is_indoors()` (:5978);
  - no wall or object collision, only floor sampling;
  - not while an interpolation node or a sticky owns the body.

Idle remotes move by `state_velocity_local`, computed from the wire snapshot (`types.rs:461`). That is a second motion
source, independent of the registry interp the MoveTo writes to.

**JS animation for a remote MoveTo**
- The KIND_MOTION for a MoveTo envelope carries a static run/walk hint computed when the packet arrives
  (`lib.rs:8320`), so the run clip starts before the turn node has finished.
- Kind-67 phase events (`lib.rs:27834`, `remote_moveto_phase.js`) then correct the clip.
- `reapplyRemoteMoveToPhase` re-asserts the node motion after a re-sent hint (`loop.js:3841`).
- The COL-20 heading-error gate is still there as a fallback (`entities.js:11443`).

**TurnTo directives** additionally:
- push a KIND_TURN (`HWEB/src/session/messages/position.rs:1220-1281`) to the JS heading ease
  (`entities.js:12159`);
- set the entity rotation directly in the world handler (`HW/handlers/movement.rs:183-221`).

### 3.4 Authority and latches

| Concept | Retail | holtburger |
|---|---|---|
| Local player's motion state | One `CMotionInterp` | Three:<br>• the `MotionState` the CommandInterpreter seams compose (`system.rs:9989-10020`)<br>• `local_motion_interp` (`:1935`; jump checks + completions)<br>• the registry interp (`:1945`; wire + MoveTo) |
| A remote's motion state | One `CMotionInterp` | • the registry interp (MoveTo, wire)<br>• the wire snapshot `body.motion_state` (root motion, NETSYNC-3 turn)<br>• the JS rig state |
| Server control of the player | `CommandInterpreter.controlled_by_server` | • Rust `CommandInterpreter.controlled_by_server` (`command_interpreter.rs:448`)<br>• `scene.local_server_controlled` (only non-Invalid directives, `player.rs:273-284`)<br>• the JS `server_turn.js` latch (default off) |
| How a MoveTo moves the body | The object's own motion, through the CSequence | • local: `AutonomousDriveIntent`<br>• remote: `RemoteMoveToDrive`<br>• the projection lane<br>• the sticky approach |
| MoveTo animation | The same motion | • local: `local_auto_motion.js`<br>• remote: hint + phase + re-apply + COL-20 |
| Target position | TargetManager voyeur: 0.5 s / 0.5 m, with an ETA lead | Polled every tick from the entity or body. A 5 cm change gate resets the progress stamps (`move_to.rs:832`). |

### 3.5 Defects found

Severities are mine. "Verified" means traced in code; none of these were observed in a live session.

**D-1 — HIGH, verified in code.** On the web client, a server MoveTo for the local player ignores `params.speed` and
the wire run rate.
- **Why:**
  - `server_moveto_drive` is only set from a `ServerMoveTo` pursuit entry (`system.rs:5023`);
  - only `enqueue_server_controlled_moveto` (`:4166`) creates one;
  - only the native `simulation.handle_server_controlled_movement` calls it (`HC/simulation.rs:683`, reached from
    `HC/messages.rs:84`);
  - the wasm recv loop installs the directive only through `apply_movement_world_events`.
- **Effect:** `current_local_drive_control` falls back to `resolved_manual_run_speed()`. An ACE melee charge
  (`speed 1.5`) therefore runs at 1.0× in the browser, while ACE simulates it at 1.5×. Remote players' charges were
  fixed by moveto-5; the local player's charge on the web was not.
- **Fix:** take the drive speed from the active directive — its `movement_params.speed` and the registry interp's
  `my_run_rate` — not from a native-only side channel.

**D-2 — MED, verified in code, native CLI only.** The server MoveTo is installed twice, with different target sizes.
- **Why:**
  - `apply_unpacked_movement` installs it with the physics dims (`resolve_movement_target`,
    `HW/handlers/movement.rs:25`);
  - the next tick's `ServerMoveTo` re-install (`HC/simulation.rs:691`) cancels that install (0x36, latch dropped)
    and replaces it with `object_radius = UseRadius`, `height 0`;
  - ACE already puts `UseRadius` into `distance_to_object` (`ACE/WorldObjects/Player_Move2.cs:122`,
    `Creature.cs:276-285`), so it is counted twice.
- **Effect:** the player stops up to `UseRadius − physics radius` early. For a target with no UseRadius, such as a
  monster, the radius is 0 and the player pushes into it. The web and CLI clients behave differently for the same
  packet.

**D-3 — MED, verified in code.** The local MoveTo walks the direct bearing, not its facing.
- The remote lane walks along its facing, with the 20° aux deadband (moveto-3), WalkBackwards and `speed`
  (moveto-5). The local lane drops all three.
- So the local path differs from the path ACE's server-side MoveToManager computes for the same charge.

**D-4 — MED, verified in code.** A remote MoveTo indoors does not advance the body.
- The turn still runs, but `ground_moves` skips indoor bodies. A mob chasing in a dungeon moves only by UpdatePosition
  interpolation.
- Outdoors the walk has no wall or object collision, so a chaser can cut through buildings between updates.
- OpenAC sweeps every remote (`RuntimeRemotePhysicsUpdater.cs:279`).

**D-5 — LOW-MED, verified in code.** Target tracking is polled, not a voyeur.
- **Missing:**
  - no ETA lead (retail aims at where the target will be);
  - no 10 s no-answer timeout;
  - no ExitWorld / Teleported / Contained / Parented statuses; "entity gone" (→ 0x37) is the only failure.
- **Side effect:** the per-tick, 5 cm change-gated stamp reset means a MoveTo at a moving target never fails
  `CheckProgressMade`. That is harmless today, because nothing reads `fail_progress_count`, but it makes the arrival
  check run every tick.

**D-6 — LOW, verified in code.** Remote speeds are constants.
- 4.0 / 3.12 for every creature (`scene.rs:376-386`), and again in `state_velocity_local`.
- moveto-5 proposed a per-table velocity lookup next to the per-table turn omega (NETSYNC-3). It was not done.

**D-7 — MED, suspected; needs a look.** A remote TurnToObject probably sends KIND_TURN with heading 0.
- **Why:**
  - ACE never fills `DesiredHeading` for TurnToObject (`~/ace-server/Source/ACE.Server/Entity/Motion.cs:56-67`,
    `Network/Motion/TurnToObject.cs`, `WorldObjects/Creature_Navigation.cs:127-135`), so both wire headings are 0;
  - `position.rs:1234-1235` emits `t.desired_heading` anyway; its comment says "ACE pre-computes the toward-target
    heading", and it does not;
  - the world handler (`HW/handlers/movement.rs:200-221`) treats 0 as "face the target", but the JS ease target
    (`entities.js:12159`) gets heading 0.
- **When it would show:** with `?remoteMoveTo` on, the Rust turn rows probably overwrite the ease while the node turns.
  An NPC turning after the node ends, with the pump off, or across a landblock edge would ease toward heading 0.
- **Check on the 1070:** an NPC `Rotate`/`TurnTo` with `?remoteMoveTo=off`.

**D-8 — LOW, verified in code.** The melee approach runs on both the client and the server.
- `picking.js:1898` sticks the local player to the target and runs it up through the StickyManager.
- Meanwhile ACE issues its own charge MoveTo (`Player_Melee.cs:190-208`), whose unpack preamble unsticks the player.
- Retail has only the server's approach.

**D-9 — LOW, a doc error in code comments.** `scene3d/server_turn.js:33-34` says `LoseControlToServer` runs
`ClearAllCommands()` (vfptr[6]).
- The PDB puts offset 80 (`vfptr[6].OnLoseFocus`) at `FinishJump`; `ClearAllCommands` is offset 40.
- Retail keeps held keys while the server drives and re-applies them on reclaim.
- The JS `clearDrive` callback built on that comment would drop them if `?serverTurn` is ever turned on.

**D-10 — LOW, a documented deviation.** `scene.local_server_controlled` is raised only for non-Invalid directives
(`player.rs:273-284`). Retail calls `LoseControlToServer` for every applied non-autonomous movement of the player,
gestures included.

---

## 4. Side by side

| | Retail | OpenAC | holtburger |
|---|---|---|---|
| Per-object movement owner | `CPhysicsObj` + `MovementManager`, every object | `IPhysicsObjHost` + `MovementManager`, every body | A registry `MovementManager` per guid (bookkeeping only) + a `SpatialBody` (pose) + the JS rig |
| What MoveTo writes to | The mover's `CMotionInterp` | The body's `MotionInterpreter` | The registry interp (no effect on the body), plus a steer descriptor |
| What moves the body | Sequence root motion → PositionManager → transition | Same | **Local:** `AutonomousDriveIntent` → transition<br>**Remote:** `RemoteMoveToDrive` constants, outdoors only, no collision |
| Turn-node completion | Overshoot + snap | Same | Same in the state machine; the overshoot was added by hand in both realization lanes |
| Target updates | Voyeur, 0.5 s / 0.5 m, ETA lead | Voyeur (`TargetManager.cs`) | Polled every tick |
| Sticky | PositionManager, installed on arrival | Same | Rust StickyManager (local + remote) + legacy JS glue + JS melee approach |
| Animation | The same motion | The sequencer, driven by the interp | JS: hints, phase events, COL-20, `local_auto_motion.js` |
| Local control handoff | CommandInterpreter | `_controlledByServer` + TakeControlFromServer | Rust CommandInterpreter + scene latch + JS latch (off) |
| Cancel | From the one interp (DoMotion bit, StopCompletely, jump, …) | Same | Per lane (manual-cancel flag, JS `cancelClientMove`, teleport arm) |
| Client-initiated MoveTo | Only TurnToHeading | `RequestTurnToHeading` | `pursueEntity` / `turnToEntity` / `moveToPosition` (bot, Follow) + sticky melee |
| Remote MoveTo indoors | Yes | Yes | Turns only |
| Remote collision | Transition | `ResolveWithTransition` | Floor sampling only |
| Speeds | Motion table × speed | Sequencer root motion | Constants: 4.0/3.12 (remote), state velocity (local) |

---

## 5. Refactor proposal

### 5.1 Target shape

One per-object movement spine, the same for the player and every remote:

```
wire 0xF74C ─► SetObjectMovement gate ─► unpack_movement ──┐
local input ─► CommandInterpreter ─► DoMotion ─────────────┤
client API (bot, Follow) ─► PerformMovement ───────────────┤
                                                            ▼
              PhysicsObject (one per guid)
                MovementManager { MotionInterp, MoveToManager }   ← MoveTo's _DoMotion lands here
                PositionManager { Interpolation, Sticky, Constraint }
                TargetManager   { target_info, voyeurs }
                root motion = f(interp state, MotionTable)
              update_object(quantum), in retail order:
                root motion → PositionManager::adjust_offset → physics → transition
                → TargetManager::HandleTargetting → MovementManager::UseTime
                → MotionTableManager::UseTime → PositionManager::UseTime
                                                            │
              per-object events (interp state, motion-table nodes, pose) ─► the JS rig renders them
```

- **MoveToManager keeps its retail logic.** Its `_DoMotion` / `_StopMotion` go into the object's own interp.
  - The steer descriptor, `MoveToView` and the per-lane adapters go away.
  - `TargetInfo` events replace `view.target_pos`.
- **One motion function.** The body's motion comes from one function of the interp's interpreted state and the
  object's MotionTable. It is the same for keyboard walking, a server MoveTo, sticky and a remote's wire state.
- **The local player has ONE interp.**
  - The CommandInterpreter's DoMotion stream and the MoveTo both write into it.
  - Cancel falls out of `DoMotion`'s bit 0x8000, as in retail.
  - `controlled_by_server` lives only in the CommandInterpreter.
- **JS renders from per-object motion events**, not from MoveTo-specific hints.
- **Client-initiated MoveTos stay**, as `PerformMovement` calls on the local object with synthesized params (retail
  does the same for `TurnToHeading`). `pursuitStatus` reads the completion latch.

### 5.2 Decisions to make before coding

1. **Where the spine lives.**
   - **Option A:** move the motion stack into `holtburger-world`, so `SpatialBody` owns it and the scene steps every
     object in retail order. The stack is `motion_interp`, `move_to`, `params`, `movement_manager`,
     `motion_table_manager`, `interp_state`, `raw_state`. It depends only on common/protocol plus core's
     `movement_types` and world's `SelfMovementCapabilities`, so the move is feasible.
   - **Option B:** keep the stack in core and make the registry entry the owner, with core calling into the scene
     for each object.
   - **Recommendation: A.** Per-body stepping already lives in the scene (`step_remote_position_managers`), while the
     local player's stepping lives in core. A puts both in one place.
2. **The speed source.**
   - Retail travels by MotionData velocity × speed.
   - holtburger chose the `get_state_velocity` constants for the local walk: COL-10 found 3.12 m/s matches ACE, and the
     walk clip plays 1.199× faster to keep the feet in step.
   - Pick one function and apply it to every object. Census the non-human tables (RunForward / WalkForward
     velocity.y) before changing remote speeds.
3. **The remote collision budget.**
   - OpenAC sweeps every remote.
   - Start with bodies that have an active MoveTo or root motion within 96 m (retail's active radius), and measure on
     the 1070.
4. **The melee approach.** Drop the JS sticky-melee approach and rely on the server's charge, or keep it as an opt-in.
5. **JS animation authority.**
   - **Full move:** the JS rig plays whatever the per-object interp holds. This deletes the most code and carries the
     most visual risk.
   - **Narrow move:** keep KIND_MOTION for wire interpreted states and add MoveTo-only motion events.
6. **Native CLI parity.** The CLI shares holtburger-core, so the spine change reaches it automatically. Its UI may not
   need the JS half.

### 5.3 Phases

Each phase ships default-on with a `?flag=off` escape (the project's pattern), keeps the gate green, and names its
eye-test.

**P0 — independent fixes, now (small)**
- D-1: on wasm, take the local server MoveTo's speed from the directive.
- D-2: native — skip the second install, or give it the physics dims.
- D-9: correct the comment in `server_turn.js`.
- D-7: verify it first. If it is real, compute the bearing in `position.rs` as the world handler does, or skip
  KIND_TURN while the Rust pump owns the remote.

**P1 — TargetManager**
- Port `TargetManager` + `TargetInfo`: §1.5 has the whole decomp, and OpenAC's 238-line `TargetManager.cs` is a
  reference.
- Feed MoveTo and sticky through `HandleUpdateTarget`.
- Delete `MoveToView::target_pos`, `refresh_moveto_target` and the change gate.
- Low visual risk. Tests: voyeur cadence, the ETA quantum, the status codes.

**P2 — one interp for the local player**
- Merge `local_motion_interp` and the system `motion_table_manager` into the local registry entry.
- Route the CommandInterpreter's DoMotion/StopMotion into that interp (raw → interpreted via `apply_raw_movement`).
- Derive the `MotionState` the integrator needs from the interp.
- Let cancel come from the interp. Delete `manual_moveto_cancel_pending`, the `last_manual_drive` restore (retail
  re-applies held keys in `TakeControlFromServer`) and the native double install.
- Keep `controlled_by_server` in the CommandInterpreter only.
- Risk: local movement feel. The wire sends are unchanged (the `2026-06-11-unified-movement-pipeline/DESIGN.md` §4
  invariants).
- Eye-test: walking, running, strafing, jumping, casting while moving, a use from distance.

**P3 — the body moves by its motion (the core of the refactor)**
- One root-motion function from the interp state, for every object.
- **Local:** a MoveTo's RunForward and aux turn become velocity along the facing plus omega, through the same
  integrator path keyboard input uses. Delete:
  - the MoveTo `AutonomousDriveIntent` and the steer descriptors;
  - the overshoot special case;
  - the `ServerMoveToDrive` and projection lanes;
  - `stall_recovery.rs`'s steer hook (the bot keeps its own wedge recovery, above the API).
- **Remote:** the scene reads the body's interp instead of `body.motion_state`. Delete `RemoteMoveToDrive`,
  `remote_moveto_forward_speed` and `remote_moveto_turn_delta`.
- Eye-test: a use from distance, a melee charge (×1.5), a monster chase and turn-in-place, an NPC TurnTo.

**P4 — remote collision and indoors**
- Run the transition for remote bodies that have motion, indoors included.
- Watch the cost with crowds.
- Eye-test: a chase in a dungeon, a chase around a building.

**P5 — the JS rig follows the per-object interp**
- One event stream per object: style, forward / sidestep / turn command + speed, the action queue.
- Delete:
  - the MoveTo hint (`moveto_locomotion_hint`), kind 67 and `remoteMoveToHintReapply`;
  - COL-20 and `local_auto_motion.js`;
  - the KIND_TURN-for-TurnTo path and the F3-4 JS glue;
  - the face loops and `pursuit_monitor.js`.
- The highest visual risk: keep `?flag=off` until a 1070 pass.

**P6 — client-initiated MoveTo on the spine**
- `pursueEntity` / `turnToEntity` / `moveToPosition` become `PerformMovement` calls.
- Settle the sticky melee approach (decision 4).
- The radial-menu Follow and the rynth bot keep working through the same API.

**P7 — clean up**
- Retire the flags and consts in Appendix A.
- Update `url-flags.md` and PARITY-STATUS.

**Order:** P0 → P1 → P2 → P3 → P5 → P4 / P6 → P7.
- P1 can run alongside P0.
- P3 needs P2, because the local MoveTo must write the interp the integrator reads.
- P5 needs P3's events.

### 5.4 What stays as it is

- `move_to.rs`'s state-machine logic and its 21 tests; `params.rs` (`get_command`, `heading_diff`/`heading_greater`,
  `from_wire_*`); `move_to_nodes.rs`.
- `apply_unpacked_movement` in `movement_manager.rs` (the unpack semantics).
- `motion_interp.rs`: `adjust_motion`, `apply_run_to_command`, the DoInterpretedMotion lattice.
- `HW/spatial/position_manager.rs` (interpolation, sticky, constraint), the transition code, the wire stamp gates.
- The decomp-cited tests, and the oracle captures in `HWEB/harness/fixtures/oracle/`. Those include retail-session
  MoveToPosition and TurnToHeading packets, usable as unpack fixtures.

### 5.5 Size

These are estimates from reading, not measurements.

- **Rust removed or replaced:** about 2.5–3.5k lines.
  - the system.rs MoveTo lanes, about 1.5k;
  - the simulation.rs projection, about 250;
  - the scene.rs remote drive, about 400;
  - the move_to.rs adapters, about 300;
  - the lib.rs/position.rs hints and KIND_TURN, about 400.
- **JS removed:** about 1.5k lines — `remote_moveto_phase.js`, `local_auto_motion.js`, `pursuit_monitor.js`, the
  picking.js face loop and sticky watch, the `server_turn.js` latch, the entities.js/loop.js glue.
- **New code:** about 2–3k lines including tests — the per-object spine and update order, TargetManager, the
  root-motion function, the JS motion-event consumer.
- **Tests touched:**
  - about 90 Rust tests mention MoveTo: move_to 21, movement_manager 18, system 32, world spatial 19;
  - plus 8 JS suites;
  - the state-machine tests survive; the system-level ones get rewritten against the spine.

### 5.6 Laptop and process

- Every phase needs wasm rebuilds and the full gate.
  - One heavy job at a time, under `capped-build`.
  - A release wasm before any measurement (about 6 min).
  - No rustfmt on `lib.rs`.
- Agents edit and run targeted tests only; the orchestrator builds.
- Eye-tests join the 1070 queue, batched.

---

## Appendix A. Flags and consts in the MoveTo area

| Name | Kind | Default | What it gates |
|---|---|---|---|
| `USE_MOVETO_DRIVER` | Rust const (`move_to.rs:53`) | true | The local MoveTo driver |
| `USE_SERVER_MOVETO_DRIVER` / `?serverMoveToDriver` | const (`system.rs:552`) + URL | on | Driver vs the projection lane (native install path) |
| `USE_UNPACK_MOVEMENT_SEMANTICS` | const (`movement_manager.rs:52`) | true | The per-entity registry |
| `USE_STICKY_MANAGER`, `USE_STICKY_IDLE_STEP` / `?stickyIdleStep` | consts + URL | on | The local/remote StickyManager; the idle sticky step |
| `?remoteMoveTo` | URL (Rust parse) | on | `drive_remote_movetos` + the scene drive |
| `USE_REMOTE_MOVETO_FACING` | const (`scene.rs:348`) | true | Walk along the facing (no URL) |
| `?remoteMoveToPhase` | URL (wasm + JS) | on | Kind-67 phase events |
| `?remoteRootMotion`, `?remoteInterp`, `?stickyRetail`, `?remoteTurnGateFix` | URL | on | Remote root motion, interpolation, the Rust remote sticky, COL-20 |
| `?localAutoMotion` | URL (JS) | on | The local rig plays the autonomous drive |
| `?combatRadii` | URL | on | Retail Setup radii for MoveTo/sticky |
| `?teleportHook` | URL | on | Teleport cancels the MoveTo (0x3C) |
| `?serverTurn` | URL (JS) | **off** (adjudicated) | The JS LoseControlToServer latch |
| `?missileFaceTarget`, `?castFaceTarget`, `?castReface` | URL (JS) | off | Legacy JS face loops |
| `?meleeFaceTarget`, `?stickyGroundZ` | URL (JS) | on | Snaps for remote melee facing; keeps the sticky mob grounded |
| `?wasmPursuit` | URL (JS) | defunct, reader still live | `pursuit_monitor.js` |
| `?wireStatePacks`, `?unifiedTick`, `?cmdInterp` | URL | on | The routes the above sit on |

## Appendix B. Main citations

**Decomp (DEC)**
- MoveToManager:
  - `_DoMotion` 344753, `CheckProgressMade` 344833, `GetCurrentDistance` 344856;
  - `MoveToObject` 345184, `TurnToObject` 345242, `CancelMoveTo` 345297;
  - `BeginMoveForward` 345371, `BeginTurnToHeading` 345456, `BeginNextNode` 345521, `HitGround` 345570;
  - `HandleMoveToPosition` 345577, `HandleTurnToHeading` 345712;
  - `MoveToPosition` 345790, `MoveToObject_Internal` 345859, `TurnToObject_Internal` 345911, `TurnToHeading` 345954;
  - `UseTime` 346018, `HandleUpdateTarget` 346051, `PerformMovement` 346119;
  - `get_command` 346175, `heading_greater` 344715.
- MovementManager: `PerformMovement` 339175, `unpack_movement` 339492; `MovementParameters` ctor 339437.
- TargetManager: `SendVoyeurUpdate` 328092, `GetInterpolatedPosition` 328131, `CheckAndUpdateVoyeur` 328158,
  `AddVoyeur` 328300, `ReceiveUpdate` 328385, `HandleTargetting` 328458, `SetTarget` 328574.
- StickyManager: `adjust_offset` 388519, `UseTime` 388605, `StickTo` 388665, `HandleUpdateTarget` 388691.
- CPhysicsObj: `cancel_moveto` 317421 and its callers; `UpdatePositionInternal` 319989; `UpdateObjectInternal`
  322719; `update_object` 323081.
- `CPhysics::SetObjectMovement` 311149; the 0xF74C dispatch 392812.
- CommandInterpreter: `LoseControlToServer` 716832, `TakeControlFromServer` 716934, `UseTime` 717595, `MovePlayer`
  717800, `TurnToHeading` 718082. Vtable offsets come from `acclient.txt` field list `0xc215`.

**OpenAC**
- `OC/Motion/MoveToManager.cs`, `TargetManager.cs`, `StickyManager.cs`, `MovementManager.cs`, `MoveToMath.cs`,
  `IPhysicsObjHost.cs`
- `OR/Physics/RemoteInboundMotionDispatcher.cs`, `RuntimeRemoteArming.cs`, `RuntimeRemotePhysicsUpdater.cs`,
  `EntityPhysicsHost.cs`
- `OR/Session/RuntimeServerControlledLocalMovement.cs`, `OR/Gameplay/PlayerMovementController.cs`

**ACE**
- `WorldObjects/Player_Move.cs` (`CreateMoveToChain` 37, `MoveTo` 156, `GetChargeParameters` 233)
- `Player_Melee.cs` 166-212, `Player_Move2.cs` 122, `Creature.cs` 276-298
- `~/ace-server`: `Entity/Motion.cs` 56, `Network/Motion/TurnToObject.cs`, `TurnToParameters.cs`,
  `WorldObjects/Creature_Navigation.cs` 127-180

**Earlier holtburger work this builds on**
- `openac-comparison-2026-10-04/4-remote-motion.md` (D1-D8)
- `openac-comparison-2026-10-08/round1-findings.json` (moveto-1..6)
- `2026-06-11-unified-movement-pipeline/DESIGN.md` (Stage 3)
