//! P15 — RETAIL-BEHAVIOR FIXTURES for the Wave-1 input layer (2026-07-03).
//!
//! Fixtures-as-tests encoding the strafecast caster's key scripts (sequences
//! A-F′) and the mechanism pins from
//! `docs/strafecast-mechanism-analysis-2026-07-03.md` §2/§3 as executable
//! assertions, DUAL-RUN (the P15 design, integration §3.1 step 3) against:
//!
//! 1. [`RefInterp`] — the self-contained reference ORACLE, kept compiled
//!    permanently as the drift alarm. ADJ-3 PATCH APPLIED at integration:
//!    the packet's oracle ended `key()` with `handle_new_forward_movement`
//!    — the decomp terminal is `if (cmd != Jump) SendMovementEvent` (flat
//!    19, verified both dumps); HNFM fires only from AddCommand's arms
//!    (where this oracle already fires it). The oracle's terminal is now a
//!    send-sink no-op, matching retail for `auto_run=on` + turn/sidestep
//!    edges (a real turn press does NOT cancel autorun).
//!    Second documented approximation (SC-4): the oracle's `set_hold_run`
//!    re-applies via `apply_current_movement`; the real P06 path under
//!    autonomy is the minterp-level re-assert. Kept — the fixtures'
//!    alphabet cannot distinguish them.
//! 2. The REAL unified [`CommandInterpreter`] through the SC-20
//!    adapter/harness rows: `key` packs a CmdStruct; `server_stomp`
//!    synthesizes the SetObjectMovement lane (latch LOW + fwd-slot write +
//!    control engage); `set_server_control(false)` is the test-only bare
//!    release (not a retail operation); `latch`/`fwd_slot` live on the
//!    recording seam (the physics sink), applying the
//!    `InterpretedMotionState::ApplyMotion` axis-slot semantics
//!    (acclient.c:332759: forward-slot commands evict the owner — incl. a
//!    cast gesture; turn/sidestep never touch it; Ready and stops clear it).
//!
//! Every pin runs TWICE (`*_oracle` + `*_real`); a divergence between the
//! two is the wave-1 drift alarm firing.
#![cfg(test)]

use super::command_interpreter::{CommandInterpreter, InterpreterSeams, MovementError};
use super::command_interpreter::{CmdStruct, FrameView, PlaneView, PositionView};
use super::params::MovementParameters;

// ---------------------------------------------------------------------------
// Command alphabet (the caster's keys → retail motion ids, analysis §1).
// ---------------------------------------------------------------------------
pub const TURN_RIGHT: u32 = 0x6500_000D; // 1694498829 → TurnList
pub const TURN_LEFT: u32 = 0x6500_000E; // 1694498830 → TurnList
pub const SIDESTEP_RIGHT: u32 = 0x6500_000F; // 1694498831 → SidestepList
pub const SIDESTEP_LEFT: u32 = 0x6500_0010; // 1694498832 → SidestepList
pub const WALK_FORWARD: u32 = 0x4500_0005; // 1157627909 → SubstateList
pub const WALK_BACKWARDS: u32 = 0x4500_0006; // 1157627910 → SubstateList
pub const RUN_FORWARD: u32 = 0x4400_0007; // 1140850695 → SubstateList
pub const READY: u32 = 0x4100_0003; // substate, 0x04000000 CLEAR
pub const JUMP: u32 = 0x2500_003B; // the skip-terminal-send cmd
/// A representative non-list substate that WEDGES the forward axis (bit
/// 0x40000000 set, 0x04000000 clear, != Ready — the AddCommand else-arm,
/// :717446-717452). Concrete retail id not needed to pin the branch (P15 Q6).
pub const WEDGE_SUBSTATE: u32 = 0x4100_0008;
/// Server-sent windup/cast gesture landing in the forward slot at a stomp
/// (analysis §2.4). Synthetic id (P15 Q5 — a live capture refines it).
pub const CAST_GESTURE: u32 = 0x1300_0001;

const MASK_SUBSTATE_HI: u32 = 0x4000_0000;
const MASK_SUBSTATE_LO: u32 = 0x0400_0000;

/// The three retail per-axis lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Substate,
    Turn,
    Sidestep,
}

/// `WhichList` (:717402) — the oracle's copy (the real port's lives in
/// `list_engine::which_list`; both are pinned by `t_whichlist_routes_*`).
pub fn which_list(cmd: u32) -> Option<Axis> {
    match cmd {
        TURN_RIGHT | TURN_LEFT => Some(Axis::Turn),
        SIDESTEP_RIGHT | SIDESTEP_LEFT => Some(Axis::Sidestep),
        _ if cmd & MASK_SUBSTATE_HI != 0 && cmd & MASK_SUBSTATE_LO != 0 => Some(Axis::Substate),
        _ => None,
    }
}

/// One recorded `MovePlayer` outcome — the interpreter's outward edge into
/// `CPhysicsObj::DoMotion`/`StopMotion` (:317315/:317354). `latch` =
/// `last_move_was_autonomous` as stamped by that call (:317325/:317364).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dispatch {
    pub cmd: u32,
    pub start: bool,
    pub speed: f32,
    pub latch: bool,
}

