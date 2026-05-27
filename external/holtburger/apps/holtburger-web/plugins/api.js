// =============================================================================
// CHORIZITE EVENT-TAXONOMY COVERAGE (audit 2026-05-19, Task 2A — HEAD 9c35cf0)
// =============================================================================
// Source: external/chorizite/ACPlugin/API/*EventArgs.cs (11 *EventArgs classes)
//         + Game.cs / World.cs / WorldObjects/Character.cs / PatchProgress.cs
//         event registrations (18 total event surfaces — some use EventArgs.Empty).
// Target: this file's `client.events` bus + ClientEvent kinds drained by
//         index.html::drainEvents (apps/holtburger-web/src/lib.rs ClientEvent).
//
// Status:
//   IMPLEMENTED — bus-emitted with equivalent payload (notes if fields differ)
//   PARTIAL     — fires but missing semantic fields (e.g. no old-value, JSON-only)
//   MISSING     — not wired on bus or in poll_events()
//   N/A         — not applicable to the browser session model
//
// | # | Chorizite (Source)                  | EventArgs Payload                              | api.js / kind=N           | Status      | Note                                                                 |
// |---|-------------------------------------|------------------------------------------------|---------------------------|-------------|----------------------------------------------------------------------|
// | 1 | World.OnWeenieCreated               | WorldObject Object                             | EntityUpdate kind=1 SPAWN | PARTIAL     | spawn/position channel only; no bus event "objectCreated" (TODO)     |
// | 2 | World.OnWeenieReleased              | WorldObject Object                             | EntityUpdate kind=2 REMOVE| PARTIAL     | no bus event "objectReleased" (TODO)                                 |
// | 3 | World.OnContainerOpened             | Container Container                            | kind=12 vendorOpened + kind=21 containerOpened | IMPLEMENTED | PR-HH 2026-05-23: ViewContents (opcode 0x0196) routed to kind=21 for chests/corpses; vendor stays on kind=12 |
// | 4 | World.OnContainerClosed             | Container Container                            | —                         | MISSING     | StopViewingObjectContents not surfaced as ClientEvent (TODO)         |
// | 5 | World.OnSelectionChanged            | WorldObject? Object                            | "selectionChanged" bus    | IMPLEMENTED | Q1b (2026-05-26): scene3d/picking.js emits {guid, prevGuid} on every change |
// | 6 | Game.OnStateChanged                 | ClientState NewState, OldState                 | kinds {1,4,5,6,7} partial | PARTIAL     | no single "stateChanged" with old→new; spread across kinds (TODO)    |
// | 7 | Game.OnCharactersChanged            | EventArgs.Empty (re-fire roster)               | kind=0 CharacterListRecv  | IMPLEMENTED | renderCharacterList drains kind=0 each fire                          |
// | 8 | Game.OnWorldInfo                    | EventArgs.Empty (ServerName/Max/Cur)           | —                         | MISSING     | Login_WorldInfo parsed but not surfaced as ClientEvent (TODO)        |
// | 9 | Character.OnVitaeChanged            | float Vitae, OldVitae                          | kind=8 "playerStatsUpdated"| PARTIAL    | coalesced; no vitae-specific channel + no oldVitae delta (TODO)      |
// |10 | Character.OnVitalChanged            | VitalId Type, int Value, int OldValue          | kind=8 "playerStatsUpdated"| PARTIAL    | coalesced into one stats-bump; per-vital deltas dropped (TODO)       |
// |11 | Character.OnEnchantmentChanged      | AddRemove Type, LayeredSpellId, Enchantment    | —                         | MISSING     | no enchantment surface; buffs-debuffs HUD blocked (TODO)             |
// |12 | Character.OnSharedCooldownChanged   | AddRemove Type, SharedCooldown                 | —                         | MISSING     | shared-cooldown bus not wired (TODO)                                 |
// |13 | Character.OnPortalSpaceEntered      | EventArgs.Empty                                | —                         | MISSING     | portal-space (loading screen) entered/exited not exposed (TODO)      |
// |14 | Character.OnPortalSpaceExited       | EventArgs.Empty                                | kind=7 ENTERED_WORLD (~)  | PARTIAL     | EnteredWorld covers the post-portal arrival; entry edge missing (TODO)|
// |15 | Character.OnDeath                   | string Text, uint KillerId                     | kind=29 "death"           | IMPLEMENTED | Q1a (2026-05-26): emits {victimGuid, killerGuid, message} on PlayerKilled; combat-hud overlays self-deaths |
// |16 | PatchProgress.OnProgressChanged     | EventArgs.Empty (aggregated)                   | —                         | N/A         | retail-client patch flow; browser ships pre-built DATs               |
// |17 | PatchProgress.OnConnectProgress     | EventArgs.Empty                                | —                         | N/A         | retail-client connect handshake; browser uses WebSocket/UDP-relay    |
// |18 | PatchProgress.OnPatchProgress       | EventArgs.Empty                                | —                         | N/A         | retail-client DAT patcher; browser bake pipeline owns content        |
//
// ---- ClientEvent kinds with no Chorizite analogue (browser-specific) ----
// kind=2  ChatReceived           — bus-relayed via chat appender (DOM only, no events.on hook); maps to ACE wire ChatMessage variants
// kind=11 InventoryUpdated       — coalesced inventory-refresh signal; Chorizite uses per-item Item_* events instead
// kind=13 UseFailed              — WeenieError; would be Character.OnUseFailed (not in current Chorizite surface)
// kind=14 UseDone                — server-ack success; ditto
// kind=15 DoorStateChanged       — door swing for 3D scene; would be a Door.OnStateChanged (typed-class event not in Chorizite)
// kind=16 SoundTriggered         — ambient/triggered audio; Chorizite has no audio event surface
// kind=17 EntityVisibilityChanged— PhysicsState draw-gate; would be WorldObject.OnVisibilityChanged
// kind=18 EntityAirborneChanged  — jump arc visual; would be Character.OnAirborneChanged (not in Chorizite)
// kind=19 CombatEvent            — emits "damageDealt"/"damageTaken"/"evadedTarget"/"evadedAttacker"/"attackDone" on bus; ACE-side semantic event family
// kind=29 Death                  — emits "death" {victimGuid, killerGuid, message}; combat-hud subscribes for self-death overlay
//
// ---- Bus-emitted events (canonical list — subscribe via client.events.on) ----
//   "playerStatsUpdated"   (kind=8)         — vitals/skills/attrs refreshed
//   "landblockChanged"     (zone-cross)     — {prevLb, lbId} from local player move
//   "vendorOpened"         (kind=12)        — {stringPayload, u32Payload, u32Payload2}
//   "damageDealt"          (kind=19 JSON)   — {defenderName, damage, damageType, ...}
//   "damageTaken"          (kind=19 JSON)   — {attackerName, damage, damageType, ...}
//   "evadedTarget"         (kind=19 JSON)   — {defenderName} (you missed)
//   "evadedAttacker"       (kind=19 JSON)   — {attackerName} (they missed)
//   "attackDone"           (kind=19 JSON)   — {error}        ("None" on success)
//   "death"                (kind=29)        — {victimGuid, killerGuid, message} (Q1a)
//   "selectionChanged"     (client-only)    — {guid, prevGuid} emitted from scene3d/picking.js on every target change (Q1b)
//
// Counts: 3 IMPLEMENTED, 6 PARTIAL, 6 MISSING, 3 N/A — total 18 Chorizite events.
// Backlog gap-fill order (highest plugin-leverage first): #11 Enchantment,
// #4 ContainerClosed, #6 StateChanged (unified), #8 WorldInfo,
// then #12 SharedCooldown / #13 PortalSpaceEntered. See CHORIZITE_PORTING_PLAN.md §3.4.
// =============================================================================

