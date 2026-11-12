//! messages-objects-1 (2026-10-13) — retail's pending inventory request and
//! the line an InventoryServerSaveFailed (0x00A0) prints from it, kept as
//! pure state + functions so `cargo test -p holtburger-web --lib
//! inventory_request` covers them natively. The wasm session only calls in:
//! the `SessionCommand` arms record (`session/commands/inventory.rs`), the
//! inbound dispatcher answers (`session/messages/mod.rs`), and the 0x00A0 arm
//! (`session/messages/game_event.rs`) asks which request failed.
//!
//! Retail sources (acclient.c):
//! - `ACCWeenieObject::RecordRequest` (436753) keeps ONE pending request
//!   (`prevRequestObjectID` / `prevRequest`). The `UIAttempt*` senders
//!   (:438132-438300) set it right after their `CM_Inventory::Event_*`:
//!   merge → IR_MERGE; split to a container or to 3-D → IR_SPLIT;
//!   PutInContainer → IR_PICK_UP for an IN_3D_VIEW object, else
//!   IR_PUT_IN_CONTAINER; PutIn3D (DropItem) → IR_MOVE for an IN_3D_VIEW
//!   object, else IR_DROP; GetAndWield → IR_WIELD (the StackableSplitToWield
//!   branch records nothing); give → IR_GIVE. A vendor buy / sale records
//!   IR_SHOP_EVENT on the VENDOR (:242518, :244839).
//! - `RecordResponse` (437402) clears it iff the answer names the pending
//!   object: `ServerSaysMoveItem` (:438554 — 0x0022 / 0x0023 / 0x019A, and
//!   `ACCObjectMaint::SetWeenieDesc` :391179 for a create / update that
//!   places the object in a container or on a wielder), 0x0024
//!   InventoryRemoveObject (`ServerSaysRemove`), SetStackSize (:437519),
//!   ViewContents (:402729, not over a pending pick-up of that container),
//!   0x0052 (:394881; retail only for the open ground container) and the
//!   vendor refresh (:246698, a pending shop event on that vendor only).
//!   ObjectDelete (0xF747) also answers here, so a destroyed object never
//!   leaves a stale request behind.
//! - The 0x00A0 dispatch (:394949) blames the pending object when one is
//!   set, else the wire guid; when that object resolves,
//!   `ServerSaysAttemptFailed` (:439317) prints the request's verb plus a
//!   per-code suffix at 0x1A (an empty string shows nothing). Then
//!   `ClientCommunicationSystem::HandleFailureEvent` (:413716) prints the
//!   code's own text, except for seven codes (:394960).
//!
//! holtburger has no `IsPlayerReadyToMakeInventoryRequest` gate (:437850),
//! so two requests can be in flight at once (fast drags, the bot's loot
//! loop). A failure therefore looks up the wire guid's OWN request first and
//! only then falls back to retail's substitution; nothing is ever refused or
//! delayed here. Cross-checked against WebAC
//! packages/shared/src/inventory/InventoryRequest.ts (AGPL-3.0).

use holtburger_protocol::errors::WeenieError;
use holtburger_protocol::messages::{GameEvent, GameMessage};

/// Retail `InventoryRequest` (acclient.h:6812). IR_VIEW_AS_GROUND_CONTAINER
/// (8) is never recorded here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InventoryRequest {
    Merge = 1,
    Split = 2,
    Move = 3,
    PickUp = 4,
    PutInContainer = 5,
    Drop = 6,
    Wield = 7,
    Give = 9,
    ShopEvent = 10,
}

/// `UIAttemptPutInContainer` (acclient.c:438179): picking an object up out
/// of the 3-D world is IR_PICK_UP, any other container move
/// IR_PUT_IN_CONTAINER.
pub(crate) fn put_in_container_request(in_3d: bool) -> InventoryRequest {
    if in_3d {
        InventoryRequest::PickUp
    } else {
        InventoryRequest::PutInContainer
    }
}

/// `UIAttemptPutIn3D` (acclient.c:438208, the DropItem sender): an object
/// already in the 3-D world is IR_MOVE, a carried one IR_DROP.
pub(crate) fn drop_request(in_3d: bool) -> InventoryRequest {
    if in_3d {
        InventoryRequest::Move
    } else {
        InventoryRequest::Drop
    }
}

/// How many unanswered requests are remembered by object, beyond retail's
/// single `prevRequest` (oldest dropped first).
const MAX_IN_FLIGHT: usize = 16;

/// Retail's pending request plus the per-object requests not answered yet.
#[derive(Debug, Default)]
pub(crate) struct InventoryRequestTracker {
    /// `prevRequestObjectID` / `prevRequest`: the newest request.
    last: Option<(u32, InventoryRequest)>,
    /// Every request not answered yet, oldest first, one per object.
    in_flight: Vec<(u32, InventoryRequest)>,
    /// Auto-unequipped `(item_guid, old_equip_mask)` pairs sent right before a
    /// pending `Wield`, restored if that wield bounces with 0x00A0.
    displaced_equip: std::collections::HashMap<u32, Vec<(u32, u32)>>,
    /// Displaced equipment captured by the most recent [`Self::attempt_failed`].
    last_failed_displaced: Vec<(u32, u32)>,
}

