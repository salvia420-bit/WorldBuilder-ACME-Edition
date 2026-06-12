//! Unified movement pipeline STAGE 1 (2026-06-11) — the `CMotionInterp`
//! port. Retail runs ONE pipeline for every object including the local
//! player: `RawMotionState` → `apply_raw_movement` (3× `adjust_motion` +
//! `apply_run_to_command`) → `InterpretedMotionState`, whose ONE
//! `speed_mod` scales BOTH the on-ground translation (authored MotionData
//! cycle velocity × speed_mod — `add_motion`,
//! `~/ac-headers/acclient.c:337431-337474`; `CSequence::apply_physics`,
//! `acclient.c:339860-339890`) AND the rig framerate (`acclient.c:337465`)
//! — the anti-ice-skating contract. The closed-form
//! [`MotionInterp::get_state_velocity`] constants (4.0 / 3.1199999 / 1.25)
//! exist for the airborne/leave-ground path and the
//! `run_rate × 4.0` magnitude clamp.
//!
//! Design + acceptance:
//! `apps/holtburger-web/docs/2026-06-11-unified-movement-pipeline/DESIGN.md`
//! (§2 THE VELOCITY CONTRACT). Function-for-function citations:
//! `apply_raw_movement` `acclient.c:344259-344298`, `adjust_motion`
//! `:343746-343803`, `apply_run_to_command` `:343439-343483`,
//! `get_state_velocity` `:343539-343594`, `apply_current_movement`
//! `:344301-344315`, `move_to_interpreted_state` `:344372-344426`,
//! `StopCompletely` `:343597-343638`. ACE 1:1 port:
//! `external/ACE/Source/ACE.Server/Physics/Animation/MotionInterp.cs`
//! (constants `:26-32`, `adjust_motion` `:394-428`, `apply_raw_movement`
//! `:506-523`, `apply_run_to_command` `:525-562`, `get_state_velocity`
//! `:678-699`).

use super::interp_state::{InterpretedForwardCommand, InterpretedState};
use super::raw_state::{
    HoldKey, RawAction, RawForwardCommand, RawSidestepCommand, RawState, RawTurnCommand,
};
use crate::client::movement_types::{MotionState, planar_velocity_for_heading};
use holtburger_common::Vector3;
use holtburger_world::SelfMovementCapabilities;
use std::collections::VecDeque;
use std::f32::consts::FRAC_PI_2;

/// `Motion_Ready` (`0x41000003`) — the completion node Stop arms enqueue
/// (`acclient.c:344056-344060` `StopInterpretedMotion`;
/// `enter_default_state` seed `:344577-344582`; ACE
/// `MotionCommand.Ready`).
pub(crate) const MOTION_READY: u32 = 0x4100_0003;

/// One-shot action bit — motions with `0x10000000` set are queued actions
/// whose completion fires the unstick + RemoveAction chain
/// (`acclient.c:343656-343661`; ACE `CommandMask.Action`).
pub(crate) const MOTION_ACTION_BIT: u32 = 0x1000_0000;

/// `MotionInterp.RunAnimSpeed` (`MotionInterp.cs:28`; `acclient.c`
/// `get_state_velocity` `:343580`) — the closed-form run constant used
/// for the airborne velocity and the `run_rate × 4.0` magnitude clamp.
/// On-ground translation uses the AUTHORED run cycle base instead
/// (4.000 for the player MotionTable — same number, different source).
#[allow(dead_code)] // staged: consumed by get_state_velocity (airborne lane)
pub(crate) const RUN_ANIM_SPEED: f32 = 4.0;

/// `MotionInterp.WalkAnimSpeed` (`MotionInterp.cs:32`) — precision is
/// load-bearing: `3.1199999`, NOT `3.12`. Closed-form walk constant
/// (airborne role); on-ground walk uses the authored cycle base (2.602).
pub(crate) const WALK_ANIM_SPEED: f32 = 3.1199999;

/// `MotionInterp.SidestepAnimSpeed` (`MotionInterp.cs:30`) — m/s per
/// unit of interpreted sidestep speed.
pub(crate) const SIDESTEP_ANIM_SPEED: f32 = 1.25;

/// `MotionInterp.SidestepFactor` (`MotionInterp.cs:31`): `adjust_motion`
/// scales the sidestep speed by `SidestepFactor × (WalkAnimSpeed /
/// SidestepAnimSpeed)` = `0.5 × (3.1199999 / 1.25)` ≈ 1.248
/// (`MotionInterp.cs:417-418`; `acclient.c:343781-343784`).
pub(crate) const SIDESTEP_FACTOR: f32 = 0.5;

/// `MotionInterp.BackwardsFactor` (`MotionInterp.cs:26`) —
/// `WalkBackwards` → `WalkForward` with `speed *= -0.649_999_98`.
pub(crate) const BACKWARDS_FACTOR: f32 = 0.649_999_98;

/// `MotionInterp.RunTurnFactor` (`MotionInterp.cs:29`) — Run hold key
/// multiplies the turn speed by a FIXED 1.5 (not the run rate).
pub(crate) const RUN_TURN_FACTOR: f32 = 1.5;

/// `MotionInterp.MaxSidestepAnimRate` (`MotionInterp.cs:27`) — the
/// run-scaled sidestep ANIM RATE clamps at ±3.0
/// (`MotionInterp.cs:550-560`; `acclient.c:343474-343480`).
pub(crate) const MAX_SIDESTEP_ANIM_RATE: f32 = 3.0;

/// 15-bit server-action-stamp compare (retail packs the stamp + the
/// autonomous bit into 16 bits; the stamp itself is 15-bit —
/// `acclient.c:344398-344408`). Directional half-window compare in
/// 15-bit space: `new` is newer when it leads `old` by 1..=0x3FFF
/// modulo 0x8000.
#[allow(dead_code)] // staged: lib consumer is the stage-3 server UpdateMotion lane
pub(crate) fn is_newer_action_stamp(new: u16, old: u16) -> bool {
    let diff = new.wrapping_sub(old) & 0x7FFF;
    diff != 0 && diff < 0x4000
}

/// One pending-motion completion node — retail allocates
/// `{ next, context_id, motion, jump_error_code }` 16-byte LList nodes
/// (`CMotionInterp::add_to_queue`, `acclient.c:343406-343437`; ACE
/// `MotionInterp.cs:390` `PendingMotion`). STAGE 2 AMENDMENT (A3-D2,
/// 2026-06-11): the A3 half of the completion layer — A4's
/// `MotionTableManager` decides WHEN a motion completes
/// ([`super::motion_table_manager::MotionTableEvent::MotionDone`]); this
/// queue decides what completion DOES to movement state
/// (`DESIGN.md` "STAGE 2 AMENDMENT" seam contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PendingMotion {
    pub context_id: u32,
    pub motion: u32,
    /// Error code `jump_is_allowed` returns while this node is the queue
    /// head (`acclient.c:343946-343948`; ACE `MotionInterp.cs:753-754`):
    /// `0` = the pending motion does not block jumping.
    pub jump_error_code: u32,
}

