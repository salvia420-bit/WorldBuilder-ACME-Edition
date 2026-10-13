// =============================================================================
// examine-text-2 (2026-10-13) — buffs-hud stat labels + effects info text
// =============================================================================
//
// Guards plugins/buffs-hud.js formatStatMod / tooltipLines against the
// retail ids:
//   [1] skills keyed by retail STypeSkill (acclient.txt S_CONSTANT
//       ARCANE_LORE_SKILL = 14, MAGIC_DEFENSE_SKILL = 15, JUMP_SKILL = 22,
//       RUN_SKILL = 24, SHIELD_SKILL = 48) — the old table read 14 "Run",
//       15 "Jump", 24 "Mana C", 48 "Finesse".
//   [2] attributes: QUICKNESS_ATTRIBUTE = 3, COORDINATION_ATTRIBUTE = 4
//       (the old table had them swapped).
//   [3] ETF.FLOAT keys are PropertyFloat ids (ResistFire 67, HealthRate 3 …).
//   [4] key-0 stat families (MULTIPLE_STAT, Attack/DefenseSkills, armor).
//   [5] tooltip carries the spell description (gmEffectsUI::UpdateSelection:
//       name + "\n\n" + description).
//
// Pure JS, no wasm / 3D. Run from apps/holtburger-web/:
//   node tests/buffs_hud_stat_labels.test.cjs
// =============================================================================

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const BUFFS_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'buffs-hud.js')
).href;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

