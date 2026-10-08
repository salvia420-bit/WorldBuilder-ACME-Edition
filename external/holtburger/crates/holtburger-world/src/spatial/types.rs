use crate::entity::EntityMotionSnapshot;
use holtburger_protocol::messages::movement::InterpretedMotionCommand;
use crate::spatial::position_manager::PositionManager;
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
///
/// `portal_side` (PORTAL-FLAGS-DECODE, 2026-08-11) is retail's
/// `Sidedness` for this polygon's plane, decoded from the INVERTED
/// `CellPortal.flags` bit 1 (`holtburger_dat::file_type::env_cell::
/// CellPortal::portal_side`; retail `acclient.c:362389`). `true` = the
/// NEGATIVE halfspace.
///
/// Measured over the whole retail baseline (holtburger-dat
/// `tests/cell_portal_flags_parity.rs`): it names the OWNING CELL's
/// interior side, on 15,186/15,186 outdoor-facing and 1,840,177/
/// 1,840,177 cell→cell portals, none on-plane. So a consumer looking
/// INTO the room from outside — the `?portalPunch` aperture gate —
/// keeps the aperture exactly when the viewer does NOT match
/// `portal_side`: the negation of retail's own traversal rule
/// (`PView::InitCell`, `acclient.c:461691`), because retail's viewer
/// there is standing inside the room.
#[derive(Debug, Clone, PartialEq)]
pub struct CellPortalPolygon {
    pub other_cell_id: u32,
    pub vertices: Vec<Vector3>,
    pub portal_side: bool,
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
    /// FU4 (2026-07-03) — a FORCE-position reposition (retail
    /// `SmartBox::BlipPlayer` arm, acclient.c:145236-145243): a hard
    /// snap that KEEPS the player's own heading and installs NO
    /// constraint and NO velocity zeroing (unlike the teleport arm
    /// :145196-145207). With `?retailLeash` off this behaves exactly
    /// like [`Self::Reset`] — byte-identical shipped behavior.
    ForceBlip,
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
    /// Physics deep-dive 2026-06-01 (gap 4) → A2-P1 (2026-06-12): the
    /// retail per-body `PositionManager` (interpolation + constraint
    /// sub-managers). Only populated when the [`crate::spatial::scene`]
    /// `USE_RETAIL_INTERPOLATE` flag is on; the default single-step
    /// constraint-pull path never touches it. With
    /// `USE_POSITION_MANAGER_QUEUE` off (default) it delegates to the
    /// legacy single-node interpolator byte-identically. The per-frame
    /// integrator advances it via
    /// [`crate::spatial::SpatialScene::step_force_position_interpolation`].
    pub position_manager: PositionManager,
    /// A2-P2 (2026-06-12, W3+ S8): last wire-reported contact for a
    /// REMOTE body — retail gates `InterpolationManager::adjust_offset`
    /// on the object's `transient_state & 1` (acclient.c:389208), which
    /// retail derives by simulating the remote body. We hold the latest
    /// wire `IS_GROUNDED` (`pp.has_contact`, acclient.c:145287) here
    /// instead; `None` (no flag seen yet) is treated as on-contact so
    /// managers aren't permanently frozen (S8 OPEN Q6, documented
    /// deviation). Only written on the `?remoteInterp=on` ingest path.
    pub last_wire_contact: Option<bool>,
    /// Retail `CMotionInterp::my_run_rate` for a remote body: latched from
    /// every interpreted state whose forward command is RunForward
    /// (acclient.c:344163) and persisting across later non-running states.
    /// Default 1.0. Feeds [`SpatialBody::adjusted_max_speed`].
    pub my_run_rate: f32,
    /// OpenAC comparison 2026-10-04 (remote motion D7): retail
    /// `m_velocityVector` of a REMOTE object, written only by
    /// `SmartBox::DoVectorUpdate` → `set_velocity` (acclient.c:143459-143480)
    /// — NOT the wire UpdatePosition velocity, which retail never applies
    /// to a remote (`MoveOrTeleport` ignores it, :323451-323498). Kept apart
    /// from [`Self::velocity`], which the authoritative reconcile and the
    /// interp drain both overwrite.
    pub remote_velocity: Vector3,
    /// D7: `Some` while the remote body is out of contact and flying its
    /// own arc (retail transient CONTACT clear), `None` on the ground.
    pub remote_arc: Option<RemoteArc>,
    /// OpenAC comparison 2026-10-04 (remote motion D5): retail
    /// `CPhysicsObj::IsMovingTo` (acclient.c:315822 → :339312) for a REMOTE
    /// body — its MoveToManager has an active directive. Feeds
    /// `InterpolateTo(p, IsMovingTo())` (`MoveOrTeleport` :323492) as
    /// `keep_heading`, so wire headings do not fight the client steer.
    pub remote_moving_to: bool,
    /// D5: this slice's MoveTo steer for a remote body (the motions the
    /// remote MoveToManager would `_DoMotion`), set by the movement system's
    /// remote MoveTo pump. `None` = no steer (idle / arrived / turn done).
    pub remote_moveto: Option<RemoteMoveToDrive>,
    /// NETSYNC-3 (2026-10-07): the z omega (rad/s about +z) of this remote
    /// body's motion-table TurnRight cycle at its current stance —
    /// `MotionData.omega.z`, resolved by the world state from the entity's
    /// motion table (`WorldState::remote_turn_right_omega_z`). `None` =
    /// unresolved; [`SpatialBody::state_omega_z`] then uses the player-table
    /// value [`RETAIL_HUMAN_TURN_RIGHT_OMEGA_Z`].
    pub remote_turn_omega_z: Option<f32>,
}

