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
  /**
   * @param {object} options
   * @param {object} [options.client]  The pluginClient from `createClient(sessionHandle)`.
   *   When set, typed WorldObject instances can dispatch wire actions
   *   via their `examine()` / `use()` / etc. methods. Optional — the
   *   manager works without it (typed dispatch + snapshot still work),
   *   but action methods log a warning and no-op.
   */
  constructor(options = {}) {
    super();
    this.taxonomy = new WorldObjectTaxonomy();
    this.enums = new ChoriziteEnums();
    this.objects = new Map();
    this.loaded = false;
    this.client = options.client ?? null;
    this.openContainer = null;
    // Events arriving from ACE before load() resolves (taxonomy + enums
    // are async-fetched). Buffer so we don't drop ObjectCreated for the
    // boot landblock — that's ~30-400 entities the per-render plugins
    // would otherwise never see classified.
    this._pendingCreate = [];
    this._pendingDelete = [];
    this._pendingUpdates = [];
    // Set when load() threw: nothing retries it, so buffering after that
    // only grew the queues for the page's lifetime (2026-10-18).
    this.loadFailed = false;
    this._wiredClient = null;

    if (this.client) {
      this.attachClient(this.client);
    }
  }

  /**
   * Late-attach a client (when the manager was constructed before
   * createClient resolved). After this call, instances created via
   * onObjectCreated AND any already-live instances pick up the client
   * for dispatch.
   */
  attachClient(client) {
    this.client = client;
    if (client) {
      if (Object.isExtensible(client) || 'worldObjects' in client) {
        client.worldObjects = this;
      }
      this._wireClientEvents(client);
    }
  }

  /** Wire live client bus events into manager deltas. */
  _wireClientEvents(client) {
    if (!client || !client.events || typeof client.events.on !== 'function') return;
    if (this._wiredClient === client) return;
    this._wiredClient = client;

    client.events.on('propertyUpdate', (evt) => {
      this.onPropertyUpdate(evt?.detail ?? evt);
    });
    client.events.on('propertyChanged', (evt) => {
      this.onPropertyUpdate(evt?.detail ?? evt);
    });
    client.events.on('positionUpdate', (evt) => {
      this.onPositionUpdate(evt?.detail ?? evt);
    });
    client.events.on('positionChanged', (evt) => {
      this.onPositionUpdate(evt?.detail ?? evt);
    });
    client.events.on('containerOpened', (evt) => {
      this.onContainerOpened(evt?.detail ?? evt);
    });
    client.events.on('containerClosed', (evt) => {
      this.onContainerClosed(evt?.detail ?? evt);
    });
    client.events.on('itemContainerChanged', (evt) => {
      this.onItemContainerChanged(evt?.detail ?? evt);
    });
    client.events.on('itemParentChanged', (evt) => {
      this.onItemParent(evt?.detail ?? evt);
    });
    client.events.on('kind:49', (evt) => {
      const d = evt?.detail ?? evt;
      const itemGuid = (d?.u32Payload ?? 0) >>> 0;
      const wielderGuid = (d?.u32Payload2 ?? 0) >>> 0;
      this.onItemParent({ itemGuid, parentGuid: wielderGuid, isWielder: true });
    });
    client.events.on('kind:47', (evt) => {
      const d = evt?.detail ?? evt;
      const itemGuid = (d?.u32Payload ?? 0) >>> 0;
      this.onItemParent({ itemGuid, parentGuid: 0, isWielder: true });
    });
    client.events.on('objectAppraised', (evt) => {
      this.onObjectAppraised(evt?.detail ?? evt);
    });
  }

  async load(taxonomyUrl, enumsUrl) {
    this.loadFailed = false;
    try {
      await this.taxonomy.load(taxonomyUrl);
      await this.enums.load(enumsUrl);
    } catch (e) {
      this.loadFailed = true;
      this._pendingCreate = [];
      this._pendingDelete = [];
      this._pendingUpdates = [];
      throw e;
    }
    this.loaded = true;
    // Drain any events that arrived during the async load window.
    const pendingCreates = this._pendingCreate;
    const pendingUpdates = this._pendingUpdates;
    const pendingDeletes = this._pendingDelete;
    this._pendingCreate = [];
    this._pendingUpdates = [];
    this._pendingDelete = [];
    for (const ev of pendingCreates) {
      try { this.onObjectCreated(ev); } catch (e) { console.warn('[wom] replay onObjectCreated:', e); }
    }
    for (const u of pendingUpdates) {
      try {
        if (u.type === 'property') this.onPropertyUpdate(u.event);
        else if (u.type === 'position') this.onPositionUpdate(u.event);
        else if (u.type === 'containerOpened') this.onContainerOpened(u.event);
        else if (u.type === 'containerClosed') this.onContainerClosed(u.event);
        else if (u.type === 'itemParent') this.onItemParent(u.event);
        else if (u.type === 'appraisal') this.onObjectAppraised(u.event);
      } catch (e) { console.warn('[wom] replay update:', e); }
    }
    for (const ev of pendingDeletes) {
      try { this.onObjectDeleted(ev); } catch (e) { console.warn('[wom] replay onObjectDeleted:', e); }
    }
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
      if (!this.loadFailed) this._pendingCreate.push(event);
      return null;
    }
    const { guid, classId, itemType, objDescFlags, weenieFlags } = this.#normalizeCreationPayload(event);
    const objectClassName = canonicalClassify(itemType, objDescFlags, weenieFlags);

    const existing = this.objects.get(guid);
    if (existing) {
      if (itemType !== undefined) existing.intValues.set(1, itemType);
      if (event.name) existing.stringValues.set(1, event.name);
      existing.objDescFlags = objDescFlags;
      existing.weenieFlags = weenieFlags;
      existing.canonicalObjectClass = objectClassName;
      this.dispatchEvent(new CustomEvent('created', {
        detail: { object: existing, resolved: objectClassName, source: existing.classificationSource, reSent: true },
      }));
      return existing;
    }

    // Three-way dispatch (entity-completeness §5 + ACPlugin behavior at
    // World.cs:622-706 — for ObjectClass values our 30-class JS roster
    // doesn't model, ACPlugin instantiates `Item` as the catch-all rather
    // than the WorldObject sentinel). Preserves more taxonomy info than
    // collapsing every gap to WorldObject.
    //   canonicalClass in roster → that constructor, source='canonical'
    //   canonicalClass not in roster AND not Unknown → Item, source='canonical-item-fallback'
    //   Unknown → WorldObject sentinel, source='unknown'
    let Constructor, classificationSource;
    if (objectClassName === 'Unknown') {
      Constructor = WorldObject;
      classificationSource = 'unknown';
    } else if (CONSTRUCTOR_BY_NAME[objectClassName]) {
      Constructor = CONSTRUCTOR_BY_NAME[objectClassName];
      classificationSource = 'canonical';
    } else {
      Constructor = Item;
      classificationSource = 'canonical-item-fallback';
    }
    const wo = new Constructor(guid, classId, this.taxonomy, this.enums, this);
    wo.objDescFlags = objDescFlags;
    wo.weenieFlags = weenieFlags;
    wo.canonicalObjectClass = objectClassName; // preserved even when Constructor is Item-fallback
    wo.classificationSource = classificationSource;
    if (classificationSource === 'unknown') {
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
      detail: { object: wo, resolved: objectClassName, source: classificationSource },
    }));
    return wo;
  }

  /** Called on a kind=? ObjectDeleted / Released. */
  onObjectDeleted(event) {
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingDelete.push(event);
      return false;
    }
    const guid = event.guid ?? event.objectId;
    const wo = this.objects.get(guid);
    if (!wo) return false;
    this.objects.delete(guid);
    this.dispatchEvent(new CustomEvent('deleted', { detail: { guid, object: wo } }));
    return true;
  }

  /**
   * Apply live property updates / deltas to a WorldObject.
   *
   * Accepts either:
   * 1. A single property delta: { guid, propertyType, key, value }
   * 2. A bulk properties bundle: { guid, intProperties, stringProperties, ... }
   *    or { guid, properties: { ints, strings, ... } }
   *
   * Emits both 'propertyChanged' and 'propertyUpdated' with { object, guid, event }.
   */
  onPropertyUpdate(event) {
    if (!event) return false;
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingUpdates.push({ type: 'property', event });
      return false;
    }
    const guid = (event.guid ?? event.objectId ?? event.id ?? event.u32Payload ?? 0) >>> 0;
    const wo = this.objects.get(guid);
    if (!wo) return false;

    let modified = false;

    const applyMap = (entries, setter) => {
      if (!entries) return;
      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (Array.isArray(item) && item.length >= 2) {
            setter(item[0], item[1]);
            modified = true;
          }
        }
      } else if (typeof entries === 'object') {
        for (const [k, v] of Object.entries(entries)) {
          setter(Number(k), v);
          modified = true;
        }
      }
    };

    // Single property delta
    const propType = event.propertyType ?? event.type ?? event.propType;
    const key = event.key ?? event.propertyId ?? event.propId;
    const value = event.value ?? event.val;
    if (propType !== undefined && key !== undefined && value !== undefined) {
      const pt = String(propType).toLowerCase();
      if (pt === 'int' || pt === 'propertyint' || propType === 1) {
        wo.setIntValue(Number(key), value | 0);
        modified = true;
      } else if (pt === 'int64' || pt === 'propertyint64' || propType === 2) {
        wo.setInt64Value(Number(key), typeof value === 'bigint' ? value : BigInt(value));
        modified = true;
      } else if (pt === 'bool' || pt === 'propertybool' || propType === 3) {
        wo.setBoolValue(Number(key), Boolean(value));
        modified = true;
      } else if (pt === 'float' || pt === 'propertyfloat' || propType === 4) {
        wo.setFloatValue(Number(key), Number(value));
        modified = true;
      } else if (pt === 'string' || pt === 'propertystring' || propType === 5) {
        wo.setStringValue(Number(key), String(value));
        modified = true;
      } else if (pt === 'data' || pt === 'dataid' || pt === 'propertydataid' || propType === 6) {
        wo.setDataValue(Number(key), value >>> 0);
        modified = true;
      } else if (pt === 'instance' || pt === 'instanceid' || pt === 'propertyinstanceid' || propType === 7) {
        wo.setInstanceValue(Number(key), value >>> 0);
        modified = true;
      } else if (pt === 'position' || pt === 'propertyposition' || propType === 8) {
        wo.setPositionValue(Number(key), value);
        modified = true;
      }
    }

    // Bulk bundles
    const props = event.properties ?? event;
    applyMap(props.intProperties ?? props.intValues ?? props.ints, (k, v) => wo.setIntValue(k | 0, v | 0));
    applyMap(props.int64Properties ?? props.int64Values ?? props.int64s, (k, v) => wo.setInt64Value(k | 0, typeof v === 'bigint' ? v : BigInt(v)));
    applyMap(props.boolProperties ?? props.boolValues ?? props.bools, (k, v) => wo.setBoolValue(k | 0, Boolean(v)));
    applyMap(props.floatProperties ?? props.floatValues ?? props.floats, (k, v) => wo.setFloatValue(k | 0, Number(v)));
    applyMap(props.stringProperties ?? props.stringValues ?? props.strings, (k, v) => wo.setStringValue(k | 0, String(v)));
    applyMap(props.dataIdProperties ?? props.dataValues ?? props.dataIds, (k, v) => wo.setDataValue(k | 0, v >>> 0));
    applyMap(props.instanceProperties ?? props.instanceValues ?? props.instances, (k, v) => wo.setInstanceValue(k | 0, v >>> 0));
    applyMap(props.positionProperties ?? props.positionValues ?? props.positions, (k, v) => wo.setPositionValue(k | 0, v));

    if (modified) {
      this.dispatchEvent(new CustomEvent('propertyChanged', { detail: { object: wo, guid: wo.id, event } }));
      this.dispatchEvent(new CustomEvent('propertyUpdated', { detail: { object: wo, guid: wo.id, event } }));
    }
    return modified;
  }

  /**
   * Apply live position updates to a WorldObject.
   *
   * Accepts: { guid, position: { x, y, z, ... } } or { guid, x, y, z, heading, cellId }
   * Emits 'positionChanged' and 'positionUpdated'.
   */
  onPositionUpdate(event) {
    if (!event) return false;
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingUpdates.push({ type: 'position', event });
      return false;
    }
    const guid = (event.guid ?? event.objectId ?? event.id ?? event.u32Payload ?? 0) >>> 0;
    const wo = this.objects.get(guid);
    if (!wo) return false;

    const pos = event.position ?? event.pos ?? {
      x: event.x ?? 0,
      y: event.y ?? 0,
      z: event.z ?? 0,
      heading: event.heading ?? 0,
      cellId: event.cellId ?? event.cell ?? 0,
    };

    wo.position = pos;
    wo.setPositionValue(1, pos);

    this.dispatchEvent(new CustomEvent('positionChanged', { detail: { object: wo, guid: wo.id, position: pos } }));
    this.dispatchEvent(new CustomEvent('positionUpdated', { detail: { object: wo, guid: wo.id, position: pos } }));
    return true;
  }

  /**
   * Handle ContainerOpened event.
   *
   * Updates `this.openContainer` and child items' `PROP_INSTANCE_CONTAINER` (2).
   * Emits 'containerOpened'.
   */
  onContainerOpened(event) {
    if (!event) return false;
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingUpdates.push({ type: 'containerOpened', event });
      return false;
    }
    const containerGuid = (event.guid ?? event.containerGuid ?? event.u32Payload ?? 0) >>> 0;
    const container = this.objects.get(containerGuid) ?? containerGuid;
    this.openContainer = container;

    const items = event.items ?? event.itemGuids ?? [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const itemGuid = (typeof item === 'object' ? (item.guid ?? item.id) : item) >>> 0;
        const childWo = this.objects.get(itemGuid);
        if (childWo) {
          childWo.setInstanceValue(2, containerGuid);
        }
      }
    }

    this.dispatchEvent(new CustomEvent('containerOpened', {
      detail: { container: this.openContainer, containerGuid, items, name: event.stringPayload ?? event.name ?? '' },
    }));
    return true;
  }

  /**
   * Handle ContainerClosed event.
   *
   * Clears `this.openContainer` and emits 'containerClosed'.
   */
  onContainerClosed(event = {}) {
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingUpdates.push({ type: 'containerClosed', event });
      return false;
    }
    const containerGuid = (event.guid ?? event.containerGuid ?? event.u32Payload ?? 0) >>> 0;
    const prev = this.openContainer;
    this.openContainer = null;

    this.dispatchEvent(new CustomEvent('containerClosed', {
      detail: { container: prev, containerGuid },
    }));
    return true;
  }

  /**
   * Handle item parenting changes (wielding or container moves).
   * Emits 'itemParentChanged' and 'itemContainerChanged'.
   */
  onItemParent(event) {
    if (!event) return false;
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingUpdates.push({ type: 'itemParent', event });
      return false;
    }
    const itemGuid = (event.itemGuid ?? event.guid ?? event.u32Payload ?? 0) >>> 0;
    const parentGuid = (event.parentGuid ?? event.containerGuid ?? event.wielderGuid ?? event.u32Payload2 ?? 0) >>> 0;
    const isWielder = event.isWielder === true;
    const slotIndex = event.slotIndex ?? 0;

    const item = this.objects.get(itemGuid);
    if (!item) return false;

    if (isWielder) {
      item.setInstanceValue(3, parentGuid); // PROP_INSTANCE_WIELDER = 3
    } else {
      item.setInstanceValue(2, parentGuid); // PROP_INSTANCE_CONTAINER = 2
    }

    const detail = { item, parentGuid, isWielder, slotIndex };
    this.dispatchEvent(new CustomEvent('itemParentChanged', { detail }));
    this.dispatchEvent(new CustomEvent('itemContainerChanged', { detail }));
    return true;
  }

  /** Alias for onItemParent with isWielder: false semantics */
  onItemContainerChanged(event) {
    return this.onItemParent({ ...event, isWielder: false });
  }

  /**
   * Handle ObjectAppraised event.
   *
   * Folds appraisal property dictionaries into the target WorldObject,
   * sets hasAppraisalData = true and lastAppraisalTime = new Date().
   * Emits 'objectAppraised' and 'appraisalUpdated'.
   */
  onObjectAppraised(event) {
    if (!event) return false;
    if (!this.loaded) {
      if (!this.loadFailed) this._pendingUpdates.push({ type: 'appraisal', event });
      return false;
    }
    const guid = (event.guid ?? event.objectId ?? event.id ?? event.u32Payload ?? 0) >>> 0;
    const wo = this.objects.get(guid);
    if (!wo) return false;

    const payload = event.properties ?? event.payload ?? event;

    const applyMap = (entries, setter) => {
      if (!entries) return;
      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (Array.isArray(item) && item.length >= 2) {
            setter(item[0], item[1]);
          }
        }
      } else if (typeof entries === 'object') {
        for (const [k, v] of Object.entries(entries)) {
          setter(Number(k), v);
        }
      }
    };

    applyMap(payload.intProperties ?? payload.intValues ?? payload.ints, (k, v) => wo.setIntValue(k | 0, v | 0));
    applyMap(payload.int64Properties ?? payload.int64Values ?? payload.int64s, (k, v) => wo.setInt64Value(k | 0, typeof v === 'bigint' ? v : BigInt(v)));
    applyMap(payload.boolProperties ?? payload.boolValues ?? payload.bools, (k, v) => wo.setBoolValue(k | 0, Boolean(v)));
    applyMap(payload.floatProperties ?? payload.floatValues ?? payload.floats, (k, v) => wo.setFloatValue(k | 0, Number(v)));
    applyMap(payload.stringProperties ?? payload.stringValues ?? payload.strings, (k, v) => wo.setStringValue(k | 0, String(v)));
    applyMap(payload.dataIdProperties ?? payload.dataValues ?? payload.dataIds, (k, v) => wo.setDataValue(k | 0, v >>> 0));
    applyMap(payload.instanceProperties ?? payload.instanceValues ?? payload.instances, (k, v) => wo.setInstanceValue(k | 0, v >>> 0));
    applyMap(payload.positionProperties ?? payload.positionValues ?? payload.positions, (k, v) => wo.setPositionValue(k | 0, v));

    if (payload.spellBook) {
      wo._spellBook = payload.spellBook;
      if (typeof wo.updateSpells === 'function') {
        wo.updateSpells(payload.spellBook);
      }
    }

    wo.hasAppraisalData = true;
    wo.lastAppraisalTime = new Date();

    const detail = { object: wo, guid: wo.id, properties: payload };
    this.dispatchEvent(new CustomEvent('objectAppraised', { detail }));
    this.dispatchEvent(new CustomEvent('appraisalUpdated', { detail }));
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
    const byCanonical = new Map();
    let unknownCount = 0;
    let itemFallbackCount = 0;
    for (const wo of this.objects.values()) {
      const cls = wo.constructor.name;
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      const canonical = wo.canonicalObjectClass ?? '(unset)';
      byCanonical.set(canonical, (byCanonical.get(canonical) ?? 0) + 1);
      if (wo.classificationSource === 'unknown') unknownCount++;
      if (wo.classificationSource === 'canonical-item-fallback') itemFallbackCount++;
      objects.push({
        guid: wo.id,
        classId: wo.classId,
        className: cls,
        canonicalObjectClass: wo.canonicalObjectClass ?? null,
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
      itemFallbackCount,
      byClass: Object.fromEntries([...byClass.entries()].sort((a, b) => b[1] - a[1])),
      byCanonical: Object.fromEntries([...byCanonical.entries()].sort((a, b) => b[1] - a[1])),
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