// ---------------------------------------------------------------------------
// THE SEAM the fixtures are written against (P15's CommandInterp).
// ---------------------------------------------------------------------------
pub trait CommandInterp {
    // --- input edges (HandleKeyboardCommand :717243) ---
    fn key(&mut self, cmd: u32, start: bool, speed: f32);

    // --- server/control machinery (harness-modeled, §2.9) ---
    /// `LoseControlToServer` (:716832) engage / TEST-ONLY bare release
    /// (SC-20: a release without the TakeControl tail is not a retail
    /// operation — the harness pokes the field).
    fn set_server_control(&mut self, on: bool);
    /// A gesture stomp (`CPhysics::SetObjectMovement` :311185 →
    /// `move_to_interpreted_state` :344372, analysis §2.4): latch LOW from
    /// the message flag, gesture into the forward slot, control engaged —
    /// and the interpreter LISTS untouched (why a reclaim can revive them).
    fn server_stomp(&mut self, gesture: u32);
    /// `SetAutonomyLevel` (:717569).
    fn set_autonomy_level(&mut self, level: u32);

    // --- modifiers (P06) ---
    fn set_hold_run(&mut self, on: bool);
    fn set_hold_sidestep(&mut self, on: bool);
    fn toggle_auto_run(&mut self);

    // --- observers ---
    fn controlled_by_server(&self) -> bool;
    fn transient_state(&self) -> bool;
    fn auto_run(&self) -> bool;
    fn autonomy_level(&self) -> u32;
    fn list_head(&self, axis: Axis) -> Option<u32>;
    /// `last_move_was_autonomous` (the autonomy latch, §2.2).
    fn latch(&self) -> bool;
    /// Current owner of the interpreted forward slot (:332759);
    /// `None` == Ready / no locomotion.
    fn fwd_slot(&self) -> Option<u32>;
    fn dispatches(&self) -> &[Dispatch];
    fn clear_dispatches(&mut self);

    // --- script sugar ---
    fn press(&mut self, cmd: u32) {
        self.key(cmd, true, 1.0);
    }
    fn release(&mut self, cmd: u32) {
        self.key(cmd, false, 1.0);
    }
    /// A "tap" = press + release edges (analysis §3 — the reclaim metronome).
    fn tap(&mut self, cmd: u32) {
        self.press(cmd);
        self.release(cmd);
    }
}

// ---------------------------------------------------------------------------
// Reference oracle (PERMANENT — the dual-run drift alarm).
// ---------------------------------------------------------------------------
#[derive(Clone)]
struct Entry {
    cmd: u32,
    speed: f32,
    #[allow(dead_code)]
    hold_run: bool,
    #[allow(dead_code)]
    mouse: bool,
}

/// A `CommandList` as a stack; head == newest == last pushed.
#[derive(Default, Clone)]
struct CmdList(Vec<Entry>);

impl CmdList {
    fn head(&self) -> Option<&Entry> {
        self.0.last()
    }
    fn push(&mut self, e: Entry) {
        self.0.push(e);
    }
    /// Match key is `cmd` only (P15 Q1 — the real list's keyboard path also
    /// matches command-only, skipping the mouse node; identical for this
    /// keyboard-only alphabet).
    fn remove(&mut self, cmd: u32) -> bool {
        if let Some(i) = self.0.iter().rposition(|e| e.cmd == cmd) {
            self.0.remove(i);
            true
        } else {
            false
        }
    }
    fn clear(&mut self) {
        self.0.clear();
    }
}

struct RefInterp {
    substate: CmdList,
    turn: CmdList,
    sidestep: CmdList,
    autonomy_level: u32,
    hold_run: bool,
    hold_sidestep: bool,
    transient_state: bool,
    auto_run: bool,
    autorun_speed: f32,
    controlled_by_server: bool,
    enabled: bool,
    player: bool,
    player_dead: bool,
    latch: bool,
    fwd_slot: Option<u32>,
    log: Vec<Dispatch>,
}

impl RefInterp {
    /// ctor (:717732): controlled_by_server=1, enabled=1, autonomy_level=2.
    fn new() -> Self {
        Self {
            substate: CmdList::default(),
            turn: CmdList::default(),
            sidestep: CmdList::default(),
            autonomy_level: 2,
            hold_run: false,
            hold_sidestep: false,
            transient_state: false,
            auto_run: false,
            autorun_speed: 1.0,
            controlled_by_server: true,
            enabled: true,
            player: false,
            player_dead: false,
            latch: false,
            fwd_slot: None,
            log: Vec::new(),
        }
    }
    fn in_world() -> Self {
        let mut s = Self::new();
        s.player = true;
        s
    }

    fn list(&self, axis: Axis) -> &CmdList {
        match axis {
            Axis::Substate => &self.substate,
            Axis::Turn => &self.turn,
            Axis::Sidestep => &self.sidestep,
        }
    }
    fn list_mut(&mut self, axis: Axis) -> &mut CmdList {
        match axis {
            Axis::Substate => &mut self.substate,
            Axis::Turn => &mut self.turn,
            Axis::Sidestep => &mut self.sidestep,
        }
    }

