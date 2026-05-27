// =============================================================================
// Wave F.4 (2026-05-27) — Typed VendorProfile + retail buyback formula
// =============================================================================
//
// Ports Chorizite.ACProtocol's `VendorProfile` typed view of the wire shape
// already carried by `ApproachVendorEventData`, plus the canonical retail
// price formulas decompiled from acclient.c.
//
// **Why a separate type when the wire data is already in `ApproachVendorEventData`?**
//
//   * `ApproachVendorEventData` is a flat wire-shape struct (DTO-style).
//   * `VendorProfile` is the typed view the JS UI actually consumes:
//     - `BuyAcceptCategories` (item_types as a `ItemType` bitmask)
//     - The `min_value` / `max_value` / `magic` acceptance rules
//     - `buy_price` / `sell_price` *as a behavior* (closure-friendly
//       methods that compute final pyreal cost) — not just floats
//     - `InqAcceptability` retail acceptance check (1=type-reject,
//       2=zero-value, 3=below-min, vendor-code=above-max — caller can
//       surface the exact rejection reason in the UI before the
//       round-trip to ACE)
//
// **Source cross-references:**
//
//   * `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/VendorProfile.generated.cs`
//     — Chorizite's typed wire view (`Categories: ItemType`, `MinValue`,
//     `MaxValue`, `DealsMagic`, `BuyPrice`, `SellPrice`, `CurrencyId`,
//     `CurrencyAmount`, `CurrencyName`).
//   * `external/chorizite/ACBindings/Generated/Net/Types/VendorProfile.cs:24-32`
//     — retail unpacked struct (matches the `acclient.c` layout exactly).
//   * `external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/AcClient/Vendor.cs:5-50`
//     — retail offsets + function signatures.
//   * `acclient.c:719870-719913` — canonical `ShopSystem::BuyPrice` /
//     `ShopSystem::SellPrice` formulas (the load-bearing math).
//   * `acclient.c:509817-509855` — `VendorProfile::InqAcceptability`
//     (the rejection-code table).
//   * `acclient.c:509859-509905` — `VendorProfile::VendorBuyPrice` /
//     `VendorSellPrice` (per-item dispatchers around ShopSystem).
//
// **Wire shape note:**
//
//   The on-wire fields land via `ApproachVendorEventData` (opcode 0x0062
//   `ApproachVendor`). `VendorProfile::from_approach_event` converts.
//   We don't add a NEW wire opcode for this — the data is already there;
//   F.4 just gives it a typed view + closes the buyback-formula gap.
//
// =============================================================================

use crate::messages::object::messages::PublicWeenieDescription;
use crate::messages::trade::events::ApproachVendorEventData;
use holtburger_common::properties::ItemType;
use serde::{Deserialize, Serialize};

/// Reason codes returned by `VendorProfile::inq_acceptability`.
///
/// Mirrors the integer return code of `VendorProfile::InqAcceptability`
/// in acclient.c:509817:
///
/// ```text
///   0 — Acceptable (vendor will buy it)
///   1 — Wrong category (ItemType bit not in `BuyAcceptCategories`)
///       or `Attuned` bit set on the item
///   2 — Per-unit value is zero (worthless)
///   3 — Below `min_value` (vendor doesn't deal in cheap items)
///   4 — Above `max_value` — but only when item is NOT a portal/promissory note.
///       (The retail code does `~((unsigned __int8)(v2 >> 16)) & 4` which
///       evaluates to 4 when neither the Portal (0x10000) nor the
///       Promissory Note (0x40000) bit is set, and 0 otherwise.)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
pub enum AcceptabilityCode {
    /// Vendor will buy this item.
    Acceptable = 0,
    /// Wrong ItemType category OR Attuned bit set.
    WrongCategory = 1,
    /// Per-unit value is zero.
    ZeroValue = 2,
    /// Per-unit value below `min_value`.
    BelowMinValue = 3,
    /// Per-unit value above `max_value` (and not a portal/note).
    AboveMaxValue = 4,
}

