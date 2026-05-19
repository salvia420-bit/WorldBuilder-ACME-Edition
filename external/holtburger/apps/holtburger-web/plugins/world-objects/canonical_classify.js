/**
 * Canonical port of `Chorizite/ACPlugin/API/WorldObject.cs:344-411`
 * `WorldObject.GetObjectClass(itemType, objDescFlags, createFlags)`.
 *
 * THIS IS THE ENTIRETY OF THE ENTITY-COMPLETENESS CLASSIFIER. There is
 * NO heuristic dispatch — the algorithm is a 1:1 mirror of ACPlugin's
 * implementation (which itself mirrors retail acclient.exe's internal
 * classifier). Same wire inputs → same `ObjectClass` output as every
 * other AC client implementation.
 *
 * If the algorithm returns `'Unknown'`, the caller MUST instantiate the
 * `WorldObject` base sentinel and log it — not pick a fallback. See
 * `docs/entity-completeness-method.md` §3-§5 for the contract.
 *
 * Bitflag constants are inlined here (sourced from
 * `external/chorizite/Chorizite.Common/Enums/{ItemType,ObjectDescriptionFlag,
 * WeenieHeaderFlag}.cs`) so the classifier is self-contained — no
 * runtime dependency on the JSON enum tables that drive the UI side.
 *
 * Each branch carries a `// WorldObject.cs:LLL` comment citing the C#
 * source line it ports.
 */

// ─────────────────────────────────────────────────────────────────────
// Bitflag constants (sourced from Chorizite.Common/Enums/*.cs)
// ─────────────────────────────────────────────────────────────────────

// ItemType (bitflag enum, u32). Source: Chorizite.Common/Enums/ItemType.cs.
const IT_MELEE_WEAPON                 = 0x00000001;
const IT_ARMOR                        = 0x00000002;
const IT_CLOTHING                     = 0x00000004;
const IT_JEWELRY                      = 0x00000008;
const IT_CREATURE                     = 0x00000010;
const IT_FOOD                         = 0x00000020;
const IT_MONEY                        = 0x00000040;
const IT_MISC                         = 0x00000080;
const IT_MISSILE_WEAPON               = 0x00000100;
const IT_CONTAINER                    = 0x00000200;
const IT_USELESS                      = 0x00000400;
const IT_GEM                          = 0x00000800;
const IT_SPELL_COMPONENTS             = 0x00001000;
const IT_WRITABLE                     = 0x00002000;
const IT_KEY                          = 0x00004000;
const IT_CASTER                       = 0x00008000;
const IT_PORTAL                       = 0x00010000;
// const IT_LOCKABLE                  = 0x00020000;  // not used by classifier
const IT_PROMISSORY_NOTE              = 0x00040000;
const IT_MANA_STONE                   = 0x00080000;
const IT_SERVICE                      = 0x00100000;
const IT_MAGIC_WIELDABLE              = 0x00200000;
const IT_CRAFT_COOKING_BASE           = 0x00400000;
const IT_CRAFT_ALCHEMY_BASE           = 0x00800000;
const IT_CRAFT_FLETCHING_BASE         = 0x02000000;
// const IT_CRAFT_ALCHEMY_INTERMEDIATE = 0x04000000; // not used by classifier
const IT_CRAFT_FLETCHING_INTERMEDIATE = 0x08000000;
const IT_TINKERING_TOOL               = 0x20000000;
const IT_TINKERING_MATERIAL           = 0x40000000;

