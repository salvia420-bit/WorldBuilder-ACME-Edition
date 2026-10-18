// tests/rynth_jump_abort.test.mjs — RYNTH-4 (2026-10-18 review): an
// operator STOP (the kernel's onLeave("Stopped") → ActiveNav.yield →
// executor cancel) aborts an in-flight nav jump before it fires: no further
// TurnToHeading, the charge key is let go within one poll, no Jump(). The
// waypoint is not FAILED by the abort; it jumps again, fresh, on resume (and
// on a rebind: a new ActiveNav sharing the executor memory).
// The legacy replayRoute jump aborts the same way when its router is
// cancelled (review extra).
//
// REAL goto_compose.attemptJumpLeg (real timers, a fast tune), the REAL
// ActiveNav + executors over a fake host / router, and the real replayRoute.
//
// Run from apps/holtburger-web/:  node tests/rynth_jump_abort.test.mjs

import assert from "node:assert/strict";

const goto = await import("../rynth/goto_compose.js");
const { legToNavPoint } = await import("../rynth/nav_file.js");
const { ActiveNav } = await import("../rynth/vt/nav/active_nav.js");
const { makeExecutor, NAV_TUNING } = await import("../rynth/vt/nav/executors.js");
const { ROUTE, POINT } = await import("../rynth/vt/nav/route_model.js");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, maxMs = 2000) {
  const end = performance.now() + maxMs;
  while (performance.now() < end) {
    if (pred()) return true;
    await sleep(2);
  }
  return pred();
}

// A 5 ms poll, a 2 s turn budget and a 300 ms charge: an unaborted job keeps
// turning / holding forward long after the STOP, an aborted one ends in a poll.
const TUNE = { pollMs: 5, jumpTurnTimeoutMs: 2000, jumpApproachMinMs: 1, jumpApproachMaxMs: 400, jumpAirborneTimeoutMs: 20, jumpLandingPollMs: 2, jumpLandingSettlePadMs: 2 };
const gc = { buildTune: (o = {}) => goto.buildTune({ ...o, ...TUNE }), attemptJumpLeg: goto.attemptJumpLeg };

const LB = 0xa9b40015;
const EAST = Math.PI / 2;
function jumpHost(heading = 0) {
  const h = { heading, log: [] };
  const rec = (name) => (...a) => h.log.push({ name, a, at: performance.now() });
  Object.assign(h, {
    TryGetPlayerPose: () => ({ objCellId: LB, x: 100, y: 100, z: 0, heading: h.heading }),
    CanJumpNow: () => true,
    TurnToHeading: rec("TurnToHeading"), // a stuck turn: the heading does not change
    SetMovementInput: rec("SetMovementInput"),
    Jump: rec("Jump"),
  });
  h.calls = (name, since = 0) => h.log.filter((c) => c.name === name && c.at >= since);
  return h;
}

function makeNav(host, g = gc) {
  const router = {
    route: [],
    status: { state: "IDLE" },
    follow(legs) {
      this.route = legs;
      this.status = { state: "WALK" };
    },
    cancel() {
      this.status = { state: "IDLE" };
    },
  };
  const options = { getValue: (k) => ({ EnableNavigation: true, FollowNavMin: 3 })[k], set: () => ({ ok: true }) };
  const bot = { kernel: { running: true, operatorHeld: false }, claimMovement: () => () => {}, movementClaimed: () => false };
  const nav = new ActiveNav({ host, router, bot, options, state: {}, gotoCompose: g, log: () => {} });
  const here = legToNavPoint(LB, 100, 100, 0);
  const far = legToNavPoint(LB, 150, 100, 0);
  nav.load({
    routeType: ROUTE.Once,
    points: [
      { type: POINT.Jump, ew: here.ew, ns: here.ns, z: 0, headingDeg: 90, holdShift: false, delayMs: 300 },
      { type: POINT.Point, ew: far.ew, ns: far.ns, z: 0 },
    ],
  });
  return { nav, router };
}

await check("STOP while the jump is still turning: no further turn, no charge, no Jump; resume jumps fresh and completes", async () => {
  const h = jumpHost(0);
  const { nav } = makeNav(h);
  nav.slot.tick({});
  assert.equal(nav.slot.pinned(), true, "the jump job runs");
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 3), "turning toward 90");
  nav.slot.onLeave("Stopped"); // kernel.holdForOperator → stop → onLeave
  const stopAt = performance.now();
  assert.ok(await until(() => !nav.slot.pinned(), 1000), "the job lets go");
  const settledMs = performance.now() - stopAt;
  await sleep(60);
  assert.equal(h.calls("TurnToHeading", stopAt).length, 0, "no TurnToHeading after STOP");
  assert.equal(h.calls("SetMovementInput").length, 0, "no charge");
  assert.equal(h.calls("Jump").length, 0, "no jump");
  assert.ok(settledMs < 250, `ended within a poll or so (${settledMs.toFixed(0)} ms)`);
  assert.equal(nav.state.lastResult, null, "the abort does not FAIL the waypoint");
  assert.equal(nav.route().activeIndex, 0);
  // Resume: the waypoint runs again and jumps (now facing east).
  h.heading = EAST;
  nav.slot.tick({});
  nav.slot.tick({});
  assert.ok(await until(() => h.calls("Jump").length === 1), "jumped after resume");
  assert.ok(await until(() => !nav.slot.pinned()), "landed");
  nav.slot.tick({});
  assert.equal(nav.state.lastResult, "DONE:9");
  assert.equal(nav.route().activeIndex, 1);
});

