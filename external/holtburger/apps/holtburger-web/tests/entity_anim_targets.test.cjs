// Animation targets T1/T2/T4/T6 (2026-06-02) — Node smoke test for the
// load-bearing contract logic of the entities-js animation fixes.
//
// Like emote_table.test.cjs / spellbook_wasm_record.test.cjs, we can't
// import scene3d/entities.js directly (it needs THREE + a DOM + the wasm
// exports). Instead we re-implement the small pure contracts under test
// here against the same shapes entities.js uses, and assert the retail-
// correct behavior. Keep these in sync with:
//   - scene3d/entities.js::_applyRampValueToMaterial      (T2)
//   - scene3d/entities.js CallPES jitter (~L6105 / ~L7354) (T6)
//   - scene3d/entities.js root.partFrames Proxy index-guard (T4)
//   - scene3d/entities.js::_resolveStateGroundSpeed + tick (T1)
//
// Run:
//   node tests/entity_anim_targets.test.cjs

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

// ─── T2: Transparent/TransparentPart inversion ─────────────────────────
// entities.js _applyRampValueToMaterial for hookType 20/7. The hook VALUE
// is TRANSLUCENCY (0=opaque, 1=invisible); retail SetTranslucencySimple
// (acclient.c:360598) sets alpha = 1 - trans. Returns {opacity, transparent}.
function applyTransparentRamp(value) {
  return { opacity: 1 - value, transparent: value > 0 };
}

check("T2: translucency 0 → fully opaque, fast opaque path", () => {
  const m = applyTransparentRamp(0);
  assert.equal(m.opacity, 1, "trans=0 must be opacity 1 (opaque)");
  assert.equal(m.transparent, false, "trans=0 stays on the opaque fast path");
});

check("T2: translucency 1 → invisible", () => {
  const m = applyTransparentRamp(1);
  assert.equal(m.opacity, 0, "trans=1 must be opacity 0 (invisible) — retail fade-OUT");
  assert.equal(m.transparent, true);
});

check("T2: translucency ramp 0→1 FADES OUT (opacity decreases)", () => {
  // The pre-fix bug faded IN (opacity = value). Confirm the corrected
  // direction: as translucency rises, opacity must fall.
  const a = applyTransparentRamp(0.25).opacity;
  const b = applyTransparentRamp(0.75).opacity;
  assert.ok(a > b, `opacity must decrease as translucency rises (got ${a} then ${b})`);
  assert.equal(applyTransparentRamp(0.4).opacity, 0.6);
});

// ─── T6: CallPES randomized delay window ───────────────────────────────
// Retail rolls RollDice(0, pause) — a UNIFORM random in [0, pause] — and
// fires immediately when pause < 0.0002. `start_time` is additive.
function callPesRandPause(pauseW, rngVal) {
  return pauseW < 0.0002 ? 0 : rngVal * pauseW;
}
function callPesDelayMs(startTime, pauseW, rngVal) {
  const randPause = callPesRandPause(pauseW, rngVal);
  return Math.max(0, ((startTime || 0) + randPause) * 1000);
}

check("T6: rand pause is within [0, pause]", () => {
  assert.equal(callPesRandPause(2.0, 0.0), 0.0, "rng=0 → 0");
  assert.equal(callPesRandPause(2.0, 0.5), 1.0, "rng=0.5, pause=2 → 1.0");
  // rng() is [0,1); the upper bound approaches but never reaches pause.
  assert.ok(callPesRandPause(2.0, 0.999) < 2.0);
});

check("T6: pause below 0.0002 fires immediately (no jitter)", () => {
  assert.equal(callPesRandPause(0.0001, 0.9), 0, "sub-epsilon window → fire now");
  assert.equal(callPesRandPause(0, 0.9), 0);
});

check("T6: start_time is additive to the rolled window", () => {
  // delay = (start_time + RollDice(0,pause)) * 1000ms
  assert.equal(callPesDelayMs(0.1, 2.0, 0.5), (0.1 + 1.0) * 1000);
  assert.equal(callPesDelayMs(0, 2.0, 0.5), 1000);
});

// ─── T4: partFrames Proxy index-guard ──────────────────────────────────
// root.partFrames[i] resolves only valid integer indices in [0, parts.len);
// everything else (negative, OOB, non-integer, method names) → undefined so
// the consumer's `&& partFrames[i]` guard falls back to root anchoring.
function partFramesIndexValid(prop, partsLen) {
  const idx = typeof prop === 'string' ? Number(prop) : NaN;
  return Number.isInteger(idx) && idx >= 0 && idx < partsLen;
}

