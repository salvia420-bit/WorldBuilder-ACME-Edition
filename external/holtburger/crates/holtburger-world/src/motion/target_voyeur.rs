//! MoveTo refactor phase G (2026-10-10) — retail `TargetManager` target
//! tracking for a MoveTo (DEC:327974-328690), as one mover's view of one
//! target.
//!
//! Retail does not hand a chasing MoveToManager the target's live pose every
//! frame. The mover registers as a VOYEUR on the target (`SetTarget(0, id,
//! 0.5, 0.5)` → the target's `AddVoyeur`, :328574 / :328300), and the target
//! sends it a `TargetInfo`:
//! - at once when the voyeur is added (`AddVoyeur`'s answer);
//! - then, from `HandleTargetting` (every 0.5 s, :328458), whenever its
//!   PREDICTED position — `pos + cached_velocity × quantum`
//!   (`GetInterpolatedPosition` :328131; `cached_velocity` is the realized
//!   transition offset ÷ quantum, `UpdateObjectInternal` :322815) — has moved
//!   more than the voyeur radius (0.5) from the last one it sent
//!   (`CheckAndUpdateVoyeur` :328158).
//!
//! The mover tunes the lead: `HandleMoveToPosition`'s tail (:345695-345707)
//! sets the quantum to `distance / |own cached_velocity|` when that is more
//! than 1 s off the current one, so the target reports where it will be when
//! the mover gets there. `MoveToManager::HandleUpdateTarget` (:346051)
//! consumes each update (the type-6 progress-stamp reset).
//!
//! The 10 s `TimedOut` status (`HandleTargetting` :328463) fires only when no
//! answer EVER arrived (`status == Undef`); a target the client cannot
//! resolve is already the 0x37 cancel in the drivers, so it is not modelled.

use holtburger_common::Guid;
use holtburger_common::Vector3;
use holtburger_common::position::WorldPosition;
use web_time::Instant;

/// `TargetManager::SetTarget` radius for a MoveTo / StickTo (DEC:345553).
pub const VOYEUR_RADIUS_M: f32 = 0.5;
/// The initial lead quantum (s) and the `HandleTargetting` cadence.
pub const VOYEUR_QUANTUM_S: f32 = 0.5;
/// `HandleMoveToPosition` re-tunes the quantum only when it is off by more
/// than this (s).
pub const VOYEUR_QUANTUM_SLACK_S: f32 = 1.0;
/// Below this own speed (m/s) the quantum is left alone (:345700).
pub const VOYEUR_MIN_SPEED: f32 = 0.1;

/// One mover's voyeur registration on one target.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetVoyeur {
    target: Guid,
    quantum: f32,
    last_sent: Option<WorldPosition>,
    last_check: Option<Instant>,
}

impl TargetVoyeur {
    pub fn new(target: Guid) -> Self {
        Self {
            target,
            quantum: VOYEUR_QUANTUM_S,
            last_sent: None,
            last_check: None,
        }
    }

    pub fn target(&self) -> Guid {
        self.target
    }

    pub fn quantum(&self) -> f32 {
        self.quantum
    }

    /// The last position the target reported (`TargetInfo`
    /// `interpolated_position`) — what the MoveTo steers at.
    pub fn reported(&self) -> Option<WorldPosition> {
        self.last_sent
    }

    /// One frame of the target's side for this voyeur: `Some(position)`
    /// when the target sends an update this instant (the first answer, or a
    /// `HandleTargetting` pass whose prediction moved past the radius).
    pub fn poll(
        &mut self,
        now: Instant,
        target_pose: WorldPosition,
        target_velocity: Vector3,
    ) -> Option<WorldPosition> {
        let predicted = predict(target_pose, target_velocity, self.quantum);
        let Some(last_sent) = self.last_sent else {
            self.last_sent = Some(predicted);
            self.last_check = Some(now);
            return Some(predicted);
        };
        if self
            .last_check
            .is_some_and(|t| now.saturating_duration_since(t).as_secs_f32() < VOYEUR_QUANTUM_S)
        {
            return None;
        }
        self.last_check = Some(now);
        if predicted.distance_to(&last_sent) > VOYEUR_RADIUS_M {
            self.last_sent = Some(predicted);
            return Some(predicted);
        }
        None
    }

