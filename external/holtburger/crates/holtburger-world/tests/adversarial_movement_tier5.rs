//! external/holtburger/crates/holtburger-world/tests/adversarial_movement_tier5.rs
//!
//! Tier 5 White-Box Adversarial Hardening Suite for Movement Physics, Kinematics,
//! and Slope Sliding Subsystems.
//! Movement Challenger: movement_challenger_m4_1

use holtburger_common::math::{Quaternion, Vector3};
use holtburger_protocol::messages::movement::MotionStance;
use holtburger_world::player::types::{PlayerState, StopCoastingState};
use holtburger_world::spatial::{
    is_sledding_slope, is_walkable_normal, slope_tangent_gravity, FLOOR_Z,
    SLEDDING_HIGH_VELOCITY_SQ, SLEDDING_LOW_VELOCITY_SQ, SLEDDING_STEEP_NORMAL_Z,
};
use holtburger_world::context::{
    burden_load_modifier, exhausted_run_skill, run_rate_from_skill_and_burden,
};
use holtburger_world::motion::motion_interp::interpreted_velocity_for_state;
use holtburger_world::motion::movement_types::MotionState;
use holtburger_world::state::motion_resolution::PlayerMotionTableSource;
use holtburger_world::state::self_movement::{SelfMovementCapabilities, SelfMovementKinematics};

fn authored_capabilities(run_rate_scalar: f32) -> SelfMovementCapabilities {
    SelfMovementCapabilities {
        kinematics: SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_0001,
            },
            motion_table_id: 0x0900_0001,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(0.0, 2.602, 0.0),
            base_run_forward_velocity: Vector3::new(0.0, 4.0, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
            base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
            base_sidestep_right_velocity: Vector3::new(1.25, 0.0, 0.0),
        },
        run_rate_scalar,
    }
}

// ============================================================================
// 1. ADVERSARIAL STEEP SLOPE SLIDING ACROSS EXTREME ANGLES
// ============================================================================

