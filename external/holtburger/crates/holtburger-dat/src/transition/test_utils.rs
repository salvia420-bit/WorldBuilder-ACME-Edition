//! `transition::test_utils` — the SHARED synthetic-cell test harness for the
//! Phase-3 `CTransition` driver (agent A16), adapted to the REAL B2a foundation
//! trait [`super::objcell::CObjCell`] (not A16's stand-in). Test-only.
//!
//! ## What it gives the driver tests
//! 1. [`SynthEnvCell`] — a synthetic interior cell implementing the foundation
//!    `CObjCell` whose `find_collisions` runs the localspace cache then routes a
//!    REAL verdict through the committed Phase-2 resolver
//!    [`crate::transition::resolver_find::find_collisions`] (so codes 1/2/3/4 +
//!    contact normals are production-faithful, not mocked).
//! 2. [`scenes`] — the five required features as hand-verifiable quad geometry:
//!    flat floor, vertical wall, single step, cliff / drop-off, sloped ramp.
//! 3. [`SceneWorld`] — a [`super::objcell::CellWorld`] that resolves cell ids →
//!    handles so the spine (`transitional_insert` → `insert_into_cell` /
//!    `check_other_cells`) runs end-to-end against the synthetic cells.
//! 4. [`build`] — `CTransition`/`SpherePath`/`ObjectInfo` builders.
//!
//! Cross-landblock `LandDefs::get_block_offset` is NOT modeled (the synthetic
//! world is a single interior cell at an identity frame).

use std::collections::HashMap;
use std::rc::Rc;

use crate::physics::{BspLeaf, BspNode, ResolvedPolygon};
use crate::transition::frame_transform::Frame;
use crate::transition::objcell::{
    CObjCell, CellArrayApi, CellWorld, LandblockRef, PhysicsObjRef, WaterType,
};
use crate::transition::resolver_find::find_collisions as bsptree_find_collisions;
use crate::transition::types::{
    object_info_state, CTransition, InsertType, ObjectInfo, Position, SpherePath, FLOOR_Z,
    Z_FOR_LANDING,
};
use holtburger_common::{Plane, Sphere, Vector3};

#[inline]
pub fn v(x: f32, y: f32, z: f32) -> Vector3 {
    Vector3::new(x, y, z)
}

/// A climbable step rise (< a walker's `step_up_height`).
pub const STEP_H: f32 = 0.4;
/// A riser too tall to climb.
pub const TALL_STEP: f32 = 1.2;
/// A drop within a typical `step_down_height`.
pub const SHALLOW_DROP: f32 = 0.3;
/// A drop that exceeds any `step_down_height`.
pub const DEEP_DROP: f32 = 4.0;

/// An interior landcell id (low `u16 >= 0x100` ⇒ `find_cell_list` interior path).
pub const ENV_CELL_ID: u32 = 0x0001_0100;

// ─── Scene geometry ───────────────────────────────────────────────────────

/// A cell-local BSP scene: the resolver `root` node + the `poly_id →
/// ResolvedPolygon` table the leaf predicates resolve against.
#[derive(Debug, Clone)]
pub struct Scene {
    pub root: BspNode,
    pub polys: HashMap<u16, ResolvedPolygon>,
}

impl Scene {
    /// A wide-bounded single leaf carrying every poly id (matches the existing
    /// leaf-test fixtures; BSP descent is separately tested).
    fn from_polys(polys: HashMap<u16, ResolvedPolygon>, center: Vector3, radius: f32) -> Self {
        let mut ids: Vec<u16> = polys.keys().copied().collect();
        ids.sort_unstable();
        let root = BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere { center, radius }),
            poly_ids: ids,
        });
        Scene { root, polys }
    }
}

/// A planar quad polygon with explicit normal/offset (`N·P + d = 0` on-plane).
fn quad(verts: [Vector3; 4], normal: Vector3, d: f32) -> ResolvedPolygon {
    ResolvedPolygon {
        num_points: 4,
        vertices: verts.to_vec(),
        plane: Plane { normal, d },
    }
}

/// The five required features as standalone scenes.
pub mod scenes {
    use super::*;

    /// Flat walkable floor: z = 0, x,y ∈ [0,2], N = +Z. `N.z = 1 ≥ FLOOR_Z`.
    pub fn flat_floor() -> Scene {
        let mut m = HashMap::new();
        m.insert(
            0u16,
            quad(
                [v(0.0, 0.0, 0.0), v(2.0, 0.0, 0.0), v(2.0, 2.0, 0.0), v(0.0, 2.0, 0.0)],
                v(0.0, 0.0, 1.0),
                0.0,
            ),
        );
        Scene::from_polys(m, v(1.0, 1.0, 0.0), 100.0)
    }

