//! MoveTo driver stall recovery (2026-07-20) — BOT-ONLY, NOT a retail port.
//!
//! Deep-trace finding pinned in `academy_wedge_tests.rs` (holtburger-world):
//! the indoor "wedge" (a driven mover freezing at 0.000 m/slice against
//! certain wall/soffit geometry) is retail-FAITHFUL physics — when the
//! movement input is exactly perpendicular to a blocking plane whose slide
//! edge is orthogonal to the input, `slide_sphere` legitimately returns
//! `Blocked` and `validate_transition` reverts the step. A real retail
//! player escapes by jittering/turning their input; our `?wasmPursuit=on`
//! driver ([`super::move_to::MoveToManager`]) drives mathematically pure
//! axis-locked headings (`MoveToSteer::Walk`'s straight bearing to the
//! target), so it can wedge permanently. `move_to.rs` stays an untouched
//! retail port — this module is the engine-side shim's own escape hatch,
//! consumed only by [`super::system::MovementSystem::drive_local_moveto`]
//! (the `USE_MOVETO_DRIVER` LOCAL-player autonomous lane). It has no effect
//! on manual WASD input, which never calls [`MoveToStallRecovery::poll`].
//!
//! State machine (per active MoveTo leg, reset whenever the steered target
//! moves more than [`TARGET_RESET_EPS_M`]):
//!   - DIRECT: accumulate realized per-tick displacement (Euclidean, only
//!     while a `Walk` steer is actually being driven — `poll` is only
//!     called from that arm). Once [`STALL_WINDOW`] consecutive samples are
//!     all below [`STALL_EPS_M`], engage a recovery ATTEMPT.
//!   - ATTEMPT: return a heading offset of ±[`RECOVERY_ANGLE_DEG`] off the
//!     direct bearing (alternating side each new attempt) for
//!     [`RECOVERY_TICKS`] ticks, giving `slide_sphere` a non-orthogonal
//!     input component so it can shear off the blocking plane. Then drop
//!     back to DIRECT with a cleared window, so the next `STALL_WINDOW`
//!     samples judge the attempt on fresh evidence (escaped ⇒ no new
//!     attempt fires; still stuck ⇒ the next attempt flips sides).
//!   - After [`MAX_RECOVERY_ATTEMPTS`] engaged attempts still end in a
//!     detected stall, [`MoveToStallRecovery`] sets a permanent `give_up`
//!     latch and stops intervening — the leg is left to the EXISTING
//!     higher-level failure path (the JS `RynthRouter` per-leg watchdog,
//!     `rynth/router.js` `LEG_TIMEOUT_MS`/`REISSUE_MS`, which already fails
//!     or re-issues a leg that isn't closing distance). No new WeenieError
//!     code is invented here — the directive is never cancelled by this
//!     module; it only perturbs the steering heading fed to the existing
//!     autonomous-drive lane.

use holtburger_common::position::WorldPosition;
use std::collections::VecDeque;
use web_time::Instant;

/// Consecutive realized-displacement samples required (all below
/// [`STALL_EPS_M`]) before a stall is declared. Suggested range 4-6 per the
/// landing spec; 5 splits the difference (fast enough to react inside a
/// single ~150-250ms window at typical tick cadence, slow enough not to
/// fire on ordinary micro-hitches).
const STALL_WINDOW: usize = 5;
/// Per-tick realized displacement (metres) below which a tick counts as
/// "no progress" toward the stall window.
const STALL_EPS_M: f32 = 0.02;
/// Off-bearing heading perturbation applied while a recovery attempt is
/// active (35-55° suggested; 45° is the deep-trace's own prediction for the
/// academy east-west slide edge).
const RECOVERY_ANGLE_DEG: f32 = 45.0;
/// Ticks held per recovery attempt before re-aiming direct to reassess.
const RECOVERY_TICKS: u32 = 3;
/// Engaged-attempt cap before the leg is left to the existing watchdog.
const MAX_RECOVERY_ATTEMPTS: u32 = 4;
/// Steered-target displacement (metres) that resets all state — a new leg
/// (or the same leg's target relocating) gets a clean slate.
const TARGET_RESET_EPS_M: f32 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Attempt {
    /// +1.0 or -1.0 — the side of the direct bearing this attempt steers.
    side: f32,
    /// Ticks remaining before this attempt ends and DIRECT resumes.
    ticks_left: u32,
}

/// Per-leg stall-recovery state, owned by the LOCAL player's MoveTo driver
/// shim (`MovementSystem::moveto_stall`). See the module doc for the state
/// machine.
#[derive(Debug, Clone, Default)]
pub(crate) struct MoveToStallRecovery {
    /// The steered-target pose this state was accumulated against — a
    /// changed target (new leg) resets everything.
    target: Option<WorldPosition>,
    /// The self-pose last seen by [`Self::poll`], for computing this
    /// tick's realized displacement.
    last_pos: Option<WorldPosition>,
    /// Realized per-tick displacement samples, DIRECT-phase only (cleared
    /// whenever an attempt starts or ends so each judgement window is
    /// fresh evidence).
    history: VecDeque<f32>,
    /// The in-progress recovery attempt, if any.
    attempt: Option<Attempt>,
    /// Count of attempts engaged for the CURRENT leg (resets with target).
    attempts_used: u32,
    /// Latched once [`MAX_RECOVERY_ATTEMPTS`] is exceeded — this module
    /// stops perturbing the heading for the rest of the leg.
    give_up: bool,
}

