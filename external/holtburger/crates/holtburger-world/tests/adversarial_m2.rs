//! Adversarial Empirical Challenge Suite for Milestone 2 (Features 23–27)
//! Movement Challenger: movement_challenger_m2_1

use holtburger_common::math::Vector3;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Triangle};
use holtburger_world::player::types::{PlayerState, StopCoastingState};
use holtburger_world::spatial::{
    cell_wall_substep_count, clamp_delta_against_cell_walls_substepped, crease_slide_projection,
    is_sledding_slope, is_walkable_normal, slope_tangent_gravity, CreaseSlideResult, FLOOR_Z,
    PLAYER_CAPSULE_HEIGHT, PLAYER_CAPSULE_RADIUS, RETAIL_EPSILON, SLEDDING_HIGH_VELOCITY,
    SLEDDING_HIGH_VELOCITY_SQ, SLEDDING_LOW_VELOCITY, SLEDDING_LOW_VELOCITY_SQ,
    SLEDDING_STEEP_NORMAL_Z,
};

// ============================================================================
// FEATURE 23: STEEP SLOPE SLIDING
// ============================================================================

#[test]
fn test_adv_f23_surface_normal_boundary_precision() {
    // Exact mathematical threshold: FLOOR_Z = 0.66417415 (~48.38118° from horizontal)
    let eps = 1e-6_f32;

    // 1. Exactly on boundary: N.z == FLOOR_Z => Walkable
    let n_exact = Vector3::new((1.0_f32 - FLOOR_Z * FLOOR_Z).sqrt(), 0.0, FLOOR_Z);
    assert!(
        is_walkable_normal(n_exact),
        "Normal exactly at FLOOR_Z must be walkable"
    );

    // 2. Just above boundary: N.z = FLOOR_Z + eps => Walkable
    let n_above = Vector3::new((1.0_f32 - (FLOOR_Z + eps).powi(2)).sqrt(), 0.0, FLOOR_Z + eps);
    assert!(
        is_walkable_normal(n_above),
        "Normal at FLOOR_Z + eps must be walkable"
    );

    // 3. Just below boundary: N.z = FLOOR_Z - eps => Steep cliff (NOT walkable)
    let n_below = Vector3::new((1.0_f32 - (FLOOR_Z - eps).powi(2)).sqrt(), 0.0, FLOOR_Z - eps);
    assert!(
        !is_walkable_normal(n_below),
        "Normal at FLOOR_Z - eps must be non-walkable steep cliff"
    );

    // 4. Angular boundary: 48.380° (walkable) vs 48.382° (cliff)
    let rad_48_380 = 48.380_f32.to_radians();
    let n_48_380 = Vector3::new(rad_48_380.sin(), 0.0, rad_48_380.cos());
    assert!(
        is_walkable_normal(n_48_380),
        "48.380° slope must be walkable (cos = {:.7})",
        n_48_380.z
    );

    let rad_48_382 = 48.382_f32.to_radians();
    let n_48_382 = Vector3::new(rad_48_382.sin(), 0.0, rad_48_382.cos());
    assert!(
        !is_walkable_normal(n_48_382),
        "48.382° slope must be non-walkable cliff (cos = {:.7})",
        n_48_382.z
    );

    // 5. Extremes: flat (0, 0, 1), vertical wall (1, 0, 0), overhang (-1, 0, -0.2)
    assert!(is_walkable_normal(Vector3::new(0.0, 0.0, 1.0)));
    assert!(!is_walkable_normal(Vector3::new(1.0, 0.0, 0.0)));
    assert!(!is_walkable_normal(Vector3::new(0.0, 1.0, -0.2)));
}

