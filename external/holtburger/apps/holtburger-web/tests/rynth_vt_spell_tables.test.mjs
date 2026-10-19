// tests/rynth_vt_spell_tables.test.mjs — rynth/vt/combat/spell_tables.js and
// its data rynth/vt/data/combat_spells.json (PLAN W1-7 CMB, §3.9, Appendix C).
//
// Pins the verified id ladders against the in-repo catalog
// (data/spells-catalog.json) and the DAT formula scarab levels
// (data/spell-table-attrs.json): Broadside = Defenselessness Other (2228 at
// L7), Futility 2282 = Yield L7, Lightning bolt = 75-80 (not Shock Wave), every
// debuff/DoT/bolt/streak/arc/item enchantment targeted, rings untargeted and
// L6/L7 only, the D38 item families (impen, bane:<el>) all Item school 3, and
// bestCastable's known-set / school-cap / exclude gates — and (2026-10-19) the
// power column (the LSD spell power VTank's SpellDiffExcessThreshold compares)
// with bestCastable's power gate, incl. a stale table without the column.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_spell_tables.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const T = await import("../rynth/vt/combat/spell_tables.js");
const catalog = JSON.parse(fs.readFileSync(path.join(APP, "data", "spells-catalog.json"), "utf8")).spells;
const attrs = JSON.parse(fs.readFileSync(path.join(APP, "data", "spell-table-attrs.json"), "utf8")).attrs;
const table = JSON.parse(fs.readFileSync(path.join(APP, "rynth", "vt", "data", "combat_spells.json"), "utf8"));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

// ACE SpellFormula.cs scarab → level (same map as rynth_spell_ladders_test.cjs).
const SCARAB_LEVEL = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [110, 6], [112, 7], [192, 7], [193, 8]]);
const ELS = ["slash", "pierce", "bludgeon", "fire", "cold", "lightning", "acid"];
const ids = (fam) => T.familyLadder(fam).map((r) => r.id);

await check("not loaded before loadCombatSpells(): lookups answer 'nothing known'", async () => {
  assert.equal(T.isLoaded(), false);
  assert.deepEqual(T.familyLadder("imperil"), []);
  assert.equal(T.bestCastable("imperil", { known: new Set([25]) }), null);
  assert.equal(T.durationOf(25), 0);
  assert.equal(T.nameOf(25), "");
  await T.loadCombatSpells();
  await T.loadCombatSpells(); // idempotent
  assert.equal(T.isLoaded(), true);
});

await check("table shape: v1, every family a non-empty level-sorted ladder of full rungs", () => {
  assert.equal(table.v, 1);
  const fams = Object.keys(table.families);
  assert.ok(fams.length >= 57, `families: ${fams.length}`);
  for (const f of fams) {
    const lad = T.familyLadder(f);
    assert.ok(lad.length > 0, f);
    for (let i = 0; i < lad.length; i++) {
      const r = lad[i];
      for (const k of ["id", "name", "level", "school", "duration", "untargeted", "metaSpellType"]) assert.ok(k in r, `${f} ${r.id} ${k}`);
      if (i) assert.ok(lad[i - 1].level < r.level, `${f} sorted by level`);
    }
  }
  for (const f of ["imperil", "fester", "yield", "broadside", "gravity", "wc", "fc", "dc", "cp", "cs", "impen"]) assert.ok(fams.includes(f), f);
  for (const el of ELS.concat(["nether"])) {
    for (const shape of ["bolt", "streak", "arc", "ring"]) assert.ok(fams.includes(`${shape}:${el}`), `${shape}:${el}`);
  }
  for (const el of ELS) {
    assert.ok(fams.includes(`vuln:${el}`), `vuln:${el}`);
    assert.ok(fams.includes(`bane:${el}`), `bane:${el}`);
  }
});

await check("every id exists in data/spells-catalog.json with the same name/school; level = DAT scarab level", () => {
  let n = 0;
  for (const f of T.familyNames()) {
    for (const r of T.familyLadder(f)) {
      const c = catalog[String(r.id)];
      assert.ok(c, `${f}: ${r.id} not in the catalog`);
      assert.equal(r.name, c.name, `${r.id} name`);
      assert.equal(r.school, c.school, `${r.id} school`);
      assert.equal(r.untargeted, c.untargeted, `${r.id} untargeted`);
      const a = attrs[String(r.id)];
      assert.ok(a && Array.isArray(a.formula), `${r.id} formula`);
      assert.equal(r.level, SCARAB_LEVEL.get(a.formula[0]), `${r.id} ${r.name} scarab level`);
      n++;
    }
  }
  assert.ok(n >= 400, `rungs ${n}`);
});

