//! A1-O1 (unification survey 2026-06-11): the canonical per-frame tick
//! spine — the SINGLE owner of the `movement → world → simulation` phase
//! order.
//!
//! Retail runs ONE frame spine: `SmartBox::UseTime`
//! (acclient.c:146256–146316) drives `CObjectMaint::UseTime` (146284,
//! visible-object maintenance/destruction timers — our `world.tick()`
//! eviction/liveness analog) then `CPhysics::UseTime` (146285, the
//! quantum-gated physics pass — our `simulation.tick` analog, see
//! `simulation.rs`'s MAX_QUANTUM slicing ↔ acclient.c:323120–323159)
//! within a single per-frame pass. Before this extraction we had TWO
//! spines: the native `ClientRuntime::run` physics arm ran
//! `movement.tick → world.tick → simulation.tick`, while the wasm
//! `SessionCommand::TickMovement` arm ran ONLY `movement.tick` — so the
//! eviction sweep and the quantum-sliced solver never executed in the
//! browser (survey A1 §3 row 1).
//!
//! `tick_frame` is the shared extraction. The native runtime delegates to
//! it directly (per-phase event sink preserves the exact pre-extraction
//! per-event handling interleave: each phase's events are observed +
//! projected BEFORE the next phase runs, so e.g. a body spawned by
//! `movement.tick` is tracked before `simulation.tick` solves).
//! [`TickSpineHandle`] is the wasm-facing facade (mirrors
//! `MovementSystemHandle`); the web bundle calls it ONLY under
//! `?unifiedTick=on` (default-off) — flag-off keeps the wasm arm calling
//! `MovementSystemHandle::tick` alone, byte-identical to before.

use super::movement::{MovementSystem, MovementSystemHandle};
use super::simulation::ClientSimulationSystem;
use anyhow::Result;
use holtburger_common::Guid;
use holtburger_session::Session;
use holtburger_world::{SpatialBodyId, WorldEvent, WorldState};
use std::time::Duration;
use web_time::Instant;

/// Which spine phase emitted a given [`WorldEvent`]. Ordered: `Movement`
/// runs first, then `World` (eviction/liveness sweep), then `Simulation`
/// (quantum-sliced spatial solver) — the `runtime.rs` order, itself
/// mirroring retail `SmartBox::UseTime`'s CObjectMaint-before-CPhysics
/// shape (acclient.c:146284–146285).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TickPhase {
    Movement,
    World,
    Simulation,
}

/// Drive one canonical client frame: `movement.tick` → `world.tick` →
/// `simulation.tick`, in exactly the order the native
/// `ClientRuntime::run` physics arm used inline before this extraction.
///
/// `on_event` fires once per emitted [`WorldEvent`], AFTER the phase that
/// produced it and BEFORE the next phase runs, with mutable access to the
/// world + simulation handed back so callers can replicate the native
/// per-event handling (solver body-tracking sync + view projection)
/// without changing any interleaving.
///
/// Only `movement.tick` is fallible; its error propagates untouched
/// (same `?` semantics the native loop had).
pub(super) async fn tick_frame<F>(
    now: Instant,
    dt: Duration,
    world: &mut WorldState,
    movement: &mut MovementSystem,
    simulation: &mut ClientSimulationSystem,
    session: &mut Session,
    mut on_event: F,
) -> Result<()>
where
    F: FnMut(TickPhase, &WorldEvent, &mut WorldState, &mut ClientSimulationSystem),
{
    let movement_events = movement.tick(now, world, session).await?;
    for event in &movement_events {
        on_event(TickPhase::Movement, event, world, simulation);
    }

    let world_events = world.tick();
    for event in &world_events {
        on_event(TickPhase::World, event, world, simulation);
    }

    let simulation_events = simulation.tick(now, dt, world, movement);
    for event in &simulation_events {
        on_event(TickPhase::Simulation, event, world, simulation);
    }

    Ok(())
}

/// Keep the solver's tracked-body set in sync with a remote body's
/// projection basis. Extracted verbatim from
/// `ClientRuntime::sync_remote_body_tracking` (runtime.rs) so the wasm
/// spine can apply the same rule without a `ClientRuntime`.
pub(super) fn sync_remote_body_tracking(
    world: &WorldState,
    simulation: &mut ClientSimulationSystem,
    body_id: SpatialBodyId,
) {
    if matches!(body_id, SpatialBodyId::LocalPlayer(_)) {
        return;
    }

    if world.body_has_simulatable_projection_basis(body_id) {
        simulation.track_body(body_id);
    } else {
        simulation.untrack_body(body_id);
    }
}

