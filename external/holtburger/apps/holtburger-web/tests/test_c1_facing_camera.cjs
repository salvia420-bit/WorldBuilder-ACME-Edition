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
  check('picking.js imports faceDeadzoneRad from camera_math', () => {
    assert.ok(/import\s*\{\s*faceDeadzoneRad\s*\}\s*from\s*["']\.\/camera_math\.js["']/
      .test(PICKING_SRC));
  });
  check('castFacing20 flag is strict ===\"on\" (default-OFF opt-in)', () => {
    assert.ok(/get\("castFacing20"\)\s*===\s*"on"/.test(PICKING_SRC));
  });
  check('FACE_DEADZONE_RAD is derived via faceDeadzoneRad(CAST_FACING_20)', () => {
    assert.ok(/FACE_DEADZONE_RAD\s*=\s*faceDeadzoneRad\(CAST_FACING_20\)/
      .test(PICKING_SRC));
  });
  check('turn-to-face gate uses FACE_DEADZONE_RAD, not a bare 0.05', () => {
    assert.ok(/Math\.abs\(turnDelta\)\s*<=\s*FACE_DEADZONE_RAD/.test(PICKING_SRC));
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
