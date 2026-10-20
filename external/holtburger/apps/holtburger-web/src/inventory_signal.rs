//! 2026-10-20 (improvement hunt A11, net-session-1) — when the recv loop
//! raises ClientEvent kind=11 `InventoryUpdated` (and marks the lazy Rust
//! inventory snapshot dirty, `mark_player_inventory_dirty`).
//!
//! Before: `session/messages` raised kind=11 for EVERY routed ObjectCreate
//! (`EntitySpawned` / `EntityReplaced`), ObjectDelete / InventoryRemoveObject,
//! ParentEvent, `PropertiesUpdated` and `EntityAttached` / `EntityDetached`
//! in view; only UpdateObject was ownership-filtered
//! (`WorldState::note_update_object`). With `?worldLifecycle` default ON that
//! is nearly every frame of a town-arrival burst (~300 creates) and every
//! missile create/delete, corpse churn and monster weapon swap in combat.
//! Each one cost a `renderInventoryPanel` + `playerInventoryChanged` fan-out
//! (snapshot clones with one wasm box per item, the legacy list innerHTML,
//! the hotbar prune, and with the inventory open the full grid / paperdoll
//! rebuild), and the kind=11 raised by the same EntityAttached/Detached arm
//! defeated the 2026-10-07 `wieldEventTouchesLocal` kind:47/49 filter in
//! plugins/inventory.js.
//!
//! Now (`?invSignalOwned`, DEFAULT ON, `=off|0|false|no` restores the
//! every-object signal) a subject raises it only when it touches the owned or
//! viewed item set BEFORE or AFTER the message ([`subject_touches_inventory`]):
//! it is the player, an owned item (`player.inventory` / `player.equipment`),
//! an open container, an item listed by the open vendor or trade, or its
//! container / wielder is the player, an owned pack or an open container.
//! "Viewed" matters because the JS consumers also refresh the open ground
//! container (corpse-loot-bar `refreshContents`) on `playerInventoryChanged`.
//!
//! "Before" matters too: ACE's drop path sends
//! `PublicUpdateInstanceID(Container -> 0)` (Player_Inventory.cs), after
//! which the item is no longer owned, so an after-only test would skip the
//! dirty mark and leave the Rust snapshot itself stale. The before-state is
//! captured pre-route for the guids the message names
//! ([`message_subject_guids`] -> [`PreRouteSubjects`]). A subject the capture
//! does not cover keeps the old unconditional signal: every GameEvent (they
//! are all about the player's own things), the Private property updates (the
//! player), and any event naming an object the message did not.
//!
//! The snapshot builder (`publish_player_inventory_snapshot`) reads only
//! `player.inventory` entities, so a message whose subjects are unowned and
//! unviewed both before and after cannot change it: dropping that signal is
//! pixel-identical for every panel. ContainerOpened / ContainerClosed,
//! EntityIdentified and the vendor / trade signals stay unconditional at the
//! call sites (`session/messages/mod.rs`).
//!
//! Same `wasm32 OR test` gate as `combat_toggle` / `chat_format` so
//! `cargo test -p holtburger-web --lib inventory_signal` runs natively; the
//! recv loop only calls in.

use holtburger_common::Guid;
use holtburger_common::properties::WorldObjectExt as _;
use holtburger_protocol::messages::GameMessage;

/// Parse `?invSignalOwned`. DEFAULT-ON, off-escape:
/// `invSignalOwned=off|0|false|no` disables (house rule: absent reads ON,
/// only an explicit off-form is OFF). OFF = kind=11 for every object in view
/// (the pre-2026-10-20 behaviour).
pub(crate) fn parse_inv_signal_owned_flag(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "invSignalOwned=off"
                | "invSignalOwned=0"
                | "invSignalOwned=false"
                | "invSignalOwned=no"
        )
    })
}

/// The `?invSignalOwned` gate, parsed once per wasm instance over the seeded
/// `flag_search()` (the recv loop reads it per message; no URL parsing after
/// the first read).
#[cfg(target_arch = "wasm32")]
pub(crate) fn inv_signal_owned_flag() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| parse_inv_signal_owned_flag(&crate::flag_search()))
}

