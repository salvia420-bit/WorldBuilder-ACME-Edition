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

/// Forward command after `adjust_motion` — `WalkBackwards` never survives
/// interpretation (it is rewritten to `WalkForward` with a negated speed,
/// `acclient.c:343764-343767` / `MotionInterp.cs:404-406`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterpretedForwardCommand {
    WalkForward,
    RunForward,
}

/// One pending interpreted one-shot action `(motion id, speed)` — the
/// FIFO `PerformMovement` (stage 2) drains into the rig.
pub(crate) type PendingAction = (u32, f32);

/// Runtime `InterpretedMotionState`. `sidestep` / `turn` are presence
/// flags for the normalized `SideStepRight` / `TurnRight` commands; the
/// signed speeds carry the direction (see module doc).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InterpretedState {
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
            ..InterpretedState::default()
        };
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
