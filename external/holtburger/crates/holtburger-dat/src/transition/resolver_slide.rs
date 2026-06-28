//! `BSPTREE::slide_sphere` + `BSPTREE::step_sphere_up` — the two `__stdcall`
//! BSP-tree responders the swept-step dispatcher (`BSPTREE::find_collisions`,
//! agent 05) hands a blocking polygon's normal so the moving sphere can either
//! slide along the contact plane or step up over the obstruction. Ported
//! decomp-faithfully from `acclient.c:361031` / `acclient.c:361072`
//! (`sub_00539E50` / `sub_00539F20`).
//!
//! ## Owns
//! - [`slide_sphere`]    — `BSPTREE::slide_sphere`    (acclient.c:361031, __stdcall)
//! - [`step_sphere_up`]  — `BSPTREE::step_sphere_up`  (acclient.c:361072, __stdcall)
//!
//! ## What the decomp does
//! Both functions are THIN wrappers. Their only own logic is to rotate the
//! caller's local-space `collision_normal` into global space through the
//! path's `localspace_pos.frame.m_fl2gv` basis (exactly
//! [`super::frame_transform::Frame::localtoglobalvec`], acclient.c:143659) and
//! then forward to the heavy leaf:
//!
//! - `slide_sphere`:    `return CSphere::slide_sphere(path->global_sphere,
//!   path, collisions, &gnormal, path->global_curr_center);` (acclient.c:361048)
//! - `step_sphere_up`:  `if (CTransition::step_up(transition, &gnormal)) return 1;`
//!   `else return SPHEREPATH::step_up_slide(&sphere_path, &object_info,
//!   &collision_info);` (acclient.c:361086-361090)
//!
//! ## RECONCILE — the Phase-1 leaf is a *pure* `CSphere::slide_sphere`
//! The decomp's `CSphere::slide_sphere(this, path, collisions, normal, curr)`
//! both MUTATES `path`/`collisions` (via `set_collision_normal` /
//! `add_offset_to_check_pos`) and returns the `2`/`3`/`4` code. Phase 1
//! deliberately ported it as a SIDE-EFFECT-FREE leaf
//! ([`super::sphere_slide::slide_sphere`]) that takes decomposed scalars and
//! surfaces those mutations through its [`super::sphere_slide::SlideSphere`]
//! return so a caller can replay them against real state. The decomp call site
//! that owns that replay for THIS branch is `BSPTREE::slide_sphere` itself (the
//! mutations happen synchronously inside the `CSphere::slide_sphere` it calls,
//! before returning to `find_collisions`), so the replay lives here:
//! [`slide_sphere`] decomposes the leaf's implicit inputs, calls the pure leaf,
//! then replays `set_collision_normal` / `add_offset_to_check_pos` exactly where
//! the decomp's leaf body does (acclient.c:358899) and maps the outcome to a
//! [`TransitionState`]. The dispatcher (agent 05) can thus `return
//! slide_sphere(..)` verbatim and observe the decomp's int + mutations.
//! `// RECONCILE:` — if the fix loop re-homes that replay into the Phase-3
//! driver, strip the mutation arms here and surface `SlideSphere` instead.
//!
//! ## PHASE3 hooks
//! - `block_offset` = `LandDefs::get_block_offset(curr_pos.objcell_id,
//!   check_pos.objcell_id)` — the cross-landblock cell delta. Cell ids /
//!   landblock grid are Phase-3 (cell-array) territory; the same-landblock case
//!   (the only one the leaf layer sees) is `0`. Passed as [`Vector3::zero`]
//!   with a `// PHASE3` note, mirroring
//!   [`super::frame_transform::Frame::plane_localtoglobal_with_offset`].
//! - `CTransition::step_up` — the Phase-3 driver re-sweep (types-agent stub
//!   returns `0` = "did not step up", so [`step_sphere_up`] falls through to
//!   the slide fallback).
//! - `SPHEREPATH::step_up_slide` — owned by agent 06 (`spherepath_methods`);
//!   called here by the decomp's exact arg order.

use super::sphere_slide::{self, SlideSphere};
use super::types::{CTransition, CollisionInfo, LandDefs, SpherePath, TransitionState};
use holtburger_common::Vector3;