// ObjectDescriptionFlag (bitflag enum, u32).
// Source: Chorizite.Common/Enums/PhysicsDescriptionFlag.cs is NOT this —
// the actual file in chorizite is the ObjectDescriptionFlag exposed through
// the protocol layer. Bits sourced from
// external/holtburger/crates/holtburger-common/src/properties/object.rs
// (`ObjectDescriptionFlag` bitflags definition; mirrored from retail
// acclient.h ObjectDescriptionFlag enum).
const ODF_OPENABLE                    = 0x00000001;
const ODF_INSCRIBABLE                 = 0x00000002;
const ODF_STUCK                       = 0x00000004;
const ODF_PLAYER                      = 0x00000008;
const ODF_ATTACKABLE                  = 0x00000010;
const ODF_PLAYER_KILLER               = 0x00000020;
const ODF_HIDDEN_ADMIN                = 0x00000040;
const ODF_UI_HIDDEN                   = 0x00000080;
const ODF_BOOK                        = 0x00000100;
const ODF_VENDOR                      = 0x00000200;
const ODF_PK_SWITCH                   = 0x00000400;
const ODF_NPK_SWITCH                  = 0x00000800;
const ODF_DOOR                        = 0x00001000;
const ODF_CORPSE                      = 0x00002000;
const ODF_LIFESTONE                   = 0x00004000;
const ODF_FOOD                        = 0x00008000;
const ODF_HEALER                      = 0x00010000;
const ODF_LOCKPICK                    = 0x00020000;
const ODF_PORTAL                      = 0x00040000;
const ODF_ADMIN                       = 0x00100000;
const ODF_FREE_PK_STATUS              = 0x00200000;
const ODF_IMMUNE_CELL_RESTRICTIONS    = 0x00400000;
const ODF_REQUIRES_PACK_SLOT          = 0x00800000;
const ODF_RETAINED                    = 0x01000000;
const ODF_PK_LITE_PK_STATUS           = 0x02000000;
const ODF_INCLUDES_SECOND_HEADER      = 0x04000000;
const ODF_BIND_STONE                  = 0x08000000;
const ODF_VOLATILE_RARE               = 0x10000000;
const ODF_WIELD_ON_USE                = 0x20000000;
const ODF_WIELDED_HAS_BEEN_USED       = 0x40000000;

// WeenieHeaderFlag (bitflag enum, u32). Only Spell needed by the classifier.
// Source: holtburger-common/src/properties/object.rs WeenieHeaderFlag.
const WHF_SPELL                       = 0x00100000;

// ─────────────────────────────────────────────────────────────────────
// The classifier — verbatim port of ACPlugin/API/WorldObject.cs:344-411
// ─────────────────────────────────────────────────────────────────────

/**
 * Map (itemType bitfield, objDescFlags bitfield, createFlags bitfield)
 * to an `ObjectClass` enum-symbol name (matching
 * `Chorizite.Common.Enums.ObjectClass`). Returns `'Unknown'` when none
 * of the 43 rules apply.
 *
 * The caller (WorldObjectManager) maps the returned name to a concrete
 * JS class via the constructor table in world_object_manager.js.
 *
 * @param {number} itemType   u32 ItemType bitfield from EntityUpdate
 * @param {number} objDescFlags  u32 ObjectDescriptionFlag bitfield
 * @param {number} createFlags  u32 WeenieHeaderFlag bitfield
 * @returns {string} ObjectClass name, or `'Unknown'`
 */
