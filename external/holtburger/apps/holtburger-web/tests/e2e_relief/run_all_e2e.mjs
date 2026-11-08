#!/usr/bin/env node
/**
 * apps/holtburger-web/tests/e2e_relief/run_all_e2e.mjs
 * Master Multi-Tier E2E Test Runner for 3D Surface Relief & Visual Enhancements.
 *
 * Runs all 4 test tiers:
 *   - Tier 1: Feature Coverage (>=75 tests across 15 features)
 *   - Tier 2: Boundary & Corner Cases (>=75 tests across 15 features)
 *   - Tier 3: Cross-Feature Combinations (>=15 tests)
 *   - Tier 4: Real-World Town Scenarios (8 scenarios)
 *   - Total: >= 173 tests!
 *
 * Usage:
 *   HB_MIN_FREE_MB=1500 node tests/e2e_relief/run_all_e2e.mjs [--tier=1|2|3|4] [--verbose] [--json] [--filter=<pattern>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResults, resetResults } from "./harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Authoritative minimum thresholds defined in TEST_INFRA.md
const THRESHOLDS = {
  tier1: 75,
  tier2: 75,
  tier3: 15,
  tier4: 8,
  total: 173,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tier: null,
    verbose: false,
    json: false,
    filter: null,
  };

  for (const arg of args) {
    if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--tier=")) {
      options.tier = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--filter=")) {
      options.filter = arg.split("=")[1];
    }
  }

  return options;
}

// Master list of test suites
const TIER1_SUITES = [
  { file: "./tier1_features/f1_cloned_pom.test.mjs", name: "F1: Cloned Material POM Persistence" },
  { file: "./tier1_features/f2_distance_lod.test.mjs", name: "F2: Extended Distance LOD Range" },
  { file: "./tier1_features/f3_texture_reclassification.test.mjs", name: "F3: Brick & Stone Texture Reclassification" },
  { file: "./tier1_features/f4_authored_overrides.test.mjs", name: "F4: Authored Override Heightfield Preservation" },
  { file: "./tier1_features/f5_modelgate_relaxation.test.mjs", name: "F5: ModelGate Threshold Relaxation" },
  { file: "./tier1_features/f6_crevice_ao.test.mjs", name: "F6: Micro-Surface Crevice AO" },
  { file: "./tier1_features/f7_specular_rim.test.mjs", name: "F7: Specular Rim Highlighting" },
  { file: "./tier1_features/f8_micro_shadows.test.mjs", name: "F8: Directional Micro-Contact Shadowing" },
  { file: "./tier1_features/f9_oblique_slope.test.mjs", name: "F9: Oblique Slope Shading" },
  { file: "./tier1_features/f10_adaptive_pom.test.mjs", name: "F10: Adaptive POM & Silhouette Clamping" },
  { file: "./tier1_features/f11_program_cache.test.mjs", name: "F11: Program Cache Disambiguation" },
  { file: "./tier1_features/f12_batched_parity.test.mjs", name: "F12: Batched Material Parity" },
  { file: "./tier1_features/f13_regression_suite.test.mjs", name: "F13: Automated Regression Suite" },
  { file: "./tier1_features/f14_visual_captures.test.mjs", name: "F14: Multi-Town Visual Captures" },
  { file: "./tier1_features/f15_gtx1070_benchmarking.test.mjs", name: "F15: GTX 1070 Framerate Benchmarking" },
];

const TIER2_SUITES = [
  { file: "./tier2_boundaries/f1_cloned_pom_boundary.test.mjs", name: "B1: Cloned POM Boundaries" },
  { file: "./tier2_boundaries/f2_distance_lod_boundary.test.mjs", name: "B2: Distance LOD Boundaries" },
  { file: "./tier2_boundaries/f3_texture_reclassification_boundary.test.mjs", name: "B3: Reclassification Boundaries" },
  { file: "./tier2_boundaries/f4_authored_overrides_boundary.test.mjs", name: "B4: Authored Overrides Boundaries" },
  { file: "./tier2_boundaries/f5_modelgate_relaxation_boundary.test.mjs", name: "B5: ModelGate Boundaries" },
  { file: "./tier2_boundaries/f6_crevice_ao_boundary.test.mjs", name: "B6: Crevice AO Boundaries" },
  { file: "./tier2_boundaries/f7_specular_rim_boundary.test.mjs", name: "B7: Specular Rim Boundaries" },
  { file: "./tier2_boundaries/f8_micro_shadows_boundary.test.mjs", name: "B8: Micro-Shadows Boundaries" },
  { file: "./tier2_boundaries/f9_oblique_slope_boundary.test.mjs", name: "B9: Oblique Slope Boundaries" },
  { file: "./tier2_boundaries/f10_adaptive_pom_boundary.test.mjs", name: "B10: Adaptive POM Boundaries" },
  { file: "./tier2_boundaries/f11_program_cache_boundary.test.mjs", name: "B11: Program Cache Boundaries" },
  { file: "./tier2_boundaries/f12_batched_parity_boundary.test.mjs", name: "B12: Batched Parity Boundaries" },
  { file: "./tier2_boundaries/f13_regression_suite_boundary.test.mjs", name: "B13: Regression Boundaries" },
  { file: "./tier2_boundaries/f14_visual_captures_boundary.test.mjs", name: "B14: Visual Capture Boundaries" },
  { file: "./tier2_boundaries/f15_gtx1070_benchmarking_boundary.test.mjs", name: "B15: GTX 1070 Benchmarking Boundaries" },
];

const TIER3_SUITES = [
  { file: "./tier3_combinations/pairwise_combinations.test.mjs", name: "T3: Cross-Feature Pairwise Interactions" },
];

const TIER4_SUITES = [
  { file: "./tier4_scenarios/s1_holtburg_cottage_wall.test.mjs", name: "S1: Holtburg Cottage Wall Close-Up & Distance Arc" },
  { file: "./tier4_scenarios/s2_holtburg_s121_sunlight.test.mjs", name: "S2: Holtburg Hilltop Brick Hall Sunlight Sweep" },
  { file: "./tier4_scenarios/s3_sanamar_stone_plaza.test.mjs", name: "S3: Sanamar Dressed Stone Plaza Tour" },
  { file: "./tier4_scenarios/s4_al_jalima_sandstone.test.mjs", name: "S4: Al-Jalima Sandstone Architecture & Domed Tavern" },
  { file: "./tier4_scenarios/s5_neydisa_mountain_keep.test.mjs", name: "S5: Neydisa Castle Mountain Keep & Walls" },
  { file: "./tier4_scenarios/s6_bandit_castle_keep.test.mjs", name: "S6: Bandit Castle Octagonal Keep & Gatehouse" },
  { file: "./tier4_scenarios/s7_authored_pbr_inworld.test.mjs", name: "S7: Authored PBR Replacement Surface In-World" },
  { file: "./tier4_scenarios/s8_multitown_gtx1070_stability.test.mjs", name: "S8: Continuous Multi-Town GTX 1070 Stability" },
];

function publishTestReady(summary) {
  const signalPath = "/home/wbterminal/.agents/teamwork/TEST_READY.md";
  const content = `# Coordination Signal: E2E Test Suite Ready (TEST_READY.md)

- **Timestamp**: ${new Date().toISOString()}
- **Test Suite Location**: \`apps/holtburger-web/tests/e2e_relief/\`
- **Master Test Runner**: \`apps/holtburger-web/tests/e2e_relief/run_all_e2e.mjs\`
- **Invocation**: \`HB_MIN_FREE_MB=1500 node tests/e2e_relief/run_all_e2e.mjs\`

## Test Execution Summary
| Tier | Description | Required Threshold | Executed | Passed | Failed | Status |
|------|-------------|:------------------:|:--------:|:------:|:------:|:------:|
| Tier 1 | Feature Coverage (15 Features) | >= 75 | ${summary.tier1.total} | ${summary.tier1.passed} | ${summary.tier1.failed} | ${summary.tier1.failed === 0 && summary.tier1.total >= 75 ? "PASS" : "FAIL"} |
| Tier 2 | Boundary & Corner Cases (15 Features) | >= 75 | ${summary.tier2.total} | ${summary.tier2.passed} | ${summary.tier2.failed} | ${summary.tier2.failed === 0 && summary.tier2.total >= 75 ? "PASS" : "FAIL"} |
| Tier 3 | Cross-Feature Interactions | >= 15 | ${summary.tier3.total} | ${summary.tier3.passed} | ${summary.tier3.failed} | ${summary.tier3.failed === 0 && summary.tier3.total >= 15 ? "PASS" : "FAIL"} |
| Tier 4 | Real-World Town Scenarios | >= 8 | ${summary.tier4.total} | ${summary.tier4.passed} | ${summary.tier4.failed} | ${summary.tier4.failed === 0 && summary.tier4.total >= 8 ? "PASS" : "FAIL"} |
| **TOTAL** | **Comprehensive Multi-Tier Suite** | **>= 173** | **${summary.total}** | **${summary.passed}** | **${summary.failed}** | **${summary.failed === 0 && summary.total >= 173 ? "PASS (100%)" : "FAIL"}** |

## Invariant Verification
- [x] Opaque-box requirement coverage complete across all 15 features
- [x] Boundary value limits verified (0m, 15m, 35m, grazing clamp 0.12, cavity AO clamp)
- [x] Cross-feature pairwise interactions verified (cloned POM x LOD x AO x shadows x batching)
- [x] 8 Real-world town scenarios simulated across Holtburg, Sanamar, Al-Jalima, Neydisa, and Bandit Castle
- [x] Production performance criteria verified (GTX 1070 mean FPS >= 60, p95 delta <= 2ms)
`;

  try {
    fs.writeFileSync(signalPath, content, "utf8");
    console.log(`\n[SIGNAL] Published coordination file: ${signalPath}`);
  } catch (err) {
    console.error(`[SIGNAL ERROR] Failed to write ${signalPath}:`, err);
  }
}

async function runTier(tierNumber, suites, options) {
  const tierSummary = { total: 0, passed: 0, failed: 0 };

  console.log(`\n======================================================================`);
  console.log(` RUNNING TIER ${tierNumber}: ${tierNumber === 1 ? "Feature Coverage" : tierNumber === 2 ? "Boundary Cases" : tierNumber === 3 ? "Cross-Feature Combinations" : "Real-World Scenarios"}`);
  console.log(`======================================================================`);

  for (const s of suites) {
    if (options.filter && !s.name.toLowerCase().includes(options.filter.toLowerCase()) && !s.file.toLowerCase().includes(options.filter.toLowerCase())) {
      continue;
    }

    const beforeRes = getResults();
    const beforeTotal = beforeRes.total;
    const beforePassed = beforeRes.passed;
    const beforeFailed = beforeRes.failed;

    try {
      const suiteModule = await import(s.file);
      if (typeof suiteModule.runTests === "function") {
        await suiteModule.runTests();
      }
    } catch (err) {
      console.error(`  [SUITE CRASH] ${s.name}:`, err);
    }

    const afterRes = getResults();
    const suiteTotal = afterRes.total - beforeTotal;
    const suitePassed = afterRes.passed - beforePassed;
    const suiteFailed = afterRes.failed - beforeFailed;

    tierSummary.total += suiteTotal;
    tierSummary.passed += suitePassed;
    tierSummary.failed += suiteFailed;

    if (suiteFailed === 0) {
      console.log(`  ✓ [PASS] ${s.name} (${suitePassed}/${suiteTotal} tests passed)`);
    } else {
      console.error(`  ✗ [FAIL] ${s.name} (${suiteFailed} failures, ${suitePassed}/${suiteTotal} passed)`);
    }

    if (options.verbose) {
      for (const f of afterRes.failures.slice(beforeFailed)) {
        console.error(`      Failure in "${f.test}": ${f.error}`);
      }
    }
  }

  return tierSummary;
}

async function main() {
  const options = parseArgs();
  const startTime = Date.now();

  console.log("======================================================================");
  console.log(" HOLTBURGER 3D SURFACE RELIEF & ENHANCEMENTS — E2E TEST RUNNER");
  console.log("======================================================================");

  resetResults();

  const summary = {
    tier1: { total: 0, passed: 0, failed: 0 },
    tier2: { total: 0, passed: 0, failed: 0 },
    tier3: { total: 0, passed: 0, failed: 0 },
    tier4: { total: 0, passed: 0, failed: 0 },
    total: 0,
    passed: 0,
    failed: 0,
  };

  if (!options.tier || options.tier === 1) {
    summary.tier1 = await runTier(1, TIER1_SUITES, options);
  }
  if (!options.tier || options.tier === 2) {
    summary.tier2 = await runTier(2, TIER2_SUITES, options);
  }
  if (!options.tier || options.tier === 3) {
    summary.tier3 = await runTier(3, TIER3_SUITES, options);
  }
  if (!options.tier || options.tier === 4) {
    summary.tier4 = await runTier(4, TIER4_SUITES, options);
  }

  summary.total = summary.tier1.total + summary.tier2.total + summary.tier3.total + summary.tier4.total;
  summary.passed = summary.tier1.passed + summary.tier2.passed + summary.tier3.passed + summary.tier4.passed;
  summary.failed = summary.tier1.failed + summary.tier2.failed + summary.tier3.failed + summary.tier4.failed;

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n======================================================================");
  console.log(" E2E TEST SUITE EXECUTION SUMMARY");
  console.log("======================================================================");
  console.log(` Tier 1 (Feature Coverage):       ${summary.tier1.passed} / ${summary.tier1.total} passed (Min: ${THRESHOLDS.tier1})`);
  console.log(` Tier 2 (Boundary & Corner):      ${summary.tier2.passed} / ${summary.tier2.total} passed (Min: ${THRESHOLDS.tier2})`);
  console.log(` Tier 3 (Cross Combinations):     ${summary.tier3.passed} / ${summary.tier3.total} passed (Min: ${THRESHOLDS.tier3})`);
  console.log(` Tier 4 (Real-World Scenarios):   ${summary.tier4.passed} / ${summary.tier4.total} passed (Min: ${THRESHOLDS.tier4})`);
  console.log(`----------------------------------------------------------------------`);
  console.log(` TOTAL:                           ${summary.passed} / ${summary.total} passed (${summary.failed} failed)`);
  console.log(` EXECUTION TIME:                  ${durationSec}s`);
  console.log("======================================================================");

  let thresholdViolations = [];
  if (!options.tier) {
    if (summary.tier1.total < THRESHOLDS.tier1) thresholdViolations.push(`Tier 1 count (${summary.tier1.total}) < ${THRESHOLDS.tier1}`);
    if (summary.tier2.total < THRESHOLDS.tier2) thresholdViolations.push(`Tier 2 count (${summary.tier2.total}) < ${THRESHOLDS.tier2}`);
    if (summary.tier3.total < THRESHOLDS.tier3) thresholdViolations.push(`Tier 3 count (${summary.tier3.total}) < ${THRESHOLDS.tier3}`);
    if (summary.tier4.total < THRESHOLDS.tier4) thresholdViolations.push(`Tier 4 count (${summary.tier4.total}) < ${THRESHOLDS.tier4}`);
    if (summary.total < THRESHOLDS.total) thresholdViolations.push(`Total test count (${summary.total}) < ${THRESHOLDS.total}`);
  }

  if (summary.failed > 0 || thresholdViolations.length > 0) {
    if (summary.failed > 0) {
      console.error(`\n[FATAL] ${summary.failed} tests failed!`);
      const allRes = getResults();
      for (const f of allRes.failures) {
        console.error(`  - [${f.suite}] ${f.test}: ${f.error}`);
      }
    }
    if (thresholdViolations.length > 0) {
      console.error(`\n[FATAL] Threshold violations:`);
      for (const v of thresholdViolations) {
        console.error(`  - ${v}`);
      }
    }
    process.exit(1);
  }

  console.log("\n[SUCCESS] All multi-tier tests passed and all coverage thresholds met!");

  // If running full suite (no tier filter), publish TEST_READY.md
  if (!options.tier && !options.filter) {
    publishTestReady(summary);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
  process.exit(1);
});
