//! `CSphere` basics — the sphere/sphere overlap predicate and the quadratic
//! swept-sphere time-of-impact (TOI) solver. Decomp-faithful ports of:
//!
//! - [`intersects`]             — `CSphere::intersects`             (acclient.c:356341)
//! - [`find_time_of_collision`] — `CSphere::find_time_of_collision` (acclient.c:358481)
//!
//! These are the two leaf primitives the swept-sphere predicates
//! (`collide_with_point`, `slide_sphere`, `step_sphere_*`, …) build on:
//! `intersects` answers "do these two spheres overlap right now?" and
//! `find_time_of_collision` answers "how far along a straight movement does a
//! moving sphere first touch a stationary one?".
//!
//! Geometry comes from `holtburger_common`; the retail collision epsilon
//! (the decomp spells it `0.00019999999`, i.e. the `f32` literal `0.0002`
//! widened to `double`) is centralized in [`super::types::EPSILON`], equal to
//! `crate::physics::PHYSICS_EPSILON`.

use super::types::EPSILON;
use holtburger_common::{Sphere, Vector3};

/// `CSphere::intersects` — `true` iff two spheres overlap.
///
/// acclient.c:356341
///
/// The IDA decomp of this `__thiscall` is one of the FPU-flag wrecks: it
/// recovers the center deltas and the radius sum but drops the
/// squared-distance accumulation and the `fcom` itself, leaving only the bare
/// x87 condition-code bytes:
///
/// ```text
/// v2 = this->center.x - s->center.x;   // delta.x
/// v3 = this->center.y - s->center.y;   // delta.y
/// v4 = this->center.z - s->center.z;   // delta.z
/// v5 = s->radius + this->radius;       // radsum
/// return (v7 | v8) != 0;               // v7 = C0, v8 = C2
/// ```
///
/// `v7`/`v8` are the x87 `C0`/`C2` condition codes left by an `fcom` of the
/// squared distance against the squared radius sum. After `fcom ST(0),ST(1)`
/// the flags encode the order of `ST(0)` vs `ST(1)`:
///
/// ```text
///   ST(0) > ST(1):  C3 C2 C0 = 0 0 0
///   ST(0) < ST(1):  C3 C2 C0 = 0 0 1   → C0 set
///   ST(0) = ST(1):  C3 C2 C0 = 1 0 0
///   unordered    :  C3 C2 C0 = 1 1 1   → C2 set
/// ```
///
/// So `(C0 | C2) != 0` is exactly "`ST(0) < ST(1)` or unordered". With the
/// distance² in `ST(0)` and `radsum²` in `ST(1)`, the reconstructed predicate
/// is the strict overlap test `distSq < radsum²` (an exact graze, `distSq ==
/// radsum²`, is NOT an intersection). Confirmed against ACE's faithful
/// translation `Sphere.Intersects` (Sphere.cs:254), which is likewise
/// `delta.LengthSquared() < radSum * radSum`.
///
/// Distinct from `holtburger_common::Sphere::intersects`, which is the
/// sphere-vs-(point,radius) form; this is the sphere-vs-sphere form the
/// retail predicate uses.
pub fn intersects(this: &Sphere, s: &Sphere) -> bool {
    // v2,v3,v4 = this->center - s->center ; v5 = s->radius + this->radius.
    let delta = this.center - s.center;
    let radsum = s.radius + this.radius;
    delta.length_squared() < radsum * radsum
}

