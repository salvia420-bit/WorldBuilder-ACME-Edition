/**
 * Browser-side mirror of Chorizite/ACPlugin/API/WorldObject.cs.
 *
 * The retail AC client (and ACPlugin) models every in-world thing as a
 * WorldObject with 8 typed-property dictionaries. We mirror the same shape
 * here so plugin code can do `wo.value(PropertyInt.Burden, 0)` instead of
 * threading raw property maps everywhere.
 *
 * Per [[../../../docs/chorizite-reading-guide-summary-2026-05-27.md]] §5.2
 * the 8-dict pattern is exactly what retail uses on the wire (PublicWeenieDesc /
 * ObjDesc / PhysicsDesc carry typed property bundles). This is a 1:1 port of
 * `ACPlugin/API/WorldObject.cs:42-682` with the following deltas:
 *
 *   - Setter overloads (`AddOrUpdateValue`/`RemoveValue`/`UpdateStatsTable`)
 *     collapse to one method per JS dict (we don't have C# method-overload
 *     resolution; callers route via dict instead of via the value-type).
 *   - `Position` defaults to `null` to match C# `Position?` nullability.
 *   - `objectClass` uses lazy memoization (port of `_objectClass` field +
 *     `get` accessor at `WorldObject.cs:42, 147-155`), via the canonical
 *     classifier in `./canonical_classify.js`.
 *   - `int64` values stay as JS BigInt so callers can carry the full ACE
 *     i64 range (e.g. `PropertyInt64.TotalExperience`).
 *
 * Citations of `WorldObject.cs:LLL` are file:line into
 * `external/chorizite/ACPlugin/API/WorldObject.cs` (vendored HEAD 1341660).
 */

import { canonicalClassify } from './canonical_classify.js';

// ─────────────────────────────────────────────────────────────────────
// WeenieHeaderFlag + WeenieHeaderFlag2 constants
// ─────────────────────────────────────────────────────────────────────
// Sourced verbatim from `external/chorizite/Chorizite.Common/Enums/
// WeenieHeaderFlag.cs:7-41` and `WeenieHeaderFlag2.cs:7-13`. Cross-verified
// against `external/holtburger/crates/holtburger-common/src/properties/
// object.rs` `WeenieHeaderFlag` bitflags. Required by `updateWeenieDesc`
// (port of `WorldObject.cs:558-678`).

const WHF_PLURAL_NAME                = 0x00000001;
const WHF_ITEMS_CAPACITY             = 0x00000002;
const WHF_CONTAINERS_CAPACITY        = 0x00000004;
const WHF_VALUE                      = 0x00000008;
const WHF_USABLE                     = 0x00000010;
const WHF_USE_RADIUS                 = 0x00000020;
const WHF_MONARCH                    = 0x00000040;
const WHF_UI_EFFECTS                 = 0x00000080;
const WHF_AMMO_TYPE                  = 0x00000100;
const WHF_COMBAT_USE                 = 0x00000200;
const WHF_USES                       = 0x00000400; // C# "Uses" → Structure
const WHF_MAX_USES                   = 0x00000800; // C# "MaxUses" → MaxStructure
const WHF_STACK_SIZE                 = 0x00001000;
const WHF_MAX_STACK_SIZE             = 0x00002000;
const WHF_CONTAINER                  = 0x00004000;
const WHF_WIELDER                    = 0x00008000;
const WHF_VALID_EQUIP_LOCATIONS      = 0x00010000;
const WHF_CURRENTLY_WIELDED_LOCATION = 0x00020000;
const WHF_COVERAGE                   = 0x00040000;
const WHF_TARGET_TYPE                = 0x00080000;
const WHF_RADAR_BLIP_COLOR           = 0x00100000;
const WHF_BURDEN                     = 0x00200000;
const WHF_SPELL                      = 0x00400000;
const WHF_RADAR_BEHAVIOR             = 0x00800000;
const WHF_WORKMANSHIP                = 0x01000000;
const WHF_OWNER                      = 0x02000000;
// const WHF_HOUSE_RESTRICTIONS      = 0x04000000;  // not unpacked in UpdateWeenieDesc
const WHF_PHYSICS_SCRIPT             = 0x08000000;
const WHF_HOOKABLE_ON                = 0x10000000;
const WHF_HOOK_TYPE                  = 0x20000000;
const WHF_ICON_OVERLAY               = 0x40000000;
// const WHF_MATERIAL_TYPE           = 0x80000000;  // 32-bit JS bitwise sign issue; use unsigned
//   note: 0x80000000 is i32-negative under `&`. We do `>>> 0` defensive shifts
//   where needed below.
const WHF_MATERIAL_TYPE              = 0x80000000;