// =============================================================================
// Chorizite/ACPlugin enum + EventArgs factory ports (ACPlugin PR-1, 2026-05-27)
// =============================================================================
// Direct 1:1 ports of:
//   - external/chorizite/ACPlugin/API/ClientState.cs           (8-state enum)
//   - external/chorizite/ACPlugin/API/AddRemoveEventType.cs    (2-member enum)
//   - external/chorizite/ACPlugin/API/*EventArgs.cs            (11 DTOs)
//
// Per ACPlugin §9 first-PR sketch — the 11 EventArgs shapes are exposed
// as plain JS object factories. Their field names match the upstream C#
// property casing (camelCase preferred per JS convention, but each
// factory documents the C# property it maps to).
//
// "Eatable" event semantics: WorldObjectSelected derives from C#'s
// EatableEventArgs (per Chorizite.Common/EatableEventArgs.cs). We port
// the .eaten convention — when a handler sets `event.eaten = true`, the
// dispatcher MUST skip remaining handlers and report eaten=true to the
// upstream system event (mirrors the retail behavior the combat bar
// uses to swallow LMB clicks before the pick-target handler sees them).
// See handoff §5.5 item 6. Not all events make sense as eatable — only
// input-derived events (selectionChanged is the canonical example).

/**
 * Client lifecycle state. Direct port of `ClientState.cs:5-45`.
 * Numeric values match the upstream C# enum exactly.
 */