check("T4: valid in-range integer index resolves", () => {
  assert.equal(partFramesIndexValid('0', 4), true);
  assert.equal(partFramesIndexValid('3', 4), true);
});

check("T4: out-of-range / negative index falls back (root anchor)", () => {
  assert.equal(partFramesIndexValid('4', 4), false, "idx == len is OOB");
  assert.equal(partFramesIndexValid('-1', 4), false, "negative is root-handled upstream");
  assert.equal(partFramesIndexValid('99', 4), false);
});

check("T4: non-integer / method-name props do not resolve a frame", () => {
  assert.equal(partFramesIndexValid('1.5', 4), false);
  assert.equal(partFramesIndexValid('map', 4), false);
  assert.equal(partFramesIndexValid('length', 4), false);
});

// ─── T1: actual-speed source selection (getter vs EMA fallback) ────────
// tick() prefers the wasm stateGroundSpeed getter; falls back to the EMA
// only when the getter is absent/null or returns a non-positive value.
function pickActualSpeed(getterResult, emaSpeed) {
  let actual = getterResult;
  if (!(Number.isFinite(actual) && actual > 0)) {
    actual = emaSpeed ?? 0;
  }
  return actual;
}

// Mirror of _resolveStateGroundSpeed's stash-presence gate + result clamp.
function resolveStateGroundSpeed(inst, getterFn, runRateFn) {
  if (typeof getterFn !== 'function') return null;
  const fwdCmd = inst.forwardCommand >>> 0;
  const sideCmd = inst.sidestepCommand >>> 0;
  if (fwdCmd === 0 && sideCmd === 0) return null; // nothing stashed yet
  const fwdSpeed = Number.isFinite(inst.forwardSpeed) ? inst.forwardSpeed : 0;
  const sideSpeed = Number.isFinite(inst.sidestepSpeed) ? inst.sidestepSpeed : 0;
  let runRate = 1.0;
  if (typeof runRateFn === 'function') {
    const rr = +runRateFn();
    if (Number.isFinite(rr) && rr > 0) runRate = rr;
  }
  const v = +getterFn(fwdCmd, fwdSpeed, sideCmd, sideSpeed, runRate);
  return Number.isFinite(v) && v > 0 ? v : null;
}

check("T1: positive getter result wins over EMA", () => {
  assert.equal(pickActualSpeed(3.5, 0.2), 3.5, "getter present → use it");
});

check("T1: null/0/negative getter result falls back to EMA", () => {
  assert.equal(pickActualSpeed(null, 0.7), 0.7);
  assert.equal(pickActualSpeed(0, 0.7), 0.7);
  assert.equal(pickActualSpeed(-1, 0.7), 0.7);
  assert.equal(pickActualSpeed(NaN, 0.7), 0.7);
});

check("T1: no stashed command → getter returns null (EMA covers gap)", () => {
  const got = resolveStateGroundSpeed(
    { forwardCommand: 0, sidestepCommand: 0 },
    () => 4.0,
  );
  assert.equal(got, null, "idle/just-spawned defers to EMA");
});

check("T1: forward command stashed → getter is consulted with run_rate", () => {
  let seenArgs = null;
  const got = resolveStateGroundSpeed(
    { forwardCommand: 0x44000007 >>> 0, forwardSpeed: 1.0, sidestepCommand: 0, sidestepSpeed: 0 },
    (...a) => { seenArgs = a; return 4.0; },
    () => 1.0,
  );
  assert.equal(got, 4.0);
  // RunForward(0x44000007) × 1.0 × run_rate 1.0 = 4.0 m/s (RunAnimSpeed).
  assert.deepEqual(seenArgs, [0x44000007 >>> 0, 1.0, 0, 0, 1.0]);
});

check("T1: absent getter → null (legacy EMA-only path preserved)", () => {
  const got = resolveStateGroundSpeed(
    { forwardCommand: 0x44000007 >>> 0, forwardSpeed: 1.0, sidestepCommand: 0, sidestepSpeed: 0 },
    undefined,
  );
  assert.equal(got, null);
});

check("T1: JS does NOT re-scale by run_rate (getter result used as-is)", () => {
  // The contract: stateGroundSpeed applies run_rate INTERNALLY; JS must feed
  // the raw result into cycleTimeScale. pickActualSpeed must not multiply.
  assert.equal(pickActualSpeed(7.2, 0.0), 7.2);
});

// ─── Roll-up ───────────────────────────────────────────────────────────

console.log(`\n[entity_anim_targets.test.cjs] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  ${f.name}: ${f.err.stack || f.err}`);
  process.exit(1);
}