await check("Broadside = Defenselessness Other (2228 at L7; never Missile Weapon Ineptitude)", () => {
  assert.deepEqual(ids("broadside"), [262, 263, 264, 265, 266, 267, 2228, 4543]);
  const l7 = T.familyLadder("broadside").find((r) => r.level === 7);
  assert.equal(l7.id, 2228);
  assert.equal(l7.name, "Broadside of a Barn");
  assert.equal(T.nameOf(262), "Defenselessness Other I");
  for (const bad of [473, 497, 545, 2204, 2310]) assert.equal(T.familyOf(bad), null, `${bad} not in any family`);
  assert.equal(T.familyOf(2228), "broadside");
});

await check("Futility 2282 = Yield L7; lore/Incantation levels from the scarab (catalog says 1)", () => {
  const y7 = T.familyLadder("yield").find((r) => r.level === 7);
  assert.equal(y7.id, 2282);
  assert.equal(y7.name, "Futility");
  assert.equal(catalog["2074"].level, 1, "catalog level is roman-parsed (wrong for lore)");
  assert.equal(T.rungOf(2074).level, 7, "Gossamer Flesh = Imperil L7");
  assert.equal(T.rungOf(4312).level, 8, "Incantation of Imperil Other = L8");
});

await check("Lightning bolt = 75-80 (Lightning Bolt), Shock Wave 64-69 is the Bludgeon bolt", () => {
  assert.deepEqual(ids("bolt:lightning"), [75, 76, 77, 78, 79, 80, 2140, 4451]);
  assert.equal(T.nameOf(75), "Lightning Bolt I");
  assert.ok(!ids("bolt:lightning").includes(64));
  assert.deepEqual(ids("bolt:bludgeon").slice(0, 6), [64, 65, 66, 67, 68, 69]);
  assert.equal(T.nameOf(64), "Shock Wave I");
  assert.equal(ids("bolt:fire")[0], 27, "Flame Bolt I is 27 (not the last-wins 4945)");
});

await check("untargeted:false for every debuff/DoT/bolt/streak/arc/item rung; true for rings; no L8 ring", () => {
  for (const f of T.familyNames()) {
    for (const r of T.familyLadder(f)) {
      if (f.startsWith("ring:")) {
        assert.equal(r.untargeted, true, `${r.id}`);
        assert.ok(r.level === 6 || r.level === 7, `${r.id} ring level ${r.level}`);
      } else assert.equal(r.untargeted, false, `${f} ${r.id} ${r.name}`);
    }
  }
  for (const el of ELS.concat(["nether"])) assert.deepEqual(T.familyLadder(`ring:${el}`).map((r) => r.level), [6, 7], el);
  assert.equal(T.familyOf(5331), null, "monster-only Clouded Soul is never picked");
  assert.deepEqual(ids("ring:nether"), [5361, 6195]);
});

await check("schools: debuffs Life/Creature, curses/DoTs/nether shapes Void, war shapes War", () => {
  const school = (f) => new Set(T.familyLadder(f).map((r) => r.school));
  for (const f of ["imperil", "fester", ...ELS.map((e) => `vuln:${e}`)]) assert.deepEqual([...school(f)], [2], f);
  for (const f of ["yield", "broadside", "gravity"]) assert.deepEqual([...school(f)], [4], f);
  for (const f of ["wc", "fc", "dc", "cp", "cs", "bolt:nether", "streak:nether", "arc:nether", "ring:nether"]) assert.deepEqual([...school(f)], [5], f);
  for (const el of ELS) for (const sh of ["bolt", "streak", "arc", "ring"]) assert.deepEqual([...school(`${sh}:${el}`)], [1], `${sh}:${el}`);
});

