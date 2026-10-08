//! held-3 (2026-10-08 follow-ups) — retail's per-object net-blob queue for
//! the two relation events that name an object the client may not have yet.
//!
//! `SmartBox::HandlePickupEvent` (acclient.c:144473-144509) and
//! `SmartBox::HandleParentEvent` (:144512-144552) do not dispatch an event
//! whose object is unknown or is a NEWER instance than the one the client
//! holds: `CObjectMaint::QueueBlobForObject` (:310848-310860) files the raw
//! blob on that object — on a null placeholder when it does not exist yet,
//! re-stamped for destruction 25 s after its latest blob
//! (`AddObjectToBeDestroyed`, :310651-310672, the 25.0 at :310666) — and
//! `SmartBox::ProcessObjectNetBlobs` (:145767) replays the queue, in arrival
//! order, through the normal dispatcher once the object's CreateObject has
//! been handled (`HandleCreateObject` :145996). A ParentEvent waits on the
//! PARENT first (unknown, or the event names a newer parent instance), then
//! on the CHILD (unknown); a PickupEvent waits on its object (unknown, or a
//! newer instance). An OLDER instance is not queued: the handler drops it
//! (result 2), which the createobj-5 stamp gates already do.
//!
//! Ownership split: the world decides the wait target
//! ([`WorldState::object_blob_wait_target`]), holds the blobs and releases a
//! guid's blobs when its ObjectCreate is handled (the `ObjectCreate` arm in
//! `handlers/inventory.rs`). The bytes are opaque here — the wasm recv loop
//! queues the raw message before ANY dispatch and replays released blobs as
//! freshly received messages, so the world handler and the JS fan-out see a
//! replayed event exactly like a live one (and re-run the wait check: a
//! ParentEvent released by its parent's create can wait on its child next).
//! The native runtime never queues (it does not call
//! [`WorldState::queue_object_blob`]), so its behaviour is unchanged.

use super::types::WorldState;
use holtburger_common::Guid;
use holtburger_common::sequence::is_newer_u16;
use holtburger_protocol::messages::GameMessage;
use std::collections::HashMap;
use std::time::Duration;
use web_time::Instant;

/// Retail placeholder lifetime: 25 s after the LATEST queued blob
/// (`CObjectMaint::AddObjectToBeDestroyed` re-add, acclient.c:310666).
pub const OBJECT_BLOB_EXPIRY: Duration = Duration::from_secs(25);

#[derive(Debug)]
struct PendingObjectBlobs {
    /// Re-stamped by every queued blob (retail remove + re-add).
    last_queued_at: Instant,
    /// FIFO — `CPhysicsObj::queue_netblob` appends, the replay walks it in
    /// order (acclient.c:145767-145830).
    blobs: Vec<Vec<u8>>,
}

/// Guid-keyed FIFO of queued raw message blobs plus the replay list of the
/// blobs released by an ObjectCreate.
#[derive(Debug, Default)]
pub(crate) struct ObjectBlobQueue {
    pending: HashMap<Guid, PendingObjectBlobs>,
    ready: Vec<Vec<u8>>,
}

impl ObjectBlobQueue {
    fn expire(&mut self, now: Instant) {
        self.pending
            .retain(|_, entry| now.saturating_duration_since(entry.last_queued_at) < OBJECT_BLOB_EXPIRY);
    }

    pub(crate) fn queue(&mut self, guid: Guid, blob: Vec<u8>, now: Instant) {
        self.expire(now);
        let entry = self.pending.entry(guid).or_insert_with(|| PendingObjectBlobs {
            last_queued_at: now,
            blobs: Vec::new(),
        });
        entry.last_queued_at = now;
        entry.blobs.push(blob);
    }

    pub(crate) fn release(&mut self, guid: Guid, now: Instant) {
        self.expire(now);
        if let Some(entry) = self.pending.remove(&guid) {
            self.ready.extend(entry.blobs);
        }
    }

    pub(crate) fn take_ready(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.ready)
    }

    pub(crate) fn pending_len(&self) -> usize {
        self.pending.values().map(|entry| entry.blobs.len()).sum()
    }
}

impl WorldState {
    /// held-3: install the `?objectBlobQueue` switch (set once at world
    /// creation by the wasm bundle; DEFAULT ON). The queue also needs the
    /// createobj-5 stamp gates (`?lifecycleStampGates`): it is the queue
    /// half of the same retail handlers.
    pub fn set_object_blob_queue_enabled(&mut self, enabled: bool) {
        self.object_blob_queue_enabled = enabled;
    }

    /// held-3: whether ParentEvent / PickupEvent blobs are queued at all.
    pub fn object_blob_queue_active(&self) -> bool {
        self.object_blob_queue_enabled && self.lifecycle_stamp_gates_enabled
    }

