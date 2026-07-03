//! Movement-port WAVE 1 / P02 (2026-07-03) — **command stacks**: the
//! three-list bookkeeping half of retail `CommandInterpreter`: how a
//! keyboard/mouse movement command is pushed onto / popped off its axis
//! stack, the **pop-through-to-fresh-press** mechanic that makes the
//! strafecast forward stack `[x under ↑]` re-own the forward slot on every
//! flap (`docs/strafecast-mechanism-analysis-2026-07-03.md §3`), and the
//! `transient_state` **wedge/suppression trio** of §2.8.
//!
//! Ported decomp-primary from `~/ac-headers/acclient.c`:
//!   * `CommandInterpreter::AddCommand`                          (:717429)
//!   * `CommandInterpreter::NukeCommand`                         (:717458)
//!   * `CommandInterpreter::BookkeepCommandAndModifyIfNecessary` (:717499)
//!   * `CommandInterpreter::ClearAllCommands`                    (:716848)
//! Routing (`WhichList` :717402) and the per-axis list are P01's
//! (`super::list_engine`) — the packet's own `CommandListOps` trait and
//! duplicate `which_list` were dropped at integration (SC-5 / P02 OQ5):
//! the stacks operate directly on the concrete [`CommandList`].
//!
//! INTEGRATION SHAPE (SC-14/SC-15): this module is the PINNED unit-level
//! port of the P02 contract. The step-3 unified `CommandInterpreter`
//! folds the three lists + `transient_state` in as direct fields and
//! transplants these bodies as inherent methods (its
//! `handle_new_forward_movement` is a direct self-call there — the
//! [`ForwardMovementSink`] seam below exists so THIS copy stays
//! compilable/testable standalone, and P15's fixtures dual-run both
//! copies as the drift alarm).
//!
//! ACE never ported the client-side list stacks — all semantics below are
//! decomp-derived (ACE `CommandList.cs` is mis-decompiled/stubbed,
//! P01 OQ8).

use super::list_engine::{CommandList, ListKind, which_list};
use super::motion_interp::{MOTION_JUMP, MOTION_READY};

/// Bit 30. Marks a command word as an interpreter-managed *movement*
/// command (`WhichList` default arm gate; AddCommand's press test). Retail
/// literal `0x40000000` (`acclient.c:717402,717436,717445`). Same value as
/// [`super::list_engine::MOVEMENT_FLAG`] — re-declared under the packet's
/// name for the AddCommand-arm reads below.
#[allow(dead_code)] // staged: step-3 interpreter fold
pub(crate) const MOVEMENT_CMD_BIT: u32 = super::list_engine::MOVEMENT_FLAG;

/// Bit 26. Together with [`MOVEMENT_CMD_BIT`] routes a command to the
/// SubstateList. Its ABSENCE in the AddCommand else-arm is what marks a
/// "loose" (non-list) substate command that wedges `transient_state`.
/// Retail literal `0x4000000` (`acclient.c:717423,717440`).
#[allow(dead_code)] // staged: step-3 interpreter fold
pub(crate) const SUBSTATE_ROUTE_BIT: u32 = super::list_engine::SUBSTATE_FLAG;

/// The in/out command register threaded through Bookkeep → Add/Nuke. Retail
/// passes these as five separate `int*`/`float*`/`unsigned*` out-params
/// (`acclient.c:717458,717499`); bundling them keeps the same aliasing but
/// makes the mutation explicit. Param ORDER settled by SC-6: Bookkeep's
/// 4th out-param = `mouse`, 5th = `hold_run` (the Hex-Rays call-site name
/// swap is stack-slot noise; Binja binding is authoritative).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CommandSlot {
    /// `cmd` — the command word. NukeCommand may REWRITE this to the
    /// popped-through head's command.
    pub cmd: u32,
    /// `start` — is this a press (`true`) or a release (`false`).
    /// NukeCommand sets it `true` when it pops through to a fresh head (a
    /// synthetic press).
    pub start: bool,
    /// `speed`.
    pub speed: f32,
    /// `mouse` — did this edge originate from the mouse. NukeCommand
    /// rewrites it to the new head's mouse-ness on pop-through.
    pub mouse: bool,
    /// `hold_run` — the hold_run latch to carry with this command (retail
    /// call-site name `new_hold_run`; element field name `hold_run` —
    /// SC-5/ADJ-16).
    pub hold_run: i32,
}

