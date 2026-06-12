//! Faithful retail `PositionManager::InterpolateTo` / `ConstrainTo`
//! reconciliation easing curve for the LOCAL player's force-position
//! updates.
//!
//! This is the 1:1 port of the per-frame `adjust_offset` velocity /
//! duration model that retail runs every physics tick once an
//! `InterpolateTo` has installed a target. It replaces the gap-4
//! single-step linear constraint-pull (`constrain_local_pose_toward`)
//! when the [`crate::spatial::scene::USE_RETAIL_INTERPOLATE`] flag is on.
//!
//! ## Retail / ACE provenance
//!
//! - `SmartBox::HandleReceivedPosition` (acclient.c 144717-145227) is
//!   where the curve enters. For the LOCAL player on a non-teleport
//!   force-position with `has_contact`, retail installs BOTH
//!   `CPhysicsObj::ConstrainTo(pos, start, max)` AND
//!   `CPhysicsObj::InterpolateTo(pos, keepHeading)` (acclient.c
//!   145210-145218). These are NOT per-message pulls — they install
//!   stateful managers that run every frame.
//! - `InterpolationManager::InterpolateTo` (acclient.c 8267 /
//!   ACE `Managers/InterpolationManager.cs:36-84`) queues the target
//!   `PositionType` node (snapping to a single node here — the
//!   force-position case always queues exactly one) and, when the gap is
//!   inside the autonomy-blip radius but above the `0.05 m` deadband,
//!   leaves it for the per-frame `adjust_offset` to ease toward.
//! - `InterpolationManager::adjust_offset`
//!   (ACE `Managers/InterpolationManager.cs:199-258`) is the per-frame
//!   easing curve this module ports:
//!     * deadband `< 0.05 m` → `NodeCompleted` (stop interpolating);
//!     * `maxSpeed = get_adjusted_max_speed() * 2.0`, floored to
//!       `MaxInterpolatedVelocity = 7.5` when `< EPSILON`
//!       (acclient.c 41536, `InterpolationManager.cs:214-224`);
//!     * a 5-frame progress window that re-evaluates `OriginalDistance`
//!       and fails the node when convergence stalls
//!       (`delta / ProgressQuantum / maxSpeed < 0.3`,
//!       `InterpolationManager.cs:226-257`);
//!     * the per-frame step is the offset toward the target, clamped to
//!       `maxQuantum = maxSpeed * quantum`
//!       (`InterpolationManager.cs:240-248`);
//!     * `KeepHeading` zeroes the heading component of the offset
//!       (`InterpolationManager.cs:250-251`).
//! - `ConstraintManager::adjust_offset`
//!   (ACE `Managers/ConstraintManager.cs:62-77`) then scales that offset
//!   down as the running constraint offset crosses `start_distance` and
//!   clamps it to zero past `max_distance` — the leash that keeps the
//!   interpolation from running away past the forced pose.
//! - `PhysicsObj::UpdatePositionInternal`
//!   (ACE `PhysicsObj.cs:1862-1884`) combines the resulting offset frame
//!   into `Position.Frame` each tick; here the caller adds the stepped
//!   origin onto the working pose directly.
//!
//! `quantum` is retail's per-frame physics `dt` in seconds.

use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use holtburger_common::math::Vector3;

/// `InterpolationManager::MaxInterpolatedVelocity`
/// (acclient.c 41536 `const float MAX_INTERPOLATED_VELOCITY = 7.5`,
/// ACE `InterpolationManager.cs:19`). Used as the `maxSpeed` floor when
/// the motion-interp speed resolves to ~0.
pub const MAX_INTERPOLATED_VELOCITY: f32 = 7.5;

/// `InterpolationManager` deadband — once the working pose is within
/// `0.05 m` of the target the node completes and we stop interpolating
/// (ACE `InterpolationManager.cs:48,209,244`).
pub const RECONCILE_DEADBAND_M: f32 = 0.05;