impl AcceptabilityCode {
    /// Human-readable rejection reason (English). Used by the vendor-ui
    /// hover tooltips to explain why a drop-target rejected an item.
    pub fn reason(self) -> &'static str {
        match self {
            AcceptabilityCode::Acceptable => "Acceptable",
            AcceptabilityCode::WrongCategory => "Vendor doesn't deal in this item type",
            AcceptabilityCode::ZeroValue => "Item has no value",
            AcceptabilityCode::BelowMinValue => "Item value is too low for this vendor",
            AcceptabilityCode::AboveMaxValue => "Item value exceeds vendor's trade cap",
        }
    }
}

/// Typed view of an in-game vendor's purchase rules + price multipliers.
///
/// Built from `ApproachVendorEventData` via [`VendorProfile::from_approach_event`].
/// The on-wire fields are already round-tripped by `ApproachVendorEventData`;
/// this struct simply wraps them in a typed surface + retail formulas.
///
/// **Fields mirror Chorizite (`VendorProfile.generated.cs`):**
///
///   * `categories` → `ItemType` (Chorizite's `Categories`) — bitmask of
///     accepted item types when the player tries to SELL.
///   * `min_value` / `max_value` → vendor's per-unit value window for buybacks.
///   * `deals_magic` → if true, vendor will buy magic items (else those
///     fall into `WrongCategory`).
///   * `buy_price` / `sell_price` → per-vendor multipliers applied to
///     the item's base value (`buy_price > 1.0` typically, `sell_price < 1.0`).
///   * `currency_id` / `currency_amount` / `currency_name` → optional
///     alternate-currency override (e.g. trade tokens). When `currency_id`
///     is 0, the vendor deals in pyreals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VendorProfile {
    pub vendor_guid: u32,
    /// ItemType bitmask of categories this vendor will BUY (categorized stock filter).
    pub categories: ItemType,
    /// Lowest per-unit value this vendor will buy. `u32::MAX` ≡ "no min".
    pub min_value: u32,
    /// Highest per-unit value this vendor will buy. `u32::MAX` ≡ "no cap".
    pub max_value: u32,
    /// If true, this vendor will purchase magical items.
    pub deals_magic: bool,
    /// Multiplier the vendor charges when selling TO the player (buy_price > 1.0).
    pub buy_price: f32,
    /// Multiplier the vendor pays when buying FROM the player (sell_price < 1.0).
    pub sell_price: f32,
    /// Alternate-currency wcid (0 = pyreals).
    pub currency_id: u32,
    /// Alternate-currency stock count.
    pub currency_amount: u32,
    /// Alternate-currency display name (empty when pyreals).
    pub currency_name: String,
}

impl VendorProfile {
    /// Construct from the freshly-unpacked `ApproachVendor` wire event.
    ///
    /// The `merchandise_item_types` u32 on the wire becomes `ItemType` bits.
    /// The `deal_magical_items` u32 becomes a bool (matches Chorizite's
    /// `ReadBool` reader — any non-zero is true).
    /// The retail `min_value`/`max_value` are signed int with `-1`
    /// meaning "no cap"; we preserve that by treating `u32::MAX` (the
    /// two's-complement bit pattern of `-1`) as the no-cap sentinel.
    pub fn from_approach_event(event: &ApproachVendorEventData) -> Self {
        Self {
            vendor_guid: u32::from(event.vendor_guid),
            categories: ItemType::from_bits_truncate(event.merchandise_item_types),
            min_value: event.merchandise_min_value,
            max_value: event.merchandise_max_value,
            deals_magic: event.deal_magical_items != 0,
            buy_price: event.buy_multiplier,
            sell_price: event.sell_multiplier,
            currency_id: event.alternate_currency_wcid,
            currency_amount: event.alternate_currency_amount,
            currency_name: event.alternate_currency_name.clone(),
        }
    }

    /// Returns true when `max_value` is the no-cap sentinel.
    pub fn has_no_max(&self) -> bool {
        self.max_value == u32::MAX
    }

