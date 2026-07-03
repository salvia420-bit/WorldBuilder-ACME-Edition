//! P10 (2026-07-03, movement-port WAVE-1) — `MoveToManager`
//! construction / destruction / node-primitive layer. EXTENDS
//! `move_to.rs` (the P11/P12 driver); it does not fork it.
//!
//! Retail sources (all cited inline at their def):
//!   ctor `MoveToManager::MoveToManager`      acclient.c:344978-345024
//!   `Create`                                 acclient.c:345029-345045
//!   dtor `~MoveToManager` → `Destroy`        acclient.c:345357-345363
//!   `Destroy`                                acclient.c:345047-345093
//!   `SetPhysicsObject`                       acclient.c:344907-344910
//!   `SetWeenieObject`                        acclient.c:344901-344904
//!   `InitializeLocalVariables`               acclient.c:344913-344959
//!   `AddMoveToPositionNode`                  acclient.c:345120-345141
//!   `AddTurnToHeadingNode`                   acclient.c:345096-345118
//! ACE 1:1 reference: Physics/Managers/MoveToManager.cs:37-72,306-313;
//! Physics/Animation/MovementNode.cs (the node class).
//!
//! ## Node / queue shape (retail vs port)
//! Retail `pending_actions` is a `DLListBase` (head_/tail_ pointers,
//! acclient.c ctor :345017-345018). Each node is a **16-byte**
//! `MoveToManager::MovementNode` (UDT `0x000165ed`, acclient.txt:536860):
//! ```text
//!   +0  dllist_next  (DLListData base, LF_BCLASS @0)
//!   +4  dllist_prev
//!   +8  type    u32   7 = MoveToPosition, 9 = TurnToHeading
//!   +12 heading f32   used only by type 9
//! ```
//! `type`/`heading` match ACE `MovementNode{Type,Heading}` and the
//! `MovementType` enum (Invalid=0 … MoveToPosition=7, TurnToHeading=9,
//! ACE MovementType.cs:7-19). `AddTurnToHeadingNode` and
//! `AddMoveToPositionNode` both `operator new(0x10)`, zero the node,
//! set `type` (and `heading` for the turn node), then
//! `DLListBase::InsertAfter(&head_, node, tail_)` — i.e. **append to
//! tail** (retail's ordered enqueue).
//!
//! RECONCILIATION: `move_to.rs` already models the payload as
//! `enum MoveToNode { TurnToHeading(f32), MoveToPosition }` in a
//! `VecDeque<MoveToNode>`. That is faithful — it keeps `type`+`heading`
//! and drops only the intrusive `next`/`prev` (the `VecDeque` owns
//! ordering). `InsertAfter(tail)` ⇒ `push_back`; `RemovePendingActionsHead`
//! (P12) ⇒ `pop_front`; the `Destroy` drain ⇒ `clear`. The two primitives
//! below are the retail-named constructors for those `push_back`s so
//! future `build_*`-shaped sites can delegate instead of open-coding the
//! push.

use super::move_to::{MoveToManager, MoveToNode};
use holtburger_common::Guid;

/// Retail `MovementType` node-tag values (ACE MovementType.cs:16-18).
/// The `pending_actions` list only ever carries these two.
#[allow(dead_code)] // documentation constants (the enum payload IS the tag)
pub(crate) const NODE_TYPE_MOVE_TO_POSITION: u32 = 7;
#[allow(dead_code)]
pub(crate) const NODE_TYPE_TURN_TO_HEADING: u32 = 9;

impl MoveToManager {
    // ---- construction (ctor / Create) ----------------------------------

