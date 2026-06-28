//! `BSPNODE`/`BSPLEAF` walkable predicates — does a sphere rest on a
//! walkable surface inside a physics BSP, and where does the lowest
//! walkable polygon push it to? Ported decomp-faithfully from `acclient.c`.
//!
//! Owns (the leaf method + its base-class node recursion, fused into one
//! `match` per the Rust enum since C++ dispatches them by vtable):
//! - [`hits_walkable`]  — `BSPLEAF::hits_walkable`  (`acclient.c:364275`)
//!                        over `BSPNODE::hits_walkable`  (`acclient.c:363615`)
//! - [`find_walkable`]  — `BSPLEAF::find_walkable`  (`acclient.c:364311`)
//!                        over `BSPNODE::find_walkable`  (`acclient.c:363663`)
//!
//! Unlike the solid / poly predicates these have no equivalent in
//! `crate::physics`, so the recursion is ported here. They delegate to the
//! per-polygon leaves [`super::polygon_walkable::walkable_hits_sphere`] /
//! [`super::polygon_walkable::check_small_walkable`] and to
//! [`super::polygon_adjust::adjust_sphere_to_plane`].
//!
//! Decomp shape mirrored faithfully:
//! - Every node (internal, portal, leaf) first gates on its own bounding
//!   sphere — `CSphere::intersects(&this->sphere, valid_pos)`. A physics BSP
//!   always carries one; our `Option<Sphere>` treats a missing sphere as
//!   "don't prune" (the per-poly tests below stay correct either way).
//! - The internal/portal split uses the decomp's signed-distance gate
//!   `dist = N·center + d`, `reach = radius - 0.00019999999`
//!   (= [`PHYSICS_EPSILON`]): `dist >= reach` ⇒ positive child only,
//!   `dist <= -reach` ⇒ negative child only, otherwise both. A `BSPPORTAL`
//!   has no walkable override, so it inherits `BSPNODE`'s body verbatim.
//! - `BSPLEAF::hits_walkable` accepts a polygon only when BOTH
//!   `walkable_hits_sphere` AND `check_small_walkable` pass (the decomp's
//!   `while ( !walkable_hits_sphere || !check_small_walkable )`).
//! - `BSPLEAF::find_walkable` is stateful: the decomp mutates `valid_pos`'s
//!   center, `path->WalkInterp`, the `*polygon` out-param and `*changed` as
//!   it visits leaves. That state is collected in [`FindWalkable`] and
//!   threaded by `&mut` through the recursion (matching the ACE `ref` args).

use super::polygon_adjust::adjust_sphere_to_plane;
use super::polygon_walkable::{check_small_walkable, walkable_hits_sphere};
use super::types::SpherePath;
use crate::physics::{BspNode, PHYSICS_EPSILON, ResolvedPolygon};
use holtburger_common::{Plane, Sphere, Vector3};
use std::collections::HashMap;

// ─── hits_walkable ───────────────────────────────────────────────────────

