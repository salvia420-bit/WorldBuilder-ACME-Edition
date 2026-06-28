//! `BSPTREE::collide_with_pt` (`acclient.c:361124`, idb addr `00539F50`) — the
//! resolver branch `BSPTREE::find_collisions` dispatches to (step 5,
//! `PATH_CLIPPED` arm) when a path-clipped object strikes a polygon: it either
//! records the collision normal and reports a hard collision, or — for a
//! *perfect-clip* object — slides the swept sphere back off the offending plane
//! (`adjust_to_plane`) and reports the adjusted rest position.
//!
//! Phase-2 resolver method **04**. Owns:
//! - [`collide_with_pt`] — `BSPTREE::collide_with_pt` (acclient.c:361124)
//!
//! ## Decomp body (acclient.c:361124, verbatim shape)
//! ```text
//! if ( !(object->state & 0x40) )                 // not PERFECT_CLIP
//! {
//!   offset = localspace_pos.frame.localtoglobalvec(hit_poly->plane.N);
//!   COLLISIONINFO::set_collision_normal(collisions, &offset);
//!   return 2;                                     // COLLIDED
//! }
//! valid_pos.center = check_pos->center;           // CSphere copy on the stack
//! valid_pos.radius = check_pos->radius;
//! if ( !BSPTREE::adjust_to_plane(this, &valid_pos, *curr_pos, hit_poly, contact_pt) )
//!   return 2;                                      // COLLIDED — NO normal write
//! v13 = Position::localtoglobalvec(&localspace_pos, &result, &hit_poly->plane.N);
//! COLLISIONINFO::set_collision_normal(collisions, v13);
//! offset   = valid_pos.center - check_pos->center; // local-space slide-back
//! offset   = Position::localtoglobalvec(&localspace_pos, &result, &offset);
//! offset  *= scale;
//! SPHEREPATH::add_offset_to_check_pos(path, &offset);
//! return 3;                                         // ADJUSTED
//! ```
//!
//! ## DECOMP vs. the Phase-2 spec prose (decomp wins)
//! The Phase-2 spec's method-inventory line for "04" says the
//! `adjust_to_plane`-**failure** path should
//! `set_collision_normal(globalvec(hit_poly.N))` before `return 2`. The
//! authoritative decomp (acclient.c:361156) does **not** — on failure it is a
//! bare `return 2` with **no** `COLLISIONINFO` write at all. Per the standing
//! ruling ("the DECOMP wins on logic", gmriggs: physics must be 1:1 or it
//! drifts from the server) this port omits the failure-path normal write. The
//! collision normal is recorded only on the no-perfect-clip arm and the
//! adjust-**success** arm. (In practice the Phase-1 [`adjust_to_plane`] is
//! `separated == true` for every front-face-gated poly — see its module docs —
//! so the failure arm is effectively unreachable and the two readings rarely
//! diverge observably; we still follow the decomp exactly.)
//!
//! ## ACE cross-ref (offset→name only)
//! `BSPTree.collide_with_pt` (`BSP/BSPTree.cs`) names the raw offsets this port
//! decodes: `object->state & 0x40` is `PERFECT_CLIP`
//! ([`object_info_state::PERFECT_CLIP`]), `path->localspace_pos` is the
//! cell-local `Position` whose `frame` (`m_fl2gv`) carries the local normal /
//! slide-back into global space, and the `2`/`3` returns are
//! `TransitionState.Collided`/`Adjusted`. ACE's logic is NOT followed where it
//! differs; only the names are borrowed.
//!
//! ## Return value
//! Returns the decomp's raw `signed int` (`2` = COLLIDED, `3` = ADJUSTED), to
//! match the sibling resolver fns ([`super::resolver_check_walkable`]). If the
//! Phase-3 driver prefers the enum, map `2 -> TransitionState::Collided`,
//! `3 -> TransitionState::Adjusted`.

use super::bsptree_adjust::adjust_to_plane;
use super::types::{object_info_state, CollisionInfo, ObjectInfo, SpherePath};
use crate::physics::{BspNode, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};
use std::collections::HashMap;

