//! Authoritative world-state crate for the client.
//!
//! Ownership is split three ways:
//! - [`player`] owns the session-local player model and player-specific mutation helpers.
//! - [`state`] owns [`WorldState`](crate::state::WorldState), entity/spatial invariants, and
//!   world-facing mutation helpers.
//! - [`handlers`] owns feature-based protocol orchestration that translates decoded messages into
//!   narrow state mutations plus [`WorldEvent`] emission.

pub mod assessment;
pub mod book;
pub mod bootstrap;
pub mod context;
pub mod crafting;
pub mod damage;
pub mod entity;
pub mod events;
pub mod handlers;
pub mod hydration;
mod identify;
pub mod inspect;
pub mod magic;
pub mod player;
pub mod sky;
pub mod spatial;
pub mod spell;
pub mod state;
pub mod stats;
pub mod vendor;

pub use self::state::WorldState;
pub use bootstrap::WorldBootstrap;
pub use events::{DerivedStatsData, DoorState, FellowshipActivity, PlayerInfoData, WorldEvent};
pub use sky::{
    AC_LAUNCH_UNIX_EPOCH, SkyEvalState, SkyObjectSnapshot, SkyStateSnapshot,
    calc_present_day_group,
};
pub use spatial::{
    AuthoritativeBodySync, BasicSpatialPhysics, BuildingAabbEntry, BuildingId, CellPortalPolygon,
    ContactState, GenericSweptHit, LocalDriveControl, LocalDriveGait, NoopSpatialPhysics,
    PLAYER_CAPSULE_HEIGHT, PLAYER_CAPSULE_RADIUS, RuntimeBodyResetCause, RuntimeSpatialBodyView,
    SelfPlayerDriveProjectionState, SolveBodyInput, SolveProjectionBasis, SolvedBodyKinematics,
    SpatialBody, SpatialBodyEvent, SpatialBodyId, SpatialEntitySample, SpatialPhysics,
    SpatialSampleMode, SpatialSamplingConfig, SpatialSamplingState, SpatialScene,
    SpatialSolveBatch, SpatialSolveRequest, StaticAabbEntry, SweptSphereHit,
    advance_body_kinematics, clamp_delta_against_buildings, project_pose_forward_distance,
    pview_clip_polygon_against_polygon, pview_project_polygon, sweep_sphere_against_aabbs,
    sweep_sphere_against_static_aabbs, sweep_sphere_against_triangles,
};
pub use state::{
    PlayerMotionTableLookupError, PlayerMotionTableResolution, PlayerMotionTableSource,
    RequiredSelfMovementKinematics, SelfMovementCapabilities, SelfMovementCapabilitiesError,
    SelfMovementKinematics, SelfMovementKinematicsError,
};
