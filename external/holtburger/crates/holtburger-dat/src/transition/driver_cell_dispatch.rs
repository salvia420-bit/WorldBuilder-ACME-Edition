//! Phase-3 driver — `CTransition` cell-collision dispatch (B2c, agent A02).
//!
//! Decomp-faithful ports of:
//! - `CTransition::check_collisions`   (acclient.c:312175)
//! - `CTransition::insert_into_cell`   (acclient.c:311632)
//! - `CTransition::check_other_cells`  (acclient.c:312381)
//! - `CTransition::build_cell_array`   (acclient.c:311675)
//!
//! ## Reconciliation to the B2a foundation
//! - The cell vtable slot 5 (`vfptr[5]`, the decompiler's apparent
//!   `AddRef`/`Release`) is the SINGLE trait method
//!   [`super::objcell::CObjCell::find_collisions`] (A15 D5). `insert_into_cell`
//!   and `check_other_cells` BOTH call it; only the per-site i32 switch differs
//!   (A15 R6) — ported branch-for-branch.
//! - Cells are stored as `Option<u32>` ids in `SpherePath`; the driver resolves
//!   id → live `Rc<dyn CObjCell>` through [`super::objcell::CellWorld`] /
//!   [`super::objcell::find_cell_list`] (the injected `world` param, design
//!   decision #2 — NOT a `CTransition` field).
//! - `SPHEREPATH::adjust_check_pos` already lives in `spherepath_methods.rs`
//!   (B2a foundation); we call it, not re-port it.

use super::objcell::{find_cell_list, CObjCell, CellWorld};
use super::types::{CTransition, InsertType, ObjCellHandle, Position, TransitionState};
use holtburger_common::Vector3;

/// SEAM (B3 / A13): `CPhysicsObj::FindObjCollisions` (`acclient.c:316159`) — the
/// object-level collision driver `check_collisions` delegates to. `check_collisions`
/// reports a collision when this is `!= 1` (anything other than OK).
pub trait FindObjCollisions {
    fn find_obj_collisions(&self, t: &mut CTransition) -> i32;
}

/// SEAM (B3 — `LandDefs`/landscape): `LandDefs::adjust_to_outside`
/// (`acclient.c:467434`). Snaps a landblock-relative / indoor id to its
/// enclosing OUTDOOR landcell, rewriting `cell_id` (and, in the real client, the
/// block-local point). Returns `true` when an outside cell exists.
///
/// NOT a faithful landblock-grid walk: this deterministic stub snaps to
/// `id & 0xFFFF_0000` (the landblock's `…0000` landcell) and zeroes a blockless
/// id, which is enough to exercise both `check_other_cells` outdoor-reentry tail
/// branches. Interior sweeps (low `u16 >= 0x100`) never reach it. B3 swaps in the
/// real `LandDefs::adjust_to_outside` before relying on outdoor cell re-entry.
fn adjust_to_outside_seam(cell_id: &mut u32, _loc: &mut Vector3) -> bool {
    if *cell_id >> 16 == 0 {
        *cell_id = 0;
        false
    } else {
        *cell_id &= 0xFFFF_0000;
        true
    }
}

impl CTransition {
    /// `CTransition::check_collisions` (acclient.c:312175). Thin placement
    /// wrapper: pin `insert_type = Placement`, seed `check_pos`/`check_cell` from
    /// the current position/cell, invalidate the cell ring, recompute the cached
    /// global sphere, then run the object-level collision driver and report "did
    /// a collision happen" (`!= 1`).
    // acclient.c:312175
    pub fn check_collisions(&mut self, object: &dyn FindObjCollisions) -> bool {
        let curr_cell = self.sphere_path.curr_cell; // v3 (read before the writes)
        self.sphere_path.insert_type = InsertType::Placement; // = 1
        self.sphere_path.check_pos.objcell_id = self.sphere_path.curr_pos.objcell_id;
        self.sphere_path.check_pos.frame = self.sphere_path.curr_pos.frame; // Frame::operator=
        self.sphere_path.check_cell = curr_cell;
        self.sphere_path.cell_array_valid = false;
        self.sphere_path.cache_global_sphere(None); // recompute from check_pos.frame
        // FindObjCollisions(object, this) != 1  (1 == TransitionState::Ok)
        object.find_obj_collisions(self) != TransitionState::Ok as i32
    }

