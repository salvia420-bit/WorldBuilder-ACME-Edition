use super::{
    BuildingAabbEntry, ContactState, LocalDriveControl, SelfPlayerDriveProjectionState,
    SolveBodyInput, SolveProjectionBasis, SolvedBodyKinematics, SpatialSampleMode, SpatialScene,
    SpatialSolveBatch, SpatialSolveRequest,
};
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use holtburger_common::{Aabb, Guid, Quaternion, Vector3};
use std::f32::consts::{PI, TAU};
use std::time::Duration;

const EPSILON: f32 = 1e-4;

/// Phase 6 step B player-capsule dimensions. ACE derives these from
/// `Setup._dat.Height` / `Setup._dat.Radius` per
/// `external/ACE/Source/ACE.Server/Physics/PartArray.cs:189-206`.
/// Retail human Setup `0x0200_0001` ships radius=0.4, height=1.8;
/// hard-coded here rather than read at runtime to avoid a Setup
/// fetch on every collision tick.
pub const PLAYER_CAPSULE_RADIUS: f32 = 0.4;
pub const PLAYER_CAPSULE_HEIGHT: f32 = 1.8;

/// Phase 6 step B: result of a single swept-sphere-vs-AABB query.
/// `t` is the parametric time of first contact in `[0.0, 1.0]`
/// (where 0.0 = start, 1.0 = full delta), `normal` is the
/// AABB-face outward normal at the contact point (used for slide
/// projection on the second sweep iteration), and `entry` carries
/// the building reference for diagnostics / Phase E door-state
/// sliding.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SweptSphereHit {
    pub t: f32,
    pub normal: Vector3,
    pub entry: BuildingAabbEntry,
}

