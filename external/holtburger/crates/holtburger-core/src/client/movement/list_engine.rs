//! Movement-port WAVE 1 / P01 (2026-07-03) — the input command **list
//! engine**: the three-list holder the `CommandInterpreter` (P02-P08) is
//! built on.
//!
//! Retail models each of the interpreter's three input channels
//! (`SubstateList`, `TurnList`, `SidestepList`,
//! `acclient.h:35340-35342`) as a `CommandList`: a hand-rolled doubly
//! linked stack of `CommandListElement` nodes with a separate
//! `mouse_command` pointer singling out the at-most-one mouse-sourced
//! element (`acclient.h:35328-35333`, `:35441-35448`). New commands push
//! at the HEAD, so `GetHead` is always the most-recently-asserted command
//! for that channel; the physics tick reads the head of each list to build
//! the raw movement (see `super::raw_state` / P02 `BookkeepCommand…`).
//!
//! ENCODING NOTE (P01 OQ4): retail stores the mouse identity as a
//! `mouse_command` *pointer* into the node list. Rust-safely and with
//! no `unsafe`/deps, we encode the same list as a `VecDeque` with FRONT ==
//! retail `head`, and encode the `mouse_command` pointer identity as a
//! per-node `is_mouse` flag. This is a re-encoding of retail state, not new
//! behavioral state: there is still at most one mouse node, it is
//! still moved to head on every mouse `AddCommand`, and `HeadIsMouse` is
//! still "the front node is the mouse node". The public method contract is
//! byte-identical to the pointer port.
//!
//! DIRECTION NAMES (ADJ-1/SC-1): the fan-out packet declared all four
//! turn/sidestep constant names FLIPPED (0x0D as "TurnLeft" etc.); retail's
//! own `command_strings` table (acclient.c:43468-43471) and ACE
//! `MotionCommand.cs:20-23` fix 0x0D=TurnRight, 0x0E=TurnLeft,
//! 0x0F=SideStepRight, 0x10=SideStepLeft. This landing uses the CORRECT
//! names via the crate's existing `MOTION_*` consts (motion_interp.rs) —
//! the numeric routing/logic below was already correct in the packet.
//!
//! All cites are `~/ac-headers/acclient.c` unless noted; the two
//! entrypoints (`WhichList`, `ApplyHoldKeysToCommand`) were cross-checked
//! against the Binja name-resolver dump (same binary — ADJ-5).

use super::motion_interp::{
    MOTION_SIDESTEP_LEFT, MOTION_SIDESTEP_RIGHT, MOTION_TURN_LEFT, MOTION_TURN_RIGHT,
};
use std::collections::VecDeque;

/// Bit set by every 0x40000000-class motion command; `WhichList` requires
/// it (with [`SUBSTATE_FLAG`]) to route to `SubstateList`
/// (`acclient.c:717418`).
#[allow(dead_code)] // staged: routing mask (step-3 interpreter + command_stacks)
pub(crate) const MOVEMENT_FLAG: u32 = 0x4000_0000;
/// Bit distinguishing a *held* substate (forward/backward/run) command from
/// a bare transient one; `SubstateList` requires it too
/// (`acclient.c:717420`).
#[allow(dead_code)] // staged: routing mask (step-3 interpreter + command_stacks)
pub(crate) const SUBSTATE_FLAG: u32 = 0x0400_0000;

/// Retail `CommandListElement` default speed — the ctor writes
/// `1065353216` == `1.0f` into the speed slot before `AddCommand`
/// overwrites it (`acclient.c:718525`). Dead in practice (P01 OQ2).
#[allow(dead_code)] // retail-parity documentation constant
pub(crate) const DEFAULT_SPEED: f32 = 1.0;

// ---- element / list -----------------------------------------------------

/// One queued input command. Retail layout `acclient.h:35441-35448`
/// (`next`/`prev` pointers dropped in favour of the `VecDeque` ordering;
/// see module ENCODING NOTE):
/// - `command`  — retail `CommandListElement::command`  (u32, off +8)
/// - `speed`    — retail `CommandListElement::speed`    (f32, off +12)
/// - `hold_run` — retail `CommandListElement::hold_run` (i32, off +16)
///   (per-element snapshot of the hold-run modifier at press time;
///   retail's `new_hold_run` is the call-site param name only — SC-5)
/// - `is_mouse` — ENCODES retail `list->mouse_command == this` identity
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CommandListElement {
    pub(crate) command: u32,
    pub(crate) speed: f32,
    pub(crate) hold_run: i32,
    pub(crate) is_mouse: bool,
}

