//! `CSphere::step_sphere_up` / `step_sphere_down` — the vertical-step
//! collision responses. After a swept sphere is found obstructed, the
//! transition tries to either *climb* a low-enough lip (`step_sphere_up`)
//! or *settle down* onto a walkable surface within the step-down budget
//! (`step_sphere_down`). Ported decomp-faithfully from `acclient.c`,
//! cross-checked against ACE `Sphere.cs` (a straight translation).
//!
//! Owns:
//! - [`step_sphere_up`]   — `CSphere::step_sphere_up`   (acclient.c:359072)
//! - [`step_sphere_down`] — `CSphere::step_sphere_down` (acclient.c:358616)
//!
//! Both leaf fns stay PURE — they compute the branch decision plus all the
//! data the Phase-3 driver needs to apply, rather than mutating
//! `SPHEREPATH`/`COLLISIONINFO` themselves:
//! - `step_sphere_up` returns whether to `slide_sphere` (with the exact
//!   `radsum + EPSILON` the decomp passes) or `step_up` (with the computed
//!   collision normal); the driver runs the chosen sibling routine.
//! - `step_sphere_down` returns the modified displacement (the resting
//!   normal), the water rest plane, the check-pos offset, and the new
//!   `walk_interp` for the driver to commit via `set_contact_plane` /
//!   `add_offset_to_check_pos`.

use super::types::EPSILON;
use holtburger_common::{Plane, Sphere, Vector3};

/// `CSphere::collides_with_sphere` (`acclient.c:358509`). The idb renders the
/// body as a bare `return v5 == 0;` — the FPU compare flag (`c0`) that drove
/// the result was lost in decompilation. ACE recovers the intent
/// (`Sphere.cs:215`, `CollidesWithSphere`): two spheres whose centers are
/// `disp` apart collide when `|disp|² ≤ radsum²` (exact touch counts here,
/// unlike `Sphere::intersects`, which uses strict `<`). The `step_sphere_*`
/// gates are the inline form of this same `radsum² < |disp|²` test.
#[inline]
fn collides_with_sphere(disp: Vector3, radsum: f32) -> bool {
    disp.length_squared() <= radsum * radsum
}

/// Branch decision returned by [`step_sphere_up`] (`acclient.c:359072`).
///
/// The decomp itself *calls* the chosen driver routine and returns its
/// `TransitionState`; the leaf layer hands the decision back so the Phase-3
/// driver can invoke the sibling routine with the live path/collision state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StepSphereUp {
    /// `object_info.step_up_height < (radsum + EPSILON) − disp.z`: the lip is
    /// too tall to step over → the driver runs
    /// `slide_sphere(disp, radsum, sphere 0)`. The `radsum` field is the
    /// decomp's `radsuma` — i.e. `radsum + EPSILON` already folded in, exactly
    /// the value passed to `slide_sphere`.
    Slide { radsum: f32 },
    /// Low enough to climb → the driver runs `step_up(collision_normal)`; on
    /// failure it falls back to `step_up_slide`. `collision_normal` is
    /// `global_curr_center[0] − center` (NOT normalized — `step_up`/the
    /// driver normalize as needed).
    StepUp { collision_normal: Vector3 },
}

/// `CSphere::step_sphere_up` (`acclient.c:359072`).
///
/// `sphere` is the moving sphere (`this`); `global_curr_center` is
/// `path.global_curr_center[0].center`; `disp` is the incoming displacement
/// (only its `z` gates the decision); `step_up_height` is
/// `object_info.step_up_height`. The threshold uses `radsum + EPSILON`
/// exactly as the decomp's `v5`.
pub fn step_sphere_up(
    sphere: Sphere,
    global_curr_center: Vector3,
    disp: Vector3,
    step_up_height: f32,
    radsum: f32,
) -> StepSphereUp {
    // acclient.c:359072
    let radsuma = radsum + EPSILON; // decomp v5 = radsum + 0.00019999999
    if step_up_height < radsuma - disp.z {
        StepSphereUp::Slide { radsum: radsuma }
    } else {
        StepSphereUp::StepUp {
            collision_normal: global_curr_center - sphere.center,
        }
    }
}

