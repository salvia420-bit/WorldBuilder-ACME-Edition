// tests/rynth_vitals_progress.test.mjs — rynth-macro-nav-3: the vitals
// give-up valve judges a recovery spell by what ACE says it restored, not by
// the net change of the vital under incoming damage (rynth/vitals.js header,
// 2026-10-13).
//
// The valve parks an axis for 60 s after 6 casts without progress (the
// Heal-Self-I-vs-99,999-HP livelock). It measured progress as the fraction at
// this cast vs the fraction at the previous one, so a tank whose every heal
// landed in full but was out-damaged had healing parked mid-fight. ACE's
// caster lines, re-derived from ACE.Server WorldObject_Magic.cs:
//   boost    "You cast {spell.Name} and {verb} {Math.Abs(boost)} points of your {srcVital}."
//   transfer "You cast {spell.Name} on yourself and lose {srcVitalChange} points of
//             {srcVital} and also gain {destVitalChange} points of {destVital}"
// (ChatMessageType.Magic → the wasm's kind=2 chat event, text as-is).
//
//   P1-P2  parseVitalGainLine on the ACE strings / other lines
//   G1     HP pinned at 50% of 1000, each heal restores 200 → 12 casts, never parks
//   G2     HP falling every cast under damage, each heal restores 200 → never parks
//   G3     99,999 HP, each heal restores 12 → parks after 6 no-progress casts
//   G4     no lines (no event plane / squelched Magic chat) → parks after 6, as before
//   G5     Stamina to Mana transfer line measures the mana axis
//   A1-A5  attribution: other axis, foreign cast token, outside the window,
//          a refused cast, first line wins
//   E1     an emergency cast's line never feeds the valve
//   R1-R2  a vital back at/above its threshold restarts the count; the first
//          cast of the next drop is not "no progress"
//
// The loop reads Date.now(): the test drives a fake clock by replacing
// Date.now for this process only.
//
// Run from apps/holtburger-web/:  node tests/rynth_vitals_progress.test.mjs

import assert from "node:assert/strict";

const clock = { t: 1_800_000_000_000 };
const realNow = Date.now;
Date.now = () => clock.t;
const advance = (ms) => {
  clock.t += ms;
};

const { RynthVitals, parseVitalGainLine } = await import("../rynth/vitals.js");

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

// ── fakes ──────────────────────────────────────────────────────────────────
const SELF = 0x50000001;
const CHAT = 2;
const CAT_MAGIC = 7; // src/lib.rs CHAT_CATEGORY_MAGIC
const FIZZLE = 0x0402; // buff_loop.js castRefusalClass → "fizzle"
const HEAL_VI = 1161;
const STAM_TO_HEALTH_VI = 1669;
const STAM_TO_MANA_VI = 1681;
const REVITALIZE_VI = 1182;
const quiet = () => {};
const boostLine = (spell, pts, vital) => `You cast ${spell} and restore ${pts} points of your ${vital}.`;
const transferLine = (spell, lose, from, gain, to) =>
  `You cast ${spell} on yourself and lose ${lose} points of ${from} and also gain ${gain} points of ${to}`;

// A RynthWebHost-shaped fake: Magic mode, clear gates, a guid, a push-event
// plane and the shared cast token. `hp`/`stam`/`mana` are [current, max].
function makeHost(over = {}) {
  const handlers = [];
  const h = {
    casts: [],
    token: null,
    hp: [500, 1000],
    stam: [1000, 1000],
    mana: [1000, 1000],
    known: [6, HEAL_VI, 1664, STAM_TO_HEALTH_VI, 1676, STAM_TO_MANA_VI, 1177, REVITALIZE_VI],
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => 8,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetPlayerId: () => SELF,
    ChangeCombatMode: () => {},
    CastSpell: (target, id) => h.casts.push({ target, id }),
    onEvent: (fn) => handlers.push(fn),
    tryClaimCast: (owner) => {
      if (h.token && h.token !== owner) return false;
      h.token = owner;
      return true;
    },
    releaseCast: (owner) => {
      if (h.token === owner) h.token = null;
    },
    get castToken() {
      return h.token ? { owner: h.token } : null;
    },
    s: {
      playerKnownSpells: () => h.known.slice(),
      playerStats: () => ({
        vitals: [1, h.hp[0], 0, h.hp[1], 3, h.stam[0], 0, h.stam[1], 5, h.mana[0], 0, h.mana[1]],
        skills: [],
        free() {},
      }),
    },
    emit(e) {
      for (const fn of handlers) fn(e);
    },
    say(text) {
      h.emit({ kind: CHAT, text, u32: 0x11, u32b: CAT_MAGIC, f32: null });
    },
    ...over,
  };
  return h;
}

// Idle top-off of HP only (stam/mana top-off off) unless a case overrides.
const HP_ONLY = { topOffHp: 95, topOffStam: 0, topOffMana: 0, healAtCombat: 60, getManaAtCombat: 0, restamAtCombat: 0 };
const mkVitals = (h, thresholds = HP_ONLY) => new RynthVitals(h, { log: quiet, thresholds });

