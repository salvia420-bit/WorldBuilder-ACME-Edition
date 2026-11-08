#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-movement-adversarial-m4-2.cjs
 *
 * Tier 5 White-Box Adversarial Hardening & Stress Testing Runner — Milestone 4
 * Features 28–37, 39: Velocity-to-playback scaling, foot synchrony,
 * 2-hop stance routing under rapid FIFO swaps, jump/landing slope links, and browser in-client execution.
 *
 * Author: movement_challenger_m4_2
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const testFile = path.resolve(repoRoot, 'apps/holtburger-web/tests/challenger_m4_2_stress.test.mjs');

console.log('======================================================================');
console.log('  MOVEMENT CHALLENGER M4-2: TIER 5 EMPIRICAL ADVERSARIAL STRESS SUITE');
console.log('======================================================================\n');
console.log(`Executing: node ${testFile}\n`);

const res = spawnSync(process.execPath, [testFile], {
  cwd: path.resolve(repoRoot, 'apps/holtburger-web'),
  stdio: 'inherit',
  env: process.env,
});

if (res.status !== 0) {
  console.error('\n>>> CHALLENGER M4-2 STRESS TESTS FAILED! <<<');
  process.exit(res.status || 1);
} else {
  console.log('\n>>> ALL 13/13 CHALLENGER M4-2 ADVERSARIAL STRESS TESTS PASSED! <<<\n');
  process.exit(0);
}
