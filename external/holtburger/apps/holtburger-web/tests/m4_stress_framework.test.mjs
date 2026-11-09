// tests/m4_stress_framework.test.mjs — Milestone 4 Challenger Adversarial Stress Test
// Component: FrameWorkScheduler (scene3d/frame_work.js)
//
// OBJECTIVES:
//   1. Simulate rapid alternating frames with high frame times (>30ms) and low frame times (<5ms).
//   2. Test adaptive floor (3ms) and micro-slicing (4ms) under pathological pacing.
//   3. Verify queue bounds, starvation limits (maxDeferFrames = 3), and no memory leaks.
//   4. Challenge edge cases: NaN/negative frameStartMs, targetPeriodMs <= 0, item throws, rapid teleports.
//
// Run: node --max-old-space-size=256 tests/m4_stress_framework.test.mjs

import assert from "node:assert/strict";
import { FrameWorkScheduler, WORK_CLASSES } from "../scene3d/frame_work.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${name} ${detail}`);
  }
}

function mockClock(t0 = 1000) {
  let t = t0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

console.log("=== M4 STRESS TEST 1: FrameWorkScheduler Adversarial Pacing ===");

// ── Test 1.1: Rapid Alternating Frame Overruns (2,000 frames) ─────────────────
{
  const clock = mockClock(1000);
  const sched = new FrameWorkScheduler({
    now: clock.now,
    isInWorld: () => true,
    budgetMs: 6,
    crossingBudgetMs: 12,
    minBudgetMs: 2,
    maxDeferFrames: 3,
    maxForceSliceMs: 4,
    maxForcePerFrame: 2,
    shrink: true,
    adaptiveCrossing: true,
  });

  const targetPeriodMs = 16.67;
  let totalEnqueued = 0;
  let totalExecuted = 0;
  const executionLog = [];
  const maxQueueDepths = { W1: 0, W2: 0, W3: 0, W4: 0, W5: 0, W6: 0 };

  // Run 2,000 alternating frames:
  // Even frames: 35-45ms frame overrun (heavy frame)
  // Odd frames: 3-5ms light frame
  for (let frame = 0; frame < 2000; frame++) {
    const isHeavy = (frame % 2 === 0);
    const prevWorkElapsed = isHeavy ? 38.0 : 4.0;
    const frameStartMs = clock.now() - prevWorkElapsed;

    // Enqueue 2 items per frame across classes
    for (const cls of ["W1", "W3", "W6"]) {
      const id = ++totalEnqueued;
      sched.enqueue(cls, {
        kind: `task-${id}`,
        fn: () => {
          totalExecuted += 1;
          clock.advance(1.2); // Each task takes 1.2ms of clock time
        },
      });
    }

    const hadStarvingBefore = sched._rows.W3.deferredFrames > 0 || sched._rows.W6.deferredFrames > 0;

    sched.run({ frameStartMs, targetPeriodMs });

    // Track queue depths
    for (const cls of WORK_CLASSES) {
      const qLen = sched._queues[cls].length;
      if (qLen > maxQueueDepths[cls]) maxQueueDepths[cls] = qLen;
    }

    // On heavy frames, verify adaptive floor is honored if stream work was deferred
    if (isHeavy && hadStarvingBefore) {
      assert(sched.lastBudgetMs >= 3, `Expected adaptive floor >= 3ms, got ${sched.lastBudgetMs}`);
    }

    // Step clock forward for next frame
    clock.advance(isHeavy ? 38.0 : 4.0);
  }

  // Drain remaining items with standard frames to verify clean resolution
  for (let drainFrame = 0; drainFrame < 1000 && sched.hasPending(); drainFrame++) {
    sched.run({ frameStartMs: clock.now() - 5.0, targetPeriodMs });
    clock.advance(16.67);
  }

  check("All enqueued items executed eventually (no queue starvation)", totalExecuted === totalEnqueued,
    `Executed ${totalExecuted} / ${totalEnqueued}`);
  check("Queue depth remained bounded under pathological alternation",
    maxQueueDepths.W1 <= 10 && maxQueueDepths.W3 <= 25 && maxQueueDepths.W6 <= 25,
    `Max depths: W1=${maxQueueDepths.W1}, W3=${maxQueueDepths.W3}, W6=${maxQueueDepths.W6}`);
  check("No residual items left in queues after drain", !sched.hasPending());
}

// ── Test 1.2: Staleness Ceiling & Micro-Slicing Bounds ─────────────────────────
{
  const clock = mockClock(2000);
  const sched = new FrameWorkScheduler({
    now: clock.now,
    isInWorld: () => true,
    budgetMs: 6,
    minBudgetMs: 2,
    maxDeferFrames: 3,
    maxForceSliceMs: 4,
    maxForcePerFrame: 2,
    shrink: true,
  });

  // Starve all 6 classes by setting budget to 0 on frame 0, 1, 2
  for (const cls of WORK_CLASSES) {
    sched.enqueue(cls, {
      kind: `starved-${cls}`,
      fn: () => { clock.advance(1.0); },
    });
  }

  // Frame 0, 1, 2: huge overage => budget shrunk to floor, but W1 consumes entire budget
  sched.run({ frameStartMs: clock.now() - 50, targetPeriodMs: 16.67 }); // frame 1
  clock.advance(16.67);
  sched.run({ frameStartMs: clock.now() - 50, targetPeriodMs: 16.67 }); // frame 2
  clock.advance(16.67);
  sched.run({ frameStartMs: clock.now() - 50, targetPeriodMs: 16.67 }); // frame 3

  // At frame 4, oldest items have waited >= 3 frames.
  // Verify that maxForcePerFrame = 2 limits force-runs to at most 2 classes this frame!
  let forcedThisFrame = 0;
  const initialRan = Object.fromEntries(WORK_CLASSES.map(c => [c, sched._rows[c].ran]));

  sched.run({ frameStartMs: clock.now() - 50, targetPeriodMs: 16.67 }); // frame 4

  for (const cls of WORK_CLASSES) {
    if (sched._rows[cls].itemsThisFrame > 0 && sched._rows[cls].forcedRuns > 0) {
      forcedThisFrame += 1;
    }
  }

  check("maxForcePerFrame clamps simultaneous force-runs to <= 2 per frame",
    forcedThisFrame <= 2,
    `got ${forcedThisFrame} forced classes`);

  // Run next frames to ensure remaining starved classes get their turn without dropping
  clock.advance(16.67);
  sched.run({ frameStartMs: clock.now() - 50, targetPeriodMs: 16.67 }); // frame 5
  clock.advance(16.67);
  sched.run({ frameStartMs: clock.now() - 50, targetPeriodMs: 16.67 }); // frame 6

  let allStarvedRan = WORK_CLASSES.every(cls => sched._rows[cls].ran >= 1);
  check("All starved classes successfully execute across staggered frames", allStarvedRan);
}

// ── Test 1.3: Continuous 100% Extreme Overrun (500 frames) ───────────────────
{
  const clock = mockClock(5000);
  const sched = new FrameWorkScheduler({
    now: clock.now,
    isInWorld: () => true,
    budgetMs: 6,
    minBudgetMs: 2,
    maxDeferFrames: 3,
    shrink: true,
  });

  let w3Ran = 0;
  let w6Ran = 0;

  for (let f = 0; f < 500; f++) {
    const hadStarvingBefore = sched._rows.W3.deferredFrames > 0 || sched._rows.W6.deferredFrames > 0;
    sched.enqueue("W3", { kind: "terrain", fn: () => { w3Ran++; clock.advance(1.5); } });
    sched.enqueue("W6", { kind: "static", fn: () => { w6Ran++; clock.advance(1.5); } });

    // Extreme 100ms overrun every single frame
    sched.run({ frameStartMs: clock.now() - 100, targetPeriodMs: 16.67 });
    clock.advance(100);

    // Adaptive floor must maintain at least 3ms under stream starvation
    if (hadStarvingBefore) {
      assert(sched.lastBudgetMs >= 3, `Expected floor >= 3ms, got ${sched.lastBudgetMs}`);
    }
  }

  check("Adaptive 3ms floor sustains forward streaming progress under 100% extreme overrun",
    w3Ran > 200 && w6Ran > 200,
    `w3Ran=${w3Ran}, w6Ran=${w6Ran}`);
}

// ── Test 1.4: Error Isolation & Hostile Task Injections ────────────────────────
{
  const clock = mockClock(10000);
  const sched = new FrameWorkScheduler({
    now: clock.now,
    isInWorld: () => true,
  });

  let canaryExecuted = false;

  // Enqueue throwing tasks in W1, W3, W6
  sched.enqueue("W1", { kind: "exploder-1", fn: () => { throw new Error("Poison Pill W1"); } });
  sched.enqueue("W3", { kind: "exploder-3", fn: () => { throw new TypeError("Poison Pill W3"); } });
  sched.enqueue("W6", { kind: "canary", fn: () => { canaryExecuted = true; } });

  // Run slot
  assert.doesNotThrow(() => {
    sched.run();
  }, "Scheduler must not crash when queued tasks throw");

  check("Scheduler survives hostile throws and serves subsequent tasks", canaryExecuted);
}

// ── Test 1.5: Clock Discontinuities & Pathological Opts ────────────────────────
{
  const clock = mockClock(20000);
  const sched = new FrameWorkScheduler({ now: clock.now, isInWorld: () => true });

  let ranCount = 0;
  sched.enqueue("W1", { kind: "t", fn: () => ranCount++ });

  // Pathological options
  const pathologicalCases = [
    { frameStartMs: NaN, targetPeriodMs: 16.67 },
    { frameStartMs: -99999, targetPeriodMs: 16.67 },
    { frameStartMs: Infinity, targetPeriodMs: 16.67 },
    { frameStartMs: clock.now(), targetPeriodMs: NaN },
    { frameStartMs: clock.now(), targetPeriodMs: -50 },
    { frameStartMs: clock.now(), targetPeriodMs: 0 },
    {},
    null,
  ];

  for (const opts of pathologicalCases) {
    sched.enqueue("W1", { kind: "t", fn: () => ranCount++ });
    assert.doesNotThrow(() => {
      sched.run(opts || undefined);
    }, `Must not throw on pathological opts: ${JSON.stringify(opts)}`);
    assert(Number.isFinite(sched.lastBudgetMs) && sched.lastBudgetMs >= 0,
      `lastBudgetMs must be non-negative finite, got ${sched.lastBudgetMs}`);
  }

  check("Scheduler handles NaN, Infinity, negative clock values robustly", ranCount > 0);
}

// ── Test 1.6: Rapid Alternating Teleport vs Walk Crossing ──────────────────────
{
  const clock = mockClock(30000);
  const sched = new FrameWorkScheduler({
    now: clock.now,
    isInWorld: () => true,
    adaptiveCrossing: true,
  });

  const lbOrigin = 0x12340000;
  const lbWalk1 = 0x12350000;   // dist 1 (walk crossing)
  const lbTeleport = 0x1a350000; // dist 8 (teleport discontinuity)

  sched.noteLbKey(lbOrigin);

  // Walk step
  sched.noteLbKey(lbWalk1);
  sched.enqueue("W3", { kind: "w", fn: () => {} });
  // Light frame (< 0.8 * targetPeriod)
  sched.run({ frameStartMs: clock.now() - 5, targetPeriodMs: 16.67 });
  check("Walk crossing arms CROSSING mode with 12ms budget",
    sched.mode === "CROSSING" && sched.lastBudgetMs === 12);

  // Teleport jump
  sched.noteLbKey(lbTeleport);
  sched.run({ frameStartMs: clock.now() - 5, targetPeriodMs: 16.67 });
  check("Teleport jump triggers TELEPORT one-shot (250ms budget)",
    sched.mode === "TELEPORT" && sched.lastBudgetMs === 250);

  // Next frame: TELEPORT consumed, returns to NORMAL or CROSSING
  sched.run({ frameStartMs: clock.now() - 5, targetPeriodMs: 16.67 });
  check("TELEPORT one-shot is consumed on single frame", sched.mode !== "TELEPORT");
}

console.log(`\nFrameWorkScheduler Stress Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
