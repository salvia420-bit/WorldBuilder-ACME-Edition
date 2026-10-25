// tests/drone_flight.test.mjs
//
// WHY: the Drone Deploy craft is what the pilot feels. Cine must fly exactly
// the stick speeds (12 / 20 / 4 m/s) at 60 AND 30 fps and brake into a hover
// — the phase-0 review measured an 18 m overshoot for a leashed setpoint and
// 16.3 m/s for a 0.5 s carrot on film's flight model (SPEC DV-6); the lift-off
// must be exact, or the goggle cut at the path midpoint pops (DV-31); the
// return-to-home must brake into its corners instead of overshooting the
// descent by 10 m; and contact must never let the craft wind up against a
// wall. This suite EXECUTES scene3d/drone/manual_flight.js on the REAL film
// flight model (scene3d/film/drone/flight_model.js — no fakes; two checks wrap
// it, through deps.createDrone, to record its poses or to hold a target up),
// flies the real scene3d/drone/tether.js planReturn paths, and pins SPEC §3.3
// / §8.2 drone_flight:
//   F1  CRAFT_MODES / CRAFT_TUNING (SPEC numbers, frozen), betaflightRateDeg;
//   F2  cine: hold ≤ 0.1 m at zero sticks; full stick 12 / boost 20 /
//       vertical 4 m/s within ±2 % at dt 1/60 AND 1/30; release travel ≤
//       v²/8 + v/4 + 1 m and |v| < 0.05 within 6 s; diagonal stick ≤ 12 m/s;
//   F3  yaw: cine command 90°/s with the camera ≤ 120°/s, angle 200°/s, acro
//       = betaflightRateDeg (666.67 ± 0.5); the gimbal pitch stops; at the
//       −90° stop (the gimbal follow overshoots the pole) W still flies the
//       heading, cam.h keeps it, a hold / contact there never spins the body;
//   F4  no wind-up: 3 s full stick into a wall (contact on the penetrating
//       frames AND on every frame), release → never penetrates, ends < 0.5 m
//       from the wall point;
//   F5  angle levels 35° → < 1° within 0.5 s, auto-throttle holds ± 0.2 m;
//       acro centred = 1 g ± 1e-6 and |vz| < 0.05 after 2 s; terminal
//       velocity at zero thrust = √(g/0.025) ± 2 %;
//   F6  contact: impactSpeed = max −(v·n̂), null normal counts |v|, tether
//       excluded, into-surface velocity removed, clamp move thresholds;
//   F7  lift-off exact at 2.2 s AND 2.2/1.5 s (pos ± 1e-6 every step, done and
//       |v| < 1e-6 at durationSec, tilt ≤ 25°, contact reports only), the
//       handover (autopilot(null)) moves ≤ |v|·dt + 0.01 m with |Δv| < 0.2;
//       angle / acro ease the camera onto the hard mount over 0.4 s (≤ 3° of
//       view turn per frame at the lift-off end and at 1.2 s — it snapped
//       28° / 33° before, R4-04), stick rotation passing straight through
//       (≤ 3° per frame over the mount's own); a plan / cine mid-blend is
//       continuous, reset ends it;
//   F8  rth lands on the path end, distTouchdownM non-increasing, ≤ 0.5 m off
//       the polyline (also from 12 m/s); land the same on its vertical line;
//       hold ± 0.1 m; crash lands; a floor contact lands the final descent; a
//       rth held off its end in mid-air lands where it is after a 3 s grace
//       (timed from an unobstructed twin's landing); distTouchdownM never
//       below the closest straight-line distance to home (a rth held back by
//       a wall never reads T17's 5 m while far, R3-3); a rth carrying the drop
//       `yaw` lands facing it, turning only on its final descent (R4-03);
//   F9  mode switches |Δpos| < 0.05 m per step; landed / take-off rules;
//   F10 determinism; NaN-free at dt 0, −1, NaN, 1e6 and NaN sticks; API shape.
//
// Flag: drone (DEFAULT ON since 2026-10-25, `?drone=off` disables it) — this is its pure craft module.
// Run from apps/holtburger-web/: node tests/drone_flight.test.mjs

import assert from "node:assert/strict";

const MF = await import("../scene3d/drone/manual_flight.js");
const FM = await import("../scene3d/film/drone/flight_model.js");
const { minJerk } = await import("../scene3d/film/core/easing.js");
const { quatFromHPR: quatHPR } = await import("../scene3d/film/core/gimbal.js");
const { createTether } = await import("../scene3d/drone/tether.js");
const { CRAFT_MODES, CRAFT_TUNING, betaflightRateDeg, createManualCraft } = MF;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err && err.message ? String(err.message).split("\n")[0] : String(err);
    console.log(`[FAIL] ${name}: ${msg}`);
  }
}