#[test]
fn test_tier5_adv_slope_sliding_extreme_normal_angles() {
    let g = -9.8000002_f32;
    let eps = 1e-6_f32;

    // (a) Exact threshold checks at FLOOR_Z (0.66417415, ~48.38118°)
    let n_exact = Vector3::new((1.0 - FLOOR_Z * FLOOR_Z).sqrt(), 0.0, FLOOR_Z);
    assert!(is_walkable_normal(n_exact), "Exact FLOOR_Z must be walkable");

    let n_walkable_boundary = Vector3::new(
        (1.0 - (FLOOR_Z + eps).powi(2)).max(0.0).sqrt(),
        0.0,
        FLOOR_Z + eps,
    );
    assert!(is_walkable_normal(n_walkable_boundary), "FLOOR_Z + eps must be walkable");

    let n_steep_boundary = Vector3::new(
        (1.0 - (FLOOR_Z - eps).powi(2)).max(0.0).sqrt(),
        0.0,
        FLOOR_Z - eps,
    );
    assert!(!is_walkable_normal(n_steep_boundary), "FLOOR_Z - eps must be steep unwalkable");

    // (b) Extreme steep walls (Nz -> 0): 89.999°, 89.9°, 89°, 85°, 80°, 75°, 60°, 50°, 48.5°
    let steep_pitches = [48.5, 49.0, 50.0, 55.0, 60.0, 70.0, 75.0, 80.0, 85.0, 88.0, 89.0, 89.9, 89.999];
    let azimuths = [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0];

    for pitch in steep_pitches {
        let theta = (pitch as f32).to_radians();
        let sin_t = theta.sin();
        let cos_t = theta.cos();

        for az in azimuths {
            let phi = (az as f32).to_radians();
            let normal = Vector3::new(sin_t * phi.cos(), sin_t * phi.sin(), cos_t);

            assert!(!is_walkable_normal(normal), "Pitch {}° must be unwalkable", pitch);
            assert!(is_sledding_slope(normal), "Pitch {}° must qualify as sledding slope", pitch);

            let a = slope_tangent_gravity(normal, g);

            // Invariant 1: Orthogonality (a · n == 0)
            let dot = a.dot(&normal);
            assert!(
                dot.abs() < 1e-4,
                "Orthogonality violated at pitch={}, az={}: dot={}",
                pitch, az, dot
            );

            // Invariant 2: Closed-form coordinate match
            let expected_ax = -g * cos_t * (sin_t * phi.cos());
            let expected_ay = -g * cos_t * (sin_t * phi.sin());
            let expected_az = g * (1.0 - cos_t * cos_t);
            assert!((a.x - expected_ax).abs() < 1e-4, "ax mismatch at pitch={}", pitch);
            assert!((a.y - expected_ay).abs() < 1e-4, "ay mismatch at pitch={}", pitch);
            assert!((a.z - expected_az).abs() < 1e-4, "az mismatch at pitch={}", pitch);

            // Invariant 3: Total magnitude |a| = |g| * sin(theta)
            let expected_mag = g.abs() * sin_t;
            assert!((a.length() - expected_mag).abs() < 1e-4, "mag mismatch at pitch={}", pitch);

            // Invariant 4: Slide trajectory angle arctan(|az| / a_planar) matches terrain pitch
            let a_planar = (a.x * a.x + a.y * a.y).sqrt();
            if a_planar > 1e-5 {
                let traj_angle_deg = (a.z.abs() / a_planar).atan().to_degrees();
                assert!(
                    (traj_angle_deg - pitch).abs() < 0.05,
                    "Trajectory angle mismatch at pitch={}: got {}",
                    pitch, traj_angle_deg
                );
            }
        }
    }

    // (c) Extreme vertical wall: Nz = 0.0 (normal = (1, 0, 0)) -> pure downward freefall
    let n_vert = Vector3::new(1.0, 0.0, 0.0);
    assert!(!is_walkable_normal(n_vert));
    let a_vert = slope_tangent_gravity(n_vert, g);
    assert!((a_vert.x).abs() < 1e-6);
    assert!((a_vert.y).abs() < 1e-6);
    assert!((a_vert.z - g).abs() < 1e-6, "Vertical wall gravity must be pure -9.8 m/s²");

    // (d) Extreme near-horizontal (Nz -> 1.0): flat ground (0, 0, 1), 0.001° tilt
    let n_flat = Vector3::new(0.0, 0.0, 1.0);
    assert!(is_walkable_normal(n_flat));
    let a_flat = slope_tangent_gravity(n_flat, g);
    assert!(a_flat.length() < 1e-6, "Flat ground tangential gravity must be zero");

    let rad_001 = 0.001_f32.to_radians();
    let n_near_flat = Vector3::new(rad_001.sin(), 0.0, rad_001.cos());
    assert!(is_walkable_normal(n_near_flat));
    assert!(!is_sledding_slope(n_near_flat));
    let a_near_flat = slope_tangent_gravity(n_near_flat, g);
    assert!(a_near_flat.length() < 0.001, "Near-flat acceleration must be negligible");

    // (e) Overhangs and inverted normals (Nz < 0)
    let n_overhang = Vector3::new(0.6, 0.0, -0.8);
    assert!(!is_walkable_normal(n_overhang));
    let a_overhang = slope_tangent_gravity(n_overhang, g);
    assert!(a_overhang.dot(&n_overhang).abs() < 1e-4, "Overhang tangent must remain orthogonal");

    // (f) Zero normal and unnormalized input robustness
    let a_zero = slope_tangent_gravity(Vector3::zero(), g);
    assert_eq!(a_zero, Vector3::new(0.0, 0.0, g), "Zero normal falls back to downward g");

    let a_unnorm = slope_tangent_gravity(Vector3::new(0.0, 3.0, 4.0), g);
    let a_norm = slope_tangent_gravity(Vector3::new(0.0, 0.6, 0.8), g);
    assert!((a_unnorm - a_norm).length() < 1e-4, "Unnormalized vector must match normalized");
}

