//! `BSPNODE`/`BSPLEAF::sphere_intersects_poly` — which physics polygon a
//! moving (cell-local) sphere first crosses, FRONT-FACE only. Ported
//! decomp-faithfully from `acclient.c`.
//!
//! Owns:
//! - [`sphere_intersects_poly`]      — `BSPNODE::sphere_intersects_poly` (acclient.c:363522)
//! - [`leaf_sphere_intersects_poly`] — `BSPLEAF::sphere_intersects_poly` (acclient.c:364200)
//!
//! The decomp methods return an `int` (1 = hit) and write the struck poly +
//! contact point through `CPolygon **polygon` / `Vector3 *contact_pt` out
//! params. Rust collapses those two outputs into the return value:
//! `Some((poly_id, contact_point))` for the first front-face polygon the
//! sweep hits, else `None`.
//!
//! The per-polygon directional predicate is `CPolygon::pos_hits_sphere`
//! (acclient.c:360494) — the precise containment test gated on the front-face
//! condition `dot(movement, N) < 0` — which the sibling
//! [`super::polygon_hits::pos_hits_sphere`] ports faithfully; this module just
//! drives the BSP recursion that picks WHICH polygons to test.
//!
//! Built ALONGSIDE `crate::physics::BspNode`, which carries an equivalent
//! M1-M4 port of this same walk.

use super::polygon_hits::pos_hits_sphere;
use crate::physics::{BspLeaf, BspNode, PHYSICS_EPSILON, ResolvedPolygon};
use holtburger_common::{Plane, Sphere, Vector3};
use std::collections::HashMap;

