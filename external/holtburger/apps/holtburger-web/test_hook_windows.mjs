// A5-P1a (2026-06-12, W3+ S5) — headless table tests for the pure
// hook-window planner (`scene3d/hook_windows.js`). No THREE / no wasm /
// no browser.
//
// Run from `apps/holtburger-web/`:
//   node test_hook_windows.mjs
//
// Mirrors the check() pattern of test_script_manager.mjs.

import { planHookWindows } from "./scene3d/hook_windows.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}
function eqWindows(a, b) {
  return (
    a.length === b.length &&
    a.every((w, i) => w[0] === b[i][0] && w[1] === b[i][1])
  );
}

console.log("planHookWindows (A5-P1a) headless tests");

// === Monotonic advance (running) — the legacy common case ================
{
  const r = planHookWindows({
    lastTime: 0.2, currentTime: 0.5, clipDuration: 1.0,
    isRunning: true, isLoopOnce: true,
  });
  check("monotonic advance: one (last, current] window",
    eqWindows(r.windows, [[0.2, 0.5]]) && r.drainedTo === null && !r.finished,
    JSON.stringify(r));
}

// === LoopRepeat wrap — two windows, legacy shape ==========================
{
  const r = planHookWindows({
    lastTime: 0.8, currentTime: 0.1, clipDuration: 1.0,
    isRunning: true, isLoopOnce: false,
  });
  check("LoopRepeat wrap: (last, dur] then (-Inf, current]",
    eqWindows(r.windows, [[0.8, 1.0], [-Infinity, 0.1]]) &&
      r.drainedTo === null && !r.finished,
    JSON.stringify(r));
}

// === Finish-drain: LoopOnce finished between two rAFs =====================
{
  const r = planHookWindows({
    lastTime: 0.7, currentTime: 0.0, clipDuration: 1.0,
    isRunning: false, isLoopOnce: true,
  });
  check("finish-drain: trailing (last, dur] window fires",
    eqWindows(r.windows, [[0.7, 1.0]]),
    JSON.stringify(r.windows));
  check("finish-drain: drainedTo = clipDuration", r.drainedTo === 1.0);
  check("finish-drain: finished flagged (animDone record point)", r.finished === true);

  // Second call with drainedTo applied → zero windows, no re-fire, no
  // second animDone (exactly-once).
  const r2 = planHookWindows({
    lastTime: r.drainedTo, currentTime: 0.0, clipDuration: 1.0,
    isRunning: false, isLoopOnce: true,
  });
  check("finish-drain fires exactly ONCE (second call drained)",
    r2.windows.length === 0 && r2.drainedTo === null && !r2.finished,
    JSON.stringify(r2));
}

// === Replay re-arm: lastTime reset to 0 → full range fires again ==========
{
  // `_tryPlayLink` resets actionLastHookTime to 0 on every play(); a
  // running replay then advances normally and a finish drains again.
  const run = planHookWindows({
    lastTime: 0, currentTime: 0.4, clipDuration: 1.0,
    isRunning: true, isLoopOnce: true,
  });
  check("replay re-arm: running replay fires (0, current]",
    eqWindows(run.windows, [[0, 0.4]]) && !run.finished);
  const fin = planHookWindows({
    lastTime: 0.4, currentTime: 0.0, clipDuration: 1.0,
    isRunning: false, isLoopOnce: true,
  });
  check("replay re-arm: replay finish drains (0.4, 1.0] + finished",
    eqWindows(fin.windows, [[0.4, 1.0]]) && fin.finished && fin.drainedTo === 1.0);
}

// === Stopped non-LoopOnce: legacy semantics, nothing fires ================
{
  const r = planHookWindows({
    lastTime: 0.3, currentTime: 0.3, clipDuration: 1.0,
    isRunning: false, isLoopOnce: false,
  });
  check("stopped LoopRepeat: no windows, no finish",
    r.windows.length === 0 && r.drainedTo === null && !r.finished);
}

// === Zero-duration clip → no windows ======================================
{
  const r = planHookWindows({
    lastTime: 0, currentTime: 0, clipDuration: 0,
    isRunning: true, isLoopOnce: true,
  });
  check("zero-duration clip: no windows",
    r.windows.length === 0 && r.drainedTo === null && !r.finished);
}

// === Non-finite inputs are coerced, not thrown ============================
{
  const r = planHookWindows({
    lastTime: NaN, currentTime: 0.2, clipDuration: 1.0,
    isRunning: true, isLoopOnce: true,
  });
  check("NaN lastTime coerces to 0",
    eqWindows(r.windows, [[0, 0.2]]),
    JSON.stringify(r.windows));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