/// `CSphere::find_time_of_collision` — the fraction `t` along `movement` at
/// which a sphere starting at relative displacement `disp` from a stationary
/// sphere of combined radius `radsum` first reaches contact, or `-1.0` if it
/// never does.
///
/// acclient.c:358481
///
/// Geometrically this solves `‖disp + t·movement‖² = radsum²`, the quadratic
///
/// ```text
///   v4·t² − 2·v5·t + v6 = 0
/// ```
///
/// with the decomp's temporaries
///
/// ```text
///   v4 = movement·movement             (= ‖movement‖²)
///   v5 = −(disp·movement)              (negated dot)
///   v6 = disp·disp − radsum²           (signed gap; <0 ⇒ already overlapping)
///   v7 = v5² − v6·v4                   (discriminant / 4)
///   v8 = sqrt(v7)
/// ```
///
/// The two roots are `t = (v5 ± v8) / v4`; the function returns the earlier
/// **non-negative** one — the smaller root `(v5 − v8)/v4` when it is itself
/// ≥ 0 (i.e. `v5 − v8 ≥ 0`), otherwise the larger root, which the decomp
/// writes literally as `(v8 − disp·movement)/v4`. Since `v5 = −(disp·movement)`
/// that larger-root numerator equals `v8 + v5`, so the two branches are
/// `(v5 − v8)/v4` and `(v5 + v8)/v4`.
///
/// Rejections (return `-1.0`), in the decomp's short-circuit order:
///   1. `v6 < EPSILON` — the sphere is already inside `radsum` at `t = 0`
///      (nothing to sweep toward);
///   2. `v4 < EPSILON` — `movement` is too small to register as a sweep;
///   3. `v7 < 0`       — the discriminant is negative, the swept paths miss.
///
/// The decomp packs these into one expression,
/// `if ( v6 < eps || (v7 = v5*v5 - v6*v4, v4 < eps) || v7 < 0.0 )`, so `v7` is
/// always assigned (via the comma operator) before the `v7 < 0` test, while
/// `v6` is tested first; this port mirrors that exactly. (ACE's
/// `Sphere.FindTimeOfCollision` checks `v4` before `v6`; that is a pure
/// reordering of an OR of three reject conditions and changes no result, so
/// the decomp order is kept for fidelity.)
///
/// DIVERGENCE — sign of the result: ACE returns `-1 * (v5 ± v8)/v4` and its
/// own remark questions it ("could be different from original AC … a negative
/// interval?"). The decomp returns the **un-negated** `(v5 ± v8)/v4`, which is
/// also the physically correct one (a sphere approaching from behind and
/// moving forward yields a positive contact time — see `toi_head_on`). Per the
/// Phase-1 ruling the DECOMP wins, so this port does NOT negate.
///
/// Done in `f64` to mirror the decomp's `double` / `long double` (x87)
/// arithmetic, including the `double`-return signature. `EPSILON as f64`
/// reproduces the decomp's `0.00019999999` exactly: both are the `f32` literal
/// `0.0002` widened to 64-bit.
pub fn find_time_of_collision(movement: Vector3, disp: Vector3, radsum: f32) -> f64 {
    // The decomp loads the `f32` 0.0002 and widens it to `double` for the
    // comparisons; `EPSILON as f64` is that same widened constant.
    let eps = EPSILON as f64;

    // v4 = movement·movement
    let v4 = movement.x as f64 * movement.x as f64
        + movement.y as f64 * movement.y as f64
        + movement.z as f64 * movement.z as f64;

    // dm = disp·movement (the raw dot, in decomp's summation order);
    // v5 = -(disp·movement).
    let dm = disp.z as f64 * movement.z as f64
        + disp.y as f64 * movement.y as f64
        + movement.x as f64 * disp.x as f64;
    let v5 = -dm;

    // v6 = disp·disp - radsum²
    let v6 = disp.x as f64 * disp.x as f64
        + disp.y as f64 * disp.y as f64
        + disp.z as f64 * disp.z as f64
        - radsum as f64 * radsum as f64;

    // Faithful short-circuit: v6 first; then v7 is assigned (comma operator)
    // and v4 tested; then v7 tested. Any of the three ⇒ -1.0.
    if v6 < eps {
        return -1.0;
    }
    let v7 = v5 * v5 - v6 * v4;
    if v4 < eps || v7 < 0.0 {
        return -1.0;
    }

    let v8 = v7.sqrt();
    if v5 - v8 < 0.0 {
        // Smaller root (v5 - v8)/v4 is negative ⇒ return the larger root.
        // Written exactly as the decomp does: (v8 - disp·movement)/v4,
        // which equals (v5 + v8)/v4 since v5 = -dm.
        (v8 - dm) / v4
    } else {
        // Smaller root is the first non-negative contact time.
        (v5 - v8) / v4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    fn sph(c: Vector3, r: f32) -> Sphere {
        Sphere {
            center: c,
            radius: r,
        }
    }

    // ── CSphere::intersects (acclient.c:356341) ──────────────────────────

    #[test]
    fn intersects_overlapping_and_symmetric() {
        // centers 1 apart, radsum 1+1=2 → distSq 1 < radsum² 4 → overlap.
        let a = sph(v(0.0, 0.0, 0.0), 1.0);
        let b = sph(v(1.0, 0.0, 0.0), 1.0);
        assert!(intersects(&a, &b));
        // length_squared(this-s) == length_squared(s-this) ⇒ symmetric.
        assert!(intersects(&b, &a));
    }

    #[test]
    fn intersects_far_apart_is_false() {
        // centers 5 apart, radsum 2 → distSq 25 < 4 is false.
        let a = sph(v(0.0, 0.0, 0.0), 1.0);
        let b = sph(v(5.0, 0.0, 0.0), 1.0);
        assert!(!intersects(&a, &b));
    }

    #[test]
    fn intersects_exact_graze_is_false() {
        // centers exactly radsum=2 apart → distSq 4 < 4 is false (strict <),
        // matching the x87 C0-only-on-strict-less reconstruction.
        let a = sph(v(0.0, 0.0, 0.0), 1.0);
        let b = sph(v(2.0, 0.0, 0.0), 1.0);
        assert!(!intersects(&a, &b));
    }

    #[test]
    fn intersects_one_fully_inside_other() {
        // small sphere wholly within the big one → overlapping.
        // distSq 0.25 < radsum² (3+0.5)²=12.25.
        let big = sph(v(0.0, 0.0, 0.0), 3.0);
        let small = sph(v(0.5, 0.0, 0.0), 0.5);
        assert!(intersects(&big, &small));
    }

    #[test]
    fn intersects_3d_diagonal() {
        // centers (3,4,12) apart → distSq 9+16+144 = 169; radsum 13+1=14,
        // radsum² 196 > 169 → overlap. Bump apart by radius and it separates.
        let origin = sph(v(0.0, 0.0, 0.0), 13.0);
        let near = sph(v(3.0, 4.0, 12.0), 1.0);
        assert!(intersects(&origin, &near));
        let far = sph(v(3.0, 4.0, 12.0), 0.5); // radsum 13.5 → 182.25 > 169
        assert!(intersects(&origin, &far));
        let just_out = sph(v(3.0, 4.0, 12.0), 0.0); // radsum 13 → 169 < 169 false
        assert!(!intersects(&origin, &just_out));
    }

    // ── CSphere::find_time_of_collision (acclient.c:358481) ───────────────

    #[test]
    fn toi_head_on_smaller_root() {
        // disp=(-2,0,0), move=(1,0,0), radsum=1.
        // ‖(-2+t,0,0)‖=1 ⇒ |t-2|=1 ⇒ t∈{1,3}; first contact t=1.
        // v4=1, dm=-2, v5=2, v6=4-1=3, v7=4-3=1, v8=1, v5-v8=1≥0 ⇒ (2-1)/1.
        let t = find_time_of_collision(v(1.0, 0.0, 0.0), v(-2.0, 0.0, 0.0), 1.0);
        assert!((t - 1.0).abs() < 1e-4, "t={t}");
    }

    #[test]
    fn toi_oblique_2d_smaller_root() {
        // disp=(-4,4,0), move=(1,0,0), radsum=5.
        // ‖(-4+t,4,0)‖²=25 ⇒ (t-4)²=9 ⇒ t∈{1,7}; first contact t=1.
        // v4=1, dm=-4, v5=4, v6=32-25=7, v7=16-7=9, v8=3, v5-v8=1≥0 ⇒ (4-3)/1.
        let t = find_time_of_collision(v(1.0, 0.0, 0.0), v(-4.0, 4.0, 0.0), 5.0);
        assert!((t - 1.0).abs() < 1e-4, "t={t}");
    }

    #[test]
    fn toi_irrational_root() {
        // disp=(-3,1,0), move=(1,0,0), radsum=2.
        // ‖(-3+t,1,0)‖²=4 ⇒ (t-3)²=3 ⇒ t = 3 - √3 ≈ 1.2679491924 (first).
        // v4=1, dm=-3, v5=3, v6=10-4=6, v7=9-6=3, v8=√3, v5-v8=3-√3≥0 ⇒ 3-√3.
        let expected = 3.0 - 3.0_f64.sqrt();
        let t = find_time_of_collision(v(1.0, 0.0, 0.0), v(-3.0, 1.0, 0.0), 2.0);
        assert!((t - expected).abs() < 1e-4, "t={t} expected={expected}");
    }

    #[test]
    fn toi_scaled_movement_normalizes_to_fraction() {
        // Same geometry as head-on but movement=(2,0,0): contact at the SAME
        // world point ⇒ HALF the parameter, t=0.5. Confirms the /v4 divide
        // returns a fraction of `movement`, not an absolute distance.
        // disp=(-2,0,0): v4=4, dm=-4, v5=4, v6=3, v7=16-12=4, v8=2,
        // v5-v8=2≥0 ⇒ (4-2)/4 = 0.5.
        let t = find_time_of_collision(v(2.0, 0.0, 0.0), v(-2.0, 0.0, 0.0), 1.0);
        assert!((t - 0.5).abs() < 1e-4, "t={t}");
    }

    #[test]
    fn toi_receding_returns_larger_negative_root() {
        // disp=(3,0,0), move=(1,0,0), radsum=1 — outside and moving away.
        // ‖(3+t,0,0)‖=1 ⇒ t∈{-2,-4}; smaller root -4 is <0 (v5-v8<0) so the
        // larger root -2 is returned via the (v8-dm)/v4 branch.
        // v4=1, dm=3, v5=-3, v6=9-1=8, v7=9-8=1, v8=1, v5-v8=-4<0 ⇒ (1-3)/1=-2.
        let t = find_time_of_collision(v(1.0, 0.0, 0.0), v(3.0, 0.0, 0.0), 1.0);
        assert!((t - (-2.0)).abs() < 1e-4, "t={t}");
    }

    #[test]
    fn toi_already_inside_rejected_v6() {
        // |disp|=0.5 < radsum=1 ⇒ v6 = 0.25 - 1 = -0.75 < EPSILON ⇒ -1.
        let t = find_time_of_collision(v(1.0, 0.0, 0.0), v(0.5, 0.0, 0.0), 1.0);
        assert!((t - (-1.0)).abs() < 1e-4, "t={t}");
    }

    #[test]
    fn toi_no_movement_rejected_v4() {
        // v6 = 4 - 1 = 3 passes; then v4 = 0 < EPSILON ⇒ -1.
        let t = find_time_of_collision(v(0.0, 0.0, 0.0), v(2.0, 0.0, 0.0), 1.0);
        assert!((t - (-1.0)).abs() < 1e-4, "t={t}");
    }

    #[test]
    fn toi_parallel_miss_rejected_v7() {
        // disp=(0,5,0), move=(1,0,0): closest approach 5 > radsum=1.
        // v5=0, v6=25-1=24, v7 = 0 - 24·1 = -24 < 0 ⇒ -1.
        let t = find_time_of_collision(v(1.0, 0.0, 0.0), v(0.0, 5.0, 0.0), 1.0);
        assert!((t - (-1.0)).abs() < 1e-4, "t={t}");
    }
}