await check("item-enchant families (D38): impen 51…1486, bane:slash 37…1562; every rung school 3, targeted", () => {
  const impen = ids("impen");
  assert.ok(impen.includes(51) && impen.includes(1486), JSON.stringify(impen));
  assert.equal(impen[0], 51);
  assert.ok(impen.includes(4407), "Incantation of Impenetrability");
  const slash = ids("bane:slash");
  assert.ok(slash.includes(37) && slash.includes(1562), JSON.stringify(slash));
  assert.deepEqual(ids("bane:fire").slice(0, 6), [1547, 1548, 1549, 1550, 1551, 1552]);
  for (const f of ["impen", ...ELS.map((e) => `bane:${e}`)]) {
    const lad = T.familyLadder(f);
    assert.deepEqual(lad.map((r) => r.level), [1, 2, 3, 4, 5, 6, 7, 8], f);
    for (const r of lad) {
      assert.equal(r.school, 3, `${f} ${r.id}`);
      assert.equal(r.untargeted, false, `${f} ${r.id}`);
      assert.equal(r.metaSpellType, 1, `${f} ${r.id} enchantment`);
    }
  }
  assert.equal(T.familyLadder("bane:nether").length, 0, "no nether bane");
});

await check("durations per id: Incantation of Defenselessness 60 s vs Broadside 240 s; curses 15/30 s; DoT windows", () => {
  assert.equal(T.durationOf(4543), 60);
  assert.equal(T.durationOf(2228), 240);
  assert.equal(T.durationOf(25), 60, "Imperil Other I");
  assert.equal(T.durationOf(4312), 300);
  assert.equal(T.durationOf(5379), 15, "Weakening Curse I");
  assert.equal(T.durationOf(5377), 30, "Festering Curse VII");
  assert.equal(T.durationOf(5395), 30, "Corruption I window");
  assert.equal(T.durationOf(5387), 15, "Corrosion I window");
  assert.equal(T.durationOf(27), 0, "bolts have no duration");
  for (const r of T.familyLadder("cp").concat(T.familyLadder("cs"))) assert.equal(r.metaSpellType, 15, `${r.id} EnchantmentProjectile`);
  for (const r of T.familyLadder("bolt:fire")) assert.equal(r.metaSpellType, 2, `${r.id} Projectile`);
});

await check("bestCastable: highest known rung; school cap by the spell's own school; exclude set", () => {
  const known = new Set([25, 1323, 1324, 2074, 27, 81, 82]);
  assert.deepEqual(T.bestCastable("imperil", { known }), { id: 2074, level: 7, school: 2, duration: 240, untargeted: false });
  assert.equal(T.bestCastable("imperil", { known, maxLevelBySchool: (s) => (s === 2 ? 3 : 8) }).id, 1324, "Life cap 3");
  assert.equal(T.bestCastable("imperil", { known, maxLevelBySchool: (s) => (s === 4 ? 1 : 8) }).id, 2074, "a Creature cap does not gate Life");
  assert.equal(T.bestCastable("imperil", { known, exclude: new Set([2074]) }).id, 1324);
  assert.equal(T.bestCastable("bolt:fire", { known, maxLevelBySchool: () => 0 }), null, "untrained school");
  assert.equal(T.bestCastable("fester", { known }), null, "nothing known");
  assert.equal(T.bestCastable("nope", { known }), null);
  assert.equal(T.bestCastable("imperil", {}), null, "no known set");
  assert.equal(T.bestCastable("imperil", { known, maxLevelBySchool: () => { throw new Error("x"); } }).id, 2074, "a throwing cap = no cap");
});

await check("power column: every rung > 0 and never decreasing up a family; the war ladder 1/50/…/300/400, debuffs 25 above their tier", () => {
  for (const f of T.familyNames()) {
    let last = 0;
    for (const r of T.familyLadder(f)) {
      assert.ok(Number.isInteger(r.power) && r.power > 0, `${f} ${r.id} power ${r.power}`);
      assert.ok(r.power >= last, `${f} ${r.id} power ${r.power} < ${last}`);
      last = r.power;
    }
  }
  assert.deepEqual(T.familyLadder("bolt:fire").map((r) => r.power), [1, 50, 100, 150, 200, 250, 300, 400]);
  assert.deepEqual(T.familyLadder("imperil").map((r) => r.power), [25, 75, 125, 175, 225, 275, 325, 400]);
  assert.deepEqual(T.familyLadder("ring:fire").map((r) => r.power), [200, 300]);
  assert.equal(T.rungOf(2228).power, 325, "Broadside of a Barn");
});