const DEG = Math.PI / 180;
const G = 9.80665;
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b} (±${eps})`);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const finite = (...xs) => xs.every((x) => Number.isFinite(x));

/** Fresh all-zero sticks (the controls.js poll shape, SPEC §3.3). */
const S = (over = {}) => ({ throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0, ...over });

/** A craft in `mode`, airborne at `pos` facing `h`. */
function mk(mode = "cine", pos = [0, 0, 100], h = 0) {
  const c = createManualCraft({ mode });
  c.reset({ pos, h, p: 0 });
  return c;
}

/** Step `sec` seconds at `dt` with fixed sticks; `each(frame, i, t)` sees every frame. */
function fly(craft, sticks, sec, dt, each, groundZ = null) {
  const n = Math.round(sec / dt);
  const input = { sticks, dt, groundZ, fovDeg: 75 };
  let f = null;
  for (let i = 0; i < n; i++) {
    f = craft.step(input);
    if (each) each(f, i, (i + 1) * dt);
  }
  return f;
}

/** Distance from p to a polyline. */
function polyDist(p, pts) {
  if (pts.length === 1) return dist3(p, pts[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let u = L2 > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L2 : 0;
    u = Math.max(0, Math.min(1, u));
    best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * u, p[1] - a[1] - ab[1] * u, p[2] - a[2] - ab[2] * u));
  }
  return best;
}

/** The return path index.js hands the rth plan (SPEC §7.4): the REAL tether.js planReturn (same lane, L1). */
const TETHER = createTether();
function returnPath(from, home, groundZ) {
  return TETHER.planReturn(from, home, { cruiseAglM: 15, groundZFrom: groundZ, groundZHome: groundZ });
}

/** Fly a plan until landed (or maxSec); collects the per-frame evidence. */
function flyPlan(craft, dt, maxSec, groundZ, onFrame) {
  const input = { sticks: S({ pitch: 1, yaw: 1, throttle: 1 }), dt, groundZ, fovDeg: 75 }; // plans ignore sticks
  const ev = { landedAt: null, mono: true, lastD: Infinity, maxSpeed: 0, frames: 0 };
  for (let i = 0; i < Math.ceil(maxSec / dt); i++) {
    const f = craft.step(input);
    ev.frames += 1;
    if (f.distTouchdownM !== null) {
      if (f.distTouchdownM > ev.lastD + 1e-9) ev.mono = false;
      ev.lastD = f.distTouchdownM;
    }
    if (f.speed > ev.maxSpeed) ev.maxSpeed = f.speed;
    if (onFrame) onFrame(f);
    if (f.landed) {
      ev.landedAt = (i + 1) * dt;
      break;
    }
  }
  return ev;
}

// ---------------------------------------------------------------------------
// F1 — constants and the rate curve
// ---------------------------------------------------------------------------

await check("F1 CRAFT_MODES and the SPEC §3.3 CRAFT_TUNING numbers (deep-frozen)", () => {
  assert.deepEqual([...CRAFT_MODES], ["cine", "angle", "acro"]);
  assert.ok(Object.isFrozen(CRAFT_MODES));
  const T = CRAFT_TUNING;
  assert.ok(Object.isFrozen(T));
  for (const k of Object.keys(T)) assert.ok(Object.isFrozen(T[k]), `${k} frozen`);
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  assert.deepEqual(pick(T.cine, ["vmaxH", "vmaxBoost", "vzMax", "yawRateDeg", "gimbalRateDeg", "pitchMinDeg", "pitchMaxDeg"]),
    { vmaxH: 12, vmaxBoost: 20, vzMax: 4, yawRateDeg: 90, gimbalRateDeg: 60, pitchMinDeg: -90, pitchMaxDeg: 30 });
  assert.deepEqual(pick(T.angle, ["maxTiltDeg", "yawRateDeg", "vzMax", "uptiltDeg", "levelOmega", "drag", "maxThrustG"]),
    { maxTiltDeg: 35, yawRateDeg: 200, vzMax: 4, uptiltDeg: 20, levelOmega: 12, drag: 0.025, maxThrustG: 2.5 });
  assert.deepEqual(pick(T.acro, ["rc", "super", "expo", "hoverG", "maxThrustG", "uptiltDeg", "drag"]),
    { rc: 1.0, super: 0.7, expo: 0, hoverG: 1, maxThrustG: 2.5, uptiltDeg: 25, drag: 0.025 });
  assert.deepEqual(pick(T.common, ["gravity", "subDt", "maxSubsteps", "restHeightM", "idleSpin"]),
    { gravity: 9.80665, subDt: 1 / 240, maxSubsteps: 4800, restHeightM: 0.06, idleSpin: 0.35 });
  assert.deepEqual(pick(T.rth, ["climbMps", "cruiseMps", "descendMps", "finalMps", "finalM"]),
    { climbMps: 3, cruiseMps: 8, descendMps: 2, finalMps: 0.6, finalM: 1.5 });
  // the tracked-plan profile limits stay inside the cinema craft (amax 4, jmax 8; DV-31)
  assert.ok(T.rth.amax < FM.DRONE_PRESETS.cinema.amax && T.rth.jmax < FM.DRONE_PRESETS.cinema.jmax);
});

await check("F1 betaflightRateDeg: defaults 666.67 °/s at full stick, the rc / super / expo formula, clamps", () => {
  const R = { rc: 1.0, super: 0.7, expo: 0 };
  near(betaflightRateDeg(1, R), 200 / 0.3, 1e-9, "full stick");
  near(betaflightRateDeg(-1, R), -200 / 0.3, 1e-9, "antisymmetric");
  assert.equal(betaflightRateDeg(0, R), 0);
  near(betaflightRateDeg(0.5, R), (200 * 0.5) / (1 - 0.5 * 0.7), 1e-9, "half stick");
  near(betaflightRateDeg(0.5, { rc: 1.5, super: 0, expo: 0.5 }), 200 * 1.5 * (0.5 * 0.125 * 0.5 + 0.5 * 0.5), 1e-9, "expo, no super");
  near(betaflightRateDeg(1, { rc: 1, super: 0.95, expo: 0 }), 200 / 0.05, 1e-6, "super 0.95");
  near(betaflightRateDeg(1, { rc: 1, super: 1, expo: 0 }), 200 / 0.01, 1e-6, "denominator clamped at 0.01");
  near(betaflightRateDeg(3, R), betaflightRateDeg(1, R), 1e-12, "x clamped to 1");
  assert.equal(betaflightRateDeg(NaN, R), 0);
  near(betaflightRateDeg(1), 200 / 0.3, 1e-9, "missing rates → the acro defaults");
  near(betaflightRateDeg(1, { rc: NaN, super: undefined }), 200 / 0.3, 1e-9, "non-finite fields → defaults");
});

// ---------------------------------------------------------------------------
// F2 — cine translation
// ---------------------------------------------------------------------------

await check("F2 cine holds within 0.1 m at zero sticks for 10 s (60 and 30 Hz)", () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const c = mk("cine", [120, -40, 30], 1.1);
    let maxDev = 0;
    fly(c, S(), 10, dt, (f) => { maxDev = Math.max(maxDev, dist3(f.pos, [120, -40, 30])); });
    assert.ok(maxDev <= 0.1, `dt ${dt}: drifted ${maxDev} m`);
  }
});

await check("F2 full stick settles at [0.98, 1.02]·12 m/s, boost ·20, vertical |vz| ·4 — at dt 1/60 AND 1/30", () => {
  const cases = [
    ["pitch", S({ pitch: 1 }), 12, (f) => f.speed],
    ["back", S({ pitch: -1 }), 12, (f) => f.speed],
    ["roll", S({ roll: 1 }), 12, (f) => f.speed],
    ["boost", S({ pitch: 1, boost: 1 }), 20, (f) => f.speed],
    ["up", S({ throttle: 1 }), 4, (f) => Math.abs(f.vel[2])],
    ["down", S({ throttle: -1 }), 4, (f) => Math.abs(f.vel[2])],
  ];
  for (const dt of [1 / 60, 1 / 30]) {
    for (const [name, sticks, v, read] of cases) {
      const c = mk("cine", [0, 0, 500], 0.4);
      const seen = [];
      fly(c, sticks, 12, dt, (f, i, t) => { if (t > 9) seen.push(read(f)); });
      const lo = Math.min(...seen), hi = Math.max(...seen);
      assert.ok(lo >= 0.98 * v && hi <= 1.02 * v, `${name} @${Math.round(1 / dt)} Hz: ${lo.toFixed(3)}..${hi.toFixed(3)} vs ${v}`);
    }
  }
});

await check("F2 cine flies in the camera's yaw frame: W = forward, D = right (compass heading 0.4 rad)", () => {
  const h = 0.4;
  const w = fly(mk("cine", [0, 0, 300], h), S({ pitch: 1 }), 6, 1 / 60);
  near(Math.atan2(w.vel[0], w.vel[1]), h, 1e-3, "W heading");
  const dd = fly(mk("cine", [0, 0, 300], h), S({ roll: 1 }), 6, 1 / 60);
  near(Math.atan2(dd.vel[0], dd.vel[1]), h + Math.PI / 2, 1e-3, "D = heading + 90°");
});

await check("F2 a diagonal stick (W + D) never exceeds the axis speed (12 m/s, not 17)", () => {
  const seen = [];
  fly(mk("cine", [0, 0, 300], 0), S({ pitch: 1, roll: 1 }), 12, 1 / 60, (f, i, t) => { if (t > 9) seen.push(f.speed); });
  assert.ok(Math.max(...seen) <= 12 * 1.02 && Math.min(...seen) >= 12 * 0.98, `${Math.min(...seen)}..${Math.max(...seen)}`);
});

await check("F2 release from 12 m/s: travel ≤ v²/(2·4) + v·4/(2·8) + 1 m and |v| < 0.05 within 6 s (60 and 30 Hz)", () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const c = mk("cine", [0, 0, 300], 0);
    const f0 = fly(c, S({ pitch: 1 }), 10, dt);
    const p0 = f0.pos.slice();
    const v = f0.speed;
    const bound = (v * v) / 8 + (v * 4) / 16 + 1;
    let maxTravel = 0, stillFrom = null;
    fly(c, S(), 9, dt, (f, i, t) => {
      maxTravel = Math.max(maxTravel, dist3(f.pos, p0));
      if (f.speed < 0.05) { if (stillFrom === null) stillFrom = t; } else stillFrom = null;
    });
    assert.ok(maxTravel <= bound, `@${Math.round(1 / dt)} Hz travel ${maxTravel.toFixed(3)} > ${bound.toFixed(3)}`);
    assert.ok(stillFrom !== null && stillFrom <= 6, `@${Math.round(1 / dt)} Hz |v| < 0.05 only from ${stillFrom} s`);
  }
});

// ---------------------------------------------------------------------------
// F3 — yaw and gimbal
// ---------------------------------------------------------------------------

/** Per-frame camera heading rates (°/s) over `sec`. */
function camRates(craft, sticks, sec, dt) {
  let prev = craft.state().cam.h;
  const out = [];
  fly(craft, sticks, sec, dt, (f, i, t) => { out.push({ t, r: (f.cam.h - prev) / dt / DEG }); prev = f.cam.h; });
  return out;
}

await check("F3 cine yaw: heading command 90 °/s (steady camera rate), camera never above the 120 °/s preset cap", () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const rates = camRates(mk("cine"), S({ yaw: 1 }), 5, dt);
    const steady = rates.filter((x) => x.t > 3).map((x) => x.r);
    near(Math.min(...steady), 90, 0.5, "steady min");
    near(Math.max(...steady), 90, 0.5, "steady max");
    assert.ok(Math.max(...rates.map((x) => Math.abs(x.r))) <= 120 + 0.5, "camera ≤ 120 °/s");
  }
  // a 57° mouse flick in one frame still turns the camera at ≤ 120 °/s and lands on the command
  const c = mk("cine");
  const dt = 1 / 60;
  const st = S({ lookX: 1 });
  const input = { sticks: st, dt, groundZ: null, fovDeg: 75 };
  let prev = 0, maxR = 0, f = c.step(input);
  maxR = Math.abs(f.cam.h - prev) / dt / DEG;
  prev = f.cam.h;
  st.lookX = 0;
  for (let i = 0; i < 150; i++) { f = c.step(input); maxR = Math.max(maxR, Math.abs(f.cam.h - prev) / dt / DEG); prev = f.cam.h; }
  assert.ok(maxR <= 120 + 0.5, `flick ${maxR} °/s`);
  near(f.cam.h, 1, 1e-3, "settles on the mouse heading");
});

await check("F3 angle yaw 200 °/s; acro full yaw stick = betaflightRateDeg(1) (666.67 ± 0.5 °/s)", () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const a = camRates(mk("angle"), S({ yaw: 1 }), 1, dt).map((x) => x.r);
    near(Math.min(...a), 200, 0.5, "angle min");
    near(Math.max(...a), 200, 0.5, "angle max");
    const r = camRates(mk("acro"), S({ yaw: 1 }), 0.5, dt).map((x) => x.r);
    const want = betaflightRateDeg(1, CRAFT_TUNING.acro);
    near(want, 666.67, 0.01, "rate curve");
    near(Math.min(...r), want, 0.5, "acro min");
    near(Math.max(...r), want, 0.5, "acro max");
  }
  // the right stick direction: +yaw = compass + in every mode
  for (const m of CRAFT_MODES) {
    const f = fly(mk(m), S({ yaw: 0.5 }), 0.5, 1 / 60);
    assert.ok(f.cam.h > 0.05, `${m}: heading ${f.cam.h}`);
  }
});

await check("F3 cine gimbal: stick 60 °/s + mouse Y, stops at +30° and −90°; angle ignores mouse Y, acro the mouse", () => {
  const c = mk("cine");
  fly(c, S({ gimbal: 1 }), 2, 1 / 60);
  const up = fly(c, S(), 2, 1 / 60);
  near(up.cam.p, 30 * DEG, 0.01, "+30° stop");
  fly(c, S({ gimbal: -1 }), 3, 1 / 60);
  const down = fly(c, S(), 3, 1 / 60);
  near(down.cam.p, -90 * DEG, 0.01, "−90° stop");
  const m = mk("cine");
  fly(m, S({ lookY: -0.3 }), 1 / 60, 1 / 60);
  near(fly(m, S(), 2, 1 / 60).cam.p, -0.3, 0.01, "mouse Y tilts");
  const a = mk("angle");
  const a0 = a.state().cam.p;
  near(fly(a, S({ lookY: 0.5 }), 0.5, 1 / 60).cam.p, a0, 1e-9, "angle: mouse Y ignored");
  const k = mk("acro");
  const k0 = k.state().cam;
  const kf = fly(k, S({ lookX: 0.5, lookY: 0.5 }), 0.5, 1 / 60);
  near(kf.cam.h, k0.h, 1e-9, "acro: mouse X ignored");
  near(kf.cam.p, k0.p, 1e-9, "acro: mouse Y ignored");
  near(k0.p, 25 * DEG, 1e-9, "acro 25° uptilt");
  near(a0, 20 * DEG, 1e-9, "angle 20° uptilt");
});

/** Rotation angle (rad) between two unit quaternions [w,x,y,z]. */
const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** a ⊗ b for [w,x,y,z] quaternions. */
const qMul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
/** The angle / acro hard mount of a frame: body ⊗ Rx(uptilt). */
const mountOf = (f, mode) => {
  const a = (CRAFT_TUNING[mode].uptiltDeg * DEG) / 2;
  return qMul(f.body.q, [Math.cos(a), Math.sin(a), 0, 0]);
};

await check("F3 cine at the gimbal's −90° stop: W flies forward, cam.h keeps the heading, hold / contact never spin the body", () => {
  // The gimbal follow overshoots the pole by up to ≈ 3° after the stick drives it into the
  // stop (createDrone's pitch limit is asin(forward.z), blind past the pole); while past it,
  // film's hprFromQuat heading reads off by π. Measured before the fix: W flew BACKWARDS for
  // ≈ 3.7 s, and a pilot-view hold there spun the body 180° and rotated the view for good.
  const H0 = 0.3, dt = 1 / 60;
  /** A craft whose gimbal stick was held down for `sec` (inside the overshoot window). */
  const atStop = (sec) => {
    const poses = [];
    const c = createManualCraft({ createDrone: (cfg) => {
      const d = FM.createDrone(cfg);
      return { ...d, step: (t, h) => { const p = d.step(t, h); poses.push(p); return p; } };
    } });
    c.reset({ pos: [0, 0, 100], h: H0, p: 0 });
    fly(c, S({ gimbal: -1 }), sec, dt);
    return { c, poses };
  };
  for (const sec of [1.6, 2.0, 2.5]) {
    const { c, poses } = atStop(sec);
    let maxVel = 0, maxCam = 0, maxRep = 0, n = 0;
    fly(c, S({ pitch: 1, gimbal: -1 }), 4, dt, (f) => {
      if (f.speed > 0.3) { maxVel = Math.max(maxVel, Math.abs(wrapA(Math.atan2(f.vel[0], f.vel[1]) - H0))); n += 1; }
      maxCam = Math.max(maxCam, Math.abs(wrapA(f.cam.h - H0)));
      assert.deepEqual(f.cam.q, poses[poses.length - 1].q, "cam.q is createDrone's, untouched");
      assert.ok(f.cam.p >= -Math.PI / 2 && f.cam.p <= 30 * DEG + 1e-9, `cam.p ${f.cam.p}`);
      // h / p / r describe q (within the overshoot past the pole)
      maxRep = Math.max(maxRep, qAngle(f.cam.q, quatHPR(f.cam.h, f.cam.p, f.cam.r)));
    });
    assert.ok(n > 100, "moving");
    assert.ok(maxVel < 0.5 * DEG, `${sec}s: W flew ${(maxVel / DEG).toFixed(2)}° off the heading`);
    assert.ok(maxCam < 0.5 * DEG, `${sec}s: cam.h ${(maxCam / DEG).toFixed(2)}° off`);
    assert.ok(maxRep < 3.5 * DEG, `${sec}s: h/p/r ${(maxRep / DEG).toFixed(2)}° from q`);
    near(c.state().speed, 12, 0.3, "full forward speed");
  }
  // a pilot-view hold installed inside the window, then back to flying + W
  const { c: h } = atStop(2.0);
  assert.deepEqual(h.autopilot({ kind: "hold" }), { ok: true, kind: "hold" });
  let maxBody = 0;
  fly(h, S(), 4, dt, (f) => { maxBody = Math.max(maxBody, Math.abs(wrapA(f.body.h - H0)), Math.abs(wrapA(f.cam.h - H0))); });
  assert.ok(maxBody < 1 * DEG, `hold: body / view turned ${(maxBody / DEG).toFixed(2)}°`);
  h.autopilot(null);
  const g = fly(h, S({ pitch: 1 }), 4, dt);
  near(wrapA(Math.atan2(g.vel[0], g.vel[1]) - H0), 0, 0.5 * DEG, "W after the hold flies the pilot's heading");
  // a contact re-seed inside the window keeps the body heading
  const { c: k } = atStop(2.0);
  const s = k.state();
  const cp = [s.pos[0], s.pos[1], s.pos[2] + 0.05];
  k.contact([{ layer: "terrain-floor", kind: "terrain", t: 1, point: cp, normal: [0, 0, 1] }], cp);
  let maxK = 0;
  fly(k, S(), 3, dt, (f) => { maxK = Math.max(maxK, Math.abs(wrapA(f.body.h - H0))); });
  assert.ok(maxK < 1 * DEG, `contact: body turned ${(maxK / DEG).toFixed(2)}°`);
  // away from the pole h / p / r reproduce q exactly
  const lv = mk("cine", [0, 0, 100], H0);
  fly(lv, S({ gimbal: -0.5, yaw: 0.4 }), 1.5, dt, (f) => assert.ok(qAngle(f.cam.q, quatHPR(f.cam.h, f.cam.p, f.cam.r)) < 1e-6, "exact"));
});

// ---------------------------------------------------------------------------
// F4 — no wind-up against a wall
// ---------------------------------------------------------------------------

await check("F4 3 s full stick into a contact wall, then release: never penetrates, ends < 0.5 m from the wall point", () => {
  // every = the hit is reported on EVERY frame (SPEC §8.2 "contact every frame"), clamped to the
  // wall plane; otherwise only on the frames the craft is past it (the reflex's own behaviour)
  for (const [mode, dt, every] of [["cine", 1 / 60, false], ["cine", 1 / 30, false], ["angle", 1 / 60, false],
    ["cine", 1 / 60, true], ["cine", 1 / 30, true], ["angle", 1 / 30, true]]) {
    const WALL = 10;
    const c = createManualCraft({ mode });
    c.reset({ pos: [3, WALL - 0.01, 40], h: 0, p: 0 }); // pressed against the wall, facing it
    const hit = { layer: "buildingMesh", kind: "wall", t: 0.5, point: [3, WALL, 40], normal: [0, -1, 0] };
    const hits = [hit];
    const cp = [0, 0, 0];
    let maxAfter = -Infinity, maxStep = 0, contacts = 0;
    const input = { sticks: S({ pitch: 1 }), dt, groundZ: null, fovDeg: 75 };
    const run = (n) => {
      for (let i = 0; i < n; i++) {
        const f = c.step(input);
        const pen = f.pos[1] - WALL;
        maxStep = Math.max(maxStep, pen);
        if (pen > 0 || every) { // the safety reflex: clamp back onto the wall, report the hit
          cp[0] = f.pos[0]; cp[1] = Math.min(WALL, f.pos[1]); cp[2] = f.pos[2];
          hit.point[0] = f.pos[0]; hit.point[2] = f.pos[2];
          c.contact(hits, cp);
          contacts += 1;
        }
        maxAfter = Math.max(maxAfter, c.state().pos[1] - WALL);
      }
    };
    run(Math.round(3 / dt));
    assert.ok(contacts >= Math.round(2 / dt), `${mode}: pressed into the wall (${contacts} contacts)`);
    input.sticks = S();
    run(Math.round(6 / dt));
    const end = c.state();
    // the craft's own position never goes past the wall by more than the cine re-seed threshold (0.02 m)
    const tag = `${mode} @${Math.round(1 / dt)} Hz${every ? " (every frame)" : ""}`;
    assert.ok(maxAfter <= 0.02, `${tag}: ${maxAfter.toFixed(4)} m past the wall`);
    assert.ok(maxStep <= 0.05, `${tag}: no wind-up, a step overshoots ≤ ${maxStep.toFixed(4)} m`);
    assert.ok(WALL - end.pos[1] < 0.5 && end.pos[1] <= WALL + 0.02, `${tag}: ends ${(WALL - end.pos[1]).toFixed(3)} m from the wall`);
    assert.ok(end.speed < 0.05, `${tag}: at rest (${end.speed})`);
  }
});

// ---------------------------------------------------------------------------
// F5 — angle and acro physics
// ---------------------------------------------------------------------------

await check("F5 angle: 35° tilt levels to < 1° within 0.5 s, auto-throttle holds altitude ± 0.2 m (60 and 30 Hz)", () => {
  for (const dt of [1 / 60, 1 / 30]) {
    for (const sticks of [S({ roll: 1 }), S({ pitch: 1 }), S({ roll: -1 })]) {
      const c = mk("angle", [0, 0, 80], 0.7);
      let zMin = 80, zMax = 80;
      const track = (f) => { zMin = Math.min(zMin, f.pos[2]); zMax = Math.max(zMax, f.pos[2]); };
      const f0 = fly(c, sticks, 2, dt, track);
      near(Math.hypot(f0.body.p, f0.body.r) / DEG, 35, 0.05, "tilted 35°");
      let levelAt = null;
      fly(c, S(), 2, dt, (f, i, t) => { track(f); if (levelAt === null && Math.hypot(f.body.p, f.body.r) < 1 * DEG) levelAt = t; });
      assert.ok(levelAt !== null && levelAt <= 0.5 + 1e-9, `levelled at ${levelAt} s`);
      assert.ok(zMax - 80 <= 0.2 && 80 - zMin <= 0.2, `altitude ${zMin.toFixed(4)}..${zMax.toFixed(4)}`);
    }
  }
  // signs: forward stick = nose down (p < 0) and accelerates forward; right stick = bank right (r > 0)
  const fw = fly(mk("angle"), S({ pitch: 1 }), 1, 1 / 60);
  assert.ok(fw.body.p < 0 && fw.vel[1] > 1, `nose ${fw.body.p}, vy ${fw.vel[1]}`);
  const rt = fly(mk("angle"), S({ roll: 1 }), 1, 1 / 60);
  assert.ok(rt.body.r > 0 && rt.vel[0] > 1, `bank ${rt.body.r}, vx ${rt.vel[0]}`);
  // a diagonal keeps the total tilt at 35°
  const dg = fly(mk("angle"), S({ pitch: 1, roll: 1 }), 2, 1 / 60);
  near(Math.hypot(dg.body.p, dg.body.r) / DEG, 35, 0.05, "diagonal tilt");
});

await check("F5 angle vertical: throttle·4 m/s climbs / sinks, then the hold re-latches without drifting", () => {
  const c = mk("angle", [0, 0, 50], 0);
  const up = fly(c, S({ throttle: 1 }), 4, 1 / 60);
  near(up.vel[2], 4, 0.05, "climb rate");
  fly(c, S(), 3, 1 / 60);
  const z0 = c.state().pos[2];
  let dz = 0;
  fly(c, S(), 5, 1 / 60, (f) => { dz = Math.max(dz, Math.abs(f.pos[2] - z0)); });
  assert.ok(dz < 0.05, `hold drift ${dz}`);
  const dn = fly(c, S({ throttle: -0.5 }), 3, 1 / 60);
  near(dn.vel[2], -2, 0.05, "sink rate");
});

await check("F5 acro centred sticks: thrust = 1 g ± 1e-6 every frame and |vz| < 0.05 after 2 s", () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const c = mk("acro", [0, 0, 60], 2.2);
    const f = fly(c, S(), 2, dt, (g) => near(g.throttle, 1, 1e-6, "throttle"));
    assert.ok(Math.abs(f.vel[2]) < 0.05, `vz ${f.vel[2]}`);
    near(f.pos[2], 60, 0.05, "altitude");
  }
  // collective: full up 2.5 g, full down 0
  near(fly(mk("acro"), S({ throttle: 1 }), 0.1, 1 / 60).throttle, 2.5, 1e-9, "full up");
  near(fly(mk("acro"), S({ throttle: -1 }), 0.1, 1 / 60).throttle, 0, 1e-9, "full down");
  near(fly(mk("acro"), S({ throttle: 0.5 }), 0.1, 1 / 60).throttle, 1.75, 1e-9, "half up");
});

await check("F5 acro body rates: pitch stick noses down, roll banks right (Betaflight rate, attitude kept at centre)", () => {
  const dt = 1 / 240;
  const p = mk("acro");
  fly(p, S({ pitch: 0.2 }), 0.1, dt);
  const fp = fly(p, S(), 0.2, dt);
  const rate = betaflightRateDeg(0.2, CRAFT_TUNING.acro);
  near(fp.body.p, -rate * 0.1 * DEG, 1e-6, "nose-down angle = rate·t");
  const r = mk("acro");
  fly(r, S({ roll: 0.2 }), 0.1, dt);
  const fr = fly(r, S(), 0.2, dt);
  near(fr.body.r, rate * 0.1 * DEG, 1e-6, "bank right = rate·t");
});

await check("F5 terminal velocity at zero thrust = √(g / 0.025) ± 2 % (quadratic drag)", () => {
  const vt = Math.sqrt(G / 0.025);
  for (const dt of [1 / 60, 1 / 30]) {
    const f = fly(mk("acro", [0, 0, 9000], 0), S({ throttle: -1 }), 25, dt);
    near(-f.vel[2], vt, 0.02 * vt, `@${Math.round(1 / dt)} Hz`);
  }
});

// ---------------------------------------------------------------------------
// F6 — contact
// ---------------------------------------------------------------------------

/** A cine craft cruising north-down: v ≈ (0, 12, −2). */
function cruising(mode = "cine") {
  const c = mk(mode, [0, 0, 300], 0);
  fly(c, S({ pitch: 1, throttle: -0.5 }), 6, 1 / 60);
  return c;
}

await check("F6 impactSpeed = max over hits of −(v·n̂) (normals normalised), 0 when moving away; reused result", () => {
  const c = cruising();
  const s = c.state();
  const v = s.vel;
  const floor = { layer: "terrain", kind: "terrain", t: 1, point: s.pos, normal: [0, 0, 5] };
  const wall = { layer: "statics", kind: "rock", t: 0.5, point: s.pos, normal: [0, -3, 0] };
  const r = c.contact([floor, wall], s.pos);
  near(r.impactSpeed, Math.max(-v[2], v[1]), 1e-9, "max of the two");
  const c2 = cruising();
  const s2 = c2.state();
  const away = c2.contact([{ layer: "statics", kind: "rock", t: 0.5, point: s2.pos, normal: [0, 1, 0] }], s2.pos);
  assert.equal(away.impactSpeed, 0, "moving away from the surface");
  assert.deepEqual(c2.state().vel, s2.vel, "and nothing removed");
  assert.equal(c2.contact([], s2.pos), away, "the same reused object");
  assert.equal(c2.contact([], s2.pos).impactSpeed, 0);
  assert.equal(c2.contact(null, s2.pos).impactSpeed, 0);
  assert.equal(c2.contact({ length: 2 }, s2.pos).impactSpeed, 0, "holes in an array-like are skipped");
});

await check("F6 a null normal counts |v|; a 'tether' hit never counts but its into-surface velocity is removed", () => {
  const c = cruising();
  const s = c.state();
  const r = c.contact([{ layer: "cell-space", kind: "wall", t: 0.4, point: s.pos.slice(), normal: null }], s.pos);
  near(r.impactSpeed, s.speed, 1e-9, "null normal = |v|");
  const t = cruising();
  const st = t.state();
  const r2 = t.contact([{ layer: "tether", kind: "range", t: 1, point: st.pos, normal: [0, -1, 0] }], st.pos);
  assert.equal(r2.impactSpeed, 0, "tether never counts");
  const after = t.state().vel;
  near(after[1], 0, 1e-9, "outward (north) velocity removed");
  near(after[2], st.vel[2], 1e-9, "the rest kept");
});

await check("F6 into-surface velocity removed, the craft moves to clampedPos (and keeps flying from it)", () => {
  const c = cruising();
  const s = c.state();
  const clamped = [s.pos[0], s.pos[1] - 0.3, s.pos[2] + 0.2];
  c.contact([{ layer: "terrain", kind: "terrain", t: 1, point: clamped, normal: [0, 0, 1] }], clamped);
  const a = c.state();
  assert.deepEqual(a.pos, clamped);
  assert.deepEqual(a.cam.pos, clamped, "cam.pos equals pos");
  near(a.vel[2], 0, 1e-9, "downward velocity removed");
  near(a.vel[1], s.vel[1], 1e-9, "tangential velocity kept");
  const f = c.step({ sticks: S({ pitch: 1, throttle: -0.5 }), dt: 1 / 60, groundZ: null, fovDeg: 75 });
  assert.ok(dist3(f.pos, clamped) < 0.3, "continues from the clamped position");
  // a null normal with no correction stops the craft (the surface direction is unknown)
  const k = cruising();
  const ks = k.state();
  k.contact([{ layer: "cell-space", kind: "wall", t: 0.4, point: null, normal: null }], ks.pos);
  near(k.state().speed, 0, 1e-12, "stopped");
});

await check("F6 cine re-seeds only past 0.02 m / 0.05 m/s (no gimbal hitch); angle / acro always take the clamp", () => {
  const c = mk("cine", [0, 0, 50], 0);
  fly(c, S(), 1, 1 / 60);
  const s = c.state();
  const tiny = [s.pos[0], s.pos[1], s.pos[2] + 0.01];
  c.contact([{ layer: "terrain", kind: "terrain", t: 1, point: tiny, normal: [0, 0, 1] }], tiny);
  assert.deepEqual(c.state().pos, s.pos, "a 1 cm clamp at rest is ignored");
  const big = [s.pos[0], s.pos[1], s.pos[2] + 0.05];
  c.contact([{ layer: "terrain", kind: "terrain", t: 1, point: big, normal: [0, 0, 1] }], big);
  assert.deepEqual(c.state().pos, big, "a 5 cm clamp moves the craft");
  const a = mk("angle", [0, 0, 50], 0);
  fly(a, S(), 1, 1 / 60);
  const as = a.state();
  const at = [as.pos[0], as.pos[1], as.pos[2] + 0.01];
  a.contact([{ layer: "terrain", kind: "terrain", t: 1, point: at, normal: [0, 0, 1] }], at);
  assert.deepEqual(a.state().pos, at);
});

// ---------------------------------------------------------------------------
// F7 — the kinematic lift-off and its handover
// ---------------------------------------------------------------------------

const PILOT = [1000, 2000, 50];
const C0 = 0.6; // pilot compass heading
const AWAY = [Math.sin(C0), Math.cos(C0)];
const HOME = [PILOT[0] + 0.72 * AWAY[0], PILOT[1] + 0.72 * AWAY[1], PILOT[2] + 0.06];
const LIFT_TO = [HOME[0] + 3.4 * AWAY[0], HOME[1] + 3.4 * AWAY[1], HOME[2] + 1.7];
const liftPlan = (D, lookAt = [PILOT[0], PILOT[1], PILOT[2] + 1.2]) => ({ kind: "liftoff", from: HOME, to: LIFT_TO, durationSec: D, heading: C0 + Math.PI, lookAt });

/** A craft landed on the drop spot facing the pilot, the lift-off installed. */
function lifting(mode, D, lookAt) {
  const c = createManualCraft({ mode });
  c.reset({ pos: HOME, h: C0 + Math.PI, p: 0 }, { landed: true });
  const r = c.autopilot(liftPlan(D, lookAt));
  assert.deepEqual(r, { ok: true, kind: "liftoff" });
  return c;
}

await check("F7 lift-off is exact at 2.2 s AND 2.2/1.5 s: pos ± 1e-6 every step, done and |v| < 1e-6 at durationSec, tilt ≤ 25°", () => {
  for (const D of [2.2, 2.2 / 1.5]) {
    const dt = 1 / 60;
    const c = lifting("cine", D);
    const input = { sticks: S({ pitch: 1 }), dt, groundZ: PILOT[2], fovDeg: 80 }; // sticks ignored by the plan
    const nEnd = Math.round(D / dt);
    let maxTilt = 0;
    for (let i = 1; i <= nEnd + 30; i++) {
      const f = c.step(input);
      const s = minJerk(Math.min(1, (i * dt) / D));
      for (let k = 0; k < 3; k++) near(f.pos[k], HOME[k] + (LIFT_TO[k] - HOME[k]) * s, 1e-6, `D ${D.toFixed(3)} step ${i} pos[${k}]`);
      maxTilt = Math.max(maxTilt, Math.hypot(f.body.p, f.body.r) / DEG);
      assert.equal(f.autopilot, "liftoff");
      assert.equal(f.landed, false);
      if (i < nEnd) assert.equal(f.autopilotDone, false, `not done at step ${i}`);
      if (i === nEnd) {
        assert.equal(f.autopilotDone, true, `done at durationSec (step ${i})`);
        assert.ok(len3(f.vel) < 1e-6, `|v| ${len3(f.vel)} at durationSec`);
      }
      assert.ok(f.throttle > 0.5 && f.throttle < 2.5, `throttle ${f.throttle}`);
    }
    assert.ok(maxTilt <= 25 + 1e-9, `tilt ${maxTilt}°`);
    assert.ok(maxTilt > 5, "the craft leans into the move");
  }
});

await check("F7 lift-off camera looks at lookAt (the pilot's chest); lookAt null = level at the plan heading", () => {
  const dt = 1 / 60;
  const c = lifting("cine", 2.2);
  const f = fly(c, S(), 2.2, dt);
  const d = [PILOT[0] - f.pos[0], PILOT[1] - f.pos[1], PILOT[2] + 1.2 - f.pos[2]];
  near(Math.cos(f.cam.h - Math.atan2(d[0], d[1])), 1, 1e-9, "heading toward the pilot");
  near(f.cam.p, Math.atan2(d[2], Math.hypot(d[0], d[1])), 1e-9, "pitch toward the chest");
  near(Math.cos(f.body.h - f.cam.h), 1, 1e-9, "the body heading follows the camera");
  const n = lifting("cine", 2.2, null);
  const g = fly(n, S(), 1.1, dt);
  near(Math.cos(g.cam.h - (C0 + Math.PI)), 1, 1e-9, "level at heading");
  near(g.cam.p, 0, 1e-9, "level");
});

await check("F7 contact during the lift-off only reports impactSpeed (the kinematic plan owns the position)", () => {
  const dt = 1 / 60;
  const c = lifting("cine", 2.2);
  const f = fly(c, S(), 1.1, dt);
  const pos = f.pos.slice(), vel = f.vel.slice();
  const r = c.contact([{ layer: "scenery", kind: "tree", t: 0.5, point: pos, normal: [-AWAY[0], -AWAY[1], 0] }], [pos[0], pos[1], pos[2] + 1]);
  near(r.impactSpeed, vel[0] * AWAY[0] + vel[1] * AWAY[1], 1e-9, "reported");
  assert.deepEqual(c.state().pos, pos, "position untouched");
  assert.deepEqual(c.state().vel, vel, "velocity untouched");
  const s = minJerk(Math.min(1, (67 * dt) / 2.2));
  const g = c.step({ sticks: S(), dt, groundZ: null, fovDeg: 75 });
  for (let k = 0; k < 3; k++) near(g.pos[k], HOME[k] + (LIFT_TO[k] - HOME[k]) * s, 1e-6, "still on the path");
});

await check("F7 handover autopilot(null) mid-move and at the end: ≤ |v|·dt + 0.01 m and |Δv| < 0.2 m/s on the next step", () => {
  const dt = 1 / 60;
  for (const D of [2.2, 2.2 / 1.5]) {
    for (const mode of CRAFT_MODES) {
      for (const frac of [0.5, 1]) {
        const c = lifting(mode, D);
        const f = fly(c, S(), Math.round((frac * D) / dt) * dt, dt);
        const p0 = f.pos.slice(), v0 = f.vel.slice();
        assert.deepEqual(c.autopilot(null), { ok: true, kind: null });
        const sticks = mode === "cine" ? S({ pitch: 1 }) : S();
        const g = c.step({ sticks, dt, groundZ: PILOT[2], fovDeg: 75 });
        const moved = dist3(g.pos, p0);
        const dv = dist3(g.vel, v0);
        const tag = `${mode} D ${D.toFixed(2)} at ${frac}`;
        assert.ok(moved <= len3(v0) * dt + 0.01, `${tag}: moved ${moved.toFixed(5)} > ${(len3(v0) * dt + 0.01).toFixed(5)}`);
        assert.ok(dv < 0.2, `${tag}: |Δv| ${dv.toFixed(4)}`);
        assert.equal(g.autopilot, null);
        near(Math.cos(g.cam.h - f.cam.h), 1, 1e-3, `${tag}: heading continuous`);
      }
    }
  }
});

await check("F7 angle / acro handover eases the camera onto the hard mount: ≤ 3° of view turn per frame at the lift-off end AND at 1.2 s, the mount from 0.4 s", () => {
  // The lift-off camera looks at the pilot's chest (≈ −8° pitch at the end); the angle / acro
  // camera is the hard mount body ⊗ Rx(20° / 25°). autopilot(null) used to snap between them:
  // 27.7° / 32.7° in ONE frame at the end of the lift-off, 12.9° / 17.8° at an early T8 (the
  // first input at 1.2 s) — E3's camera pop. It now eases from the plan's last view onto the
  // live mount (a min-jerk slerp of that offset, in the mount's frame, over 0.4 s); cine never
  // jumped and stays exact.
  const dt = 1 / 60;
  for (const mode of CRAFT_MODES) {
    for (const at of [2.2, 1.2]) {
      const tag = `${mode} at ${at} s`;
      const c = lifting(mode, 2.2);
      const f0 = fly(c, S(), at, dt);
      const before = f0.cam.q.slice();
      if (mode !== "cine") assert.ok(qAngle(before, mountOf(f0, mode)) > 10 * DEG, `${tag}: the mount is far from the plan's view`);
      assert.deepEqual(c.autopilot(null), { ok: true, kind: null });
      const input = { sticks: S(), dt, groundZ: PILOT[2], fovDeg: 75 };
      let prev = before, prevH = f0.cam.h, maxTurn = 0, maxDh = 0, maxTilt = 0;
      for (let i = 1; i <= 60; i++) {
        const f = c.step(input);
        maxTurn = Math.max(maxTurn, qAngle(prev, f.cam.q));
        maxDh = Math.max(maxDh, Math.abs(f.cam.h - prevH)); // qAngle is blind to a 2π re-wrap of cam.h
        prev = f.cam.q.slice();
        prevH = f.cam.h;
        assert.ok(qAngle(f.cam.q, quatHPR(f.cam.h, f.cam.p, f.cam.r)) < 1e-6, `${tag}: h / p / r describe the blended q (frame ${i})`);
        if (mode !== "cine" && i * dt >= 0.4 + 1e-9) assert.ok(qAngle(f.cam.q, mountOf(f, mode)) < 1e-6, `${tag}: the hard mount from 0.4 s (frame ${i})`);
        if (at === 2.2) maxTilt = Math.max(maxTilt, Math.hypot(f.body.p, f.body.r));
      }
      assert.ok(maxTurn <= 3 * DEG, `${tag}: the view turned ${(maxTurn / DEG).toFixed(2)}° in one frame`);
      // the blended heading is unwrapped next to the previous frame's (the CraftFrame's continuous cam.h)
      assert.ok(maxDh <= 3 * DEG, `${tag}: cam.h stepped ${(maxDh / DEG).toFixed(2)}° in one frame`);
      // only the camera blends: at rest the body stays level (the craft never lurches)
      if (at === 2.2) assert.ok(maxTilt < 1e-6, `${tag}: body tilt ${maxTilt}`);
    }
  }
});