const WHF2_ICON_UNDERLAY             = 0x01;
const WHF2_COOLDOWN                  = 0x02;
const WHF2_COOLDOWN_DURATION         = 0x04;
const WHF2_PET_OWNER                 = 0x08;

// ─────────────────────────────────────────────────────────────────────
// PropertyInt / PropertyInt64 / PropertyBool / PropertyFloat /
// PropertyString / PropertyInstanceId / PropertyDataId / PropertyPosition
// numeric constants needed by UpdateWeenieDesc (canonical values from
// `external/holtburger/crates/holtburger-common/src/properties/
// property_keys/*.rs`).
// ─────────────────────────────────────────────────────────────────────

const PROP_INT_ITEM_TYPE                  = 1;
const PROP_INT_CLOTHING_PRIORITY          = 4;
const PROP_INT_ENCUMBRANCE_VAL            = 5;
const PROP_INT_ITEMS_CAPACITY             = 6;
const PROP_INT_CONTAINERS_CAPACITY        = 7;
const PROP_INT_VALID_LOCATIONS            = 9;
const PROP_INT_CURRENT_WIELDED_LOCATION   = 10;
const PROP_INT_MAX_STACK_SIZE             = 11;
const PROP_INT_STACK_SIZE                 = 12;
const PROP_INT_ITEM_USEABLE               = 16;
const PROP_INT_VALUE                      = 19;
const PROP_INT_AMMO_TYPE                  = 50;
const PROP_INT_COMBAT_USE                 = 51;
const PROP_INT_MAX_STRUCTURE              = 91;
const PROP_INT_STRUCTURE                  = 92;
const PROP_INT_TARGET_TYPE                = 94;
const PROP_INT_RADAR_BLIP_COLOR           = 95;
const PROP_INT_ITEM_WORKMANSHIP           = 105;
const PROP_INT_MATERIAL_TYPE              = 131;
const PROP_INT_SHOWABLE_ON_RADAR          = 133;
const PROP_INT_HOOK_TYPE                  = 151;
const PROP_INT_HOOK_ITEM_TYPE             = 152;
const PROP_INT_SHARED_COOLDOWN            = 280;

const PROP_STRING_NAME                    = 1;
const PROP_STRING_PLURAL_NAME             = 20;

const PROP_FLOAT_USE_RADIUS               = 54;
const PROP_FLOAT_COOLDOWN_DURATION        = 167;

const PROP_DATA_ICON                      = 8;
const PROP_DATA_SPELL                     = 28;
const PROP_DATA_PHYSICS_SCRIPT            = 30;
const PROP_DATA_ICON_OVERLAY              = 50;
const PROP_DATA_ICON_OVERLAY_SECONDARY    = 51;
const PROP_DATA_ICON_UNDERLAY             = 52;

const PROP_INSTANCE_OWNER                 = 1;
const PROP_INSTANCE_CONTAINER             = 2;
const PROP_INSTANCE_WIELDER               = 3;
const PROP_INSTANCE_MONARCH               = 26;
const PROP_INSTANCE_PET_OWNER             = 44;

// PhysicsDesc parent-id flag (`WorldObject.cs:554`). Hex constant in
// the upstream source; mirror exactly.
const PHYSICS_DESC_PARENT_FLAG            = 0x00000020;