/// `PhysicsGlobals.EPSILON` (ACE `PhysicsGlobals.cs`).
const EPSILON: f32 = 1e-4;

/// Number of frames in the progress-evaluation window
/// (`InterpolationManager.cs:230` `FrameCounter < 5`).
const PROGRESS_WINDOW_FRAMES: i32 = 5;

/// Minimum fraction of `maxSpeed` the interpolation must be closing the
/// gap at over the 5-frame window or the node fails
/// (`InterpolationManager.cs:231` `... / maxSpeed >= 0.3f`).
const MIN_PROGRESS_RATIO: f32 = 0.3;

/// Outcome of a single per-frame [`RetailForcePositionInterpolator::step`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InterpStep {
    /// No node installed — nothing to interpolate. The pose is unchanged.
    Idle,
    /// The node is still being eased toward; `pose` is the new working
    /// pose for this frame.
    Progressed { pose: WorldPosition },
    /// The node completed (reached the deadband). `pose` is the final
    /// working pose; the interpolator has stopped (subsequent steps are
    /// `Idle` until another target is installed).
    Completed { pose: WorldPosition },
    /// The node failed its progress check (convergence stalled). `pose`
    /// is the pre-step working pose, unchanged; the interpolator has
    /// stopped. Retail leaves the pose for the next force-position /
    /// `UseTime` blip to correct.
    Failed { pose: WorldPosition },
}

/// Stateful per-body force-position interpolator. One instance lives on
/// the LOCAL player's [`crate::spatial::SpatialBody`]; it carries the
/// `InterpolationManager` + `ConstraintManager` fields that retail keeps
/// across frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetailForcePositionInterpolator {
    /// The single queued `PositionType` node (the forced pose). `None`
    /// when not interpolating.
    target: Option<WorldPosition>,
    /// `InterpolationManager::KeepHeading` — when set, the heading offset
    /// is zeroed so the integrator keeps owning heading.
    keep_heading: bool,
    /// `InterpolationManager::OriginalDistance` — the gap distance at the
    /// start of the current 5-frame progress window. Seeded to the
    /// install-time gap; re-seeded every 5 frames.
    original_distance: f32,
    /// `InterpolationManager::FrameCounter`.
    frame_counter: i32,
    /// `InterpolationManager::ProgressQuantum` — accumulated `quantum`
    /// over the current progress window.
    progress_quantum: f32,

    // --- ConstraintManager fields (ACE ConstraintManager.cs) ---
    /// `ConstraintManager::ConstraintDistanceStart`.
    constraint_start: f32,
    /// `ConstraintManager::ConstraintDistanceMax`.
    constraint_max: f32,
    /// `ConstraintManager::ConstraintPosOffset` — running offset length,
    /// re-evaluated each frame from the applied step.
    constraint_pos_offset: f32,
    /// Whether a constraint is installed (`ConstraintManager::IsConstrained`).
    constrained: bool,
}

impl Default for RetailForcePositionInterpolator {
    fn default() -> Self {
        Self {
            target: None,
            keep_heading: false,
            // ACE seeds OriginalDistance to LargeDistance (999999) when
            // idle; we use the install gap and only matter while a target
            // is queued.
            original_distance: 0.0,
            frame_counter: 0,
            progress_quantum: 0.0,
            constraint_start: 0.0,
            constraint_max: 0.0,
            constraint_pos_offset: 0.0,
            constrained: false,
        }
    }
}

impl RetailForcePositionInterpolator {
    /// `true` once a target is queued and being eased toward.
    pub fn is_interpolating(&self) -> bool {
        self.target.is_some()
    }

    /// The currently-queued target, if any.
    pub fn target(&self) -> Option<WorldPosition> {
        self.target
    }

    /// `InterpolationManager::StopInterpolating` (ACE
    /// `InterpolationManager.cs:133-140`) + `ConstraintManager::Unconstrain`.
    pub fn stop(&mut self) {
        *self = Self::default();
    }

