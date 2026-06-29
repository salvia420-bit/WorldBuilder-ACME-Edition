//! Shared state structs + enums for the physics leaf + resolver layers.
//!
//! Decomp-faithful ports of the retail CLIENT physics state
//! (`acclient.h`): `OBJECTINFO` @52284, `COLLISIONINFO` @52306,
//! `CTransition` @52329, `SPHEREPATH` @32625, and the `TransitionState`
//! @6100 / `SPHEREPATH::InsertType` @6160 / `ObjectInfoEnum` @6180 enums.
//!
//! Modeling conventions vs. the decomp:
//! - The decomp's parallel `_valid: bool` + value pairs collapse to
//!   `Option<Plane>` / `Option<Vector3>` (a `None` is an invalid value).
//! - `int` flags collapse to `bool`; a `CObjCell *` cell pointer collapses
//!   to `Option<u32>` (the cell id; the real `CObjCell` lands in Phase 3).
//! - `Position` (objcell_id + `Frame`) is the [`Position`] struct: Phase 2
//!   promotes the Phase-1 [`CellPos`] stub (`objcell_id` + `origin`) to carry
//!   the full orientation [`Frame`] the resolver's local↔global transforms
//!   (`Position::localtoglobalvec`, `SPHEREPATH::cache_global_sphere`) read.
//! - The driver-only wiring (`CELLARRAY`, `CObjCell`) stays `// PHASE3`.
//!
//! Phase 2 wires in the sibling leaf modules ([`super::frame_transform::Frame`]
//! for orientation, [`crate::physics::ResolvedPolygon`] for the walkable poly,
//! `holtburger_common::Sphere` for the swept `CSphere`s), so this module no
//! longer compiles standalone.

use super::frame_transform::Frame;
use crate::physics::ResolvedPolygon;
use holtburger_common::{Plane, Sphere, Vector3};

// ─── Constants (acclient.c) ──────────────────────────────────────────────
//
// Centralized here so the leaf modules `use super::types::*` instead of
// each re-deriving the literals. `crate::physics::PHYSICS_EPSILON`
// (already 0.0002) is the canonical epsilon; `EPSILON` mirrors it for the
// transition layer's own thresholds.

/// Retail collision epsilon — `acclient.c` spells it `0.00019999999`.
/// Equal to `crate::physics::PHYSICS_EPSILON`.
pub const EPSILON: f32 = 0.0002;

/// `z_for_landing` (`acclient.c:40376`) = cos(85°). The default
/// walkable-surface normal-Z threshold (`SPHEREPATH::walkable_allowance`):
/// a plane is walkable when `plane.N.z > walkable_allowance`.
pub const Z_FOR_LANDING: f32 = 0.0871557;

/// Retail gravitational acceleration (m/s²).
pub const GRAVITY: f32 = -9.8;

/// `PhysicsGlobals::floor_z` (`acclient.c:316502`,
/// `return normal->z >= (double)PhysicsGlobals::floor_z`). Initialized as
/// `floor_z = cos(3437.746770784939)` (`acclient.c:800530`) — that literal IS
/// what the decompiler emitted, and `cos()` of it evaluates (f64) to
/// 0.6641741461866276, which rounds to this f32 (= cos 48.381°). The PDB types
/// `floor_z` as T_REAL32, so f32 is canonical. VERIFIED vs decomp (A08/A15).
/// Distinct from [`Z_FOR_LANDING`] (cos 85°): `walkable_allowance` defaults to
/// `Z_FOR_LANDING`, but `step_up`/`step_down` raise it to `FLOOR_Z` once the
/// object is `ON_WALKABLE`. Both thresholds are load-bearing — do not merge.
pub const FLOOR_Z: f32 = 0.66417414618662751_f32;

// ─── Shared vector helper ────────────────────────────────────────────────

/// `AC1Legacy::Vector3::normalize_check_small` (`acclient.c:143622`).
///
/// Normalizes `v` in place and returns `false` ("not small"); if the length
/// is below the retail epsilon (`0.00019999999`) the vector is left UNCHANGED
/// and the function returns `true` ("too small to normalize"). The decomp's
/// `int` return is `1` for the small case, `0` otherwise — the callers
/// (`COLLISIONINFO::set_collision_normal`, `set_sliding_normal`,
/// `CSphere::slide_sphere`, …) treat a `true` result as "degenerate, zero it
/// out". This is the canonical reduce-and-test used across the leaf layer;
/// it shares [`EPSILON`] with `crate::physics::PHYSICS_EPSILON`.
pub fn normalize_check_small(v: &mut Vector3) -> bool {
    // Decomp accumulates the sum-of-squares in `long double`; f64 mirrors it.
    let len = ((v.x as f64 * v.x as f64
        + v.y as f64 * v.y as f64
        + v.z as f64 * v.z as f64)
        .sqrt()) as f32;
    if len >= EPSILON {
        let inv = 1.0 / len;
        v.x *= inv;
        v.y *= inv;
        v.z *= inv;
        false
    } else {
        true
    }
}

