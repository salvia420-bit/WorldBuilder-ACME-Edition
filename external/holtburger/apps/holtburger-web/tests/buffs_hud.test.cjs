// =============================================================================
// Wave F.2 (2026-05-27) — buffs / debuffs / cooldowns HUD tests
// =============================================================================
//
// Validates `plugins/buffs-hud.js` against the Wave F.2 spec:
//
//   [1] Classification (buff vs debuff vs cooldown) by EnchantmentTypeFlags
//   [2] Stat-mod formatting (additive vs multiplicative; sign handling)
//   [3] Wire field normalization (snake_case + camelCase + nested)
//   [4] Snapshot ingestion (refreshFromSnapshot)
//       - empty case
//       - cooldown routing
//       - per-(category, layer) tiebreak
//   [5] Character integration (refreshFromCharacter)
//       - tiebreak via getActiveEnchantments()
//       - cooldowns from sharedCooldowns
//   [6] Time formatting (∞ / s / m:ss / h)
//   [7] DOM render smoke (via jsdom-lite shim — overlay structure)
//
// Run from apps/holtburger-web/:
//   node tests/buffs_hud.test.cjs
// =============================================================================

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const BUFFS_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'buffs-hud.js')
).href;
const CHAR_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-objects', 'character.js')
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

// jsdom-lite stub — buffs-hud.js touches `document`, `window`,
// `setInterval`, and `fetch`. We only test the pure helpers + state
// manipulation here, NOT the DOM mount lifecycle (that's an integration
// concern — exercised via the manual `__buffsHudDebug` path). The shim
// is just enough that `import` doesn't throw on top-level access.
function installDomShim() {
  if (typeof globalThis.document !== 'undefined') return;
  const elementProto = {
    appendChild(child) { this.children = this.children || []; this.children.push(child); return child; },
    setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = v; },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    get isConnected() { return true; },
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    get innerHTML() { return this._innerHTML || ''; },
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
  };
  function mkEl() {
    return Object.assign(Object.create(elementProto), {
      attrs: {},
      dataset: {},
      style: {},
      children: [],
      classList: { add() {}, remove() {}, contains: () => false },
    });
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: () => mkEl(),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
  // ac_font.js + ac_icon_cache.js import paths — provide minimal stubs.
  // Since they import via relative path, Node will resolve them; we
  // just need __sessionHandle / __wasm to be undefined so the icon
  // path defensively returns false (the test focuses on classifier +
  // state, not DOM image rendering).
}