/// `BSPLEAF::hits_walkable` (`acclient.c:364275`) over the
/// `BSPNODE::hits_walkable` recursion (`acclient.c:363615`). Returns `true`
/// when any leaf polygon the sphere overlaps is walkable
/// (`up·N > walkable_allowance`) AND the sphere lands inside its
/// small-walkable (¼-radius) band.
///
/// `walkable_allowance` is `SPHEREPATH::walkable_allowance` (defaults to
/// [`super::types::Z_FOR_LANDING`]); forwarded to the per-poly leaf so the
/// recursion stays cell-/driver-agnostic.
pub fn hits_walkable(
    node: &BspNode,
    walkable_allowance: f32,
    valid_pos: &Sphere,
    up: Vector3,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> bool {
    match node {
        // BSPLEAF::hits_walkable (acclient.c:364275)
        BspNode::Leaf(l) => {
            // `v5 = this->num_polys; if ( v5 ) ...` else result = 0.
            if l.poly_ids.is_empty() {
                return false;
            }
            // `CSphere::intersects(&this->sphere, valid_pos)` gate.
            if !sphere_gate(&l.sphere, valid_pos) {
                return false;
            }
            // `while ( !walkable_hits_sphere(...) || !check_small_walkable(...) )`
            // — accept the first polygon for which BOTH hold.
            l.poly_ids.iter().any(|&pid| {
                polys.get(&pid).is_some_and(|poly| {
                    walkable_hits_sphere(poly, walkable_allowance, valid_pos, up)
                        && check_small_walkable(poly, valid_pos, up)
                })
            })
        }
        // BSPNODE::hits_walkable (acclient.c:363615) — internal node.
        BspNode::Internal(i) => {
            if !sphere_gate(&i.sphere, valid_pos) {
                return false;
            }
            hits_walkable_children(
                &i.plane,
                i.pos.as_deref(),
                i.neg.as_deref(),
                walkable_allowance,
                valid_pos,
                up,
                polys,
            )
        }
        // BSPPORTAL inherits BSPNODE::hits_walkable (no override).
        BspNode::Port(p) => {
            if !sphere_gate(&p.sphere, valid_pos) {
                return false;
            }
            hits_walkable_children(
                &p.plane,
                Some(p.pos.as_ref()),
                Some(p.neg.as_ref()),
                walkable_allowance,
                valid_pos,
                up,
                polys,
            )
        }
    }
}

/// The `BSPNODE::hits_walkable` split (`acclient.c:363630-363659`): descend
/// only the positive child when fully on the positive side, only the
/// negative child when fully on the negative side, otherwise both with a
/// short-circuit OR (`pos` evaluated first, exactly as the decomp).
#[allow(clippy::too_many_arguments)]
fn hits_walkable_children(
    plane: &Plane,
    pos: Option<&BspNode>,
    neg: Option<&BspNode>,
    walkable_allowance: f32,
    valid_pos: &Sphere,
    up: Vector3,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> bool {
    // v6 = N.z*c.z + N.y*c.y + c.x*N.x + d ; v7 = radius - 0.00019999999
    let dist = plane.normal.dot(&valid_pos.center) + plane.d;
    let reach = valid_pos.radius - PHYSICS_EPSILON;

    if dist >= reach {
        return pos.is_some_and(|n| hits_walkable(n, walkable_allowance, valid_pos, up, polys));
    }
    if dist <= -reach {
        return neg.is_some_and(|n| hits_walkable(n, walkable_allowance, valid_pos, up, polys));
    }
    pos.is_some_and(|n| hits_walkable(n, walkable_allowance, valid_pos, up, polys))
        || neg.is_some_and(|n| hits_walkable(n, walkable_allowance, valid_pos, up, polys))
}

// ─── find_walkable ───────────────────────────────────────────────────────

/// Accumulated state for [`find_walkable`] — the decomp's mutated `valid_pos`
/// (a `CSphere*`, only its center moves), `path->WalkInterp`, the `*polygon`
/// out-param and the `*changed` flag.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FindWalkable {
    /// `valid_pos->center` — slid down `up` by each accepted
    /// `adjust_sphere_to_plane`.
    pub center: Vector3,
    /// `valid_pos->radius` — constant through the walk.
    pub radius: f32,
    /// `path->WalkInterp` — read/written alongside `center`.
    pub walk_interp: f32,
    /// `*changed` — set once any walkable polygon adjusts the sphere.
    pub changed: bool,
    /// `*polygon` — id of the last polygon that adjusted the sphere.
    pub hit_poly: Option<u16>,
}

impl FindWalkable {
    /// Begin a walk from a sphere + a `WalkInterp` budget, nothing adjusted.
    pub fn new(center: Vector3, radius: f32, walk_interp: f32) -> Self {
        Self {
            center,
            radius,
            walk_interp,
            changed: false,
            hit_poly: None,
        }
    }

    /// The live `valid_pos` sphere (center moves, radius is constant).
    #[inline]
    fn sphere(&self) -> Sphere {
        Sphere {
            center: self.center,
            radius: self.radius,
        }
    }
}

/// `BSPLEAF::find_walkable` (`acclient.c:364311`) over the
/// `BSPNODE::find_walkable` recursion (`acclient.c:363663`). For every
/// walkable leaf polygon the (current) sphere overlaps, slides the sphere
/// down onto its plane via [`adjust_sphere_to_plane`], threading the result
/// (moved center, new `WalkInterp`, `changed`, last `hitPoly`) through
/// `state`. Note the leaf here checks ONLY `walkable_hits_sphere` — not
/// `check_small_walkable` — before adjusting.
pub fn find_walkable(
    node: &BspNode,
    state: &mut FindWalkable,
    movement: Vector3,
    up: Vector3,
    walkable_allowance: f32,
    polys: &HashMap<u16, ResolvedPolygon>,
) {
    match node {
        // BSPLEAF::find_walkable (acclient.c:364311)
        BspNode::Leaf(l) => {
            // `v8 = this->num_polys; if ( v8 ) ...`
            if l.poly_ids.is_empty() {
                return;
            }
            // `CSphere::intersects(&this->sphere, valid_pos)` gate.
            if !sphere_gate(&l.sphere, &state.sphere()) {
                return;
            }
            // `do { ... ++v9 } while ( v9 < num_polys )`
            for &pid in &l.poly_ids {
                let Some(poly) = polys.get(&pid) else {
                    continue;
                };
                // walkable_hits_sphere sees the CURRENT (possibly already
                // adjusted) center — rebuild valid_pos each iteration.
                if !walkable_hits_sphere(poly, walkable_allowance, &state.sphere(), up) {
                    continue;
                }
                // `if ( adjust_sphere_to_plane(...) ) { *changed = 1; *polygon = poly; }`
                // adjust_sphere_to_plane mutates valid_pos.Center & path.WalkInterp
                // in place (see polygon_adjust module doc); thread its result back
                // through `state`. Only `walk_interp` of the SpherePath is read/
                // written by the solver, so a default path carrying the running
                // budget is sufficient here.
                let mut valid_pos = state.sphere();
                let mut path = SpherePath {
                    walk_interp: state.walk_interp,
                    ..Default::default()
                };
                if adjust_sphere_to_plane(poly, &mut path, &mut valid_pos, &movement) {
                    state.center = valid_pos.center;
                    state.walk_interp = path.walk_interp;
                    state.changed = true;
                    state.hit_poly = Some(pid);
                }
            }
        }
        // BSPNODE::find_walkable (acclient.c:363663) — internal node.
        BspNode::Internal(i) => {
            if !sphere_gate(&i.sphere, &state.sphere()) {
                return;
            }
            find_walkable_children(
                &i.plane,
                i.pos.as_deref(),
                i.neg.as_deref(),
                state,
                movement,
                up,
                walkable_allowance,
                polys,
            );
        }
        // BSPPORTAL inherits BSPNODE::find_walkable (no override).
        BspNode::Port(p) => {
            if !sphere_gate(&p.sphere, &state.sphere()) {
                return;
            }
            find_walkable_children(
                &p.plane,
                Some(p.pos.as_ref()),
                Some(p.neg.as_ref()),
                state,
                movement,
                up,
                walkable_allowance,
                polys,
            );
        }
    }
}

/// The `BSPNODE::find_walkable` split (`acclient.c:363676-363710`). `v8`/`v9`
/// are computed once at entry — from the center BEFORE any child mutates it —
/// then the positive child runs first and may slide the sphere, after which
/// the negative child is visited with the moved center (re-gating on its own
/// bounding sphere). Fully-positive ⇒ positive child only; fully-negative ⇒
/// negative child only; straddling ⇒ both.
#[allow(clippy::too_many_arguments)]
fn find_walkable_children(
    plane: &Plane,
    pos: Option<&BspNode>,
    neg: Option<&BspNode>,
    state: &mut FindWalkable,
    movement: Vector3,
    up: Vector3,
    walkable_allowance: f32,
    polys: &HashMap<u16, ResolvedPolygon>,
) {
    // v8 = N·center + d (center at node entry) ; v9 = radius - 0.00019999999
    let dist = plane.normal.dot(&state.center) + plane.d;
    let reach = state.radius - PHYSICS_EPSILON;

    if dist >= reach {
        if let Some(n) = pos {
            find_walkable(n, state, movement, up, walkable_allowance, polys);
        }
        return;
    }
    if dist <= -reach {
        if let Some(n) = neg {
            find_walkable(n, state, movement, up, walkable_allowance, polys);
        }
        return;
    }
    if let Some(n) = pos {
        find_walkable(n, state, movement, up, walkable_allowance, polys);
    }
    if let Some(n) = neg {
        find_walkable(n, state, movement, up, walkable_allowance, polys);
    }
}

// ─── shared bounding-sphere gate ─────────────────────────────────────────

/// `CSphere::intersects(&this->sphere, valid_pos)` (`acclient.c:356341`) as
/// used by every walkable node. A physics BSP node always has a bounding
/// sphere; a `None` here means "no bound recorded" — we DON'T prune (the
/// per-polygon predicates stay correct), matching the decomp's behaviour of
/// always descending into a real node.
#[inline]
fn sphere_gate(node_sphere: &Option<Sphere>, valid_pos: &Sphere) -> bool {
    match node_sphere {
        Some(s) => s.intersects(&valid_pos.center, valid_pos.radius),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::types::Z_FOR_LANDING;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    // A 2×2 floor in the z=0 plane, normal +Z (walkable from above).
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
        BspNode::Leaf(crate::physics::BspLeaf {
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

    // ── hits_walkable ────────────────────────────────────────────────────

    /// Hand-derived: a 0.5-radius sphere centred 0.3 above the floor centre
    /// overlaps the face and `up·N = 1 > allowance`, so the leaf reports a
    /// walkable hit. The same-radius sphere grazing the vertical wall has
    /// `up·N = 0 ≤ allowance` and is rejected before any face test.
    #[test]
    fn hits_walkable_floor_true_wall_false() {
        let on_floor = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        assert!(hits_walkable(
            &leaf_node(vec![0]),
            Z_FOR_LANDING,
            &on_floor,
            v(0.0, 0.0, 1.0),
            &single(floor_poly()),
        ));

        let on_wall = Sphere {
            center: v(0.3, 1.0, 1.0),
            radius: 0.5,
        };
        assert!(!hits_walkable(
            &leaf_node(vec![0]),
            Z_FOR_LANDING,
            &on_wall,
            v(0.0, 0.0, 1.0),
            &single(wall_poly()),
        ));
    }

    /// An empty leaf (and a leaf whose bounding sphere the test sphere is far
    /// from) never reports a walkable hit — both early `return 0` paths.
    #[test]
    fn hits_walkable_empty_and_out_of_range_false() {
        let s = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };
        // num_polys == 0.
        assert!(!hits_walkable(
            &leaf_node(vec![]),
            Z_FOR_LANDING,
            &s,
            v(0.0, 0.0, 1.0),
            &single(floor_poly()),
        ));
        // Bounding sphere (centre (1,1,0) r=10) vs a sphere 100 away: the
        // CSphere::intersects gate rejects before any polygon is touched.
        let far = Sphere {
            center: v(1.0, 1.0, 100.0),
            radius: 0.5,
        };
        assert!(!hits_walkable(
            &leaf_node(vec![0]),
            Z_FOR_LANDING,
            &far,
            v(0.0, 0.0, 1.0),
            &single(floor_poly()),
        ));
    }

    // ── find_walkable ────────────────────────────────────────────────────

    /// Hand-derived slide. Sphere centre (1,1,0.3), radius 0.5, descending
    /// `movement=(0,0,-1)` against the z=0 floor:
    ///   dpPos = 0.3, dpMove = -1 ⇒ dist = dpPos - r = -0.2,
    ///   iDist = -0.2 / -1 = 0.2, interp = (1 - 0.2)·1 = 0.8,
    ///   center -= movement·iDist ⇒ z = 0.3 - (-1)(0.2) = 0.5.
    /// So the sphere rests one radius above the plane at z = 0.5,
    /// WalkInterp = 0.8, changed, hitPoly = 0.
    #[test]
    fn find_walkable_slides_sphere_onto_floor() {
        let mut st = FindWalkable::new(v(1.0, 1.0, 0.3), 0.5, 1.0);
        find_walkable(
            &leaf_node(vec![0]),
            &mut st,
            v(0.0, 0.0, -1.0),
            v(0.0, 0.0, 1.0),
            Z_FOR_LANDING,
            &single(floor_poly()),
        );
        assert!(st.changed, "should have adjusted");
        assert_eq!(st.hit_poly, Some(0));
        assert!((st.center.x - 1.0).abs() < 1e-4, "x={}", st.center.x);
        assert!((st.center.y - 1.0).abs() < 1e-4, "y={}", st.center.y);
        assert!((st.center.z - 0.5).abs() < 1e-4, "z={}", st.center.z);
        assert!((st.walk_interp - 0.8).abs() < 1e-4, "wi={}", st.walk_interp);
    }

    /// The vertical wall is not walkable (`up·N = 0`), so `walkable_hits_sphere`
    /// short-circuits and the sphere is never adjusted: changed stays false,
    /// the center and WalkInterp are untouched.
    #[test]
    fn find_walkable_no_change_on_wall() {
        let mut st = FindWalkable::new(v(0.3, 1.0, 1.0), 0.5, 1.0);
        find_walkable(
            &leaf_node(vec![0]),
            &mut st,
            v(-1.0, 0.0, 0.0),
            v(0.0, 0.0, 1.0),
            Z_FOR_LANDING,
            &single(wall_poly()),
        );
        assert!(!st.changed);
        assert_eq!(st.hit_poly, None);
        assert_eq!(st.center, v(0.3, 1.0, 1.0));
        assert!((st.walk_interp - 1.0).abs() < 1e-4);
    }
}