    /// `MovePlayer` (:717800) → DoMotion/StopMotion: latch HIGH, only this
    /// motion's axis slot applied (:332759).
    fn move_player(&mut self, cmd: u32, start: bool, speed: f32) {
        if self.player_dead {
            self.set_auto_run(0, false);
            return;
        }
        self.latch = true;
        match cmd {
            TURN_RIGHT | TURN_LEFT | SIDESTEP_RIGHT | SIDESTEP_LEFT => {}
            _ if cmd & MASK_SUBSTATE_HI != 0 => {
                self.fwd_slot = if !start || cmd == READY { None } else { Some(cmd) };
            }
            _ => {}
        }
        self.log.push(Dispatch {
            cmd,
            start,
            speed,
            latch: true,
        });
    }

    /// `ApplyHoldKeysToCommand` (:716962).
    fn apply_hold_keys(&self, cmd: u32) -> u32 {
        if self.hold_sidestep {
            match cmd {
                TURN_RIGHT => SIDESTEP_RIGHT,
                TURN_LEFT => SIDESTEP_LEFT,
                _ => cmd,
            }
        } else {
            cmd
        }
    }

    /// `AddCommand` (:717429).
    fn add_command(&mut self, cmd: u32, speed: f32) {
        let hold_run = self.hold_run;
        if let Some(axis) = which_list(cmd) {
            self.list_mut(axis).push(Entry {
                cmd,
                speed,
                hold_run,
                mouse: false,
            });
            if cmd & MASK_SUBSTATE_HI != 0 {
                if axis == Axis::Substate {
                    self.handle_new_forward_movement();
                }
                self.transient_state = false;
            }
        } else if cmd & MASK_SUBSTATE_HI != 0 && cmd & MASK_SUBSTATE_LO == 0 {
            self.handle_new_forward_movement();
            if cmd != READY {
                self.transient_state = true;
            }
        }
    }

    /// `NukeCommand` (:717458) as reached from Bookkeep on a release.
    fn nuke_dispatch(&mut self, cmd: u32, speed: f32) -> Option<(u32, bool, f32)> {
        let axis = which_list(cmd)?;
        let removed = self.list_mut(axis).remove(cmd);
        if !removed || self.transient_state || (self.auto_run && axis == Axis::Substate) {
            return None;
        }
        match self.list(axis).head() {
            Some(h) => Some((h.cmd, true, h.speed)),
            None => Some((cmd, false, speed)),
        }
    }

    /// The silent-control-release arm (:717284).
    fn nuke_silent(&mut self, cmd: u32) {
        if let Some(axis) = which_list(cmd) {
            self.list_mut(axis).remove(cmd);
        }
    }

    /// `HandleNewForwardMovement` (:717689) == `SetAutoRun(0, 1)` — fires
    /// ONLY from AddCommand's arms (ADJ-3/SC-4).
    fn handle_new_forward_movement(&mut self) {
        self.set_auto_run(0, true);
    }

    /// `SetAutoRun` (:718254): change-gated.
    fn set_auto_run(&mut self, val: u32, apply: bool) {
        let new_on = val != 0;
        if new_on == self.auto_run {
            return;
        }
        self.auto_run = new_on;
        self.transient_state = false;
        if apply {
            self.apply_current_movement();
        }
    }

    /// `ApplyCurrentMovement` (:717027) — the full-pattern revival tail.
    fn apply_current_movement(&mut self) {
        if !self.player {
            return;
        }
        if self.auto_run {
            self.move_player(WALK_FORWARD, true, self.autorun_speed);
        } else if self.substate.head().is_some() {
            self.apply_list_head(Axis::Substate);
        } else if !self.transient_state {
            // NOTE oracle approximation: retail presses Ready (start=1);
            // the oracle logs it start=false. Fixture-invisible (no pin
            // reads a READY dispatch) — kept from the packet as delivered.
            self.move_player(READY, false, 1.0);
        }
        if self.turn.head().is_some() {
            self.apply_list_head(Axis::Turn);
        } else {
            self.move_player(SIDESTEP_RIGHT, false, 1.0);
            self.move_player(TURN_RIGHT, false, 1.0);
        }
        if self.sidestep.head().is_some() {
            self.apply_list_head(Axis::Sidestep);
        } else {
            self.move_player(SIDESTEP_RIGHT, false, 1.0);
        }
    }

    /// `ApplyListHeadMovement` (:717102) — keyboard branch.
    fn apply_list_head(&mut self, axis: Axis) {
        if let Some(h) = self.list(axis).head() {
            let (cmd, speed) = (h.cmd, h.speed);
            let dispatched = self.apply_hold_keys(cmd);
            self.move_player(dispatched, true, speed);
        }
    }

    /// `TakeControlFromServer` (:716934) — THE ENGINE (FU-A).
    fn take_control_from_server(&mut self) {
        if self.controlled_by_server && self.autonomy_level != 0 && !self.player_dead {
            self.controlled_by_server = false;
            if self.player {
                self.latch = true;
                self.fwd_slot = None; // StopCompletely (:716947)
            }
            self.apply_current_movement();
        }
    }
}

