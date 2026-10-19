#!/usr/bin/env node
// rynth_vt_spell_tables_test.cjs — the VTank combat spell table
// (rynth/vt/data/combat_spells.json, PLAN W1-7 CMB / Appendix C) checked
// against the DAT + catalog, and its generator. Also checks the creature
// species table (rynth/vt/data/creature_species.json) against the LSD weenie
// summary when that dump is present.
//
// Table shape: { v: 1, families: { "<family>": [{ id, name, level, school,
//   duration, untargeted, metaSpellType, power }] } } — rungs sorted by level.
//
//   family     imperil fester yield broadside gravity wc fc dc cp cs vuln:<el>
//              bolt:<el> streak:<el> arc:<el> ring:<el> (Nether = void shapes)
//              + the D38 item enchantments impen and bane:<el>.
//   level      scarab level from the DAT formula (data/spell-table-attrs.json
//              formula[0], ACE SpellFormula.cs ScarabLevel) — NEVER the
//              catalog `level`, which reads lore (L7) and Incantation (L8)
//              spells as 1 (U2 §2.8).
//   school     1 War, 2 Life, 3 Item, 4 Creature, 5 Void (catalog).
//   duration   seconds: the enchantment duration (catalog) or, for the DoT
//              projectiles (Corruption/Corrosion, MetaSpellType 15), the LSD
//              meta_spell duration — the window the debuff ledger tracks.
//   untargeted catalog flag (SelfTargeted OR formula target type 0): true only
//              for rings; every debuff, DoT, bolt, streak, arc and item
//              enchantment must be cast TARGETED (README hard rule).
//   metaSpellType  LSD meta_spell.sp_type (1 Enchantment, 2 Projectile,
//              15 EnchantmentProjectile).
//   power      LSD spell power — the difficulty VTank's
//              SpellDiffExcessThreshold-Hunt compares with the buffed school
//              skill (1, 50 … 300, 400 up a war ladder; debuffs 25 above
//              their tier below L8); never decreasing up a family.
//
// Ids come from the verified seed lists (U6 §2.1/§2.5, Appendix C) — the C#
// name→id map is last-wins over duplicate names and is never used. The item
// families seed L1 (+ the L7 lore spell) by id and resolve the roman L2-L6
// and "Incantation of <base>" rungs by exact catalog name + school 3; the
// generator fails loudly if a family lacks its L1.
//
// LSD: ../../../LSD-Partial-*/spells.json and weenie_summary.jsonl relative to
// this app (outside the app dir; RYNTH_VT_LSD_DIR overrides). Absent ⇒ the
// DAT/catalog checks still run (metaSpellType, power and the DoT windows are
// then taken from the committed table) and the file passes with "0 corpus
// checks".
//
// Run:   node rynth_vt_spell_tables_test.cjs           (verify; exit 1 on drift)
//        node rynth_vt_spell_tables_test.cjs --write   (regenerate the table; needs LSD)

"use strict";
const fs = require("fs");
const path = require("path");

