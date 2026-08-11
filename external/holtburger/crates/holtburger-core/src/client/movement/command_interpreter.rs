//! The unified retail `CommandInterpreter` (movement-port WAVE 1, 2026-07-03)
//! — M2: the integration-pass composition of packets P03-P09 over P01's list
//! engine, per the QUALITY-integration.md rulings (SC-14 base struct, SC-15
//! one-seam shape, ADJ-1..16 fixes applied at fold time).
//!
//! ## Shape (SC-14 / SC-15)
//! ONE struct: P08's session state is the base (it owns the retail ctor,
//! acclient.c:717732), P02's three lists + `transient_state` folded in as
//! direct fields, P05's control + P06's modifier + P07's mouse fields
//! likewise. All intra-interpreter calls are DIRECT INHERENT METHODS — the
//! decomp's virtual self-dispatch collapses to direct calls because the
//! ACCmdInterp (P09) overrides are only the combat pre-hooks and the Send*
//! wall, both folded in here as seam calls (verified against P09's override
//! list + the flat-slot vtable table in QUALITY-fidelity.md). ONE outward
//! seam trait ([`InterpreterSeams`]) carries the true externals: the
//! physics-object edge (DoMotion/StopMotion/StopCompletely/StopInterpolating/
//! latch), the minterp hold-run edge, the A13 send emitters, the combat
//! pre-hooks/jump lanes, the UI sinks, and the P08 position-event reads.
//! Seams travel as a separate `&mut dyn` parameter, so the mutually recursive
//! call graph (HKC → TakeControl → ApplyCurrentMovement → MovePlayer →
//! do_motion) borrows cleanly (the SC-15 re-entrancy resolution).
//!
//! ## ADJ fixes baked in (must-fix list, verdict §must-fix)
//! - ADJ-1: direction names are the retail `command_strings` ones
//!   (0x0D=TurnRight, 0x0F=SideStepRight) via `motion_interp`'s `MOTION_*`.
//! - ADJ-2 (P07 ×3): `handle_select_left` / `handle_mouse_movement_command`
//!   END WITH `send_movement_event` (flat 19), NOT ApplyCurrentMovement; the
//!   mouse handler's pre-dispatch hook IS `take_control_from_server`
//!   (flat 26 — FU-A on the mouse path); `command_turn_to_heading` gates on
//!   `is_active` (enabled && player), not enabled alone.
//! - ADJ-3: `handle_keyboard_command`'s terminal is `SendMovementEvent`
//!   gated `cmd != Jump` (:717320) — HandleNewForwardMovement fires ONLY
//!   from AddCommand's two arms.
//! - ADJ-6: MoveToState-only send policy stands — the legacy
//!   DoMovement/StopMovement/TurnTo events are documented dead arms
//!   (autonomy is pinned at 2; level 0 is unreachable).
//! - ADJ-11: the SendPositionEvent guard shares the A13 LOCAL contact source
//!   with the payload (one `player_position_event_ready` seam read).
//! - SC-12: `set_auto_run(val, apply_movement)` returns nothing; the
//!   physics StopCompletely literal `1` is folded into the seam.
//!
//! ## Wave-1 wiring status
//! DARK until step 4: nothing constructs this except tests. The
//! `MovementSystem` seam impl + the wasm `on_action` entry + the
//! `?cmdInterp` gate land in the step-4 commit (see
//! docs/PLAN-cmdinterp-wave1-landing-2026-07-03.md ownership rows).
//!
//! Every method carries its retail cite. The flat-slot vtable table
//! (QUALITY-fidelity.md, independently re-derived) is the dispatch
//! authority; Hex-Rays `vfptr[N].<member>` artifacts are resolved
//! against it.
// Step 5 (2026-07-03) narrowed the step-4 module-level dead_code allow
// to per-item allows: the KeyEdge→on_action entry, use_time, the send
// ownership (row 9), the jump seams (row 8), and the effect stream
// (rows 12-13) are LIVE; the remaining `#[allow(dead_code)]` items are
// each tagged with what still needs wiring (lifecycle/logoff, the M4
// mouse handlers, M7 player options).

use super::list_engine::{CommandList, ListKind, apply_hold_keys_to_command, which_list};
use super::motion_interp::{
    MOTION_AUTORUN_TOGGLE, MOTION_HOLD_RUN, MOTION_HOLD_SIDESTEP, MOTION_JUMP, MOTION_READY,
    MOTION_SIDESTEP_LEFT, MOTION_SIDESTEP_RIGHT, MOTION_TURN_LEFT, MOTION_TURN_RIGHT,
    MOTION_WALK_FORWARD,
};
use super::params::MovementParameters;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// MotionCommand `Dead` (0x40000011). `PlayerIsDead` compares the interpreted
/// `forward_command` against this (acclient.c:717704).
pub(crate) const MOTION_COMMAND_DEAD: u32 = 0x4000_0011;

/// Full-autonomy level. The ctor seeds `autonomy_level = 2`
/// (acclient.c:717749, fidelity-verified — P05's "starts 1" doc was wrong,
/// SC-13); `ShouldSendPositionEvent` requires level 2 (:718117). Holtburger
/// runs pinned here (ADJ-13: nothing lowers it; level 0's legacy-event
/// sender is a dead path).
pub(crate) const AUTONOMY_LEVEL_FULL: u32 = 2;

/// `0x0C0000C1` — the mouse-turn command that triggers the sidestep remap in
/// `MovePlayer`'s mouse branch (acclient.c:717911, `201326785`).
pub(crate) const CMD_MOUSELOOK_TURN: u32 = 0x0C00_00C1;

/// Bit that suppresses a keyboard command from movement processing
/// (`command & 0x08000000` → early return; acclient.c:717271).
pub(crate) const CMD_SKIP_MOVEMENT_BIT: u32 = 0x0800_0000;
/// "Action / emote" command bit: `StopCompletely` before `DoMotion`, and
/// `action_stamp++` on success (acclient.c:717997,718002).
pub(crate) const CMD_ACTION_BIT: u32 = 0x1000_0000;

// `MovementParameters.bitfield` masks touched here (params.rs owns the
// named accessors). 0x800 = SetHoldKey (cleared for mouse commands),
// 0x1000 = Autonomous (set for autonomous presses).
const BIT_CLEAR_SETHOLDKEY: u32 = 0xFFFF_F7FF; // &= ~0x800
const BIT_AUTONOMOUS: u32 = 0x0000_1000; // |= 0x1000

// ---------------------------------------------------------------------------
// DoMotion refusal → UI error notice (acclient.c:717999-718033)
// ---------------------------------------------------------------------------

/// The movement-refusal reasons `MovePlayer` surfaces to the UI. Values are
/// the raw `DoMotion` return codes (P03, decomp-exact 62/63/64/65/66/68).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MovementError {
    /// 62 (`0x3E`) — `too_tired_1`.
    TooTired,
    /// 63 (`0x3F`) — `cant_crouch_combat_1`.
    CantCrouchCombat,
    /// 64 (`0x40`) — `cant_sit_combat_1`.
    CantSitCombat,
    /// 65 (`0x41`) — `cant_lie_down_combat_1`.
    CantLieDownCombat,
    /// 66 (`0x42`) — `cant_emote_combat_1`.
    CantEmoteCombat,
    /// 68 (`0x44`) — `cant_emote_position_1`.
    CantEmotePosition,
}