impl CommandInterp for RefInterp {
    /// `HandleKeyboardCommand` (:717243), fixture alphabet only. ADJ-3
    /// PATCHED: the terminal is a send-sink no-op gated `cmd != JUMP`
    /// (retail SendMovementEvent, flat 19) — NOT HandleNewForwardMovement.
    fn key(&mut self, cmd: u32, start: bool, speed: f32) {
        if !self.enabled || !self.player {
            return; // IsActive (:717246)
        }
        if self.controlled_by_server && !start {
            self.nuke_silent(cmd); // silent release (§2.7)
            return;
        }
        self.take_control_from_server(); // reclaim on the edge (:717298)
        if start {
            self.add_command(cmd, speed);
            let dispatched = self.apply_hold_keys(cmd);
            self.move_player(dispatched, true, speed);
        } else {
            match self.nuke_dispatch(cmd, speed) {
                Some((ncmd, nstart, nspeed)) => {
                    let dispatched = self.apply_hold_keys(ncmd);
                    self.move_player(dispatched, nstart, nspeed);
                }
                None => { /* suppressed → no MovePlayer (:717322) */ }
            }
        }
        if cmd != JUMP {
            // ADJ-3: SendMovementEvent (flat 19) — a send-sink no-op in the
            // oracle's physics-free model. The packet's original
            // `handle_new_forward_movement()` here was the SC-4
            // mis-resolution (it made a turn press cancel autorun; real
            // retail does not).
        }
    }

    fn set_server_control(&mut self, on: bool) {
        if on {
            if self.autonomy_level != 0 {
                self.controlled_by_server = true;
            }
        } else {
            self.controlled_by_server = false;
        }
    }

    fn server_stomp(&mut self, gesture: u32) {
        self.latch = false;
        self.fwd_slot = Some(gesture);
        self.controlled_by_server = true;
        self.log.push(Dispatch {
            cmd: gesture,
            start: true,
            speed: 1.0,
            latch: false,
        });
    }

    fn set_autonomy_level(&mut self, level: u32) {
        if level <= 2 {
            self.autonomy_level = level;
        }
    }

    fn set_hold_run(&mut self, on: bool) {
        // SC-4 second note: approximation — re-applies via ACM (real P06:
        // minterp-level re-assert). Fixture-invisible.
        self.hold_run = on;
        if self.autonomy_level != 0 {
            self.apply_current_movement();
        }
    }

    fn set_hold_sidestep(&mut self, on: bool) {
        self.turn.clear();
        self.hold_sidestep = on;
        self.apply_current_movement();
    }

    fn toggle_auto_run(&mut self) {
        let v = if self.auto_run { 0 } else { 1 };
        self.set_auto_run(v, true);
    }

    fn controlled_by_server(&self) -> bool {
        self.controlled_by_server
    }
    fn transient_state(&self) -> bool {
        self.transient_state
    }
    fn auto_run(&self) -> bool {
        self.auto_run
    }
    fn autonomy_level(&self) -> u32 {
        self.autonomy_level
    }
    fn list_head(&self, axis: Axis) -> Option<u32> {
        self.list(axis).head().map(|e| e.cmd)
    }
    fn latch(&self) -> bool {
        self.latch
    }
    fn fwd_slot(&self) -> Option<u32> {
        self.fwd_slot
    }
    fn dispatches(&self) -> &[Dispatch] {
        &self.log
    }
    fn clear_dispatches(&mut self) {
        self.log.clear();
    }
}

// ---------------------------------------------------------------------------
// The REAL binding (SC-20): unified CommandInterpreter + a recording seam
// modeling the physics sink (latch / forward slot / dispatch log).
// ---------------------------------------------------------------------------

/// Physics-sink model: applies `InterpretedMotionState::ApplyMotion`'s
/// axis-slot semantics (:332759) at the seam edge and stamps the autonomy
/// latch exactly where retail does (:317325/:317364/:716946).
struct SinkSeams {
    latch: bool,
    fwd_slot: Option<u32>,
    log: Vec<Dispatch>,
    /// Every `CMotionInterp::set_hold_run` the interpreter pushed through
    /// the seam, as the EFFECTIVE gait (`hold_run XOR UITogglesRun`,
    /// :716991). F3 pins `Enable`'s re-assert on it.
    hold_run_asserts: Vec<bool>,
}

impl SinkSeams {
    fn new() -> Self {
        Self {
            latch: false,
            fwd_slot: None,
            log: Vec::new(),
            hold_run_asserts: Vec::new(),
        }
    }

    fn apply_axis_slot(&mut self, cmd: u32, start: bool) {
        match cmd {
            TURN_RIGHT | TURN_LEFT | SIDESTEP_RIGHT | SIDESTEP_LEFT => {}
            _ if cmd & MASK_SUBSTATE_HI != 0 => {
                self.fwd_slot = if !start || cmd == READY { None } else { Some(cmd) };
            }
            _ => {}
        }
    }
}

