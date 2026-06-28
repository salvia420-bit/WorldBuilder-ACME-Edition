//! Phase-3 driver — `CTransition` initialization suite + object-pool factory
//! (B3, agent A07). The construction / field-reset surface the driver calls
//! before each transition. Decomp-faithful ports of `acclient.c`:
//!
//! - [`CTransition::init`]                       — `acclient.c:311596`
//! - [`CTransition::init_sphere`]                — `acclient.c:311620`
//! - [`CTransition::init_path`]                  — `acclient.c:311626`
//! - [`CTransition::init_contact_plane`]         — `acclient.c:315599`
//! - [`CTransition::init_last_known_contact_plane`] — `acclient.c:315612`
//! - [`CTransition::init_sliding_normal`]        — `acclient.c:317253`
//! - [`TransitionPool::cleanup_transition`]      — `acclient.c:311589`
//! - [`TransitionPool::make_transition`]         — `acclient.c:312543`
//!
//! Gap-fill `SPHEREPATH` delegates `init`/`init_sphere`/`init_path` (Phase 2 left
//! them out of `spherepath_methods.rs`) are supplied here; `cache_global_curr_center`
//! and `CollisionInfo::init` already exist in the foundation, so they are reused.
//!
//! ## makeTransition deviation (documented)
//! The decomp's `makeTransition` (`acclient.c:312543`) hands out slots from a
//! process-global static `CTransition transit[10]` guarded by a one-time-init
//! flag (`dword_843B70`) + `atexit(sub_766A10)`, indexed by the recursion-depth
//! counter `CTransition::transition_level`. Rust subsumes both C idioms: the
//! lazy ctor → [`TransitionPool::new`] eager init, the `atexit` array destructor
//! → `Drop` of the owned slots. We do NOT replicate the `static mut`/`unsafe`
//! global pool; instead a caller-owned [`TransitionPool`] preserves the
//! semantics that MATTER exactly — 10 reusable slots, the `transition_level`
//! ++/-- discipline, and the depth-10 `None` (null) refusal. The pool hands back
//! a slot INDEX (not `&mut CTransition`) to satisfy the borrow checker;
//! [`CTransition::new`] covers the common non-recursive case where ordinary
//! ownership replaces the pool.

use super::types::{CTransition, InsertType, Position, SpherePath};
use holtburger_common::{Plane, Sphere, Vector3};

// ─── CTransition init suite ──────────────────────────────────────────────

impl CTransition {
    /// `CTransition::init` (`acclient.c:311596`). Resets the transition to its
    /// pristine pre-sweep state. NOTE the decomp touches ONLY these fields —
    /// `object_info.{scale,step_up_height,…,ethereal,step_down}` are left as-is
    /// (`get_object_info` fills them next), and the COLLISIONINFO `*_is_water`
    /// flags / `last_known_contact_plane_cell_id` are NOT cleared here.
    // acclient.c:311596
    pub fn init(&mut self) {
        // object_info.object / state / targetID = 0.
        self.object_info.object_id = 0;
        self.object_info.state = 0;
        self.object_info.target_id = 0;

        // SPHEREPATH::init(&sphere_path).
        self.sphere_path.init();

        // The four `*_valid = 0` flags collapse to `None`.
        self.collision_info.last_known_contact_plane = None;
        self.collision_info.contact_plane = None;
        self.collision_info.sliding_normal = None;
        self.collision_info.collision_normal = None;
        // num_collide_object / last_collided_object = 0 (the object list).
        self.collision_info.reset_objects();
        self.collision_info.collided_with_environment = false;
        self.collision_info.contact_plane_cell_id = 0;
        self.collision_info.frames_stationary_fall = 0;

        // cell_array.num_cells = added_outside = do_not_load_cells = 0. The decomp
        // soft-resets the ring (it does NOT re-run the CELLARRAY ctor); `reset`
        // marks it empty (num_cells/added_outside) and we clear do_not_load_cells.
        self.cell_array.reset();
        self.cell_array.do_not_load_cells = false;
    }

    /// `CTransition::init_sphere` (`acclient.c:311620`). One-line delegate.
    // acclient.c:311620
    pub fn init_sphere(&mut self, num_sphere: u32, sphere: &[Sphere], scale: f32) {
        self.sphere_path.init_sphere(num_sphere, sphere, scale);
    }