    /// Returns true when `min_value` is the retail no-min sentinel.
    /// Retail uses `-1` (== `u32::MAX` as u32) to mean "no floor"; the
    /// numeric value `0` is not a sentinel — it just means the floor is 0
    /// pyreals (which any positive-valued item passes).
    pub fn has_no_min(&self) -> bool {
        self.min_value == u32::MAX
    }

    /// Filter a stock list down to a single category bit, mirroring
    /// `VendorItemsUI::UpdateItemsList(item_type, ...)`'s category dropdown.
    ///
    /// `category_mask = 0xFFFFFFFF` returns the whole list (the "All" option).
    /// Otherwise returns only entries whose `item_type` bit overlaps the mask.
    pub fn filter_stock<'a, I, T>(category_mask: u32, items: I) -> Vec<&'a T>
    where
        I: IntoIterator<Item = &'a T>,
        T: HasItemType,
    {
        items
            .into_iter()
            .filter(|it| category_mask == 0xFFFFFFFF || (it.item_type_bits() & category_mask) != 0)
            .collect()
    }
}

/// Trait so `filter_stock` is generic over both the wire-side
/// `VendorItemEventData` (via its inner `PublicWeenieDescription`) and
/// any client-side stock entry (the wasm `VendorStateItem`, the world
/// `CoreVendorItem`, …). Each consumer impls this once.
pub trait HasItemType {
    fn item_type_bits(&self) -> u32;
}

impl HasItemType for VendorStockSnapshot {
    fn item_type_bits(&self) -> u32 {
        self.item_type
    }
}

/// Lightweight stock-entry snapshot for testability + wasm consumption.
///
/// Carries the minimum a UI needs: the per-instance GUID, wcid for
/// icon lookup, name, base value (pre-markup), stack size, item-type
/// bits, icon DID. The full ID-properties / weapon/armor profiles
/// stay in the world crate's `CoreVendorItem`; this is the *bar-display*
/// shape, derived alongside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VendorStockSnapshot {
    pub item_guid: u32,
    pub wcid: u32,
    pub name: String,
    pub value: u32,
    pub stack_size: u32,
    pub item_type: u32,
    pub icon_id: u32,
}

// =============================================================================
// Retail buyback formula — ShopSystem::BuyPrice / SellPrice
// =============================================================================
//
// Decompiled from acclient.c:719870 + 719893. These are the canonical
// per-item pyreal-cost calculations the AC client used to render the
// "X pyreals" labels in gmVendorUI's selected-price field. The ACE
// server applies the same formulas server-side (Server/WorldObjects/
// Vendor.cs) — so the client-side preview matches the server's final
// transaction price down to the unit pyreal.
//
// `ItemType` bit 0x40000 = `PROMISSORY_NOTE` (a.k.a. trade notes / MMD).
// Retail hard-codes a flat 1.00 buy price and 1.15 sell price for
// notes — the cap is intentional, since notes ARE currency: a 250k
// MMD is always worth 250k pyreals to buy and 287.5k to sell, regardless
// of the vendor's per-item multipliers. Cross-references:
//
//   * `holtburger_common::defaults::PROMISSORY_NOTE_SELL_RATE` = 1.15
//   * `holtburger_common::defaults::VENDOR_CEIL_OFFSET`       = 0.1
//   * `ItemType::PROMISSORY_NOTE` = 0x00040000
//
// The min-1 / max-INT_MAX clamps mirror the retail unsigned-vs-signed
// dance: if the raw formula evaluates to 0 the result is clamped to 1
// (one pyreal floor, so vendors never give items away free); if the
// signed-as-unsigned cast wraps negative, the result is clamped to -1
// (an error code the UI surfaces as "vendor will not transact").

const PROMISSORY_NOTE_BIT: u32 = 0x40000;
const NEG_ONE_AS_U32: i32 = -1;