await check("F7 the handover blend under stick input (T16 / an early T8 are input-triggered): the camera turns ≤ 3° per frame more than the mount, never flips", () => {
  // The blend runs in the mount's frame (the plan view's offset decays, the stick rotation passes
  // straight through). A world-frame slerp from the fixed plan view lagged the sticks and FLIPPED
  // when a full acro roll carried the mount past 180° from it: 63° more than the mount in one frame.
  const dt = 1 / 60;
  for (const [mode, sticks] of [["acro", { roll: 1 }], ["acro", { pitch: 1 }], ["angle", { yaw: 1 }], ["angle", { pitch: -1, yaw: -1 }]]) {
    for (const at of [2.2, 1.2]) {
      const c = lifting(mode, 2.2);
      fly(c, S(), at, dt);
      let prevCam = c.state().cam.q, prevMount = mountOf(c.state(), mode), worst = 0, own = 0;
      c.autopilot(null);
      fly(c, S(sticks), 0.6, dt, (f) => {
        const m = mountOf(f, mode);
        const turn = qAngle(prevMount, m);
        own = Math.max(own, turn);
        worst = Math.max(worst, qAngle(prevCam, f.cam.q) - turn);
        prevCam = f.cam.q.slice();
        prevMount = m;
      });
      const tag = `${mode} ${JSON.stringify(sticks)} at ${at} s`;
      assert.ok(own > 2 * DEG, `${tag}: the sticks turn the mount (${(own / DEG).toFixed(2)}°/frame)`);
      assert.ok(worst <= 3 * DEG, `${tag}: the camera turned ${(worst / DEG).toFixed(2)}° more than the mount in one frame`);
    }
  }
});