/// `BSPNODE::sphere_intersects_poly` (`acclient.c:363522`) — the virtual
/// dispatch entry. Routes a `BspNode` to the internal-node recursion or the
/// leaf predicate, mirroring the decomp's `vfptr->sphere_intersects_poly`
/// (the `BSPNODE` body for internal/portal nodes, the `BSPLEAF` override for
/// leaves). Returns `Some((poly_id, contact_point))` for the first front-face
/// polygon the sweep hits.
pub fn sphere_intersects_poly(
    node: &BspNode,
    check_pos: &Sphere,
    movement: Vector3,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> Option<(u16, Vector3)> {
    match node {
        // BSPLEAF override (acclient.c:364200).
        BspNode::Leaf(l) => leaf_sphere_intersects_poly(l, check_pos, movement, polys),
        // BSPNODE body (acclient.c:363522) — internal split node.
        BspNode::Internal(i) => node_sphere_intersects_poly(
            i.sphere.as_ref(),
            &i.plane,
            i.pos.as_deref(),
            i.neg.as_deref(),
            check_pos,
            movement,
            polys,
        ),
        // BSPPORTAL is a BSPNODE subclass with the same pos/neg split, so it
        // runs the identical BSPNODE body (acclient.c:363522).
        BspNode::Port(p) => node_sphere_intersects_poly(
            p.sphere.as_ref(),
            &p.plane,
            Some(p.pos.as_ref()),
            Some(p.neg.as_ref()),
            check_pos,
            movement,
            polys,
        ),
    }
}

/// `BSPNODE::sphere_intersects_poly` body (`acclient.c:363522`), shared by the
/// `Internal` and `Port` (portal) split-node variants.
///
/// Decomp control flow, line-for-line:
/// 1. `CSphere::intersects(&this->sphere, check_pos)` — bounding-sphere reject
///    first; a miss returns 0 immediately (acclient.c:363533).
/// 2. `v7 = N·center + d` — signed distance of the check-sphere center to the
///    splitting plane (acclient.c:363538).
/// 3. `v8 = radius - 0.00019999999` — the reach margin (acclient.c:363543).
/// 4. `v7 >= v8`  → entirely on the positive side → descend `pos_node` only.
/// 5. `v7 <= -v8` → entirely on the negative side → descend `neg_node` only.
/// 6. otherwise the sphere straddles the plane → try `pos_node`, and only if
///    that misses, `neg_node` (acclient.c:363557-363570).
#[allow(clippy::too_many_arguments)]
fn node_sphere_intersects_poly(
    sphere: Option<&Sphere>,
    plane: &Plane,
    pos: Option<&BspNode>,
    neg: Option<&BspNode>,
    check_pos: &Sphere,
    movement: Vector3,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> Option<(u16, Vector3)> {
    // acclient.c:363533 — result = CSphere::intersects(&this->sphere, check_pos).
    // The decomp always has a node bounding sphere; a `None` here means our
    // loader produced no sphere, so we cannot reject and fall through.
    if let Some(s) = sphere
        && !s.intersects(&check_pos.center, check_pos.radius)
    {
        return None;
    }

    // acclient.c:363538 — v7 = N.z*c.z + N.y*c.y + N.x*c.x + d.
    let dist = plane.normal.dot(&check_pos.center) + plane.d;
    // acclient.c:363543 — v8 = check_pos->radius - 0.00019999999.
    let reach = check_pos.radius - PHYSICS_EPSILON;

    // acclient.c:363544 — if ( v7 >= v8 ) return pos_node->...(...).
    if dist >= reach {
        return pos.and_then(|n| sphere_intersects_poly(n, check_pos, movement, polys));
    }
    // acclient.c:363551 — if ( v7 <= -v8 ) return neg_node->...(...).
    if dist <= -reach {
        return neg.and_then(|n| sphere_intersects_poly(n, check_pos, movement, polys));
    }
    // acclient.c:363557 — straddle: positive child first ...
    if let Some(hit) = pos.and_then(|n| sphere_intersects_poly(n, check_pos, movement, polys)) {
        return Some(hit);
    }
    // acclient.c:363564 — ... else the negative child.
    neg.and_then(|n| sphere_intersects_poly(n, check_pos, movement, polys))
}

/// `BSPLEAF::sphere_intersects_poly` (`acclient.c:364200`).
///
/// Decomp control flow:
/// - `v6 = this->num_polys; if ( v6 && CSphere::intersects(&this->sphere, check_pos) )`
///   — require the leaf to hold polygons AND its bounding sphere to intersect
///   the check sphere; otherwise return 0 (acclient.c:364207).
/// - `while ( !CPolygon::pos_hits_sphere(in_polys[v8], check_pos, movement, contact_pt, polygon) )`
///   — walk the leaf's polygons in order; the FIRST whose directional test
///   returns nonzero wins, writing `*polygon`/`*contact_pt` (acclient.c:364214);
///   exhausting the list returns 0 (acclient.c:364216-364218).
pub fn leaf_sphere_intersects_poly(
    leaf: &BspLeaf,
    check_pos: &Sphere,
    movement: Vector3,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> Option<(u16, Vector3)> {
    // acclient.c:364207 — v6 = num_polys; the `v6 &&` guard.
    if leaf.poly_ids.is_empty() {
        return None;
    }
    // acclient.c:364207 — && CSphere::intersects(&this->sphere, check_pos).
    if let Some(s) = &leaf.sphere
        && !s.intersects(&check_pos.center, check_pos.radius)
    {
        return None;
    }

    // acclient.c:364214 — first poly whose pos_hits_sphere() is nonzero wins;
    // pos_hits_sphere already folds in the front-face gate dot(movement,N)<0.
    for &pid in &leaf.poly_ids {
        if let Some(poly) = polys.get(&pid)
            && let Some(contact) = pos_hits_sphere(poly, check_pos, movement)
        {
            return Some((pid, contact));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::InternalNode;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A 2×2 floor in the z = 0 plane, normal +Z, corners (0,0)-(2,2).
    fn floor_poly() -> ResolvedPolygon {
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

    /// Leaf carrying `poly_ids`, with a big bounding sphere that always
    /// intersects the test spheres below.
    fn leaf(poly_ids: Vec<u16>) -> BspLeaf {
        BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 10.0,
            }),
            poly_ids,
        }
    }

    fn polys() -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, floor_poly());
        m
    }

    /// `z = 0` internal split node with a generous bounding sphere; the caller
    /// supplies which child subtrees hang off the positive / negative sides.
    fn z_split(pos: BspNode, neg: BspNode) -> BspNode {
        BspNode::Internal(InternalNode {
            tag: *b"BPnn",
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            pos: Some(Box::new(pos)),
            neg: Some(Box::new(neg)),
            sphere: Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 10.0,
            }),
            poly_ids: vec![],
        })
    }

    // ── Hand-derived case 1: leaf front-face hit + back-face gate ──
    //
    // floor_poly: N=(0,0,1), d=0. Sphere c=(1,1,0.3), r=0.5.
    //   dpPos = N·c + d = 0.3 ; rad = 0.5 - 0.0002 = 0.4998 ; |0.3| ≤ rad → in slab.
    //   contact = c - N·dpPos = (1,1,0.3) - (0,0,0.3) = (1,1,0), inside the square.
    // movement (0,0,-1): dot(mv,N) = -1 < 0 → front face → Some((0,(1,1,0))).
    // movement (0,0,+1): dot(mv,N) = +1 ≥ 0 → gated out → None.
    #[test]
    fn leaf_reports_front_face_hit_and_gates_back_face() {
        let l = leaf(vec![0]);
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };

        let (pid, contact) =
            leaf_sphere_intersects_poly(&l, &s, v(0.0, 0.0, -1.0), &polys()).expect("front hit");
        assert_eq!(pid, 0);
        assert!((contact.x - 1.0).abs() < 1e-4);
        assert!((contact.y - 1.0).abs() < 1e-4);
        assert!(contact.z.abs() < 1e-4);

        assert!(leaf_sphere_intersects_poly(&l, &s, v(0.0, 0.0, 1.0), &polys()).is_none());
    }

    // ── Hand-derived case 2: node straddle descends positive child first ──
    //
    // Split plane z=0. Sphere c=(1,1,0.3), r=0.5 → dist = 0.3, reach = 0.4998.
    //   -0.4998 < 0.3 < 0.4998 → straddle → try pos first.
    // pos = floor leaf (hits, moving down), neg = empty → Some((0, (1,1,0))).
    #[test]
    fn node_straddle_finds_positive_child_hit() {
        let node = z_split(BspNode::Leaf(leaf(vec![0])), BspNode::Leaf(leaf(vec![])));
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        let hit = sphere_intersects_poly(&node, &s, v(0.0, 0.0, -1.0), &polys());
        assert_eq!(hit.map(|(pid, _)| pid), Some(0));
    }

    // ── Hand-derived case 3: "entirely positive" never visits the negative child ──
    //
    // Split plane z=0. Sphere c=(1,1,5.0), r=0.5 → dist = 5.0 ≥ reach 0.4998
    //   → descend pos_node ONLY. We hang the floor poly off the NEGATIVE child
    //   and leave pos empty; a faithful walk must NOT find it → None.
    // (The node bounding sphere c=(1,1,0) r=10 still reaches c=(1,1,5): the
    //  centre distance 5 ≤ 10 + 0.5, so the bounding gate passes.)
    #[test]
    fn node_entirely_positive_skips_negative_child() {
        let node = z_split(BspNode::Leaf(leaf(vec![])), BspNode::Leaf(leaf(vec![0])));
        let s = Sphere {
            center: v(1.0, 1.0, 5.0),
            radius: 0.5,
        };
        assert!(sphere_intersects_poly(&node, &s, v(0.0, 0.0, -1.0), &polys()).is_none());
    }

    // ── Hand-derived case 4: leaf bounding-sphere reject short-circuits ──
    //
    // The leaf holds the floor poly (which the sphere WOULD hit) but its
    // bounding sphere sits at (100,100,100) r=1; centre distance to the check
    // sphere ≫ 1 + 0.5, so CSphere::intersects fails and the leaf returns 0
    // before any per-poly test (acclient.c:364207).
    #[test]
    fn leaf_bounding_sphere_reject() {
        let l = BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(100.0, 100.0, 100.0),
                radius: 1.0,
            }),
            poly_ids: vec![0],
        };
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        assert!(leaf_sphere_intersects_poly(&l, &s, v(0.0, 0.0, -1.0), &polys()).is_none());
    }

    // ── A polyless leaf is rejected by the `num_polys` guard ──
    #[test]
    fn empty_leaf_is_none() {
        let l = leaf(vec![]);
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        assert!(leaf_sphere_intersects_poly(&l, &s, v(0.0, 0.0, -1.0), &polys()).is_none());
    }
}
