// tests/film_flight_model.test.mjs
//
// WHY: drone and FPV takes are flown through a multirotor flight model so the
// footage has real inertia: the take player runs nominal → drone dynamics →
// pilot residual → safety every frame, and flyTrajectory bakes "real drone
// feel" for scouting and rehearsals. If the model breaks its own limits,
// overshoots a target, banks the wrong way, lets a stabilised gimbal tilt
// past +30° or flip at nadir, overruns a take, or is not deterministic, every
// aerial shot inherits the bug. This suite EXECUTES
// scene3d/film/drone/flight_model.js and proves:
//   F1  presets (cinema/heavy/fpv/indoor) carry the SPEC numbers; config
//       resolution, overrides and readable errors;
//   F2  step targets converge with ≤ 5 % overshoot on every preset and step
//       size, with |v| ≤ vmax, |a| ≤ amax, |jerk| ≤ jmax;
//   F3  limits hold on an infeasible zig-zag target;
//   F4  body attitude: bank sign = lateral-acceleration sign (right turn →
//       roll > 0), nose down accelerating / up braking, tilt ≤ maxTiltDeg;
//   F5  gimbal camera pitch stays in [−90°, +30°], a nadir image rotation is
//       not mistaken for roll, the roll limit bounds the horizon-roll FOLLOW
//       ERROR (wrap-aware, relative to the target's own roll) but carries a
//       deliberate roll; it never snaps (follow + correction ≤ maxRateDeg),
//       and a target roll crossing ±180° while the gimbal lags (synthetic
//       ramps and jumps, fpv.fpv-flip, a canyon-run rolled near ±180°) is
//       followed the short way, never the long way round; the gimbal ignores
//       body bank while the FPV hard mount shows gust deviations;
//   F6  flyTrajectory: duration within [D, 1.1·D], validates, small tracking
//       error, speeds within the preset, metadata, rest-ending overrun capped;
//       drone.pass-over flown in every nadirMode (pitch-through keeps its
//       inverted image) rotates no faster than 1.5× the nominal per frame;
//   F7  determinism per wind seed; robustness (NaN targets, dt ≤ 0, resets),
//       JSON-safe state, presetForTrajectory.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — this is its pure flight model.
// Run from apps/holtburger-web/: node tests/film_flight_model.test.mjs

import assert from "node:assert/strict";