/// Result of [`step_sphere_down`], mirroring the decomp's `1`/`2`/`3` returns
/// (= [`TransitionState::Ok`]/`Collided`/`Adjusted`).
///
/// [`TransitionState::Ok`]: super::types::TransitionState::Ok
#[derive(Debug, Clone, PartialEq)]
pub enum StepSphereDown {
    /// Decomp `1` (`TransitionState::OK`). Either the sphere(s) never reach
    /// the surface, or the resting normal is below the walkable allowance —
    /// there is nothing to step down onto.
    Ok,
    /// Decomp `2` (`TransitionState::Collided`). The step-down budget is
    /// effectively zero, or the solved interpolation falls outside the
    /// `[−0.1·walk_interp .. walk_interp)` window — blocked.
    Collided,
    /// Decomp `3` (`TransitionState::Adjusted`). The sphere settles onto
    /// `contact_plane`. The driver records the contact plane as **water**
    /// (the decomp passes `is_water = 1` to `set_contact_plane`), copies
    /// `path.check_pos.objcell_id` into `collisions.contact_plane_cell_id`,
    /// sets `path.walk_interp = new_walk_interp`, and adds `offset` to the
    /// check position via `add_offset_to_check_pos`.
    Adjusted {
        /// The decomp's in-place-modified `disp`:
        /// `(disp.x, disp.y, disp.z + interp) / (radsum + EPSILON)`. This is a
        /// unit vector (the foot point lies exactly `radsum + EPSILON` away),
        /// and doubles as `contact_plane.normal`.
        new_disp: Vector3,
        /// The resting plane: normal `new_disp` through the foot point
        /// `center + radius·new_disp`. Recorded with `is_water = true`.
        contact_plane: Plane,
        /// `(0, 0, interp)` — added to the check position; `interp` is the
        /// vertical settle distance `step_down · scaled_step`.
        offset: Vector3,
        /// The decomp's `timechecka` — the new `path.walk_interp`.
        new_walk_interp: f32,
    },
}