await check("F7 the handover blend ends cleanly: a hold or a switch to cine mid-blend starts from the blended view, reset lands on the mount", () => {
  const dt = 1 / 60;
  /** 0.2 s into the blend (the lift-off end, then autopilot(null)). */
  const mid = (mode) => {
    const c = lifting(mode, 2.2);
    fly(c, S(), 2.2, dt);
    c.autopilot(null);
    fly(c, S(), 0.2, dt);
    return c;
  };
  for (const [what, act] of [["hold", (c) => c.autopilot({ kind: "hold" })], ["cine", (c) => c.setMode("cine")]]) {
    for (const mode of ["angle", "acro"]) {
      const c = mid(mode);
      let prev = c.state().cam.q, maxTurn = 0;
      act(c);
      fly(c, S(), 1, dt, (f) => { maxTurn = Math.max(maxTurn, qAngle(prev, f.cam.q)); prev = f.cam.q.slice(); });
      assert.ok(maxTurn <= 3 * DEG, `${mode} → ${what}: ${(maxTurn / DEG).toFixed(2)}° in one frame`);
      if (what === "cine") {
        // the interrupted blend is gone: back in the rigid mode the camera is the plain mount at once
        c.setMode(mode);
        const g = c.step({ sticks: S(), dt, groundZ: null, fovDeg: 75 });
        assert.ok(qAngle(g.cam.q, mountOf(g, mode)) < 1e-6, `${mode} → cine → ${mode}: no stale blend`);
      }
    }
  }
  // autopilot(null) again keeps the running blend (a restart would still be ≈ 3° off the mount here)
  const k = mid("angle");
  k.autopilot(null);
  const kf = fly(k, S(), 0.25, dt);
  assert.ok(qAngle(kf.cam.q, mountOf(kf, "angle")) < 1e-6, "on the mount 0.45 s after the first handover");
  const r = mid("acro");
  const s = r.state();
  const f = r.reset({ pos: s.pos, h: s.body.h, p: 0 });
  assert.ok(qAngle(f.cam.q, mountOf(f, "acro")) < 1e-6, "reset: the mount at once");
  const g = r.step({ sticks: S(), dt, groundZ: null, fovDeg: 75 });
  assert.ok(qAngle(g.cam.q, mountOf(g, "acro")) < 1e-6, "and the blend is over");
});

