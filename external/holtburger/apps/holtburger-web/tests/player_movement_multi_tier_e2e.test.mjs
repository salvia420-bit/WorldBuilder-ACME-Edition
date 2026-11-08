// apps/holtburger-web/tests/player_movement_multi_tier_e2e.test.mjs
// Master multi-tier E2E movement test suite bridge for headless runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_SCRIPT = path.resolve(__dirname, '../../../scripts/test-movement-e2e.cjs');

test('Holtburger-Web Player Movement System — Comprehensive 4-Tier E2E Test Suite (188 tests)', () => {
  const proc = spawnSync(process.execPath, [RUNNER_SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HB_MIN_FREE_MB: '1500' }
  });

  if (proc.status !== 0) {
    console.error('STDOUT:', proc.stdout);
    console.error('STDERR:', proc.stderr);
  }

  assert.equal(proc.status, 0, `Test runner failed with exit code ${proc.status}`);

  const report = JSON.parse(proc.stdout);
  assert.ok(report.totalTests >= 184, `Expected >= 184 tests, got ${report.totalTests}`);
  assert.equal(report.totalFailed, 0, `Expected 0 failures, got ${report.totalFailed}`);
  assert.equal(report.totalPassed, report.totalTests, 'All tests passed');

  // Verify tier thresholds
  assert.ok(report.tierBreakdown[1].passed >= 80, `Tier 1: ${report.tierBreakdown[1].passed}/80`);
  assert.ok(report.tierBreakdown[2].passed >= 80, `Tier 2: ${report.tierBreakdown[2].passed}/80`);
  assert.ok(report.tierBreakdown[3].passed >= 16, `Tier 3: ${report.tierBreakdown[3].passed}/16`);
  assert.ok(report.tierBreakdown[4].passed >= 8, `Tier 4: ${report.tierBreakdown[4].passed}/8`);
});
