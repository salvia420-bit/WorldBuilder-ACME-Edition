use super::{
    AuthoritativeBodySync, BasicSpatialPhysics, BuildingAabbEntry, BuildingId, CellPortalPolygon,
    ContactState, InterpStep, InterpolationCommand, RuntimeSpatialBodyView, SolvedBodyKinematics,
    SpatialBody,
    SpatialBodyId, SpatialPhysics, SpatialSampleMode, SpatialSamplingConfig, StaticAabbEntry,
    physics::sample_mode_for_projection_state,
};
use crate::entity::EntityMotionSnapshot;
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use holtburger_common::{Aabb, Frustum, Guid, Triangle, Vector3};
use holtburger_dat::file_type::SkyDesc;
use holtburger_dat::transition::objcell::{CELL_SIZE, lcoord_to_cellid};
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
const USE_RETAIL_INTERPOLATE: bool = true;

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

/// Physics deep-dive 2026-06-08 (track B1) — retail
/// `CPhysicsObj::GetMaxConstraintDistance` (`PhysicsObj.cs`, the player
/// arm): `50.0` outdoor / `20.0` indoor. This is the `ConstrainTo`
/// `max_distance` (the leash CAP), NOT the autonomy-blip snap radius.
///
/// The install path used to (incorrectly) pass the autonomy-blip radius
/// (`BLIP_SNAP_DISTANCE_*` = 100/25) as the interpolator `max` arg, which
/// let the constraint leash scale out to the full snap distance and
/// collapse the gap in effectively one ease — re-introducing the yank.
/// Passing the true `GetMaxConstraintDistance` here keeps the leash
/// bounded so a sub-blip gap eases over several frames instead of
/// snapping. The `if distance > blip` install gate still uses the
/// autonomy-blip radius (100/25) — that cutoff is the academy-rubberband
/// invariant and is intentionally left untouched.
const CONSTRAINT_MAX_INDOOR_M: f32 = 20.0;
const CONSTRAINT_MAX_OUTDOOR_M: f32 = 50.0;

/// A2-P2 (2026-06-12, W3+ S8) — retail `GetAutonomyBlipDistance` for a
/// NON-player object: `20.0` indoor (cellid low word ≥ 0x100), `100.0`
/// outdoor (acclient.c:315861-315880). NOT the player 25/100 pair above
/// (`BLIP_SNAP_DISTANCE_INDOOR_M`); the outdoor value happens to match.
/// The constraint start/max distances are the SAME for player and
/// non-player (acclient.c:315885-315929), so the lattice reuses
/// `CONSTRAINT_LEASH_*` / `CONSTRAINT_MAX_*`.
const REMOTE_BLIP_INDOOR_M: f32 = 20.0;
const REMOTE_BLIP_OUTDOOR_M: f32 = 100.0;

/// A2-P2 — retail's "stop tracking far objects" radius: a remote
/// correction for an object ≥ 96 m from the local player skips the
/// interpolator and hard-sets (`MoveOrTeleport`'s `player_distance`
/// gate, acclient.c:323483-323489).
const REMOTE_INTERP_PLAYER_RADIUS_M: f32 = 96.0;

/// A2-P2 (2026-06-12, W3+ S8) — wire context for a REMOTE position
/// correction, threaded from `apply_entity_position_pack` (and friends)
/// into the scene reconcile so the retail `MoveOrTeleport` lattice
/// (acclient.c:323451-323498) can run. Only constructed on the remote
/// movement-ingest paths; every other reconcile passes `None` and keeps
/// the legacy snap.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteCorrectionCtx {
    /// Wire `pp.has_contact` (acclient.c:145287; ours
    /// `UpdatePositionFlag::IS_GROUNDED`). `None` = the frame carries no
    /// contact bit (AutonomousPosition / PublicUpdatePosition) — treated
    /// as on-contact (S8 OPEN Q2/Q6 ruling: retail's 0xF753-adjacent
    /// `HandleReceivedPosition(..., 1, ...)` call site passes
    /// constant-contact).
    pub contact: Option<bool>,
    /// The local player's runtime pose at ingest — the at-ingest analog
    /// of retail's per-frame cached `player_distance`
    /// (acclient.c:323107-323114; S8 OPEN Q3). `None` (no local player
    /// yet) is treated as ≥ 96 m, i.e. snap.
    pub player_pose: Option<WorldPosition>,
}

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

