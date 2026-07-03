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

use super::interp_state::{
    InterpretedForwardCommand, InterpretedState, MOTION_NONCOMBAT_STYLE,
};
use super::motion_table_manager::MotionTableManager;
use super::params::MovementParameters;
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

/// A4 (2026-06-12, W3+ SA4F) — the renderer-realization-truth
/// `num_anims` classifier for the lattice enqueue sites
/// (`do_interpreted_motion` / `stop_interpreted_motion`).
///
/// Retail fires one `AnimDoneHook` per completed NON-LOOP (link /
/// one-shot) anim only — `CSequence::update_internal` appends
/// `anim_done_hook` exclusively when the completed node is NOT the
/// first cyclic anim (`acclient.c:340764-340773`); a steady-state loop
/// NEVER fires AnimDone per cycle. `num_anims` is `DoObjectMotion`'s
/// appended-link-anim count (out-param plumb `acclient.c:330221-330228`).
/// Under OUR renderer, action-class motions (`MOTION_ACTION_BIT`,
/// 0x10000000) are exactly the class JS realizes as tagged LoopOnce
/// overlays that report completion (`entities.js` `_tryPlayLink` /
/// `?mtQueue` tagging contract); style/substate locomotion, turns,
/// Ready stops, and default-state are realized as the KIND_MOTION gait
/// LOOP (crossfades, no `finished` event) — no completion signal ever
/// arrives, so they classify as `0` and complete through the per-frame
/// poll (`MotionTableManager::check_for_completed_motions`,
/// `acclient.c:329960-330020`). This follows the S5 bake-granularity
/// convention pinned at `motion_table_manager.rs` (module doc):
/// {0,1}-collapsed vs retail's multi-link accounting — divergence: a
/// gait-change `MotionDone` fires ~1 link-anim earlier than retail's
/// (accepted; spec SA4F §3 + §7 OQ-2 tracks the residual — a future
/// un-flattened bake must teach this classifier real counts).
/// Spec §7 OQ-6 fallback taken: ships BARE (no const) — every enqueue
/// caller is already behind default-off gates (`USE_MOVETO_DRIVER` /
/// `USE_UNPACK_MOVEMENT_SEMANTICS` / `?wasmPursuit` lane), so flag-off
/// builds are byte-identical.
pub(crate) fn renderer_num_anims(motion: u32) -> u32 {
    u32::from(motion & MOTION_ACTION_BIT != 0)
}

// A3-D3 (2026-06-12) — motion-id literals the DoMotion lattice tests
// (decompile literals at `acclient.c:344639-344653` / `:343990` /
// `:343764-343784`; ACE `MotionCommand`).
pub(crate) const MOTION_DEAD: u32 = 0x4000_0011; // 1073741841
pub(crate) const MOTION_FALLING: u32 = 0x4000_0015; // 1073741845
pub(crate) const MOTION_CROUCH: u32 = 0x4100_0012; // 1090519058
pub(crate) const MOTION_SITTING: u32 = 0x4100_0013; // 1090519059
pub(crate) const MOTION_SLEEPING: u32 = 0x4100_0014; // 1090519060
pub(crate) const MOTION_WALK_FORWARD: u32 = 0x4500_0005; // 1157627909
pub(crate) const MOTION_WALK_BACKWARDS: u32 = 0x4500_0006; // 1157627910
pub(crate) const MOTION_RUN_FORWARD: u32 = 0x4400_0007; // 1140850695
pub(crate) const MOTION_TURN_RIGHT: u32 = 0x6500_000D; // 1694498829
pub(crate) const MOTION_TURN_LEFT: u32 = 0x6500_000E; // 1694498830
pub(crate) const MOTION_SIDESTEP_RIGHT: u32 = 0x6500_000F; // 1694498831
pub(crate) const MOTION_SIDESTEP_LEFT: u32 = 0x6500_0010; // 1694498832
// P01/P02/P09 (movement-port wave 1, 2026-07-03) — the interpreter-lane
// additions, consolidated HERE per the wave-1 integration checklist
// (QUALITY-integration.md §3.2: one consts module; ADJ-1 name order
// verified against retail `command_strings` acclient.c:43468 — 0x0D =
// TurnRight, 0x0F = SideStepRight; ADJ-16 corrected values).
/// `MotionCommand.Jump` (0x2500003B) — `Bookkeep` drops it (the jump
/// path is CommenceJump/DoJump, not the lists — acclient.c:717512), and
/// `HandleKeyboardCommand`'s terminal send is gated `cmd != Jump`
/// (:717320, ADJ-3).
pub(crate) const MOTION_JUMP: u32 = 0x2500_003B; // 620757051
/// `MotionCommand.HoldRun` (0x85000001) — the run modifier command
/// (P09 OnAction case 9 → SetHoldRun; ACE MotionCommand.cs:8).
#[allow(dead_code)] // staged: P09 on_action fold (step 3/4)
pub(crate) const MOTION_HOLD_RUN: u32 = 0x8500_0001;
/// `MotionCommand.HoldSidestep` (0x85000002) — the strafe modifier
/// command (ACE MotionCommand.cs:9).
#[allow(dead_code)] // staged: P09 on_action fold (step 3/4)
pub(crate) const MOTION_HOLD_SIDESTEP: u32 = 0x8500_0002;
/// `MotionCommand.AutoRun` (0x090000C7 = 150995143, acclient.c
/// HandleKeyboardCommand autorun arm :717258) — ADJ-16: P14's
/// `0x09000047` was a typo; this is the verified literal.
#[allow(dead_code)] // staged: P03/P09 on_action fold (step 3/4)
pub(crate) const MOTION_AUTORUN_TOGGLE: u32 = 0x0900_00C7;
/// `CommandMask.ChatEmote` (`motion & 0x2000000` →
/// `CantChatEmoteInCombat`, acclient.c:344648).
pub(crate) const COMMAND_MASK_CHAT_EMOTE: u32 = 0x0200_0000;

/// Physics-side effects the DoMotion lattice would perform inline on a
/// `CPhysicsObj` — returned instead, because our physics owner is the
/// integrator + JS rig (A3-D3 spec §3 D3-0.4: effects-not-hooks shape).
/// The caller (`MovementManager::apply_unpacked_movement` /
/// future input lanes) applies them in its own domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct MotionSideEffects {
    /// `CPhysicsObj::cancel_moveto` requested (CancelMoveTo bit,
    /// acclient.c:344633-344634).
    pub cancel_moveto: bool,
    /// `CPhysicsObj::RemoveLinkAnimations` requested (Dead arm /
    /// HitGround, acclient.c:343992-343993) — renderer-side, A4/A5
    /// completion-layer territory.
    pub remove_link_animations: bool,
}

/// `MovementStruct` types 1-5 — the `CMotionInterp::PerformMovement`
/// subset (`acclient.c:344670-344720`; retail `MovementStruct.type`).
/// Types 6-9 (MoveTo/TurnTo) live on the `MovementManager` facade enum
/// (`movement_manager::MovementStruct`).
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)] // staged: input-lane constructors arrive with the Stage-3 driver / A14-I2
pub(crate) enum MotionMovementStruct {
    /// type 1 → `DoMotion`.
    RawCommand { motion: u32, params: MovementParameters },
    /// type 2 → `DoInterpretedMotion`.
    InterpretedCommand { motion: u32, params: MovementParameters },
    /// type 3 → `StopMotion`.
    StopRawCommand { motion: u32, params: MovementParameters },
    /// type 4 → `StopInterpretedMotion`.
    StopInterpretedCommand { motion: u32, params: MovementParameters },
    /// type 5 → `StopCompletely`.
    StopCompletely,
}

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
/// `acclient.c:344398-344408`). Retail takes `|new − old|` over the
/// masked 15-bit values and branches: `<= 0x3FFF` → newer iff
/// `old < new`, else → newer iff `new < old` — so at exactly delta
/// `0x4000` the verdict is DIRECTIONAL (the numerically smaller stamp
/// wins), mirroring `is_newer_u16`'s `0x8000` edge
/// (`holtburger-common/src/sequence.rs`).
#[allow(dead_code)] // staged: lib consumer is the stage-3 server UpdateMotion lane
pub(crate) fn is_newer_action_stamp(new: u16, old: u16) -> bool {
    let new = new & 0x7FFF;
    let old = old & 0x7FFF;
    let diff = new.wrapping_sub(old) & 0x7FFF;
    diff != 0 && (diff < 0x4000 || (diff == 0x4000 && new < old))
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
        // FU6 — retail adjust_motion rewrites LOCOMOTION only; a stored
        // substate passes through unadjusted (acclient.c:343746-343803
        // has no substate arm).
        RawForwardCommand::Substate(id) => (InterpretedForwardCommand::Substate(id), speed),
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
        // FU6: stored substates (gestures) likewise pass through — the
        // run promotion is a locomotion-only rewrite.
        InterpretedForwardCommand::RunForward | InterpretedForwardCommand::Substate(_) => {
            (command, speed)
        }
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
    /// A3-D3 — retail `CMotionInterp::standing_longjump`: set from the
    /// unpack case-0 flags-byte bit `0x02` (`word & 0x200`,
    /// acclient.c:339560), suppresses the velocity-bearing locomotion
    /// trio in `DoInterpretedMotion` (`:343990`), cleared by
    /// [`Self::leave_ground`] (`:344471-344476`).
    pub standing_longjump: bool,
    /// A3-D3 — retail `CMotionInterp::initted`, set by
    /// [`Self::enter_default_state`] (`acclient.c:344595`).
    pub initted: bool,
    /// Retail `CWeenieObject` vfptr[5] "player-controlled" — a STATIC
    /// property of the object, true only for the local player's own
    /// interpreter. Gates the server-echo skip in
    /// [`Self::move_to_interpreted_state`] (`acclient.c:344411`): retail
    /// skips self-echoed autonomous actions even while
    /// server-controlled, so the skip must NOT key off the dynamic
    /// `last_move_was_autonomous`. Default `false` (remote/registry
    /// entities process every newer action).
    pub player_controlled: bool,
    /// Retail `CMotionInterp::current_speed_factor` — divides the
    /// interpreted RunForward speed inside
    /// [`Self::adjusted_max_speed`] (acclient.c:343532-343534). Default
    /// 1.0; changed by client-side speed-altering enchant handling
    /// (no producer yet — FU2/row 32).
    pub current_speed_factor: f32,
}

