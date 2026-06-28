//! `CSphere::collide_with_point` — resolve a swept sphere against a single
//! point obstruction (the moving sphere has been clipped to one contact and
//! must either back off onto the contact or report a blocking normal).
//! Ported decomp-faithfully from `acclient.c`.
//!
//! Owns:
//! - [`collide_with_point`] — `CSphere::collide_with_point` (acclient.c:358808)
//!
//! The decomp keys off the `PERFECT_CLIP` object-state bit
//! (`object->state & 0x40`, [`super::types::object_info_state::PERFECT_CLIP`]):
//!
//! * **not perfect-clip** — the simple case. Take the offset from this
//!   sphere's center to the moving sphere's current global center; if it
//!   normalizes (non-degenerate) it *is* the collision normal. Always returns
//!   `2` (`Collided`).
//!
//! * **perfect-clip** — solve a quadratic time-of-impact (via
//!   [`super::sphere_basics::find_time_of_collision`], acclient.c:358481) for
//!   when the moving sphere first reaches `radsum + EPSILON` of the point. The
//!   TOI's `disp` is `globalCurrCenter - center` and its `movement` is
//!   `blockOffset + (checkCenter - globalCurrCenter)`. If the contact time `t`
//!   lands in `(EPSILON, 1]`, scale the movement by `t-1` to get the offset
//!   that backs the check position onto the contact, derive the collision
//!   normal from it, and return `3` (`Adjusted`); otherwise return `2`
//!   (`Collided`) with no normal.
//!
//! Pure-leaf shape (matching the sibling response fns
//! [`super::sphere_slide`] / [`super::sphere_step`]): rather than mutate the
//! Phase-3 `SPHEREPATH` / `COLLISIONINFO`, this returns the computed values.
//! The driver replays the decomp's two side effects with what it gets back:
//!   * `COLLISIONINFO::set_collision_normal(collisions, &collision_normal)`
//!     (acclient.c:311726 — normalizes in place; see [`super::collisioninfo`]),
//!   * `SPHEREPATH::add_offset_to_check_pos(path, &offset, check_pos->radius)`
//!     (acclient.c:00536A60 — adds `offset` to `check_pos` and re-caches the
//!     global sphere).
//!
//! The decomp's eighth argument `disp` is *unused* in the body, so it is
//! dropped here. `block_offset` is the landblock delta the decomp fetches with
//! `LandDefs::get_block_offset(curr_pos.objcell_id, check_pos.objcell_id)`
//! (acclient.c:123110 — zero when both cells share a landblock); keeping it a
//! parameter leaves this predicate cell-agnostic.
//!
//! TYPES-NEEDS: `SpherePath.global_curr_center: [Vector3; 2]` — the decomp
//! reads `path->global_curr_center[sphere_num]` (the moving sphere's cached
//! global center for sphere `sphere_num`); the driver passes that element in
//! here as `global_curr_center`.
//! TYPES-NEEDS: `SPHEREPATH::add_offset_to_check_pos(offset, radius)` plus
//! the `cell_array_valid` flag / `cache_global_sphere` it touches — Phase-3
//! wiring the driver applies to the returned `offset`.

use super::sphere_basics::find_time_of_collision;
use super::types::{EPSILON, normalize_check_small};
use holtburger_common::Vector3;

/// Result of [`collide_with_point`], mirroring the decomp's `2` / `3` returns
/// (`signed int`). The driver maps these onto
/// [`super::types::TransitionState`] (`Collided` = 2, `Adjusted` = 3) and
/// replays the recorded side effects.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CollideWithPoint {
    /// Decomp `result = 2` ([`super::types::TransitionState::Collided`]).
    /// `collision_normal` is `Some(_)` only on the non-perfect-clip branch
    /// when the center-to-global-center offset was non-degenerate (the value
    /// the decomp feeds to `set_collision_normal`); `None` otherwise — either
    /// the perfect-clip TOI fell outside `(EPSILON, 1]`, or the offset was
    /// sub-epsilon and the decomp recorded nothing.
    Collided { collision_normal: Option<Vector3> },
    /// Decomp `result = 3` ([`super::types::TransitionState::Adjusted`]).
    /// `collision_normal` is the un-normalized vector for
    /// `set_collision_normal` (which normalizes); `offset` is the argument for
    /// `add_offset_to_check_pos`.
    Adjusted {
        collision_normal: Vector3,
        offset: Vector3,
    },
}