export const ClientState = Object.freeze({
  Initial: 0,            // ClientState.cs:9
  GameStarted: 1,        // ClientState.cs:14 — "Client is done initializing"
  CharacterSelect: 2,    // ClientState.cs:19
  CreatingCharacter: 3,  // ClientState.cs:24
  EnteringGame: 4,       // ClientState.cs:29
  InGame: 5,             // ClientState.cs:34 — "Fully logged in to the game"
  LoggingOut: 6,         // ClientState.cs:39
  Disconnected: 7,       // ClientState.cs:44
});

/**
 * Add-or-remove discriminator for enchantment/cooldown events. Direct
 * port of `AddRemoveEventType.cs:2-5`.
 */
export const AddRemoveEventType = Object.freeze({
  Added: 0,    // AddRemoveEventType.cs:3
  Removed: 1,  // AddRemoveEventType.cs:4
});

/**
 * Base shape for "eatable" events (mirror of Chorizite.Common/
 * EatableEventArgs.cs). Handlers can set `.eaten = true` to swallow
 * the event and prevent downstream propagation. See handoff §3 last
 * quote and §5.5 item 6.
 *
 * Per the Chorizite convention, only INPUT-derived events should be
 * eatable (mouse/key/selection). Skill/vital/death events are
 * broadcast-only and should not derive from this shape.
 */
function makeEatable(payload) {
  return {
    ...payload,
    eaten: false,
    /** Convenience method — equivalent to `event.eaten = true`. */
    eat() { this.eaten = true; },
  };
}

// ─── 11 EventArgs factories (per ACPlugin/API/*EventArgs.cs) ───

/**
 * Port of `ObjectCreatedEventArgs.cs:7-19`.
 * Fired by `World.OnWeenieCreated` (`World.cs:41-44`) when a new
 * WorldObject enters the cache. Payload is the typed-class instance.
 * @param {object} wobject WorldObject (or subclass) instance
 */
export function makeObjectCreated(wobject) {
  return { object: wobject };
}

/**
 * Port of `ObjectReleasedEventArgs.cs:7-19`.
 * Fired by `World.OnWeenieReleased` (`World.cs:50-53`) when a
 * WorldObject leaves the cache. Payload is the typed-class instance
 * that was just removed.
 * @param {object} wobject WorldObject (or subclass) instance
 */
export function makeObjectReleased(wobject) {
  return { object: wobject };
}

