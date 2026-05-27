// =============================================================================
// ACPlugin PR-2 (2026-05-27) — WorldState dispatch table (port of World.cs)
// =============================================================================
//
// Direct port of `external/chorizite/ACPlugin/API/World.cs` (vendored HEAD
// 1341660): the 40-handler S2C dispatch table + the load-bearing
// container-open child-wait gate at `World.cs:212-249`.
//
// Routes server-event ClientEvent kinds drained by index.html into PR 1's
// `WorldObject` setters (`setIntValue` / `setInstanceValue` / etc.) so plugin
// code reads typed property bundles instead of poking the wasm session-handle.
//
// Exposed on the plugin client as `client.world` (matches the C# `Game.World`
// row in ACPlugin §4 — the top-level public surface every other plugin
// reaches into for `World[guid]`, `World.Exists`, `World.OpenContainer`,
// `World.Selected`, etc.).
//
// Citations:
//   - `World.cs:LLL` references `external/chorizite/ACPlugin/API/World.cs`.
//   - Handoff cites point to
//     `external/holtburger/docs/chorizite-reading-guide-summary-2026-05-27.md`.
//   - Coverage-matrix cites point to
//     `external/holtburger/docs/acplugin-event-coverage-2026-05-27.md`.
//
// Load-bearing semantics replicated here (handoff §3):
//   1. Container-open child-wait — defer `containerOpened` until every listed
//      child `Item_CreateObject` has arrived. Was a known race in
//      plugins/api.js pre-PR-2 (coverage table row 3); fixed below.
//   2. `PrivateUpdate*` vs `Update*` distinction is deferred to PR 4
//      (Character.cs port) — World.cs only sees PUBLIC quality updates.
//   3. `ApplyEnchantment` cooldown discriminator is deferred to PR 4
//      (Character.cs port); World.cs has no enchantment dispatch.
//   4. PR 1's setters MUST be used (`wo.setIntValue(key, value)`), NOT the
//      raw `wo.intValues.set(...)`. The setters have side effects:
//      `setIntValue` invalidates the `_objectClass` cache and
//      `setInstanceValue` short-circuits unchanged writes.
// =============================================================================

import { WorldObject } from './world-objects/world_object.js';

// PropertyInt / PropertyInstanceId constants needed by the dispatch table.
// Sourced from `crates/holtburger-common/src/properties/property_keys/`.
// PR 1's WorldObject inlines the same constants; we mirror only the values
// needed at THIS layer so a stray drift on one side doesn't silently corrupt
// the other.
const PROP_INT_STACK_SIZE        = 12;
const PROP_INT_VALUE             = 19;
const PROP_INT_PHYSICS_STATE     = 107;

const PROP_INSTANCE_CONTAINER    = 2;
const PROP_INSTANCE_WIELDER      = 3;

// `Item_OnViewContents` payload routing per `World.cs:207-251`. We model
// the in-flight gate as a Map<containerGuid, {watchSet, container}> so
// concurrent container opens don't clobber each other.
//
// Edge cases the C# version models:
//   - empty container → fires immediately (`World.cs:231-233`)
//   - child container with ContainerType — propagates onto the child weenie
//     via `AddOrUpdateValue(PropertyInstanceId.Container, e.ContainerId)`
//     (`World.cs:223`)
//   - filtered-out: skip if `container.ParentContainer?.Id ==
//     ACPlugin.Instance.Game.Character.Id` (`World.cs:228`) — opening one of
//     your OWN child packs doesn't fire containerOpened.

/**
 * Per-session weenie cache + 40-handler S2C dispatcher. One-to-one port of
 * `World.cs:18-820` (ACPlugin vendored HEAD 1341660).
 *
 * Construction is intentionally idle — the dispatcher is wired by the host
 * (plugins/api.js) calling `attachClient(client)` after `createClient()`
 * resolves, then forwarding the relevant kind=N events via
 * `dispatchContainerOpened` / `dispatchContainerClosed` / etc.
 *
 * The `Weenies` map IS the canonical entity store from the plugin POV.
 * Subscribers consume snapshots via `client.world.get(guid)` or iterate
 * `client.world.all()`. The host can still keep its wasm-side entity cache
 * for renderer hot paths; this layer is the typed mirror.
 */
