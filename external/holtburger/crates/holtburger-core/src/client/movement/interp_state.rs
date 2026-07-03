//! Unified movement pipeline STAGE 1 (2026-06-11) — runtime
//! `InterpretedMotionState`: the post-`adjust_motion` /
//! `apply_run_to_command` state that is the ONE source of truth for both
//! the physics velocity and (stage 2) the rig animation. Mirrors retail
//! `InterpretedMotionState` (`~/ac-headers/acclient.c:332759-332786`) and
//! ACE `InterpretedMotionState.cs`. The protocol type
//! (`holtburger-protocol/src/messages/movement/types.rs:226`) stays the
//! wire codec.
//!
//! Post-adjust normal form (`adjust_motion`, `acclient.c:343746-343803`):
//! - forward command is `WalkForward` or `RunForward` with a SIGNED speed
//!   (`WalkBackwards` is rewritten to `WalkForward` with
//!   `speed *= -BackwardsFactor`);
//! - the sidestep command is always `SideStepRight` with a signed speed
//!   (`SideStepLeft` is negated);
//! - the turn command is always `TurnRight` with a signed speed
//!   (`TurnLeft` is negated).

use std::collections::VecDeque;

/// `NonCombat` style (`0x8000003D` = decompile literal `-2147483587`,
/// `acclient.c:344639`; ACE `MotionCommand.NonCombat`) — the
/// `InterpretedMotionState.current_style` default and the style the
/// `DoMotion` lattice's combat-restriction gate keys off (A3-D3).
pub(crate) const MOTION_NONCOMBAT_STYLE: u32 = 0x8000_003D;

/// Forward command after `adjust_motion` — `WalkBackwards` never survives
/// interpretation (it is rewritten to `WalkForward` with a negated speed,
/// `acclient.c:343764-343767` / `MotionInterp.cs:404-406`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterpretedForwardCommand {
    WalkForward,
    RunForward,
    /// FU6 (row 11) — retail stores ANY 0x40000000-class substate in
    /// the single forward slot (`InterpretedMotionState::ApplyMotion`
    /// mirror, acclient.c:332759), evicting locomotion; zero velocity.
    /// `None` ≡ retail's Ready reset (0x41000003, `RemoveMotion`
    /// :332538 resets the slot to Ready, never to a held key).
    Substate(u32),
}

/// One pending interpreted one-shot action `(motion id, speed)` — the
/// FIFO `PerformMovement` (stage 2) drains into the rig.
pub(crate) type PendingAction = (u32, f32);

/// Runtime `InterpretedMotionState`. `sidestep` / `turn` are presence
/// flags for the normalized `SideStepRight` / `TurnRight` commands; the
/// signed speeds carry the direction (see module doc).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InterpretedState {
    /// Full 32-bit current style dword (`InterpretedMotionState.
    /// current_style`, default NonCombat `0x8000003D` —
    /// `acclient.c:344639`; ACE `InterpretedMotionState.cs:131`). Read by
    /// the A3-D3 `DoMotion` lattice's combat-restriction gate
    /// (`InqStyle()`), written by the style arm of [`Self::apply_motion`].
    pub current_style: u32,
    pub forward_command: Option<InterpretedForwardCommand>,
    /// Signed: negative = backstep (rewritten `WalkBackwards`).
    pub forward_speed: f32,
    /// `SideStepRight` held (signed speed: negative = left).
    pub sidestep: bool,
    pub sidestep_speed: f32,
    /// `TurnRight` held (signed speed: negative = left).
    pub turn: bool,
    pub turn_speed: f32,
    /// Pending one-shot action FIFO (`InterpretedMotionState::ApplyMotion`
    /// action arm; drained by stage 2's `PerformMovement`).
    pub actions: VecDeque<PendingAction>,
}

impl Default for InterpretedState {
    fn default() -> Self {
        Self {
            current_style: MOTION_NONCOMBAT_STYLE,
            forward_command: None,
            forward_speed: 1.0,
            sidestep: false,
            sidestep_speed: 1.0,
            turn: false,
            turn_speed: 1.0,
            actions: VecDeque::new(),
        }
    }
}

impl InterpretedState {
    // STAGED (stage-2/3 consumers — server `UpdateMotion` lane +
    // `PerformMovement`, DESIGN.md §3): exercised from tests only in
    // stage 1, hence `allow(dead_code)`.