const APP = __dirname;
const TABLE = path.join(APP, "rynth", "vt", "data", "combat_spells.json");
const SPECIES = path.join(APP, "rynth", "vt", "data", "creature_species.json");
const CATALOG = path.join(APP, "data", "spells-catalog.json");
const ATTRS = path.join(APP, "data", "spell-table-attrs.json");
// RYNTH_VT_LSD_DIR overrides where the LSD-Partial-* dump is looked for (a
// non-existent dir exercises the LSD-absent path).
const LSD_DIR = process.env.RYNTH_VT_LSD_DIR || path.resolve(APP, "..", "..", "..");
// ACE SpellFormula.cs — Scarab enum id -> level (same map as rynth_spell_ladders_test.cjs).
const SCARAB_LEVEL = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [110, 6], [112, 7], [192, 7], [193, 8]]);
const POWER_CAP = 900; // ids at or above are monster/item-only variants (Appendix C)

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ── seed families (Appendix C, every id verified in U6 §2.1/§2.5) ──────────
// [family, kind, ids]; kind: debuff | dot | attack | ring
const SEED_FAMILIES = [
  ["imperil", "debuff", [25, ...range(1323, 1327), 2074, 4312]],
  ["fester", "debuff", [...range(171, 176), 2178, 4489]],
  ["yield", "debuff", [...range(280, 285), 2282, 4597]],
  ["broadside", "debuff", [...range(262, 267), 2228, 4543]],
  ["gravity", "debuff", [15, ...range(230, 234), 2318, 4633]],
  ["vuln:fire", "debuff", [21, ...range(1104, 1108), 2170, 4481]],
  ["vuln:cold", "debuff", [...range(1060, 1065), 2168, 4479]],
  ["vuln:lightning", "debuff", [...range(1084, 1089), 2172, 4483]],
  ["vuln:acid", "debuff", [...range(521, 526), 2162, 4473]],
  ["vuln:slash", "debuff", [...range(1127, 1132), 2164, 4475]],
  ["vuln:pierce", "debuff", [...range(1151, 1156), 2174, 4485]],
  ["vuln:bludgeon", "debuff", [...range(1048, 1053), 2166, 4477]],
  ["wc", "debuff", [...range(5379, 5384), 5385, 5386]],
  ["fc", "debuff", [...range(5371, 5376), 5377, 5378]],
  ["dc", "debuff", [...range(5339, 5344), 5337, 5338]],
  ["cp", "dot", [...range(5395, 5400), 5401, 5402]],
  ["cs", "dot", [...range(5387, 5392), 5393, 5394]],
  ["bolt:fire", "attack", [27, ...range(81, 85), 2128, 4439]],
  ["bolt:cold", "attack", [28, ...range(70, 74), 2136, 4447]],
  ["bolt:lightning", "attack", [...range(75, 80), 2140, 4451]],
  ["bolt:acid", "attack", [...range(58, 63), 2122, 4433]],
  ["bolt:slash", "attack", [...range(92, 97), 2146, 4457]],
  ["bolt:pierce", "attack", [...range(86, 91), 2132, 4443]],
  ["bolt:bludgeon", "attack", [...range(64, 69), 2144, 4455]],
  ["bolt:nether", "attack", [...range(5349, 5354), 5355, 5356]],
  ["streak:fire", "attack", [...range(1796, 1801), 2129, 4440]],
  ["streak:cold", "attack", [...range(1808, 1813), 2137, 4448]],
  ["streak:lightning", "attack", [...range(1814, 1819), 2141, 4452]],
  ["streak:acid", "attack", [...range(1790, 1795), 2121, 4432]],
  ["streak:slash", "attack", [...range(1826, 1831), 2147, 4458]],
  ["streak:pierce", "attack", [...range(1802, 1807), 2133, 4444]],
  ["streak:bludgeon", "attack", [...range(1820, 1825), 2145, 4456]],
  ["streak:nether", "attack", [...range(5357, 5360), 5345, 5346, 5347, 5348]],
  ["arc:fire", "attack", [...range(2739, 2744), 2745, 4423]],
  ["arc:cold", "attack", [...range(2725, 2730), 2731, 4425]],
  ["arc:lightning", "attack", [...range(2732, 2737), 2738, 4426]],
  ["arc:acid", "attack", [...range(2711, 2716), 2717, 4421]],
  ["arc:slash", "attack", [...range(2753, 2758), 2759, 4422]],
  ["arc:pierce", "attack", [...range(2718, 2723), 2724, 4424]],
  ["arc:bludgeon", "attack", [...range(2746, 2751), 2752, 4427]],
  ["arc:nether", "attack", [5369, ...range(5362, 5366), 5367, 5368]],
  // Rings exist only at L6/L7 (no L8); never 5331 (monster-only Clouded Soul, power 700).
  ["ring:fire", "ring", [1785, 6191]],
  ["ring:cold", "ring", [1787, 6193]],
  ["ring:lightning", "ring", [1788, 6194]],
  ["ring:acid", "ring", [1783, 6189]],
  ["ring:slash", "ring", [1784, 6190]],
  ["ring:pierce", "ring", [1786, 6192]],
  ["ring:bludgeon", "ring", [1789, 6196]],
  ["ring:nether", "ring", [5361, 6195]],
];