impl InventoryRequestTracker {
    /// Track an auxiliary server action on `guid` in `in_flight` without
    /// overwriting retail's `self.last` (`prevRequestObjectID`). Used for
    /// auto-unequip `PutItemInContainer` packets sent ahead of `WieldFromPack`
    /// or `SplitStackToWield` so a `0x00A0` bounce on `conflict_guid` resolves
    /// its own `PutInContainer`, while a `0x00A0` bounce on an unrecorded
    /// `StackableSplitToWield` (`stack_guid`) is never misattributed to
    /// `conflict_guid`.
    pub(crate) fn record_in_flight(&mut self, guid: u32, request: InventoryRequest) {
        if guid == 0 {
            return;
        }
        self.in_flight.retain(|&(g, _)| g != guid);
        if self.in_flight.len() >= MAX_IN_FLIGHT {
            if let Some((evicted, _)) = self.in_flight.first().copied() {
                self.displaced_equip.remove(&evicted);
            }
            self.in_flight.remove(0);
        }
        self.in_flight.push((guid, request));
    }

    /// `RecordRequest`: `request` on object `guid` is now the pending one.
    pub(crate) fn record(&mut self, guid: u32, request: InventoryRequest) {
        if guid == 0 {
            return;
        }
        self.record_in_flight(guid, request);
        self.last = Some((guid, request));
    }

    /// Remember equipment auto-unequipped ahead of `guid`'s `Wield` request so
    /// a server-side 0x00A0 rejection can re-wield those items.
    pub(crate) fn record_displaced_equip(&mut self, guid: u32, displaced: Vec<(u32, u32)>) {
        if guid == 0 {
            return;
        }
        if displaced.is_empty() {
            self.displaced_equip.remove(&guid);
        } else {
            self.displaced_equip.insert(guid, displaced);
        }
    }

    /// Drain the auto-unequipped `(guid, equip_mask)` list captured when the
    /// last [`Self::attempt_failed`] answered a bounced `Wield`.
    pub(crate) fn take_failed_displaced(&mut self) -> Vec<(u32, u32)> {
        std::mem::take(&mut self.last_failed_displaced)
    }

    /// The unanswered request on object `guid`, if any.
    pub(crate) fn pending(&self, guid: u32) -> Option<InventoryRequest> {
        self.in_flight
            .iter()
            .find(|&&(g, _)| g == guid)
            .map(|&(_, r)| r)
            .or_else(|| self.last.filter(|&(g, _)| g == guid).map(|(_, r)| r))
    }

    /// `RecordResponse`: the server answered object `guid`; clears its
    /// request (and retail's pending one when it is that object). Returns
    /// whether anything was pending on it.
    pub(crate) fn respond(&mut self, guid: u32) -> bool {
        self.displaced_equip.remove(&guid);
        let before = self.in_flight.len();
        self.in_flight.retain(|&(g, _)| g != guid);
        let mut cleared = self.in_flight.len() != before;
        if matches!(self.last, Some((g, _)) if g == guid) {
            self.last = None;
            cleared = true;
        }
        cleared
    }

    /// The retail `RecordResponse` sites an inbound message reaches (see the
    /// module doc). The 0x00A0 failure itself is [`Self::attempt_failed`].
    pub(crate) fn observe_response(&mut self, message: &GameMessage) {
        let guid = match message {
            GameMessage::GameEvent(event) => match &event.event {
                GameEvent::InventoryPutObjInContainer(d) => d.item_guid.0,
                GameEvent::WieldObject(d) => d.object_guid.0,
                GameEvent::InventoryPutObjectIn3D(d) => d.object_guid.0,
                GameEvent::CloseGroundContainer(d) => d.container_guid.0,
                GameEvent::ViewContents(d) => {
                    // :402729 — not while that container's pick-up is pending.
                    let guid = d.container.0;
                    if self.pending(guid) != Some(InventoryRequest::PickUp) {
                        self.respond(guid);
                    }
                    return;
                }
                GameEvent::ApproachVendor(d) => {
                    // :246698 — only a shop event pending on that vendor.
                    let guid = d.vendor_guid.0;
                    if self.pending(guid) == Some(InventoryRequest::ShopEvent) {
                        self.respond(guid);
                    }
                    return;
                }
                _ => return,
            },
            GameMessage::InventoryRemoveObject(d) => d.object_guid.0,
            GameMessage::SetStackSize(d) => d.object_guid.0,
            GameMessage::ObjectDelete(d) => d.guid.0,
            GameMessage::PublicUpdatePropertyInstanceId(d) => {
                use holtburger_common::properties::PropertyInstanceId;
                if d.guid.0 == 0
                    || !matches!(
                        PropertyInstanceId::from_repr(d.property),
                        Some(PropertyInstanceId::Container | PropertyInstanceId::Wielder)
                    )
                {
                    return;
                }
                d.guid.0
            }
            GameMessage::ObjectCreate(d) | GameMessage::UpdateObject(d) => {
                // SetWeenieDesc moves the object (and so answers it) when
                // the new desc puts it in a container or on a wielder.
                let desc = &d.public_weenie_desc;
                let placed = |g: Option<holtburger_common::Guid>| g.is_some_and(|g| g.0 != 0);
                if !placed(desc.container_id) && !placed(desc.wielder_id) {
                    return;
                }
                desc.guid.0
            }
            _ => return,
        };
        self.respond(guid);
    }

    /// The 0x00A0 dispatch's choice of failed object and request, which it
    /// then answers: the wire guid's own request first, else retail's
    /// pending one (`prevRequestObjectID` substitution — ACE's refused shop
    /// event names the player), else the wire guid with no request. (Retail
    /// clears inside `ServerSaysAttemptFailed`, i.e. only when the object
    /// resolves; this always answers, so no stale request outlives it.)
    pub(crate) fn attempt_failed(&mut self, wire_guid: u32) -> (u32, Option<InventoryRequest>) {
        let own = self
            .in_flight
            .iter()
            .find(|&&(g, _)| g == wire_guid)
            .map(|&(_, r)| r);
        let chosen = if let Some(request) = own {
            (wire_guid, Some(request))
        } else if self.displaced_equip.contains_key(&wire_guid) {
            (wire_guid, None)
        } else if let Some((guid, request)) = self.last {
            (guid, Some(request))
        } else {
            (wire_guid, None)
        };
        self.last_failed_displaced = if chosen.1 == Some(InventoryRequest::Wield)
            || (chosen.1.is_none() && chosen.0 == wire_guid)
        {
            self.displaced_equip.remove(&chosen.0).unwrap_or_default()
        } else {
            self.displaced_equip.remove(&chosen.0);
            for list in self.displaced_equip.values_mut() {
                list.retain(|&(g, _)| g != chosen.0);
            }
            Vec::new()
        };
        self.respond(chosen.0);
        chosen
    }
}

