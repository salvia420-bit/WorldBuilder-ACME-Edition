// tests/film_gimbal.test.mjs
//
// WHY: AC Film Mode cameras carry explicit heading/pitch/roll gimbal angles and
// quaternions in the AC frame (x east, y north, z up) instead of three.js
// `lookAt` + a fixed up vector, which snaps north-up at ±90° pitch and flips
// the image on every top-down tilt or drone pass-over. This suite executes
// scene3d/film/core/gimbal.js (and the quat.js it builds on) and proves:
//   G1  the basis is orthonormal + right-handed for every (h, p, r) on a grid
//       that includes p = ±π/2 EXACTLY, and matches the SPEC §1 formulas;
//   G2  quatFromHPR ↔ basisFromHPR ↔ qToBasis agree; hprFromQuat round-trips
//       (wrap-aware) and uses the heading hint at the poles;
//   G3  lookRotation never NaNs (coincident / non-finite / vertical targets);
//   G4  acQuatToThree / acToThreePos agree with REAL three 0.184: the three
//       camera forward (0,0,−1)·q and up (0,1,0)·q equal acToThreePos of the AC
//       forward/up (1e-9), and the conjugation equals qM ⊗ q ⊗ qM⁻¹;
//   G5  the stateful look controller over a drone PASS-OVER (eye flies north at
//       10 m/s over a target 20 m below, 30 fps, 8 s) in all three nadir modes:
//       continuous, |Δh| ≤ maxYawRate·dt every frame, pitch reaches ≤ −89°,
//       pitch-through keeps the target within 3° after settling, hold freezes
//       the heading inside the cone; no NaN anywhere.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its pure modules.
// Run from apps/holtburger-web/: node tests/film_gimbal.test.mjs

import assert from "node:assert/strict";

const G = await import("../scene3d/film/core/gimbal.js");
const Q = await import("../scene3d/film/core/quat.js");
const V = await import("../scene3d/film/core/vec3.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");
const { mulberry32 } = await import("../scene3d/film/core/rng.js");
const THREE = await import("three");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

const PI = Math.PI;
const HALF_PI = PI / 2;
const DEG = PI / 180;

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function nearV(a, b, eps, msg) {
  for (let i = 0; i < 3; i++) near(a[i], b[i], eps, `${msg ?? "vec"}[${i}] (${a} vs ${b})`);
}
function finiteAll(arr) {
  return arr.every((x) => Number.isFinite(x));
}

// ---------------------------------------------------------------------------
console.log("G0 angle helpers");

check("wrapPi maps into (−π, π], −π → π, non-finite → 0", () => {
  near(G.wrapPi(3 * PI), PI, 1e-12, "3π");
  assert.equal(G.wrapPi(-PI), PI);
  assert.equal(G.wrapPi(PI), PI);
  near(G.wrapPi(-3 * PI / 2), HALF_PI, 1e-12, "−3π/2");
  near(G.wrapPi(1e6), G.wrapPi(1e6 - 2 * PI * 159154), 1e-6, "large");
  assert.equal(G.wrapPi(NaN), 0);
  assert.equal(G.wrapPi(Infinity), 0);
  for (let a = -20; a <= 20; a += 0.37) {
    const w = G.wrapPi(a);
    assert.ok(w > -PI && w <= PI, `range ${a} → ${w}`);
    near(Math.cos(w), Math.cos(a), 1e-12, "same angle cos");
    near(Math.sin(w), Math.sin(a), 1e-12, "same angle sin");
  }
});

check("shortestAngleDiff is a − b wrapped; unwrapAngle picks the representative nearest ref", () => {
  near(G.shortestAngleDiff(-3.0, 3.0), 2 * PI - 6.0, 1e-12, "across ±π");
  near(G.shortestAngleDiff(0.1, -0.1), 0.2, 1e-12, "small");
  near(G.unwrapAngle(-3.0, 3.0), 2 * PI - 3.0, 1e-12, "unwrap across π");
  near(G.unwrapAngle(0.5, 4 * PI), 4 * PI + 0.5, 1e-12, "unwrap many turns");
  assert.equal(G.unwrapAngle(NaN, 2), 2);
  near(G.unwrapAngle(7, NaN), G.wrapPi(7), 1e-15, "non-finite ref");
});

