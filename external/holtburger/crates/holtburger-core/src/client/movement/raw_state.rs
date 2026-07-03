//! Unified movement pipeline STAGE 1 (2026-06-11) — local-runtime
//! `RawMotionState`: the live input struct the `CMotionInterp` pipeline
//! consumes, mirroring retail `RawMotionState::ApplyMotion` /
//! `RemoveMotion` (`~/ac-headers/acclient.c:332852-332921`) and ACE
//! `RawMotionState.cs:32-98`.
//!
//! The protocol type in `holtburger-protocol`
//! (`messages/movement/types.rs:448`) stays the WIRE codec; this module is
//! the live struct it serializes from. Stage-1 scope is the locomotion
//! axes (forward / sidestep / turn + hold keys) and the queued-action
//! list shape; the wire senders in `common.rs`
//! (`raw_motion_state_with_motion_style`, `common.rs:83`) are untouched —
//! wire speeds DELIBERATELY stay 1.0 because ACE re-applies
//! `adjust_motion` + `apply_run_to_command` server-side (see the
//! "sending it doubles up" note at `common.rs:627-633`).

use crate::client::movement_types::{
    ForwardLocomotion, Gait, MotionState, SidestepLocomotion, Turn,
};

/// Retail `HoldKey`. `Invalid` defers to the state-level
/// `current_holdkey` — ACE `adjust_motion`: `if (holdKey ==
/// HoldKey.Invalid) holdKey = RawState.CurrentHoldKey`
/// (`external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs:421-422`;
/// decomp `~/ac-headers/acclient.c:343795-343799`). Core-local mirror;
/// the protocol `HoldKey` enum stays the wire codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum HoldKey {
    /// Defer to the state-level `current_holdkey`.
    #[default]
    Invalid,
    /// Explicitly no hold key (walk).
    NoKey,
    /// Run key held (shift / run toggle).
    Run,
}

impl HoldKey {
    /// Resolve an axis-level hold key against the state-level one,
    /// exactly as `adjust_motion` does (`MotionInterp.cs:421-422`).
    pub(crate) fn resolve(self, current: HoldKey) -> HoldKey {
        match self {
            HoldKey::Invalid => current,
            other => other,
        }
    }
}

/// Forward-axis raw command — the `MotionCommand` subset the stage-1
/// locomotion pipeline interprets (`WalkForward` / `WalkBackwards` /
/// `RunForward`). The u32 motion ids stay at the protocol layer.
/// (`RunForward` is constructed by the stage-3 server `UpdateMotion`
/// lane — keyboard input only produces the Walk commands.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawForwardCommand {
    WalkForward,
    WalkBackwards,
    #[allow(dead_code)]
    RunForward,
    /// FU6 (row 11) — retail stores ANY 0x40000000-class substate in
    /// the single forward slot (`RawMotionState::ApplyMotion` default
    /// arm, acclient.c:332890-332908): gestures, crouch, sit… The
    /// locomotion variants above are the velocity-bearing forms; a
    /// stored substate contributes ZERO locomotion. An EMPTY slot
    /// (`None`) is the canonical form of retail's Ready reset value
    /// (0x41000003, `:332538`/`:332913`).
    Substate(u32),
}

/// Sidestep-axis raw command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawSidestepCommand {
    SideStepLeft,
    SideStepRight,
}

/// Turn-axis raw command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawTurnCommand {
    TurnLeft,
    TurnRight,
}

/// One queued one-shot action — retail packs each action with a 15-bit
/// server action stamp + an autonomous bit
/// (`acclient.c:332852-332921`; ACE `RawMotionState.AddAction`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RawAction {
    /// Full 32-bit motion command id (one-shot actions, 0x10000000 class).
    pub action: u32,
    pub speed: f32,
    /// 15-bit server action stamp (see
    /// [`super::motion_interp::is_newer_action_stamp`]).
    pub stamp: u16,
    /// Set when the action originated from THIS client (so a server echo
    /// of it is skipped for the autonomous local player —
    /// `acclient.c:339543-339562`).
    pub autonomous: bool,
}