// One kernel tick: step, then (if a cast went out) the server's reply line
// ~2 s later, after the cast token is freed by its UseDone.
function tick(v, h, { inCombat = false, line = null } = {}) {
  const before = h.casts.length;
  const owned = v.step(inCombat);
  const cast = h.casts.length > before ? h.casts[h.casts.length - 1] : null;
  advance(2000);
  if (cast) {
    if (typeof line === "function") {
      const text = line(cast);
      if (text) h.say(text);
    } else if (line) h.say(line);
    h.token = null; // UseDone
  }
  return { owned, cast };
}

// Run n ticks; return the first tick index at which `axis` is parked (-1: never).
function runUntilParked(v, h, n, opts = {}, axis = "hp", each = null) {
  for (let i = 0; i < n; i++) {
    if (each) each(i);
    tick(v, h, opts);
    if (v.status.parked.includes(axis)) return i;
  }
  return -1;
}

// ── P: the parser ──────────────────────────────────────────────────────────
await check("P1 parseVitalGainLine reads ACE's boost and transfer lines", () => {
  assert.deepEqual(parseVitalGainLine(boostLine("Heal Self VI", 200, "health")), { spellName: "Heal Self VI", axis: "hp", pts: 200 });
  assert.deepEqual(parseVitalGainLine(boostLine("Revitalize Self VI", 180, "stamina")), { spellName: "Revitalize Self VI", axis: "stam", pts: 180 });
  assert.deepEqual(parseVitalGainLine(boostLine("Incantation of Heal Self", 0, "health")), { spellName: "Incantation of Heal Self", axis: "hp", pts: 0 });
  assert.deepEqual(parseVitalGainLine(transferLine("Stamina to Mana Self I", 50, "stamina", 45, "mana")), {
    spellName: "Stamina to Mana Self I",
    axis: "mana",
    pts: 45,
  });
  assert.deepEqual(parseVitalGainLine(transferLine("Stamina to Health Self VI", 120, "stamina", 96, "health")), {
    spellName: "Stamina to Health Self VI",
    axis: "hp",
    pts: 96,
  });
});

await check("P2 other lines are not gain lines", () => {
  for (const t of [
    "You cast Strength Self VI on yourself", // an enchantment
    "You cast Strength Self VI on yourself, refreshing Strength Self VI",
    "With Heal Other VI you restore 200 points of health to Bob.", // other-target boost
    "You cast Harm Self I and drain 10 points of your health.", // a harmful self boost
    "You gain 52 points of health due to casting Drain Health Other I on Olthoi Warrior",
    'Bob says, "You cast Heal Self VI and restore 999 points of your health."',
    "Your spell fizzled.",
    "",
    null,
    undefined,
  ]) {
    assert.equal(parseVitalGainLine(t), null, String(t));
  }
});

// ── G: the valve measures the spell ────────────────────────────────────────
await check("G1 HP pinned at 50% of 1000, each heal restores 200 → 12 casts, never parked", () => {
  const h = makeHost();
  const v = mkVitals(h);
  const parkedAt = runUntilParked(v, h, 12, { line: boostLine("Heal Self VI", 200, "health") });
  assert.equal(parkedAt, -1);
  assert.equal(h.casts.length, 12);
  assert.ok(h.casts.every((c) => c.id === HEAL_VI && c.target === SELF));
  assert.equal(v._noProgress.hp, 0);
});

await check("G2 HP falling every cast under damage (in combat), each heal restores 200 → never parked", () => {
  const h = makeHost({ hp: [580, 1000] });
  const v = mkVitals(h);
  const parkedAt = runUntilParked(v, h, 12, { inCombat: true, line: boostLine("Heal Self VI", 200, "health") }, "hp", (i) => {
    h.hp[0] = 580 - i * 20; // 58% → 36%: out-damaged, never in emergency
  });
  assert.equal(parkedAt, -1);
  assert.equal(h.casts.length, 12);
});

await check("G3 99,999 HP, each heal restores 12 → parked after 6 no-progress casts (the livelock still parks)", () => {
  const h = makeHost({ hp: [50_000, 99_999], known: [6] });
  const v = mkVitals(h);
  const parkedAt = runUntilParked(v, h, 12, { line: boostLine("Heal Self I", 12, "health") });
  assert.equal(parkedAt, 6); // cast 0 has no previous cast; casts 1..6 count
  assert.equal(h.casts.length, 7);
  const t = tick(v, h);
  assert.equal(t.owned, false); // parked: the tick is released
  assert.equal(t.cast, null);
});

await check("G4 no gain lines (no event plane, squelched Magic chat) → parked after 6, as before", () => {
  const h = makeHost();
  const v = mkVitals(h);
  const parkedAt = runUntilParked(v, h, 12, {});
  assert.equal(parkedAt, 6);
  assert.equal(h.casts.length, 7);
});

