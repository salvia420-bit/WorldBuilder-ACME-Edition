#!/usr/bin/env node
// rynth_test_all.cjs — sequenced regression suite for the RynthSuite ->
// holtburger-web integration. Runs each rynth_*_smoke.cjs in turn with a
// pause between them (the tests share one ACE account, tailnet1; back-to-back
// logins hit ACE's ~65s session-reap window, so we pace them). Reports a
// PASS/FAIL table + exit code.
//
// Prereqs (all local): ACE server (UDP 9000/9001), serve.py (:8765),
// holtburger-wsbridge (:8080), rynthnav sidecar (:8767) — apps/rynthnav-sidecar,
// a RELEASE wasm build in pkg/, and playwright on NODE_PATH. Some individual
// smokes need additional infra layered on top — see REQUIRES below (sidecar
// ports, the wbt-sidecar, a built netbrain AppBundle); none need anything
// beyond what's already documented per-file.
// Run from apps/holtburger-web/:
//   NODE_PATH=<playwright> node rynth_test_all.cjs [--full]
//
// Default set is the fast + representative smokes. --full adds the
// long-running grind/loot/kernel/fullstack/AI-infra tests (much slower).
//
// ── orphan-smoke fold-in (rynth-review 14 #1/#4, 17-SYNTHESIS #16, fixed
// 2026-07-23) ───────────────────────────────────────────────────────────────
// 9 rynth_*_smoke.cjs used to be referenced by NEITHER this runner NOR
// rynth_test_all_node.cjs's *_test.cjs glob — including rynth_ai_smoke.cjs
// (SPEC.md's own named director "verification bar") and
// rynth_bot_boot_smoke.cjs (the ?bot=1 auto-boot gate). All 9 need real
// ACE+serve.py+wsbridge+playwright (none can run node-only — every one
// boots through rynth_boot_helper.cjs's bootInWorld, which needs a live
// browser+session), so none can join the DEFAULT-run node suite; they are
// folded in HERE instead (added to FULL, or the new AI_INFRA group for the
// ones needing extra infra beyond plain ACE) so `--full` actually exercises
// them, AND rynth_test_all_node.cjs renders every one of them (plus every
// other smoke) as a visible, reasoned SKIP row via the exported
// SMOKE_REQUIRES map below — nothing is silently absent from either
// runner's output anymore.
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
  // rynth_netbrain_test.cjs deliberately NOT listed here (rynth-review 14
  // P2 #7): it is a `*_test.cjs`, already globbed + run every time by
  // rynth_test_all_node.cjs, and its own header says "node-only" — carrying
  // it here too just ran it twice for nothing.
];
const FULL = [
  "rynth_combat_smoke.cjs",
  "rynth_loop_smoke.cjs",
  "rynth_loot_smoke.cjs",
  "rynth_buff_smoke.cjs",
  "rynth_kernel_smoke.cjs",
  "rynth_globalroute_smoke.cjs", // sidecar-planned goto, end to end
  "rynth_fullstack_smoke.cjs",
  // ── previously-orphaned smokes (14 #1, plain ACE+serve.py+wsbridge+
  // playwright — no extra infra beyond the FAST/FULL baseline) ──
  "rynth_batch_smoke.cjs",
  "rynth_bot_boot_smoke.cjs",   // the ?bot=1 client auto-boot gate (14 #1)
  "rynth_item_smoke.cjs",
  "rynth_ladder_smoke.cjs",
  "rynth_melee_smoke.cjs",
  "rynth_p3_smoke.cjs",
];
// ── previously-orphaned smokes needing infra ABOVE the plain baseline
// (their own extra port/build requirement — see SMOKE_REQUIRES) ──
const AI_INFRA = [
  "rynth_ai_smoke.cjs",      // SPEC.md's named director verification bar (14 #1/#4)
  "rynth_ai_wbt_smoke.cjs",  // + wbt-sidecar :8768
  "rynth_netbrain_smoke.cjs",// + a built netbrain/AppBundle
];

// Per-smoke extra-infra annotation (canonical vocabulary: ACE / serve.py /
// wsbridge / sidecar / playwright / OPENROUTER_KEY / build-artifact). Every
// baseline smoke needs ACE+serve.py+wsbridge+playwright at minimum; this map
// only need note what's needed ON TOP OF that baseline, plus a couple of
// genuinely special cases (rynth_sidecar_smoke.cjs is node-only, no browser
// at all). Consumed by rynth_test_all_node.cjs to render a REASONED skip
// line for every discovered smoke, not just a generic "browser smoke".
const SMOKE_REQUIRES = {
  rynth_sidecar_smoke: "node-only HTTP test, no playwright — but needs the live rynthnav sidecar (:8767)",
  rynth_globalroute_smoke: "ACE + serve.py + wsbridge + playwright + rynthnav sidecar (:8767)",
  rynth_ai_smoke: "ACE + serve.py + wsbridge + playwright (mock LLM is spawned in-process — no OPENROUTER_KEY needed); SPEC.md's named director verification bar",
  rynth_ai_wbt_smoke: "ACE + serve.py + wsbridge + playwright + the wbt-sidecar (:8768, scripts/wbt-sidecar-boot.sh)",
  rynth_netbrain_smoke: "ACE + serve.py + wsbridge + playwright + a built netbrain/AppBundle (netbrain/build.sh)",
};
const DEFAULT_SMOKE_REQUIRES = "ACE + serve.py (:8765) + wsbridge (:8080) + playwright on NODE_PATH";
/** Full requirement string for a smoke filename (with or without .cjs). */
function requiresFor(smokeFile) {
  const base = smokeFile.replace(/\.cjs$/, "");
  return SMOKE_REQUIRES[base] || DEFAULT_SMOKE_REQUIRES;
}

const GAP_MS = 70_000; // > ACE session reap so the next login is clean

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait keeps this a simple synchronous runner (spawnSync anyway).
    spawnSync("sleep", ["0.5"]);
  }
}

function main() {
  // --only a,b,c runs just the named tests (for a quick subset check).
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;
  let suite = process.argv.includes("--full") ? [...FAST, ...FULL, ...AI_INFRA] : FAST;
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
}

if (require.main === module) main();

module.exports = { FAST, FULL, AI_INFRA, SMOKE_REQUIRES, DEFAULT_SMOKE_REQUIRES, requiresFor };