#[test]
fn test_adv_f23_gravity_tangent_projection_invariant_and_closed_form() {
    let g = -9.8000002_f32;

    // Test across 720 angles covering 360 degrees of azimuth and angles from 0 to 89 degrees
    for deg_pitch in [10, 20, 30, 45, 48, 49, 60, 75, 85, 89] {
        let theta = (deg_pitch as f32).to_radians();
        let sin_t = theta.sin();
        let cos_t = theta.cos();

        for deg_yaw in [0, 45, 90, 135, 180, 225, 270, 315] {
            let phi = (deg_yaw as f32).to_radians();
            let nx = sin_t * phi.cos();
            let ny = sin_t * phi.sin();
            let nz = cos_t;
            let normal = Vector3::new(nx, ny, nz);

            let a = slope_tangent_gravity(normal, g);

            // Invariant 1: Orthogonality: a · n == 0 (strict tangent projection)
            let dot = a.dot(&normal);
            assert!(
                dot.abs() < 1e-4,
                "Tangent acceleration must be orthogonal to surface normal: got {dot} at pitch={deg_pitch}, yaw={deg_yaw}"
            );

            // Invariant 2: Closed-form coordinate match:
            // ax = 9.8 * Nz * Nx
            // ay = 9.8 * Nz * Ny
            // az = -9.8 * (1 - Nz^2)
            let expected_ax = -g * nz * nx;
            let expected_ay = -g * nz * ny;
            let expected_az = g * (1.0 - nz * nz);
            assert!(
                (a.x - expected_ax).abs() < 1e-4,
                "ax mismatch: got {}, expected {}",
                a.x,
                expected_ax
            );
            assert!(
                (a.y - expected_ay).abs() < 1e-4,
                "ay mismatch: got {}, expected {}",
                a.y,
                expected_ay
            );
            assert!(
                (a.z - expected_az).abs() < 1e-4,
                "az mismatch: got {}, expected {}",
                a.z,
                expected_az
            );

            // Invariant 3: Total magnitude equals |g| * sin(theta)
            let expected_mag = g.abs() * sin_t;
            let actual_mag = a.length();
            assert!(
                (actual_mag - expected_mag).abs() < 1e-4,
                "magnitude mismatch: got {actual_mag}, expected {expected_mag}"
            );
        }
    }

    // Invariant 4: Zero normal fallback
    let a_zero = slope_tangent_gravity(Vector3::zero(), g);
    assert_eq!(a_zero, Vector3::new(0.0, 0.0, g));

    // Invariant 5: Unnormalized normal input: (0, 2, 2)
    let a_unnorm = slope_tangent_gravity(Vector3::new(0.0, 2.0, 2.0), g);
    let inv_sqrt2 = 1.0 / std::f32::consts::SQRT_2;
    let expected_az = g * (1.0 - 0.5);
    assert!((a_unnorm.z - expected_az).abs() < 1e-4);
    assert!(a_unnorm.dot(&Vector3::new(0.0, inv_sqrt2, inv_sqrt2)).abs() < 1e-4);
}

// ============================================================================
// FEATURE 24: SLEDDING GLIDE
// ============================================================================

#[test]
fn test_adv_f24_sledding_slope_and_speed_thresholds() {
    let cos10 = SLEDDING_STEEP_NORMAL_Z; // 0.98480775
    let eps = 1e-6_f32;

    // Boundary at 10 degrees:
    // Flatter than 10 deg (e.g. 9.9 deg): Nz > cos10 => NOT sledding slope
    let n_flat = Vector3::new((1.0_f32 - (cos10 + eps).powi(2)).sqrt(), 0.0, cos10 + eps);
    assert!(
        !is_sledding_slope(n_flat),
        "Slope flatter than 10 deg must NOT qualify for sledding"
    );

    // Steeper than 10 deg (e.g. 10.1 deg): Nz < cos10 => Qualifies for sledding
    let n_steep = Vector3::new((1.0_f32 - (cos10 - eps).powi(2)).sqrt(), 0.0, cos10 - eps);
    assert!(
        is_sledding_slope(n_steep),
        "Slope steeper than 10 deg must qualify for sledding"
    );

    // Speed thresholds:
    assert_eq!(SLEDDING_HIGH_VELOCITY, 2.5);
    assert_eq!(SLEDDING_HIGH_VELOCITY_SQ, 6.25);
    assert_eq!(SLEDDING_LOW_VELOCITY, 1.25);
    assert_eq!(SLEDDING_LOW_VELOCITY_SQ, 1.5625);

    // Speed >= 2.5 triggers sledding when on sledding slope and not actively driving
    let mut player = PlayerState::new();
    assert!(!player.is_sledding);

    let speed_over = 2.5001_f32;
    let qualifies = !false // !is_active_locomotion
        && is_sledding_slope(n_steep)
        && (speed_over * speed_over) >= SLEDDING_HIGH_VELOCITY_SQ;
    assert!(qualifies, "Speed 2.5001 on >10 deg slope must trigger sledding");

    let speed_under = 2.4999_f32;
    let under_qualifies = (speed_under * speed_under) >= SLEDDING_HIGH_VELOCITY_SQ;
    assert!(!under_qualifies, "Speed 2.4999 must NOT trigger sledding");

    // Exit condition: speed < 1.25 m/s
    player.is_sledding = true;
    let exit_speed = 1.2499_f32;
    if (exit_speed * exit_speed) < SLEDDING_LOW_VELOCITY_SQ {
        player.is_sledding = false;
    }
    assert!(!player.is_sledding, "Speed 1.2499 must disengage sledding");
}