// ---------------------------------------------------------------------------
// F8 — rth / land / hold / crash
// ---------------------------------------------------------------------------

await check("F8 rth lands on the path end (≤ 0.05 m), distTouchdownM non-increasing, ≤ 0.5 m off the polyline, phase speeds", () => {
  const home = [500, 800, 20.06];
  const GZ = 20;
  for (const [name, from] of [["far", [620, 700, 31]], ["near", [501.5, 801, 22]], ["above", [500, 800, 40]], ["low", [430, 860, 20.5]]]) {
    const c = mk("cine", from, 2);
    const path = returnPath(from, home, GZ);
    assert.deepEqual(c.autopilot({ kind: "rth", path }), { ok: true, kind: "rth" });
    near(c.state().distTouchdownM, path.lengthM, 1e-6, `${name}: starts at the path length`);
    let maxOff = 0, maxH = 0, maxUp = 0, maxDown = 0;
    const ev = flyPlan(c, 1 / 60, 120, GZ, (f) => {
      maxOff = Math.max(maxOff, polyDist(f.pos, path.points));
      maxH = Math.max(maxH, Math.hypot(f.vel[0], f.vel[1]));
      maxUp = Math.max(maxUp, f.vel[2]);
      maxDown = Math.max(maxDown, -f.vel[2]);
    });
    const s = c.state();
    assert.ok(ev.landedAt !== null, `${name}: landed`);
    assert.ok(dist3(s.pos, home) <= 0.05, `${name}: ${dist3(s.pos, home)} m from home`);
    assert.ok(ev.mono, `${name}: distTouchdownM increased`);
    assert.ok(maxOff <= 0.5, `${name}: ${maxOff.toFixed(3)} m off the polyline`);
    assert.ok(maxH <= 8 * 1.02 && maxUp <= 3 * 1.02 && maxDown <= 2 * 1.02, `${name}: speeds h ${maxH.toFixed(2)} up ${maxUp.toFixed(2)} down ${maxDown.toFixed(2)}`);
    assert.equal(s.landed, true);
    assert.equal(s.autopilotDone, true);
    assert.equal(s.distTouchdownM, 0);
    assert.equal(s.throttle, 0, "motors idle");
    assert.equal(s.speed, 0);
  }
});

await check("F8 rth touches down at finalMps: the last 1.5 m never faster than 0.6 m/s", () => {
  const home = [0, 0, 10.06];
  const c = mk("cine", [80, 0, 30], 0);
  const path = returnPath([80, 0, 30], home, 10);
  c.autopilot({ kind: "rth", path });
  let maxFinal = 0;
  flyPlan(c, 1 / 60, 120, 10, (f) => { if (f.pos[2] - home[2] < 1.5 - 0.05 && dist3(f.pos, home) < 1.6) maxFinal = Math.max(maxFinal, f.speed); });
  assert.ok(maxFinal > 0.3 && maxFinal <= 0.6 * 1.05, `final ${maxFinal}`);
});

await check("F8 rth from 12 m/s cruise: brakes inside the cinema limits, lands on home, distTouchdownM non-increasing", () => {
  const home = [0, 0, 10.06];
  const c = mk("cine", [0, 120, 40], 0);
  fly(c, S({ pitch: 1 }), 5, 1 / 60);
  const s0 = c.state();
  assert.ok(s0.speed > 11.5, "flying");
  c.autopilot({ kind: "rth", path: returnPath(s0.pos, home, 10) });
  let prevV = s0.vel.slice(), maxDv = 0, touchdown = null;
  const ev = flyPlan(c, 1 / 60, 200, 10, (f) => {
    if (f.landed) touchdown = Math.hypot(...prevV); // the touchdown frame stops the last < 0.3 m/s
    else maxDv = Math.max(maxDv, dist3(f.vel, prevV) * 60);
    prevV = f.vel.slice();
  });
  assert.ok(ev.landedAt !== null && dist3(c.state().pos, home) <= 0.05, "landed on home");
  assert.ok(ev.mono, "distTouchdownM non-increasing");
  assert.ok(maxDv <= 4 + 0.1, `acceleration ${maxDv.toFixed(2)} m/s² within the cinema 4`);
  assert.ok(touchdown !== null && touchdown <= 0.6, `touches down at ≤ finalMps (${touchdown})`);
  assert.ok(ev.maxSpeed <= s0.speed + 0.01, "never faster than it was");
});