impl InterpreterSeams for SinkSeams {
    fn cur_time(&self) -> f64 {
        0.0
    }
    fn do_motion(&mut self, cmd: u32, params: &MovementParameters) -> u32 {
        self.latch = true; // :317325
        self.apply_axis_slot(cmd, true);
        self.log.push(Dispatch {
            cmd,
            start: true,
            speed: params.speed,
            latch: true,
        });
        0
    }
    fn stop_motion(&mut self, cmd: u32, params: &MovementParameters) {
        self.latch = true; // :317364
        self.apply_axis_slot(cmd, false);
        self.log.push(Dispatch {
            cmd,
            start: false,
            speed: params.speed,
            latch: true,
        });
    }
    fn phys_stop_completely(&mut self) {
        // StopCompletely clears the movement state (:716947 path) — the
        // forward slot empties; the reclaim's re-apply re-owns it.
        self.fwd_slot = None;
    }
    fn stop_interpolating(&mut self) {}
    fn set_latch(&mut self) {
        self.latch = true; // :716946
    }
    fn minterp_set_hold_run(&mut self, on: bool) {
        self.hold_run_asserts.push(on);
    }
    fn minterp_is_standing_still(&self) -> bool {
        false
    }
    fn player_forward_command(&self) -> Option<u32> {
        None // never dead in the fixture alphabet
    }
    fn player_has_interp_motion_state(&self) -> bool {
        true
    }
    fn player_has_raw_motion_state(&self) -> bool {
        true
    }
    fn player_motions_pending(&self) -> bool {
        false
    }
    fn player_is_moving_to(&self) -> bool {
        false
    }
    fn player_report_exhaustion(&mut self) {}
    fn player_turn_to_heading(&mut self, _params: &MovementParameters) {}
    fn player_position_event_ready(&self) -> bool {
        false
    }
    fn player_objcell_id(&self) -> u32 {
        0
    }
    fn player_frame_equals(&self, _last: &FrameView) -> bool {
        true
    }
    fn player_contact_plane_equals(&self, _last: &PlaneView) -> bool {
        true
    }
    fn player_position_view(&self) -> PositionView {
        PositionView::default()
    }
    fn player_contact_plane_view(&self) -> PlaneView {
        PlaneView::default()
    }
    fn ui_toggles_run(&self) -> bool {
        false // fixture alphabet: no ui-run inversion in play
    }
    fn use_mouse_turning(&self) -> bool {
        false
    }
    fn combat_abort_automatic_attack(&mut self) {}
    fn commence_jump(&mut self) {}
    fn do_jump(&mut self, _autonomous: bool) {}
    fn finish_jump(&mut self) {}
    fn send_move_to_state(&mut self) -> bool {
        true
    }
    fn send_autonomous_position(&mut self) -> bool {
        true
    }
    fn send_autonomy_level(&mut self, _level: u32) {}
    fn send_do_movement(&mut self, _cmd: u32, _speed: f32, _hold_key: u32) {}
    fn send_stop_movement(&mut self, _cmd: u32, _hold_key: u32) {}
    fn display_movement_error(&mut self, _err: MovementError) {}
    fn display_autorun_status(&mut self, _on: bool) {}
}

/// The real interpreter + sink, bound to the fixture seam per SC-20.
struct RealFixture {
    interp: CommandInterpreter,
    sink: SinkSeams,
}

impl RealFixture {
    fn in_world() -> Self {
        let mut interp = CommandInterpreter::new(0.0);
        interp.set_smartbox(true, true);
        Self {
            interp,
            sink: SinkSeams::new(),
        }
    }
}

impl CommandInterp for RealFixture {
    fn key(&mut self, cmd: u32, start: bool, speed: f32) {
        // SC-20 adapter: pack a CmdStruct (start dword + speed dword).
        let mut args = (start as i32).to_le_bytes().to_vec();
        args.extend_from_slice(&speed.to_le_bytes());
        let mut c = CmdStruct::new(cmd, args);
        self.interp.handle_keyboard_command(&mut self.sink, &mut c);
    }

    fn set_server_control(&mut self, on: bool) {
        if on {
            self.interp.lose_control_to_server(&mut self.sink);
        } else {
            // SC-20: test-only bare release (release-without-tail is not a
            // retail operation).
            self.interp.controlled_by_server = false;
        }
    }

    fn server_stomp(&mut self, gesture: u32) {
        // SC-20: synthesize the SetObjectMovement lane — latch LOW (wire
        // autonomous flag = 0, :311190), gesture into the forward slot
        // (`move_to_interpreted_state` copy), control engaged; the
        // interpreter lists untouched.
        self.sink.latch = false;
        self.sink.fwd_slot = Some(gesture);
        self.interp.controlled_by_server = true;
        self.sink.log.push(Dispatch {
            cmd: gesture,
            start: true,
            speed: 1.0,
            latch: false,
        });
    }

    fn set_autonomy_level(&mut self, level: u32) {
        let _ = self.interp.set_autonomy_level(&mut self.sink, level);
    }

    fn set_hold_run(&mut self, on: bool) {
        self.interp.set_hold_run(&mut self.sink, on as i32);
    }

    fn set_hold_sidestep(&mut self, on: bool) {
        self.interp.set_hold_sidestep(&mut self.sink, on as i32);
    }

    fn toggle_auto_run(&mut self) {
        self.interp.toggle_auto_run(&mut self.sink);
    }

    fn controlled_by_server(&self) -> bool {
        self.interp.controlled_by_server
    }
    fn transient_state(&self) -> bool {
        self.interp.transient_state
    }
    fn auto_run(&self) -> bool {
        self.interp.auto_run
    }
    fn autonomy_level(&self) -> u32 {
        self.interp.autonomy_level
    }
    fn list_head(&self, axis: Axis) -> Option<u32> {
        use super::list_engine::ListKind;
        let kind = match axis {
            Axis::Substate => ListKind::Substate,
            Axis::Turn => ListKind::Turn,
            Axis::Sidestep => ListKind::Sidestep,
        };
        let list = match kind {
            ListKind::Substate => &self.interp.substate_list,
            ListKind::Turn => &self.interp.turn_list,
            ListKind::Sidestep => &self.interp.sidestep_list,
        };
        list.get_head().map(|e| e.command)
    }
    fn latch(&self) -> bool {
        self.sink.latch
    }
    fn fwd_slot(&self) -> Option<u32> {
        self.sink.fwd_slot
    }
    fn dispatches(&self) -> &[Dispatch] {
        &self.sink.log
    }
    fn clear_dispatches(&mut self) {
        self.sink.log.clear();
    }
}