/// Retail `ShopSystem::BuyPrice` — what the player PAYS to buy `num_item`
/// units of an item with unit value `unit_value` from a vendor with
/// `buy_price` multiplier. Returns -1 to signal "vendor refuses".
///
/// Direct port of acclient.c:719870-719889. Promissory notes (item type
/// 0x40000) bypass the per-vendor multiplier and use a flat 1.0.
pub fn shop_buy_price(unit_value: i32, item_type: u32, buy_price: f32, num_item: i32) -> i32 {
    let multiplier = if item_type == PROMISSORY_NOTE_BIT {
        1.0_f64
    } else {
        buy_price as f64
    };
    let raw = (multiplier * unit_value as f64 * num_item as f64 + 0.1_f64).floor();
    // Retail does `(unsigned __int64)floor(...)` then checks the low DWORD.
    // We clamp explicitly here for safety on i32 wrap.
    let raw_i64 = raw as i64;
    if raw_i64 == 0 {
        1 // floor of 0 → 1 pyreal floor (vendors don't give items away free)
    } else if raw_i64 < 0 || raw_i64 > i32::MAX as i64 {
        NEG_ONE_AS_U32 // signal "refuse"
    } else {
        raw_i64 as i32
    }
}

/// Retail `ShopSystem::SellPrice` — what the player RECEIVES when selling
/// `num_item` units of an item with unit value `unit_value` to a vendor
/// with `sell_price` multiplier. Returns -1 to signal "vendor refuses".
///
/// Direct port of acclient.c:719893-719912. Promissory notes use a flat
/// 1.15 (the retail constant — vendor pays 15% over face value on notes,
/// since they're effectively cash).
pub fn shop_sell_price(unit_value: i32, item_type: u32, sell_price: f32, num_item: i32) -> i32 {
    let multiplier = if item_type == PROMISSORY_NOTE_BIT {
        holtburger_common::defaults::PROMISSORY_NOTE_SELL_RATE as f64
    } else {
        sell_price as f64
    };
    let raw = (multiplier * unit_value as f64 * num_item as f64
        - holtburger_common::defaults::VENDOR_CEIL_OFFSET as f64)
        .ceil();
    let raw_i64 = raw as i64;
    if raw_i64 == 0 {
        1 // floor of 0 → 1 pyreal credit
    } else if raw_i64 < 0 || raw_i64 > i32::MAX as i64 {
        NEG_ONE_AS_U32
    } else {
        raw_i64 as i32
    }
}

impl VendorProfile {
    /// Per-item buy price (player → vendor's stock → player's inventory).
    ///
    /// Direct port of `VendorProfile::VendorBuyPrice` (acclient.c:509885):
    /// divides by stack size first for stackable items, then dispatches
    /// to `ShopSystem::BuyPrice`. Used by vendor-ui.js to label each
    /// stock-strip cell with the cost the player will pay.
    pub fn vendor_buy_price(&self, item_value: u32, item_type: u32, stack_size: u32) -> i32 {
        let (unit_value, num_item) = if stack_size > 0 {
            ((item_value / stack_size) as i32, stack_size as i32)
        } else {
            (item_value as i32, 1)
        };
        shop_buy_price(unit_value, item_type, self.buy_price, num_item)
    }

    /// Per-item sell price (vendor's stock ← player's inventory).
    ///
    /// Direct port of `VendorProfile::VendorSellPrice` (acclient.c:509859).
    pub fn vendor_sell_price(
        &self,
        item_value: u32,
        item_type: u32,
        stack_size: u32,
        sub_amount: u32,
    ) -> i32 {
        let unit_value = if stack_size > 0 {
            (item_value / stack_size) as i32
        } else {
            item_value as i32
        };
        shop_sell_price(unit_value, item_type, self.sell_price, sub_amount as i32)
    }