    /// `MoveToManager::MoveToManager` — the no-arg ctor
    /// (acclient.c:344978-345024). Retail: identity-frame the three
    /// Position members + set their vftables, default-construct
    /// `movement_params`, null the `pending_actions` head_/tail_, null
    /// physics_obj/weenie_obj, then `InitializeLocalVariables`. In the
    /// port every one of those is subsumed by the `Default` impl in
    /// move_to.rs (Positions → `Option::None`, list → empty `VecDeque`,
    /// seams → `None`, locals → the `InitializeLocalVariables` seeds).
    /// Retail-name alias so call sites read like the decomp.
    #[allow(dead_code)] // staged: lifecycle callers arrive with the P13 teardown wiring
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// `MoveToManager::Create(physics_obj, weenie_obj)`
    /// (acclient.c:345029-345045; mangled `?Create@…` ⇒ returns
    /// `MoveToManager*` — the decompiled `void`/uninitialized-`v3` is a
    /// Hex-Rays eax-alias artifact, P10-2). The 2-arg ctor path
    /// (:344978 + MoveToManager.cs:43-49): base ctor, then store the two
    /// seam handles. `0x160`=352-byte alloc is the concrete struct size
    /// (UDT 0x000165e3) — not modeled (Rust owns layout).
    #[allow(dead_code)] // staged: lifecycle callers arrive with the P13 teardown wiring
    pub(crate) fn create(physics_obj: Option<Guid>, weenie_obj: Option<Guid>) -> Self {
        let mut m = Self::new();
        m.set_physics_object(physics_obj);
        m.set_weenie_object(weenie_obj);
        m
    }

    // ---- seam setters (SetPhysicsObject / SetWeenieObject) --------------

    /// `MoveToManager::SetPhysicsObject` (acclient.c:344907-344910):
    /// `this->physics_obj = pobj`. Stores the identity handle only —
    /// per-tick pose/radius/height keep flowing through
    /// [`super::move_to::MoveToView`] (single physics source; no
    /// double-read).
    pub(crate) fn set_physics_object(&mut self, physics_obj: Option<Guid>) {
        self.set_physics_obj_handle(physics_obj);
    }

    /// `MoveToManager::SetWeenieObject` (acclient.c:344901-344904):
    /// `this->weenie_obj = wobj`. Identity handle for the P12
    /// weenie-notify / `ReportExhaustion` seam; completion itself rides
    /// the latch.
    pub(crate) fn set_weenie_object(&mut self, weenie_obj: Option<Guid>) {
        self.set_weenie_obj_handle(weenie_obj);
    }

    /// Retail-named alias for the `InitializeLocalVariables` body
    /// (acclient.c:344913-344959) — the driver-state reset that
    /// move_to.rs implements as `reset_driver_state`. NOTE the one
    /// documented sub-reset divergence (P10-1): retail zeroes only
    /// `movement_params.{bitfield,context_id}` here, the port
    /// `Default`s the whole params block. Behavior-neutral: every entry
    /// (`move_to_*`/`turn_to_*`) overwrites `movement_params` before any
    /// read. Seam handles are preserved (retail leaves them; only the
    /// ctor nulls them).
    #[allow(dead_code)] // reset_driver_state is the live callee; this is the retail-named seam
    pub(crate) fn initialize_local_variables(&mut self) {
        self.reset_driver_state_public();
    }

    // ---- destruction (dtor / Destroy) ----------------------------------

    /// `MoveToManager::Destroy` (acclient.c:345047-345093), also the body
    /// of `~MoveToManager` (:345357-345363, which is just `Destroy(this)`).
    /// Retail drains every `pending_actions` node (unlink + `operator
    /// delete`) then `InitializeLocalVariables`. Port: `VecDeque::clear`
    /// (RAII frees the nodes) folded into `reset_driver_state`. Retail
    /// `Destroy` PRESERVES physics_obj/weenie_obj across the reset
    /// (InitLocals doesn't touch them) — so does this.
    #[allow(dead_code)] // staged: retail-dtor call sites (MakeMoveToManager replace path)
    pub(crate) fn destroy(&mut self) {
        // reset_driver_state already clears pending_nodes + reseeds locals.
        self.reset_driver_state_public();
    }

    // ---- node primitives (AddMoveToPositionNode / AddTurnToHeadingNode) -

    /// `MoveToManager::AddMoveToPositionNode` (acclient.c:345120-345141):
    /// `new` a type-7 node (no heading) and `InsertAfter(tail)`.
    /// ⇒ `pending_nodes.push_back(MoveToNode::MoveToPosition)`.
    #[allow(dead_code)] // staged: retail-named delegate for the build_* push sites
    pub(crate) fn add_move_to_position_node(&mut self) {
        self.push_node(MoveToNode::MoveToPosition);
    }

