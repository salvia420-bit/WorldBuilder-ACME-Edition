//! Unified movement pipeline STAGE 2 — A4-Q1 (2026-06-11 unification
//! survey): the retail `MotionTableManager` pending-animation queue, the
//! completion layer specced ONCE in
//! `docs/2026-06-11-unified-movement-pipeline/DESIGN.md`
//! "STAGE 2 AMENDMENT" (A3-D1 fold — do not re-spec it elsewhere).
//!
//! Retail truth: `MotionTableManager { physics_obj, table, state,
//! animation_counter, DLList<AnimNode> pending_animations }`
//! (`~/ac-headers/acclient.h:31097-31104`); bodies
//! `~/ac-headers/acclient.c:329842-330260`. ACE 1:1 cross-ref:
//! `Physics/Managers/MotionTableManager.cs` (PendingAnimations :13,
//! AnimationDone :28, CheckForCompletedMotions :63) and
//! `Physics/Animation/AnimNode.cs` / `MotionState.cs`.
//!
//! Seam contract (DESIGN.md amendment / ROADMAP §2): **A4 owns WHO fires
//! completion** (this queue: `num_anims` accounting, spam coalescing via
//! `remove_redundant_links`/`truncate_animation_list`); **A3 owns what
//! completion DOES** (`motion_interp.motion_done`, the A3-D2 consumer of
//! the [`MotionTableEvent::MotionDone`] events emitted here). The
//! renderer `AnimationDone` wiring (`notifyAnimationDone` export,
//! `?mtQueue=`) is A4-Q2; the CMotionTable SELECTION calls retail makes
//! around this queue (`DoObjectMotion`/`StopObjectMotion`/
//! `StopObjectCompletely`/`SetDefaultState`, `acclient.c:330206-330245`,
//! `:330172-330200`) stay scope-gated to the Stage-2
//! `motion_sequence.rs` port (T9) — the queue-entry arms are exposed
//! here as `queue_*` so the queueing semantics (motion vs Ready
//! `0x41000003`) are pinned now.
//!
//! Retail has no `CSequence` here in headless Rust: the side effects it
//! receives (`remove_link_animations` /
//! `remove_all_link_animations`) and the `CPhysicsObj::MotionDone`
//! fan-out (`acclient.c:317097` → `MovementManager::MotionDone`
//! `:339349`) are emitted as [`MotionTableEvent`]s drained by the owner
//! (`movement/system.rs` tick under `USE_MOTION_TABLE_QUEUE`,
//! default-off — queue inert, current paths untouched).

use std::collections::VecDeque;

/// Retail MotionCommand class bits (`CommandMask`, ACE
/// `ACE.Entity/Enum/CommandMasks.cs:6-17`; same masks tested inline by
/// retail at `acclient.c:330099`, `:330122`, `:329891`).
pub(crate) const COMMAND_MASK_STYLE: u32 = 0x8000_0000;
pub(crate) const COMMAND_MASK_SUBSTATE: u32 = 0x4000_0000;
pub(crate) const COMMAND_MASK_MODIFIER: u32 = 0x2000_0000;
pub(crate) const COMMAND_MASK_ACTION: u32 = 0x1000_0000;

/// `Motion_Ready` (`0x41000003` = 1090519043) — the completion node
/// retail queues for every Stop/StopCompletely and for the default
/// state (`acclient.c:330235-330245`, `:330172-330200`; ACE
/// `MotionTableManager.cs:134-140`, `MotionCommand.Ready`). Same value
/// as `holtburger-world` `player/types.rs` `READY`.
pub(crate) const MOTION_READY: u32 = 0x4100_0003;

/// One pending-animation queue node — retail `MotionTableManager::
/// AnimNode` (`acclient.h:31097-31104`; allocated 0x10 bytes with
/// `{motion, num_anims}` at `node[1]`, `acclient.c:330155-330161`).
/// ACE `Physics/Animation/AnimNode.cs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AnimNode {
    pub motion: u32,
    pub num_anims: u32,
}

