use super::system::MovementSystem;
use crate::client::movement_types::{MotionStyle, PlayerDriveIntent};
use anyhow::Result;
use holtburger_protocol::messages::movement::InterpretedMotionCommand;
use holtburger_session::Session;
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
        self.inner.arm_autonomous_position_heartbeat_schedule(now, world);
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
        session: &mut Session,
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