/// Live `RawMotionState` — keyboard/server input before interpretation.
/// Field-for-field mirror of the retail struct's locomotion axes
/// (`acclient.c:332852-332921`): each axis carries `(command, speed,
/// hold_key)`, plus the state-level `current_holdkey` the per-axis
/// `Invalid` defers to.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawState {
    pub current_holdkey: HoldKey,
    pub forward_command: Option<RawForwardCommand>,
    pub forward_speed: f32,
    pub forward_holdkey: HoldKey,
    pub sidestep_command: Option<RawSidestepCommand>,
    pub sidestep_speed: f32,
    pub sidestep_holdkey: HoldKey,
    pub turn_command: Option<RawTurnCommand>,
    pub turn_speed: f32,
    pub turn_holdkey: HoldKey,
    pub actions: Vec<RawAction>,
}

impl Default for RawState {
    fn default() -> Self {
        // Retail defaults: speeds 1.0, no commands, Invalid hold keys
        // (RawMotionState constructor; ACE `RawMotionState.cs:32-44`).
        Self {
            current_holdkey: HoldKey::Invalid,
            forward_command: None,
            forward_speed: 1.0,
            forward_holdkey: HoldKey::Invalid,
            sidestep_command: None,
            sidestep_speed: 1.0,
            sidestep_holdkey: HoldKey::Invalid,
            turn_command: None,
            turn_speed: 1.0,
            turn_holdkey: HoldKey::Invalid,
            actions: Vec::new(),
        }
    }
}

impl RawState {
    /// Build the raw state for the existing manual-drive [`MotionState`]
    /// — the same mapping the wire sender uses
    /// (`build_motion_state_raw_motion_state`, `common.rs`): raw axis
    /// speeds stay 1.0 (the unit input), `Gait::Run` is the held Run
    /// key, and the per-axis hold keys stay `Invalid` so they defer to
    /// `current_holdkey` exactly as retail keyboard input does.
    pub(crate) fn from_motion_state(state: MotionState) -> Self {
        let mut raw = RawState::default();
        raw.current_holdkey = match state.gait {
            Gait::Run => HoldKey::Run,
            Gait::Walk => HoldKey::NoKey,
        };
        raw.forward_command = state.forward.map(|forward| match forward {
            ForwardLocomotion::Forward => RawForwardCommand::WalkForward,
            ForwardLocomotion::Backstep => RawForwardCommand::WalkBackwards,
        });
        raw.sidestep_command = state.sidestep.map(|sidestep| match sidestep {
            SidestepLocomotion::StrafeLeft => RawSidestepCommand::SideStepLeft,
            SidestepLocomotion::StrafeRight => RawSidestepCommand::SideStepRight,
        });
        raw.turn_command = state.turning.map(|turn| match turn {
            Turn::Left => RawTurnCommand::TurnLeft,
            Turn::Right => RawTurnCommand::TurnRight,
        });
        if let Some(turn_speed) = state.turn_speed {
            raw.turn_speed = turn_speed;
        }
        raw
    }

    // The Apply/Remove arms below are STAGED: their lib consumers are the
    // stage-2/3 input + server `UpdateMotion` lanes (DESIGN.md §3); stage 1
    // exercises them from tests only, so they carry `allow(dead_code)`
    // until those lanes land.

    /// `RawMotionState::ApplyMotion` forward arm (`acclient.c:332852`).
    #[allow(dead_code)]
    pub(crate) fn apply_forward(
        &mut self,
        command: RawForwardCommand,
        speed: f32,
        holdkey: HoldKey,
    ) {
        self.forward_command = Some(command);
        self.forward_speed = speed;
        self.forward_holdkey = holdkey;
    }

    /// `RawMotionState::RemoveMotion` forward arm — reset to defaults.
    #[allow(dead_code)]
    pub(crate) fn remove_forward(&mut self) {
        self.forward_command = None;
        self.forward_speed = 1.0;
        self.forward_holdkey = HoldKey::Invalid;
    }

    /// `ApplyMotion` sidestep arm.
    #[allow(dead_code)]
    pub(crate) fn apply_sidestep(
        &mut self,
        command: RawSidestepCommand,
        speed: f32,
        holdkey: HoldKey,
    ) {
        self.sidestep_command = Some(command);
        self.sidestep_speed = speed;
        self.sidestep_holdkey = holdkey;
    }