/// NETSYNC-3 (2026-10-07): `MotionData.omega.z` of the TurnRight (0x6500000D)
/// cycle AND the style-0 / per-stance TurnRight modifiers of the player motion
/// tables (0x09000001, 0x0900020D/E, 0x09000207 — every stance), read from
/// client_portal.dat (holtburger-dat test
/// `netsync3_turn_right_omega_is_clockwise_in_retail_tables`). NEGATIVE =
/// clockwise seen from above (+z up, x east, y north): a right turn. Every
/// one of the 301 retail tables that authors a TurnRight omega has z < 0
/// (values -1.0 … -4.5; one -18).
pub const RETAIL_HUMAN_TURN_RIGHT_OMEGA_Z: f32 = -1.5;

/// OpenAC comparison 2026-10-04 (remote motion D5) — one remote MoveTo
/// steer: face `heading_rad` (AC heading, the `Quaternion::from_heading`
/// convention) and, for a walk/run node, advance forward. Ported in spirit
/// from OpenAC `RuntimeRemotePhysicsUpdater` (moveToArmed) — the steering
/// itself comes from holtburger-core's retail `MoveToManager` port.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteMoveToDrive {
    /// The node heading (turn node) or the direct bearing to the target
    /// (walk node). R3 moveto-3 (2026-10-08): a walk no longer steers by
    /// it — the body runs along its own facing and turns only by
    /// [`Self::turn`]; the bearing is kept for diagnostics and the legacy
    /// bearing steer (`SpatialScene::set_remote_moveto_facing_enabled`).
    pub heading_rad: f32,
    /// `Some(run)` while a walk/run node is active (`MoveToSteer::Walk`);
    /// `None` for a turn-in-place node.
    pub forward: Option<bool>,
    /// R3 moveto-3: the walk command is WalkBackwards — retail
    /// `adjust_motion` folds it into WalkForward × −0.65
    /// (acclient.c:343746), so the body backs away along its facing.
    pub backwards: bool,
    /// R3 moveto-2/3: the turn MOTION the MoveToManager holds, signed
    /// `+1.0` TurnRight (heading increasing) / `-1.0` TurnLeft. For a turn
    /// node it is the node's command (the scene turns past the node so the
    /// strict `heading_greater` completes it, acclient.c:345712); for a
    /// walk it is the aux turn (`None` inside the 20° deadband,
    /// acclient.c:345620-345651). `None` on a turn node = the legacy
    /// shortest-arc clamp toward `heading_rad`.
    pub turn: Option<f32>,
    /// R3 moveto-5: `MovementParameters.speed` (sanitized > 0; ACE charge
    /// 1.5) — scales the walk velocity and the turn rate the way
    /// `_DoMotion` → `adjust_motion` scales the motion (acclient.c:344753,
    /// :343439).
    pub speed: f32,
}

