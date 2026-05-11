use super::{
    AuthoritativeBodySync, BasicSpatialPhysics, BuildingAabbEntry, BuildingId, ContactState,
    RuntimeSpatialBodyView, SolvedBodyKinematics, SpatialBody, SpatialBodyId, SpatialPhysics,
    SpatialSampleMode, SpatialSamplingConfig, StaticAabbEntry,
    physics::sample_mode_for_projection_state,
};
use crate::entity::EntityMotionSnapshot;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Aabb, Guid, Triangle, Vector3};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use web_time::Instant;

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
    /// Phase 6 step E: door GUID → `(building_id, part_index)` lookup.
    /// JS-side door binding is by entity GUID (the ACE-broadcast `Door`
    /// weenie's full guid); the AABB index is keyed by per-part
    /// `(BuildingId, u8)` because the same door part may belong to a
    /// building shared by many cells. JS calls `register_door_part` once
    /// per spawned door (after matching the door's setup_id + part bbox
    /// against the building's AABB entries) so subsequent
    /// `set_door_aabb_active` calls only need the door GUID.
    door_part_index: HashMap<u64, (BuildingId, u8)>,
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
            door_part_index: HashMap::new(),
            building_origins: HashMap::new(),
            statics_aabb_index: HashMap::new(),
            building_physics_index: HashMap::new(),
        }
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
        (edges_removed, aabbs_removed)
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
        if !preserve_local_runtime_pose {
            body.pose = pose;
            body.sampling.mode = mode;
        }

        self.body_store.register_body(body);
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
