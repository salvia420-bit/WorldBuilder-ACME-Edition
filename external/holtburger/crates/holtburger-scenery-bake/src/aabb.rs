//! Tiny 2D AABB types used by the scenery bake's collision-reject pass.
//!
//! The bake walks every candidate `ObjectDesc` placement and rejects
//! those whose XY bounds intersect either a building (from
//! `LandblockInfo.objects`) or an already-placed scenery item.
//!
//! ACE Scenery.cs:177-184 (`Collision`) uses 3D `BoundingBox.Intersect2D`
//! — but the comparison is XY-only. We collapse the storage to a 2D
//! min/max pair because the height axis is irrelevant to the rejection
//! test and we want the smallest possible per-placement record.
//!
//! `LocalBounds` is the 3D mesh-local bounds for an `ObjectDesc`'s
//! `obj_id`; the caller supplies these via the `fetch_obj_bounds`
//! closure. We project them to 2D via `transform_local_aabb` (rotation
//! + translation + uniform scale) before testing intersection.

use holtburger_common::Vector3;

/// 2D axis-aligned bounding box on the XY plane (Z is dropped).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb2D {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

impl Aabb2D {
    pub fn new(min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    /// Standard 2D AABB-AABB intersection test. Matches ACE
    /// `BoundingBox.Intersect2D` semantics — touching edges count as
    /// intersection (half-open would reject placements that sit
    /// exactly along a building's edge, which retail does NOT do).
    pub fn intersects(&self, other: &Aabb2D) -> bool {
        !(self.max_x < other.min_x
            || self.min_x > other.max_x
            || self.max_y < other.min_y
            || self.min_y > other.max_y)
    }
}

/// Mesh-local 3D bounds for an `ObjectDesc`'s `obj_id`. Caller-supplied
/// via the `fetch_obj_bounds` closure — the bake doesn't load GfxObj
/// vertex tables itself, that's outside its purview.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalBounds {
    pub min: Vector3,
    pub max: Vector3,
}

impl LocalBounds {
    pub fn new(min: Vector3, max: Vector3) -> Self {
        Self { min, max }
    }
}

/// Project a mesh-local 3D bounds to a world-space 2D AABB after
/// applying yaw rotation about Z + uniform scale + XY translation.
///
/// This mirrors ACE `BoundingBox` construction (see `BoundingBox.cs`,
/// the constructor that takes a `ModelMesh` walks the mesh's vertices
/// through `Frame.Transform`). We use the cheaper conservative 4-corner
/// approach: enumerate the 4 corners of the local XY rectangle, rotate
/// each by `rotation_rad` about Z, scale, translate, take the min/max.
/// The Z extent is dropped.
///
/// `tx`, `ty` are the world-space placement position (LB-local coords
/// 0..192). `rotation_rad` is the yaw about Z. `scale` is uniform
/// scale.
pub fn transform_local_aabb(
    local: LocalBounds,
    tx: f32,
    ty: f32,
    rotation_rad: f32,
    scale: f32,
) -> Aabb2D {
    let (s, c) = rotation_rad.sin_cos();
    let corners = [
        (local.min.x, local.min.y),
        (local.max.x, local.min.y),
        (local.min.x, local.max.y),
        (local.max.x, local.max.y),
    ];

    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for (lx, ly) in corners {
        let sx = lx * scale;
        let sy = ly * scale;
        let rx = sx * c - sy * s;
        let ry = sx * s + sy * c;
        let wx = rx + tx;
        let wy = ry + ty;
        if wx < min_x {
            min_x = wx;
        }
        if wy < min_y {
            min_y = wy;
        }
        if wx > max_x {
            max_x = wx;
        }
        if wy > max_y {
            max_y = wy;
        }
    }
    Aabb2D::new(min_x, min_y, max_x, max_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aabb_intersects_overlap() {
        let a = Aabb2D::new(0.0, 0.0, 10.0, 10.0);
        let b = Aabb2D::new(5.0, 5.0, 15.0, 15.0);
        assert!(a.intersects(&b));
        assert!(b.intersects(&a));
    }

    #[test]
    fn aabb_intersects_disjoint() {
        let a = Aabb2D::new(0.0, 0.0, 10.0, 10.0);
        let b = Aabb2D::new(11.0, 0.0, 20.0, 10.0);
        assert!(!a.intersects(&b));
    }

    #[test]
    fn aabb_intersects_touching_edges_count_as_intersect() {
        // Mirrors ACE BoundingBox.Intersect2D — `<` not `<=`.
        let a = Aabb2D::new(0.0, 0.0, 10.0, 10.0);
        let b = Aabb2D::new(10.0, 0.0, 20.0, 10.0);
        assert!(a.intersects(&b));
    }

    #[test]
    fn transform_local_aabb_no_rotation() {
        let local = LocalBounds::new(Vector3::new(-1.0, -2.0, 0.0), Vector3::new(1.0, 2.0, 0.0));
        let w = transform_local_aabb(local, 10.0, 20.0, 0.0, 1.0);
        assert_eq!(w, Aabb2D::new(9.0, 18.0, 11.0, 22.0));
    }

    #[test]
    fn transform_local_aabb_quarter_turn() {
        // 90° rotation about Z swaps (x, y) → (-y, x).
        let local = LocalBounds::new(Vector3::new(-1.0, -2.0, 0.0), Vector3::new(1.0, 2.0, 0.0));
        let w = transform_local_aabb(local, 0.0, 0.0, std::f32::consts::FRAC_PI_2, 1.0);
        // Corners become (2,-1), (2,1), (-2,-1), (-2,1) → AABB ±2 x ±1
        assert!((w.min_x - -2.0).abs() < 1e-5);
        assert!((w.max_x - 2.0).abs() < 1e-5);
        assert!((w.min_y - -1.0).abs() < 1e-5);
        assert!((w.max_y - 1.0).abs() < 1e-5);
    }

    #[test]
    fn transform_local_aabb_scale_doubles_extent() {
        let local = LocalBounds::new(Vector3::new(-1.0, -1.0, 0.0), Vector3::new(1.0, 1.0, 0.0));
        let w = transform_local_aabb(local, 0.0, 0.0, 0.0, 2.0);
        assert_eq!(w, Aabb2D::new(-2.0, -2.0, 2.0, 2.0));
    }
}