impl MoveToStallRecovery {
    /// One driver-tick update. `self_pos`/`target` are the SAME values the
    /// `MoveToSteer::Walk` arm already computed for this tick; `now` is the
    /// shim's tick clock. Returns the heading offset (RADIANS, signed) to
    /// add to the direct bearing this tick — `0.0` for ordinary direct
    /// steering (no stall detected, mid-cooldown, or given up).
    pub(crate) fn poll(&mut self, self_pos: WorldPosition, target: WorldPosition, now: Instant) -> f32 {
        let _ = now; // reserved: not currently part of the window math (tick-counted, not time-boxed)
        self.note_target(target);

        if self.give_up {
            return 0.0;
        }

        if let Some(prev) = self.last_pos {
            let realized = prev.distance_to(&self_pos);
            self.history.push_back(realized);
            if self.history.len() > STALL_WINDOW {
                self.history.pop_front();
            }
        }
        self.last_pos = Some(self_pos);

        // Engage a fresh attempt when the DIRECT-phase window shows a
        // stall (only checked while no attempt is already running — an
        // in-progress attempt's own ticks don't re-trigger engagement).
        if self.attempt.is_none()
            && self.history.len() >= STALL_WINDOW
            && self.history.iter().all(|&d| d < STALL_EPS_M)
        {
            if self.attempts_used >= MAX_RECOVERY_ATTEMPTS {
                self.give_up = true;
                log::info!(
                    "movement: moveto stall recovery exhausted after {MAX_RECOVERY_ATTEMPTS} attempts, \
                     leaving the leg to the existing MoveTo watchdog",
                );
                return 0.0;
            }
            self.attempts_used += 1;
            // Alternate sides: attempt 1 = +side, 2 = -side, 3 = +side, ...
            let side = if self.attempts_used % 2 == 1 { 1.0 } else { -1.0 };
            self.attempt = Some(Attempt {
                side,
                ticks_left: RECOVERY_TICKS,
            });
            self.history.clear();
            log::info!(
                "movement: moveto stall detected (>= {STALL_WINDOW} ticks < {STALL_EPS_M}m), \
                 engaging recovery attempt {}/{MAX_RECOVERY_ATTEMPTS} side={:+.0}deg",
                self.attempts_used,
                RECOVERY_ANGLE_DEG * side,
            );
        }

        // Drive (or continue driving) the active attempt, if any — the
        // SAME tick that just engaged above falls through here too, so
        // RECOVERY_TICKS counts total off-bearing ticks including the
        // engaging one.
        if let Some(attempt) = self.attempt.as_mut() {
            let offset = RECOVERY_ANGLE_DEG.to_radians() * attempt.side;
            attempt.ticks_left -= 1;
            if attempt.ticks_left == 0 {
                self.attempt = None;
                self.history.clear();
                log::info!(
                    "movement: moveto stall recovery attempt {}/{MAX_RECOVERY_ATTEMPTS} ended, re-aiming direct",
                    self.attempts_used,
                );
            }
            return offset;
        }

        0.0
    }

    /// New leg / relocated target ⇒ clean slate.
    fn note_target(&mut self, target: WorldPosition) {
        let changed = match self.target {
            Some(prev) => prev.distance_to(&target) > TARGET_RESET_EPS_M,
            None => true,
        };
        if changed {
            *self = Self {
                target: Some(target),
                ..Self::default()
            };
        }
    }

    /// Test/diagnostic accessor — is an attempt currently steering
    /// off-bearing?
    #[cfg(test)]
    pub(crate) fn is_recovering(&self) -> bool {
        self.attempt.is_some()
    }

    /// Test/diagnostic accessor — has recovery been exhausted for this leg?
    #[cfg(test)]
    pub(crate) fn has_given_up(&self) -> bool {
        self.give_up
    }

    /// Test/diagnostic accessor — attempts engaged so far this leg.
    #[cfg(test)]
    pub(crate) fn attempts_used(&self) -> u32 {
        self.attempts_used
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::{Guid, Quaternion, Vector3};

    const LB: u32 = 0xA9B4_0001;

    fn pose(x: f32, y: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(LB),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::identity(),
        }
    }

    fn target() -> WorldPosition {
        pose(0.0, 50.0)
    }

    #[test]
    fn steady_progress_never_engages() {
        let mut r = MoveToStallRecovery::default();
        let now = Instant::now();
        for i in 0..20 {
            let offset = r.poll(pose(0.0, i as f32 * 0.3), target(), now);
            assert_eq!(offset, 0.0, "tick {i}: no stall, offset must stay 0");
        }
        assert!(!r.is_recovering());
        assert_eq!(r.attempts_used(), 0);
    }