/**
 * Port of `ContainerOpenedEventArgs.cs:7-19`.
 * Fired by `World.OnContainerOpened` (`World.cs:59-62`) AFTER all
 * listed children's `Item_CreateObject` have arrived (per
 * `World.cs:212-249` container-open watcher — load-bearing per
 * handoff §3 first quote).
 * @param {object} container Container instance
 */
export function makeContainerOpened(container) {
  return { container };
}

/**
 * Port of `ContainerClosedEventArgs.cs:7-19`.
 * Fired by `World.OnContainerClosed` (`World.cs:68-71`).
 * @param {object} container Container instance
 */
export function makeContainerClosed(container) {
  return { container };
}

/**
 * Port of `WorldObjectSelectedEventArgs.cs:7-15`.
 * Fired by `World.OnSelectionChanged` (`World.cs:77-80`). Derives
 * from EatableEventArgs — handlers can set `.eaten = true` to
 * prevent the next handler from seeing the change (used by the
 * combat bar to swallow LMB before the pick-target handler).
 *
 * @param {object|null} wobject Selected WorldObject, or null on deselect
 */
export function makeWorldObjectSelected(wobject) {
  return makeEatable({ object: wobject });
}

/**
 * Port of `GameStateChangedEventArgs.cs:11-31`.
 * Fired by `Game.OnStateChanged` (per `Game.cs` state machine at
 * lines 117-123 in ACPlugin).
 * @param {number} newState ClientState
 * @param {number} oldState ClientState
 */
export function makeGameStateChanged(newState, oldState) {
  return { newState, oldState };
}

/**
 * Port of `VitaeChangedEventArgs.cs:4-21`.
 * Fired by `Character.OnVitaeChanged` (`Character.cs:116-120`).
 * Vitae is `1.0 = no vitae, 0.95 = 5% vitae` — counter-intuitive.
 * Don't invert. Per handoff §3 fourth quote.
 *
 * @param {number} vitae current vitae multiplier (1.0..0.5 ish)
 * @param {number} oldVitae previous vitae multiplier
 */
export function makeVitaeChanged(vitae, oldVitae) {
  return { vitae, oldVitae };
}

/**
 * Port of `VitalChangedEventArgs.cs:13-35`.
 * Fired by `Character.OnVitalChanged` (`Character.cs:125-129`).
 * @param {number} type    VitalId (Health=1, Stamina=3, Mana=5 per ACE)
 * @param {number} value   new current value
 * @param {number} oldValue previous current value
 */
export function makeVitalChanged(type, value, oldValue) {
  return { type, value, oldValue };
}

/**
 * Port of `EnchantmentsChangedEventArgs.cs:9-36`.
 * Fired by `Character.OnEnchantmentChanged` (`Character.cs:134-138`).
 * `spellId` is derived from `layeredSpellId.id` (per C# property at
 * EnchantmentsChangedEventArgs.cs:24).
 *
 * @param {number} type            AddRemoveEventType
 * @param {object} enchantment     Enchantment record (LayeredId/SpellId/Layer/Power/StartTime/Duration/CasterId/Type/StatKey/StatValue)
 */
export function makeEnchantmentsChanged(type, enchantment) {
  return {
    type,
    layeredSpellId: enchantment.layeredId ?? enchantment.LayeredId ?? null,
    spellId: enchantment.spellId ?? enchantment.SpellId ?? enchantment.layeredId?.id ?? 0,
    enchantment,
  };
}

/**
 * Port of `SharedCooldownsChangedEventArgs.cs:11-26`.
 * Fired by `Character.OnSharedCooldownChanged` (`Character.cs:143-147`).
 * @param {number} type        AddRemoveEventType
 * @param {object} cooldown    SharedCooldown record
 */
export function makeSharedCooldownsChanged(type, cooldown) {
  return { type, cooldown };
}

/**
 * Port of `DeathEventArgs.cs:5-19`.
 * Fired by `Character.OnDeath` (`Character.cs:171-175`).
 * @param {string} text     server-formatted death message
 * @param {number} killerId GUID of killer (0 if environment/falling)
 */