/// `CMotionInterp::motion_allows_jump` (`acclient.c:343295-343316` —
/// note: STATIC, takes the substate/motion id). Returns `0` when the
/// motion permits jumping and the WD_Error `72` (you-can't-jump-while-X)
/// when it blocks it — retail's inverted naming is kept verbatim. The
/// blocking ranges are the seated/crouched/sleeping emote substates plus
/// `Fallen` (`0x40000008`); plain locomotion (`WalkForward` `0x45000005`,
/// `RunForward` `0x44000007`) falls in the `> 0x41000014` arm → `0`.
pub(crate) fn motion_allows_jump(substate: u32) -> u32 {
    let blocks = if substate > 0x4000_0018 {
        substate <= 0x4100_0014
            && (substate >= 0x4100_0012 || (0x4000_001E..=0x4000_0039).contains(&substate))
    } else if substate < 0x4000_0016 {
        if substate > 0x1000_0131 {
            substate == 0x4000_0008
        } else {
            (0x1000_0128..=0x1000_0131).contains(&substate)
                || (0x1000_006F..=0x1000_0078).contains(&substate)
        }
    } else {
        // 0x40000016..=0x40000018 falls through both outer guards.
        true
    };
    if blocks { 72 } else { 0 }
}

/// `CMotionInterp::adjust_motion`, forward axis
/// (`acclient.c:343746-343803` / `MotionInterp.cs:394-428`):
/// `RunForward` passes through; `WalkBackwards` is rewritten to
/// `WalkForward` with `speed *= -BackwardsFactor`.
fn adjust_forward(command: RawForwardCommand, speed: f32) -> (InterpretedForwardCommand, f32) {
    match command {
        RawForwardCommand::RunForward => (InterpretedForwardCommand::RunForward, speed),
        RawForwardCommand::WalkForward => (InterpretedForwardCommand::WalkForward, speed),
        RawForwardCommand::WalkBackwards => {
            (InterpretedForwardCommand::WalkForward, speed * -BACKWARDS_FACTOR)
        }
    }
}

/// `adjust_motion`, sidestep axis: `SideStepLeft` → `SideStepRight`
/// negated, then EVERY `SideStepRight` scales by
/// `SidestepFactor × (WalkAnimSpeed / SidestepAnimSpeed)`
/// (`MotionInterp.cs:411-418`). Returns the signed normalized speed.
fn adjust_sidestep(command: RawSidestepCommand, speed: f32) -> f32 {
    let signed = match command {
        RawSidestepCommand::SideStepRight => speed,
        RawSidestepCommand::SideStepLeft => -speed,
    };
    signed * (SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED))
}

/// `adjust_motion`, turn axis: `TurnLeft` → `TurnRight` negated.
fn adjust_turn(command: RawTurnCommand, speed: f32) -> f32 {
    match command {
        RawTurnCommand::TurnRight => speed,
        RawTurnCommand::TurnLeft => -speed,
    }
}

/// `CMotionInterp::apply_run_to_command`, forward arm
/// (`acclient.c:343439-343483` / `MotionInterp.cs:525-543`): a positive
/// `WalkForward` is PROMOTED to `RunForward`; the speed multiplies by the
/// run rate either way (a negative speed — backstep — stays `WalkForward`
/// but still run-scales).
fn apply_run_to_forward(
    command: InterpretedForwardCommand,
    speed: f32,
    run_rate: f32,
) -> (InterpretedForwardCommand, f32) {
    match command {
        InterpretedForwardCommand::WalkForward => {
            let command = if speed > 0.0 {
                InterpretedForwardCommand::RunForward
            } else {
                InterpretedForwardCommand::WalkForward
            };
            (command, speed * run_rate)
        }
        // ACE's switch has no RunForward arm — passes through untouched.
        InterpretedForwardCommand::RunForward => (command, speed),
    }
}

/// `apply_run_to_command`, sidestep arm: `speed *= run_rate`, then the
/// anim rate clamps at ±[`MAX_SIDESTEP_ANIM_RATE`]
/// (`MotionInterp.cs:549-560`).
fn apply_run_to_sidestep(speed: f32, run_rate: f32) -> f32 {
    let scaled = speed * run_rate;
    scaled.clamp(-MAX_SIDESTEP_ANIM_RATE, MAX_SIDESTEP_ANIM_RATE)
}

/// `apply_run_to_command`, turn arm: fixed ×[`RUN_TURN_FACTOR`]
/// (`MotionInterp.cs:545-548`), NOT the run rate.
fn apply_run_to_turn(speed: f32) -> f32 {
    speed * RUN_TURN_FACTOR
}

/// The `CMotionInterp` port — owns the raw + interpreted states,
/// `my_run_rate`, and the 15-bit `server_action_stamp`. Per-entity by
/// contract (remote objects get `my_run_rate` from the wire, NEVER the
/// local player's skill — the F3-5 per-creature gait-tempo rule).
///
/// The run rate is an INPUT (`inq_run_rate`), mirroring retail's weenie
/// `InqRunRate` vfptr (`acclient.c:343452-343455`): callers wire it to
/// `holtburger-world` `player_run_rate()` (`context.rs:311-326`,
/// ACE-composed wire Run skill ONLY); when unavailable the pipeline
/// falls back to `my_run_rate` (initial 1.0) exactly as retail does —
/// NEVER a Quickness synthesis, NEVER a 4.5 cap (DESIGN.md §2 defect 1).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MotionInterp {
    pub raw_state: RawState,
    pub interpreted_state: InterpretedState,
    /// Last known run rate — retail's `InqRunRate`-failure fallback
    /// (`MotionInterp.cs:531-537`), refreshed whenever an interpretation
    /// resolves a `RunForward` (`acclient.c:344162-344163`). Initial 1.0.
    pub my_run_rate: f32,
    /// Last accepted 15-bit server action stamp
    /// (`acclient.c:344398-344408`).
    pub server_action_stamp: u16,
    /// Pending-motion completion queue — STAGE 2 AMENDMENT (A3-D2,
    /// 2026-06-11): every accepted `DoInterpretedMotion` enqueues a node
    /// (`acclient.c:343993-344010`), every successful
    /// `StopInterpretedMotion` enqueues a Ready node (`:344056-344060`),
    /// and [`Self::motion_done`] pops the head when A4's
    /// `MotionTableManager` reports completion. Head = oldest.
    pub pending_motions: VecDeque<PendingMotion>,
}

impl Default for MotionInterp {
    fn default() -> Self {
        Self {
            raw_state: RawState::default(),
            interpreted_state: InterpretedState::default(),
            my_run_rate: 1.0,
            server_action_stamp: 0,
            pending_motions: VecDeque::new(),
        }
    }
}

impl MotionInterp {
    /// Retail run-rate resolution: weenie `InqRunRate` if available,
    /// else `my_run_rate` (`MotionInterp.cs:529-537`).
    fn run_rate(&self, inq_run_rate: Option<f32>) -> f32 {
        inq_run_rate.unwrap_or(self.my_run_rate)
    }

