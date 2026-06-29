use super::movement::{HUGE_QUANTUM, MAX_QUANTUM, MovementSystem, ServerControlledProjection};
use anyhow::Result;
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::WorldObjectExt;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::*;
use holtburger_session::Session;
use holtburger_world::spatial::USE_STICKY_MANAGER;
use holtburger_world::{
    ContactState, SolveBodyInput, SolvedBodyKinematics, SpatialBodyId, SpatialSolveBatch,
    SpatialSolveRequest, WorldEvent, WorldState,
};
use std::sync::Arc;
use std::time::Duration;
use web_time::Instant;

const AUTO_MOVE_DISTANCE_LIMIT: f32 = 500.0;
const ACTIVE_SOLVE_RADIUS_M: f32 = 96.0;

fn calculate_arrival_position(
    source: &WorldPosition,
    target_pos: &Vector3,
    distance: f32,
) -> Vector3 {
    let to_player = source.coords - *target_pos;
    if to_player.length_squared() > 1e-6 {
        *target_pos + (to_player.normalize() * distance)
    } else {
        let mut fallback = *target_pos;
        fallback.x += distance;
        fallback
    }
}

fn approximate_move_to_object_projection_target(
    source: &WorldPosition,
    target_pos: &Vector3,
    distance_to_object: f32,
    target_use_radius: Option<f32>,
) -> Vector3 {
    let conservative_center_distance = distance_to_object + target_use_radius.unwrap_or(0.0);
    calculate_arrival_position(source, target_pos, conservative_center_distance.max(0.0))
}

#[derive(Debug, Default)]
pub(super) struct ClientSimulationSystem {
    tracked_body_ids: Vec<SpatialBodyId>,
}

impl ClientSimulationSystem {
    pub(super) fn new() -> Self {
        Self::default()
    }

    // A1-O1 (2026-06-11): no longer test-only — the canonical tick
    // spine's body-tracking observation (tick_spine.rs) calls this on
    // both the native and wasm paths.
    pub(super) fn track_body(&mut self, body_id: SpatialBodyId) {
        if body_id.authoritative_guid() != Some(Guid::NULL)
            && !self.tracked_body_ids.contains(&body_id)
        {
            self.tracked_body_ids.push(body_id);
        }
    }

    pub(super) fn untrack_body(&mut self, body_id: SpatialBodyId) {
        self.tracked_body_ids.retain(|tracked| *tracked != body_id);
    }

    pub(super) fn tick(
        &mut self,
        now: Instant,
        dt: Duration,
        world: &mut WorldState,
        movement: &mut MovementSystem,
    ) -> Vec<WorldEvent> {
        if dt.is_zero() {
            return Vec::new();
        }

        // Retail update_object quantum loop (acclient.c:323120-323154 / ACE
        // PhysicsObj.cs:4169-4186), brought to the authoritative solver path
        // (D8/PRED-2). The manual-drive integrator already subdivides
        // (system.rs); the solver previously took a single Euler step over the
        // raw inter-tick dt, so a tab stall / GC pause / debugger pause could
        // over-integrate into a resume-teleport. Now a HugeQuantum hitch
        // (> 2.0s) is dropped entirely (the next frame / server correction
        // resyncs), a frame longer than MAX_QUANTUM is integrated as a
        // sequence of <= MAX_QUANTUM slices so one long frame cannot over-step
        // gravity/collision, and a normal 30ms steady-state frame (<
        // MAX_QUANTUM) passes through as one solve with the real dt ->
        // byte-identical to before.
        // 0.1-vs-0.2: see docs/2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md (a).
        // No MIN_QUANTUM accumulator: small frames pass through rather than
        // floor-to-empty, which would stall the solver at the 30ms cadence —
        // accepted deviation, decision (c2) ibid.
        let dt_secs = dt.as_secs_f32();
        if dt_secs > HUGE_QUANTUM {
            return Vec::new();
        }

        let mut slices = Vec::new();
        let mut remaining = dt_secs;
        while remaining > MAX_QUANTUM {
            slices.push(MAX_QUANTUM);
            remaining -= MAX_QUANTUM;
        }
        if remaining > 0.0 {
            slices.push(remaining);
        }

        let mut events = Vec::new();
        for slice in slices {
            let slice_dt = Duration::from_secs_f32(slice);
            // A6-T2 (W3+ S7): under the unified-transition gate the
            // LOCAL player resolves through the retail transition
            // pipeline (outside `SpatialPhysics::solve` — the trait only
            // receives `&mut SpatialScene`; the pipeline needs
            // `&WorldState` for terrain/water, which this system holds).
            // When it resolved, the local body + local_drive are
            // EXCLUDED from the solve request so the solver cannot
            // double-advance it. Flag off: `local_resolved` stays false
            // and the request is byte-identical.
            let local_resolved = movement.unified_transition_enabled()
                && self.advance_local_player_via_transition(slice_dt, world, movement, &mut events);
            if let Some(request) =
                self.build_solve_request_inner(now, slice_dt, world, movement, !local_resolved)
            {
                let physics = Arc::clone(world.scene.physics());
                let solved = physics.solve(&request, &mut world.scene);
                events.extend(self.apply_solve_batch(world, solved));
            }
            // A2-P2 (2026-06-12, W3+ S8): the remote PositionManager
            // slot — retail runs `PositionManager::UseTime` /
            // `adjust_offset` inside the per-object physics pass this
            // system ports (acclient.c:322884-322886, 320029-320032),
            // so the remote managers step once per MAX_QUANTUM slice.
            // Gated inside on `scene.remote_interp_enabled` → flag off
            // (default) is zero work, byte-identical. Runs even when no
            // solve request was built this slice (no tracked local
            // bodies) — remote corrections are independent of the local
            // solver's input set.
            world.scene.step_remote_position_managers(slice);
        }
        events
    }