// ---------------------------------------------------------------------------
// The fixtures — each pin runs against BOTH implementations (dual-run).
// ---------------------------------------------------------------------------
mod fixtures {
    use super::*;

    fn n_press(d: &[Dispatch], cmd: u32) -> usize {
        d.iter().filter(|x| x.cmd == cmd && x.start).count()
    }
    fn has_press(d: &[Dispatch], cmd: u32) -> bool {
        n_press(d, cmd) > 0
    }

    /// Dual-run driver: the pin body runs on the oracle AND the real
    /// interpreter; a behavioral difference fails one arm — the drift alarm.
    macro_rules! dual {
        ($name:ident, $body:expr) => {
            paste_free_dual!($name, $body);
        };
    }
    macro_rules! paste_free_dual {
        ($name:ident, $body:expr) => {
            mod $name {
                use super::*;
                #[test]
                fn oracle() {
                    let mut c = RefInterp::in_world();
                    ($body)(&mut c as &mut dyn DynInterp);
                }
                #[test]
                fn real() {
                    let mut c = RealFixture::in_world();
                    ($body)(&mut c as &mut dyn DynInterp);
                }
            }
        };
    }

    /// Object-safe alias so one closure drives both impls.
    pub trait DynInterp: CommandInterp {}
    impl DynInterp for RefInterp {}
    impl DynInterp for RealFixture {}

    // --- WhichList routing (analysis §1 wire facts) -----------------------
    #[test]
    fn t_whichlist_routes_each_axis() {
        assert_eq!(which_list(TURN_RIGHT), Some(Axis::Turn));
        assert_eq!(which_list(TURN_LEFT), Some(Axis::Turn));
        assert_eq!(which_list(SIDESTEP_RIGHT), Some(Axis::Sidestep));
        assert_eq!(which_list(SIDESTEP_LEFT), Some(Axis::Sidestep));
        assert_eq!(which_list(WALK_FORWARD), Some(Axis::Substate));
        assert_eq!(which_list(WALK_BACKWARDS), Some(Axis::Substate));
        assert_eq!(which_list(RUN_FORWARD), Some(Axis::Substate));
        assert_eq!(which_list(READY), None);
        assert_eq!(which_list(WEDGE_SUBSTATE), None);
        // The REAL port's router agrees (same numeric lattice).
        use super::super::list_engine::{ListKind, which_list as real_which};
        assert_eq!(real_which(TURN_RIGHT), Some(ListKind::Turn));
        assert_eq!(real_which(SIDESTEP_LEFT), Some(ListKind::Sidestep));
        assert_eq!(real_which(RUN_FORWARD), Some(ListKind::Substate));
        assert_eq!(real_which(READY), None);
    }

    // --- PIN 6: per-axis single dispatch ----------------------------------
    dual!(t_per_axis_single_dispatch, |c: &mut dyn DynInterp| {
        c.press(SIDESTEP_LEFT); // reclaims control off the login state
        c.clear_dispatches();

        c.press(TURN_RIGHT);
        assert_eq!(n_press(c.dispatches(), TURN_RIGHT), 1);
        assert_eq!(
            c.fwd_slot(),
            None,
            "turn tap must not own the forward slot (§2.2/§3)"
        );
        assert!(
            c.dispatches().iter().all(|d| d.latch),
            "every DoMotion stamps latch HIGH"
        );

        c.clear_dispatches();
        c.press(RUN_FORWARD);
        assert_eq!(c.fwd_slot(), Some(RUN_FORWARD));
        assert_eq!(c.list_head(Axis::Substate), Some(RUN_FORWARD));
    });

    // --- PIN 1: head-wins pop-through (§2.1) ------------------------------
    dual!(t_head_wins_pop_through, |c: &mut dyn DynInterp| {
        c.press(WALK_BACKWARDS); // forward stack: [x]
        c.press(RUN_FORWARD); // forward stack: [x, ↑] (head = ↑)
        assert_eq!(c.list_head(Axis::Substate), Some(RUN_FORWARD));
        c.clear_dispatches();

        c.release(RUN_FORWARD); // pop ↑ → x re-dispatched as a FRESH PRESS
        let d = c.dispatches();
        assert_eq!(d.len(), 1, "one edge out of the pop-through");
        assert_eq!(
            d[0],
            Dispatch {
                cmd: WALK_BACKWARDS,
                start: true,
                speed: 1.0,
                latch: true
            }
        );
        assert_eq!(c.list_head(Axis::Substate), Some(WALK_BACKWARDS));
        assert_eq!(
            c.fwd_slot(),
            Some(WALK_BACKWARDS),
            "forward slot never empties mid-flap"
        );
    });