    /// `HandleMoveToPosition`'s tail (:345695-345707): lead the target by
    /// the mover's time to get there, when that is more than a second off.
    pub fn tune_quantum(&mut self, distance: f32, own_speed: f32) {
        if !(own_speed.is_finite() && own_speed > VOYEUR_MIN_SPEED && distance.is_finite()) {
            return;
        }
        let eta = distance / own_speed;
        if (eta - self.quantum).abs() > VOYEUR_QUANTUM_SLACK_S {
            self.quantum = eta;
        }
    }
}

/// `TargetManager::GetInterpolatedPosition` (:328131): the target's
/// position advanced by its realized velocity over `quantum`.
fn predict(pose: WorldPosition, velocity: Vector3, quantum: f32) -> WorldPosition {
    if !(velocity.x.is_finite() && velocity.y.is_finite() && velocity.z.is_finite()) {
        return pose;
    }
    let mut out = pose;
    out.coords = out.coords + velocity * quantum;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Quaternion;
    use std::time::Duration;

    fn at(x: f32, y: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::identity(),
        }
    }

    /// The first poll answers at once; a stationary target then never
    /// re-sends; a moving one re-sends at most every 0.5 s and only past
    /// the 0.5 m radius.
    #[test]
    fn answers_once_then_at_the_targetting_cadence() {
        let t0 = Instant::now();
        let mut voyeur = TargetVoyeur::new(Guid(0x8000_0001));
        assert_eq!(voyeur.poll(t0, at(10.0, 0.0), Vector3::zero()), Some(at(10.0, 0.0)));
        // Stationary: nothing, ever.
        for i in 1..30 {
            let now = t0 + Duration::from_millis(100 * i);
            assert_eq!(voyeur.poll(now, at(10.0, 0.0), Vector3::zero()), None);
        }
        // Moved 0.4 m: inside the radius.
        let t1 = t0 + Duration::from_secs(4);
        assert_eq!(voyeur.poll(t1, at(10.4, 0.0), Vector3::zero()), None);
        // Moved 0.6 m but within 0.5 s of the last check: wait.
        let t2 = t1 + Duration::from_millis(200);
        assert_eq!(voyeur.poll(t2, at(10.6, 0.0), Vector3::zero()), None);
        // The next HandleTargetting pass sends it.
        let t3 = t1 + Duration::from_millis(500);
        assert_eq!(voyeur.poll(t3, at(10.6, 0.0), Vector3::zero()), Some(at(10.6, 0.0)));
        assert_eq!(voyeur.reported(), Some(at(10.6, 0.0)));
    }

    /// The report leads the target by its realized velocity × the quantum,
    /// and the mover re-tunes the quantum to its time to get there.
    #[test]
    fn leads_by_velocity_times_the_tuned_quantum() {
        let t0 = Instant::now();
        let mut voyeur = TargetVoyeur::new(Guid(0x8000_0001));
        let reported = voyeur.poll(t0, at(10.0, 0.0), Vector3::new(0.0, 4.0, 0.0)).unwrap();
        assert!((reported.coords.y - 4.0 * VOYEUR_QUANTUM_S).abs() < 1e-5);
        // 20 m at 4 m/s → 5 s, more than 1 s off 0.5: re-tuned.
        voyeur.tune_quantum(20.0, 4.0);
        assert!((voyeur.quantum() - 5.0).abs() < 1e-5);
        // 22 m → 5.5 s: within the slack, kept.
        voyeur.tune_quantum(22.0, 4.0);
        assert!((voyeur.quantum() - 5.0).abs() < 1e-5);
        // Standing still: kept.
        voyeur.tune_quantum(2.0, 0.05);
        assert!((voyeur.quantum() - 5.0).abs() < 1e-5);
        let t1 = t0 + Duration::from_millis(500);
        let reported = voyeur.poll(t1, at(10.0, 1.0), Vector3::new(0.0, 4.0, 0.0)).unwrap();
        assert!((reported.coords.y - (1.0 + 4.0 * 5.0)).abs() < 1e-4, "{reported:?}");
    }
}
