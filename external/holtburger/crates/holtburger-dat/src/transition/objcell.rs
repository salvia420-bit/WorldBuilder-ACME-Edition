//! `transition/objcell.rs` — Agent A10 (CObjCell abstraction) + Agent A09
//! (CELLARRAY container methods + outdoor cell-ring assembly), reconciled to
//! the `Rc<dyn CObjCell>` fat-handle cell model.
//!
//! The `CObjCell` COLLISION ABSTRACTION (`acclient.h`; methods @346439..347319)
//! as a Rust trait, plus its decomp-faithful base methods. The decomp's
//! `CObjCell` is a C++ base class; its collision contract is the vtable. IDA
//! renders the relevant slot as `vfptr[5]` (an `InterfaceVtbl` whose
//! `QueryInterface`/`AddRef`/`Release` sub-slots are consecutive vtable
//! entries) plus `vfptr[6]`:
//!   * `vfptr[5].QueryInterface`   → `point_in_cell`        (find_cell_list:347047)
//!   * `vfptr[5].IUnknown_Release` → `find_transit_cells`   (find_cell_list:347018)
//!   * `vfptr[5].Release`          → env/land collisions     (CEnvCell::find_collisions:347816)
//!   * `vfptr[6].QueryInterface`   → `handle_move_restriction` (check_entry_restrictions:347132)
//! This is the "vptr[5] = AddRef-style collision entry" the assignment cites.
//!
//! Modeling conventions match the Phase-1/2 leaf+resolver layer
//! (`super::types`): resolver codes are raw `i32` (1=OK 2=COLLIDED 3=ADJUSTED
//! 4=SLID = `TransitionState` discriminants); a `CObjCell *` collapses to a
//! shared handle `Rc<dyn CObjCell>` (`super::types::ObjCellHandle`); `int`/`BOOL`
//! flags collapse to `bool`.
//!
//! Collaborators owned by sibling agents are reached through narrow seam
//! traits:
//!   * `CellWorld`     — `GetVisible` / `add_all_outside_cells` / `get_block_offset`
//!   * `CellArrayApi`  — `CELLARRAY` struct (`super::types::CellArray`) + methods (A09)
//!   * `ObjectManager` — `CPhysicsObj::GetObjectA`            (A13)
//!   * `PhysicsObjRef` / `WeenieObjRef` — `CPhysicsObj` / `CWeenieObject` (A13)
//!   * `LandblockRef`  — `CLandBlock` / `CLandBlockStruct::calc_water_depth`

use std::rc::Rc;

use super::types::{
    object_info_state, CTransition, CellArray, CellInfo, InsertType, ObjCellHandle, Position,
    SpherePath, TransitionState,
};
use holtburger_common::{Sphere, Vector3};

// ─── LandDefs::WaterType (acclient.h:4105) ───────────────────────────────────

/// `enum LandDefs::WaterType` (`acclient.h:4105`). Defined here because the
/// `CObjCell` water methods are its only Phase-3 consumers; if the landscape
/// agent already exports an equivalent, reconcile to that during integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u32)]
pub enum WaterType {
    #[default]
    NotWater = 0,       // NOT_WATER
    PartiallyWater = 1, // PARTIALLY_WATER
    EntirelyWater = 2,  // ENTIRELY_WATER
}

// ─── Collaborator seams ──────────────────────────────────────────────────────

/// Seam (A13 owns `CWeenieObject`). The weenie layer `check_entry_restrictions`
/// consults through the vtable (`vfptr[18]` / `vfptr[17]`).
pub trait WeenieObjRef {
    /// `weenie->vfptr[18]()` (check_entry_restrictions:347118) —
    /// `CWeenieObject::CanBypassMoveRestrictions`.
    fn can_bypass_move_restrictions(&self) -> bool;
    /// `restriction_weenie->vfptr[17](other)` (check_entry_restrictions:347130)
    /// — `CWeenieObject::CanMoveInto(other)`.
    fn can_move_into(&self, other: &dyn WeenieObjRef) -> bool;
}

/// Seam (A13 owns `CPhysicsObj`). A colliding physics object as the `CObjCell`
/// base methods see it.
pub trait PhysicsObjRef {
    /// `CPhysicsObj::id`.
    fn id(&self) -> u32;
    /// `obj->parent != 0` (find_obj_collisions:347159).
    fn has_parent(&self) -> bool;
    /// `obj->weenie_obj` (check_entry_restrictions:347115).
    fn weenie(&self) -> Option<Rc<dyn WeenieObjRef>>;
    /// `CPhysicsObj::FindObjCollisions(transition)` (find_obj_collisions:347161).
    /// Returns a `TransitionState` code (1=OK …).
    fn find_obj_collisions(&self, transition: &mut CTransition) -> i32;
}

/// Seam (A13). The global object table — `CPhysicsObj::GetObjectA(iid)`
/// (check_entry_restrictions:347124). The decomp reads an ambient global; Rust
/// has no ambient table, so the resolved object manager is injected.
pub trait ObjectManager {
    fn get_object_a(&self, iid: u32) -> Option<Rc<dyn PhysicsObjRef>>;
}

/// Seam (landscape agent owns `CLandBlock`/`CLandBlockStruct`). The cell's
/// owning landblock for the water queries.
pub trait LandblockRef {
    /// `CLandBlock::water_type` (get_block_water_type:346446).
    fn water_type(&self) -> WaterType;
    /// `CLandBlockStruct::calc_water_depth(cell_id, point)`
    /// (get_water_depth:347252).
    fn calc_water_depth(&self, cell_id: u32, point: Vector3) -> f32;
}

/// Seam — the `CELLARRAY` 3×3 ring the driver sweeps. `find_cell_list` /
/// `find_transit_cells` operate on this contract; `super::types::CellArray`
/// implements it (see the bridge below).
pub trait CellArrayApi {
    /// `CELLARRAY::num_cells`.
    fn num_cells(&self) -> usize;
    /// `cell_array->cells.data[idx].cell` (owned handle; `None` = null slot).
    fn cell_at(&self, idx: usize) -> Option<Rc<dyn CObjCell>>;
    /// `cell_array->cells.data[idx].cell_id`.
    fn cell_id_at(&self, idx: usize) -> u32;
    /// `CELLARRAY::add_cell(cell_id, cell)`.
    fn add_cell(&mut self, cell_id: u32, cell: Option<Rc<dyn CObjCell>>);
    /// `CELLARRAY::remove_cell(idx)`.
    fn remove_cell(&mut self, idx: usize);
    /// `cell_array->num_cells = n` (used only to reset to 0 at entry).
    fn set_num_cells(&mut self, n: usize);
    /// `cell_array->added_outside = v`.
    fn set_added_outside(&mut self, v: bool);
    /// `cell_array->do_not_load_cells`.
    fn do_not_load_cells(&self) -> bool;
}