/// Phase 6 step B: sweep a sphere of `radius` along `delta` and
/// return the earliest AABB contact, or `None` for a clean miss.
/// Uses the standard Minkowski-sum trick: inflate every AABB by the
/// sphere radius and ray-cast the sphere centre. `pose.coords` is
/// the start in the AC world frame (note: AABBs are stored in the
/// same global-meters frame as `pose.global_coords`, so the
/// caller's `delta` is consumed directly without per-landblock
/// conversion).
///
/// Implementation note: this is the slab method
/// (Kay-Kajiya / Williams) — for each axis compute t-range for the
/// ray entering and exiting the slab, intersect the three ranges,
/// pick the entry t. Capsule approximation uses sphere-at-chest-
/// height; vertical extent is folded into the AABBs themselves
/// (a 0.5 m roof overhang lookup against a 1.8 m capsule means the
/// AABB's `min.z` is below the player's feet anyway).
pub fn sweep_sphere_against_aabbs(
    candidates: &[BuildingAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> Option<SweptSphereHit> {
    if delta.length_squared() <= 1e-10 || candidates.is_empty() {
        return None;
    }
    let start = pose.global_coords();
    let mut best: Option<SweptSphereHit> = None;
    for entry in candidates {
        let inflated = entry.aabb.inflate(radius);
        if let Some((t, normal)) = ray_aabb_entry(start, delta, &inflated)
            && (best.is_none() || t < best.unwrap().t)
        {
            best = Some(SweptSphereHit {
                t,
                normal,
                entry: *entry,
            });
        }
    }
    best
}

fn ray_aabb_entry(
    origin: Vector3,
    direction: Vector3,
    aabb: &Aabb,
) -> Option<(f32, Vector3)> {
    let mut t_enter = 0.0f32;
    let mut t_exit = 1.0f32;
    let mut entry_axis: u8 = u8::MAX;
    let mut entry_sign: f32 = 0.0;

    let mins = [aabb.min.x, aabb.min.y, aabb.min.z];
    let maxs = [aabb.max.x, aabb.max.y, aabb.max.z];
    let starts = [origin.x, origin.y, origin.z];
    let dirs = [direction.x, direction.y, direction.z];

    for axis in 0..3 {
        let d = dirs[axis];
        let s = starts[axis];
        let lo = mins[axis];
        let hi = maxs[axis];
        if d.abs() < f32::EPSILON {
            if s < lo || s > hi {
                return None;
            }
            continue;
        }
        let inv_d = 1.0 / d;
        let mut t_lo = (lo - s) * inv_d;
        let mut t_hi = (hi - s) * inv_d;
        let mut sign_for_axis = -1.0f32;
        if t_lo > t_hi {
            std::mem::swap(&mut t_lo, &mut t_hi);
            sign_for_axis = 1.0;
        }
        if t_lo > t_enter {
            t_enter = t_lo;
            entry_axis = axis as u8;
            entry_sign = sign_for_axis;
        }
        if t_hi < t_exit {
            t_exit = t_hi;
        }
        if t_enter > t_exit {
            return None;
        }
    }

    if t_enter >= 1.0 || t_enter < 0.0 {
        return None;
    }
    if entry_axis == u8::MAX {
        return None;
    }
    let normal = match entry_axis {
        0 => Vector3::new(entry_sign, 0.0, 0.0),
        1 => Vector3::new(0.0, entry_sign, 0.0),
        _ => Vector3::new(0.0, 0.0, entry_sign),
    };
    Some((t_enter, normal))
}

/// Apply swept-sphere clamp + single-iteration slide. Returns the
/// new `delta` the integrator should consume (in place of the raw
/// `velocity * dt`). Does not mutate input.
pub fn clamp_delta_against_buildings(
    candidates: &[BuildingAabbEntry],
    pose: &WorldPosition,
    delta: Vector3,
    radius: f32,
) -> Vector3 {
    let Some(hit) = sweep_sphere_against_aabbs(candidates, pose, delta, radius) else {
        return delta;
    };
    let backoff = 1e-3;
    let safe_t = (hit.t - backoff / delta.length().max(1e-6)).max(0.0);
    let stopped_delta = delta * safe_t;
    let remaining = delta * (1.0 - safe_t);
    let into_normal = remaining.dot(&hit.normal);
    let slide = remaining - hit.normal * into_normal;
    if slide.length_squared() <= 1e-10 {
        return stopped_delta;
    }
    let slide_pose = WorldPosition {
        landblock_id: pose.landblock_id,
        coords: Vector3::new(
            pose.coords.x + stopped_delta.x,
            pose.coords.y + stopped_delta.y,
            pose.coords.z + stopped_delta.z,
        ),
        rotation: pose.rotation,
    };
    let slide_clamped = match sweep_sphere_against_aabbs(candidates, &slide_pose, slide, radius) {
        Some(slide_hit) => slide * (slide_hit.t - backoff / slide.length().max(1e-6)).max(0.0),
        None => slide,
    };
    stopped_delta + slide_clamped
}

fn velocity_kinematics_for_input(input: &SolveBodyInput) -> (Vector3, Vector3) {
    match input.basis {
        Some(SolveProjectionBasis::Velocity { velocity, omega }) => (velocity, omega),
        Some(SolveProjectionBasis::GroundedMotion { .. }) | None => {
            (Vector3::zero(), Vector3::zero())
        }
    }
}

fn grounded_kinematics_for_input(input: &SolveBodyInput) -> Option<(Vector3, Vector3)> {
    match input.basis {
        Some(SolveProjectionBasis::GroundedMotion {
            desired_local_velocity,
            desired_local_omega,
        }) => Some((desired_local_velocity, desired_local_omega)),
        _ => None,
    }
}

pub(super) fn sample_mode_for_projection_state(
    projection_state: Option<SelfPlayerDriveProjectionState>,
    velocity: Vector3,
    omega: Vector3,
) -> SpatialSampleMode {
    match projection_state {
        Some(SelfPlayerDriveProjectionState::AuthorityFrozen) => SpatialSampleMode::Suspended,
        Some(SelfPlayerDriveProjectionState::LocalGroundedDirectDrive) => {
            SpatialSampleMode::SimulatingMotionState
        }
        Some(SelfPlayerDriveProjectionState::LocalAirborne)
        | Some(SelfPlayerDriveProjectionState::ServerControlled)
        | None => {
            if velocity.length_squared() > EPSILON || omega.length_squared() > EPSILON {
                SpatialSampleMode::SimulatingVelocity
            } else {
                SpatialSampleMode::SimulatingMotionState
            }
        }
    }
}

fn desired_heading_for_local_drive(control: &LocalDriveControl, current_heading: f32) -> f32 {
    if let Some(desired_heading) = control.desired_heading {
        return normalize_heading(desired_heading);
    }

    let planar_delta = Vector3::new(
        control.desired_world_delta.x,
        control.desired_world_delta.y,
        0.0,
    );
    if planar_delta.length_squared() <= EPSILON {
        current_heading
    } else {
        Vector3::zero().heading_to(&planar_delta)
    }
}

fn derive_self_player_projection_state(
    scene: &SpatialScene,
    control: &LocalDriveControl,
) -> SelfPlayerDriveProjectionState {
    let Some(body) = scene.body(control.body_id) else {
        return if control.force_grounded {
            SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
        } else {
            SelfPlayerDriveProjectionState::LocalAirborne
        };
    };

    if body.sampling.mode == SpatialSampleMode::Suspended {
        return SelfPlayerDriveProjectionState::AuthorityFrozen;
    }

    if !control.force_grounded && body.contact == ContactState::Airborne {
        return SelfPlayerDriveProjectionState::LocalAirborne;
    }

    SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
}

fn solve_self_player_local_drive(
    input: &SolveBodyInput,
    control: &LocalDriveControl,
    dt: Duration,
    scene: &SpatialScene,
) -> SolvedBodyKinematics {
    let projection_state = derive_self_player_projection_state(scene, control);
    let dt_secs = dt.as_secs_f32().max(0.0);
    let (velocity, omega) = velocity_kinematics_for_input(input);
    let current_contact = scene
        .body(control.body_id)
        .map(|body| body.contact)
        .unwrap_or(ContactState::Unknown);
    let resolved_contact = if input.contact == ContactState::Unknown {
        current_contact
    } else {
        input.contact
    };

    if dt_secs <= f32::EPSILON {
        return SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity,
            omega,
            contact: resolved_contact,
            projection_state: Some(projection_state),
        };
    }

    match projection_state {
        SelfPlayerDriveProjectionState::AuthorityFrozen => SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity: Vector3::zero(),
            omega: Vector3::zero(),
            contact: resolved_contact,
            projection_state: Some(projection_state),
        },
        SelfPlayerDriveProjectionState::LocalAirborne => {
            let mut solved = advance_body_kinematics(input, dt);
            solved.contact = resolved_contact;
            solved.projection_state = Some(projection_state);
            solved
        }
        SelfPlayerDriveProjectionState::LocalGroundedDirectDrive
        | SelfPlayerDriveProjectionState::ServerControlled => {
            let desired_velocity = control.desired_world_delta / dt_secs;
            let current_heading = input.pose.rotation.to_heading();
            let desired_heading = desired_heading_for_local_drive(control, current_heading);
            let candidates = scene.building_aabbs_near_pose(&input.pose);
            let mut next_pose = project_pose_by_velocity_with_collision(
                input.pose,
                desired_velocity,
                dt_secs,
                control.target_hint,
                &candidates,
            );
            next_pose.rotation = Quaternion::from_heading(desired_heading);

            SolvedBodyKinematics {
                body_id: input.body_id,
                pose: next_pose,
                velocity: desired_velocity,
                omega: Vector3::new(
                    0.0,
                    0.0,
                    signed_heading_delta(current_heading, desired_heading) / dt_secs,
                ),
                contact: if control.force_grounded {
                    ContactState::Grounded
                } else {
                    resolved_contact
                },
                projection_state: Some(projection_state),
            }
        }
    }
}