impl Default for MotionInterp {
    fn default() -> Self {
        Self {
            raw_state: RawState::default(),
            interpreted_state: InterpretedState::default(),
            my_run_rate: 1.0,
            server_action_stamp: 0,
            pending_motions: VecDeque::new(),
            standing_longjump: false,
            initted: false,
            player_controlled: false,
            current_speed_factor: 1.0,
        }
    }
}

impl MotionInterp {
    /// Retail run-rate resolution: weenie `InqRunRate` if available,
    /// else `my_run_rate` (`MotionInterp.cs:529-537`).
    fn run_rate(&self, inq_run_rate: Option<f32>) -> f32 {
        inq_run_rate.unwrap_or(self.my_run_rate)
    }

    /// Retail `CMotionInterp::get_adjusted_max_speed`
    /// (acclient.c:343512-343535) — the INTERP-cap speed source (the
    /// `fUseAdjustedSpeed_` default is 1, :45657, so the interpolation
    /// manager reads THIS, not `get_max_speed`, then doubles it,
    /// :389227-389241). `full_base` is the resolved run-rate speed
    /// (run_rate × 4); when the INTERPRETED forward command is
    /// RunForward (a server-driven run), the base is replaced by
    /// `forward_speed / current_speed_factor` × 4.0 instead.
    pub(crate) fn adjusted_max_speed(&self, full_base: f32) -> f32 {
        if matches!(
            self.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        ) {
            (self.interpreted_state.forward_speed / self.current_speed_factor) * 4.0
        } else {
            full_base
        }
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
            // A3-D3: re-interpretation never changes the stance — the
            // style survives the rebuild (retail apply_raw_movement only
            // rewrites the locomotion axes).
            current_style: self.interpreted_state.current_style,
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
            // FU6: a substate in the slot (gesture/crouch) carries no
            // locomotion — zero forward, retail get_state_velocity
            // shape (acclient.c:343539-343594 matches locomotion only).
            Some(InterpretedForwardCommand::Substate(_)) | None => {}
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
            // FU6: substate-in-slot = zero locomotion (see
            // get_state_velocity above).
            Some(InterpretedForwardCommand::Substate(_)) | None => {}
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
    /// self-echoed autonomous actions for the PLAYER-CONTROLLED object
    /// (weenie vfptr[5], `acclient.c:344411` — a static object
    /// property, NOT the dynamic autonomy flag: retail skips echoes
    /// even while server-controlled), then `apply_current_movement` —
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
            if action.autonomous && self.player_controlled {
                // Self-echo of an action this client already played.
                // The stamp is NOT advanced — retail stamps inside the
                // process branch only (`:344413`), so a later
                // server-authored action with a stamp between the last
                // PROCESSED one and the skipped echo still replays.
                continue;
            }
            self.server_action_stamp = action.stamp & 0x7FFF;
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
    /// input (`acclient.c:344003`, `:343957`). FU6: a stored substate
    /// (gesture/crouch, row 11) reports its REAL id, so the jump gate
    /// sees exactly what retail sees — a cast windup in the slot lands
    /// in `motion_allows_jump`'s blocked band.
    fn interpreted_forward_motion_id(&self) -> u32 {
        match self.interpreted_state.forward_command {
            // Motion_WalkForward / Motion_RunForward (ACE MotionCommand).
            Some(InterpretedForwardCommand::WalkForward) | None => 0x4500_0005,
            Some(InterpretedForwardCommand::RunForward) => 0x4400_0007,
            Some(InterpretedForwardCommand::Substate(id)) => id,
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
    /// `0` = no pending node blocks jumping. Consumed by
    /// `MovementSystem::execute_jump_release` (A14-I4, W3+ S11).
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
    pub(crate) fn enter_default_state(&mut self) {
        self.raw_state = RawState::default();
        self.interpreted_state = InterpretedState::default();
        self.add_to_queue(0, MOTION_READY, 0);
        // A3-D3: the retail tail — `initted = 1; LeaveGround(this)`
        // (acclient.c:344595-344596). The LeaveGround velocity stamp is
        // physics-side (D3-5, movement/system.rs); the state half clears
        // `standing_longjump`.
        self.initted = true;
        self.leave_ground();
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

    // ------------------------------------------------------------------
    // STAGE 3 (A3-D3, 2026-06-12): the DoMotion entry lattice —
    // `CMotionInterp::{DoMotion, DoInterpretedMotion,
    // StopInterpretedMotion, StopMotion, PerformMovement}` ports.
    // Physics-obj-null (retail error 8, `WeenieError.NoPhysicsObject`,
    // acclient.c:344616) is structurally unreachable here: a
    // `MotionInterp` only exists inside a registry entry that IS the
    // physics owner — documented, not ported. Physics side effects ride
    // [`MotionSideEffects`], never inline (spec D3-0.4).
    // ------------------------------------------------------------------

    /// `CMotionInterp::InqStyle` — the interpreted state's full 32-bit
    /// current style (`acclient.c:339541`; ACE `MotionInterp.cs:187-190`).
    pub(crate) fn inq_style(&self) -> u32 {
        self.interpreted_state.current_style
    }

    /// `CMotionInterp::contact_allows_move` (`acclient.c:343882-343919`;
    /// ACE `MotionInterp.cs` `contact_allows_move`): TurnRight/TurnLeft
    /// and Dead/Falling are exempt; everything else needs walkable
    /// contact. The retail non-creature-weenie and gravity-less
    /// exemptions are object-class properties our per-entity callers
    /// fold into `on_walkable_contact` (server-controlled remotes pass
    /// `true`: the server is authoritative — see
    /// `apply_unpacked_movement`).
    pub(crate) fn contact_allows_move(motion: u32, on_walkable_contact: bool) -> bool {
        matches!(
            motion,
            MOTION_TURN_RIGHT | MOTION_TURN_LEFT | MOTION_DEAD | MOTION_FALLING
        ) || on_walkable_contact
    }

    /// Map the wire/params `hold_key_to_apply` value onto the runtime
    /// [`HoldKey`] (retail enum: 0 Invalid, 1 None, 2 Run).
    fn hold_key_from_raw(raw: u32) -> HoldKey {
        match raw {
            1 => HoldKey::NoKey,
            2 => HoldKey::Run,
            _ => HoldKey::Invalid,
        }
    }

    /// `CMotionInterp::SetHoldKey` (`acclient.c:344526+`; ACE
    /// `MotionInterp.cs:274-287`): only the Run→None downgrade
    /// re-derives the held interpretation (ACE's switch handles ONLY the
    /// `HoldKey.None` arm; an `Invalid` key — the params default — is a
    /// no-op). The retail `cancel_moveto` ride-along is a physics side
    /// effect already carried by the caller's CancelMoveTo bit.
    pub(crate) fn set_hold_key_from_params(&mut self, raw_key: u32, inq_run_rate: Option<f32>) {
        let key = Self::hold_key_from_raw(raw_key);
        if key == self.raw_state.current_holdkey {
            return;
        }
        if key == HoldKey::NoKey && self.raw_state.current_holdkey == HoldKey::Run {
            self.raw_state.current_holdkey = HoldKey::NoKey;
            self.apply_raw_movement(inq_run_rate);
        }
    }

    /// `CMotionInterp::adjust_motion`, the u32-command form the DoMotion
    /// lattice runs (`acclient.c:343746-343803`): WalkBackwards →
    /// WalkForward × `-BackwardsFactor`; TurnLeft → TurnRight negated;
    /// SideStepRight × `SidestepFactor × (Walk/Sidestep)`; SideStepLeft →
    /// SideStepRight negated then scaled; RunForward passes through
    /// untouched (no hold-key application); then the resolved Run hold
    /// key applies [`Self::apply_run_to_command_u32`].
    pub(crate) fn adjust_motion_command(
        &mut self,
        motion: &mut u32,
        speed: &mut f32,
        key: u32,
        inq_run_rate: Option<f32>,
    ) {
        let sidestep_adjust = SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED);
        match *motion {
            MOTION_RUN_FORWARD => return,
            MOTION_WALK_BACKWARDS => {
                *motion = MOTION_WALK_FORWARD;
                *speed *= -BACKWARDS_FACTOR;
            }
            MOTION_TURN_LEFT => {
                *motion = MOTION_TURN_RIGHT;
                *speed = -*speed;
            }
            MOTION_SIDESTEP_RIGHT => {
                *speed *= sidestep_adjust;
            }
            MOTION_SIDESTEP_LEFT => {
                *motion = MOTION_SIDESTEP_RIGHT;
                *speed = -*speed * sidestep_adjust;
            }
            _ => {}
        }
        if Self::hold_key_from_raw(key).resolve(self.raw_state.current_holdkey) == HoldKey::Run {
            self.apply_run_to_command_u32(motion, speed, inq_run_rate);
        }
    }

    /// `CMotionInterp::apply_run_to_command`, u32 form
    /// (`acclient.c:343439-343483`): a positive WalkForward promotes to
    /// RunForward and run-scales; TurnRight × fixed 1.5; SideStepRight
    /// run-scales then clamps at ±3.0.
    fn apply_run_to_command_u32(&self, motion: &mut u32, speed: &mut f32, inq: Option<f32>) {
        let run_rate = self.run_rate(inq);
        match *motion {
            MOTION_WALK_FORWARD => {
                if *speed > 0.0 {
                    *motion = MOTION_RUN_FORWARD;
                }
                *speed *= run_rate;
            }
            MOTION_TURN_RIGHT => {
                *speed *= RUN_TURN_FACTOR;
            }
            MOTION_SIDESTEP_RIGHT => {
                *speed = (*speed * run_rate)
                    .clamp(-MAX_SIDESTEP_ANIM_RATE, MAX_SIDESTEP_ANIM_RATE);
            }
            _ => {}
        }
    }

    /// `CMotionInterp::DoInterpretedMotion` (`acclient.c:343975-344031`;
    /// ACE `MotionInterp.cs:51-110`). Contact-fail + action → `Err(36)`
    /// (`YouCantJumpWhileInTheAir`); contact-fail + non-action →
    /// interp-apply-only success; `standing_longjump` suppresses exactly
    /// {WalkForward, RunForward, SideStepRight} (`:343990`); Dead →
    /// RemoveLinkAnimations effect (`:343992-343993`); the
    /// `CPhysicsObj::DoInterpretedMotion` inner body (sequence playback)
    /// is the A4-Q1 `motion_table_manager` enqueue (DESIGN.md:399-413,
    /// `num_anims` from [`renderer_num_anims`] — action-class = 1,
    /// loop-realized locomotion/turns = 0, A4/SA4F classification over
    /// the S5 convention; `acclient.c:340764-340773`); jump_error =
    /// 72 under DisableJumpDuringLink, else the motion's own
    /// `motion_allows_jump`, non-actions falling back to the interpreted
    /// forward command's (`:343996-344005`).
    pub(crate) fn do_interpreted_motion(
        &mut self,
        motion: u32,
        params: &MovementParameters,
        on_walkable_contact: bool,
        motion_table_manager: &mut MotionTableManager,
        effects: &mut MotionSideEffects,
    ) -> Result<(), u32> {
        if !Self::contact_allows_move(motion, on_walkable_contact) {
            if motion & MOTION_ACTION_BIT != 0 {
                return Err(36);
            }
            if params.modify_interpreted_state() {
                self.interpreted_state.apply_motion(motion, params.speed);
            }
            return Ok(());
        }
        if self.standing_longjump
            && matches!(
                motion,
                MOTION_WALK_FORWARD | MOTION_RUN_FORWARD | MOTION_SIDESTEP_RIGHT
            )
        {
            if params.modify_interpreted_state() {
                self.interpreted_state.apply_motion(motion, params.speed);
            }
            return Ok(());
        }
        if motion == MOTION_DEAD {
            effects.remove_link_animations = true;
        }
        motion_table_manager.queue_object_motion(motion, renderer_num_anims(motion));
        let jump_error = if params.disable_jump_during_link() {
            72
        } else {
            let mut error = motion_allows_jump(motion);
            if error == 0 && motion & MOTION_ACTION_BIT == 0 {
                error = motion_allows_jump(self.interpreted_forward_motion_id());
            }
            error
        };
        self.add_to_queue(params.context_id, motion, jump_error);
        if params.modify_interpreted_state() {
            self.interpreted_state.apply_motion(motion, params.speed);
        }
        Ok(())
    }

    /// `CMotionInterp::DoMotion` — THE entry lattice
    /// (`acclient.c:344600-344666`; ACE `MotionInterp.cs:112-158`):
    /// CancelMoveTo bit → effect; SetHoldKey bit → [`Self::
    /// set_hold_key_from_params`]; `adjust_motion`; style gate (only
    /// when `current_style != NonCombat`): Crouch → 63, Sitting → 64,
    /// Sleeping → 65, ChatEmote mask → 66 — all tested against the
    /// ORIGINAL (pre-adjust) motion, exactly as retail's `v6`; action
    /// bit + `GetNumActions() >= 6` → 69; then `DoInterpretedMotion`
    /// with the ADJUSTED motion/speed; on success the ModifyRawState
    /// bit applies the ORIGINAL motion to the raw state.
    pub(crate) fn do_motion(
        &mut self,
        motion: u32,
        params: &MovementParameters,
        on_walkable_contact: bool,
        inq_run_rate: Option<f32>,
        motion_table_manager: &mut MotionTableManager,
        effects: &mut MotionSideEffects,
    ) -> Result<(), u32> {
        let mut adjusted_params = *params;
        let mut adjusted_motion = motion;
        if params.cancel_moveto() {
            effects.cancel_moveto = true;
        }
        if params.set_hold_key() {
            self.set_hold_key_from_params(params.hold_key_to_apply, inq_run_rate);
        }
        self.adjust_motion_command(
            &mut adjusted_motion,
            &mut adjusted_params.speed,
            params.hold_key_to_apply,
            inq_run_rate,
        );
        if self.interpreted_state.current_style != MOTION_NONCOMBAT_STYLE {
            match motion {
                MOTION_CROUCH => return Err(63),
                MOTION_SITTING => return Err(64),
                MOTION_SLEEPING => return Err(65),
                _ => {}
            }
            if motion & COMMAND_MASK_CHAT_EMOTE != 0 {
                return Err(66);
            }
        }
        if motion & MOTION_ACTION_BIT != 0 && self.interpreted_state.num_actions() >= 6 {
            return Err(69);
        }
        self.do_interpreted_motion(
            adjusted_motion,
            &adjusted_params,
            on_walkable_contact,
            motion_table_manager,
            effects,
        )?;
        if params.modify_raw_state() {
            self.raw_state.apply_motion_u32(motion, params);
        }
        Ok(())
    }

    /// `CMotionInterp::StopInterpretedMotion` (`acclient.c:344034-344078`):
    /// contact-fail OR standing-longjump-suppressed trio → interp
    /// RemoveMotion only, success; else the
    /// `CPhysicsObj::StopInterpretedMotion` analog (Stop → Ready node on
    /// the A4-Q1 queue), an observable Ready (`0x41000003`) completion
    /// node on `pending_motions`, then the ModifyInterpretedState
    /// removal. A4/SA4F: the Ready stop node enqueues `num_anims = 0`
    /// — our stop realization is the KIND_MOTION idle crossfade, never
    /// a completable clip (retail Ready node `acclient.c:330233-330245`;
    /// classification rationale at [`renderer_num_anims`]), so it
    /// completes through the per-frame poll.
    pub(crate) fn stop_interpreted_motion(
        &mut self,
        motion: u32,
        params: &MovementParameters,
        on_walkable_contact: bool,
        motion_table_manager: &mut MotionTableManager,
        _effects: &mut MotionSideEffects,
    ) -> Result<(), u32> {
        let suppressed = !Self::contact_allows_move(motion, on_walkable_contact)
            || (self.standing_longjump
                && matches!(
                    motion,
                    MOTION_WALK_FORWARD | MOTION_RUN_FORWARD | MOTION_SIDESTEP_RIGHT
                ));
        if suppressed {
            if params.modify_interpreted_state() {
                self.interpreted_state.remove_motion(motion);
            }
            return Ok(());
        }
        motion_table_manager.queue_object_motion_stop(0);
        self.add_to_queue(params.context_id, MOTION_READY, 0);
        if params.modify_interpreted_state() {
            self.interpreted_state.remove_motion(motion);
        }
        Ok(())
    }

    /// `CMotionInterp::StopMotion` (`acclient.c:344081-344143`):
    /// CancelMoveTo bit → effect; copy params; `adjust_motion`;
    /// `StopInterpretedMotion` with the adjusted motion; on success the
    /// ModifyRawState bit removes the ORIGINAL motion from the raw
    /// state (`RawMotionState::RemoveMotion`, `:344133-344135`).
    pub(crate) fn stop_motion(
        &mut self,
        motion: u32,
        params: &MovementParameters,
        on_walkable_contact: bool,
        inq_run_rate: Option<f32>,
        motion_table_manager: &mut MotionTableManager,
        effects: &mut MotionSideEffects,
    ) -> Result<(), u32> {
        if params.cancel_moveto() {
            effects.cancel_moveto = true;
        }
        let mut adjusted_params = *params;
        let mut adjusted_motion = motion;
        self.adjust_motion_command(
            &mut adjusted_motion,
            &mut adjusted_params.speed,
            params.hold_key_to_apply,
            inq_run_rate,
        );
        self.stop_interpreted_motion(
            adjusted_motion,
            &adjusted_params,
            on_walkable_contact,
            motion_table_manager,
            effects,
        )?;
        if params.modify_raw_state() {
            self.raw_state.remove_motion_u32(motion);
        }
        Ok(())
    }

    /// `CMotionInterp::PerformMovement` (`acclient.c:344670-344720`;
    /// ACE `MotionInterp.cs:236-258`): 5-way dispatch with the A4-Q1
    /// completion pump (`check_for_completed_motions`) after EVERY arm —
    /// a zero-anim motion completes inside the same call. The retail
    /// `default → 71` arm is made unreachable by the typed
    /// [`MotionMovementStruct`]; the facade
    /// (`movement_manager::MovementManager::perform_movement`) owns the
    /// type 6-9 routing and the residual 71.
    pub(crate) fn perform_movement(
        &mut self,
        mvs: &MotionMovementStruct,
        on_walkable_contact: bool,
        inq_run_rate: Option<f32>,
        motion_table_manager: &mut MotionTableManager,
        effects: &mut MotionSideEffects,
    ) -> Result<(), u32> {
        let result = match mvs {
            MotionMovementStruct::RawCommand { motion, params } => self.do_motion(
                *motion,
                params,
                on_walkable_contact,
                inq_run_rate,
                motion_table_manager,
                effects,
            ),
            MotionMovementStruct::InterpretedCommand { motion, params } => self
                .do_interpreted_motion(
                    *motion,
                    params,
                    on_walkable_contact,
                    motion_table_manager,
                    effects,
                ),
            MotionMovementStruct::StopRawCommand { motion, params } => self.stop_motion(
                *motion,
                params,
                on_walkable_contact,
                inq_run_rate,
                motion_table_manager,
                effects,
            ),
            MotionMovementStruct::StopInterpretedCommand { motion, params } => self
                .stop_interpreted_motion(
                    *motion,
                    params,
                    on_walkable_contact,
                    motion_table_manager,
                    effects,
                ),
            MotionMovementStruct::StopCompletely => {
                self.stop_completely();
                Ok(())
            }
        };
        motion_table_manager.check_for_completed_motions();
        result
    }

    /// `CMotionInterp::LeaveGround`, state half
    /// (`acclient.c:344457-344490`; ACE `MotionInterp.cs:192-208`):
    /// clear `standing_longjump` (+ retail's `jump_extent`, which lives
    /// with the charge owner here). The launch-velocity stamp is the
    /// D3-5 `USE_LEAVE_GROUND_VELOCITY` slice in `movement/system.rs`;
    /// RemoveLinkAnimations is renderer-side (A4/A5).
    pub(crate) fn leave_ground(&mut self) {
        self.standing_longjump = false;
    }

    /// `CMotionInterp::HitGround` (ACE `MotionInterp.cs:175-185`):
    /// RemoveLinkAnimations effect + `apply_current_movement` re-derive
    /// (autonomous arm only — the server-controlled arm is the wire's
    /// own next UpdateMotion).
    #[allow(dead_code)] // staged: facade fan-out consumer is the Stage-3 driver / A1 tick spine
    pub(crate) fn hit_ground(
        &mut self,
        last_move_was_autonomous: bool,
        inq_run_rate: Option<f32>,
        effects: &mut MotionSideEffects,
    ) {
        effects.remove_link_animations = true;
        self.apply_current_movement(last_move_was_autonomous, inq_run_rate);
    }
}

// ── P13 tails (movement-port wave 1, 2026-07-03) ────────────────────────
// `CMotionInterp` residual methods the A3/A14 waves never needed: the
// consolidated jump gates + speed/standstill queries retail dispatches
// through the interp vtable. Weenie/physics facts arrive as resolved
// values per the crate's existing `inq_run_rate`/`on_walkable_contact`
// convention.

/// `WeenieError` ids used by the P13 jump tails (ACE `WeenieError.cs`:
/// 0x24/0x48/0x49). `WEENIE_ERROR_GENERAL_MOVEMENT_FAILURE` (71) is
/// reused from `movement_manager.rs`.
const WEENIE_ERROR_YOU_CANT_JUMP_WHILE_IN_THE_AIR: u32 = 0x24; // 36
const WEENIE_ERROR_CANT_JUMP_FROM_THIS_POSITION: u32 = 0x48; // 72
const WEENIE_ERROR_CANT_JUMP_LOADED_DOWN: u32 = 0x49; // 73
/// Retail `get_jump_v_z` extent floor (acclient.c:343351 literal
/// `0.00019999999`; ACE `PhysicsGlobals.EPSILON`).
const JUMP_EXTENT_EPSILON: f32 = 0.000_199_999_99;

/// `CMotionInterp::get_jump_v_z` (acclient.c:343343-343363; ACE
/// `MotionInterp.cs:634-652`) — launch z-velocity for a charged jump.
/// Below `EPSILON` → 0.0; clamp `(EPSILON, 1.0]`; NO weenie → 10.0;
/// weenie present but `InqJumpVelocity` (vfptr[12]) fails → 0.0.
///
/// SEAM: `inq_jump_velocity == None` ⇔ no weenie (→ 10.0); `Some(f)`
/// wires the entity's `InqJumpVelocity`, invoked with the *clamped*
/// extent (the clamp stays authoritative here). Free fn because the
/// rust `MotionInterp` does not store `jump_extent` (it lives in
/// `world.player` / the charge clock). holtburger's local-player
/// realization of the query is
/// `holtburger_world::player::PlayerState::compute_jump_velocity_z`
/// (burden × skill), already called from
/// `MovementSystem::execute_jump_release` with an extent pre-clamped to
/// `[MIN_JUMP_EXTENT, 1.0]` by `power()` — so on that path the
/// clamp/floor here are no-ops (P13 OQ-2).
#[allow(dead_code)] // staged: registry/remote jump lane (local path pre-clamps upstream)
pub(crate) fn jump_v_z<F: FnOnce(f32) -> Option<f32>>(
    jump_extent: f32,
    inq_jump_velocity: Option<F>,
) -> f32 {
    if jump_extent < JUMP_EXTENT_EPSILON {
        return 0.0;
    }
    let extent = jump_extent.min(1.0);
    match inq_jump_velocity {
        None => 10.0,
        Some(query) => query(extent).unwrap_or(0.0),
    }
}

/// Resolved-seam inputs for [`MotionInterp::jump_is_allowed`] — the
/// physics/weenie facts retail reads through vtable dispatch, supplied by
/// the caller (physics/weenie do not live in `MotionInterp` in this
/// port). Plain data for testability, per house convention.
#[allow(dead_code)] // staged: consolidated per-entity jump gate (ADJ-10 single-owner refactor)
pub(crate) struct JumpAllowEnv {
    /// `has_weenie && !weenie.is_creature()` (vfptr[11], acclient.c:343937)
    /// — a non-creature/weenie-less object bypasses the air-gate.
    pub weenie_noncreature: bool,
    /// physics `state & Gravity` (BYTE1&4, acclient.c:343939).
    pub has_gravity: bool,
    /// physics `transient & (Contact | OnWalkable)` — grounded
    /// (acclient.c:343940).
    pub on_walkable_contact: bool,
    /// `CPhysicsObj::IsFullyConstrained` (acclient.c:343942).
    pub fully_constrained: bool,
    /// raw forward command / posture id for the charge + posture gates.
    pub forward_substate: u32,
    /// resolved weenie `CanJump(extent)` (`true` when no weenie).
    pub can_jump: bool,
    /// weenie present at all (gates the stamina fold, acclient.c:343956).
    pub has_weenie: bool,
    /// weenie `JumpStaminaCost(extent, &cost) != 0` (vfptr[16]) — `true`
    /// == affordability check SUCCEEDED (acclient.c:343957).
    pub jump_stamina_ok: bool,
}

impl MotionInterp {
    /// `CMotionInterp::get_max_speed` (acclient.c:343486-343508; ACE
    /// `MotionInterp.cs:665-676`) — the UNADJUSTED interp speed base:
    /// resolved run rate × `RUN_ANIM_SPEED` (4.0), with NO
    /// interpreted-run override (that override is `adjusted_max_speed`,
    /// which reads THIS as its `full_base`). Retail: no weenie → 1.0×4;
    /// `InqRunRate` success → rate×4; fail → `my_run_rate`×4 — the
    /// existing `run_rate()` helper collapses the no-weenie/fail arms to
    /// `my_run_rate` (initial 1.0), coinciding with retail at spawn
    /// (P13 OQ-1). Currently inlined for the local player as
    /// `capabilities.resolved_manual_run_speed()` then fed to
    /// `adjusted_max_speed`; this is the per-entity method.
    #[allow(dead_code)] // staged: per-entity registry speed queries
    pub(crate) fn max_speed(&self, inq_run_rate: Option<f32>) -> f32 {
        self.run_rate(inq_run_rate) * RUN_ANIM_SPEED
    }

    /// `CMotionInterp::is_standing_still` (acclient.c:343716-343725; ACE
    /// `MotionInterp.cs:702-708`): grounded on walkable contact AND the
    /// interpreted forward axis is Ready (`None`) AND no sidestep AND no
    /// turn. `on_walkable_contact` is the physics seam
    /// `transient_state & (Contact | OnWalkable)` (retail `on_ground`,
    /// acclient.c:343720-343722) — the same bool the crate already
    /// threads through the lattice.
    #[allow(dead_code)] // staged: interpreter seam `minterp_is_standing_still` (Step 3)
    pub(crate) fn is_standing_still(&self, on_walkable_contact: bool) -> bool {
        on_walkable_contact
            && self.interpreted_state.forward_command.is_none()
            && !self.interpreted_state.sidestep
            && !self.interpreted_state.turn
    }

    /// `CMotionInterp::jump_charge_is_allowed` (acclient.c:343318-343339;
    /// ACE `MotionInterp.cs:729-740`): weenie `CanJump(extent)`
    /// (vfptr[15]) fail → 73; a jump-blocking forward posture (Fallen
    /// `0x40000008`, or Crouch..=Sleeping `0x41000012..=0x41000014`) →
    /// 72; else 0.
    ///
    /// `can_jump` = `weenie.map_or(true, |w| w.can_jump(extent))` — retail
    /// refuses (73) only when a weenie is present AND CanJump is false.
    /// `forward_substate` is the RAW forward-command id: the rust
    /// `interpreted_state.forward_command` only ever holds
    /// Ready/Walk/Run locomotion (postures live in
    /// `world.player.current_substate`), so the caller passes the
    /// server-echoed substate — the SAME approximation the charge clock
    /// makes (`jump_charge.rs:134-140`, spec §6 Q5). NOTE: the charge
    /// clock deliberately does NOT run this gate at charge-*commence*
    /// time (`jump_charge.rs:141`, DESIGN.md) — per ADJ-10 the
    /// charge-commence behavior stays per DESIGN.md until a golden
    /// replay says otherwise; this method is the release-gate arm.
    #[allow(dead_code)] // staged: ADJ-10 single-owner jump gate
    pub(crate) fn jump_charge_is_allowed(&self, can_jump: bool, forward_substate: u32) -> u32 {
        if !can_jump {
            return WEENIE_ERROR_CANT_JUMP_LOADED_DOWN; // 73
        }
        if forward_substate == 0x4000_0008
            || (0x4100_0012..=0x4100_0014).contains(&forward_substate)
        {
            return WEENIE_ERROR_CANT_JUMP_FROM_THIS_POSITION; // 72
        }
        0
    }

    /// `CMotionInterp::jump_is_allowed` (acclient.c:343922-343971; ACE
    /// `MotionInterp.cs:742-768`). Order, exactly retail:
    /// 1. air-gate (else 36): attemptable when non-creature/weenie-less,
    ///    OR no gravity, OR grounded (acclient.c:343936-343940);
    /// 2. `IsFullyConstrained` → 71 (:343942);
    /// 3. queue-head `jump_error_code` (self, via `pending_jump_error`)
    ///    → that code (:343948-343949);
    /// 4. `jump_charge_is_allowed` → 73/72 (:343951);
    /// 5. `motion_allows_jump(forward_substate)` posture → 72 (:343954);
    /// 6. weenie present AND `JumpStaminaCost==0` (unaffordable) → 71
    ///    (:343957-343962). `jump_stamina_ok` = query returned non-zero.
    /// Returns 0 when allowed.
    ///
    /// Physics-null → 36 follows the decomp (:343936 outer `&&` fold),
    /// NOT ACE's early `8 NoPhysicsObject` (P13 OQ-5). Queue-head gate is
    /// head-only per the decomp (:343948), not ACE's `Count > 1`
    /// (P13 OQ-6).
    ///
    /// The LOCAL-player gate is already assembled INLINE in
    /// `MovementSystem::execute_jump_release` (identical order + codes,
    /// same `pending_jump_error()` head input); this is the consolidated
    /// per-entity method retail `CMotionInterp::jump` (acclient.c:344224)
    /// / the registry callers want. ADJ-10: refactor
    /// `execute_jump_release` onto this method in the next wave — the
    /// two sites are pinned together by `p13_tail_tests`.
    #[allow(dead_code)] // staged: ADJ-10 single-owner jump gate
    pub(crate) fn jump_is_allowed(&self, extent: f32, env: &JumpAllowEnv) -> u32 {
        // `extent` flows into the weenie seams (`can_jump`,
        // `jump_stamina_ok`) which the caller has already resolved for
        // this extent; kept in the signature to mirror retail + document
        // the dependency.
        let _ = extent;
        if !(env.weenie_noncreature || !env.has_gravity || env.on_walkable_contact) {
            return WEENIE_ERROR_YOU_CANT_JUMP_WHILE_IN_THE_AIR; // 36
        }
        if env.fully_constrained {
            return super::movement_manager::WEENIE_ERROR_GENERAL_MOVEMENT_FAILURE; // 71
        }
        let head_error = self.pending_jump_error();
        if head_error != 0 {
            return head_error;
        }
        let charge = self.jump_charge_is_allowed(env.can_jump, env.forward_substate);
        if charge != 0 {
            return charge;
        }
        let posture = motion_allows_jump(env.forward_substate); // 72 or 0
        if posture != 0 {
            return posture;
        }
        if env.has_weenie && !env.jump_stamina_ok {
            return super::movement_manager::WEENIE_ERROR_GENERAL_MOVEMENT_FAILURE; // 71
        }
        0
    }
}

/// Convert the WIRE `InterpretedMotionState`
/// (`holtburger-protocol/src/messages/movement/types.rs:226`) into the
/// runtime [`InterpretedState`] + the stamped server-action list
/// [`super::raw_state::RawAction`] that
/// [`MotionInterp::move_to_interpreted_state`] consumes — the
/// `InterpretedMotionState::UnPack` → `move_to_interpreted_state` seam of
/// `unpack_movement` case 0 (acclient.c:339546-339557). Wire commands are
/// the server's POST-adjust normal form, so forward only carries
/// WalkForward (`0x0005`) / RunForward (`0x0007`) — anything else maps to
/// "no locomotion" (`None`); a non-normalized SideStepLeft / TurnLeft is
/// folded into the signed speed defensively. Wire action commands expand
/// through the shared low16 expander
/// (`holtburger_world::player::expand_motion_command_low16`); misses are
/// skipped fail-soft (same policy as `EntityMotionSnapshot`).
pub(crate) fn interpreted_state_from_wire(
    wire: &holtburger_protocol::messages::movement::InterpretedMotionState,
) -> (InterpretedState, Vec<RawAction>) {
    let mut state = InterpretedState::default();
    if let Some(style16) = wire.current_style {
        // Style dwords all carry the 0x80000000 class prefix
        // (command_ids_0[] expansion of the wire low16).
        state.current_style = 0x8000_0000 | u32::from(style16);
    }
    state.forward_command = match wire.forward_command.map(|c| c.raw()) {
        Some(0x0005) => Some(InterpretedForwardCommand::WalkForward),
        Some(0x0007) => Some(InterpretedForwardCommand::RunForward),
        // FU6 wire completion (2026-07-03): retail expands the wire
        // low16 through command_ids[] and stores the substate ITSELF
        // in the forward slot (acclient.c:332759) — ACE's
        // EnqueueMotionMagic sends the CAST GESTURE (substate-class,
        // e.g. MagicBlast 0x4000002B) as the forward command. Expand
        // via the shared table: substate-class results occupy the slot
        // (zero locomotion; the REAL id feeds motion_allows_jump);
        // Ready canonicalizes to the empty slot; action-class ids
        // (windups 0x1000006F+) never belong in the slot — None.
        Some(low16) => match holtburger_world::player::expand_motion_command_low16(low16) {
            // Pure-0x40-prefix substates (gestures/poses: MagicBlast
            // 0x4000002B, Crouch 0x40000018, …) occupy the slot.
            // Ready (0x41…) canonicalizes to the empty slot; locomotion
            // (0x44/0x45…) never reaches this arm via the wire's
            // post-adjust normal form; action-class (0x10…, windups)
            // rides the action list, never the slot.
            Some(full) if full >> 24 == 0x40 => {
                Some(InterpretedForwardCommand::Substate(full))
            }
            _ => None,
        },
        None => None,
    };
    if let Some(speed) = wire.forward_speed {
        state.forward_speed = speed;
    }
    match wire.sidestep_command.map(|c| c.raw()) {
        Some(0x000F) => {
            state.sidestep = true;
            state.sidestep_speed = wire.sidestep_speed.unwrap_or(1.0);
        }
        Some(0x0010) => {
            state.sidestep = true;
            state.sidestep_speed = -wire.sidestep_speed.unwrap_or(1.0);
        }
        _ => {}
    }
    match wire.turn_command.map(|c| c.raw()) {
        Some(0x000D) => {
            state.turn = true;
            state.turn_speed = wire.turn_speed.unwrap_or(1.0);
        }
        Some(0x000E) => {
            state.turn = true;
            state.turn_speed = -wire.turn_speed.unwrap_or(1.0);
        }
        _ => {}
    }
    let actions = wire
        .commands
        .iter()
        .filter_map(|item| {
            let full =
                holtburger_world::player::expand_motion_command_low16(item.command.raw())?;
            Some(RawAction {
                action: full,
                speed: item.speed,
                stamp: item.sequence(),
                autonomous: item.is_autonomous(),
            })
        })
        .collect();
    (state, actions)
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

/// A3-D3-5 (`USE_LEAVE_GROUND_VELOCITY`) — the retail launch-velocity
/// form for a NON-charged airborne transition:
/// `CMotionInterp::get_leave_ground_velocity` (acclient.c:343806-343843,
/// consumed by `LeaveGround` :344457-344490; ACE `MotionInterp.cs:192`)
/// = the CLAMPED closed-form [`MotionInterp::get_state_velocity`]
/// (magnitude capped at `run_rate × 4.0`) rotated into the world frame,
/// **falling back to the integrator's transformed velocity when the
/// closed form is ~zero** (retail per-component epsilon `0.0002`,
/// acclient.c:343826). The Z component is owned by the jump/fall arc
/// (`get_jump_v_z` half), so this returns the planar launch velocity
/// only. Replaces the unclamped planar-store freeze for walk-off-ledge
/// departures (survey A3 §3 row 6: diagonal run+strafe launched ~5.7 m/s
/// vs retail's `4.0 × rate` cap).
pub(crate) fn leave_ground_velocity_for_state(
    heading: f32,
    state: MotionState,
    capabilities: &SelfMovementCapabilities,
    integrator_velocity: Vector3,
) -> Vector3 {
    const LEAVE_GROUND_EPSILON: f32 = 0.000_199_999_99;
    let mut interp = MotionInterp {
        raw_state: RawState::from_motion_state(state),
        ..MotionInterp::default()
    };
    interp.apply_raw_movement(Some(capabilities.run_rate_scalar));
    let body = interp.get_state_velocity(Some(capabilities.run_rate_scalar));
    if body.x.abs() < LEAVE_GROUND_EPSILON && body.y.abs() < LEAVE_GROUND_EPSILON {
        return integrator_velocity;
    }
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
        // Half-range edge is DIRECTIONAL (acclient.c:344405-344408: at
        // |delta| == 0x4000 the `new < old` branch decides), mirroring
        // sequence.rs `u16_half_range_is_directional`.
        assert!(is_newer_action_stamp(0, 0x4000));
        assert!(is_newer_action_stamp(0x1000, 0x5000));
        assert!(!is_newer_action_stamp(0x5000, 0x1000));
        // The wire 16th bit (autonomous flag) is masked out of the compare.
        assert!(is_newer_action_stamp(0x8002, 1));
        assert!(!is_newer_action_stamp(0x8001, 1));
    }

    /// Server `UpdateMotion` lane: actions replay only with newer stamps;
    /// the PLAYER-CONTROLLED object skips self-echoed autonomous actions
    /// WITHOUT advancing the stamp (the update sits inside retail's
    /// process branch, `acclient.c:344408-344418`), and the autonomous
    /// local player re-derives the movement from local raw state
    /// (server movement ignored — `acclient.c:344410`).
    #[test]
    fn move_to_interpreted_state_gates_stamps_and_local_autonomy() {
        let mut interp = interp_for(MotionState::builder().run().forward().build(), Some(2.0));
        interp.player_controlled = true;

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
        assert_eq!(
            interp.server_action_stamp, 1,
            "a skipped echo must NOT advance the stamp (acclient.c:344413)"
        );
        assert_eq!(
            interp.interpreted_state.actions,
            std::collections::VecDeque::from([(0x1000_0062, 1.0)])
        );

        // Because the skipped echo left the stamp at 1, a later
        // server-authored action re-using stamp 2 still replays.
        let follow_up = [RawAction {
            action: 0x1000_0065,
            speed: 1.0,
            stamp: 2,
            autonomous: false,
        }];
        interp.move_to_interpreted_state(&server_state, &follow_up, true, Some(2.0));
        assert_eq!(interp.server_action_stamp, 2);
        assert_eq!(
            interp.interpreted_state.actions,
            std::collections::VecDeque::from([(0x1000_0062, 1.0), (0x1000_0065, 1.0)])
        );

        // Server-controlled object (player_controlled = false): movement
        // copy TAKES EFFECT, and even AUTONOMOUS actions replay (retail
        // processes them for any non-player-controlled weenie,
        // acclient.c:344411).
        let mut remote = MotionInterp::default();
        let remote_actions = [RawAction {
            action: 0x1000_0063,
            speed: 1.0,
            stamp: 2,
            autonomous: true,
        }];
        remote.move_to_interpreted_state(&server_state, &remote_actions, false, None);
        assert_eq!(
            remote.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward)
        );
        assert!((remote.interpreted_state.forward_speed - 1.0).abs() < 1e-6);
        assert_eq!(remote.server_action_stamp, 2);
        assert_eq!(
            remote.interpreted_state.actions,
            std::collections::VecDeque::from([(0x1000_0063, 1.0)])
        );
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

    // ------------------------------------------------------------------
    // STAGE 3 (A3-D3, 2026-06-12): the DoMotion lattice.
    // ------------------------------------------------------------------

    /// Style errors fire ONLY when `current_style != NonCombat`
    /// (acclient.c:344639-344649): Crouch→63, Sitting→64, Sleeping→65,
    /// ChatEmote mask→66; in NonCombat the same motions pass into the
    /// queue.
    #[test]
    fn do_motion_style_gate_fires_only_in_combat() {
        let chat_emote = 0x1300_0079_u32; // ShakeFist (0x02000000 mask set)
        let params = MovementParameters::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();

        let mut combat = MotionInterp::default();
        combat.interpreted_state.current_style = 0x8000_003E; // SwordCombat
        assert_eq!(
            combat.do_motion(0x4100_0012, &params, true, None, &mut mtm, &mut effects),
            Err(63)
        );
        assert_eq!(
            combat.do_motion(0x4100_0013, &params, true, None, &mut mtm, &mut effects),
            Err(64)
        );
        assert_eq!(
            combat.do_motion(0x4100_0014, &params, true, None, &mut mtm, &mut effects),
            Err(65)
        );
        assert_eq!(
            combat.do_motion(chat_emote, &params, true, None, &mut mtm, &mut effects),
            Err(66)
        );
        assert!(!combat.motions_pending(), "rejections must not enqueue");

        let mut noncombat = MotionInterp::default();
        assert_eq!(noncombat.inq_style(), 0x8000_003D);
        assert_eq!(
            noncombat.do_motion(0x4100_0012, &params, true, None, &mut mtm, &mut effects),
            Ok(())
        );
        assert_eq!(
            noncombat.do_motion(chat_emote, &params, true, None, &mut mtm, &mut effects),
            Ok(())
        );
        assert_eq!(noncombat.pending_motions.len(), 2, "NonCombat passes the gate");
    }

    /// The 6-action FIFO cap → 69 (acclient.c:344651-344653): the cap
    /// counts only `0x10000000`-class actions; a 7th refuses BEFORE any
    /// dispatch.
    #[test]
    fn do_motion_action_cap_refuses_seventh_with_69() {
        let params = MovementParameters::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();
        let mut interp = MotionInterp::default();
        for i in 0..6 {
            interp.interpreted_state.apply_action(0x1000_0060 + i, 1.0);
        }
        let queued_before = interp.pending_motions.len();
        assert_eq!(
            interp.do_motion(0x1000_0066, &params, true, None, &mut mtm, &mut effects),
            Err(69)
        );
        assert_eq!(interp.pending_motions.len(), queued_before, "69 enqueues nothing");
        // A non-action motion is NOT capped.
        assert_eq!(
            interp.do_motion(MOTION_READY, &params, true, None, &mut mtm, &mut effects),
            Ok(())
        );
    }

    /// Bit semantics (acclient.c:344633-344662): CancelMoveTo(bit15) →
    /// effect; ModifyRawState(bit13) applies the raw state ONLY on
    /// success; ModifyInterpretedState(bit14) applies/removes the
    /// interpreted state; SetHoldKey(bit11) routes the Run→None
    /// downgrade through the re-derive.
    #[test]
    fn do_motion_bit_semantics() {
        let params = MovementParameters::default();
        let mut mtm = MotionTableManager::new();

        // Success: cancel effect set, raw + interp applied.
        let mut interp = MotionInterp::default();
        let mut effects = MotionSideEffects::default();
        assert_eq!(
            interp.do_motion(MOTION_WALK_FORWARD, &params, true, None, &mut mtm, &mut effects),
            Ok(())
        );
        assert!(effects.cancel_moveto, "default params carry CancelMoveTo");
        assert_eq!(
            interp.raw_state.forward_command,
            Some(RawForwardCommand::WalkForward),
            "ModifyRawState applied on success"
        );
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward),
            "ModifyInterpretedState applied"
        );

        // Failure (contact-fail + action): raw NOT applied.
        let mut interp = MotionInterp::default();
        let mut effects = MotionSideEffects::default();
        assert_eq!(
            interp.do_motion(0x1000_0062, &params, false, None, &mut mtm, &mut effects),
            Err(36)
        );
        assert!(interp.raw_state.actions.is_empty(), "no raw apply on failure");
        assert_eq!(interp.interpreted_state.num_actions(), 0);

        // No-modify bits: nothing written even on success.
        let bare = MovementParameters {
            bitfield: 0,
            ..MovementParameters::default()
        };
        let mut interp = MotionInterp::default();
        let mut effects = MotionSideEffects::default();
        assert_eq!(
            interp.do_motion(MOTION_WALK_FORWARD, &bare, true, None, &mut mtm, &mut effects),
            Ok(())
        );
        assert!(!effects.cancel_moveto);
        assert_eq!(interp.raw_state.forward_command, None);
        assert_eq!(interp.interpreted_state.forward_command, None);
        assert_eq!(interp.pending_motions.len(), 1, "the queue node still lands");

        // SetHoldKey Run→None downgrade re-derives the held forward.
        let mut interp = MotionInterp::default();
        interp.raw_state.current_holdkey = HoldKey::Run;
        interp.raw_state.apply_forward(RawForwardCommand::WalkForward, 1.0, HoldKey::Invalid);
        interp.apply_raw_movement(Some(2.0));
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        let downgrade = MovementParameters {
            hold_key_to_apply: 1, // HoldKey::None
            ..MovementParameters::default()
        };
        let mut effects = MotionSideEffects::default();
        assert_eq!(
            interp.do_motion(
                MOTION_TURN_RIGHT,
                &downgrade,
                true,
                Some(2.0),
                &mut mtm,
                &mut effects
            ),
            Ok(())
        );
        assert_eq!(interp.raw_state.current_holdkey, HoldKey::NoKey);
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward),
            "held forward re-derived at the downgraded key"
        );
        assert!((interp.interpreted_state.forward_speed - 1.0).abs() < 1e-6);
    }

    /// `do_interpreted_motion` matrix (acclient.c:343975-344031):
    /// jump_error 72 under DisableJumpDuringLink; an action carries its
    /// OWN `motion_allows_jump`; contact-fail + action → 36;
    /// contact-fail + non-action → interp-apply-only success;
    /// standing_longjump suppresses exactly the velocity trio.
    #[test]
    fn do_interpreted_motion_matrix() {
        let params = MovementParameters::default();

        // DisableJumpDuringLink → head jump error 72.
        let mut interp = MotionInterp::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();
        let charging = MovementParameters {
            bitfield: MovementParameters::default().bitfield | 0x2_0000,
            ..MovementParameters::default()
        };
        interp
            .do_interpreted_motion(MOTION_WALK_FORWARD, &charging, true, &mut mtm, &mut effects)
            .unwrap();
        assert_eq!(interp.pending_jump_error(), 72);
        interp.motion_done(true);

        // Action keeps its OWN motion_allows_jump (0x1000006F =
        // MagicPowerUp01 blocks); a permitted action stays 0 (no
        // forward-command fallback for actions).
        interp
            .do_interpreted_motion(0x1000_006F, &params, true, &mut mtm, &mut effects)
            .unwrap();
        assert_eq!(interp.pending_jump_error(), 72);
        interp.motion_done(true);
        interp
            .do_interpreted_motion(0x1000_0062, &params, true, &mut mtm, &mut effects)
            .unwrap();
        assert_eq!(interp.pending_jump_error(), 0);
        interp.motion_done(true);

        // Dead → RemoveLinkAnimations effect.
        let mut effects = MotionSideEffects::default();
        interp
            .do_interpreted_motion(MOTION_DEAD, &params, true, &mut mtm, &mut effects)
            .unwrap();
        assert!(effects.remove_link_animations);
        interp.motion_done(true);

        // Contact-fail + action → 36 and NOTHING enqueued anywhere.
        let mut interp = MotionInterp::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();
        assert_eq!(
            interp.do_interpreted_motion(0x1000_0062, &params, false, &mut mtm, &mut effects),
            Err(36)
        );
        assert!(!interp.motions_pending());
        mtm.animation_done(true);
        assert!(mtm.drain_events().is_empty(), "no MTM node was queued");

        // Contact-fail + non-action → interp-apply-only success.
        assert_eq!(
            interp.do_interpreted_motion(
                MOTION_WALK_FORWARD,
                &params,
                false,
                &mut mtm,
                &mut effects
            ),
            Ok(())
        );
        assert_eq!(
            interp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::WalkForward),
            "interp applied"
        );
        assert!(!interp.motions_pending(), "no completion node on the contact-fail arm");

        // Dead/Falling and the turn commands are contact-exempt.
        assert!(MotionInterp::contact_allows_move(MOTION_DEAD, false));
        assert!(MotionInterp::contact_allows_move(MOTION_FALLING, false));
        assert!(MotionInterp::contact_allows_move(MOTION_TURN_RIGHT, false));
        assert!(MotionInterp::contact_allows_move(MOTION_TURN_LEFT, false));
        assert!(!MotionInterp::contact_allows_move(MOTION_WALK_FORWARD, false));

        // standing_longjump suppresses EXACTLY the velocity trio.
        let mut interp = MotionInterp::default();
        let mut mtm = MotionTableManager::new();
        interp.standing_longjump = true;
        for motion in [MOTION_WALK_FORWARD, MOTION_RUN_FORWARD, MOTION_SIDESTEP_RIGHT] {
            let mut effects = MotionSideEffects::default();
            assert_eq!(
                interp.do_interpreted_motion(motion, &params, true, &mut mtm, &mut effects),
                Ok(())
            );
            assert!(!interp.motions_pending(), "suppressed motion {motion:#X} must not enqueue");
        }
        let mut effects = MotionSideEffects::default();
        interp
            .do_interpreted_motion(MOTION_TURN_RIGHT, &params, true, &mut mtm, &mut effects)
            .unwrap();
        assert!(interp.motions_pending(), "turning is NOT suppressed by the charge");
        // leave_ground clears the charge (acclient.c:344471-344476).
        interp.leave_ground();
        assert!(!interp.standing_longjump);
    }

    /// Stop arms: `stop_interpreted_motion` enqueues an observable Ready
    /// node + RemoveMotion under the bit; `stop_motion` adjusts then
    /// removes the ORIGINAL from the raw state
    /// (acclient.c:344034-344143).
    #[test]
    fn stop_arms_enqueue_ready_and_remove_motions() {
        let params = MovementParameters::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();

        let mut interp = MotionInterp::default();
        interp
            .do_motion(MOTION_WALK_FORWARD, &params, true, None, &mut mtm, &mut effects)
            .unwrap();
        assert_eq!(
            interp.raw_state.forward_command,
            Some(RawForwardCommand::WalkForward)
        );
        interp.motion_done(true);

        interp
            .stop_motion(MOTION_WALK_FORWARD, &params, true, None, &mut mtm, &mut effects)
            .unwrap();
        assert_eq!(
            interp.pending_motions.front(),
            Some(&PendingMotion {
                context_id: 0,
                motion: MOTION_READY,
                jump_error_code: 0
            })
        );
        assert_eq!(interp.raw_state.forward_command, None, "raw RemoveMotion ran");
        assert_eq!(
            interp.interpreted_state.forward_command, None,
            "interp RemoveMotion ran"
        );
    }

    /// `perform_movement` runs the A4-Q1 completion pump after EVERY
    /// arm (acclient.c:344684-344704): a pre-queued zero-anim node
    /// completes inside the same call, observable via the drained
    /// `MotionDone` event.
    #[test]
    fn perform_movement_pumps_completions_after_every_arm() {
        let mut interp = MotionInterp::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();

        // Zero-anim node = completes on the next pump.
        mtm.add_to_queue(MOTION_READY, 0);
        interp
            .perform_movement(
                &MotionMovementStruct::StopCompletely,
                true,
                None,
                &mut mtm,
                &mut effects,
            )
            .unwrap();
        let events = mtm.drain_events();
        assert!(
            events
                .iter()
                .any(|event| matches!(
                    event,
                    super::super::motion_table_manager::MotionTableEvent::MotionDone {
                        motion,
                        success: true
                    } if *motion == MOTION_READY
                )),
            "the pump must run inside the same perform_movement call: {events:?}"
        );

        // And a Do arm pumps too.
        mtm.add_to_queue(MOTION_READY, 0);
        interp
            .perform_movement(
                &MotionMovementStruct::InterpretedCommand {
                    motion: MOTION_WALK_FORWARD,
                    params: MovementParameters::default(),
                },
                true,
                None,
                &mut mtm,
                &mut effects,
            )
            .unwrap();
        assert!(!mtm.drain_events().is_empty());
    }

    /// `enter_default_state` (acclient.c:344560-344597): Ready seed +
    /// `initted` + the LeaveGround tail clears `standing_longjump`.
    #[test]
    fn enter_default_state_sets_initted_and_leaves_ground() {
        let mut interp = MotionInterp::default();
        interp.standing_longjump = true;
        assert!(!interp.initted);
        interp.enter_default_state();
        assert!(interp.initted);
        assert!(!interp.standing_longjump, "LeaveGround tail ran");
        assert_eq!(
            interp.pending_motions.back(),
            Some(&PendingMotion {
                context_id: 0,
                motion: MOTION_READY,
                jump_error_code: 0
            })
        );
    }

    /// u32 `adjust_motion` normal forms match the per-axis Stage-1 port
    /// (acclient.c:343746-343803 / :343439-343483).
    #[test]
    fn adjust_motion_command_u32_normal_forms() {
        let mut interp = MotionInterp::default();

        // WalkBackwards → WalkForward × -BackwardsFactor.
        let (mut motion, mut speed) = (MOTION_WALK_BACKWARDS, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 0, None);
        assert_eq!(motion, MOTION_WALK_FORWARD);
        assert!((speed - (-BACKWARDS_FACTOR)).abs() < 1e-6);

        // TurnLeft → TurnRight negated.
        let (mut motion, mut speed) = (MOTION_TURN_LEFT, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 0, None);
        assert_eq!(motion, MOTION_TURN_RIGHT);
        assert!((speed - (-1.0)).abs() < 1e-6);

        // SideStepLeft → SideStepRight negated × the sidestep adjust.
        let adjust = SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED);
        let (mut motion, mut speed) = (MOTION_SIDESTEP_LEFT, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 0, None);
        assert_eq!(motion, MOTION_SIDESTEP_RIGHT);
        assert!((speed - (-adjust)).abs() < 1e-6);

        // Run hold key: positive WalkForward promotes + run-scales;
        // sidestep clamps at ±3.0; turn × fixed 1.5.
        let (mut motion, mut speed) = (MOTION_WALK_FORWARD, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 2, Some(2.0));
        assert_eq!(motion, MOTION_RUN_FORWARD);
        assert!((speed - 2.0).abs() < 1e-6);

        let (mut motion, mut speed) = (MOTION_SIDESTEP_RIGHT, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 2, Some(4.5));
        assert!((speed - MAX_SIDESTEP_ANIM_RATE).abs() < 1e-6);

        let (mut motion, mut speed) = (MOTION_TURN_RIGHT, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 2, Some(4.5));
        assert!((speed - RUN_TURN_FACTOR).abs() < 1e-6);

        // RunForward passes through untouched.
        let (mut motion, mut speed) = (MOTION_RUN_FORWARD, 1.0_f32);
        interp.adjust_motion_command(&mut motion, &mut speed, 2, Some(2.0));
        assert_eq!(motion, MOTION_RUN_FORWARD);
        assert!((speed - 1.0).abs() < 1e-6);
    }

    /// A3-D3-5: the leave-ground launch form clamps the diagonal
    /// composition to `run_rate × 4.0` and falls back to the
    /// integrator's velocity when the closed form is ~zero
    /// (acclient.c:343806-343843).
    #[test]
    fn leave_ground_velocity_clamps_and_falls_back() {
        let capabilities = authored_capabilities(1.0);
        let fallback = Vector3::new(0.5, -0.25, 0.0);

        // Diagonal run+strafe: legacy composition exceeds 4.0; the
        // launch form clamps to run_rate × 4.0.
        let state = MotionState::builder().run().forward().strafe_right().build();
        let launch = leave_ground_velocity_for_state(0.7, state, &capabilities, fallback);
        assert!(
            (launch.length() - 4.0).abs() < 1e-4,
            "diagonal launch must clamp to run_rate×4.0, got {}",
            launch.length()
        );
        let legacy = interpreted_velocity_for_state(0.7, state, &capabilities);
        assert!(legacy.length() > launch.length(), "legacy freeze was unclamped");

        // No input → ~zero closed form → integrator fallback verbatim.
        let idle = MotionState::builder().build();
        let launch = leave_ground_velocity_for_state(0.7, idle, &capabilities, fallback);
        assert_eq!(launch, fallback);
    }

    /// Wire → runtime conversion (`interpreted_state_from_wire`):
    /// style prefix, forward/sidestep/turn normal forms, expanded +
    /// stamped action list (fail-soft on expansion misses).
    #[test]
    fn interpreted_state_from_wire_normalizes() {
        use holtburger_protocol::messages::movement::{
            InterpretedMotionState as WireState, MotionItem, MovementStateFlags,
        };
        let wire = WireState {
            flags: MovementStateFlags::CURRENT_STYLE
                | MovementStateFlags::FORWARD_COMMAND
                | MovementStateFlags::FORWARD_SPEED
                | MovementStateFlags::SIDE_STEP_COMMAND
                | MovementStateFlags::TURN_COMMAND,
            num_commands: 2,
            current_style: Some(0x3E),
            forward_command: Some(0x0007u16.into()),
            sidestep_command: Some(0x0010u16.into()),
            turn_command: Some(0x000Eu16.into()),
            forward_speed: Some(1.9166666),
            sidestep_speed: None,
            turn_speed: None,
            commands: vec![
                MotionItem::new(0x005Bu16, 7, true, 1.25), // SlashHigh → 0x1000005B
                MotionItem::new(0x0FFFu16, 8, false, 1.0), // expansion miss → skipped
            ],
        };
        let (state, actions) = interpreted_state_from_wire(&wire);
        assert_eq!(state.current_style, 0x8000_003E);
        assert_eq!(
            state.forward_command,
            Some(InterpretedForwardCommand::RunForward)
        );
        assert!((state.forward_speed - 1.9166666).abs() < 1e-6);
        assert!(state.sidestep && state.sidestep_speed < 0.0, "SideStepLeft folds to negative");
        assert!(state.turn && state.turn_speed < 0.0, "TurnLeft folds to negative");
        assert_eq!(actions.len(), 1, "the unexpandable command is skipped fail-soft");
        assert_eq!(
            actions[0],
            RawAction {
                action: 0x1000_005B,
                speed: 1.25,
                stamp: 7,
                autonomous: true
            }
        );
    }

    /// A4/SA4F (2026-06-12) — [`renderer_num_anims`] classification at
    /// the two lattice enqueue sites: action-class motions enqueue
    /// `{motion, 1}` (await the per-entity renderer `AnimationDone`
    /// feed, acclient.c:340764-340773 — only non-loop link/one-shot
    /// anims fire AnimDone in retail); locomotion/turn enqueue
    /// `{motion, 0}` and Ready stop nodes `{Ready, 0}` (loop-realized,
    /// completed by the per-frame zero-anim poll,
    /// acclient.c:329960-330020).
    #[test]
    fn renderer_num_anims_classifies_enqueue_sites() {
        use crate::client::movement::motion_table_manager::MotionTableEvent;
        const ACTION_X: u32 = 0x1000_0062;

        assert_eq!(renderer_num_anims(ACTION_X), 1, "action class");
        assert_eq!(renderer_num_anims(MOTION_WALK_FORWARD), 0);
        assert_eq!(renderer_num_anims(MOTION_RUN_FORWARD), 0);
        assert_eq!(renderer_num_anims(MOTION_TURN_RIGHT), 0);
        assert_eq!(renderer_num_anims(MOTION_TURN_LEFT), 0);
        assert_eq!(renderer_num_anims(MOTION_READY), 0);

        let params = MovementParameters::default();

        // Action → {ACTION_X, 1}: survives the zero-anim poll, pops
        // only on the renderer AnimationDone.
        let mut interp = MotionInterp::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();
        interp
            .do_interpreted_motion(ACTION_X, &params, true, &mut mtm, &mut effects)
            .unwrap();
        mtm.use_time();
        assert!(
            mtm.drain_events().is_empty(),
            "action node must await the renderer feed"
        );
        mtm.animation_done(true);
        assert_eq!(
            mtm.drain_events(),
            vec![MotionTableEvent::MotionDone { motion: ACTION_X, success: true }]
        );

        // Locomotion / turn → {motion, 0}: the same-frame poll
        // completes them (THE repeat-pursuit stall fix — every
        // driver-lattice node clears `motions_pending` next pump).
        for motion in [MOTION_WALK_FORWARD, MOTION_RUN_FORWARD, MOTION_TURN_RIGHT] {
            let mut interp = MotionInterp::default();
            let mut mtm = MotionTableManager::new();
            let mut effects = MotionSideEffects::default();
            interp
                .do_interpreted_motion(motion, &params, true, &mut mtm, &mut effects)
                .unwrap();
            mtm.use_time();
            assert_eq!(
                mtm.drain_events(),
                vec![MotionTableEvent::MotionDone { motion, success: true }],
                "{motion:#X} completes via the zero-anim poll"
            );
        }

        // Stop → {Ready, 0} (KIND_MOTION idle crossfade realization).
        let mut interp = MotionInterp::default();
        let mut mtm = MotionTableManager::new();
        let mut effects = MotionSideEffects::default();
        interp
            .stop_interpreted_motion(MOTION_WALK_FORWARD, &params, true, &mut mtm, &mut effects)
            .unwrap();
        mtm.use_time();
        assert_eq!(
            mtm.drain_events(),
            vec![MotionTableEvent::MotionDone { motion: MOTION_READY, success: true }]
        );
    }
}

