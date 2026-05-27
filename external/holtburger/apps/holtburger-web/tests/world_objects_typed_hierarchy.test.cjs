// ACPlugin PR-3 (2026-05-27) — unit tests for the typed-subclass hierarchy
// behavior added on top of PR 1's WorldObject base + PR 2's WorldState:
//
//   - Item.cs   (Item.{isStackable, isAttuned, isBonded, burden, itemWorkmanship,
//                      uiEffects, parentContainer, isOwnedByMe, spellId, spellIds,
//                      enchantmentIds, updateSpells})
//   - Container.cs (Container.{items, containers, containerType, ContainerProperties})
//   - Equippable.cs (Equippable.{wielder, setWielded})
//   - Creature.cs (Creature.{radarColor, radarBehavior, stance, combatMode, level,
//                            equipment, MotionStance, CombatMode})
//
// Run from apps/holtburger-web/:
//   node tests/world_objects_typed_hierarchy.test.cjs
// Exits 0 on full pass, 1 on any assertion failure.

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WO_URL   = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'world_object.js')).href;
const WS_URL   = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-state.js')).href;
const ITEM_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'item.js')).href;
const CONT_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'container.js')).href;
const EQ_URL   = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'equippable.js')).href;
const CREA_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'creature.js')).href;
const FOCI_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'foci.js')).href;
const STATIC_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'static.js')).href;
const DOOR_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'door.js')).href;
const PORTAL_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'portal.js')).href;
const LIFE_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'lifestone.js')).href;
const BIND_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'bindstone.js')).href;
const CORPSE_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'corpse.js')).href;
const CHAR_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'character.js')).href;
const NPC_URL  = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'npc.js')).href;
const MONST_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'monster.js')).href;
const PLAYER_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'player.js')).href;
const VEND_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'vendor.js')).href;
const ARMOR_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'armor.js')).href;
const MELEE_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'melee_weapon.js')).href;
const MISSILE_URL = pathToFileURL(path.join(__dirname, '..', 'plugins', 'world-objects', 'missile_weapon.js')).href;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

function silentLog() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

