//! `BSPTREE::check_walkable` (`acclient.c:361052`, idb addr `00539ED0`) — the
//! resolver branch that asks "does this candidate sphere come to rest on a
//! walkable surface?" and reports the answer as a `TransitionState` code
//! (**1** = NOT walkable, **2** = walkable).
//!
//! Phase-2 resolver method **01**. Dispatched from `BSPTREE::find_collisions`
//! (`acclient.c:361296`, step 2) when `path->check_walkable` is set: it forwards
//! the swept sphere into the Phase-1 walkable recursion
//! ([`super::bspnode_walkable::hits_walkable`]) and maps the boolean hit onto
//! the decomp's `(hit != 0) + 1` return code.
//!
//! Decomp body (verbatim shape):
//! ```text
//! v4 = this->root_node;
//! valid_pos = *check_pos;                       // center{x,y,z} + radius copy
//! return (hits_walkable(path, &valid_pos, &path->localspace_z) != 0) + 1;
//! ```
//! The Phase-1 [`hits_walkable`] factored `path->walkable_allowance` and
//! `path->localspace_z` out of the `SPHEREPATH *` into explicit params, so we
//! read them off `path` here and forward the shared `polys` table the leaf
//! recursion resolves `poly_ids` through.

use super::bspnode_walkable::hits_walkable;
use super::types::SpherePath;
use crate::physics::{BspNode, ResolvedPolygon};
use holtburger_common::Sphere;
use std::collections::HashMap;

/// `BSPTREE::check_walkable` (`acclient.c:361052`).
///
/// Copies `check_pos` into a stack `valid_pos`, invokes the root node's
/// `hits_walkable(path, &valid_pos, &path->localspace_z)` (the decomp dispatches
/// it through the root `BSPNODE`'s vtable), and returns `(hit != 0) + 1`:
/// **1** when nothing walkable caught the sphere ([`TransitionState::Ok`]) and
/// **2** when a walkable polygon did ([`TransitionState::Collided`]).
///
/// `scale` is part of the decomp/dispatch signature but `check_walkable`'s body
/// never references it (the walkable recursion works entirely in `path`'s local
/// space); accepted for fidelity and ignored.
///
/// [`TransitionState::Ok`]: super::types::TransitionState::Ok
/// [`TransitionState::Collided`]: super::types::TransitionState::Collided
// acclient.c:361052
// RECONCILE: the find_collisions DISPATCH MAP abbreviates this call as
// `check_walkable(root, path, localspace_sphere, scale)` (4 args), but the
// Phase-1 `hits_walkable` resolves `poly_ids` through an external poly table,
// so the resolver must thread `polys` in as well — agent 05 has it in scope.
// Returns the decomp's raw `int` (1/2); if the driver prefers `TransitionState`,
// map 1 -> Ok, 2 -> Collided.
pub fn check_walkable(
    root: &BspNode,
    path: &SpherePath,
    check_pos: &Sphere,
    scale: f32,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> i32 {
    // `scale` is in the signature (find_collisions passes it down) but the
    // decomp body never touches it.
    let _ = scale;

    // valid_pos.center.{x,y,z} = check_pos->center; valid_pos.radius = ...
    // The decomp copies the sphere onto the stack before the vtable call;
    // `Sphere` is `Copy`, so `*check_pos` mirrors that field-by-field copy.
    let valid_pos = *check_pos;

    // v4 = this->root_node;
    // (hits_walkable(path, &valid_pos, &path->localspace_z) != 0) + 1
    //
    // Phase-1 hits_walkable(node, walkable_allowance, valid_pos, up, polys):
    //   walkable_allowance <= path->walkable_allowance,
    //   up                 <= path->localspace_z.
    let hit = hits_walkable(
        root,
        path.walkable_allowance,
        &valid_pos,
        path.localspace_z,
        polys,
    );
    hit as i32 + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::BspLeaf;
    use crate::transition::types::Z_FOR_LANDING;
    use holtburger_common::{Plane, Vector3};

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    // A 2×2 floor in the z=0 plane, normal +Z (walkable from above) — same
    // fixture geometry the Phase-1 bspnode_walkable tests are derived against.
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

    // A vertical wall in the x=0 plane, normal +X (never walkable from +Z).
    fn wall_poly() -> ResolvedPolygon {
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

    fn leaf_node(poly_ids: Vec<u16>) -> BspNode {
        BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 10.0,
            }),
            poly_ids,
        })
    }

    fn single(poly: ResolvedPolygon) -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, poly);
        m
    }

    // A `SpherePath` carrying the two fields `check_walkable` actually reads:
    // the walkable-allowance threshold and the local-space up axis.
    fn path_with(allowance: f32, up: Vector3) -> SpherePath {
        SpherePath {
            walkable_allowance: allowance,
            localspace_z: up,
            ..Default::default()
        }
    }

    /// Hand-derived: a 0.5-radius sphere centred 0.3 above the floor centre
    /// overlaps the face and `up·N = 1 > Z_FOR_LANDING`, so the leaf reports a
    /// walkable hit. `check_walkable` maps that `true` to `(1) + 1 = 2`
    /// (= `TransitionState::Collided`). `scale` (here 1.5) must not affect it.
    #[test]
    fn check_walkable_floor_returns_two() {
        let path = path_with(Z_FOR_LANDING, v(0.0, 0.0, 1.0));
        let on_floor = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        let r = check_walkable(
            &leaf_node(vec![0]),
            &path,
            &on_floor,
            1.5,
            &single(floor_poly()),
        );
        assert_eq!(r, 2, "walkable floor -> (hit != 0) + 1 == 2");
    }

    /// Hand-derived: the vertical wall has `up·N = 0 ≤ Z_FOR_LANDING`, so the
    /// leaf rejects it before any face test — `hits_walkable` is `false` and
    /// `check_walkable` returns `(0) + 1 = 1` (= `TransitionState::Ok`).
    #[test]
    fn check_walkable_wall_returns_one() {
        let path = path_with(Z_FOR_LANDING, v(0.0, 0.0, 1.0));
        let on_wall = Sphere {
            center: v(0.3, 1.0, 1.0),
            radius: 0.5,
        };
        let r = check_walkable(
            &leaf_node(vec![0]),
            &path,
            &on_wall,
            1.0,
            &single(wall_poly()),
        );
        assert_eq!(r, 1, "non-walkable wall -> (hit != 0) + 1 == 1");
    }

    /// Both early `return 0` paths of the Phase-1 recursion (empty leaf; sphere
    /// outside the node's bounding sphere) bubble up as `check_walkable == 1`.
    #[test]
    fn check_walkable_empty_and_out_of_range_return_one() {
        let path = path_with(Z_FOR_LANDING, v(0.0, 0.0, 1.0));

        // num_polys == 0.
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        assert_eq!(
            check_walkable(&leaf_node(vec![]), &path, &s, 1.0, &single(floor_poly())),
            1,
        );

        // Sphere 100 units from the leaf bounding sphere — pruned before any
        // polygon is touched.
        let far = Sphere {
            center: v(1.0, 1.0, 100.0),
            radius: 0.5,
        };
        assert_eq!(
            check_walkable(&leaf_node(vec![0]), &path, &far, 1.0, &single(floor_poly())),
            1,
        );
    }
}