#[cfg(test)]
mod adjusted_speed_tests {
    use super::*;

    /// FU2 (row 32) — retail `get_adjusted_max_speed`
    /// (acclient.c:343512-343535): the run-rate base passes through
    /// unless the INTERPRETED forward command is RunForward, in which
    /// case `forward_speed / current_speed_factor` × 4.0 replaces it.
    #[test]
    fn adjusted_max_speed_overrides_only_on_interpreted_run_forward() {
        let mut minterp = MotionInterp::default();
        let base = 18.0; // run_rate 4.5 × 4

        // Idle / gesture forward slot: passthrough.
        assert_eq!(minterp.adjusted_max_speed(base), base);
        minterp.interpreted_state.apply_motion(0x4000_0070, 1.0); // windup
        assert_eq!(minterp.adjusted_max_speed(base), base);

        // Interpreted WalkForward: passthrough.
        minterp.interpreted_state.apply_motion(0x4500_0005, 1.0);
        assert_eq!(minterp.adjusted_max_speed(base), base);

        // Interpreted RunForward speed 2.0, factor 1.0 → 8.0.
        minterp.interpreted_state.apply_motion(0x4400_0007, 2.0);
        assert_eq!(minterp.adjusted_max_speed(base), 8.0);

        // Speed factor divides (retail :343533).
        minterp.current_speed_factor = 0.5;
        assert_eq!(minterp.adjusted_max_speed(base), 16.0);
    }
}