    #[test]
    fn wedged_pose_engages_after_the_window_and_alternates_sides() {
        let mut r = MoveToStallRecovery::default();
        let now = Instant::now();
        // First sample seeds last_pos (no history yet) — then STALL_WINDOW
        // identical-position ticks fill the window.
        assert_eq!(r.poll(pose(0.0, 10.0), target(), now), 0.0);
        let mut last_offset = 0.0;
        for _ in 0..STALL_WINDOW {
            last_offset = r.poll(pose(0.0, 10.0), target(), now);
        }
        assert!(r.is_recovering(), "must engage once the window fills with zero deltas");
        assert_eq!(r.attempts_used(), 1);
        assert!(
            (last_offset.to_degrees().abs() - RECOVERY_ANGLE_DEG).abs() < 1e-3,
            "offset magnitude must be the recovery angle: {last_offset}"
        );
        let first_side = last_offset.signum();

        // Drain the first attempt's remaining ticks (still wedged — physics
        // doesn't move in this unit test, only the state machine is under
        // test); it should end after RECOVERY_TICKS total offset-ticks.
        for _ in 1..RECOVERY_TICKS {
            let o = r.poll(pose(0.0, 10.0), target(), now);
            assert_eq!(o.signum(), first_side, "same attempt must hold one side");
        }
        assert!(!r.is_recovering(), "attempt must end after RECOVERY_TICKS");

        // Still wedged (position never moved) ⇒ the next STALL_WINDOW
        // direct-phase ticks re-trigger, on the OPPOSITE side.
        let mut second_offset = 0.0;
        for _ in 0..STALL_WINDOW {
            second_offset = r.poll(pose(0.0, 10.0), target(), now);
        }
        assert!(r.is_recovering());
        assert_eq!(r.attempts_used(), 2);
        assert_eq!(
            second_offset.signum(),
            -first_side,
            "attempt 2 must alternate to the opposite side"
        );
    }

    #[test]
    fn recovery_that_actually_moves_the_mover_does_not_re_engage() {
        let mut r = MoveToStallRecovery::default();
        let now = Instant::now();
        // Fill the stall window to engage attempt 1.
        r.poll(pose(0.0, 10.0), target(), now);
        for _ in 0..STALL_WINDOW {
            r.poll(pose(0.0, 10.0), target(), now);
        }
        assert!(r.is_recovering());

        // Simulate the off-axis attempt actually shearing the mover free —
        // position advances every subsequent tick.
        let mut y = 10.0;
        for _ in 0..40 {
            y += 0.3;
            let offset = r.poll(pose(0.0, y), target(), now);
            if !r.is_recovering() && offset == 0.0 {
                // Back in DIRECT phase with real progress — should never
                // re-engage again in this run.
            }
        }
        assert!(!r.has_given_up(), "steady progress after the attempt must never exhaust recovery");
        assert_eq!(r.attempts_used(), 1, "no re-engagement once progress resumes");
    }

    #[test]
    fn exhausting_all_attempts_gives_up_and_stops_perturbing() {
        let mut r = MoveToStallRecovery::default();
        let now = Instant::now();
        r.poll(pose(0.0, 10.0), target(), now);
        // Cycle: MAX_RECOVERY_ATTEMPTS full stall->attempt cycles, mover
        // never actually moves (worst case: recovery doesn't help here).
        for _cycle in 0..MAX_RECOVERY_ATTEMPTS {
            for _ in 0..STALL_WINDOW {
                r.poll(pose(0.0, 10.0), target(), now);
            }
            assert!(r.is_recovering());
            for _ in 1..RECOVERY_TICKS {
                r.poll(pose(0.0, 10.0), target(), now);
            }
            assert!(!r.is_recovering());
        }
        assert_eq!(r.attempts_used(), MAX_RECOVERY_ATTEMPTS);
        assert!(!r.has_given_up(), "not given up until the NEXT stall window re-fires");

        // One more full stall window ⇒ attempts_used already at the cap ⇒
        // give up instead of engaging a 5th attempt.
        let mut offset = -1.0;
        for _ in 0..STALL_WINDOW {
            offset = r.poll(pose(0.0, 10.0), target(), now);
        }
        assert!(r.has_given_up());
        assert!(!r.is_recovering());
        assert_eq!(offset, 0.0);

        // Given up ⇒ permanently inert for the rest of this leg, even if
        // the stall window would otherwise re-fire.
        for _ in 0..10 {
            assert_eq!(r.poll(pose(0.0, 10.0), target(), now), 0.0);
        }
    }

    #[test]
    fn new_leg_target_resets_everything() {
        let mut r = MoveToStallRecovery::default();
        let now = Instant::now();
        r.poll(pose(0.0, 10.0), target(), now);
        for _ in 0..STALL_WINDOW {
            r.poll(pose(0.0, 10.0), target(), now);
        }
        assert!(r.is_recovering());
        assert_eq!(r.attempts_used(), 1);

        // A materially different target (new leg) resets the state even
        // mid-attempt.
        let new_target = pose(100.0, 100.0);
        let offset = r.poll(pose(0.0, 10.0), new_target, now);
        assert_eq!(offset, 0.0);
        assert!(!r.is_recovering());
        assert_eq!(r.attempts_used(), 0);
    }
}