/// What the predicate reads about the world at one instant (before or after
/// routing). Guids are raw `u32`; `0` = none.
pub(crate) trait InventoryView {
    /// The local player's guid (`0` until it is known).
    fn player_guid(&self) -> u32;
    /// In `player.inventory` or `player.equipment` (contained at any depth,
    /// or wielded, by the player — what the snapshot builder lists).
    fn is_owned(&self, guid: u32) -> bool;
    /// A container whose contents are being viewed (ViewContents, until
    /// CloseGroundContainer).
    fn is_open_container(&self, guid: u32) -> bool;
    /// `(container, wielder)` of a known object; `0` for an unset slot or an
    /// unknown object.
    fn holders(&self, guid: u32) -> (u32, u32);
    /// Listed by the open vendor, or on either side of the open trade.
    fn is_vendor_or_trade_item(&self, guid: u32) -> bool;
}

/// A container / wielder slot that puts its subject in the owned or viewed
/// set: the player, an owned pack, or an open container.
fn holder_touches_inventory<V: InventoryView + ?Sized>(view: &V, holder: u32) -> bool {
    holder != 0
        && (holder == view.player_guid() || view.is_owned(holder) || view.is_open_container(holder))
}

/// Does `guid` touch the owned or viewed item set in `view`?
pub(crate) fn subject_touches_inventory<V: InventoryView + ?Sized>(view: &V, guid: u32) -> bool {
    let player = view.player_guid();
    // Ownership is undecidable before the player's guid is known, and a NULL
    // subject names nothing we can look up: keep the signal.
    if player == 0 || guid == 0 {
        return true;
    }
    if guid == player
        || view.is_owned(guid)
        || view.is_open_container(guid)
        || view.is_vendor_or_trade_item(guid)
    {
        return true;
    }
    let (container, wielder) = view.holders(guid);
    holder_touches_inventory(view, container) || holder_touches_inventory(view, wielder)
}

/// Most guids one message names (ParentEvent: child + parent).
pub(crate) const MAX_SUBJECTS: usize = 2;

/// The guids a routed message names whose pre-route state the predicate
/// needs, `0` = empty slot. Covers the per-object families that dominate
/// bursts and combat; everything else returns `[0, 0]` (its subjects keep the
/// unconditional signal). Private property updates carry guid 0 on the wire
/// (= the player, always relevant), so they need no capture.
pub(crate) fn message_subject_guids(message: &GameMessage) -> [u32; MAX_SUBJECTS] {
    match message {
        GameMessage::ObjectCreate(d) => [u32::from(d.public_weenie_desc.guid), 0],
        GameMessage::ObjectDelete(d) => [u32::from(d.guid), 0],
        GameMessage::InventoryRemoveObject(d) => [u32::from(d.object_guid), 0],
        GameMessage::ParentEvent(d) => [u32::from(d.child_guid), u32::from(d.parent_guid)],
        GameMessage::PickupEvent(d) => [u32::from(d.guid), 0],
        GameMessage::SetStackSize(d) => [u32::from(d.object_guid), 0],
        GameMessage::PublicUpdatePropertyInt(d) => [u32::from(d.guid), 0],
        GameMessage::PublicUpdatePropertyInt64(d) => [u32::from(d.guid), 0],
        GameMessage::PublicUpdatePropertyBool(d) => [u32::from(d.guid), 0],
        GameMessage::PublicUpdatePropertyFloat(d) => [u32::from(d.guid), 0],
        GameMessage::PublicUpdatePropertyString(d) => [u32::from(d.guid), 0],
        GameMessage::PublicUpdatePropertyDataId(d) => [u32::from(d.guid), 0],
        GameMessage::PublicUpdatePropertyInstanceId(d) => [u32::from(d.guid), 0],
        _ => [0; MAX_SUBJECTS],
    }
}

