// tests/rynth_buff_canonical.test.mjs — the scroll-ladder fix (2026-10-19):
// owner report "the list of spells for buffs contains spells that players
// shouldn't normally be able to cast". A SpellCategory mixes the scroll ladder
// with quest / NPC / potion spells; ACE's @addallspells (PlayerSpellTable)
// grants several of those, and the best-(tier, Power) pick preferred them.
// spell_ladders.json flag bit 2 (rynth_spell_ladders_test.cjs) marks each bot
// family's scroll ladder; buff_loop.js offers and casts only that.
//
// The dev character knows every PlayerSpellTable spell
// (rynth/testdata/ace_player_spell_table.json, 3662 ids).
//   C1  buildDynamicBuffList: every id on the ladder; Strength = Incantation of
//       Strength Self; Blood Drinker = the Inscription's 5183, not 4395
//   C2  B4 on the dev character, no cap: every family's tier-I request and the
//       dynamic list resolve to ladder spells only (tier VIII)
//   C3  skill-cap sweep 1..8: B4 never resolves to a spell off the ladder; at 7
//       Strength = Might of the Lugians (not Zongo's Fist), Regeneration =
//       Robustify (not Combat Medication / Master's Innervation); at 6
//       Regeneration Self VI (not Zombies / Unnatural Persistence), Strength
//       Self VI (not Tusker Might)
//   C4  a fizzle walk from the Incantation lands on Might of the Lugians
//   C5  an explicit pin (Zongo's Fist) is cast as named; three fizzles walk it
//       to the ladder AT OR BELOW its tier (Might of the Lugians); it is back
//       after the 10-minute retry
//   C6  a pin the character doesn't know: the family's ladder at or below the
//       pin's tier (Strength Self VI, not the Incantation)
//   C7  only off-ladder members known: the dynamic list skips the family;
//       filterCastableBuffs drops a ladder request for it, keeps a known pin
//   C8  canonicalBuffFamilies (HUD picker): one row per bot family (61), each
//       its tier-VIII ladder spell, in the bot's order; buffFamilyInfo labels,
//       groups and schools (= skill_cap.js buffSchoolOf)
//   C9  helpers: isCanonicalBuff / canonicalTier / canonicalLadder / buffFamilyOf
//   C10 a table without ladder data (pre-2026-10-19) keeps the old picks
//   C11 Missile Weapon Mastery (category 19, added 2026-10-19 — RynthAi has no
//       MissileWeapons skill): after Finesse in the bot's order, gated on the
//       trained Missile Weapons skill (47), a full scroll ladder I–VIII
//
// Run from apps/holtburger-web/:  node tests/rynth_buff_canonical.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";

const clock = { t: 7_000_000 };
const realNow = Date.now;
Date.now = () => clock.t;

const BL = await import("../rynth/buff_loop.js");
const SC = await import("../rynth/skill_cap.js");
const ladder = await BL.loadSpellLadders();
const PST = JSON.parse(fs.readFileSync(new URL("../rynth/testdata/ace_player_spell_table.json", import.meta.url), "utf8")).ids;
const catalog = JSON.parse(fs.readFileSync(new URL("../data/spells-catalog.json", import.meta.url), "utf8")).spells;
const nameOf = (id) => catalog[String(id)]?.name ?? `#${id}`;
const isCanon = (id) => BL.isCanonicalBuff(id, ladder);

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

// The oddballs of the owner report (all in the PlayerSpellTable except 4040).
const ZONGO = 3864;
const TUSKER_MIGHT = 2929;
const COMBAT_MEDICATION = 3848;
const ZOMBIES_PERSISTENCE = 4022;
const UNNATURAL_PERSISTENCE = 2382;
const MASTERS_INNERVATION = 4040;
const LUGIANS = 2087;
const STR_INC = 4325;
const ROBUSTIFY = 2185;
const SELF = 0x50000001;
const FIZZLE = 0x0402;
const MIN = 60_000;
const quiet = () => {};