    /// `CTransition::init_path` (`acclient.c:311626`). One-line delegate.
    /// `begin_pos` is nullable (`null` selects the placement branch).
    // acclient.c:311626
    pub fn init_path(
        &mut self,
        begin_cell: Option<u32>,
        begin_pos: Option<&Position>,
        end_pos: &Position,
    ) {
        self.sphere_path.init_path(begin_cell, begin_pos, end_pos);
    }

    /// `CTransition::init_contact_plane` (`acclient.c:315599`). Seeds BOTH the
    /// last-known and the current contact plane from one input.
    // acclient.c:315599
    pub fn init_contact_plane(&mut self, cell_id: u32, plane: Plane, is_water: bool) {
        let ci = &mut self.collision_info;
        ci.last_known_contact_plane = Some(plane);
        ci.last_known_contact_plane_is_water = is_water;
        ci.last_known_contact_plane_cell_id = cell_id;
        ci.contact_plane = Some(plane);
        ci.contact_plane_is_water = is_water;
        ci.contact_plane_cell_id = cell_id;
    }

    /// `CTransition::init_last_known_contact_plane` (`acclient.c:315612`). Seeds
    /// the last-known plane — but the decomp then writes `contact_plane_cell_id`
    /// (the CURRENT plane's cell id), NOT `last_known_contact_plane_cell_id`.
    /// Almost certainly a retail copy/paste slip, but observable, so ported
    /// VERBATIM (see the dedicated test).
    // acclient.c:315612
    pub fn init_last_known_contact_plane(&mut self, cell_id: u32, plane: Plane, is_water: bool) {
        let ci = &mut self.collision_info;
        ci.last_known_contact_plane = Some(plane);
        ci.last_known_contact_plane_is_water = is_water;
        // DECOMP QUIRK (faithful): the current plane's cell id, not last-known.
        ci.contact_plane_cell_id = cell_id;
    }

    /// `CTransition::init_sliding_normal` (`acclient.c:317253`). Projects the
    /// normal onto XY (`z = 0`), normalizes in place, collapses to zero if
    /// sub-epsilon; the result is always `Some(...)` (the `_valid` flag is set
    /// first and unconditionally). Byte-identical to `set_sliding_normal`.
    // acclient.c:317253
    pub fn init_sliding_normal(&mut self, normal: Vector3) {
        let mut n = Vector3::new(normal.x, normal.y, 0.0);
        if super::types::normalize_check_small(&mut n) {
            n = Vector3::zero();
        }
        self.collision_info.sliding_normal = Some(n);
    }

    /// Idiomatic, non-pooled construction (the common non-recursive case).
    /// Equivalent to the decomp ctor (`acclient.c:312148`) followed by `init` —
    /// note `init` is NOT a no-op over `default()`: `SPHEREPATH::init` sets
    /// `placement_allows_sliding = 1` whereas `SpherePath::default()` leaves it
    /// `false`.
    pub fn new() -> Self {
        let mut t = CTransition::default();
        t.init();
        t
    }
}

// ─── GAP-FILL: unported SPHEREPATH delegates ──────────────────────────────

impl SpherePath {
    /// `SPHEREPATH::init` (`acclient.c:313431`). Pure field-init; the one
    /// non-zero field is `placement_allows_sliding = 1`. Leaves the sphere
    /// arrays / `end_pos` / `check_pos` / `walk*` / `backup*` untouched.
    // acclient.c:313431
    pub fn init(&mut self) {
        self.num_sphere = 0;
        self.begin_cell = None;
        self.begin_pos = Position::default();
        self.curr_cell = None;
        self.check_cell = None;
        self.insert_type = InsertType::Transition;
        self.step_down = false;
        self.step_up = false;
        self.collide = false;
        self.hits_interior_cell = false;
        self.bldg_check = false;
        self.obstruction_ethereal = false;
        self.backup_cell = None;
        self.walkable_allowance = 0.0;
        self.walkable = None;
        self.check_walkable = false;
        self.cell_array_valid = false;
        self.neg_step_up = 0;
        self.neg_poly_hit = false;
        self.placement_allows_sliding = true;
    }

