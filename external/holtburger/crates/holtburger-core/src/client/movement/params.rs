//! A3-D3 (2026-06-12, unified movement pipeline STAGE 3) — runtime
//! `MovementParameters`: the per-call parameter block every
//! `CMotionInterp` / `MoveToManager` entry point takes
//! (`~/ac-headers/acclient.c:339441-339489` ctor; ACE
//! `Physics/Animation/MovementParameters.cs`). The protocol
//! `MoveToParameters` / `TurnToParameters`
//! (`holtburger-protocol/src/messages/movement/messages/motion.rs`) stay
//! the wire codecs; [`MovementParameters::from_wire_moveto`] /
//! [`from_wire_turnto`](MovementParameters::from_wire_turnto) feed the
//! wire `movement_parameters: u32` into [`MovementParameters::bitfield`]
//! verbatim.

use super::motion_interp::{
    MOTION_RUN_FORWARD, MOTION_TURN_RIGHT, MOTION_WALK_BACKWARDS, MOTION_WALK_FORWARD,
};
use holtburger_protocol::messages::movement::messages::motion::{
    MoveToParameters, TurnToParameters,
};

/// A3-D3 driver (2026-06-12) — the retail heading epsilon every
/// degrees-domain comparison in the MoveTo math uses
/// (`0.00019999999`, acclient.c:344740/:345402/:345487 et al.).
pub(crate) const HEADING_EPSILON_DEG: f32 = 0.000_199_999_99;

/// `heading_diff(x, y, motion)` (acclient.c:344738-344752) — DEGREES
/// domain. The signed delta `x − y` folded to `[0, 360)` measured in
/// the direction of `motion`: TurnRight (`0x6500000D`) leaves the
/// positive wrap as-is; any other motion (TurnLeft) mirrors it to
/// `360 − diff`. Sub-epsilon deltas collapse to `0.0`.
pub(crate) fn heading_diff(x: f32, y: f32, motion: u32) -> f32 {
    let mut result = x - y;
    if result.abs() < HEADING_EPSILON_DEG {
        result = 0.0;
    }
    if result < -HEADING_EPSILON_DEG {
        result += 360.0;
    }
    if result > HEADING_EPSILON_DEG && motion != MOTION_TURN_RIGHT {
        result = 360.0 - result;
    }
    result
}

/// `heading_greater(x, y, motion)` (acclient.c:344715-344736) — the
/// turn-arrival overshoot test, DEGREES domain. Shortest-arc compare:
/// within 180° apart it is a plain `x > y`; wrapped further apart the
/// sense inverts. TurnRight returns the "greater" sense; TurnLeft
/// (any non-TurnRight motion) returns the complement.
pub(crate) fn heading_greater(x: f32, y: f32, motion: u32) -> bool {
    let le = if (x - y).abs() <= 180.0 {
        x <= y
    } else {
        y <= x
    };
    if motion == MOTION_TURN_RIGHT { !le } else { le }
}

/// Retail default bitfield, transcribed from the `MovementParameters`
/// ctor literal (`acclient.c:339455-339461`:
/// `bitfield & 0xFFFDEE0F | 0x1EE0F` — the reliable constant is the
/// OR mask `0x1EE0F`): CanWalk|CanRun|CanSideStep|CanWalkBackwards
/// (`0xF`) + MoveTowards|UseSpheres|SetHoldKey (`0xE00`) +
/// ModifyRawState|ModifyInterpretedState|CancelMoveTo|StopCompletely
/// (`0x1E000`). NOTE: ACE's ctor (`MovementParameters.cs:52-71`)
/// additionally sets CanCharge (`0x10`) — a known ACE-vs-decomp delta;
/// the retail literal wins. None of our consumers read bit 4.
pub(crate) const DEFAULT_MOVEMENT_BITFIELD: u32 = 0x0001_EE0F;

/// Runtime `MovementParameters` (`acclient.c:339441-339489`; ACE
/// `MovementParameters.cs`). Field defaults per the retail ctor:
/// `distance_to_object = 0.6` (`0x3F19999A`), `fail_distance = f32::MAX`
/// (`0x7F7FFFFF`), `speed = 1.0`, `walk_run_threshhold = 15.0`
/// (`0x41700000`), everything else zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MovementParameters {
    pub bitfield: u32,
    pub speed: f32,
    /// Wire/raw `HoldKey` value: `0` Invalid, `1` None, `2` Run.
    pub hold_key_to_apply: u32,
    pub context_id: u32,
    pub desired_heading: f32,
    pub distance_to_object: f32,
    pub min_distance: f32,
    pub fail_distance: f32,
    pub walk_run_threshhold: f32,
    pub action_stamp: u32,
}