export class WorldState extends EventTarget {
  constructor({ manager = null, client = null, logger = console } = {}) {
    super();

    // `World.cs:25 — public Dictionary<uint, WorldObject> Weenies`. We
    // mirror as a Map keyed by GUID (uint32). PR 3's typed-subclass
    // hierarchy lands as the manager dispatches typed constructors.
    this.weenies = new Map();

    // `World.cs:30 — public Container? OpenContainer`. Latest container
    // (vendor or non-vendor) the local player is viewing. Cleared on
    // container-closed.
    this.openContainer = null;

    // `World.cs:36 — public WorldObject? Selected`. Reflects the GUID
    // the renderer's picking layer reports through `client.events.on(
    // 'selectionChanged', …)`. Set by the host plugin via
    // `setSelected(guid)`.
    this.selected = null;

    // Manager (PR 1's WorldObjectManager) — owns the typed-subclass
    // dispatch (Item / Container / Door / Portal / Lifestone / …).
    // Optional; when null we fall back to constructing bare WorldObject
    // sentinels.
    this.manager = manager;

    // Plugin client for wire dispatch. Required for `world.player.attack`
    // etc., but read here only via the snapshot getters.
    this.client = client;

    // Logger — `console`-like surface. Tests inject a stub to assert log
    // lines.
    this.log = logger;

    // In-flight container-open gates (`World.cs:212-249`). Map of
    // container GUID → { container, pending: Set<childGuid>, fireOnce }.
    // The wasm-side already cached the item list when it published the
    // `containerOpened` kind=21 (see `lib.rs:25911-25951`). The reason
    // we still need the gate is the JS-side WorldObject for each child
    // may not be in `this.weenies` yet at dispatch time (the kind=10
    // ObjectCreated events for the children may arrive AFTER the
    // kind=21). The C# version watches `OnItem_CreateObject` for each
    // pending child; we watch our own `objectCreated` bus event.
    this._pendingContainerOpens = new Map();

    // Enchantment delta tracking — kind=8 PlayerStatsUpdated coalesces
    // all enchantment events (add/remove/update/purge). We diff the
    // current snapshot vs the last to emit `enchantmentAdded` and
    // `enchantmentRemoved` events with delta payloads. See handoff
    // §5.1 §6.2 priority list (#1 renderer impact, blocks the
    // buffs/debuffs HUD entirely per matrix doc §F).
    //
    // Per handoff §3 third quote (`Character.cs:619`): one wire packet
    // carries both enchantments AND cooldowns; discriminator is
    // `StatMod.Type & EnchantmentTypeFlags.Cooldown`. For PR 2 we only
    // diff actual enchantments — cooldowns ship in PR 4 via the
    // Character-private path.
    //
    // Keyed by `(spell_id << 16) | layer` so distinct layers of the
    // same spell get distinct slots — matches the AC client's
    // EnchantmentRegistry layering.
    this._enchantmentSnapshot = new Map();

    // Last-seen appraisal time per GUID — used to suppress duplicate
    // `objectAppraised` emits when the same identify reply is folded
    // into the entity store more than once. Mirrors C#
    // `WorldObject.LastAppraisalTime` (`WorldObject.cs:131`).
    this._lastAppraisalAt = new Map();

    this._disposed = false;
  }

  // ─── Public surface (mirrors `World.cs:136-165`) ───

  /**
   * Try to get a world object by GUID. Symbol of `World[guid]` indexer
   * (`World.cs:142-144`).
   *
   * @param {number} objectId GUID (uint32; 0 = lookup-miss sentinel)
   * @returns {WorldObject|null}
   */
  get(objectId) {
    if (objectId == null) return null;
    return this.weenies.get(objectId >>> 0) ?? null;
  }

  /**
   * Check whether a GUID is currently in the weenie cache. Port of
   * `World.cs:164 Exists`.
   *
   * @param {number} objectId
   * @returns {boolean}
   */
  exists(objectId) {
    if (objectId == null) return false;
    return this.weenies.has(objectId >>> 0);
  }

  /** Total weenie count. */
  count() {
    return this.weenies.size;
  }

  /** Iterate every live weenie. */
  *all() {
    yield* this.weenies.values();
  }

  /**
   * Filter weenies by typed-class name (e.g. `byClass('Container')`).
   * Returns the manager's filter when the manager is wired (uses
   * taxonomy descendant lookup), otherwise a flat name match.
   */
  byClass(className) {
    if (this.manager) return this.manager.byClass(className);
    return [...this.weenies.values()].filter(wo => wo.className === className);
  }

