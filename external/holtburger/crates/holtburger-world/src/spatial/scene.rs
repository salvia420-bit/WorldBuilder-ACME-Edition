use super::{
    AuthoritativeBodySync, BasicSpatialPhysics, BuildingAabbEntry, BuildingId, CellPortalPolygon,
    ContactState, InterpStep, RuntimeSpatialBodyView, SolvedBodyKinematics, SpatialBody,
    SpatialBodyId, SpatialPhysics, SpatialSampleMode, SpatialSamplingConfig, StaticAabbEntry,
    physics::sample_mode_for_projection_state,
};
use crate::entity::EntityMotionSnapshot;
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use holtburger_common::{Aabb, Frustum, Guid, Triangle, Vector3};
use holtburger_dat::file_type::SkyDesc;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use web_time::Instant;

/// Physics deep-dive 2026-06-01 (gap 4) — constrain the local player's
/// integrator working pose toward a sub-snap server force-position
/// instead of fully preserving it.
///
/// `true` (default): on an inbound LOCAL-player force-position in
/// Snapshot mode while mid-simulation, [`SpatialScene::reconcile_
/// authoritative_body`] pulls `body.pose` toward the forced pose by a
/// per-tick capped correction (a single-step constraint pull standing
/// in for retail's `PositionManager::InterpolateTo`/`ConstrainTo`).
/// The next AutonomousPosition heartbeat therefore reports a pose that
/// has converged toward the server, killing the small persistent
/// rubberband instead of re-asserting the drifted pose forever.
///
/// `false`: the pre-2026-06-01 behaviour — the working pose is fully
/// preserved on every Snapshot reconcile and only the JS dead-reckon
/// layer ever converges the avatar. Retained for A/B comparison.
const USE_LOCAL_FORCE_POSITION_CONSTRAINT: bool = true;

/// Physics deep-dive 2026-06-01 (gap 4, multi-pass) — opt-in faithful
/// retail `PositionManager::InterpolateTo` / `ConstrainTo` reconciliation
/// easing curve, DEFAULT-OFF.
///
/// `false` (default, **shipped behaviour unchanged**): on an inbound
/// LOCAL-player force-position the reconcile applies the single-step
/// linear constraint-pull [`constrain_local_pose_toward`] — one capped
/// correction per message. This is the validated, shipped solver path.
///
/// `true` (opt-in, for later validation): the reconcile instead
/// *installs* a stateful per-body interpolator
/// ([`super::RetailForcePositionInterpolator`]) — the 1:1 port of
/// retail's `ConstrainTo` + `InterpolateTo` pair
/// (acclient.c 145210-145218). The integrator then eases `body.pose`
/// toward the forced pose every physics frame via
/// [`SpatialScene::step_force_position_interpolation`], using the retail
/// velocity / duration model (`maxSpeed = get_adjusted_max_speed()*2`,
/// per-frame step capped at `maxSpeed * quantum`, 0.05 m deadband,
/// 5-frame progress window, constraint-leash down-scaling). The single
/// per-message pull is NOT applied in this mode — the per-frame stepper
/// owns convergence.
///
/// NOTE: when this flag is `true`, callers must drive
/// [`SpatialScene::step_force_position_interpolation`] each physics frame
/// for the LOCAL player. That per-frame wiring into the live local-drive
/// integrator (`MovementSystem::advance_local_pose_for_manual_drive`,
/// `crates/holtburger-core/.../movement/system.rs`) is the deferred
/// slice (see this file's header notes / the deep-dive handoff) and is
/// intentionally NOT enabled by default so the shipped solver behaviour
/// stays byte-for-byte identical. The easing curve, the install path and
/// the per-frame stepper are all implemented + unit-tested here so the
/// remaining work is purely the integrator call-site.
const USE_RETAIL_INTERPOLATE: bool = false;

/// Physics deep-dive 2026-06-01 (gap 4) — retail autonomy-blip /
/// constraint-leash distances for the local-player force-position
/// reconcile. Mirrors the decompiled client:
///
/// - **Blip (snap) distance** — `CPhysicsObj::GetAutonomyBlipDistance`
///   (`acclient.c:315...`, ACE `PhysicsObj.cs:545-550`): `100.0` outdoor
///   (cell `< 0x100`), `25.0` indoor for the player. Beyond this the
///   gap is too large to be a small rubberband — it's a routine
///   far-LB UpdatePosition broadcast or a teleport-class correction. We
///   leave the working pose untouched there (the academy-rubberband fix
///   invariant; teleport-class corrections come through the
///   `Reset`/`Suspended` path, not this Snapshot path).
/// - **Constraint-leash start distance** —
///   `CPhysicsObj::GetStartConstraintDistance` (`acclient.c:315885`):
///   `5.0` indoor / `10.0` outdoor for the player. A sub-leash gap is
///   pulled fully to the target this tick (`ConstrainTo` collapsing a
///   small offset); a gap between the leash and the blip is pulled in
///   by at most one leash per reconcile, so it converges over several
///   heartbeats instead of snapping.
/// - **Deadband** — `InterpolationManager` early-outs (and
///   `adjust_offset` calls `NodeCompleted`) once the object is within
///   `0.05 m` of the target (`InterpolationManager.cs:48,209,244`); we
///   leave the working pose untouched inside this band so heartbeats go
///   quiet instead of jittering around the target.
const BLIP_SNAP_DISTANCE_INDOOR_M: f32 = 25.0;
const BLIP_SNAP_DISTANCE_OUTDOOR_M: f32 = 100.0;
const CONSTRAINT_LEASH_INDOOR_M: f32 = 5.0;
const CONSTRAINT_LEASH_OUTDOOR_M: f32 = 10.0;
const RECONCILE_DEADBAND_M: f32 = 0.05;

/// Constraint-pull the integrator working pose `current` toward the
/// server-forced `target`, returning the corrected pose. Indoor/outdoor
/// awareness comes from `target` (the cell the server is forcing us
/// into):
/// - distance `<= deadband` → leave `current` untouched (already there).
/// - distance `> blip` → leave `current` untouched: too large to be a
///   small rubberband, so this is a routine far-LB broadcast (academy
///   fix) — teleport-class corrections take the `Reset`/`Suspended` hard
///   path, not this one.
/// - otherwise → move toward `target` by at most one constraint-leash;
///   a sub-leash gap collapses onto `target` this tick. Only the origin
///   is pulled — the integrator owns heading, and the forced rotation is
///   still recorded as the authoritative pose by the caller.
fn constrain_local_pose_toward(current: WorldPosition, target: WorldPosition) -> WorldPosition {
    let indoor = target.is_indoors();
    let blip = if indoor {
        BLIP_SNAP_DISTANCE_INDOOR_M
    } else {
        BLIP_SNAP_DISTANCE_OUTDOOR_M
    };
    let leash = if indoor {
        CONSTRAINT_LEASH_INDOOR_M
    } else {
        CONSTRAINT_LEASH_OUTDOOR_M
    };

    let distance = current.distance_to(&target);
    if distance <= RECONCILE_DEADBAND_M || distance > blip {
        // Within the InterpolationManager dead-band (no meaningful
        // drift) or beyond the autonomy-blip radius (not a small
        // rubberband — preserve the working pose): keep `current`.
        return current;
    }

    // Sub-blip, above the dead-band: pull toward the target along the
    // global-space offset, capped at one constraint-leash. When the gap
    // is already within the leash we land exactly on the target this
    // tick (matching ConstrainTo collapsing a small offset).
    let from = current.global_coords();
    let to = target.global_coords();
    let offset = to - from;
    let length = offset.length();
    if length <= leash || length <= EPSILON {
        // Adopt the target origin (+ rotation) wholesale — the leash
        // doesn't bind, so we converge this tick.
        return target;
    }

    let step = offset * (leash / length);
    let stepped_global = from + step;
    // Re-express the stepped global position in `target`'s landblock so
    // the pull doesn't change which landblock the working pose reports
    // mid-correction; the server already told us the destination block.
    let (target_lb_x, target_lb_y) = target.landblock_coords();
    let local = Vector3::new(
        stepped_global.x - (target_lb_x as f32 * METERS_PER_LANDBLOCK),
        stepped_global.y - (target_lb_y as f32 * METERS_PER_LANDBLOCK),
        stepped_global.z,
    );
    WorldPosition {
        landblock_id: target.landblock_id,
        coords: local,
        // Keep the integrator's working heading; the forced rotation is
        // captured in `authoritative_pose` by the caller. (Retail's
        // InterpolateTo keeps heading when the cmdinterp asks it to.)
        rotation: current.rotation,
    }
}

const EPSILON: f32 = 1e-4;

#[derive(Debug, Clone)]
pub(crate) struct BodySamplingStore {
    bodies: HashMap<SpatialBodyId, SpatialBody>,
    config: SpatialSamplingConfig,
    next_ephemeral_body_id: u64,
}

impl Default for BodySamplingStore {
    fn default() -> Self {
        Self {
            bodies: HashMap::new(),
            config: SpatialSamplingConfig::default(),
            next_ephemeral_body_id: 1,
        }
    }
}

impl BodySamplingStore {
    fn config(&self) -> SpatialSamplingConfig {
        self.config
    }

    fn set_config(&mut self, config: SpatialSamplingConfig) {
        self.config = config;
    }

    fn runtime_body_view(&self, body_id: SpatialBodyId) -> Option<RuntimeSpatialBodyView> {
        self.body(body_id).map(SpatialBody::runtime_view)
    }

    fn iter_runtime_body_views(&self) -> impl Iterator<Item = RuntimeSpatialBodyView> + '_ {
        self.bodies.values().map(SpatialBody::runtime_view)
    }

    fn body(&self, body_id: SpatialBodyId) -> Option<&SpatialBody> {
        self.bodies.get(&body_id)
    }

    fn body_for_guid(&self, guid: Guid) -> Option<&SpatialBody> {
        self.body(SpatialBodyId::LocalPlayer(guid))
            .or_else(|| self.body(SpatialBodyId::Entity(guid)))
    }

    fn body_mut(&mut self, body_id: SpatialBodyId) -> Option<&mut SpatialBody> {
        self.bodies.get_mut(&body_id)
    }

    fn register_body(&mut self, body: SpatialBody) -> Option<SpatialBody> {
        self.bodies.insert(body.id, body)
    }

    fn update_body(&mut self, body: SpatialBody) -> Option<SpatialBody> {
        let existing = self.bodies.get_mut(&body.id)?;
        Some(std::mem::replace(existing, body))
    }

    fn remove_body(&mut self, body_id: SpatialBodyId) -> Option<SpatialBody> {
        self.bodies.remove(&body_id)
    }

    fn allocate_ephemeral_body_id(&mut self) -> SpatialBodyId {
        let body_id = SpatialBodyId::Ephemeral(self.next_ephemeral_body_id);
        self.next_ephemeral_body_id += 1;
        body_id
    }

    fn register_ephemeral_body(&mut self, pose: WorldPosition, now: Instant) -> SpatialBodyId {
        let body_id = self.allocate_ephemeral_body_id();
        self.register_body(SpatialBody::new_ephemeral(body_id, pose, now));
        body_id
    }
}