/// Retail `CommandList` (`acclient.h:35328-35333`). Front of `elements`
/// is retail `head`; `mouse_command` is encoded via `is_mouse`; `current`
/// is carried for field-parity only.
#[derive(Debug, Default)]
pub(crate) struct CommandList {
    /// FRONT == retail `head`; push_front == retail head insertion.
    elements: VecDeque<CommandListElement>,
    /// Retail `CommandList::current` (`acclient.h:35332`). Across the entire
    /// ported surface it is ONLY zeroed by the interpreter ctor
    /// (`acclient.c:717742/717745/717748`) and never read — a dead iterator
    /// cursor. Carried for field-parity, `// UNKNOWN-USE`.
    #[allow(dead_code)]
    current: Option<usize>,
}

impl CommandList {
    #[allow(dead_code)] // staged: step-3 interpreter ctor
    pub(crate) fn new() -> Self {
        Self {
            elements: VecDeque::new(),
            current: None,
        }
    }

    /// Index of the single mouse node, if present — the safe analogue of
    /// dereferencing retail `mouse_command`.
    fn mouse_index(&self) -> Option<usize> {
        self.elements.iter().position(|e| e.is_mouse)
    }

    /// `CommandList::AddCommand` — `acclient.c:718508`.
    /// Always inserts at head. For a mouse command, the prior mouse node is
    /// first unlinked+freed (retail LABEL_12/LABEL_14 dance,
    /// `:718535-718567`) so there is only ever one, and it lands at head.
    pub(crate) fn add_command(&mut self, command: u32, speed: f32, mouse: bool, hold_run: i32) {
        if mouse {
            if let Some(i) = self.mouse_index() {
                self.elements.remove(i); // replace the existing mouse node
            }
        }
        self.elements.push_front(CommandListElement {
            command,
            speed,
            hold_run,
            is_mouse: mouse,
        });
    }

    /// `CommandList::RemoveCommand` — `acclient.c:718295`.
    /// - `mouse == true`: remove THE mouse node (retail ignores `command`
    ///   here, `:718346`); returns whether it was the head.
    /// - `mouse == false`: remove the first head-ward node whose `command`
    ///   matches AND that is not the mouse node (retail loop guard
    ///   `v12->command != command || v12 == mouse_command`, `:718315`);
    ///   returns whether that node was the head.
    /// - not found → `false`.
    ///
    /// `speed` is accepted for retail-parity but UNREAD in the retail body
    /// (P01 OQ1).
    pub(crate) fn remove_command(&mut self, command: u32, _speed: f32, mouse: bool) -> bool {
        let idx = if mouse {
            self.mouse_index()
        } else {
            self.elements
                .iter()
                .position(|e| e.command == command && !e.is_mouse)
        };
        match idx {
            Some(i) => {
                let was_head = i == 0;
                self.elements.remove(i);
                was_head
            }
            None => false,
        }
    }

    /// `CommandList::GetHead` — `acclient.c:718375` (retail returns the head
    /// element pointer; the decompile aliases the type to `ChatDisplayInfo`
    /// and reads `m_ltt`, which is offset 0 == `head`). `None` == retail
    /// null head.
    pub(crate) fn get_head(&self) -> Option<&CommandListElement> {
        self.elements.front()
    }

    /// `CommandList::HeadIsMouse` — `acclient.c:718381`. True iff there is a
    /// head and it is the mouse node.
    pub(crate) fn head_is_mouse(&self) -> bool {
        self.elements.front().is_some_and(|e| e.is_mouse)
    }

    /// `CommandList::ClearAllCommands` — `acclient.c:718393`. Frees every
    /// node and drops `mouse_command`. (Retail's node-walk is just a
    /// destructor loop; NB ACE's port of this is mis-decompiled — P01 OQ8.
    /// Decomp is authoritative.)
    pub(crate) fn clear_all_commands(&mut self) {
        self.elements.clear();
    }

    /// `CommandList::ClearKeyboardCommands` — `acclient.c:718435`. Removes
    /// every non-mouse node, keeping the single mouse node. The
    /// interpreter-level `ClearKeyboardCommands` fans this over the
    /// three lists (`acclient.c:716875-716877`).
    #[allow(dead_code)] // staged: interpreter-level ClearKeyboardCommands fan-out (step 3)
    pub(crate) fn clear_keyboard_commands(&mut self) {
        self.elements.retain(|e| e.is_mouse);
    }

