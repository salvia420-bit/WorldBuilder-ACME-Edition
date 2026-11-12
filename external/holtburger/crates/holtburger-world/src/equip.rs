//! items-4 (2026-10-08) — which equipped items a `WieldFromPack` must move
//! back to the pack BEFORE `GetAndWieldItem`.
//!
//! ACE expects the client to send the unequip (`PutItemInContainer`) for a
//! blocking item itself (`Player_Inventory.cs` "Client will automatically
//! send any unequip message before the GetAndWield") and refuses with
//! `InventoryServerSaveFailed` when it does not. Retail only ever does that
//! for the HELD slots — weapon / shield / ammo (`CPlayerSystem::AutoWield`,
//! acclient.c:398828, the "Moving %s to your backpack" unblock at ~399413).
//! For armor and clothing it REFUSES before anything moves
//! (`CPlayerSystem::AutoWearIsLegal`, acclient.c:397338: "You must remove
//! your %s to wear that"), and for a second stack of the wielded ammo it
//! MERGES (`ItemHolder::AttemptMerge`, :432468) or says "You cannot wield
//! more %s" — never a swap.
//!
//! The previous inline arm pushed every slot overlap to the unequip list,
//! so double-clicking a coat while wearing a breastplate and bracers moved
//! the breastplate to the pack, then ACE refused the coat over the bracers'
//! `ClothingPriority` overlap: the player ended up stripped and not wearing
//! the coat.

use crate::context::{WorldContext, WorldContextExt};
use crate::entity::Entity;
use holtburger_common::Guid;
use holtburger_common::properties::{
    EquipMask, PropertyBool, PropertyInt, WorldObjectExt, WorldObjectPropertyAccessors,
};

/// Default human player main-pack capacities (`Player.cs` in ACE omits
/// `PropertyInt::ItemsCapacity` and `PropertyInt::ContainersCapacity` on the
/// player's own `CreateObject`, so live player entities default to 102 / 7).
pub const DEFAULT_PLAYER_ITEMS_CAPACITY: u32 = 102;
pub const DEFAULT_PLAYER_CONTAINERS_CAPACITY: u32 = 7;

const COMBAT_USE_MISSILE: i32 = 2;
const COMBAT_USE_TWO_HANDED: i32 = 5;
const ITEM_TYPE_CASTER: u32 = 0x8000;

/// Retail `ACCWeenieObject::BlocksUseOfShield` (`acclient.c:395589`):
/// Caster (`ItemType & 0x8000`), TwoHanded (`CombatUse == 5`), or Launcher
/// (`CombatUse == 2` with non-zero `AmmoType`), falling back to `loc` bits
/// when `CombatUse` has not arrived yet.
fn entity_blocks_shield(entity: Option<&Entity>, loc: EquipMask) -> bool {
    if let Some(e) = entity {
        if (e.item_type_int().unwrap_or(0) & ITEM_TYPE_CASTER) != 0 {
            return true;
        }
        let ammo = e.ammo_type().unwrap_or(0);
        if let Some(cu) = e.get_int_prop(PropertyInt::CombatUse)
            && cu != 0
        {
            return (cu == COMBAT_USE_MISSILE && ammo != 0) || cu == COMBAT_USE_TWO_HANDED;
        }
    }
    let ammo = entity.and_then(|e| e.ammo_type()).unwrap_or(0);
    loc.intersects(EquipMask::TWO_HANDED | EquipMask::CASTER)
        || (loc.intersects(EquipMask::MISSILE_WEAPON) && ammo != 0)
}

/// Retail `CPlayerSystem::AutoWearIsLegal`'s wearable family
/// (`valid_locations & 0x8007FFF`): the fourteen armor / clothing slots plus
/// the cloak. Jewelry, trinkets and sigils are NOT in it.
pub const WEARABLE_LOCATION_BITS: u32 = 0x0800_7FFF;

