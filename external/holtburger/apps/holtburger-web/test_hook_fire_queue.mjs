// A5-P1b (2026-06-12, W3+ S5) — order assertions on a synthetic per-entity
// hook-fire queue, mirroring the drain contract `entities.js` implements
// under `?hookDrain=on`:
//   1. trailing hook records fire BEFORE the `animDone` record for the
//      same overlay (retail: crossed-frame execute_hooks before the queued
//      anim_done_hook, acclient.c:340725 → :340764-340774);
//   2. the drain runs once per entity tick AFTER a marker representing
//      pose application (process_hooks-after-position-resolve,
//      acclient.c:320030-320035);
//   3. a thrown hook does not drop the rest of the queue.
//
// The queue/drain logic here is a faithful miniature of the entities.js
// tick-body block (per-record try/catch, FIFO, swap-then-drain) driven by
// the REAL planner (`hook_windows.js`) so the record interleave is the
// shipped one, not a re-implementation of the math.
//
// Run from `apps/holtburger-web/`:
//   node test_hook_fire_queue.mjs

import { planHookWindows } from "./scene3d/hook_windows.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

console.log("hook-fire queue drain (A5-P1b) headless tests");

// --- miniature of the entities.js flag-path executor ----------------------
// One "instance" with a timeline + lastHookTime; tick() plans windows,
// queues records, then drains after the pose marker — same order of
// operations as the shipped per-instance tick body.
function makeInst(timeline) {
  return {
    timeline: timeline.slice().sort((a, b) => a.time - b.time),
    lastHookTime: 0,
    queue: [],
    log: [],
  };
}
function queueHooksInRange(inst, lowExclusive, highInclusive) {
  for (const h of inst.timeline) {
    if (h.time <= lowExclusive) continue;
    if (h.time > highInclusive) break;
    inst.queue.push({ kind: "hook", hook: h });
  }
}
function tick(inst, { currentTime, clipDuration, isRunning, isLoopOnce }, fireHook) {
  // 1. plan + queue (the _tickAnimationHooks flag path).
  const plan = planHookWindows({
    lastTime: inst.lastHookTime,
    currentTime,
    clipDuration,
    isRunning,
    isLoopOnce,
  });
  for (const w of plan.windows) queueHooksInRange(inst, w[0], w[1]);
  if (plan.finished) inst.queue.push({ kind: "animDone", key: "link:test" });
  if (isRunning) inst.lastHookTime = currentTime;
  else if (plan.drainedTo !== null) inst.lastHookTime = plan.drainedTo;
  // 2. pose application marker (tweens/omega/material in the real body).
  inst.log.push("pose-applied");
  // 3. drain — FIFO, per-record try/catch (the end-of-tick block).
  const q = inst.queue;
  inst.queue = [];
  for (const rec of q) {
    try {
      if (rec.kind === "hook") fireHook(inst, rec.hook);
      else if (rec.kind === "animDone") inst.log.push("animDone");
    } catch (_) {
      // a thrown hook must not drop the rest of the queue
    }
  }
}

// === 1. trailing hooks fire BEFORE animDone, both AFTER pose ==============
{
  const inst = makeInst([
    { time: 0.5, id: "mid" },
    { time: 0.95, id: "trailing" },
  ]);
  // Tick A: running, advance to 0.6 — fires "mid" only.
  tick(inst, { currentTime: 0.6, clipDuration: 1.0, isRunning: true, isLoopOnce: true },
    (i, h) => i.log.push(`hook:${h.id}`));
  // Tick B: the LoopOnce finished between rAFs — trailing hook then animDone.
  tick(inst, { currentTime: 0.0, clipDuration: 1.0, isRunning: false, isLoopOnce: true },
    (i, h) => i.log.push(`hook:${h.id}`));
  check("interleave order: pose → mid → pose → trailing → animDone",
    inst.log.join(",") ===
      "pose-applied,hook:mid,pose-applied,hook:trailing,animDone",
    inst.log.join(","));
}

// === 2. drain runs once per tick, after the pose marker ===================
{
  const inst = makeInst([{ time: 0.1, id: "a" }]);
  tick(inst, { currentTime: 0.2, clipDuration: 1.0, isRunning: true, isLoopOnce: true },
    (i, h) => i.log.push(`hook:${h.id}`));
  check("hook fires AFTER the pose marker in its own tick",
    inst.log.join(",") === "pose-applied,hook:a", inst.log.join(","));
  // Next tick with no new window: nothing re-fires (queue was swapped out).
  tick(inst, { currentTime: 0.2, clipDuration: 1.0, isRunning: true, isLoopOnce: true },
    (i, h) => i.log.push(`hook:${h.id}`));
  check("queue drains exactly once (no re-fire next tick)",
    inst.log.join(",") === "pose-applied,hook:a,pose-applied", inst.log.join(","));
}

// === 3. a thrown hook does not drop the rest of the queue =================
{
  const inst = makeInst([
    { time: 0.3, id: "boom" },
    { time: 0.6, id: "after-boom" },
  ]);
  tick(inst, { currentTime: 0.0, clipDuration: 1.0, isRunning: false, isLoopOnce: true },
    (i, h) => {
      if (h.id === "boom") throw new Error("hook threw");
      i.log.push(`hook:${h.id}`);
    });
  check("throw in hook #1 still fires hook #2 + animDone",
    inst.log.join(",") === "pose-applied,hook:after-boom,animDone",
    inst.log.join(","));
}

// === 4. completion exactly once under repeated stopped ticks ==============
{
  const inst = makeInst([]);
  for (let i = 0; i < 3; i += 1) {
    tick(inst, { currentTime: 0.0, clipDuration: 1.0, isRunning: false, isLoopOnce: true },
      () => {});
  }
  check("animDone queued exactly once across repeated stopped ticks",
    inst.log.filter((x) => x === "animDone").length === 1,
    inst.log.join(","));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