/// BSP collision narrow-phase data (PASS 1, 2026-06-02) for one
/// EnvCell, kept in CELL-LOCAL space alongside the cell's `position`
/// frame. This is the parallel to [`SpatialScene::cell_physics_index`]'s
/// flat triangle bag — same source `CellStruct`, but it preserves the
/// ALREADY-PARSED physics BSP tree + the resolved physics polygons
/// instead of fan-triangulating and discarding the tree.
///
/// The query sphere is transformed INTO this cell-local frame at query
/// time (`world → orientation^-1 · (world − origin)`), matching ACE's
/// `SpherePath.LocalSpacePos` — we never transform the tree into world
/// space. Lifetime tracks `cell_physics_index` (cleared on landblock
/// unload).
#[derive(Clone)]
pub struct CellPhysicsBsp {
    /// The parsed physics BSP tree (cell-local planes + bounding
    /// spheres), straight from `CellStruct.physics_bsp`.
    pub tree: holtburger_dat::physics::BspNode,
    /// Physics polygons resolved to cell-local vertices + computed
    /// planes, keyed by the `u16` poly-id the BSP leaves reference.
    pub polys: HashMap<u16, holtburger_dat::physics::ResolvedPolygon>,
    /// Cell origin in WORLD space (landblock origin + EnvCell
    /// `position.origin`).
    pub origin: Vector3,
    /// Cell orientation (EnvCell `position.orientation`). Unit
    /// quaternion; its conjugate maps world→cell-local.
    pub orientation: holtburger_common::Quaternion,
}

impl CellPhysicsBsp {
    /// Transform a WORLD-space point into this cell's local frame:
    /// `local = orientation^-1 · (world − origin)`. The orientation is
    /// a unit quaternion so the inverse is its conjugate
    /// `(w, −x, −y, −z)`.
    pub fn world_to_local(&self, world: Vector3) -> Vector3 {
        let q = self.orientation;
        let inv = holtburger_common::Quaternion {
            w: q.w,
            x: -q.x,
            y: -q.y,
            z: -q.z,
        };
        inv.rotate_vector(world - self.origin)
    }
}

/// Cell MEMBERSHIP tree (`CellStruct.cell_bsp`) + cell frame. Answers
/// "is this world point / capsule inside this EnvCell?" purely from
/// geometry — the client-local analogue of ACE `check_building_transit`
/// / `point_in_cell`. Distinct from [`CellPhysicsBsp`] (collision): the
/// cell tree is plane-only (no polygons), so this carries just the tree
/// + the cell frame for the world→local query transform. Lifetime
/// tracks `cell_aabbs` (cleared on landblock unload).
#[derive(Clone)]
pub struct CellMembership {
    /// The parsed cell-membership BSP tree (cell-local splitting
    /// planes), straight from `CellStruct.cell_bsp`.
    pub tree: holtburger_dat::physics::BspNode,
    /// Cell origin in WORLD space (landblock origin + EnvCell
    /// `position.origin`).
    pub origin: Vector3,
    /// Cell orientation (EnvCell `position.orientation`); unit
    /// quaternion, conjugate maps world→cell-local.
    pub orientation: holtburger_common::Quaternion,
}

impl CellMembership {
    /// `local = orientation^-1 · (world − origin)` — identical to
    /// [`CellPhysicsBsp::world_to_local`].
    pub fn world_to_local(&self, world: Vector3) -> Vector3 {
        let q = self.orientation;
        let inv = holtburger_common::Quaternion {
            w: q.w,
            x: -q.x,
            y: -q.y,
            z: -q.z,
        };
        inv.rotate_vector(world - self.origin)
    }
}

#[derive(Clone)]
pub struct SpatialScene {
    landblock_map: HashMap<Guid, HashSet<Guid>>,
    entity_poses: HashMap<Guid, WorldPosition>,
    body_store: BodySamplingStore,
    physics: Arc<dyn SpatialPhysics>,
    /// Phase 6 step B: per-cell building AABB index. Keyed by full
    /// 32-bit cell id (`landblock_id | cell_low_word`). Populated
    /// from a landblock-load path which walks each `BuildInfo`
    /// placement's Setup, derives per-part AABBs from GfxObj
    /// vertex data, transforms them by the placement's frame, and
    /// buckets each AABB into the cell its centre falls into.
    /// The integrator's swept-sphere clamp queries this map by the
    /// player's current cell + the cells the swept volume crosses.
    building_aabb_index: HashMap<u32, Vec<BuildingAabbEntry>>,
    /// Phase 6 step D: portal-driven visibility graph. Keyed by full
    /// 32-bit cell id; each entry lists every cell reachable through
    /// a single CellPortal record on the source EnvCell. Populated by
    /// `fetchEnvCellsInLandblock` (see the wasm bundle's pending pile)
    /// and consulted per-frame to compute the active render set.
    /// Stairs are EnvCell-to-EnvCell portal connections — there is no
    /// special-cased stair logic; walking up shifts `current_cell`,
    /// which shifts the BFS frontier, which swaps the visible set.
    cell_portal_graph: HashMap<u32, Vec<u32>>,
    /// Phase 6 step D: world-space AABB for each cell, keyed by full
    /// 32-bit cell id. Used by `current_cell` to pick the indoor cell
    /// containing a position when several Z-stacked cells share the
    /// same XY footprint. Outdoor cells aren't stored here — their
    /// containment is computed from the 8x8 grid in O(1) by
    /// `WorldPosition::derived_outdoor_cell_id`.
    cell_aabbs: HashMap<u32, Aabb>,
    /// 2026-05-10 indoor collision (Phase 6 step G follow-on):
    /// world-space physics triangles per cell, populated by the
    /// wasm bundle's `populateCellPhysicsForLandblock` from
    /// `Environment.cell_structures[id].physics_polygons` (the parser
    /// preserves these but the renderer ignores them — they're
    /// collision-only). Triangles are pre-transformed through the
    /// EnvCell's `position` frame so the per-tick swept-capsule
    /// kernel doesn't have to redo the cell-frame rotation each
    /// frame. Cleared on landblock unload alongside `cell_aabbs`.
    cell_physics_index: HashMap<u32, Vec<Triangle>>,
    /// BSP collision (PASS 1, 2026-06-02): per-cell physics BSP tree +
    /// resolved physics polygons + cell frame, keyed by full 32-bit
    /// cell id (parallel to `cell_physics_index`). Populated by
    /// `fetchEnvCellsInLandblock`'s collision walk when the
    /// `USE_PHYSICS_BSP` path is built — the data is preserved
    /// regardless of the integrator flag so flipping the flag on is a
    /// pure runtime switch. Read by [`Self::cell_physics_bsp_solid`]
    /// (the low+high two-sphere query) when the flag is on. Cell-local
    /// geometry; the query sphere is transformed into the cell frame
    /// (see [`CellPhysicsBsp::world_to_local`]). Cleared on landblock
    /// unload alongside `cell_physics_index`.
    cell_physics_bsp: HashMap<u32, CellPhysicsBsp>,
    /// Terrain→EnvCell entry (2026-06-02): per-cell MEMBERSHIP bsp
    /// (`CellStruct.cell_bsp`) + cell frame, keyed by full 32-bit cell
    /// id (parallel to `cell_physics_bsp`). Populated by
    /// `fetchEnvCellsInLandblock`'s cell walk regardless of any flag.
    /// Read by [`Self::entered_envcell_for_outdoor_pose`] so the
    /// integrator can flip the player indoors locally the tick the
    /// capsule enters a cell — mirroring retail's client-local
    /// `check_building_transit` — instead of waiting for the server
    /// `UpdatePosition`. Cleared on landblock unload alongside
    /// `cell_aabbs` / `cell_physics_bsp`.
    cell_membership: HashMap<u32, CellMembership>,
    /// Phase 5 PView port (2026-05-25): per-cell portal polygons in
    /// world space, for screen-space portal-frustum clipping. Keyed by
    /// the EnvCell's full 32-bit cell id; each entry is a list of
    /// portals on that cell, each with the connected `other_cell_id`
    /// and the polygon vertices (already transformed through the
    /// EnvCell's `position` frame). Populated alongside
    /// `cell_physics_index` from the Environment record's
    /// `polygons` map (the same drawing polygons the renderer skips
    /// for portal openings — see env_cell.rs:65 `polygon_id`).
    /// Cleared on landblock unload alongside `cell_aabbs`.
    cell_portal_polygons: HashMap<u32, Vec<CellPortalPolygon>>,
    /// Phase 6 step E: door GUID → `(building_id, part_index)` lookup.
    /// JS-side door binding is by entity GUID (the ACE-broadcast `Door`
    /// weenie's full guid); the AABB index is keyed by per-part
    /// `(BuildingId, u8)` because the same door part may belong to a
    /// building shared by many cells. JS calls `register_door_part` once
    /// per spawned door (after matching the door's setup_id + part bbox
    /// against the building's AABB entries) so subsequent
    /// `set_door_aabb_active` calls only need the door GUID.
    door_part_index: HashMap<u64, (BuildingId, u8)>,
    /// PR-RR 2026-05-23 (interim): per-open-door world-space AABB.
    /// Populated by the recv loop on `WorldEvent::DoorStateChanged
    /// { state: Open }` from the door entity's pose + capsule extent,
    /// cleared on `state: Closed`. Consumed by
    /// `clamp_delta_against_cell_walls_with_exclusions` to skip cell-
    /// mesh triangles representing the (now-open) door panel —
    /// EnvCell BSP polys are baked once at landblock-load and don't
    /// support per-part toggle today (see docs/FOLLOW_ONS.md "Indoor
    /// door per-poly toggle" for the proper fix). Keyed by door GUID
    /// so the open→closed transition can remove the matching entry
    /// without rebuilding the set.
    open_door_exclusion_aabbs: HashMap<u32, Aabb>,
    /// Phase 6 step E follow-up (2026-05-09): per-placement world-space
    /// origin (xy only — Z varies along the landblock height field and
    /// isn't load-bearing for sprite lookup) keyed by `BuildingId`. The
    /// recv-loop's ObjectCreate door-registration arm uses this to
    /// project a `(BuildingId, part_index)` match back into the JS-side
    /// `buildingMap` keying scheme, which encodes
    /// `${landblockId}_${x.toFixed(2)}_${y.toFixed(2)}_${modelId}`.
    /// Populated alongside the AABB index by
    /// `populateBuildingAabbsForLandblock`; cleared per-landblock by
    /// `clear_building_aabbs_for_landblock`.
    building_origins: HashMap<BuildingId, (f32, f32)>,
    /// Workstream C (3D camera collision, 2026-05-11): per-landblock
    /// world-space AABB index for non-building outdoor static placements
    /// (signs, props, trees). Keyed by the landblock high word (the
    /// 0xXXYY0000 form of `BuildingId.landblock_id`) so the camera
    /// sweep can query just the entries near the player's current
    /// landblock without scanning every static loaded across all 9
    /// landblocks in the Holtburg 3x3 ring.
    ///
    /// Populated by the wasm bundle's `populateStaticsAabbsForLandblock`
    /// from `LandblockInfo.objects` (the `Stab` list); cleared per-
    /// landblock when the LB unloads. Indoor statics ride through the
    /// existing `EnvCellPlacement.static_objects` path and don't land
    /// here — they're picked up by the cell-mesh sweep.
    statics_aabb_index: HashMap<u32, Vec<StaticAabbEntry>>,
    /// Workstream C (3D camera collision, 2026-05-11): per-landblock
    /// world-space physics triangles for building interiors / basements.
    /// **This is the building-side parallel of `cell_physics_index`.**
    ///
    /// In Asheron's Call's data model:
    /// - **Regular building interiors (incl. basements)** live in the
    ///   building's `SetupModel` parts → each part's `GfxObj.physics_-
    ///   polygons` field. They are NOT EnvCells. This index covers them.
    /// - **EnvCells** (dungeons, apartments, instanced indoor spaces)
    ///   have their physics in `Environment.physics_polygons`. Those
    ///   live in `cell_physics_index` keyed by cell id.
    ///
    /// Both feed the same `sweep_sphere_against_triangles` primitive,
    /// but the population paths are distinct and the index keys differ
    /// (landblock_high here, full cell_id for the cell index).
    ///
    /// Populated by `populateBuildingAabbsForLandblock` (extended in
    /// Workstream C to walk each part's GfxObj.physics_polygons in the
    /// same per-part frame transform used for AABBs); cleared per-
    /// landblock alongside the AABB index when the LB unloads.
    building_physics_index: HashMap<u32, Vec<Triangle>>,
    /// Workstream Sky-B (parametric skybox, 2026-05-11): the parsed
    /// SkyDesc + GameTime for the active Region. `None` until the
    /// wasm bundle's `populateSkyDescFromRegion` lands; populated once
    /// per session on `kind=7 EnteredWorld` from Region `0x13000000`.
    ///
    /// The `(SkyDesc, GameTime)` pair is the *static* portion of the
    /// skybox — DayGroup keyframes, SkyObject DIDs, time anchors. The
    /// *dynamic* portion (current_time_of_day, day_group_index, lerped
    /// lighting) is computed per-frame by `crate::sky::SkyEvalState`
    /// against this data. Renderer reads via
    /// `SessionHandle::getSkyState()` / `getSkyObjectStates()` which
    /// internally call `SkyEvalState::evaluate(&self.sky_desc, ...)`.
    ///
    /// Boxed because the value is large (Dereth's SkyDesc ships 20
    /// DayGroups × {7 SkyObjects + 11 SkyTimeOfDay} ≈ 7-10 KB) and
    /// the rest of `SpatialScene` is per-frame hot — keeping the
    /// SkyDesc heap-side avoids paying the copy cost on every body
    /// snapshot clone in the integrator.
    sky_desc: Option<Box<(SkyDesc, holtburger_dat::file_type::GameTime)>>,
}