// ── D38 item-enchant families (Item school 3, cast TARGETED at an item) ────
// [family, base name, L1 seed, L7 lore seed]. L2-L6 = "<base> II".."VI" and
// L8 = "Incantation of <base>", resolved by exact catalog name + school 3.
// The L7 lore ids are the LSD category-mates at power 300 (verified this
// session: Brogard's Defiance 2108 is category 160 with Impenetrability I-VI).
const ITEM_FAMILIES = [
  ["impen", "Impenetrability", 51, 2108],
  ["bane:slash", "Blade Bane", 37, 2094],
  ["bane:pierce", "Piercing Bane", 1569, 2113],
  ["bane:bludgeon", "Bludgeon Bane", 1511, 2098],
  ["bane:fire", "Flame Bane", 1547, 2102],
  ["bane:cold", "Frost Bane", 1523, 2104],
  ["bane:lightning", "Lightning Bane", 1535, 2110],
  ["bane:acid", "Acid Bane", 1493, 2092],
];
const ROMAN = ["I", "II", "III", "IV", "V", "VI"];

// Spot pins (Appendix C prose, U6 hazards) — readable by name in the catalog.
const SPOTS = [
  ["broadside", 2228, 7, "Broadside of a Barn = Defenselessness Other VII (not Missile Weapon Ineptitude)"],
  ["broadside", 262, 1, "Defenselessness Other I"],
  ["yield", 2282, 7, "Futility = Magic Yield Other VII"],
  ["bolt:lightning", 75, 1, "Lightning Bolt I (not Shock Wave)"],
  ["bolt:bludgeon", 64, 1, "Shock Wave I = the Bludgeon bolt"],
  ["impen", 51, 1, "Impenetrability I"],
  ["impen", 1486, 6, "Impenetrability VI"],
  ["impen", 4407, 8, "Incantation of Impenetrability"],
  ["bane:slash", 37, 1, "Blade Bane I"],
  ["bane:slash", 1562, 6, "Blade Bane VI"],
  ["bane:fire", 1547, 1, "Flame Bane I"],
  ["bane:fire", 1552, 6, "Flame Bane VI"],
];

// Power pins (LSD spells.json): the war ladder 1/50/…/300/400, debuffs 25 above
// their tier below L8 (Magic Yield Other I is 1), rings 200/300.
const POWER_SPOTS = [
  ["bolt:fire", 27, 1], ["bolt:fire", 81, 50], ["bolt:fire", 85, 250], ["bolt:fire", 2128, 300], ["bolt:fire", 4439, 400],
  ["imperil", 25, 25], ["imperil", 1327, 275], ["imperil", 2074, 325], ["imperil", 4312, 400],
  ["yield", 280, 1], ["yield", 281, 75],
  ["ring:fire", 1785, 200], ["ring:fire", 6191, 300],
];