/// `BSPTREE::slide_sphere` (`acclient.c:361031`, `sub_00539E50`, `__stdcall`).
///
/// Redirects a blocked sphere along its contact plane. Rotates the local-space
/// `collision_normal` into global space through `path.localspace_pos.frame`,
/// forwards to the Phase-1 leaf [`super::sphere_slide::slide_sphere`] (with the
/// leaf's implicit inputs resolved from `path`/`collisions`), then replays the
/// leaf's surfaced side effects against `path`/`collisions` — see the module
/// `RECONCILE` note — and returns the decomp's `2`/`3`/`4` as a
/// [`TransitionState`].
///
/// Decomp body (acclient.c:361036-361048):
/// ```text
/// v4 = path->global_sphere;
/// v7 = localtoglobalvec(path->localspace_pos.frame, *collision_normal);
/// v5 = path->global_curr_center;
/// return CSphere::slide_sphere(v4, path, collisions, &v7, v5);
/// ```
// acclient.c:361031
pub fn slide_sphere(
    path: &mut SpherePath,
    collisions: &mut CollisionInfo,
    collision_normal: &Vector3,
) -> i32 {
    // ── Rotate the contact normal local → global (decomp v7). ──
    // acclient.c:361037-361047 — the `m_fl2gv` row math IS
    // `Frame::localtoglobalvec` (acclient.c:143659), reused verbatim.
    let gnormal = path.localspace_pos.frame.localtoglobalvec(*collision_normal);

    // ── Resolve the pure leaf's implicit inputs. ──
    // `this` = path->global_sphere (the FIRST sphere); v5 = global_curr_center.
    // acclient.c:361035 (v4), 361044 (v5).
    let center = path.global_sphere[0].center;
    let curr_pos = path.global_curr_center;

    // `N` = the resting contact-plane normal the leaf cross-products against:
    // `contact_plane` when valid, else `last_known_contact_plane`
    // (acclient.c:358936-358945 — the pointer is chosen by
    // `contact_plane_valid` ALONE; `last_known`'s own valid flag is not
    // consulted). With both `Option`s `None` the decomp reads stale plane
    // memory; we substitute `0`.
    let contact_plane_normal = match collisions.contact_plane {
        Some(plane) => plane.normal,
        None => collisions
            .last_known_contact_plane
            .map(|plane| plane.normal)
            .unwrap_or_else(Vector3::zero),
    };

    // block_offset — cross-landblock cell delta. PHASE3 (cell-array); the
    // leaf layer only sees same-landblock steps, where it is `0`.
    // acclient.c:358937 — LandDefs::get_block_offset(curr.objcell_id,
    // check_pos.objcell_id).
    let block_offset =
        LandDefs::get_block_offset(path.curr_pos.objcell_id, path.check_pos.objcell_id); // acclient.c:358937

    // ── Call the pure leaf. ──
    let outcome =
        sphere_slide::slide_sphere(center, gnormal, curr_pos, contact_plane_normal, block_offset);

    // ── Replay the leaf's side effects, mirroring acclient.c:358899. ──
    // The decomp's `add_offset_to_check_pos(path, &offset, radius)` passes
    // `this->radius`, but Phase 1 proved the radius arg is never read
    // (acclient.c:358526 body ≡ the no-radius 311557 body), so the no-radius
    // mutator — the form BOTH `collisioninfo` and agent 06 expose — is used.
    match outcome {
        // Case 1 (decomp `return 3`): zero collision normal — nudge `check_pos`
        // halfway back. This is the ONLY arm that does NOT set_collision_normal.
        // acclient.c:358921-358934.
        SlideSphere::Adjusted { offset } => {
            path.add_offset_to_check_pos(&offset);
            TransitionState::Adjusted as i32
        }
        // Cases 3 & 4 (decomp `return 4`): the unconditional
        // `set_collision_normal(collision_normal)` (acclient.c:358936) FIRST,
        // then `add_offset_to_check_pos(offset)` (acclient.c:358980 / 358999).
        SlideSphere::Slid { offset } => {
            collisions.set_collision_normal(gnormal);
            path.add_offset_to_check_pos(&offset);
            TransitionState::Slid as i32
        }
        // Cases 2 & 5 (decomp `return 2`): the unconditional
        // `set_collision_normal(collision_normal)` (acclient.c:358936); then,
        // for case 5 with a non-degenerate `−gDelta`, a SECOND
        // `set_collision_normal(normalize(−gDelta))` (acclient.c:359006-359009).
        SlideSphere::Collided { recomputed_normal } => {
            collisions.set_collision_normal(gnormal);
            if let Some(recomputed) = recomputed_normal {
                collisions.set_collision_normal(recomputed);
            }
            TransitionState::Collided as i32
        }
    }
}

