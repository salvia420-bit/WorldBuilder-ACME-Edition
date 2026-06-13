// A12-C2/C3 (2026-06-12, unification survey) — headless unit half for the
// retail camera math in scene3d/camera_math.js (zoom continuum / in-head /
// near-fade / stiffness frac / FilterMouseInput). camera_math.js is
// import-free by design so it loads under plain node; camera.js itself
// (three.js + DOM) is covered by static source assertions pinning the
// load-bearing wiring strings.
//
// Retail truth: ~/ac-headers/acclient.c — cites inline per case.
//
// Run:
//   node tests/camera_retail_math.test.cjs

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

const CAMERA_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'camera.js'), 'utf8');
const ENTITIES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scene3d', 'entities.js'), 'utf8');

async function main() {
  const m = await import('../scene3d/camera_math.js');

  // ── constants pinned to the decomp ────────────────────────────────────
  check('retail constants match acclient.c', () => {
    assert.equal(m.RETAIL_CAM_ADJUST_SPEED, 40.0); // acclient.c:147921
    assert.equal(m.RETAIL_ZOOM_MIN_RADIUS, 0.5);   // acclient.c:149023
    assert.equal(m.RETAIL_ZOOM_MAX_RADIUS, 10.0);  // acclient.c:149119
    assert.equal(m.IN_HEAD_FORWARD_M, 0.18);       // acclient.c:149230-149262
    assert.equal(m.CAMERA_DEFAULT_PIVOT_Z, 1.5);   // acclient.c:39550
    assert.equal(m.IN_HEAD_DIR_Z_CLAMP, 0.8);      // acclient.c:39549
    assert.equal(m.NEAR_FADE_OUTER_M, 0.45);       // acclient.c:149195
    assert.equal(m.NEAR_FADE_INNER_M, 0.2);        // acclient.c:149206
    // Farther's in-head exit offset (0, -0.6, 0.5): packed const
    // 4539628427595585946 at acclient.c:149093 decodes to f32 (-0.6, 0.5).
    assert.ok(Math.abs(m.IN_HEAD_EXIT_RADIUS - Math.hypot(0.6, 0.5)) < 1e-12);
    // Per-notch factors: 1 ∓ 40 * (1/60) * 0.2.
    assert.ok(Math.abs(m.RETAIL_ZOOM_IN_FACTOR - (1 - 0.4 / 3)) < 1e-12);
    assert.ok(Math.abs(m.RETAIL_ZOOM_OUT_FACTOR - (1 + 0.4 / 3)) < 1e-12);
  });

  // ── C2 zoom continuum ─────────────────────────────────────────────────
  check('zoom in shrinks multiplicatively (acclient.c:149020 v9 = 1 - v8*0.2)', () => {
    const s = m.retailZoomStep({ radius: 6.0, inHead: false }, -1);
    assert.ok(Math.abs(s.radius - 6.0 * m.RETAIL_ZOOM_IN_FACTOR) < 1e-12);
    assert.equal(s.inHead, false);
  });

  check('zoom out grows multiplicatively, clamped at 10 m (acclient.c:149119)', () => {
    const s = m.retailZoomStep({ radius: 6.0, inHead: false }, 1);
    assert.ok(Math.abs(s.radius - 6.0 * m.RETAIL_ZOOM_OUT_FACTOR) < 1e-12);
    // A step that would exceed 10 m is REFUSED (radius unchanged), matching
    // retail Farther skipping the apply when the clamp trips.
    const s2 = m.retailZoomStep({ radius: 9.5, inHead: false }, 1);
    assert.equal(s2.radius, 9.5);
    assert.equal(s2.inHead, false);
  });

  check('zoom in across the 0.5 floor collapses to in-head', () => {
    // 0.55 * 0.8667 ≈ 0.477 < 0.5 → in-head; radius retained for bookkeeping.
    const s = m.retailZoomStep({ radius: 0.55, inHead: false }, -1);
    assert.equal(s.inHead, true);
    assert.equal(s.radius, 0.55);
    // Exactly at the floor stays third-person only if the step result ≥ 0.5.
    const s2 = m.retailZoomStep({ radius: 0.5 / m.RETAIL_ZOOM_IN_FACTOR, inHead: false }, -1);
    assert.equal(s2.inHead, false);
    assert.ok(Math.abs(s2.radius - 0.5) < 1e-12);
  });

  check('zoom in while in-head is a no-op (acclient.c:149006 early-out)', () => {
    const s = m.retailZoomStep({ radius: 0.55, inHead: true }, -1);
    assert.deepEqual(s, { radius: 0.55, inHead: true });
  });

  check('zoom out from in-head exits at the retail (0,-0.6,0.5) radius', () => {
    const s = m.retailZoomStep({ radius: 0.55, inHead: true }, 1);
    assert.equal(s.inHead, false);
    assert.ok(Math.abs(s.radius - m.IN_HEAD_EXIT_RADIUS) < 1e-12);
  });

  // ── C2 near-fade curve (acclient.c:149190-149216) ─────────────────────
  check('near-fade: opaque at/beyond 0.45 m', () => {
    assert.equal(m.nearFadeOpacity(0.45), 1.0);
    assert.equal(m.nearFadeOpacity(6.0), 1.0);
  });

  check('near-fade: invisible at/inside 0.2 m', () => {
    assert.equal(m.nearFadeOpacity(0.2), 0.0);
    assert.equal(m.nearFadeOpacity(0.05), 0.0);
  });

  check('near-fade: linear between — d=0.30 → 0.4, d=0.325 → 0.5', () => {
    // opacity = (d - 0.2) / 0.25 (decomp t = 1 - (0.2-d)/(0.2-0.45); opacity = 1-t)
    assert.ok(Math.abs(m.nearFadeOpacity(0.30) - 0.4) < 1e-12);
    assert.ok(Math.abs(m.nearFadeOpacity(0.325) - 0.5) < 1e-12);
  });

  // ── C3 stiffness fraction (acclient.c:147796-147825) ──────────────────
  check('stiffness frac = s*dt*10 clamped to 1', () => {
    assert.ok(Math.abs(m.stiffnessFrac(0.5, 1 / 60) - 0.5 * (1 / 60) * 10) < 1e-12);
    assert.equal(m.stiffnessFrac(0.5, 1.0), 1.0); // 5.0 clamps
  });

  check('stiffness within 2e-4 of 1.0 snaps outright', () => {
    assert.equal(m.stiffnessFrac(1.0, 1 / 240), 1.0);
    assert.equal(m.stiffnessFrac(0.99985, 1 / 240), 1.0);
    // Just below the guard does NOT snap.
    assert.ok(m.stiffnessFrac(0.9, 1 / 240) < 1.0);
  });

  check('stiffness degenerate inputs snap (0, negative, dt=0)', () => {
    assert.equal(m.stiffnessFrac(0, 1 / 60), 1.0);
    assert.equal(m.stiffnessFrac(-1, 1 / 60), 1.0);
    assert.equal(m.stiffnessFrac(0.5, 0), 1.0);
  });

  // ── C3 FilterMouseInput (acclient.c:148138-148163) ────────────────────
  check('mouse filter: amount=0 is the identity', () => {
    const st = { lastDX: 0, lastDY: 0, lastT: -1 };
    const f = m.filterMouseDelta(st, 12, -7, 0.0, 100.0);
    assert.equal(f.dx, 12);
    assert.equal(f.dy, -7);
  });

  check('mouse filter: gap > 0.25 s bypasses the two-sample average', () => {
    const st = { lastDX: 100, lastDY: 100, lastT: 0 };
    // avg falls back to raw → out = raw*(1-a) + raw*a = raw, ANY amount.
    const f = m.filterMouseDelta(st, 10, 4, 0.8, 1.0);
    assert.equal(f.dx, 10);
    assert.equal(f.dy, 4);
    assert.equal(st.lastT, 1.0);
  });

  check('mouse filter: inside the window blends raw with (lastFiltered+raw)/2', () => {
    const st = { lastDX: 20, lastDY: -20, lastT: 1.0 };
    const a = 0.5;
    const f = m.filterMouseDelta(st, 10, 10, a, 1.1);
    // avg = (20+10)/2 = 15; out = 10*0.5 + 15*0.5 = 12.5
    assert.ok(Math.abs(f.dx - 12.5) < 1e-12);
    // avgY = (-20+10)/2 = -5; out = 10*0.5 + (-5)*0.5 = 2.5
    assert.ok(Math.abs(f.dy - 2.5) < 1e-12);
    // State carries the FILTERED output (decomp stores o_Filtered).
    assert.ok(Math.abs(st.lastDX - 12.5) < 1e-12);
    assert.ok(Math.abs(st.lastDY - 2.5) < 1e-12);
  });

  check('mouse filter: consecutive events converge (smoothing, not lag-forever)', () => {
    const st = { lastDX: 0, lastDY: 0, lastT: 0.0 };
    let out = 0;
    for (let i = 0; i < 40; i++) {
      out = m.filterMouseDelta(st, 8, 0, 0.9, 0.01 * (i + 1)).dx;
    }
    assert.ok(Math.abs(out - 8) < 0.01, `should converge toward 8, got ${out}`);
  });

  check('in-head dir-z clamp ±0.8', () => {
    assert.equal(m.clampInHeadDirZ(0.95), 0.8);
    assert.equal(m.clampInHeadDirZ(-0.95), -0.8);
    assert.equal(m.clampInHeadDirZ(0.3), 0.3);
  });

  // ── static wiring assertions (camera.js / entities.js) ────────────────
  check('camera.js reads the three C2/C3 flags', () => {
    assert.match(CAMERA_SRC, /retailCamZoom/);
    assert.match(CAMERA_SRC, /camStiffness/);
    assert.match(CAMERA_SRC, /mouseSmooth/);
  });

  check('camera.js in-head path skips the collision clip + hides the player', () => {
    assert.match(CAMERA_SRC, /_positionInHead\(p\);\s*\n\s*return;/);
    assert.match(CAMERA_SRC, /_applyCameraPlayerFade\(0\.0\)/);
  });

  check('camera.js stiffness path replaces the hard-set only when flagged', () => {
    assert.match(CAMERA_SRC, /this\._camStiffness != null/);
    assert.match(CAMERA_SRC, /_applyStiffness\(dt, finalX, finalY, finalZ/);
  });

  check('camera.js restores player opacity on orbit/topDown/dispose', () => {
    const restores = CAMERA_SRC.match(/_applyCameraPlayerFade\(1\.0\)/g) || [];
    assert.ok(restores.length >= 3, `expected ≥3 restore sites, got ${restores.length}`);
  });

  check('entities.js exposes setLocalPlayerCameraOpacity with its own snapshot keys', () => {
    assert.match(ENTITIES_SRC, /setLocalPlayerCameraOpacity\(guid, opacity\)/);
    assert.match(ENTITIES_SRC, /__preCamFadeOpacity/);
    assert.match(ENTITIES_SRC, /__preCamFadeDepthWrite/);
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