// ─── LandDefs (landblock geometry) ───────────────────────────────────────

/// `LandDefs` static helpers (decomp `LandDefs::` namespace).
pub struct LandDefs;

impl LandDefs {
    /// `LandDefs::get_block_offset` (`acclient.c:123110`). The world offset of
    /// `cell_to`'s landblock origin relative to `cell_from`'s:
    /// `((Xto-Xfrom), (Yto-Yfrom), 0) * 192` (192 = 8 cells × 24 units).
    ///
    /// A cell id packs its landblock id in the high 16 bits — bits 24-31 =
    /// landblock X, bits 16-23 = landblock Y. Used to express a point/plane
    /// living in one landblock's local frame in another's; zero within one
    /// landblock (high-16 equal). Decomp arg order is `(cell_from, cell_to)`
    /// with result `(to - from)`. VERIFIED vs ACE `LandDefs.GetBlockOffset`
    /// (A08/A15).
    // acclient.c:123110
    pub fn get_block_offset(cell_from: u32, cell_to: u32) -> Vector3 {
        // Same landblock (high 16 bits equal) → zero (acclient.c:123121).
        if cell_from >> 16 == cell_to >> 16 {
            return Vector3::zero();
        }
        // FROM landblock (X,Y) * 8 (0 when cell==0) (acclient.c:123128-123137):
        //   (cell >> 21) & 0x7F8  == ((cell >> 24) & 0xFF) << 3 == X * 8
        //   8 * ((cell >> 16) & 0xFF)                           == Y * 8
        let (v5, v6): (u32, u32) = if cell_from != 0 {
            ((cell_from >> 21) & 0x7F8, 8 * ((cell_from >> 16) & 0xFF))
        } else {
            (0, 0)
        };
        // TO landblock (X,Y) * 8 (acclient.c:123138-123147). The `cell_to == 0`
        // branch is a decomp quirk (feeds raw `cell_from` into both lanes);
        // unreachable for real transitions (cell ids are non-zero).
        let (v7, v8): (u32, u32) = if cell_to != 0 {
            ((cell_to >> 21) & 0x7F8, 8 * ((cell_to >> 16) & 0xFF))
        } else {
            (cell_from, cell_from)
        };
        // (to - from) * 24 (the *8 already baked in → net *192/landblock).
        // Decomp subtracts as unsigned then reinterprets signed; `wrapping_sub
        // .. as i32` is bit-exact (acclient.c:123148-123152).
        Vector3::new(
            (v7.wrapping_sub(v5) as i32) as f32 * 24.0,
            (v8.wrapping_sub(v6) as i32) as f32 * 24.0,
            0.0,
        )
    }
}

// ─── Enums ───────────────────────────────────────────────────────────────

/// `enum TransitionState` (`acclient.h:6100`). The result of a single
/// `CTransition` step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u32)]
pub enum TransitionState {
    #[default]
    Invalid = 0,
    Ok = 1,
    Collided = 2,
    Adjusted = 3,
    Slid = 4,
}

impl TransitionState {
    /// Map a raw resolver/spine `int` code (the convention the leaf + dispatch
    /// layers carry: `1`=OK … `4`=SLID, anything else `Invalid`) back to the
    /// typed enum. The Phase-3 search loops thread `transitional_insert`'s `i32`
    /// straight into the typed `validate_*` entry points through this.
    pub fn from_i32(v: i32) -> Self {
        match v {
            1 => TransitionState::Ok,
            2 => TransitionState::Collided,
            3 => TransitionState::Adjusted,
            4 => TransitionState::Slid,
            _ => TransitionState::Invalid,
        }
    }
}

/// `enum SPHEREPATH::InsertType` (`acclient.h:6160`). How a sphere is being
/// placed into the world for this transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u32)]
pub enum InsertType {
    #[default]
    Transition = 0,
    Placement = 1,
    InitialPlacement = 2,
}