/// `true` when `requested` lies entirely inside the armor / clothing / cloak
/// family (and is non-empty) — retail's auto-WEAR path, which never moves
/// anything.
pub fn is_pure_wearable(requested: EquipMask) -> bool {
    let bits = requested.bits();
    bits != 0 && bits & !WEARABLE_LOCATION_BITS == 0
}

/// The equipped items a `GetAndWieldItem(item_guid, requested)` must unequip
/// first. Mirrors ACE `CheckWeaponCollision` for the held slots (same slot,
/// one weapon at a time, launcher / two-hander / caster vs shield both ways,
/// launcher vs mismatched ammo) with two retail guards:
///
/// 1. a pure wearable ([`is_pure_wearable`]) unequips NOTHING — ACE then
///    refuses an overlapping wear with its own text (kind 48 clears the JS
///    pending op) instead of the player being stripped;
/// 2. a second stack of the SAME wcid as the wielded ammo is not swapped
///    out — retail merges it into the wielded stack (`AttemptMerge`), which
///    the JS layer handles; on the wire ACE refuses the occupied-slot wield
///    rather than silently swapping stacks.
pub fn wield_unequip_conflicts<W: WorldContext>(
    world: &W,
    item_guid: Guid,
    requested: EquipMask,
) -> Vec<Guid> {
    if is_pure_wearable(requested) {
        return Vec::new();
    }

    let weapon_family = EquipMask::MELEE_WEAPON
        | EquipMask::MISSILE_WEAPON
        | EquipMask::TWO_HANDED
        | EquipMask::CASTER;
    let new_item = world.get_entity(item_guid);
    let new_ammo_type = new_item.and_then(|e| e.ammo_type()).unwrap_or(0);
    let new_wcid = new_item.and_then(|e| e.wcid);
    let new_combat_use = new_item
        .and_then(|e| e.get_int_prop(PropertyInt::CombatUse))
        .unwrap_or(0);
    let new_is_launcher = if new_combat_use != 0 {
        new_combat_use == COMBAT_USE_MISSILE && new_ammo_type != 0
    } else {
        requested.intersects(EquipMask::MISSILE_WEAPON) && new_ammo_type != 0
    };
    let new_blocks_shield = entity_blocks_shield(new_item, requested);

    let mut to_unequip = Vec::new();
    for guid in world.iter_equipment() {
        if guid == item_guid {
            continue;
        }
        let Some(equipped) = world.get_entity(guid) else {
            continue;
        };
        let loc = equipped.wield_location();

        // Guard 2: same-wcid ammo merges, it never swaps.
        if requested.intersects(EquipMask::MISSILE_AMMO)
            && loc.intersects(EquipMask::MISSILE_AMMO)
            && new_wcid.is_some()
            && equipped.wcid == new_wcid
        {
            continue;
        }

        let same_slot = loc.intersects(requested);
        let weapon_swap = requested.intersects(weapon_family) && loc.intersects(weapon_family);
        let shield_clear = new_blocks_shield && loc.intersects(EquipMask::SHIELD);
        let shield_vs_weapon =
            requested.intersects(EquipMask::SHIELD) && entity_blocks_shield(Some(equipped), loc);
        // Launcher swap with mismatched equipped ammo (e.g. longbow over
        // quarrels) — ACE rejects the wield on AmmoType mismatch, so pull
        // the stale ammo too.
        let ammo_mismatch = new_is_launcher
            && loc.intersects(EquipMask::MISSILE_AMMO)
            && equipped.ammo_type().unwrap_or(0) != 0
            && equipped.ammo_type().unwrap_or(0) != new_ammo_type;
        if same_slot || weapon_swap || shield_clear || shield_vs_weapon || ammo_mismatch {
            to_unequip.push(guid);
        }
    }
    to_unequip
}

