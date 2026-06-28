//! `CSphere::slide_sphere` — the retail CLIENT's 5-case sliding response that
//! redirects a blocked sphere along its contact plane. Ported
//! decomp-faithfully from `acclient.c:358899` (`sub_00537440`).
//!
//! Owns:
//! - [`slide_sphere`] — `CSphere::slide_sphere` (acclient.c:358899)
//!
//! ## What the decomp does
//! With `gDelta = blockOffset + (center − currPos)` (the "where the sphere
//! travelled, in the check cell's space") and `N` = the resting contact-plane
//! normal (`contact_plane` if valid, else `last_known_contact_plane`), the
//! method computes `direction = collisionNormal × N` (the contact *edge*) and
//! branches into five cases:
//!
//! 1. `collisionNormal == 0` → no usable normal: nudge the check position
//!    halfway back toward `currPos` (`offset = (currPos − center)·0.5`) and
//!    return **3** (CONTACT / [`SlideSphere::Adjusted`]). This is the ONLY
//!    case that does NOT first call `set_collision_normal`.
//! 2. `|direction|² ≥ ε` but the projected slide collapses (`|P|² < ε`) →
//!    return **2** (BLOCKED / [`SlideSphere::Collided`]).
//! 3. `|direction|² ≥ ε` → slide along the contact edge:
//!    `offset = project(gDelta onto direction) − gDelta`, return **4**
//!    (SLID / [`SlideSphere::Slid`]).
//! 4. `|direction|² < ε` and `dot(collisionNormal, N) ≥ 0` → the edge is
//!    degenerate (normal ∥ plane); slide straight back along the normal:
//!    `offset = −collisionNormal·(gDelta·collisionNormal)`, return **4**.
//! 5. otherwise → record `normalize(−gDelta)` as the new collision normal and
//!    return **2**.
//!
//! ## Pure-leaf shape (no `SPHEREPATH`/`COLLISIONINFO` mutation)
//! The decomp's side effects are surfaced through the return value so the
//! Phase-3 driver can replay them against real state:
//! - The computed `offset` (the `add_offset_to_check_pos` argument) rides on
//!   [`SlideSphere::Adjusted`]/[`SlideSphere::Slid`]; the driver applies
//!   `SPHEREPATH::add_offset_to_check_pos(offset, this->radius)`.
//! - For EVERY non-`Adjusted` result the decomp first calls
//!   `COLLISIONINFO::set_collision_normal(collisionNormal)` unconditionally
//!   (top of the non-zero-normal path). The driver replays that with the same
//!   `collision_normal` it passed in whenever the result is `Slid` or
//!   `Collided`.
//! - Case 5 additionally records `normalize(−gDelta)` — surfaced as
//!   [`SlideSphere::Collided`]`{ recomputed_normal: Some(..) }`, which the
//!   driver feeds to a SECOND `set_collision_normal`. When `−gDelta` is too
//!   small to normalize the decomp skips that second call, so
//!   `recomputed_normal` is `None` (matching case 2's `None`).
//!
//! ## DECOMP vs. ACE
//! Case 5 returns the decomp's `2` ([`super::types::TransitionState::Collided`]);
//! ACE's `Sphere.SlideSphere` returns `OK` on that tail. Per the Phase-1
//! "decomp wins" ruling this port returns `Collided`.

use super::types::{normalize_check_small, EPSILON};
use holtburger_common::Vector3;

/// Outcome of [`slide_sphere`], mirroring the decomp's `2`/`3`/`4` returns.
///
/// The driver maps these to [`super::types::TransitionState`] and replays the
/// recorded side effects (see the module docs):
/// `Adjusted → Adjusted(3)`, `Slid → Slid(4)`, `Collided → Collided(2)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SlideSphere {
    /// Decomp `3` (CONTACT). The collision normal was zero; nudge the check
    /// position by `offset` (= `(curr_pos − center)·0.5`). No
    /// `set_collision_normal` is replayed for this case.
    Adjusted { offset: Vector3 },
    /// Decomp `4` (SLID). Apply `add_offset_to_check_pos(offset, radius)`.
    /// The driver replays `set_collision_normal(input_normal)` first.
    Slid { offset: Vector3 },
    /// Decomp `2` (BLOCKED). The driver replays
    /// `set_collision_normal(input_normal)` first; then, when
    /// `recomputed_normal` is `Some(n)` (case 5, non-degenerate `−gDelta`),
    /// a second `set_collision_normal(n)`. `None` covers case 2 and the
    /// degenerate tail of case 5.
    Collided { recomputed_normal: Option<Vector3> },
}

