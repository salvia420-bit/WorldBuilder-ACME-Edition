//! `BSPTREE::find_collisions` — the swept-step RESOLVER dispatcher that drives
//! the Phase-1 leaf predicates to classify one swept-sphere move and route it
//! to the correct response (step up / slide / collide / adjust / walk). Ported
//! decomp-faithfully from `acclient.c:361296`.
//!
//! Owns:
//! - [`find_collisions`] — `BSPTREE::find_collisions` (`acclient.c:361296`)
//!
//! This is the integration hub of the Phase-2 fan-out: it reads the full
//! `SPHEREPATH` / `OBJECTINFO` state out of the [`CTransition`], computes
//! `movement = localspace_sphere.center − localspace_curr_center`, and walks
//! the decomp's branch ladder verbatim, calling
//! - the Phase-1 leaf predicates ([`sphere_intersects_solid`],
//!   [`sphere_intersects_poly`], [`find_walkable`]) and frame transforms
//!   ([`super::frame_transform::Frame::localtoglobalvec`] /
//!   [`super::frame_transform::Frame::plane_localtoglobal`]);
//! - the Phase-1 `COLLISIONINFO` setters ([`CollisionInfo::set_contact_plane`],
//!   [`CollisionInfo::set_collision_normal`]);
//! - the sibling Phase-2 resolver helpers `check_walkable` (01),
//!   `step_sphere_down` (02), `slide_sphere` / `step_sphere_up` (03),
//!   `collide_with_pt` (04), and the `SPHEREPATH` mutators `set_collide` /
//!   `set_walkable` / `add_offset_to_check_pos` / `set_neg_poly_hit` (06).
//!
//! ## Return value
//! Matches the decomp's raw `int`: `1` = OK, `2` = COLLIDED, `3` = ADJUSTED,
//! `4` = SLID (the values of [`TransitionState`]). The dispatcher forwards the
//! sibling helpers' raw `int` results unchanged, so this layer stays `i32`; the
//! Phase-3 driver maps the code to [`TransitionState`].
//!
//! ## Normal-space convention (decomp-exact)
//! - `step_sphere_up` / `slide_sphere` receive the **local-space** polygon
//!   normal — they re-base it through the path frame themselves (agent 03).
//! - `set_collide` / `set_collision_normal` / `set_neg_poly_hit` receive the
//!   **global** normal, transformed HERE via `localspace_pos.localtoglobalvec`
//!   exactly as the decomp does at the call site.
//!
//! ## RECONCILE — back-face "grazed poly" out-param
//! The decomp's `BSPLEAF::sphere_intersects_poly` writes its `*polygon`
//! (`hit_poly`) out-param to the struck polygon whenever the precise
//! containment test passes — EVEN when the front-face gate (`movement·N < 0`)
//! then makes it return 0 (`CPolygon::pos_hits_sphere` @360494 sets
//! `*struck_poly = this` BEFORE the gate). `find_collisions` leans on that:
//! after a 0-return it re-checks `|| hit_poly` and `scale != 0.0` to handle a
//! back-face *graze* (`set_neg_poly_hit`, the `|| hit_poly` collide paths).
//! Phase-1's [`sphere_intersects_poly`] returns `Some` only for a genuine
//! front-face hit and drops that early `*struck_poly` write (see its doc), so
//! the grazed-only sub-branches below are written to the decomp's shape but
//! cannot fire until `sphere_intersects_poly` is extended to also surface the
//! grazed polygon. Each such site is tagged `// RECONCILE:`.

use super::bspnode_poly::sphere_intersects_poly;
use super::bspnode_solid::sphere_intersects_solid;
use super::bspnode_walkable::{FindWalkable, find_walkable};
use super::trace::trace;
use super::types::*;
use crate::physics::{BspNode, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};
use std::collections::HashMap;

/// `hit_poly->plane.N` — the LOCAL-space normal of a struck polygon, looked up
/// by id in the cell's polygon table. The decomp dereferences a live
/// `CPolygon*`; our `HashMap` lookup defends against a stale id with a zero
/// normal (never hit in well-formed data — the id came from the leaf walk).
#[inline]
fn poly_normal(pid: u16, polys: &HashMap<u16, ResolvedPolygon>) -> Vector3 {
    polys
        .get(&pid)
        .map(|p| p.plane.normal)
        .unwrap_or_else(Vector3::zero)
}