// jsdom-lite stub — buffs-hud.js touches document/window/setInterval/fetch
// at import time; only the pure helpers are exercised here.
function installDomShim() {
  if (typeof globalThis.document !== 'undefined') return;
  function mkEl() {
    return {
      attrs: {}, dataset: {}, style: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
      isConnected: true,
    };
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
  // Spell records as the wasm hands them back: a JS Map
  // (serde_wasm_bindgen default) and a plain object.
  window.__sessionHandle = {
    getSpellRecord: (id) => {
      if (id === 2) {
        return new Map([
          ['name', 'Strength Self I'], ['iconId', 0], ['isBeneficial', true],
          ['schoolName', 'Creature Enchantment'],
          ['description', "Increases the caster's Strength by 10 points."],
        ]);
      }
      if (id === 3) return { name: 'Weakness Other I', iconId: 0, isBeneficial: false, schoolName: 'Creature Enchantment', description: '' };
      if (id === 4) return { name: 'Armor Self I', iconId: 0, isBeneficial: true, schoolName: 'Life Magic' };
      return null;
    },
  };
  window.getLocalPlayerGuid = () => 0x50000001;

  const { formatStatMod, __test } = await import(BUFFS_URL);
  const { ETF } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'enchantment_constants.js')).href);
  const { tooltipLines } = __test;
  const SKILL_ADD = ETF.SKILL | ETF.SINGLE_STAT | ETF.ADDITIVE;

  console.log('\n[1] skill labels keyed by retail STypeSkill');
  check('24 RUN_SKILL → "+50 Run" (Sprint)', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 24, statValue: 50 }), '+50 Run');
  });
  check('14 ARCANE_LORE_SKILL → "+50 Arcane"', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 14, statValue: 50 }), '+50 Arcane');
  });
  check('15 MAGIC_DEFENSE_SKILL → "Magic D" (Magic Resistance Self, not "Jump")', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 15, statValue: 10 }), '+10 Magic D');
  });
  check('22 JUMP_SKILL → "Jump"', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 22, statValue: 10 }), '+10 Jump');
  });
  check('48 SHIELD_SKILL → "Shield"', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 48, statValue: 10 }), '+10 Shield');
  });
  check('16 Mana C / 31 Creature E / 43 Void M / 44 Heavy W / 54 Summoning', () => {
    const lbl = (k) => formatStatMod({ type: SKILL_ADD, statKey: k, statValue: 5 });
    assert.equal(lbl(16), '+5 Mana C');
    assert.equal(lbl(31), '+5 Creature E');
    assert.equal(lbl(43), '+5 Void M');
    assert.equal(lbl(44), '+5 Heavy W');
    assert.equal(lbl(54), '+5 Summoning');
  });
  check('no short form → full retail name (11 SWORD_SKILL → "Sword")', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 11, statValue: 5 }), '+5 Sword');
  });
  check('the old non-skill 55..66 rows are gone ("id N")', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 60, statValue: 1 }), '+1 id 60');
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 66, statValue: 1 }), '+1 id 66');
  });
  check('debuff keeps its sign (Magic Yield Other: -10 Magic D)', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 15, statValue: -10 }), '-10 Magic D');
  });

  console.log('\n[2] attribute labels (STypeAttribute)');
  check('3 QUICKNESS_ATTRIBUTE → "QCK"', () => {
    assert.equal(formatStatMod({ type: ETF.ATTRIBUTE | ETF.ADDITIVE, statKey: 3, statValue: 10 }), '+10 QCK');
  });
  check('4 COORDINATION_ATTRIBUTE → "COO"', () => {
    assert.equal(formatStatMod({ type: ETF.ATTRIBUTE | ETF.ADDITIVE, statKey: 4, statValue: 10 }), '+10 COO');
  });

  console.log('\n[3] FLOAT keys are PropertyFloat ids');
  const FLOAT_MUL = ETF.FLOAT | ETF.SINGLE_STAT | ETF.MULTIPLICATIVE;
  check('67 ResistFire, multiplicative → "x1.10 Fire P"', () => {
    assert.equal(formatStatMod({ type: FLOAT_MUL, statKey: 67, statValue: 1.1 }), 'x1.10 Fire P');
  });
  check('64 ResistSlash (Blade Protection Self I 0x5008) → "x0.91 Slash P"', () => {
    assert.equal(formatStatMod({ statModType: 0x5008, statModKey: 64, statModValue: 0.91 }), 'x0.91 Slash P');
  });
  check('166 ResistNether → "Nether P"', () => {
    assert.equal(formatStatMod({ type: FLOAT_MUL, statKey: 166, statValue: 0.8 }), 'x0.80 Nether P');
  });
  check('3 HealthRate (Regeneration Self I) → "x1.10 HP Regen"', () => {
    assert.equal(formatStatMod({ type: FLOAT_MUL, statKey: 3, statValue: 1.1 }), 'x1.10 HP Regen');
  });
  check('unknown FLOAT key keeps the "id N" fallback', () => {
    assert.equal(formatStatMod({ type: FLOAT_MUL, statKey: 999, statValue: 1.5 }), 'x1.50 id 999');
  });

  console.log('\n[4] key-0 stat families');
  check('MULTIPLE_STAT skill, key 0 (Cloaked in Skill 0x200A010) → "all skills"', () => {
    assert.equal(formatStatMod({ statModType: 0x200A010, statModKey: 0, statModValue: 20 }), '+20 all skills');
  });
  check('MULTIPLE_STAT attribute, key 0 (Society blessing 0x200A001) → "all attributes"', () => {
    assert.equal(formatStatMod({ statModType: 0x200A001, statModKey: 0, statModValue: 5 }), '+5 all attributes');
  });
  check('MULTIPLE_STAT multiplicative skill debuff (0x6010) → "x0.80 all skills"', () => {
    assert.equal(formatStatMod({ statModType: 0x6010, statModKey: 0, statModValue: 0.8 }), 'x0.80 all skills');
  });
  check('Armor Self I (0xA080, BODY_ARMOR_VALUE) → "+20 Armor"', () => {
    assert.equal(formatStatMod({ statModType: 0xA080, statModKey: 0, statModValue: 20 }), '+20 Armor');
  });
  check('Vitae (0xA06012: vitals + skills) → "x0.95 all vitals & skills"', () => {
    assert.equal(formatStatMod({ statModType: 0xA06012, statModKey: 0, statModValue: 0.95 }), 'x0.95 all vitals & skills');
  });
  check('ACE DefenseSkills (0x28010) / AttackSkills (0x18010) key 0', () => {
    assert.equal(formatStatMod({ statModType: 0x28010, statModKey: 0, statModValue: -10 }), '-10 defense skills');
    assert.equal(formatStatMod({ statModType: 0x18010, statModKey: 0, statModValue: -10 }), '-10 attack skills');
  });
  check('SINGLE_STAT key 0 still prints "id 0"', () => {
    assert.equal(formatStatMod({ type: SKILL_ADD, statKey: 0, statValue: 1 }), '+1 id 0');
  });

  console.log('\n[5] tooltip carries the spell description');
  const strBuff = { spellId: 2, casterGuid: 0x50000001, duration: -1, type: 0x2009001, statKey: 1, statValue: 10 };
  check('description line present, ahead of the stat mod (Map record)', () => {
    const t = tooltipLines(strBuff, 'buff');
    assert.equal(t.name, 'Strength Self I');
    const descIdx = t.lines.findIndex((l) => l.cls === 'hb-bh-tip-desc');
    assert.ok(descIdx >= 0, JSON.stringify(t.lines));
    assert.equal(t.lines[descIdx].text, "Increases the caster's Strength by 10 points.");
    const modIdx = t.lines.findIndex((l) => l.cls === 'hb-bh-tip-mod');
    assert.equal(t.lines[modIdx].text, '+10 STR');
    assert.ok(descIdx < modIdx, 'description leads, like the retail info box');
  });
  check('no description line when the record has none (empty / missing)', () => {
    for (const spellId of [3, 4, 9999]) {
      const t = tooltipLines({ spellId, casterGuid: 0, duration: 60, startTime: 0, type: 0 }, 'buff');
      assert.ok(!t.lines.some((l) => l.cls === 'hb-bh-tip-desc'), `${spellId}: ${JSON.stringify(t.lines)}`);
    }
  });
  check('existing lines kept (Cast by You, Permanent)', () => {
    const t = tooltipLines(strBuff, 'buff');
    assert.ok(t.lines.some((l) => l.text === 'Cast by You'));
    assert.ok(t.lines.some((l) => l.text === 'Permanent'));
  });

  console.log(`\n=== buffs-hud stat labels — ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
