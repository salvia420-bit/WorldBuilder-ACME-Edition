// harness/port_e2e/run_e2e.mjs
// Opaque-box 4-tier E2E test runner for the Marine Container Terminal & Container Ship.
// Usage:
//   node harness/port_e2e/run_e2e.mjs --list
//   node harness/port_e2e/run_e2e.mjs --dry-run
//   node harness/port_e2e/run_e2e.mjs --tier=1|2|3|4|all [--json]

import { assert, getThree, loadPortModules, probePortModules } from "./e2e_helpers.mjs";
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

const REQUIRED_FEATURES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];

function parseArgs(argv) {
  const opts = {
    tier: "all",
    list: false,
    dryRun: false,
    contractCheck: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--list") opts.list = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--contract-check") opts.contractCheck = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--tier=")) opts.tier = arg.slice("--tier=".length).trim().toLowerCase();
    else {
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
  const anyTierByFeature = Object.fromEntries(REQUIRED_FEATURES.map((f) => [f, 0]));

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
      anyTierByFeature[f]++;
      if (t.tier === 1) tier1ByFeature[f]++;
      if (t.tier === 2) tier2ByFeature[f]++;
    }
  }

  assert.ok(tierCounts[1] >= 40, `Tier 1 count ${tierCounts[1]} < 40`);
  assert.ok(tierCounts[2] >= 40, `Tier 2 count ${tierCounts[2]} < 40`);
  assert.ok(tierCounts[3] >= 14, `Tier 3 count ${tierCounts[3]} < 14`);
  assert.ok(tierCounts[4] >= 8, `Tier 4 count ${tierCounts[4]} < 8`);
  assert.ok(ALL_TESTS.length >= 102, `Total count ${ALL_TESTS.length} < 102`);

  for (const f of REQUIRED_FEATURES) {
    assert.ok(tier1ByFeature[f] >= 4, `${f} Tier 1 count ${tier1ByFeature[f]} < 4`);
    assert.ok(tier2ByFeature[f] >= 4, `${f} Tier 2 count ${tier2ByFeature[f]} < 4`);
  }

  return {
    total: ALL_TESTS.length,
    tierCounts,
    tier1ByFeature,
    tier2ByFeature,
    anyTierByFeature,
  };
}

function selectTests(tier) {
  if (tier === "all") return ALL_TESTS;
  const n = Number(tier);
  return ALL_TESTS.filter((t) => t.tier === n);
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
      console.log(`=== Marine Port & Ship E2E Test Suite (${selected.length} listed / ${summary.total} total) ===`);
      for (const t of selected) {
        console.log(`  [T${t.tier}] ${t.id.padEnd(10)} [${t.features.join(",")}] ${t.title}`);
      }
      console.log(`\nTier counts: T1=${summary.tierCounts[1]}, T2=${summary.tierCounts[2]}, T3=${summary.tierCounts[3]}, T4=${summary.tierCounts[4]}, Total=${summary.total}`);
      console.log(`Feature coverage (T1/T2): ${REQUIRED_FEATURES.map((f) => `${f}:${summary.tier1ByFeature[f]}/${summary.tier2ByFeature[f]}`).join(" ")}`);
    }
    process.exitCode = 0;
    return;
  }

  if (opts.dryRun || opts.contractCheck) {
    const summary = validateManifestInvariants();
    const modules = await probePortModules();
    const loadErrors = modules.filter((m) => m.status === "LOAD_ERROR");
    if (opts.json) {
      console.log(JSON.stringify({
        mode: opts.contractCheck ? "contract-check" : "dry-run",
        manifestValid: true,
        summary,
        modules: modules.map(({ key, builder, rel, status, error }) => ({ key, builder, rel, status, error })),
      }, null, 2));
    } else {
      console.log("=== Marine Port & Ship E2E Dry-Run & Manifest Validation ===");
      console.log(`Manifest OK: T1=${summary.tierCounts[1]}, T2=${summary.tierCounts[2]}, T3=${summary.tierCounts[3]}, T4=${summary.tierCounts[4]}, Total=${summary.total}`);
      console.log("Feature threshold check (P1-P10 >= 4 T1 & >= 4 T2): PASS");
      console.log("\nB1-B4 Module Availability:");
      for (const m of modules) {
        const extra = m.error ? ` (${m.error})` : "";
        console.log(`  [${m.builder}] ${m.rel.padEnd(46)} ${m.status}${extra}`);
      }
    }
    process.exitCode = loadErrors.length > 0 ? 1 : 0;
    return;
  }

  validateManifestInvariants();
  const tStart = performance.now();
  let THREE = null;
  let mods = null;
  let setupError = null;
  try {
    THREE = await getThree();
    mods = await loadPortModules();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
  }

  const results = [];
  let passed = 0;
  let failed = 0;

  if (!opts.json) {
    console.log(`=== Running Marine Port & Ship E2E Tier=${opts.tier} (${selected.length} tests) ===`);
  }

  for (const test of selected) {
    const t0 = performance.now();
    const origLog = console.log;
    if (opts.json) console.log = () => {};
    try {
      if (setupError) throw setupError;
      await test.run({ THREE, mods });
      const ms = performance.now() - t0;
      passed++;
      results.push({ id: test.id, tier: test.tier, features: test.features, status: "PASS", durationMs: Number(ms.toFixed(2)), error: null });
      if (!opts.json) {
        console.log(`  [PASS] ${test.id} (${ms.toFixed(1)} ms) — ${test.title}`);
      }
    } catch (err) {
      const ms = performance.now() - t0;
      const msg = err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err);
      failed++;
      results.push({ id: test.id, tier: test.tier, features: test.features, status: "FAIL", durationMs: Number(ms.toFixed(2)), error: msg });
      if (!opts.json) {
        console.log(`  [FAIL] ${test.id} (${ms.toFixed(1)} ms) — ${test.title}\n         ${msg}`);
      }
    } finally {
      console.log = origLog;
    }
  }

  const totalMs = performance.now() - tStart;
  if (opts.json) {
    console.log(JSON.stringify({
      mode: "live",
      tier: opts.tier,
      passed,
      failed,
      total: selected.length,
      durationMs: Number(totalMs.toFixed(2)),
      results,
    }, null, 2));
  } else {
    console.log(`\nSummary: ${passed} passed, ${failed} failed, ${selected.length} total (${totalMs.toFixed(1)} ms)`);
  }

  process.exitCode = failed === 0 && passed === selected.length ? 0 : 1;
}

main().catch((err) => {
  console.error("port run_e2e fatal error:", err);
  process.exitCode = 1;
});
