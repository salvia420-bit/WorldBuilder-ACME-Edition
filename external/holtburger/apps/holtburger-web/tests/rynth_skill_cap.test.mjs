// tests/rynth_skill_cap.test.mjs — rynth-macro-nav-4: the buffed-skill tier
// cap (rynth/skill_cap.js) and the fizzle-demotion expiry of rynth/vitals.js.
//
// Since 2026-10-12 vitals and buff B4 resolve to the HIGHEST KNOWN tier and
// learn a lower one only from three fizzles in a row; any trained character
// can learn a level 7/8 scroll (ACE Player_Skills.cs CanReadScroll) and ACE
// fails a cast below Power − 50 / rolls a 0.07 sigmoid above it
// (Player_Magic.cs GetCastingPreCheckStatus). RynthAi gates both paths by
// buffed skill (SpellManager.cs GetHighestBuffSpellTier, defaults 35..435).
// The vitals demotion also never expired.
//
//   H1-H6  skill_cap.js: the tier rule (= the VT planner's), thresholds, the
//          host-backed cap and its refresh, school by category (re-derived
//          from data/spells-catalog.json + rynth/spell_ladders.json)
//   V1     no cap: vitals resolve exactly as before (highest known tier) and
//          never read the skills
//   V2-V3  cap on, Life 200: heal / the B15 Stamina-to-Health rung resolve to
//          tier <= 4 (1161 / 2073 / 4311 skipped); Life 300 re-resolves to VI
//          after the cache refresh
//   V4-V5  no known tier within the cap / untrained Life: today's pick
//   V6-V7  a fizzle demotion (cap off) is lifted after 10 min, not sooner; a
//          "not in the spellbook" demotion stays
//   V8     cap on: a Life tier rise lifts the fizzle demotions it now covers
//   V9     cap on: a demoted tier never resolves UP to an above-cap fallback
//   B1    no cap: buff desired + host calls identical to a loop built
//          without the option (TryGetPlayerStats never read)
//   B2-B3  cap on: each family capped by ITS school (Creature / Life;
//          untrained Item keeps today's pick); a skill rise re-resolves at
//          the heartbeat once the cached read refreshes
//   B4     a fizzle-walked tier comes back when its school's tier rises to
//          cover it (not on a rise that doesn't)
//   B5     a walked tier still above the risen cap stays walked
//   B6     setSkillCap(null) restores today's pick
//   B7     a fizzle walk never goes UP to the above-cap fallback: it is undone
//          and counted toward the B9 park instead
//
// Fake hosts: the rynth_buff_tier_lock / rynth_magic_update shapes, plus
// TryGetPlayerStats() skills. The loops read Date.now(): a fake clock replaces
// it for this process only.
//
// Run from apps/holtburger-web/:  node tests/rynth_skill_cap.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";

const clock = { t: 5_000_000 };
const realNow = Date.now;
Date.now = () => clock.t;

