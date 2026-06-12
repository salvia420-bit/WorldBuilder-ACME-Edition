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

use holtburger_protocol::messages::movement::messages::motion::{
    MoveToParameters, TurnToParameters,
};

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
}
