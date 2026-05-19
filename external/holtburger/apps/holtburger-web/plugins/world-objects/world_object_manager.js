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
import { resolveClassName } from './get_object_class.js';

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

const CONSTRUCTOR_BY_NAME = {
  WorldObject,
  Item, Equippable, Container, Static,
  Character, Creature, NPC, Vendor, Monster, Player,
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

  /** Called on a kind=10 ObjectCreated event (per CHORIZITE_PORTING_PLAN.md §3.4). */
  onObjectCreated(event) {
    if (!this.loaded) {
      console.warn('WorldObjectManager: onObjectCreated before load()');
      return null;
    }
    const { guid, classId, itemType, objectClass, behavior } = this.#normalizeCreationPayload(event);
    const itemTypeName = itemType ? this.enums.nameOf('ItemType', itemType) : null;
    // Only resolve objectClass if it was actually set; 0 == Unknown which we
    // want to treat as 'not specified, fall through to ItemType heuristic.'
    const objectClassName = objectClass ? this.enums.nameOf('ObjectClass', objectClass) : null;
    const targetName = resolveClassName({ itemTypeName, objectClassName, behavior });
    const Constructor = CONSTRUCTOR_BY_NAME[targetName] ?? WorldObject;
    const wo = new Constructor(guid, classId, this.taxonomy, this.enums);
    wo.behavior = behavior;
    // Seed itemType / class fields so subclasses can introspect.
    if (itemType !== undefined) wo.intValues.set(1, itemType);
    if (event.name) wo.stringValues.set(1, event.name);
    this.objects.set(guid, wo);
    this.dispatchEvent(new CustomEvent('created', { detail: { object: wo, resolved: targetName } }));
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

  /** Iterate all live world objects. */
  *all() { yield* this.objects.values(); }

  /** Filter live objects to a subclass tree (e.g. `byClass('Creature')` → all monsters/NPCs/players/etc). */
  byClass(className) {
    const include = new Set([className, ...this.taxonomy.allDescendantsOf(className)]);
    return [...this.objects.values()].filter(wo => include.has(wo.className));
  }

  /** Normalize the event payload coming from session-handle event shape variants. */
  #normalizeCreationPayload(event) {
    // The wire layer may surface fields differently; accept multiple aliases.
    return {
      guid:         event.guid        ?? event.objectId   ?? event.id        ?? 0,
      classId:      event.classId     ?? event.wcid       ?? 0,
      itemType:     event.itemType    ?? 0,
      objectClass:  event.objectClass ?? 0,
      behavior:     event.behavior    ?? event.behaviour  ?? 0,
      name:         event.name        ?? null,
    };
  }
}
