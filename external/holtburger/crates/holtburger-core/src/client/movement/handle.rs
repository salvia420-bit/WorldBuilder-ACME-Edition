use super::jump_charge::{JumpOutcome, JumpRefusal};
use super::system::MovementSystem;
use crate::client::movement_types::{MotionStyle, PlayerDriveIntent};
use anyhow::Result;
use holtburger_common::Guid;
use holtburger_protocol::messages::movement::InterpretedMotionCommand;
use holtburger_session::{ActionSink, Session};
use holtburger_world::{WorldEvent, WorldState};
use std::time::Duration;
use web_time::Instant;

/// Wasm-friendly facade over the cli's internal `MovementSystem`. Exposes
/// only the four methods the web bundle needs to drive the full movement
/// loop (login → spawn → WASD → AutonomousPosition heartbeat → server-side
/// position updates). Cli call sites continue to use `MovementSystem`
/// directly; this shim is the *only* path web bundles use.
///
/// Design and motivating gap (web bundle never sent AutonomousPosition,
/// so server-side player position never advanced past `@telepoi` spawn):
/// see `docs/phase-4-step-3.6-movement-system.md`.
pub struct MovementSystemHandle {
    inner: MovementSystem,
    last_tick_at: Option<Instant>,
    tick_count: u32,
}

impl MovementSystemHandle {
    pub fn new() -> Self {
        Self {
            inner: MovementSystem::new(),
            last_tick_at: None,
            tick_count: 0,
        }
    }

    /// Queue a player drive intent (e.g. WASD-held → `PlayerDriveIntent::
    /// ManualHeld(MotionState)`). Processed on the next `tick` call.
    pub fn enqueue_drive_intent(&mut self, intent: PlayerDriveIntent, now: Instant) {
        self.inner.enqueue_drive_intent(intent, now);
    }

    /// Queue a one-shot transient motion pulse — a single
    /// `MoveToState` packet edge with the given command (typically
    /// `InterpretedMotionCommand::STOP` for a stance-only change)
    /// and `motion_style` (typically `MotionStyle::Explicit(stance)`
    /// to set the player's stance to a specific
    /// `MotionStance`). Processed on the next `tick` call; takes
    /// precedence over the active drive for that tick so the active
    /// WASD movement isn't disturbed.
    ///
    /// Used by the web bundle to wire combat-stance hotkeys —
    /// pressing `1`/`2`/`3` to switch to NonCombat / HandCombat /
    /// SwordCombat sends one transient pulse with the stance set;
    /// ACE accepts + broadcasts `UpdateMotion` back to all observers
    /// (per `Player_Networking.cs::BroadcastMovement`); the
    /// kind=5 `ENTITY_UPDATE_KIND_MOTION` path then re-bakes the
    /// stance-specific walk/run cycle for the local player's
    /// gait change.
    pub fn enqueue_transient_motion(
        &mut self,
        command: InterpretedMotionCommand,
        motion_style: MotionStyle,
    ) {
        self.inner.enqueue_transient_motion(command, motion_style);
    }

    /// G-7 / F1-6 — the un-rooted interpreted-intent planar velocity for
    /// the held manual drive state (see `MovementSystem::
    /// manual_intent_velocity`). The wasm Jump arm uses this as the
    /// launch planar velocity for a standing-long-jump release.
    pub fn charged_jump_launch_velocity(
        &self,
        world: &WorldState,
    ) -> Option<holtburger_common::math::Vector3> {
        self.inner.manual_intent_velocity(world)
    }

    /// Arm the AutonomousPosition heartbeat schedule. Call once after the
    /// player enters the world (`kind=7 EnteredWorld` in the wasm bundle)
    /// so subsequent ticks emit heartbeats while moving.
    pub fn arm_heartbeat_schedule(&mut self, now: Instant, world: &WorldState) {
        self.inner
            .arm_autonomous_position_heartbeat_schedule(now, world);
    }