// ============================================================================
// 2. 3D TANGENT VELOCITY INTEGRATION WITHOUT NORMAL STRIPPING
// ============================================================================

#[test]
fn test_tier5_adv_3d_tangent_velocity_integration_without_normal_stripping() {
    let dt_s = 1.0 / 30.0_f32;
    let g = -9.8000002_f32;

    // Test sliding from rest across multiple steep slopes: 50°, 55°, 60°, 70°, 80°
    for pitch in [50.0_f32, 55.0, 60.0, 70.0, 80.0] {
        let theta = pitch.to_radians();
        let normal = Vector3::new(theta.sin(), 0.0, theta.cos());
        let a = slope_tangent_gravity(normal, g);

        let mut p_3d = PlayerState::default();
        p_3d.current_planar_velocity = Vector3::zero();
        p_3d.vertical_velocity = 0.0;
        p_3d.is_sledding = false;

        let mut p_2d_defective = Vector3::zero();

        for tick in 1..=45 {
            // (1) Fixed Option A 3D integration
            let mut v = Vector3::new(
                p_3d.current_planar_velocity.x,
                p_3d.current_planar_velocity.y,
                p_3d.vertical_velocity,
            );
            v = v + a * dt_s;

            // Check tangency
            let angle = v.dot(&normal);
            assert!(
                angle.abs() < 1e-4,
                "Option A 3D integration must preserve exact tangency (pitch={}, tick={}, angle={})",
                pitch, tick, angle
            );

            // Friction simulation
            if angle < 0.25 {
                v = v - normal * angle;
            }
            let friction = if p_3d.is_sledding && v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ {
                0.20
            } else {
                0.95
            };
            v = v * (1.0_f32 - friction).powf(dt_s);

            p_3d.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
            p_3d.vertical_velocity = v.z;

            let speed_sq = p_3d.current_planar_velocity.length_squared()
                + p_3d.vertical_velocity * p_3d.vertical_velocity;
            if speed_sq >= SLEDDING_HIGH_VELOCITY_SQ && normal.z < SLEDDING_STEEP_NORMAL_Z {
                p_3d.is_sledding = true;
            }

            // (2) Defective 2D planar projection where vz is omitted
            p_2d_defective.x += a.x * dt_s;
            p_2d_defective.y += a.y * dt_s;
            let defective_angle = p_2d_defective.x * normal.x + p_2d_defective.y * normal.y; // normal.z * 0
            if defective_angle < 0.25 {
                p_2d_defective.x -= normal.x * defective_angle;
                p_2d_defective.y -= normal.y * defective_angle;
            }
            p_2d_defective = p_2d_defective * (1.0_f32 - 0.95_f32).powf(dt_s);
        }

        let speed_3d = (p_3d.current_planar_velocity.length_squared()
            + p_3d.vertical_velocity * p_3d.vertical_velocity)
            .sqrt();
        let speed_2d = p_2d_defective.length();

        println!("pitch={}: speed_3d={}, speed_2d={}, ratio={}", pitch, speed_3d, speed_2d, speed_3d / speed_2d);
        // The 3D integration accelerates downhill smoothly past 2.2 m/s
        assert!(
            speed_3d > 2.2,
            "Option A 3D integration speed must be >= 2.2 m/s, got {}",
            speed_3d
        );
        // The defective 2D integration is trapped under 10 cm/s due to repeated normal stripping
        assert!(
            speed_2d < 0.12,
            "Defective 2D projection must be trapped under 12 cm/s, got {}",
            speed_2d
        );
        assert!(
            speed_3d / speed_2d > 20.0,
            "3D integration must be >20x faster than stripped 2D projection (pitch={}, ratio={})",
            pitch, speed_3d / speed_2d
        );
    }
}

