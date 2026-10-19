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
//   flags     bit 0 (1) = SelfTargeted (SpellFlags 0x8, DAT bitfield): retail
//             casts these TARGETED at the player's own object (ACE's untargeted
//             handler lands the enchantment but never broadcasts the
//             TargetEffect glow — ui/ac_cast_spell.js selfTargetGuidFor).
//             bit 1 (2) = Enchantment (MetaSpellType 1): only these live in the
//             enchantment registry. Categories mix kinds — 67 holds Heal Self
//             (a Boost) beside Healing Mastery Self (an enchantment), 81 holds
//             Revitalize beside Vim — so B4 must ladder enchantments only, or
//             a desired buff resolves to a heal that can never "land".
//             bit 2 (4) = CANONICAL (2026-10-19): the family's normal scroll
//             ladder — the rule below.
//             bit 3 (8) = SCROLL (2026-10-19): taught by a Scroll weenie in the
//             ACE world database (weenie type 34, PropertyDataId 28 = Spell).
//   power     spell Power (LSD) — ACE's stacking winner within a category;
//             the B4 tie-break between same-tier spells.
//
// The canonical scroll ladder (bit 2). A category is shared by the scroll
// ladder and by quest / NPC / potion / fellowship spells (family 1 holds
// Strength Self I–VI, Might of the Lugians and Incantation of Strength Self,
// but also Tusker Might, Zongo's Fist and the Empowering the Conclave
// fellowship spells). ACE's @addallspells (Player.PlayerSpellTable) grants
// several of those, and B4's best-(tier, Power) pick then preferred them —
// Zongo's Fist (VII, Power 420) over Might of the Lugians (VII, 300), Combat
// Medication (a 60 s spell) over Robustify. RynthAi never could: its resolver
// is NAME-based (SpellManager.GetDynamicSelfBuffId: "<Base> Self <roman>", the
// level-7 lore name, "Incantation of <Base> Self"). The bit restores that,
// data-driven. For each family the bot maintains (rynth/buff_families.js — the
// four RynthAi tables, base name "Strength Self" / "Heavy Weapon Mastery" /
// "Aura of Blood Drinker Self"), a row is canonical when it is a SelfTargeted
// enchantment (flags 1|2) whose catalog duration is the ladder standard for its
// tier (I–V 1800 s, VI 2700, VII 3600, VIII 5400) and
//   (a) it carries the ladder NAME for its tier — stem = base without " Self":
//         I–VI  "<stem> Self <roman>"      (auras "Aura of <X> Self <roman>")
//         VII   "<stem> Self VII" | "<stem> VII" (Arcanum Salvaging VII), else
//               the family's level-7 lore spell: the ONE name among its tier-7
//               rows at 3600 s (Might of the Lugians, Inner Calm, Robustify,
//               Aura of Infected Caress, Blessing of T'ing, …)
//         VIII  "Incantation of <stem> Self" | "Incantation of <stem>"
//               (auras "Aura of Incantation of <X>[ Self]")
//       — same-name copies all count (five "Light Weapon Mastery Self VII" ids
//       from the 2013 skill merge; the Gearcraft copies of Item Tinkering
//       Expertise, except the VI copy whose duration is 1800 s);
//   but where one tier holds (a) rows of DIFFERENT Power and a scroll teaches
//   some of them, only the scroll-taught ones: Blood Drinker VIII is 5183
//   (Power 350, ACE BloodDrinker8Cast, "Inscription of Aura of Blood Drinker
//   Self") — not 4395 (same name, Power 400, ACE BloodDrinkerSelf8, no scroll);
//   Spirit Drinker VIII is 5182 over 4414;
//   or (b) a scroll teaches it and it is an exact twin (tier, Power, duration)
//   of an (a) row of the family under another name (Inferno Ward = Fire
//   Protection Self V).
// Every (family, tier I–VIII) must end with at least one canonical row, and —
// once bit 3 is populated — at least one scroll-taught one; --write refuses
// otherwise. Families outside the four tables carry no bit-2 rows at all
// (buff_families.js rowCanonical() then answers null and callers keep their
// pre-ladder behaviour).
// Validation 2026-10-19 (ACE world DB v0.9.292: 2,513 scroll weenies → 2,413
// spells; 667 of this table's 1,429 spells are scroll-taught): over the 61
// families (60 RynthAi + Missile Weapon Mastery, category 19) the name rule
// (a) gives 545 rows and the scroll set 514 of their SelfTargeted
// enchantments; 513 agree. The rest: 30 same-name copies without a scroll (15
// Light Weapon Mastery, 8 Missile Weapon Mastery — the Bow / Crossbow /
// Thrown merge — and 7 Gearcraft; identical stats — kept), 4395/4414 (no
// scroll — dropped by the rival clause) and Inferno Ward (a scroll, another
// name — added by clause b): 544 canonical rows, every scroll-taught self
// enchantment of the families among them. No other category holds a
// scroll-taught self enchantment (81/87/89/91 — Revitalize and the vital
// transfers — are Boosts). Catalog and LSD durations agree on every table
// spell. Every canonical row is in ACE's
// PlayerSpellTable (rynth/testdata/ace_player_spell_table.json); every LSD
// scroll weenie that teaches a table spell agrees with bit 3 (the dump is
// partial — absence there proves nothing, so only presence is checked).
// `--report` lists what the rule leaves out, per family.
//
// Sources: data/spell-table-attrs.json (DAT-decrypted formula + bitfield,
// always present), data/spells-catalog.json (names, durations — always
// present), the LSD dump's spells.json (category, power, meta_spell.sp_type)
// when present at ../../../LSD-Partial-*/spells.json relative to the repo's
// external/ dir, and the ACE scroll list when passed with --scrolls=<file>.
// Without LSD only the DAT-derived fields are checked; without --scrolls bit 3
// is taken as stored (and the canonical rule reads it).
//
// Run:   node rynth_spell_ladders_test.cjs           (verify; exit 1 on drift)
//        node rynth_spell_ladders_test.cjs --report  (+ list the non-canonical
//                                                     self-enchantments per family)
//        node rynth_spell_ladders_test.cjs --write [--scrolls=<file>]
//                                                    (regenerate the table from
//                                                     the same id set)
//   --scrolls=<file>: one line per scroll weenie, the spell id first (tab or
//   space separated) — read-only, from the live ACE world database:
//     mysql -N -B ace_world -e "SELECT d.value FROM weenie w JOIN
//       weenie_properties_d_i_d d ON d.object_Id = w.class_Id AND d.type = 28
//       WHERE w.type = 34"
//   (credentials: ACE.Server's Config.js — never copy them anywhere).

