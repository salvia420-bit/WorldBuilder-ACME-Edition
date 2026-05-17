export function createClient(sessionHandle) {
  const bus = new EventTarget();

  // Events fed externally by drainEvents loop in index.html — do not poll from here.
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
      // Phase J.1 — wire `GameAction::RemoveSpellFromBook` (0x01A8).
      sessionHandle.removeSpellFromBook(spellId);
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
