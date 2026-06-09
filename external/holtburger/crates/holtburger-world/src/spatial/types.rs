use crate::entity::EntityMotionSnapshot;
use crate::spatial::force_position_interp::RetailForcePositionInterpolator;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Vector3};
use std::time::Duration;
use web_time::Instant;

/// Identifier for a building placement loaded into the per-cell
/// AABB index. Phase 6 step B uses the placement's `(landblock_id,
/// model_id, sequence)` tuple — the manifest doesn't expose stable
/// per-placement guids and a single building model can occur many
/// times in one landblock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BuildingId {
    pub landblock_id: u32,
    pub model_id: u32,
    pub sequence: u32,
}

impl BuildingId {
    pub const fn new(landblock_id: u32, model_id: u32, sequence: u32) -> Self {
        Self {
            landblock_id,
            model_id,
            sequence,
        }
    }
}

/// Single per-part building AABB stored in the per-cell index. The
/// index buckets these by the cell id the AABB falls into; the
/// sweeper looks up the player's current cell + immediate neighbours
/// each tick.
///
/// Phase 6 step E: `part_index` and `active` were added so door parts
/// can be addressed individually and toggled on/off when their state
/// changes. The `building_aabbs_near_pose` sweeper filters out
/// `active == false` entries so an open door drops out of collision
/// without rebuilding the index, and a subsequent close flips the
/// flag back. Non-door parts default to `active == true` and never
/// change.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BuildingAabbEntry {
    pub building_id: BuildingId,
    pub part_index: u8,
    pub aabb: Aabb,
    pub active: bool,
}

/// Phase 5 PView port (2026-05-25): one portal polygon on an EnvCell,
/// transformed into world coords. Stored in
/// `SpatialScene::cell_portal_polygons` keyed by the EnvCell's
/// `cell_id`; the polygon's vertices are projected to screen space at
/// PView walk time and clipped against the parent view polygon.
///
/// `other_cell_id` is the full 32-bit id of the cell on the far side
/// (`landblock_high | EnvCell.portals[i].other_cell_id` for indoor
/// neighbours; `landblock_high | 0xFFFF` for outward-facing portals
/// that exit to outdoor LandCells).
///
/// Vertices are stored as a `Vec<Vector3>` rather than a fixed-size
/// array because portal polygons in AC are convex but not constrained
/// to triangles — typical retail cottages have rectangular doorways
/// (4 verts) but some dungeons have more complex portal shapes.
#[derive(Debug, Clone, PartialEq)]
pub struct CellPortalPolygon {
    pub other_cell_id: u32,
    pub vertices: Vec<Vector3>,
}

/// Workstream C (3D camera collision, 2026-05-11): world-space AABB for
/// a non-building static placement (signs, props, foliage, trees).
/// Statics are loaded from `LandblockInfo.objects` (the `Stab` list)
/// alongside buildings, but with `is_building == false`. They live in
/// outdoor space; indoor statics ride through `EnvCellPlacement
/// .static_objects` and are addressable via the per-cell AABB index.
///
/// Camera collision uses this index to keep the third-person follow
/// camera from poking through trees and signage. The player capsule
/// already avoids walking through building parts via the existing
/// `building_aabb_index`; statics are camera-only collision today.
///
/// `did` is the placement's model id (`0x01XXXXXX` GfxObj or
/// `0x02XXXXXX` SetupModel) — kept for diagnostics. `aabb` is in the
/// global-meters frame so the existing `sweep_sphere_against_aabbs`
/// primitive consumes it without per-landblock conversion.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StaticAabbEntry {
    pub did: u32,
    pub aabb: Aabb,
    /// B4 Tier-2 (2026-06-09): true when this static ALSO has a precise
    /// physics BSP registered in `statics_physics_bsp` (same landblock).
    /// When `USE_STATIC_BSP` is on, the integrator cedes these entries
    /// from the coarse-AABB sweep to the per-static BSP push-out so the
    /// capsule can approach the true surface (the AABB stops it short of
    /// thin geometry like a tree trunk). Always `false` for the AABB-only
    /// Tier-1 path, so that sweep is byte-identical when the gate is off.
    pub has_bsp: bool,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ContactState {
    #[default]
    Unknown,
    Airborne,
    Grounded,
}