    /// `CTransition::insert_into_cell` (acclient.c:311632). Insert the swept
    /// sphere into ONE cell, retrying the cell's collision entry up to
    /// `num_insertion_attempts` times. Stops immediately on `1`/`2`; on `4`
    /// invalidates the contact plane then retries; on `3` (default) retries.
    ///
    /// `cell` is the already-resolved handle (the spine resolves `check_cell` id
    /// → `Rc<dyn CObjCell>` via the world); `None` ⇒ the decomp's `if (cell)`
    /// false case ⇒ `2`.
    // acclient.c:311632
    pub fn insert_into_cell(&mut self, cell: Option<&dyn CObjCell>, num_insertion_attempts: i32) -> i32 {
        let Some(cell) = cell else {
            return 2; // cell == null
        };

        let mut result: i32 = 1; // initialized 1 (OK); returned when attempts <= 0
        if num_insertion_attempts > 0 {
            let mut v4: i32 = 0;
            loop {
                result = cell.find_collisions(self); // vfptr[5]
                match result {
                    // case 4: clear the contact plane, then `++v4` (no fallthrough).
                    4 => {
                        self.collision_info.contact_plane = None;
                        self.collision_info.contact_plane_is_water = false;
                        v4 += 1;
                        if v4 >= num_insertion_attempts {
                            return result;
                        }
                    }
                    // case 1: case 2: return immediately.
                    1 | 2 => return result,
                    // default (3 and any other): retry.
                    _ => {
                        v4 += 1;
                        if v4 >= num_insertion_attempts {
                            return result;
                        }
                    }
                }
            }
        }
        result
    }

    /// `CTransition::build_cell_array` (acclient.c:311675). Re-derive the
    /// candidate cell ring from geometry: mark the ring valid, clear the
    /// interior-cell flag, and let `find_cell_list` populate `cell_array`.
    ///
    /// The decomp's 3-arg `find_cell_list(&cell_array, new_cell_p, &path)`
    /// forwarder expands (acclient.c:347316) to the full
    /// `find_cell_list(&check_pos, num_sphere, global_sphere, cell_array,
    /// new_cell_p, path)`; the B2a foundation `find_cell_list` takes those plus
    /// the injected `world`. `check_pos`/`num_sphere`/`global_sphere` are copied
    /// out first so they don't alias the `&mut sphere_path` the same call needs.
    // acclient.c:311675
    pub fn build_cell_array(&mut self, world: &dyn CellWorld, new_cell: Option<&mut Option<ObjCellHandle>>) {
        self.sphere_path.cell_array_valid = true; // = 1
        self.sphere_path.hits_interior_cell = false; // = 0
        let p = self.sphere_path.check_pos;
        let num_sphere = self.sphere_path.num_sphere as u32;
        let spheres = self.sphere_path.global_sphere;
        find_cell_list(
            world,
            &p,
            num_sphere,
            &spheres,
            &mut self.cell_array,
            new_cell,
            Some(&mut self.sphere_path),
        );
    }