/// P03 seam: retail `HandleNewForwardMovement` (`acclient.c:717689`, flat
/// vtable slot 18 — a verified one-liner `SetAutoRun(0, 1)`, ADJ-3).
/// AddCommand calls it outward from BOTH its arms (substate-list push and
/// loose-substate — and ONLY from there; it is NOT the HKC terminal,
/// SC-4). Modelled as a trait so the interpreter's dispatch layer (or a
/// recording fake in tests) supplies the body; the unified interpreter
/// transplants the caller bodies instead (module doc).
#[allow(dead_code)] // staged: step-3 interpreter fold (P15 dual-run keeps this copy pinned)
pub(crate) trait ForwardMovementSink {
    fn handle_new_forward_movement(&mut self);
}

/// The subset of `CommandInterpreter` state P02 owns: the three axis stacks
/// and the `transient_state` wedge. `auto_run` is owned by P06
/// (`SetAutoRun`, `acclient.c:718254`) but READ here (NukeCommand
/// suppression) — carried as a plain field the unified interpreter aliases
/// to the real one.
///
/// Field sources (retail names → this struct, acclient.h:35340-35347):
///   * `SubstateList` / `TurnList` / `SidestepList` → the three lists.
///   * `transient_state` (i32) → `transient_state: bool`.
///   * `auto_run` (i32) → `auto_run: bool` (P06-owned mirror).
#[derive(Debug, Default)]
pub(crate) struct CommandStacks {
    /// Retail `SubstateList`.
    pub substate_list: CommandList,
    /// Retail `TurnList`.
    pub turn_list: CommandList,
    /// Retail `SidestepList`.
    pub sidestep_list: CommandList,
    /// Retail `transient_state`. The §2.8 wedge: set by a non-list substate
    /// command (AddCommand else-arm, except `Motion_Ready`); cleared by ANY
    /// successful list-add of a `MOVEMENT_CMD_BIT` command (AddCommand
    /// Some-arm); while set it SUPPRESSES NukeCommand pop-through — NOTE
    /// the element IS still popped (`RemoveCommand` runs before the
    /// suppression test, decomp :717469-717474); only the DISPATCH is
    /// suppressed (ADJ-7). Also read by P04 `ApplyCurrentMovement` to
    /// suppress ready-stops. Distinct from the `CPhysicsObj` bitfield of
    /// the same name (SC-21/P08 warning).
    pub transient_state: bool,
    /// Retail `auto_run` (P06-owned). When set, releasing a SubstateList
    /// head does NOT pop through — auto-run keeps holding the forward axis
    /// (`acclient.c:717472`).
    pub auto_run: bool,
}

#[allow(dead_code)] // staged: step-3 interpreter fold (P15 dual-run keeps this copy pinned)
impl CommandStacks {
    fn list(&self, id: ListKind) -> &CommandList {
        match id {
            ListKind::Substate => &self.substate_list,
            ListKind::Turn => &self.turn_list,
            ListKind::Sidestep => &self.sidestep_list,
        }
    }

    fn list_mut(&mut self, id: ListKind) -> &mut CommandList {
        match id {
            ListKind::Substate => &mut self.substate_list,
            ListKind::Turn => &mut self.turn_list,
            ListKind::Sidestep => &mut self.sidestep_list,
        }
    }

    /// `CommandInterpreter::AddCommand` (`acclient.c:717429`). Push a
    /// command onto its axis stack and manage the `transient_state` wedge:
    ///   * If it routes to a list: push it. Then, if it's a movement
    ///     command (`MOVEMENT_CMD_BIT`): if it's the forward (Substate)
    ///     list fire `HandleNewForwardMovement` (:717442, BEFORE the wedge
    ///     write), then CLEAR the wedge (:717445-717447).
    ///   * If it routes NOWHERE but is a loose movement command
    ///     (`MOVEMENT_CMD_BIT && !SUBSTATE_ROUTE_BIT`): fire
    ///     `HandleNewForwardMovement` (:717450), and unless it's
    ///     `Motion_Ready` SET the wedge (`transient_state = 1`, :717451-
    ///     717452). The fire-before-write order is load-bearing: HNFM =
    ///     `SetAutoRun(0,1)` whose `ApplyCurrentMovement` reads the
    ///     PRE-WRITE wedge when auto_run was on.
    pub(crate) fn add_command(
        &mut self,
        cmd: u32,
        speed: f32,
        mouse: bool,
        hold_run: i32,
        fwd: &mut impl ForwardMovementSink,
    ) {
        match which_list(cmd) {
            Some(id) => {
                self.list_mut(id).add_command(cmd, speed, mouse, hold_run);
                if cmd & MOVEMENT_CMD_BIT != 0 {
                    if id == ListKind::Substate {
                        fwd.handle_new_forward_movement();
                    }
                    self.transient_state = false;
                }
            }
            None => {
                if cmd & MOVEMENT_CMD_BIT != 0 && cmd & SUBSTATE_ROUTE_BIT == 0 {
                    fwd.handle_new_forward_movement();
                    if cmd != MOTION_READY {
                        self.transient_state = true;
                    }
                }
            }
        }
    }