await check("bestCastable maxPowerBySchool: power ≤ cap by the spell's own school; -Infinity = none; Infinity / NaN / a throw = no gate", () => {
  const known = new Set(T.familyLadder("bolt:fire").map((r) => r.id).concat(T.familyLadder("imperil").map((r) => r.id)));
  const best = (fam, cap) => T.bestCastable(fam, { known, maxPowerBySchool: cap })?.id ?? null;
  assert.equal(best("bolt:fire", () => 375), 2128, "War 400 − 25");
  assert.equal(best("bolt:fire", () => 400), 4439);
  assert.equal(best("bolt:fire", () => 299), 85);
  assert.equal(best("bolt:fire", () => 0), null, "nothing under power 1");
  assert.equal(best("bolt:fire", () => -Infinity), null, "untrained");
  assert.equal(best("bolt:fire", () => Infinity), 4439);
  assert.equal(best("bolt:fire", () => NaN), 4439);
  assert.equal(best("bolt:fire", () => { throw new Error("x"); }), 4439);
  assert.equal(best("imperil", (s) => (s === 2 ? 324 : 0)), 1327, "Life cap 324 ⇒ Imperil Other VI (275)");
  assert.equal(best("imperil", (s) => (s === 1 ? 0 : 400)), 4312, "a War cap does not gate Life");
  assert.equal(T.bestCastable("bolt:fire", { known, maxPowerBySchool: () => 375, maxLevelBySchool: () => 5 }).id, 84, "both caps apply");
});

await check("a stale table without the power column: powerOf (the live spell record) is asked; unknown power is not gated", async () => {
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-vt-st-"));
  try {
    fs.mkdirSync(path.join(dir, "combat"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(path.join(APP, "rynth", "vt", "combat", "spell_tables.js"), path.join(dir, "combat", "spell_tables.mjs"));
    const stale = JSON.parse(JSON.stringify(table));
    for (const rows of Object.values(stale.families)) for (const r of rows) delete r.power;
    fs.writeFileSync(path.join(dir, "data", "combat_spells.json"), JSON.stringify(stale));
    const S = await import(pathToFileURL(path.join(dir, "combat", "spell_tables.mjs")).href);
    await S.loadCombatSpells();
    assert.equal(S.rungOf(2128).power, 0, "no column ⇒ 0");
    const known = new Set(S.familyLadder("bolt:fire").map((r) => r.id));
    const asked = [];
    const powerOf = (id) => (asked.push(id), { 4439: 400, 2128: 300 }[id] ?? 0);
    assert.equal(S.bestCastable("bolt:fire", { known, maxPowerBySchool: () => 375, powerOf }).id, 2128, "4439 (400) gated via powerOf");
    assert.deepEqual(asked, [4439, 2128]);
    assert.equal(S.bestCastable("bolt:fire", { known, maxPowerBySchool: () => 375 }).id, 4439, "unknown power ⇒ not gated");
    assert.equal(S.bestCastable("bolt:fire", { known, maxPowerBySchool: () => -Infinity, powerOf }), null, "untrained gates even without a power");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("normalizeElement: Electric⇄Lightning, Blade⇄Slash, aliases; Auto/None/garbage → null", () => {
  assert.equal(T.normalizeElement("Electric"), "Lightning");
  assert.equal(T.normalizeElement("electric"), "Lightning");
  assert.equal(T.normalizeElement("Blade"), "Slash");
  assert.equal(T.normalizeElement("Bludgeoning"), "Bludgeon");
  assert.equal(T.normalizeElement("Piercing"), "Pierce");
  assert.equal(T.normalizeElement(" fire "), "Fire");
  assert.equal(T.normalizeElement("Frost"), "Cold");
  assert.equal(T.normalizeElement("Nether"), "Nether");
  assert.equal(T.normalizeElement("Auto"), null);
  assert.equal(T.normalizeElement("None"), null);
  assert.equal(T.normalizeElement(null), null);
  assert.deepEqual([...T.ELEMENTS], ["Slash", "Pierce", "Bludgeon", "Fire", "Cold", "Lightning", "Acid", "Nether"]);
});

await check("familyOf / nameOf / rungOf; ladders are frozen", () => {
  assert.equal(T.familyOf(1796), "streak:fire");
  assert.equal(T.familyOf(2745), "arc:fire");
  assert.equal(T.familyOf(51), "impen");
  assert.equal(T.nameOf(2282), "Futility");
  assert.equal(T.rungOf(999999), null);
  assert.ok(Object.isFrozen(T.familyLadder("imperil")));
  assert.ok(Object.isFrozen(T.familyLadder("imperil")[0]));
});

console.log(fail === 0 ? `rynth_vt_spell_tables: all ${pass} checks passed` : `rynth_vt_spell_tables: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