impl ContactState {
    pub const fn grounded(self) -> Option<bool> {
        match self {
            Self::Unknown => None,
            Self::Airborne => Some(false),
            Self::Grounded => Some(true),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpatialBodyId {
    Entity(Guid),
    LocalPlayer(Guid),
    Ephemeral(u64),
}

impl SpatialBodyId {
    pub const fn authoritative_guid(self) -> Option<Guid> {
        match self {
            Self::Entity(guid) | Self::LocalPlayer(guid) => Some(guid),
            Self::Ephemeral(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SpatialSampleMode {
    #[default]
    AuthoritativeOnly,
    SimulatingMotionState,
    SimulatingVelocity,
    Suspended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfPlayerDriveProjectionState {
    LocalGroundedDirectDrive,
    LocalAirborne,
    ServerControlled,
    AuthorityFrozen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthoritativeBodySync {
    Snapshot,
    Reset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeBodyResetCause {
    InitialHydration,
    TeleportOrWorldReset,
    Resync,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpatialSamplingState {
    pub mode: SpatialSampleMode,
    pub last_authoritative_update: Instant,
    pub last_derived_at: Instant,
}

impl SpatialSamplingState {
    pub fn authoritative(now: Instant) -> Self {
        Self {
            mode: SpatialSampleMode::AuthoritativeOnly,
            last_authoritative_update: now,
            last_derived_at: now,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpatialSamplingConfig {
    pub max_position_interp: Duration,
    pub max_dead_reckon: Duration,
    pub snap_distance_m: u32,
    pub snap_heading_millirad: u32,
}

impl Default for SpatialSamplingConfig {
    fn default() -> Self {
        Self {
            max_position_interp: Duration::from_millis(150),
            max_dead_reckon: Duration::from_millis(1250),
            snap_distance_m: 3,
            snap_heading_millirad: 785,
        }
    }
}

impl SpatialSamplingConfig {
    pub fn snap_distance_meters(self) -> f32 {
        self.snap_distance_m as f32
    }

    pub fn snap_heading_radians(self) -> f32 {
        self.snap_heading_millirad as f32 / 1000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpatialEntitySample {
    pub guid: Guid,
    pub authoritative_pose: WorldPosition,
    pub projected_pose: WorldPosition,
    pub velocity: Vector3,
    pub omega: Vector3,
    pub motion_state: Option<EntityMotionSnapshot>,
    pub projection_mode: SpatialSampleMode,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RuntimeSpatialBodyView {
    pub body_id: SpatialBodyId,
    pub authoritative_pose: Option<WorldPosition>,
    pub runtime_pose: WorldPosition,
    pub velocity: Vector3,
    pub omega: Vector3,
    pub motion_state: Option<EntityMotionSnapshot>,
    pub contact: ContactState,
    pub sample_mode: SpatialSampleMode,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpatialBody {
    pub id: SpatialBodyId,
    pub authoritative_pose: Option<WorldPosition>,
    pub pose: WorldPosition,
    pub velocity: Vector3,
    pub omega: Vector3,
    pub motion_state: Option<EntityMotionSnapshot>,
    pub contact: ContactState,
    pub sampling: SpatialSamplingState,
    /// Physics deep-dive 2026-06-01 (gap 4) — the faithful retail
    /// `InterpolateTo` / `ConstrainTo` reconciliation easing state for a
    /// LOCAL-player force-position. Only populated when the
    /// [`crate::spatial::scene`] `USE_RETAIL_INTERPOLATE` flag is on; the
    /// default single-step constraint-pull path never touches it. The
    /// per-frame integrator advances it via
    /// [`crate::spatial::SpatialScene::step_force_position_interpolation`].
    pub force_position_interp: RetailForcePositionInterpolator,
}

impl SpatialBody {
    pub fn new(id: SpatialBodyId, pose: WorldPosition, now: Instant) -> Self {
        Self {
            id,
            authoritative_pose: Some(pose),
            pose,
            velocity: Vector3::zero(),
            omega: Vector3::zero(),
            motion_state: None,
            contact: ContactState::Unknown,
            sampling: SpatialSamplingState::authoritative(now),
            force_position_interp: RetailForcePositionInterpolator::default(),
        }
    }

    pub fn new_ephemeral(id: SpatialBodyId, pose: WorldPosition, now: Instant) -> Self {
        Self {
            id,
            authoritative_pose: None,
            pose,
            velocity: Vector3::zero(),
            omega: Vector3::zero(),
            motion_state: None,
            contact: ContactState::Unknown,
            sampling: SpatialSamplingState::authoritative(now),
            force_position_interp: RetailForcePositionInterpolator::default(),
        }
    }

    pub fn spatial_sample(&self) -> Option<SpatialEntitySample> {
        let guid = self.id.authoritative_guid()?;
        let authoritative_pose = self.authoritative_pose.unwrap_or(self.pose);
        Some(SpatialEntitySample {
            guid,
            authoritative_pose,
            projected_pose: self.pose,
            velocity: self.velocity,
            omega: self.omega,
            motion_state: self.motion_state,
            projection_mode: self.sampling.mode,
        })
    }

    pub fn runtime_view(&self) -> RuntimeSpatialBodyView {
        RuntimeSpatialBodyView {
            body_id: self.id,
            authoritative_pose: self.authoritative_pose,
            runtime_pose: self.pose,
            velocity: self.velocity,
            omega: self.omega,
            motion_state: self.motion_state,
            contact: self.contact,
            sample_mode: self.sampling.mode,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SolveProjectionBasis {
    Velocity {
        velocity: Vector3,
        omega: Vector3,
    },
    GroundedMotion {
        desired_local_velocity: Vector3,
        desired_local_omega: Vector3,
    },
}

impl SolveProjectionBasis {
    pub const fn velocity(velocity: Vector3, omega: Vector3) -> Self {
        Self::Velocity { velocity, omega }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolveBodyInput {
    pub body_id: SpatialBodyId,
    pub pose: WorldPosition,
    pub contact: ContactState,
    pub basis: Option<SolveProjectionBasis>,
}

impl SolveBodyInput {
    pub const fn velocity(
        body_id: SpatialBodyId,
        pose: WorldPosition,
        contact: ContactState,
        velocity: Vector3,
        omega: Vector3,
    ) -> Self {
        Self {
            body_id,
            pose,
            contact,
            basis: Some(SolveProjectionBasis::Velocity { velocity, omega }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolvedBodyKinematics {
    pub body_id: SpatialBodyId,
    pub pose: WorldPosition,
    pub velocity: Vector3,
    pub omega: Vector3,
    pub contact: ContactState,
    pub projection_state: Option<SelfPlayerDriveProjectionState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpatialBodyEvent {
    ContactChanged {
        body_id: SpatialBodyId,
        contact: ContactState,
    },
    ForcedReposition {
        body_id: SpatialBodyId,
        pose: WorldPosition,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalDriveGait {
    Walk,
    Run,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalDriveControl {
    pub body_id: SpatialBodyId,
    pub desired_world_delta: Vector3,
    pub desired_heading: Option<f32>,
    pub target_hint: Option<WorldPosition>,
    pub gait: LocalDriveGait,
    pub force_grounded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpatialSolveRequest {
    pub dt: Duration,
    pub bodies: Vec<SolveBodyInput>,
    pub local_drive: Option<LocalDriveControl>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpatialSolveBatch {
    pub solved: Vec<SolvedBodyKinematics>,
    pub events: Vec<SpatialBodyEvent>,
}