/// `enum ObjectInfoEnum` (`acclient.h:6180`) bit flags for
/// [`ObjectInfo::state`]. Mirrors the decomp values verbatim.
pub mod object_info_state {
    pub const DEFAULT: u32 = 0x0;
    pub const CONTACT: u32 = 0x1;
    pub const ON_WALKABLE: u32 = 0x2;
    pub const IS_VIEWER: u32 = 0x4;
    pub const PATH_CLIPPED: u32 = 0x8;
    pub const FREE_ROTATE: u32 = 0x10;
    pub const PERFECT_CLIP: u32 = 0x40;
    pub const IS_IMPENETRABLE: u32 = 0x80;
    pub const IS_PLAYER: u32 = 0x100;
    pub const EDGE_SLIDE: u32 = 0x200;
    pub const IGNORE_CREATURES: u32 = 0x400;
    pub const IS_PK: u32 = 0x800;
    pub const IS_PKLITE: u32 = 0x1000;
}

// ─── Position stand-in ───────────────────────────────────────────────────

/// Phase-1 stand-in for the decomp's `Position` (objcell_id + `Frame`).
/// The leaf predicates only need the cell id and origin; orientation
/// (the full `Frame`) lands in Phase 2.
///
/// Superseded in Phase 2 by [`Position`], which carries the full [`Frame`].
/// Retained here for the Phase-1 `collisioninfo` bridge until the resolver
/// reconciliation removes its remaining uses.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CellPos {
    /// `Position::objcell_id` — the landblock/cell the origin is relative to.
    pub objcell_id: u32,
    /// `Frame::m_origin` — the position within `objcell_id`'s local space.
    pub origin: Vector3,
}

/// `struct Position` (`acclient.h`, 72 B: `vfptr`@0, `objcell_id`@4,
/// `frame`@8). Phase-2 promotion of [`CellPos`] to the full decomp shape:
/// the landblock/cell id plus the orientation [`Frame`] (`m_fl2gv` 3×3 +
/// `m_fOrigin`). The resolver reads `Position::frame` to carry vectors /
/// planes between a cell's local space and global space
/// (`Position::localtoglobalvec` @143659, `Plane::localtoglobal` @467672,
/// `SPHEREPATH::cache_global_sphere` @313748).
///
/// `Frame::default()` is the identity frame, so a default `Position` is the
/// world origin with no rotation.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Position {
    /// `Position::objcell_id` — the landblock/cell the frame is relative to.
    pub objcell_id: u32,
    /// `Position::frame` — orientation (`m_fl2gv`) + origin (`m_fOrigin`).
    pub frame: Frame,
}

// ─── State structs ───────────────────────────────────────────────────────

/// `struct OBJECTINFO` (`acclient.h:52284`). The moving object's collision
/// parameters for a transition. `object` (a `CPhysicsObj*`) is reduced to
/// its id for Phase 1; `state` carries [`object_info_state`] bit flags.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ObjectInfo {
    /// `object` — the `CPhysicsObj*` reduced to its id.
    pub object_id: u32,
    /// `state` — [`object_info_state`] bit flags (CONTACT, ON_WALKABLE, …).
    pub state: u32,
    pub scale: f32,
    pub step_up_height: f32,
    pub step_down_height: f32,
    /// `ethereal` — ethereal/missile objects skip solid collision.
    pub ethereal: bool,
    pub step_down: bool,
    /// `targetID` — the object this transition is targeting (0 = none).
    pub target_id: u32,
}

/// `struct COLLISIONINFO` (`acclient.h:52306`). Accumulates the contact
/// planes / normals a transition discovers. The decomp's `_valid: bool` +
/// value pairs collapse to `Option<…>` here (set by `set_contact_plane` /
/// `set_collision_normal` — `acclient.c:311581`, owned by the
/// `collisioninfo` agent).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollisionInfo {
    /// `last_known_contact_plane(_valid)`.
    pub last_known_contact_plane: Option<Plane>,
    pub last_known_contact_plane_is_water: bool,
    /// `contact_plane(_valid)`.
    pub contact_plane: Option<Plane>,
    pub contact_plane_cell_id: u32,
    pub last_known_contact_plane_cell_id: u32,
    pub contact_plane_is_water: bool,
    /// `sliding_normal(_valid)`.
    pub sliding_normal: Option<Vector3>,
    /// `collision_normal(_valid)`.
    pub collision_normal: Option<Vector3>,
    pub adjust_offset: Vector3,
    // ── object-object collision tail (acclient.h:52321-52323) ──
    /// `num_collide_object` — active count of distinct objects hit this step.
    /// Mirrors `collide_object.len()`; `add_object`/`reset_objects` keep them
    /// in sync.
    pub num_collide_object: u32,
    /// `collide_object` (`DArray<CPhysicsObj const *>`) — distinct physics
    /// objects collided with. A `CPhysicsObj*` reduces to its id (`u32`),
    /// matching [`ObjectInfo::object_id`]/`target_id`.
    pub collide_object: Vec<u32>,
    /// `last_collided_object` — most recent non-`Ok` collision (`None` = 0).
    pub last_collided_object: Option<u32>,
    // ── (existing tail) ──
    pub collided_with_environment: bool,
    pub frames_stationary_fall: u8,
}