/// Observe a [`WorldEvent`] for solver body-tracking purposes. Extracted
/// verbatim from `ClientRuntime::observe_runtime_world_event`
/// (runtime.rs, which now delegates here) so both spines share one
/// tracking law.
pub(super) fn observe_world_event_for_body_tracking(
    world: &WorldState,
    simulation: &mut ClientSimulationSystem,
    event: &WorldEvent,
) {
    match event {
        WorldEvent::EntitySpawned(entity)
        | WorldEvent::EntityReplaced(entity)
        | WorldEvent::EntityIdentified(entity) => {
            if let Some(body_id) = world.runtime_body_id_for_guid(entity.guid) {
                sync_remote_body_tracking(world, simulation, body_id);
            }
        }
        WorldEvent::EntityVectorUpdated { guid, .. } => {
            if let Some(body_id) = world.runtime_body_id_for_guid(*guid) {
                sync_remote_body_tracking(world, simulation, body_id);
            }
        }
        WorldEvent::EntityDespawned(guid) => {
            simulation.untrack_body(SpatialBodyId::Entity(*guid));
        }
        WorldEvent::RuntimeBodyChanged { body_id } => {
            sync_remote_body_tracking(world, simulation, *body_id);
        }
        WorldEvent::RuntimeBodyRemoved { body_id }
            if !matches!(body_id, SpatialBodyId::LocalPlayer(_)) =>
        {
            simulation.untrack_body(*body_id);
        }
        WorldEvent::RuntimeBodiesReset { .. } => {}
        _ => {}
    }
}

/// Wasm-facing facade over the canonical tick spine (the
/// `MovementSystemHandle` pattern): owns the [`ClientSimulationSystem`]
/// the browser recv loop otherwise lacks, tracks its own inter-tick `dt`,
/// and drives [`tick_frame`].
///
/// Differences from the off-path (`MovementSystemHandle::tick`):
/// - the handle's bespoke manual/autonomous local-pose pre-integration is
///   SKIPPED — under the unified spine the local player advances through
///   the cli-canonical `simulation.tick` solver path
///   (`current_local_solve_body_input` → `SpatialPhysics::solve`), the
///   exact path the handle's doc comment says it sidesteps;
/// - `world.tick()` (eviction sweep + visibility-prune deadlines,
///   liveness.rs — retail `CObjectMaint::UseTime`, acclient.c:146284)
///   runs in-browser for the first time;
/// - tick-emitted events feed the same solver body-tracking observation
///   the native runtime applies ([`observe_world_event_for_body_tracking`]).
///
/// A8-M2 (2026-06-11): `tick_frame` RETURNS the guids of every
/// [`WorldEvent::EntityDespawned`] the frame emitted (in practice the
/// World phase's eviction sweep — `liveness.rs` explicit-delete marks +
/// expired 25 s out-of-visibility prune deadlines,
/// `ACE_DESTRUCTION_TIMEOUT_SECS` ↔ retail's destruction timer,
/// acclient.c:310666; the per-frame destruction-queue drain this sweep
/// mirrors is `CObjectMaint::UseTime` acclient.c:310246–310278). The
/// wasm recv loop translates these into KIND_REMOVE rig events under
/// `?maintPrune=on`. All other events are dropped after the body-
/// tracking observation, matching the wasm arm's existing `Ok(_events)`
/// discard; full KIND_SPAWN/KIND_REMOVE consolidation onto WorldEvents
/// is the A8-M3 follow-on.
pub struct TickSpineHandle {
    simulation: ClientSimulationSystem,
    last_tick_at: Option<Instant>,
}

impl TickSpineHandle {
    pub fn new() -> Self {
        Self {
            simulation: ClientSimulationSystem::new(),
            last_tick_at: None,
        }
    }