    /// `CMotionInterp::apply_raw_movement` (`acclient.c:344259-344298` /
    /// `MotionInterp.cs:506-523`): copy raw → interpreted, run
    /// `adjust_motion` on each axis (per-axis hold key falling back to
    /// `current_holdkey`), applying `apply_run_to_command` where the
    /// resolved hold key is Run; then refresh `my_run_rate` when the
    /// interpretation resolved `RunForward`
    /// (`apply_interpreted_movement`, `acclient.c:344162-344163`).
    pub(crate) fn apply_raw_movement(&mut self, inq_run_rate: Option<f32>) {
        let run_rate = self.run_rate(inq_run_rate);
        let raw = &self.raw_state;
        let mut interpreted = InterpretedState {
            actions: std::mem::take(&mut self.interpreted_state.actions),
            ..InterpretedState::default()
        };

        if let Some(command) = raw.forward_command {
            let (mut command, mut speed) = adjust_forward(command, raw.forward_speed);
            if raw.forward_holdkey.resolve(raw.current_holdkey) == HoldKey::Run {
                (command, speed) = apply_run_to_forward(command, speed, run_rate);
            }
            interpreted.forward_command = Some(command);
            interpreted.forward_speed = speed;
        }

        if let Some(command) = raw.sidestep_command {
            let mut speed = adjust_sidestep(command, raw.sidestep_speed);
            if raw.sidestep_holdkey.resolve(raw.current_holdkey) == HoldKey::Run {
                speed = apply_run_to_sidestep(speed, run_rate);
            }
            interpreted.sidestep = true;
            interpreted.sidestep_speed = speed;
        }

        if let Some(command) = raw.turn_command {
            let mut speed = adjust_turn(command, raw.turn_speed);
            if raw.turn_holdkey.resolve(raw.current_holdkey) == HoldKey::Run {
                speed = apply_run_to_turn(speed);
            }
            interpreted.turn = true;
            interpreted.turn_speed = speed;
        }

        self.interpreted_state = interpreted;

        // my_run_rate refresh — the interpretation that promoted to
        // RunForward records the rate it used, so a later InqRunRate
        // failure degrades to the LAST KNOWN rate, not a synthesized one.
        if self.interpreted_state.forward_command == Some(InterpretedForwardCommand::RunForward) {
            self.my_run_rate = run_rate;
        }
    }

    /// `CMotionInterp::get_state_velocity` (`acclient.c:343539-343594` /
    /// `MotionInterp.cs:678-699`) — the closed-form BODY-FRAME velocity
    /// (x = sidestep, y = forward): `1.25 × sidestep_speed`,
    /// `3.1199999 × forward_speed` (WalkForward) or `4.0 × forward_speed`
    /// (RunForward), magnitude clamped to `run_rate × 4.0`. Retail's only
    /// physics consumer of this form is the leave-ground/jump path
    /// (`acclient.c:343806-344489`); on-ground translation uses
    /// [`Self::ground_velocity`] (authored cycle bases).
    #[allow(dead_code)] // staged: stage-2/3 lane (DESIGN.md §3)
    pub(crate) fn get_state_velocity(&self, inq_run_rate: Option<f32>) -> Vector3 {
        let state = &self.interpreted_state;
        let mut velocity = Vector3::zero();
        if state.sidestep {
            velocity.x = SIDESTEP_ANIM_SPEED * state.sidestep_speed;
        }
        match state.forward_command {
            Some(InterpretedForwardCommand::WalkForward) => {
                velocity.y = WALK_ANIM_SPEED * state.forward_speed;
            }
            Some(InterpretedForwardCommand::RunForward) => {
                velocity.y = RUN_ANIM_SPEED * state.forward_speed;
            }
            None => {}
        }

        let max_speed = RUN_ANIM_SPEED * self.run_rate(inq_run_rate);
        let magnitude = velocity.length();
        if magnitude > max_speed && magnitude > 0.0 {
            velocity = velocity * (max_speed / magnitude);
        }
        velocity
    }

    /// On-ground BODY-FRAME velocity per the retail ground contract
    /// (DESIGN.md §2): `velocity = AUTHORED MotionData cycle base speed ×
    /// speed_mod`, where the interpreted speed IS the speed_mod
    /// (`add_motion`, `acclient.c:337431-337474`; `apply_physics`,
    /// `acclient.c:339860-339890`). Walk uses the authored walk base
    /// (2.602 for the player MotionTable), run the authored run base
    /// (4.000) — NOT the closed-form 3.1199999/4.0 constants, which are
    /// the clamp/airborne approximations (see the walk note in DESIGN.md
    /// §2). Sidestep has no authored straight-line cycle base in our
    /// profile; retail's `SidestepAnimSpeed` (1.25 m/s per anim-rate
    /// unit) is the conversion both retail and ACE use. NO magnitude
    /// clamp here — `add_motion` composition is unclamped (the legacy
    /// diagonal-composition behaviour, `common.rs:699-705`).
    pub(crate) fn ground_velocity(&self, walk_base_speed: f32, run_base_speed: f32) -> Vector3 {
        let state = &self.interpreted_state;
        let mut velocity = Vector3::zero();
        if state.sidestep {
            velocity.x = SIDESTEP_ANIM_SPEED * state.sidestep_speed;
        }
        match state.forward_command {
            Some(InterpretedForwardCommand::WalkForward) => {
                velocity.y = walk_base_speed * state.forward_speed;
            }
            Some(InterpretedForwardCommand::RunForward) => {
                velocity.y = run_base_speed * state.forward_speed;
            }
            None => {}
        }
        velocity
    }

    /// `CMotionInterp::apply_current_movement` (`acclient.c:344301-344315`):
    /// the autonomous local player re-derives the interpreted state from
    /// its LOCAL raw state (server-supplied movement is ignored); a
    /// server-controlled object keeps the interpreted state as received.
    #[allow(dead_code)] // staged: stage-2/3 lane (DESIGN.md §3)
    pub(crate) fn apply_current_movement(
        &mut self,
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
    ) {
        if last_move_was_autonomous {
            self.apply_raw_movement(inq_run_rate);
        }
    }

    /// Server `UpdateMotion` lane — `CMotionInterp::move_to_interpreted_state`
    /// (`acclient.c:344372-344426`): copy the movement axes, replay only
    /// actions with NEWER 15-bit stamps (`:344398-344408`), skipping
    /// self-echoed autonomous actions for the autonomous local player
    /// (`acclient.c:339543-339562`), then `apply_current_movement` —
    /// which for the autonomous local player immediately re-derives the
    /// movement from local raw state (the Rust-side formalization of
    /// what B9 does ad-hoc in JS).
    #[allow(dead_code)] // staged: stage-2/3 lane (DESIGN.md §3)
    pub(crate) fn move_to_interpreted_state(
        &mut self,
        state: &InterpretedState,
        server_actions: &[RawAction],
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
    ) {
        self.interpreted_state.copy_movement_from(state);
        for action in server_actions {
            if !is_newer_action_stamp(action.stamp, self.server_action_stamp) {
                continue;
            }
            self.server_action_stamp = action.stamp & 0x7FFF;
            if action.autonomous && last_move_was_autonomous {
                // Self-echo of an action this client already played.
                continue;
            }
            self.interpreted_state.apply_action(action.action, action.speed);
        }
        self.apply_current_movement(last_move_was_autonomous, inq_run_rate);
    }

