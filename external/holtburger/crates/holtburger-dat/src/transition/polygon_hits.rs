//! `CPolygon` sphere-hit predicates — the single-pass boundary test and the
//! directional (front-face) variant. Ported decomp-faithfully from
//! `acclient.c`, operating on [`crate::physics::ResolvedPolygon`] (which
//! already carries the resolved cell-local `vertices` + `plane`).
//!
//! Owns:
//! - [`polygon_hits_sphere`] — `CPolygon::polygon_hits_sphere`  (acclient.c:359916)
//! - [`pos_hits_sphere`]     — `CPolygon::pos_hits_sphere`      (acclient.c:360494)
//!
//! Lineage of the two-pass *precise* test: the decomp's
//! `CPolygon::polygon_hits_sphere_slow_but_sure` (`acclient.c:360006`,
//! sub `00538A10`) is the double-loop containment solver. It already lives
//! faithfully on `ResolvedPolygon` in `crate::physics` as
//! [`ResolvedPolygon::polygon_hits_sphere_precise`] (ACE
//! `Polygon.polygon_hits_sphere_precise`, Polygon.cs:331-384). The decomp's
//! `pos_hits_sphere` calls `..slow_but_sure` (and ACE's `pos_hits_sphere`
//! likewise calls `..precise`), so [`pos_hits_sphere`] reuses that canonical
//! port rather than duplicating the nested loop here — the spec blesses
//! `use crate::physics::*` and forbids touching `physics.rs`, so reuse keeps
//! the two copies from ever diverging.
//!
//! This module's own contribution is the *single-pass*
//! [`polygon_hits_sphere`] (`acclient.c:359916`, sub `00539870`), which the
//! `slow_but_sure`/`precise` solver refines.

use crate::physics::{PHYSICS_EPSILON, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};

/// `CPolygon::polygon_hits_sphere` (`acclient.c:359916`; ACE
/// `Polygon.polygon_hits_sphere`, Polygon.cs:289-329). Single-pass boundary
/// test: project the sphere center onto the polygon plane, then walk the
/// edges once. Returns `Some(contact_point)` when the sphere touches the
/// polygon face / edge band, else `None`.
///
/// Decomp flow (faithful):
/// 1. `v4 = N·center + d` is the signed plane distance; `v5 = radius - EPS`
///    is the slab half-thickness. If `|v4| > v5` the plane is out of reach
///    → `return 0` (`None`).
/// 2. `objecta = v5² - v4²` (`diff`) is the squared in-plane reach of the
///    sphere at its plane slice; `contact = center - v4·N` projects the
///    center onto the plane.
/// 3. With `num_pts <= 0` the decomp `return LODWORD(radsq)` where
///    `radsq == 1` → `Some(contact)` (a degenerate face the slab already
///    cleared counts as a hit). NOTE: this reject-then-empty order is the
///    decomp's; the projected `contact` is returned, NOT `None`.
/// 4. Walk edges `(last = V[prev], curr = V[i])`, `prev` seeded to the last
///    vertex. For each edge `e = curr - last`, `disp = contact - last`, and
///    the in-plane outward test `dp = disp · (N × e)`:
///    - `dp >= 0`: contact is inside this edge — fall through to the
///      radial check.
///    - `dp < 0`: contact is outside this edge. If `‖N×e‖²·diff < dp²` the
///      contact is beyond the edge's rounded reach → `return 0` (`None`).
///      Else if the projection onto the edge lies within `[0, ‖e‖²]` the
///      sphere grazes the edge segment → `return 1` (`Some(contact)`).
///      Otherwise clear `result` (an outside-but-near-a-corner edge).
///    - Either branch then tests `‖disp‖² <= diff` → `Some(contact)`
///      (the contact is within radial reach of `last`).
/// 5. After all edges, `return radsq` → `Some(contact)` unless some edge
///    cleared `result` (outside a corner) → `None`.
///
/// The decomp evaluates `dp` as the expanded triple product
/// `disp.z·(e.y·N.x − e.x·N.y) + disp.y·(e.x·N.z − e.z·N.x)
///  + disp.x·(e.z·N.y − e.y·N.z)`, which is exactly `disp · (N × e)`; we use
/// `N.cross(e)` / `disp.dot(..)` (sum-order differs by < 1 ULP, far under the
/// 1e-4 tolerance and immaterial to every sign test).
pub fn polygon_hits_sphere(poly: &ResolvedPolygon, sphere: &Sphere) -> Option<Vector3> {
    let n = &poly.plane.normal;

    // (1) plane-distance reject — comes BEFORE the empty-face check, per decomp.
    let dp_pos = n.dot(&sphere.center) + poly.plane.d; // v4 = N·center + d
    let rad = sphere.radius - PHYSICS_EPSILON; // v5 = radius - 0.00019999999
    if dp_pos.abs() > rad {
        // `if ( v5 < fabs(v4) ) return 0;`
        return None;
    }

    // (2) squared in-plane reach + the projected contact point.
    let diff = rad * rad - dp_pos * dp_pos; // objecta = v5² - v4²
    let contact = sphere.center - *n * dp_pos; // contact = center - v4·N

    // (3) degenerate face: `if ( num_pts <= 0 ) return LODWORD(radsq)` (==1).
    let verts = &poly.vertices;
    let count = verts.len();
    if count == 0 {
        return Some(contact);
    }

    // (4) single edge walk. `result` is the decomp's `radsq` flag (1 → true).
    let mut result = true;
    let mut prev_idx = count - 1; // v17 = 4*num_pts - 4 (last vertex)
    for i in 0..count {
        let vertex = verts[i]; // v19 = vertices[i]
        let last_vertex = verts[prev_idx]; // *(vertices + prev)
        prev_idx = i; // next iteration's `last`

        let edge = vertex - last_vertex; // e = curr - last
        let disp = contact - last_vertex; // disp = contact - last
        let cross = n.cross(&edge); // N × e
        let dp = disp.dot(&cross); // disp · (N × e)

        if dp < 0.0 {
            // Contact is outside this edge.
            if cross.length_squared() * diff < dp * dp {
                // Beyond the edge's rounded reach (`v23 | v24` FPU flags).
                return None;
            }
            let disp_edge = disp.dot(&edge); // v25 = disp · e
            if disp_edge >= 0.0 && disp_edge <= edge.length_squared() {
                // Grazes the edge segment itself.
                return Some(contact);
            }
            result = false; // `radsq = 0.0`
        }

        // LABEL_11: radial reach of the edge's start vertex (runs for dp>=0 too).
        if disp.length_squared() <= diff {
            return Some(contact);
        }
    }

    // (5) `return LODWORD(radsq)` — Some unless an edge cleared `result`.
    if result { Some(contact) } else { None }
}