function host({ known = PST } = {}) {
  const st = { known, reg: [], useDone: 0, casts: [], handlers: [], token: null };
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
      playerEnchantments: () => st.reg.map((r) => ({ ...r })),
      playerKnownSpells: () => st.known.slice(),
      getUseDoneSeq: () => st.useDone,
    },
    emit(e) {
      for (const fn of st.handlers) fn(e);
    },
  };
}
function mk(h, raw, opts = {}) {
  const loop = new BL.RynthBuffLoop(h, raw, { log: quiet, ...opts });
  loop.startedAt = clock.t;
  loop._buildLadders();
  loop.registryReady = true;
  loop._refresh();
  return loop;
}
// Cast the current target three times, each answered by a fizzle (kind 13
// YourSpellFizzled, then the cast's own UseDone): the third walks the family.
function threeFizzles(loop, h, t) {
  for (let i = 0; i < 3; i++) {
    clock.t = t;
    loop.tick();
    assert.ok(loop.pending, `cast ${i + 1}`);
    clock.t = t + 300;
    h.emit({ kind: 13, u32: FIZZLE, u32b: 0, text: "Your spell fizzled." });
    h.st.useDone++;
    h.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
    clock.t = t + 700;
    loop.tick();
    t += 1200;
  }
  return clock.t;
}
const off = (ids) => ids.filter((id) => !isCanon(id)).map((id) => `${id} ${nameOf(id)}`);
// Each bot family's tier-I ladder spell — what a "Strength Self I" style
// request names.
const tierOne = BL.BUFF_FAMILY_ORDER.map((c) => BL.canonicalLadder(c, ladder)[0].id);

await check("C1 dynamic list for the @addallspells character: ladder spells only, the Incantations, Blood Drinker 5183", () => {
  const list = BL.buildDynamicBuffList({ knownIds: PST, skills: null, ladder });
  assert.equal(list.length, 61, "every bot family");
  assert.ok(list.includes(4522), "Incantation of Missile Weapon Mastery Self (the scroll-taught copy)");
  assert.deepEqual(off(list), []);
  assert.ok(list.includes(STR_INC), "Incantation of Strength Self");
  assert.ok(list.includes(5183) && !list.includes(4395), "the scroll-taught Blood Drinker VIII");
  assert.ok(list.includes(5182) && !list.includes(4414), "the scroll-taught Spirit Drinker VIII");
  for (const bad of [ZONGO, TUSKER_MIGHT, COMBAT_MEDICATION, ZOMBIES_PERSISTENCE, UNNATURAL_PERSISTENCE, 3530, 2393]) {
    assert.ok(!list.includes(bad), `${bad} ${nameOf(bad)} offered`);
  }
  assert.ok(list.every((id) => ladder[String(id)][1] === 8), "tier VIII everywhere");
});

await check("C2 B4 on the @addallspells character (no cap): tier-I requests and the dynamic list resolve to ladder spells only", () => {
  clock.t = 7_000_000;
  const a = mk(host(), tierOne);
  assert.deepEqual(off(a.desired), []);
  assert.ok(a.desired.every((id) => ladder[String(id)][1] === 8));
  assert.equal(a.desired[BL.BUFF_FAMILY_ORDER.indexOf(1)], STR_INC);
  const dyn = BL.buildDynamicBuffList({ knownIds: PST, ladder });
  const b = mk(host(), dyn);
  assert.deepEqual(b.desired, dyn, "the dynamic list is already B4's answer");
});