/// Side effects the queue fires — retail calls these directly on
/// `CPhysicsObj`/`CSequence`; headless Rust emits them for the owner to
/// route (DESIGN.md STAGE 2 AMENDMENT fan-out diagram).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MotionTableEvent {
    /// `CPhysicsObj::MotionDone(motion, success)`
    /// (`acclient.c:329894`, `:329978`; fan-out `:317097` →
    /// `MovementManager::MotionDone` `:339349`). Consumer: A3-D2's
    /// `motion_interp.motion_done` (`acclient.c:343641-343676`).
    MotionDone { motion: u32, success: bool },
    /// `CSequence::remove_link_animations(seq, num_anims)` — drop the
    /// not-yet-played transition anims of truncated queue nodes
    /// (`acclient.c:329856`/`:329842` truncate_animation_list; ACE
    /// `MotionTableManager.cs:248`). Renderer wiring is A4-Q2.
    RemoveLinkAnimations { num_anims: u32 },
    /// `CSequence::remove_all_link_animations` — `HandleEnterWorld`
    /// cancels pending one-shots across enter-world
    /// (`acclient.c:329949-329957`; ACE `MotionTableManager.cs:103`).
    RemoveAllLinkAnimations,
}

/// Minimal runtime `MotionState` — retail
/// `MotionState { style, substate, substate_mod, modifier_head,
/// action_head, action_tail }` (`acclient.h:31081-31089`; ctor zeroes
/// style/substate, `substate_mod = 1.0`, empty lists,
/// `acclient.c:341303-341311`; ACE `Physics/Animation/MotionState.cs`).
/// Q1 ports only what the queue touches: the action list
/// (`remove_action_head`). The modifier LIFO stays with the Stage-2
/// selection port (`motion_sequence.rs` reuses the existing
/// `MotionModifierStack`, `holtburger-world` `state/self_movement.rs:137-216`
/// — DESIGN.md §1: don't duplicate).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MotionState {
    // STAGED (Stage-2 selection port `motion_sequence.rs` reads these —
    // `CMotionTable::GetObjectSequence` style/substate resolution,
    // `acclient.c:337641`): written here for struct fidelity, consumed
    // from tests only in Q1, hence `allow(dead_code)`.
    #[allow(dead_code)]
    pub style: u32,
    #[allow(dead_code)]
    pub substate: u32,
    #[allow(dead_code)]
    pub substate_mod: f32,
    /// `(motion, speed_mod)` FIFO — retail `action_head`/`action_tail`
    /// `MotionList` (`acclient.h:31087-31088`); ACE
    /// `MotionState.Actions`.
    pub actions: VecDeque<(u32, f32)>,
}

impl Default for MotionState {
    /// `MotionState::MotionState` (`acclient.c:341303-341311`; ACE
    /// `MotionState.cs:14-19`).
    fn default() -> Self {
        Self {
            style: 0,
            substate: 0,
            substate_mod: 1.0,
            actions: VecDeque::new(),
        }
    }
}

impl MotionState {
    /// `MotionState::add_action` (`acclient.c` decl `:6982`; queued by
    /// `CMotionTable::GetObjectSequence` for action-class motions,
    /// `:337851`/`:337895`; ACE `MotionState.cs:37-40`).
    // STAGED: the in-tree caller is the Stage-2 selection port
    // (`GetObjectSequence`); seeded from tests only in Q1.
    #[allow(dead_code)]
    pub(crate) fn add_action(&mut self, action: u32, speed_mod: f32) {
        self.actions.push_back((action, speed_mod));
    }

    /// `MotionState::remove_action_head` — pop the head action,
    /// returning its motion id (0 when empty)
    /// (`acclient.c:341420-341440`; ACE `MotionState.cs:70-74`).
    pub(crate) fn remove_action_head(&mut self) -> u32 {
        self.actions.pop_front().map(|(motion, _)| motion).unwrap_or(0)
    }
}

