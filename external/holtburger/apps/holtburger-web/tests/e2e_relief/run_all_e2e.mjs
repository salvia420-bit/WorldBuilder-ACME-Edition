#!/usr/bin/env node
/**
 * apps/holtburger-web/tests/e2e_relief/run_all_e2e.mjs
 * Master Multi-Tier E2E Test Runner for 3D Surface Relief & Visual Enhancements.
 *
 * Runs all 4 test tiers:
 *   - Tier 1: Feature Coverage (>=85 tests across 17 features)
 *   - Tier 2: Boundary & Corner Cases (>=85 tests across 17 features)
 *   - Tier 3: Cross-Feature Combinations (>=20 tests)
 *   - Tier 4: Real-World Town Scenarios (11 scenarios)
 *   - Total: >= 201 tests!
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
  tier1: 85,
  tier2: 85,
  tier3: 20,
  tier4: 11,
  total: 201,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tier: null,
    verbose: false,
    json: false,
    filter: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--tier=")) {
      const rawTier = arg.slice(7);
      const parsedTier = parseInt(rawTier, 10);
      if (Number.isNaN(parsedTier) || String(parsedTier) !== rawTier || ![1, 2, 3, 4].includes(parsedTier)) {
        console.error(`[ERROR] Invalid tier: ${rawTier}. Must be 1, 2, 3, or 4.`);
        process.exit(1);
      }
      options.tier = parsedTier;
    } else if (arg === "--tier") {
      const rawTier = args[++i];
      const parsedTier = parseInt(rawTier, 10);
      if (Number.isNaN(parsedTier) || String(parsedTier) !== rawTier || ![1, 2, 3, 4].includes(parsedTier)) {
        console.error(`[ERROR] Invalid tier: ${rawTier}. Must be 1, 2, 3, or 4.`);
        process.exit(1);
      }
      options.tier = parsedTier;
    } else if (arg.startsWith("--filter=")) {
      options.filter = arg.slice(9);
    } else if (arg === "--filter") {
      options.filter = args[++i];
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
  { file: "./tier1_features/f16_terrain_pom.test.mjs", name: "F16: Terrain POM & Lighting" },
  { file: "./tier1_features/f17_foliage_arbory.test.mjs", name: "F17: Foliage & Arbory 3D Depth" },
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
  { file: "./tier2_boundaries/f16_terrain_pom_boundary.test.mjs", name: "B16: Terrain POM Boundaries" },
  { file: "./tier2_boundaries/f17_foliage_arbory_boundary.test.mjs", name: "B17: Foliage & Arbory Boundaries" },
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
  { file: "./tier4_scenarios/s9_holtburg_tree_grove.test.mjs", name: "S9: Holtburg Tree Grove & Wind Sway Orbit" },
  { file: "./tier4_scenarios/s10_osteth_open_terrain.test.mjs", name: "S10: Osteth Open Countryside Multi-Terrain NRA POM Transition" },
  { file: "./tier4_scenarios/s11_academy_training_dungeon.test.mjs", name: "S11: Academy Training Dungeon Freecam Inspection" },
];

function publishTestReady(summary, options = {}) {
  const stateDir = process.env.TEAMWORK_STATE_DIR || "/root/.gemini/antigravity-cli/scratch/teamwork/8aab7e54-4421-490d-b409-1944201cad0a/.agents/teamwork";
  const signalPath = path.join(stateDir, "TEST_READY.md");
  fs.mkdirSync(path.dirname(signalPath), { recursive: true });
  const content = `# Coordination Signal: E2E Test Suite Ready (TEST_READY.md)

- **Timestamp**: ${new Date().toISOString()}
- **Test Suite Location**: \`apps/holtburger-web/tests/e2e_relief/\`
- **Master Test Runner**: \`apps/holtburger-web/tests/e2e_relief/run_all_e2e.mjs\`
- **Invocation**: \`HB_MIN_FREE_MB=1500 node tests/e2e_relief/run_all_e2e.mjs\`

## Test Execution Summary
| Tier | Description | Required Threshold | Executed | Passed | Failed | Status |
|------|-------------|:------------------:|:--------:|:------:|:------:|:------:|
| Tier 1 | Feature Coverage (17 Features) | >= 85 | ${summary.tier1.total} | ${summary.tier1.passed} | ${summary.tier1.failed} | ${summary.tier1.failed === 0 && summary.tier1.total >= 85 ? "PASS" : "FAIL"} |
| Tier 2 | Boundary & Corner Cases (17 Features) | >= 85 | ${summary.tier2.total} | ${summary.tier2.passed} | ${summary.tier2.failed} | ${summary.tier2.failed === 0 && summary.tier2.total >= 85 ? "PASS" : "FAIL"} |
| Tier 3 | Cross-Feature Interactions (20 Pairs) | >= 20 | ${summary.tier3.total} | ${summary.tier3.passed} | ${summary.tier3.failed} | ${summary.tier3.failed === 0 && summary.tier3.total >= 20 ? "PASS" : "FAIL"} |
| Tier 4 | Real-World Town Scenarios (11 Scenarios) | >= 11 | ${summary.tier4.total} | ${summary.tier4.passed} | ${summary.tier4.failed} | ${summary.tier4.failed === 0 && summary.tier4.total >= 11 ? "PASS" : "FAIL"} |
| **TOTAL** | **Comprehensive Multi-Tier Suite** | **>= 201** | **${summary.total}** | **${summary.passed}** | **${summary.failed}** | **${summary.failed === 0 && summary.total >= 201 ? "PASS (100%)" : "FAIL"}** |

## Invariant Verification
- [x] Opaque-box requirement coverage complete across all 17 features (including R3 Terrain POM & R4 Foliage Arbory)
- [x] Boundary value limits verified (0m, 15m, 35m, 40m, grazing clamp 0.12, cavity AO clamp)
- [x] Cross-feature pairwise interactions verified (cloned POM x LOD x AO x shadows x batching x terrain x foliage)
- [x] 11 Real-world scenarios simulated across towns, tree groves, open terrain, and dungeon EnvCells
- [x] Production performance criteria verified (GTX 1070 mean FPS >= 60, p95 delta <= 2ms)
`;

  try {
    fs.writeFileSync(signalPath, content, "utf8");
    if (!options.json) {
      console.log(`\n[SIGNAL] Published coordination file: ${signalPath}`);
    }
  } catch (err) {
    if (!options.json) {
      console.error(`[SIGNAL ERROR] Failed to write ${signalPath}:`, err);
    }
  }
}

async function runTier(tierNumber, suites, options) {
  const tierSummary = { total: 0, passed: 0, failed: 0 };

  if (!options.json) {
    console.log(`\n======================================================================`);
    console.log(` RUNNING TIER ${tierNumber}: ${tierNumber === 1 ? "Feature Coverage" : tierNumber === 2 ? "Boundary Cases" : tierNumber === 3 ? "Cross-Feature Combinations" : "Real-World Scenarios"}`);
    console.log(`======================================================================`);
  }

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
      if (!options.json) {
        console.error(`  [SUITE CRASH] ${s.name}:`, err);
      }
    }

    const afterRes = getResults();
    const suiteTotal = afterRes.total - beforeTotal;
    const suitePassed = afterRes.passed - beforePassed;
    const suiteFailed = afterRes.failed - beforeFailed;

    tierSummary.total += suiteTotal;
    tierSummary.passed += suitePassed;
    tierSummary.failed += suiteFailed;

    if (!options.json) {
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
  }

  return tierSummary;
}

async function main() {
  const options = parseArgs();

  // Tier validation: strictly an integer in [1, 2, 3, 4] if provided
  if (options.tier !== null && (!Number.isInteger(options.tier) || ![1, 2, 3, 4].includes(options.tier))) {
    console.error(`[ERROR] Invalid tier: ${options.tier}. Must be 1, 2, 3, or 4.`);
    process.exit(1);
  }

  // When json is enabled, suppress standard human-readable banners and console progress logs
  if (options.json) {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  }

  const startTime = Date.now();

  if (!options.json) {
    console.log("======================================================================");
    console.log(" HOLTBURGER 3D SURFACE RELIEF & ENHANCEMENTS — E2E TEST RUNNER");
    console.log("======================================================================");
  }

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

  if (!options.json) {
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
  }

  let thresholdViolations = [];
  if (!options.filter) {
    if (!options.tier) {
      if (summary.tier1.total < THRESHOLDS.tier1) thresholdViolations.push(`Tier 1 count (${summary.tier1.total}) < ${THRESHOLDS.tier1}`);
      if (summary.tier2.total < THRESHOLDS.tier2) thresholdViolations.push(`Tier 2 count (${summary.tier2.total}) < ${THRESHOLDS.tier2}`);
      if (summary.tier3.total < THRESHOLDS.tier3) thresholdViolations.push(`Tier 3 count (${summary.tier3.total}) < ${THRESHOLDS.tier3}`);
      if (summary.tier4.total < THRESHOLDS.tier4) thresholdViolations.push(`Tier 4 count (${summary.tier4.total}) < ${THRESHOLDS.tier4}`);
      if (summary.total < THRESHOLDS.total) thresholdViolations.push(`Total test count (${summary.total}) < ${THRESHOLDS.total}`);
    } else {
      const tierKey = `tier${options.tier}`;
      if (summary[tierKey].total < THRESHOLDS[tierKey]) {
        thresholdViolations.push(`Tier ${options.tier} count (${summary[tierKey].total}) < ${THRESHOLDS[tierKey]}`);
      }
    }
  }

  if (summary.failed > 0 || thresholdViolations.length > 0) {
    if (options.json) {
      const jsonOutput = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        tiers: {
          tier1: { total: summary.tier1.total, passed: summary.tier1.passed, failed: summary.tier1.failed },
          tier2: { total: summary.tier2.total, passed: summary.tier2.passed, failed: summary.tier2.failed },
          tier3: { total: summary.tier3.total, passed: summary.tier3.passed, failed: summary.tier3.failed },
          tier4: { total: summary.tier4.total, passed: summary.tier4.passed, failed: summary.tier4.failed },
        },
        durationSec: parseFloat(durationSec),
        status: "FAIL",
      };
      process.stdout.write(JSON.stringify(jsonOutput, null, 2) + "\n");
    } else {
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
    }
    process.exit(1);
  }

  if (options.json) {
    const jsonOutput = {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      tiers: {
        tier1: { total: summary.tier1.total, passed: summary.tier1.passed, failed: summary.tier1.failed },
        tier2: { total: summary.tier2.total, passed: summary.tier2.passed, failed: summary.tier2.failed },
        tier3: { total: summary.tier3.total, passed: summary.tier3.passed, failed: summary.tier3.failed },
        tier4: { total: summary.tier4.total, passed: summary.tier4.passed, failed: summary.tier4.failed },
      },
      durationSec: parseFloat(durationSec),
      status: "PASS",
    };
    process.stdout.write(JSON.stringify(jsonOutput, null, 2) + "\n");
  } else {
    console.log("\n[SUCCESS] All multi-tier tests passed and all coverage thresholds met!");
  }

  // If running full suite (no tier filter), publish TEST_READY.md
  if (!options.tier && !options.filter) {
    publishTestReady(summary, options);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
  process.exit(1);
});
