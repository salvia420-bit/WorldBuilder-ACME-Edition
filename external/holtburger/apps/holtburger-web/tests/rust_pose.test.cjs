// F17 (2026-07-03, physics-parity dossier A row 42) — headless unit half for
// the `?rustPose=on` render bypass in scene3d/rust_pose.js (flag parse +
// lb-local → world pose conversion). rust_pose.js is import-free by design
// so it loads under plain node; loop.js / camera.js (three.js + DOM) are
// covered by static source assertions pinning the load-bearing wiring
// strings, same split as tests/camera_retail_math.test.cjs.
//
// Retail truth: ~/ac-headers/acclient.c — the drawn parts ARE m_position
// (`CPhysicsObj::set_frame` :321328 writes `m_position.frame` :321344 →
// `CPartArray::SetFrame` :321350); there is no retail render-side smoother.
//
// Run:
//   node tests/rust_pose.test.cjs

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

const LOOP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'loop.js'), 'utf8');
const CAMERA_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'camera.js'), 'utf8');
const FLAGS_DOC = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'url-flags.md'), 'utf8');

async function main() {
  const m = await import('../scene3d/rust_pose.js');

  // ── parseRustPoseFlag: F-2026-07-03 DEFAULT ON; only `=off` disables ───
  check('flag defaults ON (absent / empty / null / undefined search)', () => {
    assert.equal(m.parseRustPoseFlag(''), true);
    assert.equal(m.parseRustPoseFlag('?'), true);
    assert.equal(m.parseRustPoseFlag(null), true);
    assert.equal(m.parseRustPoseFlag(undefined), true);
    assert.equal(m.parseRustPoseFlag('?wireframe=1&nullRender=1'), true);
  });

  check('flag disables only on exact (case-insensitive) `off`', () => {
    assert.equal(m.parseRustPoseFlag('?rustPose=on'), true);
    assert.equal(m.parseRustPoseFlag('?rustPose=ON'), true);
    assert.equal(m.parseRustPoseFlag('?rustPose=On'), true);
    // Only an explicit off disables (F-2026-07-03 default-on shape).
    assert.equal(m.parseRustPoseFlag('?rustPose=off'), false);
    assert.equal(m.parseRustPoseFlag('?rustPose=OFF'), false);
    assert.equal(m.parseRustPoseFlag('?nullRender=1&rustPose=off'), false);
    assert.equal(m.parseRustPoseFlag('?rustPose=1'), true);
    assert.equal(m.parseRustPoseFlag('?rustPose=true'), true);
    assert.equal(m.parseRustPoseFlag('?rustPose='), true);
    assert.equal(m.parseRustPoseFlag('?rustPose'), true);
    // Key is case-SENSITIVE like every other URLSearchParams reader —
    // a miskeyed `rustpose=off` does NOT disable.
    assert.equal(m.parseRustPoseFlag('?rustpose=off'), true);
  });

  check('flag composes with the other physics-parity flags', () => {
    assert.equal(m.parseRustPoseFlag('?retailLeash=on&rustPose=on'), true);
    assert.equal(
      m.parseRustPoseFlag('?nosw=1&rustPose=on&retailLeash=on&castMove=off'),
      true
    );
    // Default-on: a query without the key stays ON.
    assert.equal(m.parseRustPoseFlag('?retailLeash=on'), true);
    assert.equal(m.parseRustPoseFlag('?retailLeash=off&rustPose=off'), false);
  });

  // ── rustPoseWorldFromPose: null-gates ──────────────────────────────────
  check('null/undefined pose → null (caller keeps last applied pose)', () => {
    assert.equal(m.rustPoseWorldFromPose(null), null);
    assert.equal(m.rustPoseWorldFromPose(undefined), null);
  });

  check('non-finite coordinate → null (x, y, or z)', () => {
    const base = { x: 1, y: 2, z: 3, heading: 0, landblockId: 0 };
    assert.equal(m.rustPoseWorldFromPose({ ...base, x: NaN }), null);
    assert.equal(m.rustPoseWorldFromPose({ ...base, y: Infinity }), null);
    assert.equal(m.rustPoseWorldFromPose({ ...base, z: undefined }), null);
  });

  // ── rustPoseWorldFromPose: lb-local → world conversion ─────────────────
  check('lb-local → world matches the _armPosition/_integratorWorldPose convention', () => {
    // Holtburg-ish block 0xA9B4xxxx: lbX=0xA9=169, lbY=0xB4=180.
    const w = m.rustPoseWorldFromPose({
      x: 42.5, y: 77.25, z: 63.2, heading: 0, landblockId: 0xA9B40021,
    });
    assert.ok(w);
    assert.equal(w.x, 169 * 192.0 + 42.5);
    assert.equal(w.y, 180 * 192.0 + 77.25);
    assert.equal(w.z, 63.2); // z is already world — passes through untouched
  });

  check('missing landblockId coerces >>>0 → block (0,0), matching _integratorWorldPose', () => {
    const w = m.rustPoseWorldFromPose({ x: 5, y: 6, z: 7 });
    assert.ok(w);
    assert.equal(w.x, 5);
    assert.equal(w.y, 6);
  });

  // ── rustPoseWorldFromPose: heading → yaw-only quaternion ───────────────
  check('heading → (qw, qz) matches the legacy apply math cos/sin(h/2)', () => {
    const north = m.rustPoseWorldFromPose(
      { x: 0, y: 0, z: 0, heading: 0, landblockId: 0 });
    assert.equal(north.qw, 1.0);
    assert.equal(north.qz, 0.0);
    const east = m.rustPoseWorldFromPose(
      { x: 0, y: 0, z: 0, heading: Math.PI / 2, landblockId: 0 });
    assert.ok(Math.abs(east.qw - Math.cos(Math.PI / 4)) < 1e-15);
    assert.ok(Math.abs(east.qz - Math.sin(Math.PI / 4)) < 1e-15);
    const south = m.rustPoseWorldFromPose(
      { x: 0, y: 0, z: 0, heading: Math.PI, landblockId: 0 });
    assert.ok(Math.abs(south.qw) < 1e-15);
    assert.ok(Math.abs(south.qz - 1.0) < 1e-15);
  });

  check('non-finite/missing heading degrades to 0 (north) with position intact', () => {
    for (const heading of [NaN, Infinity, undefined, 'x']) {
      const w = m.rustPoseWorldFromPose(
        { x: 1, y: 2, z: 3, heading, landblockId: 0x01020000 });
      assert.ok(w, `heading=${String(heading)}`);
      assert.equal(w.qw, 1.0);
      assert.equal(w.qz, 0.0);
      assert.equal(w.x, 1 * 192.0 + 1);
      assert.equal(w.y, 2 * 192.0 + 2);
    }
  });

  // ── wiring: loop.js rig bypass ─────────────────────────────────────────
  check('loop.js imports the pure module and gates the apply on RUST_POSE_ON', () => {
    assert.match(LOOP_SRC,
      /import \{ parseRustPoseFlag, rustPoseWorldFromPose \} from "\.\/rust_pose\.js";/);
    assert.match(LOOP_SRC, /const RUST_POSE_ON = /);
    // The bypass lives INSIDE applyLocalPlayerPoseFromIntegrator, before
    // the predictedPlayerPos read, and returns without touching the ease.
    const fnStart = LOOP_SRC.indexOf('function applyLocalPlayerPoseFromIntegrator');
    assert.ok(fnStart > 0, 'apply fn present');
    const body = LOOP_SRC.slice(fnStart, fnStart + 4000);
    const gateAt = body.indexOf('if (RUST_POSE_ON) {');
    const predictedAt = body.indexOf('scene3d.cameraSwitcher.predictedPlayerPos');
    assert.ok(gateAt > 0, 'RUST_POSE_ON gate inside the apply fn');
    assert.ok(predictedAt > gateAt,
      'bypass branch sits BEFORE the legacy predictedPlayerPos read');
    assert.match(body, /rustPoseWorldFromPose\(pose\)/);
  });

  // ── wiring: camera.js framing bypass ───────────────────────────────────
  check('camera.js gates _safePlayerPos on the same flag via _integratorWorldPose', () => {
    assert.match(CAMERA_SRC,
      /import \{ parseRustPoseFlag \} from "\.\/rust_pose\.js";/);
    assert.match(CAMERA_SRC, /const RUST_POSE_ON = /);
    const fnStart = CAMERA_SRC.indexOf('_safePlayerPos() {');
    assert.ok(fnStart > 0, '_safePlayerPos present');
    const body = CAMERA_SRC.slice(fnStart, fnStart + 2000);
    assert.match(body, /if \(RUST_POSE_ON\) \{/);
    assert.match(body, /this\._integratorWorldPose\(\)/);
  });

  // ── wiring: legacy layers retained (deletion is gated on the 1070 A/B) ──
  check('legacy smoothing layers are NOT deleted (removal awaits the A/B)', () => {
    assert.match(LOOP_SRC, /const RIG_Z_TAU_MS = 70\.0;/);
    assert.match(LOOP_SRC, /const RIG_Z_SNAP_M = 1\.0;/);
    assert.match(CAMERA_SRC, /_smoothToIntegrator\(dt\) \{/);
    assert.match(CAMERA_SRC, /getPredictedPlayerWorldPos\(\) \{/);
  });

  // ── docs: url-flags.md row present ─────────────────────────────────────
  check('url-flags.md documents ?rustPose=on in the physics-parity section', () => {
    assert.match(FLAGS_DOC, /\?rustPose=on/);
    assert.match(FLAGS_DOC, /rust_pose\.js/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const { name, err } of failures) {
      console.error(`\nFAIL ${name}\n${err.stack}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