(async () => {
  const { WorldObject } = await import(WO_URL);
  const { WorldState } = await import(WS_URL);
  const { Item } = await import(ITEM_URL);
  const { Container, ContainerProperties } = await import(CONT_URL);
  const { Equippable } = await import(EQ_URL);
  const { Creature, MotionStance, CombatMode } = await import(CREA_URL);
  const { Foci } = await import(FOCI_URL);
  const { Static } = await import(STATIC_URL);
  const { Door } = await import(DOOR_URL);
  const { Portal } = await import(PORTAL_URL);
  const { Lifestone } = await import(LIFE_URL);
  const { Bindstone } = await import(BIND_URL);
  const { Corpse } = await import(CORPSE_URL);
  const { Character } = await import(CHAR_URL);
  const { NPC } = await import(NPC_URL);
  const { Monster } = await import(MONST_URL);
  const { Player } = await import(PLAYER_URL);
  const { Vendor } = await import(VEND_URL);
  const { Armor } = await import(ARMOR_URL);
  const { MeleeWeapon } = await import(MELEE_URL);
  const { MissileWeapon } = await import(MISSILE_URL);

  const makeItem = (id = 0xCAFE) => new Item(id, 0, null, null, null);
  const makeContainer = (id = 0xC000) => new Container(id, 0, null, null, null);
  const makeEq = (id = 0xE000) => new Equippable(id, 0, null, null, null);
  const makeCreature = (id = 0xCC00) => new Creature(id, 0, null, null, null);

  // ============================================================
  // [1] Hierarchy verification (handoff §3 — DON'T violate)
  // ============================================================
  console.log('\n[1] Hierarchy verification (handoff §3)');

  check('Item extends WorldObject', () => {
    assert.ok(makeItem() instanceof WorldObject);
  });
  check('Container extends Item (and WorldObject)', () => {
    const c = makeContainer();
    assert.ok(c instanceof Item);
    assert.ok(c instanceof WorldObject);
  });
  check('Creature extends Container (and Item, WorldObject)', () => {
    const c = makeCreature();
    assert.ok(c instanceof Container);
    assert.ok(c instanceof Item);
    assert.ok(c instanceof WorldObject);
  });
  check('Equippable extends Item (NOT Container)', () => {
    const e = makeEq();
    assert.ok(e instanceof Item);
    assert.ok(!(e instanceof Container));
  });
  check('Foci extends Container (HANDOFF §3 — surprising)', () => {
    const f = new Foci(0x1F, 0, null, null, null);
    assert.ok(f instanceof Container, 'Foci must extend Container, not Item');
    assert.ok(f instanceof Item);
  });
  check('Static extends WorldObject directly (NOT Item)', () => {
    const s = new Static(0x55, 0, null, null, null);
    assert.ok(s instanceof WorldObject);
    assert.ok(!(s instanceof Item), 'Static must NOT extend Item');
  });
  check('Door extends Static (NOT Item)', () => {
    const d = new Door(0x44, 0, null, null, null);
    assert.ok(d instanceof Static);
    assert.ok(!(d instanceof Item));
  });
  check('Portal extends Static (NOT Item)', () => {
    const p = new Portal(0x77, 0, null, null, null);
    assert.ok(p instanceof Static);
    assert.ok(!(p instanceof Item));
  });
  check('Lifestone extends Static (NOT Item)', () => {
    const l = new Lifestone(0x88, 0, null, null, null);
    assert.ok(l instanceof Static);
    assert.ok(!(l instanceof Item));
  });
  check('Bindstone extends Static (NOT Item)', () => {
    const b = new Bindstone(0x99, 0, null, null, null);
    assert.ok(b instanceof Static);
    assert.ok(!(b instanceof Item));
  });
  check('Corpse extends Static (NOT Item)', () => {
    const c = new Corpse(0xAA, 0, null, null, null);
    assert.ok(c instanceof Static);
    assert.ok(!(c instanceof Item));
  });
  check('Character extends Container', () => {
    const c = new Character(0xCC, 0, null, null, null);
    assert.ok(c instanceof Container);
    assert.ok(c instanceof Creature === false, 'Character is sibling of Creature, NOT child');
  });
  check('NPC/Monster/Player extend Creature', () => {
    assert.ok(new NPC(1, 0, null, null, null) instanceof Creature);
    assert.ok(new Monster(2, 0, null, null, null) instanceof Creature);
    assert.ok(new Player(3, 0, null, null, null) instanceof Creature);
  });
  check('Vendor extends NPC (and Creature)', () => {
    const v = new Vendor(4, 0, null, null, null);
    assert.ok(v instanceof NPC);
    assert.ok(v instanceof Creature);
  });
  check('Armor/MeleeWeapon/MissileWeapon extend Equippable', () => {
    assert.ok(new Armor(5, 0, null, null, null) instanceof Equippable);
    assert.ok(new MeleeWeapon(6, 0, null, null, null) instanceof Equippable);
    assert.ok(new MissileWeapon(7, 0, null, null, null) instanceof Equippable);
  });

  // ============================================================
  // [2] Item.cs port — typed getters
  // ============================================================
  console.log('\n[2] Item — typed getters (Item.cs:15-64)');

  check('isStackable: MaxStackSize unset (=default 1) → false', () => {
    const i = makeItem();
    assert.strictEqual(i.isStackable, false);
  });
  check('isStackable: MaxStackSize=1 → false (Item.cs:15)', () => {
    const i = makeItem();
    i.setIntValue(11 /* PROP_INT_MAX_STACK_SIZE */, 1);
    assert.strictEqual(i.isStackable, false);
  });
  check('isStackable: MaxStackSize=10 → true', () => {
    const i = makeItem();
    i.setIntValue(11, 10);
    assert.strictEqual(i.isStackable, true);
  });
  check('isAttuned: unset → false', () => {
    assert.strictEqual(makeItem().isAttuned, false);
  });
  check('isAttuned: Attuned=2 → true (Item.cs:20)', () => {
    const i = makeItem();
    i.setIntValue(114 /* Attuned */, 2);
    assert.strictEqual(i.isAttuned, true);
  });
  check('isBonded: Bonded=1 → true (Item.cs:25)', () => {
    const i = makeItem();
    i.setIntValue(33 /* Bonded */, 1);
    assert.strictEqual(i.isBonded, true);
  });
  check('burden: EncumbranceVal=500 (Item.cs:58)', () => {
    const i = makeItem();
    i.setIntValue(5, 500);
    assert.strictEqual(i.burden, 500);
  });
  check('burden: unset → 0', () => {
    assert.strictEqual(makeItem().burden, 0);
  });
  check('itemWorkmanship: ItemWorkmanship=8 (Item.cs:64)', () => {
    const i = makeItem();
    i.setIntValue(105, 8);
    assert.strictEqual(i.itemWorkmanship, 8);
  });
  check('uiEffects: IconOverlaySecondary=0x10 (Item.cs:52)', () => {
    const i = makeItem();
    i.setDataValue(51, 0x10);
    assert.strictEqual(i.uiEffects, 0x10);
  });

  // ============================================================
  // [3] Item.updateSpells — Layer 0x8000 split (Item.cs:72-87)
  // ============================================================
  console.log('\n[3] Item.updateSpells (Item.cs:72-87)');

  check('updateSpells: cast-on spell (Layer != 0x8000) → spellIds', () => {
    const i = makeItem();
    i.updateSpells([{ id: 1234, layer: 0x0001 }]);
    assert.deepStrictEqual(i.spellIds, [{ id: 1234, layer: 1 }]);
    assert.deepStrictEqual(i.enchantmentIds, []);
  });
  check('updateSpells: enchantment (Layer == 0x8000) → enchantmentIds', () => {
    const i = makeItem();
    i.updateSpells([{ id: 4444, layer: 0x8000 }]);
    assert.deepStrictEqual(i.enchantmentIds, [{ id: 4444, layer: 0x8000 }]);
    assert.deepStrictEqual(i.spellIds, []);
  });
  check('updateSpells: mixed list — splits correctly', () => {
    const i = makeItem();
    i.updateSpells([
      { id: 1, layer: 0x0001 },
      { id: 2, layer: 0x8000 },
      { id: 3, layer: 0x0002 },
      { id: 4, layer: 0x8000 },
    ]);
    assert.deepStrictEqual(i.spellIds, [{ id: 1, layer: 1 }, { id: 3, layer: 2 }]);
    assert.deepStrictEqual(i.enchantmentIds, [{ id: 2, layer: 0x8000 }, { id: 4, layer: 0x8000 }]);
  });
  check('updateSpells: idempotent — re-call clears previous', () => {
    const i = makeItem();
    i.updateSpells([{ id: 1, layer: 1 }, { id: 2, layer: 0x8000 }]);
    i.updateSpells([{ id: 99, layer: 1 }]);
    assert.deepStrictEqual(i.spellIds, [{ id: 99, layer: 1 }]);
    assert.deepStrictEqual(i.enchantmentIds, []);
  });
  check('updateSpells: null/undefined → no-op (Item.cs:73-74)', () => {
    const i = makeItem();
    i.spellIds.push({ id: 1, layer: 1 });
    i.updateSpells(null);
    i.updateSpells(undefined);
    assert.strictEqual(i.spellIds.length, 1);
  });
  check('updateSpells: tolerates PascalCase (Id/Layer)', () => {
    const i = makeItem();
    i.updateSpells([{ Id: 100, Layer: 0x8000 }]);
    assert.deepStrictEqual(i.enchantmentIds, [{ id: 100, layer: 0x8000 }]);
  });

  // ============================================================
  // [4] Item.parentContainer — read-through (Item.cs:46)
  // ============================================================
  console.log('\n[4] Item.parentContainer (Item.cs:46)');

  check('parentContainer: no container set → null', () => {
    const i = makeItem();
    assert.strictEqual(i.parentContainer, null);
  });
  check('parentContainer: container set but not in scope → null', () => {
    const i = makeItem();
    i.setInstanceValue(2 /* PROP_INSTANCE_CONTAINER */, 0xDEAD);
    assert.strictEqual(i.parentContainer, null);
  });
  check('parentContainer: resolved via injected _world (WorldState)', () => {
    const w = new WorldState({ logger: silentLog() });
    const container = makeContainer(0xC001);
    const item = makeItem(0x1001);
    w.weenies.set(0xC001, container);
    w.weenies.set(0x1001, item);
    if (typeof container.setWorld === 'function') container.setWorld(w);
    if (typeof item.setWorld === 'function') item.setWorld(w);
    item.setInstanceValue(2, 0xC001);
    assert.strictEqual(item.parentContainer, container);
  });
  check('parentContainer: parent is NOT a Container → null (Item.cs:46 "as Container")', () => {
    const w = new WorldState({ logger: silentLog() });
    const item = makeItem(0x2001);
    const door = new Door(0xDD01, 0, null, null, null);
    w.weenies.set(0xDD01, door);
    w.weenies.set(0x2001, item);
    if (typeof item.setWorld === 'function') item.setWorld(w);
    item.setInstanceValue(2, 0xDD01);
    assert.strictEqual(item.parentContainer, null, 'Door must not pass containment check');
  });

  // ============================================================
  // [5] Container — items / containers read-through getters
  // ============================================================
  console.log('\n[5] Container.items / Container.containers (Container.cs:16-26)');

  check('containerType defaults to None (Container.cs:26)', () => {
    const c = makeContainer();
    assert.strictEqual(c.containerType, ContainerProperties.None);
  });
  check('ContainerProperties enum: None=0, Container=1, Foci=2', () => {
    assert.strictEqual(ContainerProperties.None, 0);
    assert.strictEqual(ContainerProperties.Container, 1);
    assert.strictEqual(ContainerProperties.Foci, 2);
  });
  check('items: empty container → []', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeContainer(0xC100);
    w.weenies.set(0xC100, c);
    if (typeof c.setWorld === 'function') c.setWorld(w);
    assert.deepStrictEqual(c.items, []);
  });
  check('items: filters by PROP_INSTANCE_CONTAINER (Container.cs:16)', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeContainer(0xC100);
    const child1 = makeItem(0x1101);
    const child2 = makeItem(0x1102);
    const other = makeItem(0x9999);   // in some OTHER container
    [c, child1, child2, other].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    child1.setInstanceValue(2, 0xC100);
    child2.setInstanceValue(2, 0xC100);
    other.setInstanceValue(2, 0xBEEF);
    const items = c.items;
    assert.strictEqual(items.length, 2);
    assert.ok(items.includes(child1));
    assert.ok(items.includes(child2));
    assert.ok(!items.includes(other));
  });
  check('items: excludes sub-containers (Container.cs:16 "excluding containers")', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeContainer(0xC100);
    const item = makeItem(0x1101);
    const subContainer = makeContainer(0xC101);
    [c, item, subContainer].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    item.setInstanceValue(2, 0xC100);
    subContainer.setInstanceValue(2, 0xC100);
    assert.deepStrictEqual(c.items, [item]);
  });
  check('containers: filters child containers including foci (Container.cs:21)', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeContainer(0xC100);
    const subContainer = makeContainer(0xC101);
    const foci = new Foci(0xC102, 0, null, null, null);
    const item = makeItem(0x1101);  // non-container child — should not appear
    [c, subContainer, foci, item].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    subContainer.setInstanceValue(2, 0xC100);
    foci.setInstanceValue(2, 0xC100);
    item.setInstanceValue(2, 0xC100);
    const containers = c.containers;
    assert.strictEqual(containers.length, 2);
    assert.ok(containers.includes(subContainer));
    assert.ok(containers.includes(foci), 'Foci MUST appear in containers (handoff §3)');
    assert.ok(!containers.includes(item));
  });
  check('items+containers do NOT include self', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeContainer(0xC100);
    w.weenies.set(0xC100, c);
    if (typeof c.setWorld === 'function') c.setWorld(w);
    c.setInstanceValue(2, 0xC100);  // self-ref
    assert.deepStrictEqual(c.items, []);
    assert.deepStrictEqual(c.containers, []);
  });
  check('items: works without _world via manager.objects fallback', () => {
    // Simulated minimal manager interface — objects: Map
    const c = makeContainer(0xC100);
    const item = makeItem(0x1101);
    const manager = { objects: new Map([[0xC100, c], [0x1101, item]]) };
    c.manager = manager;
    item.manager = manager;
    item.setInstanceValue(2, 0xC100);
    assert.deepStrictEqual(c.items, [item]);
  });

  // ============================================================
  // [6] Equippable.setWielded — port of Character.cs:757-762
  // ============================================================
  console.log('\n[6] Equippable.setWielded (Character.cs:757-762)');

  check('setWielded sets Wielder + CurrentWieldedLocation', () => {
    const e = makeEq();
    e.setWielded(0x12345678, 0x1);
    assert.strictEqual(e.instanceValue(3 /* Wielder */, 0), 0x12345678);
    assert.strictEqual(e.intValue(19 /* CurrentWieldedLocation */, 0), 0x1);
  });
  check('setWielded slot=0 → unequipped state', () => {
    const e = makeEq();
    e.setWielded(0xABCDEF, 0);
    assert.strictEqual(e.isEquipped, false);
  });
  check('setWielded slot != 0 → isEquipped=true', () => {
    const e = makeEq();
    e.setWielded(0xABCDEF, 0x4);
    assert.strictEqual(e.isEquipped, true);
  });
  check('setWielded works on Armor/MeleeWeapon/MissileWeapon (inherits)', () => {
    const a = new Armor(0x1, 0, null, null, null);
    a.setWielded(0xAAA, 0x2);
    assert.strictEqual(a.instanceValue(3, 0), 0xAAA);

    const m = new MeleeWeapon(0x2, 0, null, null, null);
    m.setWielded(0xBBB, 0x10);
    assert.strictEqual(m.intValue(19, 0), 0x10);
  });
  check('setWielded coerces parentGuid to uint32 (signed→unsigned)', () => {
    const e = makeEq();
    e.setWielded(-1, 0x1);  // -1 → 0xFFFFFFFF after >>> 0
    assert.strictEqual(e.instanceValue(3, 0), 0xFFFFFFFF);
  });

  // ============================================================
  // [7] Equippable.wielder read-through
  // ============================================================
  console.log('\n[7] Equippable.wielder (Equippable.cs:13)');

  check('wielder: unset → null', () => {
    assert.strictEqual(makeEq().wielder, null);
  });
  check('wielder: resolved via _world (must be Creature subclass)', () => {
    const w = new WorldState({ logger: silentLog() });
    const creature = makeCreature(0xCC01);
    const eq = makeEq(0xEE01);
    [creature, eq].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    eq.setInstanceValue(3, 0xCC01);
    assert.strictEqual(eq.wielder, creature);
  });
  check('wielder: parent is not a Creature → null (duck-type check)', () => {
    const w = new WorldState({ logger: silentLog() });
    const item = makeItem(0xAA);          // not a creature
    const eq = makeEq(0xEE02);
    [item, eq].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    eq.setInstanceValue(3, 0xAA);
    assert.strictEqual(eq.wielder, null);
  });

  // ============================================================
  // [8] Creature — stance/combatMode (Creature.cs:34-68)
  // ============================================================
  console.log('\n[8] Creature.stance / Creature.combatMode (Creature.cs:34-68)');

  check('MotionStance enum values match Chorizite.Common', () => {
    assert.strictEqual(MotionStance.HandCombat, 60);
    assert.strictEqual(MotionStance.NonCombat, 61);
    assert.strictEqual(MotionStance.Magic, 73);
    assert.strictEqual(MotionStance.AtlatlCombat, 312);
    assert.strictEqual(MotionStance.ThrownShieldCombat, 313);
  });
  check('CombatMode enum values match Chorizite.Common', () => {
    assert.strictEqual(CombatMode.NonCombat, 0x1);
    assert.strictEqual(CombatMode.Melee, 0x2);
    assert.strictEqual(CombatMode.Missile, 0x4);
    assert.strictEqual(CombatMode.Magic, 0x8);
  });
  check('Default stance is NonCombat (Creature.cs:14)', () => {
    assert.strictEqual(makeCreature().stance, MotionStance.NonCombat);
    assert.strictEqual(makeCreature().combatMode, CombatMode.NonCombat);
  });
  check('stance setter ignores 0 writes (Creature.cs:36-39)', () => {
    const c = makeCreature();
    c.stance = MotionStance.SwordCombat;
    c.stance = 0;  // should be ignored
    assert.strictEqual(c.stance, MotionStance.SwordCombat);
  });
  // Melee block (Creature.cs:48-53)
  check('HandCombat → Melee', () => {
    const c = makeCreature(); c.stance = MotionStance.HandCombat;
    assert.strictEqual(c.combatMode, CombatMode.Melee);
  });
  check('DualWieldCombat → Melee', () => {
    const c = makeCreature(); c.stance = MotionStance.DualWieldCombat;
    assert.strictEqual(c.combatMode, CombatMode.Melee);
  });
  check('SwordCombat → Melee', () => {
    const c = makeCreature(); c.stance = MotionStance.SwordCombat;
    assert.strictEqual(c.combatMode, CombatMode.Melee);
  });
  check('SwordShieldCombat → Melee', () => {
    const c = makeCreature(); c.stance = MotionStance.SwordShieldCombat;
    assert.strictEqual(c.combatMode, CombatMode.Melee);
  });
  check('TwoHandedStaffCombat → Melee', () => {
    const c = makeCreature(); c.stance = MotionStance.TwoHandedStaffCombat;
    assert.strictEqual(c.combatMode, CombatMode.Melee);
  });
  check('TwoHandedSwordCombat → Melee', () => {
    const c = makeCreature(); c.stance = MotionStance.TwoHandedSwordCombat;
    assert.strictEqual(c.combatMode, CombatMode.Melee);
  });
  // Missile block (Creature.cs:55-60)
  check('BowCombat → Missile', () => {
    const c = makeCreature(); c.stance = MotionStance.BowCombat;
    assert.strictEqual(c.combatMode, CombatMode.Missile);
  });
  check('AtlatlCombat → Missile', () => {
    const c = makeCreature(); c.stance = MotionStance.AtlatlCombat;
    assert.strictEqual(c.combatMode, CombatMode.Missile);
  });
  check('CrossbowCombat → Missile', () => {
    const c = makeCreature(); c.stance = MotionStance.CrossbowCombat;
    assert.strictEqual(c.combatMode, CombatMode.Missile);
  });
  check('CrossBowNoAmmo → Missile', () => {
    const c = makeCreature(); c.stance = MotionStance.CrossBowNoAmmo;
    assert.strictEqual(c.combatMode, CombatMode.Missile);
  });
  check('ThrownShieldCombat → Missile', () => {
    const c = makeCreature(); c.stance = MotionStance.ThrownShieldCombat;
    assert.strictEqual(c.combatMode, CombatMode.Missile);
  });
  check('ThrownWeaponCombat → Missile', () => {
    const c = makeCreature(); c.stance = MotionStance.ThrownWeaponCombat;
    assert.strictEqual(c.combatMode, CombatMode.Missile);
  });
  // Magic block (Creature.cs:62)
  check('Magic → Magic', () => {
    const c = makeCreature(); c.stance = MotionStance.Magic;
    assert.strictEqual(c.combatMode, CombatMode.Magic);
  });
  // Fall-through (Creature.cs:64)
  check('NonCombat → NonCombat (fall-through)', () => {
    const c = makeCreature(); c.stance = MotionStance.NonCombat;
    assert.strictEqual(c.combatMode, CombatMode.NonCombat);
  });
  check('UnusedCombat → NonCombat (fall-through, not in melee/missile/magic)', () => {
    const c = makeCreature(); c.stance = MotionStance.UnusedCombat;
    assert.strictEqual(c.combatMode, CombatMode.NonCombat);
  });
  check('SlingCombat → NonCombat (fall-through — interesting: not in any block!)', () => {
    const c = makeCreature(); c.stance = MotionStance.SlingCombat;
    assert.strictEqual(c.combatMode, CombatMode.NonCombat);
  });
  check('BowNoAmmo → NonCombat (NOT Missile despite the name — fall-through)', () => {
    const c = makeCreature(); c.stance = MotionStance.BowNoAmmo;
    assert.strictEqual(c.combatMode, CombatMode.NonCombat);
  });

  // ============================================================
  // [9] Creature — radarColor / radarBehavior / level / equipment
  // ============================================================
  console.log('\n[9] Creature.{radarColor, radarBehavior, level, equipment}');

  check('radarColor unset → 0', () => {
    assert.strictEqual(makeCreature().radarColor, 0);
  });
  check('radarColor: RadarBlipColor=5 (Red) (Creature.cs:19)', () => {
    const c = makeCreature();
    c.setIntValue(95 /* RadarBlipColor */, 5);
    assert.strictEqual(c.radarColor, 5);
  });
  check('radarBehavior: ShowableOnRadar=4 (ShowAlways) (Creature.cs:24)', () => {
    const c = makeCreature();
    c.setIntValue(133, 4);
    assert.strictEqual(c.radarBehavior, 4);
  });
  check('level: PropertyInt.Level=42 (Creature.cs:73)', () => {
    const c = makeCreature();
    c.setIntValue(25 /* Level */, 42);
    assert.strictEqual(c.level, 42);
  });
  check('equipment: no wielded items → []', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeCreature(0xCC00);
    w.weenies.set(0xCC00, c);
    if (typeof c.setWorld === 'function') c.setWorld(w);
    assert.deepStrictEqual(c.equipment, []);
  });
  check('equipment: filters by PROP_INSTANCE_WIELDER (Creature.cs:29)', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeCreature(0xCC00);
    const eq1 = makeEq(0xE100);
    const eq2 = makeEq(0xE200);
    const otherEq = makeEq(0xE300);  // wielded by a DIFFERENT creature
    [c, eq1, eq2, otherEq].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    eq1.setInstanceValue(3, 0xCC00);
    eq2.setInstanceValue(3, 0xCC00);
    otherEq.setInstanceValue(3, 0xDEAD);
    const equipment = c.equipment;
    assert.strictEqual(equipment.length, 2);
    assert.ok(equipment.includes(eq1));
    assert.ok(equipment.includes(eq2));
    assert.ok(!equipment.includes(otherEq));
  });
  check('equipment: excludes non-Equippable weenies even if wielder set', () => {
    const w = new WorldState({ logger: silentLog() });
    const c = makeCreature(0xCC00);
    const item = makeItem(0xAAA);  // bare Item, no setWielded method
    [c, item].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    item.setInstanceValue(3, 0xCC00);
    assert.deepStrictEqual(c.equipment, []);
  });

  // ============================================================
  // [10] Integration with WorldState — _world injected on adoption
  // ============================================================
  console.log('\n[10] WorldState integration — _world injection');

  check('dispatchItemCreateObject injects _world on adoption', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0x1, classId: 0 });
    assert.strictEqual(wo._world, w);
  });
  check('Container child resolves via WorldState after dispatchItemCreateObject', () => {
    const w = new WorldState({ logger: silentLog() });
    // Replace the auto-constructed WorldObject sentinels with Container/Item.
    // (PR-3 baseline: WorldState w/o a manager constructs sentinels; this test
    //  proves the read-through pattern works whatever flavor of weenie is
    //  in the map, as long as it's a Container.)
    const container = makeContainer(0xC1);
    const item = makeItem(0x11);
    w.weenies.set(0xC1, container);
    w.weenies.set(0x11, item);
    if (typeof container.setWorld === 'function') container.setWorld(w);
    if (typeof item.setWorld === 'function') item.setWorld(w);
    item.setInstanceValue(2, 0xC1);
    assert.strictEqual(item.parentContainer, container);
    assert.deepStrictEqual(container.items, [item]);
  });
  check('isOwnedByMe: needs localCharacterId on world OR client.player.character.id', () => {
    const w = new WorldState({ logger: silentLog() });
    const character = new Character(0xCC, 0, null, null, null);
    const item = makeItem(0x11);
    [character, item].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    item.setInstanceValue(2, 0xCC);
    // No localCharacterId → false
    assert.strictEqual(item.isOwnedByMe, false);
    // Set it
    w.localCharacterId = 0xCC;
    assert.strictEqual(item.isOwnedByMe, true);
  });
  check('isOwnedByMe: also checks grandparent (Item.cs:70)', () => {
    // Layout: item → side-pack → character
    const w = new WorldState({ logger: silentLog() });
    const character = new Character(0xCC, 0, null, null, null);
    const sidePack = makeContainer(0xC2);
    const item = makeItem(0x11);
    [character, sidePack, item].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    sidePack.setInstanceValue(2, 0xCC);
    item.setInstanceValue(2, 0xC2);
    w.localCharacterId = 0xCC;
    assert.strictEqual(item.isOwnedByMe, true, 'grandparent should match');
  });

  // ============================================================
  // [11] Foci verification — handoff §3 surprising case
  // ============================================================
  console.log('\n[11] Foci → Container (handoff §3 surprising case)');

  check('Foci instance has containerType field', () => {
    const f = new Foci(0xF0, 0, null, null, null);
    assert.strictEqual(f.containerType, ContainerProperties.None);
  });
  check('Foci passes Container._isContainer duck-type check', () => {
    const f = new Foci(0xF0, 0, null, null, null);
    assert.ok(Container._isContainer(f));
  });
  check('Foci can have child items (it IS a container)', () => {
    const w = new WorldState({ logger: silentLog() });
    const foci = new Foci(0xF0, 0, null, null, null);
    const item = makeItem(0x11);
    [foci, item].forEach(wo => {
      w.weenies.set(wo.id, wo);
      if (typeof wo.setWorld === 'function') wo.setWorld(w);
    });
    item.setInstanceValue(2, 0xF0);
    assert.deepStrictEqual(foci.items, [item]);
  });

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n========');
  console.log(`${passed} passed, ${failed} failed (total ${passed + failed} assertions)`);
  console.log('========');
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}`);
      console.log(`      ${f.err.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Top-level error:', err);
  process.exit(1);
});