    /// A6-T2 (W3+ S7) — resolve the local player through the retail
    /// transition pipeline for one solve slice. Two arms, mirroring the
    /// legacy solver's split:
    ///   - Drive (server-projection / autonomous / move-to):
    ///     `LocalDriveControl::desired_world_delta` is the pipeline's
    ///     offset input directly; `force_grounded` maps through. This
    ///     upgrades the legacy P2 arm's buildings-only collision
    ///     (`project_pose_by_velocity_with_collision`) to the full
    ///     chain (retail runs ONE `find_valid_position` regardless of
    ///     autonomy, acclient.c:313419).
    ///   - Manual: the SAME shared driver T1 uses
    ///     ([`MovementSystem::advance_manual_slice_via_transition`]),
    ///     which kills the P2b zero-collision hole and makes T1↔T2
    ///     equivalence structural.
    ///
    /// The resolved pose is fed through [`Self::apply_solve_batch`] as a
    /// synthesized `SolvedBodyKinematics` so event emission /
    /// projection-state bookkeeping is unchanged. Returns `false` (and
    /// advances nothing) when there is no local player, no active
    /// drive/manual input, or the body is `Suspended`
    /// (AuthorityFrozen) — those cases keep the legacy solve path so
    /// the freeze semantics are preserved.
    fn advance_local_player_via_transition(
        &mut self,
        slice_dt: Duration,
        world: &mut WorldState,
        movement: &MovementSystem,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        use holtburger_world::spatial::transition;

        let guid = world.player.guid;
        if guid == Guid::NULL {
            return false;
        }
        let body_id = SpatialBodyId::LocalPlayer(guid);
        // Preserve the AuthorityFrozen freeze: a suspended body keeps
        // the legacy solve path (which returns the pose unchanged).
        if world
            .scene
            .body(body_id)
            .map(|body| body.sampling.mode == holtburger_world::SpatialSampleMode::Suspended)
            .unwrap_or(false)
        {
            return false;
        }

        if let Some(control) = movement.current_local_drive_control(world, slice_dt) {
            let Some(pose) = world.local_player_runtime_pose() else {
                return false;
            };
            let (object, gates) = MovementSystem::transition_profile(world);
            let end = holtburger_common::position::WorldPosition {
                landblock_id: pose.landblock_id,
                coords: Vector3::new(
                    pose.coords.x + control.desired_world_delta.x,
                    pose.coords.y + control.desired_world_delta.y,
                    pose.coords.z + control.desired_world_delta.z,
                ),
                rotation: pose.rotation,
            };
            let input = transition::TransitionInput {
                begin: pose,
                end,
                object,
                airborne: world.player.is_airborne && !control.force_grounded,
                descending: true,
                force_grounded: control.force_grounded,
                gates,
                last_known_wall_normal: world.player.last_known_wall_normal,
                frames_stationary_fall: 0,
            };
            let outcome = transition::find_transitional_position_dispatch(
                &*world,
                &input,
                movement.faithful_transition_enabled(),
                movement.faithful_outdoor_enabled(),
            );
            if let Some(n) = outcome.wall_normal {
                world.player.last_known_wall_normal = Some(n);
            }
            let mut next_pose = outcome.pose;
            let current_heading = pose.rotation.to_heading();
            let desired_heading = control.desired_heading.unwrap_or(current_heading);
            next_pose.rotation = Quaternion::from_heading(desired_heading);
            let dt_secs = slice_dt.as_secs_f32().max(1e-6);
            let solved = SolvedBodyKinematics {
                body_id,
                pose: next_pose,
                velocity: control.desired_world_delta / dt_secs,
                omega: Vector3::zero(),
                contact: if control.force_grounded || outcome.grounded {
                    ContactState::Grounded
                } else {
                    ContactState::Airborne
                },
                projection_state: Some(if control.force_grounded || outcome.grounded {
                    holtburger_world::SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
                } else {
                    holtburger_world::SelfPlayerDriveProjectionState::LocalAirborne
                }),
            };
            events.extend(self.apply_solve_batch(
                world,
                SpatialSolveBatch {
                    solved: vec![solved],
                    events: Vec::new(),
                },
            ));
            return true;
        }

        if movement.has_active_manual_drive() {
            // The shared T1 driver writes the runtime pose + player
            // contact bookkeeping itself; synthesize the solved-body
            // record from the result so apply_solve_batch's event /
            // bookkeeping path sees the same shape the solver produces.
            if movement.advance_manual_slice_via_transition(world, slice_dt) {
                if let Some(pose) = world.local_player_runtime_pose() {
                    let planar = world.player.current_planar_velocity;
                    let solved = SolvedBodyKinematics {
                        body_id,
                        pose,
                        velocity: Vector3::new(
                            planar.x,
                            planar.y,
                            world.player.vertical_velocity,
                        ),
                        omega: Vector3::zero(),
                        contact: if world.player.is_airborne {
                            ContactState::Airborne
                        } else {
                            ContactState::Grounded
                        },
                        projection_state: None,
                    };
                    events.extend(self.apply_solve_batch(
                        world,
                        SpatialSolveBatch {
                            solved: vec![solved],
                            events: Vec::new(),
                        },
                    ));
                }
                return true;
            }
        }

        false
    }

