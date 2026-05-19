/**
 * Owns the live `Map<guid, WorldObject>`. Dispatches typed-class creation
 * via GetObjectClass-port. Mirrors Chorizite/ACPlugin/API/WorldObjectManager.cs.
 *
 * The manager is intentionally SESSION-AGNOSTIC — it doesn't touch
 * sessionHandle directly. Wiring code (plugins/api.js or the bootstrap in
 * index.html) connects session events to manager methods like
 * `onObjectCreated`, `onObjectDeleted`, `onPropertyUpdate`.
 */

import { WorldObjectTaxonomy } from './taxonomy.js';
import { ChoriziteEnums } from './enums.js';
import { WorldObject } from './world_object.js';
import { canonicalClassify } from './canonical_classify.js';

import { Item } from './item.js';
import { Equippable } from './equippable.js';
import { Container } from './container.js';
import { Static } from './static.js';
import { Character } from './character.js';
import { Creature } from './creature.js';
import { NPC } from './npc.js';
import { Vendor } from './vendor.js';
import { Monster } from './monster.js';
import { Player } from './player.js';
import { Door } from './door.js';
import { Portal } from './portal.js';
import { Lifestone } from './lifestone.js';
import { Bindstone } from './bindstone.js';
import { Corpse } from './corpse.js';
import { Foci } from './foci.js';
import { Armor } from './armor.js';
import { Clothing } from './clothing.js';
import { Jewelry } from './jewelry.js';
import { MeleeWeapon } from './melee_weapon.js';
import { MissileWeapon } from './missile_weapon.js';
import { Wand } from './wand.js';
import { Food } from './food.js';
import { Gem } from './gem.js';
import { Key } from './key.js';
import { ManaStone } from './mana_stone.js';
import { Scroll } from './scroll.js';
import { SpellComponent } from './spell_component.js';
import { TradeNote } from './trade_note.js';
import { Ust } from './ust.js';

// Keys match the canonical ObjectClass enum members (Chorizite.Common
// ObjectClass.cs). Note `Npc` (not `NPC`) to mirror the C# casing — the
// JS `NPC` class is aliased under both for migration safety.
const CONSTRUCTOR_BY_NAME = {
  WorldObject,
  Item, Equippable, Container, Static,
  Character, Creature, NPC, Npc: NPC, Vendor, Monster, Player,
  Door, Portal, Lifestone, Bindstone, Corpse, Foci,
  Armor, Clothing, Jewelry, MeleeWeapon, MissileWeapon, Wand,
  Food, Gem, Key, ManaStone, Scroll, SpellComponent, TradeNote, Ust,
};

export class WorldObjectManager extends EventTarget {
  constructor() {
    super();
    this.taxonomy = new WorldObjectTaxonomy();
    this.enums = new ChoriziteEnums();
    this.objects = new Map();
    this.loaded = false;
  }

  async load(taxonomyUrl, enumsUrl) {
    await this.taxonomy.load(taxonomyUrl);
    await this.enums.load(enumsUrl);
    this.loaded = true;
  }

  /**
   * Called on a kind=10 ObjectCreated event (per CHORIZITE_PORTING_PLAN.md §3.4).
   *
   * Dispatches via the canonical classifier per the entity-completeness
   * contract (docs/entity-completeness-method.md §3). Three wire inputs
   * → one ObjectClass via the 1:1 port of ACPlugin's GetObjectClass.
   * No heuristic fallback — if canonical returns 'Unknown', we
   * instantiate the WorldObject sentinel and tag classificationSource.
   */
  onObjectCreated(event) {
    if (!this.loaded) {
      console.warn('WorldObjectManager: onObjectCreated before load()');
      return null;
    }
    const { guid, classId, itemType, objDescFlags, weenieFlags } = this.#normalizeCreationPayload(event);
    const objectClassName = canonicalClassify(itemType, objDescFlags, weenieFlags);
    const Constructor = CONSTRUCTOR_BY_NAME[objectClassName] ?? WorldObject;
    const wo = new Constructor(guid, classId, this.taxonomy, this.enums);
    wo.objDescFlags = objDescFlags;
    wo.weenieFlags = weenieFlags;
    // Entity-completeness §5 fallback discipline: tag classification source
    // so the validator (Phase E.D) can count Unknown instances.
    wo.classificationSource = (objectClassName === 'Unknown') ? 'unknown' : 'canonical';
    if (wo.classificationSource === 'unknown') {
      console.info(
        `[wom] canonical classifier returned Unknown for guid=0x${guid.toString(16).padStart(8, '0')} ` +
        `wcid=0x${classId.toString(16).padStart(8, '0')} ` +
        `itemType=0x${itemType.toString(16).padStart(8, '0')} ` +
        `objDescFlags=0x${objDescFlags.toString(16).padStart(8, '0')} ` +
        `weenieFlags=0x${weenieFlags.toString(16).padStart(8, '0')} ` +
        `— instantiating WorldObject sentinel`
      );
    }
    // Seed itemType / name property slots so subclasses can introspect.
    if (itemType !== undefined) wo.intValues.set(1, itemType);
    if (event.name) wo.stringValues.set(1, event.name);
    this.objects.set(guid, wo);
    this.dispatchEvent(new CustomEvent('created', {
      detail: { object: wo, resolved: objectClassName, source: wo.classificationSource },
    }));
    return wo;
  }