const FM = await import("../scene3d/film/drone/flight_model.js");
const SH = await import("../scene3d/film/shots/index.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const G = await import("../scene3d/film/core/gimbal.js");
const Q = await import("../scene3d/film/core/quat.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");

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
const DEG = PI / 180;
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}
function filmErr(re) {
  return (e) => {
    assert.ok(e instanceof FilmError, `expected FilmError, got ${e && e.name}: ${e && e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  };
}
function issuesText(v) {
  return v.issues.slice(0, 4).map((i) => i.message).join(" | ");
}

/** Run a drone toward per-frame targets; returns per-frame states and limit maxima (finite differences). */
function run(drone, targetAt, seconds, dt) {
  const states = [];
  let maxV = 0, maxA = 0, maxAfd = 0, maxJ = 0;
  let prev = drone.state();
  for (let k = 1; k <= Math.round(seconds / dt); k++) {
    drone.step(targetAt(k * dt), dt);
    const s = drone.state();
    maxV = Math.max(maxV, s.speed);
    maxA = Math.max(maxA, vlen(s.acc));
    maxAfd = Math.max(maxAfd, vlen(sub(s.vel, prev.vel)) / dt);
    maxJ = Math.max(maxJ, vlen(sub(s.acc, prev.acc)) / dt);
    states.push(s);
    prev = s;
  }
  return { states, maxV, maxA, maxAfd, maxJ };
}

const X0 = 30016, Y0 = 32128;
const ground = (x, y) => 50 + 0.12 * (x - X0) + 0.06 * (y - Y0);
const SUBJECT = { pos: [X0, Y0, ground(X0, Y0)], height: 1.8, radius: 0.5, heading: 0.4 };
const base = { subject: SUBJECT, groundZ: ground };

// ---------------------------------------------------------------------------
console.log("F1 presets and configuration");
// ---------------------------------------------------------------------------
check("DRONE_PRESETS: cinema/heavy/fpv/indoor with the SPEC numbers; heavy slower, indoor slow with small tilt", () => {
  assert.deepEqual([...FM.DRONE_PRESET_NAMES], ["cinema", "heavy", "fpv", "indoor"]);
  const { cinema, heavy, fpv, indoor } = FM.DRONE_PRESETS;
  assert.deepEqual([cinema.vmax, cinema.amax, cinema.jmax, cinema.maxTiltDeg, cinema.mount], [12, 4, 8, 25, "gimbal"]);
  assert.deepEqual([fpv.vmax, fpv.amax, fpv.maxTiltDeg, fpv.mount, fpv.uptiltDeg], [25, 15, 60, "hard", 20]);
  assert.ok(heavy.vmax < cinema.vmax && heavy.amax < cinema.amax && heavy.jmax < cinema.jmax && heavy.rotSmoothSec > cinema.rotSmoothSec);
  assert.ok(indoor.vmax < heavy.vmax && indoor.maxTiltDeg < cinema.maxTiltDeg && indoor.mount === "gimbal");
  for (const p of [cinema, heavy, indoor]) assert.deepEqual([p.pitchMinDeg, p.pitchMaxDeg], [-90, 30]);
  assert.ok(Object.isFrozen(FM.DRONE_PRESETS) && Object.isFrozen(cinema));
});

check("resolveDroneConfig / createDrone: names, overrides on a preset, wind, readable errors", () => {
  assert.equal(FM.createDrone().config.preset, "cinema");
  const c = FM.resolveDroneConfig({ preset: "fpv", vmax: 18, wind: { gustMps: 4, seed: "take-7" } });
  assert.equal(c.preset, "fpv");
  assert.equal(c.vmax, 18);
  assert.equal(c.amax, 15);
  assert.equal(c.wind.gustMps, 4);
  assert.equal(typeof c.wind.seed, "number");
  assert.throws(() => FM.createDrone("racer"), filmErr(/unknown preset "racer".*cinema, heavy, fpv, indoor/));
  assert.throws(() => FM.createDrone({ vmaxx: 3 }), filmErr(/unknown config key "vmaxx"/));
  assert.throws(() => FM.createDrone({ vmax: -1 }), filmErr(/vmax must be a number in \(0, 200\]/));
  assert.throws(() => FM.createDrone({ mount: "tripod" }), filmErr(/mount must be "gimbal" or "hard"/));
  assert.throws(() => FM.createDrone({ wind: { gustMps: NaN } }), filmErr(/gustMps/));
  assert.throws(() => FM.createDrone(42), filmErr(/preset name/));
});

// ---------------------------------------------------------------------------
console.log("F2 step response: converges without overshoot, inside vmax / amax / jmax");
// ---------------------------------------------------------------------------
for (const preset of FM.DRONE_PRESET_NAMES) {
  check(`${preset}: steps of 0.5 / 2 / 5 / 30 m and a 3-D diagonal converge, overshoot ≤ 5 %, limits hold`, () => {
    const cfg = FM.DRONE_PRESETS[preset];
    for (const step of [[0.5, 0, 0], [2, 0, 0], [5, 0, 0], [30, 0, 0], [20, -15, 8], [0, 0, -40]]) {
      const d = FM.createDrone(preset);
      d.reset({ pos: [0, 0, 0], h: 0, p: 0 });
      const L = vlen(step);
      const n = step.map((x) => x / L);
      const r = run(d, () => ({ pos: step, h: 0, p: 0 }), 30, 1 / 60);
      let maxAlong = -Infinity;
      for (const s of r.states) maxAlong = Math.max(maxAlong, s.pos[0] * n[0] + s.pos[1] * n[1] + s.pos[2] * n[2]);
      assert.ok(maxAlong <= 1.05 * L, `${JSON.stringify(step)} overshoot ${((maxAlong / L - 1) * 100).toFixed(2)} %`);
      const last = r.states[r.states.length - 1];
      assert.ok(vlen(sub(last.pos, step)) < 0.01 && last.speed < 0.01, `${JSON.stringify(step)} converged`);
      assert.ok(r.maxV <= cfg.vmax * (1 + 1e-9), `|v| ${r.maxV} > ${cfg.vmax}`);
      assert.ok(r.maxA <= cfg.amax * (1 + 1e-9), `|a| ${r.maxA} > ${cfg.amax}`);
      assert.ok(r.maxAfd <= cfg.amax * (1 + 1e-6), `Δv/dt ${r.maxAfd} > ${cfg.amax}`);
      assert.ok(r.maxJ <= cfg.jmax * (1 + 1e-6), `jerk ${r.maxJ} > ${cfg.jmax}`);
    }
  });
}

check("a long step reaches (but never exceeds) vmax and brakes inside the remaining distance", () => {
  const d = FM.createDrone("cinema");
  d.reset({ pos: [0, 0, 0], h: 0, p: 0 });
  const r = run(d, () => ({ pos: [400, 0, 0], h: 0, p: 0 }), 50, 1 / 30);
  assert.ok(r.maxV > 11.9 && r.maxV <= 12 + 1e-9, `cruise ${r.maxV}`);
  assert.ok(Math.max(...r.states.map((s) => s.pos[0])) <= 400 * 1.0001);
});

// ---------------------------------------------------------------------------
console.log("F3 infeasible targets");
// ---------------------------------------------------------------------------
check("a 2 Hz ±10 m zig-zag target (far beyond the craft) never breaks vmax / amax / jmax", () => {
  for (const preset of ["cinema", "fpv"]) {
    const cfg = FM.DRONE_PRESETS[preset];
    const d = FM.createDrone(preset);
    d.reset({ pos: [0, 0, 10], h: 0, p: 0 });
    const r = run(d, (t) => ({ pos: [10 * Math.sign(Math.sin(4 * PI * t)), 20 * t, 10 + 5 * Math.sin(3 * t)], h: 0, p: 0 }), 10, 1 / 30);
    assert.ok(r.maxV <= cfg.vmax * (1 + 1e-9) && r.maxA <= cfg.amax * (1 + 1e-9) && r.maxJ <= cfg.jmax * (1 + 1e-6), preset);
    for (const s of r.states) assert.ok(s.pos.every(Number.isFinite));
  }
});

// ---------------------------------------------------------------------------
console.log("F4 body attitude from the thrust vector");
// ---------------------------------------------------------------------------
/** Fly a circle of radius 20 m at 6 m/s; sgn +1 = clockwise seen from above (turning right). */
function circle(preset, sgn) {
  const d = FM.createDrone(preset);
  const R = 20, w = 0.3;
  const P = (t) => [R * Math.sin(sgn * w * t), R * Math.cos(sgn * w * t), 10];
  const hdg = (t) => sgn * w * t + sgn * PI / 2;
  d.reset({ pos: P(0), h: hdg(0), p: 0 }, { velocity: [R * sgn * w, 0, 0] });
  const out = [];
  for (let i = 1; i <= 600; i++) {
    const t = i / 60;
    d.step({ pos: P(t), h: hdg(t), p: 0 }, 1 / 60);
    if (i > 240) out.push(d.state());
  }
  return out;
}

check("bank sign matches lateral acceleration: clockwise (right) turn → roll > 0, left → roll < 0, ≈ atan(v²/(R·g))", () => {
  for (const preset of ["cinema", "fpv", "heavy"]) {
    for (const sgn of [1, -1]) {
      const st = circle(preset, sgn);
      for (const s of st) {
        // lateral acceleration in the body frame (right axis of the yaw frame)
        const right = [Math.cos(s.body.h), -Math.sin(s.body.h), 0];
        const alat = s.acc[0] * right[0] + s.acc[1] * right[1];
        assert.equal(Math.sign(s.body.r), Math.sign(alat), `${preset} sign(roll) = sign(a_lat)`);
        assert.equal(Math.sign(s.body.r), sgn, `${preset} banks into the ${sgn > 0 ? "right" : "left"} turn`);
      }
      const mean = st.reduce((a, s) => a + s.body.r, 0) / st.length;
      near(Math.abs(mean), Math.atan((6 * 6) / 20 / 9.80665), 1.5 * DEG, `${preset} bank magnitude`);
    }
  }
});

check("pitch: nose down while accelerating forward, nose up while braking; tilt never exceeds maxTiltDeg", () => {
  for (const preset of FM.DRONE_PRESET_NAMES) {
    const cfg = FM.DRONE_PRESETS[preset];
    const d = FM.createDrone(preset);
    d.reset({ pos: [0, 0, 10], h: 0, p: 0 });
    let sawDown = false, sawUp = false;
    for (let i = 1; i <= 1500; i++) {
      d.step({ pos: [0, 60, 10], h: 0, p: 0 }, 1 / 60);
      const s = d.state();
      assert.ok(Math.hypot(s.body.p, s.body.r) <= cfg.maxTiltDeg * DEG + 1e-9, `${preset} tilt`);
      if (s.acc[1] > 0.5) { assert.ok(s.body.p < 0, `${preset} nose down accelerating`); sawDown = true; }
      if (s.acc[1] < -0.5 && s.vel[1] < 1) { assert.ok(s.body.p > 0, `${preset} nose up braking`); sawUp = true; }
    }
    assert.ok(sawDown && sawUp, preset);
  }
});

// ---------------------------------------------------------------------------
console.log("F5 camera mounts");
// ---------------------------------------------------------------------------
check("gimbal pitch is limited to [−90°, +30°] for any target orientation (seeded random sweep)", () => {
  for (const preset of ["cinema", "heavy", "indoor"]) {
    const d = FM.createDrone(preset);
    d.reset({ pos: [0, 0, 10], h: 0, p: 0 });
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    let maxP = -Infinity, minP = Infinity;
    for (let i = 0; i < 1200; i++) {
      const tgt = i < 200 ? { h: 0, p: 70 * DEG } : i < 400 ? { h: 1, p: -PI / 2 } : { h: rnd() * 8 - 4, p: (rnd() * 2 - 1) * PI / 2, r: (rnd() - 0.5) * 0.4 };
      const pose = d.step({ pos: [0, 0, 10], ...tgt }, 1 / 30);
      maxP = Math.max(maxP, pose.p);
      minP = Math.min(minP, pose.p);
      assert.ok(pose.q.every(Number.isFinite));
    }
    assert.ok(maxP <= 30 * DEG + 1e-9, `${preset} max pitch ${maxP / DEG}`);
    near(maxP, 30 * DEG, 1e-6, `${preset} reaches the +30° stop`);
    assert.ok(minP >= -PI / 2 - 1e-12);
  }
});

check("a nadir image rotation (top-down rotateDeg 180) flown on a gimbal keeps −90° and rotates — never read as roll", () => {
  const tr = SH.buildShot({ technique: "drone.top-down", duration: 6, params: { rotateDeg: 180 } }, base);
  const fl = FM.flyTrajectory(tr, "cinema", 30);
  const v = TR.validateTrajectory(fl);
  assert.ok(v.ok, issuesText(v));
  for (const t of [0, 1.5, 3, 4.5, 6]) near(fl.sample(t).p, -PI / 2, 0.5 * DEG, `pitch at ${t}`);
  const rot = Q.qAngle(fl.sample(0).q, fl.sample(6).q);
  assert.ok(rot > 170 * DEG, `image rotated ${rot / DEG}°`);
});

/**
 * Horizon roll of a camera orientation (radians, ±π = inverted), measured exactly as the flight
 * model's gimbal limit measures it; NaN within 18° of nadir/zenith (no horizon in frame).
 */
function horizonRoll(q) {
  const B = Q.qToBasis(q), F = B.forward;
  if (!(Math.abs(F[2]) < Math.sin(72 * DEG))) return NaN;
  const hl = Math.hypot(F[0], F[1]);
  const R0 = [F[1] / hl, -F[0] / hl, 0];
  const U0 = [R0[1] * F[2] - R0[2] * F[1], R0[2] * F[0] - R0[0] * F[2], R0[0] * F[1] - R0[1] * F[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.atan2(-dot(B.right, U0), dot(B.right, R0));
}
/** Wrap-aware |roll error| of a camera vs a target roll (radians). */
const rollErr = (q, rT) => Math.abs(G.shortestAngleDiff(horizonRoll(q), rT));
/** Tolerance on "never faster than maxRateDeg": sub-step rotations about different axes compose to ≤ 1e-5 over. */
const RATE_TOL = 1 + 1e-4;

check("gimbal roll limit bounds follow error, not intent: a deliberate 80° roll (and a 70° reset) is carried; a target snapped back level is followed at ≤ maxRateDeg (no snap), the error never grows and is inside ±45° within ⌈35°/maxRate⌉ + 2 frames (one for the target's in-frame interpolation)", () => {
  const rollOf = (q) => G.hprFromQuat(q, 0, 0).r;
  for (const preset of ["cinema", "heavy", "indoor"]) {
    const cfg = FM.DRONE_PRESETS[preset];
    const lim = cfg.rollLimitDeg * DEG, maxStep = (cfg.maxRateDeg * DEG) / 30;
    const d0 = FM.createDrone(preset);
    near(rollOf(d0.reset({ pos: [0, 0, 10], h: 0, p: 0, r: 70 * DEG }).q), 70 * DEG, 1e-9, `${preset}: reset keeps its intended roll`);
    const d = FM.createDrone(preset);
    let prev = d.reset({ pos: [0, 0, 10], h: 0, p: 0, r: 0 });
    // roll ramps 0 → 80° over 1 s, holds to 2 s, then the target is level again (an 80° jump)
    const rollAt = (t) => (t < 1 ? 80 * DEG * t : t < 2 - 1e-9 ? 80 * DEG : 0);
    let held = 0, inside = null, prevErr = Infinity;
    const bound = Math.ceil(((80 * DEG - lim) / (cfg.maxRateDeg * DEG)) * 30) + 2;
    for (let k = 1; k <= 120; k++) {
      const t = k / 30;
      const pose = d.step({ pos: [0, 0, 10], h: 0, p: 0, r: rollAt(t) }, 1 / 30);
      const dq = Q.qAngle(prev.q, pose.q);
      assert.ok(dq <= maxStep * RATE_TOL, `${preset} t=${t}: turned ${dq / DEG}° in one frame (gimbal limit ${maxStep / DEG}°)`);
      const e = rollErr(pose.q, rollAt(t));
      if (t < 2 - 1e-9) assert.ok(e <= lim, `${preset} t=${t}: roll follow error ${e / DEG}° past ±${lim / DEG}° while carrying the deliberate roll`);
      if (t >= 1.75 && t < 2 - 1e-9) held = Math.max(held, Math.abs(rollOf(pose.q) - 80 * DEG));
      if (t >= 2 - 1e-9) {
        assert.ok(e <= prevErr + 1e-9, `${preset} t=${t}: follow error grew ${prevErr / DEG}° → ${e / DEG}°`);
        if (inside === null && e <= lim + 1e-9) inside = k - 59;
        prevErr = e;
      }
      prev = pose;
    }
    assert.ok(held < 2.5 * DEG, `${preset}: the intended 80° roll is carried (off by ${held / DEG}°)`);
    assert.ok(inside !== null && inside <= bound, `${preset}: back inside ±${lim / DEG}° after ${inside} frames (bound ${bound})`);
    assert.ok(prevErr < 0.5 * DEG, `${preset}: settles level (${prevErr / DEG}°)`);
  }
});

check("a target roll crossing ±180° while the gimbal lags (60° → 300°, rolling at 1.2× / 1.45× maxRateDeg, both directions, 24/30/60 fps): the camera follows the short way across the seam — never turns back, never faster than maxRateDeg — and settles on it", () => {
  for (const preset of ["cinema", "heavy", "indoor"]) {
    const mr = FM.DRONE_PRESETS[preset].maxRateDeg * DEG;
    for (const factor of [1.2, 1.45]) {
      for (const sgn of [1, -1]) {
        for (const fps of [24, 30, 60]) {
          const tag = `${preset} ×${factor} ${sgn > 0 ? "+" : "−"} ${fps} fps`;
          const w = sgn * factor * mr, r0 = sgn * 60 * DEG, r1 = sgn * 300 * DEG, T = (r1 - r0) / w;
          // the target's roll arrives wrapped into (−π, π], as a technique emits it: it jumps ±360° at the seam
          const rollAt = (t) => G.wrapPi(t < T ? r0 + w * t : r1);
          const d = FM.createDrone(preset);
          let prev = d.reset({ pos: [0, 0, 10], h: 0.3, p: -0.3, r: r0 });
          let maxErr = 0, e = 0, crossed = 0;
          for (let k = 1; k <= Math.round((T + 3) * fps); k++) {
            const t = k / fps;
            const pose = d.step({ pos: [0, 0, 10], h: 0.3, p: -0.3, r: rollAt(t) }, 1 / fps);
            const dq = Q.qAngle(prev.q, pose.q);
            assert.ok(dq <= (mr / fps) * RATE_TOL, `${tag} t=${t.toFixed(3)}: turned ${dq / DEG}° in one frame (gimbal limit ${mr / fps / DEG}°)`);
            const dr = sgn * G.shortestAngleDiff(horizonRoll(pose.q), horizonRoll(prev.q));
            assert.ok(dr >= -1e-6, `${tag} t=${t.toFixed(3)}: the camera rolled ${dr / DEG}° back against the target (the long way round)`);
            if (Math.abs(horizonRoll(pose.q)) > 170 * DEG) crossed += 1;
            e = rollErr(pose.q, rollAt(t));
            maxErr = Math.max(maxErr, e);
            prev = pose;
          }
          assert.ok(crossed > 0, `${tag}: the camera itself crossed the seam`);
          const lagBound = (1 - 1 / factor) * 240 * DEG + 10 * DEG;
          assert.ok(maxErr <= lagBound, `${tag}: max roll error ${maxErr / DEG}° (only the rate deficit, ≤ ${lagBound / DEG}°)`);
          assert.ok(e < 0.5 * DEG, `${tag}: settles on the target's roll (${e / DEG}°)`);
        }
      }
    }
  }
});

