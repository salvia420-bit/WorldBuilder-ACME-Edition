// harness/test_frame_work.mjs — T21 (ST8 stage A, `?frameWork`): the
// FrameWorkScheduler core, node-only, MOCKED CLOCK (no rAF, no browser).
//
// WHAT IS UNDER TEST (SPEC §3 T21; pass-08 D-08.3 + S2):
//   PART 1  — flag grammar: frameWork/framePhase EXACT-MATCH opt-ins
//             (DEFAULT OFF); workBudget numeric; workShrink default-ON
//             escape; workCrossing lever opt-in.
//   PART 2  — budget accounting: checked BETWEEN items; a batch never
//             STARTS an item once the cap is spent (the xu7 bound:
//             budget + one item, not "at most budget").
//   PART 3  — always-run-one: an over-budget single item still runs.
//   PART 4  — class priority W1 > … > W6 + starvation counter
//             (deferredFrames) for engaged classes that got nothing.
//   PART 5  — staleness ceiling: oldest item >= 3 frames force-runs one
//             regardless of budget (forcedRuns counter).
//   PART 6  — mode transitions: BOOT exit on in-world; TELEPORT one-shot
//             via LB-key discontinuity (Chebyshev >= 6, walks don't arm);
//             EMERGENCY reweights (W4 ×2 allowance, W2 paused — pause
//             outranks the staleness ceiling); CROSSING lever predicate.
//   PART 7  — shrink rule: heavy frame shrinks the slot to the 2 ms floor;
//             ?workShrink=off escape; BOOT/TELEPORT never shrink.
//   PART 8  — W6 yield grants: estimate-charged, resolved by run(),
//             reported chunk ms feeds maxItemMs + the next estimate.
//   PART 9  — W6 run coalescing (latest fn per name wins) + purgeByTile.
//   PART 10 — __frameWork stats shape matches the diag-registry schema
//             (classes.* fields, mode enum).
//   PART 11 — framePhase helpers: begin/cut/commit accumulation, disabled
//             = inert.
//   PART 12 — singleton arms: OFF arm (fresh module, no window) falls
//             through to legacy scheduling; ON arm (stubbed window) serves
//             W6 through frameWorkP4 and publishes window.__frameWork.
//
// Run:  node harness/test_frame_work.mjs        (exit 0/1)

import {
  FrameWorkScheduler,
  WORK_CLASSES,
  MODES,
  frameWorkEnabled,
  framePhaseEnabled,
  workBudgetMs,
  workShrinkEnabled,
  workCrossingEnabled,
} from "../scene3d/frame_work.js";
import { getSurface } from "./lib/diag_schema.mjs";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

// Mock clock: `t` advances only when a test (or an item fn) says so.
function mockClock(t0 = 0) {
  const c = { t: t0 };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}
function mkSched(clock, opts = {}) {
  return new FrameWorkScheduler({ now: clock.now, isInWorld: () => true, ...opts });
}
// A W6 sync item costing `ms` on the mock clock.
const costing = (clock, ms) => () => clock.advance(ms);

// ── PART 1 — flag grammar ───────────────────────────────────────────────────
console.log("PART 1 — flag grammar");
for (const v of ["on", "1", "true", "yes"]) {
  check(frameWorkEnabled(`?frameWork=${v}`) === true, `frameWork=${v} reads ON`);
  check(framePhaseEnabled(`?framePhase=${v}`) === true, `framePhase=${v} reads ON`);
  check(workCrossingEnabled(`?workCrossing=${v}`) === true, `workCrossing=${v} reads ON`);
}
for (const s of ["", "?frameWork=off", "?frameWork=0", "?frameWork=garbage", "?frameWork="]) {
  check(frameWorkEnabled(s) === false, `frameWork OFF for ${JSON.stringify(s)}`);
}
check(framePhaseEnabled("") === false, "framePhase DEFAULT OFF");
check(workCrossingEnabled("") === false, "workCrossing DEFAULT OFF (the Q4 lever is pulled, not ambient)");
check(workBudgetMs("") === 6, "workBudget default 6 (the house figure, now global)");
check(workBudgetMs("?workBudget=12") === 12, "workBudget=12");
check(workBudgetMs("?workBudget=0.2") === 1, "workBudget clamps low to 1");
check(workBudgetMs("?workBudget=9999") === 100, "workBudget clamps high to 100");
check(workBudgetMs("?workBudget=garbage") === 6, "workBudget garbage -> default");
check(workShrinkEnabled("") === true, "workShrink DEFAULT ON");
for (const v of ["off", "0", "false", "no"]) {
  check(workShrinkEnabled(`?workShrink=${v}`) === false, `workShrink=${v} escapes`);
}

