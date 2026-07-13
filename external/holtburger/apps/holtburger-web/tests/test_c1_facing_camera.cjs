// C1 (2026-07-12) — facing dead-zone + camera cast-bias + autoFollow truth.
//
// Pins the PURE selection logic (camera_math.js is import-free, loads under
// plain node) and the load-bearing wiring in picking.js / camera.js (three.js
// + DOM — covered by static source assertions, same pattern as
// tests/camera_retail_math.test.cjs).
//
// Retail/ACE truth: the client turn-to-face only fires when the caster is
// outside ACE's spellcast_max_angle (20°, Player_Magic.cs IsWithinAngle /
// PropertyManager.cs). The follow lookAt anchors the PLAYER, so a close cast
// target drifts off-frame (cast-eyetest 2026-07-12); castCamBias recenters it.
// autoFollow's reader is `!== "off"` ⇒ DEFAULT-ON (the :207 docstring that said
// "default OFF" was the classic footgun — this test pins the truth).
//
// Run: node tests/test_c1_facing_camera.cjs   (from apps/holtburger-web/)

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

const PICKING_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'picking.js'), 'utf8');
const CAMERA_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'camera.js'), 'utf8');

async function main() {
  const m = await import('../scene3d/camera_math.js');

  // ── (1) dead-zone constants pinned to ACE ────────────────────────────────
  check('FACE_DEADZONE_TIGHT_RAD is the legacy 0.05 rad', () => {
    assert.equal(m.FACE_DEADZONE_TIGHT_RAD, 0.05);
  });
  check('FACE_DEADZONE_WIDE_RAD is ACE spellcast_max_angle (20°)', () => {
    // 20° in radians ≈ 0.349 ("~0.349 rad" in the dossier).
    assert.ok(Math.abs(m.FACE_DEADZONE_WIDE_RAD - (20 * Math.PI) / 180) < 1e-12);
    assert.ok(Math.abs(m.FACE_DEADZONE_WIDE_RAD - 0.349) < 1e-3);
    // The whole point: the wide band is ~7× the tight one.
    assert.ok(m.FACE_DEADZONE_WIDE_RAD / m.FACE_DEADZONE_TIGHT_RAD > 6.5);
  });

  // ── (2) dead-zone SELECTION logic (the flag → constant mapping) ──────────
  check('faceDeadzoneRad(false) = legacy 0.05 (flag off)', () => {
    assert.equal(m.faceDeadzoneRad(false), 0.05);
    assert.equal(m.faceDeadzoneRad(false), m.FACE_DEADZONE_TIGHT_RAD);
  });
  check('faceDeadzoneRad(true) = 20° band (flag on)', () => {
    assert.equal(m.faceDeadzoneRad(true), m.FACE_DEADZONE_WIDE_RAD);
    assert.ok(m.faceDeadzoneRad(true) > m.faceDeadzoneRad(false));
  });
  check('a 10° facing error turns under legacy, not under 20°', () => {
    const err10 = (10 * Math.PI) / 180; // inside ACE's band, outside legacy
    // flag-off (0.05 rad ≈ 2.86°): 10° > dead-zone ⇒ the client would TURN.
    assert.ok(err10 > m.faceDeadzoneRad(false));
    // flag-on (20°): 10° <= dead-zone ⇒ the client early-exits (no turn),
    // matching ACE which would not re-turn inside spellcast_max_angle.
    assert.ok(err10 <= m.faceDeadzoneRad(true));
  });

  // ── (2b) GATE DECISION — instrument-quality proof (flag on + 8.9° ⇒ no turn)
  // The confounded eye-test metric (getLocalPlayerPose().heading, the SERVER-
  // overwritten shadow) showed headingDelta=26.89° for on@10 and read it as a
  // FAIL. It is not: the flag gates the CLIENT rig turn only, and the drudge's
  // projected ndc.x stayed 0.42→0.42 (no rig turn). This block pins what the
  // flag actually decides: the pure gate step turnToFaceThenAct runs each frame.
  const DEG = (d) => (d * Math.PI) / 180;
  const T0 = 0; // first frame, elapsed 0 (timeout branch inert)
  const TIMEOUT = 800; // FACE_TURN_TIMEOUT_MS (picking.js:33)
  check('flag ON + 8.9° bearing ⇒ NO turn command (done, turn===0)', () => {
    // The exact on@10 geometry: preOff = 8.9° off-axis, castFacing20=on.
    const g = m.faceTurnStep(DEG(8.9), m.faceDeadzoneRad(true), T0, TIMEOUT);
    assert.equal(g.done, true);   // early-exit
    assert.equal(g.turn, 0);      // NEVER issues a turn — this is the whole flag
    // sign-symmetric: a target 8.9° to the OTHER side is equally suppressed.
    assert.equal(m.faceTurnStep(DEG(-8.9), m.faceDeadzoneRad(true), T0, TIMEOUT).turn, 0);
  });
  check('flag OFF + 8.9° bearing ⇒ the client DOES turn (the old behaviour)', () => {
    // Same 8.9° with the legacy 2.86° band ⇒ outside dead-zone ⇒ a real turn.
    const g = m.faceTurnStep(DEG(8.9), m.faceDeadzoneRad(false), T0, TIMEOUT);
    assert.equal(g.done, false);
    assert.equal(g.turn, 1);      // +bearing ⇒ +1 turn input
    assert.equal(m.faceTurnStep(DEG(-8.9), m.faceDeadzoneRad(false), T0, TIMEOUT).turn, -1);
  });
  check('gate invariant: done ⇒ turn===0 across the band boundary', () => {
    // Just inside the 20° band ⇒ no turn; just outside ⇒ turn.
    assert.equal(m.faceTurnStep(DEG(19.9), m.faceDeadzoneRad(true), T0, TIMEOUT).turn, 0);
    assert.equal(m.faceTurnStep(DEG(20.1), m.faceDeadzoneRad(true), T0, TIMEOUT).done, false);
    // Just inside the legacy band ⇒ no turn; just outside ⇒ turn.
    assert.equal(m.faceTurnStep(DEG(2.8), m.faceDeadzoneRad(false), T0, TIMEOUT).turn, 0);
    assert.equal(m.faceTurnStep(DEG(2.9), m.faceDeadzoneRad(false), T0, TIMEOUT).done, false);
  });
  check('timeout branch stops WITHOUT a turn even outside the band', () => {
    // Past FACE_TURN_TIMEOUT_MS a huge bearing error still yields a neutral
    // stop (the stall-cap), never a turn command.
    const g = m.faceTurnStep(DEG(120), m.faceDeadzoneRad(true), TIMEOUT + 1, TIMEOUT);
    assert.equal(g.done, true);
    assert.equal(g.turn, 0);
  });
  check('faceTurnStep never returns done with a nonzero turn (safety)', () => {
    for (const dz of [m.faceDeadzoneRad(true), m.faceDeadzoneRad(false)]) {
      for (const deg of [-180, -90, -20, -8.9, -2.9, 0, 2.9, 8.9, 20, 90, 180]) {
        for (const el of [0, TIMEOUT + 1]) {
          const g = m.faceTurnStep(DEG(deg), dz, el, TIMEOUT);
          if (g.done) assert.equal(g.turn, 0, `done@${deg}°/dz${dz}/el${el} must be turn 0`);
          else assert.ok(g.turn === 1 || g.turn === -1);
        }
      }
    }
  });

  // ── (3) autoFollow default TRUTH (default-ON) ────────────────────────────
  check('autoFollowDefaultOn is default-ON (only "off" disables)', () => {
    assert.equal(m.autoFollowDefaultOn(undefined), true); // param absent
    assert.equal(m.autoFollowDefaultOn(null), true);
    assert.equal(m.autoFollowDefaultOn(''), true);
    assert.equal(m.autoFollowDefaultOn('on'), true);
    assert.equal(m.autoFollowDefaultOn('anything'), true);
    assert.equal(m.autoFollowDefaultOn('off'), false);
    assert.equal(m.autoFollowDefaultOn('OFF'), false); // case-insensitive
    assert.equal(m.autoFollowDefaultOn('Off'), false);
  });

  // ── (4) cast-bias blend easing ───────────────────────────────────────────
  check('castBiasStep eases toward 1 while active, 0 when released', () => {
    let a = 0;
    for (let i = 0; i < 200; i++) a = m.castBiasStep(a, true, 1 / 60);
    assert.ok(a > 0.99 && a <= 1); // converges up toward 1
    for (let i = 0; i < 200; i++) a = m.castBiasStep(a, false, 1 / 60);
    assert.ok(a < 0.01 && a >= 0); // eases back to 0
  });
  check('castBiasStep is monotone toward its goal each step', () => {
    assert.ok(m.castBiasStep(0.2, true, 1 / 60) > 0.2);   // rising
    assert.ok(m.castBiasStep(0.8, false, 1 / 60) < 0.8);  // falling
  });
  check('castBiasStep with dt<=0 is a no-op (no NaN)', () => {
    assert.equal(m.castBiasStep(0.4, true, 0), 0.4);
    assert.equal(m.castBiasStep(0.4, true, -1), 0.4);
  });
  check('cast-bias blend is partial (keeps the player framed)', () => {
    assert.ok(m.CAST_CAM_BIAS_MAX > 0 && m.CAST_CAM_BIAS_MAX < 1);
    assert.ok(m.CAST_CAM_BIAS_TTL_MS > 0);
  });

  // ── (5) picking.js wiring (dead-zone gate uses the selection) ────────────
  check('picking.js imports faceDeadzoneRad + faceTurnStep from camera_math', () => {
    assert.ok(/import\s*\{[^}]*\bfaceDeadzoneRad\b[^}]*\}\s*from\s*["']\.\/camera_math\.js["']/
      .test(PICKING_SRC));
    assert.ok(/import\s*\{[^}]*\bfaceTurnStep\b[^}]*\}\s*from\s*["']\.\/camera_math\.js["']/
      .test(PICKING_SRC));
  });
  check('castFacing20 flag is strict ===\"on\" (default-OFF opt-in)', () => {
    assert.ok(/get\("castFacing20"\)\s*===\s*"on"/.test(PICKING_SRC));
  });
  check('FACE_DEADZONE_RAD is derived via faceDeadzoneRad(CAST_FACING_20)', () => {
    assert.ok(/FACE_DEADZONE_RAD\s*=\s*faceDeadzoneRad\(CAST_FACING_20\)/
      .test(PICKING_SRC));
  });
  check('turn-to-face gate runs faceTurnStep with FACE_DEADZONE_RAD', () => {
    // The decision is now the pure faceTurnStep, fed the selected dead-zone.
    assert.ok(/faceTurnStep\(\s*[\s\S]*?FACE_DEADZONE_RAD/.test(PICKING_SRC));
    // and it drives setMovementInput with the gate's turn (not a bare literal).
    assert.ok(/gate\.done/.test(PICKING_SRC));
    assert.ok(/setMovementInput\(0,\s*0,\s*gate\.turn/.test(PICKING_SRC));
    // the old hard-coded 0.05 gate is gone
    assert.ok(!/Math\.abs\(turnDelta\)\s*<=\s*0\.05/.test(PICKING_SRC));
  });
  check('doCast fires camera.setCastBiasTarget(guid)', () => {
    assert.ok(/setCastBiasTarget\?\.\(guid\s*>>>\s*0\)/.test(PICKING_SRC));
  });

  // ── (6) camera.js wiring (autoFollow truth + cast-bias plumbing) ─────────
  check('camera.js autoFollow reader uses autoFollowDefaultOn', () => {
    assert.ok(/_autoFollowOn\s*=\s*autoFollowDefaultOn\(/.test(CAMERA_SRC));
  });
  check('camera.js autoFollow docstring says DEFAULT-ON, not "default OFF"', () => {
    // The stale docstring read: Autofollow (`?autoFollow=on`, default OFF).
    assert.ok(!/`\?autoFollow=on`,\s*default OFF/.test(CAMERA_SRC));
    // and now advertises the true default.
    assert.ok(/Autofollow \(`\?autoFollow=off` to disable — DEFAULT-ON\)/
      .test(CAMERA_SRC));
  });
  check('castCamBias flag is strict ===\"on\" (default-OFF opt-in)', () => {
    assert.ok(/get\("castCamBias"\)\?\.toLowerCase\(\)\s*===\s*"on"/
      .test(CAMERA_SRC));
  });
  check('camera.js defines setCastBiasTarget + resolves target pos', () => {
    assert.ok(/setCastBiasTarget\(guid/.test(CAMERA_SRC));
    assert.ok(/_castBiasTargetPos\(\)/.test(CAMERA_SRC));
  });
  check('camera.js lookX/lookY are mutable (let) for the bias blend', () => {
    assert.ok(/let\s+lookX\s*=\s*p\.x,\s*lookY\s*=\s*p\.y/.test(CAMERA_SRC));
  });

  console.log(`\nC1 facing/camera: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error('FAIL:', f.name, '—', f.err.message);
    process.exit(1);
  }
  process.exit(0);
}

main();