/// B11 exit BFS bound (2026-06-09): the most indoor cells
/// `exited_envcell_to_outdoor` will walk before giving up and staying
/// indoors. Sized well above any housing structure (the largest
/// mansions are ~15 cells) so the cap only ever trips on a malformed or
/// dungeon-scale graph, where "stay indoors, let the server correct" is
/// the safe verdict.
const EXIT_INDOOR_BFS_MAX_CELLS: usize = 64;

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
    /// Phase E3.4 — the object's uniform scale (retail `gfxobj_scale.z`;
    /// `CPhysicsPart::find_obj_collisions` caches the swept sphere into the
    /// PART's frame using the PART's scale, acclient.c:314669, NOT the mover's).
    /// Env-cell room geometry and unscaled statics are `1.0`; the bake populates
    /// it from the static/scenery placement scale when non-unit (outdoor scenery).
    pub scale: f32,
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

    /// Phase D / WS7 (Option C): the WORLD-space AABB bounding this static's
    /// resolved physics polygons. Each polygon vertex is cell-local, so it is
    /// lifted to world by `origin + orientation · v` (the same frame
    /// [`Self::world_to_local`] inverts). Returns [`Aabb::empty`] when the static
    /// carries no polygons (a tree-only BSP) — the caller skips empty AABBs.
    ///
    /// Used by the per-cell overlap bake
    /// ([`SpatialScene::bake_outdoor_static_overlap_for_landblock`]) to decide
    /// which land cells a building/static footprint overruns, so it can be
    /// registered into every overlapped cell (not just its home cell). The
    /// 8-corner conservative expansion `Aabb::transform_by` does for a part-local
    /// box is unnecessary here: we bound the ACTUAL world vertices directly.
    pub fn world_aabb(&self) -> Aabb {
        let mut aabb = Aabb::empty();
        for poly in self.polys.values() {
            for &v in &poly.vertices {
                aabb.expand_to_include_point(self.orientation.rotate_vector(v) + self.origin);
            }
        }
        aabb
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

// F4-5 (grind-loop G-2, 2026-06-11): the wasm recv-loop snapshots this
// whole struct into the JS-readable camera-sweep shadow EVERY TickMovement
// (`*collision_scene.borrow_mut() = w.scene.clone()`). The immutable
// geometry tables (triangle bags, BSPs, AABB/portal indexes) dominate that
// clone, so they're `Arc`-wrapped: the per-tick clone is a refcount bump,
// and the rare load/unload mutations go through `Arc::make_mut` (which
// deep-clones the one mutated table only while a snapshot still shares it).
// Per-tick mutable state (entity_poses, body_store, landblock_map, door
// exclusions) stays plain.
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
    building_aabb_index: Arc<HashMap<u32, Vec<BuildingAabbEntry>>>,
    /// Phase 6 step D: portal-driven visibility graph. Keyed by full
    /// 32-bit cell id; each entry lists every cell reachable through
    /// a single CellPortal record on the source EnvCell. Populated by
    /// `fetchEnvCellsInLandblock` (see the wasm bundle's pending pile)
    /// and consulted per-frame to compute the active render set.
    /// Stairs are EnvCell-to-EnvCell portal connections — there is no
    /// special-cased stair logic; walking up shifts `current_cell`,
    /// which shifts the BFS frontier, which swaps the visible set.
    cell_portal_graph: Arc<HashMap<u32, Vec<u32>>>,
    /// Phase 6 step D: world-space AABB for each cell, keyed by full
    /// 32-bit cell id. Used by `current_cell` to pick the indoor cell
    /// containing a position when several Z-stacked cells share the
    /// same XY footprint. Outdoor cells aren't stored here — their
    /// containment is computed from the 8x8 grid in O(1) by
    /// `WorldPosition::derived_outdoor_cell_id`.
    cell_aabbs: Arc<HashMap<u32, Aabb>>,
    /// 2026-06-04 (Phase 4 ambient-sound gate): per-cell SeenOutside
    /// bit, keyed by full 32-bit cell id. `true` when the EnvCell's
    /// `flags & ENVCELL_FLAG_SEEN_OUTSIDE (0x01)` is set (env_cell.rs:32).
    /// Retail feeds outdoor ambient into an EnvCell when the cell is an
    /// outdoor cell OR this bit is set — acclient.c:146721/146746. Lives
    /// parallel to `cell_aabbs` (populated by `fetchEnvCellsInLandblock`
    /// via the same pending-pile drain, cleared on landblock unload). The
    /// liveness.rs:137-143 TODO documents this exact lookup.
    cell_seen_outside: Arc<HashMap<u32, bool>>,
    /// 2026-05-10 indoor collision (Phase 6 step G follow-on):
    /// world-space physics triangles per cell, populated by the
    /// wasm bundle's `populateCellPhysicsForLandblock` from
    /// `Environment.cell_structures[id].physics_polygons` (the parser
    /// preserves these but the renderer ignores them — they're
    /// collision-only). Triangles are pre-transformed through the
    /// EnvCell's `position` frame so the per-tick swept-capsule
    /// kernel doesn't have to redo the cell-frame rotation each
    /// frame. Cleared on landblock unload alongside `cell_aabbs`.
    cell_physics_index: Arc<HashMap<u32, Vec<Triangle>>>,
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
    cell_physics_bsp: Arc<HashMap<u32, CellPhysicsBsp>>,
    /// Phase C (2026-06-28): per-cell PRECISE physics BSPs for an EnvCell's
    /// resident STATIC OBJECTS (the `stab_list` — furniture, doors, props),
    /// keyed by full 32-bit cell id. The indoor twin of `statics_physics_bsp`
    /// (which is outdoor/per-landblock): each [`CellPhysicsBsp`] is one static's
    /// `GfxObj.physics_bsp` + resolved polys, framed to WORLD via the placement
    /// origin/orientation. `cell_physics_bsp` carries only the cell ENVIRONMENT
    /// (walls/floor/ceiling); a cell's statics are NOT baked into it, so the
    /// faithful driver tests them separately via
    /// [`super::faithful_bridge::SceneObjCell::find_obj_collisions`]. Cleared on
    /// landblock unload alongside `cell_physics_bsp`.
    ///
    /// LIVE FEED (TODO, wasm-only): nothing populates this yet — the wasm
    /// bundle's `fetchEnvCellsInLandblock` static-object loop currently builds
    /// render-only `StaticObjectPlacement`s. A populate pass mirroring the
    /// outdoor `populateStaticsAabbsForLandblock` BSP extraction must push each
    /// stab's resolved physics BSP here for the gap to close on the live path.
    cell_static_physics_bsp: Arc<HashMap<u32, Vec<CellPhysicsBsp>>>,
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
    cell_membership: Arc<HashMap<u32, CellMembership>>,
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
    cell_portal_polygons: Arc<HashMap<u32, Vec<CellPortalPolygon>>>,
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
    building_origins: Arc<HashMap<BuildingId, (f32, f32)>>,
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
    statics_aabb_index: Arc<HashMap<u32, Vec<StaticAabbEntry>>>,
    /// B4 Tier-2 (2026-06-09): per-landblock PRECISE physics BSPs for
    /// outdoor statics, the parallel of `statics_aabb_index`. Keyed by
    /// landblock high word; one [`CellPhysicsBsp`] per physics-bearing
    /// static placement (its `GfxObj.physics_bsp` + resolved polys, framed
    /// to world via the placement origin/orientation). Populated alongside
    /// the AABBs by `populateStaticsAabbsForLandblock`; cleared per
    /// landblock on unload. Consulted only when `USE_STATIC_BSP` is on, via
    /// [`Self::resolve_static_bsp_pushout`] — the AABB stays the default /
    /// gate-off path, so this is a pure additive runtime switch.
    statics_physics_bsp: Arc<HashMap<u32, Vec<CellPhysicsBsp>>>,
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
    building_physics_index: Arc<HashMap<u32, Vec<Triangle>>>,
    /// Phase D / WS1 (2026-06-28): per-landblock terrain vertex heights for the
    /// faithful OUTDOOR CTransition path. Keyed by the landblock HIGH WORD
    /// (`0xXXYY0000` — `cell_id & 0xFFFF_0000`), the same key form
    /// [`WorldState::terrain_heights`] (`crate::state::types`) uses; the value is
    /// the landblock's 9×9 corner-height grid in `vx * 9 + vy` order (identical
    /// layout to `WorldState::terrain_heights` and `terrain_height_at`). This is
    /// the residency signal [`<SpatialScene as
    /// holtburger_dat::transition::objcell::Landscape>::get_landcell`] keys on
    /// (an outdoor land cell exists for the faithful ring only when its landblock
    /// is loaded) and the corner-height source the WS2/WS3 terrain-triangle build
    /// reads. Populated by [`Self::populate_terrain_heights`] (the wasm
    /// landblock-load feed, mirroring the Phase C BSP staging); cleared per
    /// landblock by [`Self::clear_terrain_heights_for_landblock`] on unload.
    terrain_heights: Arc<HashMap<u32, [f32; 81]>>,
    /// Phase 3 Phase E3.6 (2026-06-29): per-landblock terrain TYPE codes for the
    /// faithful OUTDOOR water gate. Same key form (`cell_id & 0xFFFF_0000`) and
    /// `vx * 9 + vy` layout as [`Self::terrain_heights`]; each entry is the
    /// landblock's 9×9 grid of `(CellLandblock.terrain >> 2) & 0x1F` terrain-type
    /// codes — exactly what lib.rs's heightmap parse already computes as
    /// `terrain_codes`. The faithful outdoor cell builder
    /// ([`super::faithful_bridge::build_outdoor_cell`]) reads this to classify a
    /// 24 m cell's water type from its 4 corner codes (retail `CalcCellWater`,
    /// acclient.c:353608 → water iff `TERRAIN_SURF_CHAR[code] == WATER`, i.e.
    /// code ∈ `16..=20`; ACE `SurfChar` agrees). `None` ⇒ NotWater (fail-soft).
    /// Populated by [`Self::populate_terrain_water_codes`], cleared per landblock
    /// by [`Self::clear_terrain_water_codes_for_landblock`].
    terrain_water_codes: Arc<HashMap<u32, [u8; 81]>>,
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
    /// A2-P2 (2026-06-12, W3+ S8) — runtime switch for the REMOTE
    /// `MoveOrTeleport` lattice + per-frame remote manager step. Set
    /// once at world creation from `?remoteInterp=on` (wasm; native
    /// stays off this stage — S8 OPEN Q9). Default `false` =
    /// byte-identical hard-snap reconcile for remote bodies.
    remote_interp_enabled: bool,
    /// A2-P2: per-tick ledger of remote bodies the manager stepped this
    /// frame (guid → stepped pose), drained by the wasm TickMovement arm
    /// into the JS-readable remote-pose export. Sparse by design: idle
    /// bodies never appear (the JS legacy dead-reckon path keeps owning
    /// them between corrections — S8 §5 risk 2).
    remote_stepped_poses: HashMap<Guid, WorldPosition>,
    /// A2-P3 (2026-06-12, W3+ S9) — O(1) mirror of the LOCAL player
    /// body's sticky target ([`PositionManager::sticky_object_id`]),
    /// kept in sync by [`Self::stick_local_player_to`] /
    /// [`Self::unstick_local_player`] / the timeout in
    /// [`Self::step_local_sticky`]. Lets the entity-pose update sites
    /// route the minimal TargetManager-subset feed
    /// ([`Self::sticky_pose_feed`]) with one compare. `None` whenever
    /// `USE_STICKY_MANAGER` is off (no install site runs) —
    /// byte-identical default behavior.
    local_sticky_target: Option<Guid>,
    /// A2-P3 R2 (2026-06-12, W3+ S9 Stage R2) — runtime switch for
    /// REMOTE-entity sticky (`?stickyRetail=on`). COMPOSES on top of
    /// the A2-P2 triple: set once at world creation from
    /// `?stickyRetail=on` AND the effective `?remoteInterp=on`
    /// composite AND the `USE_STICKY_MANAGER` const (wasm-only caller,
    /// same shape as [`Self::set_remote_interp_enabled`]). Default
    /// `false` = the remote install/step sites below are inert and the
    /// JS F3-4 glue keeps owning remote sticky, byte-identical.
    remote_sticky_enabled: bool,
    /// A2-P3 R2 — holder guid → sticky target guid for REMOTE entities
    /// (retail keeps this on each `CPhysicsObj`'s own StickyManager;
    /// this map is the scene-level index so the per-slice step and the
    /// target-pose resolution don't scan every body). Entries are
    /// removed on unstick, on the 1.0 s retail timeout
    /// (acclient.c:388605-388620), and on entity removal.
    remote_sticky_targets: HashMap<Guid, Guid>,
    /// A2-P3 R2 — per-tick set of remote bodies whose pose was
    /// sticky-stepped this frame; drained next to
    /// [`Self::take_remote_stepped_poses`] so the wasm export can flag
    /// those rows (JS applies the sticky heading + clears the F3-4
    /// glue for FLAGGED rows ONLY — the self-degrading compose rule:
    /// no flagged rows ⇒ the glue path stays armed).
    remote_sticky_stepped: HashSet<Guid>,
    /// Physics-parity 2026-07-03 (dossier A F9/F14) — runtime switch
    /// for the retail LOCAL position lattice (`?retailLeash`): every
    /// accepted self position echo re-arms `ConstrainTo`
    /// (acclient.c:145209-145214), `InterpolateTo` installs only under
    /// server control WITH contact (:145215-145218), teleports constrain
    /// + zero velocity (:145196-145207), and the constraint survives
    /// interp completion ([`PositionManager::set_retail_leash`]).
    /// Default `false` = the shipped `USE_RETAIL_INTERPOLATE` arm,
    /// byte-identical.
    local_retail_leash: bool,
    /// Retail `CommandInterpreter` server-control predicate for the
    /// LOCAL player (`cmdinterp->vfptr[8]`, acclient.c:145215) — the
    /// InterpolateTo install gate. Fed by the movement system on
    /// control transitions (server MoveTo/TurnTo directives); stays
    /// `false` for an autonomous player, which is exactly retail's
    /// no-interp-pull-while-walking behavior.
    local_server_controlled: bool,
}