// ---------------------------------------------------------------------------
console.log("G1 basis: orthonormal, right-handed, SPEC formulas, all pitches incl. ±π/2");

const H_GRID = [];
for (let k = -8; k <= 8; k++) H_GRID.push((k * PI) / 4);
H_GRID.push(0.3, -2.9, 5.5);
const P_GRID = [-HALF_PI, -1.5, -1.0, -0.3, 0, 0.4, 1.2, 1.5707, HALF_PI];
const R_GRID = [0, 0.25, -0.7, PI, 2.0];

check("basisFromHPR orthonormal + right × forward = up on the full grid (incl. p = ±π/2 exactly)", () => {
  let n = 0;
  for (const h of H_GRID) for (const p of P_GRID) for (const r of R_GRID) {
    const b = G.basisFromHPR(h, p, r);
    for (const k of ["right", "forward", "up"]) {
      assert.ok(finiteAll(b[k]), `finite ${k} at h=${h} p=${p} r=${r}`);
      near(V.len(b[k]), 1, 1e-12, `|${k}|`);
    }
    near(V.dot(b.right, b.forward), 0, 1e-12, "right·forward");
    near(V.dot(b.right, b.up), 0, 1e-12, "right·up");
    near(V.dot(b.forward, b.up), 0, 1e-12, "forward·up");
    nearV(V.cross(b.right, b.forward), b.up, 1e-12, "right×forward=up");
    n++;
  }
  assert.ok(n > 500, `grid size ${n}`);
});

check("roll-free basis equals the SPEC §1 closed forms; forwardFromHP agrees", () => {
  for (const h of H_GRID) for (const p of P_GRID) {
    const b = G.basisFromHPR(h, p, 0);
    nearV(b.forward, [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)], 1e-15, "forward");
    nearV(b.right, [Math.cos(h), -Math.sin(h), 0], 1e-15, "right");
    nearV(b.up, [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)], 1e-15, "up");
    nearV(G.forwardFromHP(h, p), b.forward, 1e-15, "forwardFromHP");
  }
  const id = G.basisFromHPR(0, 0, 0);
  nearV(id.right, [1, 0, 0], 0, "identity right +x");
  nearV(id.forward, [0, 1, 0], 0, "identity forward +y (north)");
  nearV(id.up, [0, 0, 1], 0, "identity up +z");
});

check("roll is right-handed about forward: r > 0 tilts the top of frame toward the right", () => {
  for (const h of [0, 1, -2.5]) for (const p of [-1, 0, 0.6]) {
    const b0 = G.basisFromHPR(h, p, 0);
    const b = G.basisFromHPR(h, p, 0.3);
    assert.ok(V.dot(b.up, b0.right) > 0.29, "up leans right");
    nearV(b.forward, b0.forward, 1e-15, "roll keeps forward");
    // right-hand rotation about forward by +0.3 maps up0 → up
    nearV(Q.qRotate(Q.qFromAxisAngle(b0.forward, 0.3), b0.up), b.up, 1e-12, "R(forward, r)·up0");
  }
});

check("basis at the nadir is continuous in h (a smooth image rotation, no singular jump)", () => {
  let prev = G.basisFromHPR(0, -HALF_PI, 0);
  for (let k = 1; k <= 720; k++) {
    const h = (k * PI) / 180;
    const b = G.basisFromHPR(h, -HALF_PI, 0);
    nearV(b.forward, [0, 0, -1], 1e-15, "forward straight down");
    assert.ok(V.dist(b.up, prev.up) < 0.0175 + 1e-9, "up moves ≤ 1° per 1° of heading");
    prev = b;
  }
});

// ---------------------------------------------------------------------------
console.log("G2 quaternion ↔ basis ↔ gimbal angles");