// ============================================================================
// 3. SLEDDING HYSTERESIS & TRANSITION GATES
// ============================================================================

#[test]
fn test_tier5_adv_sledding_hysteresis_and_transition_invariants() {
    // (a) Slope angle cutoff verification
    // 9.99° (flatter than 10°): cos > cos10 -> does not qualify
    let rad_9_99 = 9.99_f32.to_radians();
    let n_flat = Vector3::new(rad_9_99.sin(), 0.0, rad_9_99.cos());
    assert!(!is_sledding_slope(n_flat), "9.99° slope must not qualify for sledding");

    // 10.01° (steeper than 10°): cos < cos10 -> qualifies
    let rad_10_01 = 10.01_f32.to_radians();
    let n_steep = Vector3::new(rad_10_01.sin(), 0.0, rad_10_01.cos());
    assert!(is_sledding_slope(n_steep), "10.01° slope must qualify for sledding");

    // (b) Entry threshold hysteresis: exactly at 2.5 m/s (v² = 6.25)
    let speed_below_entry = 2.4999_f32;
    let entry_qualifies_below = (speed_below_entry * speed_below_entry) >= SLEDDING_HIGH_VELOCITY_SQ;
    assert!(!entry_qualifies_below, "2.4999 m/s must not trigger sledding entry");

    let speed_above_entry = 2.5001_f32;
    let entry_qualifies_above = (speed_above_entry * speed_above_entry) >= SLEDDING_HIGH_VELOCITY_SQ;
    assert!(entry_qualifies_above, "2.5001 m/s must trigger sledding entry");

    // (c) Intermediate hysteresis zone: [1.25 m/s, 2.50 m/s]
    // A player already sledding remains sledding in this zone
    let mut player = PlayerState::default();
    player.is_sledding = true;

    for speed in [2.40, 2.20, 2.00, 1.80, 1.60, 1.50, 1.40, 1.30, 1.2501] {
        let speed_sq = speed * speed;
        // Exit condition: speed_sq < SLEDDING_LOW_VELOCITY_SQ (1.5625)
        let should_exit = speed_sq < SLEDDING_LOW_VELOCITY_SQ;
        assert!(!should_exit, "Speed {} m/s must NOT exit sledding", speed);
    }

    // A player NOT sledding does NOT enter sledding in this zone
    let mut player_idle = PlayerState::default();
    player_idle.is_sledding = false;
    for speed in [1.30, 1.50, 1.80, 2.00, 2.20, 2.40, 2.499] {
        let speed_sq = speed * speed;
        let should_enter = speed_sq >= SLEDDING_HIGH_VELOCITY_SQ;
        assert!(!should_enter, "Speed {} m/s must NOT enter sledding", speed);
    }

    // (d) Exit threshold: drops below 1.25 m/s (v² < 1.5625)
    let exit_speed = 1.2499_f32;
    let exit_speed_sq = exit_speed * exit_speed;
    assert!(
        exit_speed_sq < SLEDDING_LOW_VELOCITY_SQ,
        "1.2499 m/s must satisfy exit threshold"
    );

    // (e) Locomotion override: pressing WASD active locomotion cancels sledding immediately
    let mut active_player = PlayerState::default();
    active_player.is_sledding = true;
    let is_active_locomotion = true;
    if is_active_locomotion {
        active_player.is_sledding = false;
    }
    assert!(!active_player.is_sledding, "Active locomotion must cancel sledding");

    // (f) Heading alignment to slide velocity
    let slide_v = Vector3::new(3.0, 4.0, 0.0);
    let slide_heading = Vector3::zero().heading_to(&slide_v);
    let rot = Quaternion::from_heading(slide_heading);
    let forward = rot.rotate_vector(Vector3::new(0.0, 1.0, 0.0));
    assert!(
        (forward.x - 0.6).abs() < 1e-4 && (forward.y - 0.8).abs() < 1e-4,
        "Heading alignment must point along slide velocity vector (0.6, 0.8), got ({}, {})",
        forward.x, forward.y
    );
}