  /** Called on a kind=? ObjectDeleted / Released. */
  onObjectDeleted(event) {
    const guid = event.guid ?? event.objectId;
    const wo = this.objects.get(guid);
    if (!wo) return false;
    this.objects.delete(guid);
    this.dispatchEvent(new CustomEvent('deleted', { detail: { guid, object: wo } }));
    return true;
  }

  /** Look up a world object by guid. */
  get(guid) { return this.objects.get(guid) ?? null; }
  has(guid) { return this.objects.has(guid); }
  exists(guid) { return this.objects.has(guid); }
  count() { return this.objects.size; }

  /**
   * Emit a serializable snapshot of every live object's classification.
   * Consumed by `capture_entity_classifications.cjs` (Phase E.F live
   * validator). Includes the three wire inputs + the canonical output +
   * classificationSource so Unknown sentinels can be counted + audited.
   *
   * Shape:
   *   { capturedAt, loaded, total, byClass: {class → count},
   *     unknownCount, objects: [{guid, classId, className,
   *       classificationSource, itemType, objDescFlags, weenieFlags,
   *       name}, ...] }
   */
  snapshot() {
    const objects = [];
    const byClass = new Map();
    let unknownCount = 0;
    for (const wo of this.objects.values()) {
      const cls = wo.constructor.name;
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      if (wo.classificationSource === 'unknown') unknownCount++;
      objects.push({
        guid: wo.id,
        classId: wo.classId,
        className: cls,
        classificationSource: wo.classificationSource ?? null,
        itemType: wo.intValues.get(1) ?? 0,
        objDescFlags: wo.objDescFlags ?? 0,
        weenieFlags: wo.weenieFlags ?? 0,
        name: wo.stringValues.get(1) ?? '',
      });
    }
    return {
      capturedAt: new Date().toISOString(),
      loaded: this.loaded,
      total: objects.length,
      unknownCount,
      byClass: Object.fromEntries([...byClass.entries()].sort((a, b) => b[1] - a[1])),
      objects,
    };
  }

  /** Iterate all live world objects. */
  *all() { yield* this.objects.values(); }

  /** Filter live objects to a subclass tree (e.g. `byClass('Creature')` → all monsters/NPCs/players/etc). */
  byClass(className) {
    const include = new Set([className, ...this.taxonomy.allDescendantsOf(className)]);
    return [...this.objects.values()].filter(wo => include.has(wo.className));
  }

  /** Normalize the event payload coming from session-handle event shape variants. */
  #normalizeCreationPayload(event) {
    // The wire layer surfaces the three canonical-classifier inputs as:
    //   itemType, objDescFlags, weenieFlags (per docs/entity-completeness-method.md)
    // Aliases tolerated for ad-hoc test drivers.
    return {
      guid:         event.guid          ?? event.objectId    ?? event.id          ?? 0,
      classId:      event.classId       ?? event.wcid        ?? 0,
      itemType:     event.itemType      ?? 0,
      objDescFlags: event.objDescFlags  ?? event.behavior    ?? 0,
      weenieFlags:  event.weenieFlags   ?? 0,
      name:         event.name          ?? null,
    };
  }
}
