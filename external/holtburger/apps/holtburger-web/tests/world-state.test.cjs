// ACPlugin PR-2 (2026-05-27) — unit tests for the ported `World.cs`
// dispatch table in plugins/world-state.js.
//
// Coverage:
//   1. Weenies map + Get/Exists/indexer-symbol (`World.cs:138-164`)
//   2. Container-open child-wait gate (`World.cs:212-249`)
//      - empty container → immediate fire
//      - all children already cached → immediate fire
//      - some children pending → defer until last arrives
//      - concurrent gates don't cross-contaminate
//   3. Container-closed fires when expected (`World.cs:253-262`)
//   4. ObjectCreated routes through PR 1's setters
//   5. ObjectDeleted recursively releases children
//   6. ObjDescEvent + UpdateObject + SetState + StackSize + Parent dispatches
//   7. Enchantment delta detection emits added/removed deltas
//   8. SetAppraiseInfo folds props through PR 1's setters
//   9. Selection bookkeeping
//
// Run from apps/holtburger-web/:
//   node tests/world-state.test.cjs
// Exits 0 on full pass, 1 on any assertion failure.

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WS_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-state.js')
).href;
const WO_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-objects', 'world_object.js')
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

function silentLog() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

(async () => {
  const { WorldState } = await import(WS_URL);
  const { WorldObject } = await import(WO_URL);

  // ─── [1] Weenies map + Get/Exists ───
  console.log('\n[1] Weenies map + Get/Exists');

  check('empty WorldState has count 0', () => {
    const w = new WorldState({ logger: silentLog() });
    assert.equal(w.count(), 0);
  });

  check('get(0) returns null (lookup-miss sentinel)', () => {
    const w = new WorldState({ logger: silentLog() });
    assert.equal(w.get(0), null);
  });

  check('get(null) returns null', () => {
    const w = new WorldState({ logger: silentLog() });
    assert.equal(w.get(null), null);
  });

  check('exists(0) returns false', () => {
    const w = new WorldState({ logger: silentLog() });
    assert.equal(w.exists(0), false);
  });

  check('dispatchItemCreateObject sentinel adds to map', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xCAFEBABE, classId: 7 });
    assert.ok(wo instanceof WorldObject);
    assert.equal(wo.id, 0xCAFEBABE);
    assert.equal(wo.classId, 7);
    assert.equal(w.count(), 1);
    assert.equal(w.exists(0xCAFEBABE), true);
    assert.equal(w.get(0xCAFEBABE), wo);
  });

  check('GUID normalization — get(unsigned) === get(signed bit-twiddled)', () => {
    const w = new WorldState({ logger: silentLog() });
    w.dispatchItemCreateObject({ guid: 0xFFFFFFFF, classId: 0 });
    // JS bitwise produces -1 for 0xFFFFFFFF; `>>> 0` re-unsigns. The
    // dispatcher must coerce on the way in AND out.
    assert.equal(w.get(0xFFFFFFFF).id, 0xFFFFFFFF);
    assert.equal(w.get(-1 >>> 0).id, 0xFFFFFFFF);
  });

  // ─── [2] Container-open child-wait gate ───
  console.log('\n[2] Container-open child-wait gate (World.cs:212-249)');

  check('empty container → containerOpened fires immediately', () => {
    const w = new WorldState({ logger: silentLog() });
    const container = w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    let fired = null;
    w.addEventListener('containerOpened', (e) => { fired = e.detail; });
    w.dispatchContainerOpened(0x100, []);
    assert.ok(fired);
    assert.equal(fired.container, container);
    assert.equal(w.openContainer, container);
  });

  check('all children already cached → fires immediately', () => {
    const w = new WorldState({ logger: silentLog() });
    const container = w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    const child1 = w.dispatchItemCreateObject({ guid: 0x200, classId: 0 });
    const child2 = w.dispatchItemCreateObject({ guid: 0x300, classId: 0 });
    let fired = null;
    w.addEventListener('containerOpened', (e) => { fired = e.detail; });
    w.dispatchContainerOpened(0x100, [
      { guid: 0x200, containerType: 1 },
      { guid: 0x300, containerType: 1 },
    ]);
    assert.ok(fired);
    assert.equal(fired.container, container);
    // Children got their container ref set.
    assert.equal(child1.instanceValue(2 /* PROP_INSTANCE_CONTAINER */, 0), 0x100);
    assert.equal(child2.instanceValue(2, 0), 0x100);
  });

  check('pending child → containerOpened deferred until child arrives', () => {
    const w = new WorldState({ logger: silentLog() });
    const container = w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    let firedCount = 0;
    w.addEventListener('containerOpened', () => { firedCount += 1; });
    w.dispatchContainerOpened(0x100, [
      { guid: 0x200, containerType: 1 },
      { guid: 0x300, containerType: 1 },
    ]);
    assert.equal(firedCount, 0, 'should defer until both children present');
    w.dispatchItemCreateObject({ guid: 0x200, classId: 0 });
    assert.equal(firedCount, 0, 'still one missing — should not fire');
    w.dispatchItemCreateObject({ guid: 0x300, classId: 0 });
    assert.equal(firedCount, 1, 'last child arrived — should fire');
    // openContainer is set immediately, not on gate resolution.
    assert.equal(w.openContainer, container);
  });

  check('concurrent gates: A pending, B fires when its children arrive', () => {
    const w = new WorldState({ logger: silentLog() });
    w.dispatchItemCreateObject({ guid: 0xA00, classId: 0 });
    w.dispatchItemCreateObject({ guid: 0xB00, classId: 0 });
    const firedFor = [];
    w.addEventListener('containerOpened', (e) => firedFor.push(e.detail.container.id));
    w.dispatchContainerOpened(0xA00, [{ guid: 0xA10 }]);  // pending: A's child 0xA10
    w.dispatchContainerOpened(0xB00, [{ guid: 0xB10 }]);  // pending: B's child 0xB10
    assert.deepEqual(firedFor, []);
    w.dispatchItemCreateObject({ guid: 0xB10, classId: 0 });
    assert.deepEqual(firedFor, [0xB00], 'B should resolve');
    w.dispatchItemCreateObject({ guid: 0xA10, classId: 0 });
    assert.deepEqual(firedFor, [0xB00, 0xA00], 'A resolves after B');
  });

  check('container weenie not yet arrived → ContainerOpened deferred, no warn', () => {
    const warnings = [];
    const w = new WorldState({ logger: { warn(...a) { warnings.push(a.join(' ')); }, error() {}, info() {}, log() {} } });
    let firedCount = 0;
    w.addEventListener('containerOpened', () => { firedCount += 1; });
    // Open before the container's weenie exists — must NOT warn (race is
    // expected; ACE can publish ContainerOpened before the matching kind=10
    // ObjectCreate lands).
    w.dispatchContainerOpened(0xDEAD, []);
    assert.equal(firedCount, 0, 'no event until weenie arrives');
    assert.equal(warnings.length, 0, `no warn expected on race, got: ${JSON.stringify(warnings)}`);
    // When the weenie arrives, the queued open replays + fires.
    w.dispatchItemCreateObject({ guid: 0xDEAD, classId: 0 });
    assert.equal(firedCount, 1, 'replay fires once');
  });

  check('container-arrives-late → replay propagates children container-ref', () => {
    const w = new WorldState({ logger: silentLog() });
    // Children arrive first, then the open (still pre-container), then container.
    const child1 = w.dispatchItemCreateObject({ guid: 0x200, classId: 0 });
    const child2 = w.dispatchItemCreateObject({ guid: 0x300, classId: 0 });
    let fired = null;
    w.addEventListener('containerOpened', (e) => { fired = e.detail; });
    w.dispatchContainerOpened(0x100, [
      { guid: 0x200, containerType: 1 },
      { guid: 0x300, containerType: 1 },
    ]);
    assert.equal(fired, null, 'still pending — container missing');
    // Now the container weenie arrives → replay fires.
    const container = w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    assert.ok(fired);
    assert.equal(fired.container, container);
    // Children inherit the container-id via the replayed dispatch.
    assert.equal(child1.instanceValue(2 /* PROP_INSTANCE_CONTAINER */, 0), 0x100);
    assert.equal(child2.instanceValue(2, 0), 0x100);
  });

  check('container-arrives-late → second pending child still gated correctly', () => {
    // Container arrives last; one child arrives before, one after.
    const w = new WorldState({ logger: silentLog() });
    w.dispatchItemCreateObject({ guid: 0x200, classId: 0 });
    let firedCount = 0;
    w.addEventListener('containerOpened', () => { firedCount += 1; });
    w.dispatchContainerOpened(0x100, [
      { guid: 0x200, containerType: 1 },
      { guid: 0x300, containerType: 1 },
    ]);
    assert.equal(firedCount, 0, 'container not present yet');
    w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    // Container arrived → replay re-runs. Child 0x300 still missing → gate
    // re-armed at the items level. Should NOT fire yet.
    assert.equal(firedCount, 0, 'second child still missing on replay');
    w.dispatchItemCreateObject({ guid: 0x300, classId: 0 });
    assert.equal(firedCount, 1, 'second child arrived — gate fires once');
  });

  check('container-closed cancels a queued (container-not-arrived) open', () => {
    const w = new WorldState({ logger: silentLog() });
    let firedOpenCount = 0;
    w.addEventListener('containerOpened', () => { firedOpenCount += 1; });
    w.dispatchContainerOpened(0x100, []);  // container weenie missing
    w.dispatchContainerClosed(0x100);       // server cancels (will warn — close path unchanged)
    // Now the container weenie finally arrives — the closed open should NOT fire.
    w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    assert.equal(firedOpenCount, 0, 'queued open should be cancelled by close');
  });

  // ─── [3] Container-closed (World.cs:253-262) ───
  console.log('\n[3] Container-closed dispatch');

  check('dispatchContainerClosed fires containerClosed + clears openContainer', () => {
    const w = new WorldState({ logger: silentLog() });
    const container = w.dispatchItemCreateObject({ guid: 0x100, classId: 0 });
    w.dispatchContainerOpened(0x100, []);
    assert.equal(w.openContainer, container);
    let fired = null;
    w.addEventListener('containerClosed', (e) => { fired = e.detail; });
    w.dispatchContainerClosed(0x100);
    assert.ok(fired);
    assert.equal(fired.container, container);
    assert.equal(w.openContainer, null);
  });

  check('dispatchContainerClosed on unknown container — no throw', () => {
    const w = new WorldState({ logger: silentLog() });
    assert.doesNotThrow(() => w.dispatchContainerClosed(0xDEAD));
  });

  // ─── [4] objectCreated routes through PR 1's setters ───
  console.log('\n[4] objectCreated + setter integration');

  check('weenieDesc folds through PR 1 setIntValue (name/icon/type)', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({
      guid: 0x500,
      classId: 0,
      weenieDesc: { Name: 'Test Sword', Icon: 0x1234, Type: 1 /* MeleeWeapon */ },
    });
    assert.equal(wo.name, 'Test Sword');
    assert.equal(wo.dataValues.get(8), 0x06001234, 'icon should be 0x06000000-ored');
    assert.equal(wo.intValues.get(1), 1);
  });

  check('physicsDesc parent-flag → setInstanceValue(Wielder)', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({
      guid: 0x600,
      classId: 0,
      physicsDesc: { Flags: 0x20, ParentId: 0xABCD },
    });
    assert.equal(wo.instanceValue(3, 0), 0xABCD);
  });

  check('objectCreated bus event fires', () => {
    const w = new WorldState({ logger: silentLog() });
    let detail = null;
    w.addEventListener('objectCreated', (e) => { detail = e.detail; });
    const wo = w.dispatchItemCreateObject({ guid: 0x700, classId: 0 });
    assert.ok(detail);
    assert.equal(detail.object, wo);
  });

  check('dispatchItemCreateObject is idempotent on same GUID (returns existing)', () => {
    const w = new WorldState({ logger: silentLog() });
    const a = w.dispatchItemCreateObject({ guid: 0x800, classId: 0 });
    const b = w.dispatchItemCreateObject({ guid: 0x800, classId: 0 });
    assert.equal(a, b);
    assert.equal(w.count(), 1);
  });

  // ─── [5] ObjectDeleted ───
  console.log('\n[5] ObjectDeleted dispatch');

  check('dispatchItemDeleteObject removes + fires objectReleased', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0x900, classId: 0 });
    let detail = null;
    w.addEventListener('objectReleased', (e) => { detail = e.detail; });
    const ok = w.dispatchItemDeleteObject(0x900);
    assert.equal(ok, true);
    assert.equal(w.count(), 0);
    assert.ok(detail);
    assert.equal(detail.object, wo);
  });

  check('dispatchItemDeleteObject returns false on unknown GUID', () => {
    const w = new WorldState({ logger: silentLog() });
    assert.equal(w.dispatchItemDeleteObject(0xDEAD), false);
  });

  // ─── [6] Various wire dispatchers ───
  console.log('\n[6] ObjDesc / UpdateObject / SetState / Stack / Parent');

  check('dispatchObjDescUpdate routes through wo.updateObjDesc', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xA00, classId: 0 });
    const od = { sub_palettes: [], texture_changes: [] };
    w.dispatchObjDescUpdate(0xA00, od);
    assert.equal(wo.objectDescription, od);
  });

  check('dispatchObjectUpdate folds all three blobs', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xB00, classId: 0 });
    w.dispatchObjectUpdate(0xB00, {
      weenieDesc: { Name: 'Updated', Icon: 0x5678, Type: 2 },
      objDesc: {},
      physicsDesc: { Flags: 0, ParentId: 0 },
    });
    assert.equal(wo.name, 'Updated');
  });

  check('dispatchSetState updates PhysicsState + fires itemStateChanged', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xC00, classId: 0 });
    wo.setIntValue(107 /* PhysicsState */, 0x05);
    let detail = null;
    w.addEventListener('itemStateChanged', (e) => { detail = e.detail; });
    w.dispatchSetState(0xC00, 0x07);
    assert.equal(wo.intValue(107, 0), 0x07);
    assert.ok(detail);
    assert.equal(detail.newState, 0x07);
    assert.equal(detail.previousState, 0x05);
  });

  check('dispatchUpdateStackSize updates both Int props', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xD00, classId: 0 });
    w.dispatchUpdateStackSize(0xD00, 42, 1000);
    assert.equal(wo.intValue(12 /* StackSize */, 0), 42);
    assert.equal(wo.intValue(19 /* Value */, 0), 1000);
  });

  check('dispatchItemParent sets Wielder via setInstanceValue', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xE00, classId: 0 });
    w.dispatchItemParent(0xE00, 0xCAFE);
    assert.equal(wo.instanceValue(3 /* Wielder */, 0), 0xCAFE);
  });

  check('dispatchServerSaysContainId updates Container ref + fires bus', () => {
    const w = new WorldState({ logger: silentLog() });
    const item = w.dispatchItemCreateObject({ guid: 0xE10, classId: 0 });
    w.dispatchItemCreateObject({ guid: 0xE20, classId: 0 });  // parent
    let detail = null;
    w.addEventListener('itemContainerChanged', (e) => { detail = e.detail; });
    w.dispatchServerSaysContainId(0xE10, 0xE20, 3);
    assert.equal(item.instanceValue(2 /* Container */, 0), 0xE20);
    assert.ok(detail);
    assert.equal(detail.slotIndex, 3);
  });

  // ─── [7] Enchantment delta detection ───
  console.log('\n[7] Enchantment snapshot diffing');

  check('first snapshot — all entries emit enchantmentAdded', () => {
    const w = new WorldState({ logger: silentLog() });
    const adds = [];
    w.addEventListener('enchantmentAdded', (e) => adds.push(e.detail.spellId));
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
      { spell_id: 200, layer: 1, power_level: 600, start_time: 0, duration: 60, caster_guid: 1, spell_category: 2 },
    ]);
    assert.deepEqual(adds.sort((a, b) => a - b), [100, 200]);
  });

  check('removed entries emit enchantmentRemoved', () => {
    const w = new WorldState({ logger: silentLog() });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
      { spell_id: 200, layer: 1, power_level: 600, start_time: 0, duration: 60, caster_guid: 1, spell_category: 2 },
    ]);
    const removes = [];
    const adds = [];
    w.addEventListener('enchantmentAdded', (e) => adds.push(e.detail.spellId));
    w.addEventListener('enchantmentRemoved', (e) => removes.push(e.detail.spellId));
    w.dispatchEnchantmentSnapshot([
      { spell_id: 200, layer: 1, power_level: 600, start_time: 0, duration: 60, caster_guid: 1, spell_category: 2 },
    ]);
    assert.deepEqual(removes, [100]);
    assert.deepEqual(adds, []);
  });

  check('same (spellId, layer) twice — no delta event', () => {
    const w = new WorldState({ logger: silentLog() });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    let delta = 0;
    w.addEventListener('enchantmentAdded', () => { delta += 1; });
    w.addEventListener('enchantmentRemoved', () => { delta += 1; });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    assert.equal(delta, 0);
  });

  check('different layers of same spell are distinct (layeredSpellId encoding)', () => {
    const w = new WorldState({ logger: silentLog() });
    const adds = [];
    w.addEventListener('enchantmentAdded', (e) => adds.push([e.detail.spellId, e.detail.enchantment.layer]));
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
      { spell_id: 100, layer: 1, power_level: 700, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    assert.equal(adds.length, 2);
    assert.deepEqual(
      adds.map(([s, l]) => ({ s, l })).sort((a, b) => a.l - b.l),
      [{ s: 100, l: 0 }, { s: 100, l: 1 }],
    );
  });

  check('enchantmentsChanged aggregate fires once per non-empty diff', () => {
    const w = new WorldState({ logger: silentLog() });
    let aggCount = 0;
    let lastAgg = null;
    w.addEventListener('enchantmentsChanged', (e) => {
      aggCount += 1;
      lastAgg = e.detail;
    });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    assert.equal(aggCount, 1);
    assert.equal(lastAgg.added, 1);
    assert.equal(lastAgg.removed, 0);
    // Re-feed identical snapshot — no diff → no aggregate.
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    assert.equal(aggCount, 1);
  });

  // ─── [8] SetAppraiseInfo ───
  console.log('\n[8] SetAppraiseInfo property folding');

  check('intProperties fold through PR 1 setIntValue', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xF00, classId: 0 });
    w.dispatchSetAppraiseInfo(0xF00, {
      intProperties: [[1 /* ItemType */, 7], [19 /* Value */, 1500]],
    });
    assert.equal(wo.intValue(1, 0), 7);
    assert.equal(wo.intValue(19, 0), 1500);
    assert.equal(wo.hasAppraisalData, true);
    assert.ok(wo.lastAppraisalTime instanceof Date);
  });

  check('appraisal — bool/string/float/dataId all routed via setters', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xF10, classId: 0 });
    w.dispatchSetAppraiseInfo(0xF10, {
      boolProperties:   [[100, true]],
      floatProperties:  [[200, 3.14]],
      stringProperties: [[300, 'Sigil of Death']],
      dataIdProperties: [[400, 0xABCD1234]],
    });
    assert.equal(wo.boolValue(100, false), true);
    assert.equal(wo.floatValue(200, 0), 3.14);
    assert.equal(wo.stringValue(300, ''), 'Sigil of Death');
    assert.equal(wo.dataValue(400, 0), 0xABCD1234);
  });

  check('appraisal fires objectAppraised event', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0xF20, classId: 0 });
    let detail = null;
    w.addEventListener('objectAppraised', (e) => { detail = e.detail; });
    w.dispatchSetAppraiseInfo(0xF20, { intProperties: [[1, 7]] });
    assert.ok(detail);
    assert.equal(detail.object, wo);
    assert.deepEqual(detail.properties.ints, [[1, 7]]);
  });

  // ─── [9] Selection bookkeeping ───
  console.log('\n[9] Selection bookkeeping');

  check('setSelected updates `selected` + fires selectionChanged', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0x1100, classId: 0 });
    let detail = null;
    w.addEventListener('selectionChanged', (e) => { detail = e.detail; });
    w.setSelected(0x1100);
    assert.equal(w.selected, wo);
    assert.ok(detail);
    assert.equal(detail.object, wo);
    assert.equal(detail.previous, null);
  });

  check('setSelected(0) deselects', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0x1200, classId: 0 });
    w.setSelected(0x1200);
    let detail = null;
    w.addEventListener('selectionChanged', (e) => { detail = e.detail; });
    w.setSelected(0);
    assert.equal(w.selected, null);
    assert.equal(detail.previous, wo);
  });

  check('setSelected on unknown GUID → selected becomes null', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setSelected(0xDEADBEEF);
    assert.equal(w.selected, null);
  });

  // ─── [10] reset + dispose ───
  console.log('\n[10] reset + dispose');

  check('reset clears all state', () => {
    const w = new WorldState({ logger: silentLog() });
    w.dispatchItemCreateObject({ guid: 0x1300, classId: 0 });
    w.dispatchContainerOpened(0x1300, []);
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    w.reset();
    assert.equal(w.count(), 0);
    assert.equal(w.openContainer, null);
    assert.equal(w.selected, null);
    // After reset, a feed of the same snapshot fires Add again — because
    // the diff state cleared.
    let firedAgain = false;
    w.addEventListener('enchantmentAdded', () => { firedAgain = true; });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 0, duration: 60, caster_guid: 1, spell_category: 1 },
    ]);
    assert.equal(firedAgain, true);
  });

  check('dispose makes dispatchers no-op', () => {
    const w = new WorldState({ logger: silentLog() });
    w.dispose();
    let fired = false;
    w.addEventListener('objectCreated', () => { fired = true; });
    const result = w.dispatchItemCreateObject({ guid: 0x1400, classId: 0 });
    assert.equal(result, null);
    assert.equal(fired, false);
  });

  // ─── Summary ───
  console.log('\n========');
  console.log(`${passed} passed, ${failed} failed (total ${passed + failed} assertions)`);
  console.log('========');

  if (failed > 0) {
    console.log('\nFailures:');
    for (const { name, err } of failures) {
      console.log(`  ${name}\n    ${err.stack || err.message}`);
    }
    process.exit(1);
  }
})();