fn indoor_projection_landblock_id(
    authoritative_pose: WorldPosition,
    target_hint: Option<WorldPosition>,
) -> Option<Guid> {
    let indoor_hint_landblock_id = target_hint
        .filter(|hint| hint.is_indoors())
        .map(|hint| hint.landblock_id);

    indoor_hint_landblock_id.or_else(|| {
        authoritative_pose
            .is_indoors()
            .then_some(authoritative_pose.landblock_id)
    })
}

fn normalize_heading(heading: f32) -> f32 {
    heading.rem_euclid(TAU)
}

fn rotate_planar_velocity(velocity: Vector3, turn_step: f32) -> Vector3 {
    if turn_step.abs() <= f32::EPSILON {
        return velocity;
    }
    let sin = turn_step.sin();
    let cos = turn_step.cos();
    Vector3::new(
        (velocity.x * cos) + (velocity.y * sin),
        (-velocity.x * sin) + (velocity.y * cos),
        velocity.z,
    )
}

fn signed_heading_delta(current_heading: f32, desired_heading: f32) -> f32 {
    let mut delta = (desired_heading - current_heading) % TAU;
    if delta <= -PI {
        delta += TAU;
    } else if delta > PI {
        delta -= TAU;
    }
    delta
}

fn world_velocity_from_local_basis(local_velocity: Vector3, heading: f32) -> Vector3 {
    let forward = Vector3::new(-heading.cos(), heading.sin(), 0.0);
    let right = Vector3::new(heading.sin(), heading.cos(), 0.0);

    (forward * local_velocity.x)
        + (right * local_velocity.y)
        + Vector3::new(0.0, 0.0, local_velocity.z)
}