/// `struct SPHEREPATH` (592 B, `acclient.h:32625`). The swept-sphere path
/// state a transition threads through the leaf predicates and the resolver.
/// Phase 2 fleshes the full field set (byte offsets cited per field) the
/// `BSPTREE::find_collisions` resolver + `SPHEREPATH` mutators read/write.
///
/// Decomp pointer fields are modeled by value (the resolver dereferences
/// them): a `CSphere *` array (`num_sphere` ≤ 2 in practice) becomes
/// `[Sphere; 2]`; a `Vector3 *` becomes an owned `Vector3`; a `CObjCell *`
/// becomes `Option<u32>` (cell id); a `CPolygon *` becomes
/// `Option<ResolvedPolygon>`.
///
/// No `PartialEq`/`Default` derive: [`Sphere`] and [`ResolvedPolygon`] carry
/// neither, and physics state is compared by float tolerance (not exact `==`)
/// per the leaf-layer testing convention. A hand-written [`Default`] (all
/// spheres zeroed, all positions identity) follows the struct.
// acclient.h:32625
#[derive(Debug, Clone)]
pub struct SpherePath {
    /// `num_sphere` (decomp `unsigned int`; 1 or 2 spheres in practice).
    pub num_sphere: u8, // @0
    /// `local_sphere` — the moving sphere(s) in object-local space.
    pub local_sphere: [Sphere; 2], // @4  (CSphere *)
    /// `local_low_point` — lowest point of `local_sphere` (gravity probe).
    pub local_low_point: Vector3, // @8
    /// `global_sphere` — the moving sphere(s) in global space; the slide /
    /// step responders use this as their `this` (`cache_global_sphere`).
    pub global_sphere: [Sphere; 2], // @20 (CSphere *)
    pub global_low_point: Vector3, // @24
    /// `localspace_sphere` — the swept sphere(s) in the BSP cell's local
    /// space; the primary `find_collisions` input.
    pub localspace_sphere: [Sphere; 2], // @36 (CSphere *)
    pub localspace_low_point: Vector3, // @40
    /// `localspace_curr_center` — the swept sphere's start center in local
    /// space; `movement = localspace_sphere.center − localspace_curr_center`.
    pub localspace_curr_center: Vector3, // @52 (Vector3 *)
    /// `global_curr_center` — start center in global space (slide fallback).
    pub global_curr_center: Vector3, // @56 (Vector3 *)
    /// `localspace_pos` — the cell-local `Position` (orientation `Frame`) the
    /// resolver maps local results back to global through.
    pub localspace_pos: Position, // @60 Position(72)
    /// `localspace_z` — the up axis in the path's local space.
    pub localspace_z: Vector3, // @132
    /// `begin_cell` — start cell (`CObjCell *` → cell id).
    pub begin_cell: Option<u32>, // @144
    /// `begin_pos` — start `Position` (decomp `Position *`).
    pub begin_pos: Position, // @148
    /// `end_pos` — target `Position` (decomp `Position *`).
    pub end_pos: Position, // @152
    /// `curr_cell` — current (last accepted) cell.
    pub curr_cell: Option<u32>, // @156
    /// `curr_pos` — the current (last accepted) position.
    pub curr_pos: Position, // @160 Position(72)
    pub global_offset: Vector3, // @232
    pub step_up: bool, // @244
    /// `step_up_normal` — normal latched by `set_collide`, consumed by the
    /// step-up slide fallback (`step_up_slide`).
    pub step_up_normal: Vector3, // @248
    pub collide: bool, // @260
    /// `check_cell` — the cell of the candidate position.
    pub check_cell: Option<u32>, // @264
    /// `check_pos` — the candidate position being tested this step. Carries a
    /// `Frame`: `cache_global_sphere` rotates `local_sphere` → `global_sphere`
    /// through `check_pos.frame`.
    pub check_pos: Position, // @268 Position(72)
    pub insert_type: InsertType, // @340
    pub step_down: bool, // @344
    /// `backup` — the `insert_type` snapshot taken alongside `backup_check_pos`.
    pub backup: InsertType, // @348
    /// `backup_cell` — the `check_cell` snapshot (`set_collide`).
    pub backup_cell: Option<u32>, // @352
    /// `backup_check_pos` — the `check_pos` snapshot the driver rewinds to.
    pub backup_check_pos: Position, // @356 Position(72)
    /// `obstruction_ethereal` — the swept object passes through solids.
    pub obstruction_ethereal: bool, // @428
    pub hits_interior_cell: bool, // @432
    pub bldg_check: bool, // @436
    /// `walkable_allowance` — plane is walkable when `N.z > this`
    /// (defaults to [`Z_FOR_LANDING`]); see the Discord gotcha: walkable is
    /// this normal-Z test, NOT a fixed floor_z.
    pub walkable_allowance: f32, // @440
    pub walk_interp: f32, // @444
    pub step_down_amt: f32, // @448
    /// `walkable_check_pos` — the resting sphere recorded by `set_walkable`.
    pub walkable_check_pos: Sphere, // @452 CSphere(16)
    /// `walkable` — the supporting polygon (`CPolygon *` → owned clone).
    pub walkable: Option<ResolvedPolygon>, // @468 (CPolygon *)
    pub check_walkable: bool, // @472
    /// `walkable_up` — the supporting surface "up" axis (`set_walkable`).
    pub walkable_up: Vector3, // @476
    /// `walkable_pos` — the local position of the resting walkable surface.
    pub walkable_pos: Position, // @488 Position(72)
    pub walkable_scale: f32, // @560
    /// `cell_array_valid` — cleared by `add_offset_to_check_pos` so the
    /// driver re-derives the 3×3 cell ring after the position moves.
    pub cell_array_valid: bool, // @564
    /// `neg_step_up` — the `step_up` value (0 or 1) latched by
    /// `set_neg_poly_hit`; 1 = first-sphere graze, 0 = second-sphere graze.
    /// Kept `i32` (decomp `int`) to preserve the which-sphere distinction.
    pub neg_step_up: i32, // @568
    /// `neg_collision_normal` — the negated grazing normal (`set_neg_poly_hit`).
    pub neg_collision_normal: Vector3, // @572
    pub neg_poly_hit: bool, // @584
    pub placement_allows_sliding: bool, // @588
}