"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = __dirname;
const TABLE = path.join(APP, "rynth", "spell_ladders.json");
const ATTRS = path.join(APP, "data", "spell-table-attrs.json");
const CATALOG = path.join(APP, "data", "spells-catalog.json");
const PST = path.join(APP, "rynth", "testdata", "ace_player_spell_table.json");
const FAMILIES = path.join(APP, "rynth", "buff_families.js");
const LSD_DIR = path.resolve(APP, "..", "..", "..");
const SELF_TARGETED = 0x8;
const SPELL_TYPE_ENCHANTMENT = 1;
const F_SELF = 1;
const F_ENCH = 2;
const F_CANON = 4;
const F_SCROLL = 8;
// ACE SpellFormula.cs — Scarab enum id -> level.
const SCARAB_LEVEL = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [110, 6], [112, 7], [192, 7], [193, 8]]);
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
const STD_DURATION = [0, 1800, 1800, 1800, 1800, 1800, 2700, 3600, 5400];

function findLsdDir() {
  try {
    for (const d of fs.readdirSync(LSD_DIR)) {
      if (!d.startsWith("LSD-Partial")) continue;
      if (fs.existsSync(path.join(LSD_DIR, d, "spells.json"))) return path.join(LSD_DIR, d);
    }
  } catch (_) { /* no external dir */ }
  return null;
}

