// tests/rynth_buff_batch_complete.test.mjs — B11 / B12 pass completion
// (2026-10-19): a batch (or Force Buff) pass ends even when the kernel no
// longer gives the buff loop a Buffing tick.
//
// Once every family of the pass is in _forceRebuffCast, status reads all
// active with nothing pending, so kernel._buffNeeded() is false and Buffing is
// never selected — and tick()'s "Nothing left to cast this pass" branch, the
// only place the pass used to end, never ran: _forceRebuffing stayed true,
// _isActive() kept answering from the pass, no buff ever read below the
// threshold again and none was recast (until setDesired / Cancel / setBuffs).
// heartbeat(), which the kernel calls on every tick, now ends it.
//
// The real RynthBotKernel (combat / loot / vitals absent) drives the real
// RynthBuffLoop over a scripted host and a fake clock:
//   • B11: one of two buffs drops below the threshold → the batch recasts
//     both → the pass ends from heartbeat() while the kernel sits on Idle
//     (one "batch rebuff complete") → a timer later drops below the threshold
//     → status shows it due, the kernel picks Buffing, the next tick recasts;
//   • B12: Force Buff, the same way;
//   • never early: a cast in flight or a family not yet recast keeps the pass
//     open; a parked family is skipped exactly as tick() skips it.
//
// Run from apps/holtburger-web/:  node tests/rynth_buff_batch_complete.test.mjs

import assert from "node:assert/strict";

const { RynthBuffLoop } = await import("../rynth/buff_loop.js");
const { RynthBotKernel } = await import("../rynth/kernel.js");

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
const quiet = () => {};

const REAL_NOW = Date.now;
let NOW = 1_800_000_000_000;
Date.now = () => NOW;

const ME = 0x50000001;
const A = 1011; // category 101
const B = 1021; // category 102
const CAT = { [A]: 101, [B]: 102 };
const DUR = 1800;

/** A buff that has `left` seconds of its DUR left (wire start_time = −age). */
const aged = (spellId, left) => ({ spellId, spellCategory: CAT[spellId], startTime: left - DUR, duration: DUR, layer: 1 });

function makeWorld(reg) {
  const W = { reg, seq: 0, casts: [], pend: [], subs: [], useDone: 0, token: null, castMs: 2000, logs: [] };
  const emit = (e) => {
    for (const fn of W.subs) fn({ u32: 0, u32b: 0, text: "", ...e });
  };
  W.host = {
    IsPlayerReady: () => true,
    IsPortalSpaceActive: () => false,
    GetCurrentCombatMode: () => 8,
    ChangeCombatMode: () => true,
    GetCastBusyState: () => (W.pend.length ? 1 : 0),
    GetBusyState: () => (W.pend.length ? 1 : 0),
    GetPlayerId: () => ME,
    CastSpell(t, s) {
      W.casts.push(s >>> 0);
      W.pend.push({ s: s >>> 0, at: NOW + W.castMs });
      return true;
    },
    tryClaimCast(o) {
      if (W.token && W.token.o !== o && W.token.seq === W.useDone) return false;
      W.token = { o, seq: W.useDone };
      return true;
    },
    releaseCast(o) {
      if (W.token && W.token.o === o) W.token = null;
    },
    has: (c) => c === "GetUseDoneSeq",
    GetUseDoneSeq: () => W.useDone,
    TryGetPlayerInventory: () => [{ guid: 0x60000010, equipMask: 0x01000000 }],
    onEvent(fn) {
      W.subs.push(fn);
    },
    onTick() {},
    s: {
      playerEnchantments: () => W.reg.map((r) => ({ ...r })),
      playerKnownSpells: () => [A, B],
      getSpellRecord: (id) => (CAT[id] ? { category: CAT[id], roughLevel: 1 } : null),
    },
  };
  // a cast lands after castMs: a fresh registry row (re-stamped start), its line, the UseDone
  W.step = () => {
    for (const c of W.pend.splice(0)) {
      if (c.at > NOW) {
        W.pend.push(c);
        continue;
      }
      W.reg = W.reg.filter((r) => r.spellId !== c.s).concat([{ spellId: c.s, spellCategory: CAT[c.s], startTime: -(++W.seq) * 1e-3, duration: DUR, layer: 1 }]);
      W.useDone++;
      emit({ kind: 2, text: `You cast Spell ${c.s} and feel better.` });
      emit({ kind: 14 });
    }
  };
  return W;
}

function rig(reg) {
  const W = makeWorld(reg);
  const loop = new RynthBuffLoop(W.host, [A, B], { log: (m) => W.logs.push(m) });
  loop.startedAt = NOW;
  loop.registryReady = true;
  loop._refresh();
  let ticks = 0; // buff.tick() calls — the kernel's Buffing rung only
  const tick = loop.tick.bind(loop);
  loop.tick = () => {
    ticks++;
    tick();
  };
  const kernel = new RynthBotKernel(W.host, { combat: null, buff: loop, loot: null, vitals: null, unwedge: null }, { log: quiet });
  return { W, loop, kernel, ticks: () => ticks };
}

/** One kernel tick per `stepMs` until `until()` holds (or `maxMs` passes). */
function runUntil(r, until, { stepMs = 100, maxMs = 60_000, each = null } = {}) {
  const end = NOW + maxMs;
  while (NOW < end) {
    NOW += stepMs;
    r.W.step();
    r.kernel.tick();
    if (each) each();
    if (until()) return true;
  }
  return false;
}
const completions = (W) => W.logs.filter((m) => m === "batch rebuff complete").length;

