mod entity_collision;
mod physics;
mod scene;
mod types;

pub use entity_collision::{EntityCollider, clamp_delta_against_entities};
pub use physics::{
    BasicSpatialPhysics, GenericSweptHit, NoopSpatialPhysics, PLAYER_CAPSULE_HEIGHT,
    PLAYER_CAPSULE_RADIUS, SpatialPhysics, SweptSphereHit, advance_body_kinematics,
    clamp_delta_against_buildings, clamp_delta_against_cell_walls, clamp_delta_to_cell_interior,
    highest_floor_z_under, project_pose_forward_distance, sweep_sphere_against_aabbs,
    sweep_sphere_against_static_aabbs, sweep_sphere_against_triangles,
};
pub use scene::SpatialScene;
pub use types::*;

#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity;
#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity_with_collision;

#[cfg(test)]
mod tests;