    /// Vertical wall: x = 0, y ∈ [0,2], z ∈ [0,3], N = +X. `N.z = 0` ⇒ wall.
    /// NB: NO floor — a mover here can never hold a contact plane, so
    /// `validate_transition` clears its CONTACT bit every step
    /// (`driver_validate.rs:183-194`). Models the AIRBORNE/non-CONTACT case.
    pub fn vertical_wall() -> Scene {
        let mut m = HashMap::new();
        m.insert(
            1u16,
            quad(
                [v(0.0, 0.0, 0.0), v(0.0, 2.0, 0.0), v(0.0, 2.0, 3.0), v(0.0, 0.0, 3.0)],
                v(1.0, 0.0, 0.0),
                0.0,
            ),
        );
        Scene::from_polys(m, v(0.0, 1.0, 1.5), 100.0)
    }

    /// Walkable floor (z = 0, N = +Z, x ∈ [-3,3]) meeting a vertical wall
    /// (x = 0, N = +X, z ∈ [0,3]). Models a GROUNDED player walking into a wall:
    /// the floor supplies a contact plane every step, so the mover keeps its
    /// CONTACT bit and the wall hit routes through the slide branch
    /// (`resolver_find.rs:214`) — unlike the floorless [`vertical_wall`].
    pub fn floor_and_wall() -> Scene {
        let mut m = HashMap::new();
        m.insert(
            0u16,
            quad(
                [v(-3.0, 0.0, 0.0), v(3.0, 0.0, 0.0), v(3.0, 2.0, 0.0), v(-3.0, 2.0, 0.0)],
                v(0.0, 0.0, 1.0),
                0.0,
            ),
        );
        m.insert(
            1u16,
            quad(
                [v(0.0, 0.0, 0.0), v(0.0, 2.0, 0.0), v(0.0, 2.0, 3.0), v(0.0, 0.0, 3.0)],
                v(1.0, 0.0, 0.0),
                0.0,
            ),
        );
        Scene::from_polys(m, v(0.0, 1.0, 1.5), 100.0)
    }

    /// Single step of height `rise`: lower floor z=0, riser at x=2 (N=−X), upper
    /// tread z=rise. `rise <= step_up_height` ⇒ climbable; `TALL_STEP` ⇒ wall.
    pub fn single_step(rise: f32) -> Scene {
        let mut m = HashMap::new();
        m.insert(
            10u16,
            quad(
                [v(0.0, 0.0, 0.0), v(2.0, 0.0, 0.0), v(2.0, 2.0, 0.0), v(0.0, 2.0, 0.0)],
                v(0.0, 0.0, 1.0),
                0.0,
            ),
        );
        m.insert(
            11u16,
            quad(
                [v(2.0, 0.0, 0.0), v(2.0, 0.0, rise), v(2.0, 2.0, rise), v(2.0, 2.0, 0.0)],
                v(-1.0, 0.0, 0.0),
                2.0,
            ),
        );
        m.insert(
            12u16,
            quad(
                [v(2.0, 0.0, rise), v(4.0, 0.0, rise), v(4.0, 2.0, rise), v(2.0, 2.0, rise)],
                v(0.0, 0.0, 1.0),
                -rise,
            ),
        );
        Scene::from_polys(m, v(2.0, 1.0, rise * 0.5), 100.0)
    }

    /// Cliff edge of depth `drop`: upper platform z=0 (x∈[0,2]), lower floor
    /// z=−drop (x∈[2,4]). `drop <= step_down_height` ⇒ step down.
    pub fn cliff_edge(drop: f32) -> Scene {
        let mut m = HashMap::new();
        m.insert(
            20u16,
            quad(
                [v(0.0, 0.0, 0.0), v(2.0, 0.0, 0.0), v(2.0, 2.0, 0.0), v(0.0, 2.0, 0.0)],
                v(0.0, 0.0, 1.0),
                0.0,
            ),
        );
        m.insert(
            21u16,
            quad(
                [v(2.0, 0.0, -drop), v(4.0, 0.0, -drop), v(4.0, 2.0, -drop), v(2.0, 2.0, -drop)],
                v(0.0, 0.0, 1.0),
                drop,
            ),
        );
        Scene::from_polys(m, v(2.0, 1.0, -drop * 0.5), 100.0)
    }