    /// Drive one physics tick. Reconciles server-controlled projection,
    /// expires active drives, ingests queued commands, advances the
    /// local-player runtime pose via the cli's drive-control helper,
    /// and emits `MoveToState` / `AutonomousPosition` / stop packets
    /// via `Session::send_action`.
    ///
    /// Phase 4 step 3.6 detail: the cli's full flow runs three ticks
    /// in sequence (movement → world → simulation); the simulation
    /// tick is what physically advances the player by reading
    /// `current_local_drive_control(world, dt).desired_world_delta`
    /// and feeding it through `SpatialPhysics::solve`. This wasm
    /// shim avoids standing up the full simulation system; instead
    /// it integrates the local-player pose directly from the same
    /// drive-control helper before the inner tick, so the heartbeat
    /// reads an up-to-date pose. Other entities are not advanced —
    /// they're still driven by inbound packets, which is fine for
    /// step 3.6 (only the *local* player's position needs to flow
    /// outbound).
    pub async fn tick(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
    ) -> Result<Vec<WorldEvent>> {
        let dt = match self.last_tick_at {
            Some(prev) => now.saturating_duration_since(prev),
            None => Duration::from_millis(16),
        };
        self.last_tick_at = Some(now);

        // Manual drive (WASD) — integrate velocity * dt.
        // current_local_drive_control returns None for Manual because
        // the cli routes manual through SolveBodyInput → physics.solve;
        // we sidestep the solver and integrate directly.
        self.inner.advance_local_pose_for_manual_drive(world, dt);

        // Autonomous drive (e.g. nav) — desired_world_delta is already
        // pre-scaled by dt by current_local_drive_control. Only takes
        // effect when active_drive is Autonomous, which the wasm
        // bundle doesn't currently use, but keep the path warm.
        if let Some(ctrl) = self.inner.current_local_drive_control(world, dt) {
            if let Some(mut pose) = world.local_player_runtime_pose() {
                pose.coords.x += ctrl.desired_world_delta.x;
                pose.coords.y += ctrl.desired_world_delta.y;
                pose.coords.z += ctrl.desired_world_delta.z;
                let _ = world.set_local_player_runtime_pose(pose);
            }
        }

        self.tick_count = self.tick_count.wrapping_add(1);
        self.inner.tick(now, world, session).await
    }

    /// A1-O1 (2026-06-11, unification survey): direct access to the
    /// wrapped [`MovementSystem`] for the canonical tick spine
    /// (`tick_spine::TickSpineHandle`). The spine calls
    /// `MovementSystem::tick` itself (plus `world.tick` +
    /// `simulation.tick`), deliberately SKIPPING this handle's bespoke
    /// local-pose pre-integration above — under the unified spine the
    /// local player advances through the cli-canonical solver path
    /// instead (`current_local_solve_body_input` →
    /// `SpatialPhysics::solve`), which is exactly the path the `tick`
    /// doc comment says the off-path sidesteps.
    pub(crate) fn inner_mut(&mut self) -> &mut MovementSystem {
        &mut self.inner
    }

    /// A1-O1: bookkeeping for a spine-driven tick — stamps
    /// `last_tick_at` and advances `tick_count` exactly as `tick` would,
    /// so the wasm recv loop's `tick_count()`-keyed diag throttles keep
    /// their cadence when `?unifiedTick=on` routes around `tick`.
    pub(crate) fn note_unified_tick(&mut self, now: Instant) {
        self.last_tick_at = Some(now);
        self.tick_count = self.tick_count.wrapping_add(1);
    }

    /// A13-W1 (2026-06-11, unification survey): consume the
    /// self-movement sequence `WorldEvent`s emitted by the canonical
    /// world handlers, exactly as the native runtime does
    /// (`client/messages.rs::handle_world_events`). The wasm recv loop
    /// calls this after routing `UpdatePosition` / `UpdateMotion` /
    /// `VectorUpdate` / `PlayerTeleport` through
    /// `holtburger_world::handlers::routing::handle_message` under
    /// `?wireStatePacks=stage1` — single consumption site, see
    /// [`MovementSystem::apply_self_movement_world_events`].
    pub fn apply_self_movement_world_events(&mut self, events: &[WorldEvent]) {
        self.inner.apply_self_movement_world_events(events);
    }

    /// A3-D3 (2026-06-12): sibling consumer — route the
    /// `EntityMovementEvent` / `SelfServerControlledMotion` /
    /// `EntityDespawned` stream into the per-entity `MovementManager`
    /// registry (`unpack_movement` Stage-3 semantics), exactly as the
    /// native runtime does. Gated internally by the default-off
    /// `USE_UNPACK_MOVEMENT_SEMANTICS` const; on wasm additionally only
    /// reachable under `?wireStatePacks=stage1` (the A13-W1 routed
    /// path). See [`MovementSystem::apply_movement_world_events`].
    pub fn apply_movement_world_events(&mut self, events: &[WorldEvent]) {
        self.inner.apply_movement_world_events(events);
    }