await check("B11: the batch ends from heartbeat() while the kernel sits on Idle; a timer later drops below the threshold → due, Buffing, recast", () => {
  const r = rig([aged(A, 400), aged(B, 1700)]);
  // A runs below the 300 s threshold → Buffing → B11 recasts BOTH (aligned timers)
  assert.ok(runUntil(r, () => r.W.casts.length === 2 && !r.loop.pending && r.W.pend.length === 0, { maxMs: 140_000 }), "the batch ran");
  assert.deepEqual(r.W.casts, [A, B]);
  assert.ok(r.W.logs.includes("batch rebuff: recasting all buffs to align timers"));
  // every family recast: status reads all active and the kernel stops ticking Buffing
  const st = r.loop.status;
  assert.deepEqual([st.active, st.desired, st.pending], [2, 2, 0]);
  const t0 = r.ticks();
  const actions = new Set();
  runUntil(r, () => false, { maxMs: 3000, each: () => actions.add(r.kernel.action) });
  assert.deepEqual([...actions], ["Idle"], "no Buffing tick after the last landing");
  assert.equal(r.ticks(), t0, "buff.tick() was not called");
  assert.equal(r.loop._forceRebuffing, false, "the pass ended anyway (heartbeat)");
  assert.equal(completions(r.W), 1, "logged once");
  // 25 min later a timer runs below the threshold again: status says so before
  // the kernel's tick, and that tick recasts
  let due = false;
  for (const end = NOW + 30 * 60_000; NOW < end && !due; ) {
    NOW += 1000;
    r.W.step();
    const s = r.loop.status;
    if (s.active < s.desired) due = true;
    else r.kernel.tick();
  }
  assert.ok(due, "status shows the buff due again");
  assert.equal(r.loop.needsBuff(), true);
  assert.equal(r.W.casts.length, 2, "nothing recast before that");
  r.kernel.tick();
  assert.equal(r.kernel.action, "Buffing", "the kernel picks Buffing");
  assert.equal(r.W.casts.length, 3, "and the next tick recasts");
  assert.ok(runUntil(r, () => r.W.casts.length === 4 && r.W.pend.length === 0 && !r.loop.pending, { maxMs: 30_000 }));
  assert.deepEqual(r.W.casts, [A, B, A, B], "a second batch");
  runUntil(r, () => false, { maxMs: 2000 });
  assert.equal(r.loop._forceRebuffing, false);
  assert.equal(completions(r.W), 2);
});

await check("B12: a Force Buff pass ends the same way; the next expiry is recast", () => {
  const r = rig([aged(A, 1500), aged(B, 1600)]);
  runUntil(r, () => false, { maxMs: 2000 });
  assert.deepEqual(r.W.casts, [], "both fresh: nothing to do");
  r.loop.forceRebuff();
  assert.ok(runUntil(r, () => r.W.casts.length === 2 && r.W.pend.length === 0 && !r.loop.pending, { maxMs: 30_000 }));
  assert.deepEqual(r.W.casts, [A, B]);
  const t0 = r.ticks();
  runUntil(r, () => false, { maxMs: 3000 });
  assert.equal(r.ticks(), t0, "the kernel stopped ticking Buffing");
  assert.equal(r.loop._forceRebuffing, false, "the Force pass ended (heartbeat)");
  assert.equal(completions(r.W), 1);
  assert.ok(runUntil(r, () => r.W.casts.length > 2, { stepMs: 1000, maxMs: 30 * 60_000 }), "the next rebuff happens");
});

await check("never early: a cast in flight or a family not yet recast keeps the pass open; a parked family is skipped as tick() skips it", () => {
  const r = rig([aged(A, 1500), aged(B, 1600)]);
  r.loop.forceRebuff();
  r.loop.heartbeat();
  assert.equal(r.loop._forceRebuffing, true, "nothing recast yet");
  // A in flight
  assert.ok(runUntil(r, () => r.W.casts.length === 1, { maxMs: 2000 }));
  r.loop.heartbeat();
  assert.equal(r.loop._forceRebuffing, true, "a cast in flight");
  // A landed, B not cast yet: the heartbeat between the two casts leaves it open
  assert.ok(runUntil(r, () => !r.loop.pending, { maxMs: 10_000 }));
  assert.deepEqual(r.W.casts, [A], "A confirmed; B goes out on the next buff tick");
  r.loop.heartbeat();
  assert.equal(r.loop._forceRebuffing, true, "B not yet recast");
  r.loop.cancelForceRebuff();
  // a pass whose remaining family is parked (B9 spell park / B10 family park) is over
  const p = rig([aged(A, 1500), aged(B, 1600)]);
  p.loop.forceRebuff();
  p.loop._forceRebuffCast.add(CAT[A]);
  p.loop.parkedUntil.set(B, NOW + 60_000);
  p.loop.heartbeat();
  assert.equal(p.loop._forceRebuffing, false, "B9-parked B is skipped");
  const q = rig([aged(A, 1500), aged(B, 1600)]);
  q.loop.forceRebuff();
  q.loop._forceRebuffCast.add(CAT[A]);
  q.loop._rejectParkedUntil.set(CAT[B], NOW + 60_000);
  q.loop.heartbeat();
  assert.equal(q.loop._forceRebuffing, false, "B10-parked family is skipped");
  const x = rig([aged(A, 1500), aged(B, 1600)]);
  x.loop.forceRebuff();
  x.loop._forceRebuffCast.add(CAT[A]);
  x.loop.parkedUntil.set(B, NOW - 1); // an expired park no longer skips it
  x.loop.heartbeat();
  assert.equal(x.loop._forceRebuffing, true);
  assert.ok(x.loop.parkedUntil.has(B), "heartbeat() only reads the parks (tick() prunes them)");
});

Date.now = REAL_NOW;
console.log(fail === 0 ? `rynth_buff_batch_complete: all ${pass} checks passed` : `rynth_buff_batch_complete: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