    // Production callers now route through `build_solve_request_inner`
    // (the A6-T2 exclusion seam); the legacy-shape wrapper is kept for
    // the client/mod.rs unit tests, which pin the request shape.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn build_solve_request(
        &self,
        now: Instant,
        dt: Duration,
        world: &WorldState,
        movement: &MovementSystem,
    ) -> Option<SpatialSolveRequest> {
        self.build_solve_request_inner(now, dt, world, movement, true)
    }

    /// A6-T2 — `include_local: false` excludes the local body AND the
    /// `local_drive` from the request (the transition pipeline already
    /// advanced the local player this slice; the solver must not
    /// double-advance it). `true` is the legacy byte-identical shape.
    fn build_solve_request_inner(
        &self,
        _now: Instant,
        dt: Duration,
        world: &WorldState,
        movement: &MovementSystem,
        include_local: bool,
    ) -> Option<SpatialSolveRequest> {
        if !include_local {
            let local_pose = world.local_player_runtime_pose();
            let nearby_tracked = local_pose.as_ref().map(|pose| {
                world
                    .scene
                    .get_entities_in_range(pose, ACTIVE_SOLVE_RADIUS_M)
            });
            let local_body_id = (world.player.guid != Guid::NULL)
                .then_some(SpatialBodyId::LocalPlayer(world.player.guid));
            let mut bodies = Vec::<SolveBodyInput>::new();
            for body_id in self.tracked_body_ids.iter().copied() {
                if Some(body_id) == local_body_id {
                    continue;
                }
                if nearby_tracked.as_ref().is_some_and(|guids| {
                    body_id
                        .authoritative_guid()
                        .is_some_and(|guid| !guids.contains(&guid))
                }) {
                    continue;
                }
                let Some(input) = world.resolve_body_projection_input(body_id) else {
                    continue;
                };
                if input.basis.is_none() {
                    continue;
                }
                bodies.push(input);
            }
            if bodies.is_empty() {
                return None;
            }
            return Some(SpatialSolveRequest {
                dt,
                bodies,
                local_drive: None,
            });
        }

        let local_body = movement.current_local_solve_body_input(world).or_else(|| {
            (world.player.guid != Guid::NULL)
                .then_some(SpatialBodyId::LocalPlayer(world.player.guid))
                .and_then(|body_id| world.resolve_body_projection_input(body_id))
        });
        let local_pose = local_body.map(|body| body.pose);
        let nearby_tracked = local_pose.map(|pose| {
            world
                .scene
                .get_entities_in_range(&pose, ACTIVE_SOLVE_RADIUS_M)
        });
        let mut bodies = Vec::<SolveBodyInput>::new();

        if let Some(body) = local_body {
            bodies.push(body);
        }

        for body_id in self.tracked_body_ids.iter().copied() {
            if bodies.iter().any(|body| body.body_id == body_id) {
                continue;
            }

            if nearby_tracked.as_ref().is_some_and(|guids| {
                body_id
                    .authoritative_guid()
                    .is_some_and(|guid| !guids.contains(&guid))
            }) {
                continue;
            }

            let Some(input) = world.resolve_body_projection_input(body_id) else {
                continue;
            };

            if input.basis.is_none() {
                continue;
            }

            bodies.push(input);
        }

        if bodies.is_empty() {
            return None;
        }

        Some(SpatialSolveRequest {
            dt,
            bodies,
            local_drive: movement.current_local_drive_control(world, dt),
        })
    }

    fn apply_solve_batch(
        &mut self,
        world: &mut WorldState,
        solved: SpatialSolveBatch,
    ) -> Vec<WorldEvent> {
        let mut events = Vec::new();

        for body in solved.solved {
            events.extend(world.apply_solved_body_kinematics(&body));
        }

        for event in solved.events {
            events.extend(world.apply_spatial_body_event(&event));
        }

        events
    }

    pub(super) async fn handle_server_controlled_movement(
        &mut self,
        data: MovementEventData,
        movement: &mut MovementSystem,
        world: &mut WorldState,
        session: &mut Session,
    ) -> Result<Vec<WorldEvent>> {
        log::info!(
            ">>> Processing server-initiated movement: {:?}. Control Sequence: {}",
            data.movement_type,
            data.server_control_sequence
        );
        movement.note_server_controlled_movement_started();

        match &data.data {
            MovementTypeData::MoveToObject(mto) => {
                let Some(current_pos) = world.local_player_runtime_pose() else {
                    return Ok(Vec::new());
                };

                let target_use_radius = world
                    .get_visible_entity(mto.target)
                    .and_then(|target| target.use_radius())
                    .map(|radius| radius as f32);
                let mut target_pose = current_pos;
                target_pose.landblock_id = mto.origin.cell_id;
                target_pose.coords = approximate_move_to_object_projection_target(
                    &current_pos,
                    &mto.origin.position,
                    mto.params.distance_to_object,
                    target_use_radius,
                );
                target_pose.rotation = if mto.params.desired_heading.abs() <= 1e-6 {
                    Quaternion::from_heading(target_pose.coords.heading_to(&mto.origin.position))
                } else {
                    Quaternion::from_heading(mto.params.desired_heading)
                };

                movement.set_server_controlled_projection(ServerControlledProjection {
                    target_pose,
                    speed_mps: (mto.run_rate * mto.params.speed.max(0.1)).max(0.1),
                });
                movement.arm_autonomous_position_heartbeat_schedule(Instant::now(), world);
                // A2-P3: retail per-unpack preamble unstick subset
                // (acclient.c:339518-339519) — a fresh MoveToObject for
                // the local player releases any melee sticky.
                if USE_STICKY_MANAGER {
                    apply_local_sticky_from_invalid(world, None);
                }
                return Ok(Vec::new());
            }
            MovementTypeData::Invalid(inv) => {
                // Track B1 — Invalid is the server's Stop/terminate arm for
                // a server-controlled move. It MUST clear any installed
                // projection so the per-tick drive stops immediately;
                // otherwise a MoveToObject projection (which carries no
                // self-timeout) would keep driving the player toward the
                // stale target.
                movement.clear_server_controlled_projection();
                // A2-P3 (2026-06-12, W3+ S9; RULINGS item 4) — LOCAL
                // sticky install. The player's own melee-swing echo
                // arrives here as a non-autonomous UpdateMotion Invalid
                // (ACE `Player_Melee.cs:420-427` sets
                // `MotionFlags.StickToObject` + `TargetGuid` and
                // `EnqueueBroadcastMotion` sendSelf-includes our session,
                // `WorldObject_Networking.cs:1306-1321`/`:1418-1432`;
                // the guid is serialized by the live server's
                // `Network/Motion/MovementInvalid.cs:45-46`). Retail
                // consumes it in `unpack_movement` case-0 →
                // `stick_to_object` UNCONDITIONALLY — no local-player
                // exclusion (acclient.c:339546-339560). A `None` sticky
                // guid on a fresh motion unsticks (the per-unpack
                // preamble subset, acclient.c:339518-339519). Radius
                // fallback `0.0` (acclient.c:319756-319763; spec S9
                // OPEN Q3); pose seeded from the freshest entity record
                // (scene `entity_poses` auto-feed inside
                // `stick_local_player_to`, plus the explicit visible-
                // entity feed below — retail-`Initialized` no-op until
                // one lands).
                if USE_STICKY_MANAGER {
                    apply_local_sticky_from_invalid(world, inv.sticky_object);
                }
            }
            _ => {
                // Any other server movement type supersedes a prior
                // MoveToObject projection — clear it so the two don't
                // fight (Track B1).
                movement.clear_server_controlled_projection();
                // A2-P3: retail's per-unpack preamble unsticks on EVERY
                // fresh movement unpack before the case dispatch
                // (`cancel_moveto` + `unstick_from_object`,
                // acclient.c:339518-339519) — non-Invalid local motions
                // therefore unstick. (The MoveToObject sticky BIT is a
                // remote-creature chase signal — F3-4 — and stays on the
                // wasm KIND_MOTION extraction; spec S9 §3 L1 step 1
                // installs from the Invalid arm only.)
                if USE_STICKY_MANAGER {
                    apply_local_sticky_from_invalid(world, None);
                }
            }
        }

        let Some(solved) = self.build_server_controlled_result(&data, world) else {
            return Ok(Vec::new());
        };

        let world_events = world.apply_solved_body_kinematics(&solved);
        let now = Instant::now();
        if should_send_immediate_server_controlled_sync(&data) {
            movement
                .send_autonomous_position_sync(
                    now,
                    world,
                    session,
                    super::movement_types::MovementPacketMetadata::default(),
                )
                .await?;
        } else {
            movement.arm_autonomous_position_heartbeat_schedule(now, world);
        }

        Ok(world_events)
    }

    fn build_server_controlled_result(
        &self,
        data: &MovementEventData,
        world: &WorldState,
    ) -> Option<SolvedBodyKinematics> {
        let guid = world.player.guid;
        if guid == Guid::NULL {
            return None;
        }

        let current_pos = world.local_player_runtime_pose()?;
        let mut next_pos = current_pos;

        match &data.data {
            MovementTypeData::MoveToObject(mto) => {
                next_pos.landblock_id = mto.origin.cell_id;

                let arrival_dist = mto.params.distance_to_object;

                if (current_pos.landblock_id >> 16) == (mto.origin.cell_id >> 16) {
                    next_pos.coords = calculate_arrival_position(
                        &current_pos,
                        &mto.origin.position,
                        arrival_dist,
                    );

                    if mto.params.desired_heading.abs() <= 1e-6 {
                        next_pos.rotation = Quaternion::from_heading(
                            next_pos.coords.heading_to(&mto.origin.position),
                        );
                    } else {
                        next_pos.rotation = Quaternion::from_heading(mto.params.desired_heading);
                    }
                } else {
                    next_pos.coords = mto.origin.position;
                    next_pos.coords.x += arrival_dist;
                }
            }
            MovementTypeData::MoveToPosition(mtp) => {
                next_pos.landblock_id = mtp.origin.cell_id;
                next_pos.coords = mtp.origin.position;

                if mtp.params.desired_heading.abs() > 1e-6 {
                    next_pos.rotation = Quaternion::from_heading(mtp.params.desired_heading);
                } else {
                    next_pos.rotation = Quaternion::from_heading(
                        current_pos.coords.heading_to(&mtp.origin.position),
                    );
                }
            }
            MovementTypeData::TurnToHeading(tth) => {
                next_pos.rotation = Quaternion::from_heading(tth.params.desired_heading);
            }
            MovementTypeData::TurnToObject(tto) => {
                if tto.desired_heading.abs() > 1e-6 {
                    next_pos.rotation = Quaternion::from_heading(tto.desired_heading);
                } else if let Some(target) = world.get_visible_entity(tto.target)
                    && target.position.landblock_id == next_pos.landblock_id
                {
                    next_pos.rotation = Quaternion::from_heading(
                        next_pos.coords.heading_to(&target.position.coords),
                    );
                }
            }
            _ => {}
        }

        let distance = if next_pos.landblock_id == Guid::NULL {
            0.0
        } else {
            current_pos.distance_to(&next_pos)
        };

        if distance > AUTO_MOVE_DISTANCE_LIMIT {
            log::warn!(
                "Aborting auto-move: target is {:.2}m away (limit {}m)",
                distance,
                AUTO_MOVE_DISTANCE_LIMIT
            );
            return None;
        }

        let (_, velocity, omega) = world.local_player_runtime_kinematics().unwrap_or((
            next_pos,
            Vector3::zero(),
            Vector3::zero(),
        ));

        Some(SolvedBodyKinematics {
            body_id: SpatialBodyId::LocalPlayer(guid),
            pose: next_pos,
            velocity,
            omega,
            contact: ContactState::Unknown,
            projection_state: Some(
                holtburger_world::SelfPlayerDriveProjectionState::ServerControlled,
            ),
        })
    }
}

