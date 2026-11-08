// tests/challenger_m2_nav_unwedge_stress.test.mjs
// Adversarial Challenger M2 Stress Test: Navigation & Unwedge Reflex Modules
// Stress tests:
//   1. UnwedgeReflex 4-stage recovery ladder across repeated wedge events:
//      - Breadcrumb backtracking & trail cap
//      - Avoidance zone logging (exploreMemory.markWedge)
//      - Stage 1 retreat completion & crumb pruning
//      - Stage 2 recall spell escalation
//      - Stage 3 admin @teleloc last resort
//      - Livelock threshold trigger (3 frees in same area -> force recall)
//      - Escalation suppression under VTank navigation
//   2. Waypoint runner edge cases:
//      - Single-waypoint routes (Linear, Circular, Once, Follow)
//      - Rapid waypoint reaching & skipDense bounded loop
//      - Action waypoint protection in skipDense
//      - Jump waypoint heading and power boundary checks
//      - JumpExecutor job lifecycle, abort/cancellation, and rebind grace

import assert from "node:assert/strict";

const { UnwedgeReflex } = await import("../rynth/unwedge.js");
const { ExploreMemory } = await import("../rynth/ai/explore_memory.js");
const { worldX, worldY } = await import("../rynth/nav_frame.js");
const RM = await import("../rynth/vt/nav/route_model.js");
const EX = await import("../rynth/vt/nav/executors.js");

const { degToWorld } = await import("../rynth/nav_file.js");

const {
  ROUTE,
  POINT,
  makeRoute,
  normalizePoint,
  advance,
  isEmpty,
  skipDense,
  reverse,
  minDistM,
} = RM;

const {
  makeExecutor,
  jumpArgs,
  NAV_TUNING,
} = EX;

let pass = 0;
let fail = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    results.push({ name, status: "PASS" });
    console.log(`  [OK] ${name}`);
  } catch (e) {
    fail++;
    results.push({ name, status: "FAIL", error: e });
    console.error(`  [FAIL] ${name}\n       ${e?.stack || e}`);
  }
}

// ── Unwedge Reflex Test Rig ───────────────────────────────────────────────
const CELL_OUTDOOR = 0x12340001; // Landblock 0x1234
let NOW = 1_700_000_000_000;
const now = () => NOW;