export function canonicalClassify(itemType, objDescFlags, createFlags) {
  let objectClass = 'Unknown';

  // PASS 1 — ItemType cascade (WorldObject.cs:347-371)
  if      (itemType & IT_MELEE_WEAPON)        objectClass = 'MeleeWeapon';      // :347
  else if (itemType & IT_ARMOR)               objectClass = 'Armor';            // :348
  else if (itemType & IT_CLOTHING)            objectClass = 'Clothing';         // :349
  else if (itemType & IT_JEWELRY)             objectClass = 'Jewelry';          // :350
  else if (itemType & IT_CREATURE)            objectClass = 'Monster';          // :351 (refined PASS 3)
  else if (itemType & IT_FOOD)                objectClass = 'Food';             // :352
  else if (itemType & IT_MONEY)               objectClass = 'Money';            // :353
  else if (itemType & IT_MISC)                objectClass = 'Misc';             // :354
  else if (itemType & IT_MISSILE_WEAPON)      objectClass = 'MissileWeapon';    // :355
  else if (itemType & IT_CONTAINER)           objectClass = 'Container';        // :356
  else if (itemType & IT_USELESS)             objectClass = 'Bundle';           // :357
  else if (itemType & IT_GEM)                 objectClass = 'Gem';              // :358
  else if (itemType & IT_SPELL_COMPONENTS)    objectClass = 'SpellComponent';   // :359
  else if (itemType & IT_KEY)                 objectClass = 'Key';              // :360 (also :371 — C# duplicate, harmless)
  else if (itemType & IT_CASTER)              objectClass = 'WandStaffOrb';     // :361
  else if (itemType & IT_PORTAL)              objectClass = 'Portal';           // :362
  else if (itemType & IT_PROMISSORY_NOTE)     objectClass = 'TradeNote';        // :363
  else if (itemType & IT_MANA_STONE)          objectClass = 'ManaStone';        // :364
  else if (itemType & IT_SERVICE)             objectClass = 'Services';         // :365
  else if (itemType & IT_MAGIC_WIELDABLE)     objectClass = 'Plant';            // :366
  else if (itemType & IT_CRAFT_COOKING_BASE)  objectClass = 'BaseCooking';      // :367
  else if (itemType & IT_CRAFT_ALCHEMY_BASE)  objectClass = 'BaseAlchemy';      // :368
  else if (itemType & IT_CRAFT_FLETCHING_BASE) objectClass = 'BaseFletching';   // :369
  else if (itemType & IT_CRAFT_FLETCHING_INTERMEDIATE) objectClass = 'CraftedFletching'; // :370
  else if (itemType & IT_TINKERING_TOOL)      objectClass = 'Ust';              // :371
  else if (itemType & IT_TINKERING_MATERIAL)  objectClass = 'Salvage';          // :372

  // PASS 2 — ObjectDescriptionFlag overrides (WorldObject.cs:375-388)
  if      (objDescFlags & ODF_PLAYER)             objectClass = 'Player';       // :375
  else if (objDescFlags & ODF_VENDOR)             objectClass = 'Vendor';       // :376
  else if (objDescFlags & ODF_DOOR)               objectClass = 'Door';         // :377
  else if (objDescFlags & ODF_CORPSE)             objectClass = 'Corpse';       // :378
  else if (objDescFlags & ODF_LIFESTONE)          objectClass = 'Lifestone';    // :379
  else if (objDescFlags & ODF_FOOD)               objectClass = 'Food';         // :380
  else if (objDescFlags & ODF_HEALER)             objectClass = 'HealingKit';   // :381
  else if (objDescFlags & ODF_LOCKPICK)           objectClass = 'Lockpick';     // :382
  else if (objDescFlags & ODF_PORTAL)             objectClass = 'Portal';       // :383
  else if (objDescFlags & ODF_REQUIRES_PACK_SLOT) objectClass = 'Foci';         // :384
  else if (objDescFlags & ODF_OPENABLE)           objectClass = 'Container';    // :385
  else if (objDescFlags & ODF_BIND_STONE)         objectClass = 'Bindstone';    // :386

  // PASS 3 — Writable + Book disambiguation (WorldObject.cs:390-394)
  if (objectClass === 'Unknown'
      && (itemType & IT_WRITABLE)
      && (objDescFlags & ODF_BOOK)) {
    if      (objDescFlags & ODF_INSCRIBABLE) objectClass = 'Journal';            // :391
    else if (objDescFlags & ODF_STUCK)       objectClass = 'Sign';               // :392
    else                                     objectClass = 'Book';               // :393
  }

  // PASS 3b — Scroll discrimination (WorldObject.cs:396)
  if ((itemType & IT_WRITABLE) && (createFlags & WHF_SPELL)) {
    objectClass = 'Scroll';
  }

  // PASS 3c — Monster → Npc refinement (WorldObject.cs:398-401)
  if (objectClass === 'Monster') {
    if (!(objDescFlags & ODF_ATTACKABLE)) objectClass = 'Npc';                   // :399
    if (objDescFlags & ODF_INCLUDES_SECOND_HEADER) objectClass = 'Npc';          // :400
  }

  // PASS 3d — Misc/Unknown + Stuck → Static (WorldObject.cs:403-407)
  if ((objectClass === 'Misc' || objectClass === 'Unknown')
      && (objDescFlags & ODF_STUCK)) {
    objectClass = 'Static';                                                       // :405
  }

  return objectClass;
}