    /// Install both managers for a LOCAL-player force-position, mirroring
    /// the `ConstrainTo` + `InterpolateTo` pair retail issues at
    /// acclient.c 145210-145218.
    ///
    /// `current` is the working pose at install time, `target` the forced
    /// pose. `start_distance` / `max_distance` are the constraint leash
    /// distances (`GetStartConstraintDistance` /
    /// `GetMaxConstraintDistance`). `keep_heading` mirrors the cmdinterp's
    /// `keepHeading` query (acclient.c 145216).
    ///
    /// Returns `false` (and installs nothing) when the gap is already
    /// inside the deadband — retail's `InterpolateTo` calls
    /// `StopInterpolating` there (ACE `InterpolationManager.cs:67-73`).
    pub fn install(
        &mut self,
        current: WorldPosition,
        target: WorldPosition,
        start_distance: f32,
        max_distance: f32,
        keep_heading: bool,
    ) -> bool {
        let dist = current.distance_to(&target);
        if dist <= RECONCILE_DEADBAND_M {
            // Already there — `InterpolateTo` stops interpolating, and if
            // not keeping heading snaps heading (the caller records the
            // forced rotation in the authoritative pose regardless).
            self.stop();
            return false;
        }

        // ConstraintManager::ConstrainTo (ACE ConstraintManager.cs:27-35).
        self.constrained = true;
        self.constraint_start = start_distance;
        self.constraint_max = max_distance;
        self.constraint_pos_offset = dist;

        // InterpolationManager::InterpolateTo queues the node and seeds
        // the progress window (ACE InterpolationManager.cs:36-84). For the
        // single-node force-position case OriginalDistance is the gap to
        // the queued node.
        self.target = Some(target);
        self.keep_heading = keep_heading;
        self.original_distance = dist;
        self.frame_counter = 0;
        self.progress_quantum = 0.0;
        true
    }

