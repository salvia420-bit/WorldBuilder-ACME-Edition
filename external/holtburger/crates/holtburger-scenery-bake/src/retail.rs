//! Retail scenery acceptance for [`crate::BakeMode::Retail`]
//! (terrain-scenery-3): the building-cell, slope and within-block gates of
//! `acclient.c` `CLandBlock::get_land_scenes` (:352530) that ACE's dead
//! `Entity/Scenery.cs` port does not have.
//!
//! Retail keeps a candidate only if, in this order (:352673-352718):
//!
//! 1. `0 <= x < 192` and `0 <= y < 192` — `flt_844AEC = 24.0 * 8.0`, both
//!    comparisons strict on the high side;
//! 2. `!CLandBlock::on_road` — [`crate::height::on_road_retail`];
//! 3. `!CSortCell::has_building` on the candidate's 24 m land cell — a
//!    building occupies exactly ONE cell, the one holding its origin
//!    (`CLandBlock::init_buildings` :352162-352174: `adjust_to_outside` on
//!    the origin, `get_landcell`, `CBuildingObj::add_to_cell`). Here:
//!    [`building_cell_mask`] and [`land_cell_bit`];
//! 4. `ObjectDesc::CheckSlope(walkable->plane.N.z)` on the terrain triangle
//!    `CLandCell::find_terrain_poly` returns — [`check_slope`] with
//!    [`crate::height::triangle_plane_from_grid`];
//! 5. `CPhysicsObj::obj_within_block` (:318307) on the placed object,
//!    BEFORE `SetScaleStatic`, so on the UNSCALED physics shape —
//!    [`WithinBlockShape::within_block`].
//!
//! There is no bounding-box test and no scenery-vs-scenery test anywhere in
//! that loop. ACE's live server (`Physics/Common/Landblock.get_land_scenes`,
//! `Landblock.cs:238-270`) runs the same five gates in the same order.

use holtburger_common::Vector3;
use holtburger_dat::file_type::object_desc::ObjectDesc;

use crate::height::{CELL_SIZE, LANDBLOCK_SIZE};

/// `LandDefs::adjust_to_outside` (`acclient.c:467434`) snaps a coordinate
/// with `fabs(v) < 0.00019999999` (the float `0.0002`) to zero.
const ADJUST_TO_OUTSIDE_EPSILON: f32 = 0.0002;

/// `LandDefs::get_outside_lcoord` / `lcoord_to_gid`: global land-cell
/// coordinates must be in `[0, 2040)`.
const LCOORD_LIMIT: i64 = 2040;

/// The land cell `(ix, iy)` of THIS landblock that holds the LB-local point
/// `(lx, ly)`, or `None` when it is not one of this block's 64 cells.
///
/// `LandDefs::adjust_to_outside` (`acclient.c:467434`) followed by
/// `CLandBlock::get_landcell` (:352098): snap `|v| < 0.0002` to 0, take
/// `floor(v / 24.0)` in double, require the global cell coordinate
/// `lb * 8 + floor` in `[0, 2040)`, and require the resulting cell id to be
/// one of this block's own cells (`lcell[..].m_DID.id == cell_id`), i.e.
/// `0 <= floor < 8`. A point past the block edge lands in a neighbour's
/// cell, which `get_landcell` rejects.
pub fn land_cell_index(landblock_id: u32, lx: f32, ly: f32) -> Option<(u32, u32)> {
    let snap = |v: f32| -> f64 {
        if (v as f64).abs() < ADJUST_TO_OUTSIDE_EPSILON as f64 {
            0.0
        } else {
            v as f64
        }
    };
    let fx = (snap(lx) / CELL_SIZE as f64).floor();
    let fy = (snap(ly) / CELL_SIZE as f64).floor();
    if !(fx.is_finite() && fy.is_finite()) {
        return None;
    }
    if !(0.0..8.0).contains(&fx) || !(0.0..8.0).contains(&fy) {
        return None;
    }
    let (ix, iy) = (fx as i64, fy as i64);
    let gx = ((landblock_id >> 24) & 0xFF) as i64 * 8 + ix;
    let gy = ((landblock_id >> 16) & 0xFF) as i64 * 8 + iy;
    if gx >= LCOORD_LIMIT || gy >= LCOORD_LIMIT {
        return None;
    }
    Some((ix as u32, iy as u32))
}