impl MovementError {
    /// Map a raw `DoMotion` result to a refusal reason (`None` == success or
    /// an unhandled code, both of which `MovePlayer` treats as no-op).
    pub(crate) fn from_domotion(code: u32) -> Option<Self> {
        match code {
            62 => Some(Self::TooTired),
            63 => Some(Self::CantCrouchCombat),
            64 => Some(Self::CantSitCombat),
            65 => Some(Self::CantLieDownCombat),
            66 => Some(Self::CantEmoteCombat),
            68 => Some(Self::CantEmotePosition),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// CmdStruct — the inbound command + packed argument buffer (SC-9: P03's
// OOB-safe shape + P07's mouse decode + P09's motion() ctor, unified).
// acclient.h:36324 : { char args[256]; u32 size; u32 curr; u32 command; }
// ---------------------------------------------------------------------------

/// Inbound command with its little-endian packed argument buffer and a read
/// cursor. Mirrors retail `CmdStruct` (`acclient.h:36324`). The decode
/// helpers advance `curr` exactly as the retail readers do; an out-of-range
/// read yields 0 rather than the retail OOB peek (P03 OQ-6).
#[derive(Debug, Clone)]
pub(crate) struct CmdStruct {
    args: Vec<u8>,
    size: u32,
    curr: u32,
    command: u32,
}

impl CmdStruct {
    /// `size` is the populated byte count; retail caps the buffer at 256 but
    /// never relies on the tail. `curr` starts at 0.
    pub(crate) fn new(command: u32, args: Vec<u8>) -> Self {
        let size = args.len() as u32;
        Self {
            args,
            size,
            curr: 0,
            command,
        }
    }

    /// Retail `ACCmdInterp::SetMotion` payload (acclient.c:435930-435935):
    /// a single u32 = `fOn` in the arg blob, `size = 4` (P09/M5).
    pub(crate) fn motion(command: u32, f_on: bool) -> Self {
        Self::new(command, (f_on as u32).to_le_bytes().to_vec())
    }

    /// `command` (offset +264).
    pub(crate) fn command(&self) -> u32 {
        self.command
    }

    fn read_i32(&mut self) -> i32 {
        let i = self.curr as usize;
        let v = self
            .args
            .get(i..i + 4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .unwrap_or(0);
        self.curr = self.curr.wrapping_add(4);
        v
    }

    fn read_f32(&mut self) -> f32 {
        let i = self.curr as usize;
        let v = self
            .args
            .get(i..i + 4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .unwrap_or(0.0);
        self.curr = self.curr.wrapping_add(4);
        v
    }

    /// Standard movement-command decode (acclient.c:717273-717283): read
    /// `start` (i32) unconditionally, then — only if a further 4 bytes
    /// remain — read `speed` (f32); otherwise keep `default_speed` (retail
    /// seeds it to 1.0).
    fn decode_move_args(&mut self, default_speed: f32) -> (i32, f32) {
        let start = self.read_i32();
        let mut speed = default_speed;
        if self.curr < self.size {
            speed = self.read_f32();
        }
        (start, speed)
    }

    /// Autorun-toggle decode (acclient.c:717253-717266): skip a leading i32
    /// (the toggle value, unused after decode), then read `autorun_speed`
    /// (f32) if room, else 1.0.
    fn decode_autorun_speed(&mut self) -> f32 {
        let _toggle = self.read_i32();
        if self.curr >= self.size {
            1.0
        } else {
            self.read_f32()
        }
    }

    /// Mouse-command decode (P07, acclient.c:717341): `start` (dword 0);
    /// `speed` (dword 1) ONLY when `start != 0` (a release carries no speed
    /// dword, so the next read lands one slot earlier); `new_hold_run`
    /// (next dword, unconditional).
    fn decode_mouse_args(&mut self) -> (i32, f32, i32) {
        let start = self.read_i32();
        let mut speed = 1.0;
        if start != 0 {
            speed = self.read_f32();
        }
        let new_hold_run = self.read_i32();
        (start, speed, new_hold_run)
    }
}

// ---------------------------------------------------------------------------
// P08 opaque view snapshots (compared / stamped via the seam)
// ---------------------------------------------------------------------------

/// Snapshot of a retail `Frame` held inside `last_sent_position`. Opaque:
/// equality is delegated to the seam (`Frame::is_equal`, acclient.c:718124).
/// The ctor writes an identity frame (:717764-771).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct FrameView(pub [f32; 7]);
impl FrameView {
    pub(crate) const IDENTITY: FrameView = FrameView([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
}

/// Snapshot of retail `Position` fields P08 stores in `last_sent_position`:
/// `objcell_id` + `frame` (acclient.c:717761-771 ctor, :718123-124 compare,
/// :718244 stamp).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PositionView {
    pub objcell_id: u32,
    pub frame: FrameView,
}

/// Snapshot of a retail `Plane` (N,d) held in `last_sent_contact_plane`.
/// Equality delegated to the seam (`Plane::operator==`, 0.0002 tol,
/// acclient.c:717723). The ctor zeroes it (:717772-776).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PlaneView {
    pub n: [f32; 3],
    pub d: f32,
}

// ---------------------------------------------------------------------------
// THE outward seam (SC-15) — the true externals only.
// ---------------------------------------------------------------------------

/// Every outward call the unified interpreter makes — the union of the
/// physics/send rows of the nine per-packet traits (SC-15's ~15-method
/// resolution, plus the P08 position-event reads). The step-4
/// `MovementSystem` impl binds these to `WorldState` + the A13 builders in
/// `movement/common.rs`; tests use a recording mock. Query methods are
/// `&self`; effectful seams `&mut self`.
pub(crate) trait InterpreterSeams {
    // --- timer ---
    /// `Timer::cur_time` in seconds (retail long double; f64 here — P08
    /// OQ2: fine for a 1.0 s window at second-scale stamps).
    fn cur_time(&self) -> f64;

    // --- physics object (this->player) ---
    /// `CPhysicsObj::DoMotion(player, cmd, params, 1)` — returns the raw
    /// result code (0 == ok; see [`MovementError::from_domotion`]). Stamps
    /// the autonomy latch (:317325) impl-side.
    fn do_motion(&mut self, cmd: u32, params: &MovementParameters) -> u32;
    /// `CPhysicsObj::StopMotion(player, cmd, params, 1)`. Stamps the latch
    /// (:317364) impl-side.
    fn stop_motion(&mut self, cmd: u32, params: &MovementParameters);
    /// `CPhysicsObj::StopCompletely(player, 1)` — the literal `1` is folded
    /// (P05 Q4 / SC-12: the 2013 "threads SetAutoRun's return" reading was a
    /// rendering artifact; the final client constant-folds 1).
    fn phys_stop_completely(&mut self);
    /// `CPhysicsObj::StopInterpolating(player)` — the leash drop (FU-A's
    /// observable rubberband half).
    fn stop_interpolating(&mut self);
    /// `player->last_move_was_autonomous = 1` (acclient.h:30717) — the
    /// autonomy-latch stamp at reclaim (:716946).
    fn set_latch(&mut self);
    /// `CMotionInterp::set_hold_run(get_minterp(player), effective, 1)`
    /// (acclient.c:716995-716996, 3-arg decomp-verified — ADJ-12: wire to
    /// the existing `motion_interp::set_hold_run`; the dropped
    /// `cancel_moveto` flag is documented low-risk).
    fn minterp_set_hold_run(&mut self, effective_run: bool);
    /// `CMotionInterp::is_standing_still(get_minterp(player))` — the PHYSICS
    /// minterp's test (P03 OQ-7: HoldRun/HoldSidestep gate on this, NOT the
    /// interpreter's own IsStandingStill).
    fn minterp_is_standing_still(&self) -> bool;
    /// `InqInterpretedMotionState(player) ? forward_command : None`
    /// (acclient.c:717703-704 — PlayerIsDead's read; `None` == no interp).
    fn player_forward_command(&self) -> Option<u32>;
    /// `CPhysicsObj::InqInterpretedMotionState(player) != 0` — MovePlayer
    /// guard (acclient.c:717826).
    fn player_has_interp_motion_state(&self) -> bool;
    /// `InqRawMotionState(player) != null` (acclient.c:718169).
    fn player_has_raw_motion_state(&self) -> bool;
    /// `CPhysicsObj::motions_pending(player)` (acclient.c:717607).
    fn player_motions_pending(&self) -> bool;
    /// `CPhysicsObj::IsMovingTo(player)` (acclient.c:717608).
    fn player_is_moving_to(&self) -> bool;
    /// WS04 (`?castHoldReclaim`) — true while a known LOCAL cast chain is in
    /// flight AND grounded AND the flag is on; the `use_time` FU-A reclaim
    /// then holds the FORWARD axis dead across the whole chain (strafe/turn
    /// still reclaim). NOT a retail seam — a holtburger extension over the
    /// JS-stamped cast window. Default impl is `false` (the const-default
    /// OFF and the non-system test seams); the system seam reads the cast
    /// window. Default OFF ⇒ byte-identical to today.
    fn local_cast_forward_lock_active(&self) -> bool {
        false
    }
    /// `CPhysicsObj::report_exhaustion(player)` (acclient.c:717623).
    fn player_report_exhaustion(&mut self);
    /// `CPhysicsObj::TurnToHeading(player, &params)` (P07, decl :6459 →
    /// :319851 → MoveToManager::TurnToHeading :345954).
    fn player_turn_to_heading(&mut self, params: &MovementParameters);

    // --- P08 position-event reads ---
    /// The SendPositionEvent readiness gate. ADJ-11: retail reads
    /// `player->transient_state & 0x3` + `Position::IsValid`; the A13 lane
    /// (common.rs F2-2, live-validated) replaced the transient source with
    /// the LOCAL airborne state — guard and payload must share that ONE
    /// source, so this seam read is `!is_airborne && walkable contact &&
    /// position valid` impl-side.
    fn player_position_event_ready(&self) -> bool;
    /// `player->m_position.objcell_id` (acclient.c:718123).
    fn player_objcell_id(&self) -> u32;
    /// `Frame::is_equal(last, player->m_position.frame)` (:718124).
    fn player_frame_equals(&self, last: &FrameView) -> bool;
    /// `Plane::operator==(last, player->contact_plane)` (:718131).
    fn player_contact_plane_equals(&self, last: &PlaneView) -> bool;
    /// Snapshot `player->m_position` for the `last_sent_position` stamp
    /// (:718244).
    fn player_position_view(&self) -> PositionView;
    /// Snapshot `player->contact_plane` for `last_sent_contact_plane`
    /// (:718245).
    fn player_contact_plane_view(&self) -> PlaneView;

    // --- config / player options ---
    /// `ACCmdInterp::UITogglesRun` (acclient.c:435818) = PlayerModule option
    /// bit 10. M7: holtburger is run-by-default with Shift=walk — exactly
    /// `true`; the step-4 impl wires it constant-true until a player-options
    /// store exists.
    fn ui_toggles_run(&self) -> bool;
    /// `ICIDM::s_cidm->m_UseMouseTurning` (acclient.h:49363). M4: no
    /// holtburger mouse-look consumer yet — the step-4 impl returns false
    /// (the whole MovePlayer remap block stays dark).
    fn use_mouse_turning(&self) -> bool;

    // --- combat pre-hooks + jump lanes (the P09 fold) ---
    /// `ClientCombatSystem::AbortAutomaticAttack` IF a combat system exists
    /// (acclient.c:435803/:435866 pre-hooks — the presence gate lives
    /// impl-side; no combat system == no-op).
    fn combat_abort_automatic_attack(&mut self);
    /// `ClientCombatSystem::CommenceJump` (acclient.c:435832). The retail
    /// tail's `RecvNotice_PrevSpellSelection` is a COMDAT-folded no-op
    /// (fidelity cross-packet note) — not modeled. Step-4 wires this onto
    /// the EXISTING `jump_charge_commence` lane (ownership row 8: the
    /// interpreter WRAPS the charge machinery, never re-implements it).
    fn commence_jump(&mut self);
    /// `ClientCombatSystem::DoJump(autonomous)` (acclient.c:435844) →
    /// existing `execute_jump_release` lane.
    fn do_jump(&mut self, autonomous: bool);
    /// `FinishJump` (flat 20; LoseControl/LoseKeyboardFocus call it). M6:
    /// maps to the existing charge-cancel (`jump_charge_abort`).
    fn finish_jump(&mut self);

    // --- outbound sends (P09's Send* wall → the A13 emitters) ---
    /// flat 60 `SendMoveToStateEvent` → `common::build_move_to_state` fed by
    /// the M1 converter + `Session::send_action`. Returns whether a pack was
    /// produced & sent (P08 OQ4: the stamp gates on this).
    fn send_move_to_state(&mut self) -> bool;
    /// flat 61 `SendAutonomousPositionEvent` →
    /// `common::build_autonomous_position` (None on guid/landblock NULL).
    fn send_autonomous_position(&mut self) -> bool;
    /// flat 57 `SendAutonomyLevelEvent(level)` → `AutonomyLevelActionData`
    /// (actions.rs:192, GameAction 0xF752).
    #[allow(dead_code)] // staged: SetAutonomyLevel unwired (autonomy pinned at 2, ADJ-6)
    fn send_autonomy_level(&mut self, level: u32);
    /// flat 58 `SendDoMovementEvent` — LEGACY DEAD ARM (ADJ-6: opcode 0xF61E
    /// disabled; reachable only at autonomy 0, which holtburger never
    /// enters). Impl: no-op with a debug log.
    fn send_do_movement(&mut self, cmd: u32, speed: f32, hold_key: u32);
    /// flat 59 `SendStopMovementEvent` — LEGACY DEAD ARM (0xF661 disabled).
    fn send_stop_movement(&mut self, cmd: u32, hold_key: u32);
    // NOTE deliberately ABSENT: `SendTurnToEvent` (flat 62, 0xF649) — the
    // standing S15 NO-GO (move_to.rs:15 RULINGS item 5, re-affirmed ADJ-6).

    // --- UI ---
    /// `ECM_UI::SendNotice_DisplayStringInfo(0x1A, ...)` refusal string.
    fn display_movement_error(&mut self, err: MovementError);
    /// The AutoRun ON/OFF toast (acclient.c:718276/718286).
    fn display_autorun_status(&mut self, on: bool);
}

// ---------------------------------------------------------------------------
// The unified struct (SC-14: P08 base + P02 lists + P05/P06/P07 fields)
// ---------------------------------------------------------------------------

/// Retail `CommandInterpreter` + the folded `ACCmdInterp` shim — field names
/// are retail-snake (acclient.h:35336, struct 3772). `smartbox`/`player`
/// pointers are presence bits (retail branches on null-ness only).
///
/// TYPE NOTES (SC-14): `hold_run` bool (retail normalizes 0/1 at SetHoldRun);
/// `hold_sidestep` stays i32 (stored RAW, decomp-verified);
/// `controlled_by_server`/`enabled`/`auto_run` bool-ized (branch-only);
/// `transient_state` is the INTERPRETER's wedge — distinct from the
/// `CPhysicsObj` bitfield of the same name (SC-21/P08 OQ7 warning: never
/// conflate; the physics one feeds the send guards through the seam).
#[derive(Debug)]
pub(crate) struct CommandInterpreter {
    /// retail `SmartBox *smartbox` — presence bit (acclient.h:35338).
    pub(crate) smartbox_present: bool,
    /// retail `CPhysicsObj *player` — presence bit (acclient.h:35339).
    pub(crate) player_present: bool,

    // the three lists (P01/P02; ctor zeroes them :717740-748)
    pub(crate) substate_list: CommandList,
    pub(crate) turn_list: CommandList,
    pub(crate) sidestep_list: CommandList,

    pub(crate) autonomy_level: u32,        // acclient.h:35343, ctor = 2
    pub(crate) controlled_by_server: bool, // acclient.h:35344, ctor = 1
    pub(crate) hold_run: bool,             // acclient.h:35345
    pub(crate) hold_sidestep: i32,         // acclient.h:35346 (RAW store)
    pub(crate) transient_state: bool,      // acclient.h:35347 (interp's)
    pub(crate) enabled: bool,              // acclient.h:35348, ctor = 1
    pub(crate) auto_run: bool,             // acclient.h:35349
    pub(crate) mouselook_active: i32,      // acclient.h:35350 (P07)
    pub(crate) mouseleft_down: i32,        // acclient.h:35351 (P07)
    pub(crate) autorun_speed: f32,         // acclient.h:35352, ctor = 1.0
    pub(crate) action_stamp: u32,          // acclient.h:35353, ctor = 1

    pub(crate) last_sent_position_time: f64, // acclient.h:35354
    pub(crate) last_sent_position: PositionView, // acclient.h:35355
    pub(crate) last_sent_contact_plane: PlaneView, // acclient.h:35356
    /// retail `const long double` — set once in ctor (acclient.h:35357).
    pub(crate) time_between_position_events: f64,

    // ── holtburger configs — NOT retail fields (verdict §3.3 flag
    // migration; QUALITY-integration §3.3 flag-gate map). Seeded from
    // the `?castMove`/`?slideCast` runtime carriers at construction
    // (`MovementSystem::ingest_key_edge`) — the URL flags are ALIASES
    // for these; the legacy carriers stay the `?cmdInterp=off`
    // predicates. ────────────────────────────────────────────────────
    /// `?castMove` alias: honor the server-control autonomy latch in
    /// dispatch. `true` (default) = retail — FU-C silent releases and
    /// the FU-A reclaim stomp apply while the server owns the player.
    /// `false` (`?castMove=off` escape) = pre-2026-07-02 behavior: the
    /// system-side mirror never raises [`Self::controlled_by_server`],
    /// so no dispatch is suppressed or stomped (raw input always
    /// drives; the leash still returns on any edge, system-side).
    pub(crate) honor_autonomy_latch: bool,
    /// `?slideCast` alias: the SetObjectMovement General stomp keeps
    /// the held sidestep/turn axes flowing (ADJ-8: deliberately
    /// smoother-than-retail). `false` = the authentic burst — all axes
    /// die with the stomp; revival is FU-A reclaim-driven. Consulted by
    /// the system's stomp arm when `?cmdInterp=on`; the legacy
    /// `USE_SLIDE_CAST` carrier stays the flag-off predicate. The
    /// eventual default is an ADJ-8 A/B decision — do not delete the
    /// modern arm pre-measurement.
    pub(crate) slidecast_persist: bool,
    /// Step-5 effect stream (PLAN rows 12-13) — holtburger extension,
    /// NOT retail state: the dispatch moments the renderer reacts to,
    /// recorded as they happen and drained by the system after every
    /// seam session. Behavior-neutral (nothing reads it back); the
    /// P15 dual-run pins are unaffected (they compare dispatch
    /// outcomes, not this ledger).
    pub(crate) effects: Vec<InterpEffect>,
    /// WS04 (`?castHoldReclaim`) — set true ONLY around the `use_time` FU-A
    /// reclaim while the cast forward lock is active; read by
    /// [`Self::apply_current_movement`]'s forward axis to hold Ready instead
    /// of replaying the held substate head. Never persists past the scoped
    /// reclaim (reset immediately after). Default false ⇒ off ⇒
    /// byte-identical to today.
    pub(crate) forward_reclaim_locked: bool,
}

/// Step-5 renderer/effect stream entries (PLAN rows 12-13).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InterpEffect {
    /// `HandleNewForwardMovement` fired — a fresh forward-intent edge
    /// took the forward slot (the retail cast-abort pre-hook moment,
    /// ACCmdInterp acclient.c:435866). JS consumer: the row-12
    /// anim-break cut.
    ForwardSlotEvicted,
    /// `TakeControlFromServer` actually flipped control back to the
    /// player (the FU-A stomp+revival block, :716942). JS consumer:
    /// ADJ-15 Q3 instrumentation (does a turn-tap visually evict the
    /// gesture? — the 1070 A/B reads these).
    ControlReclaimed {
        /// Post-flip diag: true when the reclaim came from the per-tick
        /// `use_time` pump (the post-anim auto-reclaim), false for the
        /// edge-driven HKC/mouse TakeControl paths.
        via_use_time: bool,
    },
}

/// Head-of-list projection the apply/stop tail consumes (P04's
/// `HeadCommand`): element `command`(+8)/`speed`(+12)/`hold_run`(+16) +
/// the `HeadIsMouse` verdict folded in.
#[derive(Clone, Copy, Debug, PartialEq)]
struct HeadCommand {
    command: u32,
    speed: f32,
    hold_run: i32,
    is_mouse: bool,
}

impl CommandInterpreter {
    /// `CommandInterpreter::CommandInterpreter` — acclient.c:717732. Ctor
    /// seeds fidelity-verified (:717749-751): `autonomy_level = 2`,
    /// `controlled_by_server = 1`, `enabled = 1`, `action_stamp = 1`,
    /// `autorun_speed = 1.0`, `time_between_position_events = 1.0`,
    /// `last_sent_position_time = Timer::cur_time`, identity frame + zero
    /// plane. Retail leaves `smartbox`/`player` UNINITIALIZED (set by
    /// SetSmartBox/NewPlayer); absent is strictly safer.
    pub(crate) fn new(cur_time: f64) -> Self {
        Self {
            smartbox_present: false,
            player_present: false,
            substate_list: CommandList::new(),
            turn_list: CommandList::new(),
            sidestep_list: CommandList::new(),
            autonomy_level: AUTONOMY_LEVEL_FULL,
            controlled_by_server: true,
            hold_run: false,
            hold_sidestep: 0,
            transient_state: false,
            enabled: true,
            auto_run: false,
            mouselook_active: 0,
            mouseleft_down: 0,
            autorun_speed: 1.0,
            action_stamp: 1,
            last_sent_position_time: cur_time,
            last_sent_position: PositionView {
                objcell_id: 0,
                frame: FrameView::IDENTITY,
            },
            last_sent_contact_plane: PlaneView::default(),
            time_between_position_events: 1.0,
            honor_autonomy_latch: true,
            slidecast_persist: true,
            effects: Vec::new(),
            forward_reclaim_locked: false,
        }
    }

    // -----------------------------------------------------------------------
    // List plumbing (P01/P02 fold)
    // -----------------------------------------------------------------------

    fn list(&self, kind: ListKind) -> &CommandList {
        match kind {
            ListKind::Substate => &self.substate_list,
            ListKind::Turn => &self.turn_list,
            ListKind::Sidestep => &self.sidestep_list,
        }
    }

    fn list_mut(&mut self, kind: ListKind) -> &mut CommandList {
        match kind {
            ListKind::Substate => &mut self.substate_list,
            ListKind::Turn => &mut self.turn_list,
            ListKind::Sidestep => &mut self.sidestep_list,
        }
    }

    fn list_head(&self, kind: ListKind) -> Option<HeadCommand> {
        let list = self.list(kind);
        list.get_head().map(|e| HeadCommand {
            command: e.command,
            speed: e.speed,
            hold_run: e.hold_run,
            is_mouse: e.is_mouse,
        })
    }

    /// `CommandInterpreter::AddCommand` (acclient.c:717429) — the P02 body
    /// as an inherent method (`HandleNewForwardMovement` is a direct self
    /// call; retail order preserved: HNFM fires BEFORE the wedge write).
    fn add_command(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        cmd: u32,
        speed: f32,
        mouse: bool,
        hold_run: i32,
    ) {
        match which_list(cmd) {
            Some(id) => {
                self.list_mut(id).add_command(cmd, speed, mouse, hold_run);
                if cmd & super::list_engine::MOVEMENT_FLAG != 0 {
                    if id == ListKind::Substate {
                        self.handle_new_forward_movement(seams);
                    }
                    self.transient_state = false;
                }
            }
            None => {
                if cmd & super::list_engine::MOVEMENT_FLAG != 0
                    && cmd & super::list_engine::SUBSTATE_FLAG == 0
                {
                    self.handle_new_forward_movement(seams);
                    if cmd != MOTION_READY {
                        self.transient_state = true;
                    }
                }
            }
        }
    }

    /// `CommandInterpreter::NukeCommand` (acclient.c:717458) — P02 body.
    /// Returns "the caller should keep going"; rewrites the out-params to
    /// the popped-through head (synthetic press) when one survives. ADJ-7:
    /// the element pops BEFORE the suppression test — wedged/silent releases
    /// still empty the lists.
    #[allow(clippy::too_many_arguments)]
    fn nuke_command(
        &mut self,
        cmd: &mut u32,
        start: &mut i32,
        speed: &mut f32,
        mouse: &mut i32,
        new_hold_run: &mut i32,
    ) -> bool {
        let Some(id) = which_list(*cmd) else {
            return false;
        };
        let was_head = self.list_mut(id).remove_command(*cmd, *speed, *mouse != 0);
        if !was_head || self.transient_state || (self.auto_run && id == ListKind::Substate) {
            return false;
        }
        if let Some(head) = self.list_head(id) {
            *cmd = head.command;
            *speed = head.speed;
            *new_hold_run = head.hold_run;
            *start = 1;
            *mouse = self.list(id).head_is_mouse() as i32;
        }
        true
    }

    /// `BookkeepCommandAndModifyIfNecessary` (acclient.c:717499) — P02 body.
    /// SC-6: 4th out-param = mouse, 5th = new_hold_run (Binja binding).
    #[allow(clippy::too_many_arguments)]
    fn bookkeep_command_and_modify_if_necessary(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        cmd: &mut u32,
        start: &mut i32,
        speed: &mut f32,
        mouse: &mut i32,
        new_hold_run: &mut i32,
    ) -> bool {
        if *cmd == MOTION_JUMP {
            true
        } else if *start != 0 {
            self.add_command(seams, *cmd, *speed, *mouse != 0, *new_hold_run);
            true
        } else {
            self.nuke_command(cmd, start, speed, mouse, new_hold_run)
        }
    }

    /// Interpreter-level `ClearAllCommands` (acclient.c:716848) — flushes
    /// the three lists; leaves `transient_state` (P02 OQ4: no reset exists).
    fn clear_all_commands(&mut self) {
        self.substate_list.clear_all_commands();
        self.turn_list.clear_all_commands();
        self.sidestep_list.clear_all_commands();
    }

    /// Interpreter-level `ClearKeyboardCommands` (acclient.c:716875-877) —
    /// keeps each list's single mouse node.
    fn clear_keyboard_commands(&mut self) {
        self.substate_list.clear_keyboard_commands();
        self.turn_list.clear_keyboard_commands();
        self.sidestep_list.clear_keyboard_commands();
    }

    // -----------------------------------------------------------------------
    // Trivial predicates + wiring (P08)
    // -----------------------------------------------------------------------

    /// `IsEnabled` — acclient.c:436205.
    #[allow(dead_code)] // staged: step-4 wasm surface
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// `IsActive` — acclient.c:717663 (`enabled && player`).
    pub(crate) fn is_active(&self) -> bool {
        self.enabled && self.player_present
    }

    /// `SetSmartBox(i_smartbox)` — acclient.c:716822: `player = i_smartbox ?
    /// i_smartbox->player : 0`.
    pub(crate) fn set_smartbox(&mut self, smartbox_present: bool, smartbox_player_present: bool) {
        self.smartbox_present = smartbox_present;
        self.player_present = smartbox_present && smartbox_player_present;
    }

    /// `NewPlayer(autonomous_movement)` — acclient.c:716859. Precondition:
    /// SetSmartBox with a non-null box ran first (retail derefs
    /// unconditionally — P08 OQ5).
    #[allow(dead_code)] // staged: login/enter-world lifecycle wiring (wire-side migration)
    pub(crate) fn new_player(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        autonomous_movement: bool,
        smartbox_player_present: bool,
    ) {
        debug_assert!(
            self.smartbox_present,
            "retail invariant: SetSmartBox precedes NewPlayer (P08 OQ5)"
        );
        self.player_present = smartbox_player_present;
        if autonomous_movement {
            self.apply_current_movement(seams);
        } else {
            self.lose_control_to_server(seams);
        }
    }

    /// `Enable` — acclient.c:716912. Reads hold_run BEFORE flipping enabled,
    /// then re-asserts it (flat 8): `v2 = this->hold_run; this->enabled = 1;
    /// vfptr[2].OnLoseFocus(v2)`.
    ///
    /// F3 (batch-D `MOVE-F3-ENABLE`) — WIRED at last: the system's
    /// world-entry attach (`system.rs`
    /// `attach_command_interpreter_at_world_entry`) is the caller. It had
    /// none before, so the lane never ran the re-assert.
    pub(crate) fn enable(&mut self, seams: &mut dyn InterpreterSeams) {
        let hr = self.hold_run;
        self.enabled = true;
        self.set_hold_run(seams, hr as i32);
    }

    /// `Disable` — acclient.c:716893. ClearAllCommands → SetHoldRun(0) →
    /// hold_sidestep=0 → if `autonomy!=0 && player && !controlled`
    /// { ApplyCurrentMovement; SendMovementEvent } → enabled=0.
    pub(crate) fn disable(&mut self, seams: &mut dyn InterpreterSeams) {
        self.clear_all_commands();
        self.set_hold_run(seams, 0);
        self.hold_sidestep = 0;
        if self.autonomy_level != 0 && self.player_present && !self.controlled_by_server {
            self.apply_current_movement(seams);
            self.send_movement_event(seams);
        }
        self.enabled = false;
    }

    /// `LoseKeyboardFocus` — acclient.c:716869. ClearKeyboardCommands →
    /// SetHoldRun(0) → hold_sidestep=0 → FinishJump → if `autonomy!=0 &&
    /// !controlled` { ApplyCurrentMovement; SendMovementEvent }. NOTE: no
    /// `player` guard here (unlike Disable) — decomp-exact.
    pub(crate) fn lose_keyboard_focus(&mut self, seams: &mut dyn InterpreterSeams) {
        self.clear_keyboard_commands();
        self.set_hold_run(seams, 0);
        self.hold_sidestep = 0;
        seams.finish_jump();
        if self.autonomy_level != 0 && !self.controlled_by_server {
            self.apply_current_movement(seams);
            self.send_movement_event(seams);
        }
    }

    /// `PlayerTeleported` — acclient.c:716924: SetAutoRun(0,1) then
    /// SendMovementEvent.
    #[allow(dead_code)] // staged: teleport wiring (PlayerTeleport → interp lane)
    pub(crate) fn player_teleported(&mut self, seams: &mut dyn InterpreterSeams) {
        self.set_auto_run(seams, 0, true);
        self.send_movement_event(seams);
    }

    /// `HandleLogOff` — acclient.c:716956: pure delegate to Disable
    /// (flat 33).
    #[allow(dead_code)] // staged: step-4 logoff wiring
    pub(crate) fn handle_log_off(&mut self, seams: &mut dyn InterpreterSeams) {
        self.disable(seams);
    }

    /// `HandleExhaustion` — acclient.c:717617: `if(player)
    /// report_exhaustion()`.
    #[allow(dead_code)] // staged: step-4 exhaustion wiring
    pub(crate) fn handle_exhaustion(&mut self, seams: &mut dyn InterpreterSeams) {
        if self.player_present {
            seams.player_report_exhaustion();
        }
    }

    /// `IsStandingStill` — acclient.c:717637: player ?
    /// minterp.is_standing_still : true.
    #[allow(dead_code)] // staged: step-4 wasm surface
    pub(crate) fn is_standing_still(&self, seams: &dyn InterpreterSeams) -> bool {
        if self.player_present {
            seams.minterp_is_standing_still()
        } else {
            true
        }
    }

    /// `PlayerIsDead` — acclient.c:717695: player && interp present &&
    /// forward_command == Dead.
    fn player_is_dead(&self, seams: &dyn InterpreterSeams) -> bool {
        self.player_present && seams.player_forward_command() == Some(MOTION_COMMAND_DEAD)
    }

    // -----------------------------------------------------------------------
    // Per-tick pump + send gate (P08)
    // -----------------------------------------------------------------------

    /// `UseTime` — acclient.c:717595. (1) position-event heartbeat; (2) the
    /// FU-A autonomy-latch trigger: queued input (or auto_run) while
    /// server-controlled and physics idle stomps control back to the client.
    /// ADJ-15 Q7 closed: the re-drive fires ONLY under server control — a
    /// held key never re-fires on its own outside it.
    pub(crate) fn use_time(&mut self, seams: &mut dyn InterpreterSeams) {
        if self.should_send_position_event(seams) {
            self.send_position_event(seams);
        }
        if self.player_present
            && self.enabled
            && self.controlled_by_server
            && !seams.player_motions_pending()
            && !seams.player_is_moving_to()
            && (self.substate_list.get_head().is_some()
                || self.turn_list.get_head().is_some()
                || self.sidestep_list.get_head().is_some()
                || self.auto_run)
        {
            // WS04 (?castHoldReclaim) — hold the FORWARD axis dead across the
            // whole cast chain; the reclaim still returns control + revives
            // turn/sidestep. Scoped to this single reclaim (reset right
            // after). Default OFF ⇒ seam returns false ⇒ no-op.
            self.forward_reclaim_locked = seams.local_cast_forward_lock_active();
            self.take_control_from_server(seams, true);
            self.forward_reclaim_locked = false;
        }
    }

    /// `ShouldSendPositionEvent` — acclient.c:718108. IsActive &&
    /// autonomy==2 && smartbox && player, then the windowed cell/frame vs
    /// cell/plane comparison against `last_sent_*`.
    fn should_send_position_event(&self, seams: &dyn InterpreterSeams) -> bool {
        if !(self.is_active()
            && self.autonomy_level == AUTONOMY_LEVEL_FULL
            && self.smartbox_present
            && self.player_present)
        {
            return false;
        }
        let out_of_window =
            self.time_between_position_events + self.last_sent_position_time < seams.cur_time();
        if out_of_window {
            self.last_sent_position.objcell_id != seams.player_objcell_id()
                || !seams.player_frame_equals(&self.last_sent_position.frame)
        } else if self.last_sent_position.objcell_id != seams.player_objcell_id() {
            true
        } else {
            !seams.player_contact_plane_equals(&self.last_sent_contact_plane)
        }
    }

    /// `SendMovementEvent` — acclient.c:718142 (flat 19). Guard: `player &&
    /// smartbox && InqRawMotionState && autonomy != 0`. Emits a MoveToState
    /// pack (flat 60 → A13 builder + M1 converter) and stamps
    /// `last_sent_position_time` ONLY. P08 OQ4: the stamp gates on the
    /// builder actually emitting (strictly safer than retail's
    /// unconditional stamp).
    pub(crate) fn send_movement_event(&mut self, seams: &mut dyn InterpreterSeams) {
        if self.player_present
            && self.smartbox_present
            && seams.player_has_raw_motion_state()
            && self.autonomy_level != 0
            && seams.send_move_to_state()
        {
            self.last_sent_position_time = seams.cur_time();
        }
    }

    /// `SendPositionEvent` — acclient.c:718202 (flat 22). Guard per ADJ-11
    /// (the ONE local contact source); stamps time + `last_sent_position` +
    /// `last_sent_contact_plane` on emit.
    fn send_position_event(&mut self, seams: &mut dyn InterpreterSeams) {
        if !(self.smartbox_present && self.player_present) {
            return;
        }
        if seams.player_position_event_ready() && seams.send_autonomous_position() {
            self.last_sent_position_time = seams.cur_time();
            self.last_sent_position = seams.player_position_view();
            self.last_sent_contact_plane = seams.player_contact_plane_view();
        }
    }

    // -----------------------------------------------------------------------
    // Control arbitration (P05 + the P09 combat pre-hook fold)
    // -----------------------------------------------------------------------

    /// `LoseControlToServer` — acclient.c:716832. No-op unless there is
    /// autonomy to lose; the flag is raised BEFORE the two dispatches
    /// (order load-bearing).
    #[allow(dead_code)] // staged: wire-side control-grab migration (the scene mirror carries it today)
    pub(crate) fn lose_control_to_server(&mut self, seams: &mut dyn InterpreterSeams) {
        if self.autonomy_level != 0 {
            self.controlled_by_server = true; // :716841
            self.set_auto_run(seams, 0, false); // :716842
            seams.finish_jump(); // :716843
        }
    }

    /// `TakeControlFromServer` — the FU-A ENGINE (ACCmdInterp override
    /// acclient.c:435803 → base :716934). Combat pre-hook, then: guard
    /// `controlled && autonomy && !PlayerIsDead` → clear control; if player:
    /// latch stamp + StopCompletely + StopInterpolating (the leash drop);
    /// then unconditionally re-assert hold_run and `ApplyCurrentMovement` —
    /// the ALL-THREE-HEADS revival that makes the four-key+tap strafecast
    /// technique fire (analysis §2.6/§3; supersedes FU5's
    /// consume_pending_take_control, ownership row 2). ADJ-15 Q8 closed:
    /// hold_run re-assert BEFORE the re-apply.
    pub(crate) fn take_control_from_server(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        via_use_time: bool,
    ) {
        seams.combat_abort_automatic_attack(); // P09 pre-hook (:435803)
        if self.controlled_by_server && self.autonomy_level != 0 && !self.player_is_dead(seams) {
            self.controlled_by_server = false; // :716942
            self.effects.push(InterpEffect::ControlReclaimed { via_use_time }); // rows 12-13 stream
            if self.player_present {
                seams.set_latch(); // :716946
                seams.phys_stop_completely(); // :716947
                seams.stop_interpolating(); // :716948 (leash drop)
            }
            let hr = self.hold_run;
            self.set_hold_run(seams, hr as i32); // :716950
            self.apply_current_movement(seams); // :716951 (FU-A tail)
        }
    }

    /// `UsePositionFromServer` — acclient.c:717529: only full autonomy (2)
    /// ignores the server position.
    #[allow(dead_code)] // staged: step-4 scene-control wiring
    pub(crate) fn use_position_from_server(&self) -> bool {
        self.autonomy_level != 2
    }

    /// `SetAutonomyLevel` — acclient.c:717569: range-gate `<= 2`; on accept,
    /// store + broadcast (flat 57). Returns accepted.
    #[allow(dead_code)] // staged: autonomy pinned at 2 (ADJ-6) — no live caller
    pub(crate) fn set_autonomy_level(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        new_level: u32,
    ) -> bool {
        if new_level <= 2 {
            self.autonomy_level = new_level;
            seams.send_autonomy_level(new_level);
            true
        } else {
            false
        }
    }

    // -----------------------------------------------------------------------
    // Modifiers (P06)
    // -----------------------------------------------------------------------

    /// `SetHoldRun` — acclient.c:716978. Guarded on `smartbox && player`
    /// (a run-key press before attach is silently dropped, hold_run
    /// unwritten). Effective gait = hold_key XOR ui-default-run; under
    /// autonomy it goes straight to the minterp, else press/release toward
    /// the server (dead arms in holtburger — ADJ-6).
    pub(crate) fn set_hold_run(&mut self, seams: &mut dyn InterpreterSeams, new_value: i32) {
        if !(self.smartbox_present && self.player_present) {
            return;
        }
        self.hold_run = new_value != 0; // normalized store (:716990)
        let effective_run = self.hold_run != seams.ui_toggles_run(); // XOR (:716991)
        if self.autonomy_level != 0 {
            seams.minterp_set_hold_run(effective_run); // :716995-996
        } else if effective_run {
            seams.send_do_movement(MOTION_HOLD_RUN, 1.0, 0); // :717000-005
        } else {
            seams.send_stop_movement(MOTION_HOLD_RUN, 0); // :717008
        }
    }

    /// `SetHoldSidestep` — acclient.c:717014. UNGUARDED (unlike SetHoldRun).
    /// Clears the Turn-list head, stores the flag RAW, re-applies.
    pub(crate) fn set_hold_sidestep(&mut self, seams: &mut dyn InterpreterSeams, new_value: i32) {
        self.stop_list_head_movement(seams, ListKind::Turn); // :717020
        self.hold_sidestep = new_value; // :717022 raw store
        self.apply_current_movement(seams); // :717023
    }

    /// `UpdateToggleRun` — acclient.c:717627: re-assert `hold_run` through
    /// SetHoldRun (re-evaluating against the possibly-changed UI option),
    /// then push the movement state. The send fires unconditionally even
    /// when SetHoldRun's guard dropped the re-assert.
    #[allow(dead_code)] // staged: player-option lane (M7)
    pub(crate) fn update_toggle_run(&mut self, seams: &mut dyn InterpreterSeams) {
        let hr = self.hold_run;
        self.set_hold_run(seams, hr as i32);
        self.send_movement_event(seams);
    }

    /// `ToggleAutoRun` — acclient.c:717657: `SetAutoRun(!auto_run, 1)`.
    pub(crate) fn toggle_auto_run(&mut self, seams: &mut dyn InterpreterSeams) {
        let toggled = (!self.auto_run) as i32;
        self.set_auto_run(seams, toggled, true);
    }

    /// `SetAutoRun(val, apply_movement)` — acclient.c:718254 (SC-12: void
    /// return). No-op unless the boolean state changes (:718263). On change:
    /// raw-store, clear `transient_state` (:718266 — full-field clear, P06
    /// OQ7), TakeControl only on OFF→ON (:718269), toast either way,
    /// ApplyCurrentMovement iff `apply_movement` and INSIDE the change block
    /// (:718289 — the ACE-drift pin: a same-value call re-applies nothing).
    pub(crate) fn set_auto_run(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        val: i32,
        apply_movement: bool,
    ) {
        if (val == 0) != (!self.auto_run) {
            self.auto_run = val != 0;
            self.transient_state = false;
            if val != 0 {
                self.take_control_from_server(seams, false);
                seams.display_autorun_status(true);
            } else {
                seams.display_autorun_status(false);
            }
            if apply_movement {
                self.apply_current_movement(seams);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Apply/stop tail (P04)
    // -----------------------------------------------------------------------

    /// `ApplyCurrentMovement` — acclient.c:717027 (flat 7). The
    /// once-per-frame re-assert of movement intent across the three axes:
    /// forward (auto-run press / substate-head replay / Ready reset — the
    /// `transient_state` wedge silences the forward axis when the list is
    /// empty), turn (head replay / SideStepRight+TurnRight releases),
    /// sidestep (head replay + EARLY RETURN / SideStepRight release). The
    /// shared SideStepRight release token is retail-literal (P04 OQ4:
    /// `ApplyHoldKeysToCommand` can have remapped a turn head into a
    /// sidestep press, so the turn-axis reset must release both forms).
    pub(crate) fn apply_current_movement(&mut self, seams: &mut dyn InterpreterSeams) {
        if !self.player_present {
            return;
        }
        // ── forward axis ──
        if self.forward_reclaim_locked {
            // WS04 (?castHoldReclaim): the cast chain owns the forward slot
            // at zero locomotion — keep it dead (Ready), do NOT replay the
            // held substate head (nor the auto_run re-issue). The substate
            // head stays in the list for later revival (a fresh forward edge
            // or window end). Turn/sidestep below re-apply normally. This
            // Ready emit is byte-identical to the `!transient_state` fallback
            // just below (`apply_axis(MOTION_READY) → drive.forward = None`).
            self.move_player(seams, MOTION_READY, 1, 1.0, 0, 0);
        } else if self.auto_run {
            let speed = self.autorun_speed;
            self.move_player(seams, MOTION_WALK_FORWARD, 1, speed, 1, 1);
        } else if self.substate_list.get_head().is_some() {
            self.apply_list_head_movement(seams, ListKind::Substate);
        } else if !self.transient_state {
            self.move_player(seams, MOTION_READY, 1, 1.0, 0, 0);
        }
        // ── turn axis ──
        if self.turn_list.get_head().is_some() {
            self.apply_list_head_movement(seams, ListKind::Turn);
        } else {
            self.move_player(seams, MOTION_SIDESTEP_RIGHT, 0, 1.0, 0, 0);
            self.move_player(seams, MOTION_TURN_RIGHT, 0, 1.0, 0, 0);
        }
        // ── sidestep axis ──
        if self.sidestep_list.get_head().is_some() {
            self.apply_list_head_movement(seams, ListKind::Sidestep);
            return;
        }
        self.move_player(seams, MOTION_SIDESTEP_RIGHT, 0, 1.0, 0, 0);
    }

    /// `ApplyListHeadMovement` — acclient.c:717102 (flat 11): replay the
    /// head as a PRESS.
    fn apply_list_head_movement(&mut self, seams: &mut dyn InterpreterSeams, list: ListKind) {
        self.apply_or_stop_list_head(seams, list, 1);
    }

    /// `StopListHeadMovement` — acclient.c:717150 (flat 12): byte-identical
    /// except start=release.
    fn stop_list_head_movement(&mut self, seams: &mut dyn InterpreterSeams, list: ListKind) {
        self.apply_or_stop_list_head(seams, list, 0);
    }

    /// Shared body (the two decomp bodies differ ONLY in the start bit).
    /// Mouse head → MovePlayer(cmd, start, speed, 1, elem.hold_run);
    /// keyboard head → ApplyHoldKeysToCommand first, then
    /// MovePlayer(cmd, start, speed, 0, 0).
    fn apply_or_stop_list_head(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        list: ListKind,
        start: i32,
    ) {
        let Some(head) = self.list_head(list) else {
            return;
        };
        if head.is_mouse {
            self.move_player(seams, head.command, start, head.speed, 1, head.hold_run);
        } else {
            let (mut cmd, mut speed) = (head.command, head.speed);
            apply_hold_keys_to_command(&mut cmd, &mut speed, self.hold_sidestep != 0);
            self.move_player(seams, cmd, start, speed, 0, 0);
        }
    }

    /// Interpreter-level `StopCompletely` — acclient.c:717535 (flat 47).
    /// Guard `smartbox && player`; ClearAllCommands → SetAutoRun(0,0) →
    /// `CPhysicsObj::StopCompletely(player, 1)` → SendMovementEvent.
    pub(crate) fn stop_completely(&mut self, seams: &mut dyn InterpreterSeams) -> bool {
        if !self.smartbox_present || !self.player_present {
            return false;
        }
        self.clear_all_commands();
        self.set_auto_run(seams, 0, false);
        seams.phys_stop_completely();
        self.send_movement_event(seams);
        true
    }

    /// `MaybeStopCompletely` — acclient.c:717557: under server control the
    /// stop is SILENTLY suppressed (true, nothing touched); else delegate.
    #[allow(dead_code)] // staged: step-4 stop wiring
    pub(crate) fn maybe_stop_completely(&mut self, seams: &mut dyn InterpreterSeams) -> bool {
        if self.controlled_by_server {
            return true;
        }
        self.stop_completely(seams)
    }

    /// `StopDrift` — acclient.c:718066: kill residual turn drift — fresh
    /// params, SetHoldKey bit cleared, hold_key 1, StopMotion both turn
    /// tokens.
    #[allow(dead_code)] // staged: step-4 mouse-look wiring (M4)
    pub(crate) fn stop_drift(&mut self, seams: &mut dyn InterpreterSeams) {
        let mut params = MovementParameters::default();
        params.bitfield &= BIT_CLEAR_SETHOLDKEY;
        params.hold_key_to_apply = 1;
        seams.stop_motion(MOTION_TURN_RIGHT, &params);
        seams.stop_motion(MOTION_TURN_LEFT, &params);
    }

    // -----------------------------------------------------------------------
    // Dispatch hub (P03)
    // -----------------------------------------------------------------------

    /// `HandleKeyboardCommand` — acclient.c:717225 (flat 38). Order is
    /// load-bearing: autorun toggle BEFORE the 0x08000000 skip gate (the
    /// toggle id carries that bit); the silent-release-under-control arm
    /// (SC-16: calls NukeCommand DIRECTLY, result ignored) BEFORE
    /// TakeControlFromServer; every other processed edge takes control first
    /// (the strafecast stomp); terminal = SendMovementEvent gated
    /// `cmd != Jump` (ADJ-3).
    pub(crate) fn handle_keyboard_command(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        cmd_struct: &mut CmdStruct,
    ) {
        if !self.is_active() {
            return; // :717246 (IsActive == enabled && player)
        }

        let command = cmd_struct.command();

        // :717251 — autorun toggle precedes the skip-bit gate.
        if command == MOTION_AUTORUN_TOGGLE {
            let autorun_speed = cmd_struct.decode_autorun_speed();
            self.autorun_speed = autorun_speed;
            self.toggle_auto_run(seams);
            self.send_movement_event(seams);
            return;
        }

        // :717271 — non-movement command bit: drop it.
        if command & CMD_SKIP_MOVEMENT_BIT != 0 {
            return;
        }

        // :717273 — decode (start, speed); speed defaults to 1.0.
        let (start, speed) = cmd_struct.decode_move_args(1.0);

        // :717284 — SILENT RELEASE ASYMMETRY (FU-C, analysis §2.7): while
        // the server owns us, a release is quietly nuked from its list and
        // never dispatched — no TakeControl, no motion, no event.
        if self.controlled_by_server && start == 0 {
            let (mut c, mut s, mut sp, mut mouse, mut nhr) = (command, start, speed, 0i32, 0i32);
            let _ = self.nuke_command(&mut c, &mut s, &mut sp, &mut mouse, &mut nhr);
            return;
        }

        // :717298 — THE STRAFECAST LATCH (FU-A): any processed press (or any
        // release we didn't nuke) seizes control from the server.
        self.take_control_from_server(seams, false);

        // :717299 — HoldRun / HoldSidestep modifier writes; a movement event
        // fires only if not already standing still (physics minterp — P03
        // OQ-7).
        if command == MOTION_HOLD_RUN {
            self.set_hold_run(seams, start);
            if !seams.minterp_is_standing_still() {
                self.send_movement_event(seams);
            }
            return;
        }
        if command == MOTION_HOLD_SIDESTEP {
            self.set_hold_sidestep(seams, start);
            if !seams.minterp_is_standing_still() {
                self.send_movement_event(seams);
            }
            return;
        }

        // :717313 — general command: Bookkeep may fold (false → just re-emit
        // the movement event) or approve a fresh dispatch.
        let (mut c, mut s, mut sp, mut mouse, mut nhr) = (command, start, speed, 0i32, 0i32);
        if !self.bookkeep_command_and_modify_if_necessary(
            seams, &mut c, &mut s, &mut sp, &mut mouse, &mut nhr,
        ) {
            self.send_movement_event(seams);
            return;
        }

        let mut sp2 = sp;
        apply_hold_keys_to_command(&mut c, &mut sp2, self.hold_sidestep != 0);
        self.move_player(seams, c, s, sp2, mouse, nhr);

        // :717320 — the terminal send, gated on Jump (ADJ-3: this is
        // SendMovementEvent flat 19, NOT HandleNewForwardMovement — HNFM
        // fires only from AddCommand's arms).
        if c != MOTION_JUMP {
            self.send_movement_event(seams);
        }
    }

    /// `MovePlayer` — acclient.c:717800 (flat 40; NOT overridden by
    /// ACCmdInterp — direct call is faithful, P03 OQ-1). Layers: dead/absent
    /// guard; the m_UseMouseTurning sidestep-remap block (dark in wave 1 —
    /// the seam returns false, M4); the autonomy split; press → DoMotion
    /// with action-command StopCompletely/action_stamp handling + refusal
    /// surfacing; release → StopMotion. Jump is a no-op in both autonomous
    /// arms.
    fn move_player(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        cmd: u32,
        start: i32,
        speed: f32,
        mouse: i32,
        new_hold_run: i32,
    ) {
        if !self.player_present || !seams.player_has_interp_motion_state() {
            return; // :717824
        }
        if self.player_is_dead(seams) {
            self.lose_keyboard_focus(seams); // :717828
            self.set_auto_run(seams, 0, false);
            return;
        }

        let mut cmd = cmd;
        let mut start = start;
        let mut speed = speed;
        let mut final_cmd = cmd;

        // :717834 — the whole remap block is gated on mouse turning (M4:
        // dark in wave 1; ported for fidelity + the P07 handlers).
        if seams.use_mouse_turning() {
            let turn_head = self
                .turn_list
                .get_head()
                .map(|e| e.command)
                .unwrap_or(0x8000_0000);
            let side_head = self
                .sidestep_list
                .get_head()
                .map(|e| e.command)
                .unwrap_or(0x8000_0000);
            let mouse_look = self.mouselook_active != 0;

            let mut cancel_sidestep_right = false;
            let mut cancel_sidestep_left = false;
            let mut cancel_turn_right = false;
            let mut cancel_turn_left = false;
            let mut start_turn_right = false;
            let mut start_turn_left = false;
            let mut start_sidestep_right = false;
            let mut start_sidestep_left = false;

            // The one path that bypasses TakeControl + the cancel stops: a
            // keyboard command while mouselook is inactive dispatches
            // verbatim (:717861 LABEL_59).
            let mut do_remap = true;

            if mouse == 0 {
                // :717859 — KEYBOARD branch.
                if !mouse_look {
                    do_remap = false;
                } else if cmd == MOTION_TURN_RIGHT {
                    if start != 0 {
                        cancel_turn_right = true;
                        start_sidestep_right = true; // LABEL_31
                    } else {
                        cancel_sidestep_right = true;
                    }
                } else if cmd == MOTION_TURN_LEFT {
                    if start != 0 {
                        cancel_turn_left = true;
                        start_sidestep_left = true;
                    } else {
                        cancel_sidestep_left = true;
                    }
                } else {
                    cancel_turn_right = true;
                    cancel_turn_left = true;
                }
            } else {
                // :717897 — MOUSE branch.
                if !mouse_look {
                    if turn_head == MOTION_TURN_RIGHT {
                        cancel_sidestep_right = true;
                        start_turn_right = true;
                    } else if turn_head == MOTION_TURN_LEFT {
                        cancel_sidestep_left = true;
                        start_turn_left = true;
                    }
                } else if cmd == CMD_MOUSELOOK_TURN {
                    if turn_head == MOTION_TURN_RIGHT {
                        cancel_turn_right = true;
                        if side_head == MOTION_SIDESTEP_LEFT {
                            start_sidestep_left = true;
                        } else {
                            start_sidestep_right = true;
                        }
                    } else if turn_head == MOTION_TURN_LEFT {
                        if side_head == MOTION_SIDESTEP_RIGHT {
                            cancel_turn_right = true; // LABEL_31 sharing
                            start_sidestep_right = true;
                        } else {
                            cancel_turn_left = true;
                            start_sidestep_left = true;
                        }
                    } else if self.mouseleft_down != 0 {
                        start = 1;
                        cmd = MOTION_WALK_FORWARD; // :717935 forced forward
                    }
                }
            }

            if do_remap {
                // :717938 (LABEL_38) — re-seize control, then cancel.
                self.take_control_from_server(seams, false);

                let mut cancel_params = MovementParameters::default();
                cancel_params.hold_key_to_apply = 0;
                if mouse != 0 {
                    cancel_params.bitfield &= BIT_CLEAR_SETHOLDKEY;
                    cancel_params.hold_key_to_apply = (new_hold_run != 0) as u32 + 1;
                }
                if cancel_sidestep_right {
                    seams.stop_motion(MOTION_SIDESTEP_RIGHT, &cancel_params);
                }
                if cancel_sidestep_left {
                    seams.stop_motion(MOTION_SIDESTEP_LEFT, &cancel_params);
                }
                if cancel_turn_right {
                    seams.stop_motion(MOTION_TURN_RIGHT, &cancel_params);
                }
                if cancel_turn_left {
                    seams.stop_motion(MOTION_TURN_LEFT, &cancel_params);
                }

                // :717947 — start_* remaps, retail order.
                final_cmd = cmd;
                if start_turn_right {
                    start = 1;
                    final_cmd = MOTION_TURN_RIGHT;
                }
                if start_turn_left {
                    final_cmd = MOTION_TURN_LEFT;
                    start = 1;
                }
                if start_sidestep_right {
                    final_cmd = MOTION_SIDESTEP_RIGHT;
                    start = 1;
                    speed = 1.0;
                }
                if start_sidestep_left {
                    start = 1;
                    final_cmd = MOTION_SIDESTEP_LEFT;
                    speed = 1.0;
                }
            }
        }

        // :717977/:717981 — hold key is uniform: mouse → 1 (None) or 2
        // (Run); keyboard → 0 (Invalid). Raw u32 per SC-10.
        let hold_key = if mouse != 0 {
            (new_hold_run != 0) as u32 + 1
        } else {
            0
        };

        // :717983 — autonomy split (level 0 is the dead server-piloted path,
        // ADJ-6/ADJ-13; ported for fidelity).
        if self.autonomy_level == 0 {
            self.move_player_non_autonomous(seams, final_cmd, start, speed, hold_key);
            return;
        }

        if start == 0 {
            // Release. :718042 — jump release is a no-op here.
            if final_cmd != MOTION_JUMP {
                let mut params = MovementParameters::default();
                params.hold_key_to_apply = 0;
                if mouse != 0 {
                    params.bitfield &= BIT_CLEAR_SETHOLDKEY;
                    params.hold_key_to_apply = (new_hold_run != 0) as u32 + 1;
                }
                seams.stop_motion(final_cmd, &params);
            }
            return;
        }

        // Press. :717987 — jump press is a no-op here (routed via OnAction
        // case 8 → CommenceJump).
        if final_cmd == MOTION_JUMP {
            return;
        }
        let mut params = MovementParameters::default();
        params.action_stamp = self.action_stamp;
        params.bitfield |= BIT_AUTONOMOUS;
        params.speed = speed;
        params.hold_key_to_apply = hold_key;
        if mouse != 0 {
            params.bitfield &= BIT_CLEAR_SETHOLDKEY;
        }

        let is_action = final_cmd & CMD_ACTION_BIT != 0;
        if is_action {
            self.stop_completely(seams); // :717998
        }

        let code = seams.do_motion(final_cmd, &params);
        if code == 0 {
            if is_action {
                self.action_stamp = self.action_stamp.wrapping_add(1); // :718003
            }
        } else if let Some(err) = MovementError::from_domotion(code) {
            seams.display_movement_error(err);
        }
    }

    /// `MovePlayer_NonAutonomous` — acclient.c:717669 (flat 14). Dead path
    /// in holtburger (autonomy pinned at 2 — ADJ-6/ADJ-13); ported for
    /// fidelity: press+non-jump → SendDoMovementEvent; press+jump →
    /// CommenceJump; release+non-jump → SendStopMovementEvent; release+jump
    /// → DoJump(0).
    fn move_player_non_autonomous(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        cmd: u32,
        start: i32,
        speed: f32,
        key: u32,
    ) {
        if start != 0 {
            if cmd != MOTION_JUMP {
                seams.send_do_movement(cmd, speed, key);
            } else {
                self.commence_jump(seams);
            }
        } else if cmd != MOTION_JUMP {
            seams.send_stop_movement(cmd, key);
        } else {
            seams.do_jump(false);
        }
    }

    /// `HandleNewForwardMovement` — the ACCmdInterp override
    /// (acclient.c:435866: combat pre-hook) delegating to the base one-liner
    /// (:717689 = `SetAutoRun(0, 1)`, ADJ-3-verified). Fires ONLY from
    /// AddCommand's two arms — never as the HKC terminal (SC-4).
    fn handle_new_forward_movement(&mut self, seams: &mut dyn InterpreterSeams) {
        self.effects.push(InterpEffect::ForwardSlotEvicted); // rows 12-13 stream
        seams.combat_abort_automatic_attack();
        self.set_auto_run(seams, 0, true);
    }

    // -----------------------------------------------------------------------
    // Mouse / turn surface (P07, ADJ-2 fixes applied)
    // -----------------------------------------------------------------------

    /// `SetMouseLookActive` — acclient.c:436211.
    #[allow(dead_code)] // staged: mouse-look lane (M4)
    pub(crate) fn set_mouse_look_active(&mut self, active: i32) {
        self.mouselook_active = active;
    }

    /// `GetMouseLookActive` — acclient.c:436217 (flat 53).
    #[allow(dead_code)] // staged: mouse-look lane (M4)
    pub(crate) fn get_mouse_look_active(&self) -> i32 {
        self.mouselook_active
    }

    /// `SetMouseLeftDown` — acclient.c:436223.
    #[allow(dead_code)] // staged: mouse-look lane (M4)
    pub(crate) fn set_mouse_left_down(&mut self, active: i32) {
        self.mouseleft_down = active;
    }

    /// `GetMouseLeftDown` — acclient.c:436229.
    #[allow(dead_code)] // staged: mouse-look lane (M4)
    pub(crate) fn get_mouse_left_down(&self) -> i32 {
        self.mouseleft_down
    }

    /// `HandleSelectLeft(start)` — acclient.c:717198. Always latches the
    /// button; iff mouse-turning AND mouse-look, injects a synthetic forward
    /// `MovePlayer(0x45000005, start, 1.0, mouse=1, nhr=1)` (bypassing
    /// decode + Bookkeep) then **SendMovementEvent** — ADJ-2 fix 1: the
    /// post-dispatch call is flat 19 (the fan-out's ApplyCurrentMovement
    /// reading would re-dispatch all held axes on every click edge and
    /// never send). Returns 1 when handled as movement.
    #[allow(dead_code)] // staged: mouse-look lane (M4)
    pub(crate) fn handle_select_left(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        start: i32,
    ) -> i32 {
        self.mouseleft_down = start;
        if seams.use_mouse_turning() && self.mouselook_active != 0 {
            self.move_player(seams, MOTION_WALK_FORWARD, start, 1.0, 1, 1);
            self.send_movement_event(seams); // ADJ-2: flat 19
            1
        } else {
            0
        }
    }

    /// `HandleMouseMovementCommand` — acclient.c:717341. Gated on IsActive;
    /// decodes with the P07 cursor discipline; the pre-dispatch hook is
    /// **TakeControlFromServer** (ADJ-2 fix 2: flat 26 — FU-A on the mouse
    /// path, exactly like the keyboard handler at :717298); Bookkeep; on
    /// approve, MovePlayer then **SendMovementEvent** (ADJ-2 fix 1).
    #[allow(dead_code)] // staged: mouse-look lane (M4)
    pub(crate) fn handle_mouse_movement_command(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        cmd_struct: &mut CmdStruct,
    ) {
        if !self.is_active() {
            return;
        }
        let mut command = cmd_struct.command();
        let (mut start, mut speed, mut new_hold_run) = cmd_struct.decode_mouse_args();

        self.take_control_from_server(seams, false); // ADJ-2: flat 26 (:717378)
        let mut mouse = 1i32;

        if self.bookkeep_command_and_modify_if_necessary(
            seams,
            &mut command,
            &mut start,
            &mut speed,
            &mut mouse,
            &mut new_hold_run,
        ) {
            self.move_player(seams, command, start, speed, mouse, new_hold_run);
            self.send_movement_event(seams); // ADJ-2: flat 19 (:717341 tail)
        }
    }

    /// `TurnToHeading` — acclient.c:718082. ADJ-2 fix 3: the guard is
    /// **IsActive** (flat 36 = enabled && player), not enabled alone — which
    /// also dissolves the null-player worry (the physics call is only
    /// reachable with a player). Builds default params, sets heading +
    /// speed 1.0, CLEARS stop_completely (`&= 0xFFFEFFFF`), Run hold key
    /// when `run`.
    #[allow(dead_code)] // staged: server/UI turn requests
    pub(crate) fn command_turn_to_heading(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        new_heading: f32,
        run: i32,
    ) -> i32 {
        if self.is_active() {
            let mut params = MovementParameters::default();
            params.desired_heading = new_heading;
            params.speed = 1.0;
            params.set_stop_completely(false);
            if run != 0 {
                params.hold_key_to_apply = 2; // HoldKey::Run
            }
            seams.player_turn_to_heading(&params);
            1
        } else {
            0
        }
    }

    // -----------------------------------------------------------------------
    // Input entry (the P09 fold: OnAction / SetMotion / jump / notices)
    // -----------------------------------------------------------------------

    /// `ACCmdInterp::CommenceJump` — acclient.c:435832: combat pre-charge.
    /// The retail tail's `RecvNotice_PrevSpellSelection` is COMDAT-folded
    /// dead (fidelity note) — not modeled.
    pub(crate) fn commence_jump(&mut self, seams: &mut dyn InterpreterSeams) {
        seams.commence_jump();
    }

    /// `ACCmdInterp::DoJump(autonomous)` — acclient.c:435844: pure
    /// forwarder.
    pub(crate) fn do_jump(&mut self, seams: &mut dyn InterpreterSeams, autonomous: bool) {
        seams.do_jump(autonomous);
    }

    /// `ACCmdInterp::SetMotion(motion, fOn)` — acclient.c:435936. Gated on a
    /// live player; builds the 4-byte-arg CmdStruct and dispatches it at the
    /// interpreter (retail routes via the GLOBAL SmartBox's registered
    /// interpreter — P09 OQ-10; holtburger has exactly one, which is self).
    pub(crate) fn set_motion(&mut self, seams: &mut dyn InterpreterSeams, motion: u32, f_on: bool) {
        if !self.player_present {
            return;
        }
        let mut cmd = CmdStruct::motion(motion, f_on);
        self.handle_keyboard_command(seams, &mut cmd);
    }

    /// `ACCmdInterp::OnAction(action, fStart)` — acclient.c:435951. Returns
    /// handled/consumed. Inactive interpreter SWALLOWS the event (true
    /// without acting). Dense switch over `InputAction - 0x29`; default →
    /// the emote hash (M3: ships dark/empty — movement ids 0x29-0x32 are the
    /// live surface; the ~90-pair emote list is `EMOTE_INPUT_ACTION_PAIRS`
    /// awaiting numeric ids). ADJ-4: this IS the retail entry the step-4 JS
    /// forwarder feeds (`w` → case 0 → WalkForward 0x45000005; autorun →
    /// case 7 → 0x090000C7 const-on — the two P14 constants corrected by
    /// construction).
    pub(crate) fn on_action(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        action: u32,
        f_start: bool,
    ) -> bool {
        if !self.is_active() {
            return true; // swallow while inactive (:0058b37d)
        }
        match action {
            0x29 => self.set_motion(seams, MOTION_WALK_FORWARD, f_start),
            0x2A => self.set_motion(seams, super::motion_interp::MOTION_WALK_BACKWARDS, f_start),
            0x2B => self.set_motion(seams, MOTION_READY, true), // const-on
            0x2C => self.set_motion(seams, MOTION_SIDESTEP_RIGHT, f_start),
            0x2D => self.set_motion(seams, MOTION_SIDESTEP_LEFT, f_start),
            0x2E => self.set_motion(seams, MOTION_TURN_RIGHT, f_start),
            0x2F => self.set_motion(seams, MOTION_TURN_LEFT, f_start),
            0x30 => self.set_motion(seams, MOTION_AUTORUN_TOGGLE, true), // const-on
            0x31 => {
                // press → charge; release → execute (autonomous).
                if f_start {
                    self.commence_jump(seams);
                } else {
                    self.do_jump(seams, true);
                }
            }
            0x32 => self.set_hold_run(seams, f_start as i32),
            _ => {
                // Emote path (M3: dark — the hash ships empty until the
                // numeric InputAction ids land; unknown → not handled).
                return false;
            }
        }
        true
    }

    /// `RecvNotice_PlayerOptionChanged(opt)` — acclient.c:435917. On the
    /// toggle-run option (10) changing with a live player, re-read the
    /// toggle state and re-assert it on the minterp — the keyboard-side
    /// companion to FU-A's hold_run re-assert.
    #[allow(dead_code)] // staged: player-option lane (M7)
    pub(crate) fn recv_notice_player_option_changed(
        &mut self,
        seams: &mut dyn InterpreterSeams,
        option: u32,
    ) {
        const TOGGLE_RUN_PLAYER_OPTION: u32 = 10;
        if option == TOGGLE_RUN_PLAYER_OPTION && self.player_present {
            let state = seams.ui_toggles_run();
            seams.minterp_set_hold_run(state);
        }
    }
}

/// The complete emote (InputAction, MotionCommand) pair list from
/// `InitializeEmoteInputActionHash` (acclient.c:436034), in retail insertion
/// order — 91 pairs, fidelity-verified programmatically. M3: the numeric
/// InputAction ids are not on this box; the hash ships DARK (empty) and
/// `on_action`'s default arm returns unhandled. When an id source lands,
/// build the map from this list.
#[allow(dead_code)] // staged: emote input lane (M3)
pub(crate) const EMOTE_INPUT_ACTION_PAIRS: &[(&str, &str)] = &[
    ("Ready", "Motion_Ready"),
    ("Crouch", "Motion_Crouch"),
    ("Sitting", "Motion_Sitting"),
    ("Sleeping", "Motion_Sleeping"),
    ("ShakeFistState", "Motion_ShakeFistState"),
    ("PrayState", "Motion_PrayState"),
    ("BowDeepState", "Motion_BowDeepState"),
    ("ClapHandsState", "Motion_ClapHandsState"),
    ("CrossArmsState", "Motion_CrossArmsState"),
    ("ShiverState", "Motion_ShiverState"),
    ("PointState", "Motion_PointState"),
    ("WaveState", "Motion_WaveState"),
    ("AkimboState", "Motion_AkimboState"),
    ("SaluteState", "Motion_SaluteState"),
    ("ScratchHeadState", "Motion_ScratchHeadState"),
    ("TapFootState", "Motion_TapFootState"),
    ("LeanState", "Motion_LeanState"),
    ("KneelState", "Motion_KneelState"),
    ("PleadState", "Motion_PleadState"),
    ("ATOYOT", "Motion_ATOYOT"),
    ("SlouchState", "Motion_SlouchState"),
    ("SurrenderState", "Motion_SurrenderState"),
    ("WoahState", "Motion_WoahState"),
    ("WindedState", "Motion_WindedState"),
    ("SnowAngelState", "Motion_SnowAngelState"),
    ("CurtseyState", "Motion_CurtseyState"),
    ("AFKState", "Motion_AFKState"),
    ("MeditateState", "Motion_MeditateState"),
    ("SitState", "Motion_SitState"),
    ("SitCrossleggedState", "Motion_SitCrossleggedState"),
    ("SitBackState", "Motion_SitBackState"),
    ("PointLeftState", "Motion_PointLeftState"),
    ("PointRightState", "Motion_PointRightState"),
    ("TalktotheHandState", "Motion_TalktotheHandState"),
    ("PointDownState", "Motion_PointDownState"),
    ("DrudgeDanceState", "Motion_DrudgeDanceState"),
    ("PossumState", "Motion_PossumState"),
    ("ReadState", "Motion_ReadState"),
    ("ThinkerState", "Motion_ThinkerState"),
    ("HaveASeatState", "Motion_HaveASeatState"),
    ("AtEaseState", "Motion_AtEaseState"),
    ("Cheer", "Motion_Cheer"),
    ("Cry", "Motion_Cry"),
    ("ShakeFist", "Motion_ShakeFist"),
    ("Beckon", "Motion_Beckon"),
    ("BeSeeingYou", "Motion_BeSeeingYou"),
    ("BlowKiss", "Motion_BlowKiss"),
    ("BowDeep", "Motion_BowDeep"),
    ("ClapHands", "Motion_ClapHands"),
    ("Laugh", "Motion_Laugh"),
    ("MimeEat", "Motion_MimeEat"),
    ("MimeDrink", "Motion_MimeDrink"),
    ("Nod", "Motion_Nod"),
    ("Point", "Motion_Point"),
    ("ShakeHead", "Motion_ShakeHead"),
    ("Shrug", "Motion_Shrug"),
    ("Wave", "Motion_Wave"),
    ("Akimbo", "Motion_Akimbo"),
    ("HeartyLaugh", "Motion_HeartyLaugh"),
    ("Salute", "Motion_Salute"),
    ("ScratchHead", "Motion_ScratchHead"),
    ("SmackHead", "Motion_SmackHead"),
    ("TapFoot", "Motion_TapFoot"),
    ("WaveHigh", "Motion_WaveHigh"),
    ("WaveLow", "Motion_WaveLow"),
    ("YawnStretch", "Motion_YawnStretch"),
    ("Cringe", "Motion_Cringe"),
    ("Kneel", "Motion_Kneel"),
    ("Plead", "Motion_Plead"),
    ("Shiver", "Motion_Shiver"),
    ("Shoo", "Motion_Shoo"),
    ("Slouch", "Motion_Slouch"),
    ("Spit", "Motion_Spit"),
    ("Surrender", "Motion_Surrender"),
    ("Woah", "Motion_Woah"),
    ("Winded", "Motion_Winded"),
    ("YMCA", "Motion_YMCA"),
    ("Pray", "Motion_Pray"),
    ("Mock", "Motion_Mock"),
    ("Teapot", "Motion_Teapot"),
    ("WarmHands", "Motion_WarmHands"),
    ("NudgeLeft", "Motion_NudgeLeft"),
    ("NudgeRight", "Motion_NudgeRight"),
    ("PointLeft", "Motion_PointLeft"),
    ("PointRight", "Motion_PointRight"),
    ("PointDown", "Motion_PointDown"),
    ("Knock", "Motion_Knock"),
    ("ScanHorizon", "Motion_ScanHorizon"),
    ("DrudgeDance", "Motion_DrudgeDance"),
    ("HaveASeat", "Motion_HaveASeat"),
    ("Helper", "Motion_Helper"),
];

// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// Recording seam — every outward call logged for order assertions.
    #[derive(Debug, Clone, PartialEq)]
    enum Op {
        DoMotion {
            cmd: u32,
            speed_bits: u32,
            hold_key: u32,
            stamp: u32,
            autonomous: bool,
        },
        StopMotion {
            cmd: u32,
            hold_key: u32,
        },
        PhysStopCompletely,
        StopInterpolating,
        SetLatch,
        MinterpHoldRun(bool),
        CombatAbort,
        CommenceJump,
        DoJump(bool),
        FinishJump,
        SendMoveToState,
        SendAutonomousPosition,
        SendAutonomyLevel(u32),
        SendDo(u32),
        SendStop(u32),
        Error(MovementError),
        AutorunToast(bool),
        ReportExhaustion,
        TurnToHeading {
            heading_bits: u32,
            stop_completely: bool,
            hold_key: u32,
        },
    }

    struct Mock {
        log: Vec<Op>,
        cur_time: f64,
        forward_command: Option<u32>,
        has_interp_state: bool,
        has_raw_state: bool,
        motions_pending: bool,
        is_moving_to: bool,
        standing_still: bool,
        ui_run: bool,
        mouse_turning: bool,
        domotion_code: u32,
        move_to_sent: bool,
        autonomous_sent: bool,
        position_ready: bool,
        objcell_id: u32,
        frame_equals: bool,
        plane_equals: bool,
        cast_forward_lock: bool,
    }

    impl Default for Mock {
        fn default() -> Self {
            Mock {
                log: vec![],
                cur_time: 100.0,
                forward_command: None,
                has_interp_state: true,
                has_raw_state: true,
                motions_pending: false,
                is_moving_to: false,
                standing_still: false,
                ui_run: false,
                mouse_turning: false,
                domotion_code: 0,
                move_to_sent: true,
                autonomous_sent: true,
                position_ready: false,
                objcell_id: 0,
                frame_equals: true,
                plane_equals: true,
                cast_forward_lock: false,
            }
        }
    }

    impl InterpreterSeams for Mock {
        fn cur_time(&self) -> f64 {
            self.cur_time
        }
        fn do_motion(&mut self, cmd: u32, params: &MovementParameters) -> u32 {
            self.log.push(Op::DoMotion {
                cmd,
                speed_bits: params.speed.to_bits(),
                hold_key: params.hold_key_to_apply,
                stamp: params.action_stamp,
                autonomous: params.bitfield & 0x1000 != 0,
            });
            self.domotion_code
        }
        fn stop_motion(&mut self, cmd: u32, params: &MovementParameters) {
            self.log.push(Op::StopMotion {
                cmd,
                hold_key: params.hold_key_to_apply,
            });
        }
        fn phys_stop_completely(&mut self) {
            self.log.push(Op::PhysStopCompletely);
        }
        fn stop_interpolating(&mut self) {
            self.log.push(Op::StopInterpolating);
        }
        fn set_latch(&mut self) {
            self.log.push(Op::SetLatch);
        }
        fn minterp_set_hold_run(&mut self, on: bool) {
            self.log.push(Op::MinterpHoldRun(on));
        }
        fn minterp_is_standing_still(&self) -> bool {
            self.standing_still
        }
        fn player_forward_command(&self) -> Option<u32> {
            self.forward_command
        }
        fn player_has_interp_motion_state(&self) -> bool {
            self.has_interp_state
        }
        fn player_has_raw_motion_state(&self) -> bool {
            self.has_raw_state
        }
        fn player_motions_pending(&self) -> bool {
            self.motions_pending
        }
        fn player_is_moving_to(&self) -> bool {
            self.is_moving_to
        }
        fn local_cast_forward_lock_active(&self) -> bool {
            self.cast_forward_lock
        }
        fn player_report_exhaustion(&mut self) {
            self.log.push(Op::ReportExhaustion);
        }
        fn player_turn_to_heading(&mut self, params: &MovementParameters) {
            self.log.push(Op::TurnToHeading {
                heading_bits: params.desired_heading.to_bits(),
                stop_completely: params.stop_completely(),
                hold_key: params.hold_key_to_apply,
            });
        }
        fn player_position_event_ready(&self) -> bool {
            self.position_ready
        }
        fn player_objcell_id(&self) -> u32 {
            self.objcell_id
        }
        fn player_frame_equals(&self, _last: &FrameView) -> bool {
            self.frame_equals
        }
        fn player_contact_plane_equals(&self, _last: &PlaneView) -> bool {
            self.plane_equals
        }
        fn player_position_view(&self) -> PositionView {
            PositionView {
                objcell_id: self.objcell_id,
                frame: FrameView::default(),
            }
        }
        fn player_contact_plane_view(&self) -> PlaneView {
            PlaneView::default()
        }
        fn ui_toggles_run(&self) -> bool {
            self.ui_run
        }
        fn use_mouse_turning(&self) -> bool {
            self.mouse_turning
        }
        fn combat_abort_automatic_attack(&mut self) {
            self.log.push(Op::CombatAbort);
        }
        fn commence_jump(&mut self) {
            self.log.push(Op::CommenceJump);
        }
        fn do_jump(&mut self, autonomous: bool) {
            self.log.push(Op::DoJump(autonomous));
        }
        fn finish_jump(&mut self) {
            self.log.push(Op::FinishJump);
        }
        fn send_move_to_state(&mut self) -> bool {
            self.log.push(Op::SendMoveToState);
            self.move_to_sent
        }
        fn send_autonomous_position(&mut self) -> bool {
            self.log.push(Op::SendAutonomousPosition);
            self.autonomous_sent
        }
        fn send_autonomy_level(&mut self, level: u32) {
            self.log.push(Op::SendAutonomyLevel(level));
        }
        fn send_do_movement(&mut self, cmd: u32, _speed: f32, _hold_key: u32) {
            self.log.push(Op::SendDo(cmd));
        }
        fn send_stop_movement(&mut self, cmd: u32, _hold_key: u32) {
            self.log.push(Op::SendStop(cmd));
        }
        fn display_movement_error(&mut self, err: MovementError) {
            self.log.push(Op::Error(err));
        }
        fn display_autorun_status(&mut self, on: bool) {
            self.log.push(Op::AutorunToast(on));
        }
    }

    /// Post-SetSmartBox/NewPlayer interpreter (smartbox + player attached).
    fn in_world() -> CommandInterpreter {
        let mut it = CommandInterpreter::new(100.0);
        it.set_smartbox(true, true);
        it
    }

    fn key_cmd(cmd: u32, start: bool) -> CmdStruct {
        CmdStruct::motion(cmd, start)
    }

    // ---- ctor (P08) -------------------------------------------------------

    #[test]
    fn ctor_defaults_match_retail() {
        let s = CommandInterpreter::new(100.0);
        assert_eq!(s.autonomy_level, 2, "ctor seed :717749 (SC-13)");
        assert!(s.controlled_by_server);
        assert!(s.enabled);
        assert_eq!(s.action_stamp, 1);
        assert_eq!(s.autorun_speed, 1.0);
        assert!(!s.hold_run);
        assert!(!s.transient_state);
        assert!(!s.auto_run);
        assert_eq!(s.time_between_position_events, 1.0);
        assert_eq!(s.last_sent_position_time, 100.0);
        assert!(!s.is_active(), "enabled but no player yet");
        assert!(s.is_enabled());
        // holtburger configs (verdict §3.3): both default ON — retail
        // latch honoring + the modern slidecast persist (ADJ-8).
        assert!(s.honor_autonomy_latch);
        assert!(s.slidecast_persist);
    }

    // ---- HKC (P03) --------------------------------------------------------

    #[test]
    fn hkc_inactive_is_ignored() {
        let mut m = Mock::default();
        let mut it = CommandInterpreter::new(0.0); // no player
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_TURN_RIGHT, true));
        assert!(m.log.is_empty());
    }

    #[test]
    fn hkc_autorun_toggle_precedes_skip_bit() {
        assert_ne!(MOTION_AUTORUN_TOGGLE & CMD_SKIP_MOVEMENT_BIT, 0);
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        let mut args = 1i32.to_le_bytes().to_vec();
        args.extend_from_slice(&3.0f32.to_le_bytes());
        it.handle_keyboard_command(&mut m, &mut CmdStruct::new(MOTION_AUTORUN_TOGGLE, args));
        assert_eq!(it.autorun_speed, 3.0);
        assert!(it.auto_run, "toggled on");
        // toggle ON runs TakeControl (no-op here: not controlled) + toast +
        // ACM + the HKC send.
        assert!(m.log.contains(&Op::AutorunToast(true)));
        assert!(m.log.contains(&Op::SendMoveToState));
    }

    #[test]
    fn hkc_skip_bit_drops_command() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.handle_keyboard_command(&mut m, &mut key_cmd(0x0800_00AA, true));
        assert!(m.log.is_empty());
    }

    #[test]
    fn hkc_silent_release_under_server_control_pops_without_dispatch() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_SIDESTEP_RIGHT, true));
        m.log.clear();
        it.controlled_by_server = true; // cast machinery grabs control
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_SIDESTEP_RIGHT, false));
        assert!(m.log.is_empty(), "no stop, no send, no TakeControl");
        assert!(
            it.sidestep_list.get_head().is_none(),
            "yet the list is still bookkept (ADJ-7 pop)"
        );
        assert!(it.controlled_by_server, "a silent release does not reclaim");
    }

    #[test]
    fn hkc_press_under_control_stomps_and_revives_all_heads() {
        // FU-A: the four-key setup + a tap under control revives everything.
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        for cmd in [
            MOTION_SIDESTEP_RIGHT,
            MOTION_TURN_RIGHT,
            super::super::motion_interp::MOTION_WALK_BACKWARDS,
            MOTION_WALK_FORWARD,
        ] {
            it.handle_keyboard_command(&mut m, &mut key_cmd(cmd, true));
        }
        it.controlled_by_server = true;
        m.log.clear();
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_TURN_RIGHT, true));
        assert!(!it.controlled_by_server, "control reclaimed");
        let presses: Vec<u32> = m
            .log
            .iter()
            .filter_map(|op| match op {
                Op::DoMotion { cmd, .. } => Some(*cmd),
                _ => None,
            })
            .collect();
        assert!(presses.contains(&MOTION_WALK_FORWARD), "forward head revived");
        assert!(presses.contains(&MOTION_TURN_RIGHT), "turn head revived");
        assert!(
            presses.contains(&MOTION_SIDESTEP_RIGHT),
            "sidestep head revived"
        );
        assert!(m.log.contains(&Op::SetLatch), "latch stamped at reclaim");
        assert!(m.log.contains(&Op::StopInterpolating), "leash dropped");
        // ADJ-15 Q8: hold_run re-assert BEFORE the ACM revival — the minterp
        // call precedes the first revived DoMotion.
        let hold_idx = m
            .log
            .iter()
            .position(|op| matches!(op, Op::MinterpHoldRun(_)))
            .expect("hold_run re-asserted");
        let first_do = m
            .log
            .iter()
            .position(|op| matches!(op, Op::DoMotion { .. }))
            .expect("revival dispatched");
        assert!(hold_idx < first_do, "hold_run re-assert precedes re-apply");
    }

    #[test]
    fn hkc_hold_run_gated_on_standing_still() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_HOLD_RUN, true));
        assert!(m.log.contains(&Op::MinterpHoldRun(true)), "hold XOR ui(false)");
        assert!(m.log.contains(&Op::SendMoveToState), "moving → event fires");

        let mut m2 = Mock {
            standing_still: true,
            ..Default::default()
        };
        let mut it2 = in_world();
        it2.controlled_by_server = false;
        it2.handle_keyboard_command(&mut m2, &mut key_cmd(MOTION_HOLD_SIDESTEP, true));
        assert_eq!(it2.hold_sidestep, 1);
        assert!(
            !m2.log.contains(&Op::SendMoveToState),
            "standing still → no event"
        );
    }

    #[test]
    fn hkc_jump_skips_terminal_send() {
        // ADJ-3: the terminal send is gated cmd != Jump.
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_JUMP, true));
        assert!(
            !m.log.contains(&Op::SendMoveToState),
            "jump: no terminal SendMovementEvent (:717320)"
        );
        // (Bookkeep skips Jump; MovePlayer's autonomous jump press is a
        // no-op — the jump lane is OnAction case 8.)
        assert!(
            !m.log.iter().any(|op| matches!(op, Op::DoMotion { .. })),
            "jump never DoMotions through this path"
        );
    }

    #[test]
    fn hkc_head_wins_pop_through() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        let back = super::super::motion_interp::MOTION_WALK_BACKWARDS;
        it.handle_keyboard_command(&mut m, &mut key_cmd(back, true)); // [x]
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_WALK_FORWARD, true)); // [x, ↑]
        m.log.clear();
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_WALK_FORWARD, false));
        // pop-through: ONE DoMotion of the buried x as a fresh press.
        let dos: Vec<&Op> = m
            .log
            .iter()
            .filter(|op| matches!(op, Op::DoMotion { .. }))
            .collect();
        assert_eq!(dos.len(), 1);
        assert!(matches!(dos[0], Op::DoMotion { cmd, .. } if *cmd == back));
        assert_eq!(
            it.substate_list.get_head().unwrap().command,
            back,
            "forward slot re-owned by x"
        );
    }

    #[test]
    fn hkc_transient_wedge_suppresses_release_dispatch() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_TURN_RIGHT, true));
        // A loose (non-list, non-Ready) substate command wedges the axis.
        it.handle_keyboard_command(&mut m, &mut key_cmd(0x4100_0008, true));
        assert!(it.transient_state, "wedged (:717452)");
        m.log.clear();
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_TURN_RIGHT, false));
        assert!(
            !m.log.iter().any(|op| matches!(op, Op::DoMotion { .. })
                || matches!(op, Op::StopMotion { .. })),
            "release dispatch suppressed while wedged"
        );
        // A forward press clears the wedge.
        it.handle_keyboard_command(&mut m, &mut key_cmd(MOTION_WALK_FORWARD, true));
        assert!(!it.transient_state, "forward press clears the wedge");
    }

    // ---- MovePlayer (P03) --------------------------------------------------

    #[test]
    fn mp_dead_player_loses_focus() {
        let mut m = Mock {
            forward_command: Some(MOTION_COMMAND_DEAD),
            ..Default::default()
        };
        let mut it = in_world();
        it.move_player(&mut m, MOTION_TURN_RIGHT, 1, 1.0, 0, 0);
        assert!(m.log.contains(&Op::FinishJump), "LoseKeyboardFocus ran");
        assert!(
            !m.log.iter().any(|op| matches!(op, Op::DoMotion { .. })),
            "no motion dispatched for a dead player"
        );
    }

    #[test]
    fn mp_autonomous_press_sets_stamp_and_autonomous_bit() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.move_player(&mut m, MOTION_TURN_RIGHT, 1, 0.5, 0, 0);
        assert_eq!(
            m.log,
            vec![Op::DoMotion {
                cmd: MOTION_TURN_RIGHT,
                speed_bits: 0.5f32.to_bits(),
                hold_key: 0,
                stamp: 1,
                autonomous: true,
            }]
        );
    }

    #[test]
    fn mp_action_command_stops_completely_and_bumps_stamp() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        let action_cmd = CMD_ACTION_BIT | 0x0055;
        it.move_player(&mut m, action_cmd, 1, 1.0, 0, 0);
        // interpreter StopCompletely (clear lists + SetAutoRun + phys stop +
        // send) precedes the DoMotion; stamp bumps on success.
        assert!(m.log.contains(&Op::PhysStopCompletely));
        assert!(m.log.iter().any(|op| matches!(op, Op::DoMotion { .. })));
        assert_eq!(it.action_stamp, 2, "stamp bumped on action success");
    }

    #[test]
    fn mp_domotion_refusal_surfaces_error_no_stamp() {
        let mut m = Mock {
            domotion_code: 62,
            ..Default::default()
        };
        let mut it = in_world();
        it.controlled_by_server = false;
        let action_cmd = CMD_ACTION_BIT | 0x0055;
        it.move_player(&mut m, action_cmd, 1, 1.0, 0, 0);
        assert!(m.log.contains(&Op::Error(MovementError::TooTired)));
        assert_eq!(it.action_stamp, 1, "no bump on refusal");
    }

    #[test]
    fn mp_release_stops_motion_and_jump_is_noop() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.move_player(&mut m, MOTION_TURN_RIGHT, 0, 1.0, 0, 0);
        assert_eq!(
            m.log,
            vec![Op::StopMotion {
                cmd: MOTION_TURN_RIGHT,
                hold_key: 0
            }]
        );
        m.log.clear();
        it.move_player(&mut m, MOTION_JUMP, 1, 1.0, 0, 0);
        it.move_player(&mut m, MOTION_JUMP, 0, 1.0, 0, 0);
        assert!(m.log.is_empty(), "autonomous jump press+release are no-ops");
    }

    #[test]
    fn mp_mouse_hold_key_encoding() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.move_player(&mut m, MOTION_TURN_RIGHT, 1, 1.0, 1, 1);
        assert!(
            matches!(m.log[0], Op::DoMotion { hold_key: 2, .. }),
            "mouse + hold_run → Run (2)"
        );
        let mut m2 = Mock::default();
        it.move_player(&mut m2, MOTION_TURN_RIGHT, 1, 1.0, 1, 0);
        assert!(
            matches!(m2.log[0], Op::DoMotion { hold_key: 1, .. }),
            "mouse + no hold_run → None (1)"
        );
    }

    #[test]
    fn mp_mouse_turning_keyboard_mouselook_turn_press_becomes_strafe() {
        let mut m = Mock {
            mouse_turning: true,
            ..Default::default()
        };
        let mut it = in_world();
        it.controlled_by_server = false;
        it.mouselook_active = 1;
        it.move_player(&mut m, MOTION_TURN_RIGHT, 1, 1.0, 0, 0);
        assert!(
            m.log
                .iter()
                .any(|op| matches!(op, Op::StopMotion { cmd, .. } if *cmd == MOTION_TURN_RIGHT)),
            "cancel turn-right stop issued"
        );
        assert!(
            m.log.iter().any(|op| matches!(op, Op::DoMotion { cmd, speed_bits, .. }
                if *cmd == MOTION_SIDESTEP_RIGHT && *speed_bits == 1.0f32.to_bits())),
            "final DoMotion is SideStepRight at speed 1.0"
        );
    }

    #[test]
    fn mp_mouse_turning_keyboard_no_mouselook_dispatches_verbatim() {
        // LABEL_59 hatch: no TakeControl, no cancels, cmd unchanged.
        let mut m = Mock {
            mouse_turning: true,
            ..Default::default()
        };
        let mut it = in_world();
        it.controlled_by_server = true; // would be reclaimed if remap ran
        it.move_player(&mut m, MOTION_TURN_RIGHT, 1, 1.0, 0, 0);
        assert!(it.controlled_by_server, "hatch skips TakeControl");
        assert!(
            m.log
                .iter()
                .all(|op| !matches!(op, Op::StopMotion { .. })),
            "no cancels"
        );
        assert!(matches!(m.log[0], Op::DoMotion { cmd, .. } if cmd == MOTION_TURN_RIGHT));
    }

    // ---- ApplyCurrentMovement (P04) ----------------------------------------

    #[test]
    fn acm_idle_no_transient_presses_ready_then_releases() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.apply_current_movement(&mut m);
        let cmds: Vec<(u32, bool)> = m
            .log
            .iter()
            .filter_map(|op| match op {
                Op::DoMotion { cmd, .. } => Some((*cmd, true)),
                Op::StopMotion { cmd, .. } => Some((*cmd, false)),
                _ => None,
            })
            .collect();
        assert_eq!(
            cmds,
            vec![
                (MOTION_READY, true),           // forward reset press
                (MOTION_SIDESTEP_RIGHT, false), // turn-empty rel #1
                (MOTION_TURN_RIGHT, false),     // turn-empty rel #2
                (MOTION_SIDESTEP_RIGHT, false), // sidestep-empty rel
            ]
        );
    }

    #[test]
    fn acm_transient_suppresses_forward_axis() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.transient_state = true;
        it.apply_current_movement(&mut m);
        assert!(
            !m.log
                .iter()
                .any(|op| matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_READY)),
            "§2.8 wedge: forward axis silent"
        );
    }

    #[test]
    fn acm_auto_run_presses_walk_forward_at_autorun_speed() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.auto_run = true;
        it.autorun_speed = 3.0;
        it.apply_current_movement(&mut m);
        assert!(matches!(
            m.log[0],
            Op::DoMotion { cmd, speed_bits, hold_key: 2, .. }
                if cmd == MOTION_WALK_FORWARD && speed_bits == 3.0f32.to_bits()
        ));
    }

    #[test]
    fn acm_sidestep_head_replays_and_early_returns() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.sidestep_list.add_command(MOTION_SIDESTEP_LEFT, 1.0, false, 0);
        it.apply_current_movement(&mut m);
        let last = m.log.last().unwrap();
        assert!(
            matches!(last, Op::DoMotion { cmd, .. } if *cmd == MOTION_SIDESTEP_LEFT),
            "ends with the sidestep head replay — no trailing release"
        );
    }

    // ---- Control (P05) ------------------------------------------------------

    #[test]
    fn lose_control_sets_flag_then_finish_jump() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.lose_control_to_server(&mut m);
        assert!(it.controlled_by_server);
        assert!(m.log.contains(&Op::FinishJump));
    }

    #[test]
    fn lose_control_noop_without_autonomy() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.autonomy_level = 0;
        it.controlled_by_server = false;
        it.lose_control_to_server(&mut m);
        assert!(!it.controlled_by_server);
        assert!(m.log.is_empty());
    }

    #[test]
    fn take_control_noop_when_dead_or_uncontrolled() {
        let mut m = Mock {
            forward_command: Some(MOTION_COMMAND_DEAD),
            ..Default::default()
        };
        let mut it = in_world();
        it.take_control_from_server(&mut m, false);
        assert!(it.controlled_by_server, "dead → reclaim aborted");
        assert!(!m.log.contains(&Op::SetLatch));

        let mut m2 = Mock::default();
        let mut it2 = in_world();
        it2.controlled_by_server = false;
        it2.take_control_from_server(&mut m2, false);
        // combat pre-hook fires unconditionally (P09 shape); the tail does not.
        assert!(!m2.log.contains(&Op::SetLatch));
    }

    #[test]
    fn set_autonomy_level_range_gates_and_broadcasts() {
        let mut m = Mock::default();
        let mut it = in_world();
        assert!(it.set_autonomy_level(&mut m, 1));
        assert_eq!(it.autonomy_level, 1);
        assert_eq!(m.log, vec![Op::SendAutonomyLevel(1)]);
        assert!(!it.set_autonomy_level(&mut m, 3));
        assert_eq!(it.autonomy_level, 1, "rejected write");
    }

    // ---- Modifiers (P06) ----------------------------------------------------

    #[test]
    fn set_hold_run_guarded_and_xor() {
        // Unattached: full no-op, hold_run unwritten.
        let mut m = Mock::default();
        let mut it = CommandInterpreter::new(0.0);
        it.set_hold_run(&mut m, 1);
        assert!(!it.hold_run);
        assert!(m.log.is_empty());

        // ui run-default + hold → effective WALK (the hold key inverts).
        let mut m = Mock {
            ui_run: true,
            ..Default::default()
        };
        let mut it = in_world();
        it.set_hold_run(&mut m, 1);
        assert_eq!(m.log, vec![Op::MinterpHoldRun(false)]);
    }

    #[test]
    fn set_hold_sidestep_stores_raw_and_reapplies() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.set_hold_sidestep(&mut m, 7);
        assert_eq!(it.hold_sidestep, 7, "raw store, not normalized");
        assert!(
            m.log
                .iter()
                .any(|op| matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_READY)),
            "ApplyCurrentMovement ran"
        );
    }

    #[test]
    fn set_auto_run_same_value_is_full_noop() {
        // The ACE-drift pin (P06 OQ1): apply gated INSIDE the change block.
        let mut m = Mock::default();
        let mut it = in_world();
        it.auto_run = true;
        it.transient_state = true;
        it.set_auto_run(&mut m, 1, true);
        assert!(m.log.is_empty());
        assert!(it.transient_state, "wedge untouched on same-value call");
    }

    #[test]
    fn set_auto_run_on_takes_control_and_clears_wedge() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.transient_state = true;
        it.set_auto_run(&mut m, 1, true);
        assert!(it.auto_run);
        assert!(!it.transient_state);
        assert!(m.log.contains(&Op::AutorunToast(true)));
        assert!(m.log.contains(&Op::CombatAbort), "TakeControl pre-hook ran");
    }

    // ---- Session (P08) ------------------------------------------------------

    #[test]
    fn disable_sequence_when_autonomous_uncontrolled() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.hold_sidestep = 5;
        it.disable(&mut m);
        assert_eq!(it.hold_sidestep, 0);
        assert!(!it.enabled);
        assert!(m.log.contains(&Op::SendMoveToState), "disable sends");

        let mut m2 = Mock::default();
        let mut it2 = in_world();
        it2.controlled_by_server = true;
        it2.disable(&mut m2);
        assert!(
            !m2.log.contains(&Op::SendMoveToState),
            "controlled → no apply/send"
        );
    }

    #[test]
    fn player_teleported_cancels_autorun_then_sends() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.auto_run = true;
        it.controlled_by_server = false;
        it.player_teleported(&mut m);
        assert!(!it.auto_run);
        assert!(m.log.contains(&Op::SendMoveToState));
    }

    #[test]
    fn use_time_latches_control_on_queued_input() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = true;
        it.substate_list.add_command(MOTION_WALK_FORWARD, 1.0, false, 0);
        it.use_time(&mut m);
        assert!(!it.controlled_by_server, "FU-A UseTime trigger reclaimed");
        assert!(m.log.contains(&Op::SetLatch));

        let mut m2 = Mock::default();
        let mut it2 = in_world();
        it2.controlled_by_server = true;
        it2.use_time(&mut m2); // no queued input, no auto_run
        assert!(it2.controlled_by_server, "no queued input → no latch");
    }

    #[test]
    fn send_movement_event_guard_and_stamp() {
        let mut m = Mock {
            cur_time: 555.0,
            has_raw_state: false,
            ..Default::default()
        };
        let mut it = in_world();
        it.send_movement_event(&mut m);
        assert!(m.log.is_empty(), "no raw state → no send, no stamp");
        assert_eq!(it.last_sent_position_time, 100.0);

        m.has_raw_state = true;
        it.send_movement_event(&mut m);
        assert_eq!(m.log, vec![Op::SendMoveToState]);
        assert_eq!(it.last_sent_position_time, 555.0, "stamp on emit");
    }

    #[test]
    fn should_send_windowed_compare() {
        let mut m = Mock {
            cur_time: 100.5, // in window (last 100, tbpe 1.0)
            plane_equals: true,
            ..Default::default()
        };
        let it = in_world();
        assert!(!it.should_send_position_event(&m), "in-window, no change");
        m.plane_equals = false;
        assert!(it.should_send_position_event(&m), "plane change sends");
        m.plane_equals = true;
        m.objcell_id = 7;
        assert!(it.should_send_position_event(&m), "cell change sends");
        m.objcell_id = 0;
        m.cur_time = 200.0; // out of window
        m.frame_equals = false;
        assert!(it.should_send_position_event(&m), "frame change sends");
        m.frame_equals = true;
        assert!(!it.should_send_position_event(&m));
    }

    #[test]
    fn use_time_position_event_stamps_all_three() {
        let mut m = Mock {
            cur_time: 200.0,
            frame_equals: false,
            position_ready: true,
            objcell_id: 42,
            ..Default::default()
        };
        let mut it = in_world();
        it.controlled_by_server = false;
        it.use_time(&mut m);
        assert!(m.log.contains(&Op::SendAutonomousPosition));
        assert_eq!(it.last_sent_position_time, 200.0);
        assert_eq!(it.last_sent_position.objcell_id, 42);
    }

    // ---- P07 (ADJ-2 pins) ---------------------------------------------------

    #[test]
    fn select_left_sends_not_reapplies() {
        // ADJ-2 fix 1: the post-dispatch call is SendMovementEvent.
        let mut m = Mock {
            mouse_turning: true,
            ..Default::default()
        };
        let mut it = in_world();
        it.controlled_by_server = false;
        it.mouselook_active = 1;
        assert_eq!(it.handle_select_left(&mut m, 1), 1);
        assert!(
            m.log.contains(&Op::SendMoveToState),
            "click path ENDS WITH a send (flat 19)"
        );
        assert!(
            !m.log
                .iter()
                .any(|op| matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_READY)),
            "no ApplyCurrentMovement re-apply (the fan-out's mis-resolution)"
        );
        // Gate closed → not handled, button still latched.
        let mut m2 = Mock::default(); // mouse_turning false
        let mut it2 = in_world();
        assert_eq!(it2.handle_select_left(&mut m2, 1), 0);
        assert_eq!(it2.mouseleft_down, 1);
    }

    #[test]
    fn mouse_movement_command_takes_control_first_then_sends() {
        // ADJ-2 fix 2: the pre-dispatch hook IS TakeControlFromServer.
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = true; // under server control
        let mut args = 1i32.to_le_bytes().to_vec();
        args.extend_from_slice(&2.0f32.to_le_bytes());
        args.extend_from_slice(&5i32.to_le_bytes());
        let mut c = CmdStruct::new(MOTION_TURN_RIGHT, args);
        it.handle_mouse_movement_command(&mut m, &mut c);
        assert!(
            !it.controlled_by_server,
            "mouse edge reclaims control (FU-A on the mouse path)"
        );
        assert!(m.log.contains(&Op::SetLatch));
        assert!(
            m.log.contains(&Op::SendMoveToState),
            "tail is a send (ADJ-2 fix 1)"
        );
        // the dispatched motion carries the mouse hold-key encoding
        assert!(
            m.log
                .iter()
                .any(|op| matches!(op, Op::DoMotion { cmd, hold_key: 2, .. } if *cmd == MOTION_TURN_RIGHT)),
            "mouse press hold_key = Run(2) from new_hold_run=5"
        );
    }

    #[test]
    fn turn_to_heading_gates_on_is_active() {
        // ADJ-2 fix 3: IsActive (enabled && player), not enabled alone.
        let mut m = Mock::default();
        let mut it = CommandInterpreter::new(0.0); // enabled but NO player
        assert_eq!(it.command_turn_to_heading(&mut m, 1.5, 0), 0);
        assert!(m.log.is_empty(), "no physics call without a player");

        let mut it2 = in_world();
        assert_eq!(it2.command_turn_to_heading(&mut m, 2.5, 1), 1);
        assert!(matches!(
            m.log[0],
            Op::TurnToHeading {
                heading_bits,
                stop_completely: false,
                hold_key: 2,
            } if heading_bits == 2.5f32.to_bits()
        ));
    }

    // ---- P09 entry ----------------------------------------------------------

    #[test]
    fn on_action_movement_cases_dispatch_corrected_constants() {
        // ADJ-4/ADJ-16: w → WalkForward 0x45000005; autorun → 0x090000C7
        // const-on.
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        assert!(it.on_action(&mut m, 0x29, true));
        assert!(
            m.log
                .iter()
                .any(|op| matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_WALK_FORWARD)),
            "case 0 = WalkForward 0x45000005"
        );
        m.log.clear();
        assert!(it.on_action(&mut m, 0x30, false)); // const-on regardless of start
        assert!(it.auto_run, "autorun toggled via 0x090000C7");
    }

    #[test]
    fn on_action_jump_and_hold_run_route() {
        let mut m = Mock::default();
        let mut it = in_world();
        it.controlled_by_server = false;
        it.on_action(&mut m, 0x31, true);
        it.on_action(&mut m, 0x31, false);
        assert!(m.log.contains(&Op::CommenceJump));
        assert!(m.log.contains(&Op::DoJump(true)));
        m.log.clear();
        it.on_action(&mut m, 0x32, true);
        assert!(m.log.contains(&Op::MinterpHoldRun(true)));
    }

    #[test]
    fn on_action_inactive_swallows_and_unknown_falls_through() {
        let mut m = Mock::default();
        let mut it = CommandInterpreter::new(0.0); // no player → inactive
        assert!(it.on_action(&mut m, 0x29, true), "swallowed while inactive");
        assert!(m.log.is_empty());

        let mut it2 = in_world();
        assert!(
            !it2.on_action(&mut m, 0xDEAD_BEEF, true),
            "unknown action unhandled (emote hash dark, M3)"
        );
    }

    #[test]
    fn emote_pair_list_is_the_verified_91() {
        assert_eq!(EMOTE_INPUT_ACTION_PAIRS.len(), 91);
    }

    // ---- WS04 (?castHoldReclaim) ------------------------------------------

    /// WS04 — with the cast forward lock active, the `use_time` reclaim
    /// returns control + revives held turn/sidestep BUT holds the forward
    /// axis at Ready (dead). The seam reports the lock via `cast_forward_lock`.
    #[test]
    fn cast_hold_reclaim_suppresses_forward_revival_only() {
        let mut it = CommandInterpreter::new(0.0);
        it.set_smartbox(true, true);
        it.controlled_by_server = true;
        // Held W (forward substate head) + held strafe-right (an edge press
        // seeds each list head).
        it.substate_list.add_command(MOTION_WALK_FORWARD, 1.0, false, 0);
        it.sidestep_list.add_command(MOTION_SIDESTEP_RIGHT, 1.0, false, 0);
        let mut m = Mock {
            motions_pending: false,
            cast_forward_lock: true,
            ..Default::default()
        };
        it.use_time(&mut m);
        // Forward axis: NO held forward key revives — the substate head is
        // NOT replayed as a WalkForward press.
        let fwd_revived = m.log.iter().any(|op| {
            matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_WALK_FORWARD)
        });
        assert!(
            !fwd_revived,
            "forward held key must NOT revive under the cast lock"
        );
        // The forward axis instead emits a Ready press (dead).
        let ready = m
            .log
            .iter()
            .any(|op| matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_READY));
        assert!(ready, "forward axis emits Ready (dead) under the lock");
        // Held strafe still revives (slidecast semantics preserved).
        let side = m.log.iter().any(|op| {
            matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_SIDESTEP_RIGHT)
        });
        assert!(
            side,
            "held strafe still reclaims (slidecast semantics preserved)"
        );
        // Control still returns to the player.
        assert!(
            !it.controlled_by_server,
            "control still returns to the player"
        );
        // The scoped flag never persists past the reclaim.
        assert!(
            !it.forward_reclaim_locked,
            "forward_reclaim_locked resets immediately after the scoped reclaim"
        );
    }

    /// WS04 — lock OFF (no window / flag off) → the existing per-node revival
    /// stands (regression floor: byte-identical to today when the flag is off).
    #[test]
    fn cast_hold_reclaim_off_preserves_use_time_revival() {
        let mut it = CommandInterpreter::new(0.0);
        it.set_smartbox(true, true);
        it.controlled_by_server = true;
        it.substate_list.add_command(MOTION_WALK_FORWARD, 1.0, false, 0);
        let mut m = Mock {
            motions_pending: false,
            cast_forward_lock: false,
            ..Default::default()
        };
        it.use_time(&mut m);
        assert!(
            m.log.iter().any(|op| {
                matches!(op, Op::DoMotion { cmd, .. } if *cmd == MOTION_WALK_FORWARD)
            }),
            "flag-off: held-W revives via use_time exactly as today"
        );
    }
}
