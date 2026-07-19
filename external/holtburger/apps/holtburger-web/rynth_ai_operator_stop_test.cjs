#!/usr/bin/env node
// rynth_ai_operator_stop_test.cjs — unit tests for rynth/ai/operator_stop.js,
// the durable operator AI-stop latch (task #11). Covers (a) stop() sets the
// latch / start() clears it (via the same helpers bot.js's window.rynthAI wires
// them to), and (b) the auto-boot cfg assembly honors the latch — the exact
// decision index.html calls (applyOperatorStopToCfg) forces cfg.ai=false when
// latched and leaves cfg alone when not.
//
// No infra, no browser: a fake localStorage is injected (plain `node` has no
// globalThis.localStorage). Run: node rynth_ai_operator_stop_test.cjs

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Minimal Storage stand-in (Web Storage semantics: string values, missing -> null).
function makeStore(seed) {
  const m = new Map(seed ? Object.entries(seed) : undefined);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "operator_stop.js")).href);
  const { OPERATOR_STOP_KEY, latchOperatorStop, clearOperatorStop, isOperatorStopLatched, applyOperatorStopToCfg } = mod;

  check("latch key name is rynthAiOperatorStop", OPERATOR_STOP_KEY === "rynthAiOperatorStop", `got ${OPERATOR_STOP_KEY}`);

  // (a) stop() latches, start() clears.
  {
    const s = makeStore();
    check("initially not latched", isOperatorStopLatched(s) === false);
    latchOperatorStop(s); // <- what rynthAI.stop() calls
    check("stop() sets latch value '1'", s.getItem(OPERATOR_STOP_KEY) === "1");
    check("isOperatorStopLatched true after stop", isOperatorStopLatched(s) === true);
    clearOperatorStop(s); // <- what rynthAI.start() calls
    check("start() removes the latch key", s.getItem(OPERATOR_STOP_KEY) === null);
    check("isOperatorStopLatched false after start", isOperatorStopLatched(s) === false);
  }

  // (b) boot-path cfg assembly honors the latch.
  {
    // Latched: director forced off regardless of botModel/botInterval params.
    const s = makeStore({ rynthAiOperatorStop: "1" });
    const cfg = { ai: { model: "z-ai/glm-5.2", intervalMinutes: 1 }, nav: { endpoint: "x" } };
    const suppressed = applyOperatorStopToCfg(cfg, s);
    check("latched: applyOperatorStopToCfg returns true (caller logs)", suppressed === true);
    check("latched: cfg.ai forced to false", cfg.ai === false);
    check("latched: unrelated cfg fields untouched", cfg.nav && cfg.nav.endpoint === "x");
  }
  {
    // Absent latch: default behavior unchanged — cfg.ai preserved.
    const s = makeStore();
    const cfg = { ai: { model: "z-ai/glm-5.2" } };
    const suppressed = applyOperatorStopToCfg(cfg, s);
    check("unlatched: returns false", suppressed === false);
    check("unlatched: cfg.ai preserved (default behavior unchanged)", cfg.ai && cfg.ai.model === "z-ai/glm-5.2");
  }
  {
    // AND-style: ?botAi=off already set cfg.ai=false; latch keeps it false, no throw.
    const s = makeStore({ rynthAiOperatorStop: "1" });
    const cfg = { ai: false };
    const suppressed = applyOperatorStopToCfg(cfg, s);
    check("botAi=off + latch: still suppressed true", suppressed === true);
    check("botAi=off + latch: cfg.ai stays false", cfg.ai === false);
  }
  {
    // Round-trip through the exact stop->boot->start sequence the bug describes.
    const s = makeStore();
    latchOperatorStop(s);                 // operator stops director
    const rebootCfg = { ai: { model: "z-ai/glm-5.2", intervalMinutes: 1 } }; // reconnect rebuilds from URL params
    applyOperatorStopToCfg(rebootCfg, s); // auto-boot honors latch
    check("reconnect reboot: director stays suppressed", rebootCfg.ai === false);
    clearOperatorStop(s);                 // operator explicitly restarts
    const afterStart = { ai: { model: "z-ai/glm-5.2" } };
    applyOperatorStopToCfg(afterStart, s);
    check("after start(): a later reboot runs the director again", afterStart.ai && afterStart.ai.model === "z-ai/glm-5.2");
  }
  {
    // Robustness: blocked/absent storage and bad cfg never throw.
    check("applyOperatorStopToCfg(null) -> false, no throw", applyOperatorStopToCfg(null, makeStore()) === false);
    let threw = false;
    try {
      const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
      latchOperatorStop(bad); clearOperatorStop(bad);
      check("blocked storage: isOperatorStopLatched false, no throw", isOperatorStopLatched(bad) === false);
    } catch { threw = true; }
    check("blocked storage never throws", threw === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
