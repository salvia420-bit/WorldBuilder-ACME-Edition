pub mod collision;
mod entity_collision;
mod force_position_interp;
mod physics;
mod scene;
mod types;

pub use entity_collision::{EntityCollider, clamp_delta_against_entities};
pub use force_position_interp::{
    InterpStep, MAX_INTERPOLATED_VELOCITY, RetailForcePositionInterpolator,
};
pub use physics::{
    BasicSpatialPhysics, GenericSweptHit, NoopSpatialPhysics, PLAYER_CAPSULE_HEIGHT,
    PLAYER_CAPSULE_RADIUS, PLAYER_STEP_DOWN_HEIGHT, PLAYER_STEP_UP_HEIGHT, SpatialPhysics,
    StepDownOutcome, SweptSphereHit, USE_SUBSTEP_TRANSITION, advance_body_kinematics,
    cell_wall_substep_count, clamp_delta_against_buildings,
    clamp_delta_against_buildings_with_normal, clamp_delta_against_cell_walls,
    collides_with_sphere, find_time_of_collision,
    clamp_delta_against_cell_walls_dispatch, clamp_delta_against_cell_walls_substepped,
    clamp_delta_against_cell_walls_with_exclusions,
    clamp_delta_against_cell_walls_with_normal, clamp_delta_to_cell_interior,
    cliff_slide_residual_along_seam, FLOOR_Z, floor_normal_under,
    highest_floor_z_under, project_pose_forward_distance, slide_residual_along_wall_tangent,
    step_down_decision, step_up_decision, sweep_sphere_against_aabbs,
    sweep_sphere_against_static_aabbs, sweep_sphere_against_triangles,
};
pub use scene::{
    CellMembership, CellPhysicsBsp, SpatialScene, pview_clip_polygon_against_polygon,
    pview_project_polygon,
};
pub use types::*;

#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity;
#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity_with_collision;

#[cfg(test)]
mod tests;