    /// A3-D3 driver (M4.4 / S10 A.3) — whether the LOCAL player's
    /// MoveTo driver holds an active directive (retail `is_moving_to`,
    /// acclient.c:344895-344898). S10's `pursuitStatus` export reads
    /// this through the wasm bundle.
    pub fn moveto_is_active(&self, world: &WorldState) -> bool {
        self.inner.moveto_is_active(world.player.guid)
    }

    /// A3-D3 driver (M4.4 / S10 A.4) — read-clear completion latch for
    /// the LOCAL player's MoveTo: `Some(0)` arrival; `Some(0x36)`
    /// cancelled, `Some(0x3D)` fail-distance, `Some(0x37/0x38)` target
    /// lost, `Some(8)` unresolvable (see `MoveToManager::
    /// take_completion`).
    pub fn take_moveto_completion(&mut self, world: &WorldState) -> Option<u32> {
        self.inner.take_moveto_completion(world.player.guid)
    }

    /// A14-I2 (W3+ S10, `?wasmPursuit=on`) — the poll-shaped pursuit
    /// status for the wasm `pursuitStatus()` export: `0` idle / `1`
    /// active / `2` arrived / `3 | (werror << 16)` failed. The 2/3
    /// states CONSUME the read-clear completion latch — the recv
    /// loop's per-tick shadow publisher is the single consumer (don't
    /// also call [`Self::take_moveto_completion`] on the same build).
    pub fn pursuit_status(&mut self, world: &WorldState) -> u32 {
        self.inner.pursuit_status(world.player.guid)
    }

    /// A6-T1/T2 (2026-06-12, W3+ S7): install the `?unifiedTransition=on`
    /// runtime carrier. The wasm recv-loop init calls this once after
    /// parsing the URL flag; when on (or when the native
    /// `USE_UNIFIED_TRANSITION` const is flipped) the local player's
    /// manual-drive slices and the canonical spine's simulation solve
    /// both route through the retail transition pipeline
    /// (`holtburger_world::spatial::transition`). Default off —
    /// byte-identical legacy paths.
    pub fn set_unified_transition(&mut self, on: bool) {
        self.inner.set_unified_transition(on);
    }

    /// Phase 3 B4 Phase B (2026-06-28): install the `?faithfulTransition=on`
    /// runtime carrier. The wasm recv-loop init calls this once after parsing
    /// the URL flag; when on (or when the native `USE_FAITHFUL_TRANSITION`
    /// const is flipped) the local player's INDOOR collision routes through
    /// the decomp-faithful `CTransition` BSP driver
    /// (`holtburger_world::spatial::faithful_bridge`) via the
    /// `find_transitional_position_dispatch` seam; statics stay identity
    /// (Phase C) and outdoor poses delegate to the existing heightfield
    /// pipeline (Phase D). Default off — the dispatcher routes to the
    /// unchanged approximate pipeline, byte-identical.
    pub fn set_faithful_transition(&mut self, on: bool) {
        self.inner.set_faithful_transition(on);
    }

    /// FU-3 (2026-07-20): install the `?faithfulEntityCollision=on` runtime
    /// carrier (default-OFF). When on (and `?faithfulTransition` is also on),
    /// the live faithful slice clamps the realized lateral residual against
    /// collidable dynamic entities (doors/monsters/players) — the faithful
    /// driver otherwise never blocks against them. Ethereal/IGNORE_COLLISIONS
    /// entities are exempt (`Entity::is_collidable`). Forwards to
    /// `MovementSystem::set_faithful_entity_collision`.
    pub fn set_faithful_entity_collision(&mut self, on: bool) {
        self.inner.set_faithful_entity_collision(on);
    }

    /// COL-DIAG (2026-08-04): install the `?fu3Diag=on` runtime carrier —
    /// the FU-3 entity clamp logs one `[fu3] …` line per ~second describing
    /// the collider gather it actually saw. Diagnostic only; changes no
    /// collision decision. Forwards to `MovementSystem::set_fu3_diag`.
    pub fn set_fu3_diag(&mut self, on: bool) {
        self.inner.set_fu3_diag(on);
    }