await check("G5 Stamina to Mana transfer line measures the mana axis (30% of 1000, +45 per cast) → never parked", () => {
  const h = makeHost({ hp: [1000, 1000], mana: [300, 1000] });
  const v = mkVitals(h, { ...HP_ONLY, getManaAtCombat: 40 });
  const parkedAt = runUntilParked(
    v,
    h,
    10,
    { inCombat: true, line: transferLine("Stamina to Mana Self VI", 50, "stamina", 45, "mana") },
    "mana"
  );
  assert.equal(parkedAt, -1);
  assert.equal(h.casts.length, 10);
  assert.ok(h.casts.every((c) => c.id === STAM_TO_MANA_VI));
  assert.equal(v._noProgress.mana, 0);
});

// ── A: attribution ─────────────────────────────────────────────────────────
await check("A1 a line for another vital does not feed this axis", () => {
  const h = makeHost();
  const v = mkVitals(h);
  tick(v, h, { line: boostLine("Revitalize Self VI", 200, "stamina") });
  assert.equal(v._axisCast.hp.gain, null);
  assert.equal(v._axisCast.stam, null);
});

await check("A2 a line while another module holds the cast token is not ours", () => {
  const h = makeHost();
  const v = mkVitals(h);
  v.step(false);
  advance(2000);
  h.token = "buff";
  h.say(boostLine("Heal Self VI", 200, "health"));
  assert.equal(v._axisCast.hp.gain, null);
  h.token = null;
  h.say(boostLine("Heal Self VI", 200, "health"));
  assert.equal(v._axisCast.hp.gain, 200);
});

await check("A3 a line outside the attribution window is ignored", () => {
  const h = makeHost();
  const v = mkVitals(h);
  v.step(false);
  h.token = null;
  advance(10_001);
  h.say(boostLine("Heal Self VI", 200, "health"));
  assert.equal(v._axisCast.hp.gain, null);
});

await check("A4 a refused (fizzled) cast takes no gain line", () => {
  const h = makeHost();
  const v = mkVitals(h);
  v.step(false);
  advance(500);
  h.emit({ kind: 13, u32: FIZZLE, text: null, u32b: 0, f32: null });
  h.say(boostLine("Heal Self VI", 200, "health"));
  assert.equal(v._axisCast.hp.refused, "fizzle");
  assert.equal(v._axisCast.hp.gain, null);
});

await check("A5 first line wins", () => {
  const h = makeHost();
  const v = mkVitals(h);
  v.step(false);
  advance(500);
  h.say(boostLine("Heal Self VI", 200, "health"));
  h.say(boostLine("Heal Self VI", 12, "health"));
  assert.equal(v._axisCast.hp.gain, 200);
});

// ── E: emergency ───────────────────────────────────────────────────────────
await check("E1 an emergency cast's line is kept on its record and never feeds the valve", () => {
  const h = makeHost({ hp: [250, 1000] });
  const v = mkVitals(h);
  tick(v, h, { inCombat: true, line: transferLine("Stamina to Health Self VI", 100, "stamina", 1, "health") });
  assert.equal(h.casts[0].id, STAM_TO_HEALTH_VI);
  assert.equal(v._axisCast.hp.emergency, true);
  assert.equal(v._axisCast.hp.gain, 1);
  // Out of emergency: the heal's valve does not judge the conversion's 1 pt.
  h.hp[0] = 400;
  tick(v, h, { inCombat: true });
  assert.equal(h.casts[1].id, HEAL_VI);
  assert.equal(v._noProgress.hp, 0);
});

// ── R: recovery restarts the count ─────────────────────────────────────────
await check("R1 back at/above the threshold resets the count; the first cast of the next drop is not 'no progress'", () => {
  const h = makeHost();
  const v = mkVitals(h);
  for (let i = 0; i < 5; i++) tick(v, h); // 50% flat, no lines: 4 no-progress
  assert.equal(v._noProgress.hp, 4);
  assert.equal(v._lastPct.hp, 50);
  h.hp[0] = 960; // 96% ≥ topOff 95: recovered
  const idle = tick(v, h);
  assert.equal(idle.cast, null);
  assert.equal(v._noProgress.hp, 0);
  assert.equal(v._lastPct.hp, -1);
  assert.equal(v._axisCast.hp, null);
  h.hp[0] = 450; // the next fight, lower than the last cast's 50%
  tick(v, h);
  assert.equal(v._noProgress.hp, 0); // was counted as no-progress before the fix
  // The count restarts from here: 5 more flat casts do not reach the limit.
  const parkedAt = runUntilParked(v, h, 5, {});
  assert.equal(parkedAt, -1);
  assert.equal(v._noProgress.hp, 5);
});

await check("R2 the in-combat threshold counts as recovered too (HP 70% ≥ HealAt 60 while fighting)", () => {
  const h = makeHost();
  const v = mkVitals(h);
  tick(v, h, { inCombat: true });
  tick(v, h, { inCombat: true });
  assert.equal(v._noProgress.hp, 1);
  h.hp[0] = 700;
  const t = tick(v, h, { inCombat: true });
  assert.equal(t.cast, null);
  assert.equal(v._noProgress.hp, 0);
  assert.equal(v._lastPct.hp, -1);
});

Date.now = realNow;
console.log(fail === 0 ? `rynth_vitals_progress: all ${pass} checks passed` : `rynth_vitals_progress: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