impl Default for SpherePath {
    /// Hand-written because [`Sphere`] derives no `Default`. All spheres are
    /// zeroed (center 0, radius 0) and all positions are the identity
    /// [`Position`]; every flag/scalar is its zero value.
    fn default() -> Self {
        let zero_sphere = Sphere {
            center: Vector3::zero(),
            radius: 0.0,
        };
        Self {
            num_sphere: 0,
            local_sphere: [zero_sphere; 2],
            local_low_point: Vector3::zero(),
            global_sphere: [zero_sphere; 2],
            global_low_point: Vector3::zero(),
            localspace_sphere: [zero_sphere; 2],
            localspace_low_point: Vector3::zero(),
            localspace_curr_center: Vector3::zero(),
            global_curr_center: Vector3::zero(),
            localspace_pos: Position::default(),
            localspace_z: Vector3::zero(),
            begin_cell: None,
            begin_pos: Position::default(),
            end_pos: Position::default(),
            curr_cell: None,
            curr_pos: Position::default(),
            global_offset: Vector3::zero(),
            step_up: false,
            step_up_normal: Vector3::zero(),
            collide: false,
            check_cell: None,
            check_pos: Position::default(),
            insert_type: InsertType::default(),
            step_down: false,
            backup: InsertType::default(),
            backup_cell: None,
            backup_check_pos: Position::default(),
            obstruction_ethereal: false,
            hits_interior_cell: false,
            bldg_check: false,
            walkable_allowance: 0.0,
            walk_interp: 0.0,
            step_down_amt: 0.0,
            walkable_check_pos: zero_sphere,
            walkable: None,
            check_walkable: false,
            walkable_up: Vector3::zero(),
            walkable_pos: Position::default(),
            walkable_scale: 0.0,
            cell_array_valid: false,
            neg_step_up: 0,
            neg_collision_normal: Vector3::zero(),
            neg_poly_hit: false,
            placement_allows_sliding: false,
        }
    }
}

// ─── Phase-3 cell ring (CELLARRAY @31574 / CELLINFO @31925) ───────────────

