// A11-S1 (unification survey 2026-06-11) — headless unit test for the shared
// PhysicsScript executor (`scene3d/script_manager.js`). No THREE / no wasm /
// no browser — `script_manager.js` imports only `time_rng.js` (pure JS).
//
// Run from `apps/holtburger-web/`:
//   node test_script_manager.mjs
//
// Mirrors the check()/assert pattern of test_particles.mjs.

import { ScriptManager } from "./scene3d/script_manager.js";
import { setCurrentTime, setRng } from "./scene3d/particles/time_rng.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}
function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

console.log("ScriptManager (A11-S1) headless tests");

// Deterministic clock — start at t=100s; tests drive `update(now)` explicitly
// so this only governs the default first-script start in addScript.
let clock = 100.0;
setCurrentTime(() => clock);
setRng(() => 0.5);

// --- helper: build a script's entries (each {startTime, marker}) ----------
function entries(...times) {
  return times.map((t, i) => ({ startTime: t, marker: i }));
}

// === Test 1: single script — hooks fire in startTime order at scriptStart+t.
{
  const fired = [];
  const mgr = new ScriptManager({
    executeHook: (e, ctx) => fired.push({ marker: e.marker, scriptDid: ctx.scriptDid }),
  });
  // length = max(startTime) = 2.0; firstScript start = now (100).
  mgr.addScript(0x33000001, entries(0.0, 1.0, 2.0), { now: 100.0 });
  check("T1.queue active after addScript", mgr.active === true);
  // Drive the clock forward in steps; assert nothing fires early.
  mgr.update(100.0); // only t=0 hook is due (>= 100)
  check("T1.first hook fires at scriptStart", fired.length === 1 && fired[0].marker === 0);
  mgr.update(100.5); // nothing new (next hook at 101)
  check("T1.no early fire", fired.length === 1);
  mgr.update(101.0);
  check("T1.second hook at +1s", fired.length === 2 && fired[1].marker === 1);
  mgr.update(102.0);
  check("T1.third hook + exhaustion", fired.length === 3 && fired[2].marker === 2);
  check("T1.scriptDid threaded", fired[0].scriptDid === 0x33000001);
  check("T1.idle after exhaustion", mgr.active === false);
  check("T1.scriptsCompleted == 1", mgr.scriptsCompleted === 1);
  check("T1.hooksFired == 3", mgr.hooksFired === 3);
}

// === Test 2: back-to-back chaining (retail AddScriptInternal).
// Script A: entries at 0 and 0.5 → length 0.5, starts at now=200.
// Script B queued while A playing → starts at A.start + A.length = 200.5.
{
  const fired = [];
  const mgr = new ScriptManager({
    executeHook: (e) => fired.push({ s: e.scriptTag, t: e.startTime }),
  });
  const A = entries(0.0, 0.5).map((e) => ({ ...e, scriptTag: "A" }));
  const B = entries(0.0, 0.25).map((e) => ({ ...e, scriptTag: "B" }));
  const dataA = mgr.addScript(0x330000AA, A, { now: 200.0 });
  const dataB = mgr.addScript(0x330000BB, B);
  check("T2.A.start == now", approx(dataA.startTime, 200.0));
  check("T2.A.length == 0.5 (max entry time)", approx(dataA.length, 0.5));
  check("T2.B.start == A.start + A.length (back-to-back)", approx(dataB.startTime, 200.5),
    `got ${dataB.startTime}`);
  // Advance past everything.
  mgr.update(199.9);
  check("T2.nothing before A.start", fired.length === 0);
  mgr.update(200.0);
  check("T2.A[0] fires at 200", fired.length === 1 && fired[0].s === "A");
  mgr.update(200.49);
  check("T2.A[1] not yet (due 200.5)", fired.length === 1);
  mgr.update(200.5);
  // At 200.5 both A[1] (200.5) and B[0] (200.5) are due — A drains first, then B starts.
  check("T2.A[1] then B[0] both at 200.5", fired.length === 3
    && fired[1].s === "A" && fired[2].s === "B", `fired=${JSON.stringify(fired.map(f=>f.s))}`);
  mgr.update(200.75);
  check("T2.B[1] at 200.75", fired.length === 4 && fired[3].s === "B");
  check("T2.both scripts completed", mgr.scriptsCompleted === 2);
  check("T2.idle", mgr.active === false);
}

// === Test 3: every due hook fires in one update (catch-up).
{
  const fired = [];
  const mgr = new ScriptManager({ executeHook: (e) => fired.push(e.marker) });
  mgr.addScript(0x33000003, entries(0.0, 1.0, 2.0, 3.0), { now: 10.0 });
  mgr.update(100.0); // way past — all 4 due at once
  check("T3.catch-up fires all 4 in one update", fired.length === 4
    && fired.join(",") === "0,1,2,3");
  check("T3.idle after catch-up", mgr.active === false);
}

// === Test 4: explicit length overrides derived length (future wasm `length`).
{
  const mgr = new ScriptManager({ executeHook: () => {} });
  const a = mgr.addScript(0x33000004, entries(0.0, 0.5), { now: 0.0, length: 5.0 });
  const b = mgr.addScript(0x33000005, entries(0.0), {});
  check("T4.explicit length honored", approx(a.length, 5.0));
  check("T4.next chains off explicit length", approx(b.startTime, 5.0), `got ${b.startTime}`);
}

// === Test 5: executor may be installed late via setExecutor.
{
  const fired = [];
  const mgr = new ScriptManager();
  mgr.addScript(0x33000006, entries(0.0), { now: 0.0 });
  mgr.update(0.0); // no executor yet — hook should still drain (no throw)
  check("T5.drains without executor (no throw)", mgr.hooksFired === 1 && fired.length === 0);
  // A fresh manager with the executor set after construction:
  const mgr2 = new ScriptManager();
  mgr2.setExecutor((e) => fired.push(e.marker));
  mgr2.addScript(0x33000007, entries(0.0), { now: 0.0 });
  mgr2.update(0.0);
  check("T5.late executor fires", fired.length === 1 && fired[0] === 0);
}

// === Test 6: clear() drops queued + current.
{
  const fired = [];
  const mgr = new ScriptManager({ executeHook: (e) => fired.push(e.marker) });
  mgr.addScript(0x33000008, entries(0.0, 1.0), { now: 0.0 });
  mgr.addScript(0x33000009, entries(0.0), {});
  check("T6.active before clear", mgr.active === true);
  mgr.clear();
  check("T6.idle after clear", mgr.active === false);
  mgr.update(1000.0);
  check("T6.no hooks fire after clear", fired.length === 0);
}

// === Test 7: a throwing executor never breaks the queue clock.
{
  let calls = 0;
  const mgr = new ScriptManager({
    executeHook: () => { calls += 1; throw new Error("boom"); },
  });
  mgr.addScript(0x3300000A, entries(0.0, 1.0), { now: 0.0 });
  mgr.update(5.0); // both due; both throw
  check("T7.both hooks attempted despite throw", calls === 2);
  check("T7.queue still drains to idle", mgr.active === false);
}

// restore global hooks
setCurrentTime(null);
setRng(null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