impl Default for MovementParameters {
    fn default() -> Self {
        Self {
            bitfield: DEFAULT_MOVEMENT_BITFIELD,
            speed: 1.0,
            hold_key_to_apply: 0,
            context_id: 0,
            desired_heading: 0.0,
            distance_to_object: 0.6,
            min_distance: 0.0,
            fail_distance: f32::from_bits(0x7F7F_FFFF),
            walk_run_threshhold: 15.0,
            action_stamp: 0,
        }
    }
}

impl MovementParameters {
    // Named bit accessors. Cites: CancelMoveTo `SBYTE1(bitfield) < 0`
    // (acclient.c:344633), SetHoldKey `BYTE1 & 8` (:344636),
    // ModifyRawState `BYTE1 & 0x20` (:344661), ModifyInterpretedState
    // `BYTE1 & 0x40` (:344012), DisableJumpDuringLink `0x20000`
    // (:343996), Sticky `0x80` (the shipped `moveto_is_sticky` mask),
    // Autonomous `0x1000` (ACE MovementParamFlags).

    /// Bit 15 — `CancelMoveTo`.
    pub(crate) fn cancel_moveto(&self) -> bool {
        self.bitfield & 0x8000 != 0
    }

    /// Bit 11 — `SetHoldKey`.
    pub(crate) fn set_hold_key(&self) -> bool {
        self.bitfield & 0x0800 != 0
    }

    /// Bit 13 — `ModifyRawState`.
    pub(crate) fn modify_raw_state(&self) -> bool {
        self.bitfield & 0x2000 != 0
    }

    /// Bit 14 — `ModifyInterpretedState`.
    pub(crate) fn modify_interpreted_state(&self) -> bool {
        self.bitfield & 0x4000 != 0
    }

    /// Bit 17 — `DisableJumpDuringLink` (jump-charge window).
    pub(crate) fn disable_jump_during_link(&self) -> bool {
        self.bitfield & 0x2_0000 != 0
    }

    /// Bit 7 — `Sticky`.
    #[allow(dead_code)] // staged: A2-P3 sticky owner (W5)
    pub(crate) fn sticky(&self) -> bool {
        self.bitfield & 0x80 != 0
    }

    /// Bit 12 — `Autonomous` (rides into the raw action stamp).
    pub(crate) fn autonomous(&self) -> bool {
        self.bitfield & 0x1000 != 0
    }

    // A3-D3 driver bits (get_command/GetCurrentDistance consumers).
    // Cites: MoveTowards `BYTE1 & 2` = 0x200 / MoveAway `BYTE1 & 1` =
    // 0x100 (acclient.c:346186-346200), UseSpheres `BYTE1 & 4` = 0x400
    // (:344873), ForceRun/CanCharge `& 0x10` + CanRun `& 2` + CanWalk
    // `& 1` in the hold-key rule (:346213-346221), UseFinalHeading
    // `& 0x40` (:345835), StopCompletely `0x10000`
    // (`*((BYTE*)&params+2) & 1`, :345966/:345248).

    /// Bit 9 — `MoveTowards` (0x200).
    pub(crate) fn move_towards(&self) -> bool {
        self.bitfield & 0x200 != 0
    }

    /// Bit 8 — `MoveAway` (0x100).
    pub(crate) fn move_away(&self) -> bool {
        self.bitfield & 0x100 != 0
    }

    /// Bit 10 — `UseSpheres` (0x400): cylinder distance metric.
    pub(crate) fn use_spheres(&self) -> bool {
        self.bitfield & 0x400 != 0
    }

    /// Bit 6 — `UseFinalHeading` (0x40): trailing turn node.
    pub(crate) fn use_final_heading(&self) -> bool {
        self.bitfield & 0x40 != 0
    }

    /// Bit 16 — `StopCompletely` (0x10000): TurnTo* entry stop.
    pub(crate) fn stop_completely(&self) -> bool {
        self.bitfield & 0x1_0000 != 0
    }

