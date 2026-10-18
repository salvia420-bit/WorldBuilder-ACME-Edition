// tests/rynth_rs_jump_cancel.test.mjs — RYNTH-4 leftover (2026-10-18 review):
// the `/rs jump` job (ActiveNav.requestJump → _startJump) now gets the job's
// isAborted(), and the JumpNow slot leaving (a higher slot takes the tick)
// or dispose() cancels it. Before, the job kept turning, charged and fired
// the jump ~2 s later behind the new owner's back.
//
// REAL goto_compose.attemptJumpLeg (real timers, a fast tune) and the REAL
// ActiveNav over a fake host / router / bot.
//
// Run from apps/holtburger-web/:  node tests/rynth_rs_jump_cancel.test.mjs

import assert from "node:assert/strict";

const goto = await import("../rynth/goto_compose.js");
const { ActiveNav } = await import("../rynth/vt/nav/active_nav.js");

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

// A 5 ms poll and a 600 ms turn budget: an uncancelled job keeps turning,
// then charges and jumps well inside the wait below.
const TUNE = { pollMs: 5, jumpTurnTimeoutMs: 600, jumpApproachMinMs: 1, jumpApproachMaxMs: 400, jumpAirborneTimeoutMs: 20, jumpLandingPollMs: 2, jumpLandingSettlePadMs: 2 };
const gc = { buildTune: (o = {}) => goto.buildTune({ ...o, ...TUNE }), attemptJumpLeg: goto.attemptJumpLeg };

const LB = 0xa9b40015;
function jumpHost() {
  const h = { heading: 0, log: [] };
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

function makeNav(host, { running }) {
  const router = { route: [], status: { state: "IDLE" }, follow() {}, cancel() {} };
  const options = { getValue: (k) => ({ EnableNavigation: true, FollowNavMin: 3 })[k], set: () => ({ ok: true }) };
  const claims = [];
  const bot = {
    kernel: { running, operatorHeld: false },
    claimMovement: (tag) => {
      claims.push(tag);
      return () => claims.splice(claims.indexOf(tag), 1);
    },
    movementClaimed: () => false,
  };
  const state = {};
  const nav = new ActiveNav({ host, router, bot, options, state, gotoCompose: gc, log: () => {} });
  return { nav, claims, state };
}

await check("queued /rs jump: the JumpNow slot leaving mid-turn aborts it — no further turn, no charge, no Jump", async () => {
  const h = jumpHost();
  const { nav, state } = makeNav(h, { running: true });
  const r = nav.requestJump({ headingDeg: 90, ms: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.queued, true);
  nav.jumpSlot.tick({});
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 3), "turning toward 90");
  nav.jumpSlot.onLeave("Vitals");
  const leftAt = performance.now();
  assert.ok(await until(() => state.lastJump != null, 1000), "the job settles");
  await sleep(900);
  assert.equal(h.calls("TurnToHeading", leftAt + 20).length, 0, "no TurnToHeading after the slot left");
  assert.equal(h.calls("SetMovementInput").length, 0, "no charge");
  assert.equal(h.calls("Jump").length, 0, "no jump");
  assert.equal(state.lastJump.ok, false);
  assert.match(String(state.lastJump.error), /aborted/);
  assert.equal(nav.jumpSlot.wants(), false, "nothing left queued");
});

await check("immediate /rs jump (kernel stopped): dispose() mid-turn aborts it and releases the movement claim", async () => {
  const h = jumpHost();
  const { nav, claims, state } = makeNav(h, { running: false });
  const r = nav.requestJump({ headingDeg: 90, ms: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.queued, false);
  assert.deepEqual(claims, ["rs-jump"]);
  assert.ok(await until(() => h.calls("TurnToHeading").length >= 3), "turning toward 90");
  nav.dispose();
  const goneAt = performance.now();
  assert.ok(await until(() => claims.length === 0, 1000), "claim released");
  await sleep(900);
  assert.equal(h.calls("TurnToHeading", goneAt + 20).length, 0, "no TurnToHeading after dispose");
  assert.equal(h.calls("Jump").length, 0, "no jump");
  assert.match(String(state.lastJump && state.lastJump.error), /aborted/);
});

await check("an uncancelled /rs jump still turns and jumps", async () => {
  const h = jumpHost();
  const { nav, state } = makeNav(h, { running: false });
  assert.equal(nav.requestJump({ headingDeg: 90, ms: 50 }).ok, true);
  assert.ok(await until(() => h.calls("Jump").length === 1, 3000), "jumped");
  assert.ok(await until(() => state.lastJump != null, 1000));
  assert.ok(h.calls("TurnToHeading").length >= 3, "turned first");
});

console.log(`rynth_rs_jump_cancel: ${fail ? `${fail} FAILED, ` : "all "}${pass} checks passed`);
if (fail) process.exit(1);