/// `BSPTREE::collide_with_pt` (`acclient.c:361124`).
///
/// `root` is the physics BSP root (`BSPTREE *this`); `object` the moving
/// object's [`ObjectInfo`] (the `state` bitfield selects the perfect-clip
/// path); `path`/`collisions` the swept-path + contact accumulators; `check_pos`
/// the `localspace_sphere` that struck the poly and `curr_pos` its pre-move
/// `localspace_curr_center`; `hit_poly` the id of the struck polygon (the
/// decomp's live `CPolygon*`, resolved through the shared `polys` table the way
/// the Phase-1 leaf layer resolves every `poly_id`); `contact_pt` the contact
/// point the decomp threads into `adjust_to_plane`'s internal queries; and
/// `scale` the object scale the local-space slide-back is multiplied by before
/// it nudges `check_pos`.
///
/// The localspace normal and slide-back are carried to global space through
/// `path.localspace_pos.frame`
/// ([`super::frame_transform::Frame::localtoglobalvec`] — the single-frame
/// reduction of the decomp's `Position::localtoglobalvec`).
// acclient.c:361124
// RECONCILE: the find_collisions DISPATCH MAP abbreviates this call as
//   collide_with_pt(root, object_info, path, collisions, localspace_sphere,
//                   localspace_curr_center, hit_poly, &cpt, scale)
// (9 args). The Phase-1 callees factor the live `CPolygon*` into a `u16` poly
// id + the shared `polys` table (so `hit_poly.plane.N` and `adjust_to_plane`'s
// re-query both resolve through `polys`), so the resolver threads `polys` in as
// a trailing arg — agent 05 has it in scope. `hit_poly` here is the `u16` id
// `sphere_intersects_poly` returns (NOT a `&CPolygon`); `contact_pt` is the
// `cpt` from the same return.
#[allow(clippy::too_many_arguments)]
pub fn collide_with_pt(
    root: &BspNode,
    object: &ObjectInfo,
    path: &mut SpherePath,
    collisions: &mut CollisionInfo,
    check_pos: &Sphere,
    curr_pos: &Vector3,
    hit_poly: u16,
    contact_pt: &Vector3,
    scale: f32,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> i32 {
    // hit_poly->plane.N — the decomp dereferences a live `CPolygon*`; here the
    // poly id resolves through the shared table. The `None` guard mirrors the
    // Phase-1 `adjust_to_plane` lookup convention: an absent poly degenerates to
    // a zero normal (which `set_collision_normal` keeps as a valid-but-collapsed
    // {0,0,0}); the retail decomp never hits it.
    let hit_normal = polys
        .get(&hit_poly)
        .map(|p| p.plane.normal)
        .unwrap_or_else(Vector3::zero);

    // if ( !(object->state & 0x40) ) — not PERFECT_CLIP: record the global
    // collision normal and report a hard collision.
    if (object.state & object_info_state::PERFECT_CLIP) == 0 {
        // offset = localspace_pos.frame.localtoglobalvec(hit_poly->plane.N).
        let global_normal = path.localspace_pos.frame.localtoglobalvec(hit_normal);
        collisions.set_collision_normal(global_normal);
        return 2; // COLLIDED
    }

    // ── PERFECT_CLIP: slide the swept sphere back off the struck plane. ──────
    //
    // `contact_pt` is the contact buffer the decomp passes through to
    // `adjust_to_plane` (which forwards it to its internal
    // `sphere_intersects_poly` queries). The Phase-1 `sphere_intersects_poly`
    // returns its contact by value, so `adjust_to_plane` dropped the out-param;
    // `contact_pt` is therefore vestigial at this call site.
    let _ = contact_pt;

    // valid_pos = { center: check_pos->center, radius: check_pos->radius }; the
    // decomp copies the CSphere onto the stack and lets `adjust_to_plane` mutate
    // its `center`. The Phase-1 port returns the mutated center in
    // `AdjustToPlane::final_center` instead of mutating in place.
    let adjusted = adjust_to_plane(
        root,
        check_pos.center,
        check_pos.radius,
        *curr_pos,
        hit_poly,
        polys,
    );

    // if ( !adjust_to_plane(...) ) return 2;
    // DECOMP (acclient.c:361156): bare `return 2` — NO set_collision_normal on
    // the failure arm (see the module docs; the spec prose says otherwise, the
    // decomp wins).
    if !adjusted.separated {
        return 2; // COLLIDED
    }

    // Adjust succeeded → valid_pos.center := adjusted.final_center.
    // v13 = localspace_pos.frame.localtoglobalvec(hit_poly->plane.N).
    let global_normal = path.localspace_pos.frame.localtoglobalvec(hit_normal);
    collisions.set_collision_normal(global_normal);

    // offset = valid_pos.center - check_pos->center  (local space);
    // offset = localspace_pos.frame.localtoglobalvec(offset);  (global);
    // offset *= scale.
    let local_offset = adjusted.final_center - check_pos.center;
    let global_offset = path.localspace_pos.frame.localtoglobalvec(local_offset) * scale;

    // SPHEREPATH::add_offset_to_check_pos(path, &offset).
    // RECONCILE: `add_offset_to_check_pos` is owned by agent 06
    // (spherepath_methods.rs); a Phase-1 copy also lives in collisioninfo.rs.
    // Whichever survives reconciliation, it is a `&mut SpherePath` method taking
    // `&Vector3` that translates `check_pos.frame.origin` by `offset` (decomp:
    // `check_pos.frame.m_fOrigin += offset`). Called as a method here.
    path.add_offset_to_check_pos(&global_offset);
    3 // ADJUSTED
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::BspLeaf;
    use crate::transition::frame_transform::Frame;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    const TOL: f32 = 1e-4;
    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }

    /// +90°-about-Z basis stored column-major in `m_fl2gv` (same convention as
    /// the `frame_transform` tests): local +X→+Y, +Y→−X, +Z→+Z. Used to prove
    /// the recorded normal is carried through `localspace_pos.frame`, not the
    /// identity.
    fn rot_z_90() -> Frame {
        Frame {
            fl2gv: [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            origin: Vector3::zero(),
        }
    }

    // A 2×2 floor square in the z=0 plane, normal +Z — the exact fixture the
    // Phase-1 `bsptree_adjust` tests are derived against, so the perfect-clip
    // slide-back lands on its known rest height.
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

    fn floor_leaf() -> BspNode {
        BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 10.0,
            }),
            poly_ids: vec![0],
        })
    }

    fn single(poly: ResolvedPolygon) -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, poly);
        m
    }

    // ── Case 1 — no PERFECT_CLIP → transformed+normalized normal, return 2. ──
    //
    // Hand-derived: `state = CONTACT|ON_WALKABLE = 0x3` (the `0x40` PERFECT_CLIP
    // bit is clear, so masking routes to the hard-collision arm). The struck
    // poly carries a deliberately NON-unit normal (2,0,0); through the
    // +90°-about-Z `localspace_pos.frame`:
    //   localtoglobalvec((2,0,0)) = col0 * 2 = (0,1,0) * 2 = (0,2,0)
    // and `set_collision_normal` normalizes it in place → (0,1,0). The function
    // returns 2 and must NOT touch `check_pos` (no `add_offset` on this arm) or
    // any other COLLISIONINFO field.
    #[test]
    fn no_perfect_clip_records_transformed_normal_returns_2() {
        let mut path = SpherePath::default();
        path.localspace_pos.frame = rot_z_90();
        path.check_pos.frame.origin = v(5.0, 6.0, 7.0);

        let object = ObjectInfo {
            state: object_info_state::CONTACT | object_info_state::ON_WALKABLE, // 0x3
            ..Default::default()
        };
        let mut collisions = CollisionInfo::default();

        // The poly is only read for `.plane.normal` here (adjust not reached);
        // give it a non-unit normal to exercise the in-place normalization.
        let poly = ResolvedPolygon {
            num_points: 3,
            vertices: vec![v(0.0, 0.0, 0.0), v(0.0, 1.0, 0.0), v(0.0, 0.0, 1.0)],
            plane: Plane {
                normal: v(2.0, 0.0, 0.0),
                d: 0.0,
            },
        };

        let r = collide_with_pt(
            &floor_leaf(),
            &object,
            &mut path,
            &mut collisions,
            &Sphere { center: v(1.0, 1.0, -1.0), radius: 0.5 },
            &v(1.0, 1.0, 1.0),
            0,
            &v(0.0, 0.0, 0.0),
            1.0,
            &single(poly),
        );

        assert_eq!(r, 2, "no PERFECT_CLIP -> hard collision (2)");
        let n = collisions.collision_normal.expect("collision_normal set");
        assert!(approx(n, v(0.0, 1.0, 0.0)), "got {n:?}");
        // The hard-collision arm records ONLY the collision normal.
        assert!(collisions.contact_plane.is_none());
        assert!(collisions.sliding_normal.is_none());
        // `check_pos` is untouched on this arm.
        assert!(approx(path.check_pos.frame.origin, v(5.0, 6.0, 7.0)));
    }

    // ── Case 2 — PERFECT_CLIP, adjust succeeds → normal + scaled offset, 3. ──
    //
    // Hand-derived from the Phase-1 `bsptree_adjust` Case-B geometry: a r=0.5
    // sphere sweeps straight down through the z=0 floor from curr_pos (1,1,1) to
    // check center (1,1,-1); `adjust_to_plane` rests it tangent at
    // final_center = (1,1,0.5). With the identity `localspace_pos.frame`:
    //   collision normal = localtoglobalvec((0,0,1)) = (0,0,1)
    //   local slide-back  = (1,1,0.5) - (1,1,-1) = (0,0,1.5)
    //   global offset      = (0,0,1.5) * scale(2.0) = (0,0,3.0)
    // so `check_pos.frame.origin` moves (5,6,7) → (5,6,10) and the fn returns 3.
    #[test]
    fn perfect_clip_adjust_success_offsets_and_returns_3() {
        let mut path = SpherePath::default(); // identity localspace_pos.frame
        path.check_pos.frame.origin = v(5.0, 6.0, 7.0);

        let object = ObjectInfo {
            state: object_info_state::PERFECT_CLIP, // 0x40
            ..Default::default()
        };
        let mut collisions = CollisionInfo::default();

        let r = collide_with_pt(
            &floor_leaf(),
            &object,
            &mut path,
            &mut collisions,
            &Sphere { center: v(1.0, 1.0, -1.0), radius: 0.5 },
            &v(1.0, 1.0, 1.0),
            0,
            &v(0.0, 0.0, 0.0),
            2.0, // scale — the slide-back is multiplied by this
            &single(floor_poly()),
        );

        assert_eq!(r, 3, "PERFECT_CLIP + adjust success -> ADJUSTED (3)");
        let n = collisions.collision_normal.expect("collision_normal set");
        assert!(approx(n, v(0.0, 0.0, 1.0)), "got {n:?}");
        // collide_with_pt records only the collision normal — never a contact
        // plane (unlike step_sphere_down / find_walkable).
        assert!(collisions.contact_plane.is_none());
        // check_pos.frame.origin += global offset (0,0,3.0) → (5,6,10).
        assert!(
            approx(path.check_pos.frame.origin, v(5.0, 6.0, 10.0)),
            "origin {:?}",
            path.check_pos.frame.origin
        );
    }

    // ── Case 3 — PERFECT_CLIP bit isolated among other state flags. ──────────
    //
    // `state = PERFECT_CLIP|IS_PLAYER|PATH_CLIPPED = 0x40|0x100|0x8 = 0x148`.
    // The `& 0x40` mask must still route to the perfect-clip arm. Identity frame
    // and scale 1.0 from the origin: the unscaled local slide-back (0,0,1.5)
    // moves `check_pos.frame.origin` (0,0,0) → (0,0,1.5). Confirms the mask
    // isolates 0x40 and that scale 1.0 leaves the offset un-scaled.
    #[test]
    fn perfect_clip_bit_isolated_among_flags_returns_3() {
        let mut path = SpherePath::default(); // origin (0,0,0), identity frame

        let object = ObjectInfo {
            state: object_info_state::PERFECT_CLIP
                | object_info_state::IS_PLAYER
                | object_info_state::PATH_CLIPPED, // 0x148
            ..Default::default()
        };
        let mut collisions = CollisionInfo::default();

        let r = collide_with_pt(
            &floor_leaf(),
            &object,
            &mut path,
            &mut collisions,
            &Sphere { center: v(1.0, 1.0, -1.0), radius: 0.5 },
            &v(1.0, 1.0, 1.0),
            0,
            &v(0.0, 0.0, 0.0),
            1.0,
            &single(floor_poly()),
        );

        assert_eq!(r, 3, "0x40 bit present (among 0x148) -> perfect-clip arm");
        assert!(approx(path.check_pos.frame.origin, v(0.0, 0.0, 1.5)));
    }
}