    /// Phase 3 Phase D (2026-06-28): install the `?faithfulOutdoor=off` runtime
    /// carrier (default-ON outdoor-faithful; `=off` rolls the OUTDOOR terrain
    /// path back to the heightfield). Read only when `?faithfulTransition` is
    /// also on. Forwards to `MovementSystem::set_faithful_outdoor`.
    pub fn set_faithful_outdoor(&mut self, on: bool) {
        self.inner.set_faithful_outdoor(on);
    }

    /// Phase 3 Phase E1 / WS-D (2026-06-29): install the `?stepUp=off` runtime
    /// carrier (default-ON walkable step-up / slope & ledge climbing; `=off`
    /// rolls climbing back to the pre-E1 stop-at-base behavior). Read only when
    /// `?faithfulTransition` is also on. Forwards to
    /// `MovementSystem::set_faithful_stepup`.
    pub fn set_faithful_stepup(&mut self, on: bool) {
        self.inner.set_faithful_stepup(on);
    }

    /// (2026-06-30): install the `?roofGrounding=off` runtime carrier (default-ON
    /// outdoor static/building roof grounding; `=off` rolls back to the
    /// indoor-only `ON_WALKABLE` latch). Read only when `?faithfulTransition` is
    /// also on. Forwards to `MovementSystem::set_outdoor_static_grounding`.
    pub fn set_outdoor_static_grounding(&mut self, on: bool) {
        self.inner.set_outdoor_static_grounding(on);
    }

    /// Phase 3 Phase D (2026-06-28, Option C): install the
    /// `?buildingOverlap=off` runtime carrier (default-ON overlap registration;
    /// `=off` = the retail home-cell-only walk-through repro for the A/B proof).
    /// Forwards to `MovementSystem::set_building_overlap`.
    pub fn set_building_overlap(&mut self, on: bool) {
        self.inner.set_building_overlap(on);
    }

    /// (2026-07-02): install the `?retailGround=off` runtime carrier
    /// (default-ON retail outdoor ground movement — FLOOR_Z cliff refusal +
    /// cliff_slide, step-down downhill stick, lip block/slide; `=off` rolls
    /// back to the pre-2026-07-02 behavior). Read only when
    /// `?faithfulTransition` is also on (the chain lives in the faithful
    /// driver). Forwards to `MovementSystem::set_retail_ground`.
    pub fn set_retail_ground(&mut self, on: bool) {
        self.inner.set_retail_ground(on);
    }

    /// TIER-3 (2026-07-28): install the `?terrainPlaneFrame=off` runtime
    /// carrier (default-ON — outdoor terrain contact planes are stored in the
    /// WORLD frame so retail's contact persistence, `adjust_offset` plane
    /// projection and the zero-offset contact echo work outdoors; `=off`
    /// restores the pre-2026-07-28 landblock-local store). Read only when
    /// `?faithfulTransition` is also on. Forwards to
    /// `MovementSystem::set_terrain_plane_frame`.
    pub fn set_terrain_plane_frame(&mut self, on: bool) {
        self.inner.set_terrain_plane_frame(on);
    }

    /// TIER-3 (2026-07-28): install the `?airborneContact=off` runtime carrier
    /// (default-ON — an AIRBORNE mover's entry contact uses retail's exact
    /// `check_contact` velocity dot instead of the vertical-arc proxy).
    /// Forwards to `MovementSystem::set_airborne_check_contact`.
    pub fn set_airborne_check_contact(&mut self, on: bool) {
        self.inner.set_airborne_check_contact(on);
    }

    /// TIER-3 (2026-07-28): install the `?walkableGround=off` runtime carrier
    /// (default-ON — GROUNDED and JUMP both require ON_WALKABLE `N.z >=
    /// floor_z`, not merely the cos-85° landing allowance). Forwards to
    /// `MovementSystem::set_walkable_landing_ground`.
    pub fn set_walkable_landing_ground(&mut self, on: bool) {
        self.inner.set_walkable_landing_ground(on);
    }

    /// F2 (2026-07-27): install the `?serverMoveToDriver=off` runtime
    /// carrier (default-ON — the LOCAL player's server-commanded MoveTo
    /// 6/7 runs the faithful `MoveToManager` driver, giving turn-first
    /// node order, the retail `get_command` gait and the Sticky-bit
    /// arrival `StickTo`; `=off` returns it to the approximate
    /// `ServerControlledProjection` lane). Forwards to
    /// `MovementSystem::set_server_moveto_driver`.
    pub fn set_server_moveto_driver(&mut self, on: bool) {
        self.inner.set_server_moveto_driver(on);
    }

