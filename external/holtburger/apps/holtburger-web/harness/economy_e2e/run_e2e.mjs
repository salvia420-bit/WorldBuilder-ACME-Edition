// harness/economy_e2e/run_e2e.mjs
// Opaque-box 4-tier E2E test runner for the Guild-Based Physicalized Town Control
// & Closed-Loop Economy (Dereth + Dericost, Phases A-E + R6).
//
// Usage:
//   node harness/economy_e2e/run_e2e.mjs --list [--tier=1|2|3|4|all] [--json]
//   node harness/economy_e2e/run_e2e.mjs --self-check [--json]
//   node harness/economy_e2e/run_e2e.mjs [--tier=1|2|3|4|all | --tier 1|2|3|4|all] [--json]

import path from "node:path";
import { acquireHeavyLock } from "../lib/heavy_lock.mjs";
import {
  PROTOCOL_DIR,
  REQUIRED_FEATURES,
  assert,
  getThree,
  probeImplementationTargets,
  runNegativeSelfChecks,
  runNode,
  runPython,
  verifyBaselineMysqlGroundTruth,
  verifyBaselineWorldAndDericostData,
  verifyWarehouseImmutability,
} from "./e2e_helpers.mjs";
import { TESTS as TIER1_TESTS } from "./tier1_features.mjs";
import { TESTS as TIER2_TESTS } from "./tier2_boundaries.mjs";
import { TESTS as TIER3_TESTS } from "./tier3_pairwise.mjs";
import { TESTS as TIER4_TESTS } from "./tier4_scenarios.mjs";

const ALL_TESTS = [
  ...TIER1_TESTS,
  ...TIER2_TESTS,
  ...TIER3_TESTS,
  ...TIER4_TESTS,
];