await check("C3 skill-cap sweep 1..8: never off the ladder; 7 = Lugians / Robustify, 6 = Strength VI / Regeneration VI", () => {
  for (let tier = 1; tier <= 8; tier++) {
    clock.t = 7_000_000;
    const loop = mk(host(), tierOne, { skillCap: () => tier });
    assert.deepEqual(off(loop.desired), [], `cap ${tier}`);
    assert.ok(loop.desired.every((id) => ladder[String(id)][1] === tier), `cap ${tier}: the ladder has every tier`);
  }
  const at = (tier, cat) => mk(host(), tierOne, { skillCap: () => tier }).desired[BL.BUFF_FAMILY_ORDER.indexOf(cat)];
  assert.equal(at(7, 1), LUGIANS, "Might of the Lugians, not Zongo's Fist (VII, Power 420)");
  assert.equal(at(7, 93), ROBUSTIFY, "Robustify, not Combat Medication (60 s) / Master's Innervation");
  assert.equal(at(6, 93), 170, "Regeneration Self VI, not Zombies Persistence (60 s) / Unnatural Persistence");
  assert.equal(at(6, 1), 1332, "Strength Self VI, not Tusker Might");
  assert.equal(at(7, 9), 2067, "Inner Calm, not Ketnan's Eye");
  assert.equal(at(7, 37), 2245, "Aura of Defense, not Aerbax's Melee Shield (180 s)");
});

await check("C4 the fizzle walk from the Incantation lands on Might of the Lugians, never Zongo's Fist", () => {
  clock.t = 7_100_000;
  const h = host();
  const loop = mk(h, [2]);
  assert.deepEqual(loop.desired, [STR_INC]);
  threeFizzles(loop, h, clock.t + 100);
  assert.deepEqual(loop.desired, [LUGIANS]);
  assert.ok(h.st.casts.every((c) => isCanon(c.id)), JSON.stringify(h.st.casts));
});

await check("C5 an explicit pin is cast as named; fizzles walk it to the ladder at or below its tier; it returns after 10 min", () => {
  clock.t = 7_200_000;
  const h = host();
  const loop = mk(h, [ZONGO]);
  assert.deepEqual(loop.desired, [ZONGO], "kept as named — no upgrade to the Incantation");
  const walkAt = threeFizzles(loop, h, clock.t + 100);
  assert.deepEqual(h.st.casts.map((c) => c.id), [ZONGO, ZONGO, ZONGO]);
  assert.deepEqual(loop.desired, [LUGIANS], "walked to the ladder at VII, not up to VIII");
  clock.t = walkAt + 10 * MIN - 1;
  loop.heartbeat();
  assert.deepEqual(loop.desired, [LUGIANS]);
  clock.t = walkAt + 10 * MIN;
  loop.heartbeat();
  assert.deepEqual(loop.desired, [ZONGO], "the pin is back");
  // The opt-in skill cap does not override a known pin…
  assert.deepEqual(mk(host(), [ZONGO], { skillCap: () => 4 }).desired, [ZONGO]);
  // …but an unknown one (Master's Innervation is not even in the
  // PlayerSpellTable) falls back to the ladder within the cap.
  assert.ok(!PST.includes(MASTERS_INNERVATION));
  assert.deepEqual(mk(host(), [MASTERS_INNERVATION], { skillCap: () => 4 }).desired, [168], "Regeneration Self IV");
});

await check("C6 a pin the character doesn't know: its family's ladder at or below the pin's tier", () => {
  clock.t = 7_300_000;
  const known = [2, 1328, 1329, 1330, 1331, 1332, STR_INC]; // Strength I–VI + VIII, no VII at all
  const kept = BL.filterCastableBuffs([ZONGO], known, ladder);
  assert.deepEqual(kept, [ZONGO], "kept: a ladder tier at or below VII is known");
  const loop = mk(host({ known }), [ZONGO]);
  assert.deepEqual(loop.desired, [1332], "Strength Self VI — the pin named a tier-VII buff, not the Incantation");
  assert.deepEqual(BL.filterCastableBuffs([ZONGO], [STR_INC], ladder), [], "only VIII known: nothing at or below VII");
});