    /// F2 follow-on (2026-07-27): install the `?stickyIdleStep=off`
    /// runtime carrier (default-ON — the LOCAL `StickyManager` step also
    /// runs on frames no manual-drive slice claimed, so a standing
    /// attacker's swing-echo/arrival sticky actually pulls; `=off`
    /// restores the manual-slice-only reach). Forwards to
    /// `MovementSystem::set_sticky_idle_step`.
    pub fn set_sticky_idle_step(&mut self, on: bool) {
        self.inner.set_sticky_idle_step(on);
    }

    /// (2026-07-02): install the `?castMove=off` runtime carrier (default-ON
    /// retail cast-movement arbitration — a server-played cast gesture
    /// suppresses held locomotion until an input edge / gesture end; `=off`
    /// disables). Forwards to `MovementSystem::set_cast_move`.
    pub fn set_cast_move(&mut self, on: bool) {
        self.inner.set_cast_move(on);
    }

    /// (2026-07-12, WS04): install the `?castHoldReclaim=on` runtime carrier
    /// (default OFF — the FU-A `use_time` reclaim holds the FORWARD slot dead
    /// across a whole known cast chain instead of reviving held-W per
    /// windup-node). Forwards to `MovementSystem::set_cast_hold_reclaim`.
    pub fn set_cast_hold_reclaim(&mut self, on: bool) {
        self.inner.set_cast_hold_reclaim(on);
    }

    /// WS04 — the JS cast chain stamps the local cast window (true at windup
    /// start, false at chain completion/fizzle/cancel). Forwards to
    /// `MovementSystem::note_local_cast_window`.
    pub fn note_local_cast_window(&mut self, active: bool) {
        self.inner.note_local_cast_window(active);
    }

    /// (2026-07-03): install the `?slideCast=off` runtime carrier (default
    /// ON — held sidestep/turn survive the local player's General
    /// cast-gesture stomps, the vanilla-ACE slidecast compensation; `=off`
    /// restores the bare stomp). Forwards to
    /// `MovementSystem::set_slide_cast`.
    pub fn set_slide_cast(&mut self, on: bool) {
        self.inner.set_slide_cast(on);
    }

    /// Movement-port wave 1 step 4 (2026-07-03): install the
    /// `?cmdInterp=on` runtime carrier (default OFF — the retail
    /// `CommandInterpreter` input lane, dark until the parity harness +
    /// 1070 live-bot A/B). Forwards to `MovementSystem::set_cmd_interp`.
    pub fn set_cmd_interp(&mut self, on: bool) {
        self.inner.set_cmd_interp(on);
    }

    /// Wave-1 step 4: queue one raw input-action edge for the
    /// `?cmdInterp=on` interpreter lane (ADJ-4 retail InputAction ids:
    /// 0x29=WalkForward, 0x2A=WalkBackward, 0x2B=Ready, 0x2C/0x2D=
    /// SideStepRight/Left, 0x2E/0x2F=TurnRight/Left, 0x30=AutoRun,
    /// 0x31=Jump, 0x32=HoldRun). The wasm `handleKeyAction` export
    /// forwards here; JS emits ONLY while the flag is on — flag-off the
    /// legacy `setMovementInput` lane stays byte-identical.
    pub fn enqueue_key_action(&mut self, action: u32, down: bool) {
        self.inner.enqueue_key_action(action, down);
    }

    /// Wave-1 step 5 (rows 12-13): drain the interpreter lane's
    /// JS-facing event stream — interpreter effects (forward-slot
    /// eviction, FU-A reclaims), the installed drive per dispatched
    /// edge, and jump refusals. The wasm TickMovement arm converts
    /// these into `ClientEvent`s (kind 61 + the kind-56 toast). Empty
    /// (and allocation-free) while the lane is off.
    pub fn take_cmd_interp_events(&mut self) -> Vec<super::system::CmdInterpEvent> {
        self.inner.take_cmd_interp_events()
    }

    /// Physics-parity 2026-07-03 (dossier A F1/F2): install the
    /// `?retailQuantum=on` runtime carrier (default OFF — ACE slice
    /// shapes stand per DECISIONS-A1-O5; `=on` runs the retail
    /// update_object schedule: 0.0002 consume-skip, direct sub-0.2
    /// entry, 0.2 slices + 1/30-floored carried remainder). Forwards to
    /// `MovementSystem::set_retail_quantum`.
    pub fn set_retail_quantum(&mut self, on: bool) {
        self.inner.set_retail_quantum(on);
    }