// Exported for unit tests + WB.Terminal cross-port parity probe.
export const BITFLAGS = {
  ItemType: {
    MeleeWeapon: IT_MELEE_WEAPON, Armor: IT_ARMOR, Clothing: IT_CLOTHING,
    Jewelry: IT_JEWELRY, Creature: IT_CREATURE, Food: IT_FOOD,
    Money: IT_MONEY, Misc: IT_MISC, MissileWeapon: IT_MISSILE_WEAPON,
    Container: IT_CONTAINER, Useless: IT_USELESS, Gem: IT_GEM,
    SpellComponents: IT_SPELL_COMPONENTS, Writable: IT_WRITABLE, Key: IT_KEY,
    Caster: IT_CASTER, Portal: IT_PORTAL, PromissoryNote: IT_PROMISSORY_NOTE,
    ManaStone: IT_MANA_STONE, Service: IT_SERVICE, MagicWieldable: IT_MAGIC_WIELDABLE,
    CraftCookingBase: IT_CRAFT_COOKING_BASE, CraftAlchemyBase: IT_CRAFT_ALCHEMY_BASE,
    CraftFletchingBase: IT_CRAFT_FLETCHING_BASE,
    CraftFletchingIntermediate: IT_CRAFT_FLETCHING_INTERMEDIATE,
    TinkeringTool: IT_TINKERING_TOOL, TinkeringMaterial: IT_TINKERING_MATERIAL,
  },
  ObjectDescriptionFlag: {
    Openable: ODF_OPENABLE, Inscribable: ODF_INSCRIBABLE, Stuck: ODF_STUCK,
    Player: ODF_PLAYER, Attackable: ODF_ATTACKABLE, PlayerKiller: ODF_PLAYER_KILLER,
    HiddenAdmin: ODF_HIDDEN_ADMIN, UiHidden: ODF_UI_HIDDEN, Book: ODF_BOOK,
    Vendor: ODF_VENDOR, PkSwitch: ODF_PK_SWITCH, NpkSwitch: ODF_NPK_SWITCH,
    Door: ODF_DOOR, Corpse: ODF_CORPSE, Lifestone: ODF_LIFESTONE,
    Food: ODF_FOOD, Healer: ODF_HEALER, Lockpick: ODF_LOCKPICK,
    Portal: ODF_PORTAL, Admin: ODF_ADMIN, FreePkStatus: ODF_FREE_PK_STATUS,
    ImmuneCellRestrictions: ODF_IMMUNE_CELL_RESTRICTIONS,
    RequiresPackSlot: ODF_REQUIRES_PACK_SLOT, Retained: ODF_RETAINED,
    PkLitePkStatus: ODF_PK_LITE_PK_STATUS,
    IncludesSecondHeader: ODF_INCLUDES_SECOND_HEADER,
    BindStone: ODF_BIND_STONE, VolatileRare: ODF_VOLATILE_RARE,
    WieldOnUse: ODF_WIELD_ON_USE, WieldedHasBeenUsed: ODF_WIELDED_HAS_BEEN_USED,
  },
  WeenieHeaderFlag: {
    Spell: WHF_SPELL,
  },
};
