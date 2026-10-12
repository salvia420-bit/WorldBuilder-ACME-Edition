#!/usr/bin/env node
// rynth_spell_ladders_test.cjs — the B4/B5 family tier table
// (rynth/spell_ladders.json) checked against the DAT, and its generator.
//
// Entry shape (2026-10-12): id -> [category, tier, flags, power]
//   category  SpellCategory — the enchantment stacking family (LSD spells.json
//             `category`; the B2/B4 family key).
//   tier      spell LEVEL by retail's client formula — the formula's first
//             component is a scarab and the scarab names the level (ACE
//             SpellFormula.cs ScarabLevel: Lead 1 … Pyreal/Diamond 6,
//             Platinum/Dark 7, Mana 8). The July table derived the tier from
//             the trailing roman numeral, so every level-7 lore spell ("Might
//             of the Lugians") and level-8 Incantation read as tier 1 and B4
//             could never pick them (C# BuffManager.GetSpellLevel special-cases
//             exactly those two, :1268-1290).
//   flags     bit 0 = SelfTargeted (SpellFlags 0x8, DAT bitfield): retail casts
//             these TARGETED at the player's own object (ACE's untargeted
//             handler lands the enchantment but never broadcasts the
//             TargetEffect glow — ui/ac_cast_spell.js selfTargetGuidFor).
//             bit 1 = Enchantment (MetaSpellType 1): only these live in the
//             enchantment registry. Categories mix kinds — 67 holds Heal Self
//             (a Boost) beside Healing Mastery Self (an enchantment), 81 holds
//             Revitalize beside Vim — so B4 must ladder enchantments only, or
//             a desired buff resolves to a heal that can never "land".
//   power     spell Power (LSD) — ACE's stacking winner within a category;
//             the B4 tie-break between same-tier spells.
//
// Sources: data/spell-table-attrs.json (DAT-decrypted formula + bitfield,
// always present) and the LSD dump's spells.json (category, power,
// meta_spell.sp_type) when present at ../../../LSD-Partial-*/spells.json
// relative to the repo's external/ dir. Without LSD only the DAT-derived
// fields are checked.
//
// Run:   node rynth_spell_ladders_test.cjs           (verify; exit 1 on drift)
//        node rynth_spell_ladders_test.cjs --write   (regenerate the table from
//                                                     the same id set)

"use strict";
const fs = require("fs");
const path = require("path");

const APP = __dirname;
const TABLE = path.join(APP, "rynth", "spell_ladders.json");
const ATTRS = path.join(APP, "data", "spell-table-attrs.json");
const LSD_DIR = path.resolve(APP, "..", "..", "..");
const SELF_TARGETED = 0x8;
const SPELL_TYPE_ENCHANTMENT = 1;
// ACE SpellFormula.cs — Scarab enum id -> level.
const SCARAB_LEVEL = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [110, 6], [112, 7], [192, 7], [193, 8]]);