/// Seam — the cell-resolver world (`holtburger-world`'s `SpatialScene` later).
/// Holds the statics `find_cell_list` reaches.
pub trait CellWorld {
    /// `CObjCell::GetVisible(cell_id)` (acclient.c:346417). The decomp splits
    /// `CEnvCell::GetVisible` (interior, id&0xFFFF>=0x100) vs `CLandCell::Get`
    /// (outdoor); the scene resolves both. `None` if the cell is not loaded.
    fn get_visible(&self, cell_id: u32) -> Option<Rc<dyn CObjCell>>;
    /// `CLandCell::add_all_outside_cells` (landscape agent) — append the
    /// outdoor terrain cells the sphere(s) overlap to `cell_array`.
    fn add_all_outside_cells(
        &self,
        p: &Position,
        num_sphere: u32,
        spheres: &[Sphere],
        cell_array: &mut dyn CellArrayApi,
    );
    /// `LandDefs::get_block_offset(base, other)` — landblock delta between two
    /// cell ids (zero within one landblock).
    fn block_offset(&self, base_cell: u32, other_cell: u32) -> Vector3;
}

// ─── The CObjCell abstraction ────────────────────────────────────────────────

/// `CObjCell` (`acclient.h`) — the swept-collision cell abstraction the
/// transition driver consumes and `holtburger-world`'s `SpatialScene`
/// implements (cells / buildings / portals / triangles).
///
/// Required methods = the decomp vtable (`vfptr[5]`/`vfptr[6]` collision slots
/// + the state accessors the base methods read). Provided methods = the
/// decomp-faithful non-virtual base methods.
pub trait CObjCell {
    // ── identity / state accessors (decomp instance fields) ──
    /// `this->m_DID.id` / `pos.objcell_id` — the cell id.
    fn id(&self) -> u32;
    /// `this->pos` — the cell's `Position` (frame). Read by the driver's
    /// `SPHEREPATH::cache_localspace_sphere(&cell->pos, scale)`.
    fn pos(&self) -> &Position;
    /// `this->water_type`.
    fn water_type(&self) -> WaterType;
    /// `this->myLandBlock_` (`None` = no owning landblock).
    fn cur_landblock(&self) -> Option<Rc<dyn LandblockRef>>;
    /// `this->restriction_obj` (0 = none).
    fn restriction_obj(&self) -> u32;
    /// `this->object_list` (`num_objects` entries).
    fn objects(&self) -> &[Rc<dyn PhysicsObjRef>];
    /// `this->shadow_object_list[i]->physobj` (`num_shadow_objects` entries),
    /// already projected to the physics objects the base methods iterate.
    fn shadow_objects(&self) -> &[Rc<dyn PhysicsObjRef>];
    /// `((CEnvCell*)this)->stab_list` — the visible/stab cell ids; non-empty
    /// only for interior env cells (the `find_cell_list` prune tail).
    fn visible_cells(&self) -> Vec<u32> {
        Vec::new()
    }

    // ── collision vtable (required virtuals) ──
    /// `vfptr[5].QueryInterface` — `point_in_cell(point)` (CEnvCell:347935 /
    /// CLandCell:354881). Base `CObjCell` returns false.
    fn point_in_cell(&self, point: Vector3) -> bool {
        // acclient: base is pure-virtual; ACE base returns false.
        let _ = point;
        false
    }
    /// `vfptr[5].IUnknown_Release` — `find_transit_cells` (CEnvCell:348250 /
    /// CLandCell:355423). Base aborts (`Turbine::Debug::Abort()`, 346661); the
    /// env/land overrides are the landscape agent's domain, so this is required.
    fn find_transit_cells(
        &self,
        p: &Position,
        num_sphere: u32,
        spheres: &[Sphere],
        cell_array: &mut dyn CellArrayApi,
        path: Option<&mut SpherePath>,
    );
    /// Cell-level `find_collisions(transition)` (CEnvCell:347810 /
    /// CLandCell:354887). Runs environment/terrain collisions then
    /// `find_obj_collisions`. The concrete bodies live with the landscape/
    /// driver agents; this is the contract the driver calls. Returns a code.
    fn find_collisions(&self, transition: &mut CTransition) -> i32;
    /// `vfptr[6].QueryInterface` — `handle_move_restriction(transition)`
    /// (check_entry_restrictions:347132). Base/env return value is ignored by
    /// the caller (void cast). Default no-op (CObjCell base).
    fn handle_move_restriction(&self, transition: &mut CTransition) {
        let _ = transition;
    }

    // ── non-virtual base methods (decomp-faithful default impls) ──

    /// `CObjCell::get_block_water_type` (acclient.c:346439).
    fn get_block_water_type(&self) -> WaterType {
        // v1 = myLandBlock_; v1 ? v1->water_type : NOT_WATER
        match self.cur_landblock() {
            Some(lb) => lb.water_type(),
            None => WaterType::NotWater,
        }
    }

    /// `CObjCell::get_water_depth` (acclient.c:347233).
    fn get_water_depth(&self, point: Vector3) -> f32 {
        // v2 = water_type; NOT_WATER→0. v3 = v2-1: if(v3){ v3==1?0.9:0.0 }
        //                                          else /*PARTIALLY*/ landblock.
        match self.water_type() {
            WaterType::NotWater => 0.0,
            WaterType::EntirelyWater => 0.89999998, // v3==1
            WaterType::PartiallyWater => {
                // v3==0: myLandBlock_ ? calc_water_depth(m_DID.id, point) : 0.1
                match self.cur_landblock() {
                    Some(lb) => lb.calc_water_depth(self.id(), point),
                    None => 0.1,
                }
            }
        }
    }

    /// `CObjCell::get_object` (acclient.c:347259).
    fn get_object(&self, obj_iid: u32) -> Option<Rc<dyn PhysicsObjRef>> {
        // for object_list[i]: if (*v4 && result->id == obj_iid) return result.
        for obj in self.objects() {
            if obj.id() == obj_iid {
                return Some(obj.clone());
            }
        }
        None
    }

    /// `CObjCell::find_obj_collisions` (acclient.c:347142).
    fn find_obj_collisions(&self, transition: &mut CTransition) -> i32 {
        let mut result = TransitionState::Ok as i32; // result = 1
        // if (sphere_path.insert_type != 2 /* InitialPlacement */)
        if transition.sphere_path.insert_type != InsertType::InitialPlacement {
            // SEAM A13: shadow_object_list[i]->physobj
            for shadow in self.shadow_objects() {
                // if (!v5->parent && v5 != object_info.object)
                if !shadow.has_parent() && shadow.id() != transition.object_info.object_id {
                    result = shadow.find_obj_collisions(transition);
                    if result != TransitionState::Ok as i32 {
                        break; // first non-OK wins
                    }
                }
            }
        }
        result
    }