    /// `RemoveMotion` sidestep arm.
    #[allow(dead_code)]
    pub(crate) fn remove_sidestep(&mut self) {
        self.sidestep_command = None;
        self.sidestep_speed = 1.0;
        self.sidestep_holdkey = HoldKey::Invalid;
    }

    /// `ApplyMotion` turn arm.
    #[allow(dead_code)]
    pub(crate) fn apply_turn(&mut self, command: RawTurnCommand, speed: f32, holdkey: HoldKey) {
        self.turn_command = Some(command);
        self.turn_speed = speed;
        self.turn_holdkey = holdkey;
    }

    /// `RemoveMotion` turn arm.
    #[allow(dead_code)]
    pub(crate) fn remove_turn(&mut self) {
        self.turn_command = None;
        self.turn_speed = 1.0;
        self.turn_holdkey = HoldKey::Invalid;
    }

    /// A3-D3 (2026-06-12) — `RawMotionState::ApplyMotion`, the u32 form
    /// the DoMotion lattice's ModifyRawState bit writes through
    /// (`acclient.c:332852-332921`; ACE `RawMotionState.cs:32-98`).
    /// Hold-key rule per ACE: when the params' SetHoldKey bit is set the
    /// axis key is `Invalid` (defer to `current_holdkey`), else the
    /// params' `hold_key_to_apply`. Normalizations: RunForward is NOT
    /// stored (ACE `RawMotionState.cs:69`); non-locomotion substates
    /// clear the forward slot (our enum holds the locomotion survivors
    /// only — same normal form as `InterpretedState::apply_motion`);
    /// the style arm is interp-side only (`InterpretedState.
    /// current_style` is the single style owner here); the action arm
    /// appends a stamped [`RawAction`].
    pub(crate) fn apply_motion_u32(
        &mut self,
        motion: u32,
        params: &super::params::MovementParameters,
    ) {
        const TURN_RIGHT: u32 = 0x6500_000D;
        const TURN_LEFT: u32 = 0x6500_000E;
        const SIDESTEP_RIGHT: u32 = 0x6500_000F;
        const SIDESTEP_LEFT: u32 = 0x6500_0010;
        const WALK_FORWARD: u32 = 0x4500_0005;
        const WALK_BACKWARDS: u32 = 0x4500_0006;
        const RUN_FORWARD: u32 = 0x4400_0007;
        const MASK_SUBSTATE: u32 = 0x4000_0000;
        const MASK_ACTION: u32 = 0x1000_0000;
        const MOTION_READY: u32 = 0x4100_0003;
        let holdkey = if params.set_hold_key() {
            HoldKey::Invalid
        } else {
            match params.hold_key_to_apply {
                1 => HoldKey::NoKey,
                2 => HoldKey::Run,
                _ => HoldKey::Invalid,
            }
        };
        match motion {
            TURN_RIGHT => self.apply_turn(RawTurnCommand::TurnRight, params.speed, holdkey),
            TURN_LEFT => self.apply_turn(RawTurnCommand::TurnLeft, params.speed, holdkey),
            SIDESTEP_RIGHT => {
                self.apply_sidestep(RawSidestepCommand::SideStepRight, params.speed, holdkey)
            }
            SIDESTEP_LEFT => {
                self.apply_sidestep(RawSidestepCommand::SideStepLeft, params.speed, holdkey)
            }
            WALK_FORWARD => {
                self.apply_forward(RawForwardCommand::WalkForward, params.speed, holdkey)
            }
            WALK_BACKWARDS => {
                self.apply_forward(RawForwardCommand::WalkBackwards, params.speed, holdkey)
            }
            RUN_FORWARD => {
                // ACE: `if (motion != RunForward)` — RunForward is never
                // stored in the raw forward slot.
            }
            _ if motion & MASK_SUBSTATE != 0 => {
                // FU6 (row 11) — retail stores the substate ITSELF in
                // the forward slot (acclient.c:332890-332908), evicting
                // any locomotion command; Ready (0x41000003) is the
                // reset value and canonicalizes to the empty slot.
                if motion == MOTION_READY {
                    self.remove_forward();
                } else {
                    self.apply_forward(RawForwardCommand::Substate(motion), params.speed, holdkey)
                }
            }
            _ if motion & MASK_ACTION != 0 => {
                self.actions.push(RawAction {
                    action: motion,
                    speed: params.speed,
                    stamp: (params.action_stamp & 0x7FFF) as u16,
                    autonomous: params.autonomous(),
                });
            }
            _ => {}
        }
    }