function loadLsd(dir) {
  if (!dir) return null;
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "spells.json"), "utf8")).table.spellBaseHash;
  const out = new Map();
  for (const r of rows) out.set(String(r.key), r.value);
  return out;
}

// Spells taught by the LSD dump's scroll weenies (weenieType 34, didStats 28).
// Partial: a hit proves a scroll exists; a miss proves nothing.
function loadLsdScrollSpells(dir) {
  if (!dir) return null;
  const summary = path.join(dir, "weenie_summary.jsonl");
  const wdir = path.join(dir, "weenies");
  if (!fs.existsSync(summary) || !fs.existsSync(wdir)) return null;
  const wcids = new Set();
  for (const line of fs.readFileSync(summary, "utf8").replace(/^﻿/, "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.weenieType === 34) wcids.add(r.wcid);
    } catch (_) { /* skip a bad line */ }
  }
  const out = new Set();
  for (const fn of fs.readdirSync(wdir)) {
    if (!wcids.has(Number(fn.split(" ", 1)[0]))) continue;
    try {
      const w = JSON.parse(fs.readFileSync(path.join(wdir, fn), "utf8").replace(/^﻿/, ""));
      for (const s of w.didStats || []) if (s.key === 28) out.add(String(s.value));
    } catch (_) { /* skip */ }
  }
  return out;
}

function loadScrolls(file) {
  const out = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const id = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(id) && id > 0) out.add(String(id));
  }
  return out;
}

// Bits 0/1, tier, category and power as before 2026-10-19.
function expectedBase(id, attrs, lsd, old) {
  const a = attrs[id];
  if (!a) return null;
  const tier = SCARAB_LEVEL.get(a.formula && a.formula[0]) ?? old[1];
  const v = lsd ? lsd.get(id) : null;
  const ench = v ? (v.meta_spell && v.meta_spell.sp_type) === SPELL_TYPE_ENCHANTMENT : null;
  const flags = ((a.bitfield & SELF_TARGETED) ? F_SELF : 0) | (ench === null ? (old[2] ?? 0) & F_ENCH : ench ? F_ENCH : 0);
  return {
    category: v ? v.category : old[0],
    tier,
    flags,
    power: v ? v.power : (old[3] ?? 0),
    hasLsd: !!v,
  };
}

function ladderNames(base, tier) {
  const stem = base.replace(/ Self$/, "");
  const aura = /^Aura of (.+)$/.exec(stem);
  if (tier <= 6) return [`${stem} Self ${ROMAN[tier]}`];
  if (tier === 7) return [`${stem} Self VII`, `${stem} VII`];
  return aura ? [`Aura of Incantation of ${aura[1]} Self`, `Aura of Incantation of ${aura[1]}`] : [`Incantation of ${stem} Self`, `Incantation of ${stem}`];
}

// The rule in the header. rows: id -> { category, tier, flags (bits 0/1/3),
// power, name, duration }. -> { canonical: Set<id>, problems: string[],
// perFamily: Map<category, { base, canonical: [...], excluded: [...] }> }
function canonicalRule(rows, families) {
  const scrollData = [...rows.values()].some((r) => r.flags & F_SCROLL);
  const byCat = new Map();
  for (const [id, r] of rows) {
    if ((r.flags & (F_SELF | F_ENCH)) !== (F_SELF | F_ENCH)) continue;
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push({ id, ...r, scroll: (r.flags & F_SCROLL) !== 0 });
  }
  const canonical = new Set();
  const problems = [];
  const perFamily = new Map();
  for (const { category, base } of families) {
    const members = byCat.get(category) || [];
    const fam = { base, canonical: [], excluded: [] };
    for (let t = 1; t <= 8; t++) {
      const tierRows = members.filter((r) => r.tier === t && r.duration === STD_DURATION[t]);
      const want = new Set(ladderNames(base, t));
      let named = tierRows.filter((r) => want.has(r.name));
      if (!named.length && t === 7) {
        const lore = new Set(tierRows.map((r) => r.name));
        if (lore.size === 1) named = tierRows;
        else if (lore.size > 1) problems.push(`family ${category} (${base}) VII: ambiguous lore spell ${[...lore].join(" / ")}`);
      }
      if (new Set(named.map((r) => r.power)).size > 1 && named.some((r) => r.scroll)) named = named.filter((r) => r.scroll);
      const twins = tierRows.filter((r) => r.scroll && !named.includes(r) && named.some((n) => n.power === r.power));
      const rung = named.concat(twins);
      if (!rung.length) problems.push(`family ${category} (${base}) tier ${ROMAN[t]}: no canonical spell`);
      else if (scrollData && !rung.some((r) => r.scroll)) problems.push(`family ${category} (${base}) tier ${ROMAN[t]}: no scroll-taught canonical spell`);
      for (const r of rung) canonical.add(r.id);
    }
    for (const r of members) (canonical.has(r.id) ? fam.canonical : fam.excluded).push(r);
    perFamily.set(category, fam);
  }
  return { canonical, problems, perFamily };
}