/// Normalize a `GetAndWieldItem` equip mask to a valid retail target mask:
/// - `0`, single-bit masks, and pure wearable coverage masks (`0x0800_7FFF`
///   armor + clothing + cloak) pass through unchanged.
/// - Multi-bit bracelet (`0x0003_0000`) / ring (`0x000C_0000`) masks pick the
///   first unoccupied slot in retail `AutoSort` order (Right -> Left), falling
///   back to Right (`0x0002_0000` / `0x0008_0000`).
/// - Multi-bit Aetheria sigil masks (`0x7000_0000`) pick the first unlocked
///   and unoccupied sigil slot in `AutoWield` order (`0x1000_0000` ->
///   `0x2000_0000` -> `0x4000_0000`), falling back to the first unlocked slot.
/// - Multi-bit weapon masks (e.g. `MELEE_WEAPON | SHIELD` `0x0030_0000`) pick
///   their primary weapon bit (`0x0350_0000`), else the lowest set bit.
#[allow(dead_code)]
pub(crate) fn normalize_wield_mask(mask: u32, worn_mask: u32) -> u32 {
    normalize_wield_mask_with_aetheria(mask, worn_mask, None)
}

pub(crate) fn normalize_wield_mask_with_aetheria(
    mask: u32,
    worn_mask: u32,
    aetheria_bits: Option<u32>,
) -> u32 {
    const PURE_WEARABLE: u32 = 0x0800_7FFF;
    const WRIST_L: u32 = 0x0001_0000;
    const WRIST_R: u32 = 0x0002_0000;
    const WRIST_BOTH: u32 = WRIST_L | WRIST_R;
    const RING_L: u32 = 0x0004_0000;
    const RING_R: u32 = 0x0008_0000;
    const RING_BOTH: u32 = RING_L | RING_R;
    const SIGIL_1: u32 = 0x1000_0000;
    const SIGIL_2: u32 = 0x2000_0000;
    const SIGIL_3: u32 = 0x4000_0000;
    const SIGIL_ALL: u32 = SIGIL_1 | SIGIL_2 | SIGIL_3;
    const PRIMARY_WEAPONS: u32 = 0x0350_0000;

    if mask == 0 || mask.is_power_of_two() || (mask & !PURE_WEARABLE) == 0 {
        return mask;
    }
    if mask == WRIST_BOTH {
        return if (worn_mask & WRIST_R) == 0 {
            WRIST_R
        } else if (worn_mask & WRIST_L) == 0 {
            WRIST_L
        } else {
            WRIST_R
        };
    }
    if mask == RING_BOTH {
        return if (worn_mask & RING_R) == 0 {
            RING_R
        } else if (worn_mask & RING_L) == 0 {
            RING_L
        } else {
            RING_R
        };
    }
    if (mask & SIGIL_ALL) != 0 && (mask & !SIGIL_ALL) == 0 {
        let unlocked = aetheria_bits.unwrap_or(0x7);
        let sigils = [(SIGIL_1, 0x1u32), (SIGIL_2, 0x2u32), (SIGIL_3, 0x4u32)];
        for (slot, ubit) in sigils {
            if (mask & slot) != 0 && (unlocked & ubit) != 0 && (worn_mask & slot) == 0 {
                return slot;
            }
        }
        for (slot, ubit) in sigils {
            if (mask & slot) != 0 && (unlocked & ubit) != 0 {
                return slot;
            }
        }
        return mask & mask.wrapping_neg();
    }
    let primary = mask & PRIMARY_WEAPONS;
    if primary != 0 {
        return primary & primary.wrapping_neg();
    }
    mask & mask.wrapping_neg()
}

/// The name fields `ACCWeenieObject::GetObjectName` (acclient.c:439093)
/// reads. (Its material-name prefix is not applied.)
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ObjectNames {
    pub(crate) name: String,
    pub(crate) plural_name: String,
    pub(crate) stack_size: u32,
}

impl ObjectNames {
    /// NAME_PLURAL: the PluralName, else the name + "s" ("es" after a
    /// trailing `s`).
    pub(crate) fn plural(&self) -> String {
        if !self.plural_name.is_empty() {
            self.plural_name.clone()
        } else if self.name.is_empty() {
            String::new()
        } else if self.name.ends_with('s') {
            format!("{}es", self.name)
        } else {
            format!("{}s", self.name)
        }
    }

    /// NAME_APPROPRIATE: the plural for a stack of more than one, else the
    /// name.
    pub(crate) fn appropriate(&self) -> String {
        if self.stack_size > 1 {
            self.plural()
        } else {
            self.name.clone()
        }
    }
}

/// `ServerSaysAttemptFailed`'s per-code suffix (acclient.c:439416-439480).
pub(crate) fn attempt_failed_suffix(code: u32) -> &'static str {
    match code {
        0x1D => " - you're too busy",
        0x20 => " - you must control both objects",
        0x28 => " - the item is under someone else's control",
        0x2A => " - you are too encumbered",
        0x36 => " - action cancelled",
        0x37..=0x39 => " - unable to move to object",
        0x3EE => " - the container is closed",
        _ => "",
    }
}