check("the roll limit itself turns the short way across ±180°: camera settled at ±170°, target jumps to ∓110° (80° through the seam); at ≤ maxRateDeg the error never grows and the camera rolls forward through the seam; with a sluggish follow (rotSmoothSec 3) the limit pulls it inside ±45° in ⌈35°/maxRate⌉ + 2 frames, which without the limit (rollLimitDeg 180) takes far longer", () => {
  const insideAfter = (config, sgn, fps, opts = {}) => {
    const mr = FM.resolveDroneConfig(config).maxRateDeg * DEG;
    const ra = sgn * 170 * DEG, rb = -sgn * 110 * DEG;
    const d = FM.createDrone(config);
    let prev = d.reset({ pos: [0, 0, 10], h: 1, p: 0.1, r: ra });
    for (let k = 0; k < fps; k++) prev = d.step({ pos: [0, 0, 10], h: 1, p: 0.1, r: ra }, 1 / fps);
    let prevErr = rollErr(prev.q, rb), inside = null;
    for (let k = 1; k <= 4 * fps; k++) {
      const pose = d.step({ pos: [0, 0, 10], h: 1, p: 0.1, r: rb }, 1 / fps);
      if (opts.strict) {
        const tag = `${JSON.stringify(config)} ${sgn > 0 ? "+" : "−"} ${fps} fps frame ${k}`;
        const dq = Q.qAngle(prev.q, pose.q);
        assert.ok(dq <= (mr / fps) * RATE_TOL, `${tag}: turned ${dq / DEG}° (gimbal limit ${mr / fps / DEG}°)`);
        const dr = sgn * G.shortestAngleDiff(horizonRoll(pose.q), horizonRoll(prev.q));
        assert.ok(dr >= -1e-6, `${tag}: rolled ${dr / DEG}° the long way round`);
        const e = rollErr(pose.q, rb);
        assert.ok(e <= prevErr + 1e-9, `${tag}: follow error grew ${prevErr / DEG}° → ${e / DEG}°`);
        prevErr = e;
      }
      if (inside === null && rollErr(pose.q, rb) <= 45 * DEG + 1e-9) inside = k;
      prev = pose;
    }
    return { inside, endErr: rollErr(prev.q, rb), mr };
  };
  for (const preset of ["cinema", "heavy", "indoor"]) {
    for (const sgn of [1, -1]) {
      for (const fps of [24, 30, 60]) {
        const tag = `${preset} ${sgn > 0 ? "+" : "−"} ${fps} fps`;
        const plain = insideAfter(preset, sgn, fps, { strict: true });
        assert.ok(plain.endErr < 0.5 * DEG, `${tag}: settles on the target (${plain.endErr / DEG}°)`);
        const slow = insideAfter({ preset, rotSmoothSec: 3 }, sgn, fps, { strict: true });
        const bound = Math.ceil((35 * DEG / slow.mr) * fps) + 2;
        assert.ok(slow.inside !== null && slow.inside <= bound, `${tag} sluggish: inside ±45° after ${slow.inside} frames (bound ${bound})`);
        const free = insideAfter({ preset, rotSmoothSec: 3, rollLimitDeg: 180 }, sgn, fps);
        assert.ok(free.inside === null || free.inside > 2 * bound, `${tag}: without the limit it takes ${free.inside} frames (the limit is what pulled it in)`);
      }
    }
  }
});