export function makeDeath(text, killerId) {
  return { text, killerId };
}

// ─── Aggregate export so tests / consumers can iterate ───
/**
 * Map of factory-name → factory function. Used by tests and
 * future PR-2 (S2C dispatch) to verify all 11 shapes have factories.
 */
export const eventArgsFactories = Object.freeze({
  objectCreated: makeObjectCreated,
  objectReleased: makeObjectReleased,
  containerOpened: makeContainerOpened,
  containerClosed: makeContainerClosed,
  worldObjectSelected: makeWorldObjectSelected,
  gameStateChanged: makeGameStateChanged,
  vitaeChanged: makeVitaeChanged,
  vitalChanged: makeVitalChanged,
  enchantmentsChanged: makeEnchantmentsChanged,
  sharedCooldownsChanged: makeSharedCooldownsChanged,
  death: makeDeath,
});

// =============================================================================

export function createClient(sessionHandle) {
  const bus = new EventTarget();

  // Events fed externally by drainEvents loop in index.html — do not poll from here.
  // Coverage table above documents which Chorizite EventArgs each bus name maps to.
  const events = {
    on(name, handler) {
      bus.addEventListener(name, handler);
    },
    off(name, handler) {
      bus.removeEventListener(name, handler);
    },
    once(name, handler) {
      bus.addEventListener(name, handler, { once: true });
    },
    emit(name, payload) {
      bus.dispatchEvent(new CustomEvent(name, { detail: payload }));
    },
  };
  // TODO(coverage-table row 1):  add "objectCreated"  bus event (World.OnWeenieCreated)
  // TODO(coverage-table row 2):  add "objectReleased" bus event (World.OnWeenieReleased)
  // row 3: DONE (PR-HH 2026-05-23) — kind=21 containerOpened fires for
  // non-vendor containers (chest/corpse/salvage bag); vendor still on kind=12.
  // TODO(coverage-table row 4):  add "containerClosed" (StopViewingObjectContents → new ClientEvent kind)
  // row 5: DONE (Q1b 2026-05-26) — scene3d/picking.js emits "selectionChanged" {guid, prevGuid} on every change.
  // TODO(coverage-table row 6):  add unified "stateChanged" {oldState,newState} bus event
  // TODO(coverage-table row 8):  add "worldInfo" bus event (ServerName/MaxConnections/CurrentConnections)
  // TODO(coverage-table row 9):  split kind=8 into per-vital "vitaeChanged" with old/new
  // TODO(coverage-table row 10): split kind=8 into per-vital "vitalChanged" {type,value,oldValue}
  // TODO(coverage-table row 11): add "enchantmentChanged" {type,layeredSpellId,enchantment} bus event
  // TODO(coverage-table row 12): add "sharedCooldownChanged" {type,cooldown} bus event
  // TODO(coverage-table row 13): add "portalSpaceEntered" bus event
  // TODO(coverage-table row 14): add "portalSpaceExited" bus event (kind=7 covers exit-equivalent only)
  // row 15: DONE (Q1a 2026-05-26) — kind=29 "death" {victimGuid,killerGuid,message}; combat-hud overlays self-deaths.

  const player = Object.freeze({
    jump(power) {
      sessionHandle.jump(power);
    },
    useObject(guid) {
      sessionHandle.useObject(guid);
    },
    toggleCombatMode() {
      sessionHandle.toggleCombatMode();
    },
    attack(targetGuid, attackHeight = 2, powerLevel = 1.0) {
      sessionHandle.attack(targetGuid, attackHeight, powerLevel);
    },
    missileAttack(targetGuid, attackHeight = 2, accuracyLevel = 1.0) {
      sessionHandle.missileAttack(targetGuid, attackHeight, accuracyLevel);
    },
    castSpell(spellId, targetGuid) {
      // null/undefined targetGuid → untargeted (self-buff / recall /
      // lifestone tie / portal-summon spells).
      if (targetGuid == null) {
        sessionHandle.castUntargetedSpell(spellId);
      } else {
        sessionHandle.castTargetedSpell(targetGuid, spellId);
      }
    },
    forgetSpell(spellId) {
      sessionHandle.removeSpellFromBook(spellId);
    },
    get pose() {
      return sessionHandle.getLocalPlayerPose();
    },
    get stats() {
      return sessionHandle.playerStats();
    },
    get inventory() {
      return sessionHandle.playerInventory();
    },
    knownSpells() {
      return sessionHandle.playerKnownSpells();
    },
  });

  const AttackHeight = Object.freeze({ HIGH: 1, MEDIUM: 2, LOW: 3 });
  const CombatMode = Object.freeze({
    UNDEF: 0,
    NON_COMBAT: 1,
    MELEE: 2,
    MISSILE: 4,
    MAGIC: 8,
  });

  const movement = Object.freeze({
    setInput(forward, strafe, turn, run) {
      sessionHandle.setMovementInput(forward, strafe, turn, run);
    },
    tick() {
      sessionHandle.tickMovement();
    },
  });

  const chat = Object.freeze({
    send(message) {
      sessionHandle.sendChat(message);
    },
    on(eventName, handler) {
      events.on(eventName, handler);
    },
  });

  const characters = Object.freeze({
    list() {
      return sessionHandle.characterList();
    },
    select(guid) {
      sessionHandle.selectCharacter(guid);
    },
    createTest(name) {
      sessionHandle.createTestCharacter(name);
    },
  });

  const world = Object.freeze({
    currentCell() {
      return sessionHandle.getCurrentCellId();
    },
    isIndoor() {
      return sessionHandle.isCurrentCellIndoor();
    },
    renderSet(depth = 1) {
      return sessionHandle.getRenderSet(depth);
    },
    terrainHeightAt(x, y) {
      return sessionHandle.terrainHeightAt(x, y);
    },
    doorPart(guid) {
      return sessionHandle.getBuildingPartForDoor(guid);
    },
  });

  const collision = Object.freeze({
    sweep(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
      return sessionHandle.cameraSweepCollision(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId);
    },
    sweepBuilding(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
      return sessionHandle.sweepSphereAgainstBuildingMesh(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId);
    },
    sweepCells(fromX, fromY, fromZ, toX, toY, toZ, radius, cellIds) {
      return sessionHandle.sweepSphereAgainstCellMesh(fromX, fromY, fromZ, toX, toY, toZ, radius, cellIds);
    },
    sweepStatics(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId) {
      return sessionHandle.sweepSphereAgainstStatics(fromX, fromY, fromZ, toX, toY, toZ, radius, landblockId);
    },
  });

  const sky = Object.freeze({
    state() {
      return sessionHandle.getSkyState();
    },
    objects() {
      return sessionHandle.getSkyObjectStates();
    },
    hasDesc() {
      return sessionHandle.hasSkyDesc();
    },
    setTimeOverride(t) {
      return sessionHandle.setSkyTimeOverride(t);
    },
    setDayOverride(d, y) {
      return sessionHandle.setGameDayOverride(d, y);
    },
  });

  const ui = Object.freeze({
    registerBarSlot(_manifest) {},
    openPanel(_pluginId) {},
    closePanel(_pluginId) {},
  });

  const client = {
    player,
    movement,
    chat,
    characters,
    world,
    collision,
    sky,
    ui,
    events: Object.freeze(events),
    AttackHeight,
    CombatMode,
    // ACPlugin PR-1: enums + EventArgs factories surfaced on client so
    // plugin authors don't need to import the module directly.
    ClientState,
    AddRemoveEventType,
    eventArgsFactories,
    get account() {
      return sessionHandle.accountName;
    },
    get canCreateCharacter() {
      return sessionHandle.canCreateCharacter;
    },
  };

  return Object.freeze(client);
}