export class WorldObject {
  /**
   * @param {number} id                GUID (uint32)
   * @param {number} classId           wcid (weenie class id) — equivalent of
   *                                   `WorldObject.ClassId` (`:52`)
   * @param {object|null} taxonomy     `WorldObjectTaxonomy` (introspection only).
   * @param {object|null} enums        `ChoriziteEnums` (symbol lookup for HUDs).
   * @param {object|null} manager      `WorldObjectManager` back-ref (for
   *                                   `examine`/`use` dispatch into the
   *                                   pluginClient session handle).
   */
  constructor(id, classId, taxonomy = null, enums = null, manager = null) {
    this.id = id;
    this.classId = classId;
    this.taxonomy = taxonomy;
    this.enums = enums;
    this.manager = manager;
    this.createdAt = new Date();
    this.lastAccessTime = this.createdAt;

    // Per `WorldObject.cs:78-113` — 8 typed property dictionaries.
    // C# `Dictionary<PropertyXxx, T>` → JS `Map`. Keys are the numeric
    // PropertyXxx values (callers may pass enum symbols once we wire
    // `enums.valueOf('PropertyInt', 'ItemType')`).
    /** @type {Map<number, number>}  PropertyInt → int (i32) */
    this.intValues = new Map();
    /** @type {Map<number, bigint>}  PropertyInt64 → long (i64, BigInt) */
    this.int64Values = new Map();
    /** @type {Map<number, string>}  PropertyString → string */
    this.stringValues = new Map();
    /** @type {Map<number, boolean>} PropertyBool → bool */
    this.boolValues = new Map();
    /** @type {Map<number, number>}  PropertyFloat → float (f32/f64) */
    this.floatValues = new Map();
    /** @type {Map<number, number>}  PropertyInstanceId → uint (object refs) */
    this.instanceValues = new Map();
    /** @type {Map<number, number>}  PropertyDataId → uint (DAT refs) */
    this.dataValues = new Map();
    /** @type {Map<number, object>}  PropertyPosition → Position */
    this.positionValues = new Map();

    // Description bundles arrive on ObjectCreated (`WorldObject.cs:129-139`).
    // Their full Position/ObjDesc/PhysicsDesc/PublicWeenieDesc shapes are
    // owned by `holtburger-protocol::messages::object::*` — JS holds the
    // last-snapshotted blob and the property-store derivatives below.
    this.objectDescription = null;
    this.physicsDesc = null;
    this.weenieDescription = null;

    // Behavior = ObjectDescriptionFlag bitfield (`WorldObject.cs:124`).
    this.behavior = 0;
    this.hasAppraisalData = false;
    this.lastAppraisalTime = null;

    // Lazy cache for the typed-class dispatch (`WorldObject.cs:42, 147-155`).
    // `null` (unset) vs `'Unknown'` (canonical returned Unknown). On first
    // read after any of the three classification inputs changes, the cache
    // is invalidated.
    this._objectClass = null;
    this.objDescFlags = 0;  // Mirrors `behavior` for the classifier inputs.
    this.weenieFlags = 0;   // WeenieHeaderFlag bitfield from PublicWeenieDesc.
    // `canonicalObjectClass`/`classificationSource` set by WorldObjectManager
    // post-construction so the snapshot/HUDs can introspect.
    this.canonicalObjectClass = null;
    this.classificationSource = null;
  }

  // ─── HasValue predicates (WorldObject.cs:164-229) ───
  /** @param {number} key PropertyInt */
  hasIntValue(key)      { return this.intValues.has(key); }
  /** @param {number} key PropertyInt64 */
  hasInt64Value(key)    { return this.int64Values.has(key); }
  /** @param {number} key PropertyString */
  hasStringValue(key)   { return this.stringValues.has(key); }
  /** @param {number} key PropertyBool */
  hasBoolValue(key)     { return this.boolValues.has(key); }
  /** @param {number} key PropertyFloat */
  hasFloatValue(key)    { return this.floatValues.has(key); }
  /** @param {number} key PropertyInstanceId */
  hasInstanceValue(key) { return this.instanceValues.has(key); }
  /** @param {number} key PropertyDataId */
  hasDataValue(key)     { return this.dataValues.has(key); }
  /** @param {number} key PropertyPosition */
  hasPositionValue(key) { return this.positionValues.has(key); }