    /// `CMotionInterp::StopCompletely` (`acclient.c:343597-343638`):
    /// clear the raw locomotion axes to defaults and stop the
    /// interpreted movement (queued one-shot actions complete).
    #[allow(dead_code)] // staged: stage-2/3 lane (DESIGN.md §3)
    pub(crate) fn stop_completely(&mut self) {
        self.raw_state.remove_forward();
        self.raw_state.remove_sidestep();
        self.raw_state.remove_turn();
        self.interpreted_state.stop_movement();
    }

    /// `CommandInterpreter::SetHoldKey` Run-toggle
    /// (`acclient.c:344492-344523` / `MotionInterp.cs:274-299`): flip the
    /// state-level hold key and re-interpret the held raw state.
    #[allow(dead_code)] // staged: stage-2/3 lane (DESIGN.md §3)
    pub(crate) fn set_hold_run(&mut self, run: bool, inq_run_rate: Option<f32>) {
        let key = if run { HoldKey::Run } else { HoldKey::NoKey };
        if self.raw_state.current_holdkey == key {
            return;
        }
        self.raw_state.current_holdkey = key;
        self.apply_raw_movement(inq_run_rate);
    }

    // ------------------------------------------------------------------
    // STAGE 2 AMENDMENT completion layer, A3-D2 half (2026-06-11):
    // what completion DOES to movement state. A4's MotionTableManager
    // (motion_table_manager.rs) owns WHO fires completion; the
    // movement/system.rs pump routes its MotionDone events here under
    // USE_MOTION_TABLE_QUEUE (default-off — inert until the Stage-2
    // ?interpRig= rig lane enqueues through these arms).
    // ------------------------------------------------------------------

    /// `CMotionInterp::add_to_queue(context_id, motion, jump_error_code)`
    /// — append a completion node (`acclient.c:343406-343437`; ACE
    /// `MotionInterp.cs:390`).
    pub(crate) fn add_to_queue(&mut self, context_id: u32, motion: u32, jump_error_code: u32) {
        self.pending_motions.push_back(PendingMotion {
            context_id,
            motion,
            jump_error_code,
        });
    }

    /// The accepted-`DoInterpretedMotion` enqueue arm
    /// (`acclient.c:343993-344010`): derive the node's `jump_error_code`
    /// — `72` while jump-charging (`params->bitfield & 0x20000`), else
    /// [`motion_allows_jump`] of the motion itself, falling back to the
    /// CURRENT interpreted forward command when the motion is not a
    /// one-shot action.
    #[allow(dead_code)] // staged: stage-2 ?interpRig= rig lane (DESIGN.md STAGE 2 AMENDMENT)
    pub(crate) fn enqueue_accepted_motion(&mut self, context_id: u32, motion: u32, charging: bool) {
        let jump_error = if charging {
            72
        } else {
            let mut error = motion_allows_jump(motion);
            if error == 0 && motion & MOTION_ACTION_BIT == 0 {
                error = motion_allows_jump(self.interpreted_forward_motion_id());
            }
            error
        };
        self.add_to_queue(context_id, motion, jump_error);
    }

    /// The successful-`StopInterpretedMotion` enqueue arm — stop
    /// completion is observable, not display-only: a Ready
    /// (`0x41000003`) node rides the same queue
    /// (`acclient.c:344056-344060`).
    #[allow(dead_code)] // staged: stage-2 ?interpRig= rig lane (DESIGN.md STAGE 2 AMENDMENT)
    pub(crate) fn enqueue_stop(&mut self, context_id: u32) {
        self.add_to_queue(context_id, MOTION_READY, 0);
    }

    /// The interpreted forward command's motion id — the
    /// `motion_allows_jump(this->interpreted_state.forward_command)`
    /// input (`acclient.c:344003`, `:343957`). Our normalized enum only
    /// holds the two post-`adjust_motion` survivors
    /// (`interp_state.rs:21-28`); both ids fall in `motion_allows_jump`'s
    /// `> 0x41000014` permit arm, kept symbolic for fidelity.
    fn interpreted_forward_motion_id(&self) -> u32 {
        match self.interpreted_state.forward_command {
            // Motion_WalkForward / Motion_RunForward (ACE MotionCommand).
            Some(InterpretedForwardCommand::WalkForward) | None => 0x4500_0005,
            Some(InterpretedForwardCommand::RunForward) => 0x4400_0007,
        }
    }

    /// `CMotionInterp::MotionDone(success)` (`acclient.c:343641-343676`)
    /// — pop the pending head; when it is a one-shot action
    /// (`motion & 0x10000000`): `unstick_from_object` +
    /// `InterpretedMotionState::RemoveAction` +
    /// `RawMotionState::RemoveAction` (`:343656-343661`) — THE drain that
    /// makes `interp_state.rs:31` true. Returns `true` when the unstick
    /// hook must fire (A2 owns the sticky object itself — DESIGN.md
    /// STAGE 2 AMENDMENT exposes the hook, never the stick state).
    /// `success` is accepted for the A4 event seam but, exactly as
    /// retail's body, does not branch (`:343646-343676` never reads it).
    pub(crate) fn motion_done(&mut self, _success: bool) -> bool {
        let Some(head) = self.pending_motions.front() else {
            return false;
        };
        let unstick = head.motion & MOTION_ACTION_BIT != 0;
        if unstick {
            self.interpreted_state.remove_action();
            self.raw_state.remove_action();
        }
        self.pending_motions.pop_front();
        unstick
    }

    /// `CMotionInterp::motions_pending` (`acclient.c:343728-343732`).
    #[allow(dead_code)] // staged: stage-2/3 consumers (DESIGN.md STAGE 2 AMENDMENT)
    pub(crate) fn motions_pending(&self) -> bool {
        !self.pending_motions.is_empty()
    }

    /// The queue-head jump gate input — `jump_is_allowed` refuses with
    /// the head's `jump_error_code` before consulting the charge gates
    /// (`acclient.c:343946-343948`; ACE `MotionInterp.cs:753-754`).
    /// `0` = no pending node blocks jumping.
    #[allow(dead_code)] // staged: lib.rs jump-gate consumer (wasm wave R4)
    pub(crate) fn pending_jump_error(&self) -> u32 {
        self.pending_motions
            .front()
            .map(|node| node.jump_error_code)
            .unwrap_or(0)
    }

