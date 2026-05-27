/** Equippable — extends Item. Base for Armor / Clothing / Jewelry /
 *  MeleeWeapon / MissileWeapon / Wand.
 *
 * 1:1 port of `external/chorizite/ACPlugin/API/WorldObjects/Equippable.cs`
 * (vendored HEAD 1341660), plus the `SetWielded` helper that lives on
 * `Character.cs:757-762` in the upstream — relocated here on the equippable
 * weenie because (a) the semantic mutation is to the equippable itself,
 * (b) the local-character dependency was the Character-class-only reason
 * upstream put it on Character, and (c) the handoff explicitly assigns
 * `SetWielded` to `equippable.js`. PR 4 (Character.cs JS port) wires the
 * `world.dispatchItemWearItem` call-path to invoke this method.
 *
 * AC retail behavior: clicking an equipped item unequips it; clicking
 * an unequipped item equips it (to the slot from ValidLocations).
 */
import { Item } from './item.js';

const PROP_VALID_LOCATIONS            = 18; // PropertyInt.ValidLocations
const PROP_CURRENTLY_WIELDED_LOCATION = 19; // PropertyInt.CurrentWieldedLocation — 0 when unequipped
const PROP_INSTANCE_WIELDER           = 3;  // PropertyInstanceId.Wielder  (Character.cs:758)
const PROP_INT_CURRENT_WIELDED_LOC    = 19; // PropertyInt.CurrentWieldedLocation (Character.cs:759)

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

  /**
   * The wielder of this equippable, if any. Read-through lookup over the
   * world's weenie map for `PropertyInstanceId.Wielder`. Mirrors
   * `Equippable.cs:13`:
   *   `World.Get((uint)Value(PropertyInstanceId.Wielder)) as Creature`
   *
   * Returns null when:
   *   - PropertyInstanceId.Wielder is unset (item is on ground / in a pack)
   *   - the wielder guid isn't in scope
   *   - the looked-up weenie isn't a Creature (we duck-type)
   *
   * @returns {object|null} Creature subclass instance, or null
   */
  get wielder() {
    const wielderId = this.instanceValue(PROP_INSTANCE_WIELDER, 0);
    if (!wielderId) return null;
    const wo = this._lookupWeenie(wielderId);
    if (!wo) return null;
    // Duck-type for Creature: Creature subclasses have `combatMode`
    // getter (added in creature.js) AND extend Container (so they have
    // `containerType`). Static-imports would create cycles.
    if (!('combatMode' in wo)) return null;
    return wo;
  }

  /**
   * Mark this equippable as wielded by `parentGuid` in `slot`. Mirrors
   * `Character.cs:757-762`:
   *
   *     internal void SetWielded(WorldObject weenie, EquipMask slot) {
   *         weenie.AddOrUpdateValue(PropertyInstanceId.Wielder, Character.Id);
   *         weenie.AddOrUpdateValue(PropertyInt.CurrentWieldedLocation, (int)slot);
   *     }
   *
   * Per handoff §"Critical semantics" — relocated to Equippable.js so
   * the mutation is colocated with the equippable's property store
   * (Character.cs JS port lands in PR 4; until then, the wire dispatch
   * path in PR 2's `dispatchItemWearItem` should call
   * `equippable.setWielded(localCharacterId, slot)`).
   *
   * `Character.cs:761` has a commented-out `Equipment.Add(weenie)` —
   * upstream relies on the property-store mutation + the read-through
   * `Creature.equipment` getter (added in creature.js) so we don't need
   * a maintained list either.
   *
   * Uses PR 1's `setInstanceValue` (short-circuits on unchanged writes
   * per `WorldObject.cs:501-508`) and `setIntValue` (invalidates the
   * `_objectClass` cache).
   *
   * @param {number} parentGuid Wielding creature's GUID (uint32)
   * @param {number} slot       EquipMask bit identifying the wield slot
   */
  setWielded(parentGuid, slot) {
    this.setInstanceValue(PROP_INSTANCE_WIELDER, (parentGuid ?? 0) >>> 0);
    this.setIntValue(PROP_INT_CURRENT_WIELDED_LOC, (slot ?? 0) | 0);
  }
}