  // ─── Wire-feed entry points (called by the host) ───

  /**
   * Late-attach the plugin client. PR 1's manager already takes a client
   * via constructor option; this lets the world-state mirror the same
   * deferred-wire pattern (manager constructed at boot, client wired at
   * createClient resolution).
   */
  attachClient(client) {
    this.client = client;
    if (this.manager) this.manager.attachClient(client);
  }

  /**
   * Port of `OnItem_CreateObject` (`World.cs:175-191`). The host calls
   * this whenever a new weenie enters the world (kind=1 EntityUpdate
   * SPAWN or the wasm-side has finished an ObjectCreate parse).
   *
   * `payload` accepts the shape published by the `WorldObjectManager`
   * (which we mirror) PLUS the optional ObjDesc/PhysicsDesc/WeenieDesc
   * blobs that may have arrived inline. When these come later (the
   * typical wasm path that fans them out across multiple wire packets),
   * the host calls `dispatchObjDescUpdate` / `dispatchPhysicsDescUpdate`
   * / `dispatchWeenieDescUpdate` separately.
   *
   * @param {object} payload {guid, classId?, objDesc?, physicsDesc?,
   *                          weenieDesc?, itemType?, objDescFlags?,
   *                          weenieFlags?, name?}
   * @returns {WorldObject|null}
   */
  dispatchItemCreateObject(payload) {
    if (this._disposed) return null;
    const guid = (payload?.guid ?? payload?.objectId ?? payload?.id ?? 0) >>> 0;
    if (guid === 0) {
      this.log.warn('[world-state] dispatchItemCreateObject: missing GUID', payload);
      return null;
    }

    // `World.cs:178-184`: if this is the local player, route through the
    // existing Character instance instead of constructing a new one.
    // PR 4 (Character.cs port) will install `client.player.character` —
    // until then we fall back to the bare-creation path. The deferral
    // matches the handoff scope.
    let wo = this.weenies.get(guid);
    if (!wo) {
      // Defer construction to the manager when available — it owns the
      // typed-subclass dispatch via `canonicalClassify`. Otherwise build
      // a sentinel.
      if (this.manager?.loaded) {
        wo = this.manager.onObjectCreated({
          guid,
          classId: payload?.classId ?? payload?.wcid ?? 0,
          itemType: payload?.itemType ?? 0,
          objDescFlags: payload?.objDescFlags ?? payload?.behavior ?? 0,
          weenieFlags: payload?.weenieFlags ?? 0,
          name: payload?.name ?? null,
        });
      } else {
        wo = new WorldObject(
          guid,
          payload?.classId ?? 0,
          null,
          null,
          null,
        );
      }
      if (!wo) return null;
      this.weenies.set(guid, wo);
    }

    // `World.cs:186-188` — apply the three description blobs in the
    // canonical order: ObjDesc, PhysicsDesc, WeenieDesc.
    if (payload?.objDesc)      wo.updateObjDesc(payload.objDesc);
    if (payload?.physicsDesc)  wo.updatePhysicsDesc(payload.physicsDesc);
    if (payload?.weenieDesc)   wo.updateWeenieDesc(payload.weenieDesc);

    // `World.cs:190` — fire ObjectCreatedEventArgs.
    this.dispatchEvent(new CustomEvent('objectCreated', { detail: { object: wo } }));

    // Notify any pending container-open gates that this GUID has now
    // arrived (`World.cs:236-246`).
    this._resolveContainerGate(guid);

    return wo;
  }

  /**
   * Port of `OnItem_DeleteObject` (`World.cs:193-195`) + `RemoveWeenie`
   * (`World.cs:734-770`). Removes from the cache, recursively removes
   * container children, fires `objectReleased`.
   *
   * @param {number} guid GUID to delete.
   * @returns {boolean} true if removed; false if not in cache.
   */
  dispatchItemDeleteObject(guid) {
    if (this._disposed) return false;
    const id = guid >>> 0;
    const wo = this.weenies.get(id);
    if (!wo) return false;

    // Recursive removal of container children (`World.cs:756-760`).
    // Conservative — we touch `wo.items` (a PR-3 Container.read-through
    // getter) only if the manager has provided it. Pre-PR-3 we skip.
    if (Array.isArray(wo.items)) {
      for (const child of [...wo.items]) {
        this.dispatchItemDeleteObject(child.id);
      }
    }

    this.weenies.delete(id);
    this._lastAppraisalAt.delete(id);

    // Fire ObjectReleasedEventArgs (`World.cs:767-768`).
    this.dispatchEvent(new CustomEvent('objectReleased', { detail: { object: wo } }));
    return true;
  }