    /// A bottomless cliff: the upper platform only (nothing below).
    pub fn bottomless_cliff() -> Scene {
        let mut m = HashMap::new();
        m.insert(
            20u16,
            quad(
                [v(0.0, 0.0, 0.0), v(2.0, 0.0, 0.0), v(2.0, 2.0, 0.0), v(0.0, 2.0, 0.0)],
                v(0.0, 0.0, 1.0),
                0.0,
            ),
        );
        Scene::from_polys(m, v(1.0, 1.0, 0.0), 100.0)
    }

    /// Sloped NON-walkable ramp (60° toward +X): N = (−sin60, 0, cos60).
    /// `Z_FOR_LANDING < N.z (0.5) < FLOOR_Z` ⇒ landable but too steep to stand.
    pub fn sloped_ramp() -> Scene {
        let n = v(-0.866_025_4, 0.0, 0.5);
        let t = v(0.5, 0.0, 0.866_025_4); // up-slope tangent (unit, ⟂ N)
        let a = v(0.0, 0.0, 0.0);
        let b = a + t * 2.0;
        let c = b + v(0.0, 2.0, 0.0);
        let d_pt = a + v(0.0, 2.0, 0.0);
        let mut m = HashMap::new();
        m.insert(30u16, quad([a, b, c, d_pt], n, 0.0));
        Scene::from_polys(m, v(0.5, 1.0, 0.866), 100.0)
    }
}

// ─── localspace cache (same-cell stand-in for SPHEREPATH::cache_localspace) ──

/// Harness-local SAME-CELL reduction of `SPHEREPATH::cache_localspace_sphere`
/// (`acclient.c:313852`, an unported SPHEREPATH mutator — SEAM). Reproduces its
/// identity-/rotated-frame, single-landblock behaviour using the ported
/// [`Frame`] transforms — all the same-cell scenes need.
pub fn cache_localspace_samecell(path: &mut SpherePath, p: &Position, scale: f32) {
    let inv = 1.0 / scale;
    let n = path.num_sphere as usize;
    for i in 0..n {
        path.localspace_sphere[i].radius = inv * path.local_sphere[i].radius;
        let g = path.check_pos.frame.localtoglobal(path.local_sphere[i].center);
        path.localspace_sphere[i].center = p.frame.globaltolocal(g) * inv;
        if i == 0 {
            let gc = path.curr_pos.frame.localtoglobal(path.local_sphere[i].center);
            path.localspace_curr_center = p.frame.globaltolocal(gc) * inv;
        }
    }
    path.localspace_pos = *p;
    // localspace_z = fl2gv column 2 = global image of local +Z.
    path.localspace_z = v(p.frame.fl2gv[2], p.frame.fl2gv[5], p.frame.fl2gv[8]);
    let lp = path.localspace_sphere[0];
    path.localspace_low_point = lp.center - path.localspace_z * lp.radius;
}

// ─── Synthetic env cell (foundation CObjCell) ──────────────────────────────

/// Synthetic `CEnvCell` (`acclient.c:347823`). Wraps a [`Scene`] + a cell-local
/// `pos` frame and routes the vtable[5] collision entry through the committed
/// Phase-2 resolver. Carries no dynamic objects / landblock.
#[derive(Clone)]
pub struct SynthEnvCell {
    pub id: u32,
    pub scene: Scene,
    pub pos: Position,
    /// `1` (allowed) or `2` (blocked) — drives `check_entry_restrictions`.
    pub entry_restriction: i32,
}

impl SynthEnvCell {
    pub fn new(scene: Scene) -> Self {
        let mut pos = Position::default();
        pos.objcell_id = ENV_CELL_ID;
        Self { id: ENV_CELL_ID, scene, pos, entry_restriction: 1 }
    }
    pub fn with_id(mut self, id: u32) -> Self {
        self.id = id;
        self.pos.objcell_id = id;
        self
    }
    pub fn blocked(mut self) -> Self {
        self.entry_restriction = 2;
        self
    }
    pub fn handle(self) -> Rc<dyn CObjCell> {
        Rc::new(self)
    }
}