function findLsdFile(name) {
  try {
    for (const d of fs.readdirSync(LSD_DIR)) {
      if (!d.startsWith("LSD-Partial")) continue;
      const p = path.join(LSD_DIR, d, name);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {
    /* no external dir */
  }
  return null;
}

function loadLsdSpells(p) {
  if (!p) return null;
  const rows = JSON.parse(fs.readFileSync(p, "utf8")).table.spellBaseHash;
  const out = new Map();
  for (const r of rows) out.set(String(r.key), r.value);
  return out;
}

function scarabLevel(attrs, id) {
  const a = attrs[String(id)];
  return a && Array.isArray(a.formula) ? SCARAB_LEVEL.get(a.formula[0]) ?? null : null;
}

// One rung from the in-repo data (+ LSD when present). `old` supplies the
// LSD-only fields when the dump is absent (verify mode).
function rungOf(id, catalog, attrs, lsd, old) {
  const c = catalog[String(id)];
  if (!c) return { error: `${id}: not in ${path.basename(CATALOG)}` };
  const level = scarabLevel(attrs, id);
  if (level == null) return { error: `${id} ${c.name}: no scarab level in ${path.basename(ATTRS)}` };
  const v = lsd ? lsd.get(String(id)) : null;
  let metaSpellType;
  let power;
  let duration = Number(c.duration) || 0;
  if (v) {
    metaSpellType = v.meta_spell ? v.meta_spell.sp_type : null;
    power = Number.isFinite(v.power) ? v.power : null;
    const d = v.meta_spell && v.meta_spell.spell ? Number(v.meta_spell.spell.duration) : NaN;
    if (Number.isFinite(d) && d > 0) duration = d;
  } else {
    metaSpellType = old ? old.metaSpellType : null;
    power = old ? old.power : null; // power lives only in LSD
    if (!duration && old) duration = old.duration; // DoT windows live only in LSD
  }
  return {
    rung: { id, name: c.name, level, school: c.school, duration, untargeted: !!c.untargeted, metaSpellType, power },
    power: v ? v.power : null,
    hasLsd: !!v,
  };
}

// Build every family. Returns { families, kinds, errors, lsdChecks }.
function build(catalog, attrs, lsd, oldTable) {
  const families = {};
  const kinds = {};
  const errors = [];
  let lsdChecks = 0;
  const oldRung = (fam, id) => {
    const rows = oldTable && oldTable.families && oldTable.families[fam];
    return Array.isArray(rows) ? rows.find((r) => r.id === id) || null : null;
  };
  const addFamily = (fam, kind, ids) => {
    const rungs = [];
    for (const id of ids) {
      const r = rungOf(id, catalog, attrs, lsd, oldRung(fam, id));
      if (r.error) {
        errors.push(`${fam}: ${r.error}`);
        continue;
      }
      if (r.hasLsd) {
        lsdChecks++;
        if (!(r.power < POWER_CAP)) errors.push(`${fam}: ${id} ${r.rung.name} power ${r.power} >= ${POWER_CAP}`);
      }
      rungs.push(r.rung);
    }
    rungs.sort((a, b) => a.level - b.level || a.id - b.id);
    families[fam] = rungs;
    kinds[fam] = kind;
  };
  for (const [fam, kind, ids] of SEED_FAMILIES) addFamily(fam, kind, ids);

  // Item families: name walk over the catalog (school 3 only).
  const byName = new Map();
  for (const [id, s] of Object.entries(catalog)) {
    if (s.school !== 3) continue;
    const k = String(s.name).toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(Number(id));
  }
  const pick = (name) => {
    const ids = (byName.get(name.toLowerCase()) || []).slice().sort((a, b) => a - b);
    if (lsd) {
      const ok = ids.filter((i) => {
        const v = lsd.get(String(i));
        return !v || v.power < POWER_CAP;
      });
      return ok.length ? ok[0] : null;
    }
    return ids.length ? ids[0] : null;
  };
  for (const [fam, base, l1, l7] of ITEM_FAMILIES) {
    const c1 = catalog[String(l1)];
    if (!c1 || c1.name !== `${base} I` || c1.school !== 3) {
      errors.push(`${fam}: L1 seed ${l1} is not "${base} I" (school 3) — family has no L1`);
      continue;
    }
    const ids = [l1];
    for (let i = 1; i < ROMAN.length; i++) {
      const id = pick(`${base} ${ROMAN[i]}`);
      if (id == null) errors.push(`${fam}: no catalog spell "${base} ${ROMAN[i]}" (school 3)`);
      else ids.push(id);
    }
    if (catalog[String(l7)] && catalog[String(l7)].school === 3) ids.push(l7);
    else errors.push(`${fam}: L7 seed ${l7} missing or not school 3`);
    const l8 = pick(`Incantation of ${base}`);
    if (l8 == null) errors.push(`${fam}: no catalog spell "Incantation of ${base}" (school 3)`);
    else ids.push(l8);
    addFamily(fam, "item", ids);
  }
  return { families, kinds, errors, lsdChecks };
}

// Structural rules every family must satisfy (independent of LSD).
function structuralChecks(families, kinds) {
  const fails = [];
  for (const [fam, rungs] of Object.entries(families)) {
    const kind = kinds[fam];
    if (!Array.isArray(rungs) || !rungs.length) {
      fails.push(`${fam}: empty family`);
      continue;
    }
    const levels = rungs.map((r) => r.level);
    if (new Set(levels).size !== levels.length) fails.push(`${fam}: duplicate levels ${levels.join(",")}`);
    let lastPower = 0;
    for (const r of rungs) {
      if (!(Number.isFinite(r.power) && r.power > 0)) fails.push(`${fam}: ${r.id} ${r.name} has no power`);
      else if (r.power < lastPower) fails.push(`${fam}: ${r.id} ${r.name} power ${r.power} below the rung under it (${lastPower})`);
      else lastPower = r.power;
      if (kind === "ring") {
        if (r.untargeted !== true) fails.push(`${fam}: ring ${r.id} must be untargeted`);
        if (r.level >= 8) fails.push(`${fam}: L8 ring ${r.id} (none exist)`);
        if (r.school !== 1 && r.school !== 5) fails.push(`${fam}: ring ${r.id} school ${r.school}`);
      } else if (r.untargeted !== false) {
        fails.push(`${fam}: ${r.id} ${r.name} must be targeted (untargeted:false)`);
      }
      if (kind === "item" && r.school !== 3) fails.push(`${fam}: ${r.id} ${r.name} school ${r.school} want 3`);
      if (kind === "attack" && !(r.school === 1 || r.school === 5)) fails.push(`${fam}: ${r.id} school ${r.school}`);
      if ((kind === "debuff" || kind === "dot") && !(r.duration > 0)) fails.push(`${fam}: ${r.id} ${r.name} has no duration`);
      if (fam.endsWith(":nether") && r.school !== 5) fails.push(`${fam}: ${r.id} nether shape not Void`);
    }
    if (kind === "ring" && levels.join(",") !== "6,7") fails.push(`${fam}: ring levels ${levels.join(",")} want 6,7`);
    if (kind !== "ring" && levels.join(",") !== "1,2,3,4,5,6,7,8") fails.push(`${fam}: levels ${levels.join(",")} want 1..8`);
  }
  return fails;
}

function formatTable(families) {
  const lines = [];
  lines.push("{");
  lines.push(` "v": 1,`);
  lines.push(
    ` "_comment": ${JSON.stringify(
      "Generated by `node rynth_vt_spell_tables_test.cjs --write` (PLAN W1-7 CMB, Appendix C seeds + D38 item enchantments). " +
        "level = DAT scarab level; school 1 War 2 Life 3 Item 4 Creature 5 Void; duration in seconds (DoT window for cp/cs); " +
        "untargeted true only for rings; metaSpellType = LSD sp_type; power = LSD spell power (the difficulty SpellDiffExcessThreshold compares). " +
        "Ids only — never resolve spells by name."
    )},`
  );
  lines.push(` "families": {`);
  const fams = Object.keys(families);
  fams.forEach((fam, i) => {
    lines.push(`  ${JSON.stringify(fam)}: [`);
    const rungs = families[fam];
    rungs.forEach((r, j) => lines.push(`   ${JSON.stringify(r)}${j < rungs.length - 1 ? "," : ""}`));
    lines.push(`  ]${i < fams.length - 1 ? "," : ""}`);
  });
  lines.push(" }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

function checkSpecies(lsdSummaryPath) {
  const fails = [];
  let corpus = 0;
  let table;
  try {
    table = JSON.parse(fs.readFileSync(SPECIES, "utf8"));
  } catch (e) {
    return { fails: [`species: cannot read ${SPECIES}: ${e.message}`], corpus };
  }
  if (table.v !== 1 || !table.names || !table.wcid) fails.push("species: shape {v:1, names, wcid} expected");
  const names = table.names || {};
  for (const [k, want] of [["1", "Olthoi"], ["3", "Drudge"], ["9", "Phyntos Wasp"], ["32", "Shreth"], ["101", "Anekshay"]]) {
    if (names[k] !== want) fails.push(`species: names[${k}] = ${JSON.stringify(names[k])} want ${want}`);
  }
  for (const [w, ct] of Object.entries(table.wcid || {})) {
    if (!Number.isInteger(ct) || !names[String(ct)]) {
      fails.push(`species: wcid ${w} -> ${ct} has no name`);
      break;
    }
  }
  if (lsdSummaryPath) {
    const gen = require("./rynth/vt/tools/gen_creature_species.cjs");
    const want = gen.speciesFromSummary(fs.readFileSync(lsdSummaryPath, "utf8"), names);
    for (const [w, ct] of Object.entries(want)) {
      corpus++;
      if (table.wcid[w] !== ct) {
        fails.push(`species: wcid ${w} -> ${table.wcid[w]} want ${ct} (LSD)`);
        if (fails.length > 20) break;
      }
    }
    const extra = Object.keys(table.wcid).filter((w) => !(w in want));
    if (extra.length) fails.push(`species: ${extra.length} wcid(s) not in the LSD summary (e.g. ${extra[0]})`);
  }
  return { fails, corpus };
}

function main() {
  const write = process.argv.includes("--write");
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")).spells;
  const attrs = JSON.parse(fs.readFileSync(ATTRS, "utf8")).attrs;
  const lsdSpellsPath = findLsdFile("spells.json");
  const lsd = loadLsdSpells(lsdSpellsPath);

  if (write) {
    if (!lsd) {
      console.error("--write needs the LSD spells.json (metaSpellType, DoT durations, power cap); not found under " + LSD_DIR);
      process.exit(2);
    }
    const { families, kinds, errors } = build(catalog, attrs, lsd, null);
    const fails = errors.concat(structuralChecks(families, kinds));
    if (fails.length) {
      for (const f of fails) console.error("FAIL " + f);
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(TABLE), { recursive: true });
    fs.writeFileSync(TABLE, formatTable(families));
    console.log(`wrote ${Object.keys(families).length} families -> ${TABLE}`);
    return;
  }

  const fails = [];
  let committed;
  try {
    committed = JSON.parse(fs.readFileSync(TABLE, "utf8"));
  } catch (e) {
    console.log(`FAIL cannot read ${TABLE}: ${e.message}`);
    process.exit(1);
  }
  if (committed.v !== 1 || !committed.families || typeof committed.families !== "object") fails.push("table shape: {v:1, families} expected");
  const { families, kinds, errors, lsdChecks } = build(catalog, attrs, lsd, committed);
  fails.push(...errors);
  const want = Object.keys(families);
  const have = Object.keys(committed.families || {});
  for (const f of want) if (!have.includes(f)) fails.push(`missing family ${f}`);
  for (const f of have) if (!want.includes(f)) fails.push(`unexpected family ${f}`);
  let rungs = 0;
  for (const fam of want) {
    const a = committed.families[fam] || [];
    const b = families[fam];
    if (a.length !== b.length) {
      fails.push(`${fam}: ${a.length} rungs want ${b.length}`);
      continue;
    }
    for (let i = 0; i < b.length; i++) {
      rungs++;
      for (const k of ["id", "name", "level", "school", "duration", "untargeted", "metaSpellType", "power"]) {
        if (a[i][k] !== b[i][k]) fails.push(`${fam}[${i}] ${k}: ${JSON.stringify(a[i][k])} want ${JSON.stringify(b[i][k])}`);
      }
    }
  }
  fails.push(...structuralChecks(committed.families || {}, kinds));
  for (const [fam, id, level, label] of SPOTS) {
    const r = (committed.families[fam] || []).find((x) => x.id === id);
    if (!r || r.level !== level) fails.push(`spot ${fam} ${id} ${label}: got ${JSON.stringify(r)}`);
  }
  for (const [fam, id, power] of POWER_SPOTS) {
    const r = (committed.families[fam] || []).find((x) => x.id === id);
    if (!r || r.power !== power) fails.push(`power spot ${fam} ${id}: want ${power}, got ${JSON.stringify(r)}`);
  }
  if (lsd) {
    const dot = (committed.families.cp || []).concat(committed.families.cs || []);
    for (const r of dot) if (r.metaSpellType !== 15) fails.push(`dot ${r.id}: metaSpellType ${r.metaSpellType} want 15`);
  }

  const species = checkSpecies(findLsdFile("weenie_summary.jsonl"));
  fails.push(...species.fails);

  const corpus = lsdChecks + species.corpus;
  console.log(
    `checked ${rungs} rungs in ${want.length} families against ${path.basename(CATALOG)} + ${path.basename(ATTRS)}; ` +
      `${corpus} corpus checks${lsd ? " (LSD " + path.basename(path.dirname(lsdSpellsPath)) + ")" : " (LSD absent: metaSpellType/power/DoT windows unchecked)"}`
  );
  if (fails.length) {
    for (const f of fails.slice(0, 40)) console.log("FAIL " + f);
    console.log(`${fails.length} failure(s)${fails.length > 40 ? " (first 40 shown)" : ""}`);
    process.exit(1);
  }
  console.log(`PASS ${SPOTS.length + POWER_SPOTS.length} spot checks; combat spell table and species table consistent`);
}

if (require.main === module) main();
module.exports = { SEED_FAMILIES, ITEM_FAMILIES, build, structuralChecks };