/// Handle to a loaded `CObjCell` (the decomp's `CObjCell *` in `CELLINFO.cell`).
///
/// The Phase-3 reconciliation adopts A10's **fat trait-object handle**
/// (`Rc<dyn CObjCell>`) so the driver can call the cell's collision vtable
/// (`find_collisions`, `find_transit_cells`, `point_in_cell`) directly through
/// the array rather than re-resolving an id → `&dyn CObjCell` at the BSP-walk
/// boundary. `None` ⇒ the cell is not loaded (`do_not_load_cells`) or absent;
/// `Some(rc)` ⇒ a loaded cell. (Single-threaded like the client; swap to `Arc`
/// only if the scene is shared across threads.)
pub type ObjCellHandle = std::rc::Rc<dyn super::objcell::CObjCell>;

/// `struct CELLINFO` (`acclient.h:31925`). One slot of the cell ring.
///
/// `Clone` only — `Option<Rc<dyn CObjCell>>` is neither `PartialEq` nor
/// `Default` (the trait carries no `Debug`/`PartialEq` supertrait), so `Debug`
/// is hand-written (prints `cell_id` + whether the handle is loaded) and the
/// `Default`/`PartialEq` derives are dropped.
#[derive(Clone)]
pub struct CellInfo {
    /// `CELLINFO.cell_id` @0 — the landcell id (always set).
    pub cell_id: u32,
    /// `CELLINFO.cell` @4 (`CObjCell *`) — loaded cell handle, or `None`.
    pub cell: Option<ObjCellHandle>,
}

impl std::fmt::Debug for CellInfo {
    /// Hand-written so `CObjCell` needs no `Debug` supertrait. Prints the id
    /// and whether the fat handle is loaded (the observable shape of the slot).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CellInfo")
            .field("cell_id", &self.cell_id)
            .field("cell_loaded", &self.cell.is_some())
            .finish()
    }
}

/// `struct CELLARRAY` (`acclient.h:31574`). The 3×3 ring of cells the driver
/// sweeps so leaf predicates stay cell-agnostic. The decomp `DArray<CELLINFO>`
/// collapses to a `Vec<CellInfo>`; the CELLARRAY methods (A09, in
/// [`super::objcell`]) keep `num_cells == cells.len()`. `int added_outside` /
/// `int do_not_load_cells` collapse to `bool`.
///
/// `Debug` works because [`CellInfo`] has a manual `Debug`; `Default` works
/// because `Vec` defaults empty (no `PartialEq` — `CellInfo` carries none).
#[derive(Debug, Clone, Default)]
pub struct CellArray {
    /// `added_outside` @0 — the outdoor landblock cell has been appended.
    pub added_outside: bool,
    /// `do_not_load_cells` @4 — skip loading uncached cells (leave `cell=None`).
    pub do_not_load_cells: bool,
    /// `num_cells` @8 — active cell count.
    pub num_cells: u32,
    /// `cells` @12 — `DArray<CELLINFO>` → owned vector.
    pub cells: Vec<CellInfo>,
}

/// `struct CTransition` (`acclient.h:52329`). The driver shell that wires
/// `OBJECTINFO` + `SPHEREPATH` + `COLLISIONINFO` + `CELLARRAY` and calls the
/// leaf predicates. The Phase-2 resolver reads the first three members
/// (`object_info` / `sphere_path` / `collision_info`); `cell_array` + the
/// driver loop are filled in by the Phase-3 driver agent.
#[derive(Debug, Clone)]
pub struct CTransition {
    pub object_info: ObjectInfo,
    pub sphere_path: SpherePath,
    pub collision_info: CollisionInfo,
    // PHASE3
    pub cell_array: CellArray,
    // PHASE3: new_cell_ptr: Option<CObjCell>.
    /// Phase 3 Phase E1 / WS-D (`USE_FAITHFUL_STEPUP`, 2026-06-29) —
    /// holtburger A/B feature toggle (NOT a retail OBJECTINFO field): when
    /// `true` (DEFAULT), the faithful step-up / slope & ledge climb path is
    /// live (the WS-B indoor-BSP early-stop relaxation + the WS-C terrain
    /// climb both read this); when `false` (`?stepUp=off`) the driver keeps
    /// the pre-E1 behavior (a grounded mover stops at the base of a walkable
    /// up-slope). Carried from `movement/system.rs`'s `USE_FAITHFUL_STEPUP`
    /// const / `?stepUp=off` runtime carrier through
    /// `find_transitional_position_dispatch` →
    /// `faithful_find_transitional_position` (the `faithful_stepup` arg). The
    /// hand-written [`Default`] below defaults this ON so every direct
    /// `CTransition::new()`/`default()` user (the dat-crate unit tests) climbs
    /// like the live default-ON path.
    pub faithful_stepup: bool,
}

