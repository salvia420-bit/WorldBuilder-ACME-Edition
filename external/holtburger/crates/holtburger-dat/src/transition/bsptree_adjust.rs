//! `BSPTREE::adjust_to_plane` — the perfect-clip refinement that slides a
//! swept sphere back along its motion until it no longer intersects any
//! physics polygon. Ported decomp-faithfully from `acclient.c:360916`.
//!
//! Owns:
//! - [`adjust_to_plane`] — `BSPTREE::adjust_to_plane` (acclient.c:360916)
//!
//! ## Algorithm (two stages, one shared 15-iteration budget `v6`)
//!
//! 1. **linear search** (`while (1)`): re-solve the touch fraction against the
//!    *current* hit polygon with [`super::polygon_adjust::adjust_sphere_to_poly`].
//!    - When that fraction is `1.0` — the decomp's `if (C3 | C2) break;`, i.e.
//!      `time_touch == 1.0`, the "already penetrating the hit poly's plane at
//!      the start" degenerate — the loop EXITS to stage 2 with the bracket
//!      `[0, 1]` untouched.
//!    - Otherwise move the sphere to `cur_pos + movement * time_touch` and
//!      re-query the tree with [`super::bspnode_poly::sphere_intersects_poly`].
//!      A **miss** fixes the lower bound (`ltime = time_touch`) and breaks; a
//!      **hit** tightens the upper bound (`utime = time_touch`), re-targets the
//!      hit polygon, and consumes one of the 15 iterations — exhausting them
//!      `return 0` (no separation found).
//! 2. **binary refine** (`do … while (v6 < 15)`): bisect `[ltime, utime]`,
//!    walking the sphere to the midpoint, until the bracket is narrower than
//!    `0.02` (or the shared budget runs out). The sphere is then re-placed at
//!    `ltime` and the function returns `1` (separated).
//!
//! ## Divergence from ACE (decomp wins)
//!
//! ACE `BSPTree.cs:50-85` runs the stage-1 body when `touchTime == 1.0f` and
//! `return false`s once stage 2 converges. The decomp does the **opposite** on
//! both counts: the x87 flags behind `if (v10 | v9) break;` are `C3` (equal) `|`
//! `C2` (unordered) from `fcom(time_touch, 1.0)`, so the body runs when
//! `time_touch != 1.0`; and stage 2 falls through to `result = 1` (TRUE) with
//! the sphere placed at `ltime`. Per PHASE1_SPEC ("when the decomp and ACE
//! differ, the DECOMP wins") this port follows the decomp. The decomp reading
//! is also the physically-correct one: `collide_with_pt` maps a `true` result
//! to `TransitionState::Adjusted` (the perfect-clip slide-back succeeded) and
//! `false` to `Collided`, so the normal outcome must be `true`.
//!
//! ## Why `separated = false` is effectively unreachable
//!
//! The `return 0` tail needs stage 1 to keep colliding for 15 iterations. But
//! every poly the tree can hit is gated by the front-face test
//! `dot(movement, N) < 0` ([`super::polygon_hits::pos_hits_sphere`]); for all
//! such polys, decreasing the time fraction (moving back toward `cur_pos`)
//! strictly increases the signed distance to that poly's face. So backing off
//! to the *minimum* tangent fraction clears every hittable poly at once and
//! stage 1 converges in a couple of steps — it never spends the whole budget.
//! The faithful value the driver consumes is the final (mutated) sphere center.

use super::bspnode_poly::sphere_intersects_poly;
use super::polygon_adjust::adjust_sphere_to_poly;
use crate::physics::{BspNode, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};
use std::collections::HashMap;

/// Result of [`adjust_to_plane`]: the decomp's `int` (1 = separated, the
/// normal perfect-clip outcome) plus the mutated `check_pos.center`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdjustToPlane {
    /// The decomp's return value — `true` (`result = 1`) once the bracket is
    /// refined, `false` (`return 0`) only if stage 1 exhausts its 15
    /// iterations without ever clearing the tree (unreachable in practice; see
    /// the module docs).
    pub separated: bool,
    /// `check_pos.center` after the walk (placed at `ltime` on the `true`
    /// path; left at the last colliding sample on the `false` path).
    pub final_center: Vector3,
}

/// Hard-coded retail iteration cap, shared across both stages (decomp `v6`,
/// `v6 >= 15` / `v6 < 15`).
const MAX_ITERATIONS: usize = 15;

/// `cur_pos + movement * t`, evaluated the way the decomp does it: each
/// component is `(float)((double)movement.c * t) + cur_pos.c` — the product is
/// formed in `double` (the bracket `t` is a `double`) and rounded to `f32`
/// *before* the `cur_pos` add. Mirrors the decomp's `v27 = movement.x * vNN;
/// v24 = v27 + curr_pos.x;` store pattern.
#[inline]
fn point_at(cur_pos: Vector3, movement: Vector3, t: f64) -> Vector3 {
    Vector3::new(
        (movement.x as f64 * t) as f32 + cur_pos.x,
        (movement.y as f64 * t) as f32 + cur_pos.y,
        (movement.z as f64 * t) as f32 + cur_pos.z,
    )
}

