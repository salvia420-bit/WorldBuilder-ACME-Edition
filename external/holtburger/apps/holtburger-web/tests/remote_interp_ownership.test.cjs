// A2-P2 (2026-06-12, W3+ S8, ?remoteInterp=on) — Node smoke test for the
// remote-pose driver's JS ownership contracts.
//
// Like entity_anim_targets.test.cjs, we can't import scene3d/entities.js
// directly (it needs THREE + a DOM + the wasm exports). We re-implement the
// small pure contracts under test here against the same shapes entities.js
// uses, and assert the spec'd behavior. Keep these in sync with:
//   - scene3d/entities.js::applyManagedPose          (skip rules)
//   - scene3d/entities.js::tick wasmDriven countdown (ease-skip + decay)
//   - scene3d/loop.js::drainRemotePoses              (row → world math)
//
// Run:
//   node tests/remote_interp_ownership.test.cjs

'use strict';

const assert = require('node:assert/strict');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const REMOTE_INTERP_OWNERSHIP_FRAMES = 30; // entities.js constant

// ─── applyManagedPose skip rules (entities.js::applyManagedPose) ────────
// Returns true when the managed pose is APPLIED (ownership armed).
function applyManagedPoseContract({ remoteInterpOn, isLocal, inst }) {
  if (!remoteInterpOn) return false;
  if (isLocal) return false;
  if (!inst || !inst.root) return false;
  if (inst._ballistic) return false; // F3-1/G-4 projectile owns motion
  if (inst._stickyTarget) return false; // F3-4 glue owns position (P3 scope)
  inst._wasmDriven = REMOTE_INTERP_OWNERSHIP_FRAMES;
  return true;
}

check('applyManagedPose: plain remote entity is applied + armed', () => {
  const inst = { root: {} };
  assert.equal(
    applyManagedPoseContract({ remoteInterpOn: true, isLocal: false, inst }),
    true
  );
  assert.equal(inst._wasmDriven, REMOTE_INTERP_OWNERSHIP_FRAMES);
});

check('applyManagedPose: flag off → never applied', () => {
  const inst = { root: {} };
  assert.equal(
    applyManagedPoseContract({ remoteInterpOn: false, isLocal: false, inst }),
    false
  );
  assert.equal(inst._wasmDriven, undefined);
});

check('applyManagedPose: local guid skipped (defense; loop.js also skips)', () => {
  const inst = { root: {} };
  assert.equal(
    applyManagedPoseContract({ remoteInterpOn: true, isLocal: true, inst }),
    false
  );
});

check('applyManagedPose: _ballistic projectile skipped (F3-1 ownership)', () => {
  const inst = { root: {}, _ballistic: true };
  assert.equal(
    applyManagedPoseContract({ remoteInterpOn: true, isLocal: false, inst }),
    false
  );
});

check('applyManagedPose: _stickyTarget skipped (F3-4 glue until A2-P3)', () => {
  const inst = { root: {}, _stickyTarget: 0x70001234 };
  assert.equal(
    applyManagedPoseContract({ remoteInterpOn: true, isLocal: false, inst }),
    false
  );
});

// ─── tick ownership countdown (entities.js::tick) ───────────────────────
// Mirrors: const wasmDriven = (inst._wasmDriven | 0) > 0;
//          if (wasmDriven) inst._wasmDriven -= 1;
// Ease runs only when `!wasmDriven` (one added conjunct on the R3.A gate).
function tickOwnershipContract(inst) {
  const wasmDriven = (inst._wasmDriven | 0) > 0;
  if (wasmDriven) inst._wasmDriven -= 1;
  return { easeSkipped: wasmDriven };
}

check('tick: ease skipped while armed; resumes after 30 idle frames', () => {
  const inst = { _wasmDriven: REMOTE_INTERP_OWNERSHIP_FRAMES };
  let skippedFrames = 0;
  for (let i = 0; i < 40; i++) {
    if (tickOwnershipContract(inst).easeSkipped) skippedFrames += 1;
  }
  assert.equal(skippedFrames, 30, 'exactly 30 frames of ownership');
  assert.equal(tickOwnershipContract(inst).easeSkipped, false, 'legacy resumes');
});

check('tick: fresh managed rows re-arm the countdown mid-decay', () => {
  const inst = { root: {} };
  applyManagedPoseContract({ remoteInterpOn: true, isLocal: false, inst });
  for (let i = 0; i < 10; i++) tickOwnershipContract(inst);
  assert.equal(inst._wasmDriven, 20);
  applyManagedPoseContract({ remoteInterpOn: true, isLocal: false, inst });
  assert.equal(inst._wasmDriven, REMOTE_INTERP_OWNERSHIP_FRAMES, 're-armed');
});

check('tick: never-armed entity is inert ((undefined | 0) === 0)', () => {
  const inst = {};
  assert.equal(tickOwnershipContract(inst).easeSkipped, false);
  assert.equal(inst._wasmDriven, undefined, 'no property materialized');
});

// ─── loop.js drainRemotePoses row math (the KIND_POSITION drain math) ───
function rowToWorld(lb, x, y) {
  return {
    wx: ((lb >>> 24) & 0xff) * 192.0 + x,
    wy: ((lb >>> 16) & 0xff) * 192.0 + y,
  };
}

check('drainRemotePoses: landblock-local → world matches KIND_POSITION math', () => {
  // 0xA9B4xxxx → lbX = 0xA9 = 169, lbY = 0xB4 = 180.
  const { wx, wy } = rowToWorld(0xa9b40000, 12.5, 100.25);
  assert.equal(wx, 169 * 192 + 12.5);
  assert.equal(wy, 180 * 192 + 100.25);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, err } of failures) console.error(`${name}: ${err.stack}`);
  process.exit(1);
}