fn advance_grounded_body_kinematics(
    input: &SolveBodyInput,
    desired_local_velocity: Vector3,
    desired_local_omega: Vector3,
    dt: Duration,
) -> SolvedBodyKinematics {
    let dt_secs = dt.as_secs_f32().max(0.0);
    let current_heading = input.pose.rotation.to_heading();
    let world_velocity = world_velocity_from_local_basis(desired_local_velocity, current_heading);

    if dt_secs <= f32::EPSILON {
        return SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity: world_velocity,
            omega: desired_local_omega,
            contact: input.contact,
            projection_state: None,
        };
    }

    let next_heading = normalize_heading(current_heading + (desired_local_omega.z * dt_secs));
    let mut next_pose = project_pose_by_velocity(input.pose, world_velocity, dt_secs, None);
    next_pose.rotation = Quaternion::from_heading(next_heading);

    SolvedBodyKinematics {
        body_id: input.body_id,
        pose: next_pose,
        velocity: world_velocity,
        omega: desired_local_omega,
        contact: input.contact,
        projection_state: None,
    }
}

fn project_pose_by_offset(
    authoritative_pose: WorldPosition,
    offset: Vector3,
    target_hint: Option<WorldPosition>,
) -> WorldPosition {
    if offset.length_squared() <= f32::EPSILON {
        return authoritative_pose;
    }

    if let Some(indoor_landblock_id) =
        indoor_projection_landblock_id(authoritative_pose, target_hint)
    {
        let indoor_origin = WorldPosition {
            landblock_id: indoor_landblock_id,
            coords: Vector3::zero(),
            rotation: authoritative_pose.rotation,
        }
        .global_coords();
        let projected_global = authoritative_pose.global_coords() + offset;

        return WorldPosition {
            landblock_id: indoor_landblock_id,
            coords: Vector3::new(
                projected_global.x - indoor_origin.x,
                projected_global.y - indoor_origin.y,
                projected_global.z,
            ),
            rotation: authoritative_pose.rotation,
        };
    }

    let projected_global = authoritative_pose.global_coords() + offset;
    let landblock_x =
        (projected_global.x.div_euclid(METERS_PER_LANDBLOCK) as i32).clamp(0, 255) as u32;
    let landblock_y =
        (projected_global.y.div_euclid(METERS_PER_LANDBLOCK) as i32).clamp(0, 255) as u32;
    let low_word = authoritative_pose.landblock_id.0 & 0xFFFF;

    WorldPosition {
        landblock_id: Guid((landblock_x << 24) | (landblock_y << 16) | low_word),
        coords: Vector3::new(
            projected_global.x.rem_euclid(METERS_PER_LANDBLOCK),
            projected_global.y.rem_euclid(METERS_PER_LANDBLOCK),
            projected_global.z,
        ),
        rotation: authoritative_pose.rotation,
    }
    .normalize_outdoor_cell()
}

pub(crate) fn project_pose_by_velocity(
    authoritative_pose: WorldPosition,
    velocity: Vector3,
    dt_secs: f32,
    target_hint: Option<WorldPosition>,
) -> WorldPosition {
    if dt_secs <= 0.0 {
        return authoritative_pose;
    }

    project_pose_by_offset(authoritative_pose, velocity * dt_secs, target_hint)
}