check("fpv.fpv-flip barrel roll (±) and drone.canyon-run rolled near ±180° (roll ±3.0, maxBankDeg 60) flown on cinema/heavy/indoor gimbals at 24/30/60 fps: never faster than maxRateDeg, the flip is followed all the way round (no unwinding), the canyon run's roll error stays < 10°, and the limit never leaves a larger error than no limit at all", () => {
  const CANYON = { ...base, path: [[X0 - 120, Y0], [X0 - 60, Y0 + 30], [X0, Y0 - 20], [X0 + 60, Y0 + 30], [X0 + 120, Y0 - 10]].map(([x, y]) => [x, y, ground(x, y)]) };
  const fly = (tr, config, fps) => {
    const d = FM.createDrone(config);
    const ts = TR.frameTimes(tr.duration, fps);
    let prev = d.reset({ ...tr.sample(0), t: 0 });
    const out = { maxDq: 0, maxErr: 0, maxRollErr: 0, travel: 0, minStep: Infinity, maxStep: -Infinity };
    for (let k = 1; k < ts.length; k++) {
      const nom = tr.sample(ts[k]);
      const pose = d.step({ ...nom, t: ts[k] }, ts[k] - ts[k - 1]);
      out.maxDq = Math.max(out.maxDq, Q.qAngle(prev.q, pose.q));
      out.maxErr = Math.max(out.maxErr, Q.qAngle(pose.q, nom.q));
      const r = horizonRoll(pose.q), rp = horizonRoll(prev.q), rn = horizonRoll(nom.q);
      if (Number.isFinite(r) && Number.isFinite(rn)) out.maxRollErr = Math.max(out.maxRollErr, Math.abs(G.shortestAngleDiff(r, rn)));
      if (Number.isFinite(r) && Number.isFinite(rp)) {
        const dr = G.shortestAngleDiff(r, rp);
        out.travel += dr;
        out.minStep = Math.min(out.minStep, dr);
        out.maxStep = Math.max(out.maxStep, dr);
      }
      prev = pose;
    }
    return out;
  };
  const shots = [
    ["fpv-flip +", SH.buildShot({ technique: "fpv.fpv-flip" }, base), 1],
    ["fpv-flip −", SH.buildShot({ technique: "fpv.fpv-flip", params: { direction: "negative" } }, base), -1],
    ["canyon-run roll 3.0", SH.buildShot({ technique: "drone.canyon-run", roll: 3.0, params: { maxBankDeg: 60 } }, CANYON), 0],
    ["canyon-run roll −3.0", SH.buildShot({ technique: "drone.canyon-run", roll: -3.0, params: { maxBankDeg: 60 } }, CANYON), 0],
  ];
  for (const [name, tr, flipSign] of shots) {
    for (const preset of ["cinema", "heavy", "indoor"]) {
      for (const fps of [24, 30, 60]) {
        const tag = `${name} ${preset} ${fps} fps`;
        const mr = FM.DRONE_PRESETS[preset].maxRateDeg * DEG;
        const got = fly(tr, preset, fps);
        assert.ok(got.maxDq <= (mr / fps) * RATE_TOL, `${tag}: a frame turned ${got.maxDq / DEG}° (gimbal limit ${mr / fps / DEG}°)`);
        if (flipSign) {
          near(got.travel, flipSign * 2 * PI, 2 * DEG, `${tag}: camera roll travel`);
          assert.ok(flipSign > 0 ? got.minStep >= -1e-6 : got.maxStep <= 1e-6, `${tag}: the camera unwound against the flip (${(flipSign > 0 ? got.minStep : got.maxStep) / DEG}°/frame)`);
        } else {
          assert.ok(got.maxRollErr < 10 * DEG, `${tag}: roll error ${got.maxRollErr / DEG}° across the ±180° seam`);
        }
        const free = fly(tr, { preset, rollLimitDeg: 180 }, fps);
        assert.ok(got.maxErr <= free.maxErr + 0.5 * DEG, `${tag}: the limit made the follow error worse (${got.maxErr / DEG}° vs ${free.maxErr / DEG}° unlimited)`);
      }
    }
  }
});

