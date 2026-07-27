// COL-20 / F4 (2026-07-27) — turn-phase ANIMATION gate for remote entities.
//
// Same convention as remote_interp_ownership.test.cjs: entities.js can't be
// imported in Node (THREE + DOM + wasm), so this file SCRAPES the load-bearing
// constants out of the shipped source and re-implements the gate's decision
// contract against them. Keep in sync with:
//   - scene3d/entities.js::setMotion turn-gate block  (arm / substitute)
//   - scene3d/entities.js::tick turn-gate release     (release)
//   - scene3d/entities.js::_headingErrorRad           (fail-open on no target)
//
// Run:
//   node tests/col20_remote_turn_gate.test.cjs

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

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'entities.js'),
  'utf8'
);
function scrapeNumber(name) {
  const m = SRC.match(new RegExp(`const ${name} = ([-0-9.xXa-fA-F]+);`));
  assert.ok(m, `${name} not found in entities.js`);
  return Number(m[1]);
}

const MOVETO_TURN_GATE_OMEGA_REF_RAD = scrapeNumber(
  'MOVETO_TURN_GATE_OMEGA_REF_RAD'
);
const MOVETO_TURN_GATE_SLACK_S = scrapeNumber('MOVETO_TURN_GATE_SLACK_S');
const MOVETO_TURN_GATE_MAX_S = scrapeNumber('MOVETO_TURN_GATE_MAX_S');
const CMD_LOW_RUN_FORWARD = scrapeNumber('CMD_LOW_RUN_FORWARD');
const CMD_LOW_WALK_FORWARD = scrapeNumber('CMD_LOW_WALK_FORWARD');
const CMD_LOW_TURN_RIGHT = scrapeNumber('CMD_LOW_TURN_RIGHT');

// ─── 1. the tolerance IS retail's 20.0 degrees ──────────────────────────
check('facing tolerance is retail 20.0° (HandleMoveToPosition :345636)', () => {
  const m = SRC.match(
    /const MOVETO_FACING_TOLERANCE_RAD = \(([0-9.]+) \* Math\.PI\) \/ 180\.0;/
  );
  assert.ok(m, 'MOVETO_FACING_TOLERANCE_RAD not found / not in degree form');
  assert.equal(Number(m[1]), 20.0);
});
const MOVETO_FACING_TOLERANCE_RAD = (20.0 * Math.PI) / 180.0;

check('the gate flag reader matches its own "default ON" comment', () => {
  const i = SRC.indexOf('const MOVETO_TURN_GATE_ON');
  const block = SRC.slice(i, i + 400);
  assert.ok(
    /get\("remoteTurnGate"\)\?\.toLowerCase\(\) !==\s*\n?\s*"off"/.test(block),
    'reader must be `!== "off"` to match the documented default-ON'
  );
});

check('the deadline valve is bounded by a 180° sweep at 1.5 rad/s', () => {
  assert.equal(MOVETO_TURN_GATE_OMEGA_REF_RAD, 1.5);
  const worst = Math.PI / MOVETO_TURN_GATE_OMEGA_REF_RAD + MOVETO_TURN_GATE_SLACK_S;
  assert.ok(
    MOVETO_TURN_GATE_MAX_S > worst,
    `cap ${MOVETO_TURN_GATE_MAX_S}s must exceed the worst legit sweep ${worst.toFixed(3)}s`
  );
});

// ─── 2. gate decision contract (setMotion block) ────────────────────────
// Returns the command actually played; mutates `inst` exactly like the source.
function applyGate(inst, { guid, isLocal, cmd, stance, motionSpeed, nowMs, cls }) {
  const cmdLow = cmd & 0xffff;
  if (isLocal || cls === 'attack' || cls === 'cast') return cmd;
  if (cmdLow !== CMD_LOW_RUN_FORWARD && cmdLow !== CMD_LOW_WALK_FORWARD) {
    inst._turnGateCmd = 0;
    return cmd;
  }
  const err = headingErrorRad(inst);
  if (err > MOVETO_FACING_TOLERANCE_RAD) {
    if (inst._turnGateCmd !== cmd) {
      inst._turnGateUntilMs =
        nowMs +
        1000 *
          Math.min(
            MOVETO_TURN_GATE_MAX_S,
            err / MOVETO_TURN_GATE_OMEGA_REF_RAD + MOVETO_TURN_GATE_SLACK_S
          );
    }
    inst._turnGateCmd = cmd;
    inst._turnGateStance = stance;
    inst._turnGateSpeed = Number.isFinite(+motionSpeed) ? +motionSpeed : 1.0;
    return ((cmd & 0xffff0000) | CMD_LOW_TURN_RIGHT) >>> 0;
  }
  inst._turnGateCmd = 0;
  return cmd;
}