    /// held-3 — the object a ParentEvent / PickupEvent must wait for
    /// (retail `HandleParentEvent` / `HandlePickupEvent` →
    /// `QueueBlobForObject`), or `None` to dispatch it now. Pure read; every
    /// other message is `None`.
    ///
    /// Deviations, both keeping today's behaviour where retail's object
    /// table and ours differ: a NULL parent (our detach form) never waits,
    /// and neither does the local player as parent — its world entity can be
    /// seeded from a position packet before its ObjectCreate, with an
    /// unseeded instance stamp, while ACE stamps the player's ParentEvents
    /// with its login count.
    pub fn object_blob_wait_target(&self, message: &GameMessage) -> Option<Guid> {
        if !self.object_blob_queue_active() {
            return None;
        }
        match message {
            GameMessage::PickupEvent(data) => match self.entities.get(data.guid) {
                None => Some(data.guid),
                Some(entity) if is_newer_u16(data.instance_sequence, entity.instance_sequence()) => {
                    Some(data.guid)
                }
                Some(_) => None,
            },
            GameMessage::ParentEvent(data) => {
                let parent = data.parent_guid;
                let parent_is_local = self.player.guid != Guid::NULL && parent == self.player.guid;
                if parent != Guid::NULL && !parent_is_local {
                    match self.entities.get(parent) {
                        None => return Some(parent),
                        Some(entity)
                            if is_newer_u16(
                                data.parent_instance_sequence,
                                entity.instance_sequence(),
                            ) =>
                        {
                            return Some(parent);
                        }
                        Some(_) => {}
                    }
                }
                if self.entities.get(data.child_guid).is_none() {
                    return Some(data.child_guid);
                }
                None
            }
            _ => None,
        }
    }

    /// held-3 — file a raw message blob on `guid` (retail
    /// `QueueBlobForObject`). Buckets idle for 25 s are dropped first.
    pub fn queue_object_blob(&mut self, guid: Guid, blob: Vec<u8>, now: Instant) {
        self.object_blobs.queue(guid, blob, now);
    }

    /// held-3 — `guid`'s ObjectCreate was handled: move its queued blobs (if
    /// any, and not expired) to the replay list, in arrival order.
    pub(crate) fn release_object_blobs(&mut self, guid: Guid, now: Instant) {
        self.object_blobs.release(guid, now);
    }

    /// held-3 — drain the blobs released since the last call; the caller
    /// re-dispatches each as a freshly received message
    /// (`SmartBox::ProcessObjectNetBlobs`, acclient.c:145767).
    pub fn take_ready_object_blobs(&mut self) -> Vec<Vec<u8>> {
        self.object_blobs.take_ready()
    }