check("gimbal ignores body bank (camera roll 0 in a hard turn); the FPV hard mount shows wind gusts the gimbal hides", () => {
  const st = circle("cinema", 1);
  for (const s of st) near(s.camera.r, 0, 1e-3, "gimbal horizon level");
  const gust = (preset) => {
    const d = FM.createDrone({ preset, wind: { gustMps: 8, seed: 3 } });
    d.reset({ pos: [0, 0, 10], h: 0, p: 0 }, { velocity: [0, 8, 0] });
    let maxDev = 0;
    for (let i = 1; i <= 300; i++) {
      const t = i / 30;
      const pose = d.step({ pos: [0, 8 * t, 10], h: 0, p: 0, vel: [0, 8, 0], acc: [0, 0, 0] }, 1 / 30);
      maxDev = Math.max(maxDev, Q.qAngle(pose.q, G.quatFromHPR(0, 0, 0)));
    }
    return maxDev;
  };
  const fpvDev = gust("fpv"), cinemaDev = gust("cinema");
  assert.ok(fpvDev > 1 * DEG, `fpv shows the gusts (${fpvDev / DEG}°)`);
  assert.ok(cinemaDev < 0.05 * DEG, `the gimbal hides them (${cinemaDev / DEG}°)`);
});

check("FPV hard mount in steady flight shows the nominal view (no constant uptilt offset)", () => {
  const d = FM.createDrone("fpv");
  d.reset({ pos: [0, 0, 10], h: 1, p: -0.1 }, { velocity: [12 * Math.sin(1), 12 * Math.cos(1), 0] });
  let pose;
  for (let i = 1; i <= 90; i++) {
    const t = i / 30;
    pose = d.step({ pos: [12 * Math.sin(1) * t, 12 * Math.cos(1) * t, 10], h: 1, p: -0.1, vel: [12 * Math.sin(1), 12 * Math.cos(1), 0], acc: [0, 0, 0] }, 1 / 30);
  }
  assert.ok(Q.qAngle(pose.q, G.quatFromHPR(1, -0.1, 0)) < 0.2 * DEG);
  assert.ok(d.state().body.p < -10 * DEG, "the body itself is nose-down against drag at 12 m/s");
});

