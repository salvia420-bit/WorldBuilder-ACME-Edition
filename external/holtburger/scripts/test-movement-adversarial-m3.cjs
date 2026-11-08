#!/usr/bin/env node
/**
 * external/holtburger/scripts/test-movement-adversarial-m3.cjs
 *
 * Empirical Adversarial Challenger Verification Suite for Milestone 3
 * Features 28, 29, 30: Velocity-to-Playback Scaling, Invariant Foot Synchrony,
 * Canonical Locomotion Playback, Deceleration Coasting Foot-Slide Suppression
 *
 * Author: movement_challenger_m3_1
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const testFile = path.resolve(repoRoot, 'apps/holtburger-web/tests/challenger_m3_stress.test.mjs');

console.log('======================================================================');
console.log('  MOVEMENT CHALLENGER M3: EMPIRICAL ADVERSARIAL STRESS TEST SUITE');
console.log('======================================================================\n');
console.log(`Executing: node ${testFile}\n`);

const res = spawnSync(process.execPath, [testFile], {
  cwd: path.resolve(repoRoot, 'apps/holtburger-web'),
  stdio: 'inherit',
  env: process.env,
});

if (res.status !== 0) {
  console.error('\n>>> CHALLENGER M3 STRESS TESTS FAILED! <<<');
  process.exit(res.status || 1);
} else {
  console.log('\n>>> ALL 13/13 CHALLENGER M3 ADVERSARIAL STRESS TESTS PASSED! <<<\n');
  process.exit(0);
}