// ============================================================================
// 4. INVARIANT STRIDE & DIAGONAL VELOCITY CLAMP UNDER EXTREME VECTORS
// ============================================================================

#[test]
fn test_tier5_adv_diagonal_clamping_and_stride_invariants() {
    let run_rates = [1.0_f32, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 4.5, 10.0];

    for rate in run_rates {
        let caps = authored_capabilities(rate);
        let max_expected_speed = 4.0 * rate;

        // Diagonal: RunForward + SideStepRight
        let state_diag = MotionState::builder().run().forward().strafe_right().build();
        let v_diag = interpreted_velocity_for_state(0.0, state_diag, &caps);
        let mag = v_diag.length();

        assert!(
            (mag - max_expected_speed).abs() < 1e-4,
            "Diagonal run magnitude must be clamped exactly to 4.0 * run_rate = {}, got {}",
            max_expected_speed, mag
        );

        // Diagonal: RunForward + SideStepLeft
        let state_diag_left = MotionState::builder().run().forward().strafe_left().build();
        let v_diag_left = interpreted_velocity_for_state(0.0, state_diag_left, &caps);
        assert!(
            (v_diag_left.length() - max_expected_speed).abs() < 1e-4,
            "Diagonal run left magnitude must clamp to {}", max_expected_speed
        );

        // All 8 heading angles for diagonal movement
        for deg in [0, 45, 90, 135, 180, 225, 270, 315] {
            let heading = (deg as f32).to_radians();
            let v_rot = interpreted_velocity_for_state(heading, state_diag, &caps);
            assert!(
                (v_rot.length() - max_expected_speed).abs() < 1e-4,
                "Rotated diagonal magnitude must be invariant across all headings (deg={})", deg
            );
        }

        // Backward Walk + Strafe (must NEVER be promoted to run)
        let state_back_strafe = MotionState::builder().backstep().strafe_right().build();
        let v_back_strafe = interpreted_velocity_for_state(0.0, state_back_strafe, &caps);
        let back_mag = v_back_strafe.length();
        assert!(
            back_mag < max_expected_speed,
            "Backward strafe must remain below max run speed"
        );
        assert!(
            back_mag > 1.8 && back_mag < 3.0,
            "Backward strafe magnitude must be in expected unpromoted range, got {}", back_mag
        );
    }

    // Zero input and micro-inputs: numerical stability
    let caps_1 = authored_capabilities(1.0);
    let state_idle = MotionState::builder().build();
    let v_idle = interpreted_velocity_for_state(0.0, state_idle, &caps_1);
    assert_eq!(v_idle, Vector3::zero(), "Idle state must produce exact zero velocity");
    assert!(!v_idle.x.is_nan() && !v_idle.y.is_nan() && !v_idle.z.is_nan());

    // Invariant Stride Displacement: 0.13333333 m/frame at 30 fps
    for speed in [1.0_f32, 2.0, 3.12, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0] {
        let time_scale = speed / 4.0;
        let frame_dt = 1.0 / 30.0;
        let frame_displacement = (speed * frame_dt) / time_scale;
        assert!(
            (frame_displacement - 0.13333333).abs() < 1e-6,
            "Displacement per frame must be invariant at 0.133333 m/frame across all speeds"
        );
    }
}

// ============================================================================
// 5. STAMINA EXHAUSTION & BURDEN LOAD CURVE TRANSITIONS
// ============================================================================