  /**
   * Port of `OnItem_ObjDescEvent` (`World.cs:197-205`). Update the ObjDesc
   * snapshot on the existing weenie. The PR 1 setter `updateObjDesc` does
   * the work; we just look up + warn-on-miss.
   *
   * @param {number} guid
   * @param {object} objDesc
   */
  dispatchObjDescUpdate(guid, objDesc) {
    const wo = this.weenies.get(guid >>> 0);
    if (!wo) {
      this.log.warn(
        `[world-state] dispatchObjDescUpdate: unknown weenie 0x${(guid >>> 0).toString(16)}`
      );
      return;
    }
    wo.updateObjDesc(objDesc);
    this.dispatchEvent(new CustomEvent('objDescChanged', { detail: { object: wo, objDesc } }));
  }

  /**
   * Port of `Item_UpdateObject` (`World.cs:346-356`). Folds all three
   * descriptions in one shot — used when ACE refreshes an entity
   * wholesale.
   */
  dispatchObjectUpdate(guid, { objDesc, physicsDesc, weenieDesc } = {}) {
    const wo = this.weenies.get(guid >>> 0);
    if (!wo) {
      this.log.warn(
        `[world-state] dispatchObjectUpdate: unknown weenie 0x${(guid >>> 0).toString(16)}`
      );
      return;
    }
    if (weenieDesc)  wo.updateWeenieDesc(weenieDesc);
    if (objDesc)     wo.updateObjDesc(objDesc);
    if (physicsDesc) wo.updatePhysicsDesc(physicsDesc);
    wo.lastAccessTime = new Date();
  }

  /**
   * Port of `Item_ParentEvent` (`World.cs:264-271`). Sets the wielder
   * GUID on the child weenie. Used when ACE notifies that an item is
   * now equipped on a creature.
   *
   * Per PR 1 conventions, use `setInstanceValue` (`WorldObject.cs:501-508`
   * has the same-value short-circuit that we mirror in
   * `world_object.js:282-286`).
   */
  dispatchItemParent(childGuid, parentGuid) {
    const wo = this.weenies.get(childGuid >>> 0);
    if (!wo) {
      this.log.warn(
        `[world-state] dispatchItemParent: unknown child 0x${(childGuid >>> 0).toString(16)}`
      );
      return;
    }
    wo.setInstanceValue(PROP_INSTANCE_WIELDER, parentGuid >>> 0);
    this.dispatchEvent(new CustomEvent('itemParentChanged', {
      detail: { object: wo, parentGuid: parentGuid >>> 0 },
    }));
  }

  /**
   * Port of `OnItem_OnViewContents` (`World.cs:207-251`). The
   * load-bearing container-open child-wait gate.
   *
   * `items` is the list `[(itemGuid, containerType), ...]` ACE published
   * with the ViewContents wire event. For each item we either:
   *   (a) already have it in the weenie cache → mark it ready; or
   *   (b) don't have it yet → register a pending watch.
   *
   * When all watched items are ready (initially or via subsequent
   * `objectCreated` events), `containerOpened` fires. Empty contents
   * → fire immediately (`World.cs:231-233`).
   *
   * @param {number} containerGuid
   * @param {Array<{guid:number, containerType:number}>} items
   */
  dispatchContainerOpened(containerGuid, items = []) {
    if (this._disposed) return;
    const cid = containerGuid >>> 0;
    const container = this.weenies.get(cid);
    if (!container) {
      this.log.warn(
        `[world-state] dispatchContainerOpened: unknown container 0x${cid.toString(16)}`
      );
      return;
    }

    // `World.cs:213-226` — propagate container-id onto each known child.
    const pending = new Set();
    for (const item of items) {
      const itemGuid = (item.guid ?? item.objectId ?? item) >>> 0;
      if (!itemGuid) continue;
      const child = this.weenies.get(itemGuid);
      if (child) {
        // `World.cs:222-223` — set the child's container ref so
        // PR 3's `Container.items` read-through getters resolve.
        child.setInstanceValue(PROP_INSTANCE_CONTAINER, cid);
        // ContainerType is a typed property on Container subclasses.
        // PR 3 lands the `containerType` field; for PR 2 we stash on
        // the WorldObject sentinel so a late-arriving subclass refresh
        // can pick it up.
        if (item.containerType !== undefined) {
          child._containerType = item.containerType;
        }
      } else {
        // Not yet seen — register watch.
        pending.add(itemGuid);
      }
    }

    // `World.cs:228-230` — filter: opening one of your own child packs
    // (where the container's ParentContainer is the local player) is
    // NOT surfaced as `containerOpened`. We can't tell pre-PR-4 because
    // we don't have a typed Character instance yet; PR 2 ships the
    // unconditional emit and PR 4 will tighten the filter.

    this.openContainer = container;

    if (pending.size === 0) {
      // `World.cs:231-233` — empty container or all children already
      // present → fire immediately.
      this._fireContainerOpened(container);
    } else {
      // `World.cs:234-249` — register a one-shot watch. As each
      // pending child arrives via `dispatchItemCreateObject`,
      // `_resolveContainerGate` strikes it off; when the set is empty
      // the gate fires.
      this._pendingContainerOpens.set(cid, {
        container,
        pending,
        startedAt: Date.now(),
      });
    }
  }