await check("C7 only off-ladder members known: the dynamic list skips the family; a ladder request is dropped, a known pin kept", () => {
  const known = [TUSKER_MIGHT, COMBAT_MEDICATION, 165]; // Tusker Might, Combat Medication, Regeneration Self I
  const list = BL.buildDynamicBuffList({ knownIds: known, ladder });
  assert.deepEqual(list, [165], "Strength skipped; Regeneration through its ladder spell only");
  assert.deepEqual(BL.filterCastableBuffs([2, 1332, TUSKER_MIGHT, 166, COMBAT_MEDICATION], known, ladder), [TUSKER_MIGHT, 166, COMBAT_MEDICATION]);
  const loop = mk(host({ known }), [TUSKER_MIGHT, 166]);
  assert.deepEqual(loop.desired, [TUSKER_MIGHT, 165], "the pin as named; Regeneration II request -> the known ladder tier I");
});

await check("C8 canonicalBuffFamilies (HUD picker): 61 rows, tier VIII ladder spells, bot order; labels / groups / schools", () => {
  const rows = BL.canonicalBuffFamilies({ knownIds: PST, ladder });
  assert.equal(rows.length, 61);
  assert.deepEqual(rows.map((r) => r.category), [...BL.BUFF_FAMILY_ORDER]);
  assert.equal(rows[0].label, "Creature Enchantment Mastery");
  assert.deepEqual(off(rows.map((r) => r.spellId)), []);
  assert.ok(rows.every((r) => r.tier === 8 && r.tierText === "VIII"));
  const byCat = new Map(rows.map((r) => [r.category, r]));
  assert.equal(byCat.get(1).label, "Strength");
  assert.equal(byCat.get(37).label, "Invulnerability");
  assert.equal(byCat.get(37).group, "Defenses");
  assert.equal(byCat.get(154).label, "Blood Drinker aura");
  assert.equal(byCat.get(154).group, "Weapon auras");
  assert.equal(byCat.get(93).group, "Regeneration");
  assert.equal(byCat.get(115).group, "Protections");
  assert.equal(byCat.get(435).label, "Arcanum Salvaging");
  for (const r of rows) {
    assert.equal(BL.BUFF_GROUPS[r.groupOrder], r.group);
    assert.equal(r.school, SC.buffSchoolOf(r.category), `school of ${r.category}`);
    assert.deepEqual(BL.buffFamilyInfo(r.category).label, r.label);
  }
  assert.equal(BL.buffFamilyInfo(20), null, "Missile Weapon Mastery Other's category is no self-buff family");
  // Only Strength known at II: one row.
  assert.deepEqual(BL.canonicalBuffFamilies({ knownIds: [1328, ZONGO], ladder }).map((r) => [r.spellId, r.tierText]), [[1328, "II"]]);
});

await check("C9 helpers: isCanonicalBuff / canonicalTier / canonicalLadder / buffFamilyOf", () => {
  assert.equal(BL.isCanonicalBuff(LUGIANS, ladder), true);
  assert.equal(BL.isCanonicalBuff(ZONGO, ladder), false);
  assert.equal(BL.isCanonicalBuff(99999, ladder), false);
  assert.equal(BL.isCanonicalBuff(LUGIANS), true, "defaults to the loaded table");
  assert.equal(BL.canonicalTier(STR_INC), 8);
  assert.equal(BL.canonicalTier(ZONGO), null);
  assert.deepEqual(BL.canonicalLadder(1).map((r) => r.id), [2, 1328, 1329, 1330, 1331, 1332, LUGIANS, STR_INC]);
  assert.deepEqual(BL.canonicalLadder(17).filter((r) => r.tier === 7).map((r) => r.id)[0], 2203, "same-name copies: the scroll-taught, lowest id first");
  assert.deepEqual(BL.canonicalLadder(81), [], "no ladder data outside the bot families (81: Revitalize Self, Boosts)");
  assert.ok(Object.values(ladder).some((r) => r[0] === 81), "…though the table holds category 81 rows");
  assert.equal(BL.buffFamilyOf(ZONGO), 1);
  assert.equal(BL.buffFamilyOf(27), null);
  // A family-selector spec (VT Buffs tab) migrated onto the ladder.
  assert.deepEqual(BL.toLadderSpec([ZONGO, 4395, 1332, 27, 6], ladder), [2, 35, 1332, 27, 6], "off-ladder -> tier I of the family; ladder, unknown and Heal Self (no ladder family) unchanged");
  assert.equal(BL.toLadderSpec("auto", ladder), "auto");
  assert.deepEqual(BL.filterCastableBuffs(BL.toLadderSpec([4395], ladder), [5183], ladder), [35], "kept, and B4 resolves it to the known 5183");
});