// ---------------------------------------------------------------------------
console.log("F6 flyTrajectory");
// ---------------------------------------------------------------------------
const route = [[100, 200, 1.6], [120, 200, 1.6], [120, 215, 1.6], [135, 215, 1.6]];
const SHOTS = [
  ["drone.orbit-poi", base, undefined],
  ["drone.pass-over", base, undefined],
  ["drone.helix", base, undefined],
  ["drone.dronie", base, undefined],
  ["drone.fly-by", base, undefined],
  ["drone.top-down-rise", base, undefined],
  ["fpv.fpv-dive", base, undefined],
  ["fpv.fpv-flip", base, undefined],
  ["fpv.fpv-gap", base, undefined],
  ["fpv.fpv-corridor", { indoor: { route, floor: () => 0, ceiling: () => 3.4 } }, 8],
];
for (const [id, ctx, duration] of SHOTS) {
  check(`${id}: flown take lasts [D, 1.1·D], validates, tracks within 0.35 m, stays inside the preset limits`, () => {
    const tr = SH.buildShot(duration ? { technique: id, duration } : { technique: id }, ctx);
    const preset = FM.presetForTrajectory(tr);
    const fl = FM.flyTrajectory(tr, undefined, 30);
    const D = tr.duration;
    assert.ok(fl.duration >= D - 1e-9 && fl.duration <= 1.1 * D + 1e-9, `duration ${fl.duration} vs ${D}`);
    const v = TR.validateTrajectory(fl);
    assert.ok(v.ok, issuesText(v));
    const m = fl.meta.flight;
    assert.equal(m.preset, preset);
    assert.ok(m.meanTrackingErrorM < 0.15 && m.maxTrackingErrorM < 0.35, `tracking mean ${m.meanTrackingErrorM} max ${m.maxTrackingErrorM}`);
    assert.ok(m.maxSpeed <= FM.DRONE_PRESETS[preset].vmax * (1 + 1e-9) && m.maxAccel <= FM.DRONE_PRESETS[preset].amax * (1 + 1e-9));
    assert.equal(fl.technique, id);
    assert.equal(fl.family, tr.family);
    assert.equal(fl.id, `${tr.id}~${preset}`);
    assert.equal(fl.meta.flownFrom, tr.id);
    assert.deepEqual(fl.bounds, tr.bounds);
    if (tr.subject) assert.equal(fl.subject, tr.subject);
    // the flown pose stays close to the nominal one at the same time
    for (const t of [0, D / 3, D / 2, D]) assert.ok(vlen(sub(fl.sample(t).pos, tr.sample(t).pos)) < 0.35, `t=${t}`);
  });
}