    /// `MovementParameters::towards_and_away` (acclient.c:346153-346173)
    /// — the both-bits (MoveTowards|MoveAway) band-following arm.
    /// Spec §7 Q6: transcribed this pass. Inside the band → no command;
    /// closer than `min_distance` (by the heading epsilon) →
    /// WalkBackwards moving-away; beyond `distance_to_object` →
    /// WalkForward towards.
    fn towards_and_away(&self, curr_distance: f32) -> (Option<u32>, bool) {
        if curr_distance <= self.distance_to_object {
            if curr_distance - self.min_distance >= HEADING_EPSILON_DEG {
                (None, false)
            } else {
                (Some(MOTION_WALK_BACKWARDS), true)
            }
        } else {
            (Some(MOTION_WALK_FORWARD), false)
        }
    }

    /// `MovementParameters::get_command` (acclient.c:346175-346222) —
    /// `(command, hold_key, moving_away)`. `curr_heading` (degrees,
    /// already epsilon-folded by the caller) is accepted-and-unused
    /// exactly as the decomp's parameter is. Hold-key rule
    /// (:346213-346221): Run (`2`) iff ForceRun `0x10`, or CanRun `0x2`
    /// with (no CanWalk `0x1`, or the distance excess beyond
    /// `distance_to_object` crosses `walk_run_threshhold`); else
    /// None (`1`).
    pub(crate) fn get_command(
        &self,
        curr_distance: f32,
        _curr_heading: f32,
    ) -> (Option<u32>, u32, bool) {
        let towards = |dist: f32| -> (Option<u32>, bool) {
            if dist > self.distance_to_object {
                (Some(MOTION_WALK_FORWARD), false)
            } else {
                (None, false)
            }
        };
        let (command, moving_away) = if self.move_towards() {
            if self.move_away() {
                self.towards_and_away(curr_distance)
            } else {
                towards(curr_distance)
            }
        } else if !self.move_away() {
            // Neither bit set falls through to the towards arm
            // (LABEL_8, acclient.c:346200-346208).
            towards(curr_distance)
        } else if curr_distance < self.min_distance {
            // Away-only: WalkForward with moving_away set (the 180°
            // aux turn faces the walk away, :346224-346239).
            (Some(MOTION_WALK_FORWARD), true)
        } else {
            (None, false)
        };

        let bits = self.bitfield;
        let hold_key = if bits & 0x10 != 0
            || (bits & 0x2 != 0
                && (bits & 0x1 == 0
                    || curr_distance - self.distance_to_object > self.walk_run_threshhold))
        {
            2
        } else {
            1
        };
        (command, hold_key, moving_away)
    }

    /// `MovementParameters::get_desired_heading(command, moving_away)`
    /// (acclient.c:346224-346239): the walk-direction offset folded
    /// onto the heading-to-target. RunForward (`0x44000007`) /
    /// WalkForward (`0x45000005`) → 180° iff moving away;
    /// WalkBackwards (`0x45000006`) → 180° iff NOT moving away;
    /// anything else → 0°.
    pub(crate) fn get_desired_heading(command: u32, moving_away: bool) -> f32 {
        match command {
            MOTION_RUN_FORWARD | MOTION_WALK_FORWARD => {
                if moving_away {
                    180.0
                } else {
                    0.0
                }
            }
            MOTION_WALK_BACKWARDS => {
                if moving_away {
                    0.0
                } else {
                    180.0
                }
            }
            _ => 0.0,
        }
    }

    /// Hydrate from the wire `MoveTo*` parameter block (`MoveToObject` /
    /// `MoveToPosition`, motion.rs `MoveToParameters`) — the
    /// `movement_parameters: u32` feeds [`Self::bitfield`] verbatim
    /// (`MovementParameters::UnPackNet`, acclient.c unpack_movement
    /// cases 6/7).
    pub(crate) fn from_wire_moveto(wire: &MoveToParameters) -> Self {
        Self {
            bitfield: wire.movement_parameters,
            speed: wire.speed,
            desired_heading: wire.desired_heading,
            distance_to_object: wire.distance_to_object,
            min_distance: wire.min_distance,
            fail_distance: wire.fail_distance,
            walk_run_threshhold: wire.walk_run_threshold,
            ..Self::default()
        }
    }

