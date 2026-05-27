// ACPlugin PR-1 (2026-05-27) — unit tests for the ported `WorldObject`
// base-class additions:
//
//   - 8 HasValue predicates       (WorldObject.cs:164-229)
//   - 8 AddOrUpdate setters       (WorldObject.cs:459-508)
//   - 8 RemoveValue setters       (WorldObject.cs:510-540)
//   - updatePhysicsDesc Wielder   (WorldObject.cs:549-556)
//   - updateWeenieDesc 35-flag    (WorldObject.cs:558-678)
//   - objectClass lazy cache      (WorldObject.cs:42, 147-155)
//   - toString debug repr         (WorldObject.cs:680-682)
//
// Plus the 11 EventArgs factories + 2 enums in plugins/api.js (ACPlugin
// PR-1 §"Chorizite/ACPlugin enum + EventArgs factory ports").
//
// The pre-existing tests/world_object_property_dict.test.cjs covers the
// 8 typed dicts + getters; this file augments without overlap. Both
// suites should be green concurrently.
//
// Run from apps/holtburger-web/:
//   node tests/world_object.test.cjs
// Exits 0 on full pass, 1 on any assertion failure.

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WO_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-objects', 'world_object.js')
).href;
const CC_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-objects', 'canonical_classify.js')
).href;
const API_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'api.js')
).href;

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