    /// `CMotionInterp::HandleExitWorld` (`acclient.c:343679-343713`) —
    /// drain EVERY pending node through the same pop path with
    /// success=0: queued one-shots are cancelled, not played, across
    /// teleport/portal (A4-Q3 wires the JS trigger). Returns `true` when
    /// any drained action requires the unstick hook.
    #[allow(dead_code)] // staged: A4-Q3 portal/teleport trigger (DESIGN.md STAGE 2 AMENDMENT)
    pub(crate) fn handle_exit_world(&mut self) -> bool {
        let mut unstick = false;
        while !self.pending_motions.is_empty() {
            unstick |= self.motion_done(false);
        }
        unstick
    }

    /// `CMotionInterp::enter_default_state` (`acclient.c:344560-344598`)
    /// — the construction semantics for every per-entity instance
    /// (Stage 3 needs this; ACE `MotionInterp.cs:610-615`): reset BOTH
    /// states to constructor defaults, then seed the queue with one
    /// Ready (`0x41000003`) node — retail APPENDS the seed
    /// (`:344577-344592`), it does not clear, and so does this port.
    /// `InitializeMotionTables` + `initted` + `LeaveGround` are
    /// physics/renderer-side (`CPhysicsObj`) and stay with their owners
    /// (DESIGN.md STAGE 2 AMENDMENT / LeaveGround fan-out section).
    #[allow(dead_code)] // staged: stage-3 per-entity construction (DESIGN.md STAGE 3 AMENDMENT)
    pub(crate) fn enter_default_state(&mut self) {
        self.raw_state = RawState::default();
        self.interpreted_state = InterpretedState::default();
        self.add_to_queue(0, MOTION_READY, 0);
    }

    /// `CMotionInterp::ReportExhaustion` (`acclient.c:344318-344332`;
    /// fan-out `MovementManager::ReportExhaustion` `:339421-339434`) —
    /// the stamina-0-crossing event re-runs the interpretation so run
    /// promotion resolves at the exhausted rate (the D2(b) half; the
    /// rate INPUT itself is `player_run_rate()`'s gated stamina term,
    /// `holtburger-world` `context.rs`). Retail's autonomous arm re-runs
    /// `apply_raw_movement`; the non-autonomous
    /// `apply_interpreted_movement` arm belongs to the Stage-3 remote
    /// lane (no port yet — `move_to_interpreted_state` is its entry) and
    /// the MoveToManager fan-out lands with Stage 3.
    #[allow(dead_code)] // staged: stamina 0-crossing event source is the stage-3 vitals lane
    pub(crate) fn report_exhaustion(
        &mut self,
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
    ) {
        if last_move_was_autonomous {
            self.apply_raw_movement(inq_run_rate);
        }
    }
}