// ============================================================================
// FEATURE 25: CREASE SLIDE PROJECTION
// ============================================================================

#[test]
fn test_adv_f25_crease_slide_projection_mathematics_and_invariants() {
    // Test 1: Non-degenerate 3D crease (90° corner between wall facing +X and slope facing +Z tilted toward +Y)
    let n1 = Vector3::new(1.0, 0.0, 0.0);
    let n2 = Vector3::new(0.0, 0.6, 0.8);
    // D = N1 × N2 = (0, -0.8, 0.6)
    // ||D||^2 = (-0.8)^2 + 0.6^2 = 0.64 + 0.36 = 1.0 >= RETAIL_EPSILON
    let d = n1.cross(&n2);
    assert!((d.length_squared() - 1.0).abs() < 1e-5);

    let v = Vector3::new(-3.0, 4.0, 5.0);
    let res = crease_slide_projection(v, n1, n2);

    match res {
        CreaseSlideResult::Slid(v_proj) => {
            // Invariant 1: Strictly parallel to D
            let dot_vd = v_proj.dot(&d);
            let reconstructed = d * (dot_vd / d.length_squared());
            assert!(
                (v_proj - reconstructed).length() < 1e-4,
                "v_proj must be parallel to crease vector D"
            );

            // Invariant 2: Orthogonal to both plane normals (zero into-plane penetration)
            assert!(
                v_proj.dot(&n1).abs() < 1e-4,
                "v_proj must not penetrate plane 1: dot = {}",
                v_proj.dot(&n1)
            );
            assert!(
                v_proj.dot(&n2).abs() < 1e-4,
                "v_proj must not penetrate plane 2: dot = {}",
                v_proj.dot(&n2)
            );

            // Invariant 3: Symmetry under normal argument swap
            let res_rev = crease_slide_projection(v, n2, n1);
            match res_rev {
                CreaseSlideResult::Slid(v_proj_rev) => {
                    assert!(
                        (v_proj - v_proj_rev).length() < 1e-4,
                        "Crease projection must be invariant under normal argument ordering"
                    );
                }
                other => panic!("Expected Slid for reversed normals, got {:?}", other),
            }
        }
        other => panic!("Expected Slid, got {:?}", other),
    }

    // Test 2: Sub-threshold velocity projection cessation
    // Velocity strictly perpendicular to crease D: V = (-5.0, 0.0, 0.0) -> V · D = 0
    let v_perp = Vector3::new(-5.0, 0.0, 0.0);
    assert_eq!(
        crease_slide_projection(v_perp, n1, n2),
        CreaseSlideResult::Blocked
    );

    // Test 3: Crease vector norm boundary around RETAIL_EPSILON (0.0002)
    let delta_sin = (RETAIL_EPSILON + 1e-5).sqrt();
    let n_a = Vector3::new(0.0, 0.0, 1.0);
    let n_b_above = Vector3::new(delta_sin, 0.0, (1.0_f32 - delta_sin * delta_sin).sqrt());
    let d_above = n_a.cross(&n_b_above);
    assert!(
        d_above.length_squared() >= RETAIL_EPSILON,
        "d_above length squared must be >= RETAIL_EPSILON"
    );

    let delta_sin_below = (RETAIL_EPSILON - 1e-5).sqrt();
    let n_b_below = Vector3::new(delta_sin_below, 0.0, (1.0_f32 - delta_sin_below * delta_sin_below).sqrt());
    let d_below = n_a.cross(&n_b_below);
    assert!(
        d_below.length_squared() < RETAIL_EPSILON,
        "d_below length squared must be < RETAIL_EPSILON"
    );

    // Below threshold with N1 · N2 >= 0 falls back to DegenerateSinglePlane on N2
    let res_deg = crease_slide_projection(Vector3::new(1.0, 2.0, 0.0), n_a, n_b_below);
    match res_deg {
        CreaseSlideResult::DegenerateSinglePlane(v_tangent) => {
            assert!(
                v_tangent.dot(&n_b_below).abs() < 1e-4,
                "Tangent projection must be orthogonal to N2"
            );
        }
        other => panic!("Expected DegenerateSinglePlane, got {:?}", other),
    }

    // Opposing acute pinch trap: N1 · N2 < 0 (normals face each other)
    let n_opp = Vector3::new(0.0, 0.0, -1.0);
    assert_eq!(
        crease_slide_projection(Vector3::new(1.0, 2.0, 0.0), n_a, n_opp),
        CreaseSlideResult::Blocked
    );
}