    /// A3-D3 — `RawMotionState::RemoveMotion`, u32 form (the
    /// ModifyRawState bit of `StopMotion`, `acclient.c:344133-344135`):
    /// turn/sidestep clear their slots; a forward locomotion command
    /// clears the forward slot when it matches.
    pub(crate) fn remove_motion_u32(&mut self, motion: u32) {
        const TURN_RIGHT: u32 = 0x6500_000D;
        const TURN_LEFT: u32 = 0x6500_000E;
        const SIDESTEP_RIGHT: u32 = 0x6500_000F;
        const SIDESTEP_LEFT: u32 = 0x6500_0010;
        const WALK_FORWARD: u32 = 0x4500_0005;
        const WALK_BACKWARDS: u32 = 0x4500_0006;
        const RUN_FORWARD: u32 = 0x4400_0007;
        match motion {
            TURN_RIGHT | TURN_LEFT => self.remove_turn(),
            SIDESTEP_RIGHT | SIDESTEP_LEFT => self.remove_sidestep(),
            WALK_FORWARD => {
                if self.forward_command == Some(RawForwardCommand::WalkForward) {
                    self.remove_forward();
                }
            }
            WALK_BACKWARDS => {
                if self.forward_command == Some(RawForwardCommand::WalkBackwards) {
                    self.remove_forward();
                }
            }
            RUN_FORWARD => {
                if self.forward_command == Some(RawForwardCommand::RunForward) {
                    self.remove_forward();
                }
            }
            _ => {}
        }
    }

    /// `RawMotionState::RemoveAction` — pop the head queued action,
    /// returning its motion id, `0` when empty
    /// (`acclient.c:332616-332639`; ACE `RawMotionState.cs:90-98`).
    /// Fired by the A3-D2 completion pop (`CMotionInterp::MotionDone`,
    /// `acclient.c:343661`).
    pub(crate) fn remove_action(&mut self) -> u32 {
        if self.actions.is_empty() {
            return 0;
        }
        self.actions.remove(0).action
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Gait::Run` maps to the held Run key; per-axis hold keys stay
    /// `Invalid` (defer to `current_holdkey`), raw axis speeds stay 1.0
    /// — the unit-input contract the wire sender shares.
    #[test]
    fn from_motion_state_maps_gait_to_current_holdkey_with_unit_speeds() {
        let run = RawState::from_motion_state(
            MotionState::builder().run().forward().strafe_left().build(),
        );
        assert_eq!(run.current_holdkey, HoldKey::Run);
        assert_eq!(run.forward_command, Some(RawForwardCommand::WalkForward));
        assert_eq!(run.forward_speed, 1.0);
        assert_eq!(run.forward_holdkey, HoldKey::Invalid);
        assert_eq!(run.sidestep_command, Some(RawSidestepCommand::SideStepLeft));
        assert_eq!(run.sidestep_speed, 1.0);

        let walk = RawState::from_motion_state(MotionState::builder().walk().backstep().build());
        assert_eq!(walk.current_holdkey, HoldKey::NoKey);
        assert_eq!(walk.forward_command, Some(RawForwardCommand::WalkBackwards));
    }

    /// Per-axis `Invalid` resolves to the state-level hold key, an
    /// explicit axis key wins (`MotionInterp.cs:421-422`).
    #[test]
    fn holdkey_invalid_defers_to_current() {
        assert_eq!(HoldKey::Invalid.resolve(HoldKey::Run), HoldKey::Run);
        assert_eq!(HoldKey::NoKey.resolve(HoldKey::Run), HoldKey::NoKey);
        assert_eq!(HoldKey::Run.resolve(HoldKey::NoKey), HoldKey::Run);
    }

    /// Apply/Remove round-trip restores the retail defaults (speed 1.0,
    /// `Invalid` hold key).
    #[test]
    fn apply_remove_round_trip_restores_defaults() {
        let mut raw = RawState::default();
        raw.apply_forward(RawForwardCommand::RunForward, 2.0, HoldKey::Run);
        assert_eq!(raw.forward_command, Some(RawForwardCommand::RunForward));
        raw.remove_forward();
        assert_eq!(raw, RawState::default());
    }
}