impl Default for SpatialScene {
    fn default() -> Self {
        Self::new()
    }
}

impl SpatialScene {
    pub fn new() -> Self {
        Self::new_with_physics(Arc::new(BasicSpatialPhysics))
    }

    pub fn new_with_physics(physics: Arc<dyn SpatialPhysics>) -> Self {
        Self {
            landblock_map: HashMap::new(),
            entity_poses: HashMap::new(),
            body_store: BodySamplingStore::default(),
            physics,
            building_aabb_index: HashMap::new(),
            cell_portal_graph: HashMap::new(),
            cell_aabbs: HashMap::new(),
            cell_physics_index: HashMap::new(),
            cell_physics_bsp: HashMap::new(),
            cell_membership: HashMap::new(),
            cell_portal_polygons: HashMap::new(),
            door_part_index: HashMap::new(),
            open_door_exclusion_aabbs: HashMap::new(),
            building_origins: HashMap::new(),
            statics_aabb_index: HashMap::new(),
            building_physics_index: HashMap::new(),
            sky_desc: None,
        }
    }

    /// Workstream Sky-B: install a parsed SkyDesc + GameTime onto the
    /// scene. Called once per session by the wasm bundle's
    /// `populateSkyDescFromRegion` after fetching Region `0x13000000`
    /// from the dat catalog. Idempotent — subsequent calls overwrite
    /// (Region descriptors don't change mid-session, but the API
    /// doesn't enforce this; out-of-order populates land cleanly).
    pub fn set_sky_desc(
        &mut self,
        sky_desc: SkyDesc,
        game_time: holtburger_dat::file_type::GameTime,
    ) {
        self.sky_desc = Some(Box::new((sky_desc, game_time)));
    }

    /// Workstream Sky-B: read access to the parsed SkyDesc + GameTime.
    /// `None` until `set_sky_desc` lands.
    pub fn sky_desc(&self) -> Option<&(SkyDesc, holtburger_dat::file_type::GameTime)> {
        self.sky_desc.as_deref()
    }

    /// Workstream Sky-B: predicate for the populator's idempotency
    /// gate — `true` once the SkyDesc has landed at least once.
    pub fn has_sky_desc(&self) -> bool {
        self.sky_desc.is_some()
    }

    /// Phase 6 step B: register one per-part building AABB into the
    /// cell that contains the AABB's centre. JS calls this once per
    /// `(building, part)` after `fetchBuildingPlacement` resolves the
    /// per-part bake; the wasm bundle wraps it through
    /// `SessionHandle::populate_building_aabb`.
    pub fn insert_building_aabb(&mut self, cell_id: u32, entry: BuildingAabbEntry) {
        self.building_aabb_index
            .entry(cell_id)
            .or_default()
            .push(entry);
    }

    /// Phase 6 step B: drop every AABB whose `building_id.landblock_id`
    /// matches the argument. Used when a landblock unloads — the next
    /// load will repopulate. Returns the number of removed entries
    /// for diagnostic logging.
    pub fn clear_building_aabbs_for_landblock(&mut self, landblock_id: u32) -> usize {
        let mut removed = 0usize;
        self.building_aabb_index.retain(|_cell, entries| {
            let before = entries.len();
            entries.retain(|e| e.building_id.landblock_id != landblock_id);
            removed += before - entries.len();
            !entries.is_empty()
        });
        // Phase 6 step E follow-up: drop the matching origin entries so
        // a subsequent re-bake of the same landblock starts from a clean
        // map. Doors registered from the prior load become orphans (no
        // origin lookup), which is the right semantics — they would
        // re-register on the next ObjectCreate.
        self.building_origins
            .retain(|building_id, _| building_id.landblock_id != landblock_id);
        // Workstream C (3D camera collision, 2026-05-11): drop matching
        // per-building-interior triangles so the next load starts from
        // a clean index. Building physics share the AABB lifetime
        // (both are populated by the same `populateBuildingAabbsFor-
        // Landblock` pass), so they get torn down together.
        self.building_physics_index
            .remove(&(landblock_id & 0xFFFF_0000));
        removed
    }

    pub fn building_aabb_count(&self) -> usize {
        self.building_aabb_index
            .values()
            .map(|v| v.len())
            .sum()
    }