/// `CSphere::slide_sphere` (`acclient.c:358899`, `sub_00537440`).
///
/// Pure leaf form of the retail method. The caller resolves the decomp's
/// implicit inputs up front:
/// - `center`   — `this->center`, the sphere's global center this step.
/// - `collision_normal` — the blocking normal handed in (the decomp mutates
///   this argument in case 5; here that mutation surfaces as
///   [`SlideSphere::Collided`]`{ recomputed_normal }`).
/// - `curr_pos` — the sphere's previous accepted global center.
/// - `contact_plane_normal` — `N`: `collisions->contact_plane.normal` when
///   `contact_plane_valid`, else `collisions->last_known_contact_plane.normal`.
/// - `block_offset` — `LandDefs::get_block_offset(path->curr_pos.objcell_id,
///   path->check_pos.objcell_id)`, the landblock delta between cells.
///
/// (`this->radius` is omitted: it is only consumed by
/// `add_offset_to_check_pos`, which the driver replays on the returned offset.)
pub fn slide_sphere(
    center: Vector3,
    collision_normal: Vector3,
    curr_pos: Vector3,
    contact_plane_normal: Vector3,
    block_offset: Vector3,
) -> SlideSphere {
    // ── Case 1: zero collision normal — split the remaining gap in half. ──
    // acclient.c:358921-358934 — direction = (curr_pos − center) * 0.5;
    //   add_offset_to_check_pos(direction, radius); return 3;
    // Exact per-component float compare, mirroring the decomp predicate.
    if collision_normal.x == 0.0 && collision_normal.y == 0.0 && collision_normal.z == 0.0 {
        return SlideSphere::Adjusted {
            offset: (curr_pos - center) * 0.5,
        };
    }

    // acclient.c:358936 — set_collision_normal(collision_normal) (replayed by
    // the driver for every Slid/Collided result below).
    //
    // gDelta = block_offset + (center − curr_pos).
    // acclient.c:358938-358950 (v23/v24/v25 = offset.* + (center.* − curr.*)).
    let g_delta = block_offset + (center - curr_pos);
    let n = contact_plane_normal;

    // direction = collision_normal × N (the contact edge).
    // acclient.c:358951-358956 — note the cross is collisionNormal × N, NOT
    // N × collisionNormal; `cross` here matches the decomp's component order.
    let direction = collision_normal.cross(&n);
    let dir_len_sq = direction.length_squared(); // acclient.c:358957 (patha)

    if dir_len_sq >= EPSILON {
        // Project gDelta onto the edge: P = direction·(direction·gDelta)/|dir|².
        // acclient.c:358960-358973.
        let along = direction.dot(&g_delta); // v19
        let inv = 1.0 / dir_len_sq; // v20
        let p = direction * (along * inv);

        // ── Case 2: the projected slide collapses → blocked. ──
        // acclient.c:358974 — if |P|² < ε return 2.
        if p.length_squared() < EPSILON {
            return SlideSphere::Collided {
                recomputed_normal: None,
            };
        }

        // ── Case 3: slide along the contact edge. ──
        // acclient.c:358976-358981 — offset = P − gDelta;
        //   add_offset_to_check_pos(offset, radius); return 4.
        return SlideSphere::Slid {
            offset: p - g_delta,
        };
    }

    // ── Case 4: edge degenerate (normal ∥ plane) but normal faces the
    // plane → slide straight back along the normal. ──
    // acclient.c:358984-359002 — if dot(collisionNormal, N) ≥ 0:
    //   amt = gDelta·collisionNormal;
    //   offset = −collisionNormal·amt; add_offset_to_check_pos; return 4.
    if collision_normal.dot(&n) >= 0.0 {
        let amt = g_delta.dot(&collision_normal); // pathb
        return SlideSphere::Slid {
            offset: collision_normal * (-amt),
        };
    }

    // ── Case 5: nothing slides — record normalize(−gDelta) and block. ──
    // acclient.c:359003-359010 — collision_normal = −gDelta;
    //   if (!normalize_check_small(collision_normal))
    //       set_collision_normal(collision_normal);
    //   return 2.
    let mut recomputed = g_delta * -1.0;
    let recomputed_normal = if normalize_check_small(&mut recomputed) {
        // "too small to normalize" — decomp skips the second set_collision_normal.
        None
    } else {
        Some(recomputed)
    };
    SlideSphere::Collided { recomputed_normal }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < 1e-4 && (a.y - b.y).abs() < 1e-4 && (a.z - b.z).abs() < 1e-4
    }

    // ── Case 1 ──────────────────────────────────────────────────────────────
    // collision_normal == 0 → offset = (curr_pos − center) * 0.5.
    // center=(0,0,0), curr_pos=(4,2,0) → offset = (2,1,0).
    #[test]
    fn case1_zero_normal_halves_the_gap() {
        let r = slide_sphere(
            v(0.0, 0.0, 0.0),
            Vector3::zero(),
            v(4.0, 2.0, 0.0),
            v(0.0, 0.0, 1.0),
            Vector3::zero(),
        );
        match r {
            SlideSphere::Adjusted { offset } => assert!(approx(offset, v(2.0, 1.0, 0.0))),
            other => panic!("expected Adjusted, got {other:?}"),
        }
    }

    // ── Case 2 ──────────────────────────────────────────────────────────────
    // collision_normal=(1,0,0), N=(0,1,0) → direction=(0,0,1), |dir|²=1 ≥ ε.
    // center=(0,0,0), curr_pos=(0,-1,0) → gDelta = center−curr = (0,1,0),
    // which is ⟂ to direction → along=0 → P=0 → |P|²=0 < ε → Collided{None}.
    #[test]
    fn case2_degenerate_slide_blocks() {
        let r = slide_sphere(
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(0.0, -1.0, 0.0),
            v(0.0, 1.0, 0.0),
            Vector3::zero(),
        );
        assert_eq!(
            r,
            SlideSphere::Collided {
                recomputed_normal: None
            }
        );
    }

    // ── Case 3 (with a non-zero block_offset, exercising gDelta) ─────────────
    // collision_normal=(1,0,0), N=(0,1,0) → direction=(1,0,0)×(0,1,0)=(0,0,1).
    // center=(1,2,3), curr_pos=(0,0,0), block_offset=(10,0,0):
    //   gDelta = (10,0,0) + (1,2,3) = (11,2,3).
    // along = direction·gDelta = 3; inv = 1/1 = 1; P = (0,0,3).
    // |P|²=9 ≥ ε → offset = P − gDelta = (0−11, 0−2, 3−3) = (−11,−2,0).
    #[test]
    fn case3_slides_along_edge_with_block_offset() {
        let r = slide_sphere(
            v(1.0, 2.0, 3.0),
            v(1.0, 0.0, 0.0),
            v(0.0, 0.0, 0.0),
            v(0.0, 1.0, 0.0),
            v(10.0, 0.0, 0.0),
        );
        match r {
            SlideSphere::Slid { offset } => assert!(approx(offset, v(-11.0, -2.0, 0.0))),
            other => panic!("expected Slid, got {other:?}"),
        }
    }

    // ── Case 4 ──────────────────────────────────────────────────────────────
    // collision_normal == N = (0,0,1) → direction ≈ 0 (|dir|² = 0 < ε) and
    // dot(collisionNormal, N) = 1 ≥ 0 → straight-back slide.
    // center=(0,0,5), curr_pos=(0,0,0), block_offset=(0,0,2):
    //   gDelta = (0,0,2)+(0,0,5) = (0,0,7); amt = gDelta·cN = 7;
    //   offset = −cN·7 = (0,0,−7).
    #[test]
    fn case4_slides_straight_back_along_normal() {
        let r = slide_sphere(
            v(0.0, 0.0, 5.0),
            v(0.0, 0.0, 1.0),
            v(0.0, 0.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(0.0, 0.0, 2.0),
        );
        match r {
            SlideSphere::Slid { offset } => assert!(approx(offset, v(0.0, 0.0, -7.0))),
            other => panic!("expected Slid, got {other:?}"),
        }
    }

    // ── Case 5 ──────────────────────────────────────────────────────────────
    // collision_normal=(0,0,1), N=(0,0,−1) → direction ≈ 0 (|dir|²=0 < ε) and
    // dot(collisionNormal, N) = −1 < 0 → record normalize(−gDelta), block.
    // center=(0,0,0), curr_pos=(0,0,−3) → gDelta = center−curr = (0,0,3);
    //   −gDelta = (0,0,−3) → normalized = (0,0,−1).
    #[test]
    fn case5_blocks_and_records_normalized_neg_gdelta() {
        let r = slide_sphere(
            v(0.0, 0.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(0.0, 0.0, -3.0),
            v(0.0, 0.0, -1.0),
            Vector3::zero(),
        );
        match r {
            SlideSphere::Collided {
                recomputed_normal: Some(n),
            } => assert!(approx(n, v(0.0, 0.0, -1.0)), "n={n:?}"),
            other => panic!("expected Collided+normal, got {other:?}"),
        }
    }

    // ── Case 5 degenerate tail ──────────────────────────────────────────────
    // direction ≈ 0, dot < 0, but gDelta ≈ 0 → −gDelta too small to normalize
    // → recomputed_normal = None (decomp skips the second set_collision_normal).
    // center == curr_pos == 0, block_offset 0 → gDelta = 0.
    #[test]
    fn case5_tiny_gdelta_yields_no_recomputed_normal() {
        let r = slide_sphere(
            v(0.0, 0.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(0.0, 0.0, 0.0),
            v(0.0, 0.0, -1.0),
            Vector3::zero(),
        );
        assert_eq!(
            r,
            SlideSphere::Collided {
                recomputed_normal: None
            }
        );
    }
}