/// Bit `ix * 8 + iy` for the land cell holding `(lx, ly)` (see
/// [`land_cell_index`]), or `0` when the point is in no cell of this block.
/// The bit order is retail's `lcell` index, `(y & 7) + (x & 7) * 8`.
#[inline]
pub fn land_cell_bit(landblock_id: u32, lx: f32, ly: f32) -> u64 {
    match land_cell_index(landblock_id, lx, ly) {
        Some((ix, iy)) => 1u64 << (ix * 8 + iy),
        None => 0,
    }
}

/// The 64-bit mask of this landblock's land cells that hold a building,
/// from the LB-local origins of `LandblockInfo.buildings[].frame`.
///
/// `CLandBlock::init_buildings` (`acclient.c:352114`) adds each building to
/// the ONE cell holding its origin (`adjust_to_outside` then
/// `get_landcell`); an origin outside the block resolves to a neighbour's
/// cell, `get_landcell` returns null and the building is dropped, so it
/// sets no bit here either. Only buildings count: `LandblockInfo.objects`
/// (stabs) never reach `CSortCell::add_building`.
pub fn building_cell_mask<I>(landblock_id: u32, building_origins: I) -> u64
where
    I: IntoIterator<Item = (f32, f32)>,
{
    building_origins
        .into_iter()
        .fold(0u64, |mask, (x, y)| mask | land_cell_bit(landblock_id, x, y))
}

/// `ObjectDesc::CheckSlope` (`acclient.c:351355`):
/// `z_val >= min_slope && z_val <= max_slope`, where `z_val` is the
/// walkable triangle's `N.z` (the slope cosine; `min_slope`/`max_slope`
/// are cosines too). Both bounds inclusive.
#[inline]
pub fn check_slope(obj: &ObjectDesc, normal_z: f32) -> bool {
    normal_z >= obj.min_slope && normal_z <= obj.max_slope
}

/// One placed candidate, as `CPhysicsObj::obj_within_block` sees it after
/// `set_initial_frame(obj_frame)` and before `SetScaleStatic`: the model
/// id and the placement frame (LB-local origin + orientation). Passed to
/// the `within_block` closure of [`crate::bake_landblock_retail`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WithinBlockQuery {
    /// GfxObj (`0x01xxxxxx`) or SetupModel (`0x02xxxxxx`) DID.
    pub obj_id: u32,
    /// LB-local frame origin (the placement's `x`, `y`, `z`).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Frame orientation, `(w, x, y, z)` — the placement's quaternion.
    pub qw: f32,
    pub qx: f32,
    pub qy: f32,
    pub qz: f32,
}

/// A sphere in the object's own frame, unscaled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlockSphere {
    pub center: Vector3,
    pub radius: f32,
}

impl BlockSphere {
    pub fn new(center: Vector3, radius: f32) -> Self {
        Self { center, radius }
    }
}

/// The physics shape `CPhysicsObj::obj_within_block` (`acclient.c:318307`)
/// bounds inside the landblock. Its ladder is exclusive and ordered:
///
/// 1. `state & HAS_PHYSICS_BSP_PS` (`0x10000`, set when any part GfxObj has
///    a physics BSP, `CPartArray::CacheHasPhysicsBSP` :325428) → the part
///    array's SORTING sphere;
/// 2. else `num_cylsphere > 0` → EVERY cylsphere, by its `low_pt` and
///    radius;
/// 3. else `num_sphere > 0` → the SORTING sphere (`LandDefs::within_block`,
///    not the spheres themselves);
/// 4. else → the frame origin with radius 0.
///
/// [`Self::from_setup`] and [`Self::from_gfx_obj`] build it from DAT fields;
/// the caller owns DAT access.
#[derive(Debug, Clone, PartialEq)]
pub enum WithinBlockShape {
    /// Rungs 1 and 3: the sorting sphere.
    SortingSphere(BlockSphere),
    /// Rung 2: every cylsphere's `low_pt` (the DAT `CylSphere.origin`) and
    /// radius. Never empty when built by [`Self::from_setup`].
    CylSpheres(Vec<BlockSphere>),
    /// Rung 4: the frame origin, radius 0.
    Origin,
}