await check("F8 land descends its vertical line onto `at` (≤ 0.05 m), distTouchdownM = height above `at`, non-increasing", () => {
  for (const mode of CRAFT_MODES) {
    const at = [50, 60, 10.06];
    const c = mk(mode, [50, 60, 35], 1);
    fly(c, S(), 0.5, 1 / 60);
    assert.deepEqual(c.autopilot({ kind: "land", at }), { ok: true, kind: "land" });
    const d0 = c.state().distTouchdownM;
    near(d0, c.state().pos[2] - at[2], 0.01, `${mode}: height above at`);
    let maxOff = 0;
    const ev = flyPlan(c, 1 / 60, 60, 10, (f) => {
      maxOff = Math.max(maxOff, Math.hypot(f.pos[0] - at[0], f.pos[1] - at[1]));
      if (!f.landed) near(f.distTouchdownM, Math.max(0, f.pos[2] - at[2]), 0.05, `${mode}: tracks the height`);
    });
    assert.ok(ev.landedAt !== null && dist3(c.state().pos, at) <= 0.05, `${mode}: landed on at`);
    assert.ok(ev.mono, `${mode}: non-increasing`);
    assert.ok(maxOff <= 0.5, `${mode}: ${maxOff} m off the vertical line`);
    assert.equal(c.state().autopilotDone, true);
  }
  // from 12 m/s: brakes, comes back over `at`, lands on it
  const at = [0, 0, 10.06];
  const k = mk("cine", [0, 0, 30], 0);
  fly(k, S({ pitch: 1 }), 0.1, 1 / 60);
  fly(k, S({ pitch: 1 }), 4, 1 / 60);
  const p = k.state().pos;
  const atM = [p[0], p[1], 10.06];
  k.autopilot({ kind: "land", at: atM });
  const ev = flyPlan(k, 1 / 60, 90, 10);
  assert.ok(ev.landedAt !== null && dist3(k.state().pos, atM) <= 0.05, "moving start lands on at");
  assert.ok(ev.mono, "moving start: non-increasing");
  void at;
});

await check("F8 hold keeps position within 0.1 m and the heading, whatever the sticks; done never", () => {
  for (const mode of CRAFT_MODES) {
    const c = mk(mode, [7, 8, 25], 1.2);
    fly(c, S(), 0.5, 1 / 60);
    const s0 = c.state();
    assert.deepEqual(c.autopilot({ kind: "hold" }), { ok: true, kind: "hold" });
    let maxDev = 0, maxH = 0;
    fly(c, S({ pitch: 1, yaw: 1, throttle: 1, lookX: 0.1 }), 10, 1 / 60, (f) => {
      maxDev = Math.max(maxDev, dist3(f.pos, s0.pos));
      maxH = Math.max(maxH, Math.abs(Math.atan2(Math.sin(f.cam.h - s0.cam.h), Math.cos(f.cam.h - s0.cam.h))));
      assert.equal(f.autopilotDone, false);
      assert.equal(f.distTouchdownM, null);
    });
    assert.ok(maxDev <= 0.1, `${mode}: ${maxDev} m`);
    assert.ok(maxH < 0.01, `${mode}: heading moved ${maxH}`);
  }
  // from 12 m/s the hold brakes onto the jerk-aware stop point and stays
  const k = mk("cine", [0, 0, 60], 0);
  const f0 = fly(k, S({ pitch: 1 }), 8, 1 / 60);
  const v = f0.speed, p0 = f0.pos.slice();
  k.autopilot({ kind: "hold" });
  const end = fly(k, S(), 10, 1 / 60);
  near(end.pos[1] - p0[1], v * (v / 8 + 0.25), 0.2, "stop distance");
  assert.ok(end.speed < 0.05);
  // an acro dive faster than the cine craft's 20 m/s: the hold is planned at the 20 m/s the craft can carry
  const a = mk("acro", [0, 0, 400], 0);
  fly(a, S({ pitch: 0.3 }), 0.25, 1 / 60);
  const fa = fly(a, S({ throttle: 1 }), 6, 1 / 60);
  assert.ok(fa.speed > 22, `acro reached ${fa.speed} m/s`);
  const pa = fa.pos.slice();
  a.autopilot({ kind: "hold" });
  let maxV = 0;
  const ea = fly(a, S(), 20, 1 / 60, (f) => { maxV = Math.max(maxV, f.speed); });
  near(dist3(ea.pos, pa), 20 * (20 / 8 + 0.25), 0.3, "stop distance from 20 m/s");
  assert.ok(ea.speed < 0.05 && maxV <= 20 + 1e-9, `at rest (${ea.speed}), never above 20 (${maxV})`);
});

await check("F8 crash: ballistic tumble onto groundZ + 0.06 m (landed), motors off, deterministic", () => {
  const run = () => {
    const c = mk("cine", [0, 0, 40], 0);
    fly(c, S({ pitch: 1 }), 3, 1 / 60, null, 10);
    assert.deepEqual(c.autopilot({ kind: "crash" }), { ok: true, kind: "crash" });
    const frames = [];
    let tumbled = 0, prevQ = c.state().body.q;
    const ev = flyPlan(c, 1 / 60, 30, 10, (f) => {
      frames.push(JSON.stringify(f));
      assert.equal(f.throttle, 0);
      tumbled += 2 * Math.acos(Math.min(1, Math.abs(prevQ[0] * f.body.q[0] + prevQ[1] * f.body.q[1] + prevQ[2] * f.body.q[2] + prevQ[3] * f.body.q[3])));
      prevQ = f.body.q.slice();
    });
    return { c, ev, frames, tumbled };
  };
  const a = run();
  const s = a.c.state();
  assert.ok(a.ev.landedAt !== null, "rests on the ground");
  near(s.pos[2], 10.06, 1e-9, "at groundZ + restHeightM");
  assert.equal(s.autopilotDone, true);
  assert.equal(s.autopilot, "crash");
  assert.ok(a.tumbled > Math.PI / 2, `tumbled ${a.tumbled} rad`);
  assert.ok(s.pos[1] > 10, "carries its momentum forward");
  assert.deepEqual(run().frames, a.frames, "deterministic");
  // without a known ground it rests on the first floor contact
  const k = mk("cine", [0, 0, 40], 0);
  k.autopilot({ kind: "crash" });
  const input = { sticks: S(), dt: 1 / 60, groundZ: null, fovDeg: 75 };
  let f = null;
  for (let i = 0; i < 600 && !(f && f.landed); i++) {
    f = k.step(input);
    if (f.pos[2] < 30) k.contact([{ layer: "terrain-floor", kind: "terrain", t: 1, point: [f.pos[0], f.pos[1], 30], normal: [0, 0, 1] }], [f.pos[0], f.pos[1], 30]);
  }
  assert.equal(k.state().landed, true, "rested on the contact floor");
  near(k.state().pos[2], 30, 1e-9, "on the floor");
});

await check("F8 a floor contact on the final descent lands rth / land above the planned end point (the body sphere on a platform)", () => {
  for (const kind of ["rth", "land"]) {
    const end = [0, 0, 10.06];
    const PLATFORM = 10.2; // the safety body sphere holds the drone 0.14 m above the planned end point
    const c = mk("cine", [0, 0, 30], 0);
    c.autopilot(kind === "rth" ? { kind, path: returnPath([0, 0, 30], end, 10) } : { kind, at: end });
    const input = { sticks: S(), dt: 1 / 60, groundZ: 10, fovDeg: 75 };
    let f = null;
    for (let i = 0; i < 60 * 60 && !(f && f.landed); i++) {
      f = c.step(input);
      if (f.pos[2] < PLATFORM) c.contact([{ layer: "statics", kind: "prop", t: 0.9, point: [0, 0, PLATFORM], normal: [0, 0, 1] }], [f.pos[0], f.pos[1], PLATFORM]);
    }
    const s = c.state();
    assert.equal(s.landed, true, `${kind}: landed on the platform`);
    near(s.pos[2], PLATFORM, 1e-9, `${kind}: at the contact height`);
    assert.equal(s.autopilotDone, true);
  }
  // a floor contact high above the end point does not land the plan
  const c = mk("cine", [0, 0, 40], 0);
  c.autopilot({ kind: "land", at: [0, 0, 10.06] });
  fly(c, S(), 1, 1 / 60, null, 10);
  const s = c.state();
  c.contact([{ layer: "scenery", kind: "tree", t: 0.5, point: s.pos, normal: [0, 0, 1] }], s.pos);
  assert.equal(c.state().landed, false, "a canopy 30 m up is not a touchdown");
});

await check("F8 a rth held off its end point in mid-air (a wall before a raised home) lands where it is after the 3 s stall grace", () => {
  // The safety reflex never lets the craft through the wall, so home (on a platform behind it)
  // is out of reach: the craft hovers at the wall at home's height. Before the fix it never
  // landed, so the sequence waited in `landing` forever (T21 needs `landed`) with the input
  // still locked. 3 s after the route clock ends it descends onto the ground under it instead;
  // should that be blocked too (here a craft that cannot sink below 25 m), it lands in place 3 s later.
  // The route clock's end is when an unobstructed twin (the same plan, no wall) lands on home:
  // distTouchdownM never reads 0 early any more (R3-3: never below the straight-line distance).
  // The fallback re-plan is the first createDrone target below home's height once the route's
  // target has reached home: 3 s after the clock end (the twin lands ≈ 0.3 s before it ends).
  // A drop `yaw` still lands facing it (its turn ends on the route clock; the fallback keeps it).
  const GZ = 10, PZ = 30, WALL = 20, R = 0.18;
  const home = [0, 0, PZ + 0.06];
  const from = [0, 60, 25];
  const path = () => TETHER.planReturn(from, home, { cruiseAglM: 15, groundZFrom: GZ, groundZHome: PZ });
  const twin = mk("cine", from, Math.PI);
  twin.autopilot({ kind: "rth", path: path() });
  const tw = flyPlan(twin, 1 / 60, 120, GZ);
  assert.ok(tw.landedAt !== null && dist3(twin.state().pos, home) <= 0.05, "the unobstructed twin lands on home");
  const endedAt = tw.landedAt;
  for (const ramp of [null, 25]) {
    for (const yaw of [undefined, 0.7]) {
      let now = 0, atEnd = false, replanAt = null;
      const c = createManualCraft({ createDrone: (cfg) => {
        const d = FM.createDrone(cfg);
        // the target never goes below `ramp` (null: no ramp): whatever holds the craft up is not a floor contact
        const hold = (t) => (ramp !== null && t && t.pos && t.pos[2] < ramp ? { ...t, pos: [t.pos[0], t.pos[1], ramp], vel: [t.vel[0], t.vel[1], 0], acc: [0, 0, 0] } : t);
        return { ...d, step: (t, h) => {
          if (t && t.pos) {
            if (dist3(t.pos, home) < 1e-6) atEnd = true; // the route's target has reached home
            else if (atEnd && replanAt === null && t.pos[2] < home[2] - 0.01) replanAt = now;
          }
          return d.step(hold(t), h);
        } };
      } });
      c.reset({ pos: from, h: Math.PI, p: 0 });
      c.autopilot(yaw === undefined ? { kind: "rth", path: path() } : { kind: "rth", path: path(), yaw });
      const input = { sticks: S(), dt: 1 / 60, groundZ: GZ, fovDeg: 75 };
      let last = Infinity, mono = true, landedAt = null;
      for (let i = 0; i < 60 * 120 && landedAt === null; i++) {
        now = (i + 1) / 60;
        const f = c.step(input);
        const want = f.pos.slice();
        const hits = [];
        if (want[1] < WALL + R) { want[1] = WALL + R; hits.push({ layer: "buildingMesh", kind: "wall", t: 0.5, point: [want[0], WALL, want[2]], normal: [0, 1, 0] }); }
        if (want[2] < GZ + 0.06) { want[2] = GZ + 0.06; hits.push({ layer: "terrain-floor", kind: "terrain", t: 1, point: [want[0], want[1], GZ], normal: [0, 0, 1] }); }
        if (hits.length) c.contact(hits, want);
        const d = c.state().distTouchdownM;
        if (d !== null) { if (d > last + 1e-9) mono = false; last = d; }
        if (c.state().landed) landedAt = (i + 1) / 60;
      }
      const s = c.state();
      const tag = (ramp === null ? "descent" : "in place") + (yaw === undefined ? "" : ` (yaw ${yaw})`);
      assert.ok(landedAt !== null && s.landed && s.autopilotDone, `${tag}: landed`);
      assert.ok(mono, `${tag}: distTouchdownM non-increasing`);
      near(s.pos[1], WALL + R, 0.05, `${tag}: at the wall`);
      near(s.pos[2], ramp === null ? GZ + 0.06 : ramp, 0.01, `${tag}: on the ground under it / on the ramp`);
      assert.ok(replanAt !== null && replanAt - endedAt >= 2.5 && replanAt - endedAt <= 3.6,
        `${tag}: the fallback starts after the 3 s grace (${replanAt === null ? "never" : (replanAt - endedAt).toFixed(2) + " s after the route clock ended"})`);
      assert.ok(landedAt - endedAt > 3, `${tag}: waited out the grace (${(landedAt - endedAt).toFixed(2)} s after the route clock ended)`);
      assert.ok(landedAt - endedAt < 30, `${tag}: then came down (${(landedAt - endedAt).toFixed(2)} s)`);
      assert.equal(s.throttle, 0, `${tag}: motors idle`);
      if (yaw !== undefined) near(wrapA(s.body.h - yaw), 0, 0.1 * DEG, `${tag}: lands facing the drop yaw`);
    }
  }
});