    /// Drive one canonical frame. `dt` is measured from the previous
    /// call (first call: 16 ms, the same default
    /// `MovementSystemHandle::tick` uses); `simulation.tick` slices it
    /// at MAX_QUANTUM / drops > HUGE_QUANTUM hitches, so rAF stalls
    /// cannot over-integrate (retail per-object clock,
    /// acclient.c:323120–323159).
    ///
    /// Returns the guids despawned this frame (A8-M2 — see the struct
    /// doc); empty for the overwhelming majority of frames.
    pub async fn tick_frame(
        &mut self,
        now: Instant,
        world: &mut WorldState,
        movement: &mut MovementSystemHandle,
        session: &mut Session,
    ) -> Result<Vec<Guid>> {
        let dt = match self.last_tick_at {
            Some(prev) => now.saturating_duration_since(prev),
            None => Duration::from_millis(16),
        };
        self.last_tick_at = Some(now);
        // Preserve the handle's tick-count/last-tick bookkeeping (the
        // wasm arm's diag throttles read `tick_count()`), WITHOUT its
        // local-pose pre-integration.
        movement.note_unified_tick(now);

        // A8-M2 (2026-06-11): collect despawn guids for the caller —
        // retail's CObjectMaint::UseTime destroys expired-timer objects
        // inside the same maintenance pass (acclient.c:310246–310278);
        // our caller-side KIND_REMOVE translation is the renderer-facing
        // half of that destroy.
        let mut despawned: Vec<Guid> = Vec::new();
        tick_frame(
            now,
            dt,
            world,
            movement.inner_mut(),
            &mut self.simulation,
            session,
            |_phase, event, world, simulation| {
                observe_world_event_for_body_tracking(world, simulation, event);
                if let WorldEvent::EntityDespawned(guid) = event {
                    despawned.push(*guid);
                }
            },
        )
        .await?;
        Ok(despawned)
    }
}