    /// Copy ONLY the movement axes from a server-supplied interpreted
    /// state, leaving the local pending-action FIFO alone — the movement
    /// half of `move_to_interpreted_state` (`acclient.c:344372-344398`);
    /// actions are replayed separately under the stamp gate.
    #[allow(dead_code)]
    pub(crate) fn copy_movement_from(&mut self, other: &InterpretedState) {
        // ACE `copy_movement_from` copies CurrentStyle along with the
        // movement axes (`InterpretedMotionState.cs:61-69`).
        self.current_style = other.current_style;
        self.forward_command = other.forward_command;
        self.forward_speed = other.forward_speed;
        self.sidestep = other.sidestep;
        self.sidestep_speed = other.sidestep_speed;
        self.turn = other.turn;
        self.turn_speed = other.turn_speed;
    }

    /// `InterpretedMotionState::ApplyMotion` action arm — queue a
    /// one-shot action for the (stage 2) sequence consumer.
    #[allow(dead_code)]
    pub(crate) fn apply_action(&mut self, action: u32, speed: f32) {
        self.actions.push_back((action, speed));
    }

    /// `InterpretedMotionState::RemoveAction` — pop the head action,
    /// returning its motion id, `0` when empty
    /// (`acclient.c:332789-332812`; ACE
    /// `InterpretedMotionState.cs:80-87`). Fired by the A3-D2
    /// completion pop (`CMotionInterp::MotionDone`,
    /// `acclient.c:343660`).
    pub(crate) fn remove_action(&mut self) -> u32 {
        self.actions.pop_front().map(|(action, _)| action).unwrap_or(0)
    }

    /// `InterpretedMotionState::GetNumActions`
    /// (`acclient.c:332815-332825`).
    #[allow(dead_code)] // staged: the D3 DoMotion validation lattice reads it
    pub(crate) fn num_actions(&self) -> usize {
        self.actions.len()
    }

    /// The `DoMotion` action-FIFO cap — STAGE 2 AMENDMENT (A3-D2,
    /// 2026-06-11): retail refuses a 7th queued action with WD_Error
    /// `69` (`acclient.c:344600-344666` `GetNumActions() >= 6`). The
    /// full DoMotion style/substate validation lattice is the D3 slice;
    /// the cap lands here so the FIFO is bounded the moment anything
    /// enqueues through it.
    #[allow(dead_code)] // staged: D3 DoMotion lattice is the in-tree caller
    pub(crate) fn apply_action_capped(&mut self, action: u32, speed: f32) -> Result<(), u32> {
        if self.actions.len() >= 6 {
            return Err(69);
        }
        self.actions.push_back((action, speed));
        Ok(())
    }

    /// Clear the movement axes to defaults — the interpreted half of
    /// `StopCompletely` (`acclient.c:343597-343638`). The action FIFO is
    /// NOT cleared (retail lets queued one-shots complete).
    #[allow(dead_code)]
    pub(crate) fn stop_movement(&mut self) {
        let actions = std::mem::take(&mut self.actions);
        *self = InterpretedState {
            actions,
            // A stop never changes stance — `current_style` survives
            // (retail Stop arms touch the locomotion axes only).
            current_style: self.current_style,
            ..InterpretedState::default()
        };
    }

    // ------------------------------------------------------------------
    // A3-D3 (2026-06-12): the full `InterpretedMotionState::ApplyMotion`
    // / `RemoveMotion` dispatch — the `ModifyInterpretedState` bit of the
    // DoMotion lattice writes through these
    // (`acclient.c:344656-344662`; ACE `InterpretedMotionState.cs:28-126`).
    // ------------------------------------------------------------------

