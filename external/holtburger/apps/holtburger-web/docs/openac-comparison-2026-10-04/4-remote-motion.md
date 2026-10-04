# 4 — Remote entity motion: holtburger vs OpenAC vs retail decomp

Read-only study, 2026-10-04. Every file:line below was opened and checked.
Path abbreviations:
- `HW` = external/holtburger/crates/holtburger-world/src
- `HWEB` = external/holtburger/apps/holtburger-web
- `OC` = external/OpenAC/src/AcDream.Core/Physics
- `OR` = external/OpenAC/src/AcDream.Runtime/Physics
- `DEC` = ~/ac-headers/acclient.c

## 0. How holtburger moves a remote today (all flags at their defaults)

1. **The wire arrives.** UpdatePosition (0xF748) goes to `HW/state/mutations.rs:891 apply_entity_position_pack`, then `HW/entity.rs:1064 apply_server_position_update`, which applies the teleport/force/position sequence gate. Next, `emit_entity_position_sync` (mutations.rs:621) calls `HW/spatial/scene.rs:4681-4757`. That function ports the retail `MoveOrTeleport` lattice:
   - teleport → hard set
   - `!contact` → no-op
   - player distance ≥ 96 m → snap
   - otherwise → `remote_interpolate_to` with blip distance 20 (indoor) or 100 (outdoor)
2. **Every frame.** `HW/spatial/scene.rs:4833 step_remote_position_managers` steps the retail InterpolationManager queue (`HW/spatial/position_manager.rs:212-640`) and exports "managed rows". In JS, `HWEB/scene3d/entities.js:6175 applyManagedPose` writes `root.position` and arms a 30-frame `_wasmDriven` ownership countdown (`entities.js:6187`).
3. **In parallel, JS gets its own copy.** JS ALSO receives an unconditional KIND_POSITION for every UpdatePosition (`HWEB/src/lib.rs:45773-45774`). `setPose` (entities.js:6227+) eases the heading toward the wire quaternion. When not `_wasmDriven`, it also eases position (k=12) toward `_serverTargetPos` (entities.js:14900-14927). That target is extrapolated by VectorUpdate velocity, which ACE sends only for player jumps and projectile stops.
4. **What is never applied:**
   - per-frame animation/locomotion root motion
   - a client-side MoveToManager for remotes
   - gravity
   - terrain or collision sweep
   
   Holtburger's own comment says so: "Our remote creatures are never in the solver at all" (entities.js:575-577). It also says the remote MovementManager registry is only pumped for completions (`holtburger-core/src/client/movement/system.rs:4040-4063`, 8072-8085; the `_effects` are discarded).

**Retail does more per frame** (`DEC:CPhysicsObj::UpdatePositionInternal`; `rg -an 'CPhysicsObj::UpdatePositionInternal\('`). For EVERY object:
- `offset = CPartArray::Update(quantum)`, i.e. sequencer root motion, multiplied by `m_scale` when ON_WALKABLE and zeroed when not
- then `PositionManager::adjust_offset` (interp REPLACES the offset while its queue is non-empty, then sticky, then constraint)
- then `Frame::combine`
- then `UpdatePhysicsInternal` (velocity + gravity) and the transition sweep

OpenAC reproduces this in `OR/RuntimeRemotePhysicsUpdater.cs:176-179` (root motion × scale, gated on walkable), `:216-258` (ComposeOffset with interp + PositionManager, then `calc_acceleration`/`UpdatePhysicsInternal`) and `:274-296` (`ResolveWithTransition`, with step-up/down per remote).

---

## Divergences (ranked by visible impact)

