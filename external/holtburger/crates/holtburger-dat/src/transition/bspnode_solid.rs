//! `BSPNODE`/`BSPLEAF::sphere_intersects_solid` — does a (cell-local) sphere
//! overlap *solid* space in a physics BSP? Decomp-faithful port of the retail
//! CLIENT physics predicates from `acclient.c`.
//!
//! Owns:
//! - [`sphere_intersects_solid`]      — `BSPNODE::sphere_intersects_solid` (acclient.c:363574)
//! - [`leaf_sphere_intersects_solid`] — `BSPLEAF::sphere_intersects_solid` (acclient.c:364236)
//!
//! These are the transition-layer entry points the Phase-3 driver calls (the
//! placement / ethereal branch of `BSPTREE::find_collisions`). The sibling
//! M1-M4 work in `crate::physics` already carries an equivalent `BspNode`
//! method walk; this module is the from-decomp re-port and cross-checks it —
//! see the `// DIVERGENCE` note on the leaf solid test below.
//!
//! `crate::physics`'s [`crate::physics::ResolvedPolygon`] supplies the
//! per-polygon boundary test (its `hits_sphere`, the ACE-faithful precise
//! solver, mirrors the decomp's `CPolygon::hits_sphere` →
//! `polygon_hits_sphere_slow_but_sure` @360007 that the leaf loop invokes).
//!
//! ## `center_check`
//! Threads the decomp's `centerCheck` bool. It starts `true` (the sphere
//! center lies on the solid-test side of every plane crossed so far) and is
//! cleared to `false` for the subtree on the *far* side of a straddled
//! splitting plane (acclient.c:363594-363601). A `solid` leaf hits
//! immediately while `center_check` still holds; otherwise the leaf falls
//! through to the per-polygon test.

use crate::physics::{BspLeaf, BspNode, PHYSICS_EPSILON, ResolvedPolygon};
use holtburger_common::{Plane, Sphere};
use std::collections::HashMap;

