//! `CPolygon` walkability predicates — does a resting/landing sphere sit on
//! this polygon as a *walkable* surface, and does it land within the face?
//! Ported decomp-faithfully from `acclient.c`, over
//! [`crate::physics::ResolvedPolygon`] (which already carries the resolved
//! cell-local `vertices` + `plane`).
//!
//! Owns:
//! - [`walkable_hits_sphere`] — `CPolygon::walkable_hits_sphere`  (acclient.c:360519)
//! - [`check_small_walkable`] — `CPolygon::check_small_walkable`  (acclient.c:360312)
//!
//! Discord gotcha (respected here): "walkable" is the normal-`up` test
//! `dot(N, up) > walkable_allowance` (~[`super::types::Z_FOR_LANDING`]), NOT a
//! fixed floor_z. [`walkable_hits_sphere`] takes the allowance as a parameter
//! (the `SPHEREPATH::walkable_allowance` field) so the leaf stays driver- and
//! cell-agnostic.
//!
//! Decomp-vs-ACE divergences (the spec says the DECOMP wins) — both live in
//! [`check_small_walkable`]:
//! 1. The gate is `fabs(N·up) < EPSILON → reject` (decomp `0.00019999999`),
//!    NOT ACE's signed `N·up < EPSILON`. A polygon whose normal faces *away*
//!    from `up` (negative `N·up`) still projects and can register a hit.
//! 2. When an edge is crossed (`disp·(N×edge) < 0`) but the contact is not
//!    within that edge's span, the decomp sets its `spherea` accumulator to 0
//!    and KEEPS scanning (the "sure" sweep); ACE early-`return false`s.

use crate::physics::ResolvedPolygon;
use holtburger_common::{Sphere, Vector3};

use super::types::EPSILON;

/// `CPolygon::walkable_hits_sphere` (`acclient.c:360519`). A polygon counts
/// as a walkable hit when its normal rises above `walkable_allowance` along
/// `up` AND the sphere precisely intersects its face.
///
/// Decomp body:
/// ```text
/// if ( N.z*up.z + N.y*up.y + up.x*N.x > path->walkable_allowance ) {
///   v5 = polygon_hits_sphere_slow_but_sure(this, object, &contact_pt);
///   if ( v5 != polygon_hits_sphere(...) ) { /* debug-only re-check, no-op */ }
///   result = v5;
/// } else result = 0;
/// ```
/// The canonical return is `polygon_hits_sphere_slow_but_sure` — the precise
/// two-pass containment test, faithfully ported as
/// [`ResolvedPolygon::polygon_hits_sphere_precise`]. The
/// `if ( v5 != polygon_hits_sphere(...) )` block recomputes both predicates
/// and discards them (it only trips a retail debug assert), so it is elided.
///
/// `walkable_allowance` is the `SPHEREPATH::walkable_allowance` threshold
/// (defaults to [`super::types::Z_FOR_LANDING`]); the gate is strict `>`.
// acclient.c:360519
pub fn walkable_hits_sphere(
    poly: &ResolvedPolygon,
    walkable_allowance: f32,
    sphere: &Sphere,
    up: Vector3,
) -> bool {
    // N·up = N.z*up.z + N.y*up.y + up.x*N.x  (decomp evaluation order)
    if up.dot(&poly.plane.normal) > walkable_allowance {
        poly.polygon_hits_sphere_precise(sphere).is_some()
    } else {
        false
    }
}

