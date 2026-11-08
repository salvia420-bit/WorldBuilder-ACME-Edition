#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-movement-e2e.cjs
 * Comprehensive E2E Multi-Tier Test Runner for Holtburger-Web Player Movement System.
 *
 * Runs all 4 test tiers:
 *   - Tier 1: Feature Coverage (>=80 tests across 16 movement features)
 *   - Tier 2: Boundary & Corner Cases (>=80 tests across 16 movement features)
 *   - Tier 3: Cross-Feature Combinations (>=16 tests)
 *   - Tier 4: Real-World Locomotion Scenarios (>=8 realistic application scenarios)
 *   - Total: >= 184 tests!
 *
 * Usage:
 *   node external/holtburger/scripts/test-movement-e2e.cjs [--tier=1|2|3|4] [--verbose] [--json] [--filter=<pattern>]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveRoot() {
  const candidates = [
    path.resolve('/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger'),
    path.resolve('/home/wbterminal/external/holtburger'),
    path.resolve(__dirname, '..'),
    path.resolve(process.cwd(), 'external/holtburger'),
    path.resolve(process.cwd())
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'tests/e2e/movement'))) {
      return c;
    }
  }
  return candidates[0];
}

const ROOT = resolveRoot();
const TESTS_ROOT = path.join(ROOT, 'tests/e2e/movement');

// Authoritative thresholds defined in TEST_INFRA.md
const THRESHOLDS = {
  tier1: 80,
  tier2: 80,
  tier3: 16,
  tier4: 8,
  total: 184
};

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tier: null,
    verbose: false,
    json: false,
    filter: null
  };

  for (const arg of args) {
    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--tier=')) {
      options.tier = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--filter=')) {
      options.filter = new RegExp(arg.split('=')[1], 'i');
    }
  }
  return options;
}

function discoverTestFiles(targetTier = null) {
  const tierDirs = [
    { tier: 1, dirName: 'tier1_features', label: 'Tier 1: Feature Coverage (16 features)' },
    { tier: 2, dirName: 'tier2_boundaries', label: 'Tier 2: Boundary & Corner Cases (16 features)' },
    { tier: 3, dirName: 'tier3_combinations', label: 'Tier 3: Cross-Feature Combinations' },
    { tier: 4, dirName: 'tier4_scenarios', label: 'Tier 4: Real-World Locomotion Scenarios' },
  ];

  const filesByTier = { 1: [], 2: [], 3: [], 4: [] };

  for (const t of tierDirs) {
    if (targetTier !== null && t.tier !== targetTier) continue;
    const fullDir = path.join(TESTS_ROOT, t.dirName);
    if (!fs.existsSync(fullDir)) continue;

    const entries = fs.readdirSync(fullDir)
      .filter(f => f.endsWith('.test.cjs') || f.endsWith('.test.js') || f.endsWith('.test.mjs'))
      .sort();

    for (const f of entries) {
      filesByTier[t.tier].push({
        tier: t.tier,
        fileName: f,
        fullPath: path.join(fullDir, f),
        tierLabel: t.label
      });
    }
  }
  return filesByTier;
}