    /// `CObjCell::check_entry_restrictions` (acclient.c:347103).
    ///
    /// `objects` injects `CPhysicsObj::GetObjectA` (the decomp's ambient global).
    /// The moving object is `transition->object_info.object`: until A11/A13
    /// promote `ObjectInfo` to carry the handle, it is resolved here from
    /// `object_info.object_id` (id 0 ⇒ no object ⇒ Collided, matching `!object`).
    fn check_entry_restrictions(
        &self,
        transition: &mut CTransition,
        objects: &dyn ObjectManager,
    ) -> i32 {
        // if (!transition->object_info.object) return 2;
        let object = match objects.get_object_a(transition.object_info.object_id) {
            Some(o) => o,
            None => return TransitionState::Collided as i32,
        };
        // v3 = object->weenie_obj; if (v3) { ... }
        if let Some(weenie) = object.weenie() {
            // v4 = weenie->CanBypassMoveRestrictions(); (vfptr[18])
            let can_bypass = weenie.can_bypass_move_restrictions();
            // if (BYTE1(state) & 1)  -> state & 0x100 == IS_PLAYER
            if transition.object_info.state & object_info_state::IS_PLAYER != 0 {
                // if (restriction_obj && !v4)
                if self.restriction_obj() != 0 && !can_bypass {
                    // v6 = GetObjectA(restriction_obj); if (!v6) return 2;
                    let restriction = match objects.get_object_a(self.restriction_obj()) {
                        Some(r) => r,
                        None => return TransitionState::Collided as i32,
                    };
                    // v7 = v6->weenie_obj; if (!v7) return 2;
                    let rweenie = match restriction.weenie() {
                        Some(w) => w,
                        None => return TransitionState::Collided as i32,
                    };
                    // if (!v7->CanMoveInto(v3)) { handle_move_restriction; return 2; }
                    if !rweenie.can_move_into(weenie.as_ref()) {
                        self.handle_move_restriction(transition);
                        return TransitionState::Collided as i32;
                    }
                }
            }
        }
        TransitionState::Ok as i32 // return 1
    }
}

// ─── find_cell_list — the static __cdecl dispatcher ──────────────────────────

/// `CObjCell::find_cell_list(Position*, num_sphere, CSphere*, CELLARRAY*,
/// CObjCell**, SPHEREPATH*)` (acclient.c:346961) — the static dispatcher that
/// fills `cell_array` with every cell the swept sphere(s) touch and (if
/// requested) reports the current cell.
///
/// `curr_cell`/`path` are `Option` because the decomp pointers are nullable
/// (the cyl/sphere forwarders pass `0`).
#[allow(clippy::too_many_arguments)]
pub fn find_cell_list(
    world: &dyn CellWorld,
    p: &Position,
    num_sphere: u32,
    spheres: &[Sphere],
    cell_array: &mut dyn CellArrayApi,
    mut curr_cell: Option<&mut Option<Rc<dyn CObjCell>>>,
    mut path: Option<&mut SpherePath>,
) {
    // cell_array->num_cells = 0; added_outside = 0;
    cell_array.set_num_cells(0);
    cell_array.set_added_outside(false);

    // v8 = p->objcell_id; if (v8) { GetVisible(interior) / Get(outdoor) }
    let visible_cell = if p.objcell_id != 0 {
        world.get_visible(p.objcell_id)
    } else {
        None
    };

    if (p.objcell_id & 0xFFFF) >= 0x100 {
        // interior: path->hits_interior_cell = 1; add the visible env cell.
        if let Some(path) = path.as_deref_mut() {
            path.hits_interior_cell = true;
        }
        cell_array.add_cell(p.objcell_id, visible_cell.clone());
    } else {
        // outdoor: landscape fills the terrain ring.
        world.add_all_outside_cells(p, num_sphere, spheres, &mut *cell_array);
    }

    // if (cell_arraya && num_sphere)
    if visible_cell.is_some() && num_sphere != 0 {
        // (a) flood transit cells. num_cells is re-read each step, so cells a
        //     find_transit_cells appends are visited in turn (the decomp's
        //     `while (v9 < v7->num_cells)`).
        let mut i = 0;
        while i < cell_array.num_cells() {
            if let Some(cell) = cell_array.cell_at(i) {
                // cloning the Rc releases the &cell_array borrow before the
                // &mut cell_array call (decomp uses raw pointers).
                cell.find_transit_cells(p, num_sphere, spheres, &mut *cell_array, path.as_deref_mut());
            }
            i += 1;
        }

        // (b) if (curr_cell): the last point_in_cell match; an interior match
        //     short-circuits and re-flags hits_interior_cell.
        if let Some(curr) = curr_cell.as_deref_mut() {
            *curr = None;
            let mut found_interior = false;
            let mut j = 0;
            while j < cell_array.num_cells() {
                if let Some(cell) = cell_array.cell_at(j) {
                    // localpoint = sphere->center - get_block_offset(p, cell)
                    let block_offset = world.block_offset(p.objcell_id, cell.id());
                    let local_point = spheres[0].center - block_offset;
                    if cell.point_in_cell(local_point) {
                        *curr = Some(cell.clone());
                        if (cell.id() & 0xFFFF) >= 0x100 {
                            found_interior = true;
                            break;
                        }
                    }
                }
                j += 1;
            }
            if found_interior {
                if let Some(path) = path.as_deref_mut() {
                    path.hits_interior_cell = true;
                }
            }
        }
    }

    // (c) LABEL_25: do_not_load_cells prune for interior sweeps — keep the
    //     visible cell and any cell in its stab list, drop the rest. (Ported
    //     from the ACE-faithful form of the decomp's cell_arraya pointer walk.)
    if cell_array.do_not_load_cells() && (p.objcell_id & 0xFFFF) >= 0x100 {
        if let Some(vis) = visible_cell.as_ref() {
            let stabs = vis.visible_cells();
            let mut k = 0;
            while k < cell_array.num_cells() {
                let cid = cell_array.cell_id_at(k);
                if cid == vis.id() || stabs.contains(&cid) {
                    k += 1; // keep
                } else {
                    cell_array.remove_cell(k); // shifts next into k; don't advance
                }
            }
        }
    }
}

// ─── Bridge: super::types::CellArray satisfies the A10 CellArrayApi seam ──────

/// `CellArray` (A08 struct shape, `super::types`) implements the A10 collision
/// contract so the driver's `find_cell_list` can sweep it. Keeps the invariant
/// `num_cells == cells.len()` (the inherent `add_cell`/`remove_cell` maintain
/// it; `set_num_cells` truncates so the `num_cells = 0` reset at the head of
/// `find_cell_list` clears the backing `Vec` too).
impl CellArrayApi for CellArray {
    fn num_cells(&self) -> usize {
        self.num_cells as usize
    }
    fn cell_at(&self, idx: usize) -> Option<ObjCellHandle> {
        self.cells[idx].cell.clone()
    }
    fn cell_id_at(&self, idx: usize) -> u32 {
        self.cells[idx].cell_id
    }
    fn add_cell(&mut self, cell_id: u32, cell: Option<ObjCellHandle>) {
        CellArray::add_cell(self, cell_id, cell);
    }
    fn remove_cell(&mut self, idx: usize) {
        CellArray::remove_cell(self, idx);
    }
    fn set_num_cells(&mut self, n: usize) {
        // The decomp resets `num_cells = 0` without freeing the DArray buffer;
        // in the Vec model the backing storage IS the count, so truncate to
        // keep `num_cells == cells.len()`. Only ever called with `n == 0`.
        self.cells.truncate(n);
        self.num_cells = self.cells.len() as u32;
    }
    fn set_added_outside(&mut self, v: bool) {
        self.added_outside = v;
    }
    fn do_not_load_cells(&self) -> bool {
        self.do_not_load_cells
    }
}

// ─── A09 — CELLARRAY container methods (acclient.c:718896 / 718762 / 346989) ──

