// A14-I4 (2026-06-12, W3+ S11, ?jumpParity=on) — Node smoke test for the
// jump-parity JS routing contracts.
//
// Like remote_interp_ownership.test.cjs, we can't import index.html's
// inline module directly (it needs a DOM + the wasm handle). We
// re-implement the small pure routing contracts under test here against
// the same shapes index.html uses, and assert the spec'd behavior. Keep
// these in sync with:
//   - index.html jumpParityActive()        (flag + 4-export typeof guard)
//   - index.html keydown space handler     (parity → jumpChargeCommence,
//                                           legacy → __jumpKeydownTs stamp)
//   - index.html keyup space handler       (parity → jumpChargeRelease and
//                                           NEVER jump(power); legacy →
//                                           jump(power) with the JS curve)
// Plus static source assertions that pin the load-bearing strings in
// index.html itself.
//
// Run:
//   node tests/jump_charge_parity.test.cjs

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

const JUMP_POWER_FULL_HOLD_MS = 1000; // index.html constant
const MIN_JUMP_EXTENT = 0.001; // index.html constant

// ─── jumpParityActive() (index.html flag + export guard) ────────────────
function jumpParityActiveContract(parityOn, handle) {
  return (
    parityOn &&
    typeof handle?.jumpChargeCommence === 'function' &&
    typeof handle?.jumpChargeRelease === 'function' &&
    typeof handle?.jumpChargeAbort === 'function' &&
    typeof handle?.jumpChargeLevel === 'function'
  );
}

function mockHandle({ withParityExports }) {
  const calls = [];
  const handle = {
    jump: (power) => calls.push(['jump', power]),
    canJumpNow: () => true,
  };
  if (withParityExports) {
    handle.jumpChargeCommence = () => calls.push(['jumpChargeCommence']);
    handle.jumpChargeRelease = () => calls.push(['jumpChargeRelease']);
    handle.jumpChargeAbort = () => calls.push(['jumpChargeAbort']);
    handle.jumpChargeLevel = () => 0.5;
  }
  return { handle, calls };
}

// ─── keydown/keyup routing (index.html space handlers) ──────────────────
// Returns the post-keyup state; mutates `state` like the handlers do.
function pressSpace(state, parityOn, handle, nowMs) {
  if (jumpParityActiveContract(parityOn, handle)) {
    state.__jumpChargeActive = true;
    handle.jumpChargeCommence();
    return;
  }
  state.__jumpKeydownTs = nowMs;
}

function releaseSpace(state, parityOn, handle, nowMs) {
  if (state.__jumpChargeActive === true) {
    state.__jumpChargeActive = false;
    handle.jumpChargeRelease();
    return;
  }
  if (state.__jumpKeydownTs == null) return;
  const holdMs = nowMs - state.__jumpKeydownTs;
  state.__jumpKeydownTs = null;
  const power = Math.max(
    MIN_JUMP_EXTENT,
    Math.min(1, holdMs / JUMP_POWER_FULL_HOLD_MS)
  );
  handle.jump(power);
}

check('flag off → keyup invokes handle.jump(power) with the JS curve', () => {
  const { handle, calls } = mockHandle({ withParityExports: true });
  const state = {};
  pressSpace(state, false, handle, 1000);
  releaseSpace(state, false, handle, 1500);
  assert.deepEqual(calls, [['jump', 0.5]]);
  assert.equal(state.__jumpKeydownTs, null);
});

check('flag on + exports present → keyup invokes jumpChargeRelease and NEVER jump()', () => {
  const { handle, calls } = mockHandle({ withParityExports: true });
  const state = {};
  pressSpace(state, true, handle, 1000);
  releaseSpace(state, true, handle, 1500);
  assert.deepEqual(calls, [['jumpChargeCommence'], ['jumpChargeRelease']]);
  assert.equal(state.__jumpChargeActive, false);
  assert.equal(
    calls.some(([name]) => name === 'jump'),
    false,
    'parity path must never call handle.jump'
  );
});

check('flag on + stale handle (missing exports) → degrades to legacy path', () => {
  const { handle, calls } = mockHandle({ withParityExports: false });
  const state = {};
  pressSpace(state, true, handle, 2000);
  assert.equal(state.__jumpChargeActive, undefined, 'parity marker never set');
  releaseSpace(state, true, handle, 2250);
  assert.deepEqual(calls, [['jump', 0.25]]);
});

check('legacy quick tap floors at MIN_JUMP_EXTENT', () => {
  const { handle, calls } = mockHandle({ withParityExports: false });
  const state = {};
  pressSpace(state, false, handle, 0);
  releaseSpace(state, false, handle, 0);
  assert.deepEqual(calls, [['jump', MIN_JUMP_EXTENT]]);
});

// ─── refusal-text mapping (index.html kind=56 drain) ────────────────────
function refusalText(code) {
  return code === 73 ? 'You are too encumbered to jump!'
    : code === 72 ? "You can't jump from this position!"
    : code === 36 ? "You're in the air!"
    : "You can't jump right now.";
}

check('kind=56 refusal codes map to the ACE-style wording', () => {
  assert.equal(refusalText(73), 'You are too encumbered to jump!');
  assert.equal(refusalText(72), "You can't jump from this position!");
  assert.equal(refusalText(36), "You're in the air!");
  assert.equal(refusalText(71), "You can't jump right now.");
});

// ─── static source assertions (pin the load-bearing index.html strings) ─
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'index.html'),
  'utf8'
);

check('index.html parses the ?jumpParity flag', () => {
  assert.match(INDEX_SRC, /get\("jumpParity"\)\?\.toLowerCase\(\) === "on"/);
});

check('index.html guards all four parity exports (stale-pkg degrade)', () => {
  for (const name of [
    'jumpChargeCommence',
    'jumpChargeRelease',
    'jumpChargeAbort',
    'jumpChargeLevel',
  ]) {
    assert.match(
      INDEX_SRC,
      new RegExp(`typeof handle\\?\\.${name} === "function"`),
      `missing typeof guard for ${name}`
    );
  }
});

check('index.html bar reads the wasm clock under parity', () => {
  assert.match(INDEX_SRC, /handle\.jumpChargeLevel\(\) \* 100/);
});

check('index.html keyup parity branch keys off __jumpChargeActive', () => {
  assert.match(
    INDEX_SRC,
    /ev\.key === " " && handle && window\.__jumpChargeActive === true/
  );
});

check('index.html blur aborts the parity charge', () => {
  assert.match(INDEX_SRC, /handle\.jumpChargeAbort\(\);/);
});

check('index.html drains kind=56 into chat text', () => {
  assert.match(INDEX_SRC, /evt\.kind === 56/);
  assert.match(INDEX_SRC, /You can't jump from this position!/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, err } of failures) {
    console.error(`\nFAIL ${name}\n${err.stack}`);
  }
  process.exit(1);
}