/// Phase 6 step B: collision-aware variant of
/// [`project_pose_by_velocity`]. Sweeps the player capsule (treated
/// as a sphere at chest height) against `building_aabbs` before
/// applying the delta; clamps + slides on first contact. Falls back
/// to the unclamped path when `building_aabbs` is empty (preserves
/// pre-Phase-B behaviour during landblock entry / cache miss).
pub(crate) fn project_pose_by_velocity_with_collision(
    authoritative_pose: WorldPosition,
    velocity: Vector3,
    dt_secs: f32,
    target_hint: Option<WorldPosition>,
    building_aabbs: &[BuildingAabbEntry],
) -> WorldPosition {
    if dt_secs <= 0.0 {
        return authoritative_pose;
    }
    if building_aabbs.is_empty() {
        return project_pose_by_offset(authoritative_pose, velocity * dt_secs, target_hint);
    }
    let raw_delta = velocity * dt_secs;
    let clamped = clamp_delta_against_buildings(
        building_aabbs,
        &authoritative_pose,
        raw_delta,
        PLAYER_CAPSULE_RADIUS,
    );
    project_pose_by_offset(authoritative_pose, clamped, target_hint)
}

pub fn project_pose_forward_distance(
    authoritative_pose: WorldPosition,
    distance_m: f32,
) -> WorldPosition {
    if !distance_m.is_finite() {
        return authoritative_pose;
    }

    let heading = authoritative_pose.rotation.to_heading();
    let forward_offset = Vector3::new(-heading.cos(), heading.sin(), 0.0) * distance_m;

    project_pose_by_offset(authoritative_pose, forward_offset, None)
}

pub fn advance_body_kinematics(input: &SolveBodyInput, dt: Duration) -> SolvedBodyKinematics {
    let (velocity, omega) = velocity_kinematics_for_input(input);
    let dt_secs = dt.as_secs_f32().max(0.0);
    if dt_secs <= f32::EPSILON {
        return SolvedBodyKinematics {
            body_id: input.body_id,
            pose: input.pose,
            velocity,
            omega,
            contact: input.contact,
            projection_state: None,
        };
    }

    let turn_step = omega.z * dt_secs;
    let next_heading = normalize_heading(input.pose.rotation.to_heading() + turn_step);
    let next_velocity = rotate_planar_velocity(velocity, turn_step);

    let mut next_pose = input.pose;
    next_pose.rotation = Quaternion::from_heading(next_heading);
    next_pose.coords = next_pose.coords + (next_velocity * dt_secs);

    SolvedBodyKinematics {
        body_id: input.body_id,
        pose: next_pose,
        velocity: next_velocity,
        omega,
        contact: input.contact,
        projection_state: None,
    }
}

pub trait SpatialPhysics: Send + Sync + 'static {
    fn solve(&self, request: &SpatialSolveRequest, scene: &mut SpatialScene) -> SpatialSolveBatch;
}

#[derive(Debug, Default)]
pub struct BasicSpatialPhysics;

impl SpatialPhysics for BasicSpatialPhysics {
    fn solve(&self, request: &SpatialSolveRequest, scene: &mut SpatialScene) -> SpatialSolveBatch {
        let solved = request
            .bodies
            .iter()
            .map(|body| {
                if request
                    .local_drive
                    .as_ref()
                    .is_some_and(|control| control.body_id == body.body_id)
                    && let Some(control) = request.local_drive.as_ref()
                {
                    solve_self_player_local_drive(body, control, request.dt, scene)
                } else if let Some((desired_local_velocity, desired_local_omega)) =
                    grounded_kinematics_for_input(body)
                {
                    advance_grounded_body_kinematics(
                        body,
                        desired_local_velocity,
                        desired_local_omega,
                        request.dt,
                    )
                } else {
                    advance_body_kinematics(body, request.dt)
                }
            })
            .collect();

        SpatialSolveBatch {
            solved,
            events: Vec::new(),
        }
    }
}

#[derive(Debug, Default)]
pub struct NoopSpatialPhysics;

impl SpatialPhysics for NoopSpatialPhysics {
    fn solve(
        &self,
        _request: &SpatialSolveRequest,
        _scene: &mut SpatialScene,
    ) -> SpatialSolveBatch {
        SpatialSolveBatch {
            solved: Vec::new(),
            events: Vec::new(),
        }
    }
}