fn should_send_immediate_server_controlled_sync(data: &MovementEventData) -> bool {
    !matches!(data.data, MovementTypeData::Invalid(_))
}

/// A2-P3 (2026-06-12, W3+ S9) — the LOCAL-player sticky consume for a
/// server-controlled movement unpack (ungated; every call site checks
/// [`USE_STICKY_MANAGER`]). `Some(target)` = the `Invalid` (case-0)
/// envelope carried `StickToObject` + guid → `stick_to_object`
/// UNCONDITIONALLY, local player included (acclient.c:339546-339560;
/// RULINGS item 4). `None` = a fresh motion without the bit, or any
/// non-Invalid movement type → the per-unpack preamble unstick subset
/// (acclient.c:339518-339519). Radius fallback `0.0`
/// (acclient.c:319756-319763; spec S9 OPEN Q3); the freshest known
/// target pose is fed immediately (scene `entity_poses` auto-feed +
/// the visible-entity record) — retail-`Initialized` no-op until one
/// lands (acclient.c:388691-388720).
pub(crate) fn apply_local_sticky_from_invalid(
    world: &mut WorldState,
    sticky_object: Option<Guid>,
) {
    match sticky_object {
        Some(target) => {
            let target_pose = world.get_visible_entity(target).map(|e| e.position);
            world.scene.stick_local_player_to(target, 0.0);
            if let Some(pose) = target_pose {
                world.scene.sticky_pose_feed(target, pose);
            }
        }
        None => {
            world.scene.unstick_local_player();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_protocol::messages::motion::{
        MoveToObject, MoveToParameters, MoveToPosition, Origin,
    };
    use holtburger_protocol::messages::{
        MotionStance, MovementEventData, MovementType, MovementTypeData,
    };
    use holtburger_world::{SpatialBodyEvent, entity::Entity};

    fn make_world_position(x: f32, y: f32, heading: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(heading),
        }
    }

    fn synthetic_player_world(start: WorldPosition) -> (WorldState, Guid) {
        let mut world = WorldState::synthetic();
        let player_guid = Guid(0x5000_0001);
        world.seed_local_player_entity(player_guid, "Player", start);
        (world, player_guid)
    }

    #[test]
    fn apply_solve_batch_applies_spatial_events() {
        let mut simulation = ClientSimulationSystem::new();
        let mut world = WorldState::synthetic();
        let player_guid = Guid(0x5000_0001);
        let remote_guid = Guid(0x5000_0002);
        let remote_pose = WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(9.0, 7.0, 0.0),
            rotation: Quaternion::identity(),
        };

        let player_pose = WorldPosition {
            landblock_id: Guid(0x1234_0000),
            ..Default::default()
        };
        world.seed_local_player_entity(player_guid, "Player", player_pose);
        world.add_entity(Entity::new(remote_guid, "Remote".to_string(), player_pose));

        let events = simulation.apply_solve_batch(
            &mut world,
            SpatialSolveBatch {
                solved: Vec::new(),
                events: vec![
                    SpatialBodyEvent::ContactChanged {
                        body_id: SpatialBodyId::LocalPlayer(player_guid),
                        contact: ContactState::Grounded,
                    },
                    SpatialBodyEvent::ForcedReposition {
                        body_id: SpatialBodyId::Entity(remote_guid),
                        pose: remote_pose,
                    },
                ],
            },
        );

        assert_eq!(world.player.last_server_grounded, Some(true));
        assert_eq!(
            world
                .scene
                .body(SpatialBodyId::Entity(remote_guid))
                .expect("remote runtime body should still exist")
                .pose,
            remote_pose
        );
        assert!(events.iter().any(|event| matches!(
            event,
            WorldEvent::PlayerGroundedUpdated { grounded } if *grounded
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorldEvent::ForcedReposition { guid, pos, sequence }
                if *guid == remote_guid && *pos == remote_pose && *sequence == 0
        )));
    }

    #[test]
    fn move_to_position_without_desired_heading_uses_current_pose_for_facing() {
        let simulation = ClientSimulationSystem::new();
        let start = make_world_position(10.0, 20.0, 1.25);
        let destination = make_world_position(32.0, 48.0, 0.0);
        let (world, player_guid) = synthetic_player_world(start);

        let solved = simulation
            .build_server_controlled_result(
                &MovementEventData {
                    guid: player_guid,
                    object_instance_sequence: 7,
                    movement_sequence: 20,
                    server_control_sequence: 10,
                    is_autonomous: false,
                    movement_type: MovementType::MoveToPosition,
                    motion_flags: 0,
                    current_style: MotionStance::SwordCombat.interpreted(),
                    data: MovementTypeData::MoveToPosition(MoveToPosition {
                        origin: Origin {
                            cell_id: destination.landblock_id,
                            position: destination.coords,
                        },
                        params: MoveToParameters {
                            desired_heading: 0.0,
                            ..Default::default()
                        },
                        run_rate: 1.0,
                    }),
                },
                &world,
            )
            .expect("server-controlled move should resolve");

        assert_eq!(solved.pose.landblock_id, destination.landblock_id);
        assert_eq!(solved.pose.coords, destination.coords);
        assert!(
            (solved.pose.rotation.to_heading() - start.coords.heading_to(&destination.coords))
                .abs()
                < 1e-5
        );
    }

    #[test]
    fn move_to_object_without_desired_heading_uses_current_pose_for_arrival_and_facing() {
        let simulation = ClientSimulationSystem::new();
        let start = make_world_position(10.0, 20.0, 1.25);
        let target = make_world_position(13.0, 24.0, 0.0);
        let arrival_distance = 2.0;
        let expected_coords = calculate_arrival_position(&start, &target.coords, arrival_distance);
        let (world, player_guid) = synthetic_player_world(start);

        let solved = simulation
            .build_server_controlled_result(
                &MovementEventData {
                    guid: player_guid,
                    object_instance_sequence: 7,
                    movement_sequence: 20,
                    server_control_sequence: 10,
                    is_autonomous: false,
                    movement_type: MovementType::MoveToObject,
                    motion_flags: 0,
                    current_style: MotionStance::SwordCombat.interpreted(),
                    data: MovementTypeData::MoveToObject(MoveToObject {
                        target: Guid(0x5000_00AA),
                        origin: Origin {
                            cell_id: target.landblock_id,
                            position: target.coords,
                        },
                        params: MoveToParameters {
                            desired_heading: 0.0,
                            distance_to_object: arrival_distance,
                            ..Default::default()
                        },
                        run_rate: 1.0,
                    }),
                },
                &world,
            )
            .expect("server-controlled move should resolve");

        assert_eq!(solved.pose.landblock_id, target.landblock_id);
        assert_eq!(solved.pose.coords, expected_coords);
        assert!(
            (solved.pose.rotation.to_heading() - expected_coords.heading_to(&target.coords)).abs()
                < 1e-5
        );
    }

    #[test]
    fn move_to_object_projection_target_adds_target_use_radius() {
        let start = make_world_position(10.0, 20.0, 0.0);
        let target = make_world_position(13.0, 24.0, 0.0);

        let projected =
            approximate_move_to_object_projection_target(&start, &target.coords, 0.6, Some(0.5));

        assert_eq!(
            projected,
            calculate_arrival_position(&start, &target.coords, 1.1)
        );
    }

    #[test]
    fn invalid_server_controlled_motion_skips_immediate_sync() {
        assert!(!should_send_immediate_server_controlled_sync(
            &MovementEventData {
                guid: Guid(0x5000_0001),
                object_instance_sequence: 7,
                movement_sequence: 20,
                server_control_sequence: 10,
                is_autonomous: false,
                movement_type: MovementType::Invalid,
                motion_flags: 0,
                current_style: MotionStance::SwordCombat.interpreted(),
                data: MovementTypeData::Invalid(Default::default()),
            }
        ));
    }

    #[test]
    fn move_to_position_server_controlled_motion_keeps_immediate_sync() {
        assert!(should_send_immediate_server_controlled_sync(
            &MovementEventData {
                guid: Guid(0x5000_0001),
                object_instance_sequence: 7,
                movement_sequence: 20,
                server_control_sequence: 10,
                is_autonomous: false,
                movement_type: MovementType::MoveToPosition,
                motion_flags: 0,
                current_style: MotionStance::SwordCombat.interpreted(),
                data: MovementTypeData::MoveToPosition(MoveToPosition {
                    origin: Origin {
                        cell_id: Guid(0x1234_0000),
                        position: Vector3::new(32.0, 48.0, 0.0),
                    },
                    params: MoveToParameters {
                        desired_heading: 0.0,
                        ..Default::default()
                    },
                    run_rate: 1.0,
                }),
            }
        ));
    }
}