check("qToBasis(quatFromHPR) == basisFromHPR on the grid; quat is unit", () => {
  for (const h of H_GRID) for (const p of P_GRID) for (const r of R_GRID) {
    const q = G.quatFromHPR(h, p, r);
    near(Math.hypot(...q), 1, 1e-14, "unit");
    const a = Q.qToBasis(q), b = G.basisFromHPR(h, p, r);
    nearV(a.right, b.right, 1e-12, "right");
    nearV(a.forward, b.forward, 1e-12, "forward");
    nearV(a.up, b.up, 1e-12, "up");
    // qFromBasis inverts it (same rotation, either sign)
    assert.ok(Q.qAngle(Q.qFromBasis(b.right, b.forward, b.up), q) < 1e-7, "qFromBasis ≡ quatFromHPR");
  }
});

check("hprFromQuat(quatFromHPR(h,p,r), hint) round-trips away from the poles (wrap-aware)", () => {
  const rng = mulberry32(1013);
  for (let i = 0; i < 2000; i++) {
    const h = (rng() * 2 - 1) * 4 * PI;
    const p = (rng() * 2 - 1) * (HALF_PI - 1e-3);
    const r = (rng() * 2 - 1) * PI * 0.999;
    const hint = (rng() * 2 - 1) * 6 * PI;
    const out = G.hprFromQuat(G.quatFromHPR(h, p, r), hint);
    near(out.h, G.unwrapAngle(h, hint), 1e-9, "h unwrapped next to the hint");
    assert.ok(Math.abs(out.h - hint) <= PI + 1e-9, "h within π of hint");
    near(out.p, p, 1e-9, "p");
    near(G.shortestAngleDiff(out.r, r), 0, 1e-9, "r");
  }
});

check("hprFromQuat at the poles: h = headingHint exactly, the quaternion is reproduced", () => {
  for (const p of [HALF_PI, -HALF_PI]) for (const h of [0, 1.1, -2.7, 3.0]) for (const r of [0, 0.4, -1.3]) {
    for (const hint of [0, 0.5, -3.1, 9.0]) {
      const q = G.quatFromHPR(h, p, r);
      const out = G.hprFromQuat(q, hint);
      assert.equal(out.h, hint, "h = hint");
      near(Math.abs(out.p), HALF_PI, 1e-7, "|p| = π/2");
      assert.ok(Q.qAngle(G.quatFromHPR(out.h, out.p, out.r), q) < 1e-7, "same orientation");
    }
  }
  // roll hint keeps roll continuous
  const out = G.hprFromQuat(G.quatFromHPR(0.2, 0.1, PI - 0.01), 0, -PI);
  near(out.r, PI - 0.01 - 2 * PI, 1e-9, "roll unwrapped next to rollHint");
});

check("hprFromQuat is NaN-free on garbage (zero / NaN quaternion, missing hint)", () => {
  for (const q of [[0, 0, 0, 0], [NaN, 0, 0, 0], null, undefined, [Infinity, 1, 2, 3]]) {
    const out = G.hprFromQuat(q, 0.7);
    assert.ok(finiteAll([out.h, out.p, out.r]), `finite for ${JSON.stringify(q)}`);
  }
  const out = G.hprFromQuat([1, 0, 0, 0], NaN);
  assert.deepEqual([out.h, out.p, out.r], [0, 0, 0]);
});

// ---------------------------------------------------------------------------
console.log("G3 stateless lookRotation");

