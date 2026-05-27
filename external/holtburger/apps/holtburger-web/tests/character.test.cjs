// ACPlugin PR-4 (2026-05-27) — unit tests for the ported `Character.cs`
// (plugins/world-objects/character.js + WorldState integration).
//
// Coverage (one test block per Character.cs region — ports of the
// load-bearing semantics called out in the handoff §3 gotchas):
//
//   [1] Construction + heritage getter   (Character.cs:53-110)
//   [2] Vitae 1.0=none semantics + event (Character.cs:79-88 + handoff §3 row 4)
//   [3] UpdateVital even/odd parity      (Character.cs:713-745 + handoff §3 row 5)
//   [4] Enchantment apply + tiebreak     (Character.cs:613-639, 230-239 + handoff §3 row 7)
//   [5] Cooldown discriminator           (Character.cs:619 + handoff §3 row 5)
//   [6] SharedCooldown sign-extend       (SharedCooldown.cs:55 + handoff §3 row 5)
//   [7] Skill / attribute updates        (Character.cs:665-755)
//   [8] applyLoginPlayerDescription      (Character.cs:380-449)
//   [9] applyEffectsPlayerTeleport       (Character.cs:468-471)
//  [10] applyItemSetState                (Character.cs:461-466)
//  [11] applyCombatHandlePlayerDeath     (Character.cs:455-459) — self-filter
//  [12] Bulk magic ops + purges          (Character.cs:564-610)
//  [13] PrivateUpdate* property family   (Character.cs:473-562 + handoff §3 row 6)
//  [14] clear() + relogin                (Character.cs:764-783)
//  [15] WorldState integration           (PR 4 — local-player Character spawn)
//
// Run from apps/holtburger-web/:
//   node tests/character.test.cjs
// Exits 0 on full pass, 1 on any assertion failure.

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const CHAR_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-objects', 'character.js')
).href;
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
  const { Character } = await import(CHAR_URL);
  const { WorldState } = await import(WS_URL);
  const { WorldObject } = await import(WO_URL);

  // ─── [1] Construction + heritage getter ───
  console.log('\n[1] Construction + heritage getter');

  check('Character extends Container → instanceof WorldObject', () => {
    const c = new Character(0x12345678, 0xa9b4);
    assert.ok(c instanceof WorldObject, 'Character should ultimately extend WorldObject');
    assert.equal(c.id, 0x12345678);
    assert.equal(c.classId, 0xa9b4);
  });

  check('Character starts with empty dicts + vitae=1 + inPortalSpace=true', () => {
    const c = new Character(0x100, 0);
    assert.equal(c.vitae, 1.0);
    assert.equal(c.inPortalSpace, true);
    assert.equal(c.skills.size, 0);
    assert.equal(c.attributes.size, 0);
    assert.equal(c.vitals.size, 0);
    assert.equal(c.allEnchantments.size, 0);
    assert.equal(c.sharedCooldowns.size, 0);
  });

  check('heritage getter reads PropertyInt.HeritageGroup', () => {
    const c = new Character(0x100, 0);
    c.setIntValue(188 /* HeritageGroup */, 5 /* Aluvian */);
    assert.equal(c.heritage, 5);
  });

  // ─── [2] Vitae semantics + event ───
  console.log('\n[2] Vitae 1.0=none semantics (handoff §3 row 4)');

  check('Vitae 1.0 = no vitae, 0.95 = 5% vitae (DO NOT INVERT)', () => {
    const c = new Character(0x100, 0);
    assert.equal(c.vitae, 1.0, 'starts at 1.0 = no vitae');
    c.vitae = 0.95;
    assert.equal(c.vitae, 0.95, 'unchanged from server value — NOT inverted');
  });

  check('setting vitae fires vitaeChanged with {vitae, oldVitae}', () => {
    const c = new Character(0x100, 0);
    let detail = null;
    c.addEventListener('vitaeChanged', (e) => { detail = e.detail; });
    c.vitae = 0.90;
    assert.ok(detail);
    assert.equal(detail.vitae, 0.90);
    assert.equal(detail.oldVitae, 1.0);
  });

  check('setting vitae to same value is a no-op (no event)', () => {
    const c = new Character(0x100, 0);
    c.vitae = 0.95;
    let count = 0;
    c.addEventListener('vitaeChanged', () => { count += 1; });
    c.vitae = 0.95;
    assert.equal(count, 0);
  });

  // ─── [3] UpdateVital even/odd parity ───
  console.log('\n[3] UpdateVital even/odd parity (handoff §3 row 5)');

  check('vitals keyed by ODD canonical id (Health=1, Stamina=3, Mana=5)', () => {
    const c = new Character(0x100, 0);
    // Even key 2 (Health current) → bundle keyed at odd id 1.
    c.updateVital(2, { current: 50, attribute: { innatePoints: 100, pointsRaised: 0 } });
    assert.equal(c.vitals.size, 1);
    assert.ok(c.vitals.has(1), 'vital must be keyed by odd id 1, not even 2');
    assert.equal(c.vitals.get(1).current, 50);
  });

  check('updateVital initial=true: seeds current, NO vitalChanged event fires', () => {
    const c = new Character(0x100, 0);
    let fired = 0;
    c.addEventListener('vitalChanged', () => { fired += 1; });
    c.updateVital(2, { current: 80, attribute: { innatePoints: 100 } }, /*isInitial=*/true);
    assert.equal(fired, 0);
    assert.equal(c.vitals.get(1).current, 80);
  });

  check('updateVital initial=false + even key: vitalChanged fires with prev/new', () => {
    const c = new Character(0x100, 0);
    c.updateVital(2, { current: 80, attribute: { innatePoints: 100 } }, true);
    let detail = null;
    c.addEventListener('vitalChanged', (e) => { detail = e.detail; });
    c.updateVital(2, { current: 60 }, /*isInitial=*/false);
    assert.ok(detail, 'vitalChanged should fire on even-key non-initial');
    assert.equal(detail.type, 1, 'event payload must report ODD canonical type id');
    assert.equal(detail.value, 60);
    assert.equal(detail.oldValue, 80);
  });

  check('updateVital initial=false + ODD key: NO vitalChanged event', () => {
    const c = new Character(0x100, 0);
    c.updateVital(1, { current: 80, attribute: { innatePoints: 100 } }, true);
    let fired = 0;
    c.addEventListener('vitalChanged', () => { fired += 1; });
    // Per Character.cs:721 — odd key + isInitial=false short-circuits.
    c.updateVital(1, { current: 60 }, false);
    assert.equal(fired, 0, 'odd key with isInitial=false must not fire event');
  });

  check('updateVitalCurrent: even key required, fires with odd-translated type', () => {
    const c = new Character(0x100, 0);
    c.updateVital(2, { current: 100, attribute: { innatePoints: 100 } }, true);
    let detail = null;
    c.addEventListener('vitalChanged', (e) => { detail = e.detail; });
    c.updateVitalCurrent(2 /* even = current */, 75);
    assert.ok(detail);
    assert.equal(detail.type, 1, 'odd canonical Health=1');
    assert.equal(detail.value, 75);
  });

  // ─── [4] Enchantment apply + tiebreak ───
  console.log('\n[4] Enchantment apply + tiebreak (handoff §3 row 7)');

  check('applyEnchantment lands in allEnchantments + fires Added event', () => {
    const c = new Character(0x100, 0);
    let detail = null;
    c.addEventListener('enchantmentChanged', (e) => { detail = e.detail; });
    c.applyEnchantment({
      spellId: 100, layer: 0, type: 0x0000001 /* Attribute */, statKey: 1,
      statValue: 10, power: 500, startTime: 1000, duration: 60,
      spellCategory: 7,
    });
    assert.equal(c.allEnchantments.size, 1);
    assert.ok(detail);
    assert.equal(detail.type, 0 /* Added */);
    assert.equal(detail.spellId, 100);
    assert.equal(detail.enchantment.power, 500);
  });

  check('tiebreak: higher power wins within category', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, statKey: 1, power: 400, startTime: 1000, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1, statKey: 1, power: 600, startTime: 2000, spellCategory: 7 });
    const active = c.getActiveEnchantments('attribute', 1);
    assert.equal(active.length, 1);
    assert.equal(active[0].spellId, 200, 'higher power should win');
  });

  check('tiebreak: tied power → newer startTime wins (non-set)', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, statKey: 1, power: 500, startTime: 1000, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1, statKey: 1, power: 500, startTime: 2000, spellCategory: 7 });
    const active = c.getActiveEnchantments('attribute', 1);
    assert.equal(active.length, 1);
    assert.equal(active[0].spellId, 200, 'newer startTime should win on power tie');
  });

  check('tiebreak: level-8-aura-self beats non-aura on tied power', () => {
    const c = new Character(0x100, 0);
    // 4395 is in the level-8 aura self spells fallback list.
    c.applyEnchantment({ spellId: 4395, layer: 0, type: 1, statKey: 1, power: 500, startTime: 1000, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200,  layer: 0, type: 1, statKey: 1, power: 500, startTime: 5000, spellCategory: 7 });
    const active = c.getActiveEnchantments('attribute', 1);
    assert.equal(active[0].spellId, 4395, 'level-8 aura self must beat non-aura even with older startTime');
  });

  check('multiple spell categories → multiple active entries', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, statKey: 1, power: 500, startTime: 1000, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1, statKey: 1, power: 600, startTime: 2000, spellCategory: 8 });
    const active = c.getActiveEnchantments('attribute', 1);
    assert.equal(active.length, 2);
  });

  check('getEnchantmentsAdditiveModifier sums Additive entries only', () => {
    const c = new Character(0x100, 0);
    // Additive flag = 0x8000.
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1 | 0x8000, statKey: 1, statValue: 10, power: 500, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1 | 0x8000, statKey: 1, statValue: 5,  power: 400, spellCategory: 8 });
    // Non-additive — should be ignored.
    c.applyEnchantment({ spellId: 300, layer: 0, type: 1,          statKey: 1, statValue: 99, power: 600, spellCategory: 9 });
    assert.equal(c.getEnchantmentsAdditiveModifier('attribute', 1), 15);
  });

  check('getEnchantmentsMultiplierModifier multiplies Multiplicative entries', () => {
    const c = new Character(0x100, 0);
    // Multiplicative flag = 0x4000.
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1 | 0x4000, statKey: 1, statValue: 1.2, power: 500, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1 | 0x4000, statKey: 1, statValue: 1.1, power: 400, spellCategory: 8 });
    const m = c.getEnchantmentsMultiplierModifier('attribute', 1);
    assert.ok(Math.abs(m - 1.32) < 1e-6, `expected 1.32 (1.2 * 1.1), got ${m}`);
  });

  check('removeEnchantment fires Removed event + cleans dict', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, statKey: 1, power: 500, spellCategory: 7 });
    let detail = null;
    c.addEventListener('enchantmentChanged', (e) => { if (e.detail.type === 1) detail = e.detail; });
    c.removeEnchantment({ id: 100, layer: 0 });
    assert.ok(detail);
    assert.equal(c.allEnchantments.size, 0);
  });

  // ─── [5] Cooldown discriminator ───
  console.log('\n[5] Cooldown discriminator (handoff §3 row 5)');

  check('enchantment with COOLDOWN flag (0x1000000) routes to sharedCooldowns', () => {
    const c = new Character(0x100, 0);
    let cdFired = null;
    let enFired = null;
    c.addEventListener('sharedCooldownChanged', (e) => { cdFired = e.detail; });
    c.addEventListener('enchantmentChanged', (e) => { enFired = e.detail; });
    c.applyEnchantment({
      spellId: 100, layer: 0, type: 0x1000000, /* COOLDOWN */
      statKey: 0, statValue: 0, startTime: 5000, duration: 30,
    });
    assert.equal(c.sharedCooldowns.size, 1);
    assert.equal(c.allEnchantments.size, 0, 'should NOT have hit allEnchantments');
    assert.ok(cdFired, 'sharedCooldownChanged should fire');
    assert.equal(enFired, null, 'enchantmentChanged should NOT fire for cooldowns');
  });

  check('enchantment without COOLDOWN flag stays in allEnchantments', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({
      spellId: 100, layer: 0, type: 0x0000001 /* Attribute */, statKey: 1,
      statValue: 10, power: 500, spellCategory: 7,
    });
    assert.equal(c.allEnchantments.size, 1);
    assert.equal(c.sharedCooldowns.size, 0);
  });

  check('mixed COOLDOWN + Attribute flag → routes to cooldown (Cooldown wins)', () => {
    const c = new Character(0x100, 0);
    // Even with other flags set, COOLDOWN bit forces the cooldown route.
    c.applyEnchantment({
      spellId: 100, layer: 0, type: 0x1000001, statKey: 0, statValue: 0,
      startTime: 1000, duration: 30,
    });
    assert.equal(c.sharedCooldowns.size, 1);
    assert.equal(c.allEnchantments.size, 0);
  });

  check('vitae spell (id=666) sets vitae directly, not in allEnchantments', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({
      spellId: 666, /* vitae */ layer: 0, type: 0x0800000,
      statValue: 0.95,
    });
    assert.equal(c.vitae, 0.95);
    assert.equal(c.allEnchantments.size, 0);
    assert.equal(c.sharedCooldowns.size, 0);
  });

  check('removing vitae spell resets vitae to 1.0', () => {
    const c = new Character(0x100, 0);
    c.vitae = 0.85;
    c.removeEnchantment({ id: 666, layer: 0 });
    assert.equal(c.vitae, 1.0);
  });

  // ─── [6] SharedCooldown sign-extend ───
  console.log('\n[6] SharedCooldown sign-extend (SharedCooldown.cs:55)');

  check('Character.signExtendLow12 preserves sign on low-12 bits', () => {
    // 0xFFF = 4095. After `<< 20 >> 20` it becomes -1 (sign-extended).
    assert.equal(Character.signExtendLow12(0xFFF), -1);
    // 0x800 = 2048 has high bit of 12-bit set → -2048 after sign-extend.
    assert.equal(Character.signExtendLow12(0x800), -2048);
    // 0x7FF = 2047 has high bit clear → +2047 stays.
    assert.equal(Character.signExtendLow12(0x7FF), 2047);
    // Upper bits ignored.
    assert.equal(Character.signExtendLow12(0xABCD0FFF), -1);
  });

  // ─── [7] Skill / attribute updates ───
  console.log('\n[7] Skill / attribute updates');

  check('updateAttribute creates bundle', () => {
    const c = new Character(0x100, 0);
    c.updateAttribute(1, { innatePoints: 100, pointsRaised: 50, experienceSpent: 12345 });
    const a = c.attributes.get(1);
    assert.equal(a.innatePoints, 100);
    assert.equal(a.pointsRaised, 50);
    assert.equal(a.experience, 12345);
  });

  check('updateAttributePointsRaised updates only the rank', () => {
    const c = new Character(0x100, 0);
    c.updateAttribute(1, { innatePoints: 100, pointsRaised: 50 });
    c.updateAttributePointsRaised(1, 60);
    assert.equal(c.attributes.get(1).pointsRaised, 60);
    assert.equal(c.attributes.get(1).innatePoints, 100, 'innate should be preserved');
  });

  check('updateSkill creates bundle with all fields', () => {
    const c = new Character(0x100, 0);
    c.updateSkill(1 /* Axe */, {
      adjustPP: 1, innatePoints: 100, lastUsedTime: 12.3,
      pointsRaised: 25, resistanceOfLastCheck: 30, trainingLevel: 2,
      experienceSpent: 5000,
    });
    const s = c.skills.get(1);
    assert.equal(s.adjustXP, 1);
    assert.equal(s.initLevel, 100);
    assert.equal(s.pointsRaised, 25);
    assert.equal(s.training, 2);
    assert.equal(s.experience, 5000);
  });

  check('updateSkillTraining preserves other fields', () => {
    const c = new Character(0x100, 0);
    c.updateSkill(1, { innatePoints: 100, pointsRaised: 25, trainingLevel: 2 });
    c.updateSkillTraining(1, 3 /* Specialized */);
    assert.equal(c.skills.get(1).training, 3);
    assert.equal(c.skills.get(1).initLevel, 100);
  });

  // ─── [8] applyLoginPlayerDescription ───
  console.log('\n[8] applyLoginPlayerDescription');

  check('hydrates options + attributes + vitals + skills from payload', () => {
    const c = new Character(0x100, 0);
    c.applyLoginPlayerDescription({
      options: 0xABCD,
      attributes: [
        { type: 1, innatePoints: 100, pointsRaised: 50 },
        { type: 6, innatePoints: 90,  pointsRaised: 40 },
      ],
      vitals: [
        { type: 1, current: 200, attribute: { innatePoints: 100, pointsRaised: 0 } },
      ],
      skills: [
        { type: 1, innatePoints: 100, pointsRaised: 25, trainingLevel: 2 },
      ],
      enchantments: [
        { spellId: 100, layer: 0, type: 1, statKey: 1, power: 500, spellCategory: 7 },
      ],
      intProperties: [[107, 4]], // PhysicsState
    });
    assert.equal(c.options1, 0xABCD);
    assert.equal(c.attributes.size, 2);
    assert.equal(c.vitals.size, 1);
    assert.equal(c.skills.size, 1);
    assert.equal(c.allEnchantments.size, 1);
    assert.equal(c.intValue(107, 0), 4);
  });

  // ─── [9] applyEffectsPlayerTeleport ───
  console.log('\n[9] applyEffectsPlayerTeleport (Character.cs:468-471)');

  check('sets inPortalSpace=true + fires portalSpaceEntered', () => {
    const c = new Character(0x100, 0);
    c.inPortalSpace = false;
    let fired = 0;
    c.addEventListener('portalSpaceEntered', () => { fired += 1; });
    c.applyEffectsPlayerTeleport();
    assert.equal(c.inPortalSpace, true);
    assert.equal(fired, 1);
  });

  // ─── [10] applyItemSetState ───
  console.log('\n[10] applyItemSetState (Character.cs:461-466)');

  check('local player clearing Hidden bit fires portalSpaceExited', () => {
    const c = new Character(0x100, 0);
    c.inPortalSpace = true;
    let fired = 0;
    c.addEventListener('portalSpaceExited', () => { fired += 1; });
    // PhysicsState bits without Hidden (0x40).
    c.applyItemSetState(0x100, 0x05);
    assert.equal(c.inPortalSpace, false);
    assert.equal(fired, 1);
  });

  check('non-self GUID ignored', () => {
    const c = new Character(0x100, 0);
    c.inPortalSpace = true;
    let fired = 0;
    c.addEventListener('portalSpaceExited', () => { fired += 1; });
    c.applyItemSetState(0x999, 0x05);
    assert.equal(c.inPortalSpace, true);
    assert.equal(fired, 0);
  });

  check('Hidden bit still set → does NOT exit portal space', () => {
    const c = new Character(0x100, 0);
    c.inPortalSpace = true;
    let fired = 0;
    c.addEventListener('portalSpaceExited', () => { fired += 1; });
    c.applyItemSetState(0x100, 0x05 | 0x40 /* with Hidden */);
    assert.equal(c.inPortalSpace, true);
    assert.equal(fired, 0);
  });

  // ─── [11] applyCombatHandlePlayerDeath ───
  console.log('\n[11] applyCombatHandlePlayerDeath (self-filter)');

  check('self-death fires `death` event', () => {
    const c = new Character(0x100, 0);
    let detail = null;
    c.addEventListener('death', (e) => { detail = e.detail; });
    c.applyCombatHandlePlayerDeath('You have been slain!', 0x100, 0x999);
    assert.ok(detail);
    assert.equal(detail.text, 'You have been slain!');
    assert.equal(detail.killerId, 0x999);
  });

  check('remote-death NOT surfaced', () => {
    const c = new Character(0x100, 0);
    let fired = 0;
    c.addEventListener('death', () => { fired += 1; });
    c.applyCombatHandlePlayerDeath('Foo slain by Bar!', 0xBEEF, 0xCAFE);
    assert.equal(fired, 0);
  });

  // ─── [12] Bulk magic ops + purges ───
  console.log('\n[12] Bulk magic ops + purges');

  check('applyMagicUpdateMultipleEnchantments folds all entries', () => {
    const c = new Character(0x100, 0);
    c.applyMagicUpdateMultipleEnchantments([
      { spellId: 100, layer: 0, type: 1, statKey: 1, power: 500, spellCategory: 7 },
      { spellId: 200, layer: 0, type: 1, statKey: 1, power: 400, spellCategory: 8 },
      { spellId: 300, layer: 0, type: 1, statKey: 1, power: 300, spellCategory: 9 },
    ]);
    assert.equal(c.allEnchantments.size, 3);
  });

  check('applyMagicPurgeEnchantments wipes duration>0 entries', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, duration: 60, power: 500, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1, duration: 0,  power: 400, spellCategory: 8 });
    c.applyMagicPurgeEnchantments();
    assert.equal(c.allEnchantments.size, 1, 'perm enchantment (duration=0) should survive');
    assert.equal([...c.allEnchantments.values()][0].spellId, 200);
  });

  check('applyMagicPurgeBadEnchantments wipes statValue<0 with duration>0', () => {
    const c = new Character(0x100, 0);
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, statValue: -5,  duration: 60, power: 500, spellCategory: 7 });
    c.applyEnchantment({ spellId: 200, layer: 0, type: 1, statValue: 10,  duration: 60, power: 400, spellCategory: 8 });
    c.applyMagicPurgeBadEnchantments();
    assert.equal(c.allEnchantments.size, 1);
    assert.equal([...c.allEnchantments.values()][0].spellId, 200, 'positive buff should survive');
  });

  // ─── [13] PrivateUpdate* property family ───
  console.log('\n[13] PrivateUpdate* property family (handoff §3 row 6)');

  check('privateUpdateInt routes through inherited setIntValue', () => {
    const c = new Character(0x100, 0);
    c.privateUpdateInt(95, 7);  // RadarBlipColor
    assert.equal(c.intValue(95, 0), 7);
  });
  check('privateUpdateFloat / Bool / String / Instance / Data / Position', () => {
    const c = new Character(0x100, 0);
    c.privateUpdateFloat(100, 3.14);
    c.privateUpdateBool(50, true);
    c.privateUpdateString(7, 'Name');
    c.privateUpdateInstance(3, 0xCAFE);
    c.privateUpdateData(8, 0x06001234);
    c.privateUpdatePosition(100, { x: 1, y: 2 });
    assert.equal(c.floatValue(100, 0), 3.14);
    assert.equal(c.boolValue(50, false), true);
    assert.equal(c.stringValue(7, ''), 'Name');
    assert.equal(c.instanceValue(3, 0), 0xCAFE);
    assert.equal(c.dataValue(8, 0), 0x06001234);
    assert.deepEqual(c.positionValue(100, null), { x: 1, y: 2 });
  });
  check('privateRemoveInt deletes the value', () => {
    const c = new Character(0x100, 0);
    c.privateUpdateInt(95, 7);
    c.privateRemoveInt(95);
    assert.equal(c.hasIntValue(95), false);
  });

  // ─── [14] clear() + relogin ───
  console.log('\n[14] clear() — Character.cs:764-783');

  check('clear resets all dicts + vitae=1', () => {
    const c = new Character(0x100, 0);
    c.options1 = 0xABCD;
    c.vitae = 0.85;
    c.updateAttribute(1, { innatePoints: 100 });
    c.updateVital(2, { current: 80, attribute: { innatePoints: 100 } }, true);
    c.updateSkill(1, { innatePoints: 50, pointsRaised: 0, trainingLevel: 2 });
    c.applyEnchantment({ spellId: 100, layer: 0, type: 1, power: 500, spellCategory: 7 });
    c.setIntValue(95, 7);
    c.clear();
    assert.equal(c.options1, 0);
    assert.equal(c.vitae, 1.0);
    assert.equal(c.attributes.size, 0);
    assert.equal(c.vitals.size, 0);
    assert.equal(c.skills.size, 0);
    assert.equal(c.allEnchantments.size, 0);
    assert.equal(c.hasIntValue(95), false);
    assert.equal(c.inPortalSpace, true);
  });

  check('clear with prior vitae < 1 fires vitaeChanged → 1.0', () => {
    const c = new Character(0x100, 0);
    c.vitae = 0.85;
    let detail = null;
    c.addEventListener('vitaeChanged', (e) => { detail = e.detail; });
    c.clear();
    assert.ok(detail);
    assert.equal(detail.vitae, 1.0);
    assert.equal(detail.oldVitae, 0.85);
  });

  // ─── [15] WorldState integration ───
  console.log('\n[15] WorldState integration — local-player Character spawn');

  check('setLocalPlayerGuid before spawn → typed Character on dispatch', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0xCAFEBABE);
    const wo = w.dispatchItemCreateObject({ guid: 0xCAFEBABE, classId: 7 });
    assert.ok(wo instanceof Character, 'local-player dispatch must spawn Character');
    assert.equal(w.character, wo, 'world.character should point to the new Character');
  });

  check('non-local-player dispatch is NOT a Character', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    const remote = w.dispatchItemCreateObject({ guid: 0x200, classId: 7 });
    assert.ok(!(remote instanceof Character), 'remote-player dispatch should not be Character');
    assert.equal(w.character, null);
  });

  check('retro-upgrade: spawn before setLocalPlayerGuid → upgrade to Character', () => {
    const w = new WorldState({ logger: silentLog() });
    const wo = w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    assert.ok(!(wo instanceof Character), 'first spawn lands as bare WorldObject');
    // Seed some property data to verify it carries over.
    wo.setIntValue(95, 42);
    wo.setStringValue(1, 'Test Player');
    w.setLocalPlayerGuid(0x100);
    const upgraded = w.weenies.get(0x100);
    assert.ok(upgraded instanceof Character, 'after setLocalPlayerGuid, entry must be Character');
    assert.equal(upgraded.intValue(95, 0), 42, 'property dict should be preserved');
    assert.equal(upgraded.name, 'Test Player');
    assert.equal(w.character, upgraded);
  });

  check('dispatchEnchantmentSnapshot forwards to Character.allEnchantments', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 1000, duration: 60, caster_guid: 1, spell_category: 7 },
      { spell_id: 200, layer: 1, power_level: 600, start_time: 2000, duration: 60, caster_guid: 1, spell_category: 8 },
    ]);
    assert.equal(w.character.allEnchantments.size, 2);
  });

  check('dispatchEnchantmentSnapshot diff propagates removals to Character', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 1000, duration: 60, caster_guid: 1, spell_category: 7 },
      { spell_id: 200, layer: 1, power_level: 600, start_time: 2000, duration: 60, caster_guid: 1, spell_category: 8 },
    ]);
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 500, start_time: 1000, duration: 60, caster_guid: 1, spell_category: 7 },
    ]);
    assert.equal(w.character.allEnchantments.size, 1);
  });

  check('Wave F.2: snapshot with COOLDOWN bit routes into Character.sharedCooldowns', () => {
    // Pre-Wave-F.2 the snapshot diff layer dropped `type`/`statKey`/
    // `statValue`, so the cooldown discriminator in Character (§3 row 5)
    // saw `type=0` and routed cooldowns as ordinary buffs. Wave F.2
    // extends the diff layer to pass the full StatMod tuple through.
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    w.dispatchEnchantmentSnapshot([
      // Normal buff.
      { spell_id: 100, layer: 0, power_level: 100,
        start_time: 0, duration: 60, caster_guid: 1, spell_category: 7,
        stat_mod_type: 0x8001 /* ADDITIVE | ATTRIBUTE */,
        stat_mod_key: 1, stat_mod_value: 10 },
      // Cooldown — distinguished by the COOLDOWN bit.
      { spell_id: 999, layer: 0, power_level: 0,
        start_time: 0, duration: 30, caster_guid: 0, spell_category: 0,
        stat_mod_type: 0x1000000 /* COOLDOWN */,
        stat_mod_key: 0x101, stat_mod_value: 0 },
    ]);
    assert.equal(w.character.allEnchantments.size, 1,
      'only the non-cooldown entry should land in allEnchantments');
    assert.equal(w.character.sharedCooldowns.size, 1,
      'cooldown entry must route to sharedCooldowns via §3 row 5');
  });

  check('Wave F.2: snapshot statValue + statKey + type reach Character record', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    w.dispatchEnchantmentSnapshot([
      { spell_id: 100, layer: 0, power_level: 200,
        start_time: 0, duration: 60, caster_guid: 1, spell_category: 7,
        stat_mod_type: 0x8001, stat_mod_key: 1, stat_mod_value: 60.0 },
    ]);
    const key = ((100 << 16) | 0) >>> 0;
    const ench = w.character.allEnchantments.get(key);
    assert.ok(ench, 'should find the enchantment by layered key');
    assert.equal(ench.type, 0x8001);
    assert.equal(ench.statKey, 1);
    assert.equal(ench.statValue, 60.0);
  });

  check('dispatchEffectsPlayerTeleport reaches the Character', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    w.character.inPortalSpace = false;
    w.dispatchEffectsPlayerTeleport();
    assert.equal(w.character.inPortalSpace, true);
  });

  check('dispatchCombatHandlePlayerDeath only fires for self', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    let fired = 0;
    w.character.addEventListener('death', () => { fired += 1; });
    w.dispatchCombatHandlePlayerDeath('You died!', 0x100, 0x999);
    assert.equal(fired, 1);
    w.dispatchCombatHandlePlayerDeath('Other died!', 0xDEAD, 0x999);
    assert.equal(fired, 1, 'should still be 1 — other death does not match');
  });

  check('dispatchCharacterPrivateQuality routes through Character.private*', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    w.dispatchCharacterPrivateQuality('int', 'update', 95, 42);
    assert.equal(w.character.intValue(95, 0), 42);
    w.dispatchCharacterPrivateQuality('int', 'remove', 95);
    assert.equal(w.character.hasIntValue(95), false);
  });

  check('reset clears world.character but preserves _localPlayerGuid', () => {
    const w = new WorldState({ logger: silentLog() });
    w.setLocalPlayerGuid(0x100);
    w.dispatchItemCreateObject({ guid: 0x100, classId: 7 });
    assert.ok(w.character);
    w.reset();
    assert.equal(w.character, null);
    // _localPlayerGuid persists per the PR-4 comment.
    assert.equal(w._localPlayerGuid, 0x100);
  });

  // ─── Bonus: Wave C.2 wasm export fallback ───
  console.log('\n[Bonus] Wave C.2 fallback when wasm unavailable');

  check('currentAttribute falls back to (innate+raised) without wasm', () => {
    const c = new Character(0x100, 0);
    c.updateAttribute(1, { innatePoints: 100, pointsRaised: 50 });
    // No globalThis.__wasm injected → fallback to base.
    assert.equal(c.currentAttribute(1), 150);
  });

  check('currentAttribute calls wasm computeAttributeCurrent when available', () => {
    const c = new Character(0x100, 0);
    c.updateAttribute(1, { innatePoints: 100, pointsRaised: 50 });
    // Mock the wasm export.
    const calls = [];
    globalThis.__wasm = {
      computeAttributeCurrent(innate, raised, mult, add) {
        calls.push({ innate, raised, mult, add });
        return 999;
      },
    };
    try {
      const got = c.currentAttribute(1);
      assert.equal(got, 999, 'should return wasm result, not fallback');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].innate, 100);
      assert.equal(calls[0].raised, 50);
    } finally {
      delete globalThis.__wasm;
      // Reset Character's cached wasm export — it cached during the call.
      c._wasmExports = null;
    }
  });

  check('maxVital uses default formula for Health when none provided', () => {
    const c = new Character(0x100, 0);
    c.updateAttribute(2, { innatePoints: 100, pointsRaised: 0 });  // Endurance
    c.updateVital(1, { current: 200, attribute: { innatePoints: 200, pointsRaised: 0 } }, true);

    const calls = [];
    globalThis.__wasm = {
      computeVitalMax(vt, init, raised, useF, divisor, a1, a1Base, a2, a2Base, enl, gear, mult, vitae, add) {
        calls.push({ vt, init, raised, useF, divisor, a1, a1Base, a2, a2Base, enl, gear, mult, vitae, add });
        return 250;
      },
    };
    try {
      const got = c.maxVital(1);
      assert.equal(got, 250);
      assert.equal(calls[0].vt, 1);
      assert.equal(calls[0].a1, 2, 'Health default formula uses Endurance');
      assert.equal(calls[0].divisor, 2);
    } finally {
      delete globalThis.__wasm;
      c._wasmExports = null;
    }
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