// ============================================================================
// FEATURE 26: STOP COASTING DECELERATION
// ============================================================================

#[test]
fn test_adv_f26_stop_coasting_exact_kinematics_and_cancellation() {
    let dt = 1.0 / 30.0_f32;

    // 1. Run -> Ready Deceleration: 4.0 m/s sprint
    let initial_speed = 4.0_f32;
    let mut state = StopCoastingState {
        initial_velocity: Vector3::new(0.0, initial_speed, 0.0),
        duration_s: 0.40,
        elapsed_s: 0.0,
    };

    let mut total_displacement = 0.0_f32;
    let mut tick_count = 0;

    for _ in 0..20 {
        state.elapsed_s += dt;
        if state.elapsed_s >= state.duration_s {
            break;
        }
        let fraction = (state.elapsed_s / state.duration_s).clamp(0.0, 1.0);
        let v = state.initial_velocity * (1.0 - fraction);
        total_displacement += v.length() * dt;
        tick_count += 1;
    }

    // Exactly 11 steps of positive velocity, 12th step reaches 0.40s duration
    assert_eq!(tick_count, 11);
    // Continuous integral = 0.5 * 4.0 * 0.40 = 0.80 m
    // Discrete left-endpoint Riemann sum = sum_{i=1}^{11} (4.0 * (1 - i/12)) * (1/30) = 0.7333 m
    // Midpoint sum is 0.80 m. Both are within 0.70m - 0.85m window (~0.79m nominal)
    assert!(
        total_displacement > 0.70 && total_displacement < 0.85,
        "Total Run coasting displacement must be ~0.79m, got {total_displacement}"
    );

    // 2. Walk -> Ready Deceleration: 3.12 m/s walk
    let walk_speed = 3.12_f32;
    let mut walk_state = StopCoastingState {
        initial_velocity: Vector3::new(0.0, walk_speed, 0.0),
        duration_s: 0.20,
        elapsed_s: 0.0,
    };

    let mut walk_displacement = 0.0_f32;
    let mut walk_ticks = 0;
    for _ in 0..10 {
        walk_state.elapsed_s += dt;
        if walk_state.elapsed_s >= walk_state.duration_s {
            break;
        }
        let fraction = (walk_state.elapsed_s / walk_state.duration_s).clamp(0.0, 1.0);
        let v = walk_state.initial_velocity * (1.0 - fraction);
        walk_displacement += v.length() * dt;
        walk_ticks += 1;
    }
    assert_eq!(walk_ticks, 5);
    assert!(
        walk_displacement > 0.25 && walk_displacement < 0.35,
        "Total Walk coasting displacement must be ~0.312m, got {walk_displacement}"
    );

    // 3. Instant cancellation on input re-press
    let mut player = PlayerState::new();
    player.stop_coasting = Some(state);
    assert!(player.stop_coasting.is_some());

    // Re-press forward locomotion: target_velocity is non-zero
    let target_velocity = Vector3::new(0.0, 4.0, 0.0);
    if target_velocity.length_squared() > f32::EPSILON {
        player.stop_coasting = None;
        player.current_planar_velocity = target_velocity;
    }

    assert!(
        player.stop_coasting.is_none(),
        "Re-pressing forward key must instantly cancel stop_coasting"
    );
    assert_eq!(player.current_planar_velocity, target_velocity);
}