### D1. No locomotion root motion between UpdatePositions → stop-go sliding, legs running in place
- **Symptom:** remote PLAYERS show the strongest stop-go: retail clients send AutonomousPosition about once a second (`CommandInterpreter::ShouldSendPositionEvent`; `time_between_position_events` = 1.0 s, set at `DEC:717777-717778`). Monsters do it more mildly: ACE monster tick is 0.2 s (`Monster_Tick.cs:10`, `Movement()` → `UpdatePosition()` → `SendUpdatePosition`, Monster_Navigation.cs:252-263). The rig catches up to each node, then STOPS dead until the next update, while the run cycle keeps playing (velScale uses the motion-state getter, not the observed displacement), so it looks like ice-skating or treadmilling.
- **Mechanism:** holtburger moves a remote only through (a) the interp queue or (b) the JS ease toward the last wire pose. Once the queue drains, nothing advances the body. Retail keeps advancing the body by the cycle's root-motion velocity (RunForward ≈ 4.0 × speed) every frame, and the interp queue only corrects.
- **OpenAC:** `OR/RuntimeRemotePhysicsUpdater.cs:176-179`, `:216-235`; `OC/RemoteMotionCombiner.cs:8-35` (the root-motion frame is copied into the output, and interp overwrites it only when active). Tests: `RemoteMotionCombinerTests.ComputeOffset_AnimationOnly_Forward_BodyAdvances`, `ComputeOffset_BothActive_CorrectionReplacesRootMotion`.
- **holtburger:** absent. `HW/spatial/scene.rs:4859-4885` steps only `queue_active()` bodies. The JS `_applyRootMotionToAnchor` (entities.js:12734-12800) applies one-shot overlay net displacement at clip completion only, never locomotion cycles.
- **Decomp:** `CPhysicsObj::UpdatePositionInternal` (CPartArray::Update → PositionManager::adjust_offset → Frame::combine).
- **Confidence:** HIGH.
- **Fix:** in `step_remote_position_managers`, for an `Entity` body whose queue is idle and that has last-wire contact:
  - compute the local velocity from the entity's interpreted motion snapshot. The math already exists as wasm `stateGroundSpeed` / `get_state_velocity` (lib.rs:8118-8183). Use the forward and sidestep commands and speeds plus the per-entity run rate.
  - rotate by `body.pose.rotation`, add `v·quantum`, and push a managed row.
  - when the queue is active, keep the existing replace semantics, which already match retail.
  
  This also makes D2's catch-up rarely needed.

### D2. Interp catch-up speed hard-wired to 7.5 m/s → permanent lag, and accumulating lag for fast mobs
- **Mechanism:** `HW/spatial/scene.rs:4869` calls `step_remote(body.pose, quantum, 0.0, on_contact)`, so `adjust_offset_core` floors to `MAX_INTERPOLATED_VELOCITY = 7.5` (`HW/spatial/force_position_interp.rs:61`; position_manager.rs:427-431).
  - Retail uses `my_max_speed = get_adjusted_max_speed() × 2` (`DEC:389178 InterpolationManager::adjust_offset`, with `fUseAdjustedSpeed_ = 1` at `DEC:45657`). `get_adjusted_max_speed` (`DEC:343512`) = `(forward==RunForward ? forward_speed/current_speed_factor : my_run_rate) × 4.0`.
  - So a run-rate-1.5 mob catches up at 12 m/s in retail; holtburger never exceeds 7.5.
  - Any remote moving faster than 7.5 m/s (fast mobs, run-buffed players) falls further behind on every update. The queue fills to 20 nodes and head-pops, so the mob is drawn metres behind its real position. It then "attacks from range" or arrives and rubber-bands.
  - The same constant also loosens the 30%-progress stall test, so stalls that retail would recover from via blip are not detected.
- **Already known:** the per-creature run rate is parsed and shipped to JS for animation tempo only (`HWEB/src/lib.rs:47448-47464`, the `vx` field). It never reaches the Rust interp.
- **OpenAC:** `OC/InterpolationManager.cs:303-304` (`scaled = maxSpeedFromMinterp*2`); the caller passes `rm.Motion.GetAdjustedMaxSpeed()` (`OR/RuntimeRemotePhysicsUpdater.cs:223`).
  - **Do NOT copy OpenAC's `GetAdjustedMaxSpeed` (`OC/MotionInterpreter.cs:1041-1052`). It is buggy:** the non-RunForward branch returns `rate` without `×4.0`, and the RunForward branch omits `/current_speed_factor`. Use the decomp formula.
- **Confidence:** HIGH (code path verified; 7.5 < 8 even at run rate 1.0).
- **Fix:** store a per-body `my_run_rate` (from MoveTo `run_rate`, plus RunForward `forward_speed`), compute the retail adjusted max speed, and pass `×2` into `step_remote`.