impl CellArray {
    /// `CELLARRAY::add_cell` (acclient.c:718896). Linear-search dedup on
    /// `cell_id`; if absent, append. The decomp's explicit `DArray::grow`
    /// (capacity bump by 8 when `num_cells >= sizeOf`) is `Vec::push`'s job.
    /// Maintains `num_cells == cells.len()`.
    pub fn add_cell(&mut self, cell_id: u32, cell: Option<ObjCellHandle>) {
        // while ( cell_id != v6->cell_id ) ... ; a full scan without a match (or
        // an empty array) falls through to LABEL_5 → append.
        if self.cells.iter().any(|c| c.cell_id == cell_id) {
            return;
        }
        self.cells.push(CellInfo { cell_id, cell });
        self.num_cells = self.cells.len() as u32;
    }

    /// `CELLARRAY::remove_cell` (acclient.c:718762). **Swap-remove**: the LAST
    /// element overwrites `index`, then the count shrinks (the decomp copies
    /// `cells[num_cells-1]` into `cells[index]` and does `--num_cells`). Order
    /// is NOT preserved — this is the decomp's exact behavior, NOT an ordered
    /// `Vec::remove`. No-op when empty or out of range.
    pub fn remove_cell(&mut self, index: usize) {
        if !self.cells.is_empty() && index < self.cells.len() {
            self.cells.swap_remove(index);
            self.num_cells = self.cells.len() as u32;
        }
    }

    /// Head of `find_cell_list` (acclient.c:346989): `num_cells = 0;
    /// added_outside = 0;`. (`do_not_load_cells` is intentionally NOT reset.)
    pub fn reset(&mut self) {
        self.cells.clear();
        self.num_cells = 0;
        self.added_outside = false;
    }
}

// ─── A09 — outdoor cell-ring assembly (acclient.c:354975 / 533260 / 355346) ───

/// Landblock = 8×8 cells; each cell is 24 units; block = 192 units.
pub const CELL_SIZE: f32 = 24.0;
pub const LCOORD_MAX: i32 = 2040; // 255 landblocks * 8 cells

/// SEAM (landscape): the global landscape cell lookup (`LScape::get_landcell`,
/// reached via `CLandCell::Get`). holtburger-world's `SpatialScene` implements
/// it (and `CellWorld` above) over the same cell registry. NOTE: the decomp
/// still *adds the entry* on `None` (cell ptr null); callers rely on that.
pub trait Landscape {
    /// `CLandCell::Get` → `LScape::get_landcell` — outdoor cell for an id, or
    /// `None` when that landblock isn't resident.
    fn get_landcell(&self, cell_id: u32) -> Option<ObjCellHandle>;
}

/// SEAM (LandDefs): the one cross-landblock coordinate helper the sphere ring
/// needs. `LandDefs::get_block_offset` is the pure static in `super::types`;
/// `adjust_to_outside` snaps a point into its outdoor landblock and stays a
/// seam. (A09's `LandDefs` trait is renamed here to `LandDefsSeam` so it does
/// not collide with `super::types::LandDefs`, the get_block_offset owner.)
pub trait LandDefsSeam {
    /// `LandDefs::adjust_to_outside` (acclient.c:467434): snap `loc` to the
    /// outdoor landblock that actually contains it. Returns the wrapped outdoor
    /// cell id and rewrites `loc` to block-local `[0,192)` coords; `None` if
    /// `cell_id` isn't a wrappable outdoor/structure cell.
    fn adjust_to_outside(&self, cell_id: u32, loc: &mut Vector3) -> Option<u32>;
}

/// Inline formula from `CLandCell::add_outside_cell` (acclient.c:354981) and
/// `add_cell_block` (533200): global landcell `(x,y)` → outdoor cell id.
/// High word = landblock id `((x>>3)<<8)|(y>>3)`; low word = 1-based in-block
/// cell index `(y&7) + 8*(x&7) + 1`.
#[inline]
pub fn lcoord_to_cellid(x: i32, y: i32) -> u32 {
    let xu = x as u32;
    let yu = y as u32;
    (((yu >> 3) | (32 * (xu & 0xFFFF_FFF8))) << 16) | ((yu & 7) + 8 * (xu & 7) + 1)
}

/// `LandDefs::gid_to_lcoord` (acclient.c) — outdoor cell id → `(x,y)` in
/// `[0,2040)`. `None` for interior ids (`low u16 >= 0x100`) or out-of-range.
#[inline]
pub fn gid_to_lcoord(cell_id: u32) -> Option<(i32, i32)> {
    if (cell_id & 0xFFFF) >= 0x100 {
        return None;
    }
    let mut x = ((cell_id >> 21) & 0x7F8) as i32;
    let mut y = (8 * ((cell_id >> 16) & 0xFF)) as i32; // 8 * BYTE2
    x += ((cell_id & 0xFFFF).wrapping_sub(1) >> 3) as i32;
    y += (cell_id.wrapping_sub(1) & 7) as i32;
    if (0..LCOORD_MAX).contains(&x) && (0..LCOORD_MAX).contains(&y) {
        Some((x, y))
    } else {
        None
    }
}

/// `CLandCell::add_outside_cell` (acclient.c:354975). Bounds-gate, build the
/// cell id from `(x,y)`, look it up, and add the entry. Faithful detail: the
/// entry is added even when `get_landcell` returns `None` (decomp passes the
/// possibly-null pointer straight to `add_cell`).
pub fn add_outside_cell<L: Landscape>(cell_array: &mut CellArray, landscape: &L, x: i32, y: i32) {
    if x >= 0 && y >= 0 && x < LCOORD_MAX && y < LCOORD_MAX {
        let cell_id = lcoord_to_cellid(x, y);
        let cell = landscape.get_landcell(cell_id);
        cell_array.add_cell(cell_id, cell);
    }
}

/// `CLandCell::add_cell_block` (acclient.c:5331D0). Rectangle `[min..=max]` of
/// landcells (the multi-part bounding-box ring). Same id math + bounds gate as
/// `add_outside_cell`, inlined per the decomp.
pub fn add_cell_block<L: Landscape>(
    cell_array: &mut CellArray,
    landscape: &L,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
) {
    let mut i = min_x;
    while i <= max_x {
        let mut j = min_y;
        while j <= max_y {
            add_outside_cell(cell_array, landscape, i, j);
            j += 1;
        }
        i += 1;
    }
}

/// `CLandCell::check_add_cell_boundary` (acclient.c:533260). THE neighbor ring.
/// `pt` is the in-cell position `[0,24)`; `incell_max = 24 - radius`,
/// `incell_min = radius`. When the sphere centered at `pt` overflows a cell
/// edge (within `radius` of it), pull in the adjacent cell(s) — including the
/// ≤3 diagonal corners. This is exactly the "check NEIGHBOR cells, not just the
/// current one" rule for building/terrain collision.
pub fn check_add_cell_boundary<L: Landscape>(
    cell_array: &mut CellArray,
    landscape: &L,
    pt: (f32, f32), // decomp Vec2D
    x: i32,
    y: i32,
    incell_max: f32,
    incell_min: f32,
) {
    if pt.0 > incell_max {
        add_outside_cell(cell_array, landscape, x + 1, y);
        if pt.1 > incell_max {
            add_outside_cell(cell_array, landscape, x + 1, y + 1);
        }
        if pt.1 < incell_min {
            add_outside_cell(cell_array, landscape, x + 1, y - 1);
        }
    }
    if pt.0 < incell_min {
        add_outside_cell(cell_array, landscape, x - 1, y);
        if pt.1 > incell_max {
            add_outside_cell(cell_array, landscape, x - 1, y + 1);
        }
        if pt.1 < incell_min {
            add_outside_cell(cell_array, landscape, x - 1, y - 1);
        }
    }
    if pt.1 > incell_max {
        add_outside_cell(cell_array, landscape, x, y + 1);
    }
    if pt.1 < incell_min {
        add_outside_cell(cell_array, landscape, x, y - 1);
    }
}

