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
import { Character } from './world-objects/character.js';

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

    // 2026-05-27 — container-itself-not-yet-arrived queue. Mirrors
    // _pendingContainerOpens but for the case where the CONTAINER weenie
    // (not the children) hasn't landed via dispatchItemCreateObject yet.
    // Observed live as `[world-state] dispatchContainerOpened: unknown
    // container 0xXXXXXXXX` on the boot trace: ACE published
    // ContainerOpened (kind=21) before the corresponding ObjectCreate
    // (kind=10) for that container. Pre-fix the dispatch dropped on the
    // floor; now we queue the (containerGuid, items) tuple and replay
    // it from dispatchItemCreateObject when the matching guid registers.
    // Latest queued entry wins on re-queue (simple/correct: ACE wouldn't
    // re-publish ContainerOpened with stale items between drains).
    this._pendingContainerOpenForContainer = new Map();

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

    // PR 4 (2026-05-27): the local player's `Character` instance. Set
    // when `dispatchItemCreateObject` sees a GUID matching
    // `_localPlayerGuid` — until then, null. The heuristic for picking
    // out the local player vs other Players: WorldState exposes
    // `setLocalPlayerGuid(guid)` which JS index.html calls from the
    // kind=1 PLAYER_SPAWNED drain (`setLocalPlayerGuid(spawnedPlayerGuid)`
    // already global). On Character spawn the host should set this BEFORE
    // forwarding the kind=10 ObjectCreate; pre-PR-4 the local-player
    // typed dispatch went through the manager's `Player` subclass — PR 4
    // adds a Character override which is a strict superset.
    this._localPlayerGuid = 0;
    /** @type {Character|null} The local player's typed Character. */
    this.character = null;

    this._disposed = false;
  }

  /**
   * Tell the WorldState which GUID is the local player. Call this from
   * the kind=1 PLAYER_SPAWNED drain BEFORE the kind=10 ObjectCreate so
   * the typed dispatch in `dispatchItemCreateObject` can construct the
   * Character instance with the correct id. If the GUID already exists
   * in the cache as a generic WorldObject/Player (e.g. the
   * ObjectCreate raced PLAYER_SPAWNED), `setLocalPlayerGuid` retro-
   * upgrades the entry to a Character.
   *
   * @param {number} guid
   */
  setLocalPlayerGuid(guid) {
    const g = (guid | 0) >>> 0;
    this._localPlayerGuid = g;
    const existing = this.weenies.get(g);
    if (existing && !(existing instanceof Character)) {
      // Retro-upgrade: build a Character and copy over the property
      // store. PR 4's typical flow is set-guid-then-create; the
      // retro-upgrade path covers the race for safety.
      const ch = new Character(g, existing.classId, existing.taxonomy, existing.enums, existing.manager);
      ch.objDescFlags = existing.objDescFlags;
      ch.weenieFlags = existing.weenieFlags;
      ch.canonicalObjectClass = existing.canonicalObjectClass;
      ch.classificationSource = existing.classificationSource;
      ch.objectDescription = existing.objectDescription;
      ch.physicsDesc = existing.physicsDesc;
      ch.weenieDescription = existing.weenieDescription;
      // Copy property dicts.
      for (const [k, v] of existing.intValues)      ch.intValues.set(k, v);
      for (const [k, v] of existing.int64Values)    ch.int64Values.set(k, v);
      for (const [k, v] of existing.stringValues)   ch.stringValues.set(k, v);
      for (const [k, v] of existing.boolValues)     ch.boolValues.set(k, v);
      for (const [k, v] of existing.floatValues)    ch.floatValues.set(k, v);
      for (const [k, v] of existing.instanceValues) ch.instanceValues.set(k, v);
      for (const [k, v] of existing.dataValues)     ch.dataValues.set(k, v);
      for (const [k, v] of existing.positionValues) ch.positionValues.set(k, v);
      this.weenies.set(g, ch);
      this.character = ch;
    } else if (existing instanceof Character) {
      this.character = existing;
    }
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
    const isLocalPlayer = this._localPlayerGuid !== 0 && guid === this._localPlayerGuid;

    if (!wo) {
      if (isLocalPlayer) {
        // PR 4: typed Character for the local player. Bypasses the
        // manager's typed-subclass dispatch — Character has its own
        // S2C handler bodies + vitae / enchantment / cooldown state
        // that the generic Player subclass can't carry.
        wo = new Character(
          guid,
          payload?.classId ?? payload?.wcid ?? 0,
          this.manager?.taxonomy ?? null,
          this.manager?.enums ?? null,
          this.manager ?? null,
        );
        if (payload?.objDescFlags !== undefined) wo.objDescFlags = payload.objDescFlags;
        if (payload?.weenieFlags !== undefined)  wo.weenieFlags = payload.weenieFlags;
        if (payload?.canonicalObjectClass)        wo.canonicalObjectClass = payload.canonicalObjectClass;
        if (payload?.classificationSource)        wo.classificationSource = payload.classificationSource;
        this.character = wo;
      } else if (this.manager?.loaded) {
        // Defer construction to the manager when available — it owns the
        // typed-subclass dispatch via `canonicalClassify`. Otherwise build
        // a sentinel.
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
      // PR-3: inject `_world` back-reference so Container/Item read-through
      // getters resolve via this WorldState (mirror of C# `ACPlugin.Instance.Game.World`).
      if (typeof wo.setWorld === 'function') wo.setWorld(this);
    } else if (isLocalPlayer && !(wo instanceof Character)) {
      // Retro-upgrade: a non-Character spawn landed before
      // `setLocalPlayerGuid`. Convert the existing entry now.
      this.setLocalPlayerGuid(guid);
      wo = this.weenies.get(guid);
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

    // 2026-05-27 — replay a ContainerOpened that arrived before this
    // weenie did. See `_pendingContainerOpenForContainer` for the
    // rationale; without this, the open is dropped on the floor.
    this._replayPendingContainerOpen(guid);

    return wo;
  }

  /** Replay a deferred ContainerOpened once the container weenie lands. */
  _replayPendingContainerOpen(guid) {
    const cid = guid >>> 0;
    const items = this._pendingContainerOpenForContainer.get(cid);
    if (items === undefined) return;
    this._pendingContainerOpenForContainer.delete(cid);
    this.dispatchContainerOpened(cid, items);
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
      // Container weenie hasn't arrived yet — queue the event for replay
      // when the ObjectCreate for `cid` lands. See
      // `_pendingContainerOpenForContainer` for the rationale; this
      // mirrors the items-not-yet-arrived gate one layer up.
      this._pendingContainerOpenForContainer.set(cid, items);
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
      const gate = {
        container,
        pending,
        startedAt: Date.now(),
        timeoutId: null,
      };
      // Watchdog: if children never arrive (lost packet, ACE race),
      // fire the gate after 5s anyway so the UI doesn't hang open.
      // HUD rec #57 — log a warning when this fires so lossy-network
      // conditions surface in the console instead of silently degrading.
      gate.timeoutId = setTimeout(() => {
        if (this._disposed) return;
        const stillThere = this._pendingContainerOpens.get(cid);
        if (stillThere === gate) {
          const remaining = gate.pending.size;
          console.warn(
            `[world-state] container 0x${cid.toString(16)} open-gate timed out ` +
            `after 5s with ${remaining} child(ren) still missing — firing degraded ` +
            `containerOpened with items received so far`,
          );
          this._pendingContainerOpens.delete(cid);
          this._fireContainerOpened(gate.container);
        }
      }, 5000);
      this._pendingContainerOpens.set(cid, gate);
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
          if (gate.timeoutId != null) clearTimeout(gate.timeoutId);
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
    // Always cancel any queued container-not-arrived open for this guid —
    // even when the weenie never landed. Otherwise a late ObjectCreate
    // would replay an open that the server already retracted.
    this._pendingContainerOpenForContainer.delete(cid);
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
   * `EnchantmentTypeFlags.Cooldown` bit (0x1000000) is the discriminator.
   * **Wave F.2 (2026-05-27) fix:** PR-2 ORIGINALLY assumed the wasm side
   * filtered cooldowns out — that was never actually true, the wasm
   * snapshot just dropped the discriminator field. Wave F.2 extended
   * `PlayerEnchantmentJs` to surface the full `StatMod` tuple, so this
   * dispatcher now passes `type`/`statKey`/`statValue` through to
   * `Character.applyEnchantment`, which routes cooldowns into
   * `sharedCooldowns` and ordinary enchantments into `allEnchantments`.
   *
   * Per handoff §3 seventh quote (`Character.cs:232-239`) — when more
   * than one enchantment occupies the same `(spell_category, layer)`,
   * the tiebreak is `Power desc → Level8AuraSelfSpells →
   * SetSpells ? SpellId : StartTime → .First()`. The diff layer doesn't
   * resolve the tiebreak (we emit all add/remove deltas verbatim);
   * Character's `getActiveEnchantments()` runs the tiebreak on demand.
   *
   * @param {Array<object>} snapshot raw wasm `playerEnchantments()` array
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
        // Wave F.2 (2026-05-27) — surface `power` too so PR-4's
        // Character.applyEnchantment + tiebreak read the same field
        // name without falling back. (Old code stored only powerLevel;
        // the typed Character reads `power` per Enchantment.cs:46.)
        power:        (e.power_level    ?? e.powerLevel    ?? e.power ?? 0) | 0,
        startTime:    (e.start_time     ?? e.startTime     ?? 0),
        duration:     (e.duration       ?? 0),
        casterGuid:   (e.caster_guid    ?? e.casterGuid    ?? 0) >>> 0,
        spellCategory:(e.spell_category ?? e.spellCategory ?? 0) >>> 0,
        // Wave F.2 — full StatMod tuple + spell-set + degrade fields
        // surfaced now that wasm `PlayerEnchantmentJs` carries them
        // (apps/holtburger-web/src/lib.rs:14759 — extended in F.2).
        // Without these the JS-side cooldown discriminator
        // (`Character.cs:619`, `type & 0x1000000`) saw 0 and routed
        // cooldowns as ordinary enchantments. Per handoff §3 row 5 +
        // §4 PR-4 "New gotchas surfaced", this is the load-bearing
        // fix unblocking real wire data routing.
        type:         (e.stat_mod_type  ?? e.statModType   ?? e.type      ?? 0) | 0,
        statKey:      (e.stat_mod_key   ?? e.statModKey    ?? e.statKey   ?? 0) | 0,
        statValue:    Number(e.stat_mod_value ?? e.statModValue ?? e.statValue ?? 0),
        hasSpellSetId:(e.has_spell_set_id ?? e.hasSpellSetId ?? 0) | 0,
        spellSetId:   (e.spell_set_id    ?? e.spellSetId    ?? 0) | 0,
        degradeModifier:   Number(e.degrade_modifier   ?? e.degradeModifier   ?? 0),
        degradeLimit:      Number(e.degrade_limit      ?? e.degradeLimit      ?? 0),
        lastTimeDegraded:  Number(e.last_time_degraded ?? e.lastTimeDegraded ?? 0),
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

    // PR 4: forward the same snapshot into the typed Character so its
    // `AllEnchantments` map and `getActiveEnchantments` tiebreak reflect
    // the latest server state. The wire-side snapshot doesn't carry
    // `statMod` (type/key/value) — Wave E will extend the wasm payload;
    // until then, the Character's allEnchantments folds the available
    // fields and the cooldown discriminator branch is unreachable from
    // the snapshot path (still works for synthetic wire payloads that
    // do carry `type`).
    if (this.character) {
      // Drop entries the snapshot no longer contains (mirrors C#
      // `Character.cs:573-580` RemoveMultiple behavior at the diff
      // boundary). Then apply each present entry via applyEnchantment;
      // the Character's own dedup (`allEnchantments.set` on existing key)
      // mirrors `Character.cs:631-633`.
      const presentKeys = new Set();
      for (const e of next.values()) {
        const k = ((e.spellId >>> 0) << 16) | (e.layer & 0xFFFF);
        presentKeys.add(k >>> 0);
      }
      for (const k of [...this.character.allEnchantments.keys()]) {
        if (!presentKeys.has(k >>> 0)) {
          this.character.removeEnchantment(k);
        }
      }
      for (const e of next.values()) {
        this.character.applyEnchantment(e);
      }
    }
  }

  // ─── PR 4: Character.cs forwarding methods ────────────────────────
  //
  // Each of these forwards an S2C wire event to the typed Character
  // instance when it exists. WorldState owns the World-side dispatch
  // (PR 2); Character owns the local-player-only dispatch (PR 4). Per
  // handoff §3 row 6: don't merge with World public dispatchers.

  /** `Character.cs:380-449` — login player description fold. */
  dispatchLoginPlayerDescription(payload) {
    if (!this.character) {
      this.log.warn?.('[world-state] dispatchLoginPlayerDescription: no Character; setLocalPlayerGuid first');
      return;
    }
    this.character.applyLoginPlayerDescription(payload);
  }

  /** `Character.cs:455-459` — local player death broadcast. */
  dispatchCombatHandlePlayerDeath(message, victimId, killerId) {
    if (this.character) this.character.applyCombatHandlePlayerDeath(message, victimId, killerId);
  }

  /** `Character.cs:461-466` — `Item_SetState` for the local player. */
  dispatchCharacterItemSetState(objectId, newState) {
    if (this.character) this.character.applyItemSetState(objectId, newState);
  }

  /** `Character.cs:468-471` — `Effects_PlayerTeleport` (S2C). */
  dispatchEffectsPlayerTeleport() {
    if (this.character) this.character.applyEffectsPlayerTeleport();
  }

  /**
   * PrivateUpdate / PrivateRemove dispatch for the 14 quality types
   * (`Character.cs:473-562`). `kind` is one of:
   *   'int' / 'int64' / 'float' / 'bool' / 'string' /
   *   'instance' / 'data' / 'position'
   * `op` is `'update'` or `'remove'`.
   */
  dispatchCharacterPrivateQuality(kind, op, key, value) {
    if (!this.character) return;
    const fn = `private${op[0].toUpperCase() + op.slice(1)}${kind[0].toUpperCase() + kind.slice(1)}`;
    if (typeof this.character[fn] === 'function') {
      if (op === 'remove') this.character[fn](key);
      else this.character[fn](key, value);
    }
  }

  /** `Character.cs:481-491` — private skill / skill-level / skill-AC updates. */
  dispatchCharacterUpdateSkill(skillType, value) {
    if (this.character) this.character.updateSkill(skillType, value);
  }
  dispatchCharacterUpdateSkillTraining(skillType, value) {
    if (this.character) this.character.updateSkillTraining(skillType, value);
  }
  dispatchCharacterUpdateSkillPointsRaised(skillType, value) {
    if (this.character) this.character.updateSkillPointsRaised(skillType, value);
  }

  /** `Character.cs:493-498` — private attribute / level updates. */
  dispatchCharacterUpdateAttribute(attributeType, value) {
    if (this.character) this.character.updateAttribute(attributeType, value);
  }
  dispatchCharacterUpdateAttributePointsRaised(attributeType, raised) {
    if (this.character) this.character.updateAttributePointsRaised(attributeType, raised);
  }

  /** `Character.cs:500-506` — private vital second-att / level updates. */
  dispatchCharacterUpdateVital(vitalKey, value, isInitial = false) {
    if (this.character) this.character.updateVital(vitalKey, value, isInitial);
  }
  dispatchCharacterUpdateVitalCurrent(vitalKey, value) {
    if (this.character) this.character.updateVitalCurrent(vitalKey, value);
  }

  /** `Character.cs:613-639` — direct ApplyEnchantment (for wire payloads carrying StatMod). */
  dispatchCharacterApplyEnchantment(enchantment) {
    if (this.character) this.character.applyEnchantment(enchantment);
  }

  /** `Character.cs:580-582` / `:608-610` — single dispel / remove. */
  dispatchCharacterRemoveEnchantment(layeredOrId) {
    if (this.character) this.character.removeEnchantment(layeredOrId);
  }

  /** `Character.cs:564-572` / `:574-578` / `:602-606` — bulk variants. */
  dispatchCharacterUpdateMultipleEnchantments(list) {
    if (this.character) this.character.applyMagicUpdateMultipleEnchantments(list);
  }
  dispatchCharacterRemoveMultipleEnchantments(list) {
    if (this.character) this.character.applyMagicRemoveMultipleEnchantments(list);
  }

  /** `Character.cs:584-591` / `:593-600` — purge variants. */
  dispatchCharacterPurgeEnchantments(badOnly = false) {
    if (!this.character) return;
    if (badOnly) this.character.applyMagicPurgeBadEnchantments();
    else         this.character.applyMagicPurgeEnchantments();
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
    for (const gate of this._pendingContainerOpens.values()) {
      if (gate.timeoutId != null) clearTimeout(gate.timeoutId);
    }
    this._pendingContainerOpens.clear();
    this._pendingContainerOpenForContainer.clear();
    this._enchantmentSnapshot.clear();
    this._lastAppraisalAt.clear();
    // PR 4: drop the typed Character handle. The local-player GUID
    // stays — a relog with the same character can reuse the heuristic.
    this.character = null;
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