impl Default for CTransition {
    fn default() -> Self {
        Self {
            object_info: ObjectInfo::default(),
            sphere_path: SpherePath::default(),
            collision_info: CollisionInfo::default(),
            cell_array: CellArray::default(),
            // Phase E1 / WS-D: default-ON (mirrors `USE_FAITHFUL_STEPUP`).
            faithful_stepup: true,
        }
    }
}

// `CTransition::step_up` (acclient.c:312794) is the Phase-3 DRIVER method; its
// real body lives in `super::driver_spine` (B2b). It keeps the same signature
// (`fn step_up(&mut self, &Vector3) -> i32`) the B1 stub had, so the committed
// `resolver_slide::step_sphere_up` call site (`transition.step_up(&gnormal)`)
// links unchanged. Called outside a driver sweep (no thread-local world ctx —
// e.g. the resolver/types unit tests), it returns `0`, preserving the B1
// "did not step up → fall through to step_up_slide" behaviour.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_and_shells_default_correctly() {
        // Discriminants mirror acclient.h (TransitionState @6100,
        // InsertType @6160).
        assert_eq!(TransitionState::Ok as u32, 1);
        assert_eq!(TransitionState::Collided as u32, 2);
        assert_eq!(TransitionState::Adjusted as u32, 3);
        assert_eq!(TransitionState::Slid as u32, 4);
        assert_eq!(TransitionState::default(), TransitionState::Invalid);
        assert_eq!(InsertType::default(), InsertType::Transition);
        assert_eq!(object_info_state::PERFECT_CLIP, 0x40);
        assert_eq!(object_info_state::EDGE_SLIDE, 0x200);

        // Option<Plane>/Option<Vector3> stand in for the decomp's
        // _valid + value pairs — default is the "invalid" None.
        let ci = CollisionInfo::default();
        assert!(ci.contact_plane.is_none());
        assert!(ci.collision_normal.is_none());
        assert!(ci.sliding_normal.is_none());
        assert_eq!(ci.frames_stationary_fall, 0);

        // The Phase-3 shell wires the four sub-structs together.
        let t = CTransition::default();
        assert_eq!(t.sphere_path.num_sphere, 0);
        assert!(!t.object_info.ethereal);
        assert_eq!(t.object_info.state, object_info_state::DEFAULT);
        // Phase E1 / WS-D: the step-up climb feature toggle defaults ON
        // (mirrors `USE_FAITHFUL_STEPUP`); `?stepUp=off` flips it.
        assert!(t.faithful_stepup);
    }

    #[test]
    fn normalize_check_small_normalizes_and_flags() {
        // (3,4,0) → length 5 → unit (0.6,0.8,0), returns false (not small).
        let mut v = Vector3::new(3.0, 4.0, 0.0);
        assert!(!normalize_check_small(&mut v));
        assert!((v.x - 0.6).abs() < 1e-6);
        assert!((v.y - 0.8).abs() < 1e-6);
        assert!(v.z.abs() < 1e-6);

        // A near-zero vector is left untouched and flagged small (true).
        let mut tiny = Vector3::new(1e-6, 0.0, 0.0);
        assert!(normalize_check_small(&mut tiny));
        assert_eq!(tiny, Vector3::new(1e-6, 0.0, 0.0));
    }

    #[test]
    fn spherepath_full_defaults_and_step_up_stub() {
        // The Phase-2 fleshed SpherePath defaults: spheres zeroed, positions
        // identity, cells/walkable absent, flags false, neg_step_up = 0.
        let sp = SpherePath::default();
        assert_eq!(sp.num_sphere, 0);
        assert_eq!(sp.localspace_sphere[0].radius, 0.0);
        assert_eq!(sp.localspace_sphere[1].center, Vector3::zero());
        assert_eq!(sp.global_sphere[0].center, Vector3::zero());
        assert!(sp.walkable.is_none());
        assert!(sp.check_cell.is_none());
        assert!(sp.backup_cell.is_none());
        assert!(!sp.cell_array_valid);
        assert!(!sp.obstruction_ethereal);
        assert_eq!(sp.neg_step_up, 0);
        assert_eq!(sp.insert_type, InsertType::Transition);
        assert_eq!(sp.backup, InsertType::Transition);

        // check_pos is now a full Position (Phase-2 promotion from CellPos):
        // identity Frame (fl2gv diagonal 1s, origin 0) relative to cell 0.
        assert_eq!(sp.check_pos.objcell_id, 0);
        assert_eq!(
            sp.check_pos.frame.fl2gv,
            [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        );
        assert_eq!(sp.check_pos.frame.origin, Vector3::zero());
        assert_eq!(sp.localspace_pos, Position::default());

        // CTransition embeds the fleshed SpherePath and exposes the Phase-3
        // `step_up` stub, which reports "did not step up" (0) so
        // `BSPTREE::step_sphere_up` falls through to its slide fallback.
        let mut t = CTransition::default();
        assert_eq!(t.sphere_path.num_sphere, 0);
        assert_eq!(t.step_up(&Vector3::new(0.0, 0.0, 1.0)), 0);
    }

    // ── A08 contract: LandDefs::get_block_offset (acclient.c:123110) ────────

    fn approx_v(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < 1e-3 && (a.y - b.y).abs() < 1e-3 && (a.z - b.z).abs() < 1e-3
    }

    #[test]
    fn get_block_offset_same_landblock_is_zero() {
        // Same high-16 (landblock 0x0102), different cell index → zero.
        let o = LandDefs::get_block_offset(0x0102_0001, 0x0102_0005);
        assert!(approx_v(o, Vector3::zero()), "got {o:?}");
    }

    #[test]
    fn get_block_offset_x_and_y_deltas() {
        // (X,Y) (1,2)→(3,2): +2 blocks X → +384, 0 Y.
        let o = LandDefs::get_block_offset(0x0102_0001, 0x0302_0001);
        assert!(approx_v(o, Vector3::new(384.0, 0.0, 0.0)), "got {o:?}");
        // Reverse (3,2)→(1,2): −384 X.
        let o = LandDefs::get_block_offset(0x0302_0001, 0x0102_0001);
        assert!(approx_v(o, Vector3::new(-384.0, 0.0, 0.0)), "got {o:?}");
        // Pure +Y: (5,5)→(5,6): +192 Y.
        let o = LandDefs::get_block_offset(0x0505_0000, 0x0506_0000);
        assert!(approx_v(o, Vector3::new(0.0, 192.0, 0.0)), "got {o:?}");
    }

    #[test]
    fn get_block_offset_zero_from_edge_branch() {
        // cell_from == 0 → v5=v6=0; to (X,Y)=(2,1) → (2*192, 1*192, 0).
        let o = LandDefs::get_block_offset(0, 0x0201_0000);
        assert!(approx_v(o, Vector3::new(384.0, 192.0, 0.0)), "got {o:?}");
    }

    // ── A08 contract: FLOOR_Z verify + CellArray real fields ────────────────

    #[test]
    fn floor_z_matches_decomp_cos_and_is_distinct_from_z_for_landing() {
        let from_decomp = (3437.746770784939_f64).cos() as f32;
        assert_eq!(FLOOR_Z, from_decomp);
        // floor_z ≈ cos(48.381°); strictly above z_for_landing (cos 85°).
        let deg = (FLOOR_Z as f64).acos().to_degrees();
        assert!((deg - 48.381).abs() < 0.01, "got {deg}");
        assert!(FLOOR_Z > Z_FOR_LANDING);
    }

    #[test]
    fn cellarray_real_fields_and_default() {
        let ca = CellArray::default();
        assert!(!ca.added_outside);
        assert!(!ca.do_not_load_cells);
        assert_eq!(ca.num_cells, 0);
        assert!(ca.cells.is_empty());

        // CELLINFO now carries the fat handle (`Option<Rc<dyn CObjCell>>`),
        // which is not `PartialEq`/`Default` — so build a null-slot entry and
        // assert on `cell_id` + `cell.is_some()` (the manual-Debug contract)
        // instead of `assert_eq!`ing the Option. The loaded-handle (`is_some`)
        // path + the `num_cells == cells.len()` invariant are exercised by
        // `objcell::tests::cellarray_add_remove_reset_and_bridge` (a real `Rc`
        // cell lives there). A null `cell` ⇒ do_not_load / absent landblock.
        let ca = CellArray {
            added_outside: true,
            do_not_load_cells: false,
            num_cells: 2,
            cells: vec![
                CellInfo { cell_id: 0x0102_0001, cell: None },
                CellInfo { cell_id: 0x0102_0002, cell: None },
            ],
        };
        assert_eq!(ca.cells.len() as u32, ca.num_cells);
        assert_eq!(ca.cells[0].cell_id, 0x0102_0001);
        assert!(ca.cells[0].cell.is_none());
        assert!(ca.cells[1].cell.is_none());

        // The hand-written Debug prints cell_id + load state (no Rc Debug).
        let dbg = format!("{:?}", ca.cells[0]);
        assert!(dbg.contains("cell_id") && dbg.contains("cell_loaded"));
    }
}