check("lookRotation: compass bearing + true elevation; forward hits the target", () => {
  const rng = mulberry32(77);
  for (let i = 0; i < 500; i++) {
    const eye = [rng() * 400 + 30000, rng() * 400 + 34000, rng() * 80];
    const tgt = [eye[0] + (rng() * 2 - 1) * 50, eye[1] + (rng() * 2 - 1) * 50, eye[2] + (rng() * 2 - 1) * 30];
    const dir = V.norm(V.sub(tgt, eye));
    const thetaV = Math.acos(Math.min(1, Math.abs(dir[2])));
    const lr = G.lookRotation(eye, tgt, { headingHint: 0.2, holdConeDeg: 1.5 });
    if (thetaV > 1.5 * DEG) {
      nearV(Q.qToBasis(lr.q).forward, dir, 1e-9, "forward → target");
    } else {
      assert.equal(lr.h, 0.2, "inside the cone → hint");
    }
    assert.ok(lr.p >= -HALF_PI && lr.p <= HALF_PI, "pitch in range");
  }
  const north = G.lookRotation([0, 0, 0], [0, 10, 0]);
  near(north.h, 0, 1e-15, "north h");
  near(north.p, 0, 1e-15, "north p");
  near(G.lookRotation([0, 0, 0], [10, 0, 0]).h, HALF_PI, 1e-15, "east = +π/2 (clockwise)");
  near(G.lookRotation([0, 0, 0], [-10, 0, 0], { headingHint: 6.0 }).h, 6.0 + G.shortestAngleDiff(-HALF_PI, 6.0), 1e-12,
    "west unwrapped next to the hint");
});

check("lookRotation straight down / coincident / non-finite: hint heading, never NaN", () => {
  const down = G.lookRotation([5, 5, 30], [5, 5, 0], { headingHint: 1.25, roll: 0.1 });
  assert.equal(down.h, 1.25);
  near(down.p, -HALF_PI, 1e-15, "p = −π/2");
  assert.equal(down.r, 0.1);
  nearV(Q.qToBasis(down.q).forward, [0, 0, -1], 1e-12, "forward down");
  const up = G.lookRotation([5, 5, 0], [5, 5, 30]);
  near(up.p, HALF_PI, 1e-15, "p = +π/2");
  const same = G.lookRotation([1, 2, 3], [1, 2, 3], { headingHint: -0.5 });
  assert.deepEqual([same.h, same.p], [-0.5, 0]);
  for (const [e, t] of [[[NaN, 0, 0], [1, 1, 1]], [[0, 0, 0], [Infinity, 0, 0]], [null, [1, 2, 3]]]) {
    const lr = G.lookRotation(e, t, { headingHint: 0.3 });
    assert.ok(finiteAll([lr.h, lr.p, lr.r, ...lr.q]), "finite");
    assert.equal(lr.h, 0.3);
  }
});

// ---------------------------------------------------------------------------
console.log("G4 three.js frame bridge (real three 0.184)");

check("acQuatToThree: three camera forward/up == acToThreePos(AC forward/up) for 1000 random (h,p,r)", () => {
  const rng = mulberry32(4242);
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    samples.push([(rng() * 2 - 1) * 2 * PI, (rng() * 2 - 1) * HALF_PI, (rng() * 2 - 1) * PI]);
  }
  for (const p of [HALF_PI, -HALF_PI]) for (const h of [0, 1, -2, 3]) samples.push([h, p, 0], [h, p, 0.5]);
  for (const [h, p, r] of samples) {
    const qAc = G.quatFromHPR(h, p, r);
    const qThree = new THREE.Quaternion(...G.acQuatToThree(qAc));
    near(qThree.length(), 1, 1e-12, "unit three quaternion");
    const b = G.basisFromHPR(h, p, r);
    fwd.set(0, 0, -1).applyQuaternion(qThree);
    up.set(0, 1, 0).applyQuaternion(qThree);
    right.set(1, 0, 0).applyQuaternion(qThree);
    nearV([fwd.x, fwd.y, fwd.z], G.acToThreePos(b.forward), 1e-9, "forward");
    nearV([up.x, up.y, up.z], G.acToThreePos(b.up), 1e-9, "up");
    nearV([right.x, right.y, right.z], G.acToThreePos(b.right), 1e-9, "right");
  }
});

