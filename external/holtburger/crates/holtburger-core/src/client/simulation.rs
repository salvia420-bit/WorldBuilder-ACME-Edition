use super::movement::{
    HUGE_QUANTUM, MAX_QUANTUM, MovementParameters, MovementSystem, RUN_ANIM_SPEED,
    ServerControlledProjection, WALK_ANIM_SPEED,
};
use super::movement_types::Gait;
use anyhow::Result;
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::WorldObjectExt;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::*;
use holtburger_session::ActionSink;
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

/// Wire `HoldKey::Run` (`MovementParameters::get_command` writes `2`;
/// acclient.c:346217-346221).
const HOLD_KEY_RUN: u32 = 2;

/// F1 (COL-21) — the server-controlled `MoveToObject` projection's
/// approach rate in REAL m/s, plus the gait retail's own gate picks.
///
/// Retail chain, all three links verified in the decomp:
/// `MovementParameters::get_command` (acclient.c:346175) emits the base
/// `WalkForward` plus a hold key — Run iff `CanCharge (0x10) ||
/// (CanRun (0x2) && (!CanWalk (0x1) || curr_distance -
/// distance_to_object > walk_run_threshhold))` (:346217).
/// `CMotionInterp::apply_run_to_command` (:343439) then promotes
/// `WalkForward -> RunForward` and scales the interpreted forward speed
/// by `my_run_rate` (:343463-343466) — the WALK arm never reaches that
/// multiply, so walk is NOT run-rate scaled. The on-ground body finally
/// travels at the AUTHORED cycle base x that interpreted speed: 4.000
/// m/s for the player MotionTable run cycle (numerically retail's
/// `RunAnimSpeed`, `get_state_velocity` :343565) and
/// [`WALK_ANIM_SPEED`] 3.1199999 for walk (:343561).
///
/// `params.speed` is the interpreted forward speed the MoveTo drive
/// installs (`MoveToManager::BeginMoveForward` :345411-345414).
///
/// Pre-fix this lane multiplied the DIMENSIONLESS `run_rate` scalar by
/// `params.speed` and used the product as m/s, so an ACE melee charge
/// (`run_rate` ~1.0-2.0, `speed` 1.5) crawled at ~1.5-3 m/s instead of
/// ~6-9. Past ~12-16 m that is slow enough for
/// `SERVER_PROJECTION_MAX_AGE` (8 s) to abandon the projection before
/// arrival — the reported "sticky melee fails from range".
fn server_controlled_approach_drive(
    params: &MovementParameters,
    run_rate: f32,
    curr_distance: f32,
    base_run_forward_speed: f32,
) -> (f32, Gait) {
    // `get_command` never reads the heading argument (:346175) — facing
    // is the turn node's job.
    let (_, hold_key, _) = params.get_command(curr_distance, 0.0);
    let speed_mod = if params.speed.is_finite() && params.speed > 0.0 {
        params.speed
    } else {
        1.0
    };
    if hold_key == HOLD_KEY_RUN {
        let base = if base_run_forward_speed.is_finite() && base_run_forward_speed > 1e-3 {
            base_run_forward_speed
        } else {
            RUN_ANIM_SPEED
        };
        let rate = if run_rate.is_finite() && run_rate > 0.0 {
            run_rate
        } else {
            1.0
        };
        ((base * rate * speed_mod).max(0.1), Gait::Run)
    } else {
        ((WALK_ANIM_SPEED * speed_mod).max(0.1), Gait::Walk)
    }
}