    /// Phase 3 Phase D — the effective OUTDOOR-faithful predicate, threaded into
    /// the transition dispatch's `faithful_outdoor` arm (WS4). Combines the
    /// `USE_FAITHFUL_OUTDOOR` const default with the `?faithfulOutdoor` runtime
    /// carrier.
    pub fn faithful_outdoor_enabled(&self) -> bool {
        self.inner.faithful_outdoor_enabled()
    }

    /// Phase 3 Phase E1 / WS-D — the effective STEP-UP-climb predicate, threaded
    /// into the transition dispatch's `faithful_stepup` arm. Combines the
    /// `USE_FAITHFUL_STEPUP` const default with the `?stepUp` runtime carrier.
    pub fn faithful_stepup_enabled(&self) -> bool {
        self.inner.faithful_stepup_enabled()
    }

    /// Phase 3 Phase D (Option C) — the effective building/static OVERLAP
    /// registration predicate, read by the per-cell static-BSP bake (WS7/WS8):
    /// the wasm bake calls this on the handle and passes the bool into the scene
    /// bake. Combines the `USE_BUILDING_OVERLAP` const default with the
    /// `?buildingOverlap` runtime carrier.
    pub fn building_overlap_enabled(&self) -> bool {
        self.inner.building_overlap_enabled()
    }

    /// A14-I3 (2026-06-12, `?retailRunKeys=on`) — public forward for
    /// the wasm `setAutoRun` export: retail
    /// `CommandInterpreter::SetAutoRun` + the `ApplyCurrentMovement`
    /// auto_run re-issue branch (acclient.c:718254-718292,
    /// :717027-717064). While on, the effective manual drive is
    /// forward+Run regardless of the held forward/backstep keys;
    /// toggling off restores the recorded manual state. Same-value
    /// calls no-op. JS reaches this only under the default-off flag.
    pub fn set_auto_run(&mut self, on: bool) {
        self.inner.set_auto_run(on);
    }

    /// A4-Q2 (2026-06-12, W3+ S5) — public forward for the wasm
    /// `notifyAnimationDone` export: renderer one-shot overlay
    /// completion → the LOCAL player's `MotionTableManager` queue
    /// (retail `AnimDoneHook::Execute` → `Hook_AnimDone` →
    /// `CPartArray::AnimationDone` → `MotionTableManager::AnimationDone`,
    /// acclient.c:342336 → :317087 → :325080 → :329873). Inert unless
    /// `USE_MOTION_TABLE_QUEUE`, and harmlessly no-op on an empty
    /// queue even then (the :329884 head-null guard).
    pub fn notify_animation_done(&mut self, success: bool) {
        self.inner.notify_animation_done(success);
    }

    /// P13/P16-H2 (2026-07-04) — install the local player's authored
    /// one-shot motion lengths for the completion-clock shim. `entries`
    /// = `(stance, full motion id, base seconds at speed 1.0)`, resolved
    /// by the wasm layer from the cached MotionTable (the same machinery
    /// behind `lookupMotionLinkForSwing`). Replaces the table wholesale —
    /// re-ingest on an mtable change. See
    /// `motion_table_manager::set_authored_motion_lengths`.
    pub fn ingest_authored_motion_lengths(&mut self, entries: &[(u32, u32, f32)]) {
        super::motion_table_manager::set_authored_motion_lengths(entries);
    }

    /// A4/SA4F (2026-06-12) — the PER-GUID `notifyAnimationDone` forward
    /// (retail per-OBJECT chain, no local filter: acclient.c:342336 →
    /// :317087 → :325080 → :329873). `is_local` keeps the landed
    /// local-instance route (`USE_MOTION_TABLE_QUEUE`-gated + the S9
    /// unstick bubble); the registry `MovementManager` half is
    /// map-miss-inert (despawn-pruned) so it carries no const gate.
    pub fn notify_animation_done_for(&mut self, guid: Guid, is_local: bool, success: bool) {
        self.inner.notify_animation_done_for(guid, is_local, success);
    }