check("acQuatToThree == qM ⊗ q ⊗ qM⁻¹ (qM = Rx(−90°)) computed with THREE.Quaternion; identity ↔ identity", () => {
  const qM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -HALF_PI);
  near(qM.w, Math.SQRT1_2, 1e-15, "qM.w = √½");
  near(qM.x, -Math.SQRT1_2, 1e-15, "qM.x = −√½");
  const rng = mulberry32(9);
  for (let i = 0; i < 300; i++) {
    const q = G.quatFromHPR(rng() * 7 - 3.5, rng() * PI - HALF_PI, rng() * 2 - 1);
    const raw = new THREE.Quaternion(q[1], q[2], q[3], q[0]);
    const conj = qM.clone().multiply(raw).multiply(qM.clone().invert());
    const mine = G.acQuatToThree(q);
    const s = Math.sign(conj.w * mine[3] + conj.x * mine[0] + conj.y * mine[1] + conj.z * mine[2]) || 1;
    nearV([conj.x * s, conj.y * s, conj.z * s], mine.slice(0, 3), 1e-12, "xyz");
    near(conj.w * s, mine[3], 1e-12, "w");
  }
  const id3 = G.acQuatToThree([1, 0, 0, 0]);
  near(id3[0], 0, 0, "id x");
  near(id3[1], 0, 0, "id y");
  near(id3[2], 0, 0, "id z");
  near(id3[3], 1, 0, "id w");
  const cam = new THREE.PerspectiveCamera();
  cam.quaternion.set(...G.acQuatToThree(G.quatFromHPR(0, 0, 0)));
  const f = new THREE.Vector3();
  cam.getWorldDirection(f);
  nearV([f.x, f.y, f.z], G.acToThreePos([0, 1, 0]), 1e-12, "identity AC camera looks AC north = three −z");
});

check("positions: acToThreePos(x,y,z) = [x, z, −y]; threeToAcPos inverts it; THREE.Vector3 accepted", () => {
  assert.deepEqual(G.acToThreePos(1, 2, 3), [1, 3, -2]);
  assert.deepEqual(G.acToThreePos([1, 2, 3]), [1, 3, -2]);
  assert.deepEqual(G.threeToAcPos(new THREE.Vector3(1, 3, -2)), [1, 2, 3]);
  const rng = mulberry32(3);
  for (let i = 0; i < 100; i++) {
    const v = [rng() * 1e4, rng() * 1e4, rng() * 100 - 50];
    assert.deepEqual(G.threeToAcPos(G.acToThreePos(v)), v);
    const q = G.quatFromHPR(rng() * 6, rng() * 3 - 1.5, rng());
    assert.ok(Q.qAngle(G.threeQuatToAc(G.acQuatToThree(q)), q) < 1e-12, "quat round trip");
    assert.ok(Q.qAngle(G.threeQuatToAc(new THREE.Quaternion(...G.acQuatToThree(q))), q) < 1e-7, "from THREE.Quaternion");
  }
});

check("a camera sweeping heading at the nadir stays continuous in three (no north-up snap)", () => {
  let prev = null;
  for (let k = 0; k <= 360; k++) {
    const q3 = new THREE.Quaternion(...G.acQuatToThree(G.quatFromHPR((k * PI) / 180, -HALF_PI, 0)));
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q3);
    nearV([f.x, f.y, f.z], [0, -1, 0], 1e-12, "looks straight down in three (−y)");
    if (prev) assert.ok(prev.angleTo(q3) < 1.0001 * DEG, `step ${k}: ${prev.angleTo(q3)}`);
    prev = q3;
  }
});

// ---------------------------------------------------------------------------
console.log("G5 look controller: the drone pass-over (10 m/s north, target 20 m below, 30 fps, 8 s)");

const FPS = 30;
const DT = 1 / FPS;
const TARGET = [0, 0, 0];
const eyeAt = (t) => [0, -40 + 10 * t, 20];

/** Run a full pass-over and return per-frame outputs. */
function passOver(opts) {
  const ctl = G.createLookController(opts);
  const out = [];
  for (let k = 0; k <= 8 * FPS; k++) {
    const t = k / FPS;
    const o = ctl.update(eyeAt(t), TARGET, k === 0 ? 0 : DT);
    out.push({ t, ...o, st: ctl.state() });
  }
  return { ctl, out };
}

/** Angle (radians) between the controller's forward and the true eye→target direction. */
function aimError(o) {
  const f = Q.qToBasis(o.q).forward;
  return V.angleBetween(f, V.sub(TARGET, eyeAt(o.t)));
}