/// The faithful `MotionTableManager` queue port (A4-Q1). Per-entity in
/// Stage 3 (DESIGN.md STAGE 3 AMENDMENT: per-entity instances, no
/// globals); the local player's instance lives on `MovementSystem`.
#[derive(Debug, Default)]
pub(crate) struct MotionTableManager {
    /// `MotionTableManager::state` (`acclient.h:31100`).
    pub(crate) state: MotionState,
    /// `MotionTableManager::animation_counter` (`acclient.h:31102`) —
    /// how many renderer `AnimationDone` signals have arrived and not
    /// yet been consumed by a queue pop.
    animation_counter: u32,
    /// `MotionTableManager::pending_animations`
    /// (`acclient.h:31103`) — head = oldest.
    pending_animations: VecDeque<AnimNode>,
    /// Emitted side effects (see [`MotionTableEvent`]), drained by the
    /// owner each pump.
    events: Vec<MotionTableEvent>,
}

impl MotionTableManager {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Drain the emitted side effects. The A3-D2 consumer routes
    /// `MotionDone` into `motion_interp.motion_done`; until it lands the
    /// `movement/system.rs` pump drains-and-drops (flag default-off, so
    /// nothing enqueues either).
    pub(crate) fn drain_events(&mut self) -> Vec<MotionTableEvent> {
        std::mem::take(&mut self.events)
    }

    /// `MotionTableManager::add_to_queue(motion, num_anims, seq)` —
    /// append an [`AnimNode`] then coalesce
    /// (`acclient.c:330149-330169`; ACE `MotionTableManager.cs:163-167`).
    pub(crate) fn add_to_queue(&mut self, motion: u32, num_anims: u32) {
        self.pending_animations.push_back(AnimNode { motion, num_anims });
        self.remove_redundant_links();
    }

    /// `MotionTableManager::PerformMovement` type-2 (DoObjectMotion)
    /// success arm: queue the motion itself
    /// (`acclient.c:330221-330228`; ACE `MotionTableManager.cs:123-128`
    /// `MovementType.InterpretedCommand`). The `DoObjectMotion`
    /// selection call that produces `num_anims` (and the
    /// disallowed-motion error 67, `:330231`) is the Stage-2
    /// `motion_sequence.rs` seam.
    // STAGED: caller is A3-D2's PerformMovement dispatch
    // (`acclient.c:344670-344720`); exercised from tests in Q1.
    #[allow(dead_code)]
    pub(crate) fn queue_object_motion(&mut self, motion: u32, num_anims: u32) {
        self.add_to_queue(motion, num_anims);
    }

    /// `PerformMovement` type-4 (StopObjectMotion) arm: every stop
    /// queues a Ready (`0x41000003`) completion node — stop completion
    /// is observable, not display-only (`acclient.c:330233-330238`; ACE
    /// `MotionTableManager.cs:130-135`).
    // STAGED: see `queue_object_motion`.
    #[allow(dead_code)]
    pub(crate) fn queue_object_motion_stop(&mut self, num_anims: u32) {
        self.add_to_queue(MOTION_READY, num_anims);
    }

    /// `PerformMovement` type-5 (StopObjectCompletely) arm — also a
    /// Ready node (`acclient.c:330240-330245`; ACE
    /// `MotionTableManager.cs:137-140`).
    // STAGED: see `queue_object_motion`.
    #[allow(dead_code)]
    pub(crate) fn queue_stop_completely(&mut self, num_anims: u32) {
        self.add_to_queue(MOTION_READY, num_anims);
    }

    /// `MotionTableManager::initialize_state` — `SetDefaultState` then
    /// queue a Ready node with the returned `num_anims`, so even the
    /// default state completes through the queue
    /// (`acclient.c:330172-330200`; ACE `MotionTableManager.cs:169-177`).
    /// The `CMotionTable::SetDefaultState` half is the Stage-2 selection
    /// seam — the caller supplies its `num_anims` out-param (0 when no
    /// table, `:330185`).
    // STAGED: caller is A3-D2's `enter_default_state`
    // (`acclient.c:344560-344598`, DESIGN.md amendment Ready-seed).
    #[allow(dead_code)]
    pub(crate) fn initialize_state(&mut self, default_state_num_anims: u32) {
        self.add_to_queue(MOTION_READY, default_state_num_anims);
    }