/// Whether each of a message's subjects touched the inventory BEFORE the
/// world routed it. `Copy` and allocation-free (one per inbound message).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PreRouteSubjects {
    /// `(guid, touched)`; guid `0` = empty slot.
    slots: [(u32, bool); MAX_SUBJECTS],
}

impl PreRouteSubjects {
    /// Capture `guids` (from [`message_subject_guids`]) against the
    /// pre-route world.
    pub(crate) fn capture<V: InventoryView + ?Sized>(view: &V, guids: [u32; MAX_SUBJECTS]) -> Self {
        let mut slots = [(0u32, false); MAX_SUBJECTS];
        for (slot, guid) in slots.iter_mut().zip(guids) {
            if guid != 0 {
                *slot = (guid, subject_touches_inventory(view, guid));
            }
        }
        PreRouteSubjects { slots }
    }

    /// `Some(touched)` for a captured guid, `None` when the capture does not
    /// cover it.
    pub(crate) fn before(&self, guid: u32) -> Option<bool> {
        if guid == 0 {
            return None;
        }
        self.slots
            .iter()
            .find(|(g, _)| *g == guid)
            .map(|(_, touched)| *touched)
    }
}

/// Raise kind=11 for an event about `guid`? `pre == None` (flag off) is the
/// old unconditional signal; a guid the capture does not cover keeps it too;
/// otherwise owned/viewed before OR after.
pub(crate) fn should_signal<V: InventoryView + ?Sized>(
    pre: Option<&PreRouteSubjects>,
    after: &V,
    guid: u32,
) -> bool {
    let Some(pre) = pre else {
        return true;
    };
    match pre.before(guid) {
        None | Some(true) => true,
        Some(false) => subject_touches_inventory(after, guid),
    }
}

/// EntityAttached / EntityDetached (item + new / prior wielder) and the
/// ParentEvent post-route arm (child + parent): the item's own test, or a
/// holder that is the player / an owned pack / an open container.
pub(crate) fn should_signal_with_holder<V: InventoryView + ?Sized>(
    pre: Option<&PreRouteSubjects>,
    after: &V,
    item: u32,
    holder: u32,
) -> bool {
    should_signal(pre, after, item) || holder_touches_inventory(after, holder)
}

/// [`InventoryView`] over the live `WorldState` (read before routing for the
/// capture, after routing for the decision).
pub(crate) struct WorldInventoryView<'a>(pub(crate) &'a holtburger_world::WorldState);