(async () => {
  const { WorldObject } = await import(WO_URL);
  const { BITFLAGS, canonicalClassify } = await import(CC_URL);
  const {
    ClientState,
    AddRemoveEventType,
    eventArgsFactories,
    makeObjectCreated,
    makeObjectReleased,
    makeContainerOpened,
    makeContainerClosed,
    makeWorldObjectSelected,
    makeGameStateChanged,
    makeVitaeChanged,
    makeVitalChanged,
    makeEnchantmentsChanged,
    makeSharedCooldownsChanged,
    makeDeath,
  } = await import(API_URL);

  const makeObj = (id = 0x12345678, classId = 0xa9b4) =>
    new WorldObject(id, classId, null, null, null);

  // ============================================================
  // [1] HasValue predicates (WorldObject.cs:164-229)
  // ============================================================
  console.log('\n[1] HasValue predicates');
  {
    const wo = makeObj();
    wo.intValues.set(1, 256);
    wo.int64Values.set(1, 42n);
    wo.stringValues.set(1, 'Name');
    wo.boolValues.set(1, true);
    wo.floatValues.set(1, 1.5);
    wo.instanceValues.set(1, 0xDEAD);
    wo.dataValues.set(1, 0x06001234);
    wo.positionValues.set(1, {});

    check('hasIntValue hit', () => assert.strictEqual(wo.hasIntValue(1), true));
    check('hasIntValue miss', () => assert.strictEqual(wo.hasIntValue(99), false));
    check('hasInt64Value hit', () => assert.strictEqual(wo.hasInt64Value(1), true));
    check('hasInt64Value miss', () => assert.strictEqual(wo.hasInt64Value(99), false));
    check('hasStringValue hit', () => assert.strictEqual(wo.hasStringValue(1), true));
    check('hasBoolValue hit', () => assert.strictEqual(wo.hasBoolValue(1), true));
    check('hasFloatValue hit', () => assert.strictEqual(wo.hasFloatValue(1), true));
    check('hasInstanceValue hit', () => assert.strictEqual(wo.hasInstanceValue(1), true));
    check('hasDataValue hit', () => assert.strictEqual(wo.hasDataValue(1), true));
    check('hasPositionValue hit', () => assert.strictEqual(wo.hasPositionValue(1), true));
  }

  // ============================================================
  // [2] AddOrUpdate setters (WorldObject.cs:459-508)
  // ============================================================
  console.log('\n[2] AddOrUpdate setters');
  {
    const wo = makeObj();
    wo.setIntValue(5, 800);
    check('setIntValue stores', () => assert.strictEqual(wo.intValues.get(5), 800));
    wo.setIntValue(5, 900);
    check('setIntValue replaces existing', () => assert.strictEqual(wo.intValues.get(5), 900));

    wo.setInt64Value(10, 100n);
    check('setInt64Value stores BigInt', () => assert.strictEqual(wo.int64Values.get(10), 100n));
    wo.setInt64Value(10, 200);
    check('setInt64Value coerces Number→BigInt', () => assert.strictEqual(wo.int64Values.get(10), 200n));

    wo.setStringValue(1, 'Halo');
    check('setStringValue stores', () => assert.strictEqual(wo.stringValues.get(1), 'Halo'));
    wo.setBoolValue(7, true);
    check('setBoolValue stores', () => assert.strictEqual(wo.boolValues.get(7), true));
    wo.setFloatValue(13, 1.25);
    check('setFloatValue stores', () => assert.strictEqual(wo.floatValues.get(13), 1.25));
    wo.setDataValue(8, 0x06001000);
    check('setDataValue stores u32', () => assert.strictEqual(wo.dataValues.get(8), 0x06001000));
    wo.setPositionValue(1, { foo: 'bar' });
    check('setPositionValue stores object', () => assert.deepStrictEqual(wo.positionValues.get(1), { foo: 'bar' }));

    // setInstanceValue same-value short-circuit (WorldObject.cs:501-508)
    wo.setInstanceValue(2, 0xDEAD);
    let writes = 0;
    const origSet = wo.instanceValues.set.bind(wo.instanceValues);
    wo.instanceValues.set = (...args) => { writes += 1; return origSet(...args); };
    wo.setInstanceValue(2, 0xDEAD);
    check('setInstanceValue skips same-value writes (WorldObject.cs:501-508)', () => {
      assert.strictEqual(writes, 0);
    });
    wo.setInstanceValue(2, 0xBEEF);
    check('setInstanceValue writes on change', () => {
      assert.strictEqual(writes, 1);
      assert.strictEqual(wo.instanceValues.get(2), 0xBEEF);
    });
    wo.instanceValues.set = origSet;
  }

  // ============================================================
  // [3] RemoveValue setters (WorldObject.cs:510-540)
  // ============================================================
  console.log('\n[3] RemoveValue setters');
  {
    const wo = makeObj();
    wo.intValues.set(5, 800);
    wo.removeIntValue(5);
    check('removeIntValue clears key', () => assert.strictEqual(wo.intValues.has(5), false));

    wo.stringValues.set(1, 'X');
    wo.removeStringValue(1);
    check('removeStringValue clears key', () => assert.strictEqual(wo.stringValues.has(1), false));

    wo.boolValues.set(1, true);
    wo.removeBoolValue(1);
    check('removeBoolValue clears key', () => assert.strictEqual(wo.boolValues.has(1), false));

    // No-op on missing (matches C# Dictionary.Remove returning false silently)
    wo.removeIntValue(99);
    check('removeIntValue no-op on missing', () => assert.strictEqual(wo.intValues.has(99), false));
  }

  // ============================================================
  // [4] updatePhysicsDesc parent → Wielder (WorldObject.cs:549-556)
  // ============================================================
  console.log('\n[4] updatePhysicsDesc');
  {
    const wo = makeObj();
    // No flags → no Wielder write.
    wo.updatePhysicsDesc({ flags: 0x00000000, parentId: 0xCAFE });
    check('updatePhysicsDesc no-parent-flag → no Wielder write', () =>
      assert.strictEqual(wo.instanceValues.has(3 /*Wielder*/), false));

    // With 0x00000020 flag → sets PropertyInstanceId.Wielder (= 3) to ParentId.
    wo.updatePhysicsDesc({ flags: 0x00000020, parentId: 0xCAFE });
    check('updatePhysicsDesc parent-flag → sets Wielder', () =>
      assert.strictEqual(wo.instanceValues.get(3), 0xCAFE));

    // PascalCase field aliases also supported (wasm-bindgen JS vs C# casing).
    wo.updatePhysicsDesc({ Flags: 0x00000020, ParentId: 0xBABE });
    check('updatePhysicsDesc PascalCase aliases honoured', () =>
      assert.strictEqual(wo.instanceValues.get(3), 0xBABE));

    // null is a no-op (WorldObject.cs:550)
    wo.physicsDesc = 'preserve';
    wo.updatePhysicsDesc(null);
    check('updatePhysicsDesc(null) is no-op', () =>
      assert.strictEqual(wo.physicsDesc, 'preserve'));
  }

  // ============================================================
  // [5] updateWeenieDesc 35-flag unpacker (WorldObject.cs:558-678)
  // ============================================================
  console.log('\n[5] updateWeenieDesc');
  {
    // No flags: only unconditional name/icon/type writes (WorldObject.cs:567-569)
    const wo = makeObj();
    wo.updateWeenieDesc({
      WeenieClassId: 0xABCD,
      Behavior: 0x00010000,  // DoorSwitch (random)
      Name: 'Test Sword',
      Icon: 0x1234,
      Type: 0x0001,          // ItemType.MeleeWeapon
      Header: 0,
      Header2: 0,
    });
    check('updateWeenieDesc sets classId', () => assert.strictEqual(wo.classId, 0xABCD));
    check('updateWeenieDesc sets behavior', () => assert.strictEqual(wo.behavior, 0x00010000));
    check('updateWeenieDesc unconditional Name (WO.cs:567)', () => assert.strictEqual(wo.name, 'Test Sword'));
    check('updateWeenieDesc unconditional Icon adds 0x06000000 prefix (WO.cs:568)', () =>
      assert.strictEqual(wo.dataValues.get(8 /*Icon*/), 0x06001234));
    check('updateWeenieDesc unconditional ItemType (WO.cs:569)', () =>
      assert.strictEqual(wo.intValue(1 /*ItemType*/), 0x0001));

    // Flag-gated PluralName (WHF.PluralName = 0x01) — :625-626
    const wo2 = makeObj();
    wo2.updateWeenieDesc({
      WeenieClassId: 1, Behavior: 0, Name: 'Pyreal', Icon: 0, Type: 0,
      Header: 0x00000001 /*PluralName*/, Header2: 0,
      PluralName: 'Pyreals',
    });
    check('updateWeenieDesc PluralName gated by Header.PluralName', () =>
      assert.strictEqual(wo2.stringValue(20 /*PluralName*/), 'Pyreals'));

    // Flag-gated Container (WHF.Container = 0x4000) — :586-587
    const wo3 = makeObj();
    wo3.updateWeenieDesc({
      WeenieClassId: 1, Behavior: 0, Name: '', Icon: 0, Type: 0,
      Header: 0x00004000 /*Container*/, Header2: 0,
      ContainerId: 0xDEADBEEF,
    });
    check('updateWeenieDesc Container → PropertyInstanceId.Container', () =>
      assert.strictEqual(wo3.instanceValue(2), 0xDEADBEEF));

    // Flag-gated Spell (WHF.Spell = 0x00400000) — :643-644 — the bug fix
    // we just landed. Verify Spell flag sets PropertyDataId.Spell to the
    // wdesc spell id; verify ABSENT Spell flag leaves it unset (no upstream
    // dead-code 0-write).
    const wo4 = makeObj();
    wo4.updateWeenieDesc({
      WeenieClassId: 1, Behavior: 0, Name: '', Icon: 0, Type: 0,
      Header: 0x00400000 /*Spell*/, Header2: 0,
      SpellId: 7777,
    });
    check('updateWeenieDesc Spell flag → PropertyDataId.Spell', () =>
      assert.strictEqual(wo4.dataValue(28 /*Spell*/), 7777));

    const wo5 = makeObj();
    wo5.updateWeenieDesc({
      WeenieClassId: 1, Behavior: 0, Name: '', Icon: 0, Type: 0,
      Header: 0, Header2: 0,
      SpellId: 7777,
    });
    check('updateWeenieDesc no Spell flag → no PropertyDataId.Spell write', () =>
      assert.strictEqual(wo5.hasDataValue(28), false));

    // Header2.IconUnderlay (WHF2 = 0x01) — :604-605
    const wo6 = makeObj();
    wo6.updateWeenieDesc({
      WeenieClassId: 1, Behavior: 0, Name: '', Icon: 0, Type: 0,
      Header: 0, Header2: 0x01,
      IconUnderlay: 0x5678,
    });
    check('updateWeenieDesc Header2.IconUnderlay → PropertyDataId.IconUnderlay (0x06000000 prefix)', () =>
      assert.strictEqual(wo6.dataValue(52), 0x06005678));

    // snake_case fallback (matches our wasm-bindgen JS output)
    const wo7 = makeObj();
    wo7.updateWeenieDesc({
      weenie_class_id: 9, behavior: 0, name: 'Snake', icon: 1, type: 0,
      header: 0x200000 /*Burden*/, header2: 0,
      burden: 250,
    });
    check('updateWeenieDesc snake_case field aliases work', () =>
      assert.strictEqual(wo7.intValue(5 /*EncumbranceVal*/), 250));

    // null wdesc is a no-op (WorldObject.cs:559-560)
    const wo8 = makeObj();
    wo8.weenieDescription = 'preserve';
    wo8.updateWeenieDesc(null);
    check('updateWeenieDesc(null) is no-op', () => assert.strictEqual(wo8.weenieDescription, 'preserve'));
  }

  // ============================================================
  // [6] objectClass lazy cache + invalidation (WorldObject.cs:147-155)
  // ============================================================
  console.log('\n[6] objectClass lazy getter');
  {
    const wo = makeObj();
    wo.setIntValue(1 /*ItemType*/, 0x0001 /*MeleeWeapon*/);
    check('objectClass routes through canonicalClassify', () =>
      assert.strictEqual(wo.objectClass, 'MeleeWeapon'));

    // Cache invalidation on setIntValue. ItemType.Creature lands as
    // 'Monster' from PASS 1 then refines to 'Npc' in PASS 3c when the
    // Attackable bit is absent (canonical_classify.js:179-181). With
    // objDescFlags=0 we get the Npc refinement.
    wo.setIntValue(1, 0x0010 /*Creature*/);
    check('objectClass invalidates on ItemType change (Creature+no-Attackable → Npc)', () =>
      assert.strictEqual(wo.objectClass, 'Npc'));

    // With Attackable set, the PASS 3c refinement is skipped and we keep Monster.
    wo.objDescFlags = BITFLAGS.ObjectDescriptionFlag.Attackable;
    wo._objectClass = null;
    check('objectClass: Creature+Attackable → Monster', () =>
      assert.strictEqual(wo.objectClass, 'Monster'));
    wo.objDescFlags = 0;
    wo._objectClass = null;

    // Behavior overrides item-type (ObjectDescriptionFlag.Door = 0x1000)
    wo.behavior = BITFLAGS.ObjectDescriptionFlag.Door;
    wo._objectClass = null;  // would have been cleared by setObjDescFlags if we had one
    check('objectClass picks up Behavior overrides (Door)', () =>
      assert.strictEqual(wo.objectClass, 'Door'));

    // Lifestone path (HANDOFF §2 row 2 — verifying NOT-MISSING in our skeleton)
    wo.behavior = BITFLAGS.ObjectDescriptionFlag.Lifestone;
    wo._objectClass = null;
    check('objectClass dispatches Lifestone (canonical_classify.js:155 covers the upstream gap)', () =>
      assert.strictEqual(wo.objectClass, 'Lifestone'));

    // PASS 3b: Writable + Spell flag → Scroll (canonical_classify.js:174-176)
    // Pre-fix this was hitting RadarBlipColor instead of Spell.
    const ws = makeObj();
    ws.setIntValue(1, 0x00002000 /*Writable*/);
    ws.weenieFlags = 0x00400000 /*Spell — the fixed value*/;
    ws._objectClass = null;
    check('objectClass picks up Scroll via WHF_SPELL=0x400000 (post-fix)', () =>
      assert.strictEqual(ws.objectClass, 'Scroll'));
  }

  // ============================================================
  // [7] toString debug repr (WorldObject.cs:680-682)
  // ============================================================
  console.log('\n[7] toString');
  {
    const wo = makeObj(0x12345678, 0xA9B4);
    wo.setIntValue(1, 0x0010 /*Creature*/);
    wo.objDescFlags = BITFLAGS.ObjectDescriptionFlag.Attackable;
    wo._objectClass = null;
    wo.setStringValue(1, 'Drudge');
    const s = wo.toString();
    check('toString contains 0x{Id:X8}', () => assert.ok(s.includes('0x12345678'), s));
    check('toString starts with Name(ClassName)', () => assert.ok(s.startsWith('Drudge(WorldObject)'), s));
    check('toString includes ObjectClass (Monster, since Attackable set)', () => {
      assert.ok(s.includes('Monster'), s);
    });
  }

  // ============================================================
  // [8] ClientState + AddRemoveEventType (ClientState.cs / AddRemoveEventType.cs)
  // ============================================================
  console.log('\n[8] ClientState + AddRemoveEventType enums');
  check('ClientState.Initial=0', () => assert.strictEqual(ClientState.Initial, 0));
  check('ClientState.GameStarted=1', () => assert.strictEqual(ClientState.GameStarted, 1));
  check('ClientState.CharacterSelect=2', () => assert.strictEqual(ClientState.CharacterSelect, 2));
  check('ClientState.CreatingCharacter=3', () => assert.strictEqual(ClientState.CreatingCharacter, 3));
  check('ClientState.EnteringGame=4', () => assert.strictEqual(ClientState.EnteringGame, 4));
  check('ClientState.InGame=5', () => assert.strictEqual(ClientState.InGame, 5));
  check('ClientState.LoggingOut=6', () => assert.strictEqual(ClientState.LoggingOut, 6));
  check('ClientState.Disconnected=7', () => assert.strictEqual(ClientState.Disconnected, 7));
  check('ClientState is frozen', () => assert.strictEqual(Object.isFrozen(ClientState), true));
  check('AddRemoveEventType.Added=0', () => assert.strictEqual(AddRemoveEventType.Added, 0));
  check('AddRemoveEventType.Removed=1', () => assert.strictEqual(AddRemoveEventType.Removed, 1));

  // ============================================================
  // [9] 11 EventArgs factories
  // ============================================================
  console.log('\n[9] EventArgs factories');
  {
    const e = makeObjectCreated({ id: 1, name: 'foo' });
    check('makeObjectCreated.object', () => assert.strictEqual(e.object.id, 1));

    const e2 = makeObjectReleased({ id: 2 });
    check('makeObjectReleased.object', () => assert.strictEqual(e2.object.id, 2));

    const e3 = makeContainerOpened({ items: [] });
    check('makeContainerOpened.container', () => assert.deepStrictEqual(e3.container.items, []));

    const e4 = makeContainerClosed({});
    check('makeContainerClosed.container exists', () => assert.ok(e4.container));

    const sel = makeWorldObjectSelected({ id: 0xABCD });
    check('makeWorldObjectSelected.object', () => assert.strictEqual(sel.object.id, 0xABCD));
    check('makeWorldObjectSelected.eaten = false default', () => assert.strictEqual(sel.eaten, false));
    sel.eat();
    check('makeWorldObjectSelected.eat() sets eaten=true', () => assert.strictEqual(sel.eaten, true));

    // Null-selection deselect
    const selNull = makeWorldObjectSelected(null);
    check('makeWorldObjectSelected(null) → object: null + eaten=false', () => {
      assert.strictEqual(selNull.object, null);
      assert.strictEqual(selNull.eaten, false);
    });

    const gs = makeGameStateChanged(ClientState.InGame, ClientState.EnteringGame);
    check('makeGameStateChanged.newState=InGame oldState=EnteringGame', () => {
      assert.strictEqual(gs.newState, 5);
      assert.strictEqual(gs.oldState, 4);
    });

    const vit = makeVitaeChanged(0.95, 1.0);
    check('makeVitaeChanged.vitae+oldVitae (1.0=none semantic preserved)', () => {
      assert.strictEqual(vit.vitae, 0.95);
      assert.strictEqual(vit.oldVitae, 1.0);
    });

    const vc = makeVitalChanged(1 /*Health*/, 80, 100);
    check('makeVitalChanged.type/value/oldValue', () => {
      assert.strictEqual(vc.type, 1);
      assert.strictEqual(vc.value, 80);
      assert.strictEqual(vc.oldValue, 100);
    });

    const enc = {
      layeredId: { id: 1234, layer: 1 },
      spellId: 1234,
      power: 100,
      startTime: 0,
      duration: 60,
    };
    const ec = makeEnchantmentsChanged(AddRemoveEventType.Added, enc);
    check('makeEnchantmentsChanged.type+layeredSpellId+spellId+enchantment', () => {
      assert.strictEqual(ec.type, 0);
      assert.strictEqual(ec.spellId, 1234);
      assert.deepStrictEqual(ec.layeredSpellId, { id: 1234, layer: 1 });
      assert.strictEqual(ec.enchantment, enc);
    });

    // PascalCase enchantment fallback
    const ec2 = makeEnchantmentsChanged(AddRemoveEventType.Removed, {
      LayeredId: { id: 99, layer: 2 },
      SpellId: 99,
    });
    check('makeEnchantmentsChanged tolerates PascalCase enchantment fields', () => {
      assert.deepStrictEqual(ec2.layeredSpellId, { id: 99, layer: 2 });
      assert.strictEqual(ec2.spellId, 99);
      assert.strictEqual(ec2.type, 1);
    });

    const sc = makeSharedCooldownsChanged(AddRemoveEventType.Added, { id: 5, duration: 30 });
    check('makeSharedCooldownsChanged.type+cooldown', () => {
      assert.strictEqual(sc.type, 0);
      assert.strictEqual(sc.cooldown.id, 5);
    });

    const d = makeDeath('You were killed by a Drudge.', 0xDEAD);
    check('makeDeath.text+killerId', () => {
      assert.strictEqual(d.text, 'You were killed by a Drudge.');
      assert.strictEqual(d.killerId, 0xDEAD);
    });

    // eventArgsFactories has exactly 11 entries
    const factoryKeys = Object.keys(eventArgsFactories);
    check('eventArgsFactories has 11 entries', () => assert.strictEqual(factoryKeys.length, 11));
    check('eventArgsFactories is frozen', () =>
      assert.strictEqual(Object.isFrozen(eventArgsFactories), true));
  }

  // ============================================================
  // [10] WHF_SPELL classifier-correctness regression
  // ============================================================
  // Pre-PR-1, canonical_classify.js had WHF_SPELL = 0x00100000 (which is
  // RadarBlipColor); we corrected to 0x00400000 (per Chorizite.Common AND
  // holtburger-common). Verify the classifier picks up Scroll only when
  // the actual Spell bit is set.
  console.log('\n[10] WHF_SPELL value fix — classifier regression');
  check('canonicalClassify(Writable, 0, RadarBlipColor) → NOT Scroll', () => {
    const objClass = canonicalClassify(0x00002000, 0, 0x00100000);
    assert.notStrictEqual(objClass, 'Scroll', `Got '${objClass}'`);
  });
  check('canonicalClassify(Writable, 0, Spell=0x400000) → Scroll', () => {
    const objClass = canonicalClassify(0x00002000, 0, 0x00400000);
    assert.strictEqual(objClass, 'Scroll', `Got '${objClass}'`);
  });

  // ============================================================
  console.log(
    `\n========\n${passed} passed, ${failed} failed (total ${passed + failed} assertions)\n========`
  );

  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.err.stack || f.err.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('FATAL test harness error:', err);
  process.exit(2);
});
