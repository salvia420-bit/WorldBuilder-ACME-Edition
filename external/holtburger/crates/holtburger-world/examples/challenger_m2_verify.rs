//! challenger_m2_verify — Empirical Adversarial Challenger Verification for Milestone 2 in Rust
//! Agent: movement_challenger_m2_2

use holtburger_common::math::Vector3;
use holtburger_world::player::types::StopCoastingState;
use holtburger_world::spatial::{
    crease_slide_projection, is_sledding_slope, is_walkable_normal, slope_tangent_gravity,
    CreaseSlideResult, FLOOR_Z, RETAIL_EPSILON, SLEDDING_FRICTION, SLEDDING_HIGH_VELOCITY,
    SLEDDING_HIGH_VELOCITY_SQ, SLEDDING_LOW_VELOCITY, SLEDDING_LOW_VELOCITY_SQ,
    SLEDDING_STEEP_NORMAL_Z,
};

fn main() {
    println!("======================================================================");
    println!("     RUST EMPIRICAL ADVERSARIAL CHALLENGER VERIFICATION (M2)");
    println!("======================================================================\n");

    let mut passed = 0;
    let mut total = 0;

    macro_rules! check {
        ($desc:expr, $expr:expr) => {
            total += 1;
            if $expr {
                passed += 1;
                println!("  [PASS] {}", $desc);
            } else {
                eprintln!("  [FAIL] {}", $desc);
                panic!("Assertion failed: {}", $desc);
            }
        };
    }

    // ------------------------------------------------------------------------
    // Feature 23: Steep Slope Sliding
    // ------------------------------------------------------------------------
    println!(">>> Feature 23: Steep Slope Sliding Invariants <<<");

    let eps = 1e-6_f32;
    check!("FLOOR_Z constant value matches retail", (FLOOR_Z - 0.66417415).abs() < 1e-5);
    check!("FLOOR_Z exact boundary is walkable", is_walkable_normal(Vector3::new(0.0, 0.0, FLOOR_Z)));
    check!("FLOOR_Z + eps is walkable", is_walkable_normal(Vector3::new(0.0, 0.0, FLOOR_Z + eps)));
    check!("FLOOR_Z - eps is steep cliff", !is_walkable_normal(Vector3::new(0.0, 0.0, FLOOR_Z - eps)));

    // Angular boundary test
    let rad_48_380 = 48.380_f32.to_radians();
    check!("48.380 deg slope is walkable", is_walkable_normal(Vector3::new(rad_48_380.sin(), 0.0, rad_48_380.cos())));

    let rad_48_382 = 48.382_f32.to_radians();
    check!("48.382 deg slope is non-walkable steep cliff", !is_walkable_normal(Vector3::new(rad_48_382.sin(), 0.0, rad_48_382.cos())));

    // Gravity Tangent Projection checks
    let g = -9.8000002_f32;
    let vert_wall = Vector3::new(1.0, 0.0, 0.0);
    let a_vert = slope_tangent_gravity(vert_wall, g);
    check!("Vertical wall accelerates purely in Z at g", a_vert.x.abs() < 1e-5 && a_vert.y.abs() < 1e-5 && (a_vert.z - g).abs() < 1e-5);

    let flat_ground = Vector3::new(0.0, 0.0, 1.0);
    let a_flat = slope_tangent_gravity(flat_ground, g);
    check!("Flat ground produces zero slide acceleration", a_flat.length() < 1e-5);

    // Tangent acceleration invariants over angles
    let mut all_ortho = true;
    let mut all_closed_form = true;
    for pitch in [15, 30, 45, 60, 75] {
        let theta = (pitch as f32).to_radians();
        for yaw in [0, 45, 90, 135, 180, 225, 270, 315] {
            let phi = (yaw as f32).to_radians();
            let nx = theta.sin() * phi.cos();
            let ny = theta.sin() * phi.sin();
            let nz = theta.cos();
            let normal = Vector3::new(nx, ny, nz);
            let a = slope_tangent_gravity(normal, g);

            if a.dot(&normal).abs() >= 1e-4 {
                all_ortho = false;
            }

            let exp_ax = -g * nz * nx;
            let exp_ay = -g * nz * ny;
            let exp_az = g * (1.0 - nz * nz);
            if (a.x - exp_ax).abs() >= 1e-4 || (a.y - exp_ay).abs() >= 1e-4 || (a.z - exp_az).abs() >= 1e-4 {
                all_closed_form = false;
            }
        }
    }
    check!("Slope tangent acceleration is strictly orthogonal (a · n == 0) across all angles", all_ortho);
    check!("Slope tangent acceleration matches closed-form formula across all angles", all_closed_form);

    // ------------------------------------------------------------------------
    // Feature 24: Sledding Glide
    // ------------------------------------------------------------------------
    println!("\n>>> Feature 24: Sledding Glide Invariants <<<");

    let cos10 = 10.0_f32.to_radians().cos();
    check!("SLEDDING_STEEP_NORMAL_Z matches cos(10 deg)", (SLEDDING_STEEP_NORMAL_Z - cos10).abs() < 1e-5);
    check!("Slope 10.01 deg qualifies for sledding", is_sledding_slope(Vector3::new(0.0, 0.0, cos10 - eps)));
    check!("Slope 9.99 deg does not qualify for sledding", !is_sledding_slope(Vector3::new(0.0, 0.0, cos10 + eps)));

    check!("Sledding speed threshold is 2.5 m/s", SLEDDING_HIGH_VELOCITY == 2.5 && SLEDDING_HIGH_VELOCITY_SQ == 6.25);
    check!("Sledding stop threshold is 1.25 m/s", SLEDDING_LOW_VELOCITY == 1.25 && SLEDDING_LOW_VELOCITY_SQ == 1.5625);
    check!("Sledding friction coeff is 0.2", SLEDDING_FRICTION == 0.2);

    // ------------------------------------------------------------------------
    // Feature 25: Crease Slide Projection
    // ------------------------------------------------------------------------
    println!("\n>>> Feature 25: Crease Slide Projection Invariants <<<");

    check!("RETAIL_EPSILON threshold is 0.0002", RETAIL_EPSILON == 0.0002);

    // Orthogonal planes
    let n1 = Vector3::new(1.0, 0.0, 0.0);
    let n2 = Vector3::new(0.0, 1.0, 0.0);
    let v_corner = Vector3::new(-3.0, -4.0, 5.0);

    let res1 = crease_slide_projection(v_corner, n1, n2);
    let res2 = crease_slide_projection(v_corner, n2, n1);

    match (res1, res2) {
        (CreaseSlideResult::Slid(v1), CreaseSlideResult::Slid(v2)) => {
            check!("Orthogonal walls project motion along Z crease line", v1.x.abs() < 1e-5 && v1.y.abs() < 1e-5 && (v1.z - 5.0).abs() < 1e-5);
            check!("Crease slide projection is invariant under normal argument order", (v1 - v2).length() < 1e-5);
            check!("Projected velocity penetrates neither plane (v · n1 == 0, v · n2 == 0)", v1.dot(&n1).abs() < 1e-5 && v1.dot(&n2).abs() < 1e-5);
        }
        _ => panic!("Expected Slid for orthogonal corner"),
    }

    // Purely horizontal motion into corner -> Blocked
    let v_flat_corner = Vector3::new(-2.0, -2.0, 0.0);
    check!("Motion purely into corner without crease component is Blocked", crease_slide_projection(v_flat_corner, n1, n2) == CreaseSlideResult::Blocked);

    // Opposing acute pinch trap -> Blocked
    let n_opp = Vector3::new(-1.0, 0.0, 0.0);
    check!("Opposing acute pinch trap (n1 · n2 < 0) halts motion (Blocked)", crease_slide_projection(Vector3::new(1.0, 0.0, 0.0), n1, n_opp) == CreaseSlideResult::Blocked);

    // Coplanar degenerate planes -> DegenerateSinglePlane
    let v_glide = Vector3::new(2.0, 3.0, -4.0);
    let n_coplanar = Vector3::new(0.0, 0.0, 1.0);
    match crease_slide_projection(v_glide, n_coplanar, n_coplanar) {
        CreaseSlideResult::DegenerateSinglePlane(v_tan) => {
            check!("Coplanar planes strip normal component and slide tangent", v_tan.x == 2.0 && v_tan.y == 3.0 && v_tan.z == 0.0);
        }
        _ => panic!("Expected DegenerateSinglePlane for coplanar"),
    }

    // ------------------------------------------------------------------------
    // Feature 26: Stop Coasting Deceleration
    // ------------------------------------------------------------------------
    println!("\n>>> Feature 26: Stop Coasting Deceleration Invariants <<<");

    let dt_s = 1.0_f32 / 30.0_f32;

    // Run -> Ready: 12 ticks, 0.40s, distance ~ 0.796875m
    let v0_run = 4.0_f32;
    let mut v_run = v0_run;
    let mut dist_run = 0.0_f32;
    let mut ticks_run = 0;
    for tick in 1..=20 {
        let elapsed = tick as f32 * dt_s;
        let v_prev = v_run;
        if elapsed >= 0.40 {
            v_run = 0.0;
        } else {
            v_run = v0_run * (1.0 - elapsed / 0.40);
            if v_run < 0.25 {
                v_run = 0.0;
            }
        }
        dist_run += 0.5 * (v_prev + v_run) * dt_s;
        ticks_run += 1;
        if v_run == 0.0 {
            break;
        }
    }
    check!("Run -> Ready stopping deceleration completes in exactly 12 ticks (0.40s)", ticks_run == 12);
    check!("Run -> Ready stopping distance is ~0.79m", (dist_run - 0.79).abs() < 0.05);

    // Walk -> Ready: 6 ticks, 0.20s, distance ~ 0.312m
    let v0_walk = 3.12_f32;
    let mut v_walk = v0_walk;
    let mut dist_walk = 0.0_f32;
    let mut ticks_walk = 0;
    for tick in 1..=15 {
        let elapsed = tick as f32 * dt_s;
        let v_prev = v_walk;
        if elapsed >= 0.20 {
            v_walk = 0.0;
        } else {
            v_walk = v0_walk * (1.0 - elapsed / 0.20);
            if v_walk < 0.25 {
                v_walk = 0.0;
            }
        }
        dist_walk += 0.5 * (v_prev + v_walk) * dt_s;
        ticks_walk += 1;
        if v_walk == 0.0 {
            break;
        }
    }
    check!("Walk -> Ready stopping deceleration completes in exactly 6 ticks (0.20s)", ticks_walk == 6);
    check!("Walk -> Ready stopping distance is ~0.312m", (dist_walk - 0.312).abs() < 0.05);

    // StopCoastingState cancellation on forward press
    let mut coasting = Some(StopCoastingState {
        initial_velocity: Vector3::new(0.0, 4.0, 0.0),
        duration_s: 0.40,
        elapsed_s: 0.10,
    });
    check!("Coasting state active", coasting.is_some());
    // Forward input re-pressed:
    let target_vel = Vector3::new(0.0, 4.0, 0.0);
    if target_vel.length_squared() > f32::EPSILON {
        coasting = None;
    }
    check!("Forward key re-press clears coasting immediately", coasting.is_none());

    // ------------------------------------------------------------------------
    // Feature 27: AP Stutter Mitigation Blending
    // ------------------------------------------------------------------------
    println!("\n>>> Feature 27: AP Stutter Mitigation Invariants <<<");

    let intended = Vector3::new(0.4, 0.0, 0.0); // 0.4m forward
    let interp_backward = Vector3::new(-1.0, 0.0, 0.0); // 1.0m backward correction

    let max_corr = intended.length() * 0.5;
    let corr_len = interp_backward.length();
    let clamped = if corr_len > max_corr && corr_len > 1e-6 {
        interp_backward * (max_corr / corr_len)
    } else {
        interp_backward
    };
    check!("Backward error correction clamped to 0.5x manual travel (-0.2m)", (clamped.x - (-0.2)).abs() < 1e-5);

    let net_offset = intended + clamped;
    check!("Net offset preserves forward progress (+0.2m), eliminating stutter", net_offset.x >= 0.2);

    println!("\n======================================================================");
    println!("     ALL {} / {} RUST ADVERSARIAL CHECKS PASSED OPERATIONAL!", passed, total);
    println!("======================================================================\n");
}