/// A2-P3 (2026-06-12, W3+ S9) — outcome of one
/// [`SpatialScene::step_local_sticky`] slice.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LocalStickyStep {
    /// No sticky target (or its pose is not fed yet) — pose unchanged.
    Inactive,
    /// The 1.0 s sticky window expired this slice and cleared the
    /// target (acclient.c:388605-388620). The owner must also clear the
    /// server-controlled projection (ACE `ClearTarget → cancel_moveto`,
    /// StickyManager.cs:38-40) — pose unchanged this slice.
    TimedOut,
    /// The sticky pull stepped the working pose (XY + heading; z
    /// untouched by construction, acclient.c:388557).
    Stepped(WorldPosition),
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
            building_aabb_index: Arc::new(HashMap::new()),
            cell_portal_graph: Arc::new(HashMap::new()),
            cell_aabbs: Arc::new(HashMap::new()),
            cell_seen_outside: Arc::new(HashMap::new()),
            cell_physics_index: Arc::new(HashMap::new()),
            cell_physics_bsp: Arc::new(HashMap::new()),
            cell_static_physics_bsp: Arc::new(HashMap::new()),
            cell_membership: Arc::new(HashMap::new()),
            cell_portal_polygons: Arc::new(HashMap::new()),
            door_part_index: HashMap::new(),
            open_door_exclusion_aabbs: HashMap::new(),
            building_origins: Arc::new(HashMap::new()),
            statics_aabb_index: Arc::new(HashMap::new()),
            statics_physics_bsp: Arc::new(HashMap::new()),
            building_physics_index: Arc::new(HashMap::new()),
            terrain_heights: Arc::new(HashMap::new()),
            terrain_water_codes: Arc::new(HashMap::new()),
            sky_desc: None,
            remote_interp_enabled: false,
            remote_stepped_poses: HashMap::new(),
            local_sticky_target: None,
            remote_sticky_enabled: false,
            remote_sticky_targets: HashMap::new(),
            remote_sticky_stepped: HashSet::new(),
            local_retail_leash: false,
            local_server_controlled: false,
        }
    }

    /// Physics-parity 2026-07-03: flip the retail LOCAL lattice switch
    /// (see the field doc). Wasm caller wires `?retailLeash`.
    pub fn set_local_retail_leash(&mut self, enabled: bool) {
        self.local_retail_leash = enabled;
    }

    pub fn local_retail_leash(&self) -> bool {
        self.local_retail_leash
    }

    /// Retail `cmdinterp` server-control predicate feed (see the field
    /// doc) — call on TakeControlFromServer/LoseControl transitions.
    pub fn set_local_server_controlled(&mut self, controlled: bool) {
        self.local_server_controlled = controlled;
    }

    /// FU5: the `controlled_by_server` predicate (retail
    /// `cmdinterp->vfptr[8]`, acclient.c:145215).
    pub fn local_server_controlled(&self) -> bool {
        self.local_server_controlled
    }

    /// FU5 — retail `CPhysicsObj::StopInterpolating` as called by
    /// `TakeControlFromServer` (acclient.c:716950): stops the body's
    /// interpolation WITHOUT unconstraining — the leash survives
    /// (disarm is `UnConstrain`/re-`ConstrainTo` only, :389417).
    pub fn stop_interpolation_only(&mut self, body_id: SpatialBodyId) {
        if let Some(body) = self.body_store.body_mut(body_id) {
            body.position_manager.interpolation.stop_interpolating();
        }
    }

    /// Physics-parity 2026-07-03 (dossier A F9b / B rows 31/42): scale
    /// a LOCAL-player per-slice movement delta through the armed
    /// constraint — retail's `PositionManager::adjust_offset` runs on
    /// EVERY frame offset while the leash is armed, walking included
    /// (acclient.c:388287-388304 chained at :320029); the travel budget
    /// accumulates each slice (scale gated on contact, accumulation
    /// not). Passthrough unless `local_retail_leash` AND the body's
    /// constraint is armed — byte-identical flag-off.
    pub fn constrain_local_manual_delta(
        &mut self,
        body_id: SpatialBodyId,
        delta: Vector3,
    ) -> Vector3 {
        if !self.local_retail_leash {
            return delta;
        }
        let Some(body) = self.body_store.body_mut(body_id) else {
            return delta;
        };
        if !body.position_manager.constraint.is_constrained() {
            return delta;
        }
        let on_contact = body.contact.grounded().unwrap_or(true);
        body.position_manager.constraint.adjust_offset(delta, on_contact)
    }

    /// F10 (2026-07-03, dossier B row 42): the LOCAL player's COMPOSED
    /// per-slice `PositionManager::adjust_offset` chain — interp
    /// REPLACES the intended offset, sticky replaces the planar half +
    /// heading, constraint scales and accumulates ONCE on the final
    /// composed offset, then the interp drain runs
    /// (acclient.c:388287-388304 chained at :320029, BEFORE the
    /// transition validates the move). Supersedes the split
    /// [`Self::constrain_local_manual_delta`] +
    /// [`Self::step_force_position_interpolation`] +
    /// [`Self::step_local_sticky`] trio for chain-owned frames — the
    /// caller must skip those while this returns `Some` (one window
    /// advance / one budget accumulate / one timeout tick per frame).
    ///
    /// `None` (ZERO side effects) unless `local_retail_leash` is armed
    /// AND the body exists — byte-identical flag-off; the split sites
    /// keep owning the frame.
    #[allow(clippy::too_many_arguments)]
    pub fn adjust_local_offset_chain(
        &mut self,
        body_id: SpatialBodyId,
        current: WorldPosition,
        intended_offset: Vector3,
        quantum: f32,
        interp_max_speed: f32,
        sticky_max_speed: f32,
        on_contact: bool,
    ) -> Option<super::position_manager::OffsetChainOutcome> {
        if !self.local_retail_leash {
            return None;
        }
        let body = self.body_store.body_mut(body_id)?;
        let outcome = body.position_manager.adjust_offset_chain(
            current,
            intended_offset,
            quantum,
            interp_max_speed,
            sticky_max_speed,
            // `my_radius = 0.0` fallback (acclient.c:319756-319763;
            // spec S9 OPEN Q3 — same input `step_local_sticky` feeds).
            0.0,
            on_contact,
        );
        if outcome.sticky_timed_out {
            // Mirror `step_local_sticky`'s timeout bookkeeping so the
            // pose-feed routing compare stays coherent.
            self.local_sticky_target = None;
        }
        Some(outcome)
    }

    /// A2-P2: flip the remote-driver runtime switch (see the field doc).
    pub fn set_remote_interp_enabled(&mut self, enabled: bool) {
        self.remote_interp_enabled = enabled;
    }

    /// A2-P2: the remote-driver runtime switch.
    pub fn remote_interp_enabled(&self) -> bool {
        self.remote_interp_enabled
    }

    /// A2-P2: drain the per-tick remote stepped-pose ledger (guid →
    /// stepped pose). Called by the wasm TickMovement arm after the
    /// spine tick; empty whenever the flag is off or no remote manager
    /// stepped this frame.
    pub fn take_remote_stepped_poses(&mut self) -> Vec<(Guid, WorldPosition)> {
        self.remote_stepped_poses.drain().collect()
    }

    /// A2-P3 R2: flip the REMOTE sticky runtime switch (see the field
    /// doc — caller must already have folded in the `?remoteInterp=on`
    /// composite AND `USE_STICKY_MANAGER`).
    pub fn set_remote_sticky_enabled(&mut self, enabled: bool) {
        self.remote_sticky_enabled = enabled;
    }

    /// A2-P3 R2: the REMOTE sticky runtime switch.
    pub fn remote_sticky_enabled(&self) -> bool {
        self.remote_sticky_enabled
    }

    /// A2-P3 R2: drain the per-tick sticky-stepped guid set (drained by
    /// the wasm TickMovement arm next to
    /// [`Self::take_remote_stepped_poses`] to flag the export rows).
    pub fn take_remote_sticky_stepped(&mut self) -> HashSet<Guid> {
        std::mem::take(&mut self.remote_sticky_stepped)
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
        Arc::make_mut(&mut self.building_aabb_index)
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
        Arc::make_mut(&mut self.building_aabb_index).retain(|_cell, entries| {
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
        Arc::make_mut(&mut self.building_origins)
            .retain(|building_id, _| building_id.landblock_id != landblock_id);
        // Workstream C (3D camera collision, 2026-05-11): drop matching
        // per-building-interior triangles so the next load starts from
        // a clean index. Building physics share the AABB lifetime
        // (both are populated by the same `populateBuildingAabbsFor-
        // Landblock` pass), so they get torn down together.
        Arc::make_mut(&mut self.building_physics_index)
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
        Arc::make_mut(&mut self.building_origins)
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
        for entries in Arc::make_mut(&mut self.building_aabb_index).values_mut() {
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
        let entry = Arc::make_mut(&mut self.cell_portal_graph).entry(from).or_default();
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
        Arc::make_mut(&mut self.cell_aabbs).insert(cell_id, aabb);
    }

    /// 2026-06-04 (Phase 4 ambient-sound gate): register the SeenOutside
    /// bit for an indoor cell. JS-side `fetchEnvCellsInLandblock` reads
    /// `envcell.flags & ENVCELL_FLAG_SEEN_OUTSIDE` (env_cell.rs:32) and
    /// pushes the boolean alongside the cell AABB; the recv-loop drain
    /// installs it here. Mirrors `insert_cell_aabb` exactly.
    pub fn insert_cell_seen_outside(&mut self, cell_id: u32, v: bool) {
        Arc::make_mut(&mut self.cell_seen_outside).insert(cell_id, v);
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
        Arc::make_mut(&mut self.cell_portal_graph).retain(|from, edges| {
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
        Arc::make_mut(&mut self.cell_aabbs)
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        let aabbs_removed = aabbs_before - self.cell_aabbs.len();
        // 2026-06-04 (Phase 4 ambient-sound gate): keep
        // `cell_seen_outside` sympathetic with `cell_aabbs` — same
        // EnvCell lifetime, same landblock-high retain. Count rolls
        // into `aabbs_removed` (per-cell flag counts aren't load-bearing).
        Arc::make_mut(&mut self.cell_seen_outside)
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // 2026-05-10 indoor collision: keep `cell_physics_index`
        // sympathetic with `cell_aabbs` — when a landblock unloads,
        // its triangles go too. Counts roll into `aabbs_removed` so
        // the diagnostic log doesn't drift; per-cell triangle counts
        // aren't load-bearing and a future commit can split them
        // out if a gauge is needed.
        Arc::make_mut(&mut self.cell_physics_index)
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // BSP collision (PASS 1): same lifetime as cell_physics_index.
        Arc::make_mut(&mut self.cell_physics_bsp)
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // Phase C: per-cell static physics BSPs share the cell lifetime.
        Arc::make_mut(&mut self.cell_static_physics_bsp)
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // Terrain→EnvCell entry: cell-membership trees share the
        // EnvCell lifetime like the physics BSP.
        Arc::make_mut(&mut self.cell_membership)
            .retain(|cell_id, _| (*cell_id & 0xFFFF_0000) != lb_high);
        // Phase 5 PView port: same lifetime as cell_aabbs.
        Arc::make_mut(&mut self.cell_portal_polygons)
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
        Arc::make_mut(&mut self.cell_portal_polygons)
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

    /// 2026-06-04 (Phase 4 ambient-sound gate): read the SeenOutside bit
    /// for `cell_id`. Returns `false` for the no-cell / outdoor / not-yet-
    /// baked case (key absent) — correct because outdoor cells already
    /// short-circuit the indoor ambient gate, so this only matters when
    /// the pose is indoors. Retail feeds outdoor ambient into a cell when
    /// (outdoor-cell OR seen_outside) — acclient.c:146721/146746. Mirrors
    /// `cell_aabb` (read access to the parallel `cell_seen_outside` map).
    pub fn cell_seen_outside(&self, cell_id: u32) -> bool {
        self.cell_seen_outside.get(&cell_id).copied().unwrap_or(false)
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
        Arc::make_mut(&mut self.cell_physics_index).entry(cell_id).or_default().push(tri);
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
        Arc::make_mut(&mut self.cell_physics_bsp).insert(cell_id, bsp);
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

    /// Phase C (2026-06-28): append one resident static's physics BSP for
    /// `cell_id`. Append-only (a cell holds many statics); the per-landblock
    /// clear on unload keeps it bounded. Mirrors `insert_static_physics_bsp`
    /// (the outdoor twin) but keyed by full cell id.
    pub fn insert_cell_static_physics_bsp(&mut self, cell_id: u32, bsp: CellPhysicsBsp) {
        Arc::make_mut(&mut self.cell_static_physics_bsp)
            .entry(cell_id)
            .or_default()
            .push(bsp);
    }

    /// Phase C: the resident static physics BSPs for `cell_id` (or `&[]` when
    /// the cell has none / isn't loaded). Iterated by the faithful driver's
    /// per-cell `find_obj_collisions`.
    pub fn cell_static_physics_bsp(&self, cell_id: u32) -> &[CellPhysicsBsp] {
        self.cell_static_physics_bsp
            .get(&cell_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Phase C: total registered per-cell static physics-BSP count. Diagnostic.
    pub fn cell_static_physics_bsp_count(&self) -> usize {
        self.cell_static_physics_bsp.values().map(|v| v.len()).sum()
    }

    /// Phase D / WS7 (Option C — the headline off-center-building fix): bake the
    /// per-cell OUTDOOR static/building overlap index for one landblock.
    ///
    /// For every outdoor static/building physics BSP registered under
    /// `landblock_high` in [`Self::statics_physics_bsp`] (keyed by landblock high
    /// word), this computes the static's WORLD AABB ([`CellPhysicsBsp::world_aabb`]),
    /// converts it to GLOBAL land-cell coords (`world / 24`, the same `floor(/24)`
    /// the ring uses at `objcell.rs` `add_all_outside_cells_sphere`), and registers
    /// the static's [`CellPhysicsBsp`] into [`Self::cell_static_physics_bsp`] for
    /// the land cells it overlaps:
    /// - `overlap_enabled == true` (DEFAULT — `?buildingOverlap` on — the fix):
    ///   the `[min..=max]` land-cell rectangle the AABB overlaps (the
    ///   `add_cell_block` rectangle), so an off-center building whose footprint
    ///   overruns into a neighbor cell is testable from THAT neighbor cell.
    /// - `overlap_enabled == false` (`?buildingOverlap=off` — the retail bug
    ///   repro): the HOME cell only (the cell the AABB CENTER falls into, matching
    ///   the `building_aabb_index` "bucket by centre" rule), reproducing retail's
    ///   home-cell-only registration that an off-center building walks through.
    ///
    /// This is the ONLY behavioral deviation from retail and it is INDEX-ONLY: it
    /// widens the per-cell static index that the faithful driver's
    /// [`super::faithful_bridge::SceneObjCell::find_obj_collisions`] reads; the
    /// swept-sphere resolver and `find_obj_collisions` itself are untouched. The
    /// faithful OUTDOOR driver reads statics from `cell_static_physics_bsp` (NOT
    /// `statics_physics_bsp`), so this bake is also what makes outdoor statics
    /// testable on the faithful path at all (the outdoor twin of the Phase C
    /// indoor `insert_cell_static_physics_bsp` feed).
    ///
    /// LOADING-VIRUS BOUND (gmriggs): the bake NEVER reads or triggers a load of
    /// another landblock — the overlap rectangle is clamped to this (resident)
    /// landblock's own 8×8 cell grid and each target cell is additionally gated on
    /// terrain residency ([`Self::terrain_landblock_resident`]). A building's
    /// footprint overruns at most an adjacent cell, so the clamped rectangle stays
    /// tiny. A static straddling a LANDBLOCK boundary is the carried cross-landblock
    /// case (plan §8): home-landblock clamping keeps the index idempotent and
    /// leak-free (every entry is keyed within this landblock, so [`Self::clear_outdoor_static_overlap_for_landblock`]
    /// / [`Self::clear_cells_for_landblock`] remove ALL of it on rebake/unload — a
    /// full AABB rectangle spilling into a neighbor landblock would orphan phantom
    /// entries on this landblock's unload since they'd be keyed in the neighbor),
    /// and the faithful ring (`add_all_outside_cells_sphere`) still floods this
    /// landblock's boundary cell — where the static IS registered — when a player
    /// approaches across the boundary from the resident neighbor.
    ///
    /// Idempotent: clears this landblock's prior OUTDOOR per-cell static entries
    /// (full cell ids whose low word is an outdoor `1..=64`) before re-registering;
    /// INDOOR per-cell statics (low word `>= 0x100`, the Phase C feed) are left
    /// untouched. Returns the number of `(cell, static)` registrations made.
    pub fn bake_outdoor_static_overlap_for_landblock(
        &mut self,
        landblock_high: u32,
        overlap_enabled: bool,
    ) -> usize {
        let lb_high = landblock_high & 0xFFFF_0000;
        // Idempotency: drop this landblock's prior OUTDOOR per-cell entries so a
        // re-bake (the live STATIC_BSP_PENDING drain runs per landblock load)
        // never double-registers.
        self.clear_outdoor_static_overlap_for_landblock(lb_high);

        // Never register into a non-resident landblock (loading-virus bound). The
        // home landblock must be resident (its terrain heights loaded) for the
        // faithful ring to ever route a mover here at all.
        if !self.terrain_landblock_resident(lb_high) {
            return 0;
        }
        // Snapshot the source statics (clone the Arc'd Vec) to release the shared
        // borrow before the per-cell `Arc::make_mut` insert.
        let statics = match self.statics_physics_bsp.get(&lb_high) {
            Some(v) => v.clone(),
            None => return 0,
        };
        if statics.is_empty() {
            return 0;
        }

        // This landblock's GLOBAL land-cell range: blockX*8 ..= blockX*8+7
        // (BlockSide = 8 cells/landblock). The overlap rectangle is clamped to
        // this so the bake stays inside the resident landblock.
        let block_x = ((lb_high >> 24) & 0xFF) as i32;
        let block_y = ((lb_high >> 16) & 0xFF) as i32;
        let (lb_min_x, lb_max_x) = (block_x * 8, block_x * 8 + 7);
        let (lb_min_y, lb_max_y) = (block_y * 8, block_y * 8 + 7);

        let mut registrations = 0usize;
        for bsp in &statics {
            let aabb = bsp.world_aabb();
            if aabb.is_empty() {
                continue;
            }
            // The [min..=max] land-cell rectangle (or, when overlap is off, the
            // single home cell from the AABB centre). `floor(world / 24)` is the
            // global landcell index (same conversion as the ring's per-sphere
            // `floor(point/24)`); `lcoord_to_cellid` packs it back to a full id.
            let (min_gx, max_gx, min_gy, max_gy) = if overlap_enabled {
                (
                    (aabb.min.x / CELL_SIZE).floor() as i32,
                    (aabb.max.x / CELL_SIZE).floor() as i32,
                    (aabb.min.y / CELL_SIZE).floor() as i32,
                    (aabb.max.y / CELL_SIZE).floor() as i32,
                )
            } else {
                let c = aabb.center();
                let gx = (c.x / CELL_SIZE).floor() as i32;
                let gy = (c.y / CELL_SIZE).floor() as i32;
                (gx, gx, gy, gy)
            };
            // Clamp to this landblock's cell grid (loading-virus bound).
            let min_gx = min_gx.max(lb_min_x);
            let max_gx = max_gx.min(lb_max_x);
            let min_gy = min_gy.max(lb_min_y);
            let max_gy = max_gy.min(lb_max_y);

            let mut gx = min_gx;
            while gx <= max_gx {
                let mut gy = min_gy;
                while gy <= max_gy {
                    let cell_id = lcoord_to_cellid(gx, gy);
                    // Residency gate (always true after the home-landblock clamp,
                    // but kept as the explicit loading-virus guard the plan calls
                    // for so the rule survives any future clamp change).
                    if self.terrain_landblock_resident(cell_id) {
                        Arc::make_mut(&mut self.cell_static_physics_bsp)
                            .entry(cell_id)
                            .or_default()
                            .push(bsp.clone());
                        registrations += 1;
                    }
                    gy += 1;
                }
                gx += 1;
            }
        }
        registrations
    }

    /// Phase D / WS7: drop this landblock's OUTDOOR per-cell static overlap
    /// entries from [`Self::cell_static_physics_bsp`] — full cell ids in this
    /// landblock whose low word is an outdoor cell index (`1..=64`). INDOOR
    /// per-cell statics (low word `>= 0x100`, the Phase C feed) are preserved, so
    /// a surface landblock that carries BOTH outdoor terrain statics and indoor
    /// env-cell statics keeps the latter. Called for idempotency at the head of
    /// [`Self::bake_outdoor_static_overlap_for_landblock`] (the broader
    /// [`Self::clear_cells_for_landblock`] also clears these on landblock unload).
    /// Returns the removed static count.
    pub fn clear_outdoor_static_overlap_for_landblock(&mut self, landblock_high: u32) -> usize {
        let lb_high = landblock_high & 0xFFFF_0000;
        let mut removed = 0usize;
        Arc::make_mut(&mut self.cell_static_physics_bsp).retain(|cell_id, v| {
            let low = cell_id & 0xFFFF;
            if (*cell_id & 0xFFFF_0000) == lb_high && (1..=64).contains(&low) {
                removed += v.len();
                false
            } else {
                true
            }
        });
        removed
    }

    /// Phase D / WS1: install a landblock's 9×9 terrain corner-height grid
    /// (`vx * 9 + vy` order — the same layout `WorldState::terrain_heights` /
    /// `terrain_height_at` use). `landblock_id` is normalized to the high-word
    /// key (`& 0xFFFF_0000`) so callers may pass either `0xXXYY0000` or any cell
    /// id in the landblock. Idempotent — a re-load overwrites. This is the
    /// residency signal the faithful outdoor ring keys on
    /// ([`Self::terrain_landblock_resident`]) and the corner source the
    /// terrain-triangle build (WS2/WS3) reads. Mirrors the Phase C BSP staging
    /// (fed by the wasm landblock-load path, WS8).
    pub fn populate_terrain_heights(&mut self, landblock_id: u32, heights: [f32; 81]) {
        Arc::make_mut(&mut self.terrain_heights).insert(landblock_id & 0xFFFF_0000, heights);
    }

    /// Phase D / WS1: drop a landblock's terrain heights on unload (parallel to
    /// `clear_*_for_landblock`). Returns `true` if an entry was removed.
    pub fn clear_terrain_heights_for_landblock(&mut self, landblock_id: u32) -> bool {
        Arc::make_mut(&mut self.terrain_heights)
            .remove(&(landblock_id & 0xFFFF_0000))
            .is_some()
    }

    /// Phase D / WS1: is the landblock containing `cell_id` resident (terrain
    /// heights loaded)? `LScape::get_landcell` returns a live outdoor cell only
    /// when its landblock is loaded; the faithful ring still adds a NULL entry on
    /// a non-resident lookup (`add_outside_cell`, objcell.rs:553).
    pub fn terrain_landblock_resident(&self, cell_id: u32) -> bool {
        self.terrain_heights.contains_key(&(cell_id & 0xFFFF_0000))
    }

    /// Phase D / WS1: the 9×9 corner-height grid for `cell_id`'s landblock, or
    /// `None` when the landblock isn't resident. The corner source the
    /// terrain-triangle build (WS2/WS3) and the outdoor cell AABB read.
    pub fn terrain_cell_heights(&self, cell_id: u32) -> Option<&[f32; 81]> {
        self.terrain_heights.get(&(cell_id & 0xFFFF_0000))
    }

    /// Phase D / WS1: count of resident terrain landblocks. Diagnostic / tests.
    pub fn terrain_heights_count(&self) -> usize {
        self.terrain_heights.len()
    }

    /// Phase E3.6: stage a landblock's 9×9 terrain TYPE codes (`vx*9+vy` order,
    /// `(terrain>>2)&0x1F`) for the faithful outdoor water classifier. Mirrors
    /// [`Self::populate_terrain_heights`]; the wasm feed passes the same
    /// `terrain_codes` array it already computes for the render heightmap.
    pub fn populate_terrain_water_codes(&mut self, landblock_id: u32, codes: [u8; 81]) {
        Arc::make_mut(&mut self.terrain_water_codes).insert(landblock_id & 0xFFFF_0000, codes);
    }

    /// Phase E3.6: drop a landblock's terrain water codes on unload (parallel to
    /// [`Self::clear_terrain_heights_for_landblock`]). `true` if an entry existed.
    pub fn clear_terrain_water_codes_for_landblock(&mut self, landblock_id: u32) -> bool {
        Arc::make_mut(&mut self.terrain_water_codes)
            .remove(&(landblock_id & 0xFFFF_0000))
            .is_some()
    }

    /// Phase E3.6: the 9×9 terrain-type-code grid for `cell_id`'s landblock, or
    /// `None` when the landblock isn't resident (⇒ the outdoor cell is NotWater).
    pub fn terrain_cell_water_codes(&self, cell_id: u32) -> Option<&[u8; 81]> {
        self.terrain_water_codes.get(&(cell_id & 0xFFFF_0000))
    }

    /// Terrain→EnvCell entry (2026-06-02): register a cell-membership
    /// tree (`CellStruct.cell_bsp` + frame) for `cell_id`. Drained from
    /// the wasm bundle's `CELL_MEMBERSHIP_PENDING` pile each TickMovement,
    /// the same cadence as the physics-BSP drain.
    pub fn insert_cell_membership(&mut self, cell_id: u32, membership: CellMembership) {
        Arc::make_mut(&mut self.cell_membership).insert(cell_id, membership);
    }

    /// Count of cells with a registered membership tree. Diagnostic only.
    pub fn cell_membership_count(&self) -> usize {
        self.cell_membership.len()
    }

    /// The precise cell-membership BSP (`CellStruct.cell_bsp`) for `cell_id`, if
    /// resident. Phase E3.2: drives `SceneObjCell::point_in_cell` (replacing the
    /// looser AABB) so `find_cell_list` re-seats `check_cell` precisely across
    /// portal boundaries.
    pub fn cell_membership(&self, cell_id: u32) -> Option<&CellMembership> {
        self.cell_membership.get(&cell_id)
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
        for (&cell_id, aabb) in self.cell_aabbs.iter() {
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
        for (&cell_id, aabb) in self.cell_aabbs.iter() {
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

    /// Does this cell carry at least one outdoor-exit portal edge? True
    /// when any neighbour in `cell_portal_graph` has the AC outdoor-exit
    /// sentinel in its low 16 bits (`>= 0xFFFE`, typically `0xFFFF`).
    /// This is the same predicate `compute_visibility_with_frustum`'s
    /// outdoor path uses to decide a cell is reachable from outside — a
    /// building's ground-floor exit room qualifies; an attic reachable
    /// only through interior portals does not. The B11 exit machinery
    /// uses it to relax the cell-AABB containment net at a building's
    /// doorway (see `movement/system.rs`).
    pub fn cell_has_outdoor_exit(&self, cell_id: u32) -> bool {
        self.cell_portal_graph
            .get(&cell_id)
            .map(|edges| edges.iter().any(|&n| (n & 0xFFFF) >= 0xFFFE))
            .unwrap_or(false)
    }

    /// Interior twin of [`Self::cell_has_outdoor_exit`] (2026-06-15): true
    /// when the player at `pose` is straddling an INTERIOR room-to-room
    /// doorway of `cell_id`. Used by the movement system to relax the
    /// cell-AABB containment net (`clamp_delta_to_cell_interior`) at interior
    /// doorways too — otherwise a multi-cell building (e.g. a Holtburg
    /// cottage: cell 0xA9B40101 has only interior portals, no outdoor exit)
    /// boxes the player at the current room's AABB face = an invisible wall
    /// between rooms.
    ///
    /// A portal neighbour qualifies only when ALL hold:
    ///   (a) it is NOT an outdoor-exit sentinel (`< 0xFFFE`);
    ///   (b) it is a currently-LOADED EnvCell (present in `cell_aabbs`) — a
    ///       room we can actually cross into;
    ///   (c) the capsule centre is within `radius` of that neighbour's AABB —
    ///       i.e. we are physically AT the shared doorway.
    ///
    /// The geometric near-test (c) is the load-bearing safety differentiator
    /// from a naive "any portal edge" check: `cell_portal_graph` MERGES true
    /// portal-direct edges with `visible_cells[]` PVS edges (see
    /// `insert_cell_portal`), so a bare edge does NOT prove a walkable
    /// doorway. Requiring a loaded neighbour AABB within a capsule radius
    /// restricts the relaxation to the doorway straddle — the only place the
    /// AABB net would wrongly box the player — and the per-poly cell-wall
    /// clamp remains the wall backstop everywhere.
    pub fn at_interior_doorway(&self, pose: &WorldPosition, cell_id: u32, radius: f32) -> bool {
        let lb_high = cell_id & 0xFFFF_0000;
        let global = pose.global_coords();
        self.cell_portal_graph
            .get(&cell_id)
            .map(|edges| {
                edges.iter().any(|&n| {
                    (n & 0xFFFF) < 0xFFFE
                        && (n & 0xFFFF_0000) == lb_high
                        && n != cell_id
                        && self
                            .cell_aabbs
                            .get(&n)
                            .map(|aabb| {
                                !aabb.is_empty()
                                    && global.x >= aabb.min.x - radius
                                    && global.x <= aabb.max.x + radius
                                    && global.y >= aabb.min.y - radius
                                    && global.y <= aabb.max.y + radius
                                    && global.z >= aabb.min.z - radius
                                    && global.z <= aabb.max.z + radius
                            })
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    /// EnvCell→terrain EXIT (B11, 2026-06-09): the inverse of
    /// [`Self::entered_envcell_for_outdoor_pose`]. When the player's
    /// predicted pose is flagged INDOOR but the capsule has left the
    /// current EnvCell's hull AND every portal-connected indoor
    /// neighbour, return the outdoor LandCell id the global XY falls in
    /// so the caller can flip `landblock_id` back to outdoor and re-
    /// engage the outdoor collision path THIS tick.
    ///
    /// Why this exists: the entry flip latches `is_indoors()` the moment
    /// the capsule reaches a cottage/mansion hull, but nothing ever
    /// re-derives the cell membership on the way out. Once latched, the
    /// indoor `clamp_delta_to_cell_interior` net boxes the capsule centre
    /// inside the cell AABB forever — you can walk INTO a house but the
    /// doorway becomes an invisible wall on the way OUT (the B11 bug).
    /// Retail `check_building_transit` re-evaluates membership from
    /// geometry every tick in BOTH directions; this restores the exit
    /// half so entry and exit are symmetric.
    ///
    /// Broad+narrow phase mirror the entry test, run in reverse:
    ///   - broad: still within the current cell's radius-padded AABB?
    ///   - narrow: the current cell's `cell_membership` BSP, plus a
    ///     bounded BFS over `cell_portal_graph` indoor neighbours
    ///     (foyer-chain mansions hold several interior cells — you only
    ///     exit once you've left ALL of them). Outdoor-exit sentinel
    ///     edges (`>= 0xFFFE`) are NOT followed: they ARE the outdoors.
    ///
    /// Guard: returns `None` when the current cell has no
    /// `cell_membership` entry (indoor geometry not baked yet) so a
    /// half-loaded cell never spuriously ejects the player mid-room. The
    /// BFS is capped at [`EXIT_INDOOR_BFS_MAX_CELLS`] cells; on overflow
    /// it returns `None` (stay indoors) rather than risk ejecting from a
    /// pathologically large structure. `radius` MUST match the capsule
    /// radius the entry test + indoor wall-clamp use so entry and exit
    /// engage at the same distance.
    ///
    /// The returned id shares the current landblock high word and is
    /// derived purely from the (landblock-local) `coords`, so
    /// `global_coords()` is preserved across the flip — no teleport.
    pub fn exited_envcell_to_outdoor(
        &self,
        pos: &WorldPosition,
        radius: f32,
    ) -> Option<u32> {
        if pos.landblock_id == Guid::NULL || !pos.is_indoors() {
            return None;
        }
        let current = self.current_cell(pos);
        // Don't eject from a cell whose membership geometry hasn't baked.
        if !self.cell_membership.contains_key(&current) {
            return None;
        }
        let global = pos.global_coords();
        // Is the capsule still inside `cell_id`? Broad-phase AABB reject
        // first (cheap), then the membership BSP (or unpadded-AABB
        // fallback when a cell has no parsed `cell_bsp`) — identical
        // verdict logic to `entered_envcell_for_outdoor_pose`.
        let still_inside = |cell_id: u32| -> bool {
            if let Some(aabb) = self.cell_aabbs.get(&cell_id) {
                if !aabb.is_empty()
                    && (global.x < aabb.min.x - radius
                        || global.x > aabb.max.x + radius
                        || global.y < aabb.min.y - radius
                        || global.y > aabb.max.y + radius
                        || global.z < aabb.min.z - radius
                        || global.z > aabb.max.z + radius)
                {
                    return false;
                }
            }
            match self.cell_membership.get(&cell_id) {
                Some(m) => {
                    let local = m.world_to_local(global);
                    m.tree.sphere_intersects_cell(&local, radius)
                        != holtburger_dat::physics::CellBound::Outside
                }
                None => match self.cell_aabbs.get(&cell_id) {
                    Some(aabb) if !aabb.is_empty() => {
                        global.x >= aabb.min.x
                            && global.x <= aabb.max.x
                            && global.y >= aabb.min.y
                            && global.y <= aabb.max.y
                            && global.z >= aabb.min.z
                            && global.z <= aabb.max.z
                    }
                    _ => false,
                },
            }
        };
        // Still in the current cell ⇒ no exit.
        if still_inside(current) {
            return None;
        }
        // BFS the indoor portal neighbours. If the capsule is inside any
        // reachable indoor cell, we merely crossed an interior portal —
        // stay indoors (entry/`current_cell` own which cell). Skip
        // outdoor-exit sentinels; cap the walk to protect against huge /
        // malformed graphs (return None = stay indoors on overflow).
        let mut visited: HashSet<u32> = HashSet::new();
        visited.insert(current);
        let mut frontier: VecDeque<u32> = VecDeque::new();
        frontier.push_back(current);
        while let Some(cell_id) = frontier.pop_front() {
            let neighbours = match self.cell_portal_graph.get(&cell_id) {
                Some(n) => n,
                None => continue,
            };
            for &neighbour in neighbours {
                // The sentinel IS the outdoors — not an indoor cell to test.
                if (neighbour & 0xFFFF) >= 0xFFFE {
                    continue;
                }
                if !visited.insert(neighbour) {
                    continue;
                }
                if visited.len() > EXIT_INDOOR_BFS_MAX_CELLS {
                    return None;
                }
                if still_inside(neighbour) {
                    return None;
                }
                frontier.push_back(neighbour);
            }
        }
        // Outside the current cell and every indoor neighbour ⇒ exited.
        // Clear the cell low-word to make the pose outdoor, then re-derive
        // the 1-64 terrain-cell index from `coords`. High word + coords
        // are unchanged ⇒ `global_coords()` is preserved across the flip.
        let outdoor = WorldPosition {
            landblock_id: Guid(pos.landblock_id.0 & 0xFFFF_0000),
            coords: pos.coords,
            rotation: pos.rotation,
        };
        Some(outdoor.normalize_outdoor_cell().landblock_id.0)
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
            for (&cell, aabb) in self.cell_aabbs.iter() {
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
        Arc::make_mut(&mut self.statics_aabb_index)
            .entry(landblock_high)
            .or_default()
            .push(entry);
    }

    /// Workstream C: drop every static-AABB entry for the given
    /// landblock. Called when the LB unloads (mirror of
    /// `clear_building_aabbs_for_landblock`). Returns the count of
    /// removed entries for diagnostic logging.
    pub fn clear_static_aabbs_for_landblock(&mut self, landblock_high: u32) -> usize {
        match Arc::make_mut(&mut self.statics_aabb_index).remove(&landblock_high) {
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

    /// B4 Tier-2 (2026-06-09): register a precise physics BSP for one
    /// outdoor static placement under `landblock_high`. Drained from the
    /// wasm bundle's `STATIC_BSP_PENDING` pile each TickMovement, the same
    /// cadence as the static-AABB drain. Append-only; the per-landblock
    /// clear on unload keeps it bounded.
    pub fn insert_static_physics_bsp(&mut self, landblock_high: u32, bsp: CellPhysicsBsp) {
        Arc::make_mut(&mut self.statics_physics_bsp)
            .entry(landblock_high)
            .or_default()
            .push(bsp);
    }

    /// B4 Tier-2: drop every static physics BSP for `landblock_high`
    /// (mirror of `clear_static_aabbs_for_landblock`). Returns the removed
    /// count for diagnostic logging.
    pub fn clear_static_physics_bsps_for_landblock(&mut self, landblock_high: u32) -> usize {
        match Arc::make_mut(&mut self.statics_physics_bsp).remove(&landblock_high) {
            Some(v) => v.len(),
            None => 0,
        }
    }

    /// B4 Tier-2: total registered static physics-BSP count. Diagnostic.
    pub fn static_physics_bsp_count(&self) -> usize {
        self.statics_physics_bsp.values().map(|v| v.len()).sum()
    }

    /// B4 Tier-2 (2026-06-09): push the player's two-sphere cylinder OUT
    /// of any outdoor static's precise physics BSP near `pose`. Iterates
    /// the pose landblock + its 3x3 neighbour ring (matching
    /// `statics_aabbs_near_pose`) and runs ACE `BSPTree.placement_insert`
    /// (`placement_insert_bsp`) per static; an `Adjusted` result
    /// contributes its WORLD-space displacement, and the running centers
    /// advance so the next static sees the resolved position (handles a
    /// capsule wedged between two trunks). Returns the NET world
    /// displacement, or `None` when nothing adjusted (no BSP near, or the
    /// capsule is already clear) so the caller leaves the delta untouched.
    ///
    /// `world_sphere_centers` are GLOBAL-meter centers (same frame
    /// `cell_physics_bsp_placement` takes); `radius` the cylinder radius;
    /// `num_sphere` ACE's NumSphere (2 for the player). Push-out only — the
    /// swept time-of-collision stop (`BSPTree.find_collisions`) is the
    /// deferred Tier-2 follow-on, so this resolves penetration rather than
    /// stopping a fast move at the surface.
    pub fn resolve_static_bsp_pushout(
        &self,
        pose: &WorldPosition,
        world_sphere_centers: &[Vector3],
        radius: f32,
        num_sphere: u8,
    ) -> Option<Vector3> {
        let lb_high = pose.landblock_id.0 & 0xFFFF_0000;
        let lb_x = ((lb_high >> 24) & 0xFF) as i32;
        let lb_y = ((lb_high >> 16) & 0xFF) as i32;
        let n = (num_sphere as usize).min(2).min(world_sphere_centers.len());
        if n == 0 {
            return None;
        }
        // Running world-space centers, advanced after each adjust.
        let mut centers = [Vector3::zero(); 2];
        centers[..n].copy_from_slice(&world_sphere_centers[..n]);
        let mut total = Vector3::zero();
        for dx in -1i32..=1 {
            for dy in -1i32..=1 {
                let nx = lb_x + dx;
                let ny = lb_y + dy;
                if !(0..256).contains(&nx) || !(0..256).contains(&ny) {
                    continue;
                }
                let key = ((nx as u32) << 24) | ((ny as u32) << 16);
                let Some(bsps) = self.statics_physics_bsp.get(&key) else {
                    continue;
                };
                for bsp in bsps {
                    let mut local = [holtburger_common::Sphere {
                        center: Vector3::zero(),
                        radius: 0.0,
                    }; 2];
                    for i in 0..n {
                        local[i] = holtburger_common::Sphere {
                            center: bsp.world_to_local(centers[i]),
                            radius,
                        };
                    }
                    let probe =
                        bsp.tree.placement_insert_bsp(&local, num_sphere, true, &bsp.polys);
                    if let holtburger_dat::physics::PlacementState::Adjusted = probe.state {
                        let world_disp =
                            bsp.orientation.rotate_vector(probe.local_displacement);
                        total = total + world_disp;
                        for c in centers.iter_mut().take(n) {
                            *c = *c + world_disp;
                        }
                    }
                }
            }
        }
        if total.length_squared() < 1e-12 {
            None
        } else {
            Some(total)
        }
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
        Arc::make_mut(&mut self.building_physics_index)
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
        self.reconcile_authoritative_body_with_remote(
            body_id, pose, velocity, omega, sync, now, None,
        );
    }

    /// A2-P2 (2026-06-12, W3+ S8): [`Self::reconcile_authoritative_body`]
    /// with the optional remote wire context. With `remote = None`, the
    /// flag off, or a non-`Entity` body this is byte-identical to the
    /// pre-P2 reconcile; otherwise the retail remote `MoveOrTeleport`
    /// lattice (acclient.c:323451-323498) decides between hard-snap,
    /// leave-untouched (`!contact`), far-snap (≥ 96 m) and
    /// `InterpolateTo` + `ConstrainTo`.
    #[allow(clippy::too_many_arguments)]
    pub fn reconcile_authoritative_body_with_remote(
        &mut self,
        body_id: SpatialBodyId,
        pose: WorldPosition,
        velocity: Vector3,
        omega: Vector3,
        sync: AuthoritativeBodySync,
        now: Instant,
        remote: Option<RemoteCorrectionCtx>,
    ) {
        let mode = match sync {
            AuthoritativeBodySync::Snapshot => SpatialSampleMode::AuthoritativeOnly,
            // ForceBlip shares Reset's suspend-then-recover shape (the
            // next accepted echo un-suspends via the Snapshot arm); the
            // leash-mode difference is heading/constraint/velocity below.
            AuthoritativeBodySync::Reset | AuthoritativeBodySync::ForceBlip => {
                SpatialSampleMode::Suspended
            }
        };

        let mut body = self.body_store.remove_body(body_id);
        let body_existed = body.is_some();
        let mut body = body
            .take()
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
            if self.local_retail_leash {
                // Physics-parity 2026-07-03 (dossier A F14 / B row 58) —
                // the retail `HandleReceivedPosition` ROUTINE arm
                // (acclient.c:145209-145218): `ConstrainTo` the event
                // position on EVERY accepted echo (the leash re-arms and
                // re-seeds each time and stays armed between echoes);
                // `InterpolateTo` ONLY when the command interpreter is
                // server-controlled AND the player has contact — retail
                // never interp-pulls an autonomous walking player toward
                // its own echoes (the reconcile-oscillation source the
                // JS predictedPlayerPos layer papered over).
                let indoor = pose.is_indoors();
                let leash_start = if indoor {
                    CONSTRAINT_LEASH_INDOOR_M
                } else {
                    CONSTRAINT_LEASH_OUTDOOR_M
                };
                let leash_max = if indoor {
                    CONSTRAINT_MAX_INDOOR_M
                } else {
                    CONSTRAINT_MAX_OUTDOOR_M
                };
                let distance = body.pose.distance_to(&pose);
                body.position_manager.set_retail_leash(true);
                body.position_manager
                    .remote_constrain_to(distance, leash_start, leash_max);
                // `Unknown` (pre-solve) counts as contact, the remote
                // lane's S8 OPEN Q6 convention.
                let has_contact = body.contact.grounded().unwrap_or(true);
                if self.local_server_controlled && has_contact {
                    let blip = if indoor {
                        BLIP_SNAP_DISTANCE_INDOOR_M
                    } else {
                        BLIP_SNAP_DISTANCE_OUTDOOR_M
                    };
                    // `keep_heading = true` pending the retail
                    // `cmdinterp->vfptr[15]` resolution (dossier open
                    // question). A beyond-blip target QUEUES with
                    // `node_fail_counter = 4` and the next drain blips
                    // it (acclient.c:389140-389172) — no scene-side
                    // `stop()` pre-gate in leash mode.
                    body.position_manager
                        .remote_interpolate_to(body.pose, pose, true, blip);
                }
            } else if USE_RETAIL_INTERPOLATE {
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
                let leash_max = if indoor {
                    CONSTRAINT_MAX_INDOOR_M
                } else {
                    CONSTRAINT_MAX_OUTDOOR_M
                };
                let distance = body.pose.distance_to(&pose);
                if distance > blip {
                    body.position_manager.stop();
                } else {
                    // `keep_heading = true`: the integrator owns heading
                    // and the forced rotation is recorded in
                    // `authoritative_pose` above. `start = leash`
                    // (`GetStartConstraintDistance` = 10 outdoor / 5
                    // indoor), `max = leash_max`
                    // (`GetMaxConstraintDistance` = 50 outdoor / 20 indoor)
                    // for the player. The `if distance > blip` gate above
                    // still uses the autonomy-blip radius (100/25) — that
                    // is the academy-rubberband cutoff, NOT the leash cap.
                    body.position_manager.install_force_position(
                        body.pose, pose, leash_start, leash_max, true,
                    );
                }
            } else if USE_LOCAL_FORCE_POSITION_CONSTRAINT {
                body.pose = constrain_local_pose_toward(body.pose, pose);
            }
        } else if self.remote_interp_enabled && matches!(body_id, SpatialBodyId::Entity(_)) {
            // A2-P2 (2026-06-12, W3+ S8): the retail remote
            // `MoveOrTeleport` lattice (acclient.c:323451-323498). The
            // flag-off path is the `else` arm below, byte-identical.
            // `sampling.mode` is written in every arm (the manager
            // mutates `body.pose` directly, like the local path; the
            // solver's projection-basis law, tick_spine.rs, is
            // untouched).
            if let Some(ctx) = remote {
                if let Some(contact) = ctx.contact {
                    body.last_wire_contact = Some(contact);
                }
                let teleport_advanced = matches!(sync, AuthoritativeBodySync::Reset);
                if teleport_advanced || !body_existed {
                    // Teleport-stamp advance / no resolved prior pose →
                    // hard set (acclient.c:323469-323478).
                    body.position_manager.stop();
                    body.pose = pose;
                    body.sampling.mode = mode;
                } else if ctx.contact == Some(false) {
                    // `!contact` → return 0: working pose untouched, no
                    // constrain; entity bookkeeping (authoritative_pose,
                    // velocity, omega) already updated above
                    // (acclient.c:323480-323481).
                    body.sampling.mode = mode;
                } else {
                    let player_dist = ctx
                        .player_pose
                        .map(|player| body.pose.distance_to(&player))
                        .unwrap_or(f32::INFINITY);
                    if player_dist >= REMOTE_INTERP_PLAYER_RADIUS_M {
                        // Far object: StopInterpolating + SetPositionSimple
                        // (acclient.c:323483-323489); `None` player → snap.
                        body.position_manager.stop();
                        body.pose = pose;
                        body.sampling.mode = mode;
                    } else {
                        // Near + contact: InterpolateTo with the NON-player
                        // blip radius (20/100, acclient.c:315872-315878),
                        // then ConstrainTo anchored on the object's OWN
                        // post-move position (acclient.c:145223-145227)
                        // with the shared start/max constants
                        // (acclient.c:315885-315929). `keep_heading =
                        // false` this stage — remote entities run no
                        // client-side MoveTo yet (S8 OPEN Q4).
                        let indoor = pose.is_indoors();
                        let blip = if indoor {
                            REMOTE_BLIP_INDOOR_M
                        } else {
                            REMOTE_BLIP_OUTDOOR_M
                        };
                        let queued = body
                            .position_manager
                            .remote_interpolate_to(body.pose, pose, false, blip);
                        if queued {
                            let start = if indoor {
                                CONSTRAINT_LEASH_INDOOR_M
                            } else {
                                CONSTRAINT_LEASH_OUTDOOR_M
                            };
                            let max = if indoor {
                                CONSTRAINT_MAX_INDOOR_M
                            } else {
                                CONSTRAINT_MAX_OUTDOOR_M
                            };
                            // Anchored on the object's own pose: the
                            // running offset starts at zero (retail
                            // constrains to `object->m_position`).
                            body.position_manager.remote_constrain_to(0.0, start, max);
                        }
                        body.sampling.mode = mode;
                    }
                }
            } else if body.position_manager.queue_active() {
                // Ctx-less reconcile (VectorUpdate / bookkeeping paths)
                // while the remote manager owns the working pose: update
                // everything EXCEPT `body.pose` — retail's
                // `DoVectorUpdate` sets velocity without relocating the
                // object (acclient.c:143459-143480), and the legacy
                // snap-to-`entity.position` here would stomp the eased
                // pose every vector frame. Documented S8 deviation;
                // unreachable with the flag off.
                body.sampling.mode = mode;
            } else {
                body.pose = pose;
                body.sampling.mode = mode;
            }
        } else {
            let mut pose = pose;
            if self.local_retail_leash && matches!(body_id, SpatialBodyId::LocalPlayer(_)) {
                match sync {
                    AuthoritativeBodySync::Reset => {
                        // Physics-parity 2026-07-03 (dossier A F14d) — the
                        // retail TELEPORT arm (acclient.c:145196-145207):
                        // TeleportPlayer, `ConstrainTo` the arrival position
                        // (seed 0 — the pose adopts the arrival below),
                        // `set_velocity(0)`. `stop()` first: a teleport
                        // clears pending interpolation before the re-arm.
                        let indoor = pose.is_indoors();
                        let leash_start = if indoor {
                            CONSTRAINT_LEASH_INDOOR_M
                        } else {
                            CONSTRAINT_LEASH_OUTDOOR_M
                        };
                        let leash_max = if indoor {
                            CONSTRAINT_MAX_INDOOR_M
                        } else {
                            CONSTRAINT_MAX_OUTDOOR_M
                        };
                        body.position_manager.stop();
                        body.position_manager.set_retail_leash(true);
                        body.position_manager
                            .remote_constrain_to(0.0, leash_start, leash_max);
                        body.velocity = Vector3::zero();
                    }
                    AuthoritativeBodySync::ForceBlip => {
                        // FU4 — the retail FORCE arm
                        // (acclient.c:145236-145243): `set_heading(pos,
                        // get_heading(player))` BEFORE `BlipPlayer` — the
                        // hard snap KEEPS the player's own heading; NO
                        // `ConstrainTo`, NO velocity zeroing (the wire
                        // velocity assigned above stands). Pending interp
                        // still clears (a blip replaces the working pose).
                        body.position_manager.stop();
                        body.position_manager.set_retail_leash(true);
                        pose = WorldPosition {
                            rotation: body.pose.rotation,
                            ..pose
                        };
                    }
                    AuthoritativeBodySync::Snapshot => {}
                }
            }
            body.pose = pose;
            body.sampling.mode = mode;
        }

        self.body_store.register_body(body);
    }

    /// A2-P2 (2026-06-12, W3+ S8) — per-slice remote manager step: the
    /// retail `PositionManager::UseTime` + `adjust_offset` slot that
    /// `CPhysicsObj::update_object` runs after MovementManager/PartArray
    /// (acclient.c:322884-322886, 320029-320032), brought to every
    /// remote `Entity` body with an active node queue. `quantum` is one
    /// solver slice (≤ MAX_QUANTUM). `max_speed` is passed as `0.0` →
    /// the manager floors to `MAX_INTERPOLATED_VELOCITY` (7.5 m/s,
    /// acclient.c:389239-389240; S8 OPEN Q5 — no Rust-side per-entity
    /// motion speed yet). Contact gates per the body's last wire flag
    /// (`None` → contact, S8 OPEN Q6). Stepped poses land in the
    /// [`Self::take_remote_stepped_poses`] ledger for the JS export.
    /// Flag off (default) = zero work, byte-identical.
    pub fn step_remote_position_managers(&mut self, quantum: f32) {
        if !self.remote_interp_enabled {
            return;
        }
        // A2-P3 R2: resolve every sticky target's live pose BEFORE the
        // mutable body walk (the per-slice refresh that replaces
        // retail's TargetManager update stream for remotes — same
        // explicit-feed deviation the local lane documents on
        // `stick_local_player_to`, taken one step further: re-resolved
        // every slice so a moving target — usually the LOCAL player,
        // the F3-4 kiting case — is tracked at full rate). Empty (zero
        // work) unless `?stickyRetail=on` armed the switch AND a sticky
        // install landed.
        let sticky_feeds: HashMap<Guid, (Guid, Option<WorldPosition>)> =
            if self.remote_sticky_enabled && !self.remote_sticky_targets.is_empty() {
                self.remote_sticky_targets
                    .iter()
                    .map(|(&holder, &target)| {
                        (
                            holder,
                            (target, self.resolve_remote_sticky_target_pose(target)),
                        )
                    })
                    .collect()
            } else {
                HashMap::new()
            };
        for body in self.body_store.bodies.values_mut() {
            let SpatialBodyId::Entity(guid) = body.id else {
                continue;
            };
            let mut stepped = false;
            if body.position_manager.queue_active() {
                let on_contact = body.last_wire_contact.unwrap_or(true);
                let (outcome, commands) =
                    body.position_manager
                        .step_remote(body.pose, quantum, 0.0, on_contact);
                // Apply the drain's physics side effects (retail UseTime
                // calls SetPositionSimple/set_velocity directly,
                // acclient.c:389320-389368).
                for command in commands {
                    match command {
                        InterpolationCommand::SetPosition(pos) => body.pose = pos,
                        InterpolationCommand::SetVelocity(v) => body.velocity = v,
                    }
                }
                match outcome {
                    InterpStep::Progressed { pose } | InterpStep::Completed { pose } => {
                        body.pose = pose;
                    }
                    // Failed leaves the working pose; the queue recovers via
                    // the next drain's blipto. Idle: nothing stepped.
                    InterpStep::Failed { .. } | InterpStep::Idle => {}
                }
                stepped = true;
            }
            // A2-P3 R2 — the REMOTE sticky slice, AFTER the interp/
            // constraint drain on the same working pose (chain shape
            // matches the landed LOCAL lane: sticky applied to the
            // already-interp-stepped pose; retail orders interp →
            // sticky → constraint, acclient.c:388287-388304 — the
            // constraint-after-sticky half is the same documented
            // deviation as Stage L3). No contact gate — retail sticky
            // has none (acclient.c:388519-388601).
            if let Some(&(target, feed)) = sticky_feeds.get(&guid) {
                // Lazy install: the wire install may have arrived
                // before this body existed (KIND_MOTION before the
                // first routed UpdatePosition) — arm the manager the
                // first slice the body is steppable.
                if body.position_manager.sticky_object_id() != Some(target) {
                    body.position_manager.stick_to(target, 0.0);
                }
                if let Some(pose) = feed {
                    body.position_manager.sticky_handle_update_target(target, pose);
                }
                if body.position_manager.sticky_use_time(quantum) {
                    // Retail 1.0 s timeout (acclient.c:388605-388620) —
                    // THE F3-4 "glued mob never times out" closer. The
                    // manager already cleared itself; drop the index
                    // entry so no re-install fires.
                    self.remote_sticky_targets.remove(&guid);
                } else if let Some(pose) = body.position_manager.step_sticky_pose(
                    body.pose, /* my_radius (OPEN Q3 fallback) */ 0.0,
                    /* max_speed → retail floor 15.0 */ 0.0, quantum,
                ) {
                    body.pose = pose;
                    self.remote_sticky_stepped.insert(guid);
                    stepped = true;
                }
            }
            if stepped {
                self.remote_stepped_poses.insert(guid, body.pose);
            }
        }
    }

    /// A2-P3 R2 — best-known live pose for a REMOTE sticky target:
    /// the target's own managed body (`Entity` — the freshest, the
    /// interp/sticky-stepped working pose), the LOCAL player's body
    /// (mob-glued-to-player is THE F3-4 case), then the wire-fed
    /// `entity_poses` stash. `None` ⇒ the holder's sticky no-ops this
    /// slice (retail `Initialized == false` semantics,
    /// acclient.c:388691-388720).
    fn resolve_remote_sticky_target_pose(&self, target: Guid) -> Option<WorldPosition> {
        if let Some(body) = self.body_store.body(SpatialBodyId::Entity(target)) {
            return Some(body.pose);
        }
        if let Some(body) = self.body_store.body(SpatialBodyId::LocalPlayer(target)) {
            return Some(body.pose);
        }
        self.entity_poses.get(&target).copied()
    }

    /// A2-P3 R2 — `CPhysicsObj::stick_to_object` for a REMOTE entity
    /// (`?stickyRetail=on`; retail sticks WHATEVER object the movement
    /// message addresses, acclient.c:339546-339560). Re-stick re-arms
    /// the 1.0 s timeout (retail `StickTo` replaces the prior target,
    /// acclient.c:388665-388690 — ACE re-sends the sticky bit on every
    /// chase MoveTo + melee swing, so a live chase keeps re-arming).
    /// Radius `0.0` fallback per spec S9 OPEN Q3 (standoff degrades to
    /// the −0.3-clamped cylinder distance; no Rust-side per-entity
    /// physics radius yet). Inert unless the runtime switch is armed.
    pub fn stick_remote_entity_to(&mut self, holder: Guid, target: Guid) {
        if !self.remote_sticky_enabled {
            return;
        }
        self.remote_sticky_targets.insert(holder, target);
        let known_pose = self.resolve_remote_sticky_target_pose(target);
        if let Some(body) = self.body_store.body_mut(SpatialBodyId::Entity(holder)) {
            body.position_manager.stick_to(target, 0.0);
            if let Some(pose) = known_pose {
                body.position_manager.sticky_handle_update_target(target, pose);
            }
        }
        // No body yet → the index entry alone is kept; the per-slice
        // step lazy-installs once the body appears.
    }

    /// A2-P3 R2 — `unstick_from_object` for a REMOTE entity (retail
    /// per-unpack preamble subset, acclient.c:339518-339519: every
    /// fresh movement message without the sticky bit unsticks — the
    /// wasm KIND_MOTION arm sends `target = 0` through here).
    pub fn unstick_remote_entity(&mut self, holder: Guid) {
        if self.remote_sticky_targets.remove(&holder).is_none() {
            return;
        }
        if let Some(body) = self.body_store.body_mut(SpatialBodyId::Entity(holder)) {
            body.position_manager.unstick();
        }
    }

    /// A2-P3 R2 — a REMOTE entity's current sticky target (diag/tests).
    pub fn remote_sticky_target(&self, holder: Guid) -> Option<Guid> {
        self.remote_sticky_targets.get(&holder).copied()
    }

    // === A2-P3 (2026-06-12, W3+ S9) — LOCAL-player sticky surface. =======
    //
    // Gate-at-entry: every caller checks
    // [`crate::spatial::position_manager::USE_STICKY_MANAGER`] before
    // installing (`movement/system.rs` step/unstick, native
    // `client/simulation.rs` Invalid arm, wasm `lib.rs` UpdateMotion
    // arm), so with the const off `local_sticky_target` stays `None`
    // and every method here is an inert compare — byte-identical.

    /// The LOCAL player's spatial body, if registered.
    fn local_player_body_mut(&mut self) -> Option<&mut SpatialBody> {
        self.body_store
            .bodies
            .values_mut()
            .find(|body| matches!(body.id, SpatialBodyId::LocalPlayer(_)))
    }

    /// `CPhysicsObj::stick_to_object` for the LOCAL player
    /// (acclient.c:319725-319763 — retail resolves radius/height from
    /// the target's `CPartArray`, else `0.0`; we pass the caller's best
    /// radius, `0.0` fallback per spec S9 OPEN Q3) → `StickyManager::
    /// StickTo` (:388665-388690). Seeds the pose stash immediately when
    /// the target's pose is already known (`entity_poses`) — the
    /// explicit-feed replacement for retail's TargetManager
    /// registration (spec S9 §3 R1 step 2 deviation note).
    pub fn stick_local_player_to(&mut self, target: Guid, target_radius: f32) {
        let known_pose = self.entity_poses.get(&target).copied();
        if let Some(body) = self.local_player_body_mut() {
            body.position_manager.stick_to(target, target_radius);
            if let Some(pose) = known_pose {
                body.position_manager.sticky_handle_update_target(target, pose);
            }
            self.local_sticky_target = Some(target);
        }
    }

    /// `unstick_from_object` for the LOCAL player (retail unstick
    /// sites: `CMotionInterp::MotionDone` one-shot pop
    /// acclient.c:343659, the per-unpack preamble :339518-339519).
    /// Returns `true` when sticky was actually active — the ACE
    /// `ClearTarget → cancel_moveto` signal for the owner.
    pub fn unstick_local_player(&mut self) -> bool {
        if self.local_sticky_target.is_none() {
            return false;
        }
        self.local_sticky_target = None;
        self.local_player_body_mut()
            .map(|body| body.position_manager.unstick())
            .unwrap_or(false)
    }

    /// The LOCAL player's current sticky target (diag + feed routing).
    pub fn local_sticky_target(&self) -> Option<Guid> {
        self.local_sticky_target
    }

    /// A3-D3 driver (M4.1) — whether the LOCAL player's
    /// position-manager interpolation queue is active (retail
    /// `CPhysicsObj::IsInterpolating`, the MoveTo driver's
    /// stall-bookkeeping gate acclient.c:345657/:345770). `false` when
    /// no local body exists.
    pub fn local_player_is_interpolating(&self) -> bool {
        self.body_store
            .bodies
            .values()
            .find(|body| matches!(body.id, SpatialBodyId::LocalPlayer(_)))
            .map(|body| body.position_manager.is_interpolating())
            .unwrap_or(false)
    }

    /// Minimal TargetManager-subset pose feed (spec S9 §3 L1 step 4;
    /// retail `PositionManager::HandleUpdateTarget` →
    /// `StickyManager::HandleUpdateTarget`, acclient.c:388691-388720).
    /// Routed from [`Self::update_entity`] (native handlers) and the
    /// wasm `PublicUpdatePosition` arm. No-op unless `guid` IS the
    /// local sticky target.
    pub fn sticky_pose_feed(&mut self, guid: Guid, pose: WorldPosition) {
        if self.local_sticky_target != Some(guid) {
            return;
        }
        if let Some(body) = self.local_player_body_mut() {
            body.position_manager.sticky_handle_update_target(guid, pose);
        }
    }

    /// One per-frame LOCAL sticky slice: timeout tick (retail
    /// `PositionManager::UseTime` runs sticky's `UseTime` each frame,
    /// acclient.c:388283) then `adjust_offset` applied to the CURRENT
    /// working pose `current` (threaded by the caller — never the stale
    /// `body.pose`, spec S9 §3 L3 step 2; this is why the airborne
    /// integrator-freeze hazard does not apply). NO contact gate —
    /// retail sticky has none (acclient.c:388519-388601).
    pub fn step_local_sticky(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
    ) -> LocalStickyStep {
        if self.local_sticky_target.is_none() {
            return LocalStickyStep::Inactive;
        }
        let Some(body) = self
            .body_store
            .bodies
            .values_mut()
            .find(|body| matches!(body.id, SpatialBodyId::LocalPlayer(_)))
        else {
            return LocalStickyStep::Inactive;
        };
        if body.position_manager.sticky_use_time(quantum) {
            self.local_sticky_target = None;
            return LocalStickyStep::TimedOut;
        }
        // `my_radius = 0.0` fallback (acclient.c:319756-319763; spec S9
        // OPEN Q3 — no client-side physics-radius source located yet;
        // degrades the standoff toward `−0.3`-clamped, functional but
        // not size-aware).
        match body
            .position_manager
            .step_sticky_pose(current, 0.0, max_speed, quantum)
        {
            Some(pose) => LocalStickyStep::Stepped(pose),
            // Target pose not fed yet — retail-accurate `Initialized`
            // no-op (acclient.c:388691-388720).
            None => LocalStickyStep::Inactive,
        }
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
    /// happened) plus the drain's emitted commands — already applied to
    /// the BODY here; the state layer routes `SetVelocity` into the
    /// player's split velocity store for the local body
    /// (`WorldState::step_local_force_position`, dossier A F8).
    pub fn step_force_position_interpolation(
        &mut self,
        body_id: SpatialBodyId,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> (InterpStep, Vec<InterpolationCommand>) {
        if !USE_RETAIL_INTERPOLATE {
            return (InterpStep::Idle, Vec::new());
        }
        let Some(body) = self.body_store.body_mut(body_id) else {
            return (InterpStep::Idle, Vec::new());
        };
        if !body.position_manager.is_interpolating() {
            return (InterpStep::Idle, Vec::new());
        }
        let (outcome, commands) =
            body.position_manager
                .step_force_position(body.pose, quantum, max_speed, on_contact);
        // A2-P1: apply the queue drain's physics side effects (retail
        // `UseTime` calls SetPositionSimple/set_velocity directly,
        // acclient.c:389320-389368). Empty on the default-off legacy path.
        for command in &commands {
            match *command {
                InterpolationCommand::SetPosition(pos) => body.pose = pos,
                InterpolationCommand::SetVelocity(v) => body.velocity = v,
            }
        }
        match outcome {
            InterpStep::Progressed { pose } | InterpStep::Completed { pose } => {
                body.pose = pose;
            }
            // Failed leaves the working pose where it was (the queue path
            // recovers via the next drain's blipto); Idle is unreachable
            // here (we checked is_interpolating above).
            InterpStep::Failed { .. } | InterpStep::Idle => {}
        }
        (outcome, commands)
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
        // A2-P3: minimal TargetManager-subset feed — every native
        // entity-pose mutation site funnels through here
        // (state/mutations.rs, liveness.rs, types.rs callers), so the
        // local sticky target's live pose stays fed. One inert compare
        // when no sticky is active (always, with USE_STICKY_MANAGER off).
        self.sticky_pose_feed(guid, pose);
    }

    pub fn remove_entity(&mut self, guid: Guid, lb: Guid) {
        if let Some(set) = self.landblock_map.get_mut(&lb) {
            set.remove(&guid);
        }
        self.entity_poses.remove(&guid);
        // A2-P3 R2: drop a despawned holder's sticky index entry (a
        // body-less entry would otherwise linger — the 1.0 s timeout
        // only ticks on steppable bodies). A removed TARGET needs no
        // sweep: its holders just stop resolving a pose (retail
        // `Initialized` no-op) until their own timeout clears them.
        self.remote_sticky_targets.remove(&guid);
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