await check("F8 distTouchdownM never reads below the closest straight-line distance to home: a rth held back by a wall never reaches T17's 5 m while far", () => {
  // The plan clock runs on while a wall taller than the cruise holds the craft back (crash off,
  // or a glancing contact under the crash speed): before the fix distTouchdownM fell to 5 m — the
  // sequence's goggle release (T17), the end of the cancellable return — with the craft still
  // 16.2 m from home (11 m behind a wall at 50°), and the craft then landed at the wall's foot.
  // It now reads ≥ the closest the craft has come to home in a straight line (non-increasing, so
  // a craft the wall deflects away keeps that), equal to the plan's on an unobstructed return.
  const GZ = 10, WALL = 15, TOP = 30, R = 0.18;
  const home = [0, 0, GZ + 0.06];
  const from = [0, 60, 25]; // cruise at 25 m (15 m AGL), the wall's top at 30
  const run = (theta) => {
    const c = mk("cine", from, Math.PI);
    c.autopilot({ kind: "rth", path: returnPath(from, home, GZ) });
    const input = { sticks: S(), dt: 1 / 60, groundZ: GZ, fovDeg: 75 };
    const nx = theta === null ? 0 : Math.sin(theta), ny = theta === null ? 1 : Math.cos(theta);
    const ev = { first5: null, below: 0, mono: true, landed: null };
    let last = Infinity, closest = Infinity;
    for (let i = 0; i < 60 * 120 && ev.landed === null; i++) {
      const f = c.step(input);
      closest = Math.min(closest, dist3(f.pos, home)); // where distTouchdownM was measured (before the clamp)
      // the safety reflex: the wall plane through (0, WALL) with normal (nx, ny, 0), and the ground
      const want = f.pos.slice();
      const hits = [];
      const sd = nx * want[0] + ny * (want[1] - WALL);
      if (theta !== null && sd < R && want[2] <= TOP + R) {
        want[0] += (R - sd) * nx;
        want[1] += (R - sd) * ny;
        hits.push({ layer: "statics", kind: "wall", t: 0.5, point: [want[0] - R * nx, want[1] - R * ny, want[2]], normal: [nx, ny, 0] });
      }
      if (want[2] < GZ + 0.06) { want[2] = GZ + 0.06; hits.push({ layer: "terrain-floor", kind: "terrain", t: 1, point: [want[0], want[1], GZ], normal: [0, 0, 1] }); }
      if (hits.length) c.contact(hits, want);
      const s = c.state(); // what index.js hands the sequence (after the contact)
      const d = s.distTouchdownM;
      if (!s.landed && d < closest - 1e-9) ev.below = Math.max(ev.below, closest - d);
      if (d > last + 1e-9) ev.mono = false;
      last = d;
      if (ev.first5 === null && d <= 5) ev.first5 = { real: dist3(s.pos, home), landed: s.landed };
      if (s.landed) ev.landed = s.pos;
    }
    return ev;
  };
  const free = run(null);
  assert.ok(free.first5 !== null && !free.first5.landed, "free: reads 5 m before touchdown");
  near(free.first5.real, 5, 0.1, "free: 5 m on the tracked path (unchanged)");
  assert.ok(free.landed && dist3(free.landed, home) <= 0.05, "free: lands on home");
  for (const deg of [0, 50]) {
    const ev = run(deg * DEG);
    const tag = `wall at ${deg}°`;
    assert.equal(ev.below, 0, `${tag}: read ${ev.below.toFixed(3)} m below the closest straight-line distance`);
    assert.ok(ev.mono, `${tag}: non-increasing`);
    assert.ok(ev.landed !== null && dist3(ev.landed, home) > 9, `${tag}: landed at the wall's foot`);
    assert.ok(ev.first5 !== null && ev.first5.landed, `${tag}: 5 m first read ${ev.first5 && ev.first5.real.toFixed(2)} m from home (${ev.first5 && ev.first5.landed ? "landed" : "airborne"})`);
  }
});

await check("F8 a rth carrying the drop yaw lands facing it (body and camera ± 0.1°), turning only on its final descent; no / non-finite yaw → the same frames", () => {
  // R4-03: the place clip sets the drone down at the drop yaw and the stow's pickup grabs it at
  // that yaw; a return used to land facing its cruise direction (the grab then snapped). The
  // final descent now turns the heading command onto plan.yaw on a min-jerk curve (body and
  // cine camera follow it); the path, the timing and every position stay exactly the same.
  const GZ = 10, home = [500, 800, GZ + 0.06];
  const flyRth = (from, h0, yaw, hasYaw) => {
    const c = mk("cine", from, h0);
    const plan = { kind: "rth", path: returnPath(from, home, GZ) };
    if (hasYaw) plan.yaw = yaw;
    assert.deepEqual(c.autopilot(plan), { ok: true, kind: "rth" });
    const rows = [];
    flyPlan(c, 1 / 60, 120, GZ, (f) => rows.push(JSON.parse(JSON.stringify(f))));
    return { s: c.state(), rows };
  };
  for (const [name, from, h0] of [["north", [500, 900, 25], Math.PI], ["far", [620, 700, 31], 2], ["above", [500, 800, 40], 1]]) {
    const base = flyRth(from, h0, undefined, false);
    assert.ok(base.s.landed, `${name}: landed`);
    for (const bad of [undefined, NaN, Infinity, null, "0.5"]) {
      assert.deepEqual(flyRth(from, h0, bad, true).rows, base.rows, `${name}: yaw ${String(bad)} changes nothing`);
    }
    for (const yaw of [0.01, -2.54, wrapA(base.s.body.h + Math.PI - 0.02)]) {
      const tag = `${name} yaw ${yaw.toFixed(2)}`;
      const r = flyRth(from, h0, yaw, true);
      assert.ok(r.s.landed && dist3(r.s.pos, home) <= 0.05, `${tag}: landed on home`);
      near(wrapA(r.s.body.h - yaw), 0, 0.1 * DEG, `${tag}: body faces the yaw`);
      near(wrapA(r.s.cam.h - yaw), 0, 0.1 * DEG, `${tag}: camera faces the yaw`);
      assert.equal(r.rows.length, base.rows.length, `${tag}: lands on the same frame`);
      let maxRate = 0;
      for (let k = 0; k < r.rows.length; k++) {
        const a = r.rows[k], b = base.rows[k];
        assert.deepEqual(a.pos, b.pos, `${tag}: frame ${k} position`);
        if (Math.hypot(b.pos[0] - home[0], b.pos[1] - home[1]) > 0.3) {
          assert.equal(a.body.h, b.body.h, `${tag}: frame ${k} turned before the final descent`);
        } else if (k > 0) {
          maxRate = Math.max(maxRate, Math.abs(a.body.h - r.rows[k - 1].body.h) * 60, Math.abs(a.cam.h - r.rows[k - 1].cam.h) * 60);
        }
      }
      assert.ok(maxRate <= 40 * DEG, `${tag}: turns at ≤ 40 °/s on the descent (${(maxRate / DEG).toFixed(1)})`);
    }
  }
});

// ---------------------------------------------------------------------------
// F9 — mode switches, landed rules
// ---------------------------------------------------------------------------

await check("F9 mode switches keep |Δpos| < 0.05 m per step (hover) and the motion continuous at 12 m/s", () => {
  const dt = 1 / 60;
  const c = mk("cine", [0, 0, 50], 0.3);
  fly(c, S(), 1, dt);
  let prev = c.state().pos;
  let maxStep = 0;
  const input = { sticks: S(), dt, groundZ: null, fovDeg: 75 };
  for (const m of ["angle", "acro", "cine", "acro", "angle", "cine"]) {
    assert.equal(c.setMode(m), m);
    for (let i = 0; i < 30; i++) {
      const f = c.step(input);
      maxStep = Math.max(maxStep, dist3(f.pos, prev));
      prev = f.pos.slice();
    }
  }
  assert.ok(maxStep < 0.05, `hover step ${maxStep}`);
  const k = mk("cine", [0, 0, 50], 0.3);
  input.sticks = S({ pitch: 1 });
  let f = fly(k, input.sticks, 5, dt);
  let pp = f.pos.slice(), pv = f.vel.slice(), maxJump = 0;
  for (const m of ["angle", "acro", "cine", "angle", "cine"]) {
    k.setMode(m);
    for (let i = 0; i < 20; i++) {
      f = k.step(input);
      maxJump = Math.max(maxJump, Math.hypot(f.pos[0] - pp[0] - pv[0] * dt, f.pos[1] - pp[1] - pv[1] * dt, f.pos[2] - pp[2] - pv[2] * dt));
      pp = f.pos.slice();
      pv = f.vel.slice();
    }
  }
  assert.ok(maxJump < 0.05, `at speed the position deviates ${maxJump} from the carried motion`);
  assert.equal(k.setMode("nope"), "cine", "unknown → unchanged");
  assert.equal(k.state().mode, "cine");
});

await check("F9 a mode switch during a plan only changes the mode (the cine craft keeps flying it)", () => {
  const c = lifting("cine", 2.2);
  const dt = 1 / 60;
  fly(c, S(), 1, dt);
  c.setMode("acro");
  const f = fly(c, S(), 0.5, dt);
  const s = minJerk((Math.round(1.5 / dt) * dt) / 2.2);
  for (let k = 0; k < 3; k++) near(f.pos[k], HOME[k] + (LIFT_TO[k] - HOME[k]) * s, 1e-6, "still on the lift-off path");
  assert.equal(c.state().mode, "acro");
  c.autopilot(null);
  const g = fly(c, S(), 0.2, dt);
  near(g.throttle, 1, 1e-6, "acro hover thrust after the handover");
});

