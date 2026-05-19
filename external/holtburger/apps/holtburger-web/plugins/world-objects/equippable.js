/** Equippable — extends Item. Base for Armor / Clothing / Jewelry /
 *  MeleeWeapon / MissileWeapon / Wand.
 *
 * AC retail behavior: clicking an equipped item unequips it; clicking
 * an unequipped item equips it (to the slot from ValidLocations).
 */
import { Item } from './item.js';

const PROP_VALID_LOCATIONS            = 18; // PropertyInt
const PROP_CURRENTLY_WIELDED_LOCATION = 19; // PropertyInt — 0 when unequipped

export class Equippable extends Item {
  /** Toggle equipped state on this item. */
  use() {
    return this.examine();
  }

  /** Explicit equip (currently identical to use(); reserved for future
   *  pre-check additions like stance requirements). */
  equip()   { return this.use(); }
  /** Explicit unequip. */
  unequip() { return this.use(); }

  /** Whether the item is currently worn/wielded. */
  get isEquipped() {
    return this.intValue(PROP_CURRENTLY_WIELDED_LOCATION, 0) !== 0;
  }

  /** ValidLocations bitfield (EquipMask) describing which slots accept this item. */
  get validLocations() {
    return this.intValue(PROP_VALID_LOCATIONS, 0);
  }
}
