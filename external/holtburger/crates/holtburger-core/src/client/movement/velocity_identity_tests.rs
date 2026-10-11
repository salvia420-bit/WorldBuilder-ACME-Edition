//! MoveTo refactor phase A (2026-10-10): the stage-1 velocity IDENTITY tests
//! that compare the interpreted pipeline (`interpreted_velocity_for_state`,
//! now in `holtburger_world::motion::motion_interp`) against core's legacy
//! `common::local_velocity_for_state`. They moved out of `motion_interp.rs`
//! with the rest of the movement stack but need both sides, so they live in
//! core.

use crate::client::movement_types::{Gait, MotionState};
use holtburger_common::Vector3;
use holtburger_protocol::messages::movement::MotionStance;
use holtburger_world::motion::motion_interp::{
    MAX_SIDESTEP_ANIM_RATE, SIDESTEP_ANIM_SPEED, SIDESTEP_FACTOR, WALK_ANIM_SPEED,
    interpreted_velocity_for_state,
};
use holtburger_world::{PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics};

/// Capabilities with the AUTHORED player MotionTable cycle bases —
/// run 4.000 / walk 2.602 m/s (copied from the `motion_interp` test module).
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
        },
        run_rate_scalar,
    }
}

/// IDENTITY (DESIGN.md §1.4): for every (gait, locomotion, run_rate)
/// cell the interpreted-pipeline ground velocity equals the legacy
/// `local_velocity_for_state` within 1e-5 — the swap is
/// behaviour-preserving where the legacy path was right. This also
/// pins the double-application risk (the interpreted forward speed is
/// ALREADY run-rate-multiplied; multiplying again in the integrator
/// would be the classic 1.9× bug in the other direction).
#[test]
fn identity_interpreted_matches_legacy_local_velocity_for_state() {
    let states = [
        MotionState::builder().forward().build(),
        MotionState::builder().backstep().build(),
        MotionState::builder().strafe_left().build(),
        MotionState::builder().strafe_right().build(),
        MotionState::builder().forward().strafe_right().build(),
        MotionState::builder().backstep().strafe_left().build(),
    ];
    let headings = [0.0_f32, 1.0, 2.5, -2.0];
    for run_rate in [1.0_f32, 1.9166666, 2.65, 4.5] {
        let capabilities = authored_capabilities(run_rate);
        for base in states {
            for gait in [Gait::Walk, Gait::Run] {
                let state = MotionState { gait, ..base };
                for heading in headings {
                    let legacy = super::common::local_velocity_for_state(
                        heading,
                        state,
                        &capabilities,
                    );
                    let interpreted =
                        interpreted_velocity_for_state(heading, state, &capabilities);
                    let dx = (legacy.x - interpreted.x).abs();
                    let dy = (legacy.y - interpreted.y).abs();
                    let dz = (legacy.z - interpreted.z).abs();
                    assert!(
                        dx < 1e-5 && dy < 1e-5 && dz < 1e-5,
                        "identity broke at gait={gait:?} state={state:?} \
                         run_rate={run_rate} heading={heading}: \
                         legacy={legacy:?} interpreted={interpreted:?}"
                    );
                }
            }
        }
    }
}

/// **O6 (parity ledger) — strafe-diagonal closed form.**
///
/// The third parity report measured retail 8.468 m/s vs holtburger
/// 8.362 m/s for the run+strafe diagonal (the only FAIL), alongside
/// run-forward retail 7.895 vs holtburger 7.884. This test pins what
/// OUR OWN constants predict for that same cell, through BOTH live
/// velocity producers, so a future session can tell "the formula is
/// wrong" apart from "the formula never ran".
///
/// Chain (`acclient.c:343746-343803` adjust, `:343439-343483` run
/// scaling, `:343539-343594` state velocity):
///   forward = run_base(4.0) x run_rate
///   sidestep = 1.25 x min(1.248 x run_rate, 3.0)
///   diagonal = hypot(forward, sidestep)   [UNCAPPED on the ground]
#[test]
fn o6_strafe_diagonal_closed_form_matches_retail_capture() {
    // Solve the capture's run_rate from the run-forward realization.
    let run_rate = 7.884_f32 / 4.0; // = 1.971
    let capabilities = authored_capabilities(run_rate);

    let forward_only = interpreted_velocity_for_state(
        0.0,
        MotionState::builder().run().forward().build(),
        &capabilities,
    );
    let diagonal = interpreted_velocity_for_state(
        0.0,
        MotionState::builder().run().forward().strafe_right().build(),
        &capabilities,
    );
    let legacy_diagonal = super::common::local_velocity_for_state(
        0.0,
        MotionState::builder().run().forward().strafe_right().build(),
        &capabilities,
    );

    // The two producers must agree (the stage-1 identity contract).
    assert!(
        (diagonal.length() - legacy_diagonal.length()).abs() < 1e-4,
        "interpreted {} vs legacy {}",
        diagonal.length(),
        legacy_diagonal.length()
    );

    // Forward reproduces the capture exactly, by construction.
    assert!((forward_only.length() - 7.884).abs() < 1e-3);

    // The closed form predicts ~8.462 for that same run_rate.
    let expected = ((4.0_f32 * run_rate).powi(2)
        + (SIDESTEP_ANIM_SPEED
            * (SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED) * run_rate)
                .min(MAX_SIDESTEP_ANIM_RATE))
        .powi(2))
    .sqrt();
    assert!(
        (diagonal.length() - expected).abs() < 1e-3,
        "diagonal {} != closed form {}",
        diagonal.length(),
        expected
    );

    // And that closed form is within tolerance of RETAIL's 8.468 —
    // i.e. the FORMULA is not the O6 defect.
    assert!(
        (expected - 8.468).abs() < 0.05,
        "closed form {expected} should track retail 8.468"
    );
}
