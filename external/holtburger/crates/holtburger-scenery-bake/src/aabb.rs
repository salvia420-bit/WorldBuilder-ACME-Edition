//! Tiny 2D AABB types used by the scenery bake's collision-reject pass.
//!
//! The bake walks every candidate `ObjectDesc` placement and rejects
//! those whose XY bounds intersect either a building (from
//! `LandblockInfo.Buildings`) or an already-placed scenery item.
//!
//! ACE Scenery.cs:177-184 (`Collision`) uses 3D `BoundingBox.Intersect2D`
//! — but the comparison is XY-only. We collapse the storage to a 2D
//! min/max pair because the height axis is irrelevant to the rejection
//! test and we want the smallest possible per-placement record.
//!
//! ## AABB construction (bake-side caller responsibility)
//!
//! The bake's `compute_world_aabb` closure is asked for an already-
//! transformed world-frame XY AABB per candidate placement. ACE's
//! `BoundingBox.BuildBox` walks each mesh vertex through
//! `scale * rotate * cellTranslate * cellTranslateInner` and takes
//! per-axis min/max — see [`transform_mesh_to_aabb`] for the bake-
//! crate helper that matches that behaviour bit-for-bit.
//!
//! ## Legacy 4-corner approximation
//!
//! Earlier revisions of the bake used [`LocalBounds`] + the rotated-
//! corner approximation in [`transform_local_aabb`]. That diverged from
//! ACE for rotated objects (corner-rotation produces a strictly LARGER
//! AABB than vertex-rotation) and SetupModel multi-part assemblies
//! (callers were applying per-part `PlacementFrames`, which ACE does
//! NOT — see `BoundingBox.GetTransform` reference in lib.rs). The types
//! survive as compatibility shims for diag tooling; production callers
//! should use [`transform_mesh_to_aabb`].

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

/// Build a world-frame XY AABB from a placement's transformed mesh
/// vertices. Mirrors ACE `BoundingBox.BuildBox` (`BoundingBox.cs:57-81`)
/// bit-for-bit: each vertex passes through
/// `scale * yaw_about_z(rotation_rad) * translate(tx, ty, tz)` and the
/// per-axis min/max accumulator collapses to an XY AABB.
///
/// The Z axis is dropped — `Intersect2D` only reads XY. We still take
/// `tz` so the caller can pass the full world position and we transform
/// vertices in the same coordinate frame ACE does (which matters if a
/// future variant ever wants the Z extent).
///
/// This is the bake's canonical AABB builder. The legacy
/// [`transform_local_aabb`] uses a coarser 4-corner approximation and
/// is retained only for diag tooling.
pub fn transform_mesh_to_aabb(
    verts: &[Vector3],
    tx: f32,
    ty: f32,
    tz: f32,
    rotation_rad: f32,
    scale: f32,
) -> Aabb2D {
    let (s, c) = rotation_rad.sin_cos();
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for v in verts {
        let sx = v.x * scale;
        let sy = v.y * scale;
        let rx = sx * c - sy * s;
        let ry = sx * s + sy * c;
        let wx = rx + tx;
        let wy = ry + ty;
        if wx < min_x { min_x = wx; }
        if wy < min_y { min_y = wy; }
        if wx > max_x { max_x = wx; }
        if wy > max_y { max_y = wy; }
    }
    // tz consumed for signature symmetry with ACE's 3D BuildBox; the
    // 2D collision check doesn't need it but plumbing it keeps the
    // call shape honest.
    let _ = tz;
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

    // transform_mesh_to_aabb tests — the production AABB builder that
    // matches ACE BoundingBox.BuildBox bit-for-bit.

    #[test]
    fn transform_mesh_to_aabb_no_rotation() {
        let verts = vec![
            Vector3::new(-1.0, -2.0, 0.0),
            Vector3::new(1.0, -2.0, 0.0),
            Vector3::new(-1.0, 2.0, 0.0),
            Vector3::new(1.0, 2.0, 0.0),
        ];
        let w = transform_mesh_to_aabb(&verts, 10.0, 20.0, 0.0, 0.0, 1.0);
        assert_eq!(w, Aabb2D::new(9.0, 18.0, 11.0, 22.0));
    }

    #[test]
    fn transform_mesh_to_aabb_is_tighter_than_corner_form_on_octagon() {
        // An octagon-of-radius-1 — half its vertices are diagonals
        // shorter than the 4-corner bounding rectangle would suggest.
        // Rotating 22.5° demonstrates the divergence: corner-form
        // rotation produces an AABB looser than the true rotated mesh.
        let n = 8;
        let r: f32 = 1.0;
        let verts: Vec<Vector3> = (0..n)
            .map(|i| {
                let a = (i as f32) * std::f32::consts::TAU / (n as f32);
                Vector3::new(r * a.cos(), r * a.sin(), 0.0)
            })
            .collect();
        let mesh_aabb = transform_mesh_to_aabb(&verts, 0.0, 0.0, 0.0, std::f32::consts::FRAC_PI_8, 1.0);
        // Octagon is rotation-symmetric mod 45° so the AABB is the
        // bounding box of the vertex set: the vertex farthest from
        // origin along ±X / ±Y after rotation.
        // Loose corner-form bounds would inflate this — confirm by
        // comparing with the legacy transform.
        let legacy = transform_local_aabb(
            LocalBounds::new(Vector3::new(-1.0, -1.0, 0.0), Vector3::new(1.0, 1.0, 0.0)),
            0.0, 0.0, std::f32::consts::FRAC_PI_8, 1.0,
        );
        let mesh_width = mesh_aabb.max_x - mesh_aabb.min_x;
        let legacy_width = legacy.max_x - legacy.min_x;
        assert!(mesh_width < legacy_width,
            "mesh-vertex AABB ({mesh_width}) should be tighter than corner-rotation AABB ({legacy_width})");
    }

    #[test]
    fn transform_mesh_to_aabb_empty_returns_inf_sentinels() {
        // No vertices → AABB stays at +/-infinity sentinels. Caller
        // should treat None-mesh specifically (skip placement) before
        // ever calling this function. Documented so a future regression
        // surfaces in the test.
        let w = transform_mesh_to_aabb(&[], 0.0, 0.0, 0.0, 0.0, 1.0);
        assert!(w.min_x.is_infinite() && w.min_x > 0.0);
        assert!(w.max_x.is_infinite() && w.max_x < 0.0);
    }
}