/// `BSPTREE::find_collisions` (`acclient.c:361296`,
/// `int __thiscall (BSPTREE *this, CTransition *transition, float scale)`).
///
/// `root` is `this->root_node` (the Phase-1 `&BspNode` for `BSPTREE *this`);
/// `transition` carries the `SPHEREPATH` / `OBJECTINFO` / `COLLISIONINFO`
/// state; `scale` is the object scale; `polys` is the cell-local polygon table
/// the leaf predicates resolve `poly_id`s against. Returns the decomp's `int`
/// transition code (see module docs / [`TransitionState`]).
// acclient.c:361296
pub fn find_collisions(
    root: &BspNode,
    transition: &mut CTransition,
    scale: f32,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> i32 {
    // acclient.c:361324-361341 — copy the by-value path inputs the decomp reads
    // through `v3`/`v4`/`v5`. CSphere/Vector3/Position are `Copy`, so taking
    // owned snapshots here avoids aliasing the `&mut transition.sphere_path`
    // borrows the sibling calls need (the decomp freely aliases via raw ptrs).
    let v5 = transition.sphere_path.localspace_sphere[0]; // localspace_sphere[0]
    let v5b = transition.sphere_path.localspace_sphere[1]; // localspace_sphere[1]
    let v3 = transition.sphere_path.localspace_curr_center; // localspace_curr_center
    let lpos = transition.sphere_path.localspace_pos; // localspace_pos (frame)
    let localspace_z = transition.sphere_path.localspace_z; // up axis (v4+132)
    let num_sphere = transition.sphere_path.num_sphere; // *(_DWORD*)v4
    let insert_type = transition.sphere_path.insert_type;

    // acclient.c:361337 — movement = localspace_sphere.center - *localspace_curr_center.
    let movement = v5.center - v3;

    // ── Step 1: placement / ethereal early-out (acclient.c:361344). ──────────
    // `if ( v8 || obstruction_ethereal )` — v8 == (insert_type == PLACEMENT(1)).
    if insert_type == InsertType::Placement || transition.sphere_path.obstruction_ethereal {
        // acclient.c:361346-361348 — v25 = 1; if bldg_check: v25 = (hits_interior_cell == 0).
        let center_check = if transition.sphere_path.bldg_check {
            !transition.sphere_path.hits_interior_cell
        } else {
            true
        };
        // acclient.c:361349 — root->sphere_intersects_solid(localspace_sphere[0], center_check)
        //   || (num_sphere > 1 && root->sphere_intersects_solid(localspace_sphere[1], center_check)).
        if sphere_intersects_solid(root, &v5, center_check, polys)
            || (num_sphere > 1 && sphere_intersects_solid(root, &v5b, center_check, polys))
        {
            return 2; // COLLIDED
        }
        // No solid overlap → fall through to the shared `return 1`.
    } else {
        // ── Step 2: check_walkable (acclient.c:361356-361357). ───────────────
        if transition.sphere_path.check_walkable {
            // RECONCILE: sibling 01 `check_walkable(this=root, path, check_pos, scale)`;
            //   Phase-1 leaf walk needs `polys`, appended here.
            return super::resolver_check_walkable::check_walkable(
                root,
                &mut transition.sphere_path,
                &v5,
                scale,
                polys,
            );
        }

        // ── Step 3: step_sphere_down (acclient.c:361358-361359). ─────────────
        if transition.sphere_path.step_down {
            // RECONCILE: sibling 02 `step_sphere_down(this=root, path, collisions,
            //   check_pos, scale)`; `polys` appended for the Phase-1 leaf walk.
            return super::resolver_step_down::step_sphere_down(
                root,
                &mut transition.sphere_path,
                &mut transition.collision_info,
                &v5,
                scale,
                polys,
            );
        }

        // ── Step 4: collide → walk down onto the supporting poly (361360). ───
        if transition.sphere_path.collide {
            // acclient.c:361362-361377 — valid_pos = copy of localspace_sphere[0];
            //   find_walkable(root, path, &valid_pos, &hit_poly_out, &movement,
            //                 localspace_z, &changed).
            let mut fw = FindWalkable::new(v5.center, v5.radius, transition.sphere_path.walk_interp);
            find_walkable(
                root,
                &mut fw,
                movement,
                localspace_z,
                transition.sphere_path.walkable_allowance,
                polys,
            );
            // The decomp's find_walkable mutates path->WalkInterp in place;
            // mirror that (FindWalkable bundled it as a Phase-1 carry).
            transition.sphere_path.walk_interp = fw.walk_interp;

            // acclient.c:361378 — if ( changed ).
            if fw.changed {
                // acclient.c:361380-361395 — offset = valid_pos.center - sphere.center;
                //   g = localtoglobalvec(localspace_pos, offset) * scale.
                let offset = fw.center - v5.center;
                let g = lpos.frame.localtoglobalvec(offset) * scale;
                // acclient.c:361396 — add_offset_to_check_pos(path, &g) (sibling 06).
                transition.sphere_path.add_offset_to_check_pos(&g);

                // The find_walkable out-param `*polygon` (always set when
                // `changed`) is the supporting poly.
                if let Some(pid) = fw.hit_poly
                    && let Some(poly) = polys.get(&pid)
                {
                    // acclient.c:361397-361398 — trans = Plane::localtoglobal(check_pos,
                    //   localspace_pos, poly->plane); trans.d *= scale. Same-cell
                    //   reduction (block offset 0); cross-cell delta is PHASE3.
                    let mut trans = lpos.frame.plane_localtoglobal(&poly.plane);
                    // Cross-landblock carry: Position::localtoglobal adds
                    // get_block_offset(check_pos, localspace_pos) to the plane
                    // point → shifts d by -(N·offset). Zero within one LB.
                    // acclient.c:467672→147154 (A08; B3 cross-LB test verifies sign).
                    trans.d -= trans.normal.dot(&LandDefs::get_block_offset(
                        transition.sphere_path.check_pos.objcell_id,
                        lpos.objcell_id,
                    ));
                    trans.d *= scale;
                    // acclient.c:361399 — set_contact_plane(collisions, &trans, false) (P1).
                    transition.collision_info.set_contact_plane(trans, false);
                    // acclient.c:361403 — collisions->contact_plane_cell_id =
                    //   check_pos.objcell_id (*(_DWORD*)(v4+272)).
                    transition.collision_info.contact_plane_cell_id =
                        transition.sphere_path.check_pos.objcell_id;
                    // acclient.c:361404-361409 — set_walkable(path, &valid_pos, poly,
                    //   localspace_z, localspace_pos, scale) (sibling 06).
                    let valid_pos = Sphere { center: fw.center, radius: v5.radius };
                    // RECONCILE: sibling 06 `set_walkable(.., local_pos: &Position, ..)`
                    //   — the decomp passes `(Position*)(v4+60)` (localspace_pos); the
                    //   stale Phase-1 `collisioninfo.rs` stub still types it `&CellPos`.
                    transition
                        .sphere_path
                        .set_walkable(&valid_pos, poly, &localspace_z, &lpos, scale);
                }
                return 3; // ADJUSTED
            }
            // !changed → fall through (the decomp does NOT run the state branch).
        } else {
            // ── Step 5: classify by object_info.state (acclient.c:361410). ───
            let state = transition.object_info.state;

            if (state & object_info_state::CONTACT) != 0 {
                // acclient.c:361411 — v19 & 1 (CONTACT).
                // acclient.c:361414-361418 — sphere_intersects_poly(sphere[0]) hit
                //   ⇒ step the sphere up over hit_poly (LOCAL normal; 03 re-bases it).
                let first = sphere_intersects_poly(root, &v5, movement, polys);
                if let Some((pid, _cpt)) = first {
                    let n = poly_normal(pid, polys); // hit_poly->plane.N (local)
                    trace(|| {
                        format!(
                            "  find_collisions CONTACT branch: sphere0 hit poly {pid} local_normal={n:?} \
                             movement={movement:?} -> step_sphere_up"
                        )
                    });
                    return super::resolver_slide::step_sphere_up(transition, &n);
                }
                // acclient.c:361419 — scale reused as the 2nd-sphere poly out-param (init 0).
                let hit_poly = first.map(|(pid, _)| pid); // None in Phase-1 (no front-face hit)
                // acclient.c:361420 — if ( num_sphere > 1 ).
                if num_sphere > 1 {
                    let second = sphere_intersects_poly(root, &v5b, movement, polys);
                    if let Some((pid2, _)) = second {
                        // acclient.c:361421-361427 — 2nd-sphere front-face hit ⇒ slide
                        //   (LOCAL normal; sibling 03 re-bases it).
                        let n2 = poly_normal(pid2, polys); // poly2->plane.N (local)
                        return super::resolver_slide::slide_sphere(
                            &mut transition.sphere_path,
                            &mut transition.collision_info,
                            &n2,
                        );
                    }
                    let poly2 = second.map(|(pid, _)| pid); // None in Phase-1
                    // RECONCILE: the next two branches require the back-face GRAZE
                    //   out-param the Phase-1 sphere_intersects_poly drops (see module
                    //   doc). With only front-face hits surfaced, poly2/hit_poly are
                    //   None here and neither fires; restore by extending the leaf
                    //   predicate to also return the grazed poly.
                    if let Some(pid2) = poly2 {
                        // acclient.c:361429-361435 — scale != 0.0 ⇒ set_neg_poly_hit(path, 0,
                        //   globalvec(poly2->plane.N)); return 1.
                        let gn = lpos.frame.localtoglobalvec(poly_normal(pid2, polys));
                        transition.sphere_path.set_neg_poly_hit(0, &gn);
                        return 1;
                    }
                    if let Some(pid1) = hit_poly {
                        // acclient.c:361436-361441 — hit_poly ⇒ set_neg_poly_hit(path, 1,
                        //   globalvec(hit_poly->plane.N)); return 1.
                        let gn = lpos.frame.localtoglobalvec(poly_normal(pid1, polys));
                        transition.sphere_path.set_neg_poly_hit(1, &gn);
                        return 1;
                    }
                }
            } else if (state & object_info_state::PATH_CLIPPED) == 0 {
                // acclient.c:361447 — v8 = (v19 & 8) == 0 ⇒ NOT path-clipped.
                // acclient.c:361449-361460 — sphere_intersects_poly(sphere[0]) hit (or
                //   grazed hit_poly) ⇒ set_collide(globalvec(hit_poly->plane.N));
                //   walkable_allowance = z_for_landing; return 3 (ADJUSTED).
                let first = sphere_intersects_poly(root, &v5, movement, polys);
                let hit_poly = first.map(|(pid, _)| pid);
                if let Some(pid) = hit_poly {
                    let gn = lpos.frame.localtoglobalvec(poly_normal(pid, polys));
                    transition.sphere_path.set_collide(&gn);
                    // acclient.c:361460 — *(_DWORD*)(v4+440) = z_for_landing_1.
                    transition.sphere_path.walkable_allowance = Z_FOR_LANDING;
                    return 3;
                }
                // RECONCILE: the decomp's `|| hit_poly` also catches a back-face
                //   graze of sphere[0] (dropped in Phase-1; see module doc).
                if num_sphere > 1 {
                    // acclient.c:361461-361473 — 2nd-sphere hit (or graze) ⇒
                    //   set_collision_normal(globalvec(hit_poly->plane.N)); return 2.
                    let second = sphere_intersects_poly(root, &v5b, movement, polys);
                    if let Some((pid2, _)) = second {
                        let gn = lpos.frame.localtoglobalvec(poly_normal(pid2, polys));
                        transition.collision_info.set_collision_normal(gn);
                        return 2; // COLLIDED
                    }
                    // RECONCILE: 2nd-sphere back-face graze (`|| hit_poly`) dropped.
                }
            } else {
                // acclient.c:361474-361487 — PATH_CLIPPED (v19 & 8): perfect-clip path.
                //   sphere_intersects_poly(sphere[0]) hit (or grazed hit_poly) ⇒
                //   collide_with_pt(root, object, path, collisions, check_pos, curr_pos,
                //                   hit_poly, contact_pt, scale).
                if let Some((pid, contact)) = sphere_intersects_poly(root, &v5, movement, polys) {
                    // RECONCILE: sibling 04 `collide_with_pt(.., hit_poly, contact_pt, scale)`
                    //   — the decomp passes the `CPolygon*`; here `hit_poly` is its `u16`
                    //   id (matching Phase-1 `adjust_to_plane`) and `polys` is appended
                    //   for the tree re-query.
                    return super::resolver_collide_pt::collide_with_pt(
                        root,
                        &transition.object_info,
                        &mut transition.sphere_path,
                        &mut transition.collision_info,
                        &v5,
                        &v3,
                        pid,
                        &contact,
                        scale,
                        polys,
                    );
                }
                // RECONCILE: PATH_CLIPPED back-face graze (`|| hit_poly`) dropped.
            }
        }
    }

    // acclient.c:361500 — default fall-through.
    1 // OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::BspLeaf;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A 2×2 floor in the z = 0 plane, normal +Z, spanning (0,0)-(2,2).
    fn floor_poly() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, 0.0),
                v(2.0, 0.0, 0.0),
                v(2.0, 2.0, 0.0),
                v(0.0, 2.0, 0.0),
            ],
            plane: Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 },
        }
    }

    fn polys() -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, floor_poly());
        m
    }

    /// A non-solid leaf carrying the floor poly with a wide bounding sphere
    /// (never rejects in these tests).
    fn floor_leaf() -> BspNode {
        BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere { center: v(1.0, 1.0, 0.0), radius: 100.0 }),
            poly_ids: vec![0],
        })
    }

    /// A transition whose path carries a single localspace sphere `s` sweeping
    /// from `curr_center`, with identity `localspace_pos`/`check_pos`, the given
    /// object `state`, and otherwise-default flags. `movement = s.center -
    /// curr_center`.
    fn transition_with(s: Sphere, curr_center: Vector3, state: u32) -> CTransition {
        let mut t = CTransition::default();
        t.object_info.state = state;
        t.sphere_path.num_sphere = 1;
        t.sphere_path.localspace_sphere[0] = s;
        t.sphere_path.localspace_curr_center = curr_center;
        t.sphere_path.localspace_z = v(0.0, 0.0, 1.0);
        t.sphere_path.walkable_allowance = Z_FOR_LANDING;
        t
    }

    // ── Case 1 — placement: solid overlap returns COLLIDED, miss falls to OK. ─
    //
    // insert_type = PLACEMENT(1), bldg_check = false ⇒ center_check = 1. The
    // non-solid floor leaf falls to its per-poly test: a sphere straddling the
    // z=0 quad overlaps (polygon_hits_sphere) ⇒ sphere_intersects_solid true ⇒
    // return 2. A sphere 5 units above the floor (|dp| = 5 > reach 0.4998)
    // misses every poly ⇒ false ⇒ fall through to return 1.
    #[test]
    fn placement_solid_overlap_collides_else_ok() {
        let mut over = transition_with(
            Sphere { center: v(1.0, 1.0, 0.3), radius: 0.5 },
            v(1.0, 1.0, 0.3),
            0,
        );
        over.sphere_path.insert_type = InsertType::Placement;
        assert_eq!(find_collisions(&floor_leaf(), &mut over, 1.0, &polys()), 2);

        let mut clear = transition_with(
            Sphere { center: v(1.0, 1.0, 5.0), radius: 0.5 },
            v(1.0, 1.0, 5.0),
            0,
        );
        clear.sphere_path.insert_type = InsertType::Placement;
        assert_eq!(find_collisions(&floor_leaf(), &mut clear, 1.0, &polys()), 1);
    }

    // ── Case 2 — ethereal early-out mirrors placement (obstruction_ethereal). ─
    //
    // Same geometry as case 1 but selected via `obstruction_ethereal` instead
    // of insert_type, proving the `v8 || obstruction_ethereal` disjunction.
    #[test]
    fn ethereal_obstruction_takes_solid_branch() {
        let mut over = transition_with(
            Sphere { center: v(1.0, 1.0, 0.3), radius: 0.5 },
            v(1.0, 1.0, 0.3),
            0,
        );
        over.sphere_path.obstruction_ethereal = true;
        assert_eq!(find_collisions(&floor_leaf(), &mut over, 1.0, &polys()), 2);
    }

    // ── Case 3 — !PATH_CLIPPED front-face hit ⇒ set_collide, ADJUSTED. ────────
    //
    // state = 0 (not CONTACT, not PATH_CLIPPED), collide/step_down/check_walkable
    // all false, not placement/ethereal. Sphere (1,1,0.3) r=0.5 over the floor;
    // curr_center (1,1,1.3) ⇒ movement (0,0,-1), so movement·N = -1 < 0 (front
    // face). sphere_intersects_poly hits ⇒ set_collide(globalvec((0,0,1))),
    // walkable_allowance := z_for_landing, return 3. localspace_pos is identity
    // so the global normal equals the local one.
    #[test]
    fn not_path_clipped_front_face_hit_adjusts() {
        let mut t = transition_with(
            Sphere { center: v(1.0, 1.0, 0.3), radius: 0.5 },
            v(1.0, 1.0, 1.3),
            0,
        );
        // Pre-perturb walkable_allowance to confirm the branch overwrites it.
        t.sphere_path.walkable_allowance = 0.0;
        let r = find_collisions(&floor_leaf(), &mut t, 1.0, &polys());
        assert_eq!(r, 3, "front-face hit ⇒ ADJUSTED");
        assert!((t.sphere_path.walkable_allowance - Z_FOR_LANDING).abs() < 1e-4);
    }

    // ── Case 4 — !PATH_CLIPPED 2nd-sphere hit ⇒ set_collision_normal, COLLIDED.
    //
    // num_sphere = 2. sphere[0] sits at (10,10,1) (x=10 is outside the [0,2]²
    // quad ⇒ no poly overlap), so the first test misses. movement is driven by
    // sphere[0] vs curr_center (10,10,2) ⇒ (0,0,-1) (front face). sphere[1] at
    // (1,1,0.3) r=0.5 overlaps the floor moving down ⇒ second test hits ⇒
    // set_collision_normal(globalvec((0,0,1))) = (0,0,1), return 2.
    #[test]
    fn not_path_clipped_second_sphere_collides() {
        let mut t = transition_with(
            Sphere { center: v(10.0, 10.0, 1.0), radius: 0.5 },
            v(10.0, 10.0, 2.0),
            0,
        );
        t.sphere_path.num_sphere = 2;
        t.sphere_path.localspace_sphere[1] = Sphere { center: v(1.0, 1.0, 0.3), radius: 0.5 };

        let r = find_collisions(&floor_leaf(), &mut t, 1.0, &polys());
        assert_eq!(r, 2, "2nd-sphere hit ⇒ COLLIDED");
        let n = t.collision_info.collision_normal.expect("collision normal set");
        assert!((n.x).abs() < 1e-4 && (n.y).abs() < 1e-4 && (n.z - 1.0).abs() < 1e-4, "n={n:?}");
    }

    // ── Case 5 — no predicate fires ⇒ default OK. ────────────────────────────
    //
    // state = 0, single sphere far above the floor (no overlap), num_sphere = 1,
    // not placement/ethereal/collide/step_down/check_walkable ⇒ both the
    // first-sphere test misses and there is no second sphere ⇒ return 1.
    #[test]
    fn no_hit_returns_ok() {
        let mut t = transition_with(
            Sphere { center: v(1.0, 1.0, 5.0), radius: 0.5 },
            v(1.0, 1.0, 6.0),
            0,
        );
        assert_eq!(find_collisions(&floor_leaf(), &mut t, 1.0, &polys()), 1);
    }
}