    /// `MotionTableManager::remove_redundant_links` — retail's
    /// anti-backlog under input spam (`acclient.c:330079-330147`; ACE
    /// `MotionTableManager.cs:179-203` — NOTE: ACE generalized this to
    /// an outer loop over every non-zero node; retail considers ONLY the
    /// last node with `num_anims != 0`, then returns. We port retail.)
    ///
    /// Shape: skip zero-anim tail nodes; classify the last non-zero
    /// node; walk backward looking for an earlier duplicate of the same
    /// motion; truncate everything after the duplicate. The substate
    /// search (`0x40000000` set, `0x20000000` clear) requires the
    /// duplicate itself to have `num_anims != 0` and is blocked by
    /// non-zero nodes with any of `0xB0000000`
    /// (style/modifier/action); the style search (sign bit) matches the
    /// duplicate regardless of its `num_anims` and is blocked by
    /// non-zero nodes with any of `0x70000000`
    /// (substate/modifier/action).
    fn remove_redundant_links(&mut self) {
        // `while (!v2[1].dllist_prev) v2 = v2->dllist_prev;`
        // (`acclient.c:330091-330096`): last node with anims pending.
        let Some(candidate) = self
            .pending_animations
            .iter()
            .rposition(|node| node.num_anims != 0)
        else {
            return;
        };
        let motion = self.pending_animations[candidate].motion;

        if motion & COMMAND_MASK_SUBSTATE != 0 && motion & COMMAND_MASK_MODIFIER == 0 {
            // Substate-class search (`acclient.c:330099-330121`).
            for i in (0..candidate).rev() {
                let prev = self.pending_animations[i];
                if prev.motion == motion && prev.num_anims != 0 {
                    self.truncate_animation_list(i);
                    return;
                }
                if prev.num_anims != 0
                    && prev.motion
                        & (COMMAND_MASK_STYLE | COMMAND_MASK_MODIFIER | COMMAND_MASK_ACTION)
                        != 0
                {
                    return;
                }
            }
        } else if motion & COMMAND_MASK_STYLE != 0 {
            // Style-class search (`acclient.c:330122-330141`).
            for i in (0..candidate).rev() {
                let prev = self.pending_animations[i];
                if prev.motion == motion {
                    self.truncate_animation_list(i);
                    return;
                }
                if prev.num_anims != 0
                    && prev.motion
                        & (COMMAND_MASK_SUBSTATE | COMMAND_MASK_MODIFIER | COMMAND_MASK_ACTION)
                        != 0
                {
                    return;
                }
            }
        }
    }

    /// `MotionTableManager::truncate_animation_list(node, seq)` — zero
    /// the `num_anims` of every node AFTER the duplicate (summing them)
    /// and emit `remove_link_animations(sum)` so the not-yet-played
    /// transition anims are dropped (`acclient.c:329842-329870`; ACE
    /// `MotionTableManager.cs:233-249`). The zeroed nodes then complete
    /// through [`Self::check_for_completed_motions`].
    fn truncate_animation_list(&mut self, duplicate_index: usize) {
        let mut total = 0u32;
        for node in self.pending_animations.iter_mut().skip(duplicate_index + 1) {
            total += node.num_anims;
            node.num_anims = 0;
        }
        // Retail emits even when the sum is 0 (`tail == node` arm,
        // `acclient.c:329853-329856`).
        self.events
            .push(MotionTableEvent::RemoveLinkAnimations { num_anims: total });
    }

    /// `MotionTableManager::AnimationDone(success)` — one renderer
    /// anim-done signal: bump `animation_counter`, then pop every head
    /// node whose `num_anims <= animation_counter`, firing `MotionDone`
    /// (action-bit motions pop `remove_action_head` first) and
    /// decrementing the counter by each popped node's `num_anims`;
    /// reset the counter to 0 when the queue drains
    /// (`acclient.c:329873-329937`; ACE `MotionTableManager.cs:28-61`).
    /// Reached in retail from the renderer:
    /// `AnimDoneHook::Execute` (`:342336`) →
    /// `CPhysicsObj::Hook_AnimDone` (`:317087`) →
    /// `CPartArray::AnimationDone` (`:325080`) → here. A4-Q2 wires the
    /// `notifyAnimationDone` export to this.
    pub(crate) fn animation_done(&mut self, success: bool) {
        if self.pending_animations.is_empty() {
            // Retail no-ops (counter NOT incremented) when nothing is
            // pending (`acclient.c:329884` head-null guard).
            return;
        }
        self.animation_counter += 1;
        while let Some(head) = self.pending_animations.front().copied() {
            if head.num_anims > self.animation_counter {
                break;
            }
            if head.motion & COMMAND_MASK_ACTION != 0 {
                // `MotionState::remove_action_head`
                // (`acclient.c:329891-329893`).
                self.state.remove_action_head();
            }
            self.events.push(MotionTableEvent::MotionDone {
                motion: head.motion,
                success,
            });
            self.animation_counter -= head.num_anims;
            self.pending_animations.pop_front();
        }
        // `if (counter && !head) counter = 0;`
        // (`acclient.c:329931-329936`).
        if self.pending_animations.is_empty() {
            self.animation_counter = 0;
        }
    }