    pub fn building_aabbs_for_cell(&self, cell_id: u32) -> &[BuildingAabbEntry] {
        self.building_aabb_index
            .get(&cell_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Phase 6 step B: collect the AABBs candidate for a swept-sphere
    /// query starting at `pose`. Includes the pose's containing cell
    /// plus the eight adjacent outdoor cells (so a delta crossing a
    /// 24 m cell boundary still sees walls in the next cell over).
    /// Indoor poses currently only check the containing cell — the
    /// per-cell EnvCell graph in Phase D will widen this to portal
    /// neighbours. Returns AABBs by value to dodge the per-cell
    /// borrow.
    pub fn building_aabbs_near_pose(&self, pose: &WorldPosition) -> Vec<BuildingAabbEntry> {
        let mut out: Vec<BuildingAabbEntry> = Vec::new();
        let lb_high = pose.landblock_id.0 & 0xFFFF_0000;
        let low = pose.landblock_id.0 & 0xFFFF;
        // Phase 6 step E: filter inactive entries (open doors) so they
        // drop out of the swept-sphere clamp without rebuilding the
        // index. Closed-door re-activation flips the flag back and the
        // entry returns to the candidate set.
        let push_active = |out: &mut Vec<BuildingAabbEntry>, entries: &[BuildingAabbEntry]| {
            out.extend(entries.iter().copied().filter(|e| e.active));
        };
        if low >= 0x0100 {
            if let Some(entries) = self.building_aabb_index.get(&pose.landblock_id.0) {
                push_active(&mut out, entries);
            }
            return out;
        }
        let cell_idx = (low as i32) - 1;
        if !(0..64).contains(&cell_idx) {
            if let Some(entries) = self.building_aabb_index.get(&pose.landblock_id.0) {
                push_active(&mut out, entries);
            }
            return out;
        }
        let cx = cell_idx >> 3;
        let cy = cell_idx & 0x7;
        for dx in -1i32..=1 {
            for dy in -1i32..=1 {
                let nx = cx + dx;
                let ny = cy + dy;
                if !(0..8).contains(&nx) || !(0..8).contains(&ny) {
                    continue;
                }
                let neighbour_cell = ((nx << 3) | ny) as u32 + 1;
                let key = lb_high | neighbour_cell;
                if let Some(entries) = self.building_aabb_index.get(&key) {
                    push_active(&mut out, entries);
                }
            }
        }
        out
    }

    /// Phase 6 step E: bind a door's full GUID to the building part it
    /// occupies, so a future `WorldEvent::DoorStateChanged` can flip
    /// the matching AABB entry's `active` flag without re-scanning the
    /// whole index. The wasm bundle calls this once per door
    /// `ObjectCreate` after matching the door's setup_id against the
    /// containing building's part list.
    pub fn register_door_part(&mut self, door_guid: u64, building_id: BuildingId, part_index: u8) {
        self.door_part_index
            .insert(door_guid, (building_id, part_index));
    }

    /// Phase 6 step E: lookup the `(BuildingId, part_index)` registered
    /// for a door GUID. Returns `None` if the door wasn't seen during
    /// the building-AABB load or if the GUID isn't a door at all.
    pub fn door_part_for_guid(&self, door_guid: u64) -> Option<(BuildingId, u8)> {
        self.door_part_index.get(&door_guid).copied()
    }

    /// Phase 6 step E: count of registered door GUIDs. Diagnostic only.
    pub fn door_part_index_len(&self) -> usize {
        self.door_part_index.len()
    }

    /// PR-RR 2026-05-23: register an open door's world-space exclusion
    /// AABB. Cell-mesh sweeps skip triangles whose centroid sits
    /// inside any registered exclusion AABB, so open doors become
    /// physically walkable without per-poly bake-time tagging. Keyed
    /// by door GUID so the open→closed transition removes the matching
    /// entry. See module doc on
    /// `clamp_delta_against_cell_walls_with_exclusions` for the
    /// follow-on proper-fix scope.
    pub fn add_open_door_exclusion(&mut self, door_guid: u32, aabb: Aabb) {
        self.open_door_exclusion_aabbs.insert(door_guid, aabb);
    }

    /// PR-RR 2026-05-23: clear an open door's exclusion entry (called
    /// on close). Returns `true` if an entry was actually removed.
    pub fn remove_open_door_exclusion(&mut self, door_guid: u32) -> bool {
        self.open_door_exclusion_aabbs.remove(&door_guid).is_some()
    }

    /// PR-RR 2026-05-23: open-door exclusion AABBs that overlap the
    /// pose's landblock (broad pre-filter — the centroid-in-AABB
    /// check in the sweep is the narrow phase). Returns owned `Vec`
    /// to dodge the borrow on `self.scene`.
    pub fn open_door_exclusion_aabbs_near(&self, pose: &WorldPosition) -> Vec<Aabb> {
        if self.open_door_exclusion_aabbs.is_empty() {
            return Vec::new();
        }
        let global = pose.global_coords();
        // Broad-phase: any AABB whose XY range is within ~10 m of the
        // pose. Player capsule + max door extent fits comfortably.
        const PREFILTER_M: f32 = 10.0;
        self.open_door_exclusion_aabbs
            .values()
            .filter(|aabb| {
                global.x >= aabb.min.x - PREFILTER_M
                    && global.x <= aabb.max.x + PREFILTER_M
                    && global.y >= aabb.min.y - PREFILTER_M
                    && global.y <= aabb.max.y + PREFILTER_M
            })
            .copied()
            .collect()
    }

    /// PR-RR 2026-05-23: count of registered open-door exclusions.
    /// Diagnostic only.
    pub fn open_door_exclusion_len(&self) -> usize {
        self.open_door_exclusion_aabbs.len()
    }

    /// Phase 6 step E follow-up (2026-05-09): record a building's
    /// world-space xy origin under its `BuildingId`, so a later
    /// `(BuildingId, part_index)` match can be projected back into the
    /// JS-side `buildingMap` keying scheme without a parallel scan. The
    /// value is the placement frame's origin in *global* world coords
    /// (already shifted by the landblock origin), not the part's AABB
    /// centre — that distinction matters because the JS-side
    /// `buildingKey` encodes the placement origin verbatim from
    /// `LandblockInfo.buildings[i].frame.origin`. Idempotent: repeated
    /// calls with the same `BuildingId` overwrite (the underlying
    /// `BuildInfo` is immutable per landblock load, so the value is
    /// stable across calls).
    pub fn register_building_origin(
        &mut self,
        building_id: BuildingId,
        world_x: f32,
        world_y: f32,
    ) {
        self.building_origins
            .insert(building_id, (world_x, world_y));
    }

    /// Phase 6 step E follow-up: lookup a building placement's
    /// world-space xy origin by `BuildingId`. Returns `None` for
    /// unregistered placements (a door whose ObjectCreate raced
    /// `populateBuildingAabbsForLandblock`, an admin-spawned dynamic
    /// dungeon, etc.).
    pub fn building_origin(&self, building_id: BuildingId) -> Option<(f32, f32)> {
        self.building_origins.get(&building_id).copied()
    }

    /// Phase 6 step E: toggle the `active` flag on every AABB entry
    /// matching `(building_id, part_index)`. Open doors set
    /// `active = false`; closed doors set `active = true`. Returns the
    /// number of entries flipped (typically 1 for a door part, but
    /// >1 if the part straddles multiple cells and was bucketed into
    /// each cell during load — all of those toggle in lockstep).
    pub fn set_door_aabb_active(
        &mut self,
        building_id: BuildingId,
        part_index: u8,
        active: bool,
    ) -> usize {
        let mut flipped = 0usize;
        for entries in self.building_aabb_index.values_mut() {
            for entry in entries.iter_mut() {
                if entry.building_id == building_id && entry.part_index == part_index {
                    entry.active = active;
                    flipped += 1;
                }
            }
        }
        flipped
    }

    /// Phase 6 step D: register a directed portal edge `from → to` in
    /// the cell graph. EnvCell `CellPortal` records are bidirectional
    /// in retail (a portal between cell A and cell B has matching
    /// records on both sides), so the JS-side population path queues
    /// both directions. The graph itself is directed so test fixtures
    /// can synthesize asymmetric topologies if needed.
    pub fn insert_cell_portal(&mut self, from: u32, to: u32) {
        let entry = self.cell_portal_graph.entry(from).or_default();
        if !entry.contains(&to) {
            entry.push(to);
        }
    }

    /// Phase 6 step D: register a world-space AABB for an indoor cell.
    /// JS computes the AABB from the cell's environment-mesh bounding
    /// box translated by the cell origin (and rotated by the cell
    /// orientation, then 8-corner-bounded — same `Aabb::transform_by`
    /// trick Phase B uses for buildings). Outdoor cells are not
    /// stored here — `current_cell` derives them from the 8x8 grid.
    pub fn insert_cell_aabb(&mut self, cell_id: u32, aabb: Aabb) {
        self.cell_aabbs.insert(cell_id, aabb);
    }

    /// Phase 6 step D: drop every portal edge and AABB whose endpoint
    /// shares the given landblock high word. Used when a landblock
    /// unloads — the next entry will repopulate via the lazy
    /// fetchEnvCellsInLandblock path. Returns `(edges_removed,
    /// aabbs_removed)` for diagnostic logging. `landblock_id` is
    /// expected to be the full landblock high word
    /// (e.g. `0xA9B40000`) — the comparison masks the low 16 bits.
    pub fn clear_cells_for_landblock(&mut self, landblock_id: u32) -> (usize, usize) {
        let lb_high = landblock_id & 0xFFFF_0000;
        let mut edges_removed = 0usize;
        self.cell_portal_graph.retain(|from, edges| {
            if (*from & 0xFFFF_0000) == lb_high {
                edges_removed += edges.len();
                return false;
            }
            let before = edges.len();
            edges.retain(|to| (*to & 0xFFFF_0000) != lb_high);
            edges_removed += before - edges.len();
            !edges.is_empty()
        });
        let aabbs_before = self.cell_aabbs.len();
        self.cell_aabbs
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        let aabbs_removed = aabbs_before - self.cell_aabbs.len();
        // 2026-05-10 indoor collision: keep `cell_physics_index`
        // sympathetic with `cell_aabbs` — when a landblock unloads,
        // its triangles go too. Counts roll into `aabbs_removed` so
        // the diagnostic log doesn't drift; per-cell triangle counts
        // aren't load-bearing and a future commit can split them
        // out if a gauge is needed.
        self.cell_physics_index
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // BSP collision (PASS 1): same lifetime as cell_physics_index.
        self.cell_physics_bsp
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // Terrain→EnvCell entry: cell-membership trees share the
        // EnvCell lifetime like the physics BSP.
        self.cell_membership
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // Phase 5 PView port: same lifetime as cell_aabbs.
        self.cell_portal_polygons
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        (edges_removed, aabbs_removed)
    }

    /// Phase 5 PView port (2026-05-25): register a portal polygon for an
    /// EnvCell. Called by the wasm bundle's `fetchEnvCellsInLandblock`
    /// alongside `insert_cell_portal`. Vertices are world-space (already
    /// transformed through the EnvCell's `position` frame). Multiple
    /// portals per cell accumulate as separate entries.
    pub fn insert_cell_portal_polygon(
        &mut self,
        cell_id: u32,
        polygon: CellPortalPolygon,
    ) {
        self.cell_portal_polygons
            .entry(cell_id)
            .or_default()
            .push(polygon);
    }

    /// Phase 5 PView port: portals registered for a cell (or `&[]` if
    /// the cell isn't loaded or has no portals).
    pub fn cell_portal_polygons_for(&self, cell_id: u32) -> &[CellPortalPolygon] {
        self.cell_portal_polygons
            .get(&cell_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Phase 5 PView port: total registered portal-polygon count
    /// across all loaded EnvCells. Diagnostic only.
    pub fn cell_portal_polygon_count(&self) -> usize {
        self.cell_portal_polygons.values().map(|v| v.len()).sum()
    }

    /// Iterate (cell_id, &portals) pairs. Used by
    /// `publish_cell_scene_snapshot` to flat-encode portal polygons
    /// into the SessionHandle's snapshot for `getRenderSetWithPView`.
    pub fn cell_portal_polygons_iter(
        &self,
    ) -> impl Iterator<Item = (u32, &[CellPortalPolygon])> + '_ {
        self.cell_portal_polygons
            .iter()
            .map(|(&id, polys)| (id, polys.as_slice()))
    }

    /// Phase 6 step D: count cells in the portal graph (any cell with
    /// at least one outbound edge). Diagnostic only — used by the
    /// recv-loop drain to log progress.
    pub fn cell_portal_graph_len(&self) -> usize {
        self.cell_portal_graph.len()
    }

    /// Phase 6 step D: count cells with cached world AABBs.
    /// Diagnostic only.
    pub fn cell_aabb_count(&self) -> usize {
        self.cell_aabbs.len()
    }

    /// Phase 6 follow-on (academy rubberband, 2026-05-10): read access
    /// to the world-space AABB cached for `cell_id`. Returned `None`
    /// when the cell hasn't been baked yet (lazy `fetchEnvCellsInLand-
    /// block` path) or `cell_id` is outdoor (outdoor containment is
    /// derived from the 8x8 grid in `current_cell`, not from this map).
    /// The integrator's indoor branch uses this to clamp the player's
    /// lateral motion to the cell interior + floor-snap Z to the
    /// cell's bottom — same data Phase 6D's `current_cell` already
    /// reads to disambiguate Z-stacked floors.
    pub fn cell_aabb(&self, cell_id: u32) -> Option<Aabb> {
        self.cell_aabbs.get(&cell_id).copied()
    }

    /// Iterate every (cell_id, world-space AABB) pair currently loaded.
    /// Phase 4 PView port (2026-05-25): used to snapshot the
    /// frustum-cullable set into `CellSceneSnapshot.cell_aabbs` per
    /// TickMovement.
    pub fn cell_aabbs_iter(&self) -> impl Iterator<Item = (u32, Aabb)> + '_ {
        self.cell_aabbs.iter().map(|(&id, &aabb)| (id, aabb))
    }

    /// 2026-05-10 indoor collision: insert a world-space triangle
    /// into the per-cell physics index. Called by the wasm bundle's
    /// `populateCellPhysicsForLandblock` populator after transforming
    /// each `physics_polygon` from cell-local coords through the
    /// EnvCell `position` frame to world coords + triangulating
    /// fan-style for `num_pts > 3`. Stored by full 32-bit cell id
    /// to mirror `cell_aabbs`.
    pub fn insert_cell_triangle(&mut self, cell_id: u32, tri: Triangle) {
        self.cell_physics_index.entry(cell_id).or_default().push(tri);
    }

    /// 2026-05-10 indoor collision: read access to the world-space
    /// physics triangles for `cell_id`. Returned slice may be empty
    /// when the cell hasn't been baked yet, or when the cell exists
    /// in the scene but its EnvCell carried no `physics_polygons`
    /// (rare — usually the EnvCell parser drops a few cells where
    /// the BSP is unparseable, and the integrator falls back to the
    /// cell-AABB clamp).
    pub fn cell_triangles(&self, cell_id: u32) -> &[Triangle] {
        self.cell_physics_index
            .get(&cell_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// 2026-05-10 indoor collision: count of cells with at least one
    /// indexed triangle. Diagnostic only — the wasm bundle's drain
    /// log uses this to confirm the populator wired up.
    pub fn cell_physics_count(&self) -> usize {
        self.cell_physics_index.len()
    }

    /// BSP collision (PASS 1, 2026-06-02): register the physics BSP
    /// tree + resolved polygons + cell frame for `cell_id`. Called by
    /// the wasm bundle's `fetchEnvCellsInLandblock` collision walk
    /// alongside `insert_cell_triangle` — the BSP path REUSES the
    /// already-parsed tree (it does not re-parse) and keeps it
    /// cell-local. Idempotent overwrite per cell (a re-bake after LRU
    /// eviction replaces).
    pub fn insert_cell_physics_bsp(&mut self, cell_id: u32, bsp: CellPhysicsBsp) {
        self.cell_physics_bsp.insert(cell_id, bsp);
    }

    /// BSP collision (PASS 1): read access to the physics BSP for
    /// `cell_id` (or `None` if not registered / not yet baked).
    pub fn cell_physics_bsp(&self, cell_id: u32) -> Option<&CellPhysicsBsp> {
        self.cell_physics_bsp.get(&cell_id)
    }

    /// BSP collision (PASS 1): count of cells with a registered physics
    /// BSP. Diagnostic only.
    pub fn cell_physics_bsp_count(&self) -> usize {
        self.cell_physics_bsp.len()
    }

    /// Terrain→EnvCell entry (2026-06-02): register a cell-membership
    /// tree (`CellStruct.cell_bsp` + frame) for `cell_id`. Drained from
    /// the wasm bundle's `CELL_MEMBERSHIP_PENDING` pile each TickMovement,
    /// the same cadence as the physics-BSP drain.
    pub fn insert_cell_membership(&mut self, cell_id: u32, membership: CellMembership) {
        self.cell_membership.insert(cell_id, membership);
    }

    /// Count of cells with a registered membership tree. Diagnostic only.
    pub fn cell_membership_count(&self) -> usize {
        self.cell_membership.len()
    }

    /// BSP collision (PASS 1, 2026-06-02): the authoritative "is the
    /// player capsule solid at this world pose" test, using the
    /// faithful ACE `BSPNode.sphere_intersects_solid` walk.
    ///
    /// Lowers the player capsule to ACE's two collision spheres
    /// (`NumSphere == 2`, `PartArray.cs`): a LOW sphere at
    /// `feet + radius` and a HIGH sphere at `head − radius`, both of
    /// `radius`. (`feet_world_z` is the bottom of the capsule;
    /// `height` its full extent.) Each sphere center is transformed
    /// into the cell-local frame and tested against the BSP. Returns
    /// `true` if EITHER sphere is solid.
    ///
    /// Returns `false` when the cell has no registered physics BSP —
    /// the integrator falls back to the flat-triangle solver in that
    /// case, so an unbaked / BSP-less cell never blocks spuriously.
    pub fn cell_physics_bsp_solid(
        &self,
        cell_id: u32,
        center_world_xy: (f32, f32),
        feet_world_z: f32,
        radius: f32,
        height: f32,
    ) -> bool {
        let Some(bsp) = self.cell_physics_bsp.get(&cell_id) else {
            return false;
        };
        // ACE two-sphere cylinder (low + high). The low sphere sits one
        // radius above the feet; the high sphere one radius below the
        // head. For a capsule shorter than 2·radius these collapse
        // toward the middle — still a valid (degenerate) two-sphere
        // probe.
        let low_z = feet_world_z + radius;
        let high_z = feet_world_z + (height - radius).max(radius);
        for cz in [low_z, high_z] {
            let world_center = Vector3::new(center_world_xy.0, center_world_xy.1, cz);
            let local_center = bsp.world_to_local(world_center);
            let sphere = holtburger_common::Sphere {
                center: local_center,
                radius,
            };
            if bsp.tree.sphere_intersects_solid(&sphere, true, &bsp.polys) {
                return true;
            }
        }
        false
    }

    /// BSP collision (M5, 2026-06-02): the PLACEMENT query against a cell's
    /// physics BSP — the adjust/widen variant of [`Self::cell_physics_bsp_solid`].
    /// Runs ACE `BSPTree.placement_insert` (holtburger-dat `placement_insert_bsp`)
    /// for the body's two-sphere cylinder, transformed into the cell-local frame.
    ///
    /// `world_sphere_centers[0..num_sphere]` are GLOBAL-meter sphere centers
    /// (same frame `cell_physics_bsp_solid` takes); `radius` the shared cylinder
    /// radius; `clear_cell` ACE's `centerCheck` (`true` for an ordinary
    /// solid-side query). Returns the placement state plus, on `Adjusted`, the
    /// net WORLD-space displacement to apply to the body (the cell-local result
    /// rotated back out by the cell orientation; `zero` otherwise). `None` when
    /// the cell has no registered physics BSP (mirrors `cell_physics_bsp_solid`
    /// returning `false` — an unbaked / BSP-less cell never blocks).
    ///
    /// INERT — not invoked by the live integrator; exercised by M5 unit tests
    /// and the M4 `placement_insert` bridge (`collision::bsp_cell_collision_fn`).
    pub fn cell_physics_bsp_placement(
        &self,
        cell_id: u32,
        world_sphere_centers: &[Vector3],
        radius: f32,
        num_sphere: u8,
        clear_cell: bool,
    ) -> Option<(holtburger_dat::physics::PlacementState, Vector3)> {
        let bsp = self.cell_physics_bsp.get(&cell_id)?;
        let n = (num_sphere as usize).min(2).min(world_sphere_centers.len());
        let mut local = [holtburger_common::Sphere {
            center: Vector3::zero(),
            radius: 0.0,
        }; 2];
        for i in 0..n {
            local[i] = holtburger_common::Sphere {
                center: bsp.world_to_local(world_sphere_centers[i]),
                radius,
            };
        }
        let probe = bsp
            .tree
            .placement_insert_bsp(&local, num_sphere, clear_cell, &bsp.polys);
        let world_disp = match probe.state {
            holtburger_dat::physics::PlacementState::Adjusted => {
                bsp.orientation.rotate_vector(probe.local_displacement)
            }
            _ => Vector3::zero(),
        };
        Some((probe.state, world_disp))
    }

    /// Phase 6 step D: portal neighbours of `cell_id`. Empty slice if
    /// the cell isn't in the graph (no EnvCell loaded yet, or an
    /// outdoor cell). Phase E may want an iterator; today the slice
    /// is plenty.
    pub fn cell_portal_neighbours(&self, cell_id: u32) -> &[u32] {
        self.cell_portal_graph
            .get(&cell_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Phase 6 step D: derive the cell id containing `pos`. Outdoor
    /// poses re-use `WorldPosition::derived_outdoor_cell_id` (which
    /// already implements the 8x8 grid lookup). Indoor poses scan the
    /// `cell_aabbs` cache for the first AABB in this landblock that
    /// contains the global `(x, y, z)` — multiple Z-stacked cells
    /// share an XY footprint, so the Z component is what discriminates
    /// floors. Returns `pos.landblock_id` unchanged if no match — the
    /// per-frame culling layer treats that as "stay on whatever cell
    /// we last saw" rather than blanking the world.
    pub fn current_cell(&self, pos: &WorldPosition) -> u32 {
        if pos.landblock_id == Guid::NULL {
            return 0;
        }
        if !pos.is_indoors() {
            // Outdoor: derive from the 8x8 grid. `derived_outdoor_cell_id`
            // returns the low-word index; OR with the landblock high
            // word to get the full cell id.
            let lb_high = pos.landblock_id.0 & 0xFFFF_0000;
            return match pos.derived_outdoor_cell_id() {
                Some(low) => lb_high | low,
                None => pos.landblock_id.0,
            };
        }
        // Indoor: scan cached AABBs in this landblock for containment.
        // EnvCells stack vertically so this is a 3D point-in-AABB test,
        // not an XY one — the Z component is what disambiguates floors.
        let global = pos.global_coords();
        let lb_high = pos.landblock_id.0 & 0xFFFF_0000;
        for (&cell_id, aabb) in &self.cell_aabbs {
            if (cell_id & 0xFFFF_0000) != lb_high {
                continue;
            }
            if aabb.is_empty() {
                continue;
            }
            if global.x >= aabb.min.x
                && global.x <= aabb.max.x
                && global.y >= aabb.min.y
                && global.y <= aabb.max.y
                && global.z >= aabb.min.z
                && global.z <= aabb.max.z
            {
                return cell_id;
            }
        }
        pos.landblock_id.0
    }

    /// Terrain→EnvCell entry (2026-06-02): when the player's predicted
    /// pose is still flagged OUTDOOR but the capsule has reached a
    /// loaded EnvCell's hull, return that cell's full 32-bit id so the
    /// caller can flip `landblock_id` locally and engage indoor
    /// collision THIS tick — the client-local analogue of ACE
    /// `check_building_transit` (which sets `HitsInteriorCell` the moment
    /// a sphere intersects the cell, acclient.c:348139). Mirrors retail:
    /// the client decides cell membership from geometry every tick, not
    /// from a server packet.
    ///
    /// Broad-phase: the radius-padded `cell_aabbs` of the player's
    /// landblock (same scan + landblock-high filter as `current_cell`).
    /// Narrow-phase: the cell's `cell_bsp` membership tree (plane-only
    /// [`BspNode::sphere_intersects_cell`]). Cells with no parsed
    /// `cell_bsp` fall back to plain (unpadded) AABB containment. First
    /// match wins, matching `current_cell`'s ordering once indoors.
    /// Returns `None` when the pose is indoors/null or no cell is
    /// entered. `radius` MUST be the same capsule radius the indoor
    /// wall-clamp uses, so the flip distance matches where collision
    /// engages.
    pub fn entered_envcell_for_outdoor_pose(
        &self,
        pos: &WorldPosition,
        radius: f32,
    ) -> Option<u32> {
        if pos.landblock_id == Guid::NULL || pos.is_indoors() {
            return None;
        }
        let global = pos.global_coords();
        let lb_high = pos.landblock_id.0 & 0xFFFF_0000;
        for (&cell_id, aabb) in &self.cell_aabbs {
            if (cell_id & 0xFFFF_0000) != lb_high || aabb.is_empty() {
                continue;
            }
            // Broad-phase: capsule centre within the AABB padded by the
            // capsule radius (so we test cells the swept sphere reaches).
            if global.x < aabb.min.x - radius
                || global.x > aabb.max.x + radius
                || global.y < aabb.min.y - radius
                || global.y > aabb.max.y + radius
                || global.z < aabb.min.z - radius
                || global.z > aabb.max.z + radius
            {
                continue;
            }
            match self.cell_membership.get(&cell_id) {
                Some(m) => {
                    let local = m.world_to_local(global);
                    if m.tree.sphere_intersects_cell(&local, radius)
                        != holtburger_dat::physics::CellBound::Outside
                    {
                        return Some(cell_id);
                    }
                }
                None => {
                    // Fallback (no parsed cell_bsp): unpadded AABB
                    // containment is the membership verdict.
                    if global.x >= aabb.min.x
                        && global.x <= aabb.max.x
                        && global.y >= aabb.min.y
                        && global.y <= aabb.max.y
                        && global.z >= aabb.min.z
                        && global.z <= aabb.max.z
                    {
                        return Some(cell_id);
                    }
                }
            }
        }
        None
    }

    /// Phase 6 step D: compute the visible cell set rooted at
    /// `current` via BFS through `cell_portal_graph`. `depth` controls
    /// the BFS frontier — depth=1 includes the current cell plus
    /// every direct portal neighbour, depth=2 also their neighbours,
    /// etc. Depth=0 returns just `{current}`. Always includes
    /// `current` even if it isn't in the graph (e.g., outdoor cells).
    pub fn render_set(&self, current: u32, depth: u8) -> HashSet<u32> {
        let mut visited: HashSet<u32> = HashSet::new();
        if current == 0 {
            return visited;
        }
        visited.insert(current);
        if depth == 0 {
            return visited;
        }
        let mut frontier: VecDeque<(u32, u8)> = VecDeque::new();
        frontier.push_back((current, 0));
        while let Some((cell_id, hop)) = frontier.pop_front() {
            if hop >= depth {
                continue;
            }
            let neighbours = match self.cell_portal_graph.get(&cell_id) {
                Some(n) => n,
                None => continue,
            };
            for &neighbour in neighbours {
                if visited.insert(neighbour) {
                    frontier.push_back((neighbour, hop + 1));
                }
            }
        }
        visited
    }

    /// Phase 4 PView port (2026-05-25): compute the visible cell set
    /// using a view frustum, mirroring WB's
    /// `EnvCellManager.GetVisibleCells` strategy (Editors/Landscape/
    /// EnvCellManager.cs:1316). Two modes based on whether `current` is
    /// an indoor EnvCell (registered in `cell_aabbs`) or an outdoor
    /// LandCell:
    ///
    /// - **Indoor**: BFS-1 over `cell_portal_graph` (which since the
    ///   2026-05-25 visible_cells fix now reaches the full DAT-baked
    ///   PVS from any EnvCell). Each neighbour is then AABB-frustum-
    ///   culled, dropping cells the camera can't see.
    /// - **Outdoor**: iterate every loaded EnvCell AABB and keep those
    ///   the frustum intersects. This is what makes Holtburg cottage
    ///   interiors visible from outside the building — the LandCell-
    ///   to-EnvCell graph edge that retail PView's screen-space portal-
    ///   polygon clip would have produced is approximated by "any
    ///   EnvCell whose AABB straddles the camera frustum is potentially
    ///   visible".
    ///
    /// The current cell is always included (even if outdoor or out of
    /// the frustum) so callers don't lose the "where am I" anchor.
    pub fn compute_visibility_with_frustum(
        &self,
        current: u32,
        frustum: &Frustum,
    ) -> HashSet<u32> {
        let mut visible: HashSet<u32> = HashSet::new();
        if current == 0 {
            return visible;
        }
        visible.insert(current);

        let in_envcell = self.cell_aabbs.contains_key(&current);
        if in_envcell {
            // Indoor path: BFS portal-graph + frustum-prune.
            let bfs = self.render_set(current, 1);
            for cell in bfs {
                if cell == current {
                    continue;
                }
                if let Some(aabb) = self.cell_aabbs.get(&cell) {
                    if frustum.intersects_aabb(aabb) {
                        visible.insert(cell);
                    }
                } else {
                    // No AABB registered — keep (matches BFS semantics).
                    visible.insert(cell);
                }
            }
        } else {
            // Outdoor path: frustum-cull every loaded EnvCell AABB.
            // This is the LandCell↔EnvCell visibility bridge.
            //
            // Phase 6 outdoor-exit filter (2026-05-25): only include
            // EnvCells whose portal records contain at least one
            // outdoor-exit sentinel (`other_cell_id & 0xFFFF >= 0xFFFE`,
            // typically 0xFFFF). Interior-only chains (upstairs cells,
            // attics, satellite-window cells) reachable solely through
            // indoor portals stay culled — retail PView from an outdoor
            // camera wouldn't reach them either.
            //
            // Symptom this fixes: standing in Holtburg town square,
            // high-Z attic / roof cells (e.g. 0xA9B40158, 0xA9B40166,
            // 0xA9B4016B) appeared as "floating dungeons in the sky"
            // because their AABBs intersected the camera frustum even
            // though no portal-graph path from outdoor to those cells
            // exists.
            //
            // A cell qualifies as having an outdoor exit when at least
            // one neighbour in `cell_portal_graph` has low-16 bits
            // ≥ 0xFFFE (the AC outdoor-exit sentinel). Cells with no
            // entry in cell_portal_graph at all are excluded (they
            // can't be reached by anything; renderer doesn't need them
            // from outdoor).
            for (&cell, aabb) in &self.cell_aabbs {
                if !frustum.intersects_aabb(aabb) {
                    continue;
                }
                let has_outdoor_exit = self
                    .cell_portal_graph
                    .get(&cell)
                    .map(|edges| {
                        edges.iter().any(|&n| (n & 0xFFFF) >= 0xFFFE)
                    })
                    .unwrap_or(false);
                if has_outdoor_exit {
                    visible.insert(cell);
                }
            }
        }
        visible
    }

    /// Phase 5 PView port (2026-05-25): full screen-space
    /// portal-polygon clipping per retail `PView::ClipPortals` /
    /// `OtherPortalClip` / `AddViewToPortals`. From `current`, walks
    /// portal-connected cells, clipping each portal polygon against
    /// the parent view polygon. Cells whose portal admits any pixels
    /// through from the camera frustum are added to the visible set.
    ///
    /// `mvp` is column-major 4×4 (the same memory layout
    /// `THREE.Matrix4.elements` produces and the same Gribb-Hartmann
    /// extraction `Frustum::from_view_projection_matrix` accepts). It
    /// must be composed in the same coord system as
    /// `cell_portal_polygons` vertices — AC world (Z-up), so JS passes
    /// `projection · matrixWorldInverse · worldRoot.matrixWorld`.
    ///
    /// `max_depth` bounds the portal traversal recursion. Retail
    /// uses no fixed limit but the per-portal clip becomes empty in
    /// a few hops; a hard cap of ~8 protects against pathological
    /// loops in malformed dat data.
    ///
    /// Always includes `current` in the visible set. Vertices behind
    /// the camera near plane (w ≤ 0) cause the entire portal polygon
    /// to be skipped in this initial implementation — proper
    /// near-plane polygon clipping is future polish. Callers that
    /// need near-portal robustness should union with
    /// `compute_visibility_with_frustum` (Phase 4 AABB cull).
    pub fn compute_visibility_with_pview(
        &self,
        current: u32,
        mvp: &[f32; 16],
        max_depth: u8,
    ) -> HashSet<u32> {
        let mut visible: HashSet<u32> = HashSet::new();
        if current == 0 {
            return visible;
        }
        visible.insert(current);

        // Initial view = full NDC viewport [-1, 1] × [-1, 1] (CCW).
        let initial_view: Vec<[f32; 2]> = vec![
            [-1.0, -1.0],
            [1.0, -1.0],
            [1.0, 1.0],
            [-1.0, 1.0],
        ];

        let mut queue: VecDeque<(u32, Vec<[f32; 2]>, u8)> = VecDeque::new();
        queue.push_back((current, initial_view, 0));

        while let Some((cell, view_poly, depth)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            for portal in self.cell_portal_polygons_for(cell) {
                let neighbour = portal.other_cell_id;
                // Skip sentinel exit-portals (0xFFFE/0xFFFF) — they
                // point to outdoor LandCells with no portals of their
                // own; PView walk doesn't recurse into them.
                if (neighbour & 0xFFFF) >= 0xFFFE {
                    continue;
                }
                if visible.contains(&neighbour) {
                    continue;
                }

                // Project the polygon's 3D vertices through MVP to NDC.
                let projected = pview_project_polygon(&portal.vertices, mvp);
                if projected.is_empty() {
                    continue;
                }

                // Clip projected polygon against parent view polygon.
                let clipped =
                    pview_clip_polygon_against_polygon(&projected, &view_poly);
                if clipped.len() < 3 {
                    continue;
                }

                visible.insert(neighbour);
                queue.push_back((neighbour, clipped, depth + 1));
            }
        }
        visible
    }

    pub fn sweep_sphere_against_buildings(
        &self,
        pose: &WorldPosition,
        delta: Vector3,
        radius: f32,
    ) -> Option<crate::spatial::SweptSphereHit> {
        crate::spatial::sweep_sphere_against_aabbs(
            &self.building_aabbs_near_pose(pose),
            pose,
            delta,
            radius,
        )
    }

    /// Workstream C (3D camera collision, 2026-05-11): insert a static
    /// placement's world-space AABB into the per-landblock index.
    /// Called by the wasm bundle's `populateStaticsAabbsForLandblock`
    /// once per non-building entry in `LandblockInfo.objects`. The
    /// landblock key is the high word (`0xXXYY0000`); callers SHOULD
    /// have already masked it. Idempotent at the API level — repeated
    /// calls with the same `(landblock, entry)` accumulate (the camera
    /// sweep tolerates duplicates; deduplication would cost more in
    /// HashMap probes than we'd save).
    pub fn insert_static_aabb(&mut self, landblock_high: u32, entry: StaticAabbEntry) {
        self.statics_aabb_index
            .entry(landblock_high)
            .or_default()
            .push(entry);
    }

    /// Workstream C: drop every static-AABB entry for the given
    /// landblock. Called when the LB unloads (mirror of
    /// `clear_building_aabbs_for_landblock`). Returns the count of
    /// removed entries for diagnostic logging.
    pub fn clear_static_aabbs_for_landblock(&mut self, landblock_high: u32) -> usize {
        match self.statics_aabb_index.remove(&landblock_high) {
            Some(v) => v.len(),
            None => 0,
        }
    }

    /// Workstream C: total static-AABB entry count across all loaded
    /// landblocks. Diagnostic only.
    pub fn static_aabb_count(&self) -> usize {
        self.statics_aabb_index.values().map(|v| v.len()).sum()
    }

    /// Workstream C: candidate statics for a swept-sphere query
    /// starting at `pose`. Returns entries for the pose's containing
    /// landblock plus the immediate neighbours (Holtburg's 3x3 ring is
    /// always loaded but the camera might sweep across an LB boundary
    /// at the edge). Returns by value to dodge per-cell borrows —
    /// statics fan-in is small (Holtburg's central LB has ~70 statics)
    /// so the clone cost is negligible.
    pub fn statics_aabbs_near_pose(&self, pose: &WorldPosition) -> Vec<StaticAabbEntry> {
        let lb_high = pose.landblock_id.0 & 0xFFFF_0000;
        let lb_x = ((lb_high >> 24) & 0xFF) as i32;
        let lb_y = ((lb_high >> 16) & 0xFF) as i32;
        let mut out: Vec<StaticAabbEntry> = Vec::new();
        for dx in -1i32..=1 {
            for dy in -1i32..=1 {
                let nx = lb_x + dx;
                let ny = lb_y + dy;
                if !(0..256).contains(&nx) || !(0..256).contains(&ny) {
                    continue;
                }
                let key = ((nx as u32) << 24) | ((ny as u32) << 16);
                if let Some(entries) = self.statics_aabb_index.get(&key) {
                    out.extend_from_slice(entries);
                }
            }
        }
        out
    }

    /// Workstream C: sweep a sphere of `radius` along `delta` against
    /// statics near `pose`, returning the earliest hit. Mirrors
    /// `sweep_sphere_against_buildings` but returns a `GenericSweptHit`
    /// (statics don't carry per-part / door state — no need for the
    /// `BuildingAabbEntry` reference).
    pub fn sweep_sphere_against_statics(
        &self,
        pose: &WorldPosition,
        delta: Vector3,
        radius: f32,
    ) -> Option<crate::spatial::GenericSweptHit> {
        crate::spatial::sweep_sphere_against_static_aabbs(
            &self.statics_aabbs_near_pose(pose),
            pose,
            delta,
            radius,
        )
    }

    /// Workstream C: sweep a sphere from `start` to `end` (world-space
    /// metres) against the cell-physics triangles of the cells in
    /// `cell_ids`. Used by the camera collision path to clip against
    /// indoor walls without snapping the camera to the player's exact
    /// cell — the camera ray crosses multiple cells in a dungeon
    /// corridor, so callers pass the BFS render set (depth=1).
    /// Returns the earliest hit across all cells, or `None` for a
    /// clean miss / no cells with cached triangles.
    pub fn sweep_sphere_against_cell_mesh(
        &self,
        cell_ids: &[u32],
        start: Vector3,
        end: Vector3,
        radius: f32,
    ) -> Option<crate::spatial::GenericSweptHit> {
        // Build a working triangle list from every cell the caller
        // gave us. We don't merge into a single Vec ahead of time
        // because the per-cell counts are small and most cells in a
        // depth=1 render set are reachable but currently empty
        // (portal-only frontier). Iterate by cell so empty buckets
        // cost a single HashMap probe.
        let mut best: Option<crate::spatial::GenericSweptHit> = None;
        for &cell_id in cell_ids {
            let tris = self.cell_triangles(cell_id);
            if tris.is_empty() {
                continue;
            }
            if let Some(hit) = crate::spatial::sweep_sphere_against_triangles(
                tris, start, end, radius,
            ) && (best.is_none() || hit.t < best.unwrap().t)
            {
                best = Some(hit);
            }
        }
        best
    }

    /// Workstream C (3D camera collision, 2026-05-11): insert a
    /// world-space physics triangle for a building part into the
    /// per-landblock index. Called by the wasm bundle's
    /// `populateBuildingAabbsForLandblock` (extended in Workstream C
    /// to also extract per-part GfxObj.physics_polygons) after
    /// transforming each polygon through the building's placement
    /// frame + the part's per-part frame.
    ///
    /// Keyed by `landblock_high` (the `0xXXYY0000` form), not full
    /// cell id — building interiors don't subdivide on AC's 8x8 grid;
    /// they belong to whatever building's placement origin is in this
    /// landblock. The camera sweep collects all triangles for the
    /// landblock the player is in.
    pub fn insert_building_triangle(&mut self, landblock_high: u32, tri: Triangle) {
        self.building_physics_index
            .entry(landblock_high)
            .or_default()
            .push(tri);
    }

    /// Workstream C: read access to the world-space building-interior
    /// triangles for `landblock_high`. Returned slice may be empty when
    /// the landblock hasn't been baked yet, or when no building in this
    /// landblock has any `physics_polygons` (e.g. early-AC content where
    /// the buildings ship with only coarse AABB collision).
    pub fn building_triangles_for_landblock(&self, landblock_high: u32) -> &[Triangle] {
        self.building_physics_index
            .get(&(landblock_high & 0xFFFF_0000))
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Workstream C: count of landblocks with at least one indexed
    /// building-interior triangle. Diagnostic only — used by the
    /// recv-loop drain logger to confirm the populator wired up. Mirrors
    /// `cell_physics_count`'s shape.
    pub fn building_physics_count(&self) -> usize {
        self.building_physics_index.len()
    }

    /// Workstream C: total triangle count across all loaded landblocks
    /// in `building_physics_index`. Used by the wasm-side drain log to
    /// report Holtburg town hall's per-part triangulated wall count.
    pub fn building_triangles_total(&self) -> usize {
        self.building_physics_index.values().map(|v| v.len()).sum()
    }

    /// Workstream C: sweep a sphere of `radius` from `start` to `end`
    /// against the building-interior triangles of the landblock at
    /// `landblock_high`. Mirrors `sweep_sphere_against_cell_mesh` but
    /// targets the building-physics index instead of the cell-physics
    /// one. Returns `None` for a clean miss / no triangles loaded.
    ///
    /// The camera path uses this when the player is inside (or near)
    /// a Holtburg building — town hall interior rooms, multi-storey
    /// merchant shops, etc. — to clip the follow camera against
    /// interior walls and basement walls that the building's coarse
    /// per-part AABB doesn't resolve.
    pub fn sweep_sphere_against_building_mesh(
        &self,
        landblock_high: u32,
        start: Vector3,
        end: Vector3,
        radius: f32,
    ) -> Option<crate::spatial::GenericSweptHit> {
        let tris = self.building_triangles_for_landblock(landblock_high);
        if tris.is_empty() {
            return None;
        }
        crate::spatial::sweep_sphere_against_triangles(tris, start, end, radius)
    }

    pub fn physics(&self) -> &Arc<dyn SpatialPhysics> {
        &self.physics
    }

    pub fn runtime_sampling_config(&self) -> SpatialSamplingConfig {
        self.body_store.config()
    }

    pub fn set_runtime_sampling_config(&mut self, config: SpatialSamplingConfig) {
        self.body_store.set_config(config);
    }

    pub fn runtime_body_view(&self, body_id: SpatialBodyId) -> Option<RuntimeSpatialBodyView> {
        self.body_store.runtime_body_view(body_id)
    }

    pub fn iter_runtime_body_views(&self) -> impl Iterator<Item = RuntimeSpatialBodyView> + '_ {
        self.body_store.iter_runtime_body_views()
    }

    pub fn body(&self, body_id: SpatialBodyId) -> Option<&SpatialBody> {
        self.body_store.body(body_id)
    }

    pub fn body_for_guid(&self, guid: Guid) -> Option<&SpatialBody> {
        self.body_store.body_for_guid(guid)
    }

    pub fn body_mut(&mut self, body_id: SpatialBodyId) -> Option<&mut SpatialBody> {
        self.body_store.body_mut(body_id)
    }

    pub fn register_body(&mut self, body: SpatialBody) -> Option<SpatialBody> {
        self.body_store.register_body(body)
    }

    pub fn update_body(&mut self, body: SpatialBody) -> Option<SpatialBody> {
        self.body_store.update_body(body)
    }

    pub fn remove_body(&mut self, body_id: SpatialBodyId) -> Option<SpatialBody> {
        self.body_store.remove_body(body_id)
    }

    pub fn allocate_ephemeral_body_id(&mut self) -> SpatialBodyId {
        self.body_store.allocate_ephemeral_body_id()
    }

    pub fn register_ephemeral_body(&mut self, pose: WorldPosition, now: Instant) -> SpatialBodyId {
        self.body_store.register_ephemeral_body(pose, now)
    }

    pub fn reconcile_authoritative_body(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        velocity: Vector3,
        omega: Vector3,
        sync: AuthoritativeBodySync,
        now: Instant,
    ) {
        let mode = match sync {
            AuthoritativeBodySync::Snapshot => SpatialSampleMode::AuthoritativeOnly,
            AuthoritativeBodySync::Reset => SpatialSampleMode::Suspended,
        };

        let mut body = self
            .body_store
            .remove_body(body_id)
            .unwrap_or_else(|| SpatialBody::new(body_id, pose, now));

        let preserve_local_runtime_pose = matches!(body_id, SpatialBodyId::LocalPlayer(_))
            && matches!(sync, AuthoritativeBodySync::Snapshot)
            && matches!(
                body.sampling.mode,
                SpatialSampleMode::SimulatingMotionState | SpatialSampleMode::SimulatingVelocity
            );

        body.authoritative_pose = Some(pose);
        body.velocity = velocity;
        body.omega = omega;
        body.motion_state = None;
        body.sampling.last_authoritative_update = now;
        body.sampling.last_derived_at = now;
        if preserve_local_runtime_pose {
            // Physics deep-dive 2026-06-01 (gap 4): the local player is
            // mid-simulation and the server force-positioned us. Rather
            // than fully preserve the (possibly drifted) integrator
            // working pose — which left the next heartbeat re-asserting
            // the drift forever — pull `body.pose` toward the forced
            // pose by a capped per-tick correction so the rubberband
            // converges over a few heartbeats. The sampling mode stays
            // on the simulating value so the integrator keeps driving;
            // only the working origin is nudged. (Far-enough corrections
            // still hard-blip; see `constrain_local_pose_toward`.)
            if USE_RETAIL_INTERPOLATE {
                // Opt-in faithful path: install the retail
                // `ConstrainTo` + `InterpolateTo` managers and let the
                // per-frame integrator ease `body.pose` toward the forced
                // pose (see `step_force_position_interpolation`). Only
                // install for a sub-blip gap — beyond the autonomy-blip
                // radius this is a routine far broadcast / teleport-class
                // correction (the academy-rubberband invariant), so we
                // leave the working pose untouched and clear any pending
                // interpolation.
                let indoor = pose.is_indoors();
                let blip = if indoor {
                    BLIP_SNAP_DISTANCE_INDOOR_M
                } else {
                    BLIP_SNAP_DISTANCE_OUTDOOR_M
                };
                let leash_start = if indoor {
                    CONSTRAINT_LEASH_INDOOR_M
                } else {
                    CONSTRAINT_LEASH_OUTDOOR_M
                };
                let distance = body.pose.distance_to(&pose);
                if distance > blip {
                    body.force_position_interp.stop();
                } else {
                    // `keep_heading = true`: the integrator owns heading
                    // and the forced rotation is recorded in
                    // `authoritative_pose` above. `start = leash`,
                    // `max = blip` mirror `GetStartConstraintDistance` /
                    // `GetMaxConstraintDistance` for the player.
                    body.force_position_interp.install(
                        body.pose, pose, leash_start, blip, true,
                    );
                }
            } else if USE_LOCAL_FORCE_POSITION_CONSTRAINT {
                body.pose = constrain_local_pose_toward(body.pose, pose);
            }
        } else {
            body.pose = pose;
            body.sampling.mode = mode;
        }

        self.body_store.register_body(body);
    }

    /// Physics deep-dive 2026-06-01 (gap 4, opt-in) — advance the faithful
    /// retail force-position interpolator for one physics frame, mutating
    /// `body.pose` toward the installed forced target via the retail
    /// `adjust_offset` easing curve (see
    /// [`super::RetailForcePositionInterpolator::step`]).
    ///
    /// This is the per-frame half of the [`USE_RETAIL_INTERPOLATE`] path.
    /// It is a NO-OP when:
    /// - the flag is `false` (shipped single-step path is in effect), or
    /// - no interpolation target is installed on the body, or
    /// - the body does not exist.
    ///
    /// `quantum` is the frame `dt` in seconds. `max_speed` should be the
    /// player's `get_adjusted_max_speed() * 2.0`
    /// (`run_rate * 4.0 * 2.0`); pass `0.0` to let the interpolator floor
    /// to `MAX_INTERPOLATED_VELOCITY` (7.5 m/s). `on_contact` mirrors
    /// `TransientStateFlags.Contact`.
    ///
    /// Returns the per-frame [`InterpStep`] outcome (`Idle` when nothing
    /// happened), so the caller can observe completion/failure.
    pub fn step_force_position_interpolation(
        &mut self,
        body_id: SpatialBodyId,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> InterpStep {
        if !USE_RETAIL_INTERPOLATE {
            return InterpStep::Idle;
        }
        let Some(body) = self.body_store.body_mut(body_id) else {
            return InterpStep::Idle;
        };
        if !body.force_position_interp.is_interpolating() {
            return InterpStep::Idle;
        }
        let outcome =
            body.force_position_interp
                .step(body.pose, quantum, max_speed, on_contact);
        match outcome {
            InterpStep::Progressed { pose } | InterpStep::Completed { pose } => {
                body.pose = pose;
            }
            // Failed leaves the working pose where it was; Idle is unreachable
            // here (we checked is_interpolating above).
            InterpStep::Failed { .. } | InterpStep::Idle => {}
        }
        outcome
    }

    pub fn retire_authoritative_body(&mut self, body_id: SpatialBodyId) -> Option<SpatialBody> {
        self.body_store.remove_body(body_id)
    }

    #[cfg(test)]
    pub(super) fn upsert_runtime_body_snapshot(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        velocity: Vector3,
        omega: Vector3,
        motion_state: Option<EntityMotionSnapshot>,
        now: Instant,
    ) {
        let mut body = self
            .body_store
            .remove_body(body_id)
            .unwrap_or_else(|| SpatialBody::new(body_id, pose, now));

        body.authoritative_pose = Some(pose);
        body.pose = pose;
        body.velocity = velocity;
        body.omega = omega;
        body.motion_state = motion_state;
        body.sampling.mode = SpatialSampleMode::AuthoritativeOnly;
        body.sampling.last_authoritative_update = now;
        body.sampling.last_derived_at = now;

        self.body_store.register_body(body);
    }

    #[cfg(test)]
    pub(super) fn seed_authoritative_body_snapshot(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        velocity: Vector3,
        omega: Vector3,
        motion_state: Option<EntityMotionSnapshot>,
        now: Instant,
    ) {
        self.upsert_runtime_body_snapshot(body_id, pose, velocity, omega, motion_state, now);
    }

    fn set_body_motion_state(
        &mut self,
        body_id: SpatialBodyId,
        motion_state: Option<EntityMotionSnapshot>,
    ) {
        let Some(body) = self.body_store.body_mut(body_id) else {
            return;
        };

        body.motion_state = motion_state;
    }

    pub fn update_runtime_body_motion_state(
        &mut self,
        body_id: SpatialBodyId,
        motion_state: Option<EntityMotionSnapshot>,
    ) {
        self.set_body_motion_state(body_id, motion_state);
    }

    fn reset_body_from_authority(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        now: Instant,
        clear_kinematics: bool,
    ) {
        let body = self
            .body_store
            .bodies
            .entry(body_id)
            .or_insert_with(|| SpatialBody::new(body_id, pose, now));

        body.authoritative_pose = Some(pose);
        body.pose = pose;
        if clear_kinematics {
            body.velocity = Vector3::zero();
            body.omega = Vector3::zero();
            body.motion_state = None;
        }
        body.sampling.last_authoritative_update = now;
        body.sampling.last_derived_at = now;
        body.sampling.mode = SpatialSampleMode::AuthoritativeOnly;
    }

    pub fn apply_runtime_body_pose(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        sample_mode: SpatialSampleMode,
    ) -> bool {
        let Some(body) = self.body_store.body_mut(body_id) else {
            return false;
        };

        body.pose = pose;
        body.sampling.mode = sample_mode;
        true
    }

    pub fn apply_runtime_body_contact(
        &mut self,
        body_id: SpatialBodyId,
        contact: ContactState,
    ) -> bool {
        let Some(body) = self.body_store.body_mut(body_id) else {
            return false;
        };

        body.contact = contact;
        true
    }

    pub fn apply_solved_runtime_body_kinematics(&mut self, solved: &SolvedBodyKinematics) -> bool {
        let Some(body) = self.body_store.body_mut(solved.body_id) else {
            return false;
        };

        body.pose = solved.pose;
        body.velocity = solved.velocity;
        body.omega = solved.omega;
        body.contact = solved.contact;
        body.sampling.mode = sample_mode_for_projection_state(
            solved.projection_state,
            solved.velocity,
            solved.omega,
        );
        true
    }

    pub fn apply_forced_reposition_reset(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        now: Instant,
    ) {
        self.reset_body_from_authority(body_id, pose, now, true);
        if let Some(body) = self.body_store.body_mut(body_id) {
            body.sampling.mode = SpatialSampleMode::Suspended;
        }
    }

    pub fn suspend_runtime_bodies(&mut self, now: Instant) {
        for body in self.body_store.bodies.values_mut() {
            if let Some(authoritative_pose) = body.authoritative_pose {
                body.pose = authoritative_pose;
            }
            body.sampling.mode = SpatialSampleMode::Suspended;
            body.sampling.last_derived_at = now;
        }
    }

    pub fn update_entity(&mut self, guid: Guid, old_lb: Guid, pose: WorldPosition) {
        let new_lb = pose.landblock_id;
        if old_lb != new_lb
            && let Some(set) = self.landblock_map.get_mut(&old_lb)
        {
            set.remove(&guid);
        }
        self.landblock_map.entry(new_lb).or_default().insert(guid);
        self.entity_poses.insert(guid, pose);
    }

    pub fn remove_entity(&mut self, guid: Guid, lb: Guid) {
        if let Some(set) = self.landblock_map.get_mut(&lb) {
            set.remove(&guid);
        }
        self.entity_poses.remove(&guid);
    }

    pub fn get_in_landblock(&self, lb: Guid) -> Option<&HashSet<Guid>> {
        self.landblock_map.get(&lb)
    }

    pub fn get_nearby_entities(&self, lb: Guid) -> HashSet<Guid> {
        let mut nearby = HashSet::new();

        let x = (lb >> 24) & 0xFF;
        let y = (lb >> 16) & 0xFF;

        for dx in -1..=1 {
            for dy in -1..=1 {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx > 0 && nx < 255 && ny > 0 && ny < 255 {
                    let neighbor_lb = ((nx as u32) << 24) | ((ny as u32) << 16) | 0xFFFF;
                    if let Some(set) = self.landblock_map.get(&Guid(neighbor_lb)) {
                        for &guid in set {
                            nearby.insert(guid);
                        }
                    }
                }
            }
        }

        if let Some(set) = self.landblock_map.get(&lb) {
            for &guid in set {
                nearby.insert(guid);
            }
        }

        nearby
    }

    pub fn get_entities_in_range(&self, pos: &WorldPosition, radius: f32) -> Vec<Guid> {
        if pos.landblock_id == Guid::NULL || radius < 0.0 {
            return Vec::new();
        }

        self.get_nearby_entities(pos.landblock_id)
            .into_iter()
            .filter(|guid| {
                self.entity_poses
                    .get(guid)
                    .is_some_and(|candidate| pos.distance_to(candidate) <= radius)
            })
            .collect()
    }
}

// ------------------------------------------------------------------
// Phase 5 PView port (2026-05-25) helpers — screen-space portal-
// polygon projection + clipping. Free functions, pure math, fully
// covered by unit tests in spatial::tests. Mirrors retail
// `PView::GetClip` / `OtherPortalClip` shape.
// ------------------------------------------------------------------

/// Project a 3D polygon through a column-major 4×4 MVP to NDC.
/// Returns the 2D NDC vertices (x/w, y/w).
///
/// Clips the polygon against the near plane in homogeneous clip
/// space BEFORE perspective divide (Sutherland-Hodgman against the
/// half-space `z + w >= 0`, the standard OpenGL/Three.js near
/// plane). This handles polygons that straddle the camera near
/// plane — vertices with `w <= 0` would otherwise produce
/// degenerate divide-by-zero or sign-flipped NDC coordinates. After
/// near-plane clipping every surviving vertex has `z + w >= 0`,
/// guaranteeing `w > 0` for normal frustums so the perspective
/// divide is safe.
///
/// Returns an empty vec if the polygon is fully behind the near
/// plane (no vertices survive clipping).
///
/// 2026-05-25: replaces the earlier "skip if any vertex has
/// w <= 1e-6" early-return that wholesale dropped portals when the
/// camera was near a doorway — that was the Phase 5 PView "Known
/// scope gap" #1 in `docs/cell-portal-method.md`.
pub fn pview_project_polygon(
    verts: &[Vector3],
    mvp: &[f32; 16],
) -> Vec<[f32; 2]> {
    if verts.len() < 3 {
        return Vec::new();
    }
    // Pass 1: lift each Vector3 to clip-space (x, y, z, w) via the
    // column-major MVP. m[col*4 + row] convention.
    let mut clip: Vec<[f32; 4]> = Vec::with_capacity(verts.len());
    for v in verts {
        let x = mvp[0] * v.x + mvp[4] * v.y + mvp[8] * v.z + mvp[12];
        let y = mvp[1] * v.x + mvp[5] * v.y + mvp[9] * v.z + mvp[13];
        let z = mvp[2] * v.x + mvp[6] * v.y + mvp[10] * v.z + mvp[14];
        let w = mvp[3] * v.x + mvp[7] * v.y + mvp[11] * v.z + mvp[15];
        clip.push([x, y, z, w]);
    }

    // Pass 2: Sutherland-Hodgman clip against the near plane
    // half-space `z + w >= 0`. For each edge prev→curr emit:
    //   - both inside: curr
    //   - prev outside, curr inside: intersection, then curr
    //   - prev inside, curr outside: intersection
    //   - both outside: nothing
    // Intersection along the edge with parameter
    //   t = (prev.z + prev.w) / ((prev.z + prev.w) - (curr.z + curr.w))
    // applied componentwise on (x, y, z, w).
    let clipped = pview_clip_against_near_plane(&clip);
    if clipped.is_empty() {
        return Vec::new();
    }

    // Pass 3: perspective divide. After near-plane clipping w > 0
    // for any normal frustum (since z >= -w). Guard against
    // pathological w == 0 anyway.
    let mut out = Vec::with_capacity(clipped.len());
    for c in &clipped {
        let w = c[3];
        if w.abs() < 1e-12 {
            // Degenerate (camera origin coincides with vertex).
            // Treat as behind-clip and bail.
            return Vec::new();
        }
        out.push([c[0] / w, c[1] / w]);
    }
    out
}

/// Sutherland-Hodgman near-plane clip in homogeneous clip space.
/// Treats `subject` as a polygon (any winding). Clips against the
/// half-space `z + w >= 0` (OpenGL/Three.js near plane convention).
/// Returns the clipped polygon's clip-space vertices or empty if
/// the whole polygon is behind the near plane.
fn pview_clip_against_near_plane(subject: &[[f32; 4]]) -> Vec<[f32; 4]> {
    let n = subject.len();
    if n < 3 {
        return Vec::new();
    }
    let inside = |v: &[f32; 4]| -> bool { v[2] + v[3] >= 0.0 };
    let intersect = |a: &[f32; 4], b: &[f32; 4]| -> [f32; 4] {
        // a's signed distance to plane: a.z + a.w.
        // Parameterize t along a→b where (1-t)*a + t*b lands on
        // the plane.
        let da = a[2] + a[3];
        let db = b[2] + b[3];
        let denom = da - db;
        // If parallel (rare), fall back to a — caller logic stays
        // consistent (we already know one side; intersection is
        // numerically nearby).
        let t = if denom.abs() < 1e-12 {
            0.0
        } else {
            da / denom
        };
        [
            a[0] + t * (b[0] - a[0]),
            a[1] + t * (b[1] - a[1]),
            a[2] + t * (b[2] - a[2]),
            a[3] + t * (b[3] - a[3]),
        ]
    };

    let mut output: Vec<[f32; 4]> = Vec::with_capacity(n + 2);
    for i in 0..n {
        let curr = subject[i];
        let prev = subject[(i + n - 1) % n];
        let curr_in = inside(&curr);
        let prev_in = inside(&prev);
        if curr_in {
            if !prev_in {
                output.push(intersect(&prev, &curr));
            }
            output.push(curr);
        } else if prev_in {
            output.push(intersect(&prev, &curr));
        }
    }
    output
}

/// Sutherland-Hodgman polygon vs convex-polygon clip. Treats `clip`
/// as a CCW convex polygon (the NDC viewport is CCW, recursively-
/// clipped polygons inherit that). `subject` is the polygon being
/// clipped; can be any winding. Returns the clipped polygon or empty
/// if completely outside.
pub fn pview_clip_polygon_against_polygon(
    subject: &[[f32; 2]],
    clip: &[[f32; 2]],
) -> Vec<[f32; 2]> {
    if clip.len() < 3 || subject.is_empty() {
        return Vec::new();
    }
    let mut output: Vec<[f32; 2]> = subject.to_vec();
    for i in 0..clip.len() {
        if output.is_empty() {
            break;
        }
        let input = std::mem::take(&mut output);
        let edge_a = clip[i];
        let edge_b = clip[(i + 1) % clip.len()];
        let len = input.len();
        for j in 0..len {
            let curr = input[j];
            let prev = input[(j + len - 1) % len];
            let curr_in = pview_is_inside_edge(curr, edge_a, edge_b);
            let prev_in = pview_is_inside_edge(prev, edge_a, edge_b);
            if curr_in {
                if !prev_in {
                    output.push(pview_line_intersect(prev, curr, edge_a, edge_b));
                }
                output.push(curr);
            } else if prev_in {
                output.push(pview_line_intersect(prev, curr, edge_a, edge_b));
            }
        }
    }
    output
}

/// Inside iff to the LEFT of edge a→b (CCW convention).
fn pview_is_inside_edge(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> bool {
    let cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    cross >= 0.0
}

/// 2D line-segment intersection (p1→p2 vs p3→p4). Returns p2 if
/// segments are parallel (degenerate, caller checks). Used by
/// Sutherland-Hodgman to compute the clipped polygon's edge crossing.
fn pview_line_intersect(
    p1: [f32; 2],
    p2: [f32; 2],
    p3: [f32; 2],
    p4: [f32; 2],
) -> [f32; 2] {
    let d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if d.abs() < 1e-9 {
        return p2;
    }
    let t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0]))
        / d;
    [
        p1[0] + t * (p2[0] - p1[0]),
        p1[1] + t * (p2[1] - p1[1]),
    ]
}