impl WithinBlockShape {
    /// The ladder for a Setup (`0x02`): `has_physics_bsp` is
    /// `HAS_PHYSICS_BSP_PS` (any part GfxObj with a physics BSP; the Setup's
    /// `HasPhysicsBSP` flag `0x8` agrees on every scenery Setup),
    /// `sorting_sphere` is `CSetup.sorting_sphere`, `cylspheres` is
    /// `CSetup.cylsphere` (`low_pt` + radius) and `num_spheres` is
    /// `CSetup.num_sphere`.
    pub fn from_setup(
        has_physics_bsp: bool,
        sorting_sphere: BlockSphere,
        cylspheres: &[BlockSphere],
        num_spheres: usize,
    ) -> Self {
        if has_physics_bsp {
            WithinBlockShape::SortingSphere(sorting_sphere)
        } else if !cylspheres.is_empty() {
            WithinBlockShape::CylSpheres(cylspheres.to_vec())
        } else if num_spheres > 0 {
            WithinBlockShape::SortingSphere(sorting_sphere)
        } else {
            WithinBlockShape::Origin
        }
    }

    /// The ladder for a bare GfxObj (`0x01`). Retail wraps it with
    /// `CSetup::makeSimpleSetup` (`acclient.c:334456`), which copies only
    /// the sorting sphere (the GfxObj's `physics_sphere`, the physics BSP
    /// root's sphere, else its `drawing_sphere`) and leaves no cylspheres
    /// or spheres: so rung 1 when the GfxObj has a physics BSP, else
    /// rung 4.
    pub fn from_gfx_obj(has_physics_bsp: bool, sorting_sphere: BlockSphere) -> Self {
        Self::from_setup(has_physics_bsp, sorting_sphere, &[], 0)
    }

    /// `CPhysicsObj::obj_within_block` (`acclient.c:318307`): every tested
    /// sphere's frame-transformed centre must satisfy
    /// `r <= x < 192 - r` and `r <= y < 192 - r`
    /// (`LandDefs::within_block` :315583, and the same bounds inline in the
    /// BSP and cylsphere branches).
    pub fn within_block(&self, q: &WithinBlockQuery) -> bool {
        match self {
            WithinBlockShape::SortingSphere(s) => sphere_within_block(q, s),
            WithinBlockShape::CylSpheres(c) => c.iter().all(|s| sphere_within_block(q, s)),
            WithinBlockShape::Origin => point_within_block(q.x, q.y, 0.0),
        }
    }
}

/// `Frame::localtoglobal` (`acclient.c`) of an object-frame point, XY only:
/// `m_fl2gv * p + origin`, with `m_fl2gv` built as `Frame::cache` builds it
/// from the quaternion and stored as float, and the result stored as float.
fn local_to_global_xy(q: &WithinBlockQuery, p: Vector3) -> (f32, f32) {
    let (w, x, y, z) = (q.qw as f64, q.qx as f64, q.qy as f64, q.qz as f64);
    let (b2, c2, d2) = (x + x, y + y, z + z);
    let (wb, wc, wd) = (w * b2, w * c2, w * d2);
    let (xb, xc, xd) = (x * b2, x * c2, x * d2);
    let (yc, yd, zd) = (y * c2, y * d2, z * d2);
    let m0 = (1.0 - yc - zd) as f32 as f64;
    let m1 = (xc + wd) as f32 as f64;
    let m3 = (xc - wd) as f32 as f64;
    let m4 = (1.0 - xb - zd) as f32 as f64;
    let m6 = (xd + wc) as f32 as f64;
    let m7 = (yd - wb) as f32 as f64;
    let (px, py, pz) = (p.x as f64, p.y as f64, p.z as f64);
    let gx = m6 * pz + m0 * px + m3 * py + q.x as f64;
    let gy = m7 * pz + m1 * px + m4 * py + q.y as f64;
    (gx as f32, gy as f32)
}

fn sphere_within_block(q: &WithinBlockQuery, s: &BlockSphere) -> bool {
    let (gx, gy) = local_to_global_xy(q, s.center);
    point_within_block(gx, gy, s.radius)
}