    /// A4-Q3 (2026-06-12) — `PlayerTeleport` exit-world drain forward
    /// (retail `CPhysicsObj::exit_world` → `CPartArray::HandleExitWorld`
    /// + `MovementManager::HandleExitWorld`, acclient.c:322215-322220;
    /// queue drain `success=0`, :329940-329947). Same routing rules as
    /// [`Self::notify_animation_done_for`]: local half
    /// `USE_MOTION_TABLE_QUEUE`-gated, registry half map-miss-inert.
    pub fn handle_exit_world_for(&mut self, guid: Guid, is_local: bool) {
        self.inner.handle_exit_world_for(guid, is_local);
    }

    /// Post-flip diag forward: the local registry minterp's pending
    /// completion-node count (see
    /// `MovementSystem::local_registry_pending_motions`).
    pub fn local_registry_pending_motions(&self, local_guid: Guid) -> usize {
        self.inner.local_registry_pending_motions(local_guid)
    }

    /// WS16 diag forward: packed autonomy-latch + interpreter forward-slot
    /// occupancy for the cast surface (see
    /// `MovementSystem::cast_arbitration_diag`).
    pub fn cast_arbitration_diag(&self, local_guid: Guid) -> u32 {
        self.inner.cast_arbitration_diag(local_guid)
    }

    /// ORACLE (`?moveTelemetry=1`): per-tick movement-state snapshot for the
    /// retail-parity oracle. Diagnostics-only — reads state, decides nothing.
    /// `tick_count` is stamped here because it lives on the handle, not on
    /// the system.
    pub fn movement_telemetry(&self, local_guid: Guid) -> super::system::MovementTelemetry {
        let mut t = self.inner.movement_telemetry(local_guid);
        t.tick_count = self.tick_count;
        t
    }

    /// A14-I4 (W3+ S11) — press-time half of the retail jump charge
    /// clock (`ClientCombatSystem::CommenceJump`,
    /// acclient.c:408033-408078). `Err(JumpRefusal::Position)` mirrors
    /// retail's press-time 72 refusal (the charge-time 73 gate is
    /// deliberately absent — DESIGN.md:460-462). The wasm
    /// `JumpChargeCommence` arm calls this under `?jumpParity=on`.
    pub fn jump_charge_commence(
        &mut self,
        now: Instant,
        world: &mut WorldState,
    ) -> std::result::Result<(), JumpRefusal> {
        self.inner.jump_charge_commence(now, world)
    }

    /// A14-I4 — the UI read (retail `GetJumpPowerLevel`,
    /// acclient.c:408081-408104): 0.0 when idle, else the charge level
    /// floored at MIN_JUMP_EXTENT. Published into the wasm
    /// `jumpChargeLevel()` shadow each TickMovement.
    pub fn jump_charge_level(&self, now: Instant, world: &WorldState) -> f32 {
        self.inner.jump_charge_power(now, world)
    }

    /// A14-I4 — abort a held charge without jumping (retail
    /// `FinishJump`, acclient.c:407625-407648; blur analog).
    pub fn jump_charge_abort(&mut self, world: &mut WorldState) {
        self.inner.jump_charge_abort(world);
    }

    /// A14-I4 — release-time half (retail `DoJump`,
    /// acclient.c:408146-408227): FinishJump-before-validate ordering,
    /// release gates (36/72 + the A4-Q1 queue-head code), vz/stamina
    /// math, and the single `build_jump` → `Session::send_action`
    /// boundary. See `MovementSystem::execute_jump_release`.
    pub async fn execute_jump_release(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut dyn ActionSink,
    ) -> Result<JumpOutcome> {
        self.inner.execute_jump_release(now, world, session).await
    }

    /// Phase 4 step 3.6 diagnostics — number of tick() calls since
    /// construction. The wasm bundle's recv loop reads this to throttle
    /// per-frame pose logs (one per ~60 ticks).
    pub fn tick_count(&self) -> u32 {
        self.tick_count
    }

    /// Phase 4 step 3.6 diagnostics — total `AutonomousPosition`
    /// heartbeat packets sent. Incremented inside the cli's
    /// `maybe_send_autonomous_position_heartbeat` right after the
    /// `session.send_action` await. If this stays at 0 while a manual
    /// drive is active, the heartbeat path is broken; if it climbs but
    /// server-side position doesn't, the packets are flowing but ACE
    /// is dropping them.
    pub fn heartbeats_sent(&self) -> u32 {
        self.inner.heartbeats_sent
    }
}

impl Default for MovementSystemHandle {
    fn default() -> Self {
        Self::new()
    }
}