async function run() {
  const options = parseArgs();
  const startTime = Date.now();

  const filesByTier = discoverTestFiles(options.tier);

  const report = {
    timestamp: new Date().toISOString(),
    totalSuites: 0,
    totalTests: 0,
    totalPassed: 0,
    totalFailed: 0,
    durationMs: 0,
    tierBreakdown: {
      1: { name: 'Tier 1: Feature Coverage', tests: 0, passed: 0, failed: 0, suites: 0 },
      2: { name: 'Tier 2: Boundary & Corner Cases', tests: 0, passed: 0, failed: 0, suites: 0 },
      3: { name: 'Tier 3: Cross-Feature Combinations', tests: 0, passed: 0, failed: 0, suites: 0 },
      4: { name: 'Tier 4: Real-World Locomotion Scenarios', tests: 0, passed: 0, failed: 0, suites: 0 },
    },
    thresholdsSatisfied: {},
    failures: []
  };

  if (!options.json) {
    console.log('======================================================================');
    console.log('    HOLTBURGER-WEB PLAYER MOVEMENT SYSTEM — MULTI-TIER E2E TEST RUNNER');
    console.log('======================================================================');
    console.log(`Root: ${ROOT}`);
    console.log(`Tests: ${TESTS_ROOT}`);
    if (options.tier) console.log(`Filter: Tier ${options.tier} only`);
    if (options.filter) console.log(`Filter regex: ${options.filter}`);
    console.log('----------------------------------------------------------------------\n');
  }

  for (let tierNum = 1; tierNum <= 4; tierNum++) {
    const tierFiles = filesByTier[tierNum];
    if (tierFiles.length === 0) continue;

    const tierInfo = report.tierBreakdown[tierNum];
    if (!options.json) {
      console.log(`\n>>> [TIER ${tierNum}] ${tierInfo.name} (${tierFiles.length} suites) <<<`);
    }

    for (const fileInfo of tierFiles) {
      if (options.filter && !options.filter.test(fileInfo.fileName)) {
        continue;
      }

      let suiteModule;
      try {
        suiteModule = require(fileInfo.fullPath);
      } catch (err) {
        console.error(`  [ERROR] Failed to load ${fileInfo.fileName}: ${err.message}`);
        report.failures.push({
          suite: fileInfo.fileName,
          tier: tierNum,
          error: `Require error: ${err.message}`
        });
        report.totalFailed++;
        tierInfo.failed++;
        continue;
      }

      if (suiteModule && typeof suiteModule.run === 'function') {
        const suiteRes = await suiteModule.run({ verbose: options.verbose });
        report.totalSuites++;
        tierInfo.suites++;
        tierInfo.tests += suiteRes.tests.length;
        tierInfo.passed += suiteRes.passed;
        tierInfo.failed += suiteRes.failed;

        report.totalTests += suiteRes.tests.length;
        report.totalPassed += suiteRes.passed;
        report.totalFailed += suiteRes.failed;

        if (!options.json) {
          const statusIcon = suiteRes.failed === 0 ? '✓ PASS' : '✗ FAIL';
          console.log(`  [${statusIcon}] ${fileInfo.fileName} (${suiteRes.passed}/${suiteRes.tests.length} passed, ${suiteRes.durationMs}ms)`);
        }

        if (suiteRes.failed > 0) {
          for (const t of suiteRes.tests) {
            if (t.status === 'failed') {
              report.failures.push({
                suite: fileInfo.fileName,
                tier: tierNum,
                test: t.name,
                error: t.error,
                stack: t.stack
              });
            }
          }
        }
      }
    }
  }

  report.durationMs = Date.now() - startTime;

  report.thresholdsSatisfied = {
    tier1: options.tier && options.tier !== 1 ? true : report.tierBreakdown[1].passed >= THRESHOLDS.tier1,
    tier2: options.tier && options.tier !== 2 ? true : report.tierBreakdown[2].passed >= THRESHOLDS.tier2,
    tier3: options.tier && options.tier !== 3 ? true : report.tierBreakdown[3].passed >= THRESHOLDS.tier3,
    tier4: options.tier && options.tier !== 4 ? true : report.tierBreakdown[4].passed >= THRESHOLDS.tier4,
    total: options.tier ? true : report.totalPassed >= THRESHOLDS.total
  };

  const allThresholdsMet = Object.values(report.thresholdsSatisfied).every(Boolean);
  const success = report.totalFailed === 0 && allThresholdsMet;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n======================================================================');
    console.log('                          TEST SUITE SUMMARY');
    console.log('======================================================================');
    for (let t = 1; t <= 4; t++) {
      if (options.tier && options.tier !== t) continue;
      const b = report.tierBreakdown[t];
      const threshold = THRESHOLDS[`tier${t}`];
      const met = b.passed >= threshold ? 'MET' : 'UNMET';
      console.log(`  Tier ${t}: ${b.passed}/${b.tests} passed (Threshold >= ${threshold}: [${met}])`);
    }
    console.log('----------------------------------------------------------------------');
    console.log(`  Total Suites:   ${report.totalSuites}`);
    console.log(`  Total Tests:    ${report.totalTests}`);
    console.log(`  Passed Tests:   ${report.totalPassed}`);
    console.log(`  Failed Tests:   ${report.totalFailed}`);
    console.log(`  Total Threshold: >= ${THRESHOLDS.total} (${report.totalPassed >= THRESHOLDS.total ? 'MET' : 'UNMET'})`);
    console.log(`  Duration:       ${(report.durationMs / 1000).toFixed(2)}s`);
    console.log('======================================================================');

    if (report.failures.length > 0) {
      console.log('\nFAILURES SUMMARY:');
      for (const f of report.failures) {
        console.log(`  - [Tier ${f.tier}] ${f.suite} > ${f.test || ''}`);
        console.log(`    Error: ${f.error}`);
      }
      console.log('======================================================================');
    }

    if (success) {
      console.log('\n>>> OVERALL RESULT: SUCCESS (All movement tests passed & thresholds met) <<<\n');
    } else {
      console.log('\n>>> OVERALL RESULT: FAILURE <<<\n');
    }
  }

  process.exit(success ? 0 : 1);
}

run().catch(err => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