/// `BSPTREE::step_sphere_up` (`acclient.c:361072`, `sub_00539F20`, `__stdcall`).
///
/// Attempts to step the swept sphere UP over a hit polygon. Rotates the
/// local-space `collision_normal` into global space through
/// `transition.sphere_path.localspace_pos.frame`, asks the Phase-3 driver
/// [`CTransition::step_up`] to re-sweep; if it succeeds, returns
/// [`TransitionState::Ok`] (decomp `1`), otherwise falls back to the
/// step-up slide ([`SpherePath::step_up_slide`], agent 06) and returns its
/// result.
///
/// Decomp body (acclient.c:361077-361090):
/// ```text
/// v4 = localtoglobalvec(transition->sphere_path.localspace_pos.frame, *collision_normal);
/// if ( CTransition::step_up(transition, &v4) )
///     result = 1;
/// else
///     result = SPHEREPATH::step_up_slide(&transition->sphere_path,
///                                        &transition->object_info,
///                                        &transition->collision_info);
/// return result;
/// ```
// acclient.c:361072
pub fn step_sphere_up(
    transition: &mut CTransition,
    collision_normal: &Vector3,
) -> i32 {
    // Rotate the contact normal local → global (decomp v4), acclient.c:361077-361085.
    let gnormal = transition
        .sphere_path
        .localspace_pos
        .frame
        .localtoglobalvec(*collision_normal);

    // PHASE3: `CTransition::step_up` re-sweeps the sphere up `gnormal` against
    // the cell array. The types-agent stub returns `0` ("did not step up"), so
    // this falls through to the slide fallback. acclient.c:361086-361087.
    if transition.step_up(&gnormal) != 0 {
        return TransitionState::Ok as i32;
    }

    // `SPHEREPATH::step_up_slide` (agent 06, `spherepath_methods`) — slide along
    // the surface as the step-up fallback, called by the decomp's exact arg
    // order. acclient.c:361089. The three `&transition.*` borrows are disjoint
    // struct fields. `step_up_slide` returns the raw decomp `i32` slide code
    // (the resolver layer's convention, matching `find_collisions` /
    // `step_sphere_down`), forwarded verbatim.
    transition
        .sphere_path
        .step_up_slide(&transition.object_info, &mut transition.collision_info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::{Plane, Sphere};

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < 1e-4 && (a.y - b.y).abs() < 1e-4 && (a.z - b.z).abs() < 1e-4
    }

    /// Build a `SpherePath` with an identity `localspace_pos` frame (so
    /// `gnormal == collision_normal`), one global sphere at `center`, and the
    /// previous accepted center at `curr`.
    fn path_with(center: Vector3, curr: Vector3) -> SpherePath {
        let mut p = SpherePath::default();
        p.num_sphere = 1;
        p.global_sphere[0] = Sphere {
            center,
            radius: 1.0,
        };
        p.global_curr_center = curr;
        p
    }

    // ── slide_sphere case 1 (decomp return 3 → Adjusted) ─────────────────────
    // collision_normal == 0 → leaf nudges check_pos by (curr − center)·0.5 and
    // does NOT set a collision normal.
    // center=(4,0,0), curr=(0,0,0) → offset = (0−4,0,0)·0.5 = (−2,0,0).
    #[test]
    fn slide_case1_zero_normal_adjusts_without_normal() {
        let mut path = path_with(v(4.0, 0.0, 0.0), v(0.0, 0.0, 0.0));
        let mut ci = CollisionInfo::default();

        let r = slide_sphere(&mut path, &mut ci, &Vector3::zero());

        assert_eq!(r, TransitionState::Adjusted as i32);
        // check_pos.origin started at the identity (0,0,0) and moved by offset.
        assert!(
            approx(path.check_pos.frame.origin, v(-2.0, 0.0, 0.0)),
            "origin = {:?}",
            path.check_pos.frame.origin
        );
        // Case 1 is the one arm that records no collision normal.
        assert!(ci.collision_normal.is_none());
    }

    // ── slide_sphere case 3 (decomp return 4 → Slid), identity frame ─────────
    // collision_normal=(1,0,0), N=(0,1,0) → direction=(1,0,0)×(0,1,0)=(0,0,1).
    // center=(1,2,3), curr=(0,0,0), block_offset=0 → gDelta=(1,2,3).
    // along=direction·gDelta=3; P=(0,0,3); |P|²=9 ≥ ε →
    //   offset = P − gDelta = (−1,−2,0). The unconditional set_collision_normal
    //   records the (already unit) (1,0,0).
    #[test]
    fn slide_case3_slides_along_edge_and_sets_normal() {
        let mut path = path_with(v(1.0, 2.0, 3.0), v(0.0, 0.0, 0.0));
        let mut ci = CollisionInfo::default();
        ci.contact_plane = Some(Plane {
            normal: v(0.0, 1.0, 0.0),
            d: 0.0,
        });

        let r = slide_sphere(&mut path, &mut ci, &v(1.0, 0.0, 0.0));

        assert_eq!(r, TransitionState::Slid as i32);
        assert!(
            approx(path.check_pos.frame.origin, v(-1.0, -2.0, 0.0)),
            "origin = {:?}",
            path.check_pos.frame.origin
        );
        assert_eq!(ci.collision_normal, Some(v(1.0, 0.0, 0.0)));
    }

    // ── slide_sphere case 5 (decomp return 2 → Collided), double set ─────────
    // collision_normal=(0,0,1), N=(0,0,−1) → direction≈0 (|dir|²=0<ε) and
    // dot(cN,N)=−1<0 → record normalize(−gDelta), block.
    // center=(0,0,0), curr=(0,0,−3) → gDelta=(0,0,3); −gDelta=(0,0,−3) →
    //   normalized (0,0,−1). The FIRST set_collision_normal stores (0,0,1);
    //   the SECOND overwrites it with (0,0,−1) — the final stored value.
    // Collided records no offset, so check_pos stays at the identity origin.
    #[test]
    fn slide_case5_blocks_and_records_normalized_neg_gdelta() {
        let mut path = path_with(v(0.0, 0.0, 0.0), v(0.0, 0.0, -3.0));
        let mut ci = CollisionInfo::default();
        ci.contact_plane = Some(Plane {
            normal: v(0.0, 0.0, -1.0),
            d: 0.0,
        });

        let r = slide_sphere(&mut path, &mut ci, &v(0.0, 0.0, 1.0));

        assert_eq!(r, TransitionState::Collided as i32);
        // The second set_collision_normal wins.
        assert_eq!(ci.collision_normal, Some(v(0.0, 0.0, -1.0)));
        assert!(
            approx(path.check_pos.frame.origin, Vector3::zero()),
            "origin = {:?}",
            path.check_pos.frame.origin
        );
    }

    // ── slide_sphere exercises the local→global frame transform ──────────────
    // A 90°-about-Z `m_fl2gv` (column-major: local +X → global (0,1,0)) so the
    // local normal (1,0,0) is rotated to gnormal (0,1,0) before the leaf runs.
    // With N=(1,0,0): direction = gnormal×N = (0,1,0)×(1,0,0) = (0,0,−1).
    // center=(0,2,5), curr=(0,0,0) → gDelta=(0,2,5); along=(0,0,−1)·gDelta=−5;
    //   P=(0,0,−1)·(−5)=(0,0,5); |P|²=25 ≥ ε → offset = P − gDelta = (0,−2,0).
    // The recorded collision normal is the ROTATED gnormal (0,1,0).
    #[test]
    fn slide_uses_localspace_frame_to_rotate_normal() {
        let mut path = path_with(v(0.0, 2.0, 5.0), v(0.0, 0.0, 0.0));
        // column-major: col0=(0,1,0) col1=(-1,0,0) col2=(0,0,1).
        path.localspace_pos.frame.fl2gv = [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let mut ci = CollisionInfo::default();
        ci.contact_plane = Some(Plane {
            normal: v(1.0, 0.0, 0.0),
            d: 0.0,
        });

        let r = slide_sphere(&mut path, &mut ci, &v(1.0, 0.0, 0.0));

        assert_eq!(r, TransitionState::Slid as i32);
        assert!(
            approx(path.check_pos.frame.origin, v(0.0, -2.0, 0.0)),
            "origin = {:?}",
            path.check_pos.frame.origin
        );
        assert_eq!(ci.collision_normal, Some(v(0.0, 1.0, 0.0)));
    }

    // ── step_sphere_up routes to step_up_slide (Phase-3 step_up stub = 0) ─────
    // CROSS-AGENT: depends on `CTransition::step_up` (types-agent stub → 0) and
    // `SPHEREPATH::step_up_slide` (agent 06). With `step_up_normal` left at 0,
    // step_up_slide's `CSphere::slide_sphere` takes the zero-normal case 1 →
    // offset = (global_curr_center − global_sphere.center)·0.5, returns 3.
    // center=(4,0,0), curr=(0,0,0) → offset=(−2,0,0); step_up_slide also clears
    // `step_up` and the contact plane.
    #[test]
    fn step_sphere_up_falls_back_to_step_up_slide() {
        let mut t = CTransition::default();
        t.sphere_path = path_with(v(4.0, 0.0, 0.0), v(0.0, 0.0, 0.0));
        t.sphere_path.step_up = true; // step_up_slide must clear this to 0.
        // step_up_normal defaults to zero → leaf case 1 (no contact plane need).

        let r = step_sphere_up(&mut t, &v(0.0, 0.0, 1.0));

        assert_eq!(r, TransitionState::Adjusted as i32);
        assert!(
            approx(t.sphere_path.check_pos.frame.origin, v(-2.0, 0.0, 0.0)),
            "origin = {:?}",
            t.sphere_path.check_pos.frame.origin
        );
        assert!(!t.sphere_path.step_up);
    }
}