/// `CSphere::step_sphere_down` (`acclient.c:358616`).
///
/// `sphere` is the moving sphere (`this`, supplying `center` + `radius`).
/// `disp` is `global_sphere[0].center − center`; `disp2` is
/// `global_sphere[1].center − center` when `path.num_sphere > 1` (else
/// `None`). `radsum`, `step_down_amt`, `walk_interp`, and `walkable_allowance`
/// come straight off the path/object state.
///
/// Faithfulness notes:
/// - The first gate is the inline `radsum² < |disp|²` (= `!collides_with_sphere`);
///   note it uses `radsum`, NOT `radsum + EPSILON`.
/// - When the first sphere clears but a second sphere exists and is still
///   within `radsum`, the routine continues — and the settle math below uses
///   the ORIGINAL `disp` (the first sphere), never `disp2`. `disp2` only gates
///   the early-out, exactly as the decomp.
/// - `val` is computed via an `f64` `sqrt` and the `(val − disp.z)` cast back
///   to `f32` before the divide, matching the decomp's double-precision
///   `sqrt`/`ACE`'s `(float)(val - disp.Z) / stepDown`.
#[allow(clippy::too_many_arguments)]
pub fn step_sphere_down(
    sphere: Sphere,
    disp: Vector3,
    disp2: Option<Vector3>,
    radsum: f32,
    step_down_amt: f32,
    walk_interp: f32,
    walkable_allowance: f32,
) -> StepSphereDown {
    // acclient.c:358616

    // Gate: `radsum² < |disp|²` → first sphere is clear of the surface.
    if !collides_with_sphere(disp, radsum) {
        // `path.num_sphere <= 1` (no second sphere) → nothing below → OK.
        match disp2 {
            None => return StepSphereDown::Ok,
            // Second sphere also clear → OK. Otherwise fall through and
            // settle using the (still original) first-sphere `disp`.
            Some(d2) => {
                if !collides_with_sphere(d2, radsum) {
                    return StepSphereDown::Ok;
                }
            }
        }
    }

    let step_down = step_down_amt * walk_interp; // decomp v11
    if step_down.abs() < EPSILON {
        return StepSphereDown::Collided;
    }

    let radsuma = radsum + EPSILON; // decomp v12 / pathz
    // val = sqrt(radsuma² − (disp.x² + disp.y²)): the sphere's z-reach at the
    // in-plane offset. sqrt in f64 to mirror the decomp's double-precision.
    let inplane = disp.x * disp.x + disp.y * disp.y;
    let val = ((radsuma * radsuma - inplane) as f64).sqrt();
    let scaled_step = (val - disp.z as f64) as f32 / step_down; // decomp v13
    let timecheck = (1.0 - scaled_step) * walk_interp; // decomp v14 / timechecka
    if timecheck >= walk_interp || timecheck < -0.1 {
        return StepSphereDown::Collided;
    }

    let interp = step_down * scaled_step; // decomp dispb
    let inv = 1.0 / radsuma; // decomp v16
    // disp ← (disp.x, disp.y, disp.z + interp) / radsuma  (the rest normal).
    let new_disp = Vector3::new(disp.x * inv, disp.y * inv, (disp.z + interp) * inv);

    if new_disp.z <= walkable_allowance {
        return StepSphereDown::Ok;
    }

    // rest_plane = Plane(normal = new_disp, point = center + radius·new_disp).
    // Plane::Plane stores N = normal, d = −(point · N)  (acclient.c:358519).
    let foot = new_disp * sphere.radius + sphere.center;
    let contact_plane = Plane {
        normal: new_disp,
        d: -new_disp.dot(&foot),
    };
    let offset = Vector3::new(0.0, 0.0, interp);

    StepSphereDown::Adjusted {
        new_disp,
        contact_plane,
        offset,
        new_walk_interp: timecheck,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    fn sph(center: Vector3, radius: f32) -> Sphere {
        Sphere { center, radius }
    }

    // ── step_sphere_up ───────────────────────────────────────────────────

    #[test]
    fn step_up_too_tall_slides() {
        // radsuma = 1 + EPS ≈ 1.0002. threshold = 1.0002 − 0 = 1.0002.
        // step_up_height 0.1 < 1.0002 → Slide, carrying radsuma.
        let r = step_sphere_up(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, 1.0), v(0.0, 0.0, 0.0), 0.1, 1.0);
        match r {
            StepSphereUp::Slide { radsum } => assert!((radsum - 1.0002).abs() < 1e-4, "radsum={radsum}"),
            other => panic!("expected Slide, got {other:?}"),
        }
    }

    #[test]
    fn step_up_slide_threshold_uses_disp_z() {
        // disp.z = −0.5 → threshold = 1.0002 − (−0.5) = 1.5002.
        // step_up_height 0.2 < 1.5002 → Slide{radsum ≈ 1.0002}.
        let r = step_sphere_up(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, 1.0), v(0.0, 0.0, -0.5), 0.2, 1.0);
        match r {
            StepSphereUp::Slide { radsum } => assert!((radsum - 1.0002).abs() < 1e-4, "radsum={radsum}"),
            other => panic!("expected Slide, got {other:?}"),
        }
    }

    #[test]
    fn step_up_low_enough_steps() {
        // threshold = 1.0002 − 0.5 = 0.5002. step_up_height 2.0 < 0.5002? no
        // → StepUp. collision_normal = global_curr_center − center = (0,0,1).
        let r = step_sphere_up(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, 1.0), v(0.0, 0.0, 0.5), 2.0, 1.0);
        assert_eq!(r, StepSphereUp::StepUp { collision_normal: v(0.0, 0.0, 1.0) });
    }

    #[test]
    fn step_up_offset_center_normal() {
        // center (1,2,3), global_curr (1,2,4.5): threshold = 0.5002 − 0.4
        // = 0.1002; step_up_height 1.0 < 0.1002? no → StepUp.
        // collision_normal = (1,2,4.5) − (1,2,3) = (0,0,1.5).
        let r = step_sphere_up(sph(v(1.0, 2.0, 3.0), 0.5), v(1.0, 2.0, 4.5), v(0.0, 0.0, 0.4), 1.0, 0.5);
        assert_eq!(r, StepSphereUp::StepUp { collision_normal: v(0.0, 0.0, 1.5) });
    }

    // ── step_sphere_down ─────────────────────────────────────────────────

    #[test]
    fn step_down_early_out_single_ok() {
        // disp 5 units away, radsum 1 → |disp|²=25 > 1, single sphere → OK.
        let r = step_sphere_down(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, 5.0), None, 1.0, 1.0, 1.0, 0.0872);
        assert_eq!(r, StepSphereDown::Ok);
    }

    #[test]
    fn step_down_early_out_second_sphere_clear_ok() {
        // First sphere clears (5 away) AND second clears (3 away) → OK.
        let r = step_sphere_down(
            sph(v(0.0, 0.0, 0.0), 0.5),
            v(0.0, 0.0, 5.0),
            Some(v(0.0, 0.0, 3.0)),
            1.0,
            1.0,
            1.0,
            0.0872,
        );
        assert_eq!(r, StepSphereDown::Ok);
    }

    #[test]
    fn step_down_second_sphere_within_settles_with_first_disp() {
        // First sphere clears (5 away) but second is within radsum (0.3 away),
        // so the early-out does NOT fire — and the math runs on the ORIGINAL
        // disp (0,0,5): val=1.0002, scaled_step=(1.0002−5)/1=−3.9998,
        // timecheck=(1−(−3.9998))·1=4.9998 ≥ walk_interp(1) → Collided.
        let r = step_sphere_down(
            sph(v(0.0, 0.0, 0.0), 0.5),
            v(0.0, 0.0, 5.0),
            Some(v(0.0, 0.0, 0.3)),
            1.0,
            1.0,
            1.0,
            0.0872,
        );
        assert_eq!(r, StepSphereDown::Collided);
    }

    #[test]
    fn step_down_zero_budget_blocks() {
        // step_down = step_down_amt(0) · walk_interp = 0 → |0| < EPS → Collided.
        let r = step_sphere_down(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, 0.5), None, 1.0, 0.0, 1.0, 0.0872);
        assert_eq!(r, StepSphereDown::Collided);
    }

    #[test]
    fn step_down_below_window_blocks() {
        // disp.z = −0.5, step_down = 0.3·1 = 0.3, radsuma = 1.0002, val = 1.0002.
        // scaled_step = (1.0002 − (−0.5))/0.3 = 1.5002/0.3 ≈ 5.0007;
        // timecheck = (1 − 5.0007)·1 ≈ −4.0007 < −0.1 → Collided.
        let r = step_sphere_down(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, -0.5), None, 1.0, 0.3, 1.0, 0.0872);
        assert_eq!(r, StepSphereDown::Collided);
    }

    #[test]
    fn step_down_rest_normal_below_walkable_ok() {
        // disp=(0.99,0,0.05): in-plane large → shallow rest normal.
        // val=sqrt(1.0004−0.9801)=sqrt(0.0203)≈0.14248; interp=val−0.05≈0.09248;
        // new_disp.z=(0.05+0.09248)/1.0002≈0.14245 ≤ allowance(0.2) → OK.
        let r = step_sphere_down(sph(v(0.0, 0.0, 0.0), 0.5), v(0.99, 0.0, 0.05), None, 1.0, 1.0, 1.0, 0.2);
        assert_eq!(r, StepSphereDown::Ok);
    }

    #[test]
    fn step_down_settles_onto_flat_surface() {
        // disp=(0,0,0.5), radsum=1, step_down_amt=1, walk_interp=1, radius=0.5.
        // radsuma≈1.0002, val≈1.0002, scaled_step≈0.5002, timecheck≈0.4998,
        // interp≈0.5002, new_disp.z=(0.5+0.5002)/1.0002=1.0 (> allowance).
        // foot = center + radius·new_disp = (0,0,0.5) → d = −radius = −0.5.
        let r = step_sphere_down(sph(v(0.0, 0.0, 0.0), 0.5), v(0.0, 0.0, 0.5), None, 1.0, 1.0, 1.0, 0.0872);
        match r {
            StepSphereDown::Adjusted { new_disp, contact_plane, offset, new_walk_interp } => {
                assert!((new_disp.x).abs() < 1e-4, "new_disp={new_disp:?}");
                assert!((new_disp.z - 1.0).abs() < 1e-4, "new_disp={new_disp:?}");
                assert!((contact_plane.normal.z - 1.0).abs() < 1e-4);
                assert!((contact_plane.d - (-0.5)).abs() < 1e-4, "d={}", contact_plane.d);
                assert!(offset.x.abs() < 1e-4 && offset.y.abs() < 1e-4);
                assert!((offset.z - 0.5002).abs() < 1e-4, "offset={offset:?}");
                assert!((new_walk_interp - 0.4998).abs() < 1e-4, "wi={new_walk_interp}");
            }
            other => panic!("expected Adjusted, got {other:?}"),
        }
    }

    #[test]
    fn step_down_settles_with_in_plane_offset() {
        // disp=(0.6,0,0.6), radsum=1, step_down_amt=2, walk_interp=0.5, radius=1.
        // step_down=1; radsuma≈1.0002; val=sqrt(1.0004−0.36)=sqrt(0.6404)≈0.80025;
        // scaled_step=(0.80025−0.6)/1=0.20025; timecheck=(1−0.20025)·0.5≈0.39988;
        // interp=0.20025; new_disp=(0.59988,0,0.80009) (unit); d=−radius=−1.0.
        let r = step_sphere_down(sph(v(0.0, 0.0, 0.0), 1.0), v(0.6, 0.0, 0.6), None, 1.0, 2.0, 0.5, 0.0872);
        match r {
            StepSphereDown::Adjusted { new_disp, contact_plane, offset, new_walk_interp } => {
                assert!((new_disp.x - 0.59988).abs() < 1e-4, "new_disp={new_disp:?}");
                assert!((new_disp.z - 0.80009).abs() < 1e-4, "new_disp={new_disp:?}");
                // |new_disp| == 1 exactly (foot lies radsuma away) ⇒ unit normal.
                assert!((new_disp.length_squared() - 1.0).abs() < 1e-4);
                assert!((contact_plane.d - (-1.0)).abs() < 1e-4, "d={}", contact_plane.d);
                assert!((offset.z - 0.20025).abs() < 1e-4, "offset={offset:?}");
                assert!((new_walk_interp - 0.39988).abs() < 1e-4, "wi={new_walk_interp}");
            }
            other => panic!("expected Adjusted, got {other:?}"),
        }
    }
}