/// `CLandCell::add_all_outside_cells(Position*, num_sphere, CSphere*, CELLARRAY*)`
/// (acclient.c:355346) — the sphere-driven outdoor ring used by the transition
/// driver (the `CellWorld::add_all_outside_cells` seam's concrete body).
/// Guarded by `added_outside`. For each sphere: snap into its landblock
/// (`adjust_to_outside`), find the landcell `(x,y)` and in-cell offset `pt1`,
/// add the center landcell, then `check_add_cell_boundary` for the ring.
pub fn add_all_outside_cells_sphere<L: Landscape, D: LandDefsSeam>(
    cell_array: &mut CellArray,
    landscape: &L,
    land: &D,
    p: &Position,
    num_sphere: u32,
    sphere: &[Sphere],
) {
    if cell_array.added_outside {
        return;
    }
    cell_array.added_outside = true;

    if num_sphere != 0 {
        // for ( i = 0; i < num_sphere; ++i ) — v5 strides 16 bytes = one CSphere.
        for s in sphere.iter().take(num_sphere as usize) {
            // point = sphere[i].center
            let mut point = s.center;
            // pt_cell = p->objcell_id; if !adjust_to_outside(...) break;
            let pt_cell = match land.adjust_to_outside(p.objcell_id, &mut point) {
                Some(id) => id,
                None => break,
            };
            // xc = floor(point.x/24); yc = floor(point.y/24)  (in-block cell)
            let xc = (point.x / CELL_SIZE).floor();
            let yc = (point.y / CELL_SIZE).floor();
            let min_rad = s.radius; // incell_min
            // pt1 = in-cell offset [0,24)
            let pt1 = (point.x - xc * CELL_SIZE, point.y - yc * CELL_SIZE);
            let max_rad = CELL_SIZE - min_rad; // incell_max
            // (x,y) = gid_to_lcoord(pt_cell) — the GLOBAL landcell of pt_cell.
            if let Some((x, y)) = gid_to_lcoord(pt_cell) {
                add_outside_cell(cell_array, landscape, x, y);
                check_add_cell_boundary(cell_array, landscape, pt1, x, y, max_rad, min_rad);
            }
        }
    } else {
        // num_sphere == 0: a single point at the frame origin, center cell only.
        let mut point = p.frame.origin;
        if let Some(id) = land.adjust_to_outside(p.objcell_id, &mut point) {
            if let Some((x, y)) = gid_to_lcoord(id) {
                add_outside_cell(cell_array, landscape, x, y);
            }
        }
    }
}

