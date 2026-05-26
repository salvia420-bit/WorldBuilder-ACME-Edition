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
    get account() {
      return sessionHandle.accountName;
    },
    get canCreateCharacter() {
      return sessionHandle.canCreateCharacter;
    },
  };

  return Object.freeze(client);
}
