//! `CPolygon` sphere-to-plane / sphere-to-poly adjustment solvers — given a
//! moving sphere and the plane of one polygon, find how far back along the
//! motion the sphere must rewind to rest tangent to that plane. Ported
//! decomp-faithfully from `acclient.c`.
//!
//! Owns:
//! - [`adjust_sphere_to_plane`] — `CPolygon::adjust_sphere_to_plane` (acclient.c:359534)
//! - [`adjust_sphere_to_poly`]  — `CPolygon::adjust_sphere_to_poly`  (acclient.c:359498)
//!
//! Faithful cross-ref: ACE `Polygon.adjust_sphere_to_plane` /
//! `adjust_sphere_to_poly` (`Physics/Polygon.cs:73-114`). Where the decomp
//! and ACE differ, the decomp wins — see the `adjust_sphere_to_poly`
//! DECOMP-NOTE for the one place the decompiler dropped a comparison and ACE
//! recovers it.
//!
//! ## Interface — mutate-in-place + `bool` (matches the decomp)
//! `adjust_sphere_to_plane` mirrors the decomp's `__thiscall` exactly: it
//! takes `&mut SPHEREPATH` / `&mut CSphere`, rewinds `valid_pos.center` and
//! tightens `path.walk_interp` IN PLACE, and returns the decomp's `int`
//! as a `bool`. This is deliberate, not a convenience: the caller
//! `BSPLEAF::sphere_intersects_solid` (acclient.c:364330) loops this over
//! every poly in a leaf, and each success tightens the SHARED
//! `path.walk_interp`, so the final value is the minimum back-off across all
//! polys. Returning a pure value would break that running accumulation.
//! `adjust_sphere_to_poly` is already pure in the decomp (it returns a
//! `double` time fraction), so it is ported as a pure `fn`.

use super::types::SpherePath;
use crate::physics::{PHYSICS_EPSILON, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};

/// `CPolygon::adjust_sphere_to_plane` (`acclient.c:359534`; faithful
/// cross-ref ACE `Polygon.adjust_sphere_to_plane`, `Polygon.cs:73-97`).
///
/// Solves for the fraction `t` of `movement` to rewind so the sphere rests
/// tangent to `poly`'s plane, then — on success — backs `valid_pos.center`
/// off by `t * movement` and tightens `path.walk_interp`. Returns `true`
/// when an adjustment was applied, `false` for the decomp's three
/// `return 0` reject paths:
/// - motion (near-)parallel to the plane (`|N·movement| <= EPSILON`),
/// - the new interpolation is no better than the running budget
///   (`interp >= path.walk_interp`),
/// - or it overshoots behind the path start (`interp < -0.5`).
///
/// MUTATES `valid_pos.center` and `path.walk_interp` in place (see module doc).
pub fn adjust_sphere_to_plane(
    poly: &ResolvedPolygon,
    path: &mut SpherePath,
    valid_pos: &mut Sphere,
    movement: &Vector3,
) -> bool {
    let plane = &poly.plane;

    // v5 = N·center + d — signed distance of the sphere center to the plane.
    let dp_pos = plane.normal.dot(&valid_pos.center) + plane.d;
    // v6 = N·movement   — motion component along the plane normal.
    let dp_move = plane.normal.dot(movement);

    // Numerator selection mirrors the decomp's branch on the sign of v6:
    //   if ( v6 <= EPSILON ) { if ( v6 >= -EPSILON ) return 0; v8 = v5 - r; }
    //   else                { v8 = -r - v5; }
    // (v9 == v6 in both branches, so the denominator is always dp_move.)
    let numerator;
    if dp_move <= PHYSICS_EPSILON {
        if dp_move >= -PHYSICS_EPSILON {
            // |N·movement| <= EPSILON: motion parallel to the plane — no cross.
            return false;
        }
        // v6 < -EPSILON: rest tangent on the +radius (front) side.
        numerator = dp_pos - valid_pos.radius;
    } else {
        // v6 > EPSILON: rest tangent on the -radius (back) side.
        numerator = -valid_pos.radius - dp_pos;
    }

    // v12 = v8 / v9.
    let i_dist = numerator / dp_move;
    // v13 = (1.0 - v12) * walk_interp.
    let interp = (1.0 - i_dist) * path.walk_interp;
    // if ( v13 >= walk_interp || v13 < -0.5 ) return 0.
    if interp >= path.walk_interp || interp < -0.5 {
        return false;
    }

    // center -= v12 * movement ; walk_interp = v13 ; return 1.
    valid_pos.center = valid_pos.center - *movement * i_dist;
    path.walk_interp = interp;
    true
}