// ─── Tests (A10 abstraction + bridge / CELLARRAY methods) ────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{object_info_state, CTransition, InsertType, Position};
    use std::cell::RefCell;
    use std::rc::Rc;

    // ── mock weenie / physics object / object manager (A13 seam) ──
    struct MockWeenie {
        bypass: bool,
        can_move_into: bool,
    }
    impl WeenieObjRef for MockWeenie {
        fn can_bypass_move_restrictions(&self) -> bool {
            self.bypass
        }
        fn can_move_into(&self, _other: &dyn WeenieObjRef) -> bool {
            self.can_move_into
        }
    }

    struct MockObj {
        id: u32,
        parent: bool,
        weenie: Option<Rc<dyn WeenieObjRef>>,
        coll_code: i32, // FindObjCollisions result
    }
    impl PhysicsObjRef for MockObj {
        fn id(&self) -> u32 {
            self.id
        }
        fn has_parent(&self) -> bool {
            self.parent
        }
        fn weenie(&self) -> Option<Rc<dyn WeenieObjRef>> {
            self.weenie.clone()
        }
        fn find_obj_collisions(&self, _t: &mut CTransition) -> i32 {
            self.coll_code
        }
    }

    #[derive(Default)]
    struct MockMgr {
        table: Vec<(u32, Rc<dyn PhysicsObjRef>)>,
    }
    impl ObjectManager for MockMgr {
        fn get_object_a(&self, iid: u32) -> Option<Rc<dyn PhysicsObjRef>> {
            if iid == 0 {
                return None;
            }
            self.table.iter().find(|(k, _)| *k == iid).map(|(_, v)| v.clone())
        }
    }

    // ── mock landblock (water seam) ──
    struct MockLb {
        wt: WaterType,
        depth: f32,
    }
    impl LandblockRef for MockLb {
        fn water_type(&self) -> WaterType {
            self.wt
        }
        fn calc_water_depth(&self, _cell_id: u32, _p: Vector3) -> f32 {
            self.depth
        }
    }

    // ── mock cell ──
    #[derive(Default)]
    struct MockCell {
        id: u32,
        pos: Position,
        water_type: WaterType,
        landblock: Option<Rc<dyn LandblockRef>>,
        restriction_obj: u32,
        objects: Vec<Rc<dyn PhysicsObjRef>>,
        shadows: Vec<Rc<dyn PhysicsObjRef>>,
        stabs: Vec<u32>,
        transit: Vec<u32>, // cells this cell's find_transit_cells appends
        in_cell: bool,     // point_in_cell answer
    }
    impl CObjCell for MockCell {
        fn id(&self) -> u32 {
            self.id
        }
        fn pos(&self) -> &Position {
            &self.pos
        }
        fn water_type(&self) -> WaterType {
            self.water_type
        }
        fn cur_landblock(&self) -> Option<Rc<dyn LandblockRef>> {
            self.landblock.clone()
        }
        fn restriction_obj(&self) -> u32 {
            self.restriction_obj
        }
        fn objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
            &self.objects
        }
        fn shadow_objects(&self) -> &[Rc<dyn PhysicsObjRef>] {
            &self.shadows
        }
        fn visible_cells(&self) -> Vec<u32> {
            self.stabs.clone()
        }
        fn point_in_cell(&self, _p: Vector3) -> bool {
            self.in_cell
        }
        fn find_transit_cells(
            &self,
            _p: &Position,
            _n: u32,
            _s: &[Sphere],
            ca: &mut dyn CellArrayApi,
            _path: Option<&mut SpherePath>,
        ) {
            // mock portal walk: append the configured transit cell ids (null
            // handles — only their ids matter to the prune).
            for &id in &self.transit {
                ca.add_cell(id, None);
            }
        }
        fn find_collisions(&self, _t: &mut CTransition) -> i32 {
            TransitionState::Ok as i32
        }
    }

    fn s0() -> Sphere {
        Sphere { center: Vector3::zero(), radius: 1.0 }
    }

    // ── get_block_water_type / get_water_depth (346439 / 347233) ──
    #[test]
    fn water_type_and_depth_cover_all_branches() {
        let c = MockCell::default();
        assert_eq!(c.get_block_water_type(), WaterType::NotWater);

        let c = MockCell {
            landblock: Some(Rc::new(MockLb { wt: WaterType::EntirelyWater, depth: 0.0 })),
            ..Default::default()
        };
        assert_eq!(c.get_block_water_type(), WaterType::EntirelyWater);

        let c = MockCell { water_type: WaterType::NotWater, ..Default::default() };
        assert_eq!(c.get_water_depth(Vector3::zero()), 0.0);

        let c = MockCell { water_type: WaterType::EntirelyWater, ..Default::default() };
        assert!((c.get_water_depth(Vector3::zero()) - 0.89999998).abs() < 1e-6);

        let c = MockCell {
            water_type: WaterType::PartiallyWater,
            landblock: Some(Rc::new(MockLb { wt: WaterType::PartiallyWater, depth: 0.42 })),
            ..Default::default()
        };
        assert!((c.get_water_depth(Vector3::zero()) - 0.42).abs() < 1e-6);

        let c = MockCell { water_type: WaterType::PartiallyWater, ..Default::default() };
        assert!((c.get_water_depth(Vector3::zero()) - 0.1).abs() < 1e-6);
    }

    // ── get_object (347259) ──
    #[test]
    fn get_object_scans_by_id() {
        let a: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 7, parent: false, weenie: None, coll_code: 1 });
        let b: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 9, parent: false, weenie: None, coll_code: 1 });
        let c = MockCell { objects: vec![a, b], ..Default::default() };
        assert_eq!(c.get_object(9).map(|o| o.id()), Some(9));
        assert!(c.get_object(123).is_none());
        assert!(MockCell::default().get_object(1).is_none());
    }

    // ── find_obj_collisions (347142) ──
    #[test]
    fn find_obj_collisions_branches() {
        let mut t = CTransition::default();
        t.object_info.object_id = 100;

        t.sphere_path.insert_type = InsertType::InitialPlacement;
        let other: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 1, parent: false, weenie: None, coll_code: 2 });
        let c = MockCell { shadows: vec![other.clone()], ..Default::default() };
        assert_eq!(c.find_obj_collisions(&mut t), TransitionState::Ok as i32);

        t.sphere_path.insert_type = InsertType::Transition;
        let parented: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 1, parent: true, weenie: None, coll_code: 2 });
        let myself: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 100, parent: false, weenie: None, coll_code: 2 });
        let hit: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 2, parent: false, weenie: None, coll_code: TransitionState::Collided as i32 });
        let c = MockCell { shadows: vec![parented, myself, hit], ..Default::default() };
        assert_eq!(c.find_obj_collisions(&mut t), TransitionState::Collided as i32);

        let clear: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 3, parent: false, weenie: None, coll_code: 1 });
        let c = MockCell { shadows: vec![clear], ..Default::default() };
        assert_eq!(c.find_obj_collisions(&mut t), TransitionState::Ok as i32);
    }

    // ── check_entry_restrictions (347103) ──
    #[test]
    fn check_entry_restrictions_branches() {
        let cell = MockCell { restriction_obj: 5, ..Default::default() };
        let mut t = CTransition::default();
        t.object_info.object_id = 0;
        let mgr = MockMgr::default();
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Collided as i32);

        let obj: Rc<dyn PhysicsObjRef> = Rc::new(MockObj { id: 100, parent: false, weenie: None, coll_code: 1 });
        let mgr = MockMgr { table: vec![(100, obj)] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::IS_PLAYER;
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Ok as i32);

        let player = |bypass: bool| -> Rc<dyn PhysicsObjRef> {
            Rc::new(MockObj {
                id: 100,
                parent: false,
                weenie: Some(Rc::new(MockWeenie { bypass, can_move_into: false })),
                coll_code: 1,
            })
        };

        let mgr = MockMgr { table: vec![(100, player(false))] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::DEFAULT;
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Ok as i32);

        let cell0 = MockCell { restriction_obj: 0, ..Default::default() };
        let mgr = MockMgr { table: vec![(100, player(false))] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::IS_PLAYER;
        assert_eq!(cell0.check_entry_restrictions(&mut t, &mgr), TransitionState::Ok as i32);

        let mgr = MockMgr { table: vec![(100, player(true))] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::IS_PLAYER;
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Ok as i32);

        let mgr = MockMgr { table: vec![(100, player(false))] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::IS_PLAYER;
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Collided as i32);

        let restriction_deny: Rc<dyn PhysicsObjRef> = Rc::new(MockObj {
            id: 5,
            parent: false,
            weenie: Some(Rc::new(MockWeenie { bypass: false, can_move_into: false })),
            coll_code: 1,
        });
        let mgr = MockMgr { table: vec![(100, player(false)), (5, restriction_deny)] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::IS_PLAYER;
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Collided as i32);

        let restriction_ok: Rc<dyn PhysicsObjRef> = Rc::new(MockObj {
            id: 5,
            parent: false,
            weenie: Some(Rc::new(MockWeenie { bypass: false, can_move_into: true })),
            coll_code: 1,
        });
        let mgr = MockMgr { table: vec![(100, player(false)), (5, restriction_ok)] };
        let mut t = CTransition::default();
        t.object_info.object_id = 100;
        t.object_info.state = object_info_state::IS_PLAYER;
        assert_eq!(cell.check_entry_restrictions(&mut t, &mgr), TransitionState::Ok as i32);
    }

    // ── find_cell_list (346961) ──

    // minimal CellArrayApi mock: ordered (id, cell) slots + the two flags.
    #[derive(Default)]
    struct MockArray {
        slots: Vec<(u32, Option<Rc<dyn CObjCell>>)>,
        added_outside: bool,
        do_not_load: bool,
    }
    impl CellArrayApi for MockArray {
        fn num_cells(&self) -> usize {
            self.slots.len()
        }
        fn cell_at(&self, idx: usize) -> Option<Rc<dyn CObjCell>> {
            self.slots.get(idx).and_then(|(_, c)| c.clone())
        }
        fn cell_id_at(&self, idx: usize) -> u32 {
            self.slots[idx].0
        }
        fn add_cell(&mut self, cell_id: u32, cell: Option<Rc<dyn CObjCell>>) {
            self.slots.push((cell_id, cell));
        }
        fn remove_cell(&mut self, idx: usize) {
            self.slots.remove(idx);
        }
        fn set_num_cells(&mut self, n: usize) {
            self.slots.truncate(n);
        }
        fn set_added_outside(&mut self, v: bool) {
            self.added_outside = v;
        }
        fn do_not_load_cells(&self) -> bool {
            self.do_not_load
        }
    }

    // world: id→cell registry; outdoor fill drops in configured cells.
    struct MockWorld {
        registry: Vec<(u32, Rc<dyn CObjCell>)>,
        outdoor_fill: RefCell<Vec<(u32, Rc<dyn CObjCell>)>>,
    }
    impl CellWorld for MockWorld {
        fn get_visible(&self, cell_id: u32) -> Option<Rc<dyn CObjCell>> {
            self.registry.iter().find(|(k, _)| *k == cell_id).map(|(_, v)| v.clone())
        }
        fn add_all_outside_cells(
            &self,
            _p: &Position,
            _n: u32,
            _s: &[Sphere],
            ca: &mut dyn CellArrayApi,
        ) {
            ca.set_added_outside(true);
            for (id, c) in self.outdoor_fill.borrow().iter() {
                ca.add_cell(*id, Some(c.clone()));
            }
        }
        fn block_offset(&self, _b: u32, _o: u32) -> Vector3 {
            Vector3::zero()
        }
    }

    fn cell(id: u32, in_cell: bool) -> Rc<dyn CObjCell> {
        Rc::new(MockCell { id, in_cell, ..Default::default() })
    }

    #[test]
    fn find_cell_list_interior_seeds_and_flags_path() {
        let env_id = 0x0001_0101; // (id & 0xFFFF) = 0x0101 >= 0x100 → interior
        let env = cell(env_id, true);
        let world = MockWorld {
            registry: vec![(env_id, env.clone())],
            outdoor_fill: RefCell::new(vec![]),
        };
        let p = Position { objcell_id: env_id, ..Default::default() };
        let mut arr = MockArray::default();
        let mut curr: Option<Rc<dyn CObjCell>> = None;
        let mut path = SpherePath::default();

        find_cell_list(&world, &p, 1, &[s0()], &mut arr, Some(&mut curr), Some(&mut path));

        assert_eq!(arr.num_cells(), 1);
        assert_eq!(arr.cell_id_at(0), env_id);
        assert!(path.hits_interior_cell);
        assert_eq!(curr.map(|c| c.id()), Some(env_id));
    }

    #[test]
    fn find_cell_list_outdoor_uses_add_all_outside_cells() {
        let land_id = 0x1234_0001; // (id & 0xFFFF) = 1 < 0x100 → outdoor
        let land = cell(land_id, true);
        let world = MockWorld {
            registry: vec![(land_id, land.clone())],
            outdoor_fill: RefCell::new(vec![(land_id, land.clone())]),
        };
        let p = Position { objcell_id: land_id, ..Default::default() };
        let mut arr = MockArray::default();
        let mut curr: Option<Rc<dyn CObjCell>> = None;

        find_cell_list(&world, &p, 1, &[s0()], &mut arr, Some(&mut curr), None);

        assert!(arr.added_outside);
        assert_eq!(arr.num_cells(), 1);
        assert_eq!(curr.map(|c| c.id()), Some(land_id));
    }

    #[test]
    fn find_cell_list_curr_cell_skips_non_matching() {
        let env_id = 0x0001_0105;
        let env = cell(env_id, false); // point_in_cell == false → not selected
        let world = MockWorld {
            registry: vec![(env_id, env.clone())],
            outdoor_fill: RefCell::new(vec![]),
        };
        let p = Position { objcell_id: env_id, ..Default::default() };
        let mut arr = MockArray::default();
        let mut curr: Option<Rc<dyn CObjCell>> = Some(env.clone());
        let mut path = SpherePath::default();

        find_cell_list(&world, &p, 1, &[s0()], &mut arr, Some(&mut curr), Some(&mut path));

        assert!(curr.is_none());
    }

    #[test]
    fn find_cell_list_prunes_non_stab_cells_when_do_not_load() {
        let env_id = 0x0001_0101;
        let keep_id = 0x0001_0102;
        let drop_id = 0x0001_0999;
        // visible env cell: stab list = [keep_id]; its find_transit_cells appends
        // keep_id and drop_id, as a real CEnvCell::find_transit_cells would.
        let env: Rc<dyn CObjCell> = Rc::new(MockCell {
            id: env_id,
            in_cell: false,
            stabs: vec![keep_id],
            transit: vec![keep_id, drop_id],
            ..Default::default()
        });
        let world = MockWorld {
            registry: vec![(env_id, env.clone())],
            outdoor_fill: RefCell::new(vec![]),
        };
        let p = Position { objcell_id: env_id, ..Default::default() };
        let mut arr = MockArray { do_not_load: true, ..Default::default() };

        find_cell_list(&world, &p, 1, &[s0()], &mut arr, None, None);

        let ids: Vec<u32> = (0..arr.num_cells()).map(|i| arr.cell_id_at(i)).collect();
        assert!(ids.contains(&env_id)); // visible cell kept
        assert!(ids.contains(&keep_id)); // in stab list kept
        assert!(!ids.contains(&drop_id)); // not in stab list pruned
    }

    // ── CellArray inherent methods + CellArrayApi bridge (A09/A08) ──
    #[test]
    fn cellarray_add_remove_reset_and_bridge() {
        let mut ca = CellArray::default();
        let c1: ObjCellHandle = Rc::new(MockCell { id: 1, ..Default::default() });

        // add_cell dedups on cell_id and keeps num_cells == cells.len().
        CellArray::add_cell(&mut ca, 1, Some(c1.clone()));
        CellArray::add_cell(&mut ca, 1, Some(c1.clone())); // dup → ignored
        CellArray::add_cell(&mut ca, 2, None);
        assert_eq!(ca.num_cells, 2);
        assert_eq!(ca.cells.len() as u32, ca.num_cells);
        assert!(ca.cells[0].cell.is_some()); // loaded handle preserved
        assert!(ca.cells[1].cell.is_none()); // null slot preserved

        // CellArrayApi bridge sees the same shape.
        assert_eq!(CellArrayApi::num_cells(&ca), 2);
        assert_eq!(CellArrayApi::cell_id_at(&ca, 0), 1);
        assert!(CellArrayApi::cell_at(&ca, 0).is_some());

        // swap-remove (decomp 718762): last element overwrites the index.
        CellArray::add_cell(&mut ca, 3, None);
        CellArray::add_cell(&mut ca, 4, None);
        // cells = [1,2,3,4]; remove index 1 → 4 takes its slot.
        CellArray::remove_cell(&mut ca, 1);
        let ids: Vec<u32> = ca.cells.iter().map(|c| c.cell_id).collect();
        assert_eq!(ids, vec![1, 4, 3]);
        assert_eq!(ca.num_cells, 3);

        // set_num_cells(0) (the find_cell_list reset) clears the backing Vec.
        CellArrayApi::set_num_cells(&mut ca, 0);
        assert_eq!(ca.num_cells, 0);
        assert!(ca.cells.is_empty());

        // reset() clears cells + added_outside, keeps do_not_load_cells.
        ca.do_not_load_cells = true;
        ca.added_outside = true;
        CellArray::add_cell(&mut ca, 9, None);
        ca.reset();
        assert!(ca.cells.is_empty());
        assert!(!ca.added_outside);
        assert!(ca.do_not_load_cells); // NOT reset
    }
}