/// Retail `ItemHolder::AttemptToPlaceInContainer(item, playerID, 0, 1, 0)`
/// (`acclient.c:399403`, `:432960-432985`) destination container selection for
/// one or more items moving off the paperdoll back into the player's packs:
/// - Main pack (`player_guid`) when it has free item slots (`< 102`, or the
///   player's explicit `ItemsCapacity` when > 0);
/// - Else the first owned, top-level, unlocked openable side pack
///   (`container_id == Some(player_guid)`, `items_capacity > 0`) in inventory
///   slot order with free item capacity, tracking slots consumed across a
///   multi-item conflict batch (e.g. a 2H weapon displacing both main-hand +
///   shield when main pack is at `101/102`);
/// - Falls back to `player_guid` when every pack is full so the server emits
///   its authoritative full-pack rejection.
pub fn unequip_destinations<W: WorldContext>(
    world: &W,
    item_guids: &[Guid],
) -> Vec<(Guid, Guid)> {
    let Some(player_guid) = world.get_player_guid().filter(|&g| g != Guid::NULL) else {
        return item_guids.iter().map(|&g| (g, Guid::NULL)).collect();
    };
    if item_guids.is_empty() {
        return Vec::new();
    }

    let main_item_cap = world
        .get_entity(player_guid)
        .and_then(|e| e.items_capacity())
        .filter(|&c| c > 0)
        .unwrap_or(DEFAULT_PLAYER_ITEMS_CAPACITY);
    let main_container_cap = world
        .get_entity(player_guid)
        .and_then(|e| e.containers_capacity())
        .filter(|&c| c > 0)
        .unwrap_or(DEFAULT_PLAYER_CONTAINERS_CAPACITY);

    let mut main_item_used = 0u32;
    let mut main_container_used = 0u32;
    let mut counts_by_container: std::collections::HashMap<Guid, u32> =
        std::collections::HashMap::new();

    for child in world.iter_entities() {
        if child.guid == player_guid
            || world.is_equipped_item(child.guid)
            || !child.wield_location().is_empty()
            || child.wielder_id().is_some_and(|w| w != Guid::NULL)
        {
            continue;
        }
        let Some(cid) = child.container_id().filter(|&c| c != Guid::NULL) else {
            continue;
        };
        if cid == player_guid {
            if child.uses_player_container_slot() {
                main_container_used += 1;
            } else {
                main_item_used += 1;
            }
        } else {
            *counts_by_container.entry(cid).or_default() += 1;
        }
    }

    let mut main_item_free = main_item_cap.saturating_sub(main_item_used);
    let mut main_container_free = main_container_cap.saturating_sub(main_container_used);

    // Collect top-level openable side packs in server `inventory_placement`
    // slot order (`player.inventory` is a `HashSet`, so never rely on its hash
    // iteration order!), falling back to ascending GUID when placement is unset.
    let mut ordered_candidates: Vec<Guid> = world
        .iter_entities()
        .filter(|e| e.container_id() == Some(player_guid))
        .map(|e| e.guid)
        .collect();
    ordered_candidates.sort_by_key(|&g| (world.inventory_placement(g).unwrap_or(u32::MAX), g.0));

    let mut side_packs: Vec<(Guid, u32)> = Vec::new();
    for g in ordered_candidates {
        if g == player_guid || world.is_equipped_item(g) {
            continue;
        }
        let Some(pack) = world.get_entity(g) else {
            continue;
        };
        if pack.container_id() != Some(player_guid)
            || !pack.wield_location().is_empty()
            || pack.wielder_id().is_some_and(|w| w != Guid::NULL)
            || !pack.uses_player_container_slot()
            || pack.get_bool_prop(PropertyBool::Locked)
        {
            continue;
        }
        let cap = pack.items_capacity().unwrap_or(0);
        if cap == 0 {
            continue; // Foci (`RequiresBackpackSlot = true`, `ItemsCapacity = 0`) cannot hold items.
        }
        let used = counts_by_container.get(&g).copied().unwrap_or(0);
        side_packs.push((g, cap.saturating_sub(used)));
    }

    let mut out = Vec::with_capacity(item_guids.len());
    for &item_guid in item_guids {
        let uses_pack_slot = world
            .get_entity(item_guid)
            .is_some_and(|e| e.uses_player_container_slot());
        if uses_pack_slot {
            main_container_free = main_container_free.saturating_sub(1);
            out.push((item_guid, player_guid));
            continue;
        }
        if main_item_free > 0 {
            main_item_free -= 1;
            out.push((item_guid, player_guid));
            continue;
        }
        if let Some((pack_guid, free)) = side_packs.iter_mut().find(|(pg, f)| *pg != item_guid && *f > 0) {
            *free -= 1;
            out.push((item_guid, *pack_guid));
        } else {
            out.push((item_guid, player_guid));
        }
    }
    out
}