#[cfg(test)]
mod forward_slot_tests {
    use super::*;

    /// FU6 (row 11) — retail stores the gesture ITSELF in the single
    /// forward slot (acclient.c:332759/:332890): the slot reports the
    /// REAL motion id to the jump gate (`:344003` — a windup lands in
    /// motion_allows_jump's blocked band), contributes zero locomotion,
    /// and Ready (0x41000003) canonicalizes back to the empty slot.
    #[test]
    fn forward_slot_stores_gesture_id_with_zero_velocity() {
        let mut minterp = MotionInterp::default();
        // MagicBlast — a cast gesture in motion_allows_jump's blocked
        // SUBSTATE band 0x4000001E..=0x40000039 (windups are
        // action-class 0x1000006F+ and ride the action queue, never
        // the forward slot).
        const CAST_GESTURE: u32 = 0x4000_002B;
        const READY: u32 = 0x4100_0003;

        minterp.interpreted_state.apply_motion(CAST_GESTURE, 1.0);
        assert_eq!(
            minterp.interpreted_state.forward_command,
            Some(InterpretedForwardCommand::Substate(CAST_GESTURE)),
            "the gesture occupies the slot"
        );
        assert_eq!(
            minterp.interpreted_forward_motion_id(),
            CAST_GESTURE,
            "the jump gate sees the real gesture id"
        );
        assert!(
            !motion_allows_jump_id(minterp.interpreted_forward_motion_id()),
            "cast-gesture-in-slot blocks jumping (retail blocked band)"
        );
        let v = minterp.ground_velocity(2.602, 4.0);
        assert_eq!(v.y, 0.0, "gesture carries no forward locomotion");

        // Ready resets the slot to the canonical empty form.
        minterp.interpreted_state.apply_motion(READY, 1.0);
        assert_eq!(minterp.interpreted_state.forward_command, None);
    }