// ─── Tests (A09 outdoor cell-ring assembly) ──────────────────────────────────

#[cfg(test)]
mod a09_ring_tests {
    use super::*;
    use holtburger_common::{Sphere, Vector3};

    // Landscape that never resolves a resident cell (null handle entries) —
    // the ring assertions check cell_ids, not the handles.
    struct MockLand;
    impl Landscape for MockLand {
        fn get_landcell(&self, _cell_id: u32) -> Option<ObjCellHandle> {
            None
        }
    }

    // LandDefs seam: adjust_to_outside returns a fixed cell + in-block point.
    struct MockDefs {
        out_id: u32,
        out_point: Vector3,
        ok: bool,
    }
    impl LandDefsSeam for MockDefs {
        fn adjust_to_outside(&self, _cell_id: u32, loc: &mut Vector3) -> Option<u32> {
            if !self.ok {
                return None;
            }
            *loc = self.out_point;
            Some(self.out_id)
        }
    }

    fn sphere_at(x: f32, y: f32, r: f32) -> Sphere {
        Sphere { center: Vector3 { x, y, z: 0.0 }, radius: r }
    }

    // ── cell-id math ──
    #[test]
    fn cellid_roundtrip_known_values() {
        assert_eq!(lcoord_to_cellid(0, 0), 1);
        assert_eq!(gid_to_lcoord(1), Some((0, 0)));
        assert_eq!(lcoord_to_cellid(1, 1), 0x0000_000A);
        assert_eq!(gid_to_lcoord(0x0A), Some((1, 1)));
        assert_eq!(lcoord_to_cellid(8, 0), 0x0100_0001);
        assert_eq!(gid_to_lcoord(0x0100_0001), Some((8, 0)));
    }