    dual!(t_pop_through_to_empty_is_a_stop, |c: &mut dyn DynInterp| {
        c.press(RUN_FORWARD);
        c.clear_dispatches();
        c.release(RUN_FORWARD);
        let d = c.dispatches();
        assert!(
            d.iter().any(|x| x.cmd == RUN_FORWARD && !x.start),
            "empty list → stop"
        );
        assert_eq!(c.fwd_slot(), None);
    });

    // --- PIN 2: silent releases under server control (§2.7 / FU-C) --------
    dual!(t_silent_release_under_server_control, |c: &mut dyn DynInterp| {
        c.press(SIDESTEP_RIGHT); // held; press reclaimed control
        c.set_server_control(true); // cast machinery grabs control
        let latch_before = c.latch();
        c.clear_dispatches();

        c.release(SIDESTEP_RIGHT); // release under control → SILENT
        assert!(
            c.dispatches().is_empty(),
            "no stop, no dispatch under server control"
        );
        assert_eq!(
            c.list_head(Axis::Sidestep),
            None,
            "yet the list is still bookkept (popped)"
        );
        assert!(c.controlled_by_server(), "a silent release does not reclaim");
        assert_eq!(c.latch(), latch_before, "no latch raise");
    });

    dual!(t_press_under_control_reclaims, |c: &mut dyn DynInterp| {
        c.set_server_control(true);
        c.clear_dispatches();
        c.press(TURN_RIGHT);
        assert!(!c.controlled_by_server(), "a press reclaims control (§2.7)");
        assert!(has_press(c.dispatches(), TURN_RIGHT));
    });

    // --- PIN 3: transient_state wedge (§2.8) ------------------------------
    dual!(t_transient_state_wedge, |c: &mut dyn DynInterp| {
        c.press(TURN_RIGHT);
        c.press(WEDGE_SUBSTATE); // non-list substate → wedges
        assert!(
            c.transient_state(),
            "non-list substate sets transient_state (:717452)"
        );
        c.clear_dispatches();

        c.release(TURN_RIGHT);
        assert!(c.dispatches().is_empty(), "release suppressed while wedged");

        c.press(WALK_FORWARD);
        assert!(!c.transient_state(), "forward press clears transient_state");

        c.clear_dispatches();
        c.release(WALK_FORWARD);
        assert!(
            !c.dispatches().is_empty(),
            "release dispatches once un-wedged"
        );
    });

    // --- PIN 4: TakeControlFromServer full-list re-apply (§2.6 / FU-A) ----
    dual!(t_take_control_full_list_reapply, |c: &mut dyn DynInterp| {
        c.press(SIDESTEP_RIGHT);
        c.press(TURN_RIGHT);
        c.press(WALK_BACKWARDS);
        c.press(RUN_FORWARD);
        c.set_server_control(true);
        c.clear_dispatches();

        c.press(TURN_RIGHT); // ONE tap under control
        let d = c.dispatches();
        assert!(has_press(d, RUN_FORWARD), "forward head revived");
        assert!(has_press(d, TURN_RIGHT), "turn head revived");
        assert!(has_press(d, SIDESTEP_RIGHT), "sidestep head revived");
        assert!(!c.controlled_by_server(), "control reclaimed");
        assert!(c.latch(), "latch stamped HIGH by the reclaim (:716946)");
    });

    // --- PIN 5: latch low at stomp, high at reclaim (§2.4 vs §2.6) --------
    dual!(t_latch_low_at_stomp_high_at_reclaim, |c: &mut dyn DynInterp| {
        c.press(RUN_FORWARD);
        assert!(c.latch());

        c.server_stomp(CAST_GESTURE);
        assert!(!c.latch(), "stomp stamps the latch LOW");
        assert_eq!(
            c.fwd_slot(),
            Some(CAST_GESTURE),
            "gesture owns the forward slot"
        );
        assert_eq!(
            c.list_head(Axis::Substate),
            Some(RUN_FORWARD),
            "interpreter list untouched by the stomp"
        );

        c.clear_dispatches();
        c.press(TURN_RIGHT); // reclaim tap
        assert!(c.latch(), "reclaim re-stamps the latch HIGH");
        assert!(
            has_press(c.dispatches(), RUN_FORWARD),
            "held forward revives out of the list"
        );
    });

    // --- Sequence A: starting slide right (hold c,→,x,↑ ; tap →) ----------
    dual!(t_sequence_a_starting_slide_right, |c: &mut dyn DynInterp| {
        for k in [SIDESTEP_RIGHT, TURN_RIGHT, WALK_BACKWARDS, RUN_FORWARD] {
            c.press(k); // the four holds, forward pressed LAST
        }
        c.server_stomp(CAST_GESTURE);
        c.clear_dispatches();

        c.tap(TURN_RIGHT); // "start tapping"
        let d = c.dispatches();
        assert!(
            has_press(d, RUN_FORWARD) && has_press(d, TURN_RIGHT) && has_press(d, SIDESTEP_RIGHT),
            "the whole pattern revives on the reclaim tap"
        );
        assert!(!c.controlled_by_server());
        assert_eq!(c.list_head(Axis::Turn), Some(TURN_RIGHT));
    });

