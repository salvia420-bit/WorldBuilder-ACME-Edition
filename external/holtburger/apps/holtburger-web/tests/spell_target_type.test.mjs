// tests/spell_target_type.test.mjs — spellcast-2 (2026-10-08).
//
// Retail ClientMagicSystem::CastSpell (acclient.c:404671) casts a SelfTargeted
// spell at the player and a spell whose CSpellBase::InqTargetType (:449055) is 0
// untargeted, without reading the selection. InqTargetType = SpellFormula::Complete
// (:487706) ? GetTargetingType (:487766) : 0, and GetTargetTypeFromComponentID
// (:487059) maps the talisman to an ItemType mask. Rings / walls / sprays end in
// a mask-0 talisman, so holtburger refused them without a selection. This locks
// ui/ac_spell_target_type.js against the DAT-decrypted formulas in
// data/spell-table-attrs.json and the regenerated data/spells-catalog.json.
//
// Run from apps/holtburger-web/:  node tests/spell_target_type.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const T = await import(pathToFileURL(path.join(APP, "ui", "ac_spell_target_type.js")).href);
const attrs = JSON.parse(fs.readFileSync(path.join(APP, "data", "spell-table-attrs.json"), "utf8")).attrs;
const catalog = JSON.parse(fs.readFileSync(path.join(APP, "data", "spells-catalog.json"), "utf8")).spells;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
const dat = (id) => ({ selfTargeted: !!(attrs[id].bitfield & 8), components: attrs[id].formula });

console.log("\n[1] GetTargetTypeFromComponentID / InqTargetType (acclient.c)");
check("talisman masks: 0x31-0x38, 0x3C-0x3E, 0xBE → 0x10; 0x39; 0x3B; else 0", () => {
  for (const id of [0x31, 0x35, 0x38, 0x3c, 0x3d, 0x3e, 0xbe]) assert.equal(T.targetTypeFromComponentId(id), 0x10, id);
  assert.equal(T.targetTypeFromComponentId(0x39), 0x88b8f);
  assert.equal(T.targetTypeFromComponentId(0x3b), 0x10010000);
  for (const id of [0, 0x30, 0x3a, 0x3f, 0xbd, 0xbf]) assert.equal(T.targetTypeFromComponentId(id), 0, id);
});
check("Flame Bolt I [1,15,34,46,55] → 0x10", () => assert.equal(T.inqTargetType([1, 15, 34, 46, 55]), 0x10));
check("Searing Disc [110,110,19,67,34,37,63,58] → 0 (Elder Talisman 0x3A)", () =>
  assert.equal(T.inqTargetType([110, 110, 19, 67, 34, 37, 63, 58]), 0));
check("an incomplete 4-component formula → 0", () => assert.equal(T.inqTargetType([1, 15, 34, 46]), 0));
check("the talisman is the last of the run from slot 4: ending 57 / 59 / 190", () => {
  assert.equal(T.inqTargetType([6, 66, 15, 65, 34, 46, 64, 57]), 0x88b8f);
  assert.equal(T.inqTargetType([6, 66, 15, 65, 34, 46, 64, 59]), 0x10010000);
  assert.equal(T.inqTargetType([1, 2, 8, 73, 26, 111, 66, 190]), 0x10);
});
check("a zero in slot 5 ends the run at slot 4", () => assert.equal(T.inqTargetType([1, 2, 3, 4, 49, 0, 58, 58]), 0x10));
check("catalog 'Comp_N' strings decode like numbers", () => {
  assert.deepEqual(T.normalizeComponents(["Comp_1", "Comp_15", 34, "x"]), [1, 15, 34, 0, 0, 0, 0, 0]);
  assert.equal(T.inqTargetType(["Comp_1", "Comp_15", "Comp_34", "Comp_46", "Comp_55"]), 0x10);
});

console.log("\n[2] the DAT (data/spell-table-attrs.json, 6266 decrypted formulas)");
check("272 spells are formula-untargeted without the SelfTargeted bit", () => {
  const n = Object.values(attrs).filter((a) => !(a.bitfield & 8) && T.inqTargetType(a.formula) === 0).length;
  assert.equal(n, 272);
});
check("no SelfTargeted spell has a type-0 formula (self and untargeted never overlap)", () => {
  const both = Object.entries(attrs).filter(([, a]) => (a.bitfield & 8) && T.inqTargetType(a.formula) === 0);
  assert.deepEqual(both.map(([id]) => id), []);
});
check("rings / walls need no selection: 1783 Searing Disc, 1785 Cassius' Ring of Fire, 1844 Os' Wall, 4239", () => {
  for (const id of ["1783", "1785", "1844", "4239"]) assert.equal(T.castNeedsNoSelection(dat(id), true), true, id);
});
check("bolts need a target: 27 Flame Bolt I, 85 Flame Bolt VI", () => {
  for (const id of ["27", "85"]) assert.equal(T.castNeedsNoSelection(dat(id), true), false, id);
});
check("2 Strength Self I casts without a selection via the SelfTargeted bit", () => {
  assert.equal(T.inqTargetType(attrs["2"].formula), 0x10);
  assert.equal(T.castNeedsNoSelection(dat("2"), true), true);
});
check("flag off: SelfTargeted only (ring needs a target, self spell does not)", () => {
  assert.equal(T.castNeedsNoSelection(dat("1783"), false), false);
  assert.equal(T.castNeedsNoSelection(dat("2"), false), true);
});
check("unknown formula (no components) stays targeted", () => {
  assert.equal(T.castNeedsNoSelection({ selfTargeted: false, components: [] }, true), false);
  assert.equal(T.castNeedsNoSelection({ selfTargeted: false }, true), false);
});

console.log("\n[3] data/spells-catalog.json (scripts/build_spells_catalog.py)");
check("every catalog `untargeted` equals castNeedsNoSelection over the DAT", () => {
  const bad = Object.keys(attrs).filter((id) => catalog[id]?.untargeted !== T.castNeedsNoSelection(dat(id), true));
  assert.deepEqual(bad, []);
});
check("?formulaUntargeted=off on the catalog restores exactly the SelfTargeted bit", () => {
  const off = T.catalogSelfTargetedOnly(catalog);
  const bad = Object.keys(attrs).filter((id) => off[id].untargeted !== !!(attrs[id].bitfield & 8));
  assert.deepEqual(bad, []);
  assert.equal(catalog["1783"].untargeted, true, "input not mutated");
});
check("spellTargetClass: 1783 none, 27 target, 2 self", () => {
  assert.equal(T.spellTargetClass(catalog["1783"]), "none");
  assert.equal(T.spellTargetClass(catalog["27"]), "target");
  assert.equal(T.spellTargetClass(catalog["2"]), "self");
  assert.equal(T.spellTargetClass(null), "target");
});

console.log("\n[4] ?formulaUntargeted reader");
check("absent / on → enabled; off / 0 / false (any case) → disabled", () => {
  assert.equal(T.formulaUntargetedEnabled(""), true);
  assert.equal(T.formulaUntargetedEnabled("?formulaUntargeted=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) assert.equal(T.formulaUntargetedEnabled(`?formulaUntargeted=${v}`), false, v);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