    /// `MotionTableManager::CheckForCompletedMotions` — pop ONLY
    /// zero-anim head nodes, firing `MotionDone(motion, success=1)`:
    /// how anim-free motions (modifiers, instant stops, truncated
    /// backlog) complete (`acclient.c:329960-330020`; ACE
    /// `MotionTableManager.cs:63-86`). The `animation_counter` is NOT
    /// touched here.
    pub(crate) fn check_for_completed_motions(&mut self) {
        while let Some(head) = self.pending_animations.front().copied() {
            if head.num_anims != 0 {
                break;
            }
            if head.motion & COMMAND_MASK_ACTION != 0 {
                self.state.remove_action_head();
            }
            self.events.push(MotionTableEvent::MotionDone {
                motion: head.motion,
                success: true,
            });
            self.pending_animations.pop_front();
        }
    }

    /// `MotionTableManager::UseTime` — a tailcall to
    /// [`Self::check_for_completed_motions`] (BN pseudo-C
    /// `acclient_2013.bndb_pseudo_c.txt:290845-290850`; ACE
    /// `MotionTableManager.cs:158-161`), reached per-frame via
    /// `CPhysicsObj::update_object_internal` →
    /// `CPartArray::HandleMovement` (`acclient.c:322882` →
    /// `:325106-325112`).
    pub(crate) fn use_time(&mut self) {
        self.check_for_completed_motions();
    }

    /// `MotionTableManager::HandleExitWorld` — drain the queue through
    /// `AnimationDone(success=0)`: pending one-shots are cancelled, not
    /// played, across exit-world (`acclient.c:329940-329947`; ACE
    /// `MotionTableManager.cs:106-110`).
    // STAGED: A4-Q3 wires the JS teleport/portal trigger.
    #[allow(dead_code)]
    pub(crate) fn handle_exit_world(&mut self) {
        while !self.pending_animations.is_empty() {
            self.animation_done(false);
        }
    }

