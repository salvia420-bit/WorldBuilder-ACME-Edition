// Batch 13 / #30 — standalone ESM test for `scene3d/diag/combat.js`
// plugin-client poll give-up + reset() timer cleanup.
//
// Bug #30: _installSneakSubscription / _installDamageDealtSubscription
// each spin a 500ms setInterval forever waiting for window.__pluginClient.
// If the page is opened without ever logging in (no client), the polls
// never stop. The fix adds a ~30s ceiling (60 ticks @ 500ms) after which
// each poll clears its interval + warns + nulls the timer ref, and
// reset() clears any still-running poll timer — WITHOUT removing the
// (idempotent) bound subscription.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_diag_combat_giveup.mjs
//
// combat.js imports getCombatDiagSnapshot from ../../ui/ac_combat_maneuver.js;
// we strip imports and inject a stub. setInterval/clearInterval are
// controllable so we can advance ticks deterministically.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

function stripImports(src) {
  return src
    .replace(/^\s*import\s+.*$/gm, "")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
}

const combatPath = resolvePath(__dirname, "scene3d", "diag", "combat.js");
const combatSrc = stripImports(readFileSync(combatPath, "utf8"));

// Build a fresh combat-module instance per scenario so the module-scope
// _sneakSubInstalled / _damageDealtSubInstalled guards start clean.
function makeCombatModule(fakeWindow) {
  // Controllable timer harness: each setInterval registers a callback we
  // can step manually. clearInterval marks the id dead.
  const timers = new Map();   // id → { cb, dead }
  let nextId = 1;
  let warns = [];

  const setIntervalStub = (cb, _ms) => {
    const id = nextId++;
    timers.set(id, { cb, dead: false });
    return id;
  };
  const clearIntervalStub = (id) => {
    const t = timers.get(id);
    if (t) t.dead = true;
  };
  // Advance every live timer by one tick.
  const tick = (n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const [, t] of timers) {
        if (!t.dead) { try { t.cb(); } catch (_) {} }
      }
    }
  };
  const liveTimerCount = () => {
    let c = 0;
    for (const [, t] of timers) if (!t.dead) c += 1;
    return c;
  };
  const totalTimersStarted = () => timers.size;

  const fakeConsole = {
    log: () => {},
    warn: (...a) => { warns.push(a.join(" ")); },
    error: () => {},
  };
  const fakeFetch = () => Promise.reject(new Error("no fetch in test"));

  const factory = new Function(
    "getCombatDiagSnapshot",
    "window", "performance", "console", "fetch",
    "setInterval", "clearInterval",
    `${combatSrc}\n; return { attachCombat };`,
  );
  const { attachCombat } = factory(
    () => ({ tables: [] }),
    fakeWindow,
    globalThis.performance ?? { now: () => Date.now() },
    fakeConsole,
    fakeFetch,
    setIntervalStub,
    clearIntervalStub,
  );
  return { attachCombat, tick, liveTimerCount, totalTimersStarted, getWarns: () => warns };
}

console.log("Batch 13 / #30 — diag/combat.js poll give-up + reset test");
console.log("=========================");

// ---- Scenario A: no __pluginClient → polls scheduled, give up @ 60 ----
{
  const fakeWindow = {};   // no __pluginClient
  const mod = makeCombatModule(fakeWindow);
  const diag = {};
  mod.attachCombat(diag);

  check("attachCombat installed diag.combat", !!diag.combat);
  check(
    "no client: two poll intervals scheduled",
    mod.totalTimersStarted() === 2,
    `started=${mod.totalTimersStarted()}`,
  );
  check(
    "no client: both intervals live before give-up",
    mod.liveTimerCount() === 2,
    `live=${mod.liveTimerCount()}`,
  );

  // Advance 59 ticks — still live (give-up is at tick 60).
  mod.tick(59);
  check(
    "after 59 ticks: both polls still live (give-up not yet)",
    mod.liveTimerCount() === 2,
    `live=${mod.liveTimerCount()}`,
  );

  // 60th tick → both give up.
  mod.tick(1);
  check(
    "after 60 ticks: both poll timers cleared (give-up)",
    mod.liveTimerCount() === 0,
    `live=${mod.liveTimerCount()}`,
  );
  const warns = mod.getWarns();
  const gaveUp = warns.filter((w) => /gave up waiting for __pluginClient/.test(w));
  check(
    "give-up warning emitted for both polls",
    gaveUp.length === 2,
    `warnings=${gaveUp.length}`,
  );

  // Further ticks must not throw / re-warn (timers already dead).
  mod.tick(5);
  check(
    "no extra give-up warnings after timers cleared",
    mod.getWarns().filter((w) => /gave up waiting/.test(w)).length === 2,
  );
}

// ---- Scenario B: reset() clears in-flight poll timers ----------------
{
  const fakeWindow = {};   // no client → polls running
  const mod = makeCombatModule(fakeWindow);
  const diag = {};
  mod.attachCombat(diag);
  check(
    "B: polls live before reset",
    mod.liveTimerCount() === 2,
    `live=${mod.liveTimerCount()}`,
  );

  diag.combat.reset();
  check(
    "B: reset() cleared both poll timers",
    mod.liveTimerCount() === 0,
    `live=${mod.liveTimerCount()}`,
  );
}

// ---- Scenario C: client present up-front → NO setInterval scheduled ---
{
  const handlers = {};
  const fakeWindow = {
    __pluginClient: {
      events: {
        on(name, fn) { (handlers[name] ||= []).push(fn); },
      },
    },
  };
  const mod = makeCombatModule(fakeWindow);
  const diag = {};
  mod.attachCombat(diag);
  check(
    "C: client up-front → NO poll intervals scheduled",
    mod.totalTimersStarted() === 0,
    `started=${mod.totalTimersStarted()}`,
  );
  check(
    "C: sneakAttackPredicted subscription bound directly",
    Array.isArray(handlers.sneakAttackPredicted) && handlers.sneakAttackPredicted.length === 1,
  );
  check(
    "C: damageDealt subscription bound directly",
    Array.isArray(handlers.damageDealt) && handlers.damageDealt.length === 1,
  );

  // reset() must NOT remove the bound subscription (still 1 handler each).
  diag.combat.reset();
  check(
    "C: reset() leaves sneakAttackPredicted subscription installed",
    handlers.sneakAttackPredicted.length === 1,
  );
  check(
    "C: reset() leaves damageDealt subscription installed",
    handlers.damageDealt.length === 1,
  );
}

console.log("=========================");
if (failed === 0) {
  console.log(`PASS: all ${passed} Batch 13 #30 checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