    /// Retail `VendorProfile::InqAcceptability` (acclient.c:509817):
    /// what is this vendor going to do when the player tries to sell
    /// `item`? Returns one of [`AcceptabilityCode`].
    ///
    /// The acceptance test runs in three layers:
    ///
    ///   1. **Type filter** — `item.item_type & this.categories != 0`,
    ///      AND the Attuned bit on the item is clear. Else WrongCategory.
    ///   2. **Value floor/ceiling** — per-unit value (`value / stack_size`)
    ///      must be > 0, then within `[min_value, max_value]`.
    ///   3. **Magic/portal/promissory exception on max_value** — when
    ///      the item is over the cap, retail returns 4 unless either
    ///      the Portal (0x10000) or PromissoryNote (0x40000) bit is set
    ///      (in which case the cap is waived — notes are above price caps).
    pub fn inq_acceptability(
        &self,
        item_type: u32,
        item_value: u32,
        stack_size: u32,
        attuned: bool,
    ) -> AcceptabilityCode {
        // Layer 1 — type bit + attuned check
        if (self.categories.bits() & item_type) == 0 || attuned {
            return AcceptabilityCode::WrongCategory;
        }
        // Magic items: separate check (retail's `magic` field; the wire
        // event surfaces this as `deal_magical_items` -> `deals_magic`).
        // NOTE: retail's `_item->_bitfield & 0x01000000` magic bit lives
        // ABOVE the AC1 item-type bits, so this layer isn't part of
        // `categories`; it's an independent gate. The wire side carries
        // the vendor's deals_magic flag separately for this reason.
        // We model it as a follow-on check the caller can apply after the
        // primary acceptance code — sufficient for UI surfacing.

        // Layer 2 — per-unit value floor
        let unit_value = if stack_size > 0 {
            item_value / stack_size
        } else {
            item_value
        };
        if unit_value == 0 {
            return AcceptabilityCode::ZeroValue;
        }
        // Layer 3 — max + min bounds
        if !self.has_no_max() && unit_value > self.max_value {
            // Retail's `~((u8)(v2 >> 16)) & 4` = 4 unless Portal (0x10000)
            // or PromissoryNote (0x40000) bit is set on the item type.
            // Bit 0x10000 is Portal, 0x40000 is PromissoryNote — both fall
            // in (item_type >> 16) & 0x05 = 1 or 4 respectively.
            let high_byte = (item_type >> 16) as u8;
            if (!high_byte & 4) != 0 {
                return AcceptabilityCode::AboveMaxValue;
            }
            // Cap waived — fall through to acceptable.
            return AcceptabilityCode::Acceptable;
        }
        if !self.has_no_min() && unit_value < self.min_value {
            return AcceptabilityCode::BelowMinValue;
        }
        AcceptabilityCode::Acceptable
    }

    /// Convenience: also runs the `deals_magic` follow-on after the
    /// primary acceptance code. Returns `WrongCategory` for magic items
    /// when the vendor doesn't deal in them, regardless of category bit.
    pub fn inq_acceptability_with_magic(
        &self,
        item_type: u32,
        item_value: u32,
        stack_size: u32,
        attuned: bool,
        item_is_magic: bool,
    ) -> AcceptabilityCode {
        if item_is_magic && !self.deals_magic {
            return AcceptabilityCode::WrongCategory;
        }
        self.inq_acceptability(item_type, item_value, stack_size, attuned)
    }
}

impl HasItemType for PublicWeenieDescription {
    fn item_type_bits(&self) -> u32 {
        self.item_type
    }
}