    fn motion_allows_jump_id(id: u32) -> bool {
        holtburger_world::player::motion_allows_jump(id)
    }
}

#[cfg(test)]
mod p13_tail_tests {
    use super::*;

    fn ready_grounded() -> MotionInterp {
        // default(): forward_command None (Ready), no sidestep/turn,
        // my_run_rate 1.0.
        MotionInterp::default()
    }

    #[test]
    fn max_speed_uses_run_rate_times_four() {
        let mi = ready_grounded();
        // No weenie query → my_run_rate (1.0) × 4.
        assert!((mi.max_speed(None) - 4.0).abs() < 1e-6);
        // Weenie InqRunRate success → queried rate × 4.
        assert!((mi.max_speed(Some(1.5)) - 6.0).abs() < 1e-6);
    }

    #[test]
    fn jump_v_z_floor_clamp_and_weenie_seam() {
        // Below epsilon → 0.
        assert_eq!(jump_v_z(0.0, Some(|_e: f32| Some(9.0))), 0.0);
        // No weenie → 10.
        assert_eq!(jump_v_z::<fn(f32) -> Option<f32>>(0.5, None), 10.0);
        // Weenie success → returned vz.
        assert_eq!(jump_v_z(0.5, Some(|_e: f32| Some(7.5))), 7.5);
        // Weenie present but query fails → 0.
        assert_eq!(jump_v_z(0.5, Some(|_e: f32| None)), 0.0);
        // Extent clamped to 1.0 before the query.
        assert_eq!(jump_v_z(4.0, Some(|e: f32| Some(e))), 1.0);
    }