// ── PART 2 — budget accounting between items ───────────────────────────────
console.log("PART 2 — budget accounting");
{
  const c = mockClock();
  const s = mkSched(c); // budget 6
  const ran = [];
  for (let i = 0; i < 4; i++) {
    s.enqueue("W6", { kind: `job${i}`, fn: () => { ran.push(i); c.advance(4); } });
  }
  s.run({});
  // 4ms item 1 (spent 4 < 6) -> item 2 (spent 8 >= 6) -> break.
  check(ran.length === 2, `budget 6 with 4ms items runs exactly 2 (got ${ran.length})`);
  check(s._queues.W6.length === 2, "2 items left queued");
  const row = s.statsInto({}).classes.W6;
  check(row.ran === 2 && row.itemsThisFrame === 2, "W6 ran/itemsThisFrame = 2");
  check(row.queueDepth === 2, "W6 queueDepth = 2");
  check(row.maxItemMs === 4, `maxItemMs records the measured item (got ${row.maxItemMs})`);
  s.run({});
  check(ran.length === 4, "second run drains the rest");
}

// ── PART 3 — always-run-one ────────────────────────────────────────────────
console.log("PART 3 — always-run-one");
{
  const c = mockClock();
  const s = mkSched(c);
  let big = 0;
  s.enqueue("W6", { kind: "big", fn: () => { big += 1; c.advance(32); } });
  s.enqueue("W6", { kind: "next", fn: () => { big += 10; } });
  s.run({});
  check(big === 1, "a 32ms item under a 6ms cap still runs (exactly one)");
  s.run({});
  check(big === 11, "the follower runs next slot");
}

// ── PART 4 — priority + starvation counters ────────────────────────────────
console.log("PART 4 — class priority + deferredFrames");
{
  const c = mockClock();
  const s = mkSched(c);
  const order = [];
  s.enqueue("W6", { kind: "legacy", fn: () => { order.push("W6"); c.advance(4); } });
  s.enqueue("W1", { kind: "urgent", fn: () => { order.push("W1"); c.advance(4); } });
  s.enqueue("W3", { kind: "feed", fn: () => { order.push("W3"); c.advance(4); } });
  s.run({});
  check(order[0] === "W1" && order[1] === "W3", `priority order W1>W3 (got ${order.join(",")})`);
  // W1 (4) + W3 (8 >= 6) -> W6 starved this frame.
  check(order.length === 2, "budget broke before W6");
  const st = s.statsInto({});
  check(st.classes.W6.deferredFrames === 1, "starved W6 counts a deferredFrame");
  check(st.classes.W1.deferredFrames === 0, "served class counts none");
}

// ── PART 5 — staleness ceiling force-run ───────────────────────────────────
console.log("PART 5 — force-run at maxDefer");
{
  const c = mockClock();
  const s = mkSched(c);
  let w6ran = false;
  s.enqueue("W6", { kind: "starved", fn: () => { w6ran = true; c.advance(1); } });
  // refill W1 with budget-eating items each frame so W6 never wins the race
  for (let frame = 0; frame < 3; frame++) {
    s.enqueue("W1", { kind: "hog", fn: () => c.advance(10) });
    s.run({});
    if (frame < 2) check(w6ran === false, `frame ${frame}: W6 still deferred`);
  }
  // 3rd run: oldest W6 item has waited 3 frames -> forced despite the hog.
  check(w6ran === true, "W6 force-ran at the 3-frame ceiling");
  const st = s.statsInto({});
  check(st.classes.W6.forcedRuns === 1, "forcedRuns counted");
  check(st.classes.W6.deferredFrames === 2, `deferredFrames counted the starved frames (got ${st.classes.W6.deferredFrames})`);
}

