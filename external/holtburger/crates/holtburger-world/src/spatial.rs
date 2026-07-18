pub mod collision;
/// A6-T1/T2 (2026-06-12, W3+ S7) — the retail transition pipeline
/// (`find_transitional_position` substep loop over `TransitionEnv`
/// geometry backends). Consumed by `holtburger-core`'s movement system
/// under the default-off `USE_UNIFIED_TRANSITION` /
/// `?unifiedTransition=on` gates.
pub mod transition;
/// Phase 3 B4 (2026-06-28) — `SpatialScene` → `CObjCell` bridge wiring the
/// decomp-faithful `CTransition` collision driver (holtburger-dat
/// `transition::driver_validate`) into the live path, behind the default-off
/// `USE_FAITHFUL_TRANSITION` flag.
pub mod faithful_bridge;
mod entity_collision;
mod force_position_interp;
mod physics;
mod position_manager;
mod scene;
mod types;

pub use entity_collision::{EntityCollider, clamp_delta_against_entities, spheres_overlap_xy};
pub use force_position_interp::{
    InterpStep, MAX_INTERPOLATED_VELOCITY, RetailForcePositionInterpolator,
};
pub use position_manager::{
    ConstraintManager, INTERPOLATION_QUEUE_CAP, InterpolationCommand, InterpolationManager,
    InterpolationNode, InterpolationNodeType, PositionManager, STICKY_RADIUS, STICKY_TIME,
    StickyManager, USE_POSITION_MANAGER_QUEUE, USE_STICKY_MANAGER,
};
pub use physics::{
    BasicSpatialPhysics, DEFAULT_STEP_HEIGHT, GenericSweptHit, NoopSpatialPhysics,
    PLAYER_CAPSULE_HEIGHT, PLAYER_CAPSULE_RADIUS, PLAYER_STEP_DOWN_HEIGHT, PLAYER_STEP_UP_HEIGHT,
    SpatialPhysics, setup_step_heights,
    StepDownOutcome, SweptSphereHit, USE_SUBSTEP_TRANSITION, advance_body_kinematics,
    cell_wall_substep_count, clamp_delta_against_buildings,
    clamp_delta_against_buildings_with_normal, clamp_delta_against_cell_walls,
    collides_with_sphere, find_time_of_collision, landing_allows_touchdown,
    clamp_delta_against_cell_walls_dispatch, clamp_delta_against_cell_walls_substepped,
    clamp_delta_against_cell_walls_with_exclusions,
    clamp_delta_against_cell_walls_with_normal, clamp_delta_to_cell_interior,
    cliff_slide_residual_along_seam, FLOOR_Z, find_crossed_edge, floor_normal_under,
    highest_floor_z_under, precipice_slide_residual, project_pose_forward_distance,
    slide_residual_along_wall_tangent,
    step_down_decision, step_down_resolve, step_up_decision, sweep_sphere_against_aabbs,
    sweep_sphere_against_static_aabbs, sweep_sphere_against_triangles,
};
pub use scene::{
    CellMembership, CellPhysicsBsp, LocalStickyStep, RemoteCorrectionCtx, SpatialScene,
    pview_clip_polygon_against_polygon, pview_project_polygon,
};
pub use types::*;

#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity;
#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity_with_collision;

#[cfg(test)]
mod tests;

/// Offline repro + diagnosis of the Holtburg grocer EnvCell-seam
/// movement-refusal bug (Environment 840, cells 0xA9B4016A..0xA9B4016E),
/// driven from the real portal/cell DATs. DAT-gated; skips when absent.
#[cfg(test)]
mod env840_seam_tests;