    #[test]
    fn gid_to_lcoord_rejects_interior_ids() {
        assert_eq!(gid_to_lcoord(0x0001_0100), None);
    }

    #[test]
    fn cellid_roundtrip_random_grid() {
        for &(x, y) in &[(7, 7), (16, 9), (255, 1), (1000, 2039), (2039, 2039)] {
            assert_eq!(gid_to_lcoord(lcoord_to_cellid(x, y)), Some((x, y)));
        }
    }

    // ── add_outside_cell bounds gate ──
    #[test]
    fn add_outside_cell_bounds_clamp() {
        let ls = MockLand;
        let mut ca = CellArray::default();
        add_outside_cell(&mut ca, &ls, -1, 5); // x < 0
        add_outside_cell(&mut ca, &ls, 5, LCOORD_MAX); // y >= 2040
        assert_eq!(ca.num_cells, 0);
        add_outside_cell(&mut ca, &ls, 5, 5); // in range → added (cell None)
        assert_eq!(ca.num_cells, 1);
        assert_eq!(ca.cells[0].cell_id, lcoord_to_cellid(5, 5));
        assert!(ca.cells[0].cell.is_none());
    }

    // ── check_add_cell_boundary ring branches ──
    #[test]
    fn boundary_center_adds_nothing() {
        let ls = MockLand;
        let mut ca = CellArray::default();
        check_add_cell_boundary(&mut ca, &ls, (12.0, 12.0), 10, 10, 23.0, 1.0);
        assert_eq!(ca.num_cells, 0);
    }

    #[test]
    fn boundary_plus_x_edge_adds_one() {
        let ls = MockLand;
        let mut ca = CellArray::default();
        check_add_cell_boundary(&mut ca, &ls, (23.5, 12.0), 10, 10, 23.0, 1.0);
        assert_eq!(ca.num_cells, 1);
        assert_eq!(ca.cells[0].cell_id, lcoord_to_cellid(11, 10));
    }

    #[test]
    fn boundary_corner_adds_three() {
        let ls = MockLand;
        let mut ca = CellArray::default();
        check_add_cell_boundary(&mut ca, &ls, (23.5, 23.5), 10, 10, 23.0, 1.0);
        let ids: std::collections::HashSet<u32> = ca.cells.iter().map(|c| c.cell_id).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&lcoord_to_cellid(11, 10)));
        assert!(ids.contains(&lcoord_to_cellid(11, 11)));
        assert!(ids.contains(&lcoord_to_cellid(10, 11)));
    }

    #[test]
    fn boundary_minus_corner_adds_three() {
        let ls = MockLand;
        let mut ca = CellArray::default();
        check_add_cell_boundary(&mut ca, &ls, (0.5, 0.5), 10, 10, 23.0, 1.0);
        let ids: std::collections::HashSet<u32> = ca.cells.iter().map(|c| c.cell_id).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&lcoord_to_cellid(9, 10)));
        assert!(ids.contains(&lcoord_to_cellid(9, 9)));
        assert!(ids.contains(&lcoord_to_cellid(10, 9)));
    }

    // ── add_all_outside_cells_sphere ──
    #[test]
    fn outside_cells_center_only_when_interior_of_cell() {
        let defs = MockDefs { out_id: 1, out_point: Vector3 { x: 12.0, y: 12.0, z: 0.0 }, ok: true };
        let ls = MockLand;
        let mut ca = CellArray::default();
        add_all_outside_cells_sphere(&mut ca, &ls, &defs, &Position::default(), 1, &[sphere_at(12.0, 12.0, 1.0)]);
        assert!(ca.added_outside);
        assert_eq!(ca.num_cells, 1); // center cell (0,0) only
        assert_eq!(ca.cells[0].cell_id, lcoord_to_cellid(0, 0));
    }

    #[test]
    fn outside_cells_corner_overlap_adds_four() {
        let defs = MockDefs { out_id: 1, out_point: Vector3 { x: 23.9, y: 23.9, z: 0.0 }, ok: true };
        let ls = MockLand;
        let mut ca = CellArray::default();
        add_all_outside_cells_sphere(&mut ca, &ls, &defs, &Position::default(), 1, &[sphere_at(23.9, 23.9, 1.0)]);
        let ids: std::collections::HashSet<u32> = ca.cells.iter().map(|c| c.cell_id).collect();
        assert_eq!(ids.len(), 4);
        assert!(ids.contains(&lcoord_to_cellid(0, 0)));
        assert!(ids.contains(&lcoord_to_cellid(1, 0)));
        assert!(ids.contains(&lcoord_to_cellid(1, 1)));
        assert!(ids.contains(&lcoord_to_cellid(0, 1)));
    }

    #[test]
    fn outside_cells_added_outside_guard_is_idempotent() {
        let defs = MockDefs { out_id: 1, out_point: Vector3 { x: 12.0, y: 12.0, z: 0.0 }, ok: true };
        let ls = MockLand;
        let mut ca = CellArray::default();
        add_all_outside_cells_sphere(&mut ca, &ls, &defs, &Position::default(), 1, &[sphere_at(12.0, 12.0, 1.0)]);
        let after_first = ca.num_cells;
        add_all_outside_cells_sphere(&mut ca, &ls, &defs, &Position::default(), 1, &[sphere_at(12.0, 12.0, 1.0)]);
        assert_eq!(ca.num_cells, after_first); // guard → no-op
    }

    #[test]
    fn outside_cells_break_on_adjust_failure() {
        let defs = MockDefs { out_id: 0, out_point: Vector3::zero(), ok: false };
        let ls = MockLand;
        let mut ca = CellArray::default();
        add_all_outside_cells_sphere(&mut ca, &ls, &defs, &Position::default(), 1, &[sphere_at(5.0, 5.0, 1.0)]);
        assert!(ca.added_outside);
        assert_eq!(ca.num_cells, 0); // adjust failed → nothing added
    }
}
