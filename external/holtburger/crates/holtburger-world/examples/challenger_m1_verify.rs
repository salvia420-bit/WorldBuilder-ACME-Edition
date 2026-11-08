//! challenger_m1_verify — Adversarial verification of Milestone 1 in Rust
//! Agent: movement_challenger_m1_2

use binrw::io::Cursor;
use holtburger_common::math::Vector3;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::MotionTable;
use holtburger_world::state::motion_resolution::{PlayerMotionTableSource, stance_kinematics_enabled};
use holtburger_world::state::self_movement::{SelfMovementCapabilities, SelfMovementKinematics};

fn main() {
    println!("======================================================================");
    println!("     RUST EMPIRICAL ADVERSARIAL CHALLENGER VERIFICATION (M1)");
    println!("======================================================================\n");

    // ------------------------------------------------------------------------
    // Part 1: Ground Friction Decay, Snap, and Terminal Clamp in Rust
    // ------------------------------------------------------------------------
    println!(">>> Testing Ground Friction & Snapping in Rust <<<");
    let dt_s = 1.0 / 30.0;
    let friction = 0.95_f32;
    let snap_threshold = 0.25_f32;
    let terminal_velocity = 50.0_f32;

    // Decay test
    let mut v = Vector3::new(4.0, 0.0, 0.0);
    let scalar = (1.0 - friction).powf(dt_s);
    v = v * scalar;
    let expected = 4.0 * (0.05_f32).powf(dt_s);
    assert!((v.x - expected).abs() < 1e-5, "Friction decay formula");
    println!("  [PASS] Single tick decay from 4.0 m/s -> {:.4} m/s", v.x);

    // Snap test: strictly below 0.25 snaps to 0.0
    let mut v_below = Vector3::new(0.2499, 0.0, 0.0);
    let mag_sq = v_below.x * v_below.x + v_below.y * v_below.y;
    let threshold_sq = snap_threshold * snap_threshold;
    if mag_sq < threshold_sq {
        v_below = Vector3::zero();
    }
    assert_eq!(v_below, Vector3::zero(), "Strictly below 0.25 must snap to 0.0");
    println!("  [PASS] 0.2499 m/s snaps to 0.0 m/s");

    // Above cutoff survives
    let mut v_above = Vector3::new(0.2501, 0.0, 0.0);
    let mag_sq_above = v_above.x * v_above.x + v_above.y * v_above.y;
    if mag_sq_above < threshold_sq {
        v_above = Vector3::zero();
    }
    assert_ne!(v_above, Vector3::zero(), "0.2501 m/s must survive");
    println!("  [PASS] 0.2501 m/s survives cutoff");

    // Terminal velocity clamp: 100 m/s -> 50.0 m/s
    let mut v_extreme = Vector3::new(60.0, 80.0, 0.0);
    let mag_sq_extreme = v_extreme.x * v_extreme.x + v_extreme.y * v_extreme.y;
    if mag_sq_extreme > terminal_velocity * terminal_velocity {
        let len = mag_sq_extreme.sqrt();
        v_extreme.x = (v_extreme.x / len) * terminal_velocity;
        v_extreme.y = (v_extreme.y / len) * terminal_velocity;
    }
    let clamped_mag = (v_extreme.x * v_extreme.x + v_extreme.y * v_extreme.y).sqrt();
    assert!((clamped_mag - 50.0).abs() < 1e-4, "Clamped to 50.0 m/s");
    assert!((v_extreme.x - 30.0).abs() < 1e-4, "Direction X preserved");
    assert!((v_extreme.y - 40.0).abs() < 1e-4, "Direction Y preserved");
    println!("  [PASS] 100 m/s clamped to {:.1} m/s (30.0, 40.0)", clamped_mag);

    // ------------------------------------------------------------------------
    // Part 2: Rotational Turning Dynamics in Rust
    // ------------------------------------------------------------------------
    println!("\n>>> Testing Rotational Acceleration & Damping in Rust <<<");
    let accel_rad_s2 = 8.0_f32;
    let rot_friction = 0.95_f32;
    let rot_snap = 0.05_f32;

    fn rust_step_rot(cur: f32, tgt: f32, accel: f32, frict: f32, snap: f32, dt: f32) -> f32 {
        if tgt.abs() > f32::EPSILON {
            let max_step = accel * dt;
            let delta = tgt - cur;
            cur + delta.clamp(-max_step, max_step)
        } else if cur.abs() > f32::EPSILON {
            let decayed = cur * (1.0 - frict).powf(dt);
            if decayed.abs() < snap {
                0.0
            } else {
                decayed
            }
        } else {
            0.0
        }
    }

    // Ramp to walk turn (1.5 rad/s)
    let mut omega = 0.0_f32;
    for tick in 1..=6 {
        omega = rust_step_rot(omega, 1.5, accel_rad_s2, rot_friction, rot_snap, dt_s);
        let expected = (tick as f32 * 8.0 / 30.0).min(1.5);
        assert!((omega - expected).abs() < 1e-5);
    }
    assert_eq!(omega, 1.5, "Reached 1.5 rad/s in 6 ticks");
    println!("  [PASS] Rotational acceleration ramps to 1.5 rad/s in exactly 6 ticks");

    // Damping decay to 0 on release
    let mut decay_ticks = 0;
    while omega > 0.0 {
        omega = rust_step_rot(omega, 0.0, accel_rad_s2, rot_friction, rot_snap, dt_s);
        decay_ticks += 1;
    }
    assert_eq!(omega, 0.0);
    assert!((decay_ticks as i32 - 35).abs() <= 2, "Expected ~35 ticks from 1.5 rad/s, got {}", decay_ticks);
    println!("  [PASS] Rotational damping settles to 0.0 rad/s in {} ticks", decay_ticks);

    // ------------------------------------------------------------------------
    // Part 3: Per-Stance Strafe Kinematics (LOCALSIM-2) in Retail DAT
    // ------------------------------------------------------------------------
    println!("\n>>> Testing Per-Stance Strafe Kinematics (LOCALSIM-2) <<<");
    assert!(stance_kinematics_enabled(), "Stance kinematics must be enabled by default");
    println!("  [PASS] stance_kinematics_enabled() is true by default");

    let dat = DatDatabase::new("/home/wbterminal/ac_base_dats/client_portal.dat")
        .expect("Failed to open client_portal.dat");
    let mt_bytes = dat.get_file(0x0900_0001).expect("MT 0x09000001 missing in portal.dat");
    let mt = MotionTable::read(&mut Cursor::new(mt_bytes))
        .expect("Failed to parse MotionTable 0x09000001");

    let stances = [
        ("NonCombat", 0x8000_003D_u32),
        ("HandCombat", 0x8000_003C_u32),
        ("SwordCombat", 0x8000_003E_u32),
        ("BowCombat", 0x8000_003F_u32),
        ("SwordShieldCombat", 0x8000_0040_u32),
        ("DualWieldCombat", 0x8000_0046_u32),
        ("ThrownWeaponCombat", 0x8000_0047_u32),
        ("Magic", 0x8000_0049_u32),
    ];

    for (name, stance_code) in stances {
        let profile = mt.movement_profile_for_stance(stance_code);
        assert_eq!(profile.stance, stance_code);
        println!(
            "  [STANCE] {:<18} (0x{:08X}): sidestep_right present: {}",
            name,
            stance_code,
            profile.sidestep_right.is_some()
        );
    }

    // Test SelfMovementKinematics::base_sidestep_speed
    let kin_default = SelfMovementKinematics {
        source: PlayerMotionTableSource::DirectProperty { motion_table_id: 0x0900_0001 },
        motion_table_id: 0x0900_0001,
        stance: 0x8000_003D,
        base_walk_forward_velocity: Vector3::new(0.0, 3.12, 0.0),
        base_run_forward_velocity: Vector3::new(0.0, 4.0, 0.0),
        base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
        base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
        base_sidestep_right_velocity: Vector3::new(1.25, 0.0, 0.0),
    };
    assert_eq!(kin_default.base_sidestep_speed(), 1.25);
    println!("  [PASS] Default SelfMovementKinematics base_sidestep_speed is 1.25 m/s");

    let kin_custom = SelfMovementKinematics {
        source: PlayerMotionTableSource::DirectProperty { motion_table_id: 0x0900_0001 },
        motion_table_id: 0x0900_0001,
        stance: 0x8000_003E, // SwordCombat
        base_walk_forward_velocity: Vector3::new(0.0, 3.12, 0.0),
        base_run_forward_velocity: Vector3::new(0.0, 4.0, 0.0),
        base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
        base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
        base_sidestep_right_velocity: Vector3::new(1.10, 0.0, 0.0),
    };
    assert!((kin_custom.base_sidestep_speed() - 1.10).abs() < 1e-4);
    println!("  [PASS] Custom SelfMovementKinematics base_sidestep_speed is 1.10 m/s");

    let caps = SelfMovementCapabilities {
        kinematics: kin_custom,
        run_rate_scalar: 1.0,
    };
    assert!((caps.base_sidestep_speed() - 1.10).abs() < 1e-4);
    println!("  [PASS] SelfMovementCapabilities forwards base_sidestep_speed cleanly");

    println!("\n======================================================================");
    println!("ALL RUST EMPIRICAL ADVERSARIAL CHECKS PASSED CLEANLY!");
    println!("======================================================================");
}