function commonChecks(out, maxYawRate, maxPitchRate, label) {
  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    assert.ok(finiteAll([o.h, o.p, o.r, ...o.q]), `${label}: NaN at frame ${k}`);
    if (k === 0) continue;
    const prev = out[k - 1];
    const dh = Math.abs(o.h - prev.h);
    assert.ok(dh <= maxYawRate * DT + 1e-9, `${label}: |Δh| ${dh} > ${maxYawRate * DT} at frame ${k}`);
    const dq = Q.qAngle(prev.q, o.q);
    // continuity: orientation can change by at most the yaw + pitch + roll rate budget per frame
    assert.ok(dq <= (maxYawRate + maxPitchRate) * DT + 1e-6, `${label}: jump ${dq} rad at frame ${k}`);
  }
}

check("yaw-slew (default): continuous, |Δh| ≤ maxYawRate·dt, p reaches ≤ −89°, p ∈ [−π/2, π/2], ends on target", () => {
  const { out } = passOver({});
  commonChecks(out, 2.5, 2.0, "yaw-slew");
  const minP = Math.min(...out.map((o) => o.p));
  assert.ok(minP <= -89 * DEG, `min pitch ${minP / DEG}°`);
  for (const o of out) assert.ok(o.p >= -HALF_PI && o.p <= HALF_PI, "p range");
  const last = out[out.length - 1];
  near(G.wrapPi(last.h), PI, 2 * DEG, "slewed round to face south");
  assert.ok(aimError(last) < 1 * DEG, `final aim error ${aimError(last) / DEG}°`);
  // before the pass the camera tracks the target closely
  for (const o of out) if (o.t >= 0.5 && o.t <= 3.5) assert.ok(aimError(o) < 3 * DEG, `approach aim ${aimError(o) / DEG}° at ${o.t}`);
  // no 180° roll / image flip: roll stays ≈ 0 and heading moved monotonically one way
  for (const o of out) near(o.r, 0, 1e-12, "roll");
  const dhs = out.slice(1).map((o, i) => o.h - out[i].h).filter((d) => Math.abs(d) > 1e-9);
  assert.ok(dhs.every((d) => d > 0) || dhs.every((d) => d < 0), "heading slews one way only");
});

check("pitch-through: forward stays on the target within 3° after settling; heading never flips", () => {
  const { out } = passOver({ nadirMode: "pitch-through" });
  commonChecks(out, 2.5, 2.0, "pitch-through");
  let worst = 0;
  for (const o of out) if (o.t >= 1.0) worst = Math.max(worst, aimError(o));
  assert.ok(worst < 3 * DEG, `worst aim error ${worst / DEG}°`);
  const h0 = out[0].h;
  for (const o of out) near(o.h, h0, 1e-6, "heading held (the camera pitches through instead)");
  const last = out[out.length - 1];
  assert.ok(last.inverted === true && last.pRaw < -HALF_PI, `inverted after the pass (pRaw ${last.pRaw / DEG}°)`);
  assert.ok(last.p >= -HALF_PI && last.p <= HALF_PI, "reported p clamped");
  const minP = Math.min(...out.map((o) => o.p));
  assert.ok(minP <= -89 * DEG, `min pitch ${minP / DEG}°`);
});

check("hold: heading constant while the target is inside the cone, then slews within the rate limit", () => {
  const { out } = passOver({ nadirMode: "hold", holdConeDeg: 2 });
  commonChecks(out, 2.5, 2.0, "hold");
  const frozen = out.filter((o) => o.st.frozen);
  assert.ok(frozen.length >= 3, `frozen frames ${frozen.length}`);
  const hFrozen = frozen[0].h;
  for (const o of frozen) assert.equal(o.h, hFrozen, "heading frozen exactly");
  // frozen spans exactly the cone exit at 2×holdConeDeg: horizontal offset < 20·tan(4°)
  for (const o of frozen) {
    const e = eyeAt(o.t);
    assert.ok(Math.hypot(e[0], e[1]) < 20 * Math.tan(4 * DEG) + 0.34, "frozen only near the pole");
  }
  const minP = Math.min(...out.map((o) => o.p));
  assert.ok(minP <= -89 * DEG, `min pitch ${minP / DEG}°`);
  const last = out[out.length - 1];
  assert.ok(aimError(last) < 1 * DEG, `final aim ${aimError(last) / DEG}°`);
});