check("a gimbal pass-over flown stays in [−90°, +30°] and its heading never flips", () => {
  const fl = FM.flyTrajectory(SH.buildShot({ technique: "drone.pass-over" }, base), "cinema", 30);
  const fr = TR.frameTimes(fl.duration, 30).map((t) => fl.sample(t));
  assert.ok(Math.min(...fr.map((p) => p.p)) <= -85 * DEG, "still looks (nearly) straight down");
  for (const p of fr) assert.ok(p.p >= -PI / 2 - 1e-12 && p.p <= 30 * DEG + 1e-9);
  assert.equal(TR.validateTrajectory(fl).counts["heading-flip"], 0);
});

for (const nadirMode of ["yaw-slew", "pitch-through", "hold"]) {
  check(`drone.pass-over '${nadirMode}' flown on the cinema gimbal (take_player's per-frame loop, 24/30/60 fps): every frame's rotation ≤ 1.5× the nominal's max, tracks the nominal, validates`, () => {
    const tr = SH.buildShot({ technique: "drone.pass-over", params: { nadirMode } }, base);
    const preset = FM.presetForTrajectory(tr);
    assert.equal(preset, "cinema", "drone family → the stabilised cinema gimbal");
    const tOver = tr.keyframes.find((k) => k.label === "overhead").t;
    for (const fps of [24, 30, 60]) {
      const d = FM.createDrone(preset);
      const ts = TR.frameTimes(tr.duration, fps);
      let prevN = tr.sample(0);
      let prev = d.reset({ ...prevN, t: 0 });
      let worst = 0, worstT = 0, maxN = 0, maxErr = 0, inverted = 0;
      for (let k = 1; k < ts.length; k++) {
        const nom = tr.sample(ts[k]);
        const pose = d.step({ ...nom, t: ts[k] }, ts[k] - ts[k - 1]);
        const dq = Q.qAngle(prev.q, pose.q);
        if (dq > worst) { worst = dq; worstT = ts[k]; }
        maxN = Math.max(maxN, Q.qAngle(prevN.q, nom.q));
        maxErr = Math.max(maxErr, Q.qAngle(pose.q, nom.q));
        if (nadirMode === "pitch-through" && ts[k] > tOver + 1) {
          // past vertical the intended image is upside down; the gimbal carries it, never rights it
          assert.ok(Q.qToBasis(nom.q).up[2] < 0, `${fps} fps t=${ts[k]}: nominal not inverted`);
          assert.ok(Q.qToBasis(pose.q).up[2] < 0, `${fps} fps t=${ts[k]}: flown image un-inverted`);
          inverted += 1;
        }
        prev = pose;
        prevN = nom;
      }
      assert.ok(worst <= 1.5 * maxN + 1e-9, `${fps} fps: flown frame rotated ${worst / DEG}° at t=${worstT} vs the nominal's max ${maxN / DEG}°`);
      assert.ok(maxErr < 5 * DEG, `${fps} fps: max orientation error vs the nominal ${maxErr / DEG}°`);
      if (nadirMode === "pitch-through") assert.ok(inverted > 3 * fps, `${fps} fps: inverted stretch checked (${inverted} frames)`);
      // flyTrajectory (exact vel/acc feed-forward, as take_player passes) bakes a table that validates
      const v = TR.validateTrajectory(FM.flyTrajectory(tr, undefined, fps));
      assert.ok(v.ok, `${fps} fps flown table: ${issuesText(v)}`);
    }
  });
}

check("a rest-ending shot too fast for the heavy lifter overruns by at most 10 % and reports it", () => {
  const tr = SH.buildShot({ technique: "drone.dronie" }, base);
  const fl = FM.flyTrajectory(tr, "heavy", 30);
  assert.ok(fl.duration > tr.duration, "overruns");
  assert.ok(fl.duration <= 1.1 * tr.duration + 1e-9, `≤ 10 %: ${fl.duration}`);
  near(fl.meta.flight.overrunSec, fl.duration - tr.duration, 1e-9);
  assert.equal(fl.meta.flight.preset, "heavy");
  assert.ok(fl.meta.flight.maxSpeed <= 7 + 1e-9);
  assert.ok(TR.validateTrajectory(fl).ok);
});

check("a concat with a cut is re-placed at the cut instead of flown across it", () => {
  const a = SH.buildShot({ technique: "drone.orbit-poi", duration: 4 }, base);
  const b = SH.buildShot({ technique: "drone.top-down", duration: 4 }, { subject: { ...SUBJECT, pos: [X0 + 300, Y0, ground(X0 + 300, Y0)] }, groundZ: ground });
  const cat = TR.concatTrajectories([a, b], { bridge: "cut" });
  const fl = FM.flyTrajectory(cat, "cinema", 30);
  assert.equal(fl.meta.flight.cutResets, 1);
  assert.ok(vlen(sub(fl.sample(4.05).pos, cat.sample(4.05).pos)) < 0.5, "already at the second setup right after the cut");
  const v = TR.validateTrajectory(fl);
  assert.ok(v.ok, issuesText(v));
});