impl CObjCell for SynthEnvCell {
    fn id(&self) -> u32 {
        self.id
    }
    fn pos(&self) -> &Position {
        &self.pos
    }
    fn water_type(&self) -> WaterType {
        WaterType::NotWater
    }
    fn cur_landblock(&self) -> Option<Rc<dyn LandblockRef>> {
        None
    }
    fn restriction_obj(&self) -> u32 {
        0
    }
    fn objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
        &[]
    }
    fn shadow_objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
        &[]
    }

    fn find_transit_cells(
        &self,
        _p: &Position,
        _num_sphere: u32,
        _spheres: &[Sphere],
        _cell_array: &mut dyn CellArrayApi,
        _path: Option<&mut SpherePath>,
    ) {
        // single synthetic cell — no portals to flood.
    }

    /// `CEnvCell::find_env_collisions` (`acclient.c:347823`), faithful order:
    /// entry-restriction gate → clear obstruction_ethereal → cache localspace →
    /// `find_collisions` (or placement) → mark `collided_with_environment`.
    fn find_collisions(&self, transition: &mut CTransition) -> i32 {
        let mut result = self.entry_restriction; // check_entry_restrictions
        if result == 1 {
            transition.sphere_path.obstruction_ethereal = false;
            cache_localspace_samecell(&mut transition.sphere_path, &self.pos, 1.0);
            if transition.sphere_path.insert_type == InsertType::InitialPlacement {
                // BSPTREE::placement_insert is unported → run the Placement path.
                let mut t = transition.clone();
                t.sphere_path.insert_type = InsertType::Placement;
                result = bsptree_find_collisions(&self.scene.root, &mut t, 1.0, &self.scene.polys);
                *transition = t;
            } else {
                result =
                    bsptree_find_collisions(&self.scene.root, transition, 1.0, &self.scene.polys);
            }
            if result != 1 && (transition.object_info.state & object_info_state::CONTACT) == 0 {
                transition.collision_info.collided_with_environment = true;
            }
        }
        result
    }

    fn point_in_cell(&self, point: Vector3) -> bool {
        // any ground projection landing on a walkable poly is "inside".
        self.scene
            .polys
            .values()
            .any(|p| p.plane.normal.z >= FLOOR_Z && p.plane.distance_to_point(&point).abs() < 1.0)
    }
}

// ─── Cell world (foundation CellWorld) ─────────────────────────────────────

/// A [`CellWorld`] over a fixed set of interior cells, keyed by id. Single
/// landblock (`block_offset == 0`); outdoor fill is a no-op (interior scenes).
pub struct SceneWorld {
    pub cells: Vec<Rc<dyn CObjCell>>,
}

impl SceneWorld {
    pub fn single(cell: Rc<dyn CObjCell>) -> Self {
        Self { cells: vec![cell] }
    }
}

impl CellWorld for SceneWorld {
    fn get_visible(&self, cell_id: u32) -> Option<Rc<dyn CObjCell>> {
        self.cells.iter().find(|c| c.id() == cell_id).cloned()
    }
    fn add_all_outside_cells(
        &self,
        _p: &Position,
        _num_sphere: u32,
        _spheres: &[Sphere],
        _cell_array: &mut dyn CellArrayApi,
    ) {
        // interior scenes only.
    }
    fn block_offset(&self, _base: u32, _other: u32) -> Vector3 {
        Vector3::zero()
    }
}

// ─── CTransition / path builders ───────────────────────────────────────────

pub mod build {
    use super::*;

    /// A walking player on a walkable surface: `ON_WALKABLE | IS_PLAYER`,
    /// `step_up_height`/`step_down_height` as given.
    pub fn walker(step_up_height: f32, step_down_height: f32) -> ObjectInfo {
        ObjectInfo {
            object_id: 1,
            state: object_info_state::ON_WALKABLE | object_info_state::IS_PLAYER,
            scale: 1.0,
            step_up_height,
            step_down_height,
            ethereal: false,
            step_down: true,
            target_id: 0,
        }
    }

    /// A GROUNDED walking player: [`walker`] with the CONTACT bit set, i.e. a
    /// player already standing on a walkable surface. CONTACT is the resolver's
    /// discriminator that routes a wall hit through the slide path
    /// (`resolver_find.rs:214`); a non-CONTACT mover instead treats the wall as
    /// a landing candidate (`:259`). Pair with [`scenes::floor_and_wall`] so the
    /// floor's contact plane keeps CONTACT set across steps.
    pub fn grounded_walker(step_up_height: f32, step_down_height: f32) -> ObjectInfo {
        let mut o = walker(step_up_height, step_down_height);
        o.state |= object_info_state::CONTACT;
        o
    }