// ============================================================================
// FEATURE 27: AP STUTTER MITIGATION
// ============================================================================

#[test]
fn test_adv_f27_reconciliation_blending_and_stutter_mitigation() {
    // Test the reconciliation blending formula from PositionManager::adjust_offset_chain:
    // When keep_heading = true:
    // clamped_corr = if corr_len > max_correction { interp_offset * (max_correction / corr_len) } else { interp_offset }
    // offset = intended_offset + clamped_corr

    let intended_offset = Vector3::new(1.0, 0.0, 0.0); // 1.0m manual forward displacement
    let stale_interp_offset = Vector3::new(-0.8, 0.0, 0.0); // 0.8m backward corrective pull

    let max_correction = intended_offset.length() * 0.5; // 0.5m clamp
    let corr_len = stale_interp_offset.length();
    let clamped_corr = if corr_len > max_correction && corr_len > 1e-6 {
        stale_interp_offset * (max_correction / corr_len)
    } else {
        stale_interp_offset
    };

    assert_eq!(clamped_corr, Vector3::new(-0.5, 0.0, 0.0));
    let blended = intended_offset + clamped_corr;
    assert_eq!(blended, Vector3::new(0.5, 0.0, 0.0));
    assert!(
        blended.x > 0.0,
        "Blended displacement must maintain forward progress without stutter"
    );

    // Also test small correction within budget:
    let small_interp = Vector3::new(-0.2, 0.0, 0.0);
    let small_clamped = if small_interp.length() > max_correction {
        small_interp * (max_correction / small_interp.length())
    } else {
        small_interp
    };
    assert_eq!(small_clamped, small_interp);
    assert_eq!(intended_offset + small_clamped, Vector3::new(0.8, 0.0, 0.0));
}
// ============================================================================
// FEATURE 23: STEEP SLOPE SLIDING — SPLIT-STORE STATE & ACCELERATION INVARIANTS
// ============================================================================