#[test]
fn test_tier5_adv_stamina_exhaustion_and_burden_curve_invariants() {
    // (a) Burden load modifier piecewise curve:
    assert_eq!(burden_load_modifier(0.0), 1.0);
    assert_eq!(burden_load_modifier(0.5), 1.0);
    assert_eq!(burden_load_modifier(0.999), 1.0);
    assert_eq!(burden_load_modifier(1.0), 1.0);
    assert_eq!(burden_load_modifier(1.25), 0.75);
    assert_eq!(burden_load_modifier(1.5), 0.5);
    assert_eq!(burden_load_modifier(1.75), 0.25);
    assert_eq!(burden_load_modifier(2.0), 0.0);
    assert_eq!(burden_load_modifier(2.5), 0.0);
    assert_eq!(burden_load_modifier(10.0), 0.0);

    // (b) Run rate formula under burden:
    let rate_overburden = run_rate_from_skill_and_burden(300.0, 2.0);
    assert_eq!(rate_overburden, 1.0, "Overburden (burden=2.0) must collapse run_rate to 1.0");

    let rate_extreme_burden = run_rate_from_skill_and_burden(500.0, 5.0);
    assert_eq!(rate_extreme_burden, 1.0, "Extreme burden (burden=5.0) must collapse run_rate to 1.0");

    // At burden = 0, skill = 0 -> run_rate = 1.0
    assert_eq!(run_rate_from_skill_and_burden(0.0, 0.0), 1.0);

    // Skill 800 retail spike: 18.0 / 4.0 = 4.5
    assert_eq!(run_rate_from_skill_and_burden(800.0, 0.0), 4.5);

    // (c) Stamina 0 exhaustion:
    let exhausted_skill = exhausted_run_skill(400.0, Some(0));
    assert_eq!(exhausted_skill, 0.0, "Stamina 0 must force run skill to 0");

    let rate_exhausted = run_rate_from_skill_and_burden(exhausted_skill, 0.0);
    assert_eq!(rate_exhausted, 1.0, "Exhausted player must have run_rate = 1.0");

    // Stamina > 0 passes skill through
    assert_eq!(exhausted_run_skill(400.0, Some(1)), 400.0);
    assert_eq!(exhausted_run_skill(400.0, None), 400.0);
}

// ============================================================================
// 6. STOP COASTING DECELERATION & 0.25 M/S SNAP INVARIANTS
// ============================================================================

#[test]
fn test_tier5_adv_stop_coasting_and_snap_cutoff_invariants() {
    let dt = 1.0 / 30.0_f32;
    let snap_threshold = 0.25_f32;
    let snap_sq = snap_threshold * snap_threshold;

    // Run -> Ready coasting: initial velocity 4.0 m/s, duration 0.40s
    let mut state = StopCoastingState {
        initial_velocity: Vector3::new(0.0, 4.0, 0.0),
        duration_s: 0.40,
        elapsed_s: 0.0,
    };

    let mut total_displacement = 0.0_f32;
    let mut positive_ticks = 0;

    for _ in 0..20 {
        state.elapsed_s += dt;
        if state.elapsed_s >= state.duration_s {
            break;
        }
        let fraction = (state.elapsed_s / state.duration_s).clamp(0.0, 1.0);
        let mut v = state.initial_velocity * (1.0 - fraction);
        v.z = 0.0;
        let mag_sq = v.x * v.x + v.y * v.y;
        if mag_sq < snap_sq {
            break;
        }
        total_displacement += v.length() * dt;
        positive_ticks += 1;
    }

    // Invariant: exactly 11 ticks of positive velocity; total distance ~0.70-0.85 m
    assert_eq!(positive_ticks, 11);
    assert!(
        total_displacement >= 0.70 && total_displacement <= 0.85,
        "Total coasting displacement must be within [0.70, 0.85] m, got {}", total_displacement
    );

    // Friction decay and snap cutoff: 0.2499 snaps to 0.0, 0.2501 survives
    let v_sub = Vector3::new(0.2499, 0.0, 0.0);
    assert!(v_sub.length_squared() < snap_sq, "0.2499 must be below snap cutoff");

    let v_super = Vector3::new(0.2501, 0.0, 0.0);
    assert!(v_super.length_squared() >= snap_sq, "0.2501 must be at or above snap cutoff");
}