  /** Strike `guid` off any in-flight container-open gates. */
  _resolveContainerGate(guid) {
    if (this._pendingContainerOpens.size === 0) return;
    const g = guid >>> 0;
    for (const [cid, gate] of this._pendingContainerOpens) {
      if (gate.pending.has(g)) {
        gate.pending.delete(g);
        if (gate.pending.size === 0) {
          this._pendingContainerOpens.delete(cid);
          this._fireContainerOpened(gate.container);
        }
      }
    }
  }

  _fireContainerOpened(container) {
    this.dispatchEvent(new CustomEvent('containerOpened', { detail: { container } }));
  }

  /**
   * Port of `OnItem_StopViewingObjectContents` (`World.cs:253-262`).
   * Fires `containerClosed` and clears `openContainer`.
   *
   * Coverage table row 4 → flipped from MISSING to IMPLEMENTED.
   */
  dispatchContainerClosed(containerGuid) {
    if (this._disposed) return;
    const cid = containerGuid >>> 0;
    const container = this.weenies.get(cid);
    if (!container) {
      this.log.warn(
        `[world-state] dispatchContainerClosed: unknown container 0x${cid.toString(16)}`
      );
      // Still clear openContainer if it matched — defensive.
      if (this.openContainer?.id === cid) this.openContainer = null;
      return;
    }

    // `World.cs:260-261`: clear the open-container reference + fire
    // the EventArgs.
    this.openContainer = null;
    // Also clear any orphan pending gate for this container.
    this._pendingContainerOpens.delete(cid);
    this.dispatchEvent(new CustomEvent('containerClosed', { detail: { container } }));
  }

  /**
   * Port of `OnItem_ServerSaysContainId` (`World.cs:273-287`). Moves a
   * weenie from one container to another (or into a container for the
   * first time).
   *
   * @param {number} itemGuid
   * @param {number} newContainerGuid
   * @param {number} slotIndex
   */
  dispatchServerSaysContainId(itemGuid, newContainerGuid, slotIndex = 0) {
    const item = this.weenies.get(itemGuid >>> 0);
    if (!item) {
      this.log.warn(
        `[world-state] dispatchServerSaysContainId: unknown item 0x${(itemGuid >>> 0).toString(16)}`
      );
      return;
    }
    const parent = this.weenies.get(newContainerGuid >>> 0);
    if (!parent) {
      this.log.warn(
        `[world-state] dispatchServerSaysContainId: unknown container 0x${(newContainerGuid >>> 0).toString(16)}`
      );
      return;
    }
    item.setInstanceValue(PROP_INSTANCE_CONTAINER, newContainerGuid >>> 0);
    this.dispatchEvent(new CustomEvent('itemContainerChanged', {
      detail: { item, parent, slotIndex },
    }));
  }