// ── PART 6 — modes ─────────────────────────────────────────────────────────
console.log("PART 6 — mode transitions");
{
  // BOOT -> NORMAL on the in-world predicate.
  const c = mockClock();
  let inWorld = false;
  const s = mkSched(c, { isInWorld: () => inWorld });
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({});
  check(s.mode === "BOOT", "pre-in-world = BOOT");
  check(s.lastBudgetMs === 50, `BOOT budget 50 (got ${s.lastBudgetMs})`);
  inWorld = true;
  s.run({});
  check(s.mode === "NORMAL", "in-world -> NORMAL");
  inWorld = false; // predicate flapping must NOT re-enter BOOT
  s.run({});
  check(s.mode === "NORMAL", "BOOT never re-enters (milestone is one-way)");
}
{
  // TELEPORT one-shot via LB discontinuity.
  const c = mockClock();
  const s = mkSched(c);
  s.noteLbKey(0x0a0a0000);
  s.noteLbKey(0x0b0a0000); // 1 LB east — a walk crossing
  s.run({});
  check(s.mode === "NORMAL" && s.teleports === 0, "adjacent LB change does not arm TELEPORT");
  s.noteLbKey(0x40400000); // Chebyshev ~53 — a teleport
  s.run({});
  check(s.mode === "TELEPORT", "discontinuity arms TELEPORT");
  check(s.lastBudgetMs === 250, `TELEPORT one-shot budget 250 (got ${s.lastBudgetMs})`);
  check(s.teleports === 1, "teleports counted");
  s.run({});
  check(s.mode === "NORMAL", "TELEPORT is one-shot");
  s.noteLbKey(0); // ignored
  s.noteLbKey(NaN);
  s.run({});
  check(s.mode === "NORMAL" && s.teleports === 1, "0/NaN keys ignored");
}
{
  // EMERGENCY: W2 paused (even at the staleness ceiling), W4 ×2 allowance.
  const c = mockClock();
  const s = mkSched(c);
  let w2 = 0;
  let w4 = 0;
  s.enqueue("W2", { kind: "upload", fn: () => { w2 += 1; } });
  for (let i = 0; i < 4; i++) s.enqueue("W4", { kind: "drain", fn: () => { w4 += 1; c.advance(5); } });
  s.setEmergency(true);
  s.run({});
  check(s.mode === "EMERGENCY", "setEmergency -> EMERGENCY");
  check(w2 === 0, "W2 uploads paused in EMERGENCY");
  // 5ms items, W4 limit 12: after 1 (5<12) run, after 2 (10<12) run, after 3 (15>=12) break.
  check(w4 === 3, `W4 gets the doubled allowance (got ${w4}, plain budget would give 2)`);
  s.run({}); s.run({}); s.run({});
  check(w2 === 0, "W2 pause outranks the 3-frame staleness ceiling");
  check(s.statsInto({}).classes.W2.deferredFrames >= 3, "paused W2 counts deferredFrames");
  s.setEmergency(false);
  s.run({});
  check(w2 === 1, "W2 resumes when EMERGENCY clears");
}
{
  // CROSSING lever: armed + queue nonempty + frame under 80% of period.
  const c = mockClock(1000);
  const s = mkSched(c, { crossing: true });
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({ frameStartMs: 998, targetPeriodMs: 16.7 }); // elapsed 2 < 13.36
  check(s.mode === "CROSSING", "CROSSING when armed + pending + light frame");
  check(s.lastBudgetMs === 12, `CROSSING budget 12 (got ${s.lastBudgetMs})`);
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({ frameStartMs: c.t - 15, targetPeriodMs: 16.7 }); // elapsed 15 > 13.36
  check(s.mode === "NORMAL", "heavy frame suppresses CROSSING");
  s.run({ frameStartMs: c.t, targetPeriodMs: 16.7 }); // queues now empty
  check(s.mode === "NORMAL", "empty queues suppress CROSSING");
  const c2 = mockClock(1000);
  const s2 = mkSched(c2, { crossing: false });
  s2.enqueue("W6", { kind: "x", fn: () => c2.advance(1) });
  s2.run({ frameStartMs: 998, targetPeriodMs: 16.7 });
  check(s2.mode === "NORMAL", "lever OFF (default): no CROSSING");
}

