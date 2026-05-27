// Wave F.1 (2026-05-27) — Node smoke test for the JS-side hybrid
// catalog that prefers wasm-decoded SpellBase records over the
// LSD-derived `data/spells-catalog.json` fallback.
//
// We can't import `plugins/spellbook.js` directly (it requires DOM,
// AC font, plugin API surface — none available in Node). Instead, we
// reproduce the `makeHybridCatalog` Proxy locally and exercise the
// merge contract against synthetic JSON + wasm-mock data. The Proxy
// itself is pure JS — testing it here catches regressions in the
// merge logic without booting a browser.
//
// Run:
//   node tests/spellbook_wasm_record.test.cjs

'use strict';

const assert = require('node:assert/strict');

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

// Local copy of the contract under test. Keep in sync with
// `plugins/spellbook.js::makeHybridCatalog`.
function spellRecordFromWasm(spellId, mockHandle) {
  if (!mockHandle?.getSpellRecord) return null;
  let raw;
  try {
    raw = mockHandle.getSpellRecord(spellId);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  return {
    name:        raw.name,
    school:      raw.school,
    level:       raw.roughLevel ?? 0,
    levelRoman:  raw.levelRoman ?? "",
    untargeted:  !!raw.isSelfTargeted,
    mana:        raw.baseMana,
    icon:        raw.iconId,
    desc:        raw.description,
    duration:    raw.duration ?? 0,
    components:  Array.isArray(raw.components) ? raw.components : [],
    _waveF1:     true,
    bitfield:    raw.bitfield,
    flags:       raw.flags,
    isFastCast:  raw.isFastCast,
    isBeneficial: raw.isBeneficial,
    metaSpellType: raw.metaSpellType,
    metaSpellTypeName: raw.metaSpellTypeName,
    baseRangeConstant: raw.baseRangeConstant,
    baseRangeMod: raw.baseRangeMod,
    power:       raw.power,
    category:    raw.category,
    casterEffect: raw.casterEffect,
    targetEffect: raw.targetEffect,
    fizzleEffect: raw.fizzleEffect,
    recoveryInterval: raw.recoveryInterval,
    recoveryAmount: raw.recoveryAmount,
    displayOrder: raw.displayOrder,
  };
}

function makeHybridCatalog(jsonCatalog, mockHandle) {
  return new Proxy(jsonCatalog || {}, {
    get(target, key) {
      const spellId = Number(key);
      if (!Number.isFinite(spellId) || spellId <= 0 || String(spellId) !== key) {
        return target[key];
      }
      const fromWasm = spellRecordFromWasm(spellId, mockHandle);
      const fromJson = target[key];
      if (fromWasm && fromJson) {
        return { ...fromWasm, level: fromJson.level ?? fromWasm.level };
      }
      if (fromWasm) return fromWasm;
      return fromJson;
    },
    has(target, key) {
      const spellId = Number(key);
      if (Number.isFinite(spellId) && spellId > 0) {
        if (spellRecordFromWasm(spellId, mockHandle)) return true;
      }
      return key in target;
    },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

console.log('## [Wave F.1] spellbook hybrid catalog\n');

// Synthetic data — modelled on retail spell 1 "Strength Other I".
const jsonCatalog = {
  '_comment': 'Generated from LSD-Partial...',
  '1': {
    name: 'Strength Other I',
    school: 4,
    level: 1,
    untargeted: false,
    mana: 10,
    icon: 100668300,  // = 0x0600138C, the JSON value (DAT confirms)
    desc: "Increases the target's Strength by 10 points.",
    duration: 0,
    components: ['Comp_1', 'Comp_7', 'Comp_33', 'Comp_44', 'Comp_49'],
  },
  '99': {
    name: 'JSON Only Spell',
    school: 3,
    level: 5,
    untargeted: true,
    mana: 50,
    icon: 0x0600A000,
    desc: 'Only in JSON, not in DAT (hypothetical).',
    duration: 60,
    components: ['Comp_5'],
  },
};

// Mock wasm handle returns the DAT-correct record for spell 1, plus
// a wasm-only spell (id 1000) that's not in the JSON catalog.
const mockHandle = {
  getSpellRecord(spellId) {
    if (spellId === 1) {
      return {
        id: 1,
        name: 'Strength Other I',
        description: "Increases the target's Strength by 10 points.",
        school: 4,
        schoolName: 'Creature Enchantment',
        iconId: 100668300,
        category: 38,
        bitfield: 4,
        flags: {
          beneficial: true,
          selfTargeted: false,
          fastCast: false,
        },
        isSelfTargeted: false,
        isUntargeted: false,
        isFastCast: false,
        isBeneficial: true,
        baseMana: 10,
        baseRangeConstant: 50.0,
        baseRangeMod: 0.5,
        power: 50,
        metaSpellType: 1,
        metaSpellTypeName: 'Enchantment',
        metaSpellId: 1,
        duration: 1800,
        degradeModifier: 0.0,
        degradeLimit: 0.0,
        components: [1, 7, 33, 44, 49],  // Decrypted from raw_components
        casterEffect: 8,
        targetEffect: 117,
        fizzleEffect: 0,
        recoveryInterval: 0,
        recoveryAmount: 0,
        displayOrder: 410,
        nonComponentTargetType: 1024,
        manaMod: 0,
        roughLevel: 1,   // Lead Scarab tier
        levelRoman: 'I',
      };
    }
    if (spellId === 1000) {
      return {
        id: 1000,
        name: 'Wasm-Only Spell',
        description: 'Found in DAT but not JSON.',
        school: 5,
        baseMana: 100,
        iconId: 0x0600B000,
        components: [8, 50, 60],
        isSelfTargeted: true,
        isUntargeted: true,
        bitfield: 8,
        roughLevel: 8,
        levelRoman: 'VIII',
      };
    }
    return null;
  },
};

check('wasm record wins over JSON for shared spell ID', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  const spell = cat['1'];
  assert.ok(spell, 'spell 1 should resolve');
  assert.equal(spell.name, 'Strength Other I');
  assert.equal(spell.school, 4);
  assert.equal(spell.mana, 10);
  assert.equal(spell.icon, 100668300);
  // Components: wasm returns numeric IDs, JSON has "Comp_N" strings.
  // The wasm path wins.
  assert.deepEqual(spell.components, [1, 7, 33, 44, 49]);
  // Wasm-only fields surface in the merge.
  assert.equal(spell._waveF1, true);
  assert.equal(spell.metaSpellType, 1);
  assert.equal(spell.metaSpellTypeName, 'Enchantment');
  assert.equal(spell.duration, 1800);
  assert.equal(spell.power, 50);
  assert.equal(spell.bitfield, 4);
  assert.equal(spell.flags?.beneficial, true);
});

check('JSON level overrides wasm roughLevel (handoff §F.1 gotcha)', () => {
  // For spell 1, the wasm `roughLevel` happens to be 1 in this mock,
  // but for real DAT it's 7 (Pyreal is highest scarab). The JSON
  // `level: 1` (parsed from "Strength Other I" name suffix) must win.
  const handleWithBadHeuristic = {
    getSpellRecord(spellId) {
      if (spellId !== 1) return null;
      return {
        ...mockHandle.getSpellRecord(1),
        roughLevel: 7,   // Bad heuristic — Pyreal scarab tier
        levelRoman: 'VII',
      };
    },
  };
  const cat = makeHybridCatalog(jsonCatalog, handleWithBadHeuristic);
  const spell = cat['1'];
  assert.equal(spell.level, 1, 'JSON-derived level=1 wins over wasm roughLevel=7');
});

check('JSON-only spell still resolves when wasm has no record', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  const spell = cat['99'];
  assert.ok(spell, 'spell 99 should resolve from JSON');
  assert.equal(spell.name, 'JSON Only Spell');
  assert.equal(spell.school, 3);
  // No _waveF1 marker since this came from JSON.
  assert.equal(spell._waveF1, undefined);
});

check('wasm-only spell resolves when JSON has no entry', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  const spell = cat['1000'];
  assert.ok(spell, 'spell 1000 should resolve from wasm');
  assert.equal(spell.name, 'Wasm-Only Spell');
  assert.equal(spell.school, 5);
  // No JSON to merge, so `level` falls through from wasm's `roughLevel`.
  assert.equal(spell.level, 8);
  assert.equal(spell.levelRoman, 'VIII');
});

check('missing spell ID returns undefined', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  assert.equal(cat['9999'], undefined);
});