    /// Test/introspection helper — head-ward node order (front == head).
    #[cfg(test)]
    fn snapshot(&self) -> Vec<CommandListElement> {
        self.elements.iter().copied().collect()
    }
}

// ---- three-list holder + routing ----------------------------------------

/// Which of the interpreter's three `CommandList`s a command routes to.
/// (SC-8: the ONE surviving axis/list enum — P02's `ListId`, P04's second
/// `ListKind`, P06's `CommandListId` and P08's `WhichList` all folded
/// here.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ListKind {
    /// `SubstateList` — forward/backward/run held locomotion (0x40000000 +
    /// 0x04000000 class).
    Substate,
    /// `TurnList` — TurnRight/TurnLeft.
    Turn,
    /// `SidestepList` — SideStepRight/SideStepLeft.
    Sidestep,
}

/// The three-list holder — the shape P02-P08 build the `CommandInterpreter`
/// around (retail fields `SubstateList`/`TurnList`/`SidestepList`,
/// `acclient.h:35340-35342`, kept in retail order).
#[derive(Debug, Default)]
pub(crate) struct CommandLists {
    pub(crate) substate: CommandList,
    pub(crate) turn: CommandList,
    pub(crate) sidestep: CommandList,
}

impl CommandLists {
    #[allow(dead_code)] // staged: step-3 interpreter ctor
    pub(crate) fn new() -> Self {
        Self {
            substate: CommandList::new(),
            turn: CommandList::new(),
            sidestep: CommandList::new(),
        }
    }

    #[allow(dead_code)] // symmetric accessor (list_mut is the hot one)
    pub(crate) fn list(&self, kind: ListKind) -> &CommandList {
        match kind {
            ListKind::Substate => &self.substate,
            ListKind::Turn => &self.turn,
            ListKind::Sidestep => &self.sidestep,
        }
    }

    #[allow(dead_code)] // staged: step-3 interpreter routing
    pub(crate) fn list_mut(&mut self, kind: ListKind) -> &mut CommandList {
        match kind {
            ListKind::Substate => &mut self.substate,
            ListKind::Turn => &mut self.turn,
            ListKind::Sidestep => &mut self.sidestep,
        }
    }
}

/// `CommandInterpreter::WhichList` — `acclient.c:717402` (flat vtable
/// slot 3; dispatched at `AddCommand:717435`/`NukeCommand:717467`).
/// Returns the target list for `cmd`, or `None` for bare/transient
/// commands (handled by the interpreter's `AddCommand` else-arm).
///
/// ORDER MATTERS: 0x6500000D-0x65000010 already carry both `MOVEMENT_FLAG`
/// and `SUBSTATE_FLAG` (top byte 0x65 & 0x40 & 0x04 != 0), so the explicit
/// turn/sidestep arms MUST precede the substate bitmask fallthrough — this
/// mirrors the retail switch dispatching those four cases before `default`.
pub(crate) fn which_list(cmd: u32) -> Option<ListKind> {
    match cmd {
        MOTION_TURN_RIGHT | MOTION_TURN_LEFT => Some(ListKind::Turn),
        MOTION_SIDESTEP_RIGHT | MOTION_SIDESTEP_LEFT => Some(ListKind::Sidestep),
        _ if cmd & MOVEMENT_FLAG != 0 && cmd & SUBSTATE_FLAG != 0 => Some(ListKind::Substate),
        _ => None,
    }
}

/// `CommandInterpreter::ApplyHoldKeysToCommand` — `acclient.c:716962`
/// (flat vtable slot 13). When hold-sidestep is latched, rewrites a TURN
/// command into the matching SIDESTEP command IN PLACE — decomp
/// `:717005-717016`: `0x6500000D → 0x6500000F` (TurnRight→SideStepRight),
/// `0x6500000E → 0x65000010` (TurnLeft→SideStepLeft); otherwise a no-op.
/// The `speed` out-param is accepted for retail-parity but UNREAD in the
/// retail body (P01 OQ1).
///
/// SEAM: retail reads `this->hold_sidestep` (`acclient.h:35346`); that flag
/// is owned by the interpreter (P06 `SetHoldSidestep`). Passed in explicitly
/// so this stays a pure function callable before `WhichList`/`AddCommand`.
#[allow(dead_code)] // staged: step-3 interpreter (HandleKeyboardCommand pre-transform)
pub(crate) fn apply_hold_keys_to_command(cmd: &mut u32, _speed: &mut f32, hold_sidestep: bool) {
    if hold_sidestep {
        match *cmd {
            MOTION_TURN_RIGHT => *cmd = MOTION_SIDESTEP_RIGHT,
            MOTION_TURN_LEFT => *cmd = MOTION_SIDESTEP_LEFT,
            _ => {}
        }
    }
}

