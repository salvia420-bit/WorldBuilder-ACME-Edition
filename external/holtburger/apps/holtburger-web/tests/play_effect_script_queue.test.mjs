import { ScriptManager } from "../scene3d/script_manager.js";
import { getPlayEffectScriptManager } from "../scene3d/play_effect_vfx.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function approx(a, b, epsilon = 1e-4) {
  return Math.abs(a - b) < epsilon;
}

console.log("Running play_effect_script_queue tests...");

// --- Test 1: ScriptManager.reserve sequencing back-to-back ---
{
  const mgr = new ScriptManager({ owner: "test-reserve" });
  assert(!mgr.active, "Manager starts idle");

  const start1 = mgr.reserve(0x33000001, 2.5, 100.0);
  assert(approx(start1, 100.0), `First reservation should start at now=100.0 (got ${start1})`);
  assert(mgr.active, "Manager active after reservation");

  const start2 = mgr.reserve(0x33000002, 1.5);
  assert(approx(start2, 102.5), `Second reservation should chain after first (got ${start2}, expected 102.5)`);

  const start3 = mgr.reserve(0x33000003, 3.0);
  assert(approx(start3, 104.0), `Third reservation should chain after second (got ${start3}, expected 104.0)`);

  // Drive clock forward
  mgr.update(101.0);
  assert(mgr.active, "Manager still active during first reservation");
  assert(mgr.scriptsCompleted === 0, "No script completed yet at 101.0");

  mgr.update(102.5);
  assert(mgr.scriptsCompleted === 1, "First reservation completes at 102.5");

  mgr.update(104.0);
  assert(mgr.scriptsCompleted === 2, "Second reservation completes at 104.0");

  mgr.update(107.0);
  assert(mgr.scriptsCompleted === 3, "Third reservation completes at 107.0");
  assert(!mgr.active, "Manager idle after all reservations complete");

  console.log("  [PASS] ScriptManager.reserve chaining and lifecycle");
}

// --- Test 2: ScriptManager entry.execute invocation ---
{
  const events = [];
  const mgr = new ScriptManager({ owner: "test-exec" });

  mgr.addScript(0x33000010, [
    {
      startTime: 0.0,
      execute: (ctx) => events.push(`A0 at ${ctx.scriptStart}`),
    },
    {
      startTime: 0.5,
      execute: (ctx) => events.push(`A1 at ${ctx.scriptStart + 0.5}`),
    },
  ], { now: 50.0, length: 1.0 });

  mgr.update(50.0);
  assert(events.length === 1 && events[0] === "A0 at 50", `A0 should execute at t=50 (got ${events[0]})`);

  mgr.update(50.25);
  assert(events.length === 1, "A1 should not execute before t=50.5");

  mgr.update(50.5);
  assert(events.length === 2 && events[1] === "A1 at 50.5", `A1 should execute at t=50.5 (got ${events[1]})`);

  mgr.update(51.0);
  assert(mgr.scriptsCompleted === 1, "Script should complete at t=51.0");
  assert(!mgr.active, "Manager should be idle");

  console.log("  [PASS] ScriptManager per-entry execute callback");
}

// --- Test 3: Multiple wire PlayScripts queuing in FIFO simulation-time order ---
{
  const firedHooks = [];
  const targetGuid = 0x12345678;

  // Mock entity manager with _scriptManagersForGuid map
  const mockEm = {
    _scriptManagersForGuid: new Map(),
    _firePlayEffectSoundHook: (guid, desc) => {
      firedHooks.push({ type: "sound", guid, time: desc.time || 0 });
    },
  };

  const mgr = getPlayEffectScriptManager(mockEm, targetGuid);
  assert(mgr instanceof ScriptManager, "Should resolve a ScriptManager for the target entity");

  // Queue Script 1 (e.g. Fizzle: sound at 0.0, particle at 0.2, length 0.5s) starting at simulation time 200.0
  const script1Data = mgr.addScript(0x33000103, [
    {
      startTime: 0.0,
      execute: () => firedHooks.push({ script: 1, hook: "sound", time: 0.0 }),
    },
    {
      startTime: 0.2,
      execute: () => firedHooks.push({ script: 1, hook: "particle", time: 0.2 }),
    },
  ], { now: 200.0, length: 0.5 });

  assert(approx(script1Data.startTime, 200.0), `Script 1 should start at 200.0 (got ${script1Data.startTime})`);

  // Queue Script 2 (e.g. Spark: particle at 0.0, sound at 0.1, length 0.4s) while Script 1 is still active
  const script2Data = mgr.addScript(0x33000067, [
    {
      startTime: 0.0,
      execute: () => firedHooks.push({ script: 2, hook: "particle", time: 0.0 }),
    },
    {
      startTime: 0.1,
      execute: () => firedHooks.push({ script: 2, hook: "sound", time: 0.1 }),
    },
  ], { length: 0.4 });

  // Script 2 MUST chain back-to-back after Script 1's end: 200.0 + 0.5 = 200.5
  assert(approx(script2Data.startTime, 200.5), `Script 2 should queue after Script 1 at 200.5 (got ${script2Data.startTime})`);

  // Queue Script 3 (e.g. Buff: sound at 0.0, length 0.3s)
  const script3Data = mgr.addScript(0x3300002B, [
    {
      startTime: 0.0,
      execute: () => firedHooks.push({ script: 3, hook: "sound", time: 0.0 }),
    },
  ], { length: 0.3 });

  // Script 3 MUST chain after Script 2's end: 200.5 + 0.4 = 200.9
  assert(approx(script3Data.startTime, 200.9), `Script 3 should queue after Script 2 at 200.9 (got ${script3Data.startTime})`);

  // Simulate tick progression
  mgr.update(200.0);
  assert(firedHooks.length === 1 && firedHooks[0].script === 1 && firedHooks[0].hook === "sound", "Script 1 sound fires at 200.0");

  mgr.update(200.1);
  assert(firedHooks.length === 1, "No new hook at 200.1");

  mgr.update(200.2);
  assert(firedHooks.length === 2 && firedHooks[1].script === 1 && firedHooks[1].hook === "particle", "Script 1 particle fires at 200.2");

  // At 200.4, Script 1 is still running, Script 2 hooks must NOT have fired!
  mgr.update(200.4);
  assert(firedHooks.length === 2, "Script 2 hooks have not fired while Script 1 is active");

  // At 200.5, Script 1 ends and Script 2 begins: Script 2 particle hook fires!
  mgr.update(200.5);
  assert(firedHooks.length === 3 && firedHooks[2].script === 2 && firedHooks[2].hook === "particle", "Script 2 particle fires at 200.5");

  // At 200.6, Script 2 sound fires
  mgr.update(200.6);
  assert(firedHooks.length === 4 && firedHooks[3].script === 2 && firedHooks[3].hook === "sound", "Script 2 sound fires at 200.6");

  // At 200.9, Script 2 ends and Script 3 begins
  mgr.update(200.9);
  assert(firedHooks.length === 5 && firedHooks[4].script === 3 && firedHooks[4].hook === "sound", "Script 3 sound fires at 200.9");

  // At 201.2, all scripts are complete
  mgr.update(201.2);
  assert(mgr.scriptsCompleted === 3, "All 3 scripts completed");
  assert(!mgr.active, "Manager is idle");

  console.log("  [PASS] Multiple wire PlayScripts queuing in strict simulation-time FIFO order");
}

console.log("All play_effect_script_queue tests passed!");