check('non-numeric keys pass through unchanged', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  assert.equal(cat['_comment'], 'Generated from LSD-Partial...');
});

check('no wasm handle = pure JSON fallback', () => {
  const cat = makeHybridCatalog(jsonCatalog, null);
  const spell = cat['1'];
  assert.ok(spell, 'spell 1 should resolve from JSON only');
  // JSON shape — components are "Comp_N" strings, not numeric.
  assert.deepEqual(spell.components, ['Comp_1', 'Comp_7', 'Comp_33', 'Comp_44', 'Comp_49']);
  assert.equal(spell._waveF1, undefined);
});

check('handle without getSpellRecord = pure JSON fallback', () => {
  const cat = makeHybridCatalog(jsonCatalog, { unrelatedMethod: () => {} });
  const spell = cat['1'];
  assert.equal(spell.name, 'Strength Other I');
  assert.equal(spell._waveF1, undefined);
});

check('handle that throws is treated as missing', () => {
  const throwingHandle = {
    getSpellRecord() { throw new Error('boom'); },
  };
  const cat = makeHybridCatalog(jsonCatalog, throwingHandle);
  const spell = cat['1'];
  // Fallback to JSON.
  assert.equal(spell._waveF1, undefined);
});

check('handle returning null treated as missing', () => {
  const nullHandle = {
    getSpellRecord() { return null; },
  };
  const cat = makeHybridCatalog(jsonCatalog, nullHandle);
  const spell = cat['1'];
  assert.equal(spell._waveF1, undefined);
});

check('"has" operator works for wasm-only spells', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  assert.equal('1000' in cat, true, 'wasm-only spell is "in" the catalog');
  assert.equal('1' in cat, true, 'JSON-and-wasm spell is "in"');
  assert.equal('9999' in cat, false, 'unknown spell is not "in"');
});

check('Object.keys returns JSON catalog only (enumerability contract)', () => {
  const cat = makeHybridCatalog(jsonCatalog, mockHandle);
  const keys = Object.keys(cat);
  // The wasm overlay is a per-id lookup, not enumerable. Object.keys
  // surfaces the JSON catalog so legacy spellbook iteration paths
  // still work. Wave F.1 doesn't break enumeration.
  assert.deepEqual(keys.sort(), ['1', '99', '_comment']);
});

console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n## Failures:');
  for (const { name, err } of failures) {
    console.log(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
process.exit(0);