    /// `CTransition::check_other_cells` (acclient.c:312381). Rebuild the cell
    /// ring (inlines `build_cell_array`'s body), then dispatch the collision
    /// entry into every candidate cell that is loaded and `!= curr_cell`,
    /// early-returning on `2`/`3`/`4`. With no blocking cell, reparent `check_pos`
    /// into the cell `find_cell_list` reported (`new_cell2`), or — failing that —
    /// the enclosing outdoor cell.
    // acclient.c:312381
    pub fn check_other_cells(&mut self, world: &dyn CellWorld, curr_cell: Option<u32>) -> i32 {
        let mut v5: i32 = 1; // result, default 1 (OK)
        let mut new_cell_handle: Option<ObjCellHandle> = None; // the CObjCell** out-param

        // ── inlined build_cell_array body (acclient.c:312401-312403) ──
        self.sphere_path.cell_array_valid = true;
        self.sphere_path.hits_interior_cell = false;
        {
            let p = self.sphere_path.check_pos;
            let num_sphere = self.sphere_path.num_sphere as u32;
            let spheres = self.sphere_path.global_sphere;
            find_cell_list(
                world,
                &p,
                num_sphere,
                &spheres,
                &mut self.cell_array,
                Some(&mut new_cell_handle),
                Some(&mut self.sphere_path),
            );
        }

        // ── walk the ring (acclient.c:312404-312432) ──
        if self.cell_array.num_cells != 0 {
            let mut v4: usize = 0;
            loop {
                // top of while(1): read cells[v4] (v4 < num_cells here — on entry
                // num_cells != 0, and we only re-loop after v4 < num_cells).
                let cell_id = self.cell_array.cells[v4].cell_id;
                let resolved = self.cell_array.cells[v4].cell.clone(); // CELLINFO.cell
                let found = resolved.is_some() && Some(cell_id) != curr_cell;
                if found {
                    // result = v6->vfptr[5].AddRef(this);  (cell is an owned Rc
                    // clone ⇒ dispatching with &mut self is borrow-legal.)
                    let cell = resolved.unwrap();
                    let result = cell.find_collisions(self);
                    v5 = result;
                    match result {
                        4 => {
                            self.collision_info.contact_plane = None; // valid = 0
                            self.collision_info.contact_plane_is_water = false;
                            return result;
                        }
                        2 | 3 => return v5,
                        // default (1 and any other) → goto $L93946: advance.
                        _ => {
                            v4 += 1;
                            if v4 >= self.cell_array.num_cells as usize {
                                break; // goto LABEL_6
                            }
                        }
                    }
                } else {
                    // $L93964: ++v4; exhausted → LABEL_6.
                    v4 += 1;
                    if v4 >= self.cell_array.num_cells as usize {
                        break;
                    }
                }
            }
        }

        // ── LABEL_6: no blocking cell (acclient.c:312436-312470) ──
        let new_cell2: Option<u32> = new_cell_handle.as_ref().map(|c| c.id());
        self.sphere_path.check_cell = new_cell2;
        if let Some(found_id) = new_cell2 {
            self.sphere_path.adjust_check_pos(found_id); // → v8->m_DID.id
            return v5;
        }
        if self.sphere_path.step_down {
            return 2;
        }

        // Position p = { check_pos.objcell_id, check_pos.frame }.
        let mut p = Position {
            objcell_id: self.sphere_path.check_pos.objcell_id,
            frame: self.sphere_path.check_pos.frame, // Frame::operator=
        };
        if (p.objcell_id & 0xFFFF) < 0x100 {
            adjust_to_outside_seam(&mut p.objcell_id, &mut p.frame.origin); // SEAM(B3)
        }
        if p.objcell_id != 0 {
            // v11 != 0 — reparent into the enclosing outside cell.
            self.sphere_path.adjust_check_pos(p.objcell_id);
            self.sphere_path.check_pos.objcell_id = p.objcell_id;
            self.sphere_path.check_pos.frame = p.frame; // Frame::operator=
            self.sphere_path.check_cell = None;
            self.sphere_path.cell_array_valid = false;
            self.sphere_path.cache_global_sphere(None);
            self.sphere_path.cell_array_valid = true;
            return v5;
        }
        v5 = 2; // no enclosing outside cell
        v5
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::objcell::{CellArrayApi, LandblockRef, PhysicsObjRef, WaterType};
    use super::super::types::SpherePath;
    use holtburger_common::{Sphere, Vector3};
    use std::cell::Cell;
    use std::rc::Rc;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }
    const TOL: f32 = 1e-4;
    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }

    // ── A CObjCell whose find_collisions returns a scripted code sequence ──
    struct ScriptCell {
        id: u32,
        pos: Position,
        codes: Vec<i32>,
        calls: Cell<usize>,
        objects: Vec<Rc<dyn PhysicsObjRef>>,
    }
    impl ScriptCell {
        fn new(id: u32, codes: Vec<i32>) -> Self {
            Self {
                id,
                pos: Position { objcell_id: id, ..Default::default() },
                codes,
                calls: Cell::new(0),
                objects: Vec::new(),
            }
        }
    }
    impl CObjCell for ScriptCell {
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
            &self.objects
        }
        fn shadow_objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
            &self.objects
        }
        fn find_transit_cells(
            &self,
            _p: &Position,
            _n: u32,
            _s: &[Sphere],
            _ca: &mut dyn CellArrayApi,
            _path: Option<&mut SpherePath>,
        ) {
        }
        fn find_collisions(&self, _t: &mut CTransition) -> i32 {
            let i = self.calls.get();
            self.calls.set(i + 1);
            self.codes[i.min(self.codes.len() - 1)]
        }
        fn point_in_cell(&self, _point: Vector3) -> bool {
            true
        }
    }

    // check_other_cells builds the ring through `find_cell_list`, which uses the
    // world's `add_all_outside_cells` for OUTDOOR sweeps. `RingWorld` seeds the
    // ring with scripted candidate cells so the dispatch walk is exercised
    // deterministically (interior `find_cell_list` flooding is covered in
    // `objcell.rs`'s tests).
    struct RingWorld {
        cells: Vec<Rc<dyn CObjCell>>,
        ring: Vec<u32>,
    }
    impl CellWorld for RingWorld {
        fn get_visible(&self, cell_id: u32) -> Option<Rc<dyn CObjCell>> {
            self.cells.iter().find(|c| c.id() == cell_id).cloned()
        }
        fn add_all_outside_cells(
            &self,
            _p: &Position,
            _n: u32,
            _s: &[Sphere],
            ca: &mut dyn CellArrayApi,
        ) {
            for &id in &self.ring {
                let cell = self.cells.iter().find(|c| c.id() == id).cloned();
                ca.add_cell(id, cell);
            }
        }
        fn block_offset(&self, _b: u32, _o: u32) -> Vector3 {
            Vector3::zero()
        }
    }

    struct FakePhysObj(i32);
    impl FindObjCollisions for FakePhysObj {
        fn find_obj_collisions(&self, _t: &mut CTransition) -> i32 {
            self.0
        }
    }

    fn one_sphere_path(t: &mut CTransition) {
        t.sphere_path.num_sphere = 1;
        t.sphere_path.local_sphere[0] = Sphere { center: v(1.0, 2.0, 3.0), radius: 0.5 };
        t.sphere_path.local_low_point = v(1.0, 2.0, 0.0);
    }

    // ── check_collisions (acclient.c:312175) ──
    #[test]
    fn check_collisions_seeds_state_and_reports_collision() {
        let mut t = CTransition::default();
        one_sphere_path(&mut t);
        t.sphere_path.curr_cell = Some(0xABCD);
        t.sphere_path.curr_pos.objcell_id = 0x1111;
        t.sphere_path.curr_pos.frame.origin = v(5.0, 0.0, 0.0); // identity basis
        t.sphere_path.insert_type = InsertType::Transition;
        t.sphere_path.cell_array_valid = true;

        let collided = t.check_collisions(&FakePhysObj(1)); // OK → no collision
        assert!(!collided);
        assert_eq!(t.sphere_path.insert_type, InsertType::Placement);
        assert_eq!(t.sphere_path.check_pos.objcell_id, 0x1111);
        assert!(approx(t.sphere_path.check_pos.frame.origin, v(5.0, 0.0, 0.0)));
        assert_eq!(t.sphere_path.check_cell, Some(0xABCD));
        assert!(!t.sphere_path.cell_array_valid);
        // cache_global_sphere(None): localtoglobal((1,2,3)) under origin (5,0,0).
        assert!(approx(t.sphere_path.global_sphere[0].center, v(6.0, 2.0, 3.0)));

        assert!(t.check_collisions(&FakePhysObj(2))); // COLLIDED → true
        assert!(t.check_collisions(&FakePhysObj(4))); // SLID is "!= 1" → true
    }

    // ── insert_into_cell (acclient.c:311632) ──
    #[test]
    fn insert_into_cell_null_cell_is_two() {
        let mut t = CTransition::default();
        assert_eq!(t.insert_into_cell(None, 3), 2);
    }

    #[test]
    fn insert_into_cell_zero_attempts_returns_initial_ok() {
        let mut t = CTransition::default();
        let cell = ScriptCell::new(1, vec![2]);
        assert_eq!(t.insert_into_cell(Some(&cell), 0), 1);
        assert_eq!(cell.calls.get(), 0);
    }

    #[test]
    fn insert_into_cell_stops_on_ok_and_collided() {
        let mut t = CTransition::default();
        let ok = ScriptCell::new(1, vec![1]);
        assert_eq!(t.insert_into_cell(Some(&ok), 3), 1);
        assert_eq!(ok.calls.get(), 1);

        let collided = ScriptCell::new(2, vec![2]);
        assert_eq!(t.insert_into_cell(Some(&collided), 3), 2);
        assert_eq!(collided.calls.get(), 1);
    }

    #[test]
    fn insert_into_cell_retries_on_slid_clearing_contact_plane() {
        let mut t = CTransition::default();
        t.collision_info.contact_plane =
            Some(holtburger_common::Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 });
        t.collision_info.contact_plane_is_water = true;

        let slid = ScriptCell::new(3, vec![4]);
        assert_eq!(t.insert_into_cell(Some(&slid), 3), 4);
        assert_eq!(slid.calls.get(), 3);
        assert!(t.collision_info.contact_plane.is_none());
        assert!(!t.collision_info.contact_plane_is_water);
    }

    #[test]
    fn insert_into_cell_retries_on_adjusted_then_stops() {
        let mut t = CTransition::default();
        let cell = ScriptCell::new(4, vec![3, 1]);
        assert_eq!(t.insert_into_cell(Some(&cell), 3), 1);
        assert_eq!(cell.calls.get(), 2);

        let stuck = ScriptCell::new(5, vec![3]);
        assert_eq!(t.insert_into_cell(Some(&stuck), 2), 3);
        assert_eq!(stuck.calls.get(), 2);
    }

    // ── check_other_cells (acclient.c:312381) ──
    #[test]
    fn check_other_cells_dispatch_returns_on_collided() {
        // Outdoor curr cell so find_cell_list uses add_all_outside_cells (our
        // RingWorld) to seed the ring with cells 10 (curr → skipped) + 20 (COLLIDE).
        let mut t = CTransition::default();
        one_sphere_path(&mut t);
        t.sphere_path.check_pos.objcell_id = 0x1234_0001; // outdoor (low u16 < 0x100)
        let c10 = Rc::new(ScriptCell::new(10, vec![2])) as Rc<dyn CObjCell>;
        let c20 = Rc::new(ScriptCell::new(20, vec![2])) as Rc<dyn CObjCell>;
        let world = RingWorld {
            cells: vec![c10.clone(), c20.clone()],
            ring: vec![10, 20],
        };
        assert_eq!(t.check_other_cells(&world, Some(10)), 2);
    }

    #[test]
    fn check_other_cells_slid_clears_contact_plane_and_returns_4() {
        let mut t = CTransition::default();
        one_sphere_path(&mut t);
        t.sphere_path.check_pos.objcell_id = 0x1234_0001;
        t.collision_info.contact_plane =
            Some(holtburger_common::Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 });
        t.collision_info.contact_plane_is_water = true;
        let c20 = Rc::new(ScriptCell::new(20, vec![4])) as Rc<dyn CObjCell>;
        let world = RingWorld { cells: vec![c20], ring: vec![20] };
        assert_eq!(t.check_other_cells(&world, Some(10)), 4);
        assert!(t.collision_info.contact_plane.is_none());
        assert!(!t.collision_info.contact_plane_is_water);
    }

    #[test]
    fn check_other_cells_step_down_no_cell_returns_2() {
        let mut t = CTransition::default();
        one_sphere_path(&mut t);
        t.sphere_path.step_down = true;
        t.sphere_path.check_pos.objcell_id = 0x1234_0001;
        let world = RingWorld { cells: vec![], ring: vec![] };
        // ring empty (num_cells 0) → LABEL_6 → step_down → return 2.
        assert_eq!(t.check_other_cells(&world, Some(10)), 2);
    }

    #[test]
    fn check_other_cells_reparents_to_outside_cell() {
        let mut t = CTransition::default();
        one_sphere_path(&mut t);
        t.sphere_path.check_pos.objcell_id = 0x5678_0001; // low u16 < 0x100, has block
        t.sphere_path.check_pos.frame.origin = v(2.0, 3.0, 4.0);
        let world = RingWorld { cells: vec![], ring: vec![] };
        let r = t.check_other_cells(&world, Some(10));
        assert_eq!(r, 1); // v5 stays 1 through the outside-readjust branch
        assert_eq!(t.sphere_path.check_pos.objcell_id, 0x5678_0000);
        assert_eq!(t.sphere_path.check_cell, None);
        assert!(t.sphere_path.cell_array_valid);
    }

    #[test]
    fn check_other_cells_no_outside_cell_returns_2() {
        let mut t = CTransition::default();
        one_sphere_path(&mut t);
        t.sphere_path.check_pos.objcell_id = 0x0000_0001; // low<0x100, no block
        let world = RingWorld { cells: vec![], ring: vec![] };
        assert_eq!(t.check_other_cells(&world, Some(10)), 2);
    }
}