/// OpenAC comparison 2026-10-04 (remote motion D7) — the airborne state of
/// a REMOTE body (retail runs `UpdatePhysicsInternal` on every object,
/// acclient.c:311375 → :323081 → :317701). See
/// `SpatialScene::step_remote_position_managers`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteArc {
    /// Height the body left the ground at.
    pub takeoff_z: f32,
    /// Wave 4: `Some(takeoff_z)` when the take-off was more than
    /// `REMOTE_UNKNOWN_FLOOR_M` above every floor the scene can sample
    /// (geometry we do not hold); the arc then lands no lower than it.
    pub unsampled_floor: Option<f32>,
    /// Seconds spent airborne (safety cap).
    pub elapsed: f32,
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
            position_manager: PositionManager::default(),
            last_wire_contact: None,
            my_run_rate: 1.0,
            remote_velocity: Vector3::zero(),
            remote_arc: None,
            remote_moving_to: false,
            remote_moveto: None,
            remote_turn_omega_z: None,
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
            position_manager: PositionManager::default(),
            last_wire_contact: None,
            my_run_rate: 1.0,
            remote_velocity: Vector3::zero(),
            remote_arc: None,
            remote_moving_to: false,
            remote_moveto: None,
            remote_turn_omega_z: None,
        }
    }

    /// Install a new interpreted motion snapshot, latching `my_run_rate`
    /// the way retail does on a RunForward state (acclient.c:344163).
    pub fn set_motion_state(&mut self, motion_state: Option<EntityMotionSnapshot>) {
        if let Some(ms) = motion_state {
            if ms.forward_command == Some(InterpretedMotionCommand::RUN_FORWARD) {
                if let Some(speed) = ms.forward_speed.map(|s| s.to_f32()) {
                    if speed.is_finite() && speed > 0.0 {
                        self.my_run_rate = speed;
                    }
                }
            }
        }
        self.motion_state = motion_state;
    }

    /// Retail `CMotionInterp::get_state_velocity` (acclient.c:343440-ish,
    /// `CMotionInterp::get_state_velocity`) for a remote body, in the body's
    /// LOCAL frame (x = right, y = forward): SideStepRight × 1.25,
    /// WalkForward × 3.12, RunForward × 4.0 of the state speeds (walk-back
    /// and strafe-left arrive as the forward command with a negative speed),
    /// magnitude clamped to `my_run_rate × 4`.
    pub fn state_velocity_local(&self) -> Vector3 {
        let Some(ms) = self.motion_state else {
            return Vector3::zero();
        };
        let speed = |s: Option<crate::entity::OrderedMotionSpeed>| {
            s.map(|v| v.to_f32()).filter(|v| v.is_finite()).unwrap_or(1.0)
        };
        let x = if ms.sidestep_command == Some(InterpretedMotionCommand::SIDESTEP_RIGHT) {
            1.25 * speed(ms.sidestep_speed)
        } else {
            0.0
        };
        let y = match ms.forward_command {
            Some(c) if c == InterpretedMotionCommand::WALK_FORWARD => 3.12 * speed(ms.forward_speed),
            Some(c) if c == InterpretedMotionCommand::RUN_FORWARD => 4.0 * speed(ms.forward_speed),
            _ => 0.0,
        };
        let v = Vector3::new(x, y, 0.0);
        let max = self.my_run_rate * 4.0;
        let len = (x * x + y * y).sqrt();
        if len > max && len > 0.0 {
            v * (max / len)
        } else {
            v
        }
    }

    /// NETSYNC-3 (2026-10-07): the angular velocity (rad/s about +z) a
    /// REMOTE body's interpreted TURN axis applies, as retail moves every
    /// object by its sequence each frame: `add_motion` / `combine_motion`
    /// set `omega = speed_mod × MotionData.omega` (acclient.c:337431,
    /// :337477), `CSequence::apply_physics` rotates the offset frame by
    /// `omega × quantum` (:339860) and `UpdatePositionInternal` composes it
    /// onto the object (:319989). The wire turn is already interpreted
    /// (ACE `MovementData`: TurnRight with ±1.0 walk / ±1.5 run / mouselook
    /// speed, TurnLeft sent as TurnRight × -1); a raw TurnLeft is folded the
    /// retail `adjust_motion` way (TurnRight, speed × -1). 0 when no turn.
    pub fn state_omega_z(&self) -> f32 {
        let Some(ms) = self.motion_state else {
            return 0.0;
        };
        let speed = ms
            .turn_speed
            .map(|s| s.to_f32())
            .filter(|v| v.is_finite())
            .unwrap_or(1.0);
        let signed = match ms.turn_command {
            Some(c) if c == InterpretedMotionCommand::TURN_RIGHT => speed,
            Some(c) if c == InterpretedMotionCommand::TURN_LEFT => -speed,
            _ => return 0.0,
        };
        self.remote_turn_omega_z
            .unwrap_or(RETAIL_HUMAN_TURN_RIGHT_OMEGA_Z)
            * signed
    }

    /// Retail `CMotionInterp::get_adjusted_max_speed` (acclient.c:343512)
    /// for a remote: RunForward → `forward_speed / current_speed_factor`
    /// (the factor is 1.0 for a remote), else `my_run_rate` (a remote's
    /// weenie has no InqRunRate); both × 4.0.
    pub fn adjusted_max_speed(&self) -> f32 {
        let rate = self
            .motion_state
            .filter(|ms| ms.forward_command == Some(InterpretedMotionCommand::RUN_FORWARD))
            .and_then(|ms| ms.forward_speed)
            .map(|s| s.to_f32())
            .filter(|s| s.is_finite() && *s > 0.0)
            .unwrap_or(self.my_run_rate);
        rate * 4.0
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
    /// Kinematic turn realization rate toward `desired_heading`, rad/s
    /// (the authored MotionTable turn omega). `None` = apply the heading
    /// instantly (the server-projection reconcile arm keeps this shape).
    /// `Some` = the consumer rotates at this rate per slice; while the
    /// heading target is a MoveTo TurnToHeading node the step is NOT
    /// clamped at the target — retail's turn-arrival test is an
    /// overshoot test (`heading_greater`, acclient.c:344715/:345739) and
    /// the driver snaps to the node only after the body passes it
    /// (:345746), so an exact clamp would never arrive.
    pub turn_omega_rad_s: Option<f32>,
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