// =============================================================================
// Tests
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::trade::events::{ApproachVendorEventData, VendorItemEventData};
    use holtburger_common::Guid;

    fn synth_profile() -> VendorProfile {
        VendorProfile {
            vendor_guid: 0x50000001,
            // ARMOR + MELEE_WEAPON + MISC + MISSILE_WEAPON
            categories: ItemType::MELEE_WEAPON
                | ItemType::ARMOR
                | ItemType::MISC
                | ItemType::MISSILE_WEAPON,
            // u32::MAX is retail's -1 "no cap" sentinel — see acclient.c:509836
            // and the doc-comment on min_value/max_value above.
            min_value: 0,
            max_value: u32::MAX,
            deals_magic: true,
            buy_price: 1.25,
            sell_price: 0.75,
            currency_id: 0,
            currency_amount: 0,
            currency_name: String::new(),
        }
    }

    #[test]
    fn shop_buy_price_basic() {
        // 1.25 × 100 × 1 + 0.1 → 125.1 → floor → 125
        assert_eq!(shop_buy_price(100, ItemType::MISC.bits(), 1.25, 1), 125);
    }

    #[test]
    fn shop_buy_price_zero_floors_to_one() {
        // 0.0 × 0 → 0 → clamp to 1 (vendors don't give items away)
        assert_eq!(shop_buy_price(0, ItemType::MISC.bits(), 1.25, 1), 1);
    }

    #[test]
    fn shop_buy_price_promissory_note_flat() {
        // Promissory note ignores buy_price multiplier (uses 1.0).
        // 1.0 × 250000 × 1 + 0.1 → 250000.1 → floor → 250000
        assert_eq!(
            shop_buy_price(250000, ItemType::PROMISSORY_NOTE.bits(), 1.5, 1),
            250000
        );
    }

    #[test]
    fn shop_sell_price_basic() {
        // 0.75 × 100 × 1 - 0.1 → 74.9 → ceil → 75
        assert_eq!(shop_sell_price(100, ItemType::MISC.bits(), 0.75, 1), 75);
    }

    #[test]
    fn shop_sell_price_promissory_note_flat() {
        // Promissory note uses 1.15 sell rate.
        // 1.15 × 250000 × 1 - 0.1 → 287499.9 → ceil → 287500
        assert_eq!(
            shop_sell_price(250000, ItemType::PROMISSORY_NOTE.bits(), 0.5, 1),
            287500
        );
    }

    #[test]
    fn vendor_buy_price_stackable_arrows() {
        // 100 arrows in a stack value 500 → per-unit value 5
        // 1.25 × 5 × 100 + 0.1 → 625.1 → floor → 625
        let p = synth_profile();
        assert_eq!(p.vendor_buy_price(500, ItemType::MISSILE_WEAPON.bits(), 100), 625);
    }

    #[test]
    fn vendor_sell_price_stackable_arrows() {
        // 100 arrows in a stack value 500 → per-unit value 5
        // 0.75 × 5 × 100 - 0.1 → 374.9 → ceil → 375
        let p = synth_profile();
        assert_eq!(p.vendor_sell_price(500, ItemType::MISSILE_WEAPON.bits(), 100, 100), 375);
    }

    #[test]
    fn inq_acceptability_wrong_category() {
        let p = synth_profile();
        // CASTER (0x8000) not in synth_profile's categories.
        assert_eq!(
            p.inq_acceptability(ItemType::CASTER.bits(), 100, 1, false),
            AcceptabilityCode::WrongCategory
        );
    }

    #[test]
    fn inq_acceptability_attuned_rejected() {
        let p = synth_profile();
        assert_eq!(
            p.inq_acceptability(ItemType::MISC.bits(), 100, 1, true),
            AcceptabilityCode::WrongCategory
        );
    }

    #[test]
    fn inq_acceptability_zero_value() {
        let p = synth_profile();
        assert_eq!(
            p.inq_acceptability(ItemType::MISC.bits(), 0, 1, false),
            AcceptabilityCode::ZeroValue
        );
    }

    #[test]
    fn inq_acceptability_accepts_in_bounds() {
        // min_value=0, max_value=0 → both "no cap" per has_no_max/min.
        let p = synth_profile();
        assert_eq!(
            p.inq_acceptability(ItemType::MISC.bits(), 100, 1, false),
            AcceptabilityCode::Acceptable
        );
    }

    #[test]
    fn inq_acceptability_below_min() {
        let mut p = synth_profile();
        p.min_value = 50;
        assert_eq!(
            p.inq_acceptability(ItemType::MISC.bits(), 10, 1, false),
            AcceptabilityCode::BelowMinValue
        );
    }

    #[test]
    fn inq_acceptability_above_max() {
        let mut p = synth_profile();
        p.max_value = 100;
        assert_eq!(
            p.inq_acceptability(ItemType::MISC.bits(), 200, 1, false),
            AcceptabilityCode::AboveMaxValue
        );
    }

    #[test]
    fn inq_acceptability_promissory_note_waives_cap() {
        // Promissory note exception — over-cap items are accepted when
        // the PromissoryNote bit (0x40000) is set.
        let mut p = synth_profile();
        p.categories |= ItemType::PROMISSORY_NOTE;
        p.max_value = 1000;
        assert_eq!(
            p.inq_acceptability(ItemType::PROMISSORY_NOTE.bits(), 500000, 1, false),
            AcceptabilityCode::Acceptable
        );
    }

    #[test]
    fn inq_acceptability_magic_gate() {
        // deals_magic=false → magic item is rejected even if category matches.
        let mut p = synth_profile();
        p.deals_magic = false;
        assert_eq!(
            p.inq_acceptability_with_magic(
                ItemType::MISC.bits(),
                100,
                1,
                false,
                /*item_is_magic=*/ true
            ),
            AcceptabilityCode::WrongCategory
        );
        // Same item, non-magic, still accepted
        assert_eq!(
            p.inq_acceptability_with_magic(
                ItemType::MISC.bits(),
                100,
                1,
                false,
                /*item_is_magic=*/ false
            ),
            AcceptabilityCode::Acceptable
        );
    }

    #[test]
    fn from_approach_event_round_trip() {
        let event = ApproachVendorEventData {
            vendor_guid: Guid::from(0x50000001),
            // ARMOR + JEWELRY
            merchandise_item_types: (ItemType::ARMOR | ItemType::JEWELRY).bits(),
            merchandise_min_value: 5,
            merchandise_max_value: 10_000,
            deal_magical_items: 1,
            buy_multiplier: 1.4,
            sell_multiplier: 0.6,
            alternate_currency_wcid: 0,
            alternate_currency_amount: 0,
            alternate_currency_name: String::new(),
            items: vec![],
        };
        let profile = VendorProfile::from_approach_event(&event);
        assert_eq!(profile.vendor_guid, 0x50000001);
        assert!(profile.categories.contains(ItemType::ARMOR));
        assert!(profile.categories.contains(ItemType::JEWELRY));
        assert!(!profile.categories.contains(ItemType::MISC));
        assert_eq!(profile.min_value, 5);
        assert_eq!(profile.max_value, 10_000);
        assert!(profile.deals_magic);
        assert_eq!(profile.buy_price, 1.4);
        assert_eq!(profile.sell_price, 0.6);
    }

    #[test]
    fn filter_stock_all_returns_full_list() {
        let items = vec![
            VendorStockSnapshot {
                item_guid: 1,
                wcid: 100,
                name: "Bread".into(),
                value: 5,
                stack_size: 1,
                item_type: ItemType::FOOD.bits(),
                icon_id: 0,
            },
            VendorStockSnapshot {
                item_guid: 2,
                wcid: 200,
                name: "Iron Sword".into(),
                value: 200,
                stack_size: 1,
                item_type: ItemType::MELEE_WEAPON.bits(),
                icon_id: 0,
            },
        ];
        let filtered = VendorProfile::filter_stock(0xFFFFFFFF, items.iter());
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn filter_stock_by_category() {
        let items = vec![
            VendorStockSnapshot {
                item_guid: 1,
                wcid: 100,
                name: "Bread".into(),
                value: 5,
                stack_size: 1,
                item_type: ItemType::FOOD.bits(),
                icon_id: 0,
            },
            VendorStockSnapshot {
                item_guid: 2,
                wcid: 200,
                name: "Iron Sword".into(),
                value: 200,
                stack_size: 1,
                item_type: ItemType::MELEE_WEAPON.bits(),
                icon_id: 0,
            },
            VendorStockSnapshot {
                item_guid: 3,
                wcid: 300,
                name: "Leather Cap".into(),
                value: 45,
                stack_size: 1,
                item_type: ItemType::ARMOR.bits(),
                icon_id: 0,
            },
        ];
        let melee_only =
            VendorProfile::filter_stock(ItemType::MELEE_WEAPON.bits(), items.iter());
        assert_eq!(melee_only.len(), 1);
        assert_eq!(melee_only[0].wcid, 200);
    }

    #[test]
    fn categorize_full_stock_into_buckets() {
        // End-to-end: take the wire ApproachVendor, build a VendorProfile,
        // then bucket a vendor's stock by category for the UI dropdown.
        let event = ApproachVendorEventData {
            vendor_guid: Guid::from(0x50000010),
            merchandise_item_types: ItemType::all().bits(),
            merchandise_min_value: 0,
            merchandise_max_value: 0,
            deal_magical_items: 1,
            buy_multiplier: 1.1,
            sell_multiplier: 0.4,
            alternate_currency_wcid: 0,
            alternate_currency_amount: 0,
            alternate_currency_name: String::new(),
            items: vec![],
        };
        let profile = VendorProfile::from_approach_event(&event);
        // Bucketed stock check.
        let stock = [
            VendorStockSnapshot {
                item_guid: 1,
                wcid: 1,
                name: "Bread".into(),
                value: 5,
                stack_size: 1,
                item_type: ItemType::FOOD.bits(),
                icon_id: 0,
            },
            VendorStockSnapshot {
                item_guid: 2,
                wcid: 2,
                name: "Iron Sword".into(),
                value: 200,
                stack_size: 1,
                item_type: ItemType::MELEE_WEAPON.bits(),
                icon_id: 0,
            },
        ];
        // Filter by MELEE_WEAPON category.
        let meleestock =
            VendorProfile::filter_stock(ItemType::MELEE_WEAPON.bits(), stock.iter());
        let buy_price = profile.vendor_buy_price(
            meleestock[0].value,
            meleestock[0].item_type,
            meleestock[0].stack_size,
        );
        // 1.1 × 200 × 1 + 0.1 → 220.1 → floor → 220
        assert_eq!(buy_price, 220);
    }

    // Wave J5.B follow-on (2026-05-27): dump the FULL wire shape of
    // `Vendor_VendorInfo` (Chorizite) / `ApproachVendor` (Rust) wrapped
    // in the outer `GameMessage::GameEvent` 0xF7B0 frame, when the
    // `DUMP_FIXTURE_HEX=1` env var is set. The bytes are then fed into
    // `apps/holtburger-web/validate_wire_conformance.cjs`'s `unpackOnly`
    // fixture for the Wave F.4 Vendor profile — which can't round-trip
    // via Chorizite's synth-pack path because of the upstream
    // `BinaryWriter.Write(bool)`=1 byte vs `BinaryReaderExtensions.
    // ReadBool()`=4 bytes asymmetry (handoff §2 row 10). Rust packs the
    // wire-correct 4-byte u32, which Chorizite's reader handles fine.
    #[test]
    fn dump_vendor_vendor_info_fixture_hex() {
        use crate::messages::game_event::{GameEvent, GameEventMessage};
        use crate::messages::game_message::GameMessage;
        use crate::traits::ProtocolPack;

        let event = ApproachVendorEventData {
            vendor_guid: Guid::from(0x5000_0001),
            // Categories: 0x83 — matches F.4 fixture
            // (ItemType::MELEE_WEAPON | ARMOR | MISC = 0x01 | 0x02 | 0x80 = 0x83).
            merchandise_item_types: 0x83,
            merchandise_min_value: 0,
            merchandise_max_value: u32::MAX, // -1 sentinel
            deal_magical_items: 1,           // true (4-byte u32)
            buy_multiplier: 1.25,
            sell_multiplier: 0.75,
            alternate_currency_wcid: 0,
            alternate_currency_amount: 0,
            alternate_currency_name: String::new(),
            items: vec![],
        };
        let msg = GameEventMessage {
            target: Guid::from(0x5000_0001),
            sequence: 0,
            event: GameEvent::ApproachVendor(Box::new(event)),
        };
        if std::env::var("DUMP_FIXTURE_HEX").ok().as_deref() == Some("1") {
            let game_msg = GameMessage::GameEvent(Box::new(msg));
            let mut packed = Vec::new();
            game_msg.pack(&mut packed);
            eprintln!("FIXTURE_HEX[vendor_vendor_info]: {}", hex::encode(&packed));
        }
    }
}