/// `CPolygon::adjust_sphere_to_poly` (`acclient.c:359498`; faithful
/// cross-ref ACE `Polygon.adjust_sphere_to_poly`, `Polygon.cs:99-114`).
///
/// Returns the fraction of `movement` (starting from `curr_pos`) at which a
/// sphere of radius `check_pos.radius` first becomes tangent to `poly`'s
/// plane — the time-of-intersection the BSP refine loop
/// `BSPTREE::adjust_to_plane` (acclient.c:360952) brackets:
/// - `1.0` when the start point is already within one radius of the plane
///   (the decomp's `radius <= |dpPos|` guard is false → no room to advance),
/// - `0.0` when the motion is (near-)parallel to the plane
///   (`|N·movement| < EPSILON`),
/// - otherwise `(±radius − dpPos) / (N·movement)`.
///
/// `check_pos` is the moving sphere, but only its `radius` is read here; the
/// position tested is the separate `curr_pos` argument (exactly the decomp,
/// where `BSPTREE::adjust_to_plane` passes `&curr_pos` distinct from the
/// `check_pos` sphere).
///
/// ### DECOMP-NOTE — the radius-sign flip
/// The decomp reads `v7 = check_pos->radius; if ( v8 | v9 ) v7 = -v7;` where
/// `v8`/`v9` are dangling x87 condition-code temporaries (`c0`/`c3` =
/// "below"/"equal", i.e. `<=`) whose originating `fcom` the decompiler
/// dropped — no visible expression sets them. ACE (gmriggs' straight
/// translation) recovers the lost comparison as
/// `movement.LengthSquared() <= radius²` (`Polygon.cs:110`): a sub-radius
/// step flips the tangent target to the −radius face. The bare decomp flags
/// don't contradict that — they're simply unrendered — so we port ACE's
/// recovered predicate.
///
/// Computed in `f64` to mirror the decomp's `long double` accumulation and
/// `double` return.
pub fn adjust_sphere_to_poly(
    poly: &ResolvedPolygon,
    check_pos: &Sphere,
    curr_pos: &Vector3,
    movement: &Vector3,
) -> f64 {
    let plane = &poly.plane;

    // curr_posa = N·curr_pos + d.
    let dp_pos = plane.normal.dot(curr_pos) + plane.d;

    // if ( radius <= fabs(curr_posa) ) { ... } else result = 1.0.
    if check_pos.radius <= dp_pos.abs() {
        // v5 = N·movement.
        let dp_move = plane.normal.dot(movement);
        // if ( fabs(v5) >= EPSILON ) { ... } else result = 0.0.
        if dp_move.abs() >= PHYSICS_EPSILON {
            // v7 = radius; if ( movement.LengthSquared() <= radius² ) v7 = -v7.
            let mut radius = check_pos.radius;
            if movement.length_squared() <= radius * radius {
                radius = -radius;
            }
            // result = (v7 - curr_posa) / v5.
            (radius as f64 - dp_pos as f64) / dp_move as f64
        } else {
            0.0
        }
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A bare polygon carrying only the plane the solvers read (vertices are
    /// untouched by these two methods).
    fn poly(normal: Vector3, d: f32) -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 0,
            vertices: Vec::new(),
            plane: Plane { normal, d },
        }
    }

    fn path_with_interp(walk_interp: f32) -> SpherePath {
        SpherePath {
            walk_interp,
            ..Default::default()
        }
    }

    fn sphere(center: Vector3, radius: f32) -> Sphere {
        Sphere { center, radius }
    }

    // ── adjust_sphere_to_plane ──────────────────────────────────────────

    #[test]
    fn adjust_sphere_to_plane_front_face_backs_off_to_tangent() {
        // z=0 plane, sphere center 0.3 above it (penetrating, r=0.5), moving
        // straight down; walk_interp budget 1.0.
        //   dpPos=0.3, dpMove=-1 (< -EPS) → num = 0.3-0.5 = -0.2
        //   t = -0.2 / -1 = 0.2 ; interp = (1-0.2)*1 = 0.8 (in window)
        //   center -= (0,0,-1)*0.2 → z = 0.3 + 0.2 = 0.5 (== +radius: tangent)
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let mut path = path_with_interp(1.0);
        let mut s = sphere(v(0.0, 0.0, 0.3), 0.5);
        assert!(adjust_sphere_to_plane(&p, &mut path, &mut s, &v(0.0, 0.0, -1.0)));
        assert!(s.center.x.abs() < 1e-4);
        assert!(s.center.y.abs() < 1e-4);
        assert!((s.center.z - 0.5).abs() < 1e-4, "z={}", s.center.z);
        assert!((path.walk_interp - 0.8).abs() < 1e-4, "interp={}", path.walk_interp);
    }

    #[test]
    fn adjust_sphere_to_plane_tilted_front_face_tangent() {
        // Tilted unit normal (0.6,0,0.8). center on the +normal ray at
        // dpPos=0.3 (r=0.5), moving along -normal (unit), budget 1.0.
        //   dpMove = N·(-N) = -1 ; num = 0.3-0.5 = -0.2 ; t = 0.2
        //   interp = (1-0.2)*1 = 0.8
        //   center = (0.18,0,0.24) - (-0.6,0,-0.8)*0.2 = (0.30,0,0.40)
        //   check: N·(0.30,0,0.40) = 0.18+0.32 = 0.5 = +radius (tangent)
        let p = poly(v(0.6, 0.0, 0.8), 0.0);
        let mut path = path_with_interp(1.0);
        let mut s = sphere(v(0.18, 0.0, 0.24), 0.5);
        assert!(adjust_sphere_to_plane(&p, &mut path, &mut s, &v(-0.6, 0.0, -0.8)));
        assert!((s.center.x - 0.30).abs() < 1e-4, "x={}", s.center.x);
        assert!(s.center.y.abs() < 1e-4);
        assert!((s.center.z - 0.40).abs() < 1e-4, "z={}", s.center.z);
        assert!((path.walk_interp - 0.8).abs() < 1e-4, "interp={}", path.walk_interp);
    }

    #[test]
    fn adjust_sphere_to_plane_back_face_branch_arithmetic() {
        // Exercises the v6 > EPSILON (back face) numerator = -r - dpPos.
        // center fully below z=0 (dpPos=-1.0, r=0.5), moving up; budget 1.0.
        //   dpMove = +1 (> EPS) → num = -0.5 - (-1.0) = 0.5 ; t = 0.5
        //   interp = (1-0.5)*1 = 0.5 (in window)
        //   center -= (0,0,1)*0.5 → z = -1.0 - 0.5 = -1.5
        // (Verifies the raw decomp arithmetic of the else-branch, not a
        //  geometric tangency — that branch is only reached for crossings
        //  the leaf has already pre-screened.)
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let mut path = path_with_interp(1.0);
        let mut s = sphere(v(0.0, 0.0, -1.0), 0.5);
        assert!(adjust_sphere_to_plane(&p, &mut path, &mut s, &v(0.0, 0.0, 1.0)));
        assert!((s.center.z + 1.5).abs() < 1e-4, "z={}", s.center.z);
        assert!((path.walk_interp - 0.5).abs() < 1e-4, "interp={}", path.walk_interp);
    }

    #[test]
    fn adjust_sphere_to_plane_rejects_parallel_motion() {
        // dpMove == 0 → |dpMove| <= EPSILON → return false, no mutation.
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let mut path = path_with_interp(1.0);
        let mut s = sphere(v(0.0, 0.0, 0.3), 0.5);
        assert!(!adjust_sphere_to_plane(&p, &mut path, &mut s, &v(1.0, 0.0, 0.0)));
        assert_eq!(s.center, v(0.0, 0.0, 0.3));
        assert_eq!(path.walk_interp, 1.0);
    }

    #[test]
    fn adjust_sphere_to_plane_rejects_out_of_window() {
        // Far above and descending: t goes negative → interp >= budget.
        //   dpPos=1.0, dpMove=-1 → num = 1.0-0.5 = 0.5 ; t = -0.5
        //   interp = (1-(-0.5))*1 = 1.5 >= 1.0 → reject, no mutation.
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let mut path = path_with_interp(1.0);
        let mut s = sphere(v(0.0, 0.0, 1.0), 0.5);
        assert!(!adjust_sphere_to_plane(&p, &mut path, &mut s, &v(0.0, 0.0, -1.0)));
        assert_eq!(s.center, v(0.0, 0.0, 1.0));
        assert_eq!(path.walk_interp, 1.0);
    }

    // ── adjust_sphere_to_poly ───────────────────────────────────────────

    #[test]
    fn adjust_sphere_to_poly_already_within_radius_is_one() {
        // |dpPos| = 0.3 < radius 0.5 → radius <= |dpPos| is false → 1.0.
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let t = adjust_sphere_to_poly(&p, &sphere(v(0.0, 0.0, 0.3), 0.5), &v(0.0, 0.0, 0.3), &v(0.0, 0.0, -1.0));
        assert!((t - 1.0).abs() < 1e-9, "t={t}");
    }

    #[test]
    fn adjust_sphere_to_poly_parallel_movement_is_zero() {
        // dpPos=2.0 (>= radius), but N·movement = 0 → |dpMove| < EPSILON → 0.0.
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let t = adjust_sphere_to_poly(&p, &sphere(v(0.0, 0.0, 2.0), 0.5), &v(0.0, 0.0, 2.0), &v(1.0, 0.0, 0.0));
        assert!(t.abs() < 1e-9, "t={t}");
    }

    #[test]
    fn adjust_sphere_to_poly_long_descent_no_sign_flip() {
        // dpPos=2.0, dpMove=-1, |move|²=1.0 > r²=0.25 → no flip (r=+0.5)
        //   t = (0.5 - 2.0) / -1 = 1.5
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let t = adjust_sphere_to_poly(&p, &sphere(v(0.0, 0.0, 2.0), 0.5), &v(0.0, 0.0, 2.0), &v(0.0, 0.0, -1.0));
        assert!((t - 1.5).abs() < 1e-6, "t={t}");
    }

    #[test]
    fn adjust_sphere_to_poly_short_step_flips_radius_sign() {
        // dpPos=2.0, dpMove=-0.4, |move|²=0.16 <= r²=0.25 → flip (r=-0.5)
        //   t = (-0.5 - 2.0) / -0.4 = 6.25
        let p = poly(v(0.0, 0.0, 1.0), 0.0);
        let t = adjust_sphere_to_poly(&p, &sphere(v(0.0, 0.0, 2.0), 0.5), &v(0.0, 0.0, 2.0), &v(0.0, 0.0, -0.4));
        assert!((t - 6.25).abs() < 1e-6, "t={t}");
    }

    #[test]
    fn adjust_sphere_to_poly_tilted_plane() {
        // Tilted unit normal (0.6,0,0.8), d=0. curr=(1,0,2): dpPos=0.6+1.6=2.2.
        // movement=(-0.6,0,-0.8): dpMove=-1.0, |move|²=1.0 > r²=0.25 (no flip).
        //   t = (0.5 - 2.2) / -1.0 = 1.7
        let p = poly(v(0.6, 0.0, 0.8), 0.0);
        let t = adjust_sphere_to_poly(&p, &sphere(v(1.0, 0.0, 2.0), 0.5), &v(1.0, 0.0, 2.0), &v(-0.6, 0.0, -0.8));
        assert!((t - 1.7).abs() < 1e-6, "t={t}");
    }
}
