// =============================================================================
// WS15 (2026-07-12) — void/life DoT enchantment labeling + classification
// =============================================================================
//
// Guards patch 3-A of the WS15 packet
// (docs/spellcasting-packets-2026-07-12/WS15-war-void-endtoend.md):
//   plugins/buffs-hud.js  formatStatMod   → labels DoT PropertyInts
//   plugins/buffs-hud.js  classifyEnchantment → DoTs are always debuffs
//
// Void (and Life) damage-over-time enchantments modify the NetherOverTime
// (PropertyInt 330) / DamageOverTime (318) stats. Their per-tick "value" is
// a POSITIVE damage number, so before this patch:
//   - formatStatMod found no ATTRIBUTE/SECOND_ATT/SKILL name → "+19 id 330"
//     (illegible; the "+" reads as a buff).
//   - classifyEnchantment's record-less fallback (pre-login catalog / record
//     lookup miss) reached the additive-sign heuristic (val ≥ 0 → "buff") and
//     mislabeled the DoT as a beneficial buff.
//
// Pure JS, no wasm / 3D. Run from apps/holtburger-web/:
//   node tests/ws15_dot_enchantment_label.test.cjs
// =============================================================================

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const BUFFS_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'buffs-hud.js')
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

// jsdom-lite stub — buffs-hud.js touches document/window/setInterval/fetch
// at import time. We only exercise the pure helpers, so the shim just has to
// keep `import` from throwing on top-level access.
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
      attrs: {}, dataset: {}, style: {}, children: [],
      classList: { add() {}, remove() {}, contains: () => false },
    });
  }
  globalThis.document = {
    head: mkEl(), body: mkEl(),
    createElement: () => mkEl(),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
}

(async () => {
  installDomShim();
  const { classifyEnchantment, formatStatMod } = await import(BUFFS_URL);

  // Corrosion I: NetherOverTime(330), +19/tick, enchant-type flag 0x9004
  //   (INT | SINGLE_STAT | ADDITIVE — BENEFICIAL bit unset).
  const corrosion = { spellId: 5387, statModType: 0x9004, statModKey: 330, statModValue: 19 };
  // Life DoT (Surge of Affliction family): DamageOverTime(318), no spell record.
  const surge = { spellId: 0, statModType: 0x9004, statModKey: 318, statModValue: 12 };
  // Control: a real STR buff must be untouched by the DoT guard.
  const strBuff = { spellId: 1, statModType: 0x2009001, statModKey: 1, statModValue: 10 };

  // ─── [1] formatStatMod labels DoTs (record-independent) ───
  console.log('\n[1] formatStatMod labels DoTs');
  check('Corrosion → "19/tick Nether DoT"', () => {
    assert.equal(formatStatMod(corrosion), '19/tick Nether DoT');
  });
  check('Surge → "12/tick DoT"', () => {
    assert.equal(formatStatMod(surge), '12/tick DoT');
  });
  check('STR buff unchanged → "+10 STR"', () => {
    assert.equal(formatStatMod(strBuff), '+10 STR');
  });
  // Verifier non-blocking note: the DoT label is applied purely on the stat
  // key (no spell-record dependency), so it improves BOTH the record-present
  // (live-client) and record-less (fallback) paths identically.
  check('DoT label ignores spell record (improves both paths)', () => {
    const withRecord = { spellId: 5387, statModType: 0x9004, statModKey: 330, statModValue: 19 };
    const withoutRecord = { spellId: 0, statModType: 0x9004, statModKey: 330, statModValue: 19 };
    assert.equal(formatStatMod(withRecord), '19/tick Nether DoT');
    assert.equal(formatStatMod(withoutRecord), '19/tick Nether DoT');
  });
  // Zero-value DoT layer (freshly landed, no tick amount yet) still labels,
  // without a misleading "0/tick" prefix.
  check('zero-value DoT → bare label', () => {
    assert.equal(formatStatMod({ statModType: 0x9004, statModKey: 330, statModValue: 0 }), 'Nether DoT');
  });

  // ─── [2] classifyEnchantment: a DoT is a debuff even without a record ───
  console.log('\n[2] classifyEnchantment DoT keys → debuff (record-less fallback)');
  check('Corrosion (330) → "debuff"', () => {
    assert.equal(classifyEnchantment(corrosion), 'debuff');
  });
  check('Surge (318) → "debuff"', () => {
    assert.equal(classifyEnchantment(surge), 'debuff');
  });
  // Regression guard: a genuine additive-positive attribute buff (non-DoT
  // key) must still classify as a buff via the existing sign heuristic.
  check('STR buff (key 1) still → "buff" in fallback', () => {
    assert.equal(classifyEnchantment(strBuff), 'buff');
  });

  console.log(`\n=== WS15 DoT label — ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    for (const { name, err } of failures) console.error(`FAIL: ${name}\n  ${err.stack || err}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
