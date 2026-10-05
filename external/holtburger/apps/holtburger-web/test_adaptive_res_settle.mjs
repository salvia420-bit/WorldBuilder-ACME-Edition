// adaptiveResSettle (2026-07-28) — oscillation damper for the adaptive
// render-scale controller. Models the reported R9 290 @ 4K failure: frame
// time as a function of scale JUMPS ACROSS the stable band
// [targetLowMs, targetHighMs] — ~17 ms (vsync-locked) at/below a threshold
// scale, ~80 ms above it — so no scale ever lands inside the band and the
// undamped controller raises/lowers forever ("screen resolution keeps
// changing"). Asserts:
//   1. settle:false reproduces the endless churn (sanity — the bug exists).
//   2. settle:true latches after the flip-flop, holds the sustainable
//      (lower) scale, and stops changing for the lock window.
//   3. Lowering is still allowed while latched (safety valve).
//   4. settleLatches reachability counter increments.
//   5. (2026-10-05) the SAWTOOTH churn — frame time lags the scale change, so
//      the controller overshoots both ways (up×4, down×3, …) and the changes
//      never strictly alternate. The first damper (strict-alternation latch)
//      never fired on it; the failed-raise ceiling must.
import { AdaptiveRenderScaleController } from "./scene3d/adaptive_render_scale.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// Simulated GPU: threshold response. At or below `goodScale` the GPU holds
// vsync (17 ms); above it, it drops frames (80 ms). Optional `crushMs`
// models a mid-session load spike that is slow at EVERY scale.
// `lagMs` models the live sawtooth: the GPU's frame time follows the scale it
// had `lagMs` ago (render-target rebuild + shader warm-up after each resize).
function runSim({ settle, minutes = 10, goodScale = 0.6, crushAfterMin = null, lagMs = 0 }) {
  let clock = 0;
  let scale = 0.35; // the smart-default start on a 4K/200% display
  const applied = [];
  const scaleAt = (t) => {
    let s = 0.35;
    for (const a of applied) { if (a.t <= t) s = a.s; else break; }
    return s;
  };
  const c = new AdaptiveRenderScaleController({
    getScale: () => scale,
    applyScale: (s) => { scale = s; applied.push({ t: clock, s }); },
    minScale: 0.35,
    maxScale: 1,
    settle,
    now: () => clock,
    log: null,
  });
  const endMs = minutes * 60_000;
  while (clock < endMs) {
    const crushed = crushAfterMin != null && clock > crushAfterMin * 60_000;
    const seen = lagMs ? scaleAt(clock - lagMs) : scale;
    const dt = crushed ? 80 : (seen <= goodScale + 1e-9 ? 17 : 80);
    clock += dt;
    c.recordFrame();
  }
  return { c, scale, applied };
}

// 1. Undamped: churns forever (the live report).
let undampedChanges = 0;
{
  const { c, applied } = runSim({ settle: false, minutes: 10 });
  undampedChanges = c.changes;
  const last3min = applied.filter((a) => a.t > 7 * 60_000);
  check("undamped controller keeps churning (>=10 changes in 10min)", c.changes >= 10,
    `changes=${c.changes}`);
  check("undamped churn persists into the last 3 minutes", last3min.length >= 3,
    `late changes=${last3min.length}`);
  check("undamped never settles (still flip-flopping at end)",
    applied.length >= 2 &&
    applied[applied.length - 1].s !== applied[applied.length - 2].s, "");
}

// 2. Damped: latches, snaps to the sustainable scale, then goes quiet.
{
  const { c, scale, applied } = runSim({ settle: true, minutes: 10 });
  check("damped controller latched at least once", c.settleLatches >= 1,
    `latches=${c.settleLatches}`);
  check("damped final scale is the sustainable (lower) side", scale <= 0.6 + 1e-9,
    `scale=${scale}`);
  const lastLatchT = applied.length ? applied[applied.length - 1].t : 0;
  const quietMin = (10 * 60_000 - lastLatchT) / 60_000;
  check("damped goes quiet for the rest of the run (>=3min without changes)",
    quietMin >= 3, `quiet=${quietMin.toFixed(1)}min`);
  // The 5-min lock can expire once inside a 10-min run (one extra latch
  // cycle is by design), so compare against the undamped run directly.
  check("damped total changes well below undamped (<=15%)",
    c.changes <= Math.max(12, undampedChanges * 0.15),
    `damped=${c.changes} undamped=${undampedChanges}`);
}

// 3. Latched controller still lowers under a real load spike.
{
  const { scale } = runSim({ settle: true, minutes: 10, crushAfterMin: 6 });
  check("latch does not block emergency lowering (ends at minScale)",
    scale <= 0.35 + 1e-9, `scale=${scale}`);
}

// 4. A healthy GPU (every scale inside/below budget) never latches.
{
  let clock = 0;
  let scale = 0.5;
  const c = new AdaptiveRenderScaleController({
    getScale: () => scale,
    applyScale: (s) => { scale = s; },
    minScale: 0.35, maxScale: 1, settle: true,
    now: () => clock, log: null,
  });
  while (clock < 5 * 60_000) { clock += 17; c.recordFrame(); }
  check("healthy GPU ramps to maxScale without latching",
    scale === 1 && c.settleLatches === 0, `scale=${scale} latches=${c.settleLatches}`);
}

// 5. The live sawtooth (2026-10-05): lagged frame time → runs of ups then runs
//    of downs, never a strict up/down alternation.
{
  const und = runSim({ settle: false, minutes: 10, lagMs: 5000 });
  const dirs = [];
  for (let i = 1; i < und.applied.length; i++) {
    dirs.push(und.applied[i].s > und.applied[i - 1].s ? "u" : "d");
  }
  check("lagged model reproduces the sawtooth (consecutive same-direction runs)",
    /uu/.test(dirs.join("")) && /dd/.test(dirs.join("")), dirs.join(""));
  check("undamped sawtooth churns all session (>=20 changes in 10min)",
    und.c.changes >= 20, `changes=${und.c.changes}`);
  const { c, scale, applied } = runSim({ settle: true, minutes: 10, lagMs: 5000 });
  check("damped sawtooth latched", c.settleLatches >= 1, `latches=${c.settleLatches}`);
  const late = applied.filter((a) => a.t > 2 * 60_000 && a.t < 5 * 60_000);
  check("damped sawtooth is quiet between minute 2 and the lock expiry",
    late.length === 0, `changes=${late.map((a) => a.s).join(",")}`);
  check("damped sawtooth total changes well below undamped (<=25%)",
    c.changes <= und.c.changes * 0.25, `damped=${c.changes} undamped=${und.c.changes}`);
  check("damped sawtooth ends on the sustainable side", scale <= 0.6 + 1e-9, `scale=${scale}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
