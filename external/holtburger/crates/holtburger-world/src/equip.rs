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

use crate::context::WorldContext;
use holtburger_common::Guid;
use holtburger_common::properties::{EquipMask, WorldObjectExt};

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
    let new_is_launcher = requested.intersects(EquipMask::MISSILE_WEAPON) && new_ammo_type != 0;
    let new_blocks_shield =
        new_is_launcher || requested.intersects(EquipMask::TWO_HANDED | EquipMask::CASTER);

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
        let shield_vs_weapon = requested.intersects(EquipMask::SHIELD)
            && (loc.intersects(EquipMask::TWO_HANDED | EquipMask::CASTER)
                || (loc.intersects(EquipMask::MISSILE_WEAPON)
                    && equipped.ammo_type().unwrap_or(0) != 0));
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
}