    /// `SPHEREPATH::init_sphere` (`acclient.c:313647`). Copies up to 2 spheres
    /// into `local_sphere`, scaling center AND radius by `scale`, then records
    /// `local_low_point` = the lowest point of `local_sphere[0]`
    /// (`c.x, c.y, c.z − r`). `num_sphere > 2` clamps to 2.
    // acclient.c:313647
    pub fn init_sphere(&mut self, num_sphere: u32, sphere: &[Sphere], scale: f32) {
        self.num_sphere = if num_sphere <= 2 { num_sphere as u8 } else { 2 };
        for i in 0..self.num_sphere as usize {
            let s = &sphere[i];
            self.local_sphere[i].center.x = scale * s.center.x;
            self.local_sphere[i].center.y = scale * s.center.y;
            self.local_sphere[i].center.z = scale * s.center.z;
            self.local_sphere[i].radius = scale * s.radius;
        }
        // local_low_point from local_sphere[0] (read unconditionally).
        let s0 = self.local_sphere[0];
        self.local_low_point = Vector3::new(s0.center.x, s0.center.y, s0.center.z - s0.radius);
    }

    /// `SPHEREPATH::init_path` (`acclient.c:314043`). Stores begin/end + start
    /// cell, seeds `curr_pos`/`curr_cell`, caches the global start center, and
    /// picks the insert type: `begin_pos` present → seed from begin,
    /// `insert_type = Transition`; `begin_pos` null → seed from end,
    /// `insert_type = Placement`.
    // acclient.c:314043
    pub fn init_path(
        &mut self,
        begin_cell: Option<u32>,
        begin_pos: Option<&Position>,
        end_pos: &Position,
    ) {
        self.begin_cell = begin_cell;
        self.begin_pos = begin_pos.copied().unwrap_or_default();
        self.end_pos = *end_pos;

        if let Some(bp) = begin_pos {
            self.curr_pos.objcell_id = bp.objcell_id;
            self.curr_pos.frame = bp.frame;
            self.curr_cell = begin_cell;
            self.cache_global_curr_center();
            self.insert_type = InsertType::Transition;
        } else {
            self.curr_pos.objcell_id = end_pos.objcell_id;
            self.curr_pos.frame = end_pos.frame;
            self.curr_cell = begin_cell;
            self.cache_global_curr_center();
            self.insert_type = InsertType::Placement;
        }
    }
}

// ─── Object-pool factory (makeTransition / cleanupTransition) ─────────────

/// The decomp's static pool depth (`transit[10]`).
pub const MAX_TRANSITION_LEVEL: usize = 10;

/// Caller-owned replacement for the decomp's `transit[10]` static pool +
/// `CTransition::transition_level` counter (`acclient.c:312543`/`:311589`). See
/// the module-level makeTransition deviation note.
#[derive(Debug)]
pub struct TransitionPool {
    /// `transit[10]` — the 10 reusable slots.
    slots: [CTransition; MAX_TRANSITION_LEVEL],
    /// `CTransition::transition_level` — live-transition recursion depth.
    level: i32,
}

impl Default for TransitionPool {
    fn default() -> Self {
        Self::new()
    }
}

impl TransitionPool {
    /// Subsumes the decomp's first-call ctor sweep (`dword_843B70`): construct
    /// all 10 slots. `make_transition` re-runs `init` per hand-out.
    pub fn new() -> Self {
        Self {
            slots: core::array::from_fn(|_| CTransition::default()),
            level: 0,
        }
    }

    /// `CTransition::makeTransition` (`acclient.c:312543`). Hands out the next
    /// slot (after re-`init`-ing it) and bumps the recursion level; returns
    /// `None` (the decomp's null) once 10 transitions are already live.
    // acclient.c:312543
    pub fn make_transition(&mut self) -> Option<usize> {
        if self.level >= MAX_TRANSITION_LEVEL as i32 {
            return None; // decomp: result = 0
        }
        let idx = self.level as usize;
        self.slots[idx].init();
        self.level += 1;
        Some(idx)
    }

    /// `CTransition::cleanupTransition` (`acclient.c:311589`): `--transition_level`.
    // acclient.c:311589
    pub fn cleanup_transition(&mut self) {
        self.level -= 1;
    }