    /// One per-frame `adjust_offset` step. `current` is this frame's
    /// working pose, `quantum` the frame `dt` in seconds, `max_speed`
    /// the motion-interp `get_adjusted_max_speed() * 2.0` value (floored
    /// to [`MAX_INTERPOLATED_VELOCITY`] when ~0). `on_contact` mirrors
    /// `TransientStateFlags.Contact`: the constraint scaling and the
    /// interp early-out both require contact
    /// (ACE `InterpolationManager.cs:201`, `ConstraintManager.cs:66`).
    ///
    /// Returns the per-frame outcome (see [`InterpStep`]).
    pub fn step(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> InterpStep {
        self.step_ext(current, quantum, max_speed, on_contact, false)
    }

    /// [`Self::step`] with the A2-P3 sticky exemption threaded:
    /// `sticky_active` bypasses the 5-frame progress-test abort while
    /// the owner's sticky target is non-zero (acclient.c:389243-389245
    /// — the sticky term of the keep-interpolating gate, previously
    /// hard-false here). [`Self::step`] delegates with `false` —
    /// byte-identical for every legacy caller.
    pub fn step_ext(
        &mut self,
        current: WorldPosition,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
        sticky_active: bool,
    ) -> InterpStep {
        let Some(target) = self.target else {
            return InterpStep::Idle;
        };

        // InterpolationManager::adjust_offset early-out: no contact → no
        // movement this frame (ACE InterpolationManager.cs:201).
        if !on_contact {
            return InterpStep::Progressed { pose: current };
        }

        let dist = current.distance_to(&target);
        // Deadband: NodeCompleted (ACE InterpolationManager.cs:208-213).
        if dist < RECONCILE_DEADBAND_M {
            self.stop();
            return InterpStep::Completed { pose: current };
        }

        // maxSpeed floor (ACE InterpolationManager.cs:223-224).
        let max_speed = if max_speed < EPSILON {
            MAX_INTERPOLATED_VELOCITY
        } else {
            max_speed
        };

        // Progress window bookkeeping (ACE InterpolationManager.cs:226-228).
        let delta = self.original_distance - dist;
        self.progress_quantum += quantum;
        self.frame_counter += 1;

        // The keep-interpolating gate (ACE InterpolationManager.cs:230-231).
        // A2-P3: the sticky term is now threaded by the facade (it was
        // hard-false pre-P3; force-position alone is never sticky).
        let progressing = delta > EPSILON
            && self.progress_quantum > EPSILON
            && (delta / self.progress_quantum / max_speed) >= MIN_PROGRESS_RATIO;
        let keep_interpolating =
            self.frame_counter < PROGRESS_WINDOW_FRAMES || progressing || sticky_active;

        if !keep_interpolating {
            // Node failed its progress check (ACE InterpolationManager.cs:256-257).
            self.stop();
            return InterpStep::Failed { pose: current };
        }

        // Re-seed the progress window every 5 frames
        // (ACE InterpolationManager.cs:233-238).
        if self.frame_counter >= PROGRESS_WINDOW_FRAMES {
            self.frame_counter = 0;
            self.progress_quantum = 0.0;
            self.original_distance = dist;
        }

        // Build the offset toward the target, capped at maxQuantum
        // (ACE InterpolationManager.cs:240-248).
        let from = current.global_coords();
        let to = target.global_coords();
        let mut offset = to - from;
        let distance = offset.length();

        if distance <= RECONCILE_DEADBAND_M {
            // ACE calls NodeCompleted but still applies the (tiny) offset
            // below; with a single node this lands us on the target.
            self.stop();
            let pose = reproject_global_into(to, target);
            return InterpStep::Completed { pose };
        }

        let max_quantum = max_speed * quantum;
        if distance > max_quantum {
            offset = offset * (max_quantum / distance);
        }

        // ConstraintManager::adjust_offset scales the offset down as the
        // running constraint offset crosses `start`, and zeroes it past
        // `max` (ACE ConstraintManager.cs:62-77). on_contact is already
        // guaranteed here.
        if self.constrained {
            if self.constraint_pos_offset < self.constraint_max {
                if self.constraint_pos_offset > self.constraint_start {
                    let span = self.constraint_max - self.constraint_start;
                    if span > EPSILON {
                        let scale = (self.constraint_max - self.constraint_pos_offset) / span;
                        offset = offset * scale;
                    }
                }
            } else {
                offset = Vector3::zero();
            }
            // The running offset re-evaluates to this frame's applied step
            // length (ConstraintManager.cs:76).
            self.constraint_pos_offset = offset.length();
        }

        let stepped_global = from + offset;
        let pose = reproject_global_into(stepped_global, target);
        // KeepHeading keeps the integrator's working heading (ACE
        // InterpolationManager.cs:250-251); otherwise the rotation eases
        // toward the target heading by this frame's progress fraction.
        let rotation = if self.keep_heading {
            current.rotation
        } else {
            let progress = (max_speed * quantum) / distance.max(1e-6);
            slerp_rotation(current.rotation, target.rotation, progress.min(1.0))
        };
        let pose = WorldPosition { rotation, ..pose };
        InterpStep::Progressed { pose }
    }
}

/// Shortest-path spherical linear interpolation between two quaternions by
/// fraction `t` in [0,1]. Used by `step` to ease heading toward the target
/// when `keep_heading` is false (shared with the A2-P1
/// [`crate::spatial::position_manager`] queue path).
pub(crate) fn slerp_rotation(
    from: holtburger_common::math::Quaternion,
    to: holtburger_common::math::Quaternion,
    t: f32,
) -> holtburger_common::math::Quaternion {
    use holtburger_common::math::Quaternion;
    let mut dot = from.w * to.w + from.x * to.x + from.y * to.y + from.z * to.z;
    let mut to = to;
    if dot < 0.0 {
        to = Quaternion { w: -to.w, x: -to.x, y: -to.y, z: -to.z };
        dot = -dot;
    }
    dot = dot.clamp(-1.0, 1.0);
    let theta = dot.acos();
    let sin_theta = theta.sin();
    if sin_theta < 1e-6 {
        return Quaternion {
            w: from.w + t * (to.w - from.w),
            x: from.x + t * (to.x - from.x),
            y: from.y + t * (to.y - from.y),
            z: from.z + t * (to.z - from.z),
        };
    }
    let w0 = ((1.0 - t) * theta).sin() / sin_theta;
    let w1 = (t * theta).sin() / sin_theta;
    Quaternion {
        w: from.w * w0 + to.w * w1,
        x: from.x * w0 + to.x * w1,
        y: from.y * w0 + to.y * w1,
        z: from.z * w0 + to.z * w1,
    }
}

/// Re-express a global-space point in `reference`'s landblock so the
/// stepped pose keeps reporting the landblock the server forced us into
/// mid-correction (the server already told us the destination block).
fn reproject_global_into(global: Vector3, reference: WorldPosition) -> WorldPosition {
    let (lb_x, lb_y) = reference.landblock_coords();
    let local = Vector3::new(
        global.x - (lb_x as f32 * METERS_PER_LANDBLOCK),
        global.y - (lb_y as f32 * METERS_PER_LANDBLOCK),
        global.z,
    );
    WorldPosition {
        landblock_id: reference.landblock_id,
        coords: local,
        rotation: reference.rotation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::guid::Guid;
    use holtburger_common::math::Quaternion;

    fn lb() -> Guid {
        // Outdoor landblock (cell == 0).
        Guid(0x00A9_B400 & 0xFFFF_0000)
    }

    fn pose(x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: lb(),
            coords: Vector3::new(x, y, z),
            rotation: Quaternion::from_heading(0.0),
        }
    }

    // Retail outdoor player leash: start 10, max 100 (the autonomy-blip
    // radius is the gate the caller applies before installing). A typical
    // player adjusted max-speed: run_rate 4.5 → get_adjusted_max_speed =
    // 4.5*4 = 18; *2 = 36 m/s. We use that throughout.
    const MAX_SPEED: f32 = 36.0;
    const START: f32 = 10.0;
    const MAX: f32 = 100.0;

    #[test]
    fn install_inside_deadband_is_noop() {
        let mut interp = RetailForcePositionInterpolator::default();
        let installed =
            interp.install(pose(10.0, 10.02, 0.0), pose(10.0, 10.0, 0.0), START, MAX, true);
        assert!(!installed, "2 cm gap is inside the 0.05 m deadband");
        assert!(!interp.is_interpolating());
    }

    #[test]
    fn install_above_deadband_queues_target() {
        let mut interp = RetailForcePositionInterpolator::default();
        let installed =
            interp.install(pose(53.0, 50.0, 0.0), pose(50.0, 50.0, 0.0), START, MAX, true);
        assert!(installed);
        assert!(interp.is_interpolating());
        assert_eq!(interp.target(), Some(pose(50.0, 50.0, 0.0)));
    }

    #[test]
    fn step_without_target_is_idle() {
        let mut interp = RetailForcePositionInterpolator::default();
        let out = interp.step(pose(0.0, 0.0, 0.0), 0.016, MAX_SPEED, true);
        assert_eq!(out, InterpStep::Idle);
    }

    #[test]
    fn step_caps_distance_at_max_quantum_per_frame() {
        // 3 m gap, 36 m/s, 16 ms frame → maxQuantum = 0.576 m. The first
        // step should move ~0.576 m toward the target, not collapse it.
        let mut interp = RetailForcePositionInterpolator::default();
        let start = pose(53.0, 50.0, 0.0);
        let target = pose(50.0, 50.0, 0.0);
        interp.install(start, target, START, MAX, true);

        let out = interp.step(start, 0.016, MAX_SPEED, true);
        let new_pose = match out {
            InterpStep::Progressed { pose } => pose,
            other => panic!("expected progress, got {other:?}"),
        };
        let moved = start.distance_to(&new_pose);
        let expected = MAX_SPEED * 0.016; // 0.576
        assert!(
            (moved - expected).abs() < 1e-3,
            "first step should move ~maxQuantum ({expected}), moved {moved}"
        );
        // Moved toward the target, not past it.
        assert!(new_pose.distance_to(&target) < start.distance_to(&target));
        assert!(interp.is_interpolating(), "still > deadband, keep going");
    }

    #[test]
    fn step_converges_into_deadband_over_frames_and_completes() {
        // 3 m gap eased at 36 m/s in 16 ms frames converges in a handful
        // of frames and completes once inside the 0.05 m deadband.
        let mut interp = RetailForcePositionInterpolator::default();
        let target = pose(50.0, 50.0, 0.0);
        let mut cur = pose(53.0, 50.0, 0.0);
        interp.install(cur, target, START, MAX, true);

        let mut completed = false;
        let mut prev_dist = cur.distance_to(&target);
        for _ in 0..30 {
            match interp.step(cur, 0.016, MAX_SPEED, true) {
                InterpStep::Progressed { pose } => {
                    let d = pose.distance_to(&target);
                    assert!(d <= prev_dist + 1e-4, "monotonic convergence");
                    prev_dist = d;
                    cur = pose;
                }
                InterpStep::Completed { pose } => {
                    cur = pose;
                    completed = true;
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert!(completed, "should converge into the deadband and complete");
        assert!(cur.distance_to(&target) < RECONCILE_DEADBAND_M);
        assert!(!interp.is_interpolating(), "stopped after completion");
    }

    #[test]
    fn step_keeps_working_heading_when_keep_heading_set() {
        let mut interp = RetailForcePositionInterpolator::default();
        let mut cur = WorldPosition {
            rotation: Quaternion::from_heading(1.0),
            ..pose(53.0, 50.0, 0.0)
        };
        let target = WorldPosition {
            rotation: Quaternion::from_heading(2.5),
            ..pose(50.0, 50.0, 0.0)
        };
        interp.install(cur, target, START, MAX, true);
        if let InterpStep::Progressed { pose } = interp.step(cur, 0.016, MAX_SPEED, true) {
            // Heading preserved from the working pose, not pulled to the
            // target's heading (KeepHeading zeroes the heading offset).
            assert!((pose.rotation.to_heading() - 1.0).abs() < 1e-3);
            cur = pose;
        } else {
            panic!("expected progress");
        }
        let _ = cur;
    }

    #[test]
    fn step_interpolates_heading_when_keep_heading_false() {
        let mut interp = RetailForcePositionInterpolator::default();
        let working_heading = 0.0_f32;
        let target_heading = std::f32::consts::FRAC_PI_2; // 90°
        let cur = WorldPosition {
            rotation: Quaternion::from_heading(working_heading),
            ..pose(53.0, 50.0, 0.0)
        };
        let target = WorldPosition {
            rotation: Quaternion::from_heading(target_heading),
            ..pose(50.0, 50.0, 0.0)
        };
        // keep_heading=false → rotation eases toward the target.
        interp.install(cur, target, START, MAX, false);
        if let InterpStep::Progressed { pose } = interp.step(cur, 0.016, MAX_SPEED, true) {
            let h = pose.rotation.to_heading();
            assert!(
                h > working_heading && h < target_heading,
                "expected heading interpolated in (0, PI/2), got {h}"
            );
        } else {
            panic!("expected progress");
        }
    }

    #[test]
    fn step_without_contact_holds_pose() {
        let mut interp = RetailForcePositionInterpolator::default();
        let cur = pose(53.0, 50.0, 0.0);
        interp.install(cur, pose(50.0, 50.0, 0.0), START, MAX, true);
        let out = interp.step(cur, 0.016, MAX_SPEED, false);
        assert_eq!(out, InterpStep::Progressed { pose: cur }, "no contact → no move");
        assert!(interp.is_interpolating(), "still queued");
    }

    #[test]
    fn step_floors_zero_max_speed_to_max_interpolated_velocity() {
        // max_speed ~0 → floored to 7.5 m/s. 16 ms frame → 0.12 m step.
        let mut interp = RetailForcePositionInterpolator::default();
        let start = pose(53.0, 50.0, 0.0);
        let target = pose(50.0, 50.0, 0.0);
        interp.install(start, target, START, MAX, true);
        let out = interp.step(start, 0.016, 0.0, true);
        let moved = match out {
            InterpStep::Progressed { pose } => start.distance_to(&pose),
            other => panic!("expected progress, got {other:?}"),
        };
        let expected = MAX_INTERPOLATED_VELOCITY * 0.016; // 0.12
        assert!(
            (moved - expected).abs() < 1e-3,
            "zero max-speed should floor to 7.5 m/s ({expected}), moved {moved}"
        );
    }

    #[test]
    fn constraint_zeroes_step_past_max_distance() {
        // Force the constraint offset to start past max so the constraint
        // scaler zeroes the step (ConstraintManager.cs:73-74).
        let mut interp = RetailForcePositionInterpolator::default();
        let start = pose(20.0, 50.0, 0.0); // 30 m gap, but install caps below blip via caller
        let target = pose(50.0, 50.0, 0.0);
        // Install with a small max so the running offset (30) is already
        // past max (5) → step zeroed.
        interp.install(start, target, 1.0, 5.0, true);
        let out = interp.step(start, 0.016, MAX_SPEED, true);
        match out {
            InterpStep::Progressed { pose } => {
                assert!(
                    start.distance_to(&pose) < 1e-4,
                    "offset zeroed by constraint past max → no movement"
                );
            }
            other => panic!("expected progress, got {other:?}"),
        }
    }

    #[test]
    fn constraint_scales_step_down_in_leash_band() {
        // Running offset between start and max → step scaled by
        // (max - offset) / (max - start) (ConstraintManager.cs:70-71).
        // start=2, max=4, offset(install)=3 → scale = (4-3)/(4-2)=0.5.
        let mut interp = RetailForcePositionInterpolator::default();
        let start = pose(53.0, 50.0, 0.0); // 3 m gap
        let target = pose(50.0, 50.0, 0.0);
        interp.install(start, target, 2.0, 4.0, true);

        // Unconstrained per-frame step would be min(3, 36*0.016=0.576) =
        // 0.576 m. With the 0.5 constraint scale → ~0.288 m.
        let out = interp.step(start, 0.016, MAX_SPEED, true);
        let moved = match out {
            InterpStep::Progressed { pose } => start.distance_to(&pose),
            other => panic!("expected progress, got {other:?}"),
        };
        let unconstrained = MAX_SPEED * 0.016;
        assert!(
            (moved - unconstrained * 0.5).abs() < 1e-3,
            "constraint should halve the step: expected {}, moved {moved}",
            unconstrained * 0.5
        );
    }

    #[test]
    fn stop_clears_state() {
        let mut interp = RetailForcePositionInterpolator::default();
        interp.install(pose(53.0, 50.0, 0.0), pose(50.0, 50.0, 0.0), START, MAX, true);
        assert!(interp.is_interpolating());
        interp.stop();
        assert!(!interp.is_interpolating());
        assert_eq!(interp.target(), None);
        assert_eq!(interp.step(pose(0.0, 0.0, 0.0), 0.016, MAX_SPEED, true), InterpStep::Idle);
    }

    #[test]
    fn step_stays_in_target_landblock() {
        let mut interp = RetailForcePositionInterpolator::default();
        let start = pose(53.0, 50.0, 0.0);
        let target = pose(50.0, 50.0, 0.0);
        interp.install(start, target, START, MAX, true);
        if let InterpStep::Progressed { pose } = interp.step(start, 0.016, MAX_SPEED, true) {
            assert_eq!(pose.landblock_id, target.landblock_id);
        } else {
            panic!("expected progress");
        }
    }
}