    #[test]
    fn is_standing_still_all_and_each_falsifier() {
        let mut mi = ready_grounded();
        assert!(mi.is_standing_still(true));
        assert!(!mi.is_standing_still(false)); // airborne
        mi.interpreted_state.forward_command = Some(InterpretedForwardCommand::RunForward);
        assert!(!mi.is_standing_still(true));
        let mut mi = ready_grounded();
        mi.interpreted_state.sidestep = true;
        assert!(!mi.is_standing_still(true));
        let mut mi = ready_grounded();
        mi.interpreted_state.turn = true;
        assert!(!mi.is_standing_still(true));
    }

    #[test]
    fn jump_charge_is_allowed_gates() {
        let mi = ready_grounded();
        assert_eq!(mi.jump_charge_is_allowed(false, 0x4100_0003), 73); // CanJump fail
        assert_eq!(mi.jump_charge_is_allowed(true, 0x4000_0008), 72); // Fallen
        assert_eq!(mi.jump_charge_is_allowed(true, 0x4100_0012), 72); // Crouch (lo)
        assert_eq!(mi.jump_charge_is_allowed(true, 0x4100_0014), 72); // Sleeping (hi)
        assert_eq!(mi.jump_charge_is_allowed(true, 0x4100_0011), 0); // just below range
        assert_eq!(mi.jump_charge_is_allowed(true, 0x4100_0003), 0); // Ready
    }