/// `CSphere::collide_with_point` (`acclient.c:358808`).
///
/// * `center` — this sphere's center (`this->center`), the sweep's origin.
/// * `global_curr_center` — the moving sphere's current global center
///   (`path->global_curr_center[sphere_num]`).
/// * `check_center` — the obstructing point/sphere's center
///   (`check_pos->center`).
/// * `radsum` — combined radius; the decomp pads it by `EPSILON`
///   (`radsuma = radsum + 0.00019999999`) on the perfect-clip branch.
/// * `perfect_clip` — `object->state & 0x40`
///   ([`super::types::object_info_state::PERFECT_CLIP`]).
/// * `block_offset` — `get_block_offset(curr_pos.objcell_id,
///   check_pos.objcell_id)` (zero within one landblock).
pub fn collide_with_point(
    center: Vector3,
    global_curr_center: Vector3,
    check_center: Vector3,
    radsum: f32,
    perfect_clip: bool,
    block_offset: Vector3,
) -> CollideWithPoint {
    if perfect_clip {
        // radsuma = radsum + 0.00019999999
        let radsuma = radsum + EPSILON;

        // old_disp = global_curr_center - this->center   (the TOI `disp`).
        let old_disp = global_curr_center - center;

        // offset = get_block_offset(...) + (check_pos->center - gCenter)
        //        = block_offset + (check_center - global_curr_center)   (`movement`).
        let movement = block_offset + (check_center - global_curr_center);

        // t = find_time_of_collision(movement, old_disp, radsuma).
        let t = find_time_of_collision(movement, old_disp, radsuma);

        // if ( v17 < 0.00019999999 || v17 > 1.0 ) result = 2;
        if t < EPSILON as f64 || t > 1.0 {
            return CollideWithPoint::Collided {
                collision_normal: None,
            };
        }

        let tf = t as f32;

        // offset = movement * t - movement   ( = movement * (t - 1) ); this is
        // the decomp's reuse of `offset` and the arg to add_offset_to_check_pos.
        let offset = movement * tf - movement;

        // old_disp = offset + check_pos->center - this->center.
        let old_disp = offset + check_center - center;

        // collision_normal = old_disp * (1.0 / radsuma)   (decomp divides by
        // radsuma — the padded sum — NOT the bare radsum).
        let collision_normal = old_disp * (1.0 / radsuma);

        CollideWithPoint::Adjusted {
            collision_normal,
            offset,
        }
    } else {
        // offset = global_curr_center - this->center; normalize; record it as
        // the collision normal only when it is not sub-epsilon.
        let mut offset = global_curr_center - center;
        if !normalize_check_small(&mut offset) {
            CollideWithPoint::Collided {
                collision_normal: Some(offset),
            }
        } else {
            CollideWithPoint::Collided {
                collision_normal: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    // ── non-perfect-clip branch (acclient.c:358859) ──────────────────────

    #[test]
    fn non_perfect_clip_records_normalized_offset() {
        // center=0, gCenter=(0,3,0) → offset (0,3,0) → unit (0,1,0).
        // check_center is unused on this branch. Always Collided (result 2).
        let r = collide_with_point(
            v(0.0, 0.0, 0.0),
            v(0.0, 3.0, 0.0),
            v(7.0, 7.0, 7.0),
            1.0,
            false,
            Vector3::zero(),
        );
        match r {
            CollideWithPoint::Collided {
                collision_normal: Some(n),
            } => {
                assert!(n.x.abs() < 1e-4, "n={n:?}");
                assert!((n.y - 1.0).abs() < 1e-4, "n={n:?}");
                assert!(n.z.abs() < 1e-4, "n={n:?}");
            }
            other => panic!("expected Collided+Some(normal), got {other:?}"),
        }
    }

    #[test]
    fn non_perfect_clip_degenerate_offset_records_nothing() {
        // gCenter == center → zero offset → normalize_check_small is true
        // (too small) → no normal recorded, still Collided.
        let r = collide_with_point(
            v(5.0, 5.0, 5.0),
            v(5.0, 5.0, 5.0),
            Vector3::zero(),
            1.0,
            false,
            Vector3::zero(),
        );
        assert_eq!(
            r,
            CollideWithPoint::Collided {
                collision_normal: None,
            }
        );
    }

    // ── perfect-clip branch (acclient.c:358830) ──────────────────────────

    #[test]
    fn perfect_clip_adjusts_on_valid_toi() {
        // center=0, gCenter=(-2,0,0) → old_disp (disp) = (-2,0,0).
        // check_center=(-1,0,0), block=0 → movement = (-1)-(-2) = (1,0,0).
        // find_time_of_collision((1,0,0),(-2,0,0),radsuma=1.0002):
        //   v4=1, dm=-2, v5=2, v6=4-1.0002²=2.99959996, v7=1.00040004,
        //   v8≈1.0002, v5-v8=0.9998≥0 → t≈0.9998  (∈ (EPS,1]).
        // offset = movement*t - movement = (0.9998-1,0,0) = (-0.0002,0,0).
        // old_disp = offset + check_center - center = (-1.0002,0,0).
        // collision_normal = old_disp/1.0002 = (-1,0,0).
        let r = collide_with_point(
            v(0.0, 0.0, 0.0),
            v(-2.0, 0.0, 0.0),
            v(-1.0, 0.0, 0.0),
            1.0,
            true,
            Vector3::zero(),
        );
        match r {
            CollideWithPoint::Adjusted {
                collision_normal,
                offset,
            } => {
                assert!((collision_normal.x + 1.0).abs() < 1e-4, "cn={collision_normal:?}");
                assert!(collision_normal.y.abs() < 1e-4, "cn={collision_normal:?}");
                assert!(collision_normal.z.abs() < 1e-4, "cn={collision_normal:?}");
                assert!((offset.x + 0.0002).abs() < 1e-4, "offset={offset:?}");
                assert!(offset.y.abs() < 1e-4, "offset={offset:?}");
                assert!(offset.z.abs() < 1e-4, "offset={offset:?}");
            }
            other => panic!("expected Adjusted, got {other:?}"),
        }
    }

    #[test]
    fn perfect_clip_collides_when_receding() {
        // center=0, gCenter=(3,0,0) → disp (3,0,0) (already outside, receding).
        // check_center=(4,0,0), block=0 → movement=(1,0,0).
        // find_time_of_collision((1,0,0),(3,0,0),1.0002): v4=1, dm=3, v5=-3,
        //   v6=9-1.0004=7.9996, v7=1.0004, v8≈1.0002, v5-v8<0 →
        //   t=(v8-dm)/v4 = (1.0002-3) ≈ -1.9998 < EPS → result 2, no normal.
        let r = collide_with_point(
            v(0.0, 0.0, 0.0),
            v(3.0, 0.0, 0.0),
            v(4.0, 0.0, 0.0),
            1.0,
            true,
            Vector3::zero(),
        );
        assert_eq!(
            r,
            CollideWithPoint::Collided {
                collision_normal: None,
            }
        );
    }

    #[test]
    fn perfect_clip_block_offset_flows_into_movement() {
        // Same center/gCenter/check as `perfect_clip_adjusts_on_valid_toi`
        // (movement would be (1,0,0)), but a block_offset of (-1,0,0) cancels
        // the approach: movement = block + (check - gCenter)
        //            = (-1,0,0) + ((-1,0,0) - (-2,0,0)) = (0,0,0).
        // find_time_of_collision with zero movement: v4=0 < EPS → returns -1
        // → t < EPS → result 2, no normal. Confirms block_offset feeds the TOI.
        let r = collide_with_point(
            v(0.0, 0.0, 0.0),
            v(-2.0, 0.0, 0.0),
            v(-1.0, 0.0, 0.0),
            1.0,
            true,
            v(-1.0, 0.0, 0.0),
        );
        assert_eq!(
            r,
            CollideWithPoint::Collided {
                collision_normal: None,
            }
        );
    }

    #[test]
    fn perfect_clip_oblique_adjust_2d() {
        // A 2D oblique contact. center=0, gCenter=(0,-2,0) → disp=(0,-2,0).
        // check_center=(0,-1,0), block=0 → movement=(0,1,0).
        // By symmetry with the head-on X case: t≈0.9998,
        //   offset=(0,-0.0002,0), old_disp=(0,-1.0002,0),
        //   collision_normal=(0,-1,0).
        let r = collide_with_point(
            v(0.0, 0.0, 0.0),
            v(0.0, -2.0, 0.0),
            v(0.0, -1.0, 0.0),
            1.0,
            true,
            Vector3::zero(),
        );
        match r {
            CollideWithPoint::Adjusted {
                collision_normal,
                offset,
            } => {
                assert!((collision_normal.y + 1.0).abs() < 1e-4, "cn={collision_normal:?}");
                assert!(collision_normal.x.abs() < 1e-4, "cn={collision_normal:?}");
                assert!((offset.y + 0.0002).abs() < 1e-4, "offset={offset:?}");
            }
            other => panic!("expected Adjusted, got {other:?}"),
        }
    }
}
