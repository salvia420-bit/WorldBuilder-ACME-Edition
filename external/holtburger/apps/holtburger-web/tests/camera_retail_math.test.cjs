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

  // ── P0.3 / LIVE-03: degenerate follow-camera basis guard ─────────────────
  // PHY-07-LIVE-RUN-2026-07-26 §LIVE-03 measured a live camera whose world
  // matrix had horizontal forward components exactly (0, 0). Reached when the
  // sweep chain clips the camera origin onto the player's head (`clipFinalTo`
  // permits t = 0) while the follow lookAt is anchored at the player's XY.
  check('guardLookHorizontal is inert when the basis is healthy', () => {
    const g = m.guardLookHorizontal(0, -5, 0, 0, { x: 0, y: 1 }, null);
    assert.equal(g.degenerate, false);
    assert.equal(g.x, 0);
    assert.equal(g.y, 0);
    assert.equal(g.dirX, 0);
    assert.equal(g.dirY, 1);
  });

  check('guardLookHorizontal never returns a zero horizontal basis', () => {
    // Camera origin === lookAt in XY: the exact LIVE-03 state.
    const yaw = 0.7;
    const g = m.guardLookHorizontal(
      12, 34, 12, 34, { x: Math.sin(yaw), y: Math.cos(yaw) }, null);
    assert.equal(g.degenerate, true);
    const dx = g.x - 12, dy = g.y - 34;
    const horiz = Math.hypot(dx, dy);
    assert.ok(horiz > 0, 'horizontal separation must be nonzero');
    assert.ok(Math.abs(horiz - m.MIN_LOOK_HORIZ_M) < 1e-9, `horiz=${horiz}`);
    // Recovered heading must be followYaw, not an arbitrary axis.
    assert.ok(Math.abs(dx / horiz - Math.sin(yaw)) < 1e-9);
    assert.ok(Math.abs(dy / horiz - Math.cos(yaw)) < 1e-9);
  });

  check('guardLookHorizontal falls back through yaw → lastGood → world north', () => {
    // Unusable followYaw (NaN) → cached last-good heading wins.
    const g1 = m.guardLookHorizontal(
      0, 0, 0, 0, { x: NaN, y: NaN }, { x: 1, y: 0 });
    assert.equal(g1.degenerate, true);
    assert.ok(Math.abs(g1.dirX - 1) < 1e-9 && Math.abs(g1.dirY) < 1e-9);
    // Nothing usable at all → AC +Y north, still normalisable.
    const g2 = m.guardLookHorizontal(0, 0, 0, 0, null, null);
    assert.equal(g2.degenerate, true);
    assert.equal(Math.hypot(g2.dirX, g2.dirY), 1);
  });

  check('guardLookHorizontal survives non-finite inputs', () => {
    const g = m.guardLookHorizontal(NaN, NaN, NaN, NaN, null, null);
    assert.equal(g.degenerate, true);
    assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y));
    assert.equal(Math.hypot(g.dirX, g.dirY), 1);
  });

  check('camera.js runs the follow lookAt through the LIVE-03 guard', () => {
    assert.match(CAMERA_SRC, /guardLookHorizontal,/);          // imported
    assert.match(CAMERA_SRC, /const g = guardLookHorizontal\(/); // called
    assert.match(CAMERA_SRC, /this\._lastGoodLookDir = \{ x: g\.dirX, y: g\.dirY \}/);
    assert.match(CAMERA_SRC, /if \(g\.degenerate\) this\._degenerateBasisFrames \+= 1/);
    // Guard must run BEFORE the viewer-step, stiffness and hard-set branches,
    // or the smoothed path keeps emitting the degenerate basis.
    const guardAt = CAMERA_SRC.indexOf('const g = guardLookHorizontal(');
    const stiffAt = CAMERA_SRC.indexOf('this._applyStiffness(dt, finalX');
    const stepAt = CAMERA_SRC.indexOf('this._applyViewerStep(');
    assert.ok(guardAt > 0 && stiffAt > guardAt, 'guard must precede _applyStiffness');
    assert.ok(stepAt > guardAt, 'guard must precede _applyViewerStep');
  });

  check('camera.js exposes the basis-guard counter for harnesses', () => {
    assert.match(CAMERA_SRC, /cameraBasisGuard\(\)\s*\{/);
    assert.match(CAMERA_SRC, /degenerateFrames: this\._degenerateBasisFrames/);
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

  // ── 2026-10-08 round 2: retail viewer order (camera-2) ──────────────────
  // CameraManager::UpdateCamera (acclient.c:147425) lerps from the previous
  // SWEPT viewer toward the UNCLIPPED sought frame (:147841); update_viewer
  // (:144991) sweeps afterwards. Fake sweep: a wall at x = -1 (pivot at 0,
  // ideal eye at x = -6), so the sweep clamps x to ≥ -1.
  const IDEAL = { x: -6, y: 0, z: 2 };
  const LOOK = { x: 0, y: 0, z: 1.6 };
  const wall = (s) => ({ x: Math.max(s.x, -1), y: s.y, z: s.z });
  const frac45 = m.stiffnessFrac(0.45, 1 / 60); // 0.075

  check('retailViewerStep (a): frame 1 publishes on the wall, never beyond it', () => {
    const r = m.retailViewerStep(null, IDEAL, frac45, wall, LOOK);
    assert.equal(r.snapped, true);
    assert.equal(r.sought, IDEAL);
    assert.equal(r.eye.x, -1);
  });

  check('retailViewerStep (b): after the clamp releases the eye moves only frac out', () => {
    const r = m.retailViewerStep({ x: -1, y: 0, z: 2 }, IDEAL, frac45, (s) => s, LOOK);
    assert.equal(r.snapped, false);
    assert.ok(Math.abs(r.eye.x - (-1 - 5 * frac45)) < 1e-12, `x=${r.eye.x}`);
  });

  check('retailViewerStep (c): pressed against the wall the eye holds (< 1e-3 / frame)', () => {
    let prev = m.retailViewerStep(null, IDEAL, frac45, wall, LOOK).eye;
    for (let i = 0; i < 30; i++) {
      const e = m.retailViewerStep(prev, IDEAL, frac45, wall, LOOK).eye;
      assert.ok(Math.hypot(e.x - prev.x, e.y - prev.y, e.z - prev.z) < 1e-3);
      assert.ok(e.x >= -1);
      prev = e;
    }
  });

  check('retailViewerStep (d): frac = 1 (hard-lock) seeks the ideal outright', () => {
    const r = m.retailViewerStep({ x: -1, y: 0, z: 2 }, IDEAL, 1.0, null, LOOK);
    assert.equal(r.sought, IDEAL);
    assert.equal(r.eye, IDEAL);
    assert.equal(r.snapped, true);
  });

  check('retailViewerStep (e): the view direction ignores the clamp', () => {
    const a = m.retailViewerStep(null, IDEAL, 1.0, wall, LOOK).fwd;
    const b = m.retailViewerStep(null, IDEAL, 1.0, (s) => s, LOOK).fwd;
    assert.deepEqual(a, b);
    assert.ok(Math.abs(Math.hypot(a.x, a.y, a.z) - 1) < 1e-12);
    assert.ok(a.x > 0.99, 'aims from the ideal eye at the look point');
  });

  check('retailViewerStep: teleport snaps, the 4e-4 m early-out seeks the ideal', () => {
    const far = m.retailViewerStep({ x: 500, y: 0, z: 2 }, IDEAL, frac45, null);
    assert.equal(far.snapped, true);
    assert.equal(far.sought, IDEAL);
    const near = m.retailViewerStep({ x: -6.0001, y: 0, z: 2 }, IDEAL, frac45, null);
    assert.equal(near.snapped, false); // rotation still slerps
    assert.equal(near.sought, IDEAL);
    assert.equal(near.fwd, null); // no look point passed
  });

  check('camera.js viewer step: lerp first, sweep after, orientation from the ideal', () => {
    assert.match(CAMERA_SRC, /this\._camViewerStepOn = !camFlagOff\(params\?\.get\("camViewerStep"\)\)/);
    const body = CAMERA_SRC.slice(CAMERA_SRC.indexOf('  _applyViewerStep(dt, p, ctx'));
    assert.match(body, /retailViewerStep\(\s*this\._prevEyeAc,/);
    assert.match(body, /\(s\) => this\._clipCameraAgainstWorld\(p, s\.x, s\.y, s\.z, ctx, false\)/);
    assert.match(body, /this\._prevEyeAc = \{ x: eye\.x, y: eye\.y, z: eye\.z \}/);
    assert.match(body, /this\.persp\.quaternion\.slerp\(t\.q, frac\)/);
    // camera_math: the sweep runs on the LERPED sought, after the lerp.
    const MATH_SRC = fs.readFileSync(
      path.join(__dirname, '..', 'scene3d', 'camera_math.js'), 'utf8');
    const lerpAt = MATH_SRC.indexOf('x: prevEye.x + dx * frac');
    const sweepAt = MATH_SRC.indexOf('sweepFn(sought)');
    assert.ok(lerpAt > 0 && sweepAt > lerpAt, 'sweep must follow the lerp');
    // Flag on: only the terrain floor touches the ideal before the look.
    assert.match(CAMERA_SRC, /finalZ = this\._terrainFloorZ\(clipCtx, finalX, finalY, finalZ\)/);
    // Every re-seed site clears the published eye.
    const seeds = CAMERA_SRC.match(/this\._prevEyeAc = null;/g) || [];
    assert.ok(seeds.length >= 4, `expected ≥4 re-seed sites, got ${seeds.length}`);
  });

  // ── camera-4: retail viewer sphere + pivot ─────────────────────────────
  check('camera.js clip chain: retail 0.3 m sphere / 1.5 m pivot, legacy behind =off', () => {
    assert.match(CAMERA_SRC, /import \{ VIEWER_SPHERE_RADIUS_M, VIEWER_PIVOT_Z_M \} from "\.\/viewer_cell\.js"/);
    assert.match(CAMERA_SRC, /this\._camRetailSphereOn = !camFlagOff\(params\?\.get\("camRetailSphere"\)\)/);
    assert.match(CAMERA_SRC, /CAM_RADIUS = retailSphere \? VIEWER_SPHERE_RADIUS_M : CAM_LEGACY_RADIUS_M/);
    assert.match(CAMERA_SRC, /BACKOFF = retailSphere \? CAM_CONTACT_SKIN_M : CAM_LEGACY_BACKOFF_M/);
    assert.match(CAMERA_SRC, /retailSphere \? VIEWER_PIVOT_Z_M : CAM_LEGACY_PIVOT_Z_M/);
    const num = (name) => Number((CAMERA_SRC.match(new RegExp(`const ${name} = ([0-9.]+);`)) || [])[1]);
    assert.ok(num('CAM_CONTACT_SKIN_M') <= 0.02);
    assert.equal(num('CAM_LEGACY_RADIUS_M'), 0.5);
    assert.equal(num('CAM_LEGACY_BACKOFF_M'), 0.2);
    assert.equal(num('CAM_LEGACY_PIVOT_Z_M'), 1.6);
    // The terrain floor keeps the legacy margin (point sample, not a sweep).
    assert.match(CAMERA_SRC, /terrainZ \+ CAM_LEGACY_RADIUS_M \+ CAM_LEGACY_BACKOFF_M/);
  });

  // ── camera-3 stage 1: scenery sweep (step 4b) ──────────────────────────
  check('camera.js step 4b sweeps scenery behind camScenery, typeof-guarded, frees the hit', () => {
    assert.match(CAMERA_SRC, /this\._camSceneryOn = !camFlagOff\(params\?\.get\("camScenery"\)\)/);
    const at = CAMERA_SRC.indexOf('---- 4b. Outdoor scenery sweep');
    assert.ok(at > 0);
    const blk = CAMERA_SRC.slice(at, at + 700);
    assert.match(blk, /if \(this\._camSceneryOn\)/);
    assert.match(blk, /typeof handle\.sweepSphereAgainstScenery === "function"/);
    assert.match(blk, /if \(hit\) \{ clipFinalTo\(hit\); freeHit\(hit\); \}/);
    const LIB_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib.rs'), 'utf8');
    assert.match(LIB_SRC, /#\[wasm_bindgen\(js_name = sweepSphereAgainstScenery\)\]/);
    assert.match(LIB_SRC, /scene\.sweep_sphere_against_scenery\(&pose, delta, radius\)\?/);
  });

  // ── camera-5: keyless in-place turns ────────────────────────────────────
  check('inPlaceTurnYawDelta: keyless turns follow rigidly, gated + wrapped', () => {
    assert.ok(Math.abs(m.inPlaceTurnYawDelta(0, 0.3, { moved: false, keyed: false }) - 0.3) < 1e-12);
    assert.equal(m.inPlaceTurnYawDelta(0, 5e-4, {}), 0);
    assert.equal(m.inPlaceTurnYawDelta(0, 0.3, { keyed: true }), 0);
    assert.equal(m.inPlaceTurnYawDelta(0, 0.3, { moved: true }), 0);
    assert.equal(m.inPlaceTurnYawDelta(0, 0.3, { dragging: true }), 0);
    assert.equal(m.inPlaceTurnYawDelta(null, 0.3, {}), 0);
    const d = m.inPlaceTurnYawDelta(3.1, -3.1, {});
    assert.ok(Math.abs(d - (2 * Math.PI - 6.2)) < 1e-12, `wrapped ${d}`);
  });

  check('camera.js _updateAutoFollow samples the heading before its early returns', () => {
    const at = CAMERA_SRC.indexOf('  _updateAutoFollow(dt, tracking = false) {');
    assert.ok(at > 0);
    const body = CAMERA_SRC.slice(at, CAMERA_SRC.indexOf('\n  }\n', at));
    const writeAt = body.indexOf('this._lastFollowHeading = turnH;');
    assert.ok(writeAt > 0 && writeAt < body.indexOf('if (tracking) return;'));
    assert.ok(writeAt < body.indexOf('if (!this._autoFollowOn) return;'));
    assert.match(body, /inPlaceTurnYawDelta\(turnPrevH, turnH, \{/);
    assert.match(CAMERA_SRC, /this\._autoFollowTurnsOn = !camFlagOff\(params\?\.get\("autoFollowTurns"\)\)/);
    // The owner-tuned ease rate stays (verify: 4.5 is not a retail constant).
    assert.match(CAMERA_SRC, /const AUTOFOLLOW_RATE_DEFAULT = 4\.0;/);
  });

  // ── charopt-2: ViewCombatTarget ──────────────────────────────────────────
  check('trackedTargetYaw: followYaw convention (north 0, east π/2, south ±π)', () => {
    const o = { x: 10, y: 10 };
    assert.equal(m.trackedTargetYaw(o, { x: 10, y: 20 }), 0);
    assert.ok(Math.abs(m.trackedTargetYaw(o, { x: 20, y: 10 }) - Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(Math.abs(m.trackedTargetYaw(o, { x: 10, y: 0 })) - Math.PI) < 1e-12);
    assert.equal(m.trackedTargetYaw(o, { x: 10, y: 10 }), null);
  });

  check('camera.js tracks the combat target: option 0x07, melee/missile, autofollow stands down', () => {
    assert.match(CAMERA_SRC, /this\._combatTargetViewOn = !camFlagOff\(params\?\.get\("combatTargetView"\)\)/);
    assert.match(CAMERA_SRC, /const CHARACTER_OPTION_VIEW_COMBAT_TARGET = 0x07;/);
    assert.match(CAMERA_SRC, /if \(combatMode !== 2 && combatMode !== 4\) return false;/);
    assert.match(CAMERA_SRC,
      /const tracking = this\._updateCombatTargetTracking\(dt\);\s*\n\s*this\._updateAutoFollow\(dt, tracking\);/);
  });

  check('camFlagOff accepts off / 0 / false only', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'False']) assert.equal(m.camFlagOff(v), true, v);
    for (const v of [undefined, null, '', 'on', '1', 'true']) assert.equal(m.camFlagOff(v), false, String(v));
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