/// `CPolygon::check_small_walkable` (`acclient.c:360312`). Drops the sphere
/// center straight down the `up` axis onto the polygon plane, then tests
/// whether that landing point lies within the face — using the **quarter**
/// acceptance band `radius² * 0.25` (the "small" tightening). Returns a
/// `CSphere*` in the decomp (`1` = hit, `0` = miss); reduced to `bool` here.
///
/// Decomp body (`v3 = N·up`, `spherea` is the result accumulator):
/// ```text
/// v3 = N.y*up.y + N.z*up.z + up.x*N.x;
/// if ( fabs(v3) < 0.00019999999 ) return 0;          // perpendicular/degenerate
/// center' = sphere.center - up * ((N·center + d) / v3);   // project down `up`
/// inside  = radius * radius * 0.25;                  // quarter band
/// spherea = 1;
/// if ( num_pts <= 0 ) return spherea;
/// for each edge (prev = last vertex, then i-1):
///   edge = vert[i] - vert[prev];
///   disp = center' - vert[prev];
///   if ( disp·(N×edge) >= 0 ) goto LABEL_11;          // inside this edge
///   if ( |N×edge|² * inside < (disp·(N×edge))² ) return 0;  // beyond edge reach
///   if ( 0 <= disp·edge <= |edge|² ) return 1;        // within the edge span
///   spherea = 0;                                       // crossed edge, keep scanning
/// LABEL_11:
///   if ( |disp|² <= inside ) return 1;                 // within band of prev vertex
/// return spherea;
/// ```
// acclient.c:360312
pub fn check_small_walkable(poly: &ResolvedPolygon, sphere: &Sphere, up: Vector3) -> bool {
    let n = poly.plane.normal;

    // v3 = N·up. DECOMP gate uses fabs(): a back-facing polygon (negative
    // N·up) still projects. (ACE diverges with a signed `< EPSILON`; decomp
    // wins.) `EPSILON` mirrors the decomp's `0.00019999999`.
    let angle_up = n.dot(&up);
    if angle_up.abs() < EPSILON {
        return false;
    }

    // Project the sphere center straight down `up` onto the polygon plane.
    let center = sphere.center - up * ((n.dot(&sphere.center) + poly.plane.d) / angle_up);

    // Quarter-radius acceptance band (`inside = radius² * 0.25`).
    let radsum = sphere.radius * sphere.radius * 0.25;

    let verts = &poly.vertices;
    if verts.is_empty() {
        // Decomp: `num_pts <= 0` returns `spherea` (== 1, a hit).
        return true;
    }

    let count = verts.len();
    let mut result = true; // `spherea`
    let mut prev_idx = count - 1;
    for i in 0..count {
        let vertex = verts[i];
        let last_vertex = verts[prev_idx];
        prev_idx = i;

        let edge = vertex - last_vertex;
        let disp = center - last_vertex;
        let cross = n.cross(&edge); // N × edge
        let diff = disp.dot(&cross); // disp·(N×edge)

        if diff < 0.0 {
            // Contact projects outside this edge.
            // `if ( v20 | v21 )` — the FPU-flag comparison the decompiler
            // dropped; structurally identical to `polygon_hits_sphere_precise`'s
            // rounded-edge reach test: beyond it, the sphere cannot reach the
            // face → definite miss.
            if cross.length_squared() * radsum < diff * diff {
                return false;
            }
            // Within the edge's span band → confirmed hit.
            let disp_edge = disp.dot(&edge);
            if disp_edge >= 0.0 && disp_edge <= edge.length_squared() {
                return true;
            }
            // Crossed the edge but near a corner: mark not-strictly-inside and
            // KEEP scanning (decomp `spherea = 0`, falling through to LABEL_11).
            result = false;
        }

        // LABEL_11 — reached from both the `diff >= 0` and the fall-through
        // `diff < 0` paths: within the quarter band of the prev vertex → hit.
        if disp.length_squared() <= radsum {
            return true;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::types::Z_FOR_LANDING;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A 2×2 floor at z=0, CCW from above → normal +Z, d=0.
    fn floor() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, 0.0),
                v(2.0, 0.0, 0.0),
                v(2.0, 2.0, 0.0),
                v(0.0, 2.0, 0.0),
            ],
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
        }
    }

    /// The same 2×2 square at z=0 but wound the other way, with an explicit
    /// DOWN normal (-Z, d=0). Used to exercise the decomp's `fabs(N·up)` gate.
    fn down_floor() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, 0.0),
                v(0.0, 2.0, 0.0),
                v(2.0, 2.0, 0.0),
                v(2.0, 0.0, 0.0),
            ],
            plane: Plane {
                normal: v(0.0, 0.0, -1.0),
                d: 0.0,
            },
        }
    }

    /// A vertical wall in the x=0 plane, normal +X, d=0.
    fn wall() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, 0.0),
                v(0.0, 2.0, 0.0),
                v(0.0, 2.0, 2.0),
                v(0.0, 0.0, 2.0),
            ],
            plane: Plane {
                normal: v(1.0, 0.0, 0.0),
                d: 0.0,
            },
        }
    }

    // ── check_small_walkable ────────────────────────────────────────────

    // Hand-derived: center (1,1,0.5), r=1, up=+Z.
    //   angle_up = N·up = 1 ≥ EPSILON.
    //   t = (N·center + d)/angle_up = 0.5/1 = 0.5 → center' = (1,1,0).
    //   radsum = 1²·0.25 = 0.25.
    //   Every edge gives disp·(N×edge) = +2 ≥ 0 (contact strictly inside) →
    //   spherea stays 1 → HIT.
    #[test]
    fn check_small_walkable_interior_landing_hits() {
        let s = Sphere {
            center: v(1.0, 1.0, 0.5),
            radius: 1.0,
        };
        assert!(check_small_walkable(&floor(), &s, v(0.0, 0.0, 1.0)));
    }

    // Hand-derived: center (5,1,0.5), r=0.5, up=+Z → center' = (5,1,0).
    //   radsum = 0.5²·0.25 = 0.0625.
    //   The x=2 edge (vert (2,0,0)→(2,2,0)) has edge=(0,2,0), N×edge=(-2,0,0),
    //   disp=(3,1,0), diff = disp·cross = -6 < 0.
    //   reach test: |N×edge|²·radsum = 4·0.0625 = 0.25 < diff² = 36 → MISS.
    #[test]
    fn check_small_walkable_off_face_misses() {
        let s = Sphere {
            center: v(5.0, 1.0, 0.5),
            radius: 0.5,
        };
        assert!(!check_small_walkable(&floor(), &s, v(0.0, 0.0, 1.0)));
    }

    // Decomp-wins divergence: a DOWN-facing polygon (N·up = -1) below the
    // sphere. `fabs(-1) = 1 ≥ EPSILON` so the decomp projects center (1,1,0.5)
    // down to (1,1,0); with the -Z winding every edge gives diff = +2 ≥ 0 →
    // HIT. ACE's signed `N·up < EPSILON` gate would `return false` here.
    #[test]
    fn check_small_walkable_back_facing_still_projects() {
        let s = Sphere {
            center: v(1.0, 1.0, 0.5),
            radius: 1.0,
        };
        assert!(check_small_walkable(&down_floor(), &s, v(0.0, 0.0, 1.0)));
    }

    // Gate: a wall (normal +X) tested with up=+Z → N·up = 0, fabs(0) < EPSILON
    // → reject (true in BOTH decomp and ACE).
    #[test]
    fn check_small_walkable_perpendicular_rejected() {
        let s = Sphere {
            center: v(0.3, 1.0, 1.0),
            radius: 0.5,
        };
        assert!(!check_small_walkable(&wall(), &s, v(0.0, 0.0, 1.0)));
    }

    // ── walkable_hits_sphere ────────────────────────────────────────────

    // Flat floor: N·up = 1 > Z_FOR_LANDING (≈0.0872); sphere (1,1,0.3) r=0.5
    // straddles the plane and its in-plane projection (1,1,0) is inside the
    // face → precise hit → walkable.
    #[test]
    fn walkable_hits_sphere_flat_floor_hits() {
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        assert!(walkable_hits_sphere(
            &floor(),
            Z_FOR_LANDING,
            &s,
            v(0.0, 0.0, 1.0)
        ));
    }

    // Vertical wall: N·up = 0, NOT > Z_FOR_LANDING → gate fails before any
    // hit test → never walkable.
    #[test]
    fn walkable_hits_sphere_wall_gate_fails() {
        let s = Sphere {
            center: v(0.3, 1.0, 1.0),
            radius: 0.5,
        };
        assert!(!walkable_hits_sphere(
            &wall(),
            Z_FOR_LANDING,
            &s,
            v(0.0, 0.0, 1.0)
        ));
    }

    // Gate passes (flat floor) but the sphere is far off the face: projection
    // (10,10,0) lies outside every edge → precise returns None → not walkable.
    #[test]
    fn walkable_hits_sphere_gate_passes_but_off_face() {
        let s = Sphere {
            center: v(10.0, 10.0, 0.3),
            radius: 0.5,
        };
        assert!(!walkable_hits_sphere(
            &floor(),
            Z_FOR_LANDING,
            &s,
            v(0.0, 0.0, 1.0)
        ));
    }
}