    // --- Sequence B: return slide left (hold z,→,x,↑ ; tap ↑) -------------
    dual!(t_sequence_b_return_slide_forward_tap_evicts, |c: &mut dyn DynInterp| {
        for k in [SIDESTEP_LEFT, TURN_RIGHT, WALK_BACKWARDS, RUN_FORWARD] {
            c.press(k);
        }
        c.server_stomp(CAST_GESTURE);
        c.clear_dispatches();

        c.press(RUN_FORWARD); // return-slide taps FORWARD (aggressive half)
        assert!(!c.controlled_by_server());
        assert_eq!(
            c.fwd_slot(),
            Some(RUN_FORWARD),
            "player forward evicts the gesture (:332759)"
        );
        assert!(
            has_press(c.dispatches(), SIDESTEP_LEFT),
            "sidestep revived by the reclaim"
        );
        assert!(
            has_press(c.dispatches(), TURN_RIGHT),
            "turn revived by the reclaim"
        );
    });

    // --- Sequence F / F′: the invisible animation break (§3) --------------
    dual!(t_sequence_f_anim_break, |c: &mut dyn DynInterp| {
        // D setup: c, ←, x, ↑.
        for k in [SIDESTEP_RIGHT, TURN_LEFT, WALK_BACKWARDS, RUN_FORWARD] {
            c.press(k);
        }
        c.set_server_control(true); // inside the cast window

        // "release all but c" — SILENT under control.
        c.clear_dispatches();
        c.release(RUN_FORWARD);
        c.release(WALK_BACKWARDS);
        c.release(TURN_LEFT);
        assert!(
            c.dispatches().is_empty(),
            "the whole release cascade is silent"
        );
        assert_eq!(c.list_head(Axis::Substate), None);
        assert_eq!(c.list_head(Axis::Turn), None);
        assert_eq!(
            c.list_head(Axis::Sidestep),
            Some(SIDESTEP_RIGHT),
            "the slide survives"
        );

        // "then hold →, then x/↓ in that order".
        c.press(TURN_RIGHT); // reclaim
        assert!(!c.controlled_by_server());
        c.press(WALK_BACKWARDS); // back owns the forward slot
        assert_eq!(
            c.fwd_slot(),
            Some(WALK_BACKWARDS),
            "player-owned backward in the forward slot"
        );
        assert_eq!(c.list_head(Axis::Substate), Some(WALK_BACKWARDS));
    });

    // --- Modifier: hold_sidestep remap (:716962) --------------------------
    dual!(t_hold_sidestep_remaps_turn, |c: &mut dyn DynInterp| {
        c.set_hold_sidestep(true);
        c.clear_dispatches();
        c.press(TURN_RIGHT); // remapped to SideStepRight at dispatch time
        assert!(
            has_press(c.dispatches(), SIDESTEP_RIGHT),
            "turn key drives a sidestep motion"
        );
        assert!(!has_press(c.dispatches(), TURN_RIGHT));
    });

    // --- Control gate: no reclaim without autonomy (:716940) --------------
    dual!(t_no_reclaim_without_autonomy, |c: &mut dyn DynInterp| {
        c.set_autonomy_level(0);
        c.set_server_control(true); // already controlled from the ctor
        c.press(TURN_RIGHT); // autonomy 0 → TakeControlFromServer no-ops
        assert!(c.controlled_by_server(), "no reclaim while non-autonomous");
    });

    // --- Invariant §2.1: a held key never re-fires on its own -------------
    dual!(t_held_key_never_refires, |c: &mut dyn DynInterp| {
        c.press(RUN_FORWARD);
        c.clear_dispatches();
        // No edge injected → nothing re-dispatches (the controlled-case
        // UseTime re-drive is P08's cadence — ADJ-15 Q7).
        assert!(c.dispatches().is_empty());
    });

    // --- Lifecycle: Enable re-asserts hold_run (:716912) ------------------
    // REAL-only (the oracle has no enable/disable lifecycle — SC-20 models
    // the key alphabet, not the attach sequence). MOVE-F3-ENABLE's pin:
    // `v2 = this->hold_run; this->enabled = 1; vfptr[2].OnLoseFocus(v2)` —
    // the read is BEFORE the flip, and the value re-asserted is the CURRENT
    // latch, never a fresh 0.
    #[test]
    fn t_enable_reasserts_the_current_hold_run() {
        let mut f = RealFixture::in_world();

        // Shift down: hold_run = 1. The fixture seam's UITogglesRun is
        // false, so the effective gait is Run (:716991 XOR).
        f.set_hold_run(true);
        assert!(f.interp.hold_run);
        assert_eq!(f.sink.hold_run_asserts, vec![true]);

        f.sink.hold_run_asserts.clear();
        f.interp.disable(&mut f.sink); // :716893 — SetHoldRun(0) + enabled=0
        assert!(!f.interp.is_enabled());
        assert!(!f.interp.hold_run, "Disable drops the latch (:716902)");
        assert_eq!(f.sink.hold_run_asserts, vec![false]);

        // Re-arm the latch while disabled, then Enable: the re-assert must
        // carry THAT value through, and enabled must come back true.
        f.set_hold_run(true);
        f.sink.hold_run_asserts.clear();
        f.interp.enable(&mut f.sink); // :716912
        assert!(f.interp.is_enabled(), "Enable flipped enabled");
        assert!(f.interp.hold_run, "Enable does not clear the latch");
        assert_eq!(
            f.sink.hold_run_asserts,
            vec![true],
            "Enable pushed the CURRENT hold_run through SetHoldRun (flat 8)"
        );
    }
}