const SC = await import("../rynth/skill_cap.js");
const { RynthVitals } = await import("../rynth/vitals.js");
const { RynthBuffLoop } = await import("../rynth/buff_loop.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}

const T0 = 5_000_000;
const SELF = 0x50000001;
const FIZZLE = 0x0402;
const NOT_IN_BOOK = 0x03fc;
const MIN = 60_000;
const SK_CREATURE = 31;
const SK_ITEM = 32;
const SK_LIFE = 33;

// ── H — skill_cap.js ────────────────────────────────────────────────────────
await check("H1 the tier rule: thresholds 35..435, at least tier 1, untrained 0, unreadable Infinity", () => {
  const T = SC.tierForSkill;
  assert.deepEqual([...SC.TIER_DEFAULTS], [35, 85, 135, 185, 235, 285, 335, 435]);
  assert.equal(T({ current: 0, training: 2 }), 1, "below tier 1's threshold still casts tier 1 (ComputeTier)");
  assert.equal(T({ current: 184, training: 2 }), 3);
  assert.equal(T({ current: 185, training: 2 }), 4);
  assert.equal(T({ current: 300, training: 3 }), 6);
  assert.equal(T({ current: 500, training: 3 }), 8);
  assert.equal(T({ current: 400, training: 1 }), 0, "untrained");
  assert.equal(T({ base: 240 }), 5, "base when current is absent");
  assert.equal(T(null), Infinity);
  assert.equal(T({ current: "x" }), Infinity);
  assert.equal(T({ current: 100 }, [1, 50, 100, 150, 200, 250, 300, 350]), 3, "custom thresholds");
});

await check("H2 skillCapFn: school -> skill (War 34, Life 33, Item 32, Creature 31, Void 43), numeric or string keys", () => {
  const cap = SC.skillCapFn({ 34: { current: 90 }, 33: { current: 300 }, "32": { current: 140 }, 31: { current: 190 }, 43: { current: 40, training: 1 } });
  assert.deepEqual([1, 2, 3, 4, 5].map(cap), [2, 6, 3, 4, 0]);
  assert.equal(SC.skillCapFn(null)(2), Infinity);
  assert.equal(SC.skillCapFn({})(2), Infinity, "no row for the school");
  assert.equal(SC.skillCapFn({ 33: { current: 300 } })(0), Infinity, "unknown school");
});

await check("H3 readTierThresholds: `${prefix}N` per tier, defaults for missing / non-numeric values", () => {
  const vals = { BuffMinSkillLevelTier1: 10, BuffMinSkillLevelTier4: "200", BuffMinSkillLevelTier8: "x" };
  const t = SC.readTierThresholds((k, d) => (k in vals ? vals[k] : d), "BuffMinSkillLevelTier");
  assert.deepEqual(t, [10, 85, 135, 200, 235, 285, 335, 435]);
});

await check("H4 createHostSkillCap: TryGetPlayerStats skills, one read per 5 s (refresh() forces one); Infinity while unreadable", () => {
  clock.t = T0;
  let reads = 0;
  const skills = { 33: { current: 200, training: 2 } };
  let ready = false;
  const host = { TryGetPlayerStats: () => (reads++, ready ? { skills } : null) };
  const cap = SC.createHostSkillCap(host);
  assert.equal(cap(2), Infinity, "stats plane not hydrated");
  ready = true;
  assert.equal(cap(2), Infinity, "cached");
  clock.t = T0 + 5_000;
  assert.equal(cap(2), 4);
  skills[33].current = 300;
  clock.t = T0 + 9_000;
  assert.equal(cap(2), 4, "still the cached read");
  assert.equal(reads, 2);
  cap.refresh();
  assert.equal(cap(2), 6);
  assert.equal(reads, 3);
  assert.equal(SC.createHostSkillCap(host, { tiers: [1, 2, 3, 4, 5, 6, 7, 250] })(2), 8, "custom thresholds");
  clock.t = T0;
});

await check("H5 raw playerStats() fallback (no TryGetPlayerStats): stride-6 skills, the box freed", () => {
  let freed = 0;
  const host = {
    s: { playerStats: () => ({ skills: [33, 250, 200, 5, 3, 0, 31, 90, 90, 0, 1, 0], vitals: [], free() { freed++; } }) },
  };
  const cap = SC.createHostSkillCap(host);
  assert.equal(cap(2), 5);
  assert.equal(cap(4), 0, "untrained Creature");
  assert.equal(freed, 1);
  assert.equal(SC.readSkills({ s: { playerStats: () => ({ skills: [] }) } }), null);
  assert.equal(SC.readSkills(null), null);
});

await check("H6 school by category: the Life / Item tables re-derived from the catalog over the ladder's enchantments; a record school wins", () => {
  const catalog = JSON.parse(fs.readFileSync(new URL("../data/spells-catalog.json", import.meta.url), "utf8")).spells;
  const ladder = JSON.parse(fs.readFileSync(new URL("../rynth/spell_ladders.json", import.meta.url), "utf8"));
  const byCat = new Map();
  for (const [id, row] of Object.entries(ladder)) {
    if (row.length > 2 && !(row[2] & 2)) continue; // enchantments only (B4 ladders those)
    const school = catalog[id] && catalog[id].school;
    assert.ok(school, `catalog row for ${id}`);
    if (!byCat.has(row[0])) byCat.set(row[0], new Set());
    byCat.get(row[0]).add(school);
  }
  const life = [];
  const item = [];
  for (const [cat, schools] of byCat) {
    assert.equal(schools.size, 1, `category ${cat} holds one school`);
    const [s] = schools;
    if (s === 2) life.push(cat);
    else if (s === 3) item.push(cat);
    else assert.equal(s, 4, `category ${cat}: Creature otherwise`);
    assert.equal(SC.buffSchoolOf(cat), s, `buffSchoolOf(${cat})`);
  }
  assert.deepEqual([...SC.BUFF_SCHOOL_CATEGORIES.life].sort((a, b) => a - b), life.sort((a, b) => a - b));
  assert.deepEqual([...SC.BUFF_SCHOOL_CATEGORIES.item].sort((a, b) => a - b), item.sort((a, b) => a - b));
  assert.equal(SC.buffSchoolOf(1, 2), 2, "record school wins");
  assert.equal(SC.buffSchoolOf(99999), 4, "unknown category: Creature (SkillForBuff default)");
  assert.equal(SC.capRose([1, 4, 1, 1, 1], [1, 5, 1, 1, 1], 2), true);
  assert.equal(SC.capRose([1, Infinity, 1, 1, 1], [1, 5, 1, 1, 1], 2), false, "readable is no rise");
  assert.deepEqual(SC.capsBySchool(() => { throw new Error("x"); }), [Infinity, Infinity, Infinity, Infinity, Infinity]);
});

// ── V — vitals ─────────────────────────────────────────────────────────────
function vitalsHost({ known, life = 200, lifeTraining = 3, vitals = [1, 40, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] } = {}) {
  const st = { known, life, lifeTraining, vitals, casts: [], handlers: [], token: null, statsReads: 0 };
  return {
    st,
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => 8,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetPlayerId: () => SELF,
    CastSpell: (target, id) => st.casts.push({ target, id }),
    ChangeCombatMode: () => true,
    TryGetPlayerInventory: () => [],
    TryGetPlayerStats: () => {
      st.statsReads++;
      return { skills: { [SK_LIFE]: { current: st.life, base: st.life, training: st.lifeTraining } } };
    },
    onEvent: (fn) => st.handlers.push(fn),
    tryClaimCast: (owner) => {
      if (st.token && st.token !== owner) return false;
      st.token = owner;
      return true;
    },
    releaseCast: (owner) => {
      if (st.token === owner) st.token = null;
    },
    get castToken() {
      return st.token ? { owner: st.token } : null;
    },
    s: {
      playerKnownSpells: () => st.known.slice(),
      playerStats: () => ({ vitals: st.vitals.slice(), skills: [], free() {} }),
    },
    emit(e) {
      for (const fn of st.handlers) fn(e);
    },
  };
}
const quiet = () => {};
const HEAL_ALL = [6, 1157, 1158, 1159, 1160, 1161, 2073, 4311];
const S2H = [1664, 1665, 1666, 1667, 1668, 1669, 2343, 4658];
// Three fizzles of the heal (cast, kind-13 fizzle) at hp 40 in combat.
function fizzleHeal(vit, host, n = 3) {
  for (let i = 0; i < n; i++) {
    host.st.token = null;
    clock.t += 1000;
    vit.step(true);
    clock.t += 200;
    host.emit({ kind: 13, u32: FIZZLE, u32b: 0, text: null });
  }
}

await check("V1 no cap: highest known tier, as before (V1 of rynth_magic_update), and the skills are never read", () => {
  clock.t = T0;
  const host = vitalsHost({ known: [6, 1157, 1161, 1664, 1669, 2343] });
  const vit = new RynthVitals(host, { log: quiet });
  assert.deepEqual(vit.spells, { healSelf: 1161, stamToHealth: 2343, stamToMana: 1676, revitalize: 1177 });
  vit.step(true);
  assert.equal(host.st.casts[0].id, 1161);
  assert.equal(host.st.statsReads, 0);
});

await check("V2 cap on, Life 200 (tier 4): heal and the B15 Stamina-to-Health rung resolve to IV; 1161 / 2073 / 4311 skipped", () => {
  clock.t = T0;
  const host = vitalsHost({ known: [...HEAL_ALL, ...S2H], life: 200, vitals: [1, 20, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] });
  const vit = new RynthVitals(host, { log: quiet, skillCap: SC.createHostSkillCap(host) });
  assert.equal(vit.spells.healSelf, 1159);
  assert.equal(vit.spells.stamToHealth, 1667);
  vit.step(true); // hp 20 <= 30, stam 100 > 20: the B15 emergency
  assert.equal(vit.lastReason, "EMERGENCY hp->stam");
  assert.deepEqual(host.st.casts[0], { target: SELF, id: 1667 });
});

await check("V3 Life raised to 300 (tier 6): re-resolves to VI once the cached read refreshes", () => {
  clock.t = T0;
  const host = vitalsHost({ known: HEAL_ALL, life: 200 });
  const vit = new RynthVitals(host, { log: quiet, skillCap: SC.createHostSkillCap(host) });
  assert.equal(vit.spells.healSelf, 1159);
  host.st.life = 300;
  assert.equal(vit.spells.healSelf, 1159, "same read");
  clock.t = T0 + SC.SKILL_CAP_REFRESH_MS;
  assert.equal(vit.spells.healSelf, 1161);
  host.st.life = 340;
  clock.t += SC.SKILL_CAP_REFRESH_MS;
  assert.equal(vit.spells.healSelf, 2073, "tier 7 (335)");
});

await check("V4 no known tier within the cap: today's pick (the highest known)", () => {
  clock.t = T0;
  const host = vitalsHost({ known: [1161, 4311], life: 90 });
  const vit = new RynthVitals(host, { log: quiet, skillCap: SC.createHostSkillCap(host) });
  assert.equal(vit.spells.healSelf, 4311);
});

await check("V5 untrained Life (cap 0) and unreadable skills (Infinity): today's pick", () => {
  clock.t = T0;
  const h1 = vitalsHost({ known: HEAL_ALL, life: 400, lifeTraining: 1 });
  assert.equal(new RynthVitals(h1, { log: quiet, skillCap: SC.createHostSkillCap(h1) }).spells.healSelf, 4311);
  const h2 = vitalsHost({ known: HEAL_ALL });
  h2.TryGetPlayerStats = () => null;
  assert.equal(new RynthVitals(h2, { log: quiet, skillCap: SC.createHostSkillCap(h2) }).spells.healSelf, 4311);
  const h3 = vitalsHost({ known: HEAL_ALL, life: 100 });
  const pinned = new RynthVitals(h3, { log: quiet, spells: { healSelf: 4311 }, skillCap: SC.createHostSkillCap(h3) });
  assert.equal(pinned.spells.healSelf, 4311, "an opts.spells pin still wins");
});

await check("V6 cap off: three fizzles demote VI to V; still demoted at 9 min; back after 10 min", () => {
  clock.t = T0;
  const host = vitalsHost({ known: [6, 1160, 1161] });
  const logs = [];
  const vit = new RynthVitals(host, { log: (m) => logs.push(m) });
  fizzleHeal(vit, host);
  const demotedAt = clock.t;
  assert.equal(vit.spells.healSelf, 1160);
  assert.equal(vit._demotedUntil.get(1161), demotedAt + 10 * MIN);
  clock.t = demotedAt + 9 * MIN;
  assert.equal(vit.spells.healSelf, 1160);
  clock.t = demotedAt + 10 * MIN;
  assert.equal(vit.spells.healSelf, 1161);
  assert.equal(vit._demoted.has(1161), false);
  assert.ok(logs.some((m) => m.includes("1161 back on the ladder")), logs.join(" | "));
  host.st.token = null;
  clock.t += 1000;
  vit.step(true);
  assert.equal(host.st.casts[host.st.casts.length - 1].id, 1161, "cast again");
  assert.equal(host.st.statsReads, 0, "no skill reads without a cap");
});

await check("V7 a 'not in the spellbook' demotion is for good (no expiry, not lifted by a later fizzle run)", () => {
  clock.t = T0;
  const host = vitalsHost({ known: [6, 1160, 1161] });
  const vit = new RynthVitals(host, { log: quiet });
  host.st.token = null;
  vit.step(true);
  clock.t += 200;
  host.emit({ kind: 13, u32: NOT_IN_BOOK, u32b: 0, text: null });
  assert.equal(vit.spells.healSelf, 1160);
  vit._demote(1161, "fizzled 3x in a row", 10 * MIN); // a pinned id can still fizzle-demote
  clock.t += 60 * MIN;
  assert.equal(vit.spells.healSelf, 1160);
  assert.equal(vit._demotedUntil.has(1161), false);
});

await check("V8 cap on: a Life tier rise lifts the fizzle demotions it now covers", () => {
  clock.t = T0;
  // Life 200 = tier 4; V unknown, so the heal sits at IV and falls to III.
  const host = vitalsHost({ known: [6, 1157, 1158, 1159, 1161], life: 200 });
  const vit = new RynthVitals(host, { log: quiet, skillCap: SC.createHostSkillCap(host) });
  assert.equal(vit.spells.healSelf, 1159);
  fizzleHeal(vit, host);
  assert.equal(vit.spells.healSelf, 1158, "IV demoted");
  host.st.life = 220; // still tier 4
  clock.t += SC.SKILL_CAP_REFRESH_MS;
  host.st.token = null;
  vit.step(true);
  assert.equal(vit._demoted.has(1159), true, "no tier change, no lift");
  host.st.life = 240; // tier 5
  clock.t += SC.SKILL_CAP_REFRESH_MS;
  host.st.token = null;
  vit.step(true);
  assert.equal(vit._demoted.has(1159), false);
  assert.equal(vit.spells.healSelf, 1159, "IV again (V unknown, VI above the cap)");
});

await check("V9 cap on: IV demoted with only VI above the cap: no resolution UP to VI (the axis waits for the expiry)", () => {
  clock.t = T0;
  const host = vitalsHost({ known: [1159, 1161], life: 200 });
  const vit = new RynthVitals(host, { log: quiet, skillCap: SC.createHostSkillCap(host) });
  assert.equal(vit.spells.healSelf, 1159);
  fizzleHeal(vit, host);
  const demotedAt = clock.t;
  assert.equal(vit.spells.healSelf, 6, "the unknown placeholder: _decide skips the axis");
  const casts = host.st.casts.length;
  host.st.token = null;
  clock.t += 1000;
  assert.equal(vit.step(true), false);
  assert.equal(host.st.casts.length, casts);
  clock.t = demotedAt + 10 * MIN;
  assert.equal(vit.spells.healSelf, 1159);
});

// ── B — buff loop ──────────────────────────────────────────────────────────
// Families with REAL categories (school by the category table — the records
// carry no school): Strength 1 (Creature), Regeneration 93 (Life), Blood
// Drinker 154 (Item); fake ids, tier = last digit.
const META = {};
for (let t = 1; t <= 8; t++) META[1010 + t] = [1, t];
for (let t = 1; t <= 6; t++) META[2010 + t] = [93, t];
for (let t = 1; t <= 6; t++) META[3010 + t] = [154, t];
const STR_1_7 = [1011, 1012, 1013, 1014, 1015, 1016, 1017];
const REGEN = [2011, 2012, 2013, 2014, 2015, 2016];
const BLOOD = [3011, 3012, 3013, 3014, 3015, 3016];

function buffHost({ known, creature = 200, life = 250, item = 300, itemTraining = 1 } = {}) {
  const st = { known, sk: { creature, life, item, itemTraining }, reg: [], useDone: 0, casts: [], handlers: [], token: null, calls: [] };
  const rec = (name, fn) => (...a) => (st.calls.push(name), fn(...a));
  return {
    st,
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => 8,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetPlayerId: () => SELF,
    CastSpell: (target, id) => st.casts.push({ target, id }),
    ChangeCombatMode: () => true,
    TryGetPlayerInventory: () => [],
    TryGetPlayerStats: rec("TryGetPlayerStats", () => ({
      skills: {
        [SK_CREATURE]: { current: st.sk.creature, training: 3 },
        [SK_LIFE]: { current: st.sk.life, training: 3 },
        [SK_ITEM]: { current: st.sk.item, training: st.sk.itemTraining },
      },
    })),
    onEvent: (fn) => st.handlers.push(fn),
    tryClaimCast: (owner) => {
      if (st.token && st.token !== owner) return false;
      st.token = owner;
      return true;
    },
    releaseCast: (owner) => {
      if (st.token === owner) st.token = null;
    },
    s: {
      playerEnchantments: rec("playerEnchantments", () => st.reg.map((r) => ({ ...r }))),
      playerKnownSpells: rec("playerKnownSpells", () => st.known.slice()),
      getUseDoneSeq: rec("getUseDoneSeq", () => st.useDone),
      getSpellRecord: rec("getSpellRecord", (id) => {
        const m = META[id >>> 0];
        return m ? { category: m[0], roughLevel: m[1] } : null;
      }),
    },
    emit(e) {
      for (const fn of st.handlers) fn(e);
    },
  };
}
function mk(host, raw, opts = {}) {
  const loop = new RynthBuffLoop(host, raw, { log: quiet, ...opts });
  loop.startedAt = clock.t;
  loop._buildLadders();
  loop.registryReady = true;
  loop._refresh();
  return loop;
}
const tickAt = (loop, t) => {
  clock.t = t;
  loop.tick();
};
function fizzleBuff(host) {
  host.emit({ kind: 13, u32: FIZZLE, u32b: 0, text: "Your spell fizzled." });
  host.st.useDone++;
  host.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
}
// Cast the current target three times, each answered by a fizzle: the third
// walks the family down a tier (retried in 10 min). Returns the walk time.
function threeFizzles(loop, host, t) {
  let walkAt = t;
  for (let i = 0; i < 3; i++) {
    tickAt(loop, t);
    assert.ok(loop.pending, `cast ${i + 1}`);
    clock.t = t + 300;
    fizzleBuff(host);
    tickAt(loop, t + 700);
    walkAt = t + 700;
    t += 1200;
  }
  return walkAt;
}

await check("B1 no cap: desired and the host-call trace are those of a loop built without the option; skills never read", () => {
  clock.t = T0;
  const run = (opts) => {
    clock.t = T0;
    const h = buffHost({ known: [...STR_1_7, ...REGEN, ...BLOOD] });
    const l = mk(h, [1011, 2011, 3011], opts);
    for (let i = 1; i <= 8; i++) {
      tickAt(l, T0 + i * 700);
      l.heartbeat();
    }
    return { desired: l.desired.slice(), calls: h.st.calls.join(","), casts: JSON.stringify(h.st.casts) };
  };
  const a = run({});
  const b = run({ skillCap: undefined });
  assert.deepEqual(a.desired, [1017, 2016, 3016]);
  assert.deepEqual(b, a);
  assert.equal(a.calls.includes("TryGetPlayerStats"), false);
});

await check("B2 cap on: each family capped by its own school — Creature 200 -> IV, Life 250 -> V, untrained Item keeps today's pick", () => {
  clock.t = T0;
  const h = buffHost({ known: [...STR_1_7, ...REGEN, ...BLOOD] });
  const l = mk(h, [1011, 2011, 3011], { skillCap: SC.createHostSkillCap(h) });
  assert.deepEqual(l.desired, [1014, 2015, 3016]);
  assert.deepEqual(l._skillCapsBuilt, [Infinity, 5, 0, 4, Infinity]);
});

await check("B3 Creature raised to 300: the heartbeat re-resolves IV -> VI once the cached read refreshes", () => {
  clock.t = T0;
  const h = buffHost({ known: [...STR_1_7, ...REGEN] });
  const l = mk(h, [1011, 2011], { skillCap: SC.createHostSkillCap(h) });
  assert.deepEqual(l.desired, [1014, 2015]);
  h.st.sk.creature = 300;
  l.heartbeat();
  assert.deepEqual(l.desired, [1014, 2015], "same read");
  clock.t = T0 + SC.SKILL_CAP_REFRESH_MS;
  l.heartbeat();
  assert.deepEqual(l.desired, [1016, 2015]);
});

await check("B4 a fizzle-walked tier comes back when its school's tier rises to cover it (not on a rise inside the same tier)", () => {
  clock.t = T0;
  // Creature 200 = tier 4; V unknown, so the walk goes IV -> III.
  const h = buffHost({ known: [1011, 1012, 1013, 1014, 1016, 1017] });
  const l = mk(h, [1011], { skillCap: SC.createHostSkillCap(h) });
  assert.deepEqual(l.desired, [1014]);
  const walkAt = threeFizzles(l, h, T0 + 100);
  assert.deepEqual(l.desired, [1013]);
  assert.equal(l._unresolvableUntil.get(1014), walkAt + 10 * MIN);
  h.st.sk.creature = 220; // still tier 4
  clock.t = walkAt + SC.SKILL_CAP_REFRESH_MS;
  l.heartbeat();
  assert.equal(l._unresolvable.has(1014), true);
  assert.deepEqual(l.desired, [1013]);
  h.st.sk.creature = 240; // tier 5
  clock.t += SC.SKILL_CAP_REFRESH_MS;
  l.heartbeat();
  assert.equal(l._unresolvable.has(1014), false);
  assert.equal(l._unresolvableUntil.has(1014), false);
  assert.deepEqual(l.desired, [1014], "IV again (V unknown, VI above the cap)");
});

await check("B5 no known tier within the cap: today's pick, walked down by fizzles; a rise that doesn't cover the walked tier leaves it walked", () => {
  clock.t = T0;
  const h = buffHost({ known: [1016, 1017], creature: 200 });
  const l = mk(h, [1011], { skillCap: SC.createHostSkillCap(h) });
  assert.deepEqual(l.desired, [1017], "nothing within tier 4: the highest known, as without a cap");
  const walkAt = threeFizzles(l, h, T0 + 100);
  assert.deepEqual(l.desired, [1016], "walked DOWN, never up");
  h.st.sk.creature = 240; // tier 5: VII still above it
  clock.t = walkAt + SC.SKILL_CAP_REFRESH_MS;
  l.heartbeat();
  assert.equal(l._unresolvable.has(1017), true);
  assert.deepEqual(l.desired, [1016]);
  clock.t = walkAt + 10 * MIN;
  l.heartbeat();
  assert.equal(l._unresolvable.has(1017), false, "the 10 min retry still applies (rynth-macro-nav-1)");
});

await check("B6 setSkillCap(null) restores today's pick at the next heartbeat; setSkillCap(fn) caps again", () => {
  clock.t = T0;
  const h = buffHost({ known: STR_1_7 });
  const l = mk(h, [1011], { skillCap: SC.createHostSkillCap(h) });
  assert.deepEqual(l.desired, [1014]);
  l.setSkillCap(null);
  l.heartbeat();
  assert.deepEqual(l.desired, [1017]);
  assert.equal(l._skillCapsBuilt, null);
  l.setSkillCap(SC.createHostSkillCap(h));
  l.heartbeat();
  assert.deepEqual(l.desired, [1014]);
});

await check("B7 IV fizzles out with only VI/VII above the cap: no walk UP to VII — undone, counted toward the B9 park", () => {
  clock.t = T0;
  const h = buffHost({ known: [1014, 1016, 1017], creature: 200 });
  const l = mk(h, [1017], { skillCap: SC.createHostSkillCap(h) });
  assert.deepEqual(l.desired, [1014]);
  threeFizzles(l, h, T0 + 100);
  assert.deepEqual(l.desired, [1014], "still IV");
  assert.equal(l._unresolvable.has(1014), false);
  assert.equal(l._unresolvableUntil.has(1014), false);
  assert.equal(l.noShows.get(1014), 1);
  assert.equal(h.st.casts.every((c) => c.id === 1014), true, JSON.stringify(h.st.casts));
});

Date.now = realNow;
console.log(fail === 0 ? `rynth_skill_cap: all ${pass} checks passed` : `rynth_skill_cap: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