#[derive(Debug, Default)]
pub(super) struct ClientSimulationSystem {
    tracked_body_ids: Vec<SpatialBodyId>,
    /// F1/F2 (physics parity 2026-07-03) — the retail-quantum-loop
    /// remainder bank: the sub-`MIN_QUANTUM` post-slicing tail retail
    /// carries by advancing `update_time` only by the consumed slices
    /// (acclient.c:323146-323148). Written ONLY when the retail loop is
    /// active (`MovementSystem::retail_quantum_enabled`); stays 0.0 —
    /// and the default path stays byte-identical — otherwise.
    physics_time_carry: f32,
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
        let slices = if movement.retail_quantum_enabled() {
            // USE_RETAIL_QUANTUM (system.rs) — the retail update_object
            // loop (acclient.c:323123-323161): 0.0002 consume-skip, 0.2
            // direct entry, 0.2 slices + sub-1/30 remainder banked into
            // `physics_time_carry`. With zero slices (consumed/skipped)
            // nothing steps this tick — including the remote position
            // managers, which retail also only steps inside an integrated
            // quantum. `carry > 0` implies at least one slice, so the
            // bank can never starve the loop.
            let total = self.physics_time_carry + dt_secs;
            let (slices, carry) = MovementSystem::retail_quantum_schedule(total);
            self.physics_time_carry = carry;
            slices
        } else {
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
            slices
        };

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
            let (object, mut gates) = MovementSystem::transition_profile(world);
            // (2026-06-30) — apply the `?roofGrounding=off` runtime carrier over
            // the const default (mirrors faithful_stepup); see the system.rs twin.
            gates.outdoor_static_grounding = movement.outdoor_static_grounding_enabled();
            // (2026-07-02) — apply the `?retailGround=off` runtime carrier.
            gates.retail_ground = movement.retail_ground_enabled();
            // TIER-3 (2026-07-28) — the COL-16/COL-17/isOnGround carriers
            // (system.rs twin).
            gates.world_frame_terrain_plane = movement.terrain_plane_frame_enabled();
            gates.airborne_check_contact = movement.airborne_check_contact_enabled();
            gates.walkable_landing_ground = movement.walkable_landing_ground_enabled();
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
                entry_descending: true,
                force_grounded: control.force_grounded,
                gates,
                last_known_wall_normal: world.player.last_known_wall_normal,
                frames_stationary_fall: 0,
                // USE_RETAIL_GROUND: same contact-plane carry as the manual
                // slice (system.rs twin).
                last_contact_plane: world.player.last_contact_plane,
                // USE_AIRBORNE_CHECK_CONTACT: the mover's physics velocity for
                // retail's exact `check_contact` dot (system.rs twin).
                physics_velocity: Vector3::new(
                    world.player.current_planar_velocity.x,
                    world.player.current_planar_velocity.y,
                    world.player.vertical_velocity,
                ),
            };
            let outcome = transition::find_transitional_position_dispatch(
                &*world,
                &input,
                movement.faithful_transition_enabled(),
                movement.faithful_outdoor_enabled(),
                movement.faithful_stepup_enabled(),
            );
            if let Some(n) = outcome.wall_normal {
                world.player.last_known_wall_normal = Some(n);
            }
            // USE_RETAIL_GROUND: mirror the settled plane exactly, clearing
            // when none was touched (system.rs twin).
            if gates.retail_ground {
                world.player.last_contact_plane = outcome.contact_plane;
            }
            let mut next_pose = outcome.pose;
            let current_heading = pose.rotation.to_heading();
            let desired_heading = control.desired_heading.unwrap_or(current_heading);
            // Kinematic turn realization (2026-07-18, soak-9 §3 fix): rotate
            // at the authored turn omega instead of snapping. The MoveTo
            // driver's TurnToHeading arrival is an OVERSHOOT test
            // (`heading_greater`, acclient.c:344715/:345739 — retail snaps
            // only after the body PASSES the node, :345746), so an instant
            // snap onto the node NEVER arrives for TurnRight turns (equality
            // fails the strict compare) and the driver turned forever — the
            // soak's indoor "walk:no-walk" wedge. Turn-node slices
            // (zero-delta control) take the FULL omega·dt step, crossing the
            // node like the retail turn animation; walking slices clamp at
            // the bearing (retail's aux-turn stops inside its ±20° band —
            // no arrival test depends on overshoot there). `None` omega
            // (server-projection reconcile) keeps the instant snap.
            let realized_heading = match control.turn_omega_rad_s {
                Some(omega) if omega > 0.0 && desired_heading != current_heading => {
                    use std::f32::consts::{PI, TAU};
                    let mut diff = (desired_heading - current_heading).rem_euclid(TAU);
                    if diff > PI {
                        diff -= TAU;
                    }
                    let step = omega * slice_dt.as_secs_f32();
                    let translating = control.desired_world_delta.length_squared() > 1e-12;
                    if translating && diff.abs() <= step {
                        desired_heading
                    } else {
                        current_heading + step.copysign(diff)
                    }
                }
                _ => desired_heading,
            };
            next_pose.rotation = Quaternion::from_heading(realized_heading);
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

        // F2 follow-on (`USE_STICKY_IDLE_STEP`) — neither arm claimed
        // this slice (no drive, no manual input). Retail still runs the
        // sticky pull here: `PositionManager::adjust_offset` is part of
        // the per-object physics pass, not of input handling
        // (acclient.c:388287-388304 chained at :320029), and standing
        // still while swinging is the case the glue exists for. Returns
        // `false` either way so the legacy solve still runs its normal
        // gravity/contact pass — from the sticky-updated pose.
        movement.step_local_sticky_idle_slice(world, slice_dt);

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
        session: &mut dyn ActionSink,
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

                // F1 (COL-21) — `get_command`'s hold-key rule measures to
                // the TARGET OBJECT centre, not to the arrival standoff
                // (`curr_distance - distance_to_object >
                // walk_run_threshhold`, acclient.c:346217), so the
                // distance fed here is player -> `origin`, NOT player ->
                // `target_pose`.
                let mut target_center = current_pos;
                target_center.landblock_id = mto.origin.cell_id;
                target_center.coords = mto.origin.position;
                let capabilities = world.resolve_self_movement_capabilities().ok();
                // Retail `unpack_movement` case 6 stores the wire
                // `run_rate` into the mover's `my_run_rate`
                // (acclient.c:339571); a non-positive wire value keeps the
                // last resolved rate rather than freezing the approach.
                let run_rate = if mto.run_rate.is_finite() && mto.run_rate > 0.0 {
                    mto.run_rate
                } else {
                    capabilities.as_ref().map_or(1.0, |c| c.run_rate_scalar)
                };
                let (speed_mps, gait) = server_controlled_approach_drive(
                    &MovementParameters::from_wire_moveto(&mto.params),
                    run_rate,
                    current_pos.distance_to(&target_center),
                    capabilities
                        .as_ref()
                        .map_or(RUN_ANIM_SPEED, |c| c.base_run_forward_speed()),
                );

                // F2 (COL-21 structural) — the faithful driver owns this
                // directive when [`USE_SERVER_MOVETO_DRIVER`] is
                // effective AND the target entity resolves. Retail runs
                // exactly one consumer for wire type 6 regardless of who
                // asked (`unpack_movement` case 6 -> `PerformMovement`,
                // acclient.c:346133-346145), and only that pipeline
                // reaches the turn-then-move node order (:345859) and
                // the Sticky-bit arrival handoff
                // (`BeginNextNode` empty queue -> `StickTo`,
                // :345553-345566). An unresolvable target degrades to the
                // projection below, which can still drive to the wire
                // `origin` rather than cancelling 0x37 next frame.
                let driver_target = movement
                    .server_moveto_driver_enabled()
                    .then(|| world.get_visible_entity(mto.target).map(|_| mto.target))
                    .flatten();
                if let Some(target) = driver_target {
                    movement.clear_server_controlled_projection();
                    movement.enqueue_server_controlled_moveto(
                        Some(target),
                        mto.origin.cell_id,
                        mto.origin.position,
                        // Retail resolves the sought object's dims off
                        // `CPartArray::GetRadius/GetHeight` with a 0.0
                        // fallback (acclient.c:319808-319817); our entity
                        // model surfaces `use_radius` only.
                        target_use_radius.unwrap_or(0.0),
                        0.0,
                        MovementParameters::from_wire_moveto(&mto.params),
                        capabilities
                            .as_ref()
                            .map_or(RUN_ANIM_SPEED, |c| c.base_run_forward_speed())
                            * run_rate,
                        mto.params.speed,
                    );
                    movement.arm_autonomous_position_heartbeat_schedule(Instant::now(), world);
                    if USE_STICKY_MANAGER {
                        apply_local_sticky_from_invalid(world, None);
                    }
                    return Ok(Vec::new());
                }

                movement.set_server_controlled_projection(ServerControlledProjection {
                    target_pose,
                    speed_mps,
                    gait,
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
            MovementTypeData::MoveToPosition(mtp)
                if movement.server_moveto_driver_enabled() =>
            {
                // F2 — wire type 7 on the faithful driver. Pre-fix this
                // arm fell through to `build_server_controlled_result`,
                // which SNAPS the avatar onto `origin` in one frame; the
                // driver walks it there with the same node order retail
                // builds (`MoveToPosition` :345790-345857, sticky bit
                // cleared at :345852) and the same fail-distance /
                // progress give-ups.
                let capabilities = world.resolve_self_movement_capabilities().ok();
                let run_rate = if mtp.run_rate.is_finite() && mtp.run_rate > 0.0 {
                    mtp.run_rate
                } else {
                    capabilities.as_ref().map_or(1.0, |c| c.run_rate_scalar)
                };
                movement.clear_server_controlled_projection();
                movement.enqueue_server_controlled_moveto(
                    None,
                    mtp.origin.cell_id,
                    mtp.origin.position,
                    0.0,
                    0.0,
                    MovementParameters::from_wire_moveto(&mtp.params),
                    capabilities
                        .as_ref()
                        .map_or(RUN_ANIM_SPEED, |c| c.base_run_forward_speed())
                        * run_rate,
                    mtp.params.speed,
                );
                movement.arm_autonomous_position_heartbeat_schedule(Instant::now(), world);
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

    /// F1 (COL-21) — ACE's player melee charge
    /// (`Player_Move.cs:230-245`): CanRun|CanCharge|Sticky, `speed`
    /// 1.5, `distance_to_object` 0.6. Retail lands
    /// `4.0 x run_rate x 1.5`; the pre-fix lane produced
    /// `run_rate x 1.5` — 4x low, and low enough for the 8 s
    /// `SERVER_PROJECTION_MAX_AGE` to abandon a 20 m approach.
    #[test]
    fn approach_drive_charge_uses_run_anim_speed_not_the_run_rate_scalar() {
        let params = MovementParameters {
            // CanWalk|CanRun|CanCharge|Sticky|MoveTowards|UseSpheres
            bitfield: 0x1 | 0x2 | 0x10 | 0x80 | 0x200 | 0x400,
            speed: 1.5,
            distance_to_object: 0.6,
            walk_run_threshhold: 1.0,
            ..Default::default()
        };

        let (speed, gait) = server_controlled_approach_drive(&params, 1.0, 20.0, RUN_ANIM_SPEED);
        assert_eq!(gait, Gait::Run);
        assert!((speed - 6.0).abs() < 1e-4, "expected 4.0*1.0*1.5, got {speed}");

        // run_rate scales the RUN arm (`apply_run_to_command`
        // :343463-343466).
        let (fast, _) = server_controlled_approach_drive(&params, 1.5, 20.0, RUN_ANIM_SPEED);
        assert!((fast - 9.0).abs() < 1e-4, "expected 4.0*1.5*1.5, got {fast}");

        // CanCharge (0x10) short-circuits the distance branch, so a
        // 1 m charge still runs.
        let (close, close_gait) =
            server_controlled_approach_drive(&params, 1.0, 1.0, RUN_ANIM_SPEED);
        assert_eq!(close_gait, Gait::Run);
        assert!((close - 6.0).abs() < 1e-4);
    }

    /// The walk arm of `get_command` (no CanCharge, CanWalk set,
    /// inside `walk_run_threshhold`) realizes `WALK_ANIM_SPEED` and is
    /// NOT run-rate scaled — `apply_run_to_command`'s `* my_run_rate`
    /// only runs on the WalkForward->RunForward promotion.
    #[test]
    fn approach_drive_walk_arm_is_walk_anim_speed_without_run_rate() {
        let params = MovementParameters {
            bitfield: 0x1 | 0x2 | 0x200 | 0x400, // CanWalk|CanRun|MoveTowards|UseSpheres
            speed: 1.0,
            distance_to_object: 0.6,
            walk_run_threshhold: 15.0,
            ..Default::default()
        };

        // 5 m out: 5 - 0.6 = 4.4 <= 15 -> hold key None -> walk.
        let (speed, gait) = server_controlled_approach_drive(&params, 4.0, 5.0, RUN_ANIM_SPEED);
        assert_eq!(gait, Gait::Walk);
        assert!(
            (speed - WALK_ANIM_SPEED).abs() < 1e-4,
            "expected WALK_ANIM_SPEED, got {speed}"
        );

        // 20 m out: 20 - 0.6 = 19.4 > 15 -> hold key Run.
        let (far, far_gait) = server_controlled_approach_drive(&params, 4.0, 20.0, RUN_ANIM_SPEED);
        assert_eq!(far_gait, Gait::Run);
        assert!((far - 16.0).abs() < 1e-4, "expected 4.0*4.0*1.0, got {far}");
    }

    /// Non-positive / non-finite inputs must never freeze the approach
    /// (the projection drives the avatar every tick).
    #[test]
    fn approach_drive_degrades_to_the_retail_constants() {
        let params = MovementParameters {
            bitfield: 0x2 | 0x10 | 0x200,
            speed: 0.0,
            ..Default::default()
        };
        let (speed, gait) = server_controlled_approach_drive(&params, 0.0, 20.0, 0.0);
        assert_eq!(gait, Gait::Run);
        assert!(
            (speed - RUN_ANIM_SPEED).abs() < 1e-4,
            "expected the 4.0 fallback, got {speed}"
        );
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