await check("F9 landed: stays landed (motors idle) with throttle ≤ 0.1, takes off above it — every mode", () => {
  for (const mode of CRAFT_MODES) {
    const c = createManualCraft({ mode });
    const f0 = c.reset({ pos: [5, 5, 10.06], h: 0.5 }, { landed: true });
    assert.equal(f0.landed, true);
    assert.equal(f0.throttle, 0);
    let f = fly(c, S({ throttle: 0.1, pitch: 1, roll: 1, yaw: 1, lookX: 0.2 }), 2, 1 / 60);
    assert.equal(f.landed, true, `${mode}: stays landed`);
    assert.deepEqual(f.pos, [5, 5, 10.06]);
    assert.equal(f.throttle, 0);
    assert.equal(f.speed, 0);
    f = fly(c, S({ throttle: 0.6 }), 1, 1 / 60);
    assert.equal(f.landed, false, `${mode}: took off`);
    assert.ok(f.pos[2] > 10.2, `${mode}: climbing (${f.pos[2]})`);
  }
});

// ---------------------------------------------------------------------------
// F10 — determinism, robustness, API
// ---------------------------------------------------------------------------

/** A scripted run through modes, plans and contacts; returns every frame as JSON. */
function scripted() {
  const c = createManualCraft({ mode: "cine", rates: { rc: 1.2, super: 0.6, expo: 0.2 } });
  c.reset({ pos: HOME, h: C0 + Math.PI, p: 0 }, { landed: true });
  const rows = [];
  const dt = 1 / 60;
  const input = { sticks: S(), dt, groundZ: 50, fovDeg: 75 };
  const go = (n, sticks) => { input.sticks = sticks; for (let i = 0; i < n; i++) { rows.push(JSON.stringify(c.step(input))); } };
  c.autopilot(liftPlan(2.2));
  go(90, S());
  c.autopilot(null);
  go(60, S({ pitch: 1, yaw: 0.3, gimbal: -0.5 }));
  c.setMode("angle");
  go(60, S({ roll: -0.7, throttle: 0.4 }));
  const s = c.state();
  rows.push(JSON.stringify(c.contact([{ layer: "statics", kind: "rock", t: 0.4, point: s.pos, normal: [0.3, -1, 0.2] }], [s.pos[0], s.pos[1] - 0.1, s.pos[2]])));
  c.setMode("acro");
  go(60, S({ pitch: 0.2, roll: 0.3, throttle: 0.1 }));
  c.autopilot({ kind: "rth", path: returnPath(c.state().pos, HOME, 50) });
  go(240, S());
  c.autopilot({ kind: "crash" });
  go(120, S());
  rows.push(JSON.stringify(c.state()));
  return rows;
}

await check("F10 identical inputs → deep-equal frames (modes, plans, contact, crash)", () => {
  const a = scripted(), b = scripted();
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b);
});

await check("F10 NaN-free and no throw at dt 0, −1, NaN, ±Infinity, 1e6 and NaN sticks — every mode and plan", () => {
  for (const mode of CRAFT_MODES) {
    for (const planned of [null, "hold", "rth", "crash", "liftoff", "land"]) {
      const c = createManualCraft({ mode });
      c.reset({ pos: [0, 0, 50], h: 0 });
      if (planned === "rth") c.autopilot({ kind: "rth", path: returnPath([0, 0, 50], [0, 30, 10.06], 10) });
      else if (planned === "liftoff") c.autopilot({ kind: "liftoff", from: [0, 0, 50], to: [0, 3, 52], durationSec: 2.2, heading: 0, lookAt: [0, -1, 51] });
      else if (planned === "land") c.autopilot({ kind: "land", at: [0, 0, 10.06] });
      else if (planned) c.autopilot({ kind: planned });
      for (const dt of [0, -1, NaN, Infinity, -Infinity, 1e6, 1 / 60, 1e6]) {
        const f = c.step({ sticks: { throttle: NaN, yaw: Infinity, pitch: 1, roll: NaN, gimbal: -Infinity, boost: NaN, lookX: NaN, lookY: 1e9 }, dt, groundZ: NaN, fovDeg: NaN });
        assert.ok(finite(...f.pos, ...f.vel, f.speed, f.throttle, f.t, ...f.body.q, f.body.h, f.body.p, f.body.r,
          ...f.cam.q, ...f.cam.pos, f.cam.h, f.cam.p, f.cam.r, f.cam.fov), `${mode}/${planned} dt ${dt}`);
        assert.ok(f.distTouchdownM === null || Number.isFinite(f.distTouchdownM));
      }
      for (const bad of [undefined, null, 7, { dt: 1 / 60 }, { dt: 1 / 60, sticks: null }]) assert.doesNotThrow(() => c.step(bad));
      assert.doesNotThrow(() => c.contact([{ layer: "x", normal: [NaN, 0, 0] }, null, 3], [NaN, 1, 2]));
      const s = c.state();
      assert.deepEqual(JSON.parse(JSON.stringify(s)), s, "state JSON-safe");
    }
  }
});

await check("F10 dt ≤ 0 returns the current frame unchanged", () => {
  const c = mk("angle", [3, 4, 50], 0.2);
  fly(c, S({ pitch: 0.5 }), 1, 1 / 60);
  const before = JSON.stringify(c.state());
  for (const dt of [0, -0.016, NaN]) {
    const f = c.step({ sticks: S({ pitch: 1, yaw: 1, lookX: 0.5 }), dt, groundZ: null, fovDeg: 90 });
    assert.equal(JSON.stringify(c.state()), before, `dt ${dt}`);
    assert.equal(f.cam.fov, 75, "not even the fov");
  }
});

await check("F10 CraftFrame: one reused object from reset / step, SPEC keys, cam.pos equals pos, fov from the input", () => {
  const c = createManualCraft();
  const a = c.reset({ pos: [1, 2, 3], h: 0.5, p: 0 });
  const b = c.step({ sticks: S({ pitch: 1 }), dt: 1 / 60, groundZ: null, fovDeg: 92 });
  assert.equal(a, b, "the same object");
  assert.deepEqual(Object.keys(b).sort(), ["autopilot", "autopilotDone", "body", "cam", "distTouchdownM", "landed", "pos", "speed", "t", "throttle", "vel"].sort());
  assert.deepEqual(Object.keys(b.body).sort(), ["h", "p", "q", "r"]);
  assert.deepEqual(Object.keys(b.cam).sort(), ["fov", "h", "p", "pos", "q", "r", "t"]);
  assert.deepEqual(b.cam.pos, b.pos);
  assert.equal(b.cam.fov, 92);
  near(b.t, 1 / 60, 1e-12, "t = Σdt");
  near(len3(b.vel), b.speed, 1e-12, "speed = |vel|");
  near(Math.hypot(...b.body.q), 1, 1e-9, "unit body q");
  near(Math.hypot(...b.cam.q), 1, 1e-9, "unit cam q");
  assert.equal(b.autopilot, null);
  assert.equal(b.autopilotDone, false);
  assert.equal(b.distTouchdownM, null);
  const s = c.state();
  assert.deepEqual(Object.keys(s).sort(), ["autopilot", "autopilotDone", "body", "cam", "distTouchdownM", "landed", "mode", "pos", "speed", "throttle", "vel"].sort());
  assert.notEqual(s.pos, b.pos, "state() copies");
  assert.deepEqual(s.pos, b.pos);
});

await check("F10 reset: non-finite pose keeps the state; velocity seeds; landed zeroes it; plans are cleared", () => {
  const c = mk("cine", [10, 20, 30], 1);
  const before = JSON.stringify(c.state());
  for (const bad of [null, {}, { pos: [NaN, 0, 0], h: 0 }, { pos: [1, 2] }, 5]) c.reset(bad);
  assert.equal(JSON.stringify(c.state()), before);
  c.reset({ pos: [0, 0, 50], h: 0 }, { velocity: [0, 6, 0] });
  near(c.state().vel[1], 6, 1e-12, "seeded velocity");
  const f = fly(c, S(), 1 / 60, 1 / 60);
  assert.ok(f.pos[1] > 0.05, "keeps moving");
  c.autopilot({ kind: "hold" });
  c.reset({ pos: [0, 0, 10.06], h: NaN }, { velocity: [3, 3, 3], landed: true });
  const s = c.state();
  assert.equal(s.autopilot, null, "plan cleared");
  assert.equal(s.landed, true);
  assert.deepEqual(s.vel, [0, 0, 0]);
});

await check("F10 autopilot: invalid plans → {ok:false} and the current plan stays; unknown mode → cine", () => {
  const c = mk("cine", [0, 0, 50], 0);
  c.autopilot({ kind: "hold" });
  for (const bad of [{ kind: "warp" }, { kind: "rth" }, { kind: "rth", path: { points: [] } }, { kind: "land", at: [1, NaN, 2] },
    { kind: "liftoff", from: [0, 0, 0], to: [0, 1, 1], durationSec: 0 }, { kind: "liftoff", from: null, to: [0, 0, 0], durationSec: 2 }, 42, "rth"]) {
    const r = c.autopilot(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(c.state().autopilot, "hold");
  }
  assert.deepEqual(c.autopilot(undefined), { ok: true, kind: null });
  assert.equal(createManualCraft({ mode: "turbo" }).state().mode, "cine");
  assert.equal(createManualCraft().state().mode, "cine");
  assert.equal(createManualCraft(null).state().mode, "cine");
});

await check("F10 deps.createDrone is the injection point: ONE cinema craft with vmax 20 (DV-6)", () => {
  const calls = [];
  const c = createManualCraft({ createDrone: (cfg) => { calls.push(cfg); return FM.createDrone(cfg); } });
  assert.deepEqual(calls, [{ preset: "cinema", vmax: 20 }]);
  const f = fly(c, S({ pitch: 1, boost: 1 }), 12, 1 / 60);
  assert.ok(f.speed > 19.5, "boost reaches 20 m/s through the injected craft");
  assert.equal(calls.length, 1);
});

await check("F10 setRates changes the acro rates live (rc 2 → 1333 °/s at full stick)", () => {
  const c = mk("acro");
  c.setRates({ rc: 2, super: 0.7, expo: 0 });
  const r = camRates(c, S({ yaw: 1 }), 0.25, 1 / 60).map((x) => x.r);
  near(Math.max(...r), (2 * 200) / 0.3, 0.5, "rc 2");
  c.setRates({ rc: NaN, super: 0, expo: 0 });
  const r2 = camRates(c, S({ yaw: 1 }), 0.25, 1 / 60).map((x) => x.r);
  near(Math.max(...r2), 400, 0.5, "non-finite rc kept at 2, super 0");
  const d = createManualCraft({ mode: "acro", rates: { rc: 0.5 } });
  d.reset({ pos: [0, 0, 50], h: 0 });
  near(Math.max(...camRates(d, S({ yaw: 1 }), 0.25, 1 / 60).map((x) => x.r)), 100 / 0.3, 0.5, "deps.rates");
});

console.log(`drone_flight: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