await check("STOP during the charge: forward is let go within a poll and Jump never fires", async () => {
  const h = jumpHost(EAST);
  const { nav } = makeNav(h);
  nav.slot.tick({});
  assert.ok(await until(() => h.calls("SetMovementInput").length === 1), "the charge holds forward");
  assert.deepEqual(h.calls("SetMovementInput")[0].a, [1, 0, 0, true]);
  await sleep(20);
  nav.slot.onLeave("Stopped");
  const stopAt = performance.now();
  assert.ok(await until(() => h.calls("SetMovementInput").length === 2, 1000), "released");
  const rel = h.calls("SetMovementInput")[1];
  assert.deepEqual(rel.a, [0, 0, 0, false]);
  assert.ok(rel.at - stopAt < 150, `released ${(rel.at - stopAt).toFixed(0)} ms after STOP (charge is 300 ms)`);
  await sleep(400);
  assert.equal(h.calls("Jump").length, 0, "no jump after STOP");
  assert.equal(h.calls("SetMovementInput").length, 2, "nothing pressed again");
  assert.equal(nav.state.lastResult, null);
});

await check("a rebind mid-turn (old ActiveNav disposed): the old job stops driving, the new one jumps fresh (no 12 s 'outcome unknown')", async () => {
  const h = jumpHost(0);
  const { nav, router } = makeNav(h);
  nav.slot.tick({});
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 2));
  nav.dispose();
  const stopAt = performance.now();
  await sleep(40);
  assert.equal(h.calls("TurnToHeading", stopAt + 10).length, 0, "the old job stopped turning");
  const nav2 = new ActiveNav({ host: h, router, bot: nav.bot, options: nav.options, state: nav.state, gotoCompose: gc, log: () => {} });
  h.heading = EAST;
  let jumped = false;
  const end = performance.now() + 2000;
  while (!jumped && performance.now() < end) {
    nav2.slot.tick({});
    await sleep(5);
    jumped = h.calls("Jump").length === 1;
  }
  assert.ok(jumped, "the new ActiveNav jumped");
  assert.ok(performance.now() - stopAt < NAV_TUNING.jumpRebindGraceMs / 4, "well inside the rebind grace");
  assert.ok(await until(() => !nav2.slot.pinned()));
  nav2.slot.tick({});
  assert.equal(nav2.state.lastResult, "DONE:9", "a real outcome, not 'jump outcome unknown after a rebind'");
});

await check("a rebind whose new ActiveNav ticks before the old job lets go (its clock moved startedAt): it still jumps fresh", async () => {
  // A 60 ms poll: the old job is still in its turn poll when nav2 first runs.
  const slow = { buildTune: (o = {}) => goto.buildTune({ ...o, ...TUNE, pollMs: 60 }), attemptJumpLeg: goto.attemptJumpLeg };
  const h = jumpHost(0);
  const { nav, router } = makeNav(h, slow);
  nav.slot.tick({});
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 1));
  nav.dispose();
  await sleep(5);
  const nav2 = new ActiveNav({ host: h, router, bot: nav.bot, options: nav.options, state: nav.state, gotoCompose: slow, log: () => {} });
  nav2.slot.tick({}); // _resumeClock shifts mem.startedAt by the time away
  assert.equal(h.calls("Jump").length, 0);
  h.heading = EAST;
  let jumped = false;
  const end = performance.now() + 2000;
  while (!jumped && performance.now() < end) {
    nav2.slot.tick({});
    await sleep(5);
    jumped = h.calls("Jump").length === 1;
  }
  assert.ok(jumped, "the new ActiveNav jumped (not the 12 s grace, then 'outcome unknown' with no jump)");
  assert.ok(await until(() => !nav2.slot.pinned()));
  nav2.slot.tick({});
  assert.equal(nav2.state.lastResult, "DONE:9");
});