// ── PART 7 — shrink rule ───────────────────────────────────────────────────
console.log("PART 7 — shrink rule");
{
  const c = mockClock(100);
  const s = mkSched(c);
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({ frameStartMs: 80, targetPeriodMs: 16 }); // elapsed 20, over by 4
  check(s.lastBudgetMs === 2, `over-by-4 shrinks 6 -> 2 (got ${s.lastBudgetMs})`);
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({ frameStartMs: c.t - 40, targetPeriodMs: 16 }); // over by 24
  check(s.lastBudgetMs === 2, "shrink floors at 2 ms");
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({ frameStartMs: c.t - 10, targetPeriodMs: 16 }); // under period
  check(s.lastBudgetMs === 6, "light frame keeps the full budget");
  const s2 = mkSched(c, { shrink: false });
  s2.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s2.run({ frameStartMs: c.t - 40, targetPeriodMs: 16 });
  check(s2.lastBudgetMs === 6, "?workShrink=off escape keeps the full budget");
  // BOOT never shrinks.
  const s3 = mkSched(c, { isInWorld: () => false });
  s3.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s3.run({ frameStartMs: c.t - 40, targetPeriodMs: 16 });
  check(s3.lastBudgetMs === 50, "BOOT budget never shrinks");
}

// ── PART 8 — W6 yield grants ───────────────────────────────────────────────
console.log("PART 8 — w6Yield");
await (async () => {
  const c = mockClock();
  const s = mkSched(c);
  const settled = [false, false];
  const p0 = s.w6Yield("statics", 9).then(() => { settled[0] = true; });
  const p1 = s.w6Yield("cells", 4).then(() => { settled[1] = true; });
  check(s.statsInto({}).classes.W6.queueDepth === 2, "two resumes queued");
  check(s.statsInto({}).classes.W6.maxItemMs === 9, "reported chunk ms feeds maxItemMs");
  s.run({});
  await p0; // first grant: est charge 9 -> spent >= 6 -> second deferred
  check(settled[0] === true, "first yield granted");
  check(settled[1] === false, "second yield deferred (estimate-charged budget)");
  s.run({});
  await p1;
  check(settled[1] === true, "second yield granted next slot");
})();

// ── PART 9 — w6Run coalescing + purgeByTile ────────────────────────────────
console.log("PART 9 — coalescing + purge");
{
  const c = mockClock();
  const s = mkSched(c);
  const hits = [];
  s.w6Run("drain", () => hits.push("first"));
  s.w6Run("drain", () => hits.push("second"));
  check(s._queues.W6.length === 1, "same-name w6Run coalesces to one item");
  s.run({});
  check(hits.length === 1 && hits[0] === "second", "latest fn wins");
  s.w6Run("drain", () => hits.push("third")); // re-enqueue after service works
  s.run({});
  check(hits[1] === "third", "name is reusable after service");

  let fed = 0;
  s.enqueue("W3", { kind: "feed", tileKey: "t1", fn: () => { fed += 1; } });
  s.enqueue("W3", { kind: "feed", tileKey: "t2", fn: () => { fed += 1; } });
  const purged = s.purgeByTile("t1");
  check(purged === 1, "purgeByTile removes the vacated tile's items");
  s.run({});
  check(fed === 1, "only the surviving tile's feed ran");
}

// ── PART 10 — stats shape vs the diag registry ─────────────────────────────
console.log("PART 10 — __frameWork schema conformance");
{
  const c = mockClock();
  const s = mkSched(c);
  s.enqueue("W6", { kind: "x", fn: () => c.advance(1) });
  s.run({});
  const st = s.statsInto({});
  const reg = getSurface("__frameWork");
  check(!!reg, "__frameWork is registered");
  const classFields = Object.keys(reg.fields)
    .filter((p) => p.startsWith("classes.*."))
    .map((p) => p.split(".").pop());
  check(classFields.length >= 5, "registry declares the per-class row");
  for (const cls of WORK_CLASSES) {
    for (const f of classFields) {
      check(
        typeof st.classes[cls]?.[f] === "number",
        `classes.${cls}.${f} published as a number`,
      );
    }
  }
  const modeNote = reg.fields.mode?.note || "";
  check(MODES.every((m) => modeNote.includes(m)), "registry mode enum covers all scheduler modes");
  check(MODES.includes(st.mode), `published mode ${st.mode} is in the enum`);
  check(st.uploads && typeof st.uploads.initTextureCalls === "number"
    && Array.isArray(st.uploads.exclusive), "uploads surface has the stage-C shape (zeros at stage A)");
}