### D3. Rust sequence gate is bypassed by the JS lane: every UpdatePosition reaches `setPose`, even stale or rejected ones
- **Mechanism:** the KIND_POSITION `EntityUpdate` is pushed unconditionally (`HWEB/src/lib.rs:45773-45774`), even when `apply_server_position_update` returned `Rejected` (stale position, older teleport, or `!contact`). In JS, `setPose`:
  - (a) retargets the heading ease to the stale quaternion (6290-6305)
  - (b) clears `_stickyTarget` on ANY position frame (6257)
  - (c) when not `_wasmDriven`, eases position to the stale or airborne pose (6340-6385)
  
  Retail drops these frames entirely (`SmartBox::HandleReceivedPosition` `DEC:145125-145240`; `CPhysicsObj::newer_event` `DEC:143015`; `MoveOrTeleport` returns 0 on `!contact`, `DEC:323480-323481`).
- **Symptoms:** heading flicks or face-wrong-way on reordered packets; a melee mob drifts toward an outdated spot; the JS sticky glue is dropped.
- **OpenAC:** `OC/PhysicsTimestampGate.cs:132-164` gates everything before any consumer sees it.
- **Confidence:** HIGH that the gap exists. MEDIUM on frequency (it needs UDP reorder or duplication; the `!contact` arm fires on every airborne remote frame).
- **Fix:** carry `accepted` (and the outcome) into the KIND_POSITION row, or emit KIND_POSITION from the world `EntityMoved`/`ForcedReposition` events instead of the raw recv arm.

### D4. Snaps are swallowed while `_wasmDriven > 0` → a hard reposition lands up to one update late, or never
- **Mechanism:** Rust hard-sets `body.pose` on the teleport/Reset arm (scene.rs:4694-4699) and on the ≥96 m far-snap (4711-4716), and `stop()`s the queue. That pose is NOT inserted into `remote_stepped_poses` (the only insert is scene.rs:4924), so no managed row is exported. JS `setPose` returns early for position whenever `_wasmDriven` (entities.js:6310, 6360, 6390), for up to 30 frames. When that decays, the legacy ease resumes toward `_serverTargetPos`, which `applyManagedPose` last re-anchored to the OLD interp pose (6188-6191).
- **When it hits:** ACE sends a teleport-stamped UpdatePosition at the first swing of every melee engagement (`Monster_Melee.cs DoSwingMotion: SendUpdatePosition(true)` → `adminMove` → `GetNextSequence(ObjectTeleport)`, PositionPack.cs:46-49). The retail client hard-snaps the mob to its true attack spot right then. Holtburger keeps drawing it at the lagged interp spot, which feeds "attacks in place / from range".
- **Confidence:** HIGH (code path); MEDIUM-HIGH (visible).
- **Fix:** on every Rust-side hard set (Reset, far-snap, `use_time` blip, deadband stop), insert into `remote_stepped_poses` so JS receives a managed row. Alternatively, make `setPose` honor `ForcedReposition` regardless of `_wasmDriven`.

### D5. No client-side MoveToManager for remotes → pursuit/facing driven only by server cadence
- **Mechanism:** retail runs `MoveToManager::UseTime` for remote objects too, after `MovementManager::unpack_movement` type 6/7/8/9. A chasing mob steers toward the target's live client-side position each frame, with RunForward and aux turns (holtburger's own notes cite `HandleMoveToPosition :345636`). Retail also interpolates with `keep_heading = IsMovingTo()` (`DEC:323492-323495`; `CPhysicsObj::IsMovingTo` `DEC:315822`), so the server heading never fights the client steer.
- **holtburger:**
  - The remote MovementManagers are created but their effects are discarded (system.rs:8079-8085), so there is no remote MoveTo stepping.
  - `keep_heading=false` is hard-coded (scene.rs:4734).
  - The heading comes from the 5 Hz wire quaternion, eased at K=14 (entities.js:6290-6305, 14970-14995).
  - TurnToHeading/TurnToObject snap the world rotation instantly (`HW/handlers/movement.rs:141-176`; `state/mutations.rs:1504`). The JS `?turnOmega` cap smooths it, but there is no per-frame turn toward a moving target. The TurnToObject target heading is computed only when both are in the same landblock (`movement.rs:149-157`).