#[cfg(test)]
mod sticky_tests {
    use super::*;
    use holtburger_world::entity::Entity;
    use holtburger_world::spatial::LocalStickyStep;

    fn make_pose(x: f32, y: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(0.0),
        }
    }

    /// Spec S9 §4 test 9 — the server-controlled-movement sticky
    /// consume: an `Invalid` envelope with `sticky_object = Some`
    /// installs the LOCAL player's sticky target (with the visible
    /// entity's pose fed, so the very next step pulls); `None` — the
    /// fresh-motion / non-Invalid preamble subset — unsticks. The arm
    /// itself is gated by the default-off [`USE_STICKY_MANAGER`]; this
    /// drives the ungated helper (gate-at-entry pattern).
    #[test]
    fn apply_local_sticky_from_invalid_installs_and_unsticks() {
        let mut world = WorldState::synthetic();
        let player_guid = Guid(0x5000_0001);
        let target_guid = Guid(0x8000_0001);
        world.seed_local_player_entity(player_guid, "Player", make_pose(50.0, 50.0));
        world.add_entity(Entity::new(
            target_guid,
            "Drudge".to_string(),
            make_pose(55.0, 50.0),
        ));

        assert_eq!(world.scene.local_sticky_target(), None);

        // Install: the swing echo's StickToObject guid.
        apply_local_sticky_from_invalid(&mut world, Some(target_guid));
        assert_eq!(world.scene.local_sticky_target(), Some(target_guid));
        // The target pose was fed at install — the first step pulls.
        assert!(matches!(
            world.scene.step_local_sticky(make_pose(50.0, 50.0), 0.016, 4.0),
            LocalStickyStep::Stepped(_)
        ));

        // Preamble subset: a fresh motion without the bit unsticks.
        apply_local_sticky_from_invalid(&mut world, None);
        assert_eq!(world.scene.local_sticky_target(), None);
        assert!(matches!(
            world.scene.step_local_sticky(make_pose(50.0, 50.0), 0.016, 4.0),
            LocalStickyStep::Inactive
        ));

        // Unknown target (no visible entity): installs uninitialized —
        // retail no-op until a pose feed lands.
        let stranger = Guid(0x8000_0002);
        apply_local_sticky_from_invalid(&mut world, Some(stranger));
        assert_eq!(world.scene.local_sticky_target(), Some(stranger));
        assert!(matches!(
            world.scene.step_local_sticky(make_pose(50.0, 50.0), 0.016, 4.0),
            LocalStickyStep::Inactive
        ));
    }
}