    /// Borrow a live slot handed out by [`Self::make_transition`].
    pub fn slot(&self, idx: usize) -> &CTransition {
        &self.slots[idx]
    }
    /// Mutably borrow a live slot handed out by [`Self::make_transition`].
    pub fn slot_mut(&mut self, idx: usize) -> &mut CTransition {
        &mut self.slots[idx]
    }
    /// Current recursion depth (`transition_level`).
    pub fn level(&self) -> i32 {
        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::frame_transform::Frame;
    use crate::transition::types::object_info_state;

    const TOL: f32 = 1e-5;
    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }
    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }
    fn pos(cell: u32, o: Vector3) -> Position {
        Position { objcell_id: cell, frame: Frame { fl2gv: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], origin: o } }
    }
    fn sph(c: Vector3, r: f32) -> Sphere {
        Sphere { center: c, radius: r }
    }

    #[test]
    fn init_resets_a_dirtied_transition() {
        let mut t = CTransition::default();
        t.object_info.object_id = 42;
        t.object_info.state = object_info_state::IS_PLAYER | object_info_state::CONTACT;
        t.object_info.target_id = 7;
        t.object_info.scale = 1.5; // must be LEFT ALONE
        t.collision_info.contact_plane = Some(Plane { normal: v(0.0, 0.0, 1.0), d: -3.0 });
        t.collision_info.sliding_normal = Some(v(1.0, 0.0, 0.0));
        t.collision_info.collision_normal = Some(v(0.0, 1.0, 0.0));
        t.collision_info.last_known_contact_plane = Some(Plane { normal: v(0.0, 1.0, 0.0), d: 0.0 });
        t.collision_info.collided_with_environment = true;
        t.collision_info.contact_plane_cell_id = 99;
        t.collision_info.frames_stationary_fall = 4;
        t.sphere_path.num_sphere = 2;
        t.sphere_path.collide = true;
        t.sphere_path.placement_allows_sliding = false;
        t.sphere_path.insert_type = InsertType::Placement;
        t.cell_array.do_not_load_cells = true;

        t.init();

        assert_eq!(t.object_info.object_id, 0);
        assert_eq!(t.object_info.state, object_info_state::DEFAULT);
        assert_eq!(t.object_info.target_id, 0);
        assert_eq!(t.object_info.scale, 1.5, "init must not touch scale");
        assert!(t.collision_info.contact_plane.is_none());
        assert!(t.collision_info.sliding_normal.is_none());
        assert!(t.collision_info.collision_normal.is_none());
        assert!(t.collision_info.last_known_contact_plane.is_none());
        assert!(!t.collision_info.collided_with_environment);
        assert_eq!(t.collision_info.contact_plane_cell_id, 0);
        assert_eq!(t.collision_info.frames_stationary_fall, 0);
        assert_eq!(t.sphere_path.num_sphere, 0);
        assert!(!t.sphere_path.collide);
        assert!(t.sphere_path.placement_allows_sliding);
        assert_eq!(t.sphere_path.insert_type, InsertType::Transition);
        assert!(!t.cell_array.do_not_load_cells);
    }

    #[test]
    fn new_equals_default_plus_init() {
        let t = CTransition::new();
        assert!(t.sphere_path.placement_allows_sliding);
        assert_eq!(t.object_info.object_id, 0);
        assert_eq!(t.sphere_path.insert_type, InsertType::Transition);
    }

    #[test]
    fn init_sphere_scales_center_and_radius_and_low_point() {
        let mut t = CTransition::default();
        t.init_sphere(1, &[sph(v(1.0, 2.0, 3.0), 0.5)], 2.0);
        assert_eq!(t.sphere_path.num_sphere, 1);
        assert!(approx(t.sphere_path.local_sphere[0].center, v(2.0, 4.0, 6.0)));
        assert!((t.sphere_path.local_sphere[0].radius - 1.0).abs() < TOL);
        assert!(approx(t.sphere_path.local_low_point, v(2.0, 4.0, 5.0)));
    }

    #[test]
    fn init_sphere_clamps_count_to_two() {
        let mut t = CTransition::default();
        let s = [sph(v(0.0, 0.0, 0.0), 1.0), sph(v(1.0, 1.0, 1.0), 1.0), sph(v(2.0, 2.0, 2.0), 1.0)];
        t.init_sphere(5, &s, 1.0);
        assert_eq!(t.sphere_path.num_sphere, 2);
    }

    #[test]
    fn init_path_with_begin_pos_is_transition_insert() {
        let mut t = CTransition::default();
        t.init_sphere(1, &[sph(v(0.0, 0.0, 0.0), 1.0)], 1.0);
        let begin = pos(7, v(10.0, 20.0, 30.0));
        let end = pos(9, v(0.0, 0.0, 0.0));
        t.init_path(Some(7), Some(&begin), &end);
        let sp = &t.sphere_path;
        assert_eq!(sp.begin_cell, Some(7));
        assert_eq!(sp.curr_pos.objcell_id, 7);
        assert_eq!(sp.curr_cell, Some(7));
        assert_eq!(sp.insert_type, InsertType::Transition);
        assert!(approx(sp.global_curr_center, v(10.0, 20.0, 30.0)));
    }

    #[test]
    fn init_path_null_begin_pos_is_placement_insert() {
        let mut t = CTransition::default();
        t.init_sphere(1, &[sph(v(0.0, 0.0, 0.0), 1.0)], 1.0);
        let end = pos(9, v(1.0, 2.0, 3.0));
        t.init_path(None, None, &end);
        let sp = &t.sphere_path;
        assert!(sp.begin_cell.is_none());
        assert_eq!(sp.curr_pos.objcell_id, 9);
        assert!(sp.curr_cell.is_none());
        assert_eq!(sp.insert_type, InsertType::Placement);
        assert!(approx(sp.global_curr_center, v(1.0, 2.0, 3.0)));
    }

    #[test]
    fn init_contact_plane_seeds_both_planes() {
        let mut t = CTransition::default();
        let p = Plane { normal: v(0.0, 0.0, 1.0), d: -5.0 };
        t.init_contact_plane(123, p, true);
        let ci = &t.collision_info;
        assert_eq!(ci.last_known_contact_plane, Some(p));
        assert!(ci.last_known_contact_plane_is_water);
        assert_eq!(ci.last_known_contact_plane_cell_id, 123);
        assert_eq!(ci.contact_plane, Some(p));
        assert!(ci.contact_plane_is_water);
        assert_eq!(ci.contact_plane_cell_id, 123);
    }

    #[test]
    fn init_last_known_writes_contact_cell_id_quirk() {
        let mut t = CTransition::default();
        t.collision_info.last_known_contact_plane_cell_id = 111;
        t.collision_info.contact_plane_cell_id = 222;
        let p = Plane { normal: v(0.0, 1.0, 0.0), d: 0.0 };
        t.init_last_known_contact_plane(555, p, false);
        let ci = &t.collision_info;
        assert_eq!(ci.last_known_contact_plane, Some(p));
        assert!(!ci.last_known_contact_plane_is_water);
        // DECOMP QUIRK: cell_id lands in contact_plane_cell_id.
        assert_eq!(ci.contact_plane_cell_id, 555);
        assert_eq!(ci.last_known_contact_plane_cell_id, 111);
        assert!(ci.contact_plane.is_none());
    }

    #[test]
    fn init_sliding_normal_drops_z_then_normalizes() {
        let mut t = CTransition::default();
        t.init_sliding_normal(v(3.0, 4.0, 9.0));
        let n = t.collision_info.sliding_normal.expect("valid");
        assert!(approx(n, v(0.6, 0.8, 0.0)));
    }

    #[test]
    fn init_sliding_normal_vertical_collapses_to_zero() {
        let mut t = CTransition::default();
        t.init_sliding_normal(v(0.0, 0.0, 1.0));
        assert_eq!(t.collision_info.sliding_normal, Some(Vector3::zero()));
    }

    #[test]
    fn pool_hands_out_ten_slots_then_refuses() {
        let mut pool = TransitionPool::new();
        for expect in 0..MAX_TRANSITION_LEVEL {
            assert_eq!(pool.make_transition(), Some(expect));
        }
        assert_eq!(pool.level(), 10);
        assert!(pool.make_transition().is_none());
        assert_eq!(pool.level(), 10, "refused call must not bump level");
    }

    #[test]
    fn pool_cleanup_releases_slot_for_reuse() {
        let mut pool = TransitionPool::new();
        assert_eq!(pool.make_transition(), Some(0));
        assert_eq!(pool.level(), 1);
        pool.cleanup_transition();
        assert_eq!(pool.level(), 0);
        assert_eq!(pool.make_transition(), Some(0));
    }

    #[test]
    fn pool_make_transition_inits_the_slot() {
        let mut pool = TransitionPool::new();
        pool.slot_mut(0).object_info.object_id = 77;
        pool.slot_mut(0).sphere_path.placement_allows_sliding = false;
        let idx = pool.make_transition().unwrap();
        let t = pool.slot(idx);
        assert_eq!(t.object_info.object_id, 0);
        assert!(t.sphere_path.placement_allows_sliding);
    }
}