impl InventoryView for WorldInventoryView<'_> {
    fn player_guid(&self) -> u32 {
        u32::from(self.0.player.guid)
    }

    fn is_owned(&self, guid: u32) -> bool {
        let g = Guid::from(guid);
        self.0.player.inventory.contains(&g) || self.0.player.equipment.contains_key(&g)
    }

    fn is_open_container(&self, guid: u32) -> bool {
        self.0.open_containers.contains(&Guid::from(guid))
    }

    fn holders(&self, guid: u32) -> (u32, u32) {
        self.0
            .entities
            .get(Guid::from(guid))
            .map(|entity| {
                (
                    entity.container_id().map(u32::from).unwrap_or(0),
                    entity.wielder_id().map(u32::from).unwrap_or(0),
                )
            })
            .unwrap_or((0, 0))
    }

    fn is_vendor_or_trade_item(&self, guid: u32) -> bool {
        let g = Guid::from(guid);
        self.0
            .vendor
            .as_ref()
            .is_some_and(|vendor| vendor.items.iter().any(|item| item.guid == g))
            || self.0.trade.as_ref().is_some_and(|trade| {
                trade.self_side.items.contains(&g) || trade.partner_side.items.contains(&g)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::{
        PropertyInstanceId, PropertyInt, WorldObjectPropertyAccessorsMut as _,
    };
    use holtburger_protocol::messages::{
        InventoryRemoveObjectData, ObjectDeleteData, ParentEventData, PrivateUpdatePropertyIntData,
        PublicUpdatePropertyInstanceIdData, PublicUpdatePropertyIntData, SetStackSizeData,
    };
    use holtburger_world::{WorldEvent, WorldState};
    use std::collections::{HashMap, HashSet};

    const PLAYER: u32 = 0x5000_0001;
    const NPC: u32 = 0x8000_0201;
    const NPC_SWORD: u32 = 0x8000_0202;
    const PACK: u32 = 0x8000_0301;
    const DAGGER: u32 = 0x8000_0302;
    const CORPSE: u32 = 0x8000_0401;
    const LOOT: u32 = 0x8000_0402;

    #[derive(Default)]
    struct FakeView {
        player: u32,
        owned: HashSet<u32>,
        open: HashSet<u32>,
        holders: HashMap<u32, (u32, u32)>,
        listed: HashSet<u32>,
    }

    impl InventoryView for FakeView {
        fn player_guid(&self) -> u32 {
            self.player
        }
        fn is_owned(&self, guid: u32) -> bool {
            self.owned.contains(&guid)
        }
        fn is_open_container(&self, guid: u32) -> bool {
            self.open.contains(&guid)
        }
        fn holders(&self, guid: u32) -> (u32, u32) {
            self.holders.get(&guid).copied().unwrap_or((0, 0))
        }
        fn is_vendor_or_trade_item(&self, guid: u32) -> bool {
            self.listed.contains(&guid)
        }
    }

    /// A player with one pack (and a dagger in it), an NPC wielding a sword,
    /// and an open corpse.
    fn fake_world() -> FakeView {
        let mut v = FakeView {
            player: PLAYER,
            ..FakeView::default()
        };
        v.owned.extend([PACK, DAGGER]);
        v.holders.insert(PACK, (PLAYER, 0));
        v.holders.insert(DAGGER, (PACK, 0));
        v.holders.insert(NPC_SWORD, (0, NPC));
        v.holders.insert(NPC, (0, 0));
        v.holders.insert(CORPSE, (0, 0));
        v.open.insert(CORPSE);
        v
    }

    #[test]
    fn inv_signal_owned_flag_defaults_on_with_off_0_false_no_escape() {
        assert!(parse_inv_signal_owned_flag(""));
        assert!(parse_inv_signal_owned_flag("?foo=bar"));
        assert!(parse_inv_signal_owned_flag("?invSignalOwned=on"));
        assert!(parse_inv_signal_owned_flag("?invSignalOwned=1"));
        for off in ["off", "0", "false", "no"] {
            assert!(!parse_inv_signal_owned_flag(&format!(
                "?invSignalOwned={off}"
            )));
            assert!(!parse_inv_signal_owned_flag(&format!(
                "?a=b&invSignalOwned={off}&c=d"
            )));
        }
    }

    #[test]
    fn owned_viewed_and_listed_subjects_touch_the_inventory() {
        let mut v = fake_world();
        assert!(subject_touches_inventory(&v, PLAYER), "the player itself");
        assert!(subject_touches_inventory(&v, PACK), "an owned pack");
        assert!(subject_touches_inventory(&v, DAGGER), "an owned item");
        assert!(subject_touches_inventory(&v, CORPSE), "an open container");
        // Not (yet) filed as owned, but held by the player / an owned pack /
        // an open container.
        v.holders.insert(LOOT, (PLAYER, 0));
        assert!(subject_touches_inventory(&v, LOOT));
        v.holders.insert(LOOT, (PACK, 0));
        assert!(subject_touches_inventory(&v, LOOT));
        v.holders.insert(LOOT, (CORPSE, 0));
        assert!(
            subject_touches_inventory(&v, LOOT),
            "inside the open corpse"
        );
        v.holders.insert(LOOT, (0, PLAYER));
        assert!(subject_touches_inventory(&v, LOOT), "wielded by the player");
        v.holders.insert(LOOT, (0, 0));
        v.listed.insert(LOOT);
        assert!(
            subject_touches_inventory(&v, LOOT),
            "vendor / trade listing"
        );
    }

    #[test]
    fn creatures_and_their_gear_do_not_touch_the_inventory() {
        let v = fake_world();
        assert!(!subject_touches_inventory(&v, NPC));
        assert!(
            !subject_touches_inventory(&v, NPC_SWORD),
            "wielded by an NPC"
        );
        assert!(
            !subject_touches_inventory(&v, 0x8000_0999),
            "unknown object"
        );
    }

    #[test]
    fn unknown_player_or_null_subject_keeps_the_signal() {
        let mut v = fake_world();
        assert!(subject_touches_inventory(&v, 0), "NULL subject");
        v.player = 0;
        assert!(
            subject_touches_inventory(&v, NPC),
            "player guid not known yet"
        );
    }

    /// The bug trigger: a spawn burst of creatures raised kind=11 per create.
    #[test]
    fn npc_spawn_is_quiet_but_an_item_created_into_a_pack_or_open_corpse_signals() {
        let mut v = fake_world();
        // NPC create: absent before, a bare creature after.
        v.holders.remove(&NPC);
        let pre = PreRouteSubjects::capture(&v, [NPC, 0]);
        v.holders.insert(NPC, (0, 0));
        assert_eq!(pre.before(NPC), Some(false));
        assert!(!should_signal(Some(&pre), &v, NPC));
        // Flag off: unchanged.
        assert!(should_signal(None, &v, NPC));

        // Loot created into the player's pack.
        let pre = PreRouteSubjects::capture(&v, [LOOT, 0]);
        v.holders.insert(LOOT, (PACK, 0));
        assert!(should_signal(Some(&pre), &v, LOOT));
        // ... and into the open corpse.
        v.holders.remove(&LOOT);
        let pre = PreRouteSubjects::capture(&v, [LOOT, 0]);
        v.holders.insert(LOOT, (CORPSE, 0));
        assert!(should_signal(Some(&pre), &v, LOOT));
    }

    #[test]
    fn owned_before_signals_even_when_not_owned_after() {
        let mut v = fake_world();
        let pre = PreRouteSubjects::capture(&v, [DAGGER, 0]);
        // Dropped / deleted: unfiled, no holders.
        v.owned.remove(&DAGGER);
        v.holders.insert(DAGGER, (0, 0));
        assert!(!subject_touches_inventory(&v, DAGGER));
        assert!(should_signal(Some(&pre), &v, DAGGER));
        // An item leaving the open corpse (another player looted it).
        v.holders.insert(LOOT, (CORPSE, 0));
        let pre = PreRouteSubjects::capture(&v, [LOOT, 0]);
        v.holders.remove(&LOOT);
        assert!(should_signal(Some(&pre), &v, LOOT));
    }

    #[test]
    fn an_uncaptured_subject_keeps_the_signal() {
        let v = fake_world();
        // e.g. a GameEvent: nothing captured, so every subject signals.
        let pre = PreRouteSubjects::capture(&v, [0, 0]);
        assert_eq!(pre.before(NPC), None);
        assert!(should_signal(Some(&pre), &v, NPC));
        // A captured message, but an event about another object.
        let pre = PreRouteSubjects::capture(&v, [NPC_SWORD, NPC]);
        assert_eq!(pre.before(0x8000_0999), None);
        assert!(should_signal(Some(&pre), &v, 0x8000_0999));
    }

    #[test]
    fn npc_weapon_parent_event_is_quiet_but_a_local_equip_signals() {
        let mut v = fake_world();
        let pre = PreRouteSubjects::capture(&v, [NPC_SWORD, NPC]);
        assert!(!should_signal_with_holder(Some(&pre), &v, NPC_SWORD, NPC));
        assert!(
            should_signal_with_holder(None, &v, NPC_SWORD, NPC),
            "flag off"
        );
        // The player equips a pack item: owned before, wielder = player.
        let pre = PreRouteSubjects::capture(&v, [DAGGER, PLAYER]);
        v.holders.insert(DAGGER, (0, PLAYER));
        assert!(should_signal_with_holder(Some(&pre), &v, DAGGER, PLAYER));
        // A detach whose prior wielder was the player signals on the holder
        // alone (the item itself reads unowned on both sides).
        let pre = PreRouteSubjects::capture(&v, [NPC_SWORD, 0]);
        assert!(!should_signal(Some(&pre), &v, NPC_SWORD));
        assert!(should_signal_with_holder(Some(&pre), &v, NPC_SWORD, PLAYER));
        // A NULL holder (ParentEvent detach) adds nothing.
        let pre = PreRouteSubjects::capture(&v, [NPC_SWORD, 0]);
        assert!(!should_signal_with_holder(Some(&pre), &v, NPC_SWORD, 0));
    }

    #[test]
    fn message_subjects_cover_the_per_object_families() {
        let g = Guid;
        let delete = GameMessage::ObjectDelete(Box::new(ObjectDeleteData {
            guid: g(NPC),
            instance_sequence: None,
        }));
        assert_eq!(message_subject_guids(&delete), [NPC, 0]);
        let remove = GameMessage::InventoryRemoveObject(Box::new(InventoryRemoveObjectData {
            object_guid: g(LOOT),
        }));
        assert_eq!(message_subject_guids(&remove), [LOOT, 0]);
        let parent = GameMessage::ParentEvent(Box::new(ParentEventData {
            parent_guid: g(NPC),
            child_guid: g(NPC_SWORD),
            location: 1,
            placement: 1,
            parent_instance_sequence: 1,
            child_position_sequence: 1,
        }));
        assert_eq!(message_subject_guids(&parent), [NPC_SWORD, NPC]);
        let stack = GameMessage::SetStackSize(Box::new(SetStackSizeData {
            sequence: 1,
            object_guid: g(DAGGER),
            stack_size: 2,
            value: 10,
        }));
        assert_eq!(message_subject_guids(&stack), [DAGGER, 0]);
        let public = GameMessage::PublicUpdatePropertyInt(Box::new(PublicUpdatePropertyIntData {
            sequence: 1,
            guid: g(NPC),
            property: PropertyInt::Value as u32,
            value: 5,
        }));
        assert_eq!(message_subject_guids(&public), [NPC, 0]);
        // Private updates name the player (guid 0 on the wire): no capture.
        let private =
            GameMessage::PrivateUpdatePropertyInt(Box::new(PrivateUpdatePropertyIntData {
                sequence: 1,
                guid: Guid::NULL,
                property: PropertyInt::Value as u32,
                value: 5,
            }));
        assert_eq!(message_subject_guids(&private), [0, 0]);
    }

    // ---- the WorldState adapter + the real routed handlers ----

    fn world_with_player() -> WorldState {
        let mut w = WorldState::synthetic();
        w.player.guid = Guid(PLAYER);
        w
    }

    fn insert_entity(w: &mut WorldState, guid: u32, container: u32, wielder: u32) {
        let mut entity = holtburger_world::entity::Entity::new(
            Guid(guid),
            format!("obj {guid:08X}"),
            WorldPosition::default(),
        );
        if container != 0 {
            entity.set_iid_prop(PropertyInstanceId::Container, Guid(container));
        }
        if wielder != 0 {
            entity.set_iid_prop(PropertyInstanceId::Wielder, Guid(wielder));
        }
        w.entities.insert(entity);
    }

    #[test]
    fn world_view_reads_ownership_open_containers_and_holders() {
        let mut w = world_with_player();
        insert_entity(&mut w, PACK, PLAYER, 0);
        insert_entity(&mut w, DAGGER, PACK, 0);
        insert_entity(&mut w, NPC, 0, 0);
        insert_entity(&mut w, NPC_SWORD, 0, NPC);
        insert_entity(&mut w, CORPSE, 0, 0);
        insert_entity(&mut w, LOOT, CORPSE, 0);
        w.player.add_to_inventory(Guid(PACK));
        w.player.add_to_inventory(Guid(DAGGER));
        w.open_containers.insert(Guid(CORPSE));
        let v = WorldInventoryView(&w);
        assert_eq!(v.player_guid(), PLAYER);
        assert!(v.is_owned(DAGGER) && !v.is_owned(NPC_SWORD));
        assert!(v.is_open_container(CORPSE) && !v.is_open_container(PACK));
        assert_eq!(v.holders(DAGGER), (PACK, 0));
        assert_eq!(v.holders(NPC_SWORD), (0, NPC));
        assert_eq!(v.holders(0x8000_0999), (0, 0));
        assert!(!v.is_vendor_or_trade_item(LOOT));
        assert!(subject_touches_inventory(&v, LOOT));
        assert!(!subject_touches_inventory(&v, NPC_SWORD));
    }

    /// The verifier's case: ACE's drop sends `PublicUpdateInstanceID
    /// (Container -> 0)`. Routed, the item stops being owned, so only the
    /// pre-route capture keeps the signal (and the snapshot dirty mark).
    #[test]
    fn routed_drop_signals_from_the_pre_route_capture() {
        let mut w = world_with_player();
        insert_entity(&mut w, DAGGER, PLAYER, 0);
        w.player.add_to_inventory(Guid(DAGGER));
        let msg = GameMessage::PublicUpdatePropertyInstanceId(Box::new(
            PublicUpdatePropertyInstanceIdData {
                sequence: 1,
                guid: Guid(DAGGER),
                property: PropertyInstanceId::Container as u32,
                value: Guid::NULL,
            },
        ));
        let pre = PreRouteSubjects::capture(&WorldInventoryView(&w), message_subject_guids(&msg));
        assert_eq!(pre.before(DAGGER), Some(true));
        let events = w.handle_message(&msg);
        assert!(events.iter().any(|e| matches!(
            e,
            WorldEvent::PropertiesUpdated { guid, .. } if *guid == Guid(DAGGER)
        )));
        let after = WorldInventoryView(&w);
        assert!(
            !subject_touches_inventory(&after, DAGGER),
            "after routing the dropped item is unowned; an after-only test would miss it"
        );
        assert!(should_signal(Some(&pre), &after, DAGGER));
    }

    /// The common combat/arrival case: a creature's public property update.
    #[test]
    fn routed_npc_property_update_is_quiet_with_the_flag_and_signals_without() {
        let mut w = world_with_player();
        insert_entity(&mut w, NPC, 0, 0);
        let msg = GameMessage::PublicUpdatePropertyInt(Box::new(PublicUpdatePropertyIntData {
            sequence: 1,
            guid: Guid(NPC),
            property: PropertyInt::Value as u32,
            value: 7,
        }));
        let pre = PreRouteSubjects::capture(&WorldInventoryView(&w), message_subject_guids(&msg));
        let events = w.handle_message(&msg);
        let subjects: Vec<u32> = events
            .iter()
            .filter_map(|e| match e {
                WorldEvent::PropertiesUpdated { guid, .. } => Some(u32::from(*guid)),
                _ => None,
            })
            .collect();
        assert_eq!(subjects, vec![NPC]);
        let after = WorldInventoryView(&w);
        assert!(!should_signal(Some(&pre), &after, NPC));
        assert!(should_signal(None, &after, NPC), "flag off: the old signal");
    }

    /// An owned item's delete: the routed handler unfiles it, the capture
    /// still signals.
    #[test]
    fn routed_delete_of_an_owned_item_signals() {
        let mut w = world_with_player();
        insert_entity(&mut w, PACK, PLAYER, 0);
        insert_entity(&mut w, DAGGER, PACK, 0);
        w.player.add_to_inventory(Guid(PACK));
        w.player.add_to_inventory(Guid(DAGGER));
        let msg = GameMessage::ObjectDelete(Box::new(ObjectDeleteData {
            guid: Guid(DAGGER),
            instance_sequence: None,
        }));
        let pre = PreRouteSubjects::capture(&WorldInventoryView(&w), message_subject_guids(&msg));
        let _ = w.handle_message(&msg);
        let after = WorldInventoryView(&w);
        assert!(!after.is_owned(DAGGER), "the delete unfiles the item");
        assert!(should_signal(Some(&pre), &after, DAGGER));
    }
}