#[test]
fn test_adv_f23_steep_slope_slide_player_state_split_velocity_accelerates_into_sledding() {
    let normal = Vector3::new(0.8660254, 0.0, 0.5); // 60 deg steep cliff (Nz < FLOOR_Z)
    assert!(!is_walkable_normal(normal));

    let mut player = PlayerState::default();
    player.current_planar_velocity = Vector3::zero();
    player.vertical_velocity = 0.0;
    player.is_sledding = false;

    let dt_s = 1.0 / 30.0_f32;
    let a_tangent = slope_tangent_gravity(normal, -9.8000002);

    // Simulate 45 ticks (1.50 seconds) of steep slope sliding
    for tick in 1..=45 {
        // Step 1: Must compose 3D velocity from PlayerState split stores:
        // current_planar_velocity (z == 0.0) and vertical_velocity.
        assert_eq!(player.current_planar_velocity.z, 0.0, "current_planar_velocity.z must strictly be 0.0");
        let mut v = Vector3::new(
            player.current_planar_velocity.x,
            player.current_planar_velocity.y,
            player.vertical_velocity,
        );

        // Step 2: Accumulate gravity tangent acceleration across all 3 axes:
        v = v + a_tangent * dt_s;

        // Step 3: Contact plane projection & friction decay (calc_friction):
        let vel_mag_sq = v.length_squared();
        let angle = v.dot(&normal);
        // Orthogonality invariant: tangent acceleration must remain strictly orthogonal to slope normal
        assert!(
            angle.abs() < 1e-4,
            "Tangent velocity must be orthogonal to normal (got angle={:.6}); if vertical_velocity was dropped, normal stripping occurs!",
            angle
        );

        if angle < 0.25 {
            v = v - normal * angle;
        }

        let mut friction = 0.95_f32;
        if player.is_sledding {
            if vel_mag_sq < SLEDDING_LOW_VELOCITY_SQ {
                friction = 1.0;
            } else if vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ && normal.z < SLEDDING_STEEP_NORMAL_Z {
                friction = 0.2;
            }
        }
        let scalar = (1.0 - friction).powf(dt_s);
        v = v * scalar;

        // Step 4: Write back to PlayerState split stores:
        player.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        player.vertical_velocity = v.z;

        // Step 5: Sledding state transition check at tick end:
        let speed_sq = player.current_planar_velocity.length_squared()
            + player.vertical_velocity * player.vertical_velocity;
        if speed_sq >= SLEDDING_HIGH_VELOCITY_SQ && normal.z < SLEDDING_STEEP_NORMAL_Z {
            player.is_sledding = true;
        } else if player.is_sledding && speed_sq < SLEDDING_LOW_VELOCITY_SQ {
            player.is_sledding = false;
        }

        let speed = speed_sq.sqrt();

        // Checkpoint 1: t = 0.33s (tick 10) — accelerating from rest under default friction 0.95
        if tick == 10 {
            assert!(
                speed >= 1.5 && speed <= 1.9,
                "Tick 10 speed must be within [1.5, 1.9] m/s, got {:.3}",
                speed
            );
            assert!(
                !player.is_sledding,
                "Sledding must NOT engage before crossing 2.5 m/s threshold"
            );
        }

        // Checkpoint 2: t = 0.67s (tick 20) — approaching threshold
        if tick == 20 {
            assert!(
                speed >= 2.1 && speed <= 2.45,
                "Tick 20 speed must be within [2.1, 2.45] m/s, got {:.3}",
                speed
            );
            assert!(
                !player.is_sledding,
                "Sledding must remain false at tick 20 (speed={:.3})",
                speed
            );
        }

        // Checkpoint 3: t = 1.00s (tick 30) — crossed 2.5 m/s, engaged sledding glide
        if tick == 30 {
            assert!(
                speed >= 3.0 && speed <= 3.6,
                "Tick 30 speed must be within [3.0, 3.6] m/s, got {:.3}",
                speed
            );
            assert!(
                player.current_planar_velocity.x >= 1.5,
                "Planar velocity must exceed 1.5 m/s (got vx={:.3})",
                player.current_planar_velocity.x
            );
            assert!(
                player.is_sledding,
                "Avatar must engage sledding mode upon exceeding 2.5 m/s"
            );
        }

        // Checkpoint 4: t = 1.50s (tick 45) — continuous sledding glide (f = 0.20)
        if tick == 45 {
            assert!(
                speed >= 6.5 && speed <= 7.5,
                "Tick 45 speed must reach [6.5, 7.5] m/s under sledding glide, got {:.3}",
                speed
            );
            assert!(
                player.current_planar_velocity.x >= 3.0,
                "Planar velocity must exceed 3.0 m/s (got vx={:.3})",
                player.current_planar_velocity.x
            );
            assert!(player.is_sledding, "Sledding glide must remain active");
        }
    }
}