- **Symptoms:** a mob faces where the player WAS (strafing around a mob shows it lagging and facing the wrong way); the chase path cuts corners behind a kiting player.
- **OpenAC:** a MoveToManager per remote (`OR/RuntimeRemoteArming.cs:246-270`, with `isInterpolating: () => remote.Interp.IsActive`). `OR/RemoteServerControlledVelocityCycle.cs` skips its heuristics when `rm.MoveTo` is armed.
- **Confidence:** HIGH (absence); MEDIUM (magnitude).
- **Fix (staged):**
  1. Pass `keep_heading = entity has an active MoveTo directive`.
  2. Drive the remote registry's MoveTo heading-only per frame toward the resolved target pose. The local-player MoveToManager port already exists in holtburger-core movement/move_to.rs.
  3. Later, add positional MoveTo plus D1 root motion.

### D6. Remote sticky lane is radius-blind (0.0/0.0) → mob glued 0.3 m from the target centre
- **Mechanism:** `stick_to(target, 0.0)` and `step_sticky_pose(.., my_radius 0.0, ..)` are at `HW/spatial/scene.rs:4903, 4914-4915, 4962`. Retail and OpenAC use `cylinder_distance_no_z(own_radius, self, target_radius, target) − 0.3` (`OC/Motion/StickyManager.cs` AdjustOffset). Holtburger documents this itself and papers over it with the JS creature-separation push-out (entities.js:6193-6211). ACE stops position broadcasts while sticky (`Monster_Tick.cs:118-119 UpdatePosition(false)`), so this lane alone places the mob during melee.
- **Confidence:** HIGH.
- **Fix:** feed `state.combat_part_dims(target)` (already used for MoveTo, `handlers/movement.rs:31-36`) and the holder's own dims into `stick_remote_entity_to` and `step_sticky_pose`. Then the JS separation clamp becomes a no-op guard.

### D7. No remote physics: no gravity, no terrain/collision sweep → jump arcs float, Z cuts terrain between nodes
- **Mechanism:**
  - Remote Z is the straight-line interp between wire poses, or the k=12 ease; there is no terrain snap (loop.js:3396-3404 states that the server Z is used directly).
  - Remote jumpers get VectorUpdate velocity extrapolated LINEARLY for 500 ms without gravity (entities.js:14904-14920, `ENTITY_VELOCITY_STALE_MS`). The only gravity in entities.js is for projectiles (14591).
  - Retail ignores `!contact` positions and integrates `set_velocity` + gravity with collision (`SmartBox::DoVectorUpdate` → `UpdatePhysicsInternal`).
  - OpenAC sweeps every remote through `ResolveWithTransition` with step-up/down (`OR/RuntimeRemotePhysicsUpdater.cs:274-296`). Tests: `RuntimeRemoteSlopeProjectionTests.TheRemoteTickTracksTheSurfaceWhileRunningDownhill`, `RuntimeRemoteUphillProgressTests.ARemoteWithABodyClimbsAWalkableSlopeAndKeepsItsFeetOnIt`.
- **Symptoms:** remote jumps rise linearly and then pop; small sink or float over crests and valleys between sparse remote-player updates (most visible together with D1 root motion over 1 s gaps).
- **Confidence:** HIGH (absence); LOW-MEDIUM (magnitude for monsters at 5 Hz, higher for remote players).
- **Fix:**
  - When adding D1 root motion, clamp Z to the terrain sampler (`terrain_oracle`/heightfield) for outdoor contact bodies.
  - For airborne remotes, integrate `−9.8 z` on the VectorUpdate velocity until the next contact position, and ignore `!contact` wire poses in JS (see D3).