  // ─── Value getters (WorldObject.cs:237-341) ───
  // Each mirrors one C# `Value(PropertyXxx key, T @default)` overload.
  /** @param {number} key @param {number} [fallback=0] */
  intValue(key, fallback = 0)            { return this.intValues.has(key) ? this.intValues.get(key) : fallback; }
  /** @param {number} key @param {bigint} [fallback=0n] */
  int64Value(key, fallback = 0n)         { return this.int64Values.has(key) ? this.int64Values.get(key) : fallback; }
  /** @param {number} key @param {string} [fallback=''] */
  stringValue(key, fallback = '')        { return this.stringValues.has(key) ? this.stringValues.get(key) : fallback; }
  /** @param {number} key @param {boolean} [fallback=false] */
  boolValue(key, fallback = false)       { return this.boolValues.has(key) ? this.boolValues.get(key) : fallback; }
  /** @param {number} key @param {number} [fallback=0.0] */
  floatValue(key, fallback = 0.0)        { return this.floatValues.has(key) ? this.floatValues.get(key) : fallback; }
  /** @param {number} key @param {number} [fallback=0] */
  instanceValue(key, fallback = 0)       { return this.instanceValues.has(key) ? this.instanceValues.get(key) : fallback; }
  /** @param {number} key @param {number} [fallback=0] */
  dataValue(key, fallback = 0)           { return this.dataValues.has(key) ? this.dataValues.get(key) : fallback; }
  /** @param {number} key @param {object|null} [fallback=null] */
  positionValue(key, fallback = null)    { return this.positionValues.has(key) ? this.positionValues.get(key) : fallback; }

  /**
   * Typed-dispatch shortcut for callers that don't know which dict the
   * property lives in (e.g. ad-hoc inspector tools). Searches all 8
   * dicts in `intValues → floatValues → boolValues → stringValues →
   * int64Values → instanceValues → dataValues → positionValues` order.
   * Prefer the typed accessors above in hot paths.
   *
   * Mirrors the C# `Value<T>` overload resolution which dispatches by
   * compile-time key type; in JS we fall back to runtime dict-scan.
   *
   * @param {number} key
   * @param {*} [fallback]
   */
  value(key, fallback) {
    if (typeof key === 'number') {
      if (this.intValues.has(key))      return this.intValues.get(key);
      if (this.floatValues.has(key))    return this.floatValues.get(key);
      if (this.boolValues.has(key))     return this.boolValues.get(key);
      if (this.stringValues.has(key))   return this.stringValues.get(key);
      if (this.int64Values.has(key))    return this.int64Values.get(key);
      if (this.instanceValues.has(key)) return this.instanceValues.get(key);
      if (this.dataValues.has(key))     return this.dataValues.get(key);
      if (this.positionValues.has(key)) return this.positionValues.get(key);
    }
    return fallback;
  }

  // ─── AddOrUpdate setters (WorldObject.cs:459-508) ───
  // One method per dict (vs C#'s 8 method overloads). Each mirrors the C#
  // `AddOrUpdateValue(PropertyXxx key, T value)` semantics — set-or-replace.
  setIntValue(key, value)      { this.intValues.set(key, value | 0); this._objectClass = null; }
  setInt64Value(key, value)    { this.int64Values.set(key, typeof value === 'bigint' ? value : BigInt(value)); }
  setStringValue(key, value)   { this.stringValues.set(key, String(value)); }
  setBoolValue(key, value)     { this.boolValues.set(key, Boolean(value)); }
  setFloatValue(key, value)    { this.floatValues.set(key, Number(value)); }
  setDataValue(key, value)     { this.dataValues.set(key, value >>> 0); }
  setPositionValue(key, value) { this.positionValues.set(key, value); }
  /**
   * `AddOrUpdateValue(PropertyInstanceId, uint)` has an extra
   * skip-when-unchanged short-circuit (`WorldObject.cs:501-508`). Mirror
   * exactly — same-value writes are a no-op to prevent stale-cache wakeup
   * on quality-update spam.
   */
  setInstanceValue(key, value) {
    const v = value >>> 0;
    if (this.instanceValues.has(key) && this.instanceValues.get(key) === v) return;
    this.instanceValues.set(key, v);
  }

  // ─── Remove setters (WorldObject.cs:510-540) ───
  removeIntValue(key)      { this.intValues.delete(key); this._objectClass = null; }
  removeInt64Value(key)    { this.int64Values.delete(key); }
  removeStringValue(key)   { this.stringValues.delete(key); }
  removeBoolValue(key)     { this.boolValues.delete(key); }
  removeFloatValue(key)    { this.floatValues.delete(key); }
  removeInstanceValue(key) { this.instanceValues.delete(key); }
  removeDataValue(key)     { this.dataValues.delete(key); }
  removePositionValue(key) { this.positionValues.delete(key); }