    /// `InterpretedMotionState::ApplyMotion` (ACE
    /// `InterpretedMotionState.cs:28-59`), normalized onto our
    /// post-`adjust_motion` enum: the forward slot only models the two
    /// locomotion survivors (`WalkForward` / `RunForward`); any OTHER
    /// substate (Ready, Crouch, Falling, …) clears the forward command —
    /// "no forward locomotion", the closest normal form (the full
    /// substate id is tracked wire-side by `holtburger-world`'s
    /// `current_substate`). Style arm = forward→Ready (here `None`) +
    /// `current_style` write; action arm = FIFO append (the 6-cap is
    /// enforced by the `DoMotion` lattice BEFORE dispatch,
    /// `acclient.c:344651-344653`, so this arm appends uncapped exactly
    /// as retail's).
    pub(crate) fn apply_motion(&mut self, motion: u32, speed: f32) {
        const TURN_RIGHT: u32 = 0x6500_000D;
        const SIDESTEP_RIGHT: u32 = 0x6500_000F;
        const WALK_FORWARD: u32 = 0x4500_0005;
        const RUN_FORWARD: u32 = 0x4400_0007;
        const MASK_SUBSTATE: u32 = 0x4000_0000;
        const MASK_STYLE: u32 = 0x8000_0000;
        const MASK_ACTION: u32 = 0x1000_0000;
        const MOTION_READY: u32 = 0x4100_0003;
        match motion {
            TURN_RIGHT => {
                self.turn = true;
                self.turn_speed = speed;
            }
            SIDESTEP_RIGHT => {
                self.sidestep = true;
                self.sidestep_speed = speed;
            }
            WALK_FORWARD => {
                self.forward_command = Some(InterpretedForwardCommand::WalkForward);
                self.forward_speed = speed;
            }
            RUN_FORWARD => {
                self.forward_command = Some(InterpretedForwardCommand::RunForward);
                self.forward_speed = speed;
            }
            _ if motion & MASK_SUBSTATE != 0 => {
                // FU6 (row 11) — the substate ITSELF occupies the
                // forward slot (retail :332759), evicting locomotion;
                // Ready canonicalizes to the empty slot.
                self.forward_command = if motion == MOTION_READY {
                    None
                } else {
                    Some(InterpretedForwardCommand::Substate(motion))
                };
                self.forward_speed = speed;
            }
            _ if motion & MASK_STYLE != 0 => {
                // Style arm: forward → Ready, style recorded
                // (InterpretedMotionState.cs:48-52).
                self.forward_command = None;
                self.forward_speed = 1.0;
                self.current_style = motion;
            }
            _ if motion & MASK_ACTION != 0 => {
                self.apply_action(motion, speed);
            }
            _ => {}
        }
    }

    /// `InterpretedMotionState::RemoveMotion` (ACE
    /// `InterpretedMotionState.cs:99-126`): turn/sidestep clear their
    /// slots; a substate clears the forward slot only when it matches
    /// (here: any substate removal returns the forward slot to "no
    /// locomotion" Ready form when the held command matches); a style
    /// removal matching `current_style` resets to NonCombat.
    pub(crate) fn remove_motion(&mut self, motion: u32) {
        const TURN_RIGHT: u32 = 0x6500_000D;
        const SIDESTEP_RIGHT: u32 = 0x6500_000F;
        const WALK_FORWARD: u32 = 0x4500_0005;
        const RUN_FORWARD: u32 = 0x4400_0007;
        const MASK_SUBSTATE: u32 = 0x4000_0000;
        const MASK_STYLE: u32 = 0x8000_0000;
        match motion {
            TURN_RIGHT => {
                self.turn = false;
                self.turn_speed = 1.0;
            }
            SIDESTEP_RIGHT => {
                self.sidestep = false;
                self.sidestep_speed = 1.0;
            }
            WALK_FORWARD => {
                if self.forward_command == Some(InterpretedForwardCommand::WalkForward) {
                    self.forward_command = None;
                    self.forward_speed = 1.0;
                }
            }
            RUN_FORWARD => {
                if self.forward_command == Some(InterpretedForwardCommand::RunForward) {
                    self.forward_command = None;
                    self.forward_speed = 1.0;
                }
            }
            _ if motion & MASK_SUBSTATE != 0 => {
                // Non-locomotion substates are not held in our forward
                // slot (apply_motion normalizes them to None) — nothing
                // to remove.
            }
            _ if motion & MASK_STYLE != 0 => {
                if self.current_style == motion {
                    self.current_style = MOTION_NONCOMBAT_STYLE;
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `copy_movement_from` copies the axes but never the local action
    /// FIFO (actions ride the stamp gate, not the movement copy).
    #[test]
    fn copy_movement_from_preserves_local_action_fifo() {
        let mut local = InterpretedState::default();
        local.apply_action(0x1000_0062, 1.0);

        let mut server = InterpretedState::default();
        server.forward_command = Some(InterpretedForwardCommand::RunForward);
        server.forward_speed = 1.9166666;
        server.apply_action(0x1000_0099, 2.0);

        local.copy_movement_from(&server);
        assert_eq!(
            local.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        assert_eq!(local.forward_speed, 1.9166666);
        assert_eq!(local.actions, VecDeque::from([(0x1000_0062, 1.0)]));
    }

    /// `stop_movement` resets the axes to retail defaults but keeps
    /// queued one-shot actions.
    #[test]
    fn stop_movement_resets_axes_keeps_actions() {
        let mut state = InterpretedState::default();
        state.forward_command = Some(InterpretedForwardCommand::WalkForward);
        state.forward_speed = -0.65;
        state.sidestep = true;
        state.sidestep_speed = -1.248;
        state.apply_action(0x1000_0062, 1.0);

        state.stop_movement();
        assert_eq!(state.forward_command, None);
        assert_eq!(state.forward_speed, 1.0);
        assert!(!state.sidestep);
        assert_eq!(state.actions.len(), 1);
    }
}
