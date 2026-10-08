// scene3d/held_location.js — held-6 (2026-10-08, `?heldMountStrict`).
//
// Where a wielded item mounts when the wielded-items snapshot carries no
// ParentLocation yet (the authoritative ParentEvent / CreateObject Parent has
// not landed): the fallback `flushWieldedDirty` (scene3d/index.js) uses until
// the server's own attach arrives. It mirrors ACE's server mapping,
// `Creature_Equipment.GetPlacementLocation` (Creature_Equipment.cs), which is
// what that ParentEvent will carry (ParentLocation / Placement enums,
// ACE.Entity/Enum/ParentLocation.cs + Placement.cs):
//
//   MeleeWeapon / Held / TwoHanded   → RightHand(1)  / RightHandCombat(1)
//   Shield slot, ItemType Armor      → Shield(3)     / Shield(6)
//   Shield slot, anything else       → LeftWeapon(8) / RightHandNonCombat(2)
//     (an off-hand weapon)
//   MissileWeapon                    → bow / crossbow LeftHand(2) / LeftHand(3),
//                                      otherwise RightHand(1) / RightHandCombat(1)
//     — the combat style that decides it is not in the snapshot, so: null
//       (wait for the authoritative attach)
//   MissileAmmo                      → ACE: None(0), which retail cannot
//     mount until the reload ParentEvent(RightHand). Kept on the FU-1
//     Quiver(5) mapping while `?wieldHandAttach` is on (owner call, held-6 c).
//
// The old fallback sent bows to the right hand and off-hand weapons to the
// shield slot, always with placement 0. Pure; no DOM, no wasm.

const EQUIP_MELEE_WEAPON = 0x00100000;
const EQUIP_SHIELD = 0x00200000;
const EQUIP_MISSILE_WEAPON = 0x00400000;
const EQUIP_MISSILE_AMMO = 0x00800000;
const EQUIP_HELD = 0x01000000;
const EQUIP_TWO_HANDED = 0x02000000;
const ITEM_TYPE_ARMOR = 0x00000002;

/**
 * Fallback mount for a wielded item whose ParentLocation is still 0.
 * Like ACE's switch, `equipMask` is the item's CurrentWieldedLocation (one
 * slot); anything else answers null.
 *
 * @param {number} equipMask  CurrentWieldedLocation (EquipMask) of the item
 * @param {number} itemType   ItemType of the item
 * @param {{ammoQuiver?: boolean}} [opts] ammoQuiver = FU-1 `?wieldHandAttach`
 * @returns {{loc: number, place: number} | null} null = do not guess
 */
export function heuristicParentLocation(equipMask, itemType, { ammoQuiver = true } = {}) {
  switch (equipMask >>> 0) {
    case EQUIP_MELEE_WEAPON:
    case EQUIP_HELD:
    case EQUIP_TWO_HANDED:
      return { loc: 1, place: 1 };
    case EQUIP_SHIELD:
      return (itemType >>> 0) === ITEM_TYPE_ARMOR // ACE: ItemType == Armor
        ? { loc: 3, place: 6 }
        : { loc: 8, place: 2 };
    case EQUIP_MISSILE_WEAPON:
      return null;
    case EQUIP_MISSILE_AMMO:
      return ammoQuiver ? { loc: 5, place: 0 } : null;
    default:
      return null;
  }
}