  // ─── Convenience getters ───
  /** PropertyString.Name (= 1). `WorldObject.cs:58`. */
  get name() {
    return this.stringValue(PROP_STRING_NAME, '');
  }
  /** PropertyInt.ItemType (= 1). `WorldObject.cs:119`. */
  get itemType() {
    return this.intValue(PROP_INT_ITEM_TYPE, 0);
  }
  /** Resolved enum-symbol form of itemType. */
  get itemTypeName() {
    return this.enums?.nameOf('ItemType', this.itemType) ?? `0x${this.itemType.toString(16)}`;
  }
  /** Hook for taxonomy-aware dispatch. */
  get className() {
    return this.constructor.name || 'WorldObject';
  }

  /**
   * The lazy `ObjectClass` getter (`WorldObject.cs:147-155`). Re-runs
   * `canonicalClassify` on first read after a setter invalidates the
   * cache (via setIntValue's `_objectClass = null`). Distinct from
   * `canonicalObjectClass` — the latter is the manager-snapshotted value
   * at construction time; this getter re-runs the algorithm against the
   * CURRENT state of the property store (used after late
   * UpdateWeenieDesc / quality updates change ItemType or Behavior).
   *
   * Returns the symbolic name (matching Chorizite's `ObjectClass` enum
   * member names — `'MeleeWeapon'`, `'Player'`, `'Lifestone'`, etc.).
   *
   * @returns {string}
   */
  get objectClass() {
    if (this._objectClass !== null) return this._objectClass;
    this._objectClass = canonicalClassify(this.itemType, this.objDescFlags | this.behavior, this.weenieFlags);
    return this._objectClass;
  }

  /**
   * Update the `ObjDesc` snapshot (`WorldObject.cs:543-547`). Does NOT
   * touch the property store — ObjDesc carries appearance overrides
   * (Palette/Texture/Anim swaps) consumed by the renderer separately.
   * @param {object|null} objDesc
   */
  updateObjDesc(objDesc) {
    if (objDesc == null) return;
    this.objectDescription = objDesc;
  }

  /**
   * Update the `PhysicsDesc` snapshot (`WorldObject.cs:549-556`). When
   * the parent-id bit (0x00000020) is set, copies `ParentId` into
   * `PropertyInstanceId.Wielder` so containment queries see the wielding
   * creature's GUID.
   * @param {object|null} physicsDesc
   */
  updatePhysicsDesc(physicsDesc) {
    if (physicsDesc == null) return;
    this.physicsDesc = physicsDesc;
    const flags = (physicsDesc.flags ?? physicsDesc.Flags ?? 0) >>> 0;
    if ((flags & PHYSICS_DESC_PARENT_FLAG) !== 0) {
      const parentId = (physicsDesc.parentId ?? physicsDesc.ParentId ?? 0) >>> 0;
      this.setInstanceValue(PROP_INSTANCE_WIELDER, parentId);
    }
  }