function parseArgs(argv) {
  const opts = {
    tier: "all",
    list: false,
    selfCheck: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") opts.list = true;
    else if (arg === "--self-check" || arg === "--dry-run" || arg === "--contract-check") opts.selfCheck = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--tier=")) opts.tier = arg.slice("--tier=".length).trim().toLowerCase();
    else if (arg === "--tier") {
      if (i + 1 >= argv.length) throw new Error("Missing value after --tier");
      opts.tier = argv[++i].trim().toLowerCase();
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }
  if (!["1", "2", "3", "4", "all"].includes(opts.tier)) {
    throw new Error(`Invalid --tier="${opts.tier}" (expected 1|2|3|4|all)`);
  }
  return opts;
}

function validateManifestInvariants() {
  const seenIds = new Set();
  const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const tier1ByFeature = Object.fromEntries(REQUIRED_FEATURES.map((f) => [f, 0]));
  const tier2ByFeature = Object.fromEntries(REQUIRED_FEATURES.map((f) => [f, 0]));
  const tier3ByFeature = Object.fromEntries(REQUIRED_FEATURES.map((f) => [f, 0]));
  const tier4ByFeature = Object.fromEntries(REQUIRED_FEATURES.map((f) => [f, 0]));

  for (const t of ALL_TESTS) {
    assert.ok(t && typeof t === "object", "test descriptor must be object");
    assert.ok(typeof t.id === "string" && t.id.length > 0, "test id required");
    assert.equal(seenIds.has(t.id), false, `duplicate test ID: ${t.id}`);
    seenIds.add(t.id);

    assert.ok([1, 2, 3, 4].includes(t.tier), `invalid tier ${t.tier} on ${t.id}`);
    assert.ok(Array.isArray(t.features) && t.features.length > 0, `features[] required on ${t.id}`);
    assert.ok(typeof t.title === "string" && t.title.length > 0, `title required on ${t.id}`);
    assert.equal(typeof t.run, "function", `run() function required on ${t.id}`);

    tierCounts[t.tier]++;
    for (const f of t.features) {
      assert.ok(REQUIRED_FEATURES.includes(f), `unknown feature "${f}" on ${t.id}`);
      if (t.tier === 1) tier1ByFeature[f]++;
      if (t.tier === 2) tier2ByFeature[f]++;
      if (t.tier === 3) tier3ByFeature[f]++;
      if (t.tier === 4) tier4ByFeature[f]++;
    }
  }

  assert.equal(tierCounts[1], 95, `Tier 1 count ${tierCounts[1]} !== 95`);
  assert.equal(tierCounts[2], 95, `Tier 2 count ${tierCounts[2]} !== 95`);
  assert.equal(tierCounts[3], 20, `Tier 3 count ${tierCounts[3]} !== 20`);
  assert.equal(tierCounts[4], 6, `Tier 4 count ${tierCounts[4]} !== 6`);
  assert.equal(ALL_TESTS.length, 216, `Total count ${ALL_TESTS.length} !== 216`);

  for (const f of REQUIRED_FEATURES) {
    assert.ok(tier1ByFeature[f] >= 5, `${f} Tier 1 count ${tier1ByFeature[f]} < 5`);
    assert.ok(tier2ByFeature[f] >= 5, `${f} Tier 2 count ${tier2ByFeature[f]} < 5`);
    assert.ok(tier3ByFeature[f] >= 1, `${f} Tier 3 count ${tier3ByFeature[f]} < 1`);
  }

  return {
    total: ALL_TESTS.length,
    tierCounts,
    tier1ByFeature,
    tier2ByFeature,
    tier3ByFeature,
    tier4ByFeature,
  };
}

function selectTests(tier) {
  if (tier === "all") return ALL_TESTS;
  const n = Number(tier);
  return ALL_TESTS.filter((t) => t.tier === n);
}

async function runSelfCheck(opts) {
  const summary = validateManifestInvariants();
  const baselineChecks = [];
  const runBaseline = (id, fn) => {
    try {
      const detail = fn();
      baselineChecks.push({ id, status: "PASS", detail });
    } catch (err) {
      baselineChecks.push({ id, status: "FAIL", detail: err instanceof Error ? err.message : String(err) });
    }
  };

  // 1. R6 18-file Warehouse immutability
  runBaseline("BASE-R6-18FILES", () => verifyWarehouseImmutability());

  // 2. JS coverage guard = 0 unregistered
  runBaseline("BASE-JS-COVERAGE", () => {
    const res = runNode("harness/run-js-headless.mjs", ["--coverage"]);
    assert.equal(res.code, 0, res.stderr || res.stdout);
    assert.ok(/0 unregistered/.test(res.stdout), `Expected 0 unregistered, got: ${res.stdout}`);
    return "0 unregistered";
  });

  // 3. Protocol fixture parity check
  runBaseline("BASE-FIXTURES-CHECK", () => {
    const res = runPython(path.join(PROTOCOL_DIR, "gen_fixtures.py"), ["--check"]);
    assert.equal(res.code, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  });

  // 4. Dericost 41 towns & world metadata
  runBaseline("BASE-DERICOST-41", () => verifyBaselineWorldAndDericostData());

  // 5. MariaDB ace_world ground-truth baseline
  runBaseline("BASE-MYSQL-ACE-WORLD", () => verifyBaselineMysqlGroundTruth());

  // 6. Negative self-checks (prove validators actually reject bad inputs)
  const THREE = await getThree();
  let negativeChecks = [];
  let negativeFailed = 0;
  try {
    negativeChecks = await runNegativeSelfChecks(THREE);
  } catch (err) {
    negativeFailed++;
    negativeChecks.push({ id: "NEG-SUITE", status: "FAIL", detail: err instanceof Error ? err.message : String(err) });
  }

  // 7. Probe Phases A-E implementation targets
  const probes = await probeImplementationTargets();
  const loadErrors = probes.filter((p) => p.status === "LOAD_ERROR");
  const baselineFailed = baselineChecks.filter((b) => b.status === "FAIL").length;
  const warehouse18Intact = baselineChecks.find((b) => b.id === "BASE-R6-18FILES")?.status === "PASS";

  const ok = baselineFailed === 0 && negativeFailed === 0 && loadErrors.length === 0;

  if (opts.json) {
    console.log(JSON.stringify({
      mode: "self-check",
      manifestValid: true,
      summary,
      warehouse18Intact,
      baselineChecks,
      negativeChecks,
      probes,
      totals: {
        baselinePass: baselineChecks.filter((b) => b.status === "PASS").length,
        baselineFail: baselineFailed,
        negativePass: negativeChecks.filter((n) => n.status === "PASS").length,
        negativeFail: negativeFailed,
        available: probes.filter((p) => p.status === "AVAILABLE").length,
        notYetImplemented: probes.filter((p) => p.status === "NOT_YET_IMPLEMENTED").length,
        loadError: loadErrors.length,
      },
      ok,
    }, null, 2));
  } else {
    console.log("=== Economy E2E Self-Check & Contract Validation ===");
    console.log(`Manifest OK: T1=${summary.tierCounts[1]}, T2=${summary.tierCounts[2]}, T3=${summary.tierCounts[3]}, T4=${summary.tierCounts[4]}, Total=${summary.total}`);
    console.log("\nBaseline & Regression Self-Checks:");
    for (const b of baselineChecks) {
      console.log(`  [${b.status}] ${b.id.padEnd(28)} ${typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail)}`);
    }
    console.log("\nNegative Validator Self-Checks:");
    for (const n of negativeChecks) {
      console.log(`  [${n.status}] ${n.id.padEnd(28)} ${n.detail}`);
    }
    console.log("\nPhase A-E Target Probes:");
    for (const p of probes) {
      console.log(`  [${p.phase.padEnd(9)}] ${p.label.padEnd(34)} ${p.status.padEnd(21)} ${p.detail}`);
    }
    console.log(`\nLOAD_ERROR: ${loadErrors.length} | BASELINE_FAIL: ${baselineFailed} | NEGATIVE_FAIL: ${negativeFailed}`);
  }

  process.exitCode = ok ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selected = selectTests(opts.tier);

  if (opts.list) {
    const summary = validateManifestInvariants();
    if (opts.json) {
      console.log(JSON.stringify({
        mode: "list",
        summary,
        tests: selected.map(({ id, tier, features, title }) => ({ id, tier, features, title })),
      }, null, 2));
    } else {
      console.log(`=== Economy E2E Test Suite (${selected.length} listed / ${summary.total} total) ===`);
      for (const t of selected) {
        console.log(`  [T${t.tier}] ${t.id.padEnd(7)} [${t.features.join(",")}] ${t.title}`);
      }
      console.log(`\nTier counts: T1=${summary.tierCounts[1]}, T2=${summary.tierCounts[2]}, T3=${summary.tierCounts[3]}, T4=${summary.tierCounts[4]}, Total=${summary.total}`);
      console.log(`Feature coverage (T1/T2/T3): ${REQUIRED_FEATURES.map((f) => `${f}:${summary.tier1ByFeature[f]}/${summary.tier2ByFeature[f]}/${summary.tier3ByFeature[f]}`).join(" ")}`);
    }
    process.exitCode = 0;
    return;
  }

  if (opts.selfCheck) {
    await runSelfCheck(opts);
    return;
  }

  // Strict live execution mode: NO fake passes or silent skips!
  process.env.ECONOMY_E2E_STRICT = "1";
  const summary = validateManifestInvariants();
  const heavyLock = await acquireHeavyLock({ label: `economy_e2e:tier=${opts.tier}` });
  try {
  const tStart = performance.now();
  const THREE = await getThree();

  const results = [];
  let passed = 0;
  let failed = 0;
  let notYetImplemented = 0;

  if (!opts.json) {
    console.log(`=== Running Economy E2E (STRICT) Tier=${opts.tier} (${selected.length} tests) ===`);
  }

  for (const test of selected) {
    const t0 = performance.now();
    const origLog = console.log;
    if (opts.json) console.log = () => {};
    try {
      await test.run({ THREE });
      const ms = performance.now() - t0;
      passed++;
      results.push({ id: test.id, tier: test.tier, features: test.features, title: test.title, status: "PASS", durationMs: Number(ms.toFixed(2)), detail: "ok" });
      if (!opts.json) {
        console.log(`  [PASS] ${test.id} (${ms.toFixed(1)} ms) — ${test.title}`);
      }
    } catch (err) {
      const ms = performance.now() - t0;
      const causeCode = err?.cause?.code ? ` (${err.cause.code})` : "";
      const msg = (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err)) + causeCode;
      const isNotImpl = /Target not yet implemented|not found|ENOENT|Missing|not listening|ECONNREFUSED|Table .* doesn't exist/i.test(msg);
      if (isNotImpl) notYetImplemented++;
      failed++;
      results.push({
        id: test.id,
        tier: test.tier,
        features: test.features,
        title: test.title,
        status: isNotImpl ? "FAIL (NOT_YET_IMPLEMENTED)" : "FAIL",
        durationMs: Number(ms.toFixed(2)),
        detail: msg,
      });
      if (!opts.json) {
        console.log(`  [FAIL] ${test.id} (${ms.toFixed(1)} ms) — ${test.title}\n         ${msg}`);
      }
    } finally {
      console.log = origLog;
    }
  }

  let warehouse18Intact = false;
  try {
    verifyWarehouseImmutability();
    warehouse18Intact = true;
  } catch (_) {
    warehouse18Intact = false;
  }

  const totalMs = performance.now() - tStart;
  if (opts.json) {
    console.log(JSON.stringify({
      mode: "live",
      tier: opts.tier,
      tierCounts: summary.tierCounts,
      totals: {
        pass: passed,
        fail: failed,
        notYetImplemented,
        loadError: 0,
        total: selected.length,
      },
      warehouse18Intact,
      durationMs: Number(totalMs.toFixed(2)),
      results,
    }, null, 2));
  } else {
    console.log(`\nSummary: ${passed} passed, ${failed} failed (of which notYetImplemented=${notYetImplemented}), ${selected.length} total (${totalMs.toFixed(1)} ms) | warehouse18Intact=${warehouse18Intact}`);
  }

  process.exitCode = failed === 0 && passed === selected.length ? 0 : 1;
  } finally {
    heavyLock.release();
  }
}

main().catch((err) => {
  console.error("run_e2e fatal error:", err);
  process.exitCode = 1;
});
