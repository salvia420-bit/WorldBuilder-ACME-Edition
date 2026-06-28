//! `CPolygon::find_crossed_edge` — given a sphere resting on (or near) a
//! polygon's plane, find which of the polygon's edges the sphere's center has
//! crossed when projected straight down the `up` axis, and return that edge's
//! outward in-plane normal. The driver uses this to pick an edge-slide
//! collision normal when a sphere walks off a walkable surface.
//!
//! Ported decomp-faithfully from `acclient.c` (Intel-style decompilation).
//!
//! Owns:
//! - [`find_crossed_edge`] — `CPolygon::find_crossed_edge` (acclient.c:360397)

use crate::physics::{PHYSICS_EPSILON, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};

/// `CPolygon::find_crossed_edge` (`acclient.c:360397`).
///
/// Decomp signature:
/// `int CPolygon::find_crossed_edge(CPolygon*, CSphere* sphere, Vector3* up,
/// Vector3* normal)` — returns `1` and fills `*normal` when the projected
/// center lies outside one of the polygon's edges, else `0`. Here that maps to
/// `Some(normal)` / `None`.
///
/// Steps, mirroring the decomp line-for-line:
/// 1. `v4 = N·up`. If `|v4| < 0.00019999999` the plane is perpendicular to
///    `up` (the projection is undefined) → `None`. (acclient.c:360428)
/// 2. `v8 = (N·center + d) / v4` — distance along `up` from the sphere center
///    to the plane (`N·center + d` is the plane's signed distance to the
///    center). (acclient.c:360434)
/// 3. `center' = sphere.center − v8·up` — the center projected onto the plane
///    along `up`. (acclient.c:360440)
/// 4. Walk the edges with `prev` starting at `num_pts − 1` (so the first edge
///    is `vert[0] − vert[last]`). For each edge compute
///    `v16 = disp · (N × edge)` with `disp = center' − last_vertex`; the decomp
///    breaks on FPU flags `c0 | c2`, i.e. `v16 < 0` (the "unordered"/NaN case
///    also breaks, but valid geometry never produces NaN here).
///    (acclient.c:360453)
/// 5. The crossed edge's normal is `N × edge`, normalized in extended
///    precision. (acclient.c:360471)
///
/// The returned vector is the crossed edge's `N × edge`, normalized — an
/// in-plane direction perpendicular to the edge. Its orientation is whatever
/// the cross product yields for the polygon's winding (for a CCW-wound polygon
/// about `N` this points toward the interior); the decomp returns it verbatim
/// and does NOT re-sign it against the displacement. The driver feeds it to the
/// edge-slide response as a collision normal.
pub fn find_crossed_edge(poly: &ResolvedPolygon, sphere: &Sphere, up: Vector3) -> Option<Vector3> {
    let n = poly.plane.normal;

    // (1) v4 = N·up. Bail if the plane is (near) perpendicular to `up`.
    // acclient.c:360428  `if ( fabs(v4) >= 0.00019999999 )`
    let angle_up = n.dot(&up);
    if angle_up.abs() < PHYSICS_EPSILON {
        return None;
    }

    // (2) v8 = (N·center + d) / (N·up). `N·center + d` is the signed distance
    // from the sphere center to the plane. acclient.c:360434
    let dist = n.dot(&sphere.center) + poly.plane.d;
    let t = dist / angle_up;

    // (3) center' = sphere.center − v8·up. acclient.c:360440
    let center = sphere.center - up * t;

    // (4) Walk edges. The decomp's `if ( v6 <= 0 )` early-out; `num_points`
    // should equal `vertices.len()`, but clamp to stay panic-free on malformed
    // resolved polygons. acclient.c:360442
    let verts = &poly.vertices;
    let count = poly.num_points.min(verts.len());
    if count == 0 {
        return None;
    }

    // v12 = 4*v6 - 4 → prev index starts at the last vertex.
    let mut prev = count - 1;
    for i in 0..count {
        let vertex = verts[i];
        let last_vertex = verts[prev];
        prev = i; // v12 = 4*v7 (this iteration's index becomes next iter's prev)

        // edge = vertex − last_vertex. acclient.c:360460
        let edge = vertex - last_vertex;
        // disp = center' − last_vertex. (inlined as `center - last_vertex` in
        // each term of v16)
        let disp = center - last_vertex;

        // v16 = disp · (N × edge). Expanding the decomp's three terms:
        //   (c.z - l.z)*(edge_y*N.x - edge_x*N.y)   = disp.z * (N×edge).z
        //   (c.y - l.y)*(edge_x*N.z - edge_z*N.x)   = disp.y * (N×edge).y
        //   (c.x - l.x)*(edge_z*N.y - edge_y*N.z)   = disp.x * (N×edge).x
        // i.e. exactly disp · (N × edge). acclient.c:360463
        let cross = n.cross(&edge);
        let v16 = disp.dot(&cross);

        // Break on `c0 | c2` → v16 < 0 (NaN also breaks in the decomp, but
        // can't arise from valid geometry). acclient.c:360466
        if v16 < 0.0 {
            // (5) normal = (N × edge) normalized. The decomp accumulates the
            // magnitude in `long double v26` and forms `(1.0 / v26) * comp`;
            // f64 mirrors that extended precision. acclient.c:360479
            let len = (cross.x as f64 * cross.x as f64
                + cross.y as f64 * cross.y as f64
                + cross.z as f64 * cross.z as f64)
                .sqrt();
            let inv = 1.0_f64 / len;
            return Some(Vector3::new(
                (inv * cross.x as f64) as f32,
                (inv * cross.y as f64) as f32,
                (inv * cross.z as f64) as f32,
            ));
        }
    }

    // Fell through every edge → projected center is inside the polygon.
    // acclient.c:360448 `result = 0;`
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// CCW unit-of-2 square (0,0)→(2,0)→(2,2)→(0,2) in the z=0 plane,
    /// outward normal +Z. Wound counter-clockwise about +Z, so `N × edge`
    /// points OUT of the square along each edge.
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

    // Hand derivation (the +X / right edge from (2,0)→(2,2)):
    //   up = +Z, N = +Z, d = 0.
    //   v4 = N·up = 1.
    //   center=(3,1,0.5): v8 = (N·center + d)/v4 = 0.5.
    //   center' = (3,1,0.5) − 0.5·(0,0,1) = (3,1,0).
    //   edge0 vert0−vert3 = (0,-2,0); disp=(3,-1,0); N×edge=(2,0,0); dot=6  ≥0
    //   edge1 vert1−vert0 = (2,0,0);  disp=(3,1,0);  N×edge=(0,2,0); dot=2  ≥0
    //   edge2 vert2−vert1 = (0,2,0);  disp=(1,1,0);  N×edge=(-2,0,0); dot=-2 <0 → CROSS
    //   normal = (-2,0,0)/2 = (-1,0,0).
    #[test]
    fn finds_edge_when_projected_center_outside() {
        let poly = floor();
        let s = Sphere {
            center: v(3.0, 1.0, 0.5),
            radius: 0.5,
        };
        let normal = find_crossed_edge(&poly, &s, v(0.0, 0.0, 1.0)).expect("crossed");
        assert!((normal.x - (-1.0)).abs() < 1e-4, "nx={}", normal.x);
        assert!(normal.y.abs() < 1e-4 && normal.z.abs() < 1e-4);
        assert!((normal.length() - 1.0).abs() < 1e-4);
    }

    // Hand derivation (the bottom edge from (0,0)→(2,0)):
    //   center=(1,-0.5,2): v8 = (N·center + d)/v4 = 2.
    //   center' = (1,-0.5,2) − 2·(0,0,1) = (1,-0.5,0).
    //   edge0 vert0−vert3 = (0,-2,0); disp=(1,-2.5,0); N×edge=(2,0,0); dot=2  ≥0
    //   edge1 vert1−vert0 = (2,0,0);  disp=(1,-0.5,0); N×edge=(0,2,0); dot=-1 <0 → CROSS
    //     N×edge for (2,0,0) = (N_y·e_z−N_z·e_y, N_z·e_x−N_x·e_z, N_x·e_y−N_y·e_x)
    //                        = (0, 1·2, 0) = (0,2,0); normalized → (0,1,0).
    //   The returned vector is exactly the crossed edge's (N×edge), normalized —
    //   the decomp returns the cross-product direction verbatim; it does NOT
    //   re-sign it against `disp` (the break test only chooses WHICH edge). So
    //   the result is (0,1,0), not the geometric outward −Y. We assert the
    //   decomp's value to stay faithful, not the intuitive outward normal.
    #[test]
    fn finds_lower_edge_normal_verbatim() {
        let poly = floor();
        let s = Sphere {
            center: v(1.0, -0.5, 2.0),
            radius: 0.25,
        };
        let normal = find_crossed_edge(&poly, &s, v(0.0, 0.0, 1.0)).expect("crossed");
        assert!((normal.x).abs() < 1e-4, "nx={}", normal.x);
        assert!((normal.y - 1.0).abs() < 1e-4, "ny={}", normal.y);
        assert!(normal.z.abs() < 1e-4, "nz={}", normal.z);
    }

    #[test]
    fn none_when_inside_or_perpendicular() {
        let poly = floor();
        // Projects to (1,1,0): strictly inside every edge → no crossed edge.
        //   edge0 N×edge=(2,0,0) disp=(1,-1,0) dot=2; edge1 (0,2,0) disp=(1,1,0) dot=2;
        //   edge2 (-2,0,0) disp=(-1,1,0) dot=2;  edge3 (0,-2,0) disp=(-1,-1,0) dot=2.
        let inside = Sphere {
            center: v(1.0, 1.0, 0.5),
            radius: 0.5,
        };
        assert!(find_crossed_edge(&poly, &inside, v(0.0, 0.0, 1.0)).is_none());

        // up ⟂ plane normal → N·up = 0 < EPSILON → None (acclient.c:360428).
        assert!(find_crossed_edge(&poly, &inside, v(1.0, 0.0, 0.0)).is_none());
    }
}