/// `ServerSaysAttemptFailed`'s 0x1A string: the verb for the pending
/// `request` (merge / split name the plural, the rest the appropriate name;
/// a shop event or no request has none) plus the code's suffix. Empty =
/// retail shows nothing.
pub(crate) fn attempt_failed_text(
    request: Option<InventoryRequest>,
    code: u32,
    names: &ObjectNames,
) -> String {
    use InventoryRequest as R;
    let mut text = match request {
        Some(R::Merge) => format!("The {} can't be merged", names.plural()),
        Some(R::Split) => format!("The {} can't be split", names.plural()),
        Some(R::Move) => format!("The {} can't be moved", names.appropriate()),
        Some(R::PickUp) => format!("The {} can't be picked up", names.appropriate()),
        Some(R::PutInContainer) => {
            format!("The {} can't be put in the container", names.appropriate())
        }
        Some(R::Drop) => format!("The {} can't be dropped", names.appropriate()),
        Some(R::Wield) => format!("The {} can't be wielded", names.appropriate()),
        Some(R::Give) => format!("The {} can't be given", names.appropriate()),
        Some(R::ShopEvent) | None => String::new(),
    };
    text.push_str(attempt_failed_suffix(code));
    text
}

/// The codes the 0x00A0 dispatch keeps out of `HandleFailureEvent`
/// (acclient.c:394960: 1086, 1130, 1231, 1007, 43, 30, 1230 — the
/// name-templated gift / carry refusals).
pub(crate) fn skips_failure_event(code: u32) -> bool {
    matches!(code, 0x1E | 0x2B | 0x3EF | 0x43E | 0x46A | 0x4CE | 0x4CF)
}

/// The JS chat categories the lines are pushed at: the numbers of lib.rs's
/// wasm-only `CHAT_CATEGORY_SYSTEM` / `_MAGIC` / `_TRANSIENT`
/// (`session/messages/game_event.rs` asserts they agree at compile time).
pub(crate) const LINE_CATEGORY_SYSTEM: u32 = 0;
pub(crate) const LINE_CATEGORY_MAGIC: u32 = 7;
pub(crate) const LINE_CATEGORY_TRANSIENT: u32 = 9;

/// Everything an InventoryServerSaveFailed prints: the composed
/// `ServerSaysAttemptFailed` string (`""` when retail shows nothing, or when
/// the failed object is unknown — `names` = None, retail skips the call) and
/// the chat lines `(text, category)` in order — that string at Transient
/// (0x1A), then the code's `HandleFailureEvent` text at its retail text type
/// (`holtburger_core::errors::retail_failure_line`: only a code retail has a
/// case for, so code 0 and ACE-only codes add nothing) unless the dispatch
/// skips the code.
pub(crate) fn attempt_failed_lines(
    request: Option<InventoryRequest>,
    error: WeenieError,
    names: Option<&ObjectNames>,
) -> (String, Vec<(String, u32)>) {
    let code = error as u32;
    let text = names
        .map(|n| attempt_failed_text(request, code, n))
        .unwrap_or_default();
    let mut lines = Vec::new();
    if !text.is_empty() {
        lines.push((text.clone(), LINE_CATEGORY_TRANSIENT));
    }
    if !skips_failure_event(code)
        && let Some(failure) = holtburger_core::errors::retail_failure_line(code, None)
    {
        let category = if holtburger_core::errors::retail_failure_text_type(error) == Some(0x1A) {
            LINE_CATEGORY_TRANSIENT
        } else if holtburger_core::errors::retail_text_type(error) == Some(7) {
            LINE_CATEGORY_MAGIC
        } else {
            LINE_CATEGORY_SYSTEM
        };
        lines.push((failure, category));
    }
    (text, lines)
}