function createUnwedgeRig(opts = {}) {
  const exploreMemory = new ExploreMemory();
  const loggedWedges = [];
  const originalMarkWedge = exploreMemory.markWedge.bind(exploreMemory);
  exploreMemory.markWedge = (x, y, r) => {
    loggedWedges.push({ x, y, r, at: NOW });
    originalMarkWedge(x, y, r);
  };

  const journal = [];
  const moves = [];
  const chats = [];
  const stops = [];

  const state = {
    pose: { objCellId: CELL_OUTDOOR, x: 50, y: 50, z: 10, cellResolved: true },
    castBusy: 0,
    knownSpells: opts.knownSpells ?? [1635, 2023], // Lifestone Recall & Sanctuary
    routerState: "WALK",
  };

  const host = {
    moves,
    chats,
    stops,
    s: {
      playerKnownSpells: () => state.knownSpells.slice(),
    },
    TryGetPlayerPose: () => ({ ...state.pose }),
    GetCastBusyState: () => state.castBusy,
    MoveToPosition(cell, x, y, z, run) {
      moves.push({ cell, x, y, z, run, at: NOW });
      return true;
    },
    StopCompletely() {
      stops.push({ at: NOW });
      return true;
    },
    InvokeChatParser(cmd) {
      chats.push({ cmd, at: NOW });
      return true;
    },
  };

  const bot = {
    host,
    router: {
      status: {
        get state() {
          return state.routerState;
        },
      },
      cancel() {
        state.routerState = "IDLE";
      },
    },
    kernel: {
      running: true,
      stop() {
        this.running = false;
      },
      start() {
        this.running = true;
      },
    },
    ai: {
      extensions: { exploreMemory },
      journal: {
        add(kind, text) {
          journal.push({ kind, text, at: NOW });
        },
      },
    },
  };

  const reflex = new UnwedgeReflex(host, {
    now,
    log: () => {},
    sampleMs: 100,
    wedgeAfterMs: 3000,
    progressM: 1.0,
    crumbSpacingM: 1.0,
    crumbCap: 12,
    cooldownMs: 5000,
    minRetreatM: 3.5,
    maxRetreatCrumbs: 3,
    freedM: 5.0,
    recallTune: {
      adminTeleWaitMs: 100,
      teleportPollMs: 10,
    },
    ...opts,
  });

  reflex.bot = bot;

  return {
    reflex,
    state,
    host,
    bot,
    exploreMemory,
    loggedWedges,
    journal,
    moves,
    chats,
    tick: (dt = 100) => {
      NOW += dt;
      reflex.tick();
    },
    teleportTo: (cell, x, y, z) => {
      state.pose = { objCellId: cell, x, y, z, cellResolved: true };
      NOW += 100;
      reflex.tick();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE 1: Unwedge Reflex 4-Stage Recovery Ladder Stress Tests
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== CHALLENGE 1: Unwedge Reflex 4-Stage Recovery Ladder Stress ===");

await check("Stage 1 Breadcrumb retreat: Avoidance zone logged, breadcrumbs ring-buffered, and clean retreat frees bot", () => {
  const rig = createUnwedgeRig();

  // Lay 15 breadcrumbs by moving along +X axis (spacing = 2m each)
  for (let i = 0; i < 15; i++) {
    rig.state.pose.x += 2.0;
    rig.tick(500);
  }

  // Ring buffer cap is 12: crumbs count must never exceed 12
  assert.equal(rig.reflex._crumbs.length, 12, `Crumb count must be capped at 12 (got ${rig.reflex._crumbs.length})`);

  // Stop moving, keep router in WALK mode to trigger wedge detection
  const wedgeAnchorX = rig.state.pose.x;
  const wedgeAnchorY = rig.state.pose.y;

  // Advance time past wedgeAfterMs (3000ms)
  for (let t = 0; t < 35; t++) {
    rig.tick(100);
  }

  // Verification 1: Wedge detected! State transitioned to RETREAT
  assert.equal(rig.reflex.state, "RETREAT", `Must transition to RETREAT upon wedge detection`);
  assert.equal(rig.reflex.wedges, 1, `Wedge counter must increment to 1`);

  // Verification 2: Avoidance zone logged in exploreMemory immediately
  assert.equal(rig.loggedWedges.length, 1, `Must log wedge in exploreMemory immediately upon detection`);
  const logged = rig.loggedWedges[0];
  const expectedWx = worldX(CELL_OUTDOOR, wedgeAnchorX);
  const expectedWy = worldY(CELL_OUTDOOR, wedgeAnchorY);
  assert.equal(logged.x, expectedWx);
  assert.equal(logged.y, expectedWy);
  assert.equal(logged.r, 8, `Avoidance zone radius must be 8m`);

  // Verification 3: MoveToPosition was issued for chosen breadcrumb (at least 3.5m back)
  assert.ok(rig.moves.length > 0, "Must have issued MoveToPosition for retreat crumb");
  const retreatMove = rig.moves[0];
  const dRetreat = Math.hypot(retreatMove.x - wedgeAnchorX, retreatMove.y - wedgeAnchorY);
  assert.ok(dRetreat >= 3.5, `Chosen retreat crumb must be >= 3.5m away (got ${dRetreat.toFixed(2)}m)`);

  // Verification 4: Simulate reaching retreat crumb -> frees the bot
  rig.state.pose.x = retreatMove.x;
  rig.state.pose.y = retreatMove.y;
  rig.tick(100);

  assert.equal(rig.reflex.state, "MONITOR", "Reaching retreat crumb must return state to MONITOR");
  assert.equal(rig.reflex.freedCount, 1, "Freed counter must increment to 1");

  // Subsequent crumbs leading to the wedge must be pruned
  assert.ok(rig.reflex._crumbs.length < 12, "Crumbs newer than the retreat target must be pruned");
});

await check("Stage 2 Recall escalation: Exhausted retreat escalates to recall cast without infinite loop", async () => {
  const rig = createUnwedgeRig();

  // Lay 4 breadcrumbs
  for (let i = 0; i < 4; i++) {
    rig.state.pose.x += 2.0;
    rig.tick(500);
  }

  // Trigger wedge
  for (let t = 0; t < 35; t++) rig.tick(100);
  assert.equal(rig.reflex.state, "RETREAT");

  // Simulate retreat failure: pose does NOT move toward crumb for retreatLegMs (12,000ms)
  // Repeat for maxRetreatCrumbs (3 attempts)
  for (let attempt = 0; attempt < 4; attempt++) {
    rig.tick(13000);
  }

  // State must escalate to RECALL
  assert.equal(rig.reflex.state, "RECALL", "Exhausted retreat attempts must escalate to RECALL");

  // Simulate recall teleport arrival (jump >= 30m)
  rig.teleportTo(0x99990001, 10, 10, 0);

  // Bot must be freed by teleport
  assert.equal(rig.reflex.state, "MONITOR", "Teleport clear must finish recovery and return to MONITOR");
  assert.ok(rig.reflex.lastResult.why.includes("teleported"), "Recovery reason must record teleport");
});

await check("Stage 3 Admin @teleloc last resort: When character has NO recall spells, admin teleloc is invoked", async () => {
  const rig = createUnwedgeRig({
    knownSpells: [], // NO recall spells known!
  });

  // Lay 3 breadcrumbs
  for (let i = 0; i < 3; i++) {
    rig.state.pose.x += 3.0;
    rig.tick(500);
  }

  const oldestCrumb = { ...rig.reflex._crumbs[0] };

  // Trigger wedge
  for (let t = 0; t < 35; t++) rig.tick(100);
  assert.equal(rig.reflex.state, "RETREAT");

  // Fail retreat attempts to exhaust crumbs
  for (let attempt = 0; attempt < 4; attempt++) {
    rig.tick(13000);
  }

  assert.equal(rig.reflex.state, "RECALL");

  // Wait for async _doRecall to execute
  await new Promise((r) => setTimeout(r, 200));

  // Verify journal has honest recall-unavailable note
  const note = rig.journal.find((j) => j.text.includes("recall-unavailable"));
  assert.ok(note, "Must journal 'recall-unavailable' fact when no recall spells are known");

  // Verify admin teleloc command was sent for oldest breadcrumb
  const adminCmd = rig.chats.find((c) => c.cmd.startsWith("@teleloc"));
  assert.ok(adminCmd, "Must issue @teleloc chat command to oldest breadcrumb as last resort");
  assert.ok(adminCmd.cmd.includes(oldestCrumb.x.toFixed(2)), "Teleloc coordinates must match oldest crumb x");
  assert.ok(adminCmd.cmd.includes(oldestCrumb.y.toFixed(2)), "Teleloc coordinates must match oldest crumb y");
});

await check("Stage 4 Repeated wedge cycles: 5 consecutive wedge/recovery cycles operate with zero memory leaks", () => {
  const rig = createUnwedgeRig();

  for (let cycle = 1; cycle <= 5; cycle++) {
    // Advance past cooldown and ensure router is commanding movement
    NOW += 6000;
    rig.state.routerState = "WALK";

    // Move to a distinct geographical area for each cycle (100m separation)
    rig.state.pose.x = 50 + cycle * 100;
    rig.state.pose.y = 50 + cycle * 100;

    // Lay 5 crumbs
    for (let i = 0; i < 5; i++) {
      rig.state.pose.x += 2.0;
      rig.tick(500);
    }

    const currentX = rig.state.pose.x;

    // Trigger wedge
    for (let t = 0; t < 35; t++) rig.tick(100);
    assert.equal(rig.reflex.state, "RETREAT", `Cycle ${cycle} must enter RETREAT`);

    // Free the bot
    rig.state.pose.x -= 4.0;
    rig.tick(100);
    assert.equal(rig.reflex.state, "MONITOR", `Cycle ${cycle} must be FREED`);
  }

  assert.equal(rig.reflex.wedges, 5, "Total wedges must be 5");
  assert.equal(rig.reflex.freedCount, 5, "Total freed count must be 5");
  assert.equal(rig.loggedWedges.length, 5, "Must have logged 5 avoidance zones in exploreMemory");
  assert.ok(rig.reflex._crumbs.length <= 12, "Crumbs buffer must stay strictly <= 12");
});

await check("Livelock escape trigger: 3 frees within 40m window forces RECALL on 4th wedge", () => {
  const rig = createUnwedgeRig({
    livelockRecall: true,
    livelockFreeThreshold: 3,
    livelockRadiusM: 40,
    livelockWindowMs: 240000,
  });

  // Simulate 3 frees within 40m radius
  const baseWx = worldX(CELL_OUTDOOR, 50);
  const baseWy = worldY(CELL_OUTDOOR, 50);

  for (let i = 0; i < 3; i++) {
    NOW += 5000;
    rig.reflex._freedHistory.push({
      wx: baseWx + i * 2,
      wy: baseWy + i * 2,
      cell: CELL_OUTDOOR,
      at: NOW,
    });
  }

  // Lay 5 breadcrumbs nearby
  for (let i = 0; i < 5; i++) {
    rig.state.pose.x += 1.5;
    rig.tick(500);
  }

  // Trigger 4th wedge in same area
  for (let t = 0; t < 35; t++) rig.tick(100);

  // Must skip retreat and force RECALL immediately!
  assert.equal(rig.reflex.state, "RECALL", "Livelock detector must skip retreat and jump directly to RECALL");
  assert.equal(rig.reflex.livelockRecalls, 1, "livelockRecalls counter must increment");
  const note = rig.journal.find((j) => j.text.includes("LIVELOCK"));
  assert.ok(note, "Must record LIVELOCK note in journal");
});

await check("Escalation suppression: When VTank nav owns the route, RECALL is suppressed cleanly", () => {
  const rig = createUnwedgeRig({
    allowEscalation: () => false, // VTank nav active!
  });

  // Lay 5 crumbs so usable crumbs >= 3.5m exist
  for (let i = 0; i < 5; i++) {
    rig.state.pose.x += 2.0;
    rig.tick(500);
  }

  // Trigger wedge
  for (let t = 0; t < 35; t++) rig.tick(100);
  assert.equal(rig.reflex.state, "RETREAT");

  // Exhaust retreat attempts
  for (let attempt = 0; attempt < 4; attempt++) {
    rig.tick(13000);
  }

  // Escalation must be suppressed cleanly: does NOT enter RECALL, ends FAILED with explanation
  assert.equal(rig.reflex.state, "MONITOR", "Suppressed escalation must return state to MONITOR");
  assert.equal(rig.reflex.recalls, 0, "No recall casts must be attempted");
  assert.ok(rig.reflex.lastResult.why.includes("escalation suppressed"), "Must record escalation suppressed in lastResult");
});

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE 2: Waypoint Runner Edge Cases & Boundary Stress
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== CHALLENGE 2: Waypoint Runner Edge Cases & Boundary Stress ===");

await check("Single-waypoint routes: Linear, Circular, Once, Follow boundary invariants", () => {
  const p1 = normalizePoint({ type: POINT.Point, ew: 10.0, ns: 20.0, z: 0 });

  // 1. Single-point Linear route
  const lin = makeRoute({ routeType: ROUTE.Linear, points: [p1] });
  assert.equal(lin.activeIndex, 0);
  assert.equal(lin.finished, false);
  const linAdv = advance(lin);
  // CS fix U7b H16: Single-point linear finishes and reads empty
  assert.equal(linAdv.finished, true, "Single-point Linear must mark finished=true on advance");
  assert.equal(isEmpty(linAdv), true, "Finished linear route must read empty");

  // 2. Single-point Circular route
  const circ = makeRoute({ routeType: ROUTE.Circular, points: [p1] });
  const circAdv = advance(circ);
  assert.equal(circAdv.activeIndex, 0, "Single-point Circular wraps back to index 0");
  assert.equal(circAdv.finished, false, "Circular route never finishes");

  // 3. Single-point Once route
  const once = makeRoute({ routeType: ROUTE.Once, points: [p1] });
  const onceAdv = advance(once);
  assert.equal(onceAdv.finished, true, "Once route finishes at end");
  assert.equal(onceAdv.points.length, 0, "Once route clears points at end");
  assert.equal(isEmpty(onceAdv), true, "Once route reads empty at end");

  // 4. Follow route
  const flw = makeRoute({ routeType: ROUTE.Follow, followTarget: { guid: 0x12345678, name: "Leader" } });
  assert.equal(isEmpty(flw), false, "Follow route with target is not empty");
  const flwAdv = advance(flw);
  assert.equal(flwAdv.activeIndex, 0, "Follow activeIndex stays 0");
});

await check("skipDense stress: 25 co-located points skipped in single tick; action waypoints preserved", () => {
  // Construct corridor of 25 Point waypoints inside 0.5m of (10E, 20N)
  const pts = [];
  for (let i = 0; i < 25; i++) {
    pts.push({ type: POINT.Point, ew: 10.0 + (i * 0.0001), ns: 20.0, z: 0 });
  }

  // Insert an action waypoint (Pause) at index 10
  pts[10] = { type: POINT.Pause, ew: 10.0, ns: 20.0, z: 0, pauseMs: 2000 };

  const route = makeRoute({ routeType: ROUTE.Circular, points: pts });
  const poseWorld = degToWorld(10.0, 20.0);

  // Run skipDense with arriveM = 1.5m
  const res = skipDense(route, poseWorld, 1.5);

  // It should skip points 0..9 (10 points total) and STOP immediately at Pause (index 10)
  assert.equal(res.skipped, 10, "Must skip exactly 10 co-located Point waypoints");
  assert.equal(res.route.activeIndex, 10, "Active index must stop at Pause action waypoint");
  assert.equal(res.route.points[res.route.activeIndex].type, POINT.Pause, "Action waypoint must NEVER be skipped by skipDense");
});

await check("skipDense circular co-located loop: bounded by route length, never spins in infinite loop", () => {
  // A circular route where EVERY waypoint is co-located Point
  const pts = [
    { type: POINT.Point, ew: 5.0, ns: 5.0, z: 0 },
    { type: POINT.Point, ew: 5.0, ns: 5.0, z: 0 },
    { type: POINT.Point, ew: 5.0, ns: 5.0, z: 0 },
  ];
  const route = makeRoute({ routeType: ROUTE.Circular, points: pts });
  const poseWorld = degToWorld(5.0, 5.0);

  const tStart = performance.now();
  const res = skipDense(route, poseWorld, 2.0);
  const elapsed = performance.now() - tStart;

  assert.ok(elapsed < 50, "skipDense must terminate rapidly");
  assert.equal(res.skipped, 3, "Must skip up to route length budget (3)");
});

await check("Jump waypoint normalization boundary tests (heading, power, direction, holdShift)", () => {
  const cases = [
    // [input, expectedHeading, expectedDelay, expectedDirection, expectedHoldShift]
    [{ type: POINT.Jump, ew: 0, ns: 0, z: 0, headingDeg: 0, delayMs: 500, ext: { direction: "forward" } }, 0, 500, "forward", false],
    [{ type: POINT.Jump, ew: 0, ns: 0, z: 0, headingDeg: 360, delayMs: 1000, ext: { direction: "back" } }, 360, 1000, "back", false],
    [{ type: POINT.Jump, ew: 0, ns: 0, z: 0, headingDeg: 720, delayMs: 1500, ext: { direction: "strafeleft" } }, 720, 1500, "strafeleft", false],
    [{ type: POINT.Jump, ew: 0, ns: 0, z: 0, headingDeg: -90, delayMs: -500, ext: { direction: "invalid_dir" }, holdShift: true }, -90, 0, undefined, true],
    [{ type: POINT.Jump, ew: 0, ns: 0, z: 0, headingDeg: NaN, delayMs: NaN, ext: { direction: "none" } }, 0, 0, "none", false],
  ];

  for (const [raw, expHeading, expDelay, expDir, expShift] of cases) {
    const norm = normalizePoint(raw);
    assert.ok(norm, `normalizePoint must not return null for valid jump`);
    assert.equal(norm.headingDeg, expHeading, `Heading mismatch for ${raw.headingDeg}`);
    assert.equal(norm.delayMs, expDelay, `DelayMs mismatch for ${raw.delayMs}`);
    assert.equal(norm.ext?.direction, expDir, `Direction mismatch for ${raw.ext?.direction}`);
    assert.equal(norm.holdShift, expShift, `HoldShift mismatch`);
  }
});

await check("JumpExecutor lifecycle: normal jump, cancellation/abort, failure, and rebind grace", async () => {
  // Test Mock gotoCompose
  let attempts = 0;
  let shouldFail = false;
  let simulateAbort = false;

  const mockGotoCompose = {
    buildTune: (o) => ({ ...o }),
    attemptJumpLeg: async ({ host, isAborted }, leg, tune) => {
      attempts++;
      if (simulateAbort) {
        return { ok: false, aborted: true };
      }
      if (shouldFail) {
        return { ok: false, error: "stuck on ledge" };
      }
      return { ok: true, power: 0.85 };
    },
  };

  const jumpPt = normalizePoint({
    type: POINT.Jump,
    ew: 1.0,
    ns: 1.0,
    z: 0,
    headingDeg: 90,
    delayMs: 800,
    ext: { direction: "forward" },
  });

  const makeCtx = (mem = {}) => ({
    mem,
    host: {},
    gotoCompose: mockGotoCompose,
    cancelLeg: () => {},
    inPortalSpace: () => false,
  });

  // 1. Normal jump execution
  const ctx1 = makeCtx();
  const ex1 = makeExecutor(jumpPt, ctx1);
  const status1 = ex1.step(NOW);
  assert.equal(status1, "running", "Jump must enter 'running' status while job executes");
  assert.ok(ex1.job, "Jump executor must have active job");

  await ex1.job.promise;
  const status1b = ex1.step(NOW);
  assert.equal(status1b, "done", "Jump must finish 'done' on success");

  // 2. Aborted / Cancelled jump
  simulateAbort = true;
  const ctx2 = makeCtx();
  const ex2 = makeExecutor(jumpPt, ctx2);
  ex2.step(NOW);
  await ex2.job.promise;
  const status2 = ex2.step(NOW);
  assert.equal(status2, "running", "Aborted jump must reset st.job and return running for fresh retry");
  assert.equal(ctx2.mem.startedAt, null, "mem.startedAt must be cleared for retry");

  // 3. Failed jump
  simulateAbort = false;
  shouldFail = true;
  const ctx3 = makeCtx();
  const ex3 = makeExecutor(jumpPt, ctx3);
  ex3.step(NOW);
  await ex3.job.promise;
  const status3 = ex3.step(NOW);
  assert.equal(status3, "failed", "Failed jump must step to 'failed'");
  assert.equal(ex3.failReason, "stuck on ledge");

  // 4. Rebind grace period
  const ctx4 = makeCtx({ startedAt: NOW }); // startedAt already set from previous session
  shouldFail = false;
  const ex4 = makeExecutor(jumpPt, ctx4);
  // Within grace window (12,000ms): returns running
  const status4a = ex4.step(NOW + 2000);
  assert.equal(status4a, "running", "Within jumpRebindGraceMs must return running");
  // Beyond grace window: completes done with warning
  const status4b = ex4.step(NOW + 13000);
  assert.equal(status4b, "done", "Beyond jumpRebindGraceMs must complete done");
  assert.ok(ex4.warning.includes("rebind"), "Must set warning about rebind");
});

console.log(`\nNav & Unwedge Stress Suite Results: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