    /// `MoveToManager::AddTurnToHeadingNode(heading)`
    /// (acclient.c:345096-345118): `new` a type-9 node, store `heading`
    /// (DEGREES, retail node domain), `InsertAfter(tail)`.
    /// ⇒ `pending_nodes.push_back(MoveToNode::TurnToHeading(heading))`.
    #[allow(dead_code)] // staged: retail-named delegate for the build_* push sites
    pub(crate) fn add_turn_to_heading_node(&mut self, heading_deg: f32) {
        self.push_node(MoveToNode::TurnToHeading(heading_deg));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::movement::move_to::{MoveToManager, MoveToNode};

    /// ctor/`new`/`create` seed identity: fresh manager is inactive with
    /// empty node queue; `create` records both seam handles; `new`==default.
    #[test]
    fn ctor_and_create_seat_handles() {
        let m = MoveToManager::new();
        assert!(!m.is_active());
        assert_eq!(m.physics_object(), None);
        assert_eq!(m.weenie_object(), None);

        let p = Guid(0x8000_0001);
        let w = Guid(0x5000_0002);
        let m = MoveToManager::create(Some(p), Some(w));
        assert_eq!(m.physics_object(), Some(p));
        assert_eq!(m.weenie_object(), Some(w));
        assert!(!m.is_active(), "Create does not start a movement");
    }

    /// `SetPhysicsObject`/`SetWeenieObject` overwrite the handles;
    /// clearing to `None` mirrors retail null-store.
    #[test]
    fn set_object_seams() {
        let mut m = MoveToManager::new();
        m.set_physics_object(Some(Guid(0xAAAA)));
        m.set_weenie_object(Some(Guid(0xBBBB)));
        assert_eq!(m.physics_object(), Some(Guid(0xAAAA)));
        assert_eq!(m.weenie_object(), Some(Guid(0xBBBB)));
        m.set_physics_object(None);
        assert_eq!(m.physics_object(), None);
        assert_eq!(m.weenie_object(), Some(Guid(0xBBBB)), "independent");
    }

    /// `AddTurnToHeadingNode`/`AddMoveToPositionNode` append in order
    /// (`InsertAfter(tail)` ⇒ `push_back`), carrying the heading on the
    /// type-9 node and nothing on the type-7 node.
    #[test]
    fn node_primitives_append_in_order() {
        let mut m = MoveToManager::new();
        m.add_turn_to_heading_node(123.5);
        m.add_move_to_position_node();
        m.add_turn_to_heading_node(45.0);
        assert_eq!(
            m.pending_nodes_snapshot(),
            vec![
                MoveToNode::TurnToHeading(123.5),
                MoveToNode::MoveToPosition,
                MoveToNode::TurnToHeading(45.0),
            ]
        );
    }

    /// Node-tag constants match the retail `MovementType` values used by
    /// the two Add* bodies (7 / 9).
    #[test]
    fn node_tag_constants() {
        assert_eq!(NODE_TYPE_MOVE_TO_POSITION, 7);
        assert_eq!(NODE_TYPE_TURN_TO_HEADING, 9);
    }

    /// `Destroy` drains the node queue and re-seeds locals but PRESERVES
    /// the seam handles (retail InitLocals leaves physics/weenie alone).
    #[test]
    fn destroy_drains_nodes_preserves_seams() {
        let mut m = MoveToManager::create(Some(Guid(0x1)), Some(Guid(0x2)));
        m.add_turn_to_heading_node(10.0);
        m.add_move_to_position_node();
        m.destroy();
        assert!(m.pending_nodes_snapshot().is_empty(), "node list drained");
        assert!(!m.is_active());
        assert_eq!(
            m.physics_object(),
            Some(Guid(0x1)),
            "Destroy preserves physics seam"
        );
        assert_eq!(
            m.weenie_object(),
            Some(Guid(0x2)),
            "Destroy preserves weenie seam"
        );
    }
}
