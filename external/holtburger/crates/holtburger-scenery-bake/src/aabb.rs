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

/// World-frame 3D axis-aligned bounding box for one placement.
///
/// DAT-01 phase 1 (2026-07-27). The bake has always computed a
/// world-frame box per candidate placement in order to run ACE's
/// `Collision` rejection — and has always thrown it away afterwards.
/// This is the shipped form of that box, widened to carry the Z extent
/// the collision consumer needs (`holtburger_world::StaticAabbEntry`
/// takes a 3D `Aabb`; the rejection test only ever read XY).
///
/// **Rejection parity contract.** [`Self::xy`] is the box the bake feeds
/// to `Collision`, and it is bit-identical to what the legacy
/// [`transform_mesh_to_aabb`] returns for the same inputs: both walk the
/// same vertex slice in the same order through the same
/// `scale → yaw → translate` chain and accumulate the same XY min/max.
/// Adding the Z accumulator cannot perturb the XY result. See
/// `transform_mesh_to_aabb3_xy_matches_2d` for the pinned test.
///
/// Coordinates are LB-local metres on XY (`[0, 192]`-ish; a placement's
/// mesh may overhang the landblock edge, which is legal and why the box
/// is not clamped) and absolute world metres on Z (terrain-snapped
/// placement Z plus the mesh's local Z extent).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb3D {
    pub min_x: f32,
    pub min_y: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_y: f32,
    pub max_z: f32,
}

impl Aabb3D {
    pub fn new(min_x: f32, min_y: f32, min_z: f32, max_x: f32, max_y: f32, max_z: f32) -> Self {
        Self {
            min_x,
            min_y,
            min_z,
            max_x,
            max_y,
            max_z,
        }
    }

    /// The XY slice — the exact box ACE's `Collision` rejection reads.
    pub fn xy(&self) -> Aabb2D {
        Aabb2D {
            min_x: self.min_x,
            min_y: self.min_y,
            max_x: self.max_x,
            max_y: self.max_y,
        }
    }

    /// Degenerate all-`+inf`/all-`-inf` sentinel — what an empty vertex
    /// list accumulates to. Callers treat a missing mesh as "skip the
    /// placement" before ever reaching here; this exists so test
    /// fixtures and the `Default`-shaped construction sites have one
    /// obviously-invalid value to name.
    pub const EMPTY: Aabb3D = Aabb3D {
        min_x: f32::INFINITY,
        min_y: f32::INFINITY,
        min_z: f32::INFINITY,
        max_x: f32::NEG_INFINITY,
        max_y: f32::NEG_INFINITY,
        max_z: f32::NEG_INFINITY,
    };

    /// True when no vertex was ever folded in (any axis inverted).
    pub fn is_empty(&self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y || self.min_z > self.max_z
    }
}

impl Default for Aabb3D {
    fn default() -> Self {
        Self::EMPTY
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

/// Z-aware twin of [`transform_mesh_to_aabb`]: same per-vertex
/// `scale → yaw-about-Z → translate` chain, same iteration order, but
/// the Z axis is accumulated instead of discarded.
///
/// DAT-01 phase 1. This is the bake's production AABB builder from
/// 2026-07-27 on. Its `.xy()` is bit-identical to
/// [`transform_mesh_to_aabb`] for the same arguments — the Z rotation
/// leaves `v.z` untouched, so the X/Y accumulators see exactly the same
/// sequence of values. That identity is what lets us widen the shipped
/// box without perturbing a single placement-rejection decision (and
/// therefore without perturbing the E5 determinism freeze hash).
pub fn transform_mesh_to_aabb3(
    verts: &[Vector3],
    tx: f32,
    ty: f32,
    tz: f32,
    rotation_rad: f32,
    scale: f32,
) -> Aabb3D {
    let (s, c) = rotation_rad.sin_cos();
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for v in verts {
        let sx = v.x * scale;
        let sy = v.y * scale;
        let rx = sx * c - sy * s;
        let ry = sx * s + sy * c;
        let wx = rx + tx;
        let wy = ry + ty;
        // Yaw is about Z, so Z is scale-then-translate only.
        let wz = v.z * scale + tz;
        if wx < min_x { min_x = wx; }
        if wy < min_y { min_y = wy; }
        if wz < min_z { min_z = wz; }
        if wx > max_x { max_x = wx; }
        if wy > max_y { max_y = wy; }
        if wz > max_z { max_z = wz; }
    }
    Aabb3D::new(min_x, min_y, min_z, max_x, max_y, max_z)
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

    // ---- DAT-01 phase 1: the Z-aware builder ----

    /// THE load-bearing test for DAT-01 phase 1: widening the box to 3D
    /// must not move a single XY bound, because the XY bound is what
    /// ACE's `Collision` rejection reads and therefore what decides
    /// which placements exist at all. Exercised over rotation, scale and
    /// translation so a future refactor that reorders the accumulator
    /// (or folds Z into the rotation) trips here rather than silently
    /// re-shuffling the world.
    #[test]
    fn transform_mesh_to_aabb3_xy_matches_2d() {
        let verts: Vec<Vector3> = (0..37)
            .map(|i| {
                let a = (i as f32) * 0.37;
                Vector3::new(a.cos() * (1.0 + a * 0.05), a.sin() * 2.0, a * 0.11 - 1.0)
            })
            .collect();
        for &(rot, scale, tx, ty, tz) in &[
            (0.0f32, 1.0f32, 0.0f32, 0.0f32, 0.0f32),
            (0.7, 1.0, 10.0, 20.0, 5.0),
            (std::f32::consts::FRAC_PI_3, 1.75, 91.5, 3.25, -12.5),
            (-2.4, 0.5, 191.9, 0.1, 200.0),
        ] {
            let a2 = transform_mesh_to_aabb(&verts, tx, ty, tz, rot, scale);
            let a3 = transform_mesh_to_aabb3(&verts, tx, ty, tz, rot, scale);
            assert_eq!(
                a2,
                a3.xy(),
                "XY drift at rot={rot} scale={scale} t=({tx},{ty},{tz})"
            );
        }
    }

    #[test]
    fn transform_mesh_to_aabb3_z_extent_scales_and_translates() {
        let verts = vec![
            Vector3::new(0.0, 0.0, -1.0),
            Vector3::new(0.0, 0.0, 3.0),
        ];
        // Yaw must not touch Z: quarter turn, scale 2, lifted to z=10.
        let a = transform_mesh_to_aabb3(
            &verts,
            0.0,
            0.0,
            10.0,
            std::f32::consts::FRAC_PI_2,
            2.0,
        );
        assert!((a.min_z - 8.0).abs() < 1e-5, "min_z {}", a.min_z);
        assert!((a.max_z - 16.0).abs() < 1e-5, "max_z {}", a.max_z);
    }

    #[test]
    fn aabb3d_empty_sentinel_reports_empty() {
        assert!(Aabb3D::EMPTY.is_empty());
        assert!(transform_mesh_to_aabb3(&[], 0.0, 0.0, 0.0, 0.0, 1.0).is_empty());
        assert!(!Aabb3D::new(0.0, 0.0, 0.0, 1.0, 1.0, 1.0).is_empty());
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