/// `CPolygon::pos_hits_sphere` (`acclient.c:360494`, sub `00539500`; ACE
/// `Polygon.pos_hits_sphere`, Polygon.cs:386-398). The directional variant:
/// run the *precise* containment test, then gate on the front-face condition
/// — a sphere only strikes this face if it is moving INTO the front (`N`)
/// side, i.e. `movement · N < 0`. Returns the contact point on a confirmed
/// front-face hit, else `None`.
///
/// Decomp flow (faithful):
/// ```c
/// v5 = CPolygon::polygon_hits_sphere_slow_but_sure(this, object, contact_pt);
/// if ( v5 )            *struck_poly = this;          // garbled `v6` == this
/// if ( N · movement >= 0.0 )  result = 0;
/// else                        result = v5;
/// return result;
/// ```
/// - `..slow_but_sure` is the double-loop precise solver — here
///   [`ResolvedPolygon::polygon_hits_sphere_precise`] (the canonical port in
///   `crate::physics`; the decomp's `00538A10` body). Reused, not re-ported,
///   to stay byte-identical with `physics.rs`.
/// - `struck_poly = this` (the decomp's uninitialized `v6` is the `this`
///   register) is the CALLER's bookkeeping: it remembers which polygon a
///   `true` came from. In our `Option<Vector3>` shape the caller already
///   knows which `poly` it passed, so the "struck poly" identity is recorded
///   by the driver (Phase 3 `SPHEREPATH`/`CTransition`), not threaded out
///   here. The decomp writes it before the front-face gate, but a gated-false
///   return is ignored by every call site (e.g. the `!pos_hits_sphere(...)`
///   loop at `acclient.c:364214`), so dropping the early write is behaviorally
///   faithful.
/// - The front-face gate uses `>= 0.0` (NOT `> 0.0`): a movement exactly
///   tangent to the face counts as "not moving in" → `None`.
pub fn pos_hits_sphere(
    poly: &ResolvedPolygon,
    sphere: &Sphere,
    movement: Vector3,
) -> Option<Vector3> {
    // v5 = ..slow_but_sure(object, contact_pt)  — the precise double-loop solver.
    let hit = poly.polygon_hits_sphere_precise(sphere);

    // `if ( N · movement >= 0.0 ) return 0;` — reject unless moving into the
    // front face. Gate applies regardless of whether the precise test hit.
    if movement.dot(&poly.plane.normal) >= 0.0 {
        return None;
    }

    // else `result = v5` — the precise contact point (or None on a miss).
    hit
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A unit square in the `z = 0` plane, outward normal `+Z`, wound CCW
    /// `(0,0)→(1,0)→(1,1)→(0,1)`. Edge `i` runs `V[i-1] → V[i]` (prev seeded
    /// to the last vertex), so each `N × edge` points INWARD.
    fn unit_square() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, 0.0),
                v(1.0, 0.0, 0.0),
                v(1.0, 1.0, 0.0),
                v(0.0, 1.0, 0.0),
            ],
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
        }
    }

    // ── polygon_hits_sphere ──────────────────────────────────────────────

    #[test]
    fn hits_over_face_returns_projected_contact() {
        // center (0.5,0.5,0.3), r=0.5 → dpPos=0.3 ≤ rad=0.4998, so the slab
        // passes. contact = center - 0.3·(0,0,1) = (0.5,0.5,0) — strictly
        // inside, every edge gives dp≥0, result stays true → Some(contact).
        let s = Sphere {
            center: v(0.5, 0.5, 0.3),
            radius: 0.5,
        };
        let c = polygon_hits_sphere(&unit_square(), &s).expect("interior hit");
        assert!((c.x - 0.5).abs() < 1e-4);
        assert!((c.y - 0.5).abs() < 1e-4);
        assert!(c.z.abs() < 1e-4);
    }

    #[test]
    fn misses_when_plane_out_of_reach() {
        // center 2 above the plane, r=0.5 → |dpPos|=2 > rad=0.4998 → None.
        let s = Sphere {
            center: v(0.5, 0.5, 2.0),
            radius: 0.5,
        };
        assert!(polygon_hits_sphere(&unit_square(), &s).is_none());
    }

    #[test]
    fn misses_far_past_an_edge() {
        // center (2,0.5,0) IN-plane (dpPos=0), r=0.3 → diff=0.2998²=0.089880.
        // Right edge V[1]→V[2]=(1,0)→(1,1): e=(0,1,0), N×e=(-1,0,0),
        // disp=contact-(1,0,0)=(1,0.5,0), dp=-1<0. ‖N×e‖²·diff=0.089880 <
        // dp²=1 → beyond the edge's reach → None.
        let s = Sphere {
            center: v(2.0, 0.5, 0.0),
            radius: 0.3,
        };
        assert!(polygon_hits_sphere(&unit_square(), &s).is_none());
    }

    #[test]
    fn grazes_edge_band_returns_contact() {
        // center (1.1,0.5,0) IN-plane, r=0.2 → rad=0.1998, diff=0.039920.
        // Right edge: e=(0,1,0), N×e=(-1,0,0), disp=(0.1,0.5,0), dp=-0.1<0.
        // ‖N×e‖²·diff=0.039920 NOT < dp²=0.01 → keep going. dispEdge =
        // disp·e = 0.5 ∈ [0, ‖e‖²=1] → grazes the segment → Some(contact).
        let s = Sphere {
            center: v(1.1, 0.5, 0.0),
            radius: 0.2,
        };
        let c = polygon_hits_sphere(&unit_square(), &s).expect("edge-band hit");
        assert!((c.x - 1.1).abs() < 1e-4);
        assert!((c.y - 0.5).abs() < 1e-4);
        assert!(c.z.abs() < 1e-4);
    }

    #[test]
    fn degenerate_empty_face_hits_when_slab_passes() {
        // num_pts == 0: decomp does the plane reject FIRST, then returns 1
        // (true) with the projected contact — NOT None. center (0.4,0.7,0.1),
        // r=0.5 → dpPos=0.1 ≤ rad → Some(center - 0.1·N) = (0.4,0.7,0).
        let empty = ResolvedPolygon {
            num_points: 0,
            vertices: vec![],
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
        };
        let s = Sphere {
            center: v(0.4, 0.7, 0.1),
            radius: 0.5,
        };
        let c = polygon_hits_sphere(&empty, &s).expect("empty face still hits");
        assert!((c.x - 0.4).abs() < 1e-4);
        assert!((c.y - 0.7).abs() < 1e-4);
        assert!(c.z.abs() < 1e-4);
        // ...but the plane reject still fires for an empty face out of reach.
        let far = Sphere {
            center: v(0.4, 0.7, 3.0),
            radius: 0.5,
        };
        assert!(polygon_hits_sphere(&empty, &far).is_none());
    }

    // ── pos_hits_sphere (directional gate) ───────────────────────────────

    #[test]
    fn pos_hits_only_when_moving_into_front_face() {
        let poly = unit_square();
        let s = Sphere {
            center: v(0.5, 0.5, 0.3),
            radius: 0.5,
        };
        // Moving DOWN (-Z) into the +Z front face: movement·N = -1 < 0 →
        // precise hit passes the gate → Some((0.5,0.5,0)).
        let c = pos_hits_sphere(&poly, &s, v(0.0, 0.0, -1.0)).expect("front-face hit");
        assert!((c.x - 0.5).abs() < 1e-4);
        assert!((c.y - 0.5).abs() < 1e-4);
        assert!(c.z.abs() < 1e-4);

        // Moving UP (+Z), away from the front face: movement·N = 1 ≥ 0 →
        // gated to None even though the geometry overlaps.
        assert!(pos_hits_sphere(&poly, &s, v(0.0, 0.0, 1.0)).is_none());

        // Exactly tangent (movement in-plane): movement·N = 0 ≥ 0 → None
        // (the gate is `>= 0`, not `> 0`).
        assert!(pos_hits_sphere(&poly, &s, v(1.0, 0.0, 0.0)).is_none());
    }

    #[test]
    fn pos_hits_none_when_geometry_misses_regardless_of_movement() {
        // Plane out of reach → precise returns None → None even when the
        // movement points straight into the face.
        let poly = unit_square();
        let s = Sphere {
            center: v(0.5, 0.5, 2.0),
            radius: 0.5,
        };
        assert!(pos_hits_sphere(&poly, &s, v(0.0, 0.0, -1.0)).is_none());
    }
}
