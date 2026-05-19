/**
 * Browser-side mirror of Chorizite/ACPlugin/API/WorldObject.cs.
 *
 * The retail AC client (and ACPlugin) models every in-world thing as a
 * WorldObject with 8 typed-property dictionaries. We mirror the same shape
 * here so plugin code can do `wo.value(PropertyInt.Burden, 0)` instead of
 * threading raw property maps everywhere.
 *
 * Per [[../../../docs/chorizite/READING_GUIDE.md]] ACPlugin §4 — this 8-dict
 * pattern is exactly what retail uses on the wire (PublicWeenieDesc / ObjDesc
 * / PhysicsDesc carry typed property bundles).
 */

export class WorldObject {
  /**
   * @param {number} id          GUID
   * @param {number} classId     wcid (weenie class id)
   * @param {object} taxonomy    WorldObjectTaxonomy instance (for inheritance queries)
   * @param {object} enums       ChoriziteEnums instance (for symbol lookup)
   */
  constructor(id, classId, taxonomy, enums) {
    this.id = id;
    this.classId = classId;
    this.taxonomy = taxonomy;
    this.enums = enums;
    this.createdAt = new Date();
    this.lastAccessTime = this.createdAt;

    // Per ACPlugin/API/WorldObject.cs lines 80-119: 8 typed dicts.
    this.intValues = new Map();        // PropertyInt → int
    this.int64Values = new Map();      // PropertyInt64 → long
    this.stringValues = new Map();     // PropertyString → string
    this.boolValues = new Map();       // PropertyBool → bool
    this.floatValues = new Map();      // PropertyFloat → float
    this.instanceValues = new Map();   // PropertyInstanceId → uint (other-object refs)
    this.dataValues = new Map();       // PropertyDataId → uint (DAT refs)
    this.positionValues = new Map();   // PropertyPosition → Position

    // Object description (ObjDesc) + Physics description (PhysicsDesc) +
    // Weenie description bundles arrive on ObjectCreated; defer their full
    // shape to when we actually need them.
    this.objectDescription = null;
    this.physicsDesc = null;
    this.weenieDescription = null;
    this.behavior = 0;
    this.hasAppraisalData = false;
    this.lastAppraisalTime = null;
  }

  /** Typed read with default; mirrors ACPlugin's `Value<T>` overloads. */
  value(prop, fallback) {
    // Caller passes the numeric PropertyInt / PropertyFloat / etc. value.
    // We dispatch by the value's type. The lookup hits whichever dict the
    // caller meant; if it's not present, returns the fallback.
    if (typeof prop === 'number') {
      // Heuristic: search all dicts. In practice the caller will narrow via
      // intValue(), floatValue() etc. (See helpers below.)
      if (this.intValues.has(prop)) return this.intValues.get(prop);
      if (this.floatValues.has(prop)) return this.floatValues.get(prop);
      if (this.boolValues.has(prop)) return this.boolValues.get(prop);
      if (this.stringValues.has(prop)) return this.stringValues.get(prop);
      if (this.int64Values.has(prop)) return this.int64Values.get(prop);
      if (this.instanceValues.has(prop)) return this.instanceValues.get(prop);
      if (this.dataValues.has(prop)) return this.dataValues.get(prop);
      if (this.positionValues.has(prop)) return this.positionValues.get(prop);
    }
    return fallback;
  }

  intValue(prop, fallback = 0) {
    return this.intValues.has(prop) ? this.intValues.get(prop) : fallback;
  }
  floatValue(prop, fallback = 0.0) {
    return this.floatValues.has(prop) ? this.floatValues.get(prop) : fallback;
  }
  boolValue(prop, fallback = false) {
    return this.boolValues.has(prop) ? this.boolValues.get(prop) : fallback;
  }
  stringValue(prop, fallback = '') {
    return this.stringValues.has(prop) ? this.stringValues.get(prop) : fallback;
  }
  dataValue(prop, fallback = 0) {
    return this.dataValues.has(prop) ? this.dataValues.get(prop) : fallback;
  }
  instanceValue(prop, fallback = 0) {
    return this.instanceValues.has(prop) ? this.instanceValues.get(prop) : fallback;
  }

  /** Convenience: the object's name from PropertyString.Name (== 1). */
  get name() {
    return this.stringValue(1, '');
  }

  /** ItemType from PropertyInt.ItemType (== 1). */
  get itemType() {
    return this.intValue(1, 0);
  }

  /** Resolved enum-symbol form of itemType. */
  get itemTypeName() {
    return this.enums?.nameOf('ItemType', this.itemType) ?? `0x${this.itemType.toString(16)}`;
  }

  /** Hook for taxonomy-aware dispatch. Subclasses override to add type-specific accessors. */
  get className() {
    return this.constructor.name || 'WorldObject';
  }

  /** Build a debug-friendly summary; useful in HUD + console. */
  describe() {
    return {
      className: this.className,
      id: `0x${this.id.toString(16).padStart(8, '0')}`,
      classId: this.classId,
      name: this.name,
      itemType: this.itemTypeName,
      hasAppraisalData: this.hasAppraisalData,
    };
  }
}