// entities.js::_headingErrorRad — 0 (fail-open) when no target is armed.
function headingErrorRad(inst) {
  if (!inst || !inst._headingEaseInit || inst._headingErr === undefined) return 0;
  return inst._headingErr;
}

// entities.js::tick release block. Returns the released command or 0.
function tickRelease(inst, nowMs) {
  if (!inst._turnGateCmd) return 0;
  if (
    headingErrorRad(inst) <= MOVETO_FACING_TOLERANCE_RAD ||
    nowMs >= inst._turnGateUntilMs
  ) {
    const queued = inst._turnGateCmd >>> 0;
    inst._turnGateCmd = 0;
    return queued;
  }
  return 0;
}

const RUN_FORWARD = 0x44000007;
const WALK_FORWARD = 0x45000005;
const TURN_RIGHT = 0x6500000d;

check('no heading target armed → gate never fires (fail-open)', () => {
  const inst = {};
  assert.equal(
    applyGate(inst, { isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0 }),
    RUN_FORWARD
  );
  assert.equal(inst._turnGateCmd, 0);
});

check('local player is never gated', () => {
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  assert.equal(
    applyGate(inst, { isLocal: true, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0 }),
    RUN_FORWARD
  );
});

check('180° error → the turn cycle plays, stance preserved', () => {
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  const played = applyGate(inst, {
    isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1.0, nowMs: 0,
  });
  assert.equal(played & 0xffff, CMD_LOW_TURN_RIGHT);
  assert.equal(played >>> 16, RUN_FORWARD >>> 16, 'class byte preserved');
  assert.equal(inst._turnGateCmd, RUN_FORWARD);
  assert.equal(inst._turnGateStance, 0x3d);
});

check('19° error → locomotion starts immediately (inside tolerance)', () => {
  const inst = { _headingEaseInit: true, _headingErr: (19 * Math.PI) / 180 };
  assert.equal(
    applyGate(inst, { isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0 }),
    RUN_FORWARD
  );
  assert.equal(inst._turnGateCmd, 0);
});

check('WalkForward is gated the same as RunForward', () => {
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  const played = applyGate(inst, {
    isLocal: false, cmd: WALK_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0,
  });
  assert.equal(played & 0xffff, CMD_LOW_TURN_RIGHT);
  assert.equal(inst._turnGateCmd, WALK_FORWARD);
});

check('a non-locomotion command retires a held gate', () => {
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  applyGate(inst, { isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0 });
  assert.equal(inst._turnGateCmd, RUN_FORWARD);
  applyGate(inst, { isLocal: false, cmd: 0x40000011 /* Dead */, stance: 0x3d, motionSpeed: 1, nowMs: 0 });
  assert.equal(inst._turnGateCmd, 0);
});

check('a re-broadcast of the same command does NOT extend the deadline', () => {
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  applyGate(inst, { isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0 });
  const first = inst._turnGateUntilMs;
  const played = applyGate(inst, {
    isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 1000,
  });
  assert.equal(inst._turnGateUntilMs, first, 'deadline must not slide');
  assert.equal(played & 0xffff, CMD_LOW_TURN_RIGHT, 're-broadcast stays gated');
});