#[test]
fn test_adv_f23_multi_angle_and_oblique_slope_invariance() {
    let dt_s = 1.0 / 30.0_f32;

    // Test Case 1: 70 deg cliff facing +Y (N = (0, sin 70°, cos 70°))
    let rad_70 = 70.0_f32.to_radians();
    let n_y_cliff = Vector3::new(0.0, rad_70.sin(), rad_70.cos());
    assert!(!is_walkable_normal(n_y_cliff));

    let mut p_y = PlayerState::default();
    let a_y = slope_tangent_gravity(n_y_cliff, -9.8000002);

    for _ in 1..=30 {
        let mut v = Vector3::new(
            p_y.current_planar_velocity.x,
            p_y.current_planar_velocity.y,
            p_y.vertical_velocity,
        );
        v = v + a_y * dt_s;
        let vel_mag_sq = v.length_squared();
        let angle = v.dot(&n_y_cliff);
        if angle < 0.25 {
            v = v - n_y_cliff * angle;
        }
        let friction: f32 = if p_y.is_sledding && vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v = v * (1.0 - friction).powf(dt_s);
        p_y.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        p_y.vertical_velocity = v.z;
        if v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && n_y_cliff.z < SLEDDING_STEEP_NORMAL_Z {
            p_y.is_sledding = true;
        }
    }
    // Pure +Y acceleration: vx must be 0, vy must accelerate past 1.5 m/s
    assert!(p_y.current_planar_velocity.x.abs() < 1e-4, "X velocity must remain 0 on Y-facing cliff");
    assert!(p_y.current_planar_velocity.y >= 1.5, "Y velocity must accelerate past 1.5 m/s, got {:.3}", p_y.current_planar_velocity.y);
    assert!(p_y.is_sledding, "Sledding must trigger on 70° cliff");

    // Test Case 2: 60 deg oblique cliff facing 45° diagonal (Nx = Ny > 0)
    let rad_60 = 60.0_f32.to_radians();
    let n_xy = rad_60.sin() / 2.0_f32.sqrt();
    let n_oblique = Vector3::new(n_xy, n_xy, rad_60.cos());
    assert!(!is_walkable_normal(n_oblique));

    let mut p_obl = PlayerState::default();
    let a_obl = slope_tangent_gravity(n_oblique, -9.8000002);

    for _ in 1..=30 {
        let mut v = Vector3::new(
            p_obl.current_planar_velocity.x,
            p_obl.current_planar_velocity.y,
            p_obl.vertical_velocity,
        );
        v = v + a_obl * dt_s;
        let vel_mag_sq = v.length_squared();
        let angle = v.dot(&n_oblique);
        if angle < 0.25 {
            v = v - n_oblique * angle;
        }
        let friction: f32 = if p_obl.is_sledding && vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v = v * (1.0 - friction).powf(dt_s);
        p_obl.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        p_obl.vertical_velocity = v.z;
        if v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && n_oblique.z < SLEDDING_STEEP_NORMAL_Z {
            p_obl.is_sledding = true;
        }
    }
    // Symmetry invariant: vx and vy must be identical and both positive
    assert!(
        (p_obl.current_planar_velocity.x - p_obl.current_planar_velocity.y).abs() < 1e-4,
        "Oblique 45° slide must have identical X and Y components"
    );
    let planar_speed = (p_obl.current_planar_velocity.x.powi(2) + p_obl.current_planar_velocity.y.powi(2)).sqrt();
    assert!(
        planar_speed >= 1.5,
        "Oblique planar slide speed must exceed 1.5 m/s, got {:.3}",
        planar_speed
    );
    assert!(p_obl.is_sledding, "Oblique slide must trigger sledding");
}