function findLsd() {
  try {
    for (const d of fs.readdirSync(LSD_DIR)) {
      if (!d.startsWith("LSD-Partial")) continue;
      const p = path.join(LSD_DIR, d, "spells.json");
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* no external dir */ }
  return null;
}

function loadLsd(p) {
  if (!p) return null;
  const rows = JSON.parse(fs.readFileSync(p, "utf8")).table.spellBaseHash;
  const out = new Map();
  for (const r of rows) out.set(String(r.key), r.value);
  return out;
}

function expected(id, attrs, lsd, old) {
  const a = attrs[id];
  if (!a) return null;
  const tier = SCARAB_LEVEL.get(a.formula && a.formula[0]) ?? old[1];
  const v = lsd ? lsd.get(id) : null;
  const ench = v ? (v.meta_spell && v.meta_spell.sp_type) === SPELL_TYPE_ENCHANTMENT : null;
  const flags = ((a.bitfield & SELF_TARGETED) ? 1 : 0) | (ench === null ? (old[2] ?? 0) & 2 : ench ? 2 : 0);
  return {
    category: v ? v.category : old[0],
    tier,
    flags,
    power: v ? v.power : (old[3] ?? 0),
    hasLsd: !!v,
  };
}

function main() {
  const write = process.argv.includes("--write");
  const table = JSON.parse(fs.readFileSync(TABLE, "utf8"));
  const attrs = JSON.parse(fs.readFileSync(ATTRS, "utf8")).attrs;
  const lsdPath = findLsd();
  const lsd = loadLsd(lsdPath);

  if (write) {
    if (!lsd) {
      console.error("--write needs the LSD spells.json (category/power/sp_type); not found under " + LSD_DIR);
      process.exit(2);
    }
    const out = {};
    for (const id of Object.keys(table).sort((a, b) => Number(a) - Number(b))) {
      const e = expected(id, attrs, lsd, table[id]);
      if (!e) { console.error(`no DAT attrs for ${id}`); process.exit(2); }
      out[id] = [e.category, e.tier, e.flags, e.power];
    }
    fs.writeFileSync(TABLE, JSON.stringify(out));
    console.log(`wrote ${Object.keys(out).length} entries -> ${TABLE}`);
    return;
  }

  const fails = [];
  let checked = 0;
  for (const [id, row] of Object.entries(table)) {
    if (!Array.isArray(row) || row.length !== 4) { fails.push(`${id}: shape ${JSON.stringify(row)} (want [category,tier,flags,power])`); continue; }
    const e = expected(id, attrs, lsd, row);
    if (!e) { fails.push(`${id}: missing from ${path.basename(ATTRS)}`); continue; }
    checked++;
    if (row[1] !== e.tier) fails.push(`${id}: tier ${row[1]} want ${e.tier} (scarab ${attrs[id].formula[0]})`);
    if ((row[2] & 1) !== (e.flags & 1)) fails.push(`${id}: selfTargeted bit ${row[2] & 1} want ${e.flags & 1}`);
    if (e.hasLsd) {
      if ((row[2] & 2) !== (e.flags & 2)) fails.push(`${id}: enchantment bit ${row[2] & 2} want ${e.flags & 2}`);
      if (row[0] !== e.category) fails.push(`${id}: category ${row[0]} want ${e.category}`);
      if (row[3] !== e.power) fails.push(`${id}: power ${row[3]} want ${e.power}`);
    }
  }

  // Spot checks a reader can verify by name (data/spells-catalog.json).
  const spot = [
    ["2", "Strength Self I", (r) => r[0] === 1 && r[1] === 1 && (r[2] & 3) === 3],
    ["1332", "Strength Self VI", (r) => r[0] === 1 && r[1] === 6],
    ["2087", "Might of the Lugians (Strength Self VII)", (r) => r[0] === 1 && r[1] === 7],
    ["4325", "Incantation of Strength Self (VIII)", (r) => r[0] === 1 && r[1] === 8],
    ["4291", "Incantation of Armor Self (VIII)", (r) => r[0] === 115 && r[1] === 8],
    ["6", "Heal Self I — a Boost, NOT an enchantment", (r) => r[0] === 67 && (r[2] & 1) === 1 && (lsd ? (r[2] & 2) === 0 : true)],
    ["874", "Healing Mastery Self I — same category 67, an enchantment", (r) => r[0] === 67 && (lsd ? (r[2] & 2) === 2 : true)],
    ["2963", "Aura of Hunter's Cunning — not SelfTargeted", (r) => (r[2] & 1) === 0],
  ];
  for (const [id, label, ok] of spot) {
    const r = table[id];
    if (!r || !ok(r)) fails.push(`spot ${id} ${label}: got ${JSON.stringify(r)}`);
  }

  console.log(`checked ${checked} entries against ${path.basename(ATTRS)}${lsd ? " + LSD " + path.basename(path.dirname(lsdPath)) : " (LSD absent: category/power/enchantment unchecked)"}`);
  if (fails.length) {
    for (const f of fails.slice(0, 40)) console.log("FAIL " + f);
    console.log(`${fails.length} failure(s)${fails.length > 40 ? " (first 40 shown)" : ""}`);
    process.exit(1);
  }
  console.log(`PASS ${spot.length} spot checks; table consistent`);
}

main();