    /// held-3 — queued (not yet released) blob count (diag/tests).
    pub fn queued_object_blob_count(&self) -> usize {
        self.object_blobs.pending_len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::Entity;
    use holtburger_common::position::WorldPosition;
    use holtburger_protocol::messages::object::messages::properties::{
        ParentEventData, PickupEventData,
    };

    const PARENT: Guid = Guid(0x5000_0002);
    const CHILD: Guid = Guid(0x8000_0010);

    fn world_with(guids: &[(Guid, u16)]) -> WorldState {
        let mut world = WorldState::synthetic();
        for &(guid, instance) in guids {
            let mut entity = Entity::new(guid, "E".to_string(), WorldPosition::default());
            // Retail `update_times[8]` (INSTANCE_TS) — `Entity::instance_sequence`.
            entity.sequences[8] = instance;
            world.entities.insert(entity);
        }
        world
    }

    fn parent_event(parent_instance: u16) -> GameMessage {
        GameMessage::ParentEvent(Box::new(ParentEventData {
            parent_guid: PARENT,
            child_guid: CHILD,
            location: 1,
            placement: 1,
            parent_instance_sequence: parent_instance,
            child_position_sequence: 7,
        }))
    }

    fn pickup_event(instance: u16) -> GameMessage {
        GameMessage::PickupEvent(Box::new(PickupEventData {
            guid: CHILD,
            instance_sequence: instance,
            position_sequence: 7,
        }))
    }

    /// HandleParentEvent (acclient.c:144512-144552): unknown parent → wait on
    /// the parent; newer parent instance → wait on the parent; unknown child
    /// → wait on the child; both present at the current (or an OLDER, which
    /// the handler drops) parent instance → dispatch now.
    #[test]
    fn parent_event_waits_on_parent_then_child() {
        assert_eq!(world_with(&[]).object_blob_wait_target(&parent_event(3)), Some(PARENT));
        assert_eq!(world_with(&[(CHILD, 0)]).object_blob_wait_target(&parent_event(3)), Some(PARENT));
        let newer_parent = world_with(&[(PARENT, 2), (CHILD, 0)]);
        assert_eq!(newer_parent.object_blob_wait_target(&parent_event(3)), Some(PARENT));
        let no_child = world_with(&[(PARENT, 3)]);
        assert_eq!(no_child.object_blob_wait_target(&parent_event(3)), Some(CHILD));
        let both = world_with(&[(PARENT, 3), (CHILD, 0)]);
        assert_eq!(both.object_blob_wait_target(&parent_event(3)), None);
        assert_eq!(both.object_blob_wait_target(&parent_event(2)), None, "older: the gate drops it");
    }

    /// The local player as parent and the NULL (detach) parent never wait.
    #[test]
    fn parent_event_local_player_and_detach_never_wait_on_the_parent() {
        let mut world = world_with(&[(CHILD, 0)]);
        world.player.guid = PARENT;
        assert_eq!(world.object_blob_wait_target(&parent_event(57)), None);
        let detach = GameMessage::ParentEvent(Box::new(ParentEventData {
            parent_guid: Guid::NULL,
            child_guid: CHILD,
            location: 0,
            placement: 0,
            parent_instance_sequence: 0,
            child_position_sequence: 7,
        }));
        assert_eq!(world_with(&[(CHILD, 0)]).object_blob_wait_target(&detach), None);
    }

    /// HandlePickupEvent (acclient.c:144473-144509): unknown object or newer
    /// instance → wait on it; the current (or an older) instance → now.
    #[test]
    fn pickup_event_waits_on_unknown_or_newer_instance() {
        assert_eq!(world_with(&[]).object_blob_wait_target(&pickup_event(0)), Some(CHILD));
        assert_eq!(world_with(&[(CHILD, 1)]).object_blob_wait_target(&pickup_event(2)), Some(CHILD));
        assert_eq!(world_with(&[(CHILD, 1)]).object_blob_wait_target(&pickup_event(1)), None);
        assert_eq!(world_with(&[(CHILD, 2)]).object_blob_wait_target(&pickup_event(1)), None);
    }

    /// `?objectBlobQueue=off` and `?lifecycleStampGates=off` both disable it.
    #[test]
    fn queue_switches_off() {
        let mut world = world_with(&[]);
        world.set_object_blob_queue_enabled(false);
        assert_eq!(world.object_blob_wait_target(&pickup_event(0)), None);
        let mut world = world_with(&[]);
        world.set_lifecycle_stamp_gates_enabled(false);
        assert_eq!(world.object_blob_wait_target(&parent_event(0)), None);
    }

    /// Queue → release (FIFO, only the created guid) → drain once.
    #[test]
    fn release_replays_in_arrival_order() {
        let mut world = world_with(&[]);
        let t0 = Instant::now();
        world.queue_object_blob(PARENT, vec![1], t0);
        world.queue_object_blob(CHILD, vec![9], t0);
        world.queue_object_blob(PARENT, vec![2], t0);
        assert_eq!(world.queued_object_blob_count(), 3);
        world.release_object_blobs(PARENT, t0);
        assert_eq!(world.take_ready_object_blobs(), vec![vec![1u8], vec![2u8]]);
        assert!(world.take_ready_object_blobs().is_empty(), "drained");
        assert_eq!(world.queued_object_blob_count(), 1, "the child's blob still waits");
        world.release_object_blobs(Guid(0x8000_7777), t0);
        assert!(world.take_ready_object_blobs().is_empty(), "nothing queued for that guid");
    }

    /// The placeholder dies 25 s after its LATEST blob (acclient.c:310666):
    /// a newer blob re-stamps the whole bucket; an expired bucket is dropped
    /// unreplayed.
    #[test]
    fn buckets_expire_25s_after_the_latest_blob() {
        let mut world = world_with(&[]);
        let t0 = Instant::now();
        world.queue_object_blob(PARENT, vec![1], t0);
        world.queue_object_blob(PARENT, vec![2], t0 + Duration::from_secs(20));
        world.release_object_blobs(PARENT, t0 + Duration::from_secs(40));
        assert_eq!(world.take_ready_object_blobs(), vec![vec![1u8], vec![2u8]], "re-stamped at 20 s");
        world.queue_object_blob(CHILD, vec![3], t0);
        world.release_object_blobs(CHILD, t0 + Duration::from_secs(26));
        assert!(world.take_ready_object_blobs().is_empty(), "expired unreplayed");
        assert_eq!(world.queued_object_blob_count(), 0);
    }

    /// The ObjectCreate world handler releases the created guid's blobs.
    #[test]
    fn object_create_releases_the_queue() {
        use holtburger_protocol::messages::object::messages::description::ObjectDescriptionData;
        let mut world = world_with(&[]);
        world.queue_object_blob(PARENT, vec![5], Instant::now());
        world.queue_object_blob(CHILD, vec![6], Instant::now());
        let data = ObjectDescriptionData::with_guid(PARENT);
        let _ = world.handle_message(&GameMessage::ObjectCreate(Box::new(data)));
        assert_eq!(world.take_ready_object_blobs(), vec![vec![5u8]]);
        assert_eq!(world.queued_object_blob_count(), 1, "only the created guid is released");
    }
}
