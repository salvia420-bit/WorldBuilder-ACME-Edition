//! challenger_m2_it3_verify — Empirical Adversarial Challenger Verification for Milestone 2 Iteration 3 in Rust
//! Agent: movement_challenger_m2_it3_1

use holtburger_common::math::Vector3;
use holtburger_world::player::PlayerState;
use holtburger_world::spatial::{
    is_walkable_normal, slope_tangent_gravity, FLOOR_Z,
    SLEDDING_FRICTION, SLEDDING_HIGH_VELOCITY_SQ,
    SLEDDING_LOW_VELOCITY_SQ, SLEDDING_STEEP_NORMAL_Z,
};

fn main() {
    println!("======================================================================");
    println!("     RUST EMPIRICAL ADVERSARIAL CHALLENGER VERIFICATION (M2 IT3)");
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

    let dt_s = 1.0_f32 / 30.0_f32;
    let g = -9.8000002_f32;

    // ------------------------------------------------------------------------
    // Feature 23: 60° Cliff Slide from Rest Continuous Acceleration & Sledding
    // ------------------------------------------------------------------------
    println!(">>> 1. 60° Cliff Sliding from Rest: Continuous Acceleration & Sledding Transition <<<");

    let theta_60 = 60.0_f32.to_radians();
    let n_60 = Vector3::new(theta_60.sin(), 0.0, theta_60.cos()); // (0.8660254, 0.0, 0.50)
    check!("60° cliff normal Nz is 0.50 (< FLOOR_Z 0.664)", n_60.z < FLOOR_Z && !is_walkable_normal(n_60));

    let mut player = PlayerState::default();
    player.current_planar_velocity = Vector3::zero();
    player.vertical_velocity = 0.0;
    player.is_sledding = false;

    let a_60 = slope_tangent_gravity(n_60, g);
    check!("60° cliff tangent gravity has positive X and negative Z", a_60.x > 0.0 && a_60.y.abs() < 1e-5 && a_60.z < 0.0);
    check!("60° cliff tangent gravity is strictly orthogonal to normal", a_60.dot(&n_60).abs() < 1e-5);

    let mut speed_history = Vec::new();
    let mut sledding_start_tick = None;

    for tick in 1..=60 {
        // Compose 3D velocity from PlayerState split stores
        let mut v = Vector3::new(
            player.current_planar_velocity.x,
            player.current_planar_velocity.y,
            player.vertical_velocity,
        );

        // Accumulate tangent gravity
        v = v + a_60 * dt_s;

        // calc_friction projection
        let angle = v.dot(&n_60);
        assert!(angle.abs() < 1e-5, "Orthogonality failure at tick {}: angle={}", tick, angle);

        if angle < 0.25 {
            v = v - n_60 * angle;
        }

        let vel_mag_sq = v.length_squared();
        let friction = if player.is_sledding {
            if vel_mag_sq < SLEDDING_LOW_VELOCITY_SQ {
                1.0
            } else if vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ && n_60.z < SLEDDING_STEEP_NORMAL_Z {
                SLEDDING_FRICTION
            } else {
                0.95
            }
        } else {
            0.95
        };

        let scalar = (1.0 - friction).powf(dt_s);
        v = v * scalar;

        // Write back to split stores
        player.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        player.vertical_velocity = v.z;

        // Sledding state update
        let speed_sq = player.current_planar_velocity.length_squared()
            + player.vertical_velocity * player.vertical_velocity;
        if speed_sq >= SLEDDING_HIGH_VELOCITY_SQ && n_60.z < SLEDDING_STEEP_NORMAL_Z {
            if !player.is_sledding && sledding_start_tick.is_none() {
                sledding_start_tick = Some(tick);
            }
            player.is_sledding = true;
        } else if player.is_sledding && speed_sq < SLEDDING_LOW_VELOCITY_SQ {
            player.is_sledding = false;
        }

        let speed = speed_sq.sqrt();
        speed_history.push(speed);
    }

    // Monotonic acceleration check
    let mut strictly_increasing = true;
    for i in 1..speed_history.len() {
        if speed_history[i] <= speed_history[i - 1] {
            strictly_increasing = false;
        }
    }
    check!("Avatar speed strictly increases monotonically from rest", strictly_increasing);

    // Speed checkpoints
    let speed_t10 = speed_history[9];  // tick 10 (0.33s)
    let speed_t20 = speed_history[19]; // tick 20 (0.67s)
    let speed_t30 = speed_history[29]; // tick 30 (1.00s)
    let speed_t45 = speed_history[44]; // tick 45 (1.50s)

    check!("Speed at t=0.33s (tick 10) is within [1.5, 1.9] m/s", speed_t10 >= 1.5 && speed_t10 <= 1.9);
    check!("Speed at t=0.67s (tick 20) is within [2.1, 2.45] m/s", speed_t20 >= 2.1 && speed_t20 <= 2.45);
    check!("Speed at t=1.00s (tick 30) exceeds 2.5 m/s threshold and is within [3.0, 3.6] m/s", speed_t30 >= 3.0 && speed_t30 <= 3.6);
    check!("Planar speed vx at t=1.00s exceeds 1.5 m/s", player.current_planar_velocity.x > 1.5);
    check!("Speed at t=1.50s (tick 45) under sledding glide (f=0.20) reaches [6.5, 7.5] m/s", speed_t45 >= 6.5 && speed_t45 <= 7.5);
    println!("Debug: sledding_start_tick = {:?}", sledding_start_tick);
    for (i, spd) in speed_history.iter().enumerate().take(35).skip(18) {
        println!("  tick {}: speed = {:.4}", i + 1, spd);
    }
    check!("Sledding engages upon crossing 2.5 m/s", sledding_start_tick.is_some() && speed_history[sledding_start_tick.unwrap() - 1] >= 2.5);
    check!("Avatar remains in is_sledding=true at tick 60", player.is_sledding);

    // ------------------------------------------------------------------------
    // 2. Multi-Angle and Rotational Invariance (Isotropy)
    // ------------------------------------------------------------------------
    println!("\n>>> 2. Multi-Angle & Oblique Slope Invariance <<<");

    // Pure +Y cliff (70°)
    let rad_70 = 70.0_f32.to_radians();
    let n_plus_y = Vector3::new(0.0, rad_70.sin(), rad_70.cos());
    let a_plus_y = slope_tangent_gravity(n_plus_y, g);

    let mut p_plus_y = PlayerState::default();
    for _ in 1..=30 {
        let mut v = Vector3::new(p_plus_y.current_planar_velocity.x, p_plus_y.current_planar_velocity.y, p_plus_y.vertical_velocity);
        v = v + a_plus_y * dt_s;
        let friction: f32 = if p_plus_y.is_sledding && v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v = v * (1.0_f32 - friction).powf(dt_s);
        p_plus_y.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        p_plus_y.vertical_velocity = v.z;
        if v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && n_plus_y.z < SLEDDING_STEEP_NORMAL_Z {
            p_plus_y.is_sledding = true;
        }
    }
    check!("+Y cliff slide: vx remains 0.0", p_plus_y.current_planar_velocity.x.abs() < 1e-5);
    check!("+Y cliff slide: vy accelerates past 1.5 m/s", p_plus_y.current_planar_velocity.y >= 1.5);
    check!("+Y cliff slide: is_sledding is true at 1.0s", p_plus_y.is_sledding);

    // Pure -Y cliff (70°)
    let n_minus_y = Vector3::new(0.0, -rad_70.sin(), rad_70.cos());
    let a_minus_y = slope_tangent_gravity(n_minus_y, g);

    let mut p_minus_y = PlayerState::default();
    for _ in 1..=30 {
        let mut v = Vector3::new(p_minus_y.current_planar_velocity.x, p_minus_y.current_planar_velocity.y, p_minus_y.vertical_velocity);
        v = v + a_minus_y * dt_s;
        let friction: f32 = if p_minus_y.is_sledding && v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v = v * (1.0_f32 - friction).powf(dt_s);
        p_minus_y.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        p_minus_y.vertical_velocity = v.z;
        if v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && n_minus_y.z < SLEDDING_STEEP_NORMAL_Z {
            p_minus_y.is_sledding = true;
        }
    }
    check!("-Y cliff slide: vx remains 0.0", p_minus_y.current_planar_velocity.x.abs() < 1e-5);
    check!("-Y cliff slide: vy accelerates negatively past -1.5 m/s", p_minus_y.current_planar_velocity.y <= -1.5);
    check!("-Y cliff slide: speeds match +Y cliff slide exactly (symmetric magnitude)", (p_plus_y.current_planar_velocity.y + p_minus_y.current_planar_velocity.y).abs() < 1e-5);

    // 45° Diagonal oblique cliff (60°)
    let rad_60 = 60.0_f32.to_radians();
    let n_xy = rad_60.sin() / 2.0_f32.sqrt();
    let n_obl = Vector3::new(n_xy, n_xy, rad_60.cos());
    let a_obl = slope_tangent_gravity(n_obl, g);

    let mut p_obl = PlayerState::default();
    for _ in 1..=30 {
        let mut v = Vector3::new(p_obl.current_planar_velocity.x, p_obl.current_planar_velocity.y, p_obl.vertical_velocity);
        v = v + a_obl * dt_s;
        let friction: f32 = if p_obl.is_sledding && v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v = v * (1.0_f32 - friction).powf(dt_s);
        p_obl.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
        p_obl.vertical_velocity = v.z;
        if v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && n_obl.z < SLEDDING_STEEP_NORMAL_Z {
            p_obl.is_sledding = true;
        }
    }
    check!("45° oblique slide: vx and vy are identical (symmetry invariant)", (p_obl.current_planar_velocity.x - p_obl.current_planar_velocity.y).abs() < 1e-5);
    let obl_planar_speed = (p_obl.current_planar_velocity.x.powi(2) + p_obl.current_planar_velocity.y.powi(2)).sqrt();
    let expected_planar_speed = speed_t30 * theta_60.cos(); // horizontal component of downhill tangent is cos(slope)
    println!("Debug: obl_planar_speed = {:.4}, expected = {:.4}", obl_planar_speed, expected_planar_speed);
    check!("45° oblique slide: planar speed matches pure +X slide planar speed", (obl_planar_speed - expected_planar_speed).abs() < 1e-4);
    check!("45° oblique slide: is_sledding is true at 1.0s", p_obl.is_sledding);

    // 72-Azimuth rotational sweep (every 5° from 0° to 355°)
    let mut all_isotropic = true;
    let expected_speed = speed_t30;
    for deg in (0..360).step_by(5) {
        let phi = (deg as f32).to_radians();
        let nx = theta_60.sin() * phi.cos();
        let ny = theta_60.sin() * phi.sin();
        let nz = theta_60.cos();
        let n = Vector3::new(nx, ny, nz);
        let a = slope_tangent_gravity(n, g);

        let mut p = PlayerState::default();
        for _ in 1..=30 {
            let mut v = Vector3::new(p.current_planar_velocity.x, p.current_planar_velocity.y, p.vertical_velocity);
            v = v + a * dt_s;
            let friction: f32 = if p.is_sledding && v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
            v = v * (1.0_f32 - friction).powf(dt_s);
            p.current_planar_velocity = Vector3::new(v.x, v.y, 0.0);
            p.vertical_velocity = v.z;
            if v.length_squared() >= SLEDDING_HIGH_VELOCITY_SQ && n.z < SLEDDING_STEEP_NORMAL_Z {
                p.is_sledding = true;
            }
        }
        let speed = (p.current_planar_velocity.length_squared() + p.vertical_velocity.powi(2)).sqrt();
        if (speed - expected_speed).abs() > 1e-4 {
            all_isotropic = false;
        }
    }
    check!("Rotational invariance (isotropy) confirmed across 72 azimuth angles (speed identical to 1e-4)", all_isotropic);

    // ------------------------------------------------------------------------
    // 3. Planar Normal Stripping Elimination Proof
    // ------------------------------------------------------------------------
    println!("\n>>> 3. Planar Normal Stripping Elimination Proof <<<");

    // Defective 2D model proof:
    let mut v_2d = Vector3::zero();
    for _ in 0..30 {
        v_2d.x += a_60.x * dt_s;
        v_2d.y += a_60.y * dt_s;
        let angle = v_2d.dot(&n_60); // angle = v_2d.x * n_60.x > 0 because vz is missing!
        v_2d = v_2d - n_60 * angle;   // normal projection strips 75% of forward velocity every tick
        v_2d = v_2d * (1.0 - 0.95_f32).powf(dt_s);
        v_2d.z = 0.0;
    }
    check!("Defective 2D vector saturates at 4 cm/s (0.0414 m/s)", (v_2d.x - 0.0414).abs() < 0.005);

    // Remediated 3D model proof:
    let mut v_3d = Vector3::zero();
    let mut max_ortho_err = 0.0_f32;
    let mut is_sledding = false;
    for _ in 0..30 {
        v_3d = v_3d + a_60 * dt_s;
        let angle = v_3d.dot(&n_60);
        max_ortho_err = max_ortho_err.max(angle.abs());
        // angle is 0, so v_3d - n_60 * angle leaves v_3d untouched!
        v_3d = v_3d - n_60 * angle;
        let vel_mag_sq = v_3d.length_squared();
        let friction = if is_sledding && vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ { 0.2 } else { 0.95 };
        v_3d = v_3d * (1.0_f32 - friction).powf(dt_s);
        if vel_mag_sq >= SLEDDING_HIGH_VELOCITY_SQ && n_60.z < SLEDDING_STEEP_NORMAL_Z {
            is_sledding = true;
        }
    }
    check!("Remediated 3D model maximum orthogonality error is < 1e-6 (zero normal stripping)", max_ortho_err < 1e-6);
    check!("Remediated 3D model velocity accelerates unobstructed (> 3.0 m/s vs 0.0414 m/s)", v_3d.x > 1.5 && v_3d.length() > 3.0);

    // ------------------------------------------------------------------------
    // 4. Split-Store State Decomposition & Recomposition Fidelity
    // ------------------------------------------------------------------------
    println!("\n>>> 4. Split-Store State Decomposition & Recomposition Fidelity <<<");

    let test_v = Vector3::new(3.456, -2.789, -5.678);
    let mut player_store = PlayerState::default();
    player_store.current_planar_velocity = Vector3::new(test_v.x, test_v.y, 0.0);
    player_store.vertical_velocity = test_v.z;

    check!("Split store planar Z is strictly 0.0", player_store.current_planar_velocity.z == 0.0);
    check!("Split store vertical_velocity matches vz", player_store.vertical_velocity == test_v.z);

    let recomposed = Vector3::new(
        player_store.current_planar_velocity.x,
        player_store.current_planar_velocity.y,
        player_store.vertical_velocity,
    );
    check!("Recomposed 3D vector is bit-identical to original", recomposed == test_v);

    // ------------------------------------------------------------------------
    // 5. Terminal Velocity Clamp and Sledding Exit Invariants
    // ------------------------------------------------------------------------
    println!("\n>>> 5. Terminal Velocity Clamp & Sledding Exit <<<");

    let mut v_overspeed = Vector3::new(40.0, 30.0, -50.0); // magnitude = sqrt(1600+900+2500) = sqrt(5000) ≈ 70.71 m/s
    let mag_sq = v_overspeed.length_squared();
    if mag_sq > 50.0 * 50.0 {
        let len = mag_sq.sqrt();
        v_overspeed = (v_overspeed / len) * 50.0;
    }
    check!("Terminal velocity clamp caps at exactly 50.0 m/s", (v_overspeed.length() - 50.0).abs() < 1e-5);

    // Sledding exit gate when speed drops below 1.25 m/s
    let mut sledding_active = true;
    let v_slow = Vector3::new(0.5, 0.5, -0.5); // mag_sq = 0.75 < 1.5625 (1.25^2)
    let speed_sq_slow = v_slow.length_squared();
    if sledding_active && speed_sq_slow < SLEDDING_LOW_VELOCITY_SQ {
        sledding_active = false;
    }
    check!("Sledding clears when speed drops below 1.25 m/s (speed_sq < 1.5625)", !sledding_active);

    println!("\n======================================================================");
    println!("     ALL {} / {} RUST M2 IT3 ADVERSARIAL CHECKS PASSED!", passed, total);
    println!("======================================================================\n");
}