// -------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::movement::motion_interp::MOTION_READY;

    fn kb(cmd: u32, speed: f32, hold: i32) -> CommandListElement {
        CommandListElement {
            command: cmd,
            speed,
            hold_run: hold,
            is_mouse: false,
        }
    }

    // ---- WhichList dispatch selection (every arm) ----
    #[test]
    fn which_list_routes_turn_sidestep_substate_and_none() {
        assert_eq!(which_list(MOTION_TURN_RIGHT), Some(ListKind::Turn));
        assert_eq!(which_list(MOTION_TURN_LEFT), Some(ListKind::Turn));
        assert_eq!(which_list(MOTION_SIDESTEP_RIGHT), Some(ListKind::Sidestep));
        assert_eq!(which_list(MOTION_SIDESTEP_LEFT), Some(ListKind::Sidestep));
        // held substate: both flags set, not a turn/sidestep literal.
        assert_eq!(
            which_list(MOVEMENT_FLAG | SUBSTATE_FLAG | 0x1),
            Some(ListKind::Substate)
        );
        // bare transient: MOVEMENT_FLAG only -> no list (interpreter arms
        // transient_state instead).
        assert_eq!(which_list(MOVEMENT_FLAG | 0x1), None);
        assert_eq!(which_list(MOTION_READY), None); // 0x41000003: movement flag, no substate flag
        assert_eq!(which_list(0), None);
    }

    #[test]
    fn which_list_turn_ids_take_precedence_over_substate_bitmask() {
        // 0x65 top byte carries BOTH flags; must still route to Turn, not Substate.
        assert_ne!(MOTION_TURN_RIGHT & MOVEMENT_FLAG, 0);
        assert_ne!(MOTION_TURN_RIGHT & SUBSTATE_FLAG, 0);
        assert_eq!(which_list(MOTION_TURN_RIGHT), Some(ListKind::Turn));
    }

    // ---- ApplyHoldKeysToCommand mapping (numerics: 0x0D→0x0F, 0x0E→0x10,
    //      decomp :717005-717016; names per ADJ-1) ----
    #[test]
    fn apply_hold_keys_maps_turn_to_sidestep_only_when_latched() {
        let mut s = 1.0f32;
        let mut c = MOTION_TURN_RIGHT;
        apply_hold_keys_to_command(&mut c, &mut s, true);
        assert_eq!(c, MOTION_SIDESTEP_RIGHT); // 0x0D → 0x0F
        c = MOTION_TURN_LEFT;
        apply_hold_keys_to_command(&mut c, &mut s, true);
        assert_eq!(c, MOTION_SIDESTEP_LEFT); // 0x0E → 0x10
        // not latched -> untouched
        c = MOTION_TURN_RIGHT;
        apply_hold_keys_to_command(&mut c, &mut s, false);
        assert_eq!(c, MOTION_TURN_RIGHT);
        // non-turn command -> untouched even when latched
        c = MOTION_READY;
        apply_hold_keys_to_command(&mut c, &mut s, true);
        assert_eq!(c, MOTION_READY);
        assert_eq!(s, 1.0); // speed out-param never written
    }

    // ---- keyboard stack: head == most recent ----
    #[test]
    fn add_pushes_at_head() {
        let mut l = CommandList::new();
        l.add_command(0xA, 1.0, false, 0);
        l.add_command(0xB, 2.0, false, 1);
        assert_eq!(l.get_head().unwrap().command, 0xB);
        assert_eq!(l.get_head().unwrap().speed, 2.0);
        assert_eq!(l.get_head().unwrap().hold_run, 1);
        assert_eq!(l.snapshot(), vec![kb(0xB, 2.0, 1), kb(0xA, 1.0, 0)]);
        assert!(!l.head_is_mouse());
    }

    // ---- mouse: single element, moved to head, HeadIsMouse toggling ----
    #[test]
    fn mouse_is_single_and_lands_at_head() {
        let mut l = CommandList::new();
        l.add_command(0xA, 1.0, true, 0);
        assert!(l.head_is_mouse());
        // re-asserting a mouse command replaces (does not duplicate) it
        l.add_command(0xB, 3.0, true, 0);
        assert_eq!(l.snapshot().iter().filter(|e| e.is_mouse).count(), 1);
        assert_eq!(l.get_head().unwrap().command, 0xB);
        assert!(l.head_is_mouse());
        // a keyboard press then buries the mouse node -> HeadIsMouse flips off
        l.add_command(0xC, 1.0, false, 0);
        assert!(!l.head_is_mouse());
        assert_eq!(l.get_head().unwrap().command, 0xC);
    }

    // ---- RemoveCommand: was-head return, keyboard match, mouse skip ----
    // (Fixture corrected at integration: the packet removed the head 0xB
    // first, which PROMOTED 0xA to head — its "was not head" assert was
    // self-defeating. Three elements make the non-head case real.)
    #[test]
    fn remove_keyboard_reports_was_head_and_skips_mouse() {
        let mut l = CommandList::new();
        l.add_command(0xA, 1.0, false, 0); // tail
        l.add_command(0xB, 1.0, false, 0); // middle
        l.add_command(0xC, 1.0, false, 0); // head
        assert!(l.remove_command(0xC, 0.0, false)); // removed the head
        assert!(!l.remove_command(0xA, 0.0, false)); // removed the TAIL (0xB is head now)
        assert!(!l.remove_command(0x99, 0.0, false)); // not found
        assert_eq!(l.get_head().unwrap().command, 0xB, "0xB drives");
    }

    #[test]
    fn remove_keyboard_does_not_take_the_mouse_node_even_on_command_match() {
        let mut l = CommandList::new();
        l.add_command(0xA, 1.0, true, 0); // mouse node, command 0xA
        // keyboard remove of 0xA must NOT consume the mouse node
        assert!(!l.remove_command(0xA, 0.0, false));
        assert_eq!(l.snapshot().len(), 1);
        assert!(l.head_is_mouse());
        // mouse remove ignores the command arg and drops the mouse node
        assert!(l.remove_command(0x0, 0.0, true));
        assert!(l.get_head().is_none());
        // removing from empty -> false
        assert!(!l.remove_command(0x0, 0.0, true));
    }

    #[test]
    fn remove_mouse_reports_was_head() {
        let mut l = CommandList::new();
        l.add_command(0xA, 1.0, true, 0); // mouse at head
        l.add_command(0xB, 1.0, false, 0); // keyboard now at head, mouse buried
        assert!(!l.remove_command(0x0, 0.0, true)); // mouse removed, was NOT head
        l.add_command(0xC, 1.0, true, 0); // mouse at head again
        assert!(l.remove_command(0x0, 0.0, true)); // mouse removed, WAS head
    }

    // ---- clear variants ----
    #[test]
    fn clear_keyboard_keeps_the_mouse_node() {
        let mut l = CommandList::new();
        l.add_command(0xA, 1.0, false, 0);
        l.add_command(0xB, 1.0, true, 0);
        l.add_command(0xC, 1.0, false, 0);
        l.clear_keyboard_commands();
        assert_eq!(l.snapshot(), vec![kb_mouse(0xB)]);
        l.clear_all_commands();
        assert!(l.get_head().is_none());
    }

    fn kb_mouse(cmd: u32) -> CommandListElement {
        CommandListElement {
            command: cmd,
            speed: 1.0,
            hold_run: 0,
            is_mouse: true,
        }
    }

    // ---- holder routing ----
    #[test]
    fn holder_routes_add_via_which_list() {
        let mut lists = CommandLists::new();
        for &c in &[
            MOTION_TURN_RIGHT,
            MOTION_SIDESTEP_LEFT,
            MOVEMENT_FLAG | SUBSTATE_FLAG | 1,
        ] {
            let kind = which_list(c).unwrap();
            lists.list_mut(kind).add_command(c, 1.0, false, 0);
        }
        assert_eq!(lists.turn.get_head().unwrap().command, MOTION_TURN_RIGHT);
        assert_eq!(
            lists.sidestep.get_head().unwrap().command,
            MOTION_SIDESTEP_LEFT
        );
        assert!(lists.substate.get_head().is_some());
    }
}