    /// A single-sphere `CTransition` sweeping a radius-`r` collision sphere from
    /// world `from` to world `to`, in `cell_id`, with `object`. The global
    /// sphere cache is seeded from `check_pos` (the driver's `init_sphere` would).
    pub fn sweep(cell_id: u32, object: ObjectInfo, r: f32, from: Vector3, to: Vector3) -> CTransition {
        let mut t = CTransition::default();
        t.object_info = object;
        t.sphere_path.num_sphere = 1;
        t.sphere_path.local_sphere[0] = Sphere { center: Vector3::zero(), radius: r };
        t.sphere_path.local_low_point = v(0.0, 0.0, -r);
        let mut curr = Position { objcell_id: cell_id, frame: Frame::identity() };
        curr.frame.origin = from;
        let mut chk = Position { objcell_id: cell_id, frame: Frame::identity() };
        chk.frame.origin = to;
        t.sphere_path.curr_pos = curr;
        t.sphere_path.begin_pos = curr;
        t.sphere_path.check_pos = chk;
        t.sphere_path.end_pos = chk;
        t.sphere_path.begin_cell = Some(cell_id);
        t.sphere_path.curr_cell = Some(cell_id);
        t.sphere_path.check_cell = Some(cell_id);
        t.sphere_path.walkable_allowance = Z_FOR_LANDING;
        // seed the cached spheres (driver setup would; the spine reads them).
        t.sphere_path.cache_global_curr_center();
        t.sphere_path.cache_global_sphere(None);
        t
    }

    /// Promote a transition to a placement probe.
    pub fn as_placement(mut t: CTransition, initial: bool) -> CTransition {
        t.sphere_path.insert_type =
            if initial { InsertType::InitialPlacement } else { InsertType::Placement };
        t
    }
}

#[cfg(test)]
mod tests {
    use super::build::*;
    use super::*;
    use crate::transition::driver_validate::MovingObjectPhysics;

    struct NoGravity;
    impl MovingObjectPhysics for NoGravity {
        fn has_gravity(&self) -> bool {
            false
        }
    }

    fn walker_obj() -> ObjectInfo {
        walker(0.5, 0.5)
    }

    // ── harness self-tests: single find_collisions verdicts (resolver-level) ──

    #[test]
    fn floor_downsweep_adjusts_with_up_normal() {
        let cell = SynthEnvCell::new(scenes::flat_floor());
        let mut obj = walker_obj();
        obj.state = 0;
        let mut t = sweep(ENV_CELL_ID, obj, 0.5, v(1.0, 1.0, 1.3), v(1.0, 1.0, 0.3));
        let r = cell.find_collisions(&mut t);
        assert_eq!(r, 3, "floor front-face hit ⇒ ADJUSTED");
        assert!((t.sphere_path.step_up_normal - v(0.0, 0.0, 1.0)).length() < 1e-3);
        assert!(t.sphere_path.step_up_normal.z >= FLOOR_Z);
    }

    #[test]
    fn wall_sidesweep_adjusts_with_horizontal_normal() {
        let cell = SynthEnvCell::new(scenes::vertical_wall());
        let mut obj = walker_obj();
        obj.state = 0;
        let mut t = sweep(ENV_CELL_ID, obj, 0.5, v(0.3, 1.0, 1.5), v(-0.3, 1.0, 1.5));
        let r = cell.find_collisions(&mut t);
        assert_eq!(r, 3, "wall front-face hit ⇒ ADJUSTED");
        let n = t.sphere_path.step_up_normal;
        assert!((n - v(1.0, 0.0, 0.0)).length() < 1e-3);
        assert!(n.z < FLOOR_Z, "wall normal is not walkable");
    }

    #[test]
    fn ramp_is_landable_but_not_walkable() {
        let cell = SynthEnvCell::new(scenes::sloped_ramp());
        let mut obj = walker_obj();
        obj.state = 0;
        let mut t = sweep(ENV_CELL_ID, obj, 0.5, v(0.3, 1.0, 1.2), v(0.3, 1.0, 0.2));
        let r = cell.find_collisions(&mut t);
        assert_eq!(r, 3, "ramp front-face hit ⇒ ADJUSTED");
        let n = t.sphere_path.step_up_normal;
        assert!(n.z > Z_FOR_LANDING, "ramp passes the landing gate");
        assert!(n.z < FLOOR_Z, "ramp fails the stand gate ⇒ driver slides");
    }

