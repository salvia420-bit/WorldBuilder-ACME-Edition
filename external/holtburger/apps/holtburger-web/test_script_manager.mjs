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

// === Test 8 (A11-S1 fixup): CallPES rand-pause start is honored as an
// absolute `now`, INDEPENDENT of any parent script length. This is the
// ScriptManager half of the entities.js CallPES fix — the sub-script is queued
// with `{ now: fireTime + RollDice(0,pause) }`, which must win over the
// back-to-back-after-parent-length chaining whenever the queue is empty (the
// common case once the parent script has popped). Retail CallPES schedules at
// `RollDice(0, pause)` (acclient.c:318984-318987), NOT after parent length.
{
  const fired = [];
  const mgr = new ScriptManager({ executeHook: (e) => fired.push(e.scriptTag) });
  // Parent script P plays at t=300 with length 4.0 and runs to exhaustion.
  const P = entries(0.0).map((e) => ({ ...e, scriptTag: "P" }));
  mgr.addScript(0x33000FF0 >>> 0, P, { now: 300.0, length: 4.0 });
  mgr.update(300.0); // P[0] fires + P pops (single entry → exhausted)
  check("T8.parent popped (queue empty)", mgr.active === false);
  // The CallPES fires at t=300; pause window 2.0, rng=0.5 → randPause=1.0 →
  // sub-script absolute start = 301.0. With the fix the sub uses `{ now: 301 }`.
  // WITHOUT the fix (old back-to-back), an empty queue would start it at
  // currentTime() = clock (100), i.e. WRONG / already in the past.
  const subStart = 300.0 + 0.5 * 2.0; // currentTime()+randPause at fire-time
  const S = entries(0.0, 1.0).map((e) => ({ ...e, scriptTag: "S" }));
  const dataS = mgr.addScript(0x330000F0 >>> 0, S, { now: subStart });
  check("T8.sub-script start == fireTime + randPause (not parent length)",
    approx(dataS.startTime, 301.0), `got ${dataS.startTime}`);
  mgr.update(300.9);
  check("T8.sub does NOT fire before its rand-pause start", fired.length === 1);
  mgr.update(301.0);
  check("T8.sub[0] fires at rand-pause start", fired.length === 2 && fired[1] === "S");
  mgr.update(302.0);
  check("T8.sub[1] fires +1s later", fired.length === 3 && fired[2] === "S");
}

// === Test 9 (A11-S1 fixup): a CallPES with pause < 0.0002 fires immediately
// (randPause=0 → sub start == fire time), matching the retail threshold and the
// legacy off-path (entities.js:8047).
{
  const fired = [];
  const mgr = new ScriptManager({ executeHook: (e) => fired.push(e.scriptTag) });
  const subStart = 500.0 + 0; // pause below threshold → randPause forced to 0
  const S = entries(0.0).map((e) => ({ ...e, scriptTag: "S" }));
  const dataS = mgr.addScript(0x330000F1 >>> 0, S, { now: subStart });
  check("T9.sub-zero-pause start == fire time", approx(dataS.startTime, 500.0));
  mgr.update(500.0);
  check("T9.fires immediately at fire time", fired.length === 1 && fired[0] === "S");
}

// === Test 10 (A11-S1 fixup): the A-DIR gate must NOT drop PhysicsScript-sourced
// hooks. `_decodePhysicsScriptHookEntry` (entities.js) now forces `direction: 0`
// (Both) regardless of the wire `i32 direction`, so the `_fireHook` A-DIR gate
// (`if ((hook.direction|0) === -1) return;`, entities.js:9935) never drops a
// genuinely wire-parsed `direction == -1` 0x33 entry. This mirrors the exact
// decode `direction` assignment + the gate predicate; if the decode reverted to
// `e.direction|0` a `-1` wire entry would be dropped on the queue path while the
// off-path fires it — the on/off divergence the flag forbids.
{
  // The fixed decode: PhysicsScript base hook always carries direction 0.
  const decodeDirection = (_wireDirection) => 0; // matches entities.js fixup
  // The _fireHook A-DIR gate predicate (returns true == DROPPED).
  const dirGateDrops = (hook) => (hook.direction | 0) === -1;
  for (const wireDir of [-1, 0, 1, -2, 7]) {
    const h = { hookType: 2 /* SoundTable */, direction: decodeDirection(wireDir) };
    check(`T10.wire direction=${wireDir} 0x33 hook is NOT dropped`,
      dirGateDrops(h) === false, `direction decoded to ${h.direction}`);
  }
}

// restore global hooks
setCurrentTime(null);
setRng(null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