async function main() {
  const write = process.argv.includes("--write");
  const report = process.argv.includes("--report");
  const scrollsArg = process.argv.find((a) => a.startsWith("--scrolls="));
  const table = JSON.parse(fs.readFileSync(TABLE, "utf8"));
  const attrs = JSON.parse(fs.readFileSync(ATTRS, "utf8")).attrs;
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")).spells;
  const lsdDir = findLsdDir();
  const lsd = loadLsd(lsdDir);
  const scrolls = scrollsArg ? loadScrolls(scrollsArg.slice("--scrolls=".length)) : null;
  const pst = fs.existsSync(PST) ? new Set(JSON.parse(fs.readFileSync(PST, "utf8")).ids.map(String)) : null;
  const F = await import(pathToFileURL(FAMILIES).href);
  const families = F.buffFamilies().map((f) => ({ category: f.category, base: f.base }));
  if (F.LADDER_FLAG_CANONICAL !== F_CANON || F.LADDER_FLAG_SCROLL !== F_SCROLL) throw new Error("buff_families.js flag bits drifted");

  if (write && !lsd) {
    console.error("--write needs the LSD spells.json (category/power/sp_type); not found under " + LSD_DIR);
    process.exit(2);
  }

  // Expected rows: bits 0/1 + fields from the DAT/LSD, bit 3 from --scrolls
  // (else as stored), then bit 2 by the rule over those.
  const exp = new Map();
  const fails = [];
  for (const id of Object.keys(table).sort((a, b) => Number(a) - Number(b))) {
    const row = table[id];
    if (!Array.isArray(row) || row.length !== 4) { fails.push(`${id}: shape ${JSON.stringify(row)} (want [category,tier,flags,power])`); continue; }
    const e = expectedBase(id, attrs, lsd, row);
    if (!e) {
      if (write) { console.error(`no DAT attrs for ${id}`); process.exit(2); }
      fails.push(`${id}: missing from ${path.basename(ATTRS)}`);
      continue;
    }
    const scroll = scrolls ? scrolls.has(id) : ((row[2] ?? 0) & F_SCROLL) !== 0;
    const c = catalog[id] || {};
    exp.set(id, { ...e, flags: e.flags | (scroll ? F_SCROLL : 0), name: String(c.name ?? ""), duration: Number(c.duration) });
  }
  const rule = canonicalRule(exp, families);
  for (const p of rule.problems) fails.push(`canonical rule: ${p}`);

  if (write) {
    if (rule.problems.length) {
      for (const p of rule.problems) console.error(`canonical rule: ${p}`);
      process.exit(2);
    }
    const out = {};
    for (const [id, e] of exp) out[id] = [e.category, e.tier, e.flags | (rule.canonical.has(id) ? F_CANON : 0), e.power];
    fs.writeFileSync(TABLE, JSON.stringify(out));
    console.log(`wrote ${Object.keys(out).length} entries (${rule.canonical.size} canonical) -> ${TABLE}`);
    return;
  }

  let checked = 0;
  for (const [id, e] of exp) {
    const row = table[id];
    checked++;
    if (row[1] !== e.tier) fails.push(`${id}: tier ${row[1]} want ${e.tier} (scarab ${attrs[id].formula[0]})`);
    if ((row[2] & F_SELF) !== (e.flags & F_SELF)) fails.push(`${id}: selfTargeted bit ${row[2] & F_SELF} want ${e.flags & F_SELF}`);
    if (e.hasLsd) {
      if ((row[2] & F_ENCH) !== (e.flags & F_ENCH)) fails.push(`${id}: enchantment bit ${row[2] & F_ENCH} want ${e.flags & F_ENCH}`);
      if (row[0] !== e.category) fails.push(`${id}: category ${row[0]} want ${e.category}`);
      if (row[3] !== e.power) fails.push(`${id}: power ${row[3]} want ${e.power}`);
    }
    if (scrolls && (row[2] & F_SCROLL) !== (e.flags & F_SCROLL)) fails.push(`${id}: scroll bit ${row[2] & F_SCROLL} want ${e.flags & F_SCROLL} (--scrolls)`);
    const canon = rule.canonical.has(id) ? F_CANON : 0;
    if ((row[2] & F_CANON) !== canon) fails.push(`${id} '${e.name}': canonical bit ${row[2] & F_CANON} want ${canon}`);
    if ((row[2] & ~(F_SELF | F_ENCH | F_CANON | F_SCROLL)) !== 0) fails.push(`${id}: unknown flag bits ${row[2]}`);
  }

  // Cross-checks against the other authorities.
  const notes = [];
  if (pst) {
    const missing = [...rule.canonical].filter((id) => !pst.has(id));
    if (missing.length) fails.push(`canonical rows outside ACE's PlayerSpellTable: ${missing.join(",")}`);
    notes.push(`PlayerSpellTable holds all ${rule.canonical.size} canonical rows`);
  }
  const lsdScrolls = loadLsdScrollSpells(lsdDir);
  if (lsdScrolls) {
    let hits = 0;
    for (const id of lsdScrolls) {
      if (!table[id]) continue;
      hits++;
      if (!(table[id][2] & F_SCROLL)) fails.push(`${id}: an LSD scroll weenie teaches it but the scroll bit is clear`);
    }
    notes.push(`LSD scroll weenies teach ${hits} table spells, all scroll-flagged`);
  }
  if (scrolls) notes.push(`--scrolls: ${scrolls.size} scroll-taught spells`);

  // Spot checks a reader can verify by name (data/spells-catalog.json).
  const canonOk = (r) => (r[2] & F_CANON) !== 0;
  const spot = [
    ["2", "Strength Self I", (r) => r[0] === 1 && r[1] === 1 && (r[2] & 3) === 3 && canonOk(r)],
    ["1332", "Strength Self VI", (r) => r[0] === 1 && r[1] === 6 && canonOk(r)],
    ["2087", "Might of the Lugians (Strength Self VII)", (r) => r[0] === 1 && r[1] === 7 && canonOk(r)],
    ["4325", "Incantation of Strength Self (VIII)", (r) => r[0] === 1 && r[1] === 8 && canonOk(r)],
    ["4291", "Incantation of Armor Self (VIII)", (r) => r[0] === 115 && r[1] === 8 && canonOk(r)],
    ["6", "Heal Self I — a Boost, NOT an enchantment", (r) => r[0] === 67 && (r[2] & 1) === 1 && (lsd ? (r[2] & 2) === 0 : true) && !canonOk(r)],
    ["874", "Healing Mastery Self I — same category 67, an enchantment", (r) => r[0] === 67 && (lsd ? (r[2] & 2) === 2 : true) && canonOk(r)],
    ["2963", "Aura of Hunter's Cunning — not SelfTargeted", (r) => (r[2] & 1) === 0 && !canonOk(r)],
    ["3864", "Zongo's Fist — family 1 VII, Power 420, 3 h: off the ladder", (r) => r[0] === 1 && r[1] === 7 && !canonOk(r)],
    ["2929", "Tusker Might — off the ladder", (r) => r[0] === 1 && !canonOk(r)],
    ["3848", "Combat Medication — a 60 s Regeneration spell: off the ladder", (r) => r[0] === 93 && !canonOk(r)],
    ["4022", "Zombies Persistence — 60 s: off the ladder", (r) => r[0] === 93 && !canonOk(r)],
    ["4040", "Master's Innervation — Power 1000: off the ladder", (r) => r[0] === 93 && !canonOk(r)],
    ["2185", "Robustify (Regeneration Self VII)", (r) => r[0] === 93 && r[1] === 7 && canonOk(r)],
    ["5183", "Aura of Incantation of Blood Drinker Self — the Inscription's spell", (r) => r[0] === 154 && r[1] === 8 && canonOk(r) && (r[2] & F_SCROLL) !== 0],
    ["4395", "Aura of Incantation of Blood Drinker Self — Power 400, no scroll", (r) => r[0] === 154 && !canonOk(r)],
    ["3337", "Inferno Ward — scroll-taught twin of Fire Protection Self V", (r) => r[0] === 109 && r[1] === 5 && canonOk(r)],
    ["5066", "Item Tinkering Expertise Self VI (Gearcraft copy, 1800 s)", (r) => r[0] === 57 && !canonOk(r)],
    ["5067", "Yoshi's Blessing (Gearcraft copy, standard stats)", (r) => r[0] === 57 && r[1] === 7 && canonOk(r)],
    ["467", "Missile Weapon Mastery Self I (family 19, added 2026-10-19)", (r) => r[0] === 19 && r[1] === 1 && (r[2] & 3) === 3 && canonOk(r)],
    ["2207", "Missile Weapon Mastery Self VII", (r) => r[0] === 19 && r[1] === 7 && canonOk(r) && (r[2] & F_SCROLL) !== 0],
    ["4522", "Incantation of Missile Weapon Mastery Self", (r) => r[0] === 19 && r[1] === 8 && canonOk(r) && (r[2] & F_SCROLL) !== 0],
    ["4628", "Incantation of Missile Weapon Mastery Self (merge copy, no scroll)", (r) => r[0] === 19 && r[1] === 8 && canonOk(r) && (r[2] & F_SCROLL) === 0],
  ];
  // Every family of buff_families.js has a full I–VIII ladder (the rule
  // refuses otherwise; this pins the family count the cross-checks ran over).
  if (families.length !== 61 || !families.some((f) => f.category === 19)) fails.push(`families: ${families.length} (want 61, Missile Weapon Mastery 19 included)`);
  for (const [id, label, ok] of spot) {
    const r = table[id];
    if (!r || !ok(r)) fails.push(`spot ${id} ${label}: got ${JSON.stringify(r)}`);
  }

  if (report) {
    console.log("non-canonical self-enchantments per family (the B4/dynamic-list exclusions):");
    for (const [cat, fam] of rule.perFamily) {
      if (!fam.excluded.length) continue;
      const ex = fam.excluded.sort((a, b) => a.tier - b.tier || a.id - b.id).map((r) => `${r.id} ${r.name} (${ROMAN[r.tier]}, P${r.power}, ${r.duration}s${r.scroll ? ", scroll" : ""})`);
      console.log(`  ${cat} ${fam.base}: ${ex.join("; ")}`);
    }
  }

  const canonCount = Object.values(table).filter((r) => r[2] & F_CANON).length;
  console.log(`checked ${checked} entries against ${path.basename(ATTRS)}${lsd ? " + LSD " + path.basename(lsdDir) : " (LSD absent: category/power/enchantment unchecked)"}; ${canonCount} canonical over ${families.length} families`);
  for (const n of notes) console.log(`  ${n}`);
  if (fails.length) {
    for (const f of fails.slice(0, 40)) console.log("FAIL " + f);
    console.log(`${fails.length} failure(s)${fails.length > 40 ? " (first 40 shown)" : ""}`);
    process.exit(1);
  }
  console.log(`PASS ${spot.length} spot checks; table consistent`);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