(async () => {
  installDomShim();
  const { manifest, classifyEnchantment, formatStatMod, __test } = await import(BUFFS_URL);
  const { ETF, normalizeEnchantment, refreshFromSnapshot,
          refreshFromCharacter, state, remainingSeconds, fmtRemaining } = __test;
  const { Character } = await import(CHAR_URL);

  // ─── [1] Classification ───
  console.log('\n[1] classifyEnchantment — EnchantmentTypeFlags routing');

  check('COOLDOWN bit (0x1000000) → "cooldown"', () => {
    assert.equal(classifyEnchantment({ type: ETF.COOLDOWN }), 'cooldown');
    assert.equal(classifyEnchantment({ type: ETF.COOLDOWN | ETF.ADDITIVE }), 'cooldown');
  });

  check('BENEFICIAL bit (0x2000000) → "buff"', () => {
    assert.equal(classifyEnchantment({ type: ETF.BENEFICIAL }), 'buff');
    // Beneficial overrides negative statValue (some retail spells
    // have negative-value buffs that ARE beneficial — e.g. -damage).
    assert.equal(classifyEnchantment({
      type: ETF.BENEFICIAL | ETF.ADDITIVE, statValue: -5
    }), 'buff');
  });

  check('additive + positive statValue → "buff"', () => {
    assert.equal(classifyEnchantment({
      type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 10
    }), 'buff');
  });

  check('additive + negative statValue → "debuff"', () => {
    assert.equal(classifyEnchantment({
      type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: -10
    }), 'debuff');
  });

  check('multiplicative + >1.0 statValue → "buff"', () => {
    assert.equal(classifyEnchantment({
      type: ETF.MULTIPLICATIVE | ETF.ATTRIBUTE, statValue: 1.25
    }), 'buff');
  });

  check('multiplicative + <1.0 statValue → "debuff"', () => {
    assert.equal(classifyEnchantment({
      type: ETF.MULTIPLICATIVE | ETF.ATTRIBUTE, statValue: 0.75
    }), 'debuff');
  });

  check('unknown flags (no ADDITIVE/MULTIPLICATIVE) → default "buff"', () => {
    assert.equal(classifyEnchantment({ type: ETF.SKILL, statValue: 5 }), 'buff');
  });

  check('null/missing ench → "buff" default (safe)', () => {
    assert.equal(classifyEnchantment(null), 'buff');
    assert.equal(classifyEnchantment({}), 'buff');
  });

  // ─── [2] Stat-mod formatting ───
  console.log('\n[2] formatStatMod — Wave F.2 stat label + sign');

  check('attribute additive positive: "+10 STR"', () => {
    assert.equal(formatStatMod({
      type: ETF.ATTRIBUTE | ETF.ADDITIVE | ETF.SINGLE_STAT,
      statKey: 1, statValue: 10,
    }), '+10 STR');
  });

  check('attribute additive negative: "-5 END"', () => {
    assert.equal(formatStatMod({
      type: ETF.ATTRIBUTE | ETF.ADDITIVE,
      statKey: 2, statValue: -5,
    }), '-5 END');
  });

  check('attribute multiplicative: "x1.25 STR"', () => {
    assert.equal(formatStatMod({
      type: ETF.ATTRIBUTE | ETF.MULTIPLICATIVE,
      statKey: 1, statValue: 1.25,
    }), 'x1.25 STR');
  });

  check('vital additive: "+30 HP"', () => {
    assert.equal(formatStatMod({
      type: ETF.SECOND_ATT | ETF.ADDITIVE,
      statKey: 1, statValue: 30,
    }), '+30 HP');
  });

  check('skill additive: "+50 Run"', () => {
    assert.equal(formatStatMod({
      type: ETF.SKILL | ETF.ADDITIVE,
      statKey: 14, statValue: 50,
    }), '+50 Run');
  });

  check('unknown statKey falls back to "id N"', () => {
    assert.equal(formatStatMod({
      type: ETF.SKILL | ETF.ADDITIVE,
      statKey: 999, statValue: 1,
    }), '+1 id 999');
  });

  check('rounds fractional additive value (no decimals on int additive)', () => {
    // 10.7 → 11 (Math.round)
    assert.equal(formatStatMod({
      type: ETF.ATTRIBUTE | ETF.ADDITIVE,
      statKey: 1, statValue: 10.7,
    }), '+11 STR');
  });

  // ─── [3] Wire field normalization ───
  console.log('\n[3] normalizeEnchantment — snake_case + camelCase both accepted');

  check('snake_case wire shape accepted', () => {
    const n = normalizeEnchantment({
      spell_id: 1158, layer: 0, spell_category: 12,
      power_level: 200, start_time: 1000, duration: 600,
      caster_guid: 0xDEADBEEF, stat_mod_type: 0x8001,
      stat_mod_key: 1, stat_mod_value: 10,
    });
    assert.equal(n.spellId, 1158);
    assert.equal(n.spellCategory, 12);
    assert.equal(n.power, 200);
    assert.equal(n.casterGuid, 0xDEADBEEF);
    assert.equal(n.type, 0x8001);
    assert.equal(n.statKey, 1);
    assert.equal(n.statValue, 10);
  });

  check('camelCase wire shape accepted', () => {
    const n = normalizeEnchantment({
      spellId: 1158, layer: 0, spellCategory: 12,
      powerLevel: 200, startTime: 1000, duration: 600,
      casterGuid: 0xDEADBEEF, type: 0x8001,
      statKey: 1, statValue: 10,
    });
    assert.equal(n.spellId, 1158);
    assert.equal(n.type, 0x8001);
    assert.equal(n.statValue, 10);
  });

  check('layered key packs (spellId << 16 | layer)', () => {
    const n = normalizeEnchantment({ spellId: 0x100, layer: 3 });
    assert.equal(n.layeredId, ((0x100 << 16) | 3) >>> 0);
  });

  // ─── [4] Snapshot ingestion ───
  console.log('\n[4] refreshFromSnapshot — wasm playerEnchantments() shape');

  check('empty snapshot → 0 enchantments, 0 cooldowns', () => {
    refreshFromSnapshot([]);
    assert.equal(state.enchantments.size, 0);
    assert.equal(state.cooldowns.size, 0);
  });

  check('one buff lands in enchantments map', () => {
    refreshFromSnapshot([
      { spellId: 100, layer: 0, spellCategory: 7, powerLevel: 100,
        startTime: 0, duration: 600, casterGuid: 0x1,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE | ETF.BENEFICIAL,
        statKey: 1, statValue: 10 },
    ]);
    assert.equal(state.enchantments.size, 1);
    assert.equal(state.cooldowns.size, 0);
    const ench = [...state.enchantments.values()][0];
    assert.equal(ench.spellId, 100);
    assert.equal(ench.statValue, 10);
  });

  check('cooldown-flagged entry routes into cooldowns map', () => {
    refreshFromSnapshot([
      { spellId: 666, layer: 0, spellCategory: 0, powerLevel: 0,
        startTime: 0, duration: 60, casterGuid: 0,
        type: ETF.COOLDOWN, statKey: 0x101, statValue: 0 },
    ]);
    assert.equal(state.enchantments.size, 0);
    assert.equal(state.cooldowns.size, 1);
  });

  check('mixed snapshot: 2 buffs + 1 cooldown → 2 / 1', () => {
    refreshFromSnapshot([
      { spellId: 100, layer: 0, spellCategory: 7, powerLevel: 100,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 10 },
      { spellId: 200, layer: 0, spellCategory: 8, powerLevel: 100,
        type: ETF.ADDITIVE | ETF.SKILL, statValue: 50, statKey: 14 },
      { spellId: 666, layer: 0, spellCategory: 0, powerLevel: 0,
        type: ETF.COOLDOWN, statKey: 0x101 },
    ]);
    assert.equal(state.enchantments.size, 2);
    assert.equal(state.cooldowns.size, 1);
  });

  check('same (category, layer): higher Power wins — fallback tiebreak', () => {
    refreshFromSnapshot([
      { spellId: 100, layer: 0, spellCategory: 7, powerLevel: 100,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 5, statKey: 1 },
      { spellId: 200, layer: 0, spellCategory: 7, powerLevel: 200,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 10, statKey: 1 },
    ]);
    // Only the higher-power one (spellId 200, power 200) survives.
    assert.equal(state.enchantments.size, 1);
    const winner = [...state.enchantments.values()][0];
    assert.equal(winner.spellId, 200);
    assert.equal(winner.power, 200);
  });

  check('different layers in same category coexist', () => {
    refreshFromSnapshot([
      { spellId: 100, layer: 0, spellCategory: 7, powerLevel: 100,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 5 },
      { spellId: 100, layer: 1, spellCategory: 7, powerLevel: 100,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 6 },
    ]);
    assert.equal(state.enchantments.size, 2);
  });

  // ─── [5] Character integration ───
  console.log('\n[5] refreshFromCharacter — PR 4 typed Character tiebreak');

  check('refreshFromCharacter pulls allEnchantments + sharedCooldowns', () => {
    const c = new Character(0x12345678, 0xa9b4);
    c.applyEnchantment({
      spellId: 100, layer: 0, type: ETF.ADDITIVE | ETF.ATTRIBUTE,
      statKey: 1, statValue: 10, power: 100, startTime: 0,
      duration: 600, spellCategory: 7,
    });
    c.applyEnchantment({
      // Cooldown — discriminator bit set; should land in sharedCooldowns
      // NOT allEnchantments.
      spellId: 999, layer: 0, type: ETF.COOLDOWN,
      statKey: 0x101, statValue: 0, power: 0, startTime: 0,
      duration: 60, spellCategory: 0,
    });
    refreshFromCharacter(c);
    assert.equal(state.enchantments.size, 1);
    assert.equal(state.cooldowns.size, 1);
  });

  check('refreshFromCharacter honors Power-desc tiebreak (only winner shown)', () => {
    const c = new Character(0x12345678, 0xa9b4);
    // Two strength buffs at different powers, same category 7.
    c.applyEnchantment({
      spellId: 100, layer: 0, type: ETF.ADDITIVE | ETF.ATTRIBUTE,
      statKey: 1, statValue: 5, power: 100, startTime: 1000,
      duration: 600, spellCategory: 7,
    });
    c.applyEnchantment({
      spellId: 200, layer: 0, type: ETF.ADDITIVE | ETF.ATTRIBUTE,
      statKey: 1, statValue: 10, power: 300, startTime: 2000,
      duration: 600, spellCategory: 7,
    });
    refreshFromCharacter(c);
    // allEnchantments has both (PR 4 stores per-layeredId, not per-category)
    assert.equal(c.allEnchantments.size, 2);
    // getActiveEnchantments collapses to the per-category winner — buffs-HUD
    // shows ONLY the higher-Power one.
    assert.equal(state.enchantments.size, 1);
    const winner = [...state.enchantments.values()][0];
    assert.equal(winner.spellId, 200);
    assert.equal(winner.power, 300);
  });

  check('refreshFromCharacter with null character = empty maps', () => {
    refreshFromCharacter(null);
    assert.equal(state.enchantments.size, 0);
    assert.equal(state.cooldowns.size, 0);
  });

  // ─── [6] Time formatting ───
  console.log('\n[6] remainingSeconds + fmtRemaining');

  check('duration <= 0 → permanent (∞)', () => {
    assert.equal(remainingSeconds({ duration: 0, startTime: 0 }), Infinity);
    assert.equal(remainingSeconds({ duration: -1, startTime: 0 }), Infinity);
    assert.equal(fmtRemaining(Infinity), '∞');
  });

  check('< 60 s → "Ns"', () => {
    assert.equal(fmtRemaining(45), '45s');
    assert.equal(fmtRemaining(1), '1s');
  });

  check('60 ≤ s < 3600 → "M:SS"', () => {
    assert.equal(fmtRemaining(60), '1:00');
    assert.equal(fmtRemaining(90), '1:30');
    assert.equal(fmtRemaining(3599), '59:59');
  });

  check('≥ 3600 → "Nh"', () => {
    assert.equal(fmtRemaining(3600), '1h');
    assert.equal(fmtRemaining(7200), '2h');
  });

  // ─── [7] Manifest + manifest version stamp ───
  console.log('\n[7] manifest');

  check('manifest reports Wave F.2 version', () => {
    assert.equal(manifest.id, 'buffs-hud');
    assert.equal(manifest.version, '0.3.0');
    assert.ok(manifest.iconHidden);
  });

  // ─── [8] Real wire shape from wasm playerEnchantments() ───
  console.log('\n[8] wasm wire shape contract');

  check('wasm shape (statModType / statModValue) normalizes correctly', () => {
    // Mirrors what PlayerEnchantmentJs.type / statValue produce from
    // wasm-bindgen — camelCase via #[wasm_bindgen(js_name = ...)].
    const n = normalizeEnchantment({
      spellId: 1158, layer: 0, spellCategory: 12,
      powerLevel: 200, startTime: 1000, duration: 600,
      casterGuid: 0xDEADBEEF,
      // Wave F.2 — these are the new getters.
      type: ETF.ADDITIVE | ETF.ATTRIBUTE,
      statKey: 1, statValue: 60,
      hasSpellSetId: 1, spellSetId: 42,
    });
    assert.equal(n.type, ETF.ADDITIVE | ETF.ATTRIBUTE);
    assert.equal(n.statValue, 60);
    assert.equal(n.hasSpellSetId, 1);
    assert.equal(n.spellSetId, 42);
  });

  check('cooldown discriminator works on REAL wire snapshot (Wave F.2 gap closed)', () => {
    // Pre-Wave-F.2 the wasm snapshot dropped the type field, so the
    // cooldown bit was 0 and routing was broken. Wave F.2 fix: the
    // wasm side now copies stat_mod_type verbatim, so a snapshot with
    // a cooldown-flagged entry routes correctly via refreshFromSnapshot
    // (no need to spin up a Character).
    refreshFromSnapshot([
      { spellId: 100, layer: 0, spellCategory: 7, powerLevel: 100,
        type: ETF.ADDITIVE | ETF.ATTRIBUTE, statValue: 10 },
      { spellId: 999, layer: 0, spellCategory: 0, powerLevel: 0,
        type: ETF.COOLDOWN, statKey: 0x101 },
    ]);
    assert.equal(state.enchantments.size, 1,
      'cooldown entry should NOT land in enchantments map');
    assert.equal(state.cooldowns.size, 1,
      'cooldown entry should land in cooldowns map');
    const cd = [...state.cooldowns.values()][0];
    assert.equal((cd.type & ETF.COOLDOWN), ETF.COOLDOWN);
  });

  console.log('\n========');
  console.log(`${passed} passed, ${failed} failed (total ${passed + failed} assertions)`);
  console.log('========');
  if (failed > 0) {
    for (const f of failures) {
      console.log(`\n  - ${f.name}`);
      console.log(`    ${f.err.stack || f.err.message}`);
    }
    process.exit(1);
  }
})();