// ── PART 11 — framePhase helpers ───────────────────────────────────────────
console.log("PART 11 — framePhase");
await (async () => {
  // Fresh module instance so the memoized gate starts OFF, then flips.
  const m = await import("../scene3d/frame_work.js?fp-test");
  // Disabled: inert.
  m.framePhaseBegin();
  m.framePhaseCut(0);
  m.framePhaseCommit();
  m._setFramePhaseEnabledForTest(true);
  m.framePhaseBegin();
  for (let slot = 0; slot <= 4; slot++) m.framePhaseCut(slot);
  m.framePhaseCommit();
  // No window in node: read via the module's committed state through a second
  // frame — the observable contract is "frames counts, cumulative >= last".
  m.framePhaseBegin();
  for (let slot = 0; slot <= 4; slot++) m.framePhaseCut(slot);
  m.framePhaseCommit();
  // Install-on-window path: stub a window and re-enable to install.
  globalThis.window = {};
  m._setFramePhaseEnabledForTest(true);
  const fp = globalThis.window.__framePhase;
  check(!!fp, "__framePhase installs on window when enabled");
  check(fp.frames === 2, `disabled-time commits did not count; enabled ones did (frames=${fp.frames})`);
  for (const k of ["p0", "p1", "p2", "p3", "p4"]) {
    check(typeof fp[k] === "number" && fp[k] >= 0, `${k} is a non-negative level`);
    check(typeof fp[`${k}Ms`] === "number" && fp[`${k}Ms`] >= fp[k], `${k}Ms cumulative >= last-frame`);
  }
  delete globalThis.window;
})();

// ── PART 12 — singleton arms ───────────────────────────────────────────────
console.log("PART 12 — singleton OFF/ON arms");
await (async () => {
  // OFF arm: the default import ran with no window -> flag OFF.
  const off = await import("../scene3d/frame_work.js");
  check(off.frameWorkW6Run("x", () => {}) === false, "OFF: w6Run declines (caller keeps legacy path)");
  const t0 = Date.now();
  await off.frameWorkW6Yield("x", 1); // must resolve via setTimeout(0) with no scheduler
  check(Date.now() - t0 < 500, "OFF: w6Yield resolves as a plain macrotask yield");
  off.frameWorkP4({}); // no-op, no throw
  off.frameWorkNoteLbKey(0x01010000); // no-op, no throw
  check(off.getFrameWorkScheduler().teleports === 0, "OFF: note is a no-op");

  // ON arm: stub window BEFORE a fresh module instance loads.
  globalThis.window = {
    location: { search: "?frameWork=on" },
    __bootState: "in-world",
  };
  const on = await import("../scene3d/frame_work.js?on-arm");
  check(globalThis.window.__frameWork?.enabled === true, "ON: __frameWork installed, enabled:true");
  let drained = 0;
  check(on.frameWorkW6Run("drain", () => { drained += 1; }) === true, "ON: w6Run accepted");
  on.frameWorkP4({});
  check(drained === 1, "ON: P4 served the W6 drain");
  check(globalThis.window.__frameWork.classes.W6.ran === 1, "ON: surface published the run");
  check(globalThis.window.__frameWork.mode === "NORMAL", "ON: in-world -> NORMAL");
  let resumed = false;
  const p = on.frameWorkW6Yield("chunk", 2).then(() => { resumed = true; });
  on.frameWorkP4({});
  await p;
  check(resumed === true, "ON: yield resumed by the slot");
  delete globalThis.window;
})();

console.log(`\nframe-work test: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("FRAME-WORK ✅");
  process.exit(0);
} else {
  console.log("FRAME-WORK ❌");
  process.exit(1);
}