/// Parse `?retailAttemptFailed=off` (or `&…`). DEFAULT-ON off-escape shape
/// (`off`/`0`/`false`); `=off` restores the pre-fix 0x00A0 output — the
/// Debug-label kind=48 payload and `chat_format::inventory_save_failed_chat_line`.
pub(crate) fn retail_attempt_failed_enabled(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "retailAttemptFailed=off" | "retailAttemptFailed=0" | "retailAttemptFailed=false"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Guid;
    use holtburger_protocol::messages::{
        ApproachVendorEventData, GameEventMessage, InventoryPutObjectIn3DEventData,
        InventoryRemoveObjectData, ObjectDescriptionData, PublicWeenieDescription,
        ViewContentsEventData,
    };

    const PLAYER: u32 = 0x5000_0001;
    const VENDOR: u32 = 0x8000_0100;
    const ITEM_A: u32 = 0x8000_0A01;
    const ITEM_B: u32 = 0x8000_0B02;

    fn pyreal() -> ObjectNames {
        ObjectNames {
            name: "Pyreal".to_string(),
            plural_name: "Pyreals".to_string(),
            stack_size: 1,
        }
    }

    fn event(event: GameEvent) -> GameMessage {
        GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(PLAYER),
            sequence: 1,
            event,
        }))
    }

    fn update_object(guid: u32, container: Option<u32>) -> GameMessage {
        GameMessage::UpdateObject(Box::new(ObjectDescriptionData {
            public_weenie_desc: PublicWeenieDescription {
                guid: Guid(guid),
                container_id: container.map(Guid),
                ..PublicWeenieDescription::default()
            },
            ..ObjectDescriptionData::default()
        }))
    }

    #[test]
    fn a_failed_pickup_names_the_item() {
        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, put_in_container_request(true));
        let (guid, request) = t.attempt_failed(ITEM_A);
        assert_eq!((guid, request), (ITEM_A, Some(InventoryRequest::PickUp)));
        let (line, lines) = attempt_failed_lines(request, WeenieError::None, Some(&pyreal()));
        assert_eq!(line, "The Pyreal can't be picked up");
        assert_eq!(lines, vec![(line, LINE_CATEGORY_TRANSIENT)]);
        assert_eq!(t.pending(ITEM_A), None, "the failure answers the request");
    }

    #[test]
    fn action_cancelled_adds_the_suffix_and_the_failure_text() {
        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, put_in_container_request(true));
        let (_, request) = t.attempt_failed(ITEM_A);
        let (line, lines) =
            attempt_failed_lines(request, WeenieError::ActionCancelled, Some(&pyreal()));
        assert_eq!(line, "The Pyreal can't be picked up - action cancelled");
        assert_eq!(
            lines,
            vec![
                (line, LINE_CATEGORY_TRANSIENT),
                ("Action cancelled!".to_string(), LINE_CATEGORY_TRANSIENT),
            ]
        );
        let (busy, busy_lines) = attempt_failed_lines(
            Some(InventoryRequest::Wield),
            WeenieError::YoureTooBusy,
            Some(&pyreal()),
        );
        assert_eq!(busy, "The Pyreal can't be wielded - you're too busy");
        assert_eq!(busy_lines[1], ("You're too busy!".to_string(), LINE_CATEGORY_TRANSIENT));
    }

    #[test]
    fn every_verb_and_its_name_type() {
        use InventoryRequest as R;
        let stack = ObjectNames {
            name: "Arrow".to_string(),
            plural_name: String::new(),
            stack_size: 1,
        };
        // Merge / split always name the plural (NAME_PLURAL), even for one.
        assert_eq!(attempt_failed_text(Some(R::Merge), 0, &stack), "The Arrows can't be merged");
        assert_eq!(attempt_failed_text(Some(R::Split), 0, &stack), "The Arrows can't be split");
        assert_eq!(attempt_failed_text(Some(R::Move), 0, &stack), "The Arrow can't be moved");
        assert_eq!(attempt_failed_text(Some(R::PickUp), 0, &stack), "The Arrow can't be picked up");
        assert_eq!(
            attempt_failed_text(Some(R::PutInContainer), 0, &stack),
            "The Arrow can't be put in the container"
        );
        assert_eq!(attempt_failed_text(Some(R::Drop), 0, &stack), "The Arrow can't be dropped");
        assert_eq!(attempt_failed_text(Some(R::Wield), 0, &stack), "The Arrow can't be wielded");
        assert_eq!(attempt_failed_text(Some(R::Give), 0, &stack), "The Arrow can't be given");
        assert_eq!(attempt_failed_text(Some(R::ShopEvent), 0, &stack), "");
        assert_eq!(attempt_failed_text(None, 0, &stack), "");
        // NAME_APPROPRIATE: the plural for a stack of more than one.
        let many = ObjectNames { stack_size: 25, ..pyreal() };
        assert_eq!(attempt_failed_text(Some(R::Drop), 0, &many), "The Pyreals can't be dropped");
        assert_eq!(
            attempt_failed_text(Some(R::Merge), 0, &pyreal()),
            "The Pyreals can't be merged"
        );
        // No PluralName: "es" after a trailing s.
        let glass = ObjectNames {
            name: "Glass".to_string(),
            ..ObjectNames::default()
        };
        assert_eq!(glass.plural(), "Glasses");
        assert_eq!(ObjectNames::default().plural(), "");
    }

    #[test]
    fn suffixes_by_code() {
        assert_eq!(attempt_failed_suffix(0x1D), " - you're too busy");
        assert_eq!(attempt_failed_suffix(0x20), " - you must control both objects");
        assert_eq!(attempt_failed_suffix(0x28), " - the item is under someone else's control");
        assert_eq!(attempt_failed_suffix(0x2A), " - you are too encumbered");
        assert_eq!(attempt_failed_suffix(0x36), " - action cancelled");
        for code in 0x37..=0x39 {
            assert_eq!(attempt_failed_suffix(code), " - unable to move to object");
        }
        assert_eq!(attempt_failed_suffix(0x3EE), " - the container is closed");
        assert_eq!(attempt_failed_suffix(0), "");
        assert_eq!(attempt_failed_suffix(0x426), "");
    }

    #[test]
    fn a_refused_shop_event_naming_the_player_adds_no_line() {
        let mut t = InventoryRequestTracker::default();
        t.record(VENDOR, InventoryRequest::ShopEvent);
        // ACE names the PLAYER; retail substitutes the pending vendor.
        let (guid, request) = t.attempt_failed(PLAYER);
        assert_eq!((guid, request), (VENDOR, Some(InventoryRequest::ShopEvent)));
        let vendor = ObjectNames {
            name: "Shopkeeper".to_string(),
            ..ObjectNames::default()
        };
        assert_eq!(
            attempt_failed_lines(request, WeenieError::None, Some(&vendor)),
            (String::new(), Vec::new())
        );
        assert_eq!(t.pending(VENDOR), None);
    }

    #[test]
    fn two_requests_in_flight_blame_the_wire_guids_own() {
        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, put_in_container_request(true));
        t.record(ITEM_B, drop_request(false));
        // Retail would substitute B (the newest); the wire names A.
        let (guid, request) = t.attempt_failed(ITEM_A);
        assert_eq!((guid, request), (ITEM_A, Some(InventoryRequest::PickUp)));
        assert_eq!(t.pending(ITEM_B), Some(InventoryRequest::Drop), "B stays pending");
        assert_eq!(t.pending(ITEM_A), None);
        let (guid, request) = t.attempt_failed(ITEM_B);
        assert_eq!((guid, request), (ITEM_B, Some(InventoryRequest::Drop)));
    }

    #[test]
    fn a_name_templated_code_skips_the_failure_event() {
        // 0x3EF IsNotAcceptingGiftsRightNow has a HandleFailureEvent case,
        // but the 0x00A0 dispatch never reaches it.
        let (line, lines) = attempt_failed_lines(
            Some(InventoryRequest::Give),
            WeenieError::IsNotAcceptingGiftsRightNow,
            Some(&pyreal()),
        );
        assert_eq!(line, "The Pyreal can't be given");
        assert_eq!(lines, vec![(line, LINE_CATEGORY_TRANSIENT)]);
        for code in [0x1E, 0x2B, 0x3EF, 0x43E, 0x46A, 0x4CE, 0x4CF] {
            assert!(skips_failure_event(code), "{code:#X}");
        }
        assert!(!skips_failure_event(0x36));
    }

    #[test]
    fn nothing_pending_and_code_zero_prints_nothing() {
        let mut t = InventoryRequestTracker::default();
        let (guid, request) = t.attempt_failed(ITEM_A);
        assert_eq!((guid, request), (ITEM_A, None));
        assert_eq!(
            attempt_failed_lines(request, WeenieError::None, Some(&pyreal())),
            (String::new(), Vec::new())
        );
        // No request, a suffix code: retail prints the bare suffix, then the
        // HandleFailureEvent text.
        let (line, lines) =
            attempt_failed_lines(None, WeenieError::TheContainerIsClosed, Some(&pyreal()));
        assert_eq!(line, " - the container is closed");
        assert_eq!(lines[1], ("The container is closed!".to_string(), LINE_CATEGORY_TRANSIENT));
    }

    #[test]
    fn an_unknown_object_prints_only_the_failure_event() {
        let (line, lines) = attempt_failed_lines(
            Some(InventoryRequest::PickUp),
            WeenieError::ActionCancelled,
            None,
        );
        assert_eq!(line, "");
        assert_eq!(lines, vec![("Action cancelled!".to_string(), LINE_CATEGORY_TRANSIENT)]);
        // An ACE-only code with no HandleFailureEvent case adds nothing.
        let (_, lines) = attempt_failed_lines(
            Some(InventoryRequest::Drop),
            WeenieError::AttunedItem,
            Some(&pyreal()),
        );
        let dropped = "The Pyreal can't be dropped".to_string();
        assert_eq!(lines, vec![(dropped, LINE_CATEGORY_TRANSIENT)]);
    }

    #[test]
    fn responses_clear_the_answered_request() {
        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, InventoryRequest::Drop);
        t.record(ITEM_B, InventoryRequest::Give);
        t.observe_response(&GameMessage::InventoryRemoveObject(Box::new(
            InventoryRemoveObjectData { object_guid: Guid(ITEM_B) },
        )));
        assert_eq!(t.pending(ITEM_B), None);
        assert_eq!(t.pending(ITEM_A), Some(InventoryRequest::Drop), "other objects untouched");
        t.observe_response(&event(GameEvent::InventoryPutObjectIn3D(Box::new(
            InventoryPutObjectIn3DEventData { object_guid: Guid(ITEM_A) },
        ))));
        assert_eq!(t.pending(ITEM_A), None);
        // Nothing left: a failure now names the wire guid with no request.
        assert_eq!(t.attempt_failed(ITEM_A), (ITEM_A, None));
    }

    #[test]
    fn create_or_update_answers_only_a_placed_object() {
        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, InventoryRequest::PickUp);
        // A ground-object update (no container, no wielder) moves nothing.
        t.observe_response(&update_object(ITEM_A, None));
        assert_eq!(t.pending(ITEM_A), Some(InventoryRequest::PickUp));
        t.observe_response(&update_object(ITEM_A, Some(PLAYER)));
        assert_eq!(t.pending(ITEM_A), None);
    }

    #[test]
    fn view_contents_and_vendor_refresh_rules() {
        let mut t = InventoryRequestTracker::default();
        let chest = 0x8000_0C03;
        let view = |guid: u32| {
            event(GameEvent::ViewContents(Box::new(ViewContentsEventData {
                container: Guid(guid),
                items: Vec::new(),
            })))
        };
        // Picking a pack up: its own ViewContents does not answer it.
        t.record(chest, InventoryRequest::PickUp);
        t.observe_response(&view(chest));
        assert_eq!(t.pending(chest), Some(InventoryRequest::PickUp));
        t.record(chest, InventoryRequest::PutInContainer);
        t.observe_response(&view(chest));
        assert_eq!(t.pending(chest), None);
        // The vendor refresh answers only a pending shop event.
        let vendor_info = event(GameEvent::ApproachVendor(Box::new(ApproachVendorEventData {
            vendor_guid: Guid(VENDOR),
            ..ApproachVendorEventData::default()
        })));
        t.record(VENDOR, InventoryRequest::Give);
        t.observe_response(&vendor_info);
        assert_eq!(t.pending(VENDOR), Some(InventoryRequest::Give));
        t.record(VENDOR, InventoryRequest::ShopEvent);
        t.observe_response(&vendor_info);
        assert_eq!(t.pending(VENDOR), None);
    }

    #[test]
    fn record_keeps_one_request_per_object_and_stays_bounded() {
        let mut t = InventoryRequestTracker::default();
        t.record(0, InventoryRequest::Drop);
        assert_eq!(t.attempt_failed(0), (0, None), "guid 0 is never recorded");
        t.record(ITEM_A, InventoryRequest::Split);
        t.record(ITEM_A, InventoryRequest::Merge);
        assert_eq!(t.pending(ITEM_A), Some(InventoryRequest::Merge));
        for i in 0..(MAX_IN_FLIGHT as u32 + 4) {
            t.record(0x8001_0000 + i, InventoryRequest::Give);
        }
        assert_eq!(t.in_flight.len(), MAX_IN_FLIGHT);
        assert_eq!(t.pending(ITEM_A), None, "the oldest request is dropped first");
        assert!(t.respond(0x8001_0000 + MAX_IN_FLIGHT as u32 + 3));
        assert!(!t.respond(ITEM_B));
    }

    #[test]
    fn position_picks_the_retail_request() {
        assert_eq!(put_in_container_request(true), InventoryRequest::PickUp);
        assert_eq!(put_in_container_request(false), InventoryRequest::PutInContainer);
        assert_eq!(drop_request(true), InventoryRequest::Move);
        assert_eq!(drop_request(false), InventoryRequest::Drop);
    }

    #[test]
    fn retail_attempt_failed_escape() {
        assert!(retail_attempt_failed_enabled(""));
        assert!(retail_attempt_failed_enabled("?diag=1"));
        assert!(retail_attempt_failed_enabled("?retailAttemptFailed=on"));
        assert!(!retail_attempt_failed_enabled("?retailAttemptFailed=off"));
        assert!(!retail_attempt_failed_enabled("?a=1&retailAttemptFailed=0"));
        assert!(!retail_attempt_failed_enabled("retailAttemptFailed=false"));
    }

    #[test]
    fn normalize_wield_mask_preserves_wearables_and_resolves_jewelry_or_weapons() {
        assert_eq!(normalize_wield_mask(0, 0), 0);
        // Single-bit mask stays unchanged.
        assert_eq!(normalize_wield_mask(0x0020_0000, 0), 0x0020_0000);
        // Multi-bit pure wearable (robe/coat) keeps all coverage bits.
        assert_eq!(normalize_wield_mask(0x0000_1A00, 0), 0x0000_1A00);
        assert_eq!(normalize_wield_mask(0x0800_0002, 0), 0x0800_0002);
        // Bracelets: R (0x0002_0000) first, then L (0x0001_0000).
        assert_eq!(normalize_wield_mask(0x0003_0000, 0), 0x0002_0000);
        assert_eq!(normalize_wield_mask(0x0003_0000, 0x0002_0000), 0x0001_0000);
        assert_eq!(normalize_wield_mask(0x0003_0000, 0x0003_0000), 0x0002_0000);
        // Rings: R (0x0008_0000) first, then L (0x0004_0000).
        assert_eq!(normalize_wield_mask(0x000C_0000, 0), 0x0008_0000);
        assert_eq!(normalize_wield_mask(0x000C_0000, 0x0008_0000), 0x0004_0000);
        // Dual-wield weapon mask (MELEE_WEAPON | SHIELD) picks MELEE_WEAPON.
        assert_eq!(normalize_wield_mask(0x0030_0000, 0), 0x0010_0000);
        // Multi-slot Aetheria sigils (0x7000_0000) pick the first unlocked &
        // unoccupied slot in Blue -> Yellow -> Red order.
        assert_eq!(normalize_wield_mask(0x7000_0000, 0), 0x1000_0000);
        assert_eq!(normalize_wield_mask(0x7000_0000, 0x1000_0000), 0x2000_0000);
        assert_eq!(normalize_wield_mask(0x7000_0000, 0x3000_0000), 0x4000_0000);
        assert_eq!(
            normalize_wield_mask_with_aetheria(0x7000_0000, 0, Some(0x2)),
            0x2000_0000
        );
        assert_eq!(
            normalize_wield_mask_with_aetheria(0x7000_0000, 0x2000_0000, Some(0x6)),
            0x4000_0000
        );
        assert_eq!(
            normalize_wield_mask_with_aetheria(0x7000_0000, 0x6000_0000, Some(0x6)),
            0x2000_0000
        );
    }

    #[test]
    fn displaced_equip_is_returned_only_when_wield_attempt_fails() {
        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, InventoryRequest::Wield);
        t.record_displaced_equip(ITEM_A, vec![(ITEM_B, 0x0020_0000)]);
        assert_eq!(
            t.attempt_failed(ITEM_A),
            (ITEM_A, Some(InventoryRequest::Wield))
        );
        assert_eq!(t.take_failed_displaced(), vec![(ITEM_B, 0x0020_0000)]);
        assert!(t.take_failed_displaced().is_empty());

        // When answered normally, displaced_equip is cleared and never replayed.
        t.record(ITEM_A, InventoryRequest::Wield);
        t.record_displaced_equip(ITEM_A, vec![(ITEM_B, 0x0010_0000)]);
        assert!(t.respond(ITEM_A));
        assert_eq!(t.attempt_failed(ITEM_A), (ITEM_A, None));
        assert!(t.take_failed_displaced().is_empty());
    }

    #[test]
    fn public_update_property_instance_id_answers_container_or_wielder() {
        use holtburger_common::properties::PropertyInstanceId;
        use holtburger_protocol::messages::PublicUpdatePropertyInstanceIdData;

        let mut t = InventoryRequestTracker::default();
        t.record(ITEM_A, InventoryRequest::Drop);
        // Non-placement InstanceId (e.g. Owner = 1) does not answer.
        t.observe_response(&GameMessage::PublicUpdatePropertyInstanceId(Box::new(
            PublicUpdatePropertyInstanceIdData {
                sequence: 1,
                guid: Guid(ITEM_A),
                property: PropertyInstanceId::Owner as u32,
                value: Guid::NULL,
            },
        )));
        assert_eq!(t.pending(ITEM_A), Some(InventoryRequest::Drop));
        // Container (2) answers the pending Drop.
        t.observe_response(&GameMessage::PublicUpdatePropertyInstanceId(Box::new(
            PublicUpdatePropertyInstanceIdData {
                sequence: 2,
                guid: Guid(ITEM_A),
                property: PropertyInstanceId::Container as u32,
                value: Guid::NULL,
            },
        )));
        assert_eq!(t.pending(ITEM_A), None);
    }

    #[test]
    fn recorded_conflict_unequip_bounce_does_not_steal_pending_wield() {
        const OLD_SHIELD: u32 = 0x8000_00AA;
        const NEW_BOW: u32 = 0x8000_00BB;
        let mut t = InventoryRequestTracker::default();

        // WieldFromPack records PutInContainer on conflict_guid in-flight ahead of Wield on item_guid.
        t.record_in_flight(OLD_SHIELD, InventoryRequest::PutInContainer);
        t.record(NEW_BOW, InventoryRequest::Wield);
        t.record_displaced_equip(NEW_BOW, vec![(OLD_SHIELD, 0x0020_0000)]);

        // If PutInContainer(OLD_SHIELD) bounces with 0x00A0, it answers OLD_SHIELD's
        // PutInContainer without stealing self.last (NEW_BOW's Wield) or emitting
        // a bogus re-wield restore while OLD_SHIELD never unequipped.
        assert_eq!(
            t.attempt_failed(OLD_SHIELD),
            (OLD_SHIELD, Some(InventoryRequest::PutInContainer))
        );
        assert!(t.take_failed_displaced().is_empty());
        assert_eq!(t.pending(NEW_BOW), Some(InventoryRequest::Wield));

        // When NEW_BOW subsequently bounces too, OLD_SHIELD was pruned from displaced_equip.
        assert_eq!(
            t.attempt_failed(NEW_BOW),
            (NEW_BOW, Some(InventoryRequest::Wield))
        );
        assert!(t.take_failed_displaced().is_empty());

        // Conversely, when PutInContainer(OLD_SHIELD) succeeds and NEW_BOW bounces,
        // OLD_SHIELD IS returned for re-wield restore.
        t.record_in_flight(OLD_SHIELD, InventoryRequest::PutInContainer);
        t.record(NEW_BOW, InventoryRequest::Wield);
        t.record_displaced_equip(NEW_BOW, vec![(OLD_SHIELD, 0x0020_0000)]);
        assert!(t.respond(OLD_SHIELD));
        assert_eq!(t.pending(NEW_BOW), Some(InventoryRequest::Wield));
        assert_eq!(
            t.attempt_failed(NEW_BOW),
            (NEW_BOW, Some(InventoryRequest::Wield))
        );
        assert_eq!(t.take_failed_displaced(), vec![(OLD_SHIELD, 0x0020_0000)]);
    }

    #[test]
    fn split_stack_to_wield_conflict_neither_steals_last_nor_drops_displaced_restore() {
        const OLD_DART: u32 = 0x8000_00CC;
        const DART_STACK: u32 = 0x8000_00DD;
        let mut t = InventoryRequestTracker::default();

        // SplitStackToWield records conflict PutInContainer via `record_in_flight`
        // and records NO request on `DART_STACK` (`acclient.c:438132`).
        t.record_in_flight(OLD_DART, InventoryRequest::PutInContainer);
        t.record_displaced_equip(DART_STACK, vec![(OLD_DART, 0x0040_0000)]);

        // Case 1: StackableSplitToWield bounces BEFORE OLD_DART's unequip answers.
        // Because `record_in_flight` left `self.last = None`, `attempt_failed(DART_STACK)`
        // returns `(DART_STACK, None)` instead of falsely blaming `OLD_DART`!
        assert_eq!(t.attempt_failed(DART_STACK), (DART_STACK, None));
        assert_eq!(t.take_failed_displaced(), vec![(OLD_DART, 0x0040_0000)]);
        assert_eq!(t.pending(OLD_DART), Some(InventoryRequest::PutInContainer));
        assert!(t.respond(OLD_DART));

        // Case 2: OLD_DART unequips first, then StackableSplitToWield bounces -> restores OLD_DART.
        t.record_in_flight(OLD_DART, InventoryRequest::PutInContainer);
        t.record_displaced_equip(DART_STACK, vec![(OLD_DART, 0x0040_0000)]);
        assert!(t.respond(OLD_DART));
        assert_eq!(t.attempt_failed(DART_STACK), (DART_STACK, None));
        assert_eq!(t.take_failed_displaced(), vec![(OLD_DART, 0x0040_0000)]);

        // Case 3: OLD_DART's unequip bounces (`0x00A0(OLD_DART)`), then StackableSplitToWield bounces ->
        // OLD_DART was pruned from `displaced_equip` because it never unequipped.
        t.record_in_flight(OLD_DART, InventoryRequest::PutInContainer);
        t.record_displaced_equip(DART_STACK, vec![(OLD_DART, 0x0040_0000)]);
        assert_eq!(
            t.attempt_failed(OLD_DART),
            (OLD_DART, Some(InventoryRequest::PutInContainer))
        );
        assert!(t.take_failed_displaced().is_empty());
        assert_eq!(t.attempt_failed(DART_STACK), (DART_STACK, None));
        assert!(t.take_failed_displaced().is_empty());

        // Case 4: Even when an unrelated request is still in `self.last`, a bounce
        // naming `DART_STACK` (`displaced_equip` key) resolves `DART_STACK` directly.
        const PRIOR_DROP: u32 = 0x8000_00EE;
        t.record(PRIOR_DROP, InventoryRequest::Drop);
        t.record_in_flight(OLD_DART, InventoryRequest::PutInContainer);
        t.record_displaced_equip(DART_STACK, vec![(OLD_DART, 0x0040_0000)]);
        assert!(t.respond(OLD_DART));
        assert_eq!(t.attempt_failed(DART_STACK), (DART_STACK, None));
        assert_eq!(t.take_failed_displaced(), vec![(OLD_DART, 0x0040_0000)]);
        assert_eq!(t.pending(PRIOR_DROP), Some(InventoryRequest::Drop));
    }
}