/// `LandDefs::within_block` (`acclient.c:315583`):
/// `x >= r && y >= r && 192 - r > x && 192 - r > y`.
fn point_within_block(x: f32, y: f32, radius: f32) -> bool {
    let (x, y, r) = (x as f64, y as f64, radius as f64);
    let hi = LANDBLOCK_SIZE as f64 - r;
    x >= r && y >= r && x < hi && y < hi
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Quaternion;
    use holtburger_dat::graphics::Frame;

    const LB: u32 = 0xA9B4_0000;

    fn query(x: f32, y: f32, yaw_rad: f32) -> WithinBlockQuery {
        let half = yaw_rad as f64 * 0.5;
        WithinBlockQuery {
            obj_id: 0x0200_0001,
            x,
            y,
            z: 10.0,
            qw: half.cos() as f32,
            qx: 0.0,
            qy: 0.0,
            qz: half.sin() as f32,
        }
    }

    fn sphere(x: f32, y: f32, z: f32, r: f32) -> BlockSphere {
        BlockSphere::new(Vector3::new(x, y, z), r)
    }

    fn obj_with_slope(min_slope: f32, max_slope: f32) -> ObjectDesc {
        ObjectDesc {
            obj_id: 0x0100_0001,
            base_loc: Frame {
                origin: Vector3::new(0.0, 0.0, 0.0),
                orientation: Quaternion::default(),
            },
            freq: 1.0,
            displace_x: 0.0,
            displace_y: 0.0,
            min_scale: 1.0,
            max_scale: 1.0,
            max_rotation: 0.0,
            min_slope,
            max_slope,
            align: 0,
            orient: 0,
            weenie_obj: 0,
        }
    }

    #[test]
    fn land_cell_is_floor_over_24_inside_the_block() {
        assert_eq!(land_cell_index(LB, 0.0, 0.0), Some((0, 0)));
        assert_eq!(land_cell_index(LB, 30.0, 30.0), Some((1, 1)));
        assert_eq!(land_cell_index(LB, 50.0, 30.0), Some((2, 1)));
        assert_eq!(land_cell_index(LB, 24.0, 47.999), Some((1, 1)));
        assert_eq!(land_cell_index(LB, 191.999, 0.5), Some((7, 0)));
        assert_eq!(land_cell_bit(LB, 30.0, 30.0), 1u64 << 9);
        assert_eq!(land_cell_bit(LB, 50.0, 30.0), 1u64 << 17);
        assert_eq!(land_cell_bit(LB, 191.0, 191.0), 1u64 << 63);
    }

    /// `adjust_to_outside` snaps `|v| < 0.0002` to 0, so a hair below the
    /// edge is still cell 0; anything past either edge belongs to a
    /// neighbour and is no cell of this block.
    #[test]
    fn land_cell_snaps_epsilon_and_rejects_neighbour_cells() {
        assert_eq!(land_cell_index(LB, -0.0001, 5.0), Some((0, 0)));
        assert_eq!(land_cell_index(LB, 5.0, -0.000_19), Some((0, 0)));
        assert_eq!(land_cell_index(LB, -0.001, 5.0), None);
        assert_eq!(land_cell_index(LB, 192.0, 5.0), None);
        assert_eq!(land_cell_index(LB, 5.0, 200.0), None);
        assert_eq!(land_cell_index(LB, f32::NAN, 5.0), None);
        assert_eq!(land_cell_bit(LB, -30.0, 5.0), 0);
        // Block x = 0xFF: global x = 2040 + ix, past retail's 2040 limit.
        assert_eq!(land_cell_index(0xFF10_0000, 5.0, 5.0), None);
        assert_eq!(land_cell_index(0xFE10_0000, 191.0, 5.0), Some((7, 0)));
    }

    /// One bit per building origin cell; out-of-block origins set nothing.
    #[test]
    fn building_cell_mask_marks_only_origin_cells() {
        assert_eq!(building_cell_mask(LB, std::iter::empty()), 0);
        let mask = building_cell_mask(
            LB,
            [(30.0f32, 30.0f32), (31.0, 44.0), (100.0, 5.0), (-3.0, 50.0), (195.0, 10.0)],
        );
        // (30,30) and (31,44) share cell (1,1); (100,5) is cell (4,0).
        assert_eq!(mask, (1u64 << 9) | (1u64 << 32));
        assert_eq!(mask.count_ones(), 2);
    }

    #[test]
    fn check_slope_is_inclusive_on_both_bounds() {
        let obj = obj_with_slope(0.95, 1.0);
        assert!(!check_slope(&obj, 0.9));
        assert!(check_slope(&obj, 0.97));
        assert!(check_slope(&obj, 0.95));
        assert!(check_slope(&obj, 1.0));
        let capped = obj_with_slope(0.0, 0.9);
        assert!(!check_slope(&capped, 0.95));
        assert!(check_slope(&capped, 0.0));
    }

    /// The ladder is exclusive and ordered: a BSP wins over cylspheres,
    /// cylspheres over spheres, and spheres mean the SORTING sphere.
    #[test]
    fn ladder_order_matches_obj_within_block() {
        let sorting = sphere(0.0, 0.0, 1.0, 3.0);
        let cyl = [sphere(1.0, 0.0, 0.0, 1.2)];
        assert_eq!(
            WithinBlockShape::from_setup(true, sorting, &cyl, 2),
            WithinBlockShape::SortingSphere(sorting)
        );
        assert_eq!(
            WithinBlockShape::from_setup(false, sorting, &cyl, 2),
            WithinBlockShape::CylSpheres(cyl.to_vec())
        );
        assert_eq!(
            WithinBlockShape::from_setup(false, sorting, &[], 2),
            WithinBlockShape::SortingSphere(sorting)
        );
        assert_eq!(
            WithinBlockShape::from_setup(false, sorting, &[], 0),
            WithinBlockShape::Origin
        );
        assert_eq!(
            WithinBlockShape::from_gfx_obj(true, sorting),
            WithinBlockShape::SortingSphere(sorting)
        );
        assert_eq!(WithinBlockShape::from_gfx_obj(false, sorting), WithinBlockShape::Origin);
    }

    /// A cylsphere at object-local (1, 0) with radius 1.2: its low point
    /// must sit at least 1.2 m inside the block edge. Unrotated, x = 0.1
    /// puts it at 1.1 (out) and x = 0.5 at 1.5 (in); turned 180 degrees,
    /// x = 0.5 puts it at -0.5 (out) and x = 5 at 4 (in).
    #[test]
    fn cylsphere_low_point_is_rotated_and_bounded_by_its_radius() {
        let shape = WithinBlockShape::CylSpheres(vec![sphere(1.0, 0.0, 0.0, 1.2)]);
        assert!(!shape.within_block(&query(0.1, 50.0, 0.0)));
        assert!(shape.within_block(&query(0.5, 50.0, 0.0)));
        let pi = std::f32::consts::PI;
        assert!(!shape.within_block(&query(0.5, 50.0, pi)));
        assert!(shape.within_block(&query(5.0, 50.0, pi)));
        // The far edge: 192 - 1.2 = 190.8 is already out (strict).
        assert!(shape.within_block(&query(189.7, 50.0, 0.0))); // 190.7
        assert!(!shape.within_block(&query(189.9, 50.0, 0.0))); // 190.9
        // Every cylsphere must pass, not just one.
        let two = WithinBlockShape::CylSpheres(vec![
            sphere(1.0, 0.0, 0.0, 1.2),
            sphere(0.0, -3.0, 0.0, 1.0),
        ]);
        assert!(two.within_block(&query(50.0, 50.0, 0.0)));
        assert!(!two.within_block(&query(50.0, 3.5, 0.0))); // second at y 0.5
    }

    /// A sphere-only setup is tested by its sorting sphere: here one far
    /// bigger than the real spheres, so a candidate the spheres would let
    /// through is still rejected.
    #[test]
    fn sphere_only_setup_uses_the_sorting_sphere() {
        let spheres_only =
            WithinBlockShape::from_setup(false, sphere(0.0, 0.0, 2.0, 6.0), &[], 3);
        assert!(!spheres_only.within_block(&query(4.0, 50.0, 0.0)));
        assert!(spheres_only.within_block(&query(6.5, 50.0, 0.0)));
        assert!(!spheres_only.within_block(&query(50.0, 186.5, 0.0)));
        // The sphere centre is rotated with the frame.
        let off_centre = WithinBlockShape::SortingSphere(sphere(0.0, 3.0, 0.0, 1.0));
        assert!(off_centre.within_block(&query(50.0, 0.5, 0.0))); // y 3.5
        assert!(!off_centre.within_block(&query(50.0, 0.5, std::f32::consts::PI))); // y -2.5
    }

    /// No physics shape: the origin with radius 0, i.e. `[0, 192)`.
    #[test]
    fn no_shape_tests_the_origin_with_radius_zero() {
        let none = WithinBlockShape::from_setup(false, sphere(0.0, 0.0, 0.0, 50.0), &[], 0);
        assert_eq!(none, WithinBlockShape::Origin);
        assert!(none.within_block(&query(0.0, 0.0, 1.0)));
        assert!(none.within_block(&query(191.9, 191.9, 0.0)));
        assert!(!none.within_block(&query(192.0, 5.0, 0.0)));
        assert!(!none.within_block(&query(-0.01, 5.0, 0.0)));
    }
}
