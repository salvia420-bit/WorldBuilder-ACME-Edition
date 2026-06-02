mod entity_collision;
mod physics;
mod scene;
mod types;

pub use entity_collision::{EntityCollider, clamp_delta_against_entities};
pub use physics::{
    BasicSpatialPhysics, GenericSweptHit, NoopSpatialPhysics, PLAYER_CAPSULE_HEIGHT,
    PLAYER_CAPSULE_RADIUS, PLAYER_STEP_DOWN_HEIGHT, PLAYER_STEP_UP_HEIGHT, SpatialPhysics,
    StepDownOutcome, SweptSphereHit, advance_body_kinematics, clamp_delta_against_buildings,
    clamp_delta_against_cell_walls, clamp_delta_against_cell_walls_with_exclusions,
    clamp_delta_to_cell_interior, highest_floor_z_under, project_pose_forward_distance,
    step_down_decision, step_up_decision, sweep_sphere_against_aabbs,
    sweep_sphere_against_static_aabbs, sweep_sphere_against_triangles,
};
pub use scene::{SpatialScene, pview_clip_polygon_against_polygon, pview_project_polygon};
pub use types::*;

#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity;
#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity_with_collision;

#[cfg(test)]
mod tests;