    /// Hydrate from the wire `TurnTo*` parameter block
    /// (`TurnToParameters`, cases 8/9).
    pub(crate) fn from_wire_turnto(wire: &TurnToParameters) -> Self {
        Self {
            bitfield: wire.movement_parameters,
            speed: wire.speed,
            desired_heading: wire.desired_heading,
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bit-accessor semantics pinned to the retail byte tests
    /// (acclient.c:344633/:344636/:344661/:344012/:343996) and the
    /// retail default ctor literal `0x1EE0F`.
    #[test]
    fn default_bitfield_and_accessors_match_retail() {
        let params = MovementParameters::default();
        assert_eq!(params.bitfield, 0x0001_EE0F);
        // Defaults: SBYTE1(0x1EE0F)=0xEE<0 → cancel; BYTE1&8 → hold key;
        // BYTE1&0x20 / &0x40 → both modify bits.
        assert!(params.cancel_moveto());
        assert!(params.set_hold_key());
        assert!(params.modify_raw_state());
        assert!(params.modify_interpreted_state());
        assert!(!params.disable_jump_during_link());
        assert!(!params.sticky());
        assert!(!params.autonomous());
        assert!((params.distance_to_object - 0.6).abs() < 1e-6);
        assert!((params.walk_run_threshhold - 15.0).abs() < 1e-6);
        assert_eq!(params.fail_distance.to_bits(), 0x7F7F_FFFF);

        let charged = MovementParameters {
            bitfield: 0x2_0000 | 0x80 | 0x1000,
            ..MovementParameters::default()
        };
        assert!(charged.disable_jump_during_link());
        assert!(charged.sticky());
        assert!(charged.autonomous());
        assert!(!charged.cancel_moveto());
    }

    /// Wire hydration: `movement_parameters` lands in `bitfield`
    /// verbatim; scalar fields carry over; unset fields keep ctor
    /// defaults.
    #[test]
    fn wire_hydration_feeds_bitfield_verbatim() {
        let wire = MoveToParameters {
            movement_parameters: 0x0001_0080,
            distance_to_object: 2.5,
            min_distance: 1.0,
            fail_distance: 50.0,
            speed: 1.5,
            walk_run_threshold: 12.0,
            desired_heading: 3.0,
        };
        let params = MovementParameters::from_wire_moveto(&wire);
        assert_eq!(params.bitfield, 0x0001_0080);
        assert!(params.sticky());
        assert!((params.speed - 1.5).abs() < 1e-6);
        assert!((params.desired_heading - 3.0).abs() < 1e-6);
        assert_eq!(params.context_id, 0);

        let turn = TurnToParameters {
            movement_parameters: 0x4000,
            speed: 1.0,
            desired_heading: 1.25,
        };
        let params = MovementParameters::from_wire_turnto(&turn);
        assert!(params.modify_interpreted_state());
        assert!((params.desired_heading - 1.25).abs() < 1e-6);
    }

    /// A3-D3 driver — `get_command` table (acclient.c:346175-346222):
    /// towards / away / both-bits × distance bands, plus the hold-key
    /// rule incl. the `0x10` force-run and the walk_run_threshhold
    /// crossover.
    #[test]
    fn get_command_table_matches_retail() {
        // Default params: MoveTowards set (0x1EE0F has 0x200), CanWalk +
        // CanRun set, distance_to_object 0.6, threshold 15.0.
        let params = MovementParameters::default();
        assert!(params.move_towards() && !params.move_away());
        assert!(params.use_spheres());

        // Towards, beyond distance_to_object → WalkForward, walk gait
        // (excess 4.4 < threshold 15.0).
        let (cmd, key, away) = params.get_command(5.0, 0.0);
        assert_eq!(cmd, Some(MOTION_WALK_FORWARD));
        assert_eq!(key, 1);
        assert!(!away);

        // Towards, inside → no command.
        let (cmd, _, _) = params.get_command(0.5, 0.0);
        assert_eq!(cmd, None);

        // Threshold crossover → Run hold key.
        let (cmd, key, _) = params.get_command(20.0, 0.0);
        assert_eq!(cmd, Some(MOTION_WALK_FORWARD));
        assert_eq!(key, 2);

        // ForceRun bit 0x10 → Run even when close.
        let forced = MovementParameters {
            bitfield: params.bitfield | 0x10,
            ..params
        };
        let (_, key, _) = forced.get_command(1.0, 0.0);
        assert_eq!(key, 2);

        // No CanWalk (bit 0x1 clear) + CanRun → always Run.
        let no_walk = MovementParameters {
            bitfield: (params.bitfield & !0x1),
            ..params
        };
        let (_, key, _) = no_walk.get_command(1.0, 0.0);
        assert_eq!(key, 2);

        // Away-only (0x100 set, 0x200 clear), closer than min_distance →
        // WalkForward with moving_away.
        let away_only = MovementParameters {
            bitfield: (params.bitfield & !0x200) | 0x100,
            min_distance: 3.0,
            ..params
        };
        let (cmd, _, away) = away_only.get_command(1.0, 0.0);
        assert_eq!(cmd, Some(MOTION_WALK_FORWARD));
        assert!(away);
        let (cmd, _, _) = away_only.get_command(4.0, 0.0);
        assert_eq!(cmd, None);

        // Both bits (towards_and_away, acclient.c:346153-346173):
        // beyond → forward; in-band → none; under min → WalkBackwards
        // moving_away.
        let both = MovementParameters {
            bitfield: params.bitfield | 0x100 | 0x200,
            distance_to_object: 4.0,
            min_distance: 2.0,
            ..params
        };
        let (cmd, _, away) = both.get_command(6.0, 0.0);
        assert_eq!(cmd, Some(MOTION_WALK_FORWARD));
        assert!(!away);
        let (cmd, _, _) = both.get_command(3.0, 0.0);
        assert_eq!(cmd, None);
        let (cmd, _, away) = both.get_command(1.5, 0.0);
        assert_eq!(cmd, Some(MOTION_WALK_BACKWARDS));
        assert!(away);
    }

    /// `get_desired_heading` 0/180 matrix (acclient.c:346224-346239).
    #[test]
    fn get_desired_heading_matrix() {
        for (cmd, away, expected) in [
            (MOTION_WALK_FORWARD, false, 0.0),
            (MOTION_WALK_FORWARD, true, 180.0),
            (MOTION_RUN_FORWARD, false, 0.0),
            (MOTION_RUN_FORWARD, true, 180.0),
            (MOTION_WALK_BACKWARDS, false, 180.0),
            (MOTION_WALK_BACKWARDS, true, 0.0),
            (MOTION_TURN_RIGHT, true, 0.0),
        ] {
            assert_eq!(
                MovementParameters::get_desired_heading(cmd, away),
                expected,
                "cmd {cmd:#x} away {away}"
            );
        }
    }

    /// `heading_diff` / `heading_greater` epsilon + wrap +
    /// direction-fold (acclient.c:344715-344752), plus the
    /// radians↔degrees boundary round-trip the driver's view seam uses.
    #[test]
    fn heading_diff_and_greater_fold_correctly() {
        // Sub-epsilon collapse.
        assert_eq!(heading_diff(10.0, 10.00001, MOTION_TURN_RIGHT), 0.0);
        // TurnRight direction: positive stays.
        assert!((heading_diff(30.0, 10.0, MOTION_TURN_RIGHT) - 20.0).abs() < 1e-4);
        // Negative wraps +360.
        assert!((heading_diff(10.0, 30.0, MOTION_TURN_RIGHT) - 340.0).abs() < 1e-4);
        // TurnLeft mirrors.
        assert!(
            (heading_diff(30.0, 10.0, super::super::motion_interp::MOTION_TURN_LEFT) - 340.0).abs()
                < 1e-4
        );

        // heading_greater: shortest-arc overshoot sense.
        assert!(heading_greater(95.0, 90.0, MOTION_TURN_RIGHT));
        assert!(!heading_greater(85.0, 90.0, MOTION_TURN_RIGHT));
        // Wrapped pair (350 vs 10, 20° apart through 0): turning right
        // from 350 toward 10 has NOT passed it.
        assert!(!heading_greater(350.0, 10.0, MOTION_TURN_RIGHT));
        assert!(heading_greater(15.0, 10.0, MOTION_TURN_RIGHT));
        // TurnLeft complement.
        assert!(heading_greater(
            85.0,
            90.0,
            super::super::motion_interp::MOTION_TURN_LEFT
        ));
        assert!(!heading_greater(
            95.0,
            90.0,
            super::super::motion_interp::MOTION_TURN_LEFT
        ));

        // Radians↔degrees round trip at the view boundary: a radian
        // pose heading converted to degrees and back is identity within
        // f32 tolerance.
        for deg in [0.0f32, 45.0, 179.9, 359.5] {
            let rad = deg.to_radians();
            assert!((rad.to_degrees() - deg).abs() < 1e-3);
        }
    }
}