    /// `CommandInterpreter::NukeCommand` (`acclient.c:717458`). Pop a
    /// command off its stack and, if it was the HEAD, POP THROUGH to the
    /// new head as a synthetic press. This is the strafecast forward
    /// stack's engine: releasing `↑` off `[x under ↑]` re-issues a fresh
    /// `x` PRESS so the forward slot never empties mid-dance (§3).
    ///
    /// Returns `true` == "the caller should keep going" (retail `result`):
    ///   * `slot.start == true`  → a fresh head popped through (dispatch it).
    ///   * `slot.start == false` → the list emptied; the caller
    ///     (`HandleKeyboardCommand`) issues the axis STOP.
    /// Returns `false` == "swallow this release" — either the removed
    /// command was NOT the head (head still drives), or a SUPPRESSION held:
    ///   * `transient_state` set (the §2.8 wedge), or
    ///   * `auto_run` set and this is the SubstateList (auto-run owns
    ///     forward).
    /// WEDGE SEMANTICS (ADJ-7): `RemoveCommand` runs BEFORE the
    /// suppression test (decomp :717469-717474) — the element IS popped
    /// even when suppressed; only the dispatch is swallowed. Wedged/silent
    /// releases therefore DO empty the lists.
    ///
    /// Out-params (`slot.{cmd,speed,start,mouse,hold_run}`) are rewritten
    /// ONLY when a head is present after removal (retail writes under
    /// `if(v8)`); on an empty-after-remove they stay as the caller left
    /// them.
    pub(crate) fn nuke_command(&mut self, slot: &mut CommandSlot) -> bool {
        let Some(id) = which_list(slot.cmd) else {
            return false;
        };
        let was_head = self
            .list_mut(id)
            .remove_command(slot.cmd, slot.speed, slot.mouse);
        if !was_head || self.transient_state || (self.auto_run && id == ListKind::Substate) {
            return false;
        }
        if let Some(head) = self.list(id).get_head() {
            slot.cmd = head.command;
            slot.speed = head.speed;
            slot.hold_run = head.hold_run;
            slot.start = true;
            slot.mouse = self.list(id).head_is_mouse();
        }
        true
    }

    /// `CommandInterpreter::BookkeepCommandAndModifyIfNecessary`
    /// (`acclient.c:717499`). The press/release router in front of
    /// Add/Nuke:
    ///   * `MOTION_JUMP` (0x2500003B) → do nothing, return `true` — the
    ///     jump path is CommenceJump/DoJump, not the lists (P02 OQ1,
    ///     resolved by the fidelity pass: command_strings index 59 =
    ///     "Jump").
    ///   * press (`slot.start`) → `AddCommand`, return `true`.
    ///   * release → `NukeCommand` (its bool result is the return).
    pub(crate) fn bookkeep_command_and_modify_if_necessary(
        &mut self,
        slot: &mut CommandSlot,
        fwd: &mut impl ForwardMovementSink,
    ) -> bool {
        if slot.cmd == MOTION_JUMP {
            true
        } else if slot.start {
            self.add_command(slot.cmd, slot.speed, slot.mouse, slot.hold_run, fwd);
            true
        } else {
            self.nuke_command(slot)
        }
    }

    /// `CommandInterpreter::ClearAllCommands` (`acclient.c:716848`). Flush
    /// all three axis stacks. Does NOT touch `transient_state` (retail
    /// leaves it — P02 OQ4: no hidden reset exists in
    /// LoseKeyboardFocus/TakeControl either; a stale wedge persists by
    /// design until the next movement-bit list-add).
    pub(crate) fn clear_all_commands(&mut self) {
        self.substate_list.clear_all_commands();
        self.turn_list.clear_all_commands();
        self.sidestep_list.clear_all_commands();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::movement::motion_interp::{MOTION_TURN_LEFT, MOTION_TURN_RIGHT};

    #[derive(Default)]
    struct CountingFwd(u32);
    impl ForwardMovementSink for CountingFwd {
        fn handle_new_forward_movement(&mut self) {
            self.0 += 1;
        }
    }

    fn stacks() -> CommandStacks {
        CommandStacks::default()
    }

    // A synthetic SubstateList-routed command: both movement bits + a nonce.
    const FWD_A: u32 = MOVEMENT_CMD_BIT | SUBSTATE_ROUTE_BIT | 0x01; // ↑ / forward
    const FWD_B: u32 = MOVEMENT_CMD_BIT | SUBSTATE_ROUTE_BIT | 0x02; // x / backward
    // A loose (non-list) movement command: movement bit, no substate route.
    const LOOSE_GESTURE: u32 = MOVEMENT_CMD_BIT | 0x07;
    // A non-movement command (neither bit): must be inert.
    const NON_MOVEMENT: u32 = 0x0000_0007;

    #[test]
    fn add_substate_press_fires_forward_and_clears_wedge() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.transient_state = true; // pretend a prior wedge is set
        s.add_command(FWD_A, 1.0, false, 0, &mut fwd);
        assert_eq!(fwd.0, 1, "substate press must fire HandleNewForwardMovement");
        assert!(!s.transient_state, "substate press clears the wedge");
        assert_eq!(s.substate_list.get_head().unwrap().command, FWD_A);
    }