### D8. UpdateMotion has no timestamp gating for remotes
- **Mechanism:** `HW/handlers/movement.rs:116-176` applies every UpdateMotion. Retail requires:
  - the same instance
  - `movement_ts` strictly newer
  - `server_control_ts` not older (`CPhysics::SetObjectMovement`, cited in holtburger's own server_turn.js header; OpenAC `OC/PhysicsTimestampGate.cs:98-110`)
  
  Holtburger gates the local player only (`HW/player/mutations.rs:304`). Remote `entity.sequences[1]` is never checked or advanced.
- **Symptom:** a duplicated or reordered stale MoveTo, Ready, or attack replays, so a mob re-attacks after death or snaps back to Ready mid-run (rare, but a "freeze" source).
- **Confidence:** HIGH (absence); LOW (frequency).
- **Fix:** add `Entity::accept_movement(instance, movement_ts, server_control_ts)`, mirroring OpenAC, and early-return in both UpdateMotion arms and the 0xF619 movement half.

### D9. Position gate details differ from retail
- **Instance timestamp is overwritten, never checked** (entity.rs:1122). Retail drops an older instance and defers a newer one (`SmartBox::UnpackPositionEvent`, `DEC:145257-145291`).
- **Force-position timestamp is applied to remotes.** It can reject a frame (entity.rs:1053-1058), and an advance triggers a hard Reset (entity.rs:1132). Retail consults FORCE_POSITION_TS only when `object == player` (`DEC:145157-145165`). For a remote, a force advance just interpolates. ACE bumps ObjectForcePosition only for players (Player.cs:1148, Player_Tick.cs:488), so other PLAYERS hard-snap where retail glides.
- **The position timestamp is skipped when teleport/force advanced** (entity.rs:1113). Retail always requires `newer_event(POSITION)` first (`DEC:145167`).
- **AutonomousPosition (`position_sequence=None`) always Resets** (entity.rs:1132).
- **Confidence:** HIGH (code); LOW-MEDIUM (impact).
- **Fix:** split the remote gate from the player gate exactly as in `HandleReceivedPosition`.

### D10. (Minor) Dead or ragdolled rigs can still be moved by managed rows
`applyManagedPose` (entities.js:6175-6191) checks `_ballistic`, `_stickyTarget` and parenting, but not `_deadFrozen`. That flag gates only the separation call (6205-6208), so a queue still draining at death moves a collapsed corpse. **Fix:** early-return on `inst._deadFrozen`. Confidence: MEDIUM.

---

## Where holtburger already matches retail (do not "fix")
- **Remote MoveOrTeleport lattice:** teleport → set; `!contact` → no-op; ≥96 m → `SetPositionSimple` + `StopInterpolating`; else `InterpolateTo` + `ConstrainTo` anchored on own pose (scene.rs:4694-4748 vs `DEC:323451-323498`, 145223-145227).
- **InterpolationManager queue:**
  - blip 20/100 for non-players (scene.rs:299-300 vs `CPhysicsObj::GetAutonomyBlipDistance` `DEC:315861`)
  - tail-dedupe 0.05, cap 20 head-pop, beyond-blip `fail=4`
  - 5-frame / 30% stall test, `<0.2` complete, `NodeCompleted` reseed, contact gate, offset REPLACE

  All of this is in position_manager.rs:212-560, matching `DEC:389017-389276`.
- **No 4 m snap:** OpenAC adds a non-retail 4 m body-snap (`OR/RuntimeRemoteSteadyStatePosition.cs:10`) and a 0.6 s stale-velocity cycle heuristic (`OR/RuntimeRemotePhysicsUpdater.cs:12`, `RemoteServerControlledVelocityCycle.cs`). Both are OpenAC conveniences, not decomp behaviour. Holtburger's pure retail blip queue is closer there.
- **Retail ignores UpdatePosition velocity for remotes** (`MoveOrTeleport` never reads `velocity`). Holtburger stores it on the entity (mutations.rs:910-923). It only reaches JS as KIND_VELOCITY from real VectorUpdates (lib.rs:47745-47808), so no double-move results.

## Suggested order of work
1. **D2** (one-line plumbing + formula)
2. **D4** (export a row on snap)
3. **D3** (gate KIND_POSITION)
4. **D1** (per-frame state-velocity root motion for idle-queue remotes, plus Z clamp)
5. **D6** (radii)
6. **D5** (`keep_heading` + remote MoveTo heading steer)
7. **D8 / D9 / D7 / D10**

D1+D2 together remove most of the "slide/stop-go/attack-from-range" class.