await check("Point stuck rung: cancel() aborts its jump job and gives the rung back", async () => {
  const h = jumpHost(0);
  const far = legToNavPoint(LB, 150, 100, 0);
  let issued = 0;
  const ctx = {
    host: h,
    gotoCompose: gc,
    mem: { reissues: NAV_TUNING.stuckReissues },
    log: () => {},
    now: () => performance.now(),
    pose: () => h.TryGetPlayerPose(),
    inPortalSpace: () => false,
    arriveM: () => 3,
    issueLeg: () => issued++,
    legState: () => "FAILED",
    cancelLeg: () => {},
  };
  const ex = makeExecutor({ type: POINT.Point, ew: far.ew, ns: far.ns, z: 0 }, ctx);
  assert.equal(ex.step(performance.now()), "running"); // issues the leg
  assert.equal(ex.step(performance.now()), "running"); // FAILED, rungs used up → jump
  assert.equal(ctx.mem.jumped, true);
  assert.ok(ex.job && !ex.job.settled, "the stuck-rung jump job runs");
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 2));
  ex.cancel();
  assert.ok(await until(() => ex.job.settled, 1000), "aborted");
  assert.equal(ex.job.result.aborted, true);
  assert.equal(h.calls("Jump").length + h.calls("SetMovementInput").length, 0);
  const n = issued;
  ex.step(performance.now());
  assert.equal(ctx.mem.jumped, false, "the jump never fired: the rung is still there");
  assert.equal(issued, n + 1, "the leg is re-issued");
});

await check("Point stuck rung on a rebind: the old executor's aborted jump gives the rung to the new one (sharing mem)", async () => {
  const h = jumpHost(0);
  const far = legToNavPoint(LB, 150, 100, 0);
  const mem = { reissues: NAV_TUNING.stuckReissues };
  const ctx = {
    host: h,
    gotoCompose: gc,
    mem,
    log: () => {},
    now: () => performance.now(),
    pose: () => h.TryGetPlayerPose(),
    inPortalSpace: () => false,
    arriveM: () => 3,
    issueLeg: () => {},
    legState: () => "FAILED",
    cancelLeg: () => {},
  };
  const point = { type: POINT.Point, ew: far.ew, ns: far.ns, z: 0 };
  const old = makeExecutor(point, ctx);
  old.step(performance.now());
  old.step(performance.now());
  assert.ok(old.job && !old.job.settled, "the old executor's jump runs");
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 1));
  old.cancel(); // its ActiveNav is disposed: old.step never runs again
  assert.ok(await until(() => old.job.settled, 1000));
  assert.equal(mem.jumped, false, "the rung is back in the shared mem");
  const ex = makeExecutor(point, { ...ctx });
  ex.step(performance.now());
  ex.step(performance.now());
  assert.ok(ex.job && !ex.job.settled, "the new executor jumps instead of failing 'stuck'");
  assert.equal(ex.failReason, null);
  ex.cancel();
  await until(() => ex.job.settled, 1000);
});

await check("attemptJumpLeg: aborted before it starts sends nothing; never aborted fires as before", async () => {
  const leg = { meta: { navType: "jmp", headingDeg: 90, holdShift: false, delayMs: 100 } };
  const tune = { ...gc.buildTune({}), direction: "forward" };
  const h = jumpHost(0);
  const r = await goto.attemptJumpLeg({ host: h, isAborted: () => true }, leg, tune);
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.equal(r.reason, "aborted");
  assert.equal(h.log.length, 0);
  const h2 = jumpHost(EAST);
  const r2 = await goto.attemptJumpLeg({ host: h2, isAborted: () => false }, leg, tune);
  assert.equal(r2.ok, true);
  assert.deepEqual(h2.log.map((c) => c.name), ["SetMovementInput", "Jump", "SetMovementInput"]);
});

await check("legacy replayRoute: a router cancel (operator STOP) during the jump aborts it → CANCELLED, no Jump", async () => {
  const h = jumpHost(0);
  const router = {
    status: { state: "IDLE", leg: 0, walked: 0 },
    follow() {
      this.status = { state: "FAILED", leg: 0, walked: 0 };
    },
    cancel() {
      this.status = { state: "IDLE", leg: 0, walked: 0 };
    },
  };
  const legs = [
    { lb: LB, x: 100, y: 100, z: 0 },
    { lb: LB, x: 110, y: 100, z: 0, meta: { navType: "jmp", headingDeg: 90, holdShift: false, delayMs: 300 } },
  ];
  const done = goto.replayRoute({ host: h, router, log: () => {} }, legs, { ...TUNE, timeoutMs: 10_000 });
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 2), "the replay's jump is turning");
  router.cancel();
  const stopAt = performance.now();
  const r = await done;
  assert.equal(r.state, "CANCELLED");
  assert.ok(performance.now() - stopAt < 250, "ended within a poll or so");
  assert.equal(h.calls("Jump").length + h.calls("SetMovementInput").length, 0);
});

console.log(fail === 0 ? `rynth_jump_abort: all ${pass} checks passed` : `rynth_jump_abort: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