check("an in-motion ending is never extended; a zero-duration trajectory flies to a single frame", () => {
  const tr = SH.buildShot({ technique: "drone.flyover", params: { speed: 11 } }, base);
  const fl = FM.flyTrajectory(tr, "cinema", 30);
  assert.equal(fl.duration, tr.duration);
  assert.equal(fl.meta.flight.overrunSec, 0);
  const still = TR.makeTrajectory({ duration: 0, positionAt: [1, 2, 3], orientAt: { h: 0, p: 0 } });
  const f0 = FM.flyTrajectory(still, "cinema", 30);
  assert.equal(f0.duration, 0);
  assert.deepEqual(f0.sample(0).pos, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
console.log("F7 determinism and robustness");
// ---------------------------------------------------------------------------
check("deterministic: identical runs bake identical tables; wind seeds are reproducible and distinct; gust 0 = calm", () => {
  const tr = SH.buildShot({ technique: "drone.orbit-poi" }, base);
  const bake = (preset) => TR.bakeTrajectory(FM.flyTrajectory(tr, preset, 30), 30).checksum;
  assert.equal(bake("cinema"), bake("cinema"));
  const w1 = bake({ preset: "fpv", wind: { gustMps: 5, seed: 1 } });
  assert.equal(w1, bake({ preset: "fpv", wind: { gustMps: 5, seed: 1 } }), "same seed, same take");
  assert.notEqual(w1, bake({ preset: "fpv", wind: { gustMps: 5, seed: 2 } }), "another seed, another take");
  assert.equal(bake({ preset: "fpv", wind: { gustMps: 0, seed: 9 } }), bake("fpv"), "no gust = no wind");
  const windy = FM.flyTrajectory(tr, { preset: "cinema", wind: { gustMps: 6, seed: 4 } }, 30);
  assert.ok(TR.validateTrajectory(windy).ok);
  assert.deepEqual(windy.meta.flight.wind, { gustMps: 6, seed: 4, frequencyHz: 0.3 });
});

check("robust: NaN targets hold the last one, dt ≤ 0 / NaN returns the current pose, first step snaps, bad resets throw", () => {
  const d = FM.createDrone("cinema");
  const p0 = d.step({ pos: [5, 5, 5], h: 0.5, p: 0 }, 1 / 30);
  assert.deepEqual(p0.pos, [5, 5, 5], "first step without reset snaps");
  d.step({ pos: [10, 5, 5], h: 0.5, p: 0 }, 1 / 30);
  const a = d.step({ pos: [NaN, 0, 0], h: NaN, p: NaN }, 1 / 30);
  assert.ok(a.pos.every(Number.isFinite) && a.q.every(Number.isFinite));
  for (let i = 0; i < 300; i++) d.step({ pos: [NaN, 1, 1] }, 1 / 30);
  assert.ok(vlen(sub(d.state().pos, [10, 5, 5])) < 0.01, "kept tracking the last valid target");
  const s1 = d.state();
  assert.deepEqual(d.step({ pos: [0, 0, 0], h: 0, p: 0 }, 0).pos, s1.pos);
  assert.deepEqual(d.step({ pos: [0, 0, 0], h: 0, p: 0 }, NaN).pos, s1.pos);
  assert.throws(() => FM.createDrone().step({ pos: [NaN, 0, 0] }, 0.1), filmErr(/first target/));
  assert.throws(() => d.reset({ pos: [0, 0] }), filmErr(/finite pos/));
  assert.throws(() => d.reset({ pos: [0, 0, 0] }), filmErr(/orientation|quaternion/));
  assert.throws(() => FM.flyTrajectory({}, "cinema", 30), filmErr(/Trajectory/));
  assert.throws(() => FM.flyTrajectory(SH.buildShot({ technique: "drone.pano-360" }, base), "cinema", 0), filmErr(/fps/));
});

check("state() is JSON-safe and reports preset, body, camera, target and tracking error", () => {
  const d = FM.createDrone({ preset: "indoor", wind: { gustMps: 1, seed: 2 } });
  assert.deepEqual(d.state(), { initialized: false, preset: "indoor", name: "indoor", mount: "gimbal" });
  d.reset({ pos: [0, 0, 1.5], h: 0, p: 0 });
  d.step({ pos: [1, 0, 1.5], h: 0.2, p: -0.1 }, 0.1);
  const s = d.state();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  for (const k of ["pos", "vel", "acc", "body", "camera", "target", "trackingError", "limits", "wind"]) assert.ok(k in s, k);
  assert.equal(s.camera.q.length, 4);
});

check("presetForTrajectory: fpv family → fpv, meta.flightPreset wins, indoor option, else cinema", () => {
  assert.equal(FM.presetForTrajectory({ family: "fpv" }), "fpv");
  assert.equal(FM.presetForTrajectory({ family: "drone", meta: { flightPreset: "heavy" } }), "heavy");
  assert.equal(FM.presetForTrajectory({ family: "drone" }, { indoor: true }), "indoor");
  assert.equal(FM.presetForTrajectory({ family: "classic" }), "cinema");
  assert.equal(FM.presetForTrajectory(SH.buildShot({ technique: "drone.orbit-poi" }, { subject: SUBJECT, indoor: { floor: () => 0 } })), "indoor");
});

console.log(`film_flight_model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
