#!/usr/bin/env node
// rynth_test_all.cjs — sequenced regression suite for the RynthSuite ->
// holtburger-web integration. Runs each rynth_*_smoke.cjs in turn with a
// pause between them (the tests share one ACE account, tailnet1; back-to-back
// logins hit ACE's ~65s session-reap window, so we pace them). Reports a
// PASS/FAIL table + exit code.
//
// Prereqs (all local): ACE server (UDP 9000/9001), serve.py (:8765),
// holtburger-wsbridge (:8080), rynthnav sidecar (:8767) — apps/rynthnav-sidecar,
// a RELEASE wasm build in pkg/, and playwright on NODE_PATH.
// Run from apps/holtburger-web/:
//   NODE_PATH=<playwright> node rynth_test_all.cjs [--full]
//
// Default set is the fast + representative smokes. --full adds the
// long-running grind/loot/kernel/fullstack tests (much slower).

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const FAST = [
  "rynth_webhost_smoke.cjs",   // seam + snapshot + moveToPosition
  "rynth_phase1_smoke.cjs",    // getters + moveToPosition
  "rynth_trio_smoke.cjs",      // busy trio
  "rynth_p12_smoke.cjs",       // T8 + P12 (deterministic)
  "rynth_giveup_smoke.cjs",    // vitals give-up valve (deterministic)
  "rynth_vitals_smoke.cjs",    // B15/B16 matrix + live heal
  "rynth_control_smoke.cjs",   // control channel (injected events)
  "rynth_router_smoke.cjs",    // multi-leg route
  "rynth_sidecar_smoke.cjs",   // rynthnav sidecar HTTP contract (node-only)
  "rynth_supervisor_smoke.cjs",// fleet lifecycle
];
const FULL = [
  "rynth_combat_smoke.cjs",
  "rynth_loop_smoke.cjs",
  "rynth_loot_smoke.cjs",
  "rynth_buff_smoke.cjs",
  "rynth_kernel_smoke.cjs",
  "rynth_globalroute_smoke.cjs", // sidecar-planned goto, end to end
  "rynth_fullstack_smoke.cjs",
];

const GAP_MS = 70_000; // > ACE session reap so the next login is clean

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait keeps this a simple synchronous runner (spawnSync anyway).
    spawnSync("sleep", ["0.5"]);
  }
}

// --only a,b,c runs just the named tests (for a quick subset check).
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;
let suite = process.argv.includes("--full") ? [...FAST, ...FULL] : FAST;
if (only) suite = suite.filter((t) => only.some((o) => t.includes(o)));
const nodePath = process.env.NODE_PATH || "";
const results = [];

console.log(`rynth regression suite: ${suite.length} tests, ${GAP_MS / 1000}s pacing\n`);
for (let i = 0; i < suite.length; i++) {
  const test = suite[i];
  process.stdout.write(`[${i + 1}/${suite.length}] ${test} ... `);
  const t0 = Date.now();
  const r = spawnSync("node", [path.join(__dirname, test)], {
    env: { ...process.env, NODE_PATH: nodePath },
    encoding: "utf8",
    timeout: 400_000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const pass = r.status === 0;
  // Pull the test's own verdict line if present.
  const verdict = (out.match(/[A-Z0-9 /]+: (PASS|FAIL|PARTIAL)[^\n]*/g) || []).slice(-1)[0] || "";
  results.push({ test, pass, secs, verdict: verdict.trim() });
  console.log(`${pass ? "PASS" : "FAIL"} (${secs}s) ${verdict ? "— " + verdict.trim() : ""}`);
  if (i < suite.length - 1) sleep(GAP_MS);
}

console.log("\n─── SUMMARY ───");
const passed = results.filter((r) => r.pass).length;
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.test} (${r.secs}s)`);
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
