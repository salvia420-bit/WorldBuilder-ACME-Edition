// tests/rynth_buff_tier_lock.test.mjs — rynth-macro-nav-1: the B5 tier lock in
// rynth/buff_loop.js (header "Tier lock fix", 2026-10-13).
//
// B5 used to learn its cap from EVERY registry row on the first refresh — the
// login snapshot included — and _buildLadders caps the cast TARGET with it. A
// lower tier standing at login therefore re-resolved `desired` down to itself
// and the family never upgraded for the life of the bot (and again after every
// relog: the old tier is rebuffed before it lapses). The C# reference
// (RynthAi BuffManager.cs) records every row too but reads the cap only in
// IsBuffActive (:1207-1209); its target resolver never does, so a low cap
// there only delays an upgrade to the next rebuff window.
//
//   A1-A2  login with Strength V standing, VII known: desired stays VII; V is
//          held active (C# flap guard) and the rebuff window casts VII, not V
//   B1-B3  an upgrade over the lower tier that FIZZLES is not "confirmed" (the
//          old entry is not the new landing); fizzles count; the third walks
//          to VI; VI lands and sets no ladder cap
//   D1-D2  ten minutes later VII is back on the ladder (desired returns to
//          VII; it is retried at VI's rebuff window); not a minute sooner
//   C1     an upgrade that lands confirms; the seen tier rises to 7
//   C2     a skill-capped landing (cast at 8, lands as VI) sets the B5 ladder cap
//   C3     a lower tier that stands after OUR cast was refused sets no cap
//   E1-E2  unknown-spell and silent no-show walks stay permanent
//   G1     a same-tier force-rebuff recast keeps today's confirm (no baseline)
//   K1     the B5 ladder filter is kept (rynth_ladder_smoke B5 in node)
//   K2     a registry tier still guards the upgrade test (C# IsBuffActive)
//   P1     the prior-entry match: same spell, expiry within one ACE heartbeat
//   R1-R5  (review Y-R1) a prior that OUTLIVES the upgrade (a permanent item V,
//          a fellow's longer V) still stands after the upgrade lands, because
//          B2 keeps the later-expiry row: a new VII layer under it confirms
//          (it used to walk VII, then VI, off the ladder for good); a fizzle
//          there still counts; a same-spell refresh (never re-stamped)
//          confirms on ACE's clean UseDone; no row of the cast spell at all is
//          still a B9 walk; our VII standing under it is judged by its own
//          timer, not recast every tick as an upgrade
//
// Fake host: the META families of rynth_bufffix_test.cjs (Strength 101, tiers
// 1..7 = ids 1011..1017, Incantation 1018 at tier 8) served by getSpellRecord
// (no ladder table is loaded in this process), plus the push-event plane,
// UseDone counter and cast token of rynth_magic_update_test.cjs.
//
// The loop reads Date.now(): the test drives a fake clock by replacing
// Date.now for this process only.
//
// Run from apps/holtburger-web/:  node tests/rynth_buff_tier_lock.test.mjs

import assert from "node:assert/strict";

const clock = { t: 5_000_000 };
const realNow = Date.now;
Date.now = () => clock.t;

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

// ── fakes ──────────────────────────────────────────────────────────────────
const SELF = 0x50000001;
const FIZZLE = 0x0402; // YourSpellFizzled
const NOT_IN_BOOK = 0x03fc; // MagicInvalidSpellType
const META = {
  1011: [101, 1], 1012: [101, 2], 1013: [101, 3], 1014: [101, 4],
  1015: [101, 5], 1016: [101, 6], 1017: [101, 7], 1018: [101, 8],
};
const STR_1_TO_7 = [1011, 1012, 1013, 1014, 1015, 1016, 1017];
const STR_1_TO_8 = [...STR_1_TO_7, 1018];

function makeHost({ reg = [], known = STR_1_TO_7 } = {}) {
  const st = { reg, known, useDone: 0, casts: [], handlers: [], token: null };
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
      getSpellRecord: (id) => {
        const m = META[id >>> 0];
        return m ? { category: m[0], roughLevel: m[1] } : null;
      },
    },
    emit(e) {
      for (const fn of st.handlers) fn(e);
    },
  };
}
// One enchantment row as it arrives fresh (startTime 0): it expires
// `remainingS` after the loop first reads it.
const wire = (spellId, remainingS) => ({
  spellId, spellCategory: META[spellId][0], startTime: 0, duration: remainingS, layer: 0,
});