  /**
   * 1:1 port of `WorldObject.cs:558-678` `UpdateWeenieDesc` — the
   * 35-flag WeenieHeaderFlag unpacker. Reads `wdesc.Header`/`wdesc.Header2`
   * bitfields and copies the gated fields into the typed property store.
   *
   * Field-name conventions: the upstream C# `PublicWeenieDesc` uses
   * PascalCase; our `holtburger-protocol::messages::object::PublicWeenieDesc`
   * exports snake_case. We accept both — first PascalCase (matches
   * Chorizite.ACProtocol output), falling back to snake_case (matches
   * our wasm-bindgen JS output).
   *
   * Citation tags per line: each `if` carries `// :LLL` of the upstream
   * source line so future drift can be diffed mechanically.
   *
   * @param {object|null} wdesc PublicWeenieDesc payload
   */
  updateWeenieDesc(wdesc) {
    if (wdesc == null) return;

    this.weenieDescription = wdesc;

    // Unwrap header fields (PascalCase preferred; snake_case fallback).
    const weenieClassId   = wdesc.WeenieClassId   ?? wdesc.weenie_class_id   ?? wdesc.weenieClassId   ?? 0;
    const behavior        = wdesc.Behavior        ?? wdesc.behavior          ?? 0;
    const flag1           = (wdesc.Header         ?? wdesc.header            ?? 0) >>> 0;
    const flag2           = (wdesc.Header2        ?? wdesc.header2           ?? 0) >>> 0;
    const wdescName       = wdesc.Name            ?? wdesc.name              ?? '';
    const wdescIcon       = wdesc.Icon            ?? wdesc.icon              ?? 0;
    const wdescType       = wdesc.Type            ?? wdesc.type              ?? 0;
    const wdescSpellId    = wdesc.SpellId         ?? wdesc.spell_id          ?? wdesc.spellId          ?? 0;

    this.classId = weenieClassId;
    this.behavior = behavior;
    this.weenieFlags = flag1;
    this._objectClass = null;  // invalidate cache — Behavior/Header changed

    // :567-569 — unconditional updates (name/icon/type seed the property store).
    this.setStringValue(PROP_STRING_NAME, wdescName);
    this.setDataValue(PROP_DATA_ICON, (0x06000000 | wdescIcon) >>> 0);
    this.setIntValue(PROP_INT_ITEM_TYPE, wdescType);

    // :574-577
    if ((flag1 & WHF_AMMO_TYPE) !== 0)
      this.setIntValue(PROP_INT_AMMO_TYPE, (wdesc.AmmunitionType ?? wdesc.ammunition_type ?? 0) | 0);

    // :577-578
    if ((flag1 & WHF_RADAR_BLIP_COLOR) !== 0)
      this.setIntValue(PROP_INT_RADAR_BLIP_COLOR, (wdesc.BlipColor ?? wdesc.blip_color ?? 0) | 0);

    // :580-581
    if ((flag1 & WHF_COMBAT_USE) !== 0)
      this.setIntValue(PROP_INT_COMBAT_USE, (wdesc.CombatUse ?? wdesc.combat_use ?? 0) | 0);

    // :583-584
    if ((flag1 & WHF_CONTAINERS_CAPACITY) !== 0)
      this.setIntValue(PROP_INT_CONTAINERS_CAPACITY, (wdesc.ContainerCapacity ?? wdesc.container_capacity ?? 0) | 0);

    // :586-587
    if ((flag1 & WHF_CONTAINER) !== 0)
      this.setInstanceValue(PROP_INSTANCE_CONTAINER, (wdesc.ContainerId ?? wdesc.container_id ?? 0) >>> 0);

    // :589-590  (Header2 / CooldownDuration)
    if ((flag2 & WHF2_COOLDOWN_DURATION) !== 0)
      this.setFloatValue(PROP_FLOAT_COOLDOWN_DURATION, wdesc.CooldownDuration ?? wdesc.cooldown_duration ?? 0);

    // :592-593  (Header2 / Cooldown)
    if ((flag2 & WHF2_COOLDOWN) !== 0)
      this.setIntValue(PROP_INT_SHARED_COOLDOWN, (wdesc.CooldownId ?? wdesc.cooldown_id ?? 0) | 0);

    // :595-596
    if ((flag1 & WHF_HOOK_TYPE) !== 0)
      this.setIntValue(PROP_INT_HOOK_TYPE, (wdesc.HookType ?? wdesc.hook_type ?? 0) | 0);

    // :598-599
    if ((flag1 & WHF_HOOKABLE_ON) !== 0)
      this.setIntValue(PROP_INT_HOOK_ITEM_TYPE, (wdesc.HookItemTypes ?? wdesc.hook_item_types ?? 0) | 0);

    // :601-602
    if ((flag1 & WHF_ICON_OVERLAY) !== 0)
      this.setDataValue(PROP_DATA_ICON_OVERLAY, (0x06000000 | (wdesc.IconOverlay ?? wdesc.icon_overlay ?? 0)) >>> 0);

    // :604-605  (Header2 / IconUnderlay)
    if ((flag2 & WHF2_ICON_UNDERLAY) !== 0)
      this.setDataValue(PROP_DATA_ICON_UNDERLAY, (0x06000000 | (wdesc.IconUnderlay ?? wdesc.icon_underlay ?? 0)) >>> 0);

    // :607-608
    if ((flag1 & WHF_ITEMS_CAPACITY) !== 0)
      this.setIntValue(PROP_INT_ITEMS_CAPACITY, (wdesc.ItemsCapacity ?? wdesc.items_capacity ?? 0) | 0);

    // :610-611
    if ((flag1 & WHF_CURRENTLY_WIELDED_LOCATION) !== 0)
      this.setIntValue(PROP_INT_CURRENT_WIELDED_LOCATION, (wdesc.Slot ?? wdesc.slot ?? 0) | 0);

    // :613-614
    if ((flag1 & WHF_MATERIAL_TYPE) !== 0)
      this.setIntValue(PROP_INT_MATERIAL_TYPE, (wdesc.Material ?? wdesc.material ?? 0) | 0);

    // :616-617
    if ((flag1 & WHF_MAX_STACK_SIZE) !== 0)
      this.setIntValue(PROP_INT_MAX_STACK_SIZE, (wdesc.MaxStackSize ?? wdesc.max_stack_size ?? 0) | 0);

    // :619-620  C#'s `MaxUses` flag → `MaxStructure` property
    if ((flag1 & WHF_MAX_USES) !== 0)
      this.setIntValue(PROP_INT_MAX_STRUCTURE, (wdesc.MaxStructure ?? wdesc.max_structure ?? 0) | 0);

    // :622-623
    if ((flag1 & WHF_MONARCH) !== 0)
      this.setInstanceValue(PROP_INSTANCE_MONARCH, (wdesc.MonarchId ?? wdesc.monarch_id ?? 0) >>> 0);

    // :625-626
    if ((flag1 & WHF_PLURAL_NAME) !== 0)
      this.setStringValue(PROP_STRING_PLURAL_NAME, wdesc.PluralName ?? wdesc.plural_name ?? '');

    // :628-629
    if ((flag1 & WHF_OWNER) !== 0)
      this.setInstanceValue(PROP_INSTANCE_OWNER, (wdesc.OwnerId ?? wdesc.owner_id ?? 0) >>> 0);

    // :631-632  (Header2 / PetOwner)
    if ((flag2 & WHF2_PET_OWNER) !== 0)
      this.setInstanceValue(PROP_INSTANCE_PET_OWNER, (wdesc.PetOwnerId ?? wdesc.pet_owner_id ?? 0) >>> 0);

    // :634-635
    if ((flag1 & WHF_PHYSICS_SCRIPT) !== 0)
      this.setDataValue(PROP_DATA_PHYSICS_SCRIPT, (wdesc.PhysicsScript ?? wdesc.physics_script ?? 0) >>> 0);

    // :637-638  ClothingPriority = wdesc.Priority
    if ((flag1 & WHF_COVERAGE) !== 0)
      this.setIntValue(PROP_INT_CLOTHING_PRIORITY, (wdesc.Priority ?? wdesc.priority ?? 0) | 0);

    // :640-641
    if ((flag1 & WHF_RADAR_BEHAVIOR) !== 0)
      this.setIntValue(PROP_INT_SHOWABLE_ON_RADAR, (wdesc.RadarEnum ?? wdesc.radar_enum ?? 0) | 0);

    // :643-644  Spell flag → PropertyDataId.Spell
    // NOTE: upstream sets this twice — :566 (unconditional) and :644 (gated).
    // We omit the :566 unconditional write because it stores a 0 when the
    // weenie has no spell, polluting the dict. The gated :644 write is the
    // only one that matters; the :566 line is upstream dead code (its value
    // is overwritten if the gate fires and is wrong if the gate doesn't).
    // Cross-checked: ACE's `PublicWeenieDesc.SpellId` is only meaningful
    // when WeenieHeaderFlag.Spell is set.
    if ((flag1 & WHF_SPELL) !== 0)
      this.setDataValue(PROP_DATA_SPELL, wdescSpellId >>> 0);

    // :646-647
    if ((flag1 & WHF_STACK_SIZE) !== 0)
      this.setIntValue(PROP_INT_STACK_SIZE, (wdesc.StackSize ?? wdesc.stack_size ?? 0) | 0);

    // :649-650  C#'s `Uses` flag → `Structure` property
    if ((flag1 & WHF_USES) !== 0)
      this.setIntValue(PROP_INT_STRUCTURE, (wdesc.Structure ?? wdesc.structure ?? 0) | 0);

    // :652-653
    if ((flag1 & WHF_TARGET_TYPE) !== 0)
      this.setIntValue(PROP_INT_TARGET_TYPE, (wdesc.TargetType ?? wdesc.target_type ?? 0) | 0);

    // :655-656
    if ((flag1 & WHF_USABLE) !== 0)
      this.setIntValue(PROP_INT_ITEM_USEABLE, (wdesc.Useability ?? wdesc.useability ?? 0) | 0);

    // :658-659
    if ((flag1 & WHF_USE_RADIUS) !== 0)
      this.setFloatValue(PROP_FLOAT_USE_RADIUS, wdesc.UseRadius ?? wdesc.use_radius ?? 0);

    // :661-662
    if ((flag1 & WHF_VALID_EQUIP_LOCATIONS) !== 0)
      this.setIntValue(PROP_INT_VALID_LOCATIONS, (wdesc.ValidSlots ?? wdesc.valid_slots ?? 0) | 0);

    // :664-665
    if ((flag1 & WHF_VALUE) !== 0)
      this.setIntValue(PROP_INT_VALUE, (wdesc.Value ?? wdesc.value ?? 0) | 0);

    // :667-668
    if ((flag1 & WHF_WIELDER) !== 0)
      this.setInstanceValue(PROP_INSTANCE_WIELDER, (wdesc.WielderId ?? wdesc.wielder_id ?? 0) >>> 0);

    // :670-671
    if ((flag1 & WHF_WORKMANSHIP) !== 0)
      this.setIntValue(PROP_INT_ITEM_WORKMANSHIP, (wdesc.Workmanship ?? wdesc.workmanship ?? 0) | 0);

    // :673-674
    if ((flag1 & WHF_BURDEN) !== 0)
      this.setIntValue(PROP_INT_ENCUMBRANCE_VAL, (wdesc.Burden ?? wdesc.burden ?? 0) | 0);

    // :676-677  UiEffects (PropertyDataId.IconOverlaySecondary)
    if ((flag1 & WHF_UI_EFFECTS) !== 0)
      this.setDataValue(PROP_DATA_ICON_OVERLAY_SECONDARY, (wdesc.Effects ?? wdesc.effects ?? 0) >>> 0);
  }