    #[test]
    fn add_turn_press_clears_wedge_without_forward() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.transient_state = true;
        s.add_command(MOTION_TURN_LEFT, 1.0, false, 0, &mut fwd);
        assert_eq!(fwd.0, 0, "turn press must NOT fire HandleNewForwardMovement");
        assert!(!s.transient_state, "any movement-bit list-add clears the wedge");
        assert!(s.turn_list.get_head().is_some());
    }

    #[test]
    fn add_loose_gesture_sets_wedge_and_fires_forward() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(LOOSE_GESTURE, 1.0, false, 0, &mut fwd);
        assert_eq!(fwd.0, 1, "loose movement cmd fires HandleNewForwardMovement");
        assert!(s.transient_state, "loose non-list substate cmd wedges the axis");
    }

    #[test]
    fn add_motion_ready_fires_forward_but_never_wedges() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(MOTION_READY, 1.0, false, 0, &mut fwd);
        assert_eq!(fwd.0, 1);
        assert!(!s.transient_state, "Motion_Ready is exempt from the wedge");
    }

    #[test]
    fn add_non_movement_is_inert() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(NON_MOVEMENT, 1.0, false, 0, &mut fwd);
        assert_eq!(fwd.0, 0);
        assert!(!s.transient_state);
        assert!(s.substate_list.get_head().is_none());
    }

    #[test]
    fn nuke_head_pops_through_to_fresh_press() {
        // Build the strafecast forward stack [FWD_B under FWD_A]: press x then ↑.
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_B, 2.0, false, 5, &mut fwd); // x pushed first
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd); // ↑ now head
        // Release the head (↑) → pop through to x as a synthetic PRESS.
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 9,
        };
        let go = s.nuke_command(&mut slot);
        assert!(go);
        assert!(slot.start, "pop-through synthesizes a press");
        assert_eq!(slot.cmd, FWD_B, "forward slot re-owned by x");
        assert_eq!(slot.speed, 2.0);
        assert_eq!(slot.hold_run, 5);
        assert_eq!(s.substate_list.get_head().unwrap().command, FWD_B);
    }

    #[test]
    fn nuke_non_head_is_swallowed() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_B, 2.0, false, 5, &mut fwd);
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd); // FWD_A is head
        // Release the NON-head (FWD_B): head still drives, no re-dispatch.
        let mut slot = CommandSlot {
            cmd: FWD_B,
            start: false,
            speed: 2.0,
            mouse: false,
            hold_run: 5,
        };
        assert!(!s.nuke_command(&mut slot));
        assert_eq!(s.substate_list.get_head().unwrap().command, FWD_A);
    }

    #[test]
    fn nuke_head_emptying_returns_true_with_stop() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd);
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 9,
        };
        let go = s.nuke_command(&mut slot);
        assert!(
            go,
            "emptying the list still returns true (caller stops the axis)"
        );
        assert!(!slot.start, "no head → start stays false → caller issues the STOP");
        assert!(s.substate_list.get_head().is_none());
    }

    #[test]
    fn nuke_suppressed_by_transient_state_but_still_pops() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_B, 2.0, false, 5, &mut fwd);
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd);
        s.transient_state = true; // the §2.8 wedge
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 9,
        };
        assert!(!s.nuke_command(&mut slot), "wedge: release dispatch swallowed");
        assert!(!slot.start);
        // ADJ-7: the element IS popped — only the dispatch was suppressed
        // (decomp :717469: RemoveCommand runs before the suppression test).
        assert_eq!(
            s.substate_list.get_head().unwrap().command,
            FWD_B,
            "wedged release still pops the element"
        );
    }

    #[test]
    fn nuke_suppressed_by_auto_run_on_substate_only() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_B, 2.0, false, 5, &mut fwd);
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd);
        s.auto_run = true;
        // Substate release is swallowed while auto_run holds forward.
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 9,
        };
        assert!(!s.nuke_command(&mut slot));
        // But auto_run does NOT suppress the Turn list. (ADJ-1 note: 0x0E
        // = TurnLeft pushed first, 0x0D = TurnRight head — numerics match
        // the packet's original flow, names corrected.)
        s.add_command(MOTION_TURN_LEFT, 1.0, false, 0, &mut fwd);
        s.add_command(MOTION_TURN_RIGHT, 1.0, false, 0, &mut fwd);
        let mut t = CommandSlot {
            cmd: MOTION_TURN_RIGHT,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 0,
        };
        assert!(s.nuke_command(&mut t), "auto_run only guards the SubstateList");
        assert!(t.start);
        assert_eq!(t.cmd, MOTION_TURN_LEFT);
    }

    #[test]
    fn nuke_unrouted_command_returns_false() {
        let mut s = stacks();
        let mut slot = CommandSlot {
            cmd: NON_MOVEMENT,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 0,
        };
        assert!(!s.nuke_command(&mut slot));
    }

    #[test]
    fn nuke_pop_through_reports_mouse_head() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_B, 2.0, true, 5, &mut fwd); // a mouse-origin head under...
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd); // ...a keyboard head
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 9,
        };
        assert!(s.nuke_command(&mut slot));
        assert_eq!(slot.cmd, FWD_B);
        assert!(slot.mouse, "pop-through reports the new head's HeadIsMouse");
    }

    /// SC-5 drift pin: a keyboard release must NOT consume a mouse node
    /// even on a command match — P01's REAL RemoveCommand skips the mouse
    /// node on the keyboard path (the packet's FakeList matched
    /// `mouse == e.mouse` which happened to work; the real list's contract
    /// is the retail one, :718315).
    #[test]
    fn nuke_keyboard_release_never_consumes_mouse_node() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_A, 1.0, true, 0, &mut fwd); // mouse node, cmd FWD_A
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false, // KEYBOARD release of the same command word
            hold_run: 0,
        };
        assert!(!s.nuke_command(&mut slot), "keyboard release finds no keyboard node");
        assert!(s.substate_list.head_is_mouse(), "mouse node survives");
    }

    #[test]
    fn bookkeep_skip_sentinel_is_noop() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        let mut slot = CommandSlot {
            cmd: MOTION_JUMP,
            start: true,
            speed: 1.0,
            mouse: false,
            hold_run: 0,
        };
        assert!(s.bookkeep_command_and_modify_if_necessary(&mut slot, &mut fwd));
        assert_eq!(fwd.0, 0);
        assert!(
            s.substate_list.get_head().is_none(),
            "skip sentinel touches no list"
        );
    }

    #[test]
    fn bookkeep_press_routes_to_add() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: true,
            speed: 1.0,
            mouse: false,
            hold_run: 0,
        };
        assert!(s.bookkeep_command_and_modify_if_necessary(&mut slot, &mut fwd));
        assert_eq!(s.substate_list.get_head().unwrap().command, FWD_A);
        assert_eq!(fwd.0, 1);
    }

    #[test]
    fn bookkeep_release_routes_to_nuke() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_B, 2.0, false, 5, &mut fwd);
        s.add_command(FWD_A, 1.0, false, 9, &mut fwd);
        let mut slot = CommandSlot {
            cmd: FWD_A,
            start: false,
            speed: 1.0,
            mouse: false,
            hold_run: 9,
        };
        let go = s.bookkeep_command_and_modify_if_necessary(&mut slot, &mut fwd);
        assert!(
            go && slot.start && slot.cmd == FWD_B,
            "release pops through via Nuke"
        );
    }

    #[test]
    fn clear_all_flushes_three_lists() {
        let mut s = stacks();
        let mut fwd = CountingFwd::default();
        s.add_command(FWD_A, 1.0, false, 0, &mut fwd);
        s.add_command(MOTION_TURN_LEFT, 1.0, false, 0, &mut fwd);
        s.add_command(
            crate::client::movement::motion_interp::MOTION_SIDESTEP_LEFT,
            1.0,
            false,
            0,
            &mut fwd,
        );
        s.transient_state = true;
        s.clear_all_commands();
        assert!(s.substate_list.get_head().is_none());
        assert!(s.turn_list.get_head().is_none());
        assert!(s.sidestep_list.get_head().is_none());
        assert!(
            s.transient_state,
            "ClearAllCommands leaves the wedge (retail: no reset, P02 OQ4)"
        );
    }
}