impl Default for TickSpineHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Guid, Quaternion, Vector3};
    use holtburger_protocol::messages::GameMessage;
    use holtburger_protocol::messages::object::ObjectDeleteData;
    use holtburger_world::entity::Entity;

    fn seeded_world() -> (WorldState, Guid) {
        let mut world = WorldState::synthetic();
        let player_guid = Guid(0x5000_0001);
        world.seed_local_player_entity(
            player_guid,
            "Player",
            WorldPosition {
                landblock_id: Guid(0x1234_0000),
                coords: Vector3::new(50.0, 50.0, 0.0),
                rotation: Quaternion::identity(),
            },
        );
        (world, player_guid)
    }

    /// Lane-A spine-order test (survey A1 §4 Stage O1): phases fire in
    /// `Movement → World → Simulation` order, and the World phase
    /// actually runs the liveness eviction sweep — the half of the spine
    /// the wasm arm never executed. An explicit-deleted entity (canonical
    /// `ObjectDelete` handler marks it; retail single `DeleteObject`
    /// funnel acclient.c:309918–309936) must be swept by `world.tick()`
    /// INSIDE `tick_frame` and surface as an `EntityDespawned` event
    /// tagged `TickPhase::World`.
    #[tokio::test]
    async fn tick_frame_runs_world_sweep_between_movement_and_simulation() {
        let (mut world, _player_guid) = seeded_world();

        let remote_guid = Guid(0x5000_0099);
        world.add_entity(Entity::new(
            remote_guid,
            "Remote".to_string(),
            WorldPosition {
                landblock_id: Guid(0x1234_0000),
                coords: Vector3::new(60.0, 60.0, 0.0),
                rotation: Quaternion::identity(),
            },
        ));
        // Canonical explicit-delete mark (same handler the A8-M1 wasm
        // routing uses) — world.tick()'s sweep evicts it.
        let _ = world.handle_message(&GameMessage::ObjectDelete(Box::new(ObjectDeleteData {
            guid: remote_guid,
        })));
        assert!(
            world.entities.get(remote_guid).is_some(),
            "explicit delete defers eviction to the world.tick sweep"
        );

        let mut movement = MovementSystem::new();
        let mut simulation = ClientSimulationSystem::new();
        let mut session = Session::new_test();

        let mut observed: Vec<(TickPhase, bool)> = Vec::new();
        tick_frame(
            Instant::now(),
            Duration::from_millis(30),
            &mut world,
            &mut movement,
            &mut simulation,
            &mut session,
            |phase, event, _world, _simulation| {
                observed.push((
                    phase,
                    matches!(event, WorldEvent::EntityDespawned(guid) if *guid == remote_guid),
                ));
            },
        )
        .await
        .expect("tick_frame should succeed on a synthetic world");

        // The eviction ran inside the spine...
        assert!(
            world.entities.get(remote_guid).is_none(),
            "world.tick inside tick_frame should sweep the explicit-deleted entity"
        );
        // ...its event was tagged with the World phase...
        assert!(
            observed
                .iter()
                .any(|(phase, is_despawn)| *phase == TickPhase::World && *is_despawn),
            "EntityDespawned should surface from the World phase; got {observed:?}"
        );
        // ...and phases arrived in canonical non-decreasing order
        // (Movement ≤ World ≤ Simulation).
        let phases: Vec<TickPhase> = observed.iter().map(|(phase, _)| *phase).collect();
        let mut sorted = phases.clone();
        sorted.sort();
        assert_eq!(
            phases, sorted,
            "spine phases must fire in Movement → World → Simulation order"
        );
    }

    /// The wasm facade: drives the same spine, preserves the
    /// `MovementSystemHandle` tick-count bookkeeping the recv-loop diag
    /// throttles read, and is repeatable.
    #[tokio::test]
    async fn tick_spine_handle_ticks_and_preserves_tick_count() {
        let (mut world, _player_guid) = seeded_world();
        let mut movement = MovementSystemHandle::new();
        let mut session = Session::new_test();
        let mut spine = TickSpineHandle::new();

        let start = Instant::now();
        spine
            .tick_frame(start, &mut world, &mut movement, &mut session)
            .await
            .expect("first unified tick should succeed");
        spine
            .tick_frame(
                start + Duration::from_millis(30),
                &mut world,
                &mut movement,
                &mut session,
            )
            .await
            .expect("second unified tick should succeed");

        assert_eq!(
            movement.tick_count(),
            2,
            "unified ticks must keep the handle's tick_count advancing"
        );
    }

    /// A8-M2 acceptance (Lane A, survey A8 §4 Stage M2): an entity that
    /// leaves the conservative visible set (landblock adjacency ∪ 384 m,
    /// `liveness.rs::current_visible_world_guids`) gets the 25 s prune
    /// deadline stamped by the World phase
    /// (`maintain_visibility_prune_deadlines`) and, once the deadline
    /// expires in sim-time, is SWEPT — and the handle REPORTS the
    /// despawn guid so the wasm caller can translate it into a
    /// KIND_REMOVE rig event. Retail: cell-less objects go on the
    /// +25.0 s destruction timer (`AddObjectToBeDestroyed`,
    /// acclient.c:310651–310672, constant at :310666; scheduled from
    /// the no-cell branch acclient.c:146087–146101) and are destroyed
    /// by `CObjectMaint::UseTime`'s queue drain
    /// (acclient.c:310246–310278).
    #[tokio::test]
    async fn tick_spine_handle_reports_out_of_visibility_prune_despawn() {
        let (mut world, _player_guid) = seeded_world();
        let mut movement = MovementSystemHandle::new();
        let mut session = Session::new_test();
        let mut spine = TickSpineHandle::new();

        // Far entity: non-adjacent landblock, far beyond the 384 m
        // conservative radius (lb 0x7F7F vs the player's 0x1234).
        let far_guid = Guid(0x5000_0777);
        world.add_entity(Entity::new(
            far_guid,
            "FarAway".to_string(),
            WorldPosition {
                landblock_id: Guid(0x7F7F_0000),
                coords: Vector3::new(50.0, 50.0, 0.0),
                rotation: Quaternion::identity(),
            },
        ));

        // Pin server time so the 25 s deadline is deterministic.
        let _ = world.set_server_time_sync(1_000.0, Instant::now());

        // Tick 1: entity is out of visibility → World phase stamps
        // `prune_deadline = now + 25 s`; nothing despawns yet.
        let start = Instant::now();
        let despawned = spine
            .tick_frame(start, &mut world, &mut movement, &mut session)
            .await
            .expect("tick 1 should succeed");
        assert!(
            despawned.is_empty(),
            "no despawn may fire before the 25 s deadline; got {despawned:?}"
        );
        assert!(
            world.entities.get(far_guid).is_some(),
            "entity must survive the deadline-stamping tick"
        );

        // Advance sim-time past ACE_DESTRUCTION_TIMEOUT_SECS by
        // re-anchoring the server-time sync (+30 s).
        let _ = world.set_server_time_sync(1_030.0, Instant::now());

        // Tick 2: the sweep evicts and the handle reports the guid.
        let despawned = spine
            .tick_frame(
                start + Duration::from_millis(32),
                &mut world,
                &mut movement,
                &mut session,
            )
            .await
            .expect("tick 2 should succeed");
        assert!(
            despawned.contains(&far_guid),
            "expired 25 s prune must surface the despawned guid; got {despawned:?}"
        );
        assert!(
            world.entities.get(far_guid).is_none(),
            "swept entity must be evicted from world.entities"
        );
    }
}