/// `BSPNODE::sphere_intersects_solid` (`acclient.c:363574`).
///
/// Faithful port of the decomp's internal-node recursion:
/// ```text
/// result = CSphere::intersects(&this->sphere, check_pos);   // bounding reject
/// if (result) {
///     v5 = N.z*c.z + N.y*c.y + N.x*c.x + d;                 // splitting plane dist
///     v6 = check_pos->radius - 0.00019999999;               // reach
///     if (v5 >= v6)  return pos_node->...(check_pos, center_check);
///     if (v5 <= -v6) return neg_node->...(check_pos, center_check);
///     if (v5 < 0.0) { if pos(check_pos, 0) return 1; result = neg(check_pos, center_check); }
///     else          { if pos(check_pos, center_check) return 1; result = neg(check_pos, 0); }
/// }
/// return result;
/// ```
///
/// The leaf override (`BspNode::Leaf`) dispatches to
/// [`leaf_sphere_intersects_solid`]. Internal and PORT nodes share the
/// [`node_walk`] plane fan-out. Physics trees do not normally contain PORT
/// nodes, but if one appears it carries the same `plane` / `pos` / `neg`
/// shape, so it recurses identically.
pub fn sphere_intersects_solid(
    node: &BspNode,
    check_pos: &Sphere,
    center_check: bool,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> bool {
    match node {
        BspNode::Leaf(l) => leaf_sphere_intersects_solid(l, check_pos, center_check, polys),
        BspNode::Internal(i) => {
            // CSphere::intersects(&this->sphere, check_pos) (acclient.c:363583).
            // The decomp's node sphere is mandatory; our type makes it
            // `Option`, so `None` means "no stored bound" → skip the reject.
            if let Some(s) = &i.sphere
                && !s.intersects(&check_pos.center, check_pos.radius)
            {
                return false;
            }
            node_walk(
                &i.plane,
                i.pos.as_deref(),
                i.neg.as_deref(),
                check_pos,
                center_check,
                polys,
            )
        }
        BspNode::Port(p) => {
            if let Some(s) = &p.sphere
                && !s.intersects(&check_pos.center, check_pos.radius)
            {
                return false;
            }
            node_walk(
                &p.plane,
                Some(p.pos.as_ref()),
                Some(p.neg.as_ref()),
                check_pos,
                center_check,
                polys,
            )
        }
    }
}

/// The internal-node splitting-plane fan-out (`acclient.c:363585-363613`),
/// shared by `Internal` (optional children) and `Port` (mandatory children).
///
/// A `None` child stands in for the decomp's null `pos_node`/`neg_node`,
/// which never occurs in a well-formed physics tree (both are always present);
/// it is treated as "no hit".
fn node_walk(
    plane: &Plane,
    pos: Option<&BspNode>,
    neg: Option<&BspNode>,
    check_pos: &Sphere,
    center_check: bool,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> bool {
    // v5 = N.z*c.z + N.y*c.y + N.x*c.x + d  (signed distance, center to plane).
    let dist = plane.normal.dot(&check_pos.center) + plane.d;
    // v6 = check_pos->radius - 0.00019999999.
    let reach = check_pos.radius - PHYSICS_EPSILON;

    // v5 >= v6: sphere fully on the positive side.
    if dist >= reach {
        return pos.is_some_and(|n| sphere_intersects_solid(n, check_pos, center_check, polys));
    }
    // v5 <= -v6: sphere fully on the negative side.
    if dist <= -reach {
        return neg.is_some_and(|n| sphere_intersects_solid(n, check_pos, center_check, polys));
    }
    // Straddle: descend both, clearing center_check on the side the sphere
    // center is NOT on (the far side).
    if dist < 0.0 {
        // Center is on the negative side → pos subtree gets center_check = 0.
        if pos.is_some_and(|n| sphere_intersects_solid(n, check_pos, false, polys)) {
            return true;
        }
        neg.is_some_and(|n| sphere_intersects_solid(n, check_pos, center_check, polys))
    } else {
        // Center is on the positive side → neg subtree gets center_check = 0.
        if pos.is_some_and(|n| sphere_intersects_solid(n, check_pos, center_check, polys)) {
            return true;
        }
        neg.is_some_and(|n| sphere_intersects_solid(n, check_pos, false, polys))
    }
}

/// `BSPLEAF::sphere_intersects_solid` (`acclient.c:364236`).
///
/// Faithful port of the decomp's leaf override:
/// ```text
/// v4 = num_polys;
/// if (v4) {
///     if (center_check && solid)                       result = 1;
///     else if (CSphere::intersects(&sphere, check_pos) && num_polys) {
///         while (!CPolygon::hits_sphere(in_polys[i], check_pos))
///             if (++i >= num_polys) { result = 0; break; }   // (LABEL_10)
///         result = 1;                                          // a poly hit
///     } else result = 0;
/// } else result = 0;
/// ```
///
/// Order is exact: the `num_polys == 0` guard precedes everything, so a
/// `solid` leaf with no polygons still returns `false`; the
/// `center_check && solid` short-circuit precedes the bounding-sphere reject.
///
/// // DIVERGENCE: the decomp tests `center_check && this->solid` — a *truthy*
/// // test (`solid != 0`). The sibling `crate::physics::BspNode::
/// // sphere_intersects_solid` (physics.rs:287) uses `l.solid == 1`. Both
/// // agree for retail data (`solid` is only ever 0 or 1), but the decomp is
/// // authoritative, so this port uses `leaf.solid != 0`.
pub fn leaf_sphere_intersects_solid(
    leaf: &BspLeaf,
    check_pos: &Sphere,
    center_check: bool,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> bool {
    // if (!num_polys) return 0;  — precedes the solid/center short-circuit.
    if leaf.poly_ids.is_empty() {
        return false;
    }
    // if (center_check && this->solid) return 1;  (truthy `solid`, see above).
    if center_check && leaf.solid != 0 {
        return true;
    }
    // CSphere::intersects(&this->sphere, check_pos) (leaf bounding reject).
    // `None` ⇒ no stored bound ⇒ skip the reject (decomp leaf sphere is
    // mandatory).
    if let Some(s) = &leaf.sphere
        && !s.intersects(&check_pos.center, check_pos.radius)
    {
        return false;
    }
    // while (!CPolygon::hits_sphere(in_polys[i], check_pos)) … first hit wins.
    // ResolvedPolygon::hits_sphere is the ACE-faithful precise solver
    // matching the decomp's CPolygon::hits_sphere → polygon_hits_sphere_*.
    for &pid in &leaf.poly_ids {
        if let Some(poly) = polys.get(&pid)
            && poly.hits_sphere(check_pos)
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::InternalNode;
    use holtburger_common::Vector3;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A unit-quad floor in z = 0 spanning x,y ∈ [0,2], normal +Z.
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

    fn polys() -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, floor_poly());
        m
    }

    fn leaf(solid: i32, poly_ids: Vec<u16>, sphere: Option<Sphere>) -> BspLeaf {
        BspLeaf {
            index: 0,
            solid,
            sphere,
            poly_ids,
        }
    }

    /// A wide bounding sphere that never rejects in these tests.
    fn wide() -> Option<Sphere> {
        Some(Sphere {
            center: v(1.0, 1.0, 0.0),
            radius: 100.0,
        })
    }

    // ── Leaf-level cases ──────────────────────────────────────────────────

    #[test]
    fn leaf_solid_center_check_and_num_polys_guard() {
        // center_check=true && solid=1 with ≥1 poly → immediate hit, no poly
        // test (sphere is high above the floor).
        let l = leaf(1, vec![0], wide());
        let s = Sphere {
            center: v(1.0, 1.0, 5.0),
            radius: 0.5,
        };
        assert!(leaf_sphere_intersects_solid(&l, &s, true, &polys()));

        // center_check=false → the solid short-circuit is skipped; the sphere
        // is 5 units above the z=0 floor (|dp| = 5 > reach 0.4998) → no hit.
        assert!(!leaf_sphere_intersects_solid(&l, &s, false, &polys()));

        // DIVERGENCE coverage: solid=2 is still truthy, so center_check hits
        // (decomp `!= 0`); a `== 1` port would WRONGLY miss here.
        let l2 = leaf(2, vec![0], wide());
        assert!(leaf_sphere_intersects_solid(&l2, &s, true, &polys()));

        // num_polys==0 guard precedes the solid short-circuit: an empty solid
        // leaf returns false even with center_check.
        let empty = leaf(1, vec![], wide());
        assert!(!leaf_sphere_intersects_solid(&empty, &s, true, &polys()));
    }

    #[test]
    fn leaf_polygon_hit_and_bounding_reject() {
        // Non-solid leaf, sphere straddling the z=0 floor within the quad.
        // dp = center.z = 0.30; reach = 0.5 - 0.0002 = 0.4998; |dp| < reach,
        // contact = center - N*dp = (1,1,0) is inside [0,2]² → poly hit.
        let l = leaf(0, vec![0], wide());
        let hit = Sphere {
            center: v(1.0, 1.0, 0.30),
            radius: 0.5,
        };
        // hand-checked plane math (within 1e-4):
        let dp: f32 = 0.0 * 1.0 + 0.0 * 1.0 + 1.0 * 0.30 + 0.0;
        let reach = 0.5 - PHYSICS_EPSILON;
        assert!((dp - 0.30).abs() < 1e-4);
        assert!((reach - 0.4998).abs() < 1e-4);
        assert!(dp.abs() < reach);
        assert!(leaf_sphere_intersects_solid(&l, &hit, false, &polys()));

        // Leaf bounding-sphere reject: a tight bound around (1,1,0) r=1 vs a
        // check sphere at (1,1,10) r=0.5 → centre-distance 10, r_sum=1.5,
        // 100 > 2.25 → no intersect → leaf returns false before any poly test.
        let tight = leaf(
            0,
            vec![0],
            Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 1.0,
            }),
        );
        let far = Sphere {
            center: v(1.0, 1.0, 10.0),
            radius: 0.5,
        };
        let dist_sq = 10.0_f32 * 10.0;
        let r_sum = 1.0_f32 + 0.5;
        assert!(dist_sq > r_sum * r_sum); // 100 > 2.25
        assert!(!leaf_sphere_intersects_solid(&tight, &far, false, &polys()));
    }

    // ── Node-level cases ──────────────────────────────────────────────────

    fn internal(plane: Plane, pos: BspNode, neg: BspNode, sphere: Option<Sphere>) -> BspNode {
        BspNode::Internal(InternalNode {
            tag: *b"BPnn",
            plane,
            pos: Some(Box::new(pos)),
            neg: Some(Box::new(neg)),
            sphere,
            poly_ids: vec![],
        })
    }

    #[test]
    fn node_one_sided_descent_and_bounding_reject() {
        // Split on z=0 (+Z). pos = solid leaf, neg = empty leaf.
        let node = internal(
            Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            BspNode::Leaf(leaf(1, vec![0], wide())),
            BspNode::Leaf(leaf(0, vec![], wide())),
            wide(),
        );
        // Sphere well on +Z: dp = 5.0 ≥ reach 0.4998 → pos-only descent →
        // solid leaf + center_check → hit.
        let above = Sphere {
            center: v(1.0, 1.0, 5.0),
            radius: 0.5,
        };
        assert!((5.0_f32 - (0.5 - PHYSICS_EPSILON)) > 0.0); // dp ≥ reach
        assert!(sphere_intersects_solid(&node, &above, true, &polys()));

        // Node bounding-sphere reject: tight node bound (1,1,0) r=1 vs a check
        // sphere 100 units away → reject before the plane fan-out → false.
        let tight_node = internal(
            Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            BspNode::Leaf(leaf(1, vec![0], wide())),
            BspNode::Leaf(leaf(0, vec![], wide())),
            Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 1.0,
            }),
        );
        let far = Sphere {
            center: v(100.0, 100.0, 100.0),
            radius: 0.5,
        };
        assert!(!sphere_intersects_solid(&tight_node, &far, true, &polys()));
    }

    #[test]
    fn node_straddle_fan_out() {
        // Split on z=0. pos = solid leaf (poly 0), neg = empty leaf.
        let pos_solid = internal(
            Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            BspNode::Leaf(leaf(1, vec![0], wide())),
            BspNode::Leaf(leaf(0, vec![], wide())),
            wide(),
        );

        // Straddle, center on +Z side (dp = 0.10 > 0, |dp| < reach 0.4998).
        // → else-branch: pos descends with center_check INTACT → solid leaf
        //   + center_check → immediate hit.
        let center_pos = Sphere {
            center: v(1.0, 1.0, 0.10),
            radius: 0.5,
        };
        let reach = 0.5 - PHYSICS_EPSILON;
        assert!(0.10 < reach && 0.10 > -reach); // straddle
        assert!(sphere_intersects_solid(&pos_solid, &center_pos, true, &polys()));

        // Straddle, center on −Z side (dp = -0.10 < 0). → if-branch: pos
        // descends with center_check CLEARED → solid short-circuit skipped →
        // falls to the floor poly test. contact = (1,1,0) ∈ quad → hit.
        let center_neg = Sphere {
            center: v(1.0, 1.0, -0.10),
            radius: 0.5,
        };
        assert!(-0.10 > -reach && -0.10 < reach); // straddle
        assert!(sphere_intersects_solid(&pos_solid, &center_neg, true, &polys()));

        // Straddle with both children empty → neither side hits → false.
        let both_empty = internal(
            Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            BspNode::Leaf(leaf(0, vec![], wide())),
            BspNode::Leaf(leaf(0, vec![], wide())),
            wide(),
        );
        assert!(!sphere_intersects_solid(&both_empty, &center_pos, true, &polys()));
    }
}