// Build a ready loop with ladders resolved and families primed (the
// rynth_bufffix_test.cjs mkLoop shape).
function mk(host, raw) {
  const loop = new RynthBuffLoop(host, raw, { log: () => {} });
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
// ACE's answer to a fizzled cast: the WeenieError (kind 13), then the cast's
// own UseDone (kind 14).
function fizzle(host) {
  host.emit({ kind: 13, u32: FIZZLE, u32b: 0, text: "Your spell fizzled." });
  host.st.useDone++;
  host.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
}

// ── A/B/D — one session: login with V standing, VII known ──────────────────
const T0 = 5_000_000;
const host = makeHost({ reg: [wire(1015, 3000)] });
const loop = new RynthBuffLoop(host, [1011], { log: () => {} });
loop.startedAt = T0;
let walkAt = 0;

await check("A1 login with Strength V standing and VII known: through the B1 gate and the first refresh, desired stays VII (no login-seeded ladder cap)", () => {
  tickAt(loop, T0); // ladders + first B1 read
  tickAt(loop, T0 + 1000); // B1 stable -> ready, and the first B13 refresh in the same tick
  assert.equal(loop.registryReady, true);
  assert.deepEqual(loop.desired, [1017]);
  assert.equal(loop._familyAchievedTier.has(101), false, "no B5 ladder cap from a row we didn't cast");
  assert.equal(loop._familySeenTier.get(101), 5, "the row still feeds the flap guard");
  // C# IsBuffActive: the upgrade waits for V's rebuff window.
  assert.equal(loop._isActiveReal(1017), true);
  assert.equal(host.st.casts.length, 0);
});

await check("A2 V's rebuff window casts VII at self (the old lock recast V), with V remembered as the upgrade baseline", () => {
  tickAt(loop, T0 + 2_750_000); // V has 250 s left
  assert.equal(host.st.casts.length, 1);
  assert.deepEqual(host.st.casts[0], { target: SELF, id: 1017 });
  assert.ok(loop.pending && loop.pending.spellId === 1017);
  assert.equal(loop.pending.prior.spellId, 1015);
  assert.equal(loop.pending.prior.expiresAtMs, T0 + 3_000_000);
});

await check("B1 the upgrade fizzles with V still standing: not confirmed, the fizzle is counted", () => {
  const t = T0 + 2_750_000;
  clock.t = t + 300;
  fizzle(host);
  tickAt(loop, t + 700);
  assert.equal(loop.pending, null);
  assert.equal(loop._fizzles.get(1017), 1);
  assert.equal(loop.lastRefusal && loop.lastRefusal.cls, "fizzle");
  assert.equal(loop._forceRebuffCast.has(101), false, "a confirm marks the family cast this cycle");
});

await check("B2 two more fizzles: the third walks VII down to VI, retried in 10 min (not for good)", () => {
  let t = T0 + 2_750_000 + 1200;
  for (let i = 0; i < 2; i++) {
    tickAt(loop, t); // recast (the batch is still running)
    assert.ok(loop.pending && loop.pending.spellId === 1017, `recast ${i + 2}`);
    assert.equal(loop.pending.prior.spellId, 1015);
    clock.t = t + 300;
    fizzle(host);
    tickAt(loop, t + 700);
    walkAt = t + 700;
    t += 1200;
  }
  assert.equal(host.st.casts.length, 3);
  assert.equal(loop._unresolvable.has(1017), true);
  assert.deepEqual(loop.desired, [1016]);
  assert.equal(loop._unresolvableUntil.get(1017), walkAt + 10 * 60_000);
});

await check("B3 VI is cast over V and lands: confirmed by the new entry; a landing at the cast tier sets no ladder cap", () => {
  const t = walkAt + 500;
  tickAt(loop, t);
  assert.ok(loop.pending && loop.pending.spellId === 1016);
  assert.equal(loop.pending.prior.spellId, 1015);
  host.st.reg = [...host.st.reg, wire(1016, 1800)]; // VI lands as a new layer over V
  host.st.useDone++;
  host.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  tickAt(loop, t + 700);
  assert.equal(loop.pending, null);
  assert.equal(loop._forceRebuffCast.has(101), true);
  assert.equal(loop._familyAchievedTier.has(101), false);
  assert.equal(loop._familySeenTier.get(101), 6);
  const casts = host.st.casts.length;
  tickAt(loop, t + 1300); // the batch closes: every family recast this cycle
  assert.equal(loop._forceRebuffing, false);
  assert.equal(host.st.casts.length, casts);
});

await check("D1 a minute before the retry time VII is still off the ladder", () => {
  clock.t = walkAt + 9 * 60_000;
  loop.heartbeat();
  assert.equal(loop._unresolvable.has(1017), true);
  assert.deepEqual(loop.desired, [1016]);
});

await check("D2 ten minutes after the walk the kernel heartbeat puts VII back: desired returns to VII, retried at VI's rebuff window", () => {
  clock.t = walkAt + 10 * 60_000;
  loop.heartbeat();
  assert.equal(loop._unresolvable.has(1017), false);
  assert.equal(loop._unresolvableUntil.has(1017), false);
  assert.deepEqual(loop.desired, [1017]);
  assert.equal(loop._isActiveReal(1017), true, "VI held active until its window (C# IsBuffActive)");
  const before = host.st.casts.length;
  tickAt(loop, walkAt + 500 + 700 + 1_560_000); // VI has ~240 s left
  assert.equal(host.st.casts.length, before + 1);
  assert.equal(host.st.casts[host.st.casts.length - 1].id, 1017);
  assert.equal(loop.pending.prior.spellId, 1016);
});

// ── C — landings ────────────────────────────────────────────────────────────
await check("C1 an upgrade over V that LANDS confirms; the seen tier rises to 7 and VII is held active", () => {
  clock.t = T0;
  const h = makeHost({ reg: [wire(1015, 250)] }); // V inside its rebuff window
  const l = mk(h, [1011]);
  assert.deepEqual(l.desired, [1017]);
  tickAt(l, T0 + 100);
  assert.ok(l.pending && l.pending.spellId === 1017 && l.pending.prior.spellId === 1015);
  clock.t = T0 + 600;
  h.st.reg = [...h.st.reg, wire(1017, 3600)];
  h.st.useDone++;
  h.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  tickAt(l, T0 + 800);
  assert.equal(l.pending, null);
  assert.equal(l._familySeenTier.get(101), 7);
  assert.equal(l._familyAchievedTier.has(101), false);
  assert.equal(l._isActiveReal(1017), true);
  tickAt(l, T0 + 1400);
  assert.equal(h.st.casts.length, 1, "no recast once VII stands");
});

await check("C2 a skill-capped landing (Incantation cast at 8 lands as VI) sets the B5 ladder cap and re-resolves desired to VI", () => {
  clock.t = T0;
  const h = makeHost({ known: STR_1_TO_8 });
  const l = mk(h, [1011]);
  assert.deepEqual(l.desired, [1018]);
  tickAt(l, T0 + 100);
  assert.ok(l.pending && l.pending.spellId === 1018 && l.pending.prior === undefined);
  h.st.reg = [wire(1016, 1800)];
  tickAt(l, T0 + 800);
  assert.equal(l.pending, null);
  assert.equal(l._familyAchievedTier.get(101), 6);
  assert.deepEqual(l.desired, [1016]);
  assert.equal(l._isActiveReal(1016), true);
});

await check("C3 our cast fizzled while a fellow's Strength V landed: no B5 ladder cap from someone else's buff", () => {
  clock.t = T0;
  const h = makeHost();
  const l = mk(h, [1011]);
  tickAt(l, T0 + 100);
  assert.ok(l.pending && l.pending.spellId === 1017 && l.pending.prior === undefined);
  clock.t = T0 + 400;
  fizzle(h);
  h.st.reg = [wire(1015, 1800)];
  tickAt(l, T0 + 800);
  assert.equal(l.pending, null);
  assert.equal(l._familyAchievedTier.has(101), false);
  assert.deepEqual(l.desired, [1017]);
});

// ── E — permanent walks stay permanent ──────────────────────────────────────
await check("E1 a not-in-spellbook refusal walks for good (no retry time)", () => {
  clock.t = T0;
  const h = makeHost();
  const l = mk(h, [1011]);
  tickAt(l, T0 + 100);
  clock.t = T0 + 300;
  h.emit({ kind: 13, u32: NOT_IN_BOOK, u32b: 0, text: null });
  tickAt(l, T0 + 800);
  assert.equal(l._unresolvable.has(1017), true);
  assert.equal(l._unresolvableUntil.has(1017), false);
  clock.t = T0 + 60 * 60_000;
  l.heartbeat();
  assert.equal(l._unresolvable.has(1017), true);
  assert.deepEqual(l.desired, [1016]);
});

await check("E2 a silent no-show (UseDone, nothing landed) walks for good", () => {
  clock.t = T0;
  const h = makeHost();
  const l = mk(h, [1011]);
  tickAt(l, T0 + 100);
  clock.t = T0 + 1000;
  h.st.useDone++;
  h.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  tickAt(l, T0 + 1100);
  tickAt(l, T0 + 2700);
  assert.equal(l.pending, null);
  assert.equal(l._unresolvable.has(1017), true);
  assert.equal(l._unresolvableUntil.has(1017), false);
  clock.t = T0 + 60 * 60_000;
  l.heartbeat();
  assert.equal(l._unresolvable.has(1017), true);
});

// ── G/K/P — what stays as it was ────────────────────────────────────────────
await check("G1 a same-tier force-rebuff recast has no upgrade baseline and confirms as before", () => {
  clock.t = T0;
  const h = makeHost({ reg: [wire(1017, 3000)] });
  const l = mk(h, [1011]);
  l.forceRebuff();
  tickAt(l, T0 + 100);
  assert.ok(l.pending && l.pending.spellId === 1017);
  assert.equal(l.pending.prior, undefined);
  tickAt(l, T0 + 800);
  assert.equal(l.pending, null);
  assert.equal(l._forceRebuffCast.has(101), true);
});

await check("K1 the B5 ladder cap still filters _buildLadders (rynth_ladder_smoke B5: cap 4 -> tier IV)", () => {
  clock.t = T0;
  const l = new RynthBuffLoop(makeHost(), [1011], { log: () => {} });
  l._buildLadders();
  assert.deepEqual(l.desired, [1017]);
  l._familyAchievedTier.set(101, 4);
  l._buildLadders();
  assert.deepEqual(l.desired, [1014]);
});

await check("K2 a registry tier still guards the upgrade test: VII standing, the Incantation known -> VII held active (C# IsBuffActive)", () => {
  clock.t = T0;
  const l = mk(makeHost({ reg: [wire(1017, 3000)], known: STR_1_TO_8 }), [1011]);
  assert.deepEqual(l.desired, [1018]);
  assert.equal(l._isActiveReal(1018), true);
  assert.equal(l._anyBelowThreshold(), false);
});

await check("P1 the upgrade baseline matches the same spell with its expiry within one ACE heartbeat (5 s)", () => {
  const l = new RynthBuffLoop(makeHost(), [1011], { log: () => {} });
  const prior = { spellId: 1015, expiresAtMs: 1_000_000 };
  assert.equal(l._isPriorEntry(prior, { spellId: 1015, expiresAtMs: 1_000_000 }), true);
  assert.equal(l._isPriorEntry(prior, { spellId: 1015, expiresAtMs: 1_004_000 }), true);
  assert.equal(l._isPriorEntry(prior, { spellId: 1015, expiresAtMs: 1_006_000 }), false, "a refresh of the same spell is a landing");
  assert.equal(l._isPriorEntry(prior, { spellId: 1017, expiresAtMs: 1_000_000 }), false);
  assert.equal(l._isPriorEntry({ spellId: 1015, expiresAtMs: Infinity }, { spellId: 1015, expiresAtMs: Infinity }), true);
  assert.equal(l._isPriorEntry(undefined, { spellId: 1015, expiresAtMs: 1_000_000 }), false);
});

// ── R — a prior that outlives the upgrade (review Y-R1) ─────────────────────
// ACE keeps both layers of a category; B2 keeps the row with the LATER expiry.
const layered = (spellId, remainingS, layer) => ({ ...wire(spellId, remainingS), layer });
const ITEM_V = () => layered(1015, -1, 1); // a permanent (B6) item enchantment

await check("R1 a permanent item V outlives the upgrade: VII landing as a new layer under it confirms (was a silent no-show walking VII, then VI, off for good)", () => {
  clock.t = T0;
  const h = makeHost({ reg: [ITEM_V()] });
  const l = mk(h, [1011]);
  assert.deepEqual(l.desired, [1017]);
  l.forceRebuff(); // B11/B12: the batch recasts every family
  tickAt(l, T0 + 100);
  assert.ok(l.pending && l.pending.spellId === 1017);
  assert.equal(l.pending.prior.spellId, 1015);
  assert.equal(l.pending.prior.expiresAtMs, Infinity);
  clock.t = T0 + 600;
  h.st.reg = [...h.st.reg, layered(1017, 3600, 2)];
  h.st.useDone++;
  h.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  tickAt(l, T0 + 800);
  assert.equal(l.families.get(101).spellId, 1015, "B2 still holds the permanent V");
  assert.equal(l.pending, null);
  assert.equal(l._unresolvable.has(1017), false);
  assert.deepEqual(l.desired, [1017]);
  assert.equal(l._forceRebuffCast.has(101), true);
  assert.equal(l._familyAchievedTier.has(101), false, "the item V sets no ladder cap");
  for (const t of [1400, 2000, 3000, 4000]) tickAt(l, T0 + t);
  assert.equal(h.st.casts.length, 1, "no walk-down recast of VI");
});

await check("R2 the same upgrade FIZZLING under the permanent V is still not confirmed: the fizzle counts", () => {
  clock.t = T0;
  const h = makeHost({ reg: [ITEM_V()] });
  const l = mk(h, [1011]);
  l.forceRebuff();
  tickAt(l, T0 + 100);
  clock.t = T0 + 400;
  fizzle(h);
  tickAt(l, T0 + 800);
  assert.equal(l.pending, null);
  assert.equal(l._fizzles.get(1017), 1);
  assert.equal(l._forceRebuffCast.has(101), false);
  assert.equal(l._unresolvable.has(1017), false);
});

await check("R3 a same-spell refresh of our VII under a fellow's longer V (same spell/layer/start 0, never re-stamped) confirms on ACE's clean UseDone, not a walk", () => {
  clock.t = T0;
  const h = makeHost({ reg: [layered(1017, 1200, 1), layered(1015, 7200, 2)] });
  const l = mk(h, [1011]);
  assert.equal(l.families.get(101).spellId, 1015, "B2 keeps the later-expiry V");
  l.forceRebuff();
  tickAt(l, T0 + 100);
  assert.ok(l.pending && l.pending.spellId === 1017 && l.pending.prior.spellId === 1015);
  clock.t = T0 + 600;
  h.st.useDone++; // ACE refreshed layer 1 in place: the row reads the same
  h.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  tickAt(l, T0 + 800);
  assert.ok(l.pending, "waits out the UseDone grace / give-up clocks, as a no-show would");
  tickAt(l, T0 + 2700);
  assert.equal(l.pending, null);
  assert.equal(l._unresolvable.has(1017), false);
  assert.equal(l._forceRebuffCast.has(101), true);
});

await check("R4 with no row of the cast spell at all, a clean UseDone under the standing V is still a silent no-show (B9 walk)", () => {
  clock.t = T0;
  const h = makeHost({ reg: [ITEM_V()] });
  const l = mk(h, [1011]);
  l.forceRebuff();
  tickAt(l, T0 + 100);
  clock.t = T0 + 1000;
  h.st.useDone++;
  h.emit({ kind: 14, u32: 0, u32b: 0, text: "" });
  tickAt(l, T0 + 1100);
  tickAt(l, T0 + 2700);
  assert.equal(l.pending, null);
  assert.equal(l._unresolvable.has(1017), true);
});

await check("R5 our VII standing under a permanent V is judged by its own timer, not recast every tick as an upgrade", () => {
  clock.t = T0;
  const h = makeHost({ reg: [ITEM_V(), layered(1017, 3000, 2)] });
  const l = mk(h, [1011]);
  l._familySeenTier.set(101, 7); // VII held the family before the item V went on
  assert.equal(l.families.get(101).spellId, 1015);
  assert.equal(l._isActiveReal(1017), true);
  tickAt(l, T0 + 100);
  assert.equal(h.st.casts.length, 0);
  clock.t = T0 + 2_800_000; // VII has 200 s left: inside its rebuff window
  assert.equal(l._isActiveReal(1017), false);
  h.st.reg = [ITEM_V()];
  l._refresh();
  assert.equal(l._isActiveReal(1017), false, "no VII row: still an upgrade");
});

Date.now = realNow;
console.log(fail === 0 ? `rynth_buff_tier_lock: all ${pass} checks passed` : `rynth_buff_tier_lock: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