    /// `MotionTableManager::HandleEnterWorld` — additionally drops ALL
    /// sequence link animations first (`acclient.c:329949-329957`; ACE
    /// `MotionTableManager.cs:100-104`).
    // STAGED: see `handle_exit_world`.
    #[allow(dead_code)]
    pub(crate) fn handle_enter_world(&mut self) {
        self.events.push(MotionTableEvent::RemoveAllLinkAnimations);
        while !self.pending_animations.is_empty() {
            self.animation_done(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic motion ids carrying ONLY the class bits under test
    // (low bits arbitrary): substate = `0x40000000` without
    // `0x20000000`; style = sign bit; action = `0x10000000`; modifier =
    // `0x20000000` (CommandMasks.cs:6-17).
    const SUBSTATE_A: u32 = 0x4500_0005;
    const SUBSTATE_B: u32 = 0x4500_0006;
    const STYLE_S: u32 = 0x8000_003C;
    const ACTION_X: u32 = 0x1300_0062;
    const MODIFIER_M: u32 = 0x2100_0041;

    fn nodes(m: &MotionTableManager) -> Vec<AnimNode> {
        m.pending_animations.iter().copied().collect()
    }

    fn node(motion: u32, num_anims: u32) -> AnimNode {
        AnimNode { motion, num_anims }
    }

    /// Queue FIFO order: `MotionDone` fires head-first in submission
    /// order (`acclient.c:329873` pops from `pending_animations.head_`).
    #[test]
    fn animation_done_pops_fifo_order() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(SUBSTATE_A, 1);
        m.queue_object_motion(ACTION_X, 1);

        m.animation_done(true);
        assert_eq!(
            m.drain_events(),
            vec![MotionTableEvent::MotionDone {
                motion: SUBSTATE_A,
                success: true
            }]
        );
        m.animation_done(true);
        assert_eq!(
            m.drain_events(),
            vec![MotionTableEvent::MotionDone {
                motion: ACTION_X,
                success: true
            }]
        );
        assert!(m.pending_animations.is_empty());
        assert_eq!(m.animation_counter, 0);
    }

    /// `num_anims` accounting: a 2-anim node needs two `AnimationDone`
    /// signals (`num_anims <= animation_counter` pop gate,
    /// `acclient.c:329888`), and trailing zero-anim nodes ride out in
    /// the same pop pass.
    #[test]
    fn multi_anim_node_waits_for_matching_done_count() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(ACTION_X, 2);
        // A zero-anim follower in a class the coalescer leaves alone.
        m.queue_object_motion(MODIFIER_M, 0);

        m.animation_done(true);
        assert_eq!(m.drain_events(), vec![]);
        assert_eq!(m.animation_counter, 1);

        m.animation_done(true);
        assert_eq!(
            m.drain_events(),
            vec![
                MotionTableEvent::MotionDone {
                    motion: ACTION_X,
                    success: true
                },
                MotionTableEvent::MotionDone {
                    motion: MODIFIER_M,
                    success: true
                },
            ]
        );
        assert!(m.pending_animations.is_empty());
        assert_eq!(m.animation_counter, 0);
    }

    /// Counter reset on drain: popping a zero-anim node leaves the
    /// incremented counter at 1, and the drained-queue reset zeroes it
    /// (`if (counter && !head) counter = 0`, `acclient.c:329931-329936`).
    #[test]
    fn animation_counter_resets_when_queue_drains() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(MODIFIER_M, 0);
        m.animation_done(true);
        assert_eq!(m.animation_counter, 0);
        assert!(m.pending_animations.is_empty());
    }

    /// Retail no-ops (counter untouched) on an empty queue
    /// (`acclient.c:329884` head-null guard).
    #[test]
    fn animation_done_on_empty_queue_is_noop() {
        let mut m = MotionTableManager::new();
        m.animation_done(true);
        assert_eq!(m.animation_counter, 0);
        assert_eq!(m.drain_events(), vec![]);
    }

    /// Action-bit (`0x10000000`) pops call
    /// `MotionState::remove_action_head` before `MotionDone`
    /// (`acclient.c:329891-329893`); non-action pops leave the action
    /// list alone.
    #[test]
    fn action_bit_pop_removes_action_head() {
        let mut m = MotionTableManager::new();
        m.state.add_action(ACTION_X, 1.0);
        m.queue_object_motion(SUBSTATE_A, 1);
        m.queue_object_motion(ACTION_X, 1);

        m.animation_done(true);
        assert_eq!(m.state.actions.len(), 1, "non-action pop must not touch actions");
        m.animation_done(true);
        assert!(m.state.actions.is_empty(), "action pop removes the action head");
    }

    /// `remove_action_head` returns the popped id, 0 when empty
    /// (`acclient.c:341420-341440`).
    #[test]
    fn remove_action_head_returns_motion_id() {
        let mut state = MotionState::default();
        assert_eq!(state.remove_action_head(), 0);
        state.add_action(ACTION_X, 1.0);
        assert_eq!(state.remove_action_head(), ACTION_X);
        assert_eq!(state.remove_action_head(), 0);
    }

    /// Zero-anim motions complete immediately through
    /// `CheckForCompletedMotions` with `success = 1`
    /// (`acclient.c:329960-329980`) — anim-free motions never hang.
    #[test]
    fn check_for_completed_motions_pops_zero_anim_heads() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(MODIFIER_M, 0);
        m.queue_object_motion(SUBSTATE_A, 1);