/// STAGE-1 integrator entry point — the unified-pipeline replacement for
/// `local_velocity_for_state` (`common.rs:686-734`), consumed by
/// `MovementSystem::advance_local_pose_for_manual_drive_slice` under the
/// `USE_INTERPRETED_VELOCITY` gate. Builds the raw state for the manual
/// drive input, runs the full `apply_raw_movement` interpretation with
/// the caller's run rate (the `InqRunRate` input — `capabilities.
/// run_rate_scalar`, sourced from the ACE-composed `player_run_rate()`),
/// composes the on-ground velocity from the AUTHORED cycle bases, and
/// rotates the body-frame result into the world frame (forward along
/// `heading`, positive sidestep to the right — same convention as the
/// legacy path; signed speeds fold direction in via
/// `planar_velocity_for_heading`'s linearity).
///
/// Contract (stage-1 identity test): for every (gait, locomotion,
/// run_rate) cell this lands within float-epsilon of the legacy
/// `local_velocity_for_state` — the constants encode the same retail
/// chain; the swap is behaviour-preserving where the legacy path was
/// right, and replaces four disagreeing speed sources with this one.
pub(crate) fn interpreted_velocity_for_state(
    heading: f32,
    state: MotionState,
    capabilities: &SelfMovementCapabilities,
) -> Vector3 {
    let mut interp = MotionInterp {
        raw_state: RawState::from_motion_state(state),
        ..MotionInterp::default()
    };
    interp.apply_raw_movement(Some(capabilities.run_rate_scalar));
    let body = interp.ground_velocity(
        capabilities.base_walk_forward_speed(),
        capabilities.base_run_forward_speed(),
    );
    planar_velocity_for_heading(heading, body.y)
        + planar_velocity_for_heading(heading + FRAC_PI_2, body.x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::movement_types::Gait;
    use holtburger_protocol::messages::movement::MotionStance;
    use holtburger_world::{
        PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics,
    };

    /// Capabilities with the AUTHORED player MotionTable cycle bases —
    /// run 4.000 / walk 2.602 m/s, the documented test fixtures
    /// (exact MOTK derivations, `docs/2026-06-05-movement-fixes/NOTES.md`).
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

    fn interp_for(state: MotionState, run_rate: Option<f32>) -> MotionInterp {
        let mut interp = MotionInterp {
            raw_state: RawState::from_motion_state(state),
            ..MotionInterp::default()
        };
        interp.apply_raw_movement(run_rate);
        interp
    }

    // -----------------------------------------------------------------
    // adjust_motion / apply_run_to_command — pinned to the acclient/ACE
    // constants (acclient.c:343746-343803 / :343439-343483).
    // -----------------------------------------------------------------

    /// WalkBackwards → WalkForward with `speed *= -0.649_999_98`
    /// (`MotionInterp.cs:404-406`); the Run hold key still run-scales the
    /// (negative) speed but does NOT promote it to RunForward (only
    /// `speed > 0` promotes — `MotionInterp.cs:539-543`).
    #[test]
    fn adjust_motion_backstep_rewrites_walk_forward_negative() {
        let walk = interp_for(MotionState::builder().walk().backstep().build(), Some(2.0));
        assert_eq!(
            walk.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward)
        );
        assert!((walk.interpreted_state.forward_speed - (-BACKWARDS_FACTOR)).abs() < 1e-6);

        let run = interp_for(MotionState::builder().run().backstep().build(), Some(2.0));
        assert_eq!(
            run.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward),
            "negative speed must NOT promote to RunForward"
        );
        assert!((run.interpreted_state.forward_speed - (-BACKWARDS_FACTOR * 2.0)).abs() < 1e-6);
    }

    /// Sidestep normal form: Left negates, every sidestep scales by
    /// `0.5 × (3.1199999 / 1.25)` ≈ 1.248 (`MotionInterp.cs:411-418`),
    /// and the run-scaled anim rate clamps at ±3.0
    /// (`MotionInterp.cs:550-560`).
    #[test]
    fn adjust_motion_sidestep_factor_and_run_clamp() {
        let adjust = SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED); // ≈ 1.248
        let walk_left = interp_for(MotionState::builder().walk().strafe_left().build(), None);
        assert!(walk_left.interpreted_state.sidestep);
        assert!((walk_left.interpreted_state.sidestep_speed - (-adjust)).abs() < 1e-6);

        // run_rate 2.0: 1.248 × 2.0 = 2.496 < 3.0, no clamp.
        let run_right =
            interp_for(MotionState::builder().run().strafe_right().build(), Some(2.0));
        assert!((run_right.interpreted_state.sidestep_speed - adjust * 2.0).abs() < 1e-6);

        // run_rate 4.5: 1.248 × 4.5 = 5.616 → clamps to ±3.0.
        let clamped_r =
            interp_for(MotionState::builder().run().strafe_right().build(), Some(4.5));
        assert!((clamped_r.interpreted_state.sidestep_speed - MAX_SIDESTEP_ANIM_RATE).abs() < 1e-6);
        let clamped_l =
            interp_for(MotionState::builder().run().strafe_left().build(), Some(4.5));
        assert!(
            (clamped_l.interpreted_state.sidestep_speed + MAX_SIDESTEP_ANIM_RATE).abs() < 1e-6
        );
    }

    /// Turn normal form: Left negates; Run hold key multiplies by the
    /// FIXED 1.5 `RunTurnFactor` (`MotionInterp.cs:545-548`), never the
    /// run rate.
    #[test]
    fn adjust_motion_turn_negates_left_and_run_applies_fixed_factor() {
        let walk = interp_for(MotionState::builder().walk().turn_left().build(), None);
        assert!(walk.interpreted_state.turn);
        assert!((walk.interpreted_state.turn_speed - (-1.0)).abs() < 1e-6);

        // run_rate 4.5 must NOT leak into the turn speed — factor is 1.5.
        let run = interp_for(MotionState::builder().run().turn_right().build(), Some(4.5));
        assert!((run.interpreted_state.turn_speed - RUN_TURN_FACTOR).abs() < 1e-6);
    }

    /// Run promotion: WalkForward(speed 1.0) + Run hold key →
    /// RunForward with `speed = run_rate` (`MotionInterp.cs:539-543`),
    /// and the promotion refreshes `my_run_rate`
    /// (`acclient.c:344162-344163`).
    #[test]
    fn run_holdkey_promotes_walk_forward_and_refreshes_my_run_rate() {
        let mut interp = interp_for(
            MotionState::builder().run().forward().build(),
            Some(1.9166666),
        );
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        assert!((interp.interpreted_state.forward_speed - 1.9166666).abs() < 1e-6);
        assert!((interp.my_run_rate - 1.9166666).abs() < 1e-6);

        // InqRunRate failure now degrades to the LAST KNOWN rate, not 1.0.
        interp.apply_raw_movement(None);
        assert!((interp.interpreted_state.forward_speed - 1.9166666).abs() < 1e-6);
    }

    // -----------------------------------------------------------------
    // get_state_velocity (acclient.c:343539-343594 / MotionInterp.cs:678-699)
    // -----------------------------------------------------------------

    /// Closed-form constants: walk y = 3.1199999 × speed, run y = 4.0 ×
    /// speed, sidestep x = 1.25 × speed.
    #[test]
    fn get_state_velocity_uses_retail_constants() {
        let walk = interp_for(MotionState::builder().walk().forward().build(), Some(1.0));
        let v = walk.get_state_velocity(Some(1.0));
        assert!((v.y - WALK_ANIM_SPEED).abs() < 1e-6);
        assert_eq!(v.x, 0.0);

        let run = interp_for(MotionState::builder().run().forward().build(), Some(1.5));
        let v = run.get_state_velocity(Some(1.5));
        assert!((v.y - RUN_ANIM_SPEED * 1.5).abs() < 1e-5);

        let strafe = interp_for(MotionState::builder().walk().strafe_right().build(), Some(1.0));
        let v = strafe.get_state_velocity(Some(1.0));
        let adjust = SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED);
        assert!((v.x - SIDESTEP_ANIM_SPEED * adjust).abs() < 1e-6); // 1.56 m/s
    }

    /// Magnitude clamps to `run_rate × 4.0` (`MotionInterp.cs:691-697`):
    /// run forward + run strafe at run_rate 1.0 exceeds 4.0 combined and
    /// must be normalized back onto the cap.
    #[test]
    fn get_state_velocity_clamps_magnitude_to_run_rate_times_four() {
        let diagonal = interp_for(
            MotionState::builder().run().forward().strafe_right().build(),
            Some(1.0),
        );
        let v = diagonal.get_state_velocity(Some(1.0));
        let max_speed = RUN_ANIM_SPEED * 1.0;
        assert!(
            (v.length() - max_speed).abs() < 1e-5,
            "diagonal magnitude must clamp to run_rate×4.0, got {}",
            v.length()
        );
    }

    // -----------------------------------------------------------------
    // THE VELOCITY CONTRACT (DESIGN.md §2) — regression pins for the
    // measured snapback bug (NOTES.md:33-54).
    // -----------------------------------------------------------------

    /// Regression pin, the OLD ~7.7 chain: with the wire Run skill 100
    /// the ACE formula gives run_rate 1.9166666 and ground speed
    /// 4.000 × 1.9166666 = 7.6667 m/s — the measured ~7.7 IS
    /// formula-correct (`acclient.c:713801`); the snapback root is the
    /// run-rate INPUT, not the chain.
    #[test]
    fn velocity_contract_run_skill_100_gives_7_67_ground_speed() {
        let run_rate = holtburger_world::context::run_rate_from_skill_and_burden(100.0, 0.0);
        assert!((run_rate - 1.9166666).abs() < 1e-5);

        let capabilities = authored_capabilities(run_rate);
        let v = interpreted_velocity_for_state(
            0.0,
            MotionState::builder().run().forward().build(),
            &capabilities,
        );
        assert!(
            (v.length() - 7.666_666_5).abs() < 1e-4,
            "run skill 100 ground speed must be 4.0 × 1.9167 ≈ 7.667, got {}",
            v.length()
        );
    }

    /// Regression pin, the SNAPBACK scenario: when the run-rate input is
    /// UNAVAILABLE the pipeline falls back to `my_run_rate` (initial
    /// 1.0) → 4.0 m/s. It must NEVER emit a skill-synthesized rate ACE
    /// doesn't hold (the retired Quickness fallback / 4.5 seed —
    /// DESIGN.md §2 defect 1).
    #[test]
    fn velocity_contract_unavailable_run_rate_falls_back_to_my_run_rate() {
        let interp = interp_for(MotionState::builder().run().forward().build(), None);
        let v = interp.ground_velocity(2.602, 4.0);
        assert!(
            (v.y - 4.0).abs() < 1e-6,
            "no run-rate input → my_run_rate 1.0 → 4.0 m/s, got {}",
            v.y
        );
    }

    /// Walk ground speed is the AUTHORED walk cycle base — 2.602 m/s
    /// exact (MOTK derivation), NOT the closed-form 3.1199999.
    #[test]
    fn velocity_contract_walk_uses_authored_2_602_base() {
        let capabilities = authored_capabilities(1.9166666);
        let v = interpreted_velocity_for_state(
            0.0,
            MotionState::builder().walk().forward().build(),
            &capabilities,
        );
        assert!((v.length() - 2.602).abs() < 1e-5, "got {}", v.length());
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
                        let legacy = super::super::common::local_velocity_for_state(
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

    // -----------------------------------------------------------------
    // Hold-key transitions + server lane
    // -----------------------------------------------------------------

    /// Run-toggle transition (`SetHoldKey`): the SAME held raw forward
    /// re-interprets Walk↔Run as the hold key flips, with the speed
    /// following (1.0 ↔ run_rate).
    #[test]
    fn set_hold_run_reinterprets_held_forward() {
        let mut interp = interp_for(MotionState::builder().walk().forward().build(), Some(2.0));
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward)
        );
        assert!((interp.interpreted_state.forward_speed - 1.0).abs() < 1e-6);

        interp.set_hold_run(true, Some(2.0));
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        assert!((interp.interpreted_state.forward_speed - 2.0).abs() < 1e-6);

        interp.set_hold_run(false, Some(2.0));
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward)
        );
        assert!((interp.interpreted_state.forward_speed - 1.0).abs() < 1e-6);
    }

    /// `stop_completely` clears both states' locomotion to defaults.
    #[test]
    fn stop_completely_clears_raw_and_interpreted_movement() {
        let mut interp = interp_for(
            MotionState::builder().run().forward().strafe_left().build(),
            Some(2.0),
        );
        interp.stop_completely();
        // Locomotion axes reset to defaults; the held Run key SURVIVES
        // (retail `StopCompletely` clears commands, not the hold key —
        // `MotionInterp.cs:309-312`).
        assert_eq!(
            interp.raw_state,
            RawState {
                current_holdkey: HoldKey::Run,
                ..RawState::default()
            }
        );
        assert_eq!(interp.interpreted_state.forward_command, None);
        assert!(!interp.interpreted_state.sidestep);
        assert_eq!(interp.ground_velocity(2.602, 4.0), Vector3::zero());
    }

    /// 15-bit stamp compare: directional half-window (0x3FFF) with
    /// wraparound at 0x8000.
    #[test]
    fn action_stamp_compare_is_15_bit_with_wraparound() {
        assert!(is_newer_action_stamp(1, 0));
        assert!(!is_newer_action_stamp(0, 1));
        assert!(!is_newer_action_stamp(5, 5));
        // Window edge: +0x3FFF newer, +0x4000 not.
        assert!(is_newer_action_stamp(0x3FFF, 0));
        assert!(!is_newer_action_stamp(0x4000, 0));
        // 15-bit wraparound: 0 follows 0x7FFF.
        assert!(is_newer_action_stamp(0, 0x7FFF));
        assert!(!is_newer_action_stamp(0x7FFF, 0));
    }

    /// Server `UpdateMotion` lane: actions replay only with newer stamps;
    /// the autonomous local player skips self-echoed autonomous actions
    /// AND re-derives the movement from local raw state (server movement
    /// ignored — `acclient.c:344410`, `:339543-339562`).
    #[test]
    fn move_to_interpreted_state_gates_stamps_and_local_autonomy() {
        let mut interp = interp_for(MotionState::builder().run().forward().build(), Some(2.0));

        let mut server_state = InterpretedState::default();
        server_state.forward_command = Some(InterpretedForwardCommand::WalkForward);
        server_state.forward_speed = 1.0;

        let actions = [
            RawAction { action: 0x1000_0062, speed: 1.0, stamp: 1, autonomous: false },
            // Self-echo: autonomous bit set, must be skipped locally.
            RawAction { action: 0x1000_0063, speed: 1.0, stamp: 2, autonomous: true },
            // Stale stamp: must not replay (and not regress the stamp).
            RawAction { action: 0x1000_0064, speed: 1.0, stamp: 1, autonomous: false },
        ];

        // Autonomous local player: movement re-derived from raw (still
        // RunForward × 2.0), echo skipped, fresh server action queued.
        interp.move_to_interpreted_state(&server_state, &actions, true, Some(2.0));
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward),
            "server movement must be ignored for the autonomous local player"
        );
        assert_eq!(interp.server_action_stamp, 2);
        assert_eq!(
            interp.interpreted_state.actions,
            std::collections::VecDeque::from([(0x1000_0062, 1.0)])
        );

        // Server-controlled object: movement copy TAKES EFFECT.
        let mut remote = MotionInterp::default();
        remote.move_to_interpreted_state(&server_state, &[], false, None);
        assert_eq!(
            remote.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward)
        );
        assert!((remote.interpreted_state.forward_speed - 1.0).abs() < 1e-6);
    }

    // ------------------------------------------------------------------
    // STAGE 2 AMENDMENT completion layer, A3-D2 FIFO lane (2026-06-12).
    // ------------------------------------------------------------------

    /// `add_to_queue` appends; `motion_done` pops strictly head-first
    /// (`acclient.c:343406-343437`, `:343641-343676`).
    #[test]
    fn pending_motions_queue_is_fifo() {
        let mut interp = MotionInterp::default();
        interp.add_to_queue(1, 0x4500_0005, 0);
        interp.add_to_queue(2, MOTION_READY, 0);
        assert!(interp.motions_pending());

        interp.motion_done(true);
        assert_eq!(
            interp.pending_motions.front(),
            Some(&PendingMotion {
                context_id: 2,
                motion: MOTION_READY,
                jump_error_code: 0
            })
        );
        interp.motion_done(true);
        assert!(!interp.motions_pending());
        // Empty-queue MotionDone is a no-op (retail head-null guard).
        assert!(!interp.motion_done(true));
    }

    /// A completed one-shot action (`motion & 0x10000000`) fires the
    /// unstick hook and drains ONE action from BOTH state FIFOs — THE
    /// drain that makes `interp_state.rs:31` true
    /// (`acclient.c:343656-343661`). Non-action completions touch
    /// neither.
    #[test]
    fn motion_done_action_pop_removes_raw_and_interp_actions() {
        let mut interp = MotionInterp::default();
        interp.interpreted_state.apply_action(0x1000_0062, 1.0);
        interp.interpreted_state.apply_action(0x1000_0063, 1.0);
        interp.raw_state.actions.push(RawAction {
            action: 0x1000_0062,
            speed: 1.0,
            stamp: 1,
            autonomous: true,
        });

        // Non-action node first: no unstick, no action drain.
        interp.add_to_queue(1, MOTION_READY, 0);
        assert!(!interp.motion_done(true));
        assert_eq!(interp.interpreted_state.num_actions(), 2);
        assert_eq!(interp.raw_state.actions.len(), 1);

        // Action node: unstick fires, both FIFOs pop their heads.
        interp.add_to_queue(2, 0x1000_0062, 0);
        assert!(interp.motion_done(true));
        assert_eq!(
            interp.interpreted_state.actions,
            VecDeque::from([(0x1000_0063, 1.0)])
        );
        assert!(interp.raw_state.actions.is_empty());
        // Further RemoveActions on empty FIFOs return 0 (retail).
        assert_eq!(interp.raw_state.remove_action(), 0);
    }

    /// `motion_allows_jump` blocking table (`acclient.c:343295-343316`):
    /// seated/crouched emote ranges + Fallen block with error 72; plain
    /// locomotion and one-shot actions outside the ranges permit.
    #[test]
    fn motion_allows_jump_blocking_table() {
        // Permit arms.
        assert_eq!(motion_allows_jump(0x4500_0005), 0); // WalkForward
        assert_eq!(motion_allows_jump(0x4400_0007), 0); // RunForward
        assert_eq!(motion_allows_jump(MOTION_READY), 0); // Ready 0x41000003
        assert_eq!(motion_allows_jump(0x1000_0062), 0); // generic action
        // Blocking ranges.
        assert_eq!(motion_allows_jump(0x4000_0008), 72); // Fallen
        assert_eq!(motion_allows_jump(0x4000_0016), 72); // mid-range fall-through
        assert_eq!(motion_allows_jump(0x4000_001E), 72); // 0x1E..=0x39 arm
        assert_eq!(motion_allows_jump(0x4000_0039), 72);
        assert_eq!(motion_allows_jump(0x4100_0012), 72); // 0x12..=0x14 arm
        assert_eq!(motion_allows_jump(0x4100_0014), 72);
        assert_eq!(motion_allows_jump(0x1000_006F), 72); // 0x6F..=0x78 arm
        assert_eq!(motion_allows_jump(0x1000_0128), 72); // 0x128..=0x131 arm
        // Range edges back to permit.
        assert_eq!(motion_allows_jump(0x4000_003A), 0);
        assert_eq!(motion_allows_jump(0x4100_0015), 0);
    }

    /// The accepted-motion enqueue derives the node's jump error per
    /// `acclient.c:343993-344010`: charging → 72; a blocking motion
    /// carries its own error; a permitted NON-ACTION motion falls back
    /// to the current interpreted forward command; `jump_is_allowed`
    /// consults exactly the head's code (`:343946-343948`).
    #[test]
    fn enqueue_accepted_motion_derives_jump_error_and_head_gates() {
        let mut interp = MotionInterp::default();
        assert_eq!(interp.pending_jump_error(), 0);

        interp.enqueue_accepted_motion(1, 0x4500_0005, true);
        assert_eq!(interp.pending_jump_error(), 72, "charging blocks at enqueue");
        interp.motion_done(true);

        interp.enqueue_accepted_motion(2, 0x4000_0008, false);
        assert_eq!(interp.pending_jump_error(), 72, "Fallen blocks by table");
        interp.motion_done(true);

        // Permitted locomotion with a permitted forward command → 0.
        interp.enqueue_accepted_motion(3, 0x4500_0005, false);
        assert_eq!(interp.pending_jump_error(), 0);
        interp.motion_done(true);

        // Stop arm enqueues an observable Ready completion node.
        interp.enqueue_stop(4);
        assert_eq!(
            interp.pending_motions.front(),
            Some(&PendingMotion {
                context_id: 4,
                motion: MOTION_READY,
                jump_error_code: 0
            })
        );
    }

    /// `HandleExitWorld` drains EVERY node through the same pop path —
    /// queued one-shots are cancelled (actions drained, unstick
    /// reported), never played, across teleport/portal
    /// (`acclient.c:343679-343713`).
    #[test]
    fn handle_exit_world_drains_queue_and_cancels_actions() {
        let mut interp = MotionInterp::default();
        interp.interpreted_state.apply_action(0x1000_0062, 1.0);
        interp.add_to_queue(1, 0x4500_0005, 0);
        interp.add_to_queue(2, 0x1000_0062, 0);
        interp.add_to_queue(3, MOTION_READY, 0);

        assert!(interp.handle_exit_world(), "drained action must report unstick");
        assert!(!interp.motions_pending());
        assert_eq!(interp.interpreted_state.num_actions(), 0);
    }

    /// `enter_default_state` resets both states to constructor defaults
    /// and APPENDS one Ready seed node — retail appends, it does not
    /// clear (`acclient.c:344560-344598`).
    #[test]
    fn enter_default_state_resets_states_and_seeds_ready() {
        let mut interp = MotionInterp::default();
        interp.raw_state.current_holdkey = HoldKey::Run;
        interp.raw_state.apply_forward(RawForwardCommand::WalkForward, 1.0, HoldKey::Invalid);
        interp.apply_raw_movement(Some(2.0));
        interp.add_to_queue(7, 0x4500_0005, 0);

        interp.enter_default_state();
        assert_eq!(interp.raw_state, RawState::default());
        assert_eq!(interp.interpreted_state, InterpretedState::default());
        assert_eq!(interp.pending_motions.len(), 2, "seed APPENDS after the existing node");
        assert_eq!(
            interp.pending_motions.back(),
            Some(&PendingMotion {
                context_id: 0,
                motion: MOTION_READY,
                jump_error_code: 0
            })
        );
    }

    /// The action FIFO cap: a 7th queued action refuses with WD_Error 69
    /// (`acclient.c:344600-344666` `GetNumActions() >= 6`).
    #[test]
    fn action_fifo_caps_at_six_with_error_69() {
        let mut state = InterpretedState::default();
        for i in 0..6 {
            assert_eq!(state.apply_action_capped(0x1000_0060 + i, 1.0), Ok(()));
        }
        assert_eq!(state.apply_action_capped(0x1000_0066, 1.0), Err(69));
        assert_eq!(state.num_actions(), 6);
    }

    /// `ReportExhaustion` re-runs the interpretation so run promotion
    /// resolves at the exhausted rate (`acclient.c:344318-344332`): a
    /// held Run forward re-derives from ×2.0 promotion down to the
    /// exhausted 1.0.
    #[test]
    fn report_exhaustion_rederives_run_promotion_at_exhausted_rate() {
        let mut interp = MotionInterp::default();
        interp.raw_state.current_holdkey = HoldKey::Run;
        interp.raw_state.apply_forward(RawForwardCommand::WalkForward, 1.0, HoldKey::Invalid);
        interp.apply_raw_movement(Some(2.0));
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        assert!((interp.interpreted_state.forward_speed - 2.0).abs() < 1e-6);

        // Stamina hits 0: the rate INPUT collapses to 1.0
        // (context.rs exhausted_run_skill) and the event re-derive
        // resolves promotion at the exhausted rate.
        interp.report_exhaustion(true, Some(1.0));
        assert!((interp.interpreted_state.forward_speed - 1.0).abs() < 1e-6);

        // Non-autonomous arm is the Stage-3 remote lane: no re-derive.
        interp.apply_raw_movement(Some(2.0));
        interp.report_exhaustion(false, Some(1.0));
        assert!((interp.interpreted_state.forward_speed - 2.0).abs() < 1e-6);
    }
}