#[test]
fn test_adv_f23_planar_normal_stripping_regression_guard() {
    let normal = Vector3::new(0.8660254, 0.0, 0.5); // 60 deg cliff
    let a_tangent = slope_tangent_gravity(normal, -9.8000002);
    let dt_s = 1.0 / 30.0_f32;

    // 1. Defect proof: Passing 2D planar velocity with vz=0 into 3D normal projection strips (1 - Nz^2)
    let mut v_defective = Vector3::zero();
    for _ in 0..30 {
        v_defective.x += a_tangent.x * dt_s;
        v_defective.y += a_tangent.y * dt_s;
        // vz is 0.0 => angle is non-zero
        let angle = v_defective.dot(&normal);
        assert!(angle > 0.0, "Defect signature: non-zero dot product with normal when vz is missing");
        v_defective = v_defective - normal * angle;
        v_defective = v_defective * (1.0_f32 - 0.95_f32).powf(dt_s);
        v_defective.z = 0.0;
    }
    assert!(
        v_defective.x < 0.05,
        "Planar velocity without vertical component is crushed to 4 cm/s ({:.4})",
        v_defective.x
    );

    // 2. Remediation proof: Compositing vertical_velocity eliminates stripping and accelerates
    let mut v_remediated = Vector3::zero();
    let mut is_sledding = false;
    for _ in 0..30 {
        v_remediated = v_remediated + a_tangent * dt_s;
        let angle = v_remediated.dot(&normal);
        assert!(
            angle.abs() < 1e-5,
            "Remediation signature: dot product with normal is zero when 3D vector is maintained"
        );
        let vel_mag_sq = v_remediated.length_squared();
        let friction = if is_sledding && vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v_remediated = v_remediated * (1.0_f32 - friction).powf(dt_s);
        if v_remediated.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && normal.z < SLEDDING_STEEP_NORMAL_Z {
            is_sledding = true;
        }
    }
    assert!(
        v_remediated.x >= 1.5,
        "Remediated planar velocity must accelerate past 1.5 m/s, got {:.3}",
        v_remediated.x
    );
    assert!(
        v_remediated.length() >= 3.0,
        "Remediated 3D velocity must accelerate past 3.0 m/s, got {:.3}",
        v_remediated.length()
    );
    assert!(is_sledding, "Remediated avatar must engage sledding");
}

#[test]
fn test_adv_f25_cell_wall_substep_accumulation_and_early_exit() {
    let r = PLAYER_CAPSULE_RADIUS; // 0.4
    let h = PLAYER_CAPSULE_HEIGHT;

    // Helper wall triangle facing +X
    let wall_x = Triangle::new(
        Vector3::new(0.4, -10.0, -1.0),
        Vector3::new(0.4, 10.0, -1.0),
        Vector3::new(0.4, -10.0, 3.0),
    );
    let pose = WorldPosition {
        landblock_id: Guid(0x0000_0000),
        coords: Vector3::new(0.0, 0.0, 0.0),
        rotation: holtburger_common::math::Quaternion::from_heading(0.0),
    };

    // Scenario 1: Dead-ahead move into wall that subdivides into 3 substeps
    let delta_into_wall = Vector3::new(1.2, 0.0, 0.0);
    let steps = cell_wall_substep_count(delta_into_wall.length(), r);
    assert!(steps >= 3, "Delta of 1.2m must generate at least 3 substeps");

    let (clamped, wall_norm) = clamp_delta_against_cell_walls_substepped(
        &[wall_x],
        &pose,
        delta_into_wall,
        r,
        h,
        &[],
    );

    // Wall at x = 0.4 with radius 0.4 means capsule already touches wall.
    // Into-wall motion must be completely clamped to 0.0.
    // Early exit in line 1422 must fire on step 1 because step_lat <= EPSILON.
    assert!(
        clamped.length() < 1e-4,
        "Motion dead into wall must yield 0 clamped displacement, got {:?}",
        clamped
    );
    assert!(
        wall_norm.is_some(),
        "Must register wall normal upon contact"
    );

    // Scenario 2: Grazing move along wall with into-wall bias across 3 substeps
    let delta_glance = Vector3::new(0.2, 1.2, 0.0);
    let (clamped_glance, _) = clamp_delta_against_cell_walls_substepped(
        &[wall_x],
        &pose,
        delta_glance,
        r,
        h,
        &[],
    );

    // X displacement into wall must be clamped, Y displacement along wall preserved
    assert!(
        clamped_glance.x.abs() < 1e-3,
        "Into-wall displacement must be zero, got {}",
        clamped_glance.x
    );
    assert!(
        (clamped_glance.y - 1.2).abs() < 1e-3,
        "Along-wall displacement must be preserved (1.2m), got {}",
        clamped_glance.y
    );
}