        m.use_time();
        assert_eq!(
            m.drain_events(),
            vec![MotionTableEvent::MotionDone {
                motion: MODIFIER_M,
                success: true
            }]
        );
        assert_eq!(nodes(&m), vec![node(SUBSTATE_A, 1)]);
        assert_eq!(m.animation_counter, 0, "polled pops never touch the counter");
    }

    /// A zero-anim node BEHIND a non-zero head waits its turn — the
    /// poll stops at the first `num_anims != 0` head
    /// (`acclient.c:329970-329972`).
    #[test]
    fn check_for_completed_motions_stops_at_nonzero_head() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(SUBSTATE_A, 1);
        m.queue_object_motion(MODIFIER_M, 0);
        m.use_time();
        assert_eq!(m.drain_events(), vec![]);
        assert_eq!(nodes(&m).len(), 2);
    }

    /// The retail spam-coalescer: re-queueing a substate already in the
    /// queue truncates everything after the earlier duplicate — their
    /// `num_anims` zero out and the summed link anims are removed
    /// (`remove_redundant_links` → `truncate_animation_list`,
    /// `acclient.c:330079`/`:329842`). The zeroed backlog then
    /// completes through the next poll.
    #[test]
    fn redundant_substate_truncates_unplayed_backlog() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(SUBSTATE_A, 1);
        m.queue_object_motion(SUBSTATE_B, 2);
        m.queue_object_motion(SUBSTATE_A, 1);

        assert_eq!(
            m.drain_events(),
            vec![MotionTableEvent::RemoveLinkAnimations { num_anims: 3 }]
        );
        assert_eq!(
            nodes(&m),
            vec![node(SUBSTATE_A, 1), node(SUBSTATE_B, 0), node(SUBSTATE_A, 0)]
        );

        // The surviving head still needs its real AnimationDone; the
        // truncated tail completes in the same pop pass.
        m.animation_done(true);
        assert_eq!(
            m.drain_events(),
            vec![
                MotionTableEvent::MotionDone {
                    motion: SUBSTATE_A,
                    success: true
                },
                MotionTableEvent::MotionDone {
                    motion: SUBSTATE_B,
                    success: true
                },
                MotionTableEvent::MotionDone {
                    motion: SUBSTATE_A,
                    success: true
                },
            ]
        );
        assert!(m.pending_animations.is_empty());
    }

    /// The substate backward search is BLOCKED by a pending (non-zero)
    /// action/style/modifier node (`& 0xB0000000` gate,
    /// `acclient.c:330111-330113`) — no truncation across a queued
    /// one-shot.
    #[test]
    fn substate_search_blocked_by_pending_action() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(SUBSTATE_A, 1);
        m.queue_object_motion(ACTION_X, 1);
        m.queue_object_motion(SUBSTATE_A, 1);

        assert_eq!(m.drain_events(), vec![]);
        assert_eq!(
            nodes(&m),
            vec![node(SUBSTATE_A, 1), node(ACTION_X, 1), node(SUBSTATE_A, 1)]
        );
    }

    /// A substate duplicate with `num_anims == 0` does NOT truncate
    /// (retail requires the earlier node to still have anims,
    /// `acclient.c:330108-330110`) — the search walks past it.
    #[test]
    fn substate_zero_anim_duplicate_does_not_truncate() {
        let mut m = MotionTableManager::new();
        m.pending_animations.push_back(node(SUBSTATE_A, 0));
        m.add_to_queue(SUBSTATE_A, 1);
        assert_eq!(m.drain_events(), vec![]);
        assert_eq!(nodes(&m), vec![node(SUBSTATE_A, 0), node(SUBSTATE_A, 1)]);
    }

    /// Style-class (sign bit) coalescing: matches the earlier duplicate
    /// regardless of its `num_anims` (`acclient.c:330124-330128` breaks
    /// on motion equality alone) and is blocked by non-zero
    /// substate/modifier/action nodes (`& 0x70000000`,
    /// `acclient.c:330129-330131`).
    #[test]
    fn style_truncation_matches_and_blocks_per_retail_masks() {
        // Pass: zero-anim substate between the duplicates doesn't block.
        let mut m = MotionTableManager::new();
        m.queue_object_motion(STYLE_S, 1);
        m.pending_animations.push_back(node(SUBSTATE_A, 0));
        m.add_to_queue(STYLE_S, 1);
        assert_eq!(
            m.drain_events(),
            vec![MotionTableEvent::RemoveLinkAnimations { num_anims: 1 }]
        );
        assert_eq!(
            nodes(&m),
            vec![node(STYLE_S, 1), node(SUBSTATE_A, 0), node(STYLE_S, 0)]
        );

        // Blocked: a pending substate stops the style search.
        let mut blocked = MotionTableManager::new();
        blocked.queue_object_motion(STYLE_S, 1);
        blocked.queue_object_motion(SUBSTATE_B, 1);
        blocked.queue_object_motion(STYLE_S, 1);
        assert_eq!(blocked.drain_events(), vec![]);
        assert_eq!(nodes(&blocked).len(), 3);
    }

    /// Stop/StopCompletely queue a Ready (`0x41000003`) completion node
    /// (`acclient.c:330235-330245`) — "did the stop finish" is
    /// observable through the queue, never display-only (survey A4 §3
    /// row 5).
    #[test]
    fn stops_queue_ready_completion_nodes() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion_stop(2);
        assert_eq!(nodes(&m), vec![node(MOTION_READY, 2)]);

        let mut c = MotionTableManager::new();
        c.queue_stop_completely(0);
        assert_eq!(nodes(&c), vec![node(MOTION_READY, 0)]);
        // An instant (zero-anim) stop completes on the next poll.
        c.use_time();
        assert_eq!(
            c.drain_events(),
            vec![MotionTableEvent::MotionDone {
                motion: MOTION_READY,
                success: true
            }]
        );
    }

    /// Spam-stop coalescing: two back-to-back Ready nodes truncate to
    /// one pending stop (Ready is substate-class, `0x41000003`).
    #[test]
    fn repeated_stop_coalesces() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion_stop(1);
        m.queue_object_motion_stop(1);
        assert_eq!(
            m.drain_events(),
            vec![MotionTableEvent::RemoveLinkAnimations { num_anims: 1 }]
        );
        assert_eq!(nodes(&m), vec![node(MOTION_READY, 1), node(MOTION_READY, 0)]);
    }

    /// `initialize_state` seeds the queue with one Ready node carrying
    /// `SetDefaultState`'s anim count — the default state completes
    /// through the queue too (`acclient.c:330172-330200`; DESIGN.md
    /// amendment `enter_default_state` Ready seed).
    #[test]
    fn initialize_state_seeds_ready_node() {
        let mut m = MotionTableManager::new();
        m.initialize_state(3);
        assert_eq!(nodes(&m), vec![node(MOTION_READY, 3)]);
    }

    /// `HandleExitWorld` drains the whole queue with `success = 0` —
    /// pending one-shots are cancelled, not played, across exit-world
    /// (`acclient.c:329940-329947`), and the action head is still
    /// popped for action-class motions.
    #[test]
    fn handle_exit_world_drains_with_failure() {
        let mut m = MotionTableManager::new();
        m.state.add_action(ACTION_X, 1.0);
        m.queue_object_motion(SUBSTATE_A, 1);
        m.queue_object_motion(ACTION_X, 2);

        m.handle_exit_world();
        assert_eq!(
            m.drain_events(),
            vec![
                MotionTableEvent::MotionDone {
                    motion: SUBSTATE_A,
                    success: false
                },
                MotionTableEvent::MotionDone {
                    motion: ACTION_X,
                    success: false
                },
            ]
        );
        assert!(m.pending_animations.is_empty());
        assert_eq!(m.animation_counter, 0);
        assert!(m.state.actions.is_empty());
    }

    /// `HandleEnterWorld` removes ALL sequence link animations BEFORE
    /// draining (`acclient.c:329949-329957`).
    #[test]
    fn handle_enter_world_removes_all_links_first() {
        let mut m = MotionTableManager::new();
        m.queue_object_motion(SUBSTATE_A, 1);
        m.handle_enter_world();
        assert_eq!(
            m.drain_events(),
            vec![
                MotionTableEvent::RemoveAllLinkAnimations,
                MotionTableEvent::MotionDone {
                    motion: SUBSTATE_A,
                    success: false
                },
            ]
        );
        assert!(m.pending_animations.is_empty());
    }
}