// ─── 3. the spec's acceptance run: 180° re-target, clip log per frame ───
function driveRetarget({ omega, dt = 1 / 60, startErr = Math.PI }) {
  const inst = { _headingEaseInit: true, _headingErr: startErr };
  let now = 0;
  const clips = [];
  let playing = applyGate(inst, {
    isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1.0, nowMs: now,
  });
  for (let f = 0; f < 1200; f += 1) {
    clips.push({ err: inst._headingErr, clip: playing & 0xffff });
    // constant-omega slew with exact terminal snap (COL-19 shape)
    inst._headingErr = Math.max(0, inst._headingErr - omega * dt);
    now += dt * 1000;
    const released = tickRelease(inst, now);
    if (released) playing = released;
    if (inst._headingErr === 0 && (playing & 0xffff) === CMD_LOW_RUN_FORWARD) break;
  }
  return clips;
}

check('order is turn-cycle → run-cycle, switching at error ≤ 20°', () => {
  const clips = driveRetarget({ omega: 1.5 });
  assert.equal(clips[0].clip, CMD_LOW_TURN_RIGHT, 'first frame must be the turn cycle');
  const first = clips.findIndex((c) => c.clip === CMD_LOW_RUN_FORWARD);
  assert.ok(first > 0, 'run cycle never started');
  assert.ok(
    clips[first].err <= MOVETO_FACING_TOLERANCE_RAD + 1e-9,
    `switched at ${((clips[first].err * 180) / Math.PI).toFixed(2)}°, must be ≤ 20°`
  );
  // monotone: once running it never reverts within this sweep
  assert.ok(clips.slice(first).every((c) => c.clip === CMD_LOW_RUN_FORWARD));
});

check('ZERO run-cycle frames while the facing error exceeds 90°', () => {
  const clips = driveRetarget({ omega: 1.5 });
  const bad = clips.filter(
    (c) => c.clip === CMD_LOW_RUN_FORWARD && c.err > Math.PI / 2
  );
  assert.equal(bad.length, 0, `${bad.length} eager run frames past 90°`);
});

check('gate duration for a 180° sweep at 1.5 rad/s ≈ 1.86 s', () => {
  const dt = 1 / 60;
  const clips = driveRetarget({ omega: 1.5, dt });
  const first = clips.findIndex((c) => c.clip === CMD_LOW_RUN_FORWARD);
  const held = first * dt;
  const expected = (Math.PI - MOVETO_FACING_TOLERANCE_RAD) / 1.5;
  assert.ok(
    Math.abs(held - expected) <= 2 * dt,
    `held ${held.toFixed(3)} s, expected ~${expected.toFixed(3)} s`
  );
});

check('pre-COL-19 exponential ease still releases (gate is F3-independent)', () => {
  // K=14 whip: the gate is only ~0.16 s but the ORDER is still correct.
  const dt = 1 / 60;
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  let now = 0;
  let playing = applyGate(inst, {
    isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: now,
  });
  assert.equal(playing & 0xffff, CMD_LOW_TURN_RIGHT);
  for (let f = 0; f < 600 && (playing & 0xffff) !== CMD_LOW_RUN_FORWARD; f += 1) {
    inst._headingErr -= inst._headingErr * (1 - Math.exp(-14.0 * dt));
    now += dt * 1000;
    const r = tickRelease(inst, now);
    if (r) playing = r;
  }
  assert.equal(playing & 0xffff, CMD_LOW_RUN_FORWARD);
  assert.ok(now / 1000 < 0.5, `released in ${(now / 1000).toFixed(3)} s`);
});

check('DEADLINE VALVE: a target that never converges still releases', () => {
  const inst = { _headingEaseInit: true, _headingErr: Math.PI };
  applyGate(inst, { isLocal: false, cmd: RUN_FORWARD, stance: 0x3d, motionSpeed: 1, nowMs: 0 });
  assert.equal(tickRelease(inst, 1000), 0, 'must still be held at 1 s');
  const cap = 1000 * MOVETO_TURN_GATE_MAX_S + 1;
  assert.equal(tickRelease(inst, cap), RUN_FORWARD, 'valve must fire by the cap');
  assert.equal(inst._turnGateCmd, 0);
});

console.log(`\ncol20_remote_turn_gate: ${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}