  /**
   * Port of `Item_SetState` (`World.cs:336-344`). The wire payload sets
   * `PropertyInt.PhysicsState` on the target weenie. JS-side door /
   * visibility consumers already react to kind=15 / kind=17 — this is
   * additional plumbing for non-door entities (per matrix row 13:
   * "Generic itemStateChanged for non-door objects would cover
   * container locks").
   */
  dispatchSetState(guid, newState) {
    const wo = this.weenies.get(guid >>> 0);
    if (!wo) {
      this.log.warn(
        `[world-state] dispatchSetState: unknown weenie 0x${(guid >>> 0).toString(16)}`
      );
      return;
    }
    const previousState = wo.intValue(PROP_INT_PHYSICS_STATE, 0);
    wo.setIntValue(PROP_INT_PHYSICS_STATE, newState | 0);
    this.dispatchEvent(new CustomEvent('itemStateChanged', {
      detail: { object: wo, newState: newState | 0, previousState },
    }));
  }

  /**
   * Port of `Item_UpdateStackSize` (`World.cs:358-366`). Updates both
   * the stack-count + per-item value.
   */
  dispatchUpdateStackSize(guid, amount, newValue) {
    const wo = this.weenies.get(guid >>> 0);
    if (!wo) {
      this.log.warn(
        `[world-state] dispatchUpdateStackSize: unknown weenie 0x${(guid >>> 0).toString(16)}`
      );
      return;
    }
    wo.setIntValue(PROP_INT_STACK_SIZE, amount | 0);
    wo.setIntValue(PROP_INT_VALUE, newValue | 0);
    this.dispatchEvent(new CustomEvent('stackSizeChanged', {
      detail: { object: wo, amount, newValue },
    }));
  }

  /**
   * Port of `OnItem_SetAppraiseInfo` (`World.cs:317-334`). Fold the
   * appraisal property bundles into the weenie's typed property store
   * and emit `objectAppraised` for the UI to refresh.
   *
   * The wasm side already stashed the appraisal text via the world's
   * `apply_identify_response` (entity.properties.strings/.ints/etc.); we
   * mirror those into the JS-side typed property dicts here so plugin
   * code that reads off `WorldObject` sees them too.
   *
   * `payload` accepts the shape `{boolProperties, intProperties,
   * int64Properties, floatProperties, stringProperties, dataIdProperties,
   * spellBook}` (matching `Item_SetAppraiseInfo`'s C# field names);
   * each is an iterable of `[key, value]` pairs.
   *
   * Coverage table row 12 → flipped from N to IMPLEMENTED.
   */
  dispatchSetAppraiseInfo(guid, payload = {}) {
    const wo = this.weenies.get(guid >>> 0);
    if (!wo) {
      this.log.warn(
        `[world-state] dispatchSetAppraiseInfo: unknown weenie 0x${(guid >>> 0).toString(16)}`
      );
      return;
    }
    const folded = {};
    if (payload.intProperties) {
      folded.ints = [];
      for (const [k, v] of payload.intProperties) {
        wo.setIntValue(k | 0, v | 0);
        folded.ints.push([k | 0, v | 0]);
      }
    }
    if (payload.int64Properties) {
      folded.int64s = [];
      for (const [k, v] of payload.int64Properties) {
        wo.setInt64Value(k | 0, typeof v === 'bigint' ? v : BigInt(v));
        folded.int64s.push([k | 0, v]);
      }
    }
    if (payload.boolProperties) {
      folded.bools = [];
      for (const [k, v] of payload.boolProperties) {
        wo.setBoolValue(k | 0, Boolean(v));
        folded.bools.push([k | 0, Boolean(v)]);
      }
    }
    if (payload.floatProperties) {
      folded.floats = [];
      for (const [k, v] of payload.floatProperties) {
        wo.setFloatValue(k | 0, Number(v));
        folded.floats.push([k | 0, Number(v)]);
      }
    }
    if (payload.stringProperties) {
      folded.strings = [];
      for (const [k, v] of payload.stringProperties) {
        wo.setStringValue(k | 0, String(v));
        folded.strings.push([k | 0, String(v)]);
      }
    }
    if (payload.dataIdProperties) {
      folded.dataIds = [];
      for (const [k, v] of payload.dataIdProperties) {
        wo.setDataValue(k | 0, v >>> 0);
        folded.dataIds.push([k | 0, v >>> 0]);
      }
    }
    if (payload.spellBook) {
      // PR-3 Item.updateSpells lands the typed spell-book; for PR-2
      // we stash on the WorldObject for now.
      wo._spellBook = payload.spellBook;
      folded.spellBook = payload.spellBook;
    }
    wo.hasAppraisalData = true;
    wo.lastAppraisalTime = new Date();
    this._lastAppraisalAt.set(wo.id, wo.lastAppraisalTime.getTime());
    this.dispatchEvent(new CustomEvent('objectAppraised', {
      detail: { object: wo, properties: folded },
    }));
  }

