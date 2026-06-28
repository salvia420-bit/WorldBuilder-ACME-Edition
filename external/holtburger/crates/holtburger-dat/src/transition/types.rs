//! Shared state structs + enums for the Phase-1 physics leaf layer.
//!
//! Decomp-faithful ports of the retail CLIENT physics state
//! (`acclient.h`): `OBJECTINFO` @52284, `COLLISIONINFO` @52306,
//! `CTransition` @52329, `SPHEREPATH` @32625, and the `TransitionState`
//! @6100 / `SPHEREPATH::InsertType` @6160 / `ObjectInfoEnum` @6180 enums.
//!
//! Phase-1 simplifications vs. the decomp:
//! - The decomp's parallel `_valid: bool` + value pairs collapse to
//!   `Option<Plane>` / `Option<Vector3>` (a `None` is an invalid value).
//! - `Position` (objcell_id + `Frame`) is stubbed as [`CellPos`]
//!   (`objcell_id` + `origin`); orientation lands in Phase 2.
//! - Fields the leaf predicates never touch are stubbed with `// PHASE2:`;
//!   the driver wiring is stubbed with `// PHASE3`.
//!
//! This module depends only on `holtburger_common`, so it compiles
//! standalone (no dependency on the sibling leaf submodules).

use holtburger_common::{Plane, Vector3};

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
/// `return normal->z >= (double)PhysicsGlobals::floor_z`). The idb renders
/// the initializer as `cos(3437.746770784939)` — an arcminutes-confused
/// decompiler artifact, not the literal — so we use the value ACE carries.
/// VERIFY floor_z vs decomp.
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
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CellPos {
    /// `Position::objcell_id` — the landblock/cell the origin is relative to.
    pub objcell_id: u32,
    /// `Frame::m_origin` — the position within `objcell_id`'s local space.
    pub origin: Vector3,
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
    pub collided_with_environment: bool,
    pub frames_stationary_fall: u8,
    // PHASE2/PHASE3: num_collide_object, collide_object (DArray<CPhysicsObj*>),
    //                last_collided_object.
}

/// `struct SPHEREPATH` (~45 fields, `acclient.h:32625`). The swept-sphere
/// path state a transition threads through the leaf predicates. Phase 1
/// defines only the leaf-touched fields; the rest are `// PHASE2:` stubs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpherePath {
    /// `num_sphere` (decomp `unsigned int`; 1 or 2 spheres in practice).
    pub num_sphere: u8,
    /// `walkable_allowance` — plane is walkable when `N.z > this`
    /// (defaults to [`Z_FOR_LANDING`]); see the Discord gotcha: walkable is
    /// this normal-Z test, NOT a fixed floor_z.
    pub walkable_allowance: f32,
    pub walk_interp: f32,
    pub step_down_amt: f32,
    /// `localspace_z` — the up axis in the path's local space.
    pub localspace_z: Vector3,
    /// `check_pos` — the candidate position being tested this step.
    pub check_pos: CellPos,
    /// `curr_pos` — the current (last accepted) position.
    pub curr_pos: CellPos,
    pub insert_type: InsertType,
    // ── flags ──
    pub collide: bool,
    pub step_up: bool,
    pub step_down: bool,
    pub check_walkable: bool,
    pub neg_poly_hit: bool,
    // PHASE2: local_sphere/global_sphere/localspace_sphere + low points,
    //         localspace_pos, begin/end/backup positions, begin/curr/check
    //         cells, global_offset, step_up_normal, walkable_check_pos,
    //         walkable/walkable_up/walkable_pos/walkable_scale,
    //         obstruction_ethereal, hits_interior_cell, bldg_check,
    //         neg_step_up, neg_collision_normal, placement_allows_sliding.
}

// ─── Phase-3 driver shells ───────────────────────────────────────────────

/// Phase-3 cell-array shell (`CELLARRAY`). Holds the 3×3 ring of cells the
/// driver sweeps so leaf predicates stay cell-agnostic.
// PHASE3
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CellArray {
    // PHASE3: cells, num_cells, added_outside, do_not_load_cells, …
}

/// `struct CTransition` (`acclient.h:52329`). The Phase-3 driver shell that
/// wires `OBJECTINFO` + `SPHEREPATH` + `COLLISIONINFO` + `CELLARRAY` and
/// calls the leaf predicates. Filled in by the Phase-3 driver agent.
// PHASE3
#[derive(Debug, Clone, Default)]
pub struct CTransition {
    pub object_info: ObjectInfo,
    pub sphere_path: SpherePath,
    pub collision_info: CollisionInfo,
    pub cell_array: CellArray,
    // PHASE3: new_cell_ptr: Option<CObjCell>.
}

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
}