  /**
   * String repr (`WorldObject.cs:680-682`).
   * `"{Name}({GetType().Name})[0x{Id:X8} {ItemType}//{ObjectClass}]"`
   */
  toString() {
    const idHex = this.id.toString(16).toUpperCase().padStart(8, '0');
    return `${this.name}(${this.className})[0x${idHex} ${this.itemTypeName}//${this.objectClass}]`;
  }

  /** Build a debug-friendly summary; useful in HUD + console. */
  describe() {
    return {
      className: this.className,
      id: `0x${this.id.toString(16).padStart(8, '0')}`,
      classId: this.classId,
      name: this.name,
      itemType: this.itemTypeName,
      objectClass: this.objectClass,
      canonicalObjectClass: this.canonicalObjectClass ?? null,
      classificationSource: this.classificationSource ?? null,
      hasAppraisalData: this.hasAppraisalData,
    };
  }

  /**
   * Dispatch a "use" interaction on this object via the wire. In retail
   * AC this is the click/double-click gesture — server interprets the
   * action per-object (containers open, doors toggle, portals teleport,
   * food gets eaten, weapons get equipped, etc.).
   *
   * Subclasses provide type-named wrappers (Door.use, Vendor.openTrade,
   * Portal.enter, Lifestone.tie, Food.eat, Equippable.equip) that all
   * funnel back here. Use the subclass wrapper for type-safety; this
   * base method is the fallback for generic objects or for
   * WorldObject-sentinel instances.
   *
   * @returns {boolean} true if dispatched, false if no client is wired
   */
  examine() {
    const client = this.manager?.client;
    if (!client?.player?.useObject) {
      console.warn(`[wom] examine(0x${this.id.toString(16)}): no client.player.useObject — manager not wired?`);
      return false;
    }
    client.player.useObject(this.id);
    return true;
  }
}