  /**
   * Process the local player's enchantment snapshot (kind=8 piggyback).
   * Diffs against the previous snapshot to emit `enchantmentAdded` and
   * `enchantmentRemoved` bus events with delta payloads. The full
   * snapshot stays available via `client.player.enchantments`.
   *
   * Per handoff §3 third quote (`Character.cs:619`): the wire packet
   * carries enchantments AND cooldowns combined; the
   * EnchantmentTypeFlags.Cooldown bit is the discriminator. For PR 2
   * we ASSUME the wasm side has already filtered cooldowns out
   * (publish_player_enchantments_snapshot only takes "Enchantment"
   * variants). PR 4 will add a separate dispatch for cooldowns.
   *
   * Per handoff §3 seventh quote (`Character.cs:232-239`) — when more
   * than one enchantment occupies the same `(spell_category, layer)`,
   * the tiebreak is `Power desc → Level8AuraSelfSpells →
   * SetSpells ? SpellId : StartTime → .First()`. PR 2 doesn't
   * resolve the tiebreak (we emit all add/remove deltas verbatim); the
   * buff-display UI on top of this should run the tiebreak when
   * rendering its slot list.
   *
   * @param {Array<{spell_id, spellId, layer, power_level, powerLevel,
   *               start_time, startTime, duration, caster_guid,
   *               casterGuid, spell_category, spellCategory}>} snapshot
   */
  dispatchEnchantmentSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return;
    const next = new Map();
    for (const e of snapshot) {
      const sid = (e.spell_id ?? e.spellId ?? 0) >>> 0;
      const layer = (e.layer ?? 0) >>> 0;
      const key = (sid << 16) | (layer & 0xFFFF);
      next.set(key, {
        spellId: sid,
        layer,
        powerLevel:   (e.power_level    ?? e.powerLevel    ?? 0) >>> 0,
        startTime:    (e.start_time     ?? e.startTime     ?? 0),
        duration:     (e.duration       ?? 0),
        casterGuid:   (e.caster_guid    ?? e.casterGuid    ?? 0) >>> 0,
        spellCategory:(e.spell_category ?? e.spellCategory ?? 0) >>> 0,
      });
    }

    // Diff. Per AddRemoveEventType in plugins/api.js:108-111 — Added=0,
    // Removed=1. We emit one bus event per delta.
    const prev = this._enchantmentSnapshot;
    let added = 0;
    let removed = 0;
    for (const [key, ench] of next) {
      if (!prev.has(key)) {
        added += 1;
        this.dispatchEvent(new CustomEvent('enchantmentAdded', {
          detail: { type: 0, layeredSpellId: key, spellId: ench.spellId,
                    enchantment: ench },
        }));
      }
    }
    for (const [key, ench] of prev) {
      if (!next.has(key)) {
        removed += 1;
        this.dispatchEvent(new CustomEvent('enchantmentRemoved', {
          detail: { type: 1, layeredSpellId: key, spellId: ench.spellId,
                    enchantment: ench },
        }));
      }
    }

    this._enchantmentSnapshot = next;
    if (added + removed > 0) {
      this.dispatchEvent(new CustomEvent('enchantmentsChanged', {
        detail: {
          added, removed,
          total: next.size,
          snapshot: [...next.values()],
        },
      }));
    }
  }

  /**
   * Set the renderer-side selection. Bus subscribers reading
   * `world.selected` see the updated typed WorldObject (or null on
   * deselect).
   *
   * Symbol of `World.Selected` getter (`World.cs:36`) + the OnObjectSelected
   * handler chain (`World.cs:168-173`). The selection wire flow lives
   * in scene3d/picking.js; this is the bookkeeping hook.
   */
  setSelected(guid) {
    const prev = this.selected;
    if (guid == null || guid === 0) {
      this.selected = null;
    } else {
      this.selected = this.weenies.get(guid >>> 0) ?? null;
    }
    this.dispatchEvent(new CustomEvent('selectionChanged', {
      detail: { object: this.selected, previous: prev ?? null },
    }));
  }

  /**
   * Clear all state. Used at logout / character-swap. `World.cs:772-819`
   * is the Dispose path (which also unsubscribes from net events — N/A
   * here because we bind via the host's event drain).
   */
  reset() {
    this.weenies.clear();
    this.openContainer = null;
    this.selected = null;
    this._pendingContainerOpens.clear();
    this._enchantmentSnapshot.clear();
    this._lastAppraisalAt.clear();
  }

  dispose() {
    this._disposed = true;
    this.reset();
  }

  // ─── Snapshot for inspector / tests ───

  snapshot() {
    return {
      capturedAt: new Date().toISOString(),
      total: this.weenies.size,
      openContainer: this.openContainer ? {
        id: this.openContainer.id,
        name: this.openContainer.name,
      } : null,
      selected: this.selected ? {
        id: this.selected.id,
        name: this.selected.name,
      } : null,
      pendingGates: this._pendingContainerOpens.size,
      enchantmentCount: this._enchantmentSnapshot.size,
    };
  }
}