/// `BSPTREE::adjust_to_plane` (`acclient.c:360916`). `root` is the physics BSP
/// root, `check_center`/`check_radius` the swept sphere's end position and
/// radius, `cur_pos` its pre-move center, and `hit_poly` the id of the polygon
/// it first struck (the decomp's `hit_poly` in/out-param, re-targeted as the
/// tree is re-queried).
pub fn adjust_to_plane(
    root: &BspNode,
    check_center: Vector3,
    check_radius: f32,
    cur_pos: Vector3,
    hit_poly: u16,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> AdjustToPlane {
    // acclient.c:360916 — movement = check_pos.center - curr_pos; ltime = 0;
    // utime = 1; v6 = 0.
    let movement = check_center - cur_pos;
    let mut lower_time = 0.0f64; // ltime
    let mut upper_time = 1.0f64; // utime
    let mut iter: usize = 0; // v6 (shared across both stages)
    let mut center = check_center; // check_pos.center
    let mut cur_hit = hit_poly;

    // ── Stage 1: `while (1)` linear search. ──────────────────────────────
    loop {
        // v7 = CPolygon::adjust_sphere_to_poly(hit_poly, check_pos, &curr_pos,
        //                                      &movement);
        let time_touch = match polys.get(&cur_hit) {
            Some(p) => adjust_sphere_to_poly(
                p,
                &Sphere { center, radius: check_radius },
                &cur_pos,
                &movement,
            ),
            // The decomp's `hit_poly` is always a live `CPolygon*`; this guards
            // our `HashMap` lookup. 0.0 routes to the body (moves to cur_pos,
            // the known-good start) so the search still terminates cleanly.
            None => 0.0,
        };

        // Decomp: `if (v10 | v9) break;` — the x87 `C3` (equal) `| C2`
        // (unordered) flags from `fcom(time_touch, 1.0)`. True exactly when
        // time_touch == 1.0 (or NaN); the loop EXITS to stage 2 there and runs
        // the body otherwise. (ACE inverts this — see the module docs.)
        if !(time_touch < 1.0) && !(time_touch > 1.0) {
            break;
        }

        // check_pos.center = curr_pos + movement * time_touch.
        center = point_at(cur_pos, movement, time_touch);
        let sphere = Sphere { center, radius: check_radius };

        // if (!root_node->sphere_intersects_poly(check_pos, &movement,
        //                                        &hit_poly, contact_pt)) { … }
        match sphere_intersects_poly(root, &sphere, movement, polys) {
            None => {
                // Cleared the tree at this fraction — fix the lower bound.
                lower_time = time_touch; // ltime = time_touch
                break;
            }
            Some((pid, _contact)) => {
                // Still colliding — tighten the upper bound, re-target the hit
                // poly, and spend one iteration.
                iter += 1; // ++v6
                upper_time = time_touch; // utime = time_touch
                cur_hit = pid; // hit_poly updated by ref inside the query
                if iter >= MAX_ITERATIONS {
                    // `if (v6 >= 15) return 0;`
                    return AdjustToPlane { separated: false, final_center: center };
                }
            }
        }
    }

    // ── Stage 2: `do … while (v6 < 15)` binary refine. ───────────────────
    //
    // The decomp guards this with `if (v6 < 15)`, but after the stage-1 loop
    // `v6` is always < 15 (the only path to 15 is the early `return 0`), so the
    // decomp's `else { result = 0; }` is dead — stage 2 always runs.
    loop {
        // v15 = (ltime + utime) * 0.5; check_pos.center = curr_pos +
        //                                                 movement * v15;
        let average_time = (lower_time + upper_time) * 0.5;
        center = point_at(cur_pos, movement, average_time);
        let sphere = Sphere { center, radius: check_radius };

        // if (sphere_intersects_poly(...)) utime = avg; else ltime = avg;
        // (the decomp re-evaluates `(ltime + utime) * 0.5`, which equals the
        // `average_time` already computed above.)
        if sphere_intersects_poly(root, &sphere, movement, polys).is_some() {
            upper_time = average_time;
        } else {
            lower_time = average_time;
        }

        // if (utime - ltime < 0.02) break;
        if upper_time - lower_time < 0.02 {
            break;
        }
        // ++v6; while (v6 < 15)
        iter += 1;
        if iter >= MAX_ITERATIONS {
            break;
        }
    }

    // Decomp tail: re-place check_pos at `ltime` and `result = 1`.
    center = point_at(cur_pos, movement, lower_time);
    AdjustToPlane { separated: true, final_center: center }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::BspLeaf;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    // A 2×2 floor square in the z = 0 plane, normal +Z, spanning (0,0)-(2,2).
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

    fn floor_leaf() -> BspNode {
        BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere { center: v(1.0, 1.0, 0.0), radius: 10.0 }),
            poly_ids: vec![0],
        })
    }

    fn polys() -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, floor_poly());
        m
    }

    // ── Case A — `time_touch == 1.0` immediate stage-1 break. ────────────
    //
    // The sphere (r = 0.5) sweeps straight DOWN through the floor from
    // cur_pos (1,1,0.4) to check_center (1,1,-0.4); movement = (0,0,-0.8).
    // adjust_sphere_to_poly sees |dpPos| = |0.4| < r → returns 1.0, so stage 1
    // breaks at once with the bracket [0, 1]. The sphere overlaps the floor at
    // every sampled time (cur_pos itself penetrates: 0.4 < r), so the bisection
    // only ever lowers `utime`; `ltime` stays 0 and the sphere is re-placed at
    // cur_pos. Decomp returns true (Adjusted) → caller slides the object back.
    #[test]
    fn case_a_descend_through_floor_places_at_cur_pos() {
        let res = adjust_to_plane(&floor_leaf(), v(1.0, 1.0, -0.4), 0.5, v(1.0, 1.0, 0.4), 0, &polys());
        assert!(res.separated, "decomp tail returns result = 1 (true)");
        assert!((res.final_center.x - 1.0).abs() < 1e-4);
        assert!((res.final_center.y - 1.0).abs() < 1e-4);
        // ltime stays 0 → center = cur_pos + movement*0 = (1,1,0.4).
        assert!((res.final_center.z - 0.4).abs() < 1e-4, "z = {}", res.final_center.z);
    }

    // ── Case B — stage-1 finds a tangent lower bound, stage 2 bisects. ───
    //
    // cur_pos (1,1,1.0) → check_center (1,1,-1.0); movement = (0,0,-2.0),
    // r = 0.5. Stage 1 iter 0: adjust_sphere_to_poly = (0.5 - 1.0)/(-2.0)
    // = 0.25; the moved sphere sits at z = 0.5 (|dpPos| = 0.5 > r - EPS) so the
    // tree MISSES → ltime = 0.25, break. Stage 2 bisects [0.25, 1.0]; every
    // midpoint (z ≤ 0.477) still overlaps the floor, so `utime` collapses
    // toward 0.25 while `ltime` holds. Final placement: cur_pos + movement*0.25
    // → z = 1.0 - 0.5 = 0.5 (the sphere resting tangent on the floor).
    #[test]
    fn case_b_high_descent_rests_tangent() {
        let res = adjust_to_plane(&floor_leaf(), v(1.0, 1.0, -1.0), 0.5, v(1.0, 1.0, 1.0), 0, &polys());
        assert!(res.separated);
        assert!((res.final_center.x - 1.0).abs() < 1e-4);
        assert!((res.final_center.y - 1.0).abs() < 1e-4);
        assert!((res.final_center.z - 0.5).abs() < 1e-4, "z = {}", res.final_center.z);
    }

    // ── Case C — ascending: every sample is front-face-gated → `ltime` rises.
    //
    // cur_pos (1,1,-0.4) → check_center (1,1,0.4); movement = (0,0,+0.8),
    // r = 0.5. Stage 1: |dpPos| = 0.4 < r → time_touch = 1.0 → break at [0, 1].
    // In stage 2 the upward movement fails the `dot(movement,N) < 0` front-face
    // gate, so the tree MISSES at every sample → the `else` branch fires every
    // iteration and `ltime` climbs by bisection: 0.5, 0.75, …, 0.984375 (the
    // step where utime - ltime = 0.015625 < 0.02). Final z = -0.4 + 0.8 *
    // 0.984375 = 0.3875. Exercises the stage-2 `ltime = avg` path.
    #[test]
    fn case_c_ascend_raises_lower_bound() {
        let res = adjust_to_plane(&floor_leaf(), v(1.0, 1.0, 0.4), 0.5, v(1.0, 1.0, -0.4), 0, &polys());
        assert!(res.separated);
        assert!((res.final_center.x - 1.0).abs() < 1e-4);
        assert!((res.final_center.y - 1.0).abs() < 1e-4);
        assert!((res.final_center.z - 0.3875).abs() < 1e-4, "z = {}", res.final_center.z);
    }

    // ── Case D — the final center always lies on the swept segment. ──────
    #[test]
    fn case_d_final_center_stays_on_segment() {
        let cur = v(1.0, 1.0, 1.0);
        let end = v(1.0, 1.0, -1.0);
        let res = adjust_to_plane(&floor_leaf(), end, 0.5, cur, 0, &polys());
        // x/y are constant along this vertical sweep; z is bracketed by the
        // endpoints (the bracket time stays within [0, 1]).
        assert!((res.final_center.x - 1.0).abs() < 1e-4);
        assert!((res.final_center.y - 1.0).abs() < 1e-4);
        assert!(res.final_center.z >= -1.0 - 1e-4 && res.final_center.z <= 1.0 + 1e-4);
    }
}
