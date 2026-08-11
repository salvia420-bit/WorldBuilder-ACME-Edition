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

// ---------------------------------------------------------------------------
// MOVE-RUNRATE-105 — the local player's run rate (2026-08-11).
//
// Defect card: `docs/reengineering/oracle/second-parity-report.md` —
// `run-hold-long / steady_speed` retail 7.885 vs holtburger 7.806 m/s
// (-1.0%). Ground speed is `4.0 x run_rate`, so that is a run-rate delta:
// ACE read Run skill 110 (rate 1.9758065), we read 105 (rate 1.9467213).
//
// These pins are NOT dual-run: the SC-20 oracle models the key alphabet, not
// the qualities layer. They pin the two independent fixes against the decomp
// and against the values measured on the live rig.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod runrate_105 {
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::{PropertyInt, WorldObjectPropertyAccessorsMut};
    use holtburger_common::{Guid, Quaternion, Vector3};
    use holtburger_world::context::{
        RunSkillSource, WorldContextExt, run_rate_from_skill_and_burden,
        run_skill_augmentation_bonus,
    };
    use holtburger_world::stats::{Attribute, AttributeType, Skill, SkillType, TrainingLevel};
    use holtburger_protocol::messages::movement::{
        InterpretedMotionCommand, MovementEventData, MovementInvalid, MovementType,
        MovementTypeData,
    };
    use holtburger_protocol::messages::GameMessage;
    use holtburger_world::WorldState;

    /// `MovementSystem::GetRunRate(load=1.0, runskill=110, 1.0)` — the value
    /// ACE published on the wire for both oracle characters, confirmed twice:
    /// as `interpreted.forward_speed` on every s2c self-motion RunForward
    /// echo, and as `4.0 x` the `Jump` GameAction's planar launch velocity
    /// (7.903226 m/s).
    const ACE_RUN_RATE_110: f32 = 1.975_806_5;
    /// The pre-fix value: the same formula at Run skill 105 — the wire
    /// `Current` WITHOUT the JackOfAllTrades augmentation.
    const BUGGY_RUN_RATE_105: f32 = 1.946_721_3;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    // --- Fix B: the augmentation terms of the composition -----------------

    /// Retail `CACQualities::InqRunRate` (acclient.c:443736-443758) folds
    /// three augmentation terms into `runskill` before calling
    /// `MovementSystem::GetRunRate`; ACE folds the same three into
    /// `CreatureSkill.Current` (`GetAugBonus_Base` +
    /// `GetAugBonus_Current`). The stage-1 spec's composition
    /// ("formula base + init + ranks") is short by all three.
    #[test]
    fn t_aug_bonus_mirrors_inqrunrate_terms() {
        // No augmentations: no bonus (the overwhelmingly common case, and
        // the reason this went unnoticed).
        assert_eq!(run_skill_augmentation_bonus(0, 0, 0, false), 0.0);
        // int 0x146 AugmentationJackOfAllTrades -> +5 (retail's flat `+= 5`
        // and ACE's `* 5` agree at the only legal value).
        assert_eq!(run_skill_augmentation_bonus(0, 1, 0, false), 5.0);
        // int 0x16D LumAugAllSkills -> straight add.
        assert_eq!(run_skill_augmentation_bonus(7, 0, 0, false), 7.0);
        // int 0x158 LumAugSkilledSpec -> 2x, SPECIALIZED only (retail
        // `_sac == 3`, :443750-443757).
        assert_eq!(run_skill_augmentation_bonus(0, 0, 4, false), 0.0);
        assert_eq!(run_skill_augmentation_bonus(0, 0, 4, true), 8.0);
        // Negative / absent property values are inert, never a debuff.
        assert_eq!(run_skill_augmentation_bonus(-3, -1, -9, true), 0.0);
        // All three at once.
        assert_eq!(run_skill_augmentation_bonus(7, 1, 4, true), 20.0);
    }

    /// The exact rig arithmetic, both endpoints. This is the defect card's
    /// number made executable.
    #[test]
    fn t_the_five_points_are_the_one_percent() {
        let with_aug = 105.0 + run_skill_augmentation_bonus(0, 1, 0, false);
        assert_eq!(with_aug, 110.0);
        assert!(close(
            run_rate_from_skill_and_burden(with_aug, 0.0),
            ACE_RUN_RATE_110
        ));
        assert!(close(
            run_rate_from_skill_and_burden(105.0, 0.0),
            BUGGY_RUN_RATE_105
        ));
        // Ground speed is `4.0 x run_rate` — the steady-speed rows of the
        // parity report, to the millimetre.
        let retail_speed = 4.0 * ACE_RUN_RATE_110;
        let buggy_speed = 4.0 * BUGGY_RUN_RATE_105;
        assert!(close(retail_speed, 7.903_226));
        assert!(close(buggy_speed, 7.786_885));
        // -1.47% of rate; the report measured -1.0% of realized speed
        // (position differentiation over ~10 s, so a little slower to
        // separate than the intent figure).
        let delta_pct = (buggy_speed - retail_speed) / retail_speed * 100.0;
        assert!((-1.48..-1.46).contains(&delta_pct), "{delta_pct}");
    }

    // --- Fix A: the server value wins -------------------------------------

    /// The oracle rig's character, as read out of `ace_shard` on
    /// 2026-08-11: Quickness 100, Run `level_From_P_P` 5 / `init_Level` 0
    /// (so the wire `Current` composes to 105), and
    /// `AugmentationJackOfAllTrades = 1`.
    fn rig_world() -> WorldState {
        let mut world = WorldState::synthetic();
        let guid = Guid(0x5000_017B);
        world.seed_local_player_entity(
            guid,
            "Probe 3650",
            WorldPosition {
                landblock_id: Guid(0x977B_0000),
                coords: Vector3::new(100.0, 100.0, 0.0),
                rotation: Quaternion::from_heading(0.0),
            },
        );
        // Strength 40 (the rig's) — `player_capacity` needs it, and without
        // it `player_burden` degrades to 3.0 -> load_mod 0 -> rate 1.0.
        world.player.attributes.insert(
            AttributeType::StrengthAttr,
            Attribute {
                attr_type: AttributeType::StrengthAttr,
                ranks: 0,
                start: 40,
                spent_xp: 0,
                next_rank_xp: None,
                base: 40,
                current: 40,
            },
        );
        world.player.skills.insert(
            SkillType::Run,
            Skill {
                skill_type: SkillType::Run,
                ranks: 5,
                init: 0,
                spent_xp: 526,
                next_rank_xp: None,
                base: 105,
                current: 105,
                training: TrainingLevel::Trained,
                trained_cost: 0,
                specialized_cost: 0,
            },
        );
        if let Some(entity) = world.entities.get_mut(guid) {
            entity
                .properties
                .set_int_prop(PropertyInt::AugmentationJackOfAllTrades, 1);
        }
        world
    }

    /// Fix B alone closes the gap: with no server rate seen yet, the
    /// composition now lands on ACE's value instead of 105's.
    #[test]
    fn t_composition_alone_now_matches_ace() {
        let world = rig_world();
        assert_eq!(world.player.server_run_rate, None);
        let rate = world.player_run_rate().expect("run skill is seeded");
        assert!(close(rate, ACE_RUN_RATE_110), "{rate}");

        let inputs = world.player_run_rate_inputs();
        assert_eq!(inputs.run_skill_source, RunSkillSource::WireRunSkill);
        assert_eq!(inputs.run_skill_wire, Some(105));
        assert_eq!(inputs.run_skill_used, Some(110.0));
        assert_eq!(inputs.run_skill_aug_bonus, 5.0);
        assert_eq!(inputs.server_run_rate, None);
    }

    /// Fix A: once the server has published a rate, it wins outright —
    /// the composition is not consulted at all. Owner directive 2026-08-11.
    #[test]
    fn t_server_run_rate_outranks_the_composition() {
        let mut world = rig_world();
        // Deliberately a value the composition CANNOT produce, so a pass
        // cannot be an accident of the two agreeing.
        world.player.server_run_rate = Some(2.5);
        assert!(close(world.player_run_rate().unwrap(), 2.5));

        let inputs = world.player_run_rate_inputs();
        assert_eq!(inputs.run_skill_source, RunSkillSource::ServerRunRate);
        assert_eq!(inputs.server_run_rate, Some(2.5));
        // The composition is still REPORTED beside it — that is how a
        // capture proves the two agree rather than assuming it.
        assert_eq!(inputs.run_skill_used, Some(110.0));
    }

    /// `?serverRunRate=off` restores the stage-1 order (composition only)
    /// without a rebuild — the A/B arm for the reversal.
    #[test]
    fn t_server_run_rate_off_restores_stage_one_order() {
        let mut world = rig_world();
        world.player.server_run_rate = Some(2.5);
        world.set_server_run_rate_enabled(false);
        assert!(close(world.player_run_rate().unwrap(), ACE_RUN_RATE_110));

        let inputs = world.player_run_rate_inputs();
        assert_eq!(inputs.run_skill_source, RunSkillSource::WireRunSkill);
        // Still probed, just not consumed — the flag is a consumption
        // switch, not an observation switch.
        assert_eq!(inputs.server_run_rate, None);
        assert_eq!(world.player.server_run_rate, Some(2.5));

        world.set_server_run_rate_enabled(true);
        assert!(close(world.player_run_rate().unwrap(), 2.5));
    }

    /// With NO run skill on the wire yet (the boot window), the server rate
    /// is the only answer there is — and it is a good one. Pre-fix this
    /// window resolved to `None` and the caller fell back to the flat
    /// `run_rate_scalar = 1.0` capability override (4.0 m/s, half speed).
    #[test]
    fn t_server_rate_covers_the_pre_stats_window() {
        let mut world = WorldState::synthetic();
        world.seed_local_player_entity(
            Guid(0x5000_017B),
            "Probe 3650",
            WorldPosition {
                landblock_id: Guid(0x977B_0000),
                coords: Vector3::new(0.0, 0.0, 0.0),
                rotation: Quaternion::from_heading(0.0),
            },
        );
        assert_eq!(world.player_run_rate(), None);
        world.player.server_run_rate = Some(ACE_RUN_RATE_110);
        assert!(close(world.player_run_rate().unwrap(), ACE_RUN_RATE_110));
        assert_eq!(
            world.player_run_rate_inputs().run_skill_source,
            RunSkillSource::ServerRunRate
        );
    }

    // --- Fix A: the wire latch --------------------------------------------

    /// One s2c self-motion frame, shaped like the ones ACE actually sends:
    /// `MovementType::Invalid` carrying an InterpretedMotionState.
    /// `forward_speed` on a RunForward is the RATE (retail
    /// `apply_interpreted_movement`, acclient.c:344161-344162), and walk
    /// envelopes carry none at all.
    fn self_motion(
        guid: Guid,
        seq: u16,
        autonomous: bool,
        forward_command: Option<InterpretedMotionCommand>,
        forward_speed: Option<f32>,
    ) -> GameMessage {
        let mut invalid = MovementInvalid::default();
        invalid.state.forward_command = forward_command;
        invalid.state.forward_speed = forward_speed;
        GameMessage::UpdateMotion(Box::new(MovementEventData {
            guid,
            object_instance_sequence: seq,
            movement_sequence: seq,
            server_control_sequence: seq,
            is_autonomous: autonomous,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: 0,
            data: MovementTypeData::Invalid(invalid),
        }))
    }

    /// The measured shape: ACE publishes the rate on the player's OWN
    /// autonomous echo (`forward_command 7 -> forward_speed 1.9758065` in
    /// all seven retail captures), and on nothing else. Walk frames carry
    /// `forward_speed: null` and must not disturb the latch.
    #[test]
    fn t_latch_takes_the_rate_off_a_runforward_self_echo() {
        let mut world = rig_world();
        let guid = world.player.guid;
        assert_eq!(world.player.server_run_rate, None);

        // The autonomous self echo — the frame retail's SetObjectMovement
        // gate drops and we deliberately keep.
        world.handle_message(&self_motion(
            guid,
            1,
            true,
            Some(InterpretedMotionCommand::RUN_FORWARD),
            Some(ACE_RUN_RATE_110),
        ));
        assert_eq!(world.player.server_run_rate, Some(ACE_RUN_RATE_110));
        assert!(close(world.player_run_rate().unwrap(), ACE_RUN_RATE_110));

        // A walk envelope carries no rate: the latch HOLDS its last good
        // value rather than clearing (retail's `my_run_rate` is a
        // last-known, not a per-frame field).
        world.handle_message(&self_motion(
            guid,
            2,
            true,
            Some(InterpretedMotionCommand::WALK_FORWARD),
            None,
        ));
        assert_eq!(world.player.server_run_rate, Some(ACE_RUN_RATE_110));

        // A stop (no forward command at all) likewise holds.
        world.handle_message(&self_motion(guid, 3, true, None, None));
        assert_eq!(world.player.server_run_rate, Some(ACE_RUN_RATE_110));
    }

    /// Garbage on the wire must never reach the `run_rate * 4.0` ground
    /// clamp: a NaN would poison every subsequent pose, a zero would pin
    /// the avatar.
    #[test]
    fn t_latch_refuses_a_nonsense_rate() {
        let mut world = rig_world();
        let guid = world.player.guid;
        for bad in [f32::NAN, f32::INFINITY, 0.0, -1.0] {
            world.handle_message(&self_motion(
                guid,
                1,
                true,
                Some(InterpretedMotionCommand::RUN_FORWARD),
                Some(bad),
            ));
            assert_eq!(world.player.server_run_rate, None, "accepted {bad}");
            world.player.movement_sequence = 0;
            world.player.server_control_sequence = 0;
        }
    }

    /// A frame dropped by the sequence gates never reaches the latch —
    /// the latch sits INSIDE `apply_self_update_motion`, after both gates
    /// (retail `SetObjectMovement` :311158-311176 drops stale frames at
    /// the message level, before any unpack).
    #[test]
    fn t_stale_frame_never_latches() {
        let mut world = rig_world();
        let guid = world.player.guid;
        world.handle_message(&self_motion(
            guid,
            9,
            true,
            Some(InterpretedMotionCommand::RUN_FORWARD),
            Some(ACE_RUN_RATE_110),
        ));
        assert_eq!(world.player.server_run_rate, Some(ACE_RUN_RATE_110));
        // seq 4 < 9 -> stale.
        world.handle_message(&self_motion(
            guid,
            4,
            true,
            Some(InterpretedMotionCommand::RUN_FORWARD),
            Some(3.0),
        ));
        assert_eq!(world.player.server_run_rate, Some(ACE_RUN_RATE_110));
    }

    // --- The retail gate this fix deliberately does not honour ------------

    /// `CPhysics::SetObjectMovement` (acclient.c:311186-311190) unpacks only
    /// when `autonomous == 0 || !player_controlled`. Encoded as a predicate
    /// so the DEVIATION is executable rather than prose: for the local
    /// player (player-controlled) retail drops exactly the autonomous
    /// echoes, which are the ONLY self-motion frames ACE puts the run rate
    /// on (measured: all seven retail captures, 2026-08-11). Honouring it
    /// here would make `latch_server_run_rate` dead code — which is why
    /// the latch runs before our own autonomous early-return.
    fn retail_unpacks(autonomous: bool, player_controlled: bool) -> bool {
        !autonomous || !player_controlled
    }

    #[test]
    fn t_retail_skips_the_autonomous_self_echo() {
        // Remote entities: ACE-authored, non-autonomous -> unpacked. This
        // is the lane holtburger already honoured, and where retail really
        // does consume `my_run_rate` off the wire.
        assert!(retail_unpacks(false, false));
        // The local player's own echo -> retail drops it.
        assert!(!retail_unpacks(true, true));
        // A server DIRECTIVE to the local player (MoveTo/TurnTo) is not
        // autonomous -> unpacked, by both retail and us.
        assert!(retail_unpacks(false, true));
    }
}