    #[test]
    fn blocked_cell_short_circuits_to_two() {
        let cell = SynthEnvCell::new(scenes::flat_floor()).blocked();
        let mut obj = walker_obj();
        obj.state = 0;
        let mut t = sweep(ENV_CELL_ID, obj, 0.5, v(1.0, 1.0, 1.3), v(1.0, 1.0, 0.3));
        assert_eq!(cell.find_collisions(&mut t), 2);
    }

    // ── SPINE end-to-end: transitional_insert through cell + resolver ──

    fn drive(scene: Scene, obj: ObjectInfo, from: Vector3, to: Vector3, r: f32) -> (i32, CTransition) {
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scene).handle();
        let world = SceneWorld::single(cell);
        let mut t = sweep(ENV_CELL_ID, obj, r, from, to);
        let code = t.transitional_insert(&world, 3);
        (code, t)
    }

    fn valid_code(c: i32) -> bool {
        (1..=4).contains(&c)
    }

    #[test]
    fn spine_flat_floor_downsweep_terminates() {
        // A downward sweep onto the floor drives insert_into_cell (ADJUST→retry→
        // settle) + check_other_cells; the depth guard must not fire.
        let (code, _t) = drive(
            scenes::flat_floor(),
            build::walker(0.5, 0.5),
            v(1.0, 1.0, 1.3),
            v(1.0, 1.0, 0.3),
            0.5,
        );
        assert!(valid_code(code), "got {code}");
    }

    #[test]
    fn spine_wall_sidesweep_terminates() {
        let (code, _t) = drive(
            scenes::vertical_wall(),
            build::walker(0.5, 0.5),
            v(0.3, 1.0, 1.5),
            v(-0.3, 1.0, 1.5),
            0.5,
        );
        assert!(valid_code(code), "got {code}");
    }

    #[test]
    fn spine_step_sweep_terminates() {
        let (code, _t) = drive(
            scenes::single_step(STEP_H),
            build::walker(0.5, 0.5),
            v(1.7, 1.0, 0.25),
            v(2.3, 1.0, 0.25),
            0.3,
        );
        assert!(valid_code(code), "got {code}");
    }

    #[test]
    fn spine_cliff_sweep_terminates() {
        let (code, _t) = drive(
            scenes::cliff_edge(SHALLOW_DROP),
            build::walker(0.5, 0.5),
            v(1.5, 1.0, 0.5),
            v(2.5, 1.0, 0.5),
            0.5,
        );
        assert!(valid_code(code), "got {code}");
    }

    #[test]
    fn spine_ramp_sweep_terminates() {
        let (code, _t) = drive(
            scenes::sloped_ramp(),
            build::walker(0.5, 0.5),
            v(0.3, 1.0, 1.2),
            v(0.3, 1.0, 0.2),
            0.5,
        );
        assert!(valid_code(code), "got {code}");
    }

    #[test]
    fn spine_no_check_cell_is_ok_early() {
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scenes::flat_floor()).handle();
        let world = SceneWorld::single(cell);
        let mut t = sweep(ENV_CELL_ID, build::walker(0.5, 0.5), 0.5, v(1.0, 1.0, 1.0), v(1.0, 1.0, 1.0));
        t.sphere_path.check_cell = None;
        assert_eq!(t.transitional_insert(&world, 3), 1);
    }

    // ── check_collisions end-to-end (placement wrapper) ──

    #[test]
    fn check_collisions_placement_into_solid_collides() {
        // A static sphere sitting in the floor; FindObjCollisions reports via the
        // wrapper. We drive the env cell's find_collisions through a tiny adapter.
        use crate::transition::driver_cell_dispatch::FindObjCollisions;
        struct CellAdapter(Rc<dyn CObjCell>);
        impl FindObjCollisions for CellAdapter {
            fn find_obj_collisions(&self, t: &mut CTransition) -> i32 {
                self.0.find_collisions(t)
            }
        }
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scenes::flat_floor()).handle();
        let obj = build::walker(0.5, 0.5);
        // sphere straddling the floor solid → placement COLLIDED.
        let t0 = sweep(ENV_CELL_ID, obj, 0.5, v(1.0, 1.0, 0.3), v(1.0, 1.0, 0.3));
        let mut t = as_placement(t0, false);
        let adapter = CellAdapter(cell.clone());
        let collided = t.check_collisions(&adapter);
        assert!(collided, "placement into solid ⇒ collision reported");
    }

    // ── validate_transition end-to-end (the B2 validation surface) ──

    #[test]
    fn validate_transition_ok_through_real_world() {
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scenes::flat_floor()).handle();
        let world = SceneWorld::single(cell);
        let mut t = sweep(ENV_CELL_ID, build::walker(0.5, 0.5), 0.5, v(1.0, 1.0, 0.5), v(1.0, 1.0, 0.5));
        let mut redo = true;
        let r = t.validate_transition(
            crate::transition::types::TransitionState::Ok,
            &mut redo,
            &world,
            &NoGravity,
        );
        assert_eq!(r, crate::transition::types::TransitionState::Ok);
        assert!(!redo);
    }

    // ── PAYOFF: find_transitional_position end-to-end (B3, the canonical
    //    validate_transition caller). Drives a sphere across each synthetic
    //    scene through `find_valid_position` (insert_type == Transition). The
    //    swept-step search runs calc_num_steps → N× adjust_offset +
    //    transitional_insert + validate_transition; the depth guard must not
    //    fire (no panic) and the result is the int 0/1 the search returns. ──

    /// Drive `find_valid_position` over a single-cell synthetic scene.
    fn drive_find(scene: Scene, obj: ObjectInfo, from: Vector3, to: Vector3, r: f32) -> (i32, CTransition) {
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scene).handle();
        let world = SceneWorld::single(cell);
        let mut t = sweep(ENV_CELL_ID, obj, r, from, to);
        // find_valid_position dispatches on insert_type; sweep() seeds Transition.
        let code = t.find_valid_position(&world, &NoGravity);
        (code, t)
    }

    #[test]
    fn find_transitional_walk_across_flat_floor_is_ok() {
        // A short horizontal walk along the floor (sphere resting on z=0): the
        // search advances check_pos one whole-offset step and validates OK.
        let (code, t) = drive_find(
            scenes::flat_floor(),
            build::walker(0.5, 0.5),
            v(1.0, 1.0, 0.5),
            v(1.4, 1.0, 0.5),
            0.5,
        );
        assert_eq!(code, 1, "clean floor walk ⇒ find_transitional_position OK");
        // curr_pos advanced toward the target (validate_transition committed it).
        assert!(t.sphere_path.curr_pos.frame.origin.x > 1.0);
    }

    // PAYOFF (2026-06-28): a GROUNDED walker (CONTACT held by a floor) walking
    // into a wall STOPS instead of passing through (its airborne counterpart is
    // `..._airborne_mover_stops_at_wall` below). With CONTACT
    // set, the sphere[0] wall hit routes through the SLIDE branch
    // (resolver_find.rs:214 → step_sphere_up → step_up fails on a vertical wall →
    // step_up_slide → slide_sphere, which stamps the horizontal collision_normal);
    // validate_transition promotes collision_normal → sliding_normal
    // (driver_validate.rs:132-134) and the NEXT step's adjust_offset zeroes the
    // into-wall component. So the sphere center must NOT cross the wall.
    #[test]
    fn find_transitional_grounded_walker_stops_at_wall() {
        // Grounded walker rests on z=0 (center z = radius = 0.5), walks x=2 → -2
        // into a wall at x=0 (N=+X). Expected stop ≈ one radius out (x ≈ 0.5).
        let (code, t) = drive_find(
            scenes::floor_and_wall(),
            build::grounded_walker(0.5, 0.5),
            v(2.0, 1.0, 0.5),
            v(-2.0, 1.0, 0.5),
            0.5,
        );
        let x = t.sphere_path.curr_pos.frame.origin.x;
        println!("DIAG grounded walker: code={code} final_x={x}");
        assert!(x >= 0.0, "grounded walker passed THROUGH the wall: final x = {x} (code {code})");
        assert!(x < 2.0, "grounded walker never advanced toward the wall: final x = {x}");
    }

    // AIRBORNE/non-CONTACT wall stop (2026-06-28). Counterpart to the grounded
    // test above: a non-CONTACT mover (a jumping/falling player — CONTACT clear,
    // step_down off so it stays airborne) walking into a wall must also STOP. Here
    // the wall hit routes through the non-CONTACT branch (resolver_find.rs:259):
    // set_collide → transitional_insert's collide block, which (the landing being
    // non-walkable) returns COLLIDED with collision_normal = step_up_normal;
    // validate_transition promotes that to sliding_normal and adjust_offset zeroes
    // the into-wall step — same x≈0.5 stop as the grounded case.
    //
    // NB the scene needs a FLOOR even though the mover is airborne ABOVE it: the
    // synthetic SynthEnvCell::point_in_cell only counts a point "inside" the cell
    // when it is within 1.0 of a WALKABLE poly, so a floorless scene (the old
    // `vertical_wall()` end-to-end probe) makes check_other_cells/find_cell_list
    // null `check_cell` after step 0 (driver_cell_dispatch.rs:215), which silently
    // disables collision for the rest of the walk — a HARNESS cell-seating
    // artifact, NOT a driver bug. (The driver was never wrong here; the earlier
    // "faithful driver walks through walls" §4 diagnosis was the floorless fixture.
    // The live blocker is instead the static-object stub:
    // faithful_bridge.rs find_obj_collisions → OK.)
    #[test]
    fn find_transitional_airborne_mover_stops_at_wall() {
        // Non-CONTACT mover hovering one radius above z=0 floor (z=0.9 keeps the
        // cell seated), walks x=2 → -2 into a wall at x=0. Expected stop x ≈ 0.5.
        let mut obj = build::walker(0.5, 0.5);
        obj.state = object_info_state::IS_PLAYER; // non-CONTACT, non-ON_WALKABLE
        obj.step_down = false; // do not snap to the floor → stays airborne
        let (code, t) = drive_find(
            scenes::floor_and_wall(),
            obj,
            v(2.0, 1.0, 0.9),
            v(-2.0, 1.0, 0.9),
            0.5,
        );
        let x = t.sphere_path.curr_pos.frame.origin.x;
        println!("DIAG airborne mover: code={code} final_x={x}");
        assert!(x >= 0.0, "airborne mover passed THROUGH the wall: final x = {x} (code {code})");
        assert!(x < 2.0, "airborne mover never advanced toward the wall: final x = {x}");
    }

    #[test]
    fn find_transitional_no_motion_seeds_cell_array_and_succeeds() {
        // begin == end ⇒ num_steps == 0 ⇒ the no-motion branch seats check_pos,
        // builds the cell ring, and returns 1.
        let (code, t) = drive_find(
            scenes::flat_floor(),
            build::walker(0.5, 0.5),
            v(1.0, 1.0, 0.5),
            v(1.0, 1.0, 0.5),
            0.5,
        );
        assert_eq!(code, 1);
        assert!(t.sphere_path.cell_array_valid);
    }

    #[test]
    fn find_transitional_no_begin_cell_fails() {
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scenes::flat_floor()).handle();
        let world = SceneWorld::single(cell);
        let mut t = sweep(ENV_CELL_ID, build::walker(0.5, 0.5), 0.5, v(1.0, 1.0, 0.5), v(1.4, 1.0, 0.5));
        t.sphere_path.begin_cell = None; // 313203 guard
        assert_eq!(t.find_valid_position(&world, &NoGravity), 0);
    }

    #[test]
    fn find_transitional_wall_sidesweep_terminates() {
        // Walking into a wall: the search drives the slide/blocked machinery and
        // terminates with a valid 0/1 code (the depth guard does not fire).
        let (code, _t) = drive_find(
            scenes::vertical_wall(),
            build::walker(0.5, 0.5),
            v(0.6, 1.0, 1.5),
            v(-0.4, 1.0, 1.5),
            0.5,
        );
        assert!(code == 0 || code == 1, "got {code}");
    }

    #[test]
    fn find_transitional_step_up_terminates() {
        // Sweep into a climbable step (rise < step_up_height): exercises the
        // step-up path under the swept-step loop.
        let (code, _t) = drive_find(
            scenes::single_step(STEP_H),
            build::walker(0.5, 0.5),
            v(1.6, 1.0, 0.25),
            v(2.4, 1.0, 0.25),
            0.3,
        );
        assert!(code == 0 || code == 1, "got {code}");
    }

    #[test]
    fn find_transitional_cliff_step_down_terminates() {
        // Sweep off a shallow cliff edge: exercises step_down + edge_slide under
        // the search.
        let (code, _t) = drive_find(
            scenes::cliff_edge(SHALLOW_DROP),
            build::walker(0.5, 0.5),
            v(1.4, 1.0, 0.5),
            v(2.6, 1.0, 0.5),
            0.5,
        );
        assert!(code == 0 || code == 1, "got {code}");
    }

    #[test]
    fn find_transitional_ramp_slide_terminates() {
        // Sweep into a too-steep ramp (landable, not walkable): exercises the
        // slide response under the search.
        let (code, _t) = drive_find(
            scenes::sloped_ramp(),
            build::walker(0.5, 0.5),
            v(0.4, 1.0, 1.2),
            v(0.4, 1.0, 0.2),
            0.5,
        );
        assert!(code == 0 || code == 1, "got {code}");
    }
}
