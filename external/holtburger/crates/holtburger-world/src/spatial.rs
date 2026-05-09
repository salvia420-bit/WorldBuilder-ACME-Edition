mod physics;
mod scene;
mod types;

pub use physics::{
    BasicSpatialPhysics, NoopSpatialPhysics, PLAYER_CAPSULE_HEIGHT, PLAYER_CAPSULE_RADIUS,
    SpatialPhysics, SweptSphereHit, advance_body_kinematics, clamp_delta_against_buildings,
    project_pose_forward_distance, sweep_sphere_against_aabbs,
};
pub use scene::SpatialScene;
pub use types::*;

#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity;
#[cfg(test)]
pub(crate) use physics::project_pose_by_velocity_with_collision;

#[cfg(test)]
mod tests;