    fn allow_env() -> JumpAllowEnv {
        JumpAllowEnv {
            weenie_noncreature: false,
            has_gravity: true,
            on_walkable_contact: true, // grounded creature
            fully_constrained: false,
            forward_substate: 0x4100_0003, // Ready
            can_jump: true,
            has_weenie: true,
            jump_stamina_ok: true,
        }
    }

    #[test]
    fn jump_is_allowed_full_order() {
        let mi = ready_grounded();
        // Grounded creature, everything clear → allowed.
        assert_eq!(mi.jump_is_allowed(0.5, &allow_env()), 0);
        // Airborne creature with gravity → 36.
        let mut e = allow_env();
        e.on_walkable_contact = false;
        assert_eq!(mi.jump_is_allowed(0.5, &e), 36);
        // Non-creature bypasses the air gate.
        let mut e = allow_env();
        e.on_walkable_contact = false;
        e.weenie_noncreature = true;
        assert_eq!(mi.jump_is_allowed(0.5, &e), 0);
        // Fully constrained → 71 (before head/charge/posture).
        let mut e = allow_env();
        e.fully_constrained = true;
        assert_eq!(mi.jump_is_allowed(0.5, &e), 71);
        // Charge gate: loaded down → 73.
        let mut e = allow_env();
        e.can_jump = false;
        assert_eq!(mi.jump_is_allowed(0.5, &e), 73);
        // Posture gate: blocking substate → 72.
        let mut e = allow_env();
        e.forward_substate = 0x4000_0008; // Fallen
        assert_eq!(mi.jump_is_allowed(0.5, &e), 72);
        // Stamina unaffordable (weenie present) → 71.
        let mut e = allow_env();
        e.jump_stamina_ok = false;
        assert_eq!(mi.jump_is_allowed(0.5, &e), 71);
    }

    #[test]
    fn jump_is_allowed_queue_head_short_circuits() {
        let mut mi = ready_grounded();
        mi.add_to_queue(0, 0x4400_0007, 71); // pending node carries an error
        // Head error wins over charge/posture (which would pass here).
        assert_eq!(mi.jump_is_allowed(0.5, &allow_env()), 71);
    }
}