check("yaw-slew with a headingHint rotates the image at the nadir smoothly (drone gimbal flip)", () => {
  const ctl = G.createLookController({ nadirMode: "yaw-slew", maxYawRate: 1.0 });
  const eye = [10, 10, 50];
  const tgt = [10, 10, 0];
  ctl.update(eye, tgt, 0, { headingHint: 0 });
  let prevH = ctl.state().h;
  for (let k = 1; k <= 120; k++) {
    const o = ctl.update(eye, tgt, DT, { headingHint: PI / 2 });
    assert.ok(Math.abs(o.h - prevH) <= 1.0 * DT + 1e-9, "rate-limited image rotation");
    nearV(Q.qToBasis(o.q).forward, [0, 0, -1], 1e-9, "still looking straight down");
    prevH = o.h;
  }
  near(prevH, PI / 2, 1e-3, "rotated to the hinted heading");
});

check("rate limits hold for a sudden 180° target jump; dt = 0 / NaN returns the current pose", () => {
  const ctl = G.createLookController({ maxYawRate: 1.5, maxPitchRate: 0.8, smoothTime: 0.1 });
  ctl.update([0, 0, 10], [0, 50, 10], 0);
  let prev = ctl.update([0, 0, 10], [0, 50, 10], DT);
  for (let k = 0; k < 200; k++) {
    const o = ctl.update([0, 0, 10], [0, -50, -20], DT);
    assert.ok(Math.abs(o.h - prev.h) <= 1.5 * DT + 1e-9, "yaw rate");
    assert.ok(Math.abs(o.p - prev.p) <= 0.8 * DT + 1e-9, "pitch rate");
    prev = o;
  }
  assert.ok(aimError({ q: prev.q, t: 0 }) >= 0, "finite");
  const f = Q.qToBasis(prev.q).forward;
  assert.ok(V.angleBetween(f, V.sub([0, -50, -20], [0, 0, 10])) < 1 * DEG, "converged");
  const same0 = ctl.update([0, 0, 10], [50, 0, 10], 0);
  const sameN = ctl.update([0, 0, 10], [50, 0, 10], NaN);
  assert.equal(same0.h, prev.h);
  assert.equal(sameN.h, prev.h);
});

check("controller: NaN / coincident inputs hold the aim; reset(h,p,r) snaps; unknown nadirMode throws FilmError", () => {
  const ctl = G.createLookController({});
  ctl.reset(0.5, -0.2, 0);
  const a = ctl.update([NaN, 0, 0], [1, 2, 3], DT);
  assert.ok(finiteAll([a.h, a.p, a.r, ...a.q]));
  near(a.h, 0.5, 1e-12, "held h");
  const b = ctl.update([1, 2, 3], [1, 2, 3], DT);
  assert.ok(finiteAll([b.h, b.p, b.r, ...b.q]));
  ctl.reset();
  assert.equal(ctl.state().initialized, false);
  const c = ctl.update([0, 0, 0], [10, 0, 0], DT);
  near(c.h, HALF_PI, 1e-12, "first update after reset() snaps");
  assert.throws(() => G.createLookController({ nadirMode: "spin" }), (e) => e instanceof FilmError && e.code === "BAD_ARGUMENT");
  assert.deepEqual(G.NADIR_MODES, ["yaw-slew", "pitch-through", "hold"]);
});

check("controller output is deterministic (same inputs → bit-identical outputs)", () => {
  const a = passOver({ nadirMode: "pitch-through" }).out.map((o) => [o.h, o.p, o.r]);
  const b = passOver({ nadirMode: "pitch-through" }).out.map((o) => [o.h, o.p, o.r]);
  assert.deepEqual(a, b);
});

console.log(`film_gimbal: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