/// Convenience single-item wrapper around [`unequip_destinations`].
pub fn unequip_destination<W: WorldContext>(world: &W, item_guid: Guid) -> Guid {
    unequip_destinations(world, &[item_guid])
        .into_iter()
        .next()
        .map(|(_, dest)| dest)
        .unwrap_or_else(|| world.get_player_guid().unwrap_or(Guid::NULL))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorldState;
    use crate::entity::Entity;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::PropertyInt;

    const PLAYER: Guid = Guid(0x5000_0001);

    fn world() -> WorldState {
        let mut state = WorldState::synthetic();
        state.seed_local_player_entity(PLAYER, "Wearer", WorldPosition::default());
        state
    }

    /// An item in the pack (not wielded).
    fn pack_item(state: &mut WorldState, guid: u32, wcid: u32, valid: u32, ammo_type: u32) {
        let mut entity = Entity::new(
            Guid(guid),
            format!("item {guid:x}"),
            WorldPosition::default(),
        );
        entity.wcid = Some(wcid);
        entity
            .properties
            .ints
            .insert(PropertyInt::ValidLocations, valid as i32);
        if ammo_type != 0 {
            entity
                .properties
                .ints
                .insert(PropertyInt::AmmoType, ammo_type as i32);
        }
        state.entities.insert(entity);
        state.player.add_to_inventory(Guid(guid));
    }

    /// An item wielded in `slot`.
    fn wielded(state: &mut WorldState, guid: u32, wcid: u32, slot: u32, ammo_type: u32) {
        pack_item(state, guid, wcid, slot, ammo_type);
        if let Some(entity) = state.entities.get_mut(Guid(guid)) {
            entity
                .properties
                .ints
                .insert(PropertyInt::CurrentWieldedLocation, slot as i32);
        }
        state
            .player
            .wield_item(Guid(guid), EquipMask::from_bits_retain(slot));
    }

    fn conflicts(state: &WorldState, item: u32, requested: u32) -> Vec<u32> {
        let mut out: Vec<u32> =
            wield_unequip_conflicts(state, Guid(item), EquipMask::from_bits_retain(requested))
                .into_iter()
                .map(|g| g.0)
                .collect();
        out.sort_unstable();
        out
    }

    #[test]
    fn plan_wield_pure_wearable_family() {
        assert!(is_pure_wearable(EquipMask::CHEST_WEAR));
        assert!(is_pure_wearable(
            EquipMask::CHEST_ARMOR | EquipMask::UPPER_ARM_ARMOR
        ));
        assert!(is_pure_wearable(EquipMask::CLOAK));
        assert!(!is_pure_wearable(EquipMask::NONE));
        assert!(
            !is_pure_wearable(EquipMask::FINGER_WEAR_LEFT),
            "jewelry keeps its path"
        );
        assert!(!is_pure_wearable(EquipMask::MELEE_WEAPON));
        assert!(!is_pure_wearable(
            EquipMask::CHEST_ARMOR | EquipMask::SHIELD
        ));
    }

    /// The finding's scenario: a coat over a breastplate + bracers. The JS
    /// sends one chest bit; the breastplate shares it. Nothing may move —
    /// ACE refuses the overlapping wear on its own.
    #[test]
    fn plan_wield_coat_over_breastplate_moves_nothing() {
        let mut state = world();
        wielded(&mut state, 0x8000_0010, 100, 0x0000_0200, 0); // breastplate (CHEST_ARMOR)
        wielded(&mut state, 0x8000_0011, 101, 0x0000_1000, 0); // bracers (LOWER_ARM_ARMOR)
        pack_item(&mut state, 0x8000_0012, 102, 0x0000_1A00, 0); // coat
        assert!(conflicts(&state, 0x8000_0012, 0x0000_0200).is_empty());
    }

    /// Shirt over shirt: also refused by the server, never swapped.
    #[test]
    fn plan_wield_shirt_over_shirt_moves_nothing() {
        let mut state = world();
        wielded(&mut state, 0x8000_0020, 200, 0x0000_001A, 0);
        pack_item(&mut state, 0x8000_0021, 201, 0x0000_001A, 0);
        assert!(conflicts(&state, 0x8000_0021, 0x0000_0002).is_empty());
    }

    /// Sword over sword: the retail unblock still runs.
    #[test]
    fn plan_wield_sword_over_sword_unequips_old_sword() {
        let mut state = world();
        wielded(&mut state, 0x8000_0030, 300, 0x0010_0000, 0);
        pack_item(&mut state, 0x8000_0031, 301, 0x0010_0000, 0);
        assert_eq!(
            conflicts(&state, 0x8000_0031, 0x0010_0000),
            vec![0x8000_0030]
        );
    }

    /// Arrows of the SAME wcid as the wielded stack merge (JS), never swap.
    #[test]
    fn plan_wield_same_wcid_ammo_is_not_swapped() {
        let mut state = world();
        wielded(&mut state, 0x8000_0040, 300, 0x0080_0000, 1);
        pack_item(&mut state, 0x8000_0041, 300, 0x0080_0000, 1);
        assert!(conflicts(&state, 0x8000_0041, 0x0080_0000).is_empty());
    }

    /// Arrows of a DIFFERENT wcid: the wielded stack goes back to the pack.
    #[test]
    fn plan_wield_different_wcid_ammo_unequips_old_stack() {
        let mut state = world();
        wielded(&mut state, 0x8000_0050, 300, 0x0080_0000, 1);
        pack_item(&mut state, 0x8000_0051, 301, 0x0080_0000, 1);
        assert_eq!(
            conflicts(&state, 0x8000_0051, 0x0080_0000),
            vec![0x8000_0050]
        );
    }

    /// A launcher over a shield and mismatched quarrels pulls both.
    #[test]
    fn plan_wield_bow_clears_shield_and_mismatched_ammo() {
        let mut state = world();
        wielded(&mut state, 0x8000_0060, 400, 0x0020_0000, 0); // shield
        wielded(&mut state, 0x8000_0061, 401, 0x0080_0000, 2); // quarrels
        wielded(&mut state, 0x8000_0062, 402, 0x0000_0200, 0); // breastplate stays
        pack_item(&mut state, 0x8000_0063, 403, 0x0040_0000, 1); // bow (arrows)
        assert_eq!(
            conflicts(&state, 0x8000_0063, 0x0040_0000),
            vec![0x8000_0060, 0x8000_0061]
        );
    }

    #[test]
    fn plan_wield_two_handed_combat_use_and_dual_wield_offhand() {
        let mut state = world();
        // Shield equipped in 0x0020_0000.
        wielded(&mut state, 0x8000_0070, 500, 0x0020_0000, 0);
        // Two-handed weapon whose ValidLocations is MELEE_WEAPON (0x0010_0000)
        // with CombatUse = 5 (TwoHanded): clears shield.
        pack_item(&mut state, 0x8000_0071, 501, 0x0010_0000, 0);
        state
            .entities
            .get_mut(Guid(0x8000_0071))
            .unwrap()
            .properties
            .ints
            .insert(PropertyInt::CombatUse, 5);
        assert_eq!(
            conflicts(&state, 0x8000_0071, 0x0010_0000),
            vec![0x8000_0070]
        );

        // Dual-wielding a 1H sword into SHIELD (0x0020_0000) while a 2H sword
        // is equipped in MELEE_WEAPON clears the 2H sword, NOT a 1H main-hand sword.
        let mut state2 = world();
        wielded(&mut state2, 0x8000_0072, 502, 0x0010_0000, 0); // 1H main-hand
        pack_item(&mut state2, 0x8000_0073, 503, 0x0010_0000, 0); // 1H off-hand
        assert!(conflicts(&state2, 0x8000_0073, 0x0020_0000).is_empty());

        state2
            .entities
            .get_mut(Guid(0x8000_0072))
            .unwrap()
            .properties
            .ints
            .insert(PropertyInt::CombatUse, 5);
        assert_eq!(
            conflicts(&state2, 0x8000_0073, 0x0020_0000),
            vec![0x8000_0072]
        );
    }

    fn main_pack_filler(state: &mut WorldState, guid: u32) {
        let mut entity = Entity::new(Guid(guid), format!("gem {guid:x}"), WorldPosition::default());
        entity
            .properties
            .iids
            .insert(holtburger_common::properties::PropertyInstanceId::Container, PLAYER);
        state.entities.insert(entity);
        state.player.add_to_inventory(Guid(guid));
    }

    fn side_pack(state: &mut WorldState, guid: u32, cap: u32, locked: bool) {
        let mut entity = Entity::new(Guid(guid), format!("pack {guid:x}"), WorldPosition::default());
        entity
            .properties
            .iids
            .insert(holtburger_common::properties::PropertyInstanceId::Container, PLAYER);
        entity
            .properties
            .bools
            .insert(PropertyBool::RequiresBackpackSlot, true);
        if cap > 0 {
            entity
                .properties
                .ints
                .insert(PropertyInt::ItemsCapacity, cap as i32);
        }
        if locked {
            entity.properties.bools.insert(PropertyBool::Locked, true);
        }
        state.entities.insert(entity);
        state.player.add_to_inventory(Guid(guid));
    }

    #[test]
    fn unequip_destinations_overflows_full_main_pack_into_openable_side_pack() {
        let mut state = world();
        wielded(&mut state, 0x8000_0100, 600, 0x0010_0000, 0); // sword
        wielded(&mut state, 0x8000_0101, 601, 0x0020_0000, 0); // shield

        // Foci (RequiresBackpackSlot = true, ItemsCapacity = 0), locked pack,
        // 1-slot side pack, and 24-slot side pack.
        side_pack(&mut state, 0x7000_0001, 0, false); // Foci — cannot hold items
        side_pack(&mut state, 0x7000_0002, 24, true); // Locked — skipped
        side_pack(&mut state, 0x7000_0003, 1, false); // 1 free slot
        side_pack(&mut state, 0x7000_0004, 24, false); // 24 free slots

        // Fill 101 of 102 main-pack item slots: first unequip fits main pack,
        // second overflows past Foci & locked pack into 0x7000_0003.
        for i in 0..101u32 {
            main_pack_filler(&mut state, 0x6000_1000 + i);
        }
        assert_eq!(
            unequip_destinations(&state, &[Guid(0x8000_0100), Guid(0x8000_0101)]),
            vec![
                (Guid(0x8000_0100), PLAYER),
                (Guid(0x8000_0101), Guid(0x7000_0003)),
            ]
        );

        // Fill the 102nd main-pack slot: sword goes to 1-slot pack 0x7000_0003,
        // shield overflows into 0x7000_0004.
        main_pack_filler(&mut state, 0x6000_10FF);
        assert_eq!(
            unequip_destination(&state, Guid(0x8000_0100)),
            Guid(0x7000_0003)
        );
        assert_eq!(
            unequip_destinations(&state, &[Guid(0x8000_0100), Guid(0x8000_0101)]),
            vec![
                (Guid(0x8000_0100), Guid(0x7000_0003)),
                (Guid(0x8000_0101), Guid(0x7000_0004)),
            ]
        );
    }
}
