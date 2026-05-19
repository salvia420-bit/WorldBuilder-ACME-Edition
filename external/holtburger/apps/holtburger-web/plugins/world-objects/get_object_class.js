/**
 * Port of Chorizite/ACPlugin/API/WorldObject.cs GetObjectClass dispatch.
 *
 * Maps (ItemType, Behavior, Header) → ObjectClass name. ObjectClass is the
 * coarse-grained discriminator that drives WorldObjectManager's typed-class
 * dispatch (e.g. ObjectClass.Vendor → instantiate Vendor, ObjectClass.Door →
 * Door, etc.).
 *
 * One known FIX vs upstream C# (per ACPlugin READING_GUIDE.md §3 surprise #3):
 * the C# `World.cs:622-706` GetOrCreateWorldObject switch is MISSING the
 * Lifestone case — Lifestone falls through to Static there. Our port adds
 * the explicit case so Lifestone gets its own Lifestone class instance.
 *
 * IMPORTANT: this dispatch table needs the actual numeric values of ItemType
 * + ObjectClass enums. We don't hardcode them — the WorldObjectManager passes
 * the resolved enum names (via ChoriziteEnums.nameOf) and we dispatch on
 * those. Net effect: changing enum int values upstream doesn't break this code.
 */

const OBJECT_CLASS_TO_CLASS_NAME = {
  Player: 'Player',
  Npc: 'NPC',
  Vendor: 'Vendor',
  Monster: 'Monster',
  Container: 'Container',
  Corpse: 'Corpse',
  Door: 'Door',
  Portal: 'Portal',
  Lifestone: 'Lifestone',
  Bindstone: 'Bindstone',
  Foci: 'Foci',
  Armor: 'Armor',
  Clothing: 'Clothing',
  Jewelry: 'Jewelry',
  Gem: 'Gem',
  Food: 'Food',
  Key: 'Key',
  ManaStone: 'ManaStone',
  SpellComponent: 'SpellComponent',
  Scroll: 'Scroll',
  TradeNote: 'TradeNote',
  MeleeWeapon: 'MeleeWeapon',
  MissileWeapon: 'MissileWeapon',
  WandStaffOrb: 'Wand',
  Ust: 'Ust',
  Static: 'Static',
  Sign: 'Static',
  Plant: 'Static',
  HealingKit: 'Item',
  Lockpick: 'Item',
  Money: 'Item',
  Book: 'Item',
  Journal: 'Item',
  Bundle: 'Item',
  Salvage: 'Item',
  BaseAlchemy: 'Item',
  BaseCooking: 'Item',
  BaseFletching: 'Item',
  CraftedFletching: 'Item',
  Misc: 'Item',
  Services: 'Item',
  Unknown: 'WorldObject',
};

/**
 * Given an ItemType enum-symbol name (e.g. "MeleeWeapon"), an ObjectClass
 * enum-symbol name (e.g. "Vendor"), and a Behavior integer bitfield, return
 * the concrete JS class NAME to instantiate.
 *
 * The dispatch prefers ObjectClass when available, falling back to ItemType.
 * If both are unknown/ambiguous, returns 'WorldObject' (the generic base).
 *
 * @returns {string} class name (matches taxonomy.json `name` field)
 */
export function resolveClassName({ itemTypeName, objectClassName, behavior: _behavior }) {
  // `behavior` is the ObjectDescriptionFlag bitfield; reserved for future
  // disambiguation rules (e.g. PlayerKiller flag → Monster vs NPC).
  // Prefer explicit ObjectClass when set.
  if (objectClassName && OBJECT_CLASS_TO_CLASS_NAME[objectClassName]) {
    return OBJECT_CLASS_TO_CLASS_NAME[objectClassName];
  }

  // Fall back to ItemType-based heuristics (mirrors ACPlugin GetObjectClass:362-411).
  switch (itemTypeName) {
    case 'Armor':              return 'Armor';
    case 'Clothing':           return 'Clothing';
    case 'Jewelry':            return 'Jewelry';
    case 'MeleeWeapon':        return 'MeleeWeapon';
    case 'MissileWeapon':      return 'MissileWeapon';
    case 'MagicWieldable':     return 'Wand';
    case 'Caster':             return 'Wand';
    case 'Container':          return 'Container';
    case 'Creature':           return 'Creature';
    case 'Food':               return 'Food';
    case 'Gem':                return 'Gem';
    case 'Key':                return 'Key';
    case 'ManaStone':          return 'ManaStone';
    case 'Money':              return 'Item';
    case 'Portal':             return 'Portal';
    case 'Scroll':             return 'Scroll';
    case 'Service':            return 'Item';
    case 'SpellComponents':    return 'SpellComponent';
    case 'PromissoryNote':     return 'TradeNote';
    case 'Writable':           return 'Item';
    case 'Misc':               return 'Item';
    case 'Useless':            return 'Item';
    default:                   return 'WorldObject';
  }
}