/**
 * Bind a freshly-constructed `WorldState` to the existing `client.events`
 * dispatch surface. Host calls this once at boot after creating both the
 * world-state instance and the plugin client.
 *
 * The kind=N drain in index.html publishes onto `client.events` already
 * for: `playerInventoryChanged`, `playerStatsUpdated`, `vendorOpened`,
 * `containerOpened`, `selectionChanged`, `playerKilled`, etc. We hook
 * the relevant ones into the WorldState dispatcher so plugins reading
 * `client.world.get(guid)` see the typed mirror.
 *
 * Per the load-bearing constraint in the PR-2 brief: integrate WITH the
 * existing kind=N system; don't refactor it.
 *
 * @param {WorldState} world
 * @param {object} client - plugin client from createClient()
 */
export function bindWorldStateToClient(world, client) {
  if (!client || !world) return;
  world.attachClient(client);

  // ContainerOpened (kind=21) — wasm side already cached the item GUID
  // list; pull it via `client.world.containerContents` (PR 1's
  // getContainerContents getter). For PR 2 we accept the wasm payload
  // directly + look up children from the existing weenie cache.
  client.events.on('containerOpened', (evt) => {
    const detail = evt.detail || {};
    const containerGuid = detail.u32Payload >>> 0;
    // The wasm-side container_contents cache (lib.rs:21473) holds
    // [item_guid, ...]. If the host passes them inline via the
    // `itemGuids` field, dispatch directly; otherwise emit with empty
    // children (the gate will fire immediately).
    const items = Array.isArray(detail.itemGuids)
      ? detail.itemGuids.map(g => ({ guid: g, containerType: 0 }))
      : [];
    world.dispatchContainerOpened(containerGuid, items);
  });

  // ContainerClosed (kind=31, new in this PR) — analogous to
  // containerOpened but for the StopViewingObjectContents wire.
  client.events.on('containerClosed', (evt) => {
    const detail = evt.detail || {};
    const containerGuid = detail.u32Payload >>> 0;
    world.dispatchContainerClosed(containerGuid);
  });

  // ObjectAppraised (kind=32, new in this PR). The wasm side has
  // already folded the appraisal data into the entity store; the kind
  // carries just the GUID so JS can look up properties via the existing
  // entity-store API. We forward the GUID into world-state's
  // dispatchSetAppraiseInfo with the payload pulled from the entity
  // store (host wires the lookup; default to an empty payload).
  client.events.on('objectAppraised', (evt) => {
    const detail = evt.detail || {};
    const guid = detail.u32Payload >>> 0;
    world.dispatchSetAppraiseInfo(guid, detail.properties || {});
  });

  // PlayerStatsUpdated (kind=8) — piggybacks enchantments. Forward the
  // snapshot into the diff engine.
  client.events.on('playerStatsUpdated', () => {
    try {
      const snapshot = client.player.enchantments
        ? client.player.enchantments()
        : null;
      if (snapshot) world.dispatchEnchantmentSnapshot(snapshot);
    } catch (e) {
      world.log.warn?.('[world-state] enchantment snapshot read failed', e);
    }
  });

  // SelectionChanged — emitted by scene3d/picking.js with
  // `{ guid, prevGuid }`. Mirror onto world.setSelected so
  // `client.world.selected` tracks.
  client.events.on('selectionChanged', (evt) => {
    const detail = evt.detail || {};
    const guid = (detail.guid ?? 0) >>> 0;
    world.setSelected(guid);
  });
}
