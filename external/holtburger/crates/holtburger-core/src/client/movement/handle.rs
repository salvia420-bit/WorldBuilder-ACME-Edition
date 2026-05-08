use super::system::MovementSystem;
use crate::client::movement_types::PlayerDriveIntent;
use anyhow::Result;
use holtburger_session::Session;
use holtburger_world::{WorldEvent, WorldState};
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
}

impl MovementSystemHandle {
    pub fn new() -> Self {
        Self {
            inner: MovementSystem::new(),
        }
    }

    /// Queue a player drive intent (e.g. WASD-held → `PlayerDriveIntent::
    /// ManualHeld(MotionState)`). Processed on the next `tick` call.
    pub fn enqueue_drive_intent(&mut self, intent: PlayerDriveIntent, now: Instant) {
        self.inner.enqueue_drive_intent(intent, now);
    }

    /// Arm the AutonomousPosition heartbeat schedule. Call once after the
    /// player enters the world (`kind=7 EnteredWorld` in the wasm bundle)
    /// so subsequent ticks emit heartbeats while moving.
    pub fn arm_heartbeat_schedule(&mut self, now: Instant, world: &WorldState) {
        self.inner.arm_autonomous_position_heartbeat_schedule(now, world);
    }

    /// Drive one physics tick. Reconciles server-controlled projection,
    /// expires active drives, ingests queued commands, and emits
    /// `MoveToState` / `AutonomousPosition` / stop packets via
    /// `Session::send_action`.
    pub async fn tick(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        session: &mut Session,
    ) -> Result<Vec<WorldEvent>> {
        self.inner.tick(now, world, session).await
    }
}

impl Default for MovementSystemHandle {
    fn default() -> Self {
        Self::new()
    }
}