await check("C10 a table without ladder data (pre-2026-10-19) keeps the old picks", () => {
  const old = {};
  for (const [k, r] of Object.entries(ladder)) old[k] = [r[0], r[1], r[2] & 3, r[3]];
  const list = BL.buildDynamicBuffList({ knownIds: PST, ladder: old });
  assert.ok(list.includes(4395), "best (tier, Power) — the old Blood Drinker pick");
  assert.deepEqual(BL.filterCastableBuffs([2], [ZONGO], old), [2], "any known enchantment of the family");
  assert.deepEqual(BL.canonicalBuffFamilies({ knownIds: PST, ladder: old }), [], "the picker needs ladder data");
});

await check("C11 Missile Weapon Mastery (19): after Finesse, gated on trained Missile Weapons (47), a full scroll ladder", () => {
  const order = [...BL.BUFF_FAMILY_ORDER];
  assert.equal(order.indexOf(19), order.indexOf(23) + 1, "right after Finesse Weapon Mastery");
  assert.equal(order.indexOf(593), order.indexOf(19) + 1, "before Two Handed Combat Mastery");
  const info = BL.buffFamilyInfo(19);
  assert.deepEqual([info.label, info.group, info.school], ["Missile Weapon Mastery", "Masteries", 4]);
  assert.equal(SC.buffSchoolOf(19), 4, "Creature, like the other masteries");
  assert.deepEqual(BL.SKILL_BUFFS.find(([, , c]) => c === 19), [47, "Missile Weapon Mastery", 19]);
  // Gating: trained (2) / specialized (3) in, untrained (1) out; unknown skills (null) in.
  const known = [418, 467]; // Heavy / Missile Weapon Mastery Self I
  const dyn = (sk) => BL.buildDynamicBuffList({ knownIds: known, skills: sk, ladder });
  assert.deepEqual(dyn(new Map([[44, 2], [47, 2]])), [418, 467], "both trained: Heavy then Missile");
  assert.deepEqual(dyn(new Map([[44, 2], [47, 3]])), [418, 467], "specialized counts");
  assert.deepEqual(dyn(new Map([[44, 2], [47, 1]])), [418], "untrained Missile Weapons: no missile mastery");
  assert.deepEqual(dyn(null), [418, 467], "skills unreadable: every skill usable (C# _charSkills == null)");
  // The ladder: Missile Weapon Mastery Self I–VII + the Incantation, the
  // scroll-taught copy first among the three merge copies of each tier.
  const lad = BL.canonicalLadder(19, ladder);
  assert.deepEqual([...new Set(lad.map((r) => r.tier))], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(lad.length, 24);
  assert.ok(lad.every((r) => /^(Missile Weapon Mastery Self [IV]+|Incantation of Missile Weapon Mastery Self)$/.test(nameOf(r.id))));
  assert.equal(lad.filter((r) => r.tier === 7)[0].id, 2207);
  // B4 on the @addallspells character: tier VIII, or VII under a cap of 7.
  clock.t = 7_400_000;
  assert.deepEqual(mk(host(), [467]).desired, [4522]);
  assert.deepEqual(mk(host(), [467], { skillCap: () => 7 }).desired, [2207]);
});

Date.now = realNow;
console.log(fail === 0 ? `rynth_buff_canonical: all ${pass} checks passed` : `rynth_buff_canonical: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
