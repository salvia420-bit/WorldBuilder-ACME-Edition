// scene3d/film/shots/fpv_tricks.js — FPV trick primitives and the fpv.fpv-run builder.
//
// WHY: a real FPV run is more than a camera gliding along a line. The quad
// punches (the view dips as it tilts to accelerate), brakes (the view flares),
// banks into turns, bobs with the throttle, wobbles in its own prop wash, and
// throws tricks: it punches up, cuts the throttle and FLOATS in true free fall,
// rolls, yaw-spins, loops, split-S's into a pit and noses over into drops. The
// take player flies every fpv shot through the flight model (drone/flight_model.js,
// preset 'fpv': vmax 25, amax 15, jmax 60, hard-mounted up-tilted camera), and
// that model shows only the DEVIATION of the craft from the attitude the
// nominal motion implies — so the FPV character has to be authored into the
// nominal trajectory itself, and the nominal has to stay flyable (jerk ≤ jmax,
// |a| ≤ amax) or the craft trails it. This module does both:
//
//   - trick primitives (planFloat, loopShape, bumpC2, quinticHermite,
//     integratePhases): closed-form, jerk-limited (FPV_RUN_CONSTANTS.trickJerk)
//     motions with zero relative position, velocity AND acceleration at both
//     ends (C² joins), quaternion-continuous attitude, pure in τ;
//   - buildFpvRun: a long run along a racing line with a per-arc-length speed
//     plan (zones, curvature, gravity-assisted dives), spliced tricks, a start
//     hover and an exact duration, and an FPV body-attitude camera (thrust-
//     derived pitch + uptilt mixed with the path pitch, look-ahead heading,
//     coordinated bank, seeded throttle bob and prop-wash wobble).
//
// Everything is computed ONCE at build time into tables (speed profile at
// 240 Hz, camera attitude at 120 Hz), so sample(t) is pure in t and cheap; no
// clocks, no Math.random (noise is seeded from the shot's specSeed).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks, no Math.random.

import { FilmShotError } from "../core/errors.js";
import { quatFromHPR, unwrapAngle } from "../core/gimbal.js";
import { createNoise1D, fbm1D } from "../core/noise.js";
import { qConj, qFromAxisAngle, qMul, qNorm, qSlerp } from "../core/quat.js";
import { deriveSeed } from "../core/rng.js";
import { DRONE_PRESETS } from "../drone/flight_model.js";
import { clampToEnvelope } from "./trajectory.js";

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
/** Standard gravity, m/s² (same constant as the flight model). */
export const GRAVITY = 9.80665;

/** Trick types of fpv.fpv-run (`params.tricks[].type`). */
export const FPV_TRICK_TYPES = Object.freeze(["float", "roll", "yaw-spin", "power-loop", "split-s", "dive", "dip"]);

/** Tricks that leave the racing line and re-join it further on (they ADD their time to the run). */
const IN_PLACE = new Set(["power-loop", "split-s"]);

/**
 * Limits every fpv-run piece is built to (the fpv flight preset must follow it: jmax 60, amax 15,
 * maxRateDeg 720):
 *  - trickJerk: jerk of every trick phase (punch, chop, catch, dips, loop curvature ramps), m/s³;
 *  - profileJerk: jerk the speed profile is smoothed to (punch ↔ brake), m/s³;
 *  - maxTrickRateDeg: peak rotation rate of rolls / spins / split-S rolls (durations are stretched to fit), °/s;
 *  - validate: the validateTrajectory limits the run declares in meta.validate (loops and rolls exceed the default 240°/s);
 *  - drag: quadratic drag per unit mass (the fpv preset's; thrust = a + g ẑ + drag·v|v|);
 *  - diveSpeedMax: speed cap of a gravity-assisted dive (90 % of the fpv preset's vmax);
 *  - loopG: loop / split-S speed u = √(loopG·g·R) — the centripetal acceleration at the top is ≥ g, so a
 *    real quad's thrust keeps pointing at the loop centre (and |a| ≈ 10.8 m/s² < amax).
 * @type {Readonly<{trickJerk:number, profileJerk:number, maxTrickRateDeg:number, validate:Readonly<{maxAngularSpeedDeg:number}>,
 *   drag:number, diveSpeedMax:number, loopG:number, tableHz:number, cameraHz:number}>}
 */
export const FPV_RUN_CONSTANTS = Object.freeze({
  trickJerk: 45,
  profileJerk: 45,
  maxTrickRateDeg: 700,
  validate: Object.freeze({ maxAngularSpeedDeg: 900 }),
  drag: DRONE_PRESETS.fpv.drag,
  diveSpeedMax: 0.9 * DRONE_PRESETS.fpv.vmax,
  loopG: 1.1,
  tableHz: 240,
  cameraHz: 120,
});

/** Smallest fraction of a loop's arc over which its curvature ramps in (and out): clothoid-like, so the centripetal acceleration never jumps. */
const LOOP_RAMP = 0.2;
/** Peak-rate factor of smootherstep (max of its derivative): a turn of θ over T peaks at 1.875·θ/T. */
const SMOOTHERSTEP_PEAK = 1.875;
/** Lateral jerk the speed plan allows where the line's curvature changes (v³·|dκ/ds|), m/s³. */
const LATERAL_JERK = 32;
/** Smallest punch / catch acceleration that still leaves a positive velocity across the jerk-limited chop (√½·g). */
const MIN_FLOAT_ACCEL = 7.2;

// ---------------------------------------------------------------------------
// registry list schemas (used by drone.js's fpv.fpv-run params)
// ---------------------------------------------------------------------------

const pDir = (what) => ({ type: "enum", values: ["right", "left"], default: "right", desc: what });

/** Common fields of one `tricks[]` item. */
export const FPV_TRICK_ITEM = Object.freeze({
  type: { type: "enum", values: FPV_TRICK_TYPES.slice(), desc: "Trick: float | roll | yaw-spin | power-loop | split-s | dive | dip." },
  s: { type: "number", min: 0, max: 100000, unit: "m", desc: "Arc length along the racing line (metres from its start) where the trick begins." },
});

/** Per-type fields of a `tricks[]` item (discriminated by `type`). */
export const FPV_TRICK_VARIANTS = Object.freeze({
  key: "type",
  fields: {
    float: {
      rise: { type: "number", optional: true, min: 0.5, max: 20, unit: "m", desc: "Apex height above the racing line (punch up, cut throttle, float, catch back onto the line). Omitted: 2.5 m, or solved from hangSec when that is given." },
      punchAccel: { type: "number", default: 8, min: MIN_FLOAT_ACCEL, max: 13, unit: "m/s²", desc: "Net upward acceleration of the punch (lowered when even a zero-length punch would overshoot the rise)." },
      catchAccel: { type: "number", default: 12, min: MIN_FLOAT_ACCEL, max: 13, unit: "m/s²", desc: "Net upward acceleration of the catch that stops the fall back on the line." },
      hangSec: { type: "number", optional: true, min: 0.2, max: 6, unit: "s", desc: "Free-fall time (throttle cut → catch). Without rise the apex is solved for it (≈ 0.6 s at 2.5 m, ≈ 1.4 s at ≈ 9 m); with rise the catch is solved instead (little room: ignored, with a note, when it cannot land)." },
      lookDownDeg: { type: "number", default: 30, min: 0, max: 70, unit: "deg", desc: "How far the nose tips down toward the landing at the apex (the camera pitch relative to the entry)." },
    },
    roll: {
      turns: { type: "number", default: 1, min: 1, max: 3, integer: true, desc: "Full rolls." },
      dir: pDir("Roll direction: right = clockwise seen from behind."),
      durationSec: { type: "number", default: 1.1, min: 0.4, max: 6, unit: "s", desc: "Roll time (stretched so the peak rate stays ≤ 700°/s)." },
      rise: { type: "number", default: 0.3, min: 0, max: 3, unit: "m", desc: "Pop-up above the line during the roll." },
    },
    "yaw-spin": {
      turns: { type: "number", default: 1, min: 1, max: 4, integer: true, desc: "Full 360° yaw turns (the camera spins while the craft keeps flying the line)." },
      dir: pDir("Spin direction: right = clockwise seen from above."),
      durationSec: { type: "number", default: 1.6, min: 0.5, max: 10, unit: "s", desc: "Spin time (stretched so the peak rate stays ≤ 700°/s)." },
    },
    "power-loop": {
      radius: { type: "number", default: 3, min: 1.5, max: 15, unit: "m", desc: "Tightest radius of the vertical loop (it rises ≈ 2.05·radius above the line and re-joins it ≈ 1.56·radius further on; flown at √(1.1·g·radius))." },
    },
    "split-s": {
      radius: { type: "number", default: 2.5, min: 1.5, max: 10, unit: "m", desc: "Tightest radius of the half loop down (it drops ≈ 2.05·radius and comes back the other way)." },
      dir: pDir("Direction of the half roll."),
      rollSec: { type: "number", default: 0.5, min: 0.3, max: 2, unit: "s", desc: "Time of the half roll to inverted before the half loop." },
    },
    dive: {
      pitchDeg: { type: "number", default: -80, min: -90, max: -30, unit: "deg", desc: "Body (nose) pitch through the drop; the camera shows pitchDeg + uptiltDeg. The speed builds ballistically (≈ g) down the steep part of the line after s." },
    },
    dip: {
      depth: { type: "number", default: 1, min: 0.2, max: 4, unit: "m", desc: "How far the craft dips below the line (skim)." },
      durationSec: { type: "number", default: 1.6, min: 0.6, max: 8, unit: "s", desc: "Dip time (lengthened so the dip's jerk stays flyable)." },
    },
  },
});

/** Fields of one `zones[]` item. */
export const FPV_ZONE_ITEM = Object.freeze({
  s0: { type: "number", min: 0, max: 100000, unit: "m", desc: "Zone start: arc length along the racing line." },
  s1: { type: "number", min: 0, max: 100000, unit: "m", desc: "Zone end (> s0)." },
  speed: { type: "number", min: 0.5, max: 25, unit: "m/s", desc: "Speed cap inside the zone (absolute: the duration fit never raises it)." },
});

/** Cross-field check of a zone item (registry list `check`). */
export function checkZoneItem(z) {
  return z.s1 > z.s0 ? null : `s1 (${z.s1}) must be greater than s0 (${z.s0})`;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 6x⁵ − 15x⁴ + 10x³ on [0, 1] (zero slope and curvature at both ends). */
function smootherstep(x) {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth maximum (C¹, exactly max once |a − b| ≥ k). */
function softMax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.max(a, b) + (h * h) / (4 * k);
}

/** Box filter of half-width k (edge samples replicated). */
function boxSmooth(arr, k) {
  const n = arr.length;
  if (!(k >= 1) || n < 3) return Float64Array.from(arr);
  const out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  for (let i = 0; i < n; i++) {
    let lo = i - k, hi = i + k;
    let sum = 0;
    if (lo < 0) { sum += arr[0] * -lo; lo = 0; }
    if (hi > n - 1) { sum += arr[n - 1] * (hi - (n - 1)); hi = n - 1; }
    sum += pre[hi + 1] - pre[lo];
    out[i] = sum / (2 * k + 1);
  }
  return out;
}

/** Uniform Catmull-Rom interpolation of a sampled series at fractional index x (clamped). */
function catmull(arr, x) {
  const n = arr.length;
  if (n === 1) return arr[0];
  const xc = clamp(Number.isFinite(x) ? x : 0, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(xc));
  const f = xc - i;
  const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(n - 1, i + 2)];
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
}

const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
function vunit(a, fallback) {
  const l = vlen(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
}
function vcross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Bisection for f(x) = target on [lo, hi] with f increasing; 80 iterations. */
function solveIncreasing(f, target, lo, hi) {
  let a = lo, b = hi;
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    if (f(m) < target) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// trick primitives
// ---------------------------------------------------------------------------

/**
 * Integrate phases of LINEARLY ramped acceleration (jerk piecewise constant): each phase is
 * `{dur, a0, a1}` (acceleration a0 → a1 over dur seconds). Exact cubic polynomials, starting
 * from height z0 and velocity v0. Returns the end state and `at(τ) → {z, v, a, j}` (τ clamped).
 * @param {Array<{dur:number, a0:number, a1:number}>} phases
 * @param {number} [v0=0] @param {number} [z0=0]
 * @returns {{T:number, zEnd:number, vEnd:number, starts:Array<{t:number,z:number,v:number,a0:number,j:number,d:number}>,
 *   at:(tau:number)=>{z:number, v:number, a:number, j:number}}}
 */
export function integratePhases(phases, v0 = 0, z0 = 0) {
  const starts = [];
  let t = 0, z = z0, v = v0;
  for (const ph of phases) {
    const d = Math.max(0, ph.dur);
    const j = d > 0 ? (ph.a1 - ph.a0) / d : 0;
    starts.push({ t, z, v, a0: ph.a0, j, d });
    z += v * d + (ph.a0 * d * d) / 2 + (j * d * d * d) / 6;
    v += ph.a0 * d + (j * d * d) / 2;
    t += d;
  }
  const T = t;
  const at = (tau) => {
    const tt = clamp(Number.isFinite(tau) ? tau : 0, 0, T);
    let k = starts.length - 1;
    while (k > 0 && starts[k].t > tt) k--;
    const s = starts[k];
    const u = Math.min(tt - s.t, s.d);
    return { z: s.z + s.v * u + (s.a0 * u * u) / 2 + (s.j * u * u * u) / 6, v: s.v + s.a0 * u + (s.j * u * u) / 2, a: s.a0 + s.j * u, j: s.j };
  };
  return { T, zEnd: z, vEnd: v, starts, at };
}

/**
 * The FLOAT trick as a vertical offset above the line: punch (ramp 0 → +P, hold), chop
 * (ramp +P → −g), FREE FALL (a = −g exactly: up to the apex and back down), catch (ramp −g →
 * +C, hold), release (ramp +C → 0). Every ramp is at `jerk` m/s³; the hold times are solved so
 * the apex is exactly `rise` above the start and the offset returns to 0 with zero velocity and
 * acceleration (C² joins). Apex = z(chop end) + v(chop end)²/(2g) (ballistic closed form).
 * `hangSec` (free-fall time) without `rise`: the apex is solved for it. Both: the catch
 * acceleration is solved (in [7.2, 13] m/s²) — the jerk-limited catch leaves little room, so a
 * hang far from the rise's own is ignored with a note giving the longest that lands. Neither:
 * rise 2.5 m.
 * @param {{rise?:number, punchAccel:number, catchAccel:number, hangSec?:number, jerk?:number}} o
 * @returns {{T:number, at:(tau:number)=>{z:number,v:number,a:number,j:number}, apex:number, tApex:number,
 *   freeFall:number[], punchAccel:number, catchAccel:number, hangSec:number, notes:string[]}}
 */
export function planFloat(o) {
  const hasRise = Number.isFinite(o.rise);
  if (Number.isFinite(o.hangSec) && !hasRise) {
    // hang only: the apex is solved so the free fall lasts hangSec (the hang grows with the rise)
    const base = { ...o, hangSec: undefined };
    const hangOf = (r) => planFloatCore({ ...base, rise: r }).hangSec;
    const lo = 0.5, hi = 30;
    let rise;
    const pre = [];
    if (hangOf(hi) < o.hangSec) {
      rise = hi;
      pre.push(`hangSec ${o.hangSec} s needs a float higher than ${hi} m: rise ${hi} m used`);
    } else if (hangOf(lo) > o.hangSec) {
      rise = lo;
      pre.push(`hangSec ${o.hangSec} s is shorter than the smallest float's: rise ${lo} m used`);
    } else rise = solveIncreasing(hangOf, o.hangSec, lo, hi);
    const out = planFloatCore({ ...base, rise });
    out.notes.unshift(...pre);
    return out;
  }
  return planFloatCore({ ...o, rise: hasRise ? o.rise : FLOAT_DEFAULT_RISE });
}

/** Rise of a float that names neither rise nor hangSec, m. */
const FLOAT_DEFAULT_RISE = 2.5;

/** planFloat with a given rise (hangSec, when given too, is met by solving the catch). */
function planFloatCore(o) {
  const J = Number.isFinite(o.jerk) && o.jerk > 0 ? o.jerk : FPV_RUN_CONSTANTS.trickJerk;
  const notes = [];
  let rise = o.rise;
  let P = Math.max(MIN_FLOAT_ACCEL, o.punchAccel);
  let C = Math.max(MIN_FLOAT_ACCEL, o.catchAccel);
  const upPhases = (p, tp) => [{ dur: p / J, a0: 0, a1: p }, { dur: tp, a0: p, a1: p }, { dur: (p + GRAVITY) / J, a0: p, a1: -GRAVITY }];
  const apexOf = (p, tp) => {
    const u = integratePhases(upPhases(p, tp));
    return u.zEnd + (u.vEnd * u.vEnd) / (2 * GRAVITY);
  };
  let tp = 0;
  if (apexOf(P, 0) > rise) {
    if (apexOf(MIN_FLOAT_ACCEL, 0) > rise) {
      notes.push(`rise ${rise} m is below the smallest jerk-limited float (${apexOf(MIN_FLOAT_ACCEL, 0).toFixed(2)} m): raised`);
      rise = apexOf(MIN_FLOAT_ACCEL, 0);
      P = MIN_FLOAT_ACCEL;
    } else {
      const p2 = solveIncreasing((p) => apexOf(p, 0), rise, MIN_FLOAT_ACCEL, P);
      notes.push(`punchAccel lowered to ${p2.toFixed(2)} m/s² (a zero-length punch at ${P} overshoots the ${rise} m rise)`);
      P = p2;
    }
  } else {
    let hi = 1;
    while (apexOf(P, hi) < rise && hi < 1e4) hi *= 2;
    tp = solveIncreasing((x) => apexOf(P, x), rise, 0, hi);
  }
  const up = integratePhases(upPhases(P, tp));
  const v3 = up.vEnd, z3 = up.zEnd;
  const tUp = v3 / GRAVITY;
  const apex = z3 + (v3 * v3) / (2 * GRAVITY);

  const catchPhases = (c, tc) => [{ dur: (GRAVITY + c) / J, a0: -GRAVITY, a1: c }, { dur: tc, a0: c, a1: c }, { dur: c / J, a0: c, a1: 0 }];
  const dvCatch = (c, tc) => (2 * c * c - GRAVITY * GRAVITY) / (2 * J) + c * tc;
  // landing height (relative to the start) for a catch (c, tc) after falling td from the apex
  const zEndOf = (c, tc) => {
    const td = dvCatch(c, tc) / GRAVITY;
    const fall = integratePhases(catchPhases(c, tc), -GRAVITY * td, apex - (GRAVITY * td * td) / 2);
    return fall.zEnd;
  };
  let tc = 0;
  let hang = null;
  if (Number.isFinite(o.hangSec)) {
    const td = o.hangSec - tUp;
    const tcOf = (c) => Math.max(0, (GRAVITY * td - (2 * c * c - GRAVITY * GRAVITY) / (2 * J)) / c);
    const zc = (c) => {
      const t = tcOf(c);
      const fall = integratePhases(catchPhases(c, t), -GRAVITY * td, apex - (GRAVITY * td * td) / 2);
      return fall.zEnd;
    };
    const exact = (c) => Math.abs(dvCatch(c, tcOf(c)) - GRAVITY * td) < 1e-9;
    if (td > 0 && exact(13) && zc(13) >= 0 && exact(MIN_FLOAT_ACCEL) && zc(MIN_FLOAT_ACCEL) <= 0) {
      C = solveIncreasing(zc, 0, MIN_FLOAT_ACCEL, 13);
      tc = tcOf(C);
      hang = o.hangSec;
    } else {
      // the hangs the softest / hardest catch can still land from this apex (fall + catch = apex)
      const landWith = (c) => (tdx) => {
        const tcx = Math.max(0, (GRAVITY * tdx - (2 * c * c - GRAVITY * GRAVITY) / (2 * J)) / c);
        return integratePhases(catchPhases(c, tcx), -GRAVITY * tdx, apex - (GRAVITY * tdx * tdx) / 2).zEnd;
      };
      const hMin = tUp + solveIncreasing((x) => -landWith(MIN_FLOAT_ACCEL)(x), 0, 0, 10);
      const hMax = tUp + solveIncreasing((x) => -landWith(13)(x), 0, 0, 10);
      notes.push(`hangSec ${o.hangSec} s cannot be landed from a ${apex.toFixed(2)} m apex (a catch in [${MIN_FLOAT_ACCEL}, 13] m/s² lands ≈ ${hMin.toFixed(2)}–${hMax.toFixed(2)} s; omit rise to have the apex solved for the hang): ignored`);
    }
  }
  if (hang === null) {
    if (zEndOf(C, 0) < 0) {
      // even the shortest catch at C lands below the line: soften it
      const c2 = zEndOf(MIN_FLOAT_ACCEL, 0) < 0 ? MIN_FLOAT_ACCEL : solveIncreasing((c) => -zEndOf(c, 0), 0, MIN_FLOAT_ACCEL, C);
      notes.push(`catchAccel lowered to ${c2.toFixed(2)} m/s²`);
      C = c2;
      tc = 0;
    } else {
      let hi = 1;
      while (zEndOf(C, hi) > 0 && hi < 1e4) hi *= 2;
      tc = solveIncreasing((x) => -zEndOf(C, x), 0, 0, hi);
    }
  }
  const td = dvCatch(C, tc) / GRAVITY;
  const tff = tUp + td;
  const phases = [...upPhases(P, tp), { dur: tff, a0: -GRAVITY, a1: -GRAVITY }, ...catchPhases(C, tc)];
  const prof = integratePhases(phases);
  const ffStart = prof.starts[3].t;
  return {
    T: prof.T,
    at: prof.at,
    apex,
    rise,
    tApex: ffStart + tUp,
    freeFall: [ffStart, ffStart + tff],
    punchEnd: prof.starts[2].t,
    catchEnd: prof.starts[5].t + prof.starts[5].d,
    punchAccel: P,
    catchAccel: C,
    hangSec: tff,
    zEnd: prof.zEnd,
    vEnd: prof.vEnd,
    notes,
  };
}

/** sin⁴(πx) on [0, 1]: a C² bump (value, slope and curvature 0 at both ends, 1 at x = ½). */
export function bumpC2(x) {
  if (!(x > 0 && x < 1)) return 0;
  const s = Math.sin(Math.PI * x);
  return s * s * s * s;
}

/** max |d³/dx³ sin⁴(πx)| (a unit bump over unit time has this peak jerk). */
const BUMP_JERK = (() => {
  let m = 0;
  for (let i = 0; i <= 4000; i++) {
    const a = (Math.PI * i) / 4000;
    const s = Math.sin(a), c = Math.cos(a);
    m = Math.max(m, Math.abs(4 * Math.PI ** 3 * (6 * s * c * c * c - 10 * s * s * s * c)));
  }
  return m;
})();

/** Shortest time a C² bump of `height` takes at `jerk` m/s³. */
export function bumpMinSec(height, jerk = FPV_RUN_CONSTANTS.trickJerk) {
  return height > 0 ? Math.cbrt((height * BUMP_JERK) / jerk) : 0;
}

/**
 * A planar curve that turns by `turn` radians (+ = pulls up, toward the plane's "up"; − =
 * down) with curvature ramping (smootherstep) from 0 to 1/radius over the first LOOP_RAMP of
 * its arc and back to 0 over the last, after an optional straight `lead` (metres) — so a
 * craft entering it straight sees its centripetal acceleration build smoothly (clothoid-like)
 * and leaves it straight. Local coordinates: x along the entry direction, z along the plane's
 * up. A full loop (turn 2π) climbs ≈ 2.04·radius and exits ≈ 1.56·radius ahead of its entry.
 * Positions are a C¹ Hermite table (exact tangents); λ < 0 and λ > length extrapolate straight.
 * @param {number} turn radians (±2π loop, −π half loop down)
 * @param {number} radius tightest radius, m
 * @param {number} [lead=0] straight run before the turn, m
 * @returns {{length:number, lead:number, at:(lam:number)=>{x:number, z:number, theta:number},
 *   end:{x:number, z:number, theta:number}, zMax:number, zMin:number}}
 */
export function loopShape(turn, radius, lead = 0) {
  const sgn = turn < 0 ? -1 : 1;
  // ramp long enough that, flown at the design speed √(loopG·g·R), the curvature ramp's jerk
  // 1.875·u³/(R·ramp) stays ≤ 85 % of trickJerk (a half loop needs a larger fraction than a full one)
  const u = Math.sqrt(FPV_RUN_CONSTANTS.loopG * GRAVITY * radius);
  const rampLen = (SMOOTHERSTEP_PEAK * u * u * u) / (radius * 0.85 * FPV_RUN_CONSTANTS.trickJerk);
  const xr = rampLen / (Math.abs(turn) * radius);
  const rho = clamp(xr / (1 + xr), LOOP_RAMP, 0.45);
  const arc = (Math.abs(turn) * radius) / (1 - rho);
  const n = 2048;
  const h = arc / n;
  const kap = (v) => {
    const r = v < rho ? smootherstep(v / rho) : v > 1 - rho ? smootherstep((1 - v) / rho) : 1;
    return (sgn * r) / radius;
  };
  const X = new Float64Array(n + 1), Z = new Float64Array(n + 1), TH = new Float64Array(n + 1);
  let th = 0, x = 0, z = 0, zMax = 0, zMin = 0;
  for (let i = 0; i < n; i++) {
    const k0 = kap(i / n), k1 = kap((i + 0.5) / n), k2 = kap((i + 1) / n);
    const th1 = th + (h / 2) * (k0 + k1) / 2;
    const th2 = th + (h * (k0 + 4 * k1 + k2)) / 6;
    x += (h * (Math.cos(th) + 4 * Math.cos(th1) + Math.cos(th2))) / 6;
    z += (h * (Math.sin(th) + 4 * Math.sin(th1) + Math.sin(th2))) / 6;
    th = th2;
    X[i + 1] = x; Z[i + 1] = z; TH[i + 1] = th;
    if (z > zMax) zMax = z;
    if (z < zMin) zMin = z;
  }
  TH[n] = turn;
  const total = lead + arc;
  const at = (lam) => {
    const l = Number.isFinite(lam) ? lam : 0;
    if (l <= lead) return { x: l, z: 0, theta: 0 };
    const m = l - lead;
    if (m >= arc) {
      const e = m - arc, c = Math.cos(TH[n]), s = Math.sin(TH[n]);
      return { x: lead + X[n] + c * e, z: Z[n] + s * e, theta: TH[n] };
    }
    const fi = m / h;
    const i = Math.min(n - 1, Math.floor(fi));
    const f = fi - i;
    const f2 = f * f, f3 = f2 * f;
    const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
    const c0 = Math.cos(TH[i]), s0 = Math.sin(TH[i]), c1 = Math.cos(TH[i + 1]), s1 = Math.sin(TH[i + 1]);
    return {
      x: lead + h00 * X[i] + h10 * h * c0 + h01 * X[i + 1] + h11 * h * c1,
      z: h00 * Z[i] + h10 * h * s0 + h01 * Z[i + 1] + h11 * h * s1,
      theta: TH[i] + (TH[i + 1] - TH[i]) * f,
    };
  };
  return { length: total, lead, at, end: { x: lead + X[n], z: Z[n], theta: TH[n] }, zMax, zMin };
}

/**
 * Quintic Hermite (vector) with given value, first and second derivative at τ = 0 and τ = T:
 * the C² correction that splices a trick's motion exactly onto the line at both ends.
 * @returns {(tau:number) => number[]}
 */
export function quinticHermite(T, p0, v0, a0, p1, v1, a1) {
  return (tau) => {
    const u = clamp(T > 0 ? tau / T : 1, 0, 1);
    const u2 = u * u, u3 = u2 * u, u4 = u3 * u, u5 = u4 * u;
    const h0 = 1 - 10 * u3 + 15 * u4 - 6 * u5;
    const h1 = (u - 6 * u3 + 8 * u4 - 3 * u5) * T;
    const h2 = ((u2 - 3 * u3 + 3 * u4 - u5) / 2) * T * T;
    const h3 = 10 * u3 - 15 * u4 + 6 * u5;
    const h4 = (-4 * u3 + 7 * u4 - 3 * u5) * T;
    const h5 = ((u3 - 2 * u4 + u5) / 2) * T * T;
    return [0, 1, 2].map((c) => h0 * p0[c] + h1 * v0[c] + h2 * a0[c] + h3 * p1[c] + h4 * v1[c] + h5 * a1[c]);
  };
}

// ---------------------------------------------------------------------------
// speed plan along the racing line
// ---------------------------------------------------------------------------

/**
 * Station grid with every λ-independent cap of the speed plan: curvature (√(alat/κ), peak κ of
 * both adjacent intervals), zones and in-place trick caps (`fixed`), dive stations (cruise cap
 * replaced by the dive cap, gravity-assisted forward acceleration).
 */
function makeStations(line, o) {
  const L = line.L;
  const n = Math.max(64, Math.min(40000, Math.ceil(L / 0.25)));
  const ds = L / n;
  const SUB = 4;
  const kInt = new Float64Array(n);
  const kap = (s) => {
    const k = line.curvatureAt(clamp(s, 0, L));
    return Number.isFinite(k) && k > 0 ? k : 0;
  };
  let kPrev = kap(0);
  for (let i = 0; i < n; i++) {
    let km = kPrev;
    for (let j = 1; j <= SUB; j++) {
      const k = kap(i * ds + (ds * j) / SUB);
      if (k > km) km = k;
      if (j === SUB) kPrev = k;
    }
    kInt[i] = km;
  }
  const capCurv = new Float64Array(n + 1);
  const fixed = new Float64Array(n + 1).fill(Infinity);
  const dive = new Uint8Array(n + 1);
  const aFwd = new Float64Array(n + 1).fill(o.amax);
  // lateral jerk ≈ v³·|dκ/ds|: where the curvature changes fast (tight S-bends, a hairpin through a
  // vertical drop) the speed is also capped by ∛(J/|κ'|), so the nominal stays within the craft's jerk
  const kS = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) kS[i] = kap(i * ds);
  const kw = Math.max(1, Math.round(0.5 / ds));
  const kSm = boxSmooth(kS, kw);
  const dk = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n, i + 1);
    dk[i] = b > a ? Math.abs(kSm[b] - kSm[a]) / ((b - a) * ds) : 0;
  }
  const dkM = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - kw); j <= Math.min(n, i + kw); j++) if (dk[j] > m) m = dk[j];
    dkM[i] = m;
  }
  for (let i = 0; i <= n; i++) {
    const k = Math.max(i > 0 ? kInt[i - 1] : 0, i < n ? kInt[i] : 0);
    const cLat = k > 0 ? Math.sqrt(o.alat / k) : Infinity;
    const cJerk = dkM[i] > 1e-9 ? Math.cbrt(LATERAL_JERK / dkM[i]) : Infinity;
    capCurv[i] = Math.min(cLat, cJerk);
  }
  return { n, ds, L, capCurv, fixed, dive, aFwd };
}

/** Forward / backward acceleration passes over station caps; returns speeds and station times. */
function passes(st, cap, o) {
  const { n, ds } = st;
  const V = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) V[i] = cap[i];
  if (o.rest) {
    V[0] = 0;
    V[n] = 0;
  }
  for (let i = 0; i < n; i++) V[i + 1] = Math.min(V[i + 1], Math.sqrt(V[i] * V[i] + 2 * st.aFwd[i] * ds));
  for (let i = n - 1; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] * V[i + 1] + 2 * o.amax * ds));
  const T = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const vs = V[i] + V[i + 1];
    T[i + 1] = T[i] + (vs > 1e-9 ? (2 * ds) / vs : Math.sqrt((2 * ds) / Math.max(o.amax, 1e-3)));
  }
  return { V, T };
}

/** Sliding-window minimum of cap over stations whose times lie within ±W (monotone deque). */
function erodeInTime(cap, T, W) {
  const n = cap.length;
  const out = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && T[hi] <= T[i] + W) {
      while (tail > head && cap[dq[tail - 1]] >= cap[hi]) tail--;
      dq[tail++] = hi;
      hi++;
    }
    while (head < tail && T[dq[head]] < T[i] - W) head++;
    out[i] = cap[dq[head]];
  }
  return out;
}

/**
 * The route speed plan at cruise speed vc: caps → passes → caps eroded over ±W of time → passes
 * again. Smoothing the result with a kernel of half-support W then never exceeds a cap (every
 * speed in a station's kernel window is ≤ its eroded cap ≤ the station's own cap).
 */
function planAt(st, vc, o) {
  const { n } = st;
  const cap = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) cap[i] = Math.min(st.dive[i] ? o.diveCap : vc, st.capCurv[i], st.fixed[i]);
  const p1 = passes(st, cap, o);
  const capE = o.W > 0 ? erodeInTime(cap, p1.T, o.W) : cap;
  const p2 = passes(st, capE, o);
  return { V: p2.V, T: p2.T, R: p2.T[n] };
}

/** Station-table time / speed at arc length s (linear between stations). */
function stationLerp(arr, st, s) {
  const x = clamp(s / st.ds, 0, st.n);
  const i = Math.min(st.n - 1, Math.floor(x));
  return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
}

/**
 * Jerk-smoothed route profile over the ROUTE time axis r ∈ [0, H0 + R + H1]: v = 0 in the start
 * hover H0 and end settle H1, the station profile in between; two box passes of half-width hb
 * (support ±2hb ≤ the erosion window) — the acceleration of the station profile (piecewise
 * constant) becomes continuous with jerk ≤ Δa/(2·hb); the distance is rescaled to exactly L.
 */
function smoothRoute(st, plan, H0, H1, hb, rest) {
  const hz = FPV_RUN_CONSTANTS.tableHz;
  const Rtot = H0 + plan.R + H1;
  const m = Math.max(16, Math.ceil(Rtot * hz));
  const dt = Rtot / m;
  const { V, T } = plan;
  const v = new Float64Array(m + 1);
  let i = 0;
  for (let k = 0; k <= m; k++) {
    const r = k * dt - H0;
    if (r <= 0) v[k] = rest ? 0 : V[0];
    else if (r >= plan.R) v[k] = rest ? 0 : V[st.n];
    else {
      while (i < st.n - 1 && T[i + 1] < r) i++;
      const d = T[i + 1] - T[i];
      const a = d > 0 ? (V[i + 1] - V[i]) / d : 0;
      v[k] = Math.max(0, V[i] + a * (r - T[i]));
    }
  }
  const kk = Math.max(0, Math.round(hb / dt));
  const vs = kk >= 1 ? boxSmooth(boxSmooth(v, kk), kk) : v;
  if (rest) {
    vs[0] = 0;
    vs[m] = 0;
  }
  const S = new Float64Array(m + 1);
  for (let k = 0; k < m; k++) S[k + 1] = S[k] + 0.5 * (vs[k] + vs[k + 1]) * dt;
  const sc = S[m] > 1e-12 ? st.L / S[m] : 0;
  for (let k = 0; k <= m; k++) {
    vs[k] *= sc;
    S[k] *= sc;
  }
  const locate = (r) => {
    const x = clamp(Number.isFinite(r) ? r : 0, 0, Rtot) / dt;
    const k = Math.min(m - 1, Math.floor(x));
    return { k, f: (x - k) * dt };
  };
  const sAt = (r) => {
    const { k, f } = locate(r);
    return clamp(S[k] + vs[k] * f + (0.5 * (vs[k + 1] - vs[k]) * f * f) / dt, 0, st.L);
  };
  const vAt = (r) => {
    const { k, f } = locate(r);
    return vs[k] + ((vs[k + 1] - vs[k]) * f) / dt;
  };
  /** Route time at which s is first reached (bisection over the monotone S table). */
  const rAt = (s) => {
    if (!(s > 0)) {
      let k = 0;
      while (k < m && S[k + 1] <= 0) k++;
      return k * dt;
    }
    if (s >= st.L) {
      let k = m;
      while (k > 0 && S[k - 1] >= st.L - 1e-12) k--;
      return k * dt;
    }
    let lo = 0, hi = m;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] < s) lo = mid;
      else hi = mid;
    }
    let a = lo * dt, b = hi * dt;
    for (let it = 0; it < 50; it++) {
      const mm = (a + b) / 2;
      if (sAt(mm) < s) a = mm;
      else b = mm;
    }
    return (a + b) / 2;
  };
  let peak = 0;
  for (let k = 0; k <= m; k++) if (vs[k] > peak) peak = vs[k];
  return { Rtot, dt, sAt, vAt, rAt, peak };
}

// ---------------------------------------------------------------------------
// fpv.fpv-run
// ---------------------------------------------------------------------------

/**
 * The racing line as a C² curve: the (filleted, smoothed) path resampled every ≤ 0.1 m of arc
 * length and evaluated as a uniform cubic B-spline over those samples (phantom end points make it
 * pass exactly through both ends with the end tangents; interior deviation ≈ h²κ/6 < 1 mm).
 * Catmull-Rom paths are only C¹ — their curvature steps at every knot, which a craft (and any
 * jerk measurement) sees as jerk spikes — so the run flies this instead. Position, unit tangent
 * and curvature at arc length s; beyond [0, L] the line continues straight along its end tangent.
 */
function lineView(line) {
  const L = line.length;
  if (!(L > 1e-6)) {
    const p0 = line.at(0);
    return { L: 0, pos: () => p0.slice(), tan: () => [0, 1, 0], curvatureAt: () => 0 };
  }
  const n = Math.max(16, Math.min(200000, Math.ceil(L / 0.1)));
  const h = L / n;
  const X = new Float64Array(n + 3), Y = new Float64Array(n + 3), Z = new Float64Array(n + 3);
  for (let i = 0; i <= n; i++) {
    const p = line.at(i === n ? L : i * h);
    X[i + 1] = p[0]; Y[i + 1] = p[1]; Z[i + 1] = p[2];
  }
  X[0] = 2 * X[1] - X[2]; Y[0] = 2 * Y[1] - Y[2]; Z[0] = 2 * Z[1] - Z[2];
  X[n + 2] = 2 * X[n + 1] - X[n]; Y[n + 2] = 2 * Y[n + 1] - Y[n]; Z[n + 2] = 2 * Z[n + 1] - Z[n];
  /** B-spline value and first/second derivatives (per metre) at s ∈ [0, L]. */
  const evalAt = (s, order) => {
    const x = clamp(s, 0, L) / h;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    const f2 = f * f, f3 = f2 * f;
    let w;
    if (order === 0) w = [(1 - 3 * f + 3 * f2 - f3) / 6, (4 - 6 * f2 + 3 * f3) / 6, (1 + 3 * f + 3 * f2 - 3 * f3) / 6, f3 / 6];
    else if (order === 1) w = [(-3 + 6 * f - 3 * f2) / (6 * h), (-12 * f + 9 * f2) / (6 * h), (3 + 6 * f - 9 * f2) / (6 * h), (3 * f2) / (6 * h)];
    else w = [(6 - 6 * f) / (6 * h * h), (-12 + 18 * f) / (6 * h * h), (6 - 18 * f) / (6 * h * h), (6 * f) / (6 * h * h)];
    // samples i-1..i+2 live at array indices i..i+3 (index 0 is the phantom before the start)
    return [
      w[0] * X[i] + w[1] * X[i + 1] + w[2] * X[i + 2] + w[3] * X[i + 3],
      w[0] * Y[i] + w[1] * Y[i + 1] + w[2] * Y[i + 2] + w[3] * Y[i + 3],
      w[0] * Z[i] + w[1] * Z[i + 1] + w[2] * Z[i + 2] + w[3] * Z[i + 3],
    ];
  };
  const tan = (s) => vunit(evalAt(s, 1), [0, 1, 0]);
  const pos = (s) => {
    if (s > L) return vadd(evalAt(L, 0), vscale(tan(L), s - L));
    if (s < 0) return vadd(evalAt(0, 0), vscale(tan(0), s));
    return evalAt(s, 0);
  };
  const curvatureAt = (s) => {
    const d1 = evalAt(s, 1), d2 = evalAt(s, 2);
    const sp = vlen(d1);
    if (!(sp > 1e-9)) return 0;
    const k = vlen(vcross(d1, d2)) / (sp * sp * sp);
    return Number.isFinite(k) ? k : 0;
  };
  return { L, pos, tan, curvatureAt };
}

/**
 * Look-ahead heading and pitch tables over s. The heading is unwrapped and taken only where the
 * look-ahead has a clear horizontal component (≥ 30 %); across near-vertical stretches (a shaft,
 * a chute that comes out the other way) it is interpolated between the headings before and after,
 * so a reversal through a vertical drop turns smoothly instead of snapping 180°; the result is
 * box-smoothed over ≈ lookAhead/2 so the heading rate has no kinks.
 */
function lookTables(lv, LA, hint) {
  const L = lv.L;
  const n = L > 1e-6 ? Math.max(32, Math.min(16384, Math.ceil(L / 0.25) + 1)) : 1;
  const ds = n > 1 ? L / (n - 1) : 0;
  const H = new Float64Array(n), Pt = new Float64Array(n);
  const ok = new Uint8Array(n);
  let prevH = hint;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    const p = lv.pos(s), q = lv.pos(s + LA);
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    const hz = Math.hypot(dx, dy), tot = Math.hypot(hz, dz);
    Pt[i] = tot > 1e-9 ? Math.atan2(dz, hz) : i > 0 ? Pt[i - 1] : 0;
    if (hz > 0.3 * Math.max(1e-6, tot)) {
      H[i] = unwrapAngle(Math.atan2(dx, dy), prevH);
      prevH = H[i];
      ok[i] = 1;
    }
  }
  // fill the near-vertical gaps: hold at the ends, interpolate (the short way) in between
  let last = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && !ok[i]) continue;
    const a = last, b = i < n ? i : -1;
    if (b - a > 1 || (b < 0 && a < n - 1)) {
      const hA = a >= 0 ? H[a] : b >= 0 ? H[b] : hint;
      const hB = b >= 0 ? H[b] : hA;
      for (let k = a + 1; k < (b >= 0 ? b : n); k++) {
        const f = b >= 0 && a >= 0 ? (k - a) / (b - a) : 0;
        H[k] = hA + (hB - hA) * smootherstep(f);
      }
    }
    last = i;
  }
  const kw = Math.max(1, Math.round((0.25 * LA) / Math.max(ds, 1e-9)));
  const Hs = n > 2 ? boxSmooth(boxSmooth(H, kw), kw) : H;
  const at = (arr, s) => catmull(arr, ds > 0 ? s / ds : 0);
  return { headingAt: (s) => at(Hs, s), pitchAt: (s) => at(Pt, s) };
}

/**
 * Build the fpv.fpv-run nominal (see drone.js for the technique definition): returns
 * `{positionAt, orientAt, keyframes, meta}` for makeTrajectory.
 *
 * Steps: (1) tricks sorted by s, in-place ones (power-loop, split-s) and dives decided on the
 * line's geometry; (2) the speed plan — caps from cruise speed, curvature (alat), zones,
 * in-place trick speeds and dive caps, accel/brake passes with gravity-assisted dives, eroded
 * and jerk-smoothed — fitted (cruise speed bisection between ~0.3 m/s and speedMax) so the
 * route time + start hover + end settle + the in-place tricks' own time is exactly D (beyond
 * speedMax the route time is compressed: `overspeed`); (3) the timeline: route segments and
 * in-place tricks (their motion + a quintic C² correction onto the line at both ends), along-
 * line tricks (float / roll / yaw-spin / dip / dive) placed by arc length, skipped (with a
 * reason) when they overlap, run past the end or do not fit; (4) the FPV body-attitude camera.
 * @param {{spec:Object, ctx:Object, line:Object, P:Object, headingHint:number}} o
 */
export function buildFpvRun(o) {
  const { spec, ctx, P } = o;
  const D = spec.duration;
  const lv = lineView(o.line);
  const L = lv.L;
  const C = FPV_RUN_CONSTANTS;
  const rest = P.ends !== "cruise";
  const fpvVmax = DRONE_PRESETS.fpv.vmax;
  const amax = Math.min(P.amax, 0.875 * DRONE_PRESETS.fpv.amax);
  const uptilt = P.uptiltDeg * DEG;
  const lap = P.lookAlongPath;
  const ceilingAt = ctx.indoor && typeof ctx.indoor.ceiling === "function" ? ctx.indoor.ceiling : null;
  const floorAt = ctx.indoor && typeof ctx.indoor.floor === "function" ? ctx.indoor.floor : null;
  const groundAt = !ctx.indoor && typeof ctx.groundZ === "function" ? ctx.groundZ : null;
  const zSafe = (fn, p) => {
    if (!fn) return null;
    let z;
    try {
      z = fn(p[0], p[1]);
    } catch {
      return null;
    }
    return typeof z === "number" && Number.isFinite(z) ? z : null;
  };

  // ---- 1. tricks: normalise, sort, decide the in-place ones and dives on the geometry ----------
  const tricks = (Array.isArray(P.tricks) ? P.tricks : []).map((t, index) => ({ ...t, index, rec: { type: t.type, s: t.s, t0: null, t1: null } }));
  tricks.sort((a, b) => a.s - b.s || a.index - b.index);
  const skip = (t, reason) => {
    t.skipped = true;
    t.rec.skipped = true;
    t.rec.reason = reason;
  };
  const straightness = (s0, s1) => {
    let km = 0;
    for (let s = Math.max(0, s0); s <= Math.min(L, s1) + 1e-9; s += 0.25) km = Math.max(km, lv.curvatureAt(s));
    return km;
  };
  const committedS = []; // [s0, s1] route windows of in-place tricks and dives (pre-fit)
  const overlapsS = (a, b) => committedS.find((w) => a < w[1] + 0.5 && b > w[0] - 0.5);
  const loopSpeed = (R) => Math.sqrt(C.loopG * GRAVITY * R);
  for (const t of tricks) {
    if (!(L > 0.5)) {
      skip(t, `the racing line is too short (${L.toFixed(2)} m)`);
      continue;
    }
    if (t.s > L) {
      skip(t, `s ${t.s} m is beyond the end of the racing line (${L.toFixed(1)} m)`);
      continue;
    }
    if (t.type === "power-loop") {
      const shape = loopShape(TAU, t.radius);
      const delta = shape.end.x;
      const tA = lv.tan(t.s);
      if (Math.abs(tA[2]) > 0.5) { skip(t, "the line is too steep at s for a loop (|slope| > 30°)"); continue; }
      if (t.s + delta > L) { skip(t, "the loop would re-join the line past its end"); continue; }
      if (straightness(t.s - 1, t.s + delta + 1) > 1 / (3 * t.radius)) { skip(t, "the line curves too much at s for a loop (needs a near-straight stretch)"); continue; }
      const pa = lv.pos(t.s);
      const ce = zSafe(ceilingAt, pa);
      if (ce !== null && pa[2] + shape.zMax + 0.3 > ce - 0.3) { skip(t, `no headroom: the loop climbs ${shape.zMax.toFixed(1)} m, the ceiling is ${(ce - pa[2]).toFixed(1)} m above the line`); continue; }
      const w = [t.s, t.s + delta];
      const hit = overlapsS(w[0], w[1]);
      if (hit) { skip(t, `overlaps the ${hit[2]} at s=${hit[3]} m`); continue; }
      Object.assign(t, { shape, sb: t.s + delta, u: loopSpeed(t.radius) });
      committedS.push([w[0], w[1], t.type, t.s]);
    } else if (t.type === "split-s") {
      const tA = lv.tan(t.s);
      if (Math.abs(tA[2]) > 0.35) { skip(t, "the line is too steep at s for a split-S (|slope| > 20°)"); continue; }
      const u = loopSpeed(t.radius);
      const found = findSplitS(lv, t, u);
      if (!found.ok) { skip(t, found.reason); continue; }
      const pa = lv.pos(t.s);
      const fl = zSafe(floorAt, pa) ?? zSafe(groundAt, pa);
      if (fl !== null && pa[2] + found.shape.zMin < fl + 0.5) { skip(t, `no room below: the split-S drops ${(-found.shape.zMin).toFixed(1)} m`); continue; }
      const hit = overlapsS(t.s, found.sb);
      if (hit) { skip(t, `overlaps the ${hit[2]} at s=${hit[3]} m`); continue; }
      Object.assign(t, { shape: found.shape, sb: found.sb, u });
      committedS.push([t.s, found.sb, t.type, t.s]);
    } else if (t.type === "dive") {
      // the steep part of the line after s gets the gravity assist
      let s0 = null, s1 = null;
      for (let s = t.s; s <= Math.min(L, t.s + 60); s += 0.25) {
        const steep = lv.tan(s)[2] < -0.5;
        if (steep && s0 === null && s <= t.s + 6) s0 = s;
        if (s0 !== null && !steep) { s1 = s; break; }
      }
      if (s0 !== null && s1 === null) s1 = Math.min(L, t.s + 60);
      const sEnd = s0 !== null ? s1 : Math.min(L, t.s + 4);
      const hit = overlapsS(t.s, sEnd);
      if (hit) { skip(t, `overlaps the ${hit[2]} at s=${hit[3]} m`); continue; }
      Object.assign(t, { steep: s0 !== null ? [s0, s1] : null, sEnd });
      committedS.push([t.s, sEnd, t.type, t.s]);
    }
  }

  // ---- 2. speed plan + duration fit -------------------------------------------------------------
  const hb = (amax + Math.max(amax, tricks.some((t) => t.type === "dive" && !t.skipped && t.steep) ? 0.95 * GRAVITY : 0)) / (2 * C.profileJerk);
  const W = 2 * hb;
  // the pure hover lasts startHoldSec; the jerk smoothing's spool-up (W) follows it inside the route axis
  const H0 = rest ? P.startHoldSec + W : 0;
  const H1 = rest ? W : 0;
  const st = L > 1e-6 ? makeStations(lv, { amax, alat: P.alat }) : null;
  const vHi = Math.min(P.speedMax, 0.95 * fpvVmax);
  const vLo = Math.min(0.3, vHi);
  const planOpts = { amax, rest, W, diveCap: C.diveSpeedMax };
  const applyCaps = () => {
    if (!st) return;
    st.fixed.fill(Infinity);
    st.dive.fill(0);
    st.aFwd.fill(amax);
    for (const z of P.zones || []) {
      const i0 = Math.max(0, Math.floor(z.s0 / st.ds)), i1 = Math.min(st.n, Math.ceil(z.s1 / st.ds));
      for (let i = i0; i <= i1; i++) st.fixed[i] = Math.min(st.fixed[i], z.speed);
    }
    for (const t of tricks) {
      if (t.skipped) continue;
      if (IN_PLACE.has(t.type)) {
        const margin = t.u * (2 * W + 0.3) + 1;
        const i0 = Math.max(0, Math.floor((t.s - margin) / st.ds)), i1 = Math.min(st.n, Math.ceil((t.sb + margin) / st.ds));
        for (let i = i0; i <= i1; i++) st.fixed[i] = Math.min(st.fixed[i], t.u);
      } else if (t.type === "dive" && t.steep) {
        const i0 = Math.max(0, Math.floor(t.steep[0] / st.ds)), i1 = Math.min(st.n, Math.ceil(t.steep[1] / st.ds));
        for (let i = i0; i <= i1; i++) {
          st.dive[i] = 1;
          st.aFwd[i] = Math.max(amax, 0.95 * GRAVITY * Math.max(0, -lv.tan(i * st.ds)[2]));
        }
      }
    }
  };
  const inPlace = () => tricks.filter((t) => !t.skipped && IN_PLACE.has(t.type));
  const totalOf = (plan) => {
    let tot = H0 + H1 + plan.R;
    for (const t of inPlace()) {
      const ra = stationLerp(plan.T, st, t.s), rb = stationLerp(plan.T, st, t.sb);
      const va = Math.max(0.5, stationLerp(plan.V, st, t.s));
      tot += t.shape.length / va - (rb - ra);
    }
    return tot;
  };
  let vc = 0, plan = null, prof = null, routeK = 1, segs = null, saturated = false;
  for (let attempt = 0; attempt < 16; attempt++) {
    applyCaps();
    if (st) {
      let lo = Math.log(vLo), hi = Math.log(vHi);
      const fHi = totalOf(planAt(st, vHi, planOpts));
      saturated = fHi >= D;
      if (saturated) {
        lo = hi;
      } else {
        for (let i = 0; i < 64; i++) {
          const mid = (lo + hi) / 2;
          if (totalOf(planAt(st, Math.exp(mid), planOpts)) > D) lo = mid;
          else hi = mid;
        }
      }
      vc = Math.exp((lo + hi) / 2);
      plan = planAt(st, vc, planOpts);
      prof = smoothRoute(st, plan, H0, H1, hb, rest);
    } else {
      prof = null;
    }
    // in-place tricks: their route-axis window and entry speed on the smoothed profile
    let fixedRoute = prof ? prof.Rtot : D;
    let extra = 0;
    let bad = null;
    for (const t of inPlace()) {
      t.ra = prof.rAt(t.s);
      t.rb = prof.rAt(t.sb);
      t.va = prof.vAt(t.ra);
      fixedRoute -= t.rb - t.ra;
      extra += t.shape.length / Math.max(0.5, t.va);
      if (t.va < 1.5 && !bad) bad = t;
    }
    if (bad) {
      skip(bad, `entry speed ${bad.va.toFixed(2)} m/s too low (too close to a rest start/end or a tight turn)`);
      continue;
    }
    // route time compression k (1 when the fit converged; > 1 = overspeed; < 1 = slack absorbed)
    routeK = prof ? (fixedRoute + extra) / D : 1;
    if (!(routeK > 0) || !Number.isFinite(routeK)) routeK = 1;
    // a run whose fixed parts (hover, settle, tricks) leave no route time: drop the last in-place trick
    if (prof && inPlace().length && fixedRoute / routeK < 0.5) {
      const last = inPlace().pop();
      skip(last, "the shot is too short for this trick");
      continue;
    }
    break;
  }

  // ---- 3. timeline -------------------------------------------------------------------------
  // segments: route (σ from the route axis) and in-place tricks, in global time
  segs = [];
  {
    let tG = 0, rPrev = 0;
    for (const t of inPlace()) {
      const dtR = (t.ra - rPrev) / routeK;
      segs.push({ kind: "route", t0: tG, t1: tG + dtR, r0: rPrev });
      tG += dtR;
      t.u = t.va * routeK;
      t.T = t.shape.length / t.u;
      segs.push({ kind: "trick", t0: tG, t1: tG + t.T, trick: t });
      t.t0 = tG;
      t.t1 = tG + t.T;
      tG += t.T;
      rPrev = t.rb;
    }
    segs.push({ kind: "route", t0: tG, t1: Math.max(tG, D), r0: rPrev });
    if (segs.length) segs[segs.length - 1].t1 = D;
  }
  const sigmaR = (r) => (prof ? prof.sAt(r) : 0);
  const segAt = (t) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (segs[m].t0 <= t) lo = m;
      else hi = m - 1;
    }
    return segs[lo];
  };
  /** Route progress at global time t (smooth through in-place tricks; the look tables and headroom checks use it). */
  const sigmaAt = (t) => {
    const tc = clamp(t, 0, D);
    const sg = segAt(tc);
    if (sg.kind === "trick") {
      const k = sg.trick;
      return k.s + (k.sb - k.s) * smootherstep((tc - sg.t0) / (sg.t1 - sg.t0));
    }
    return sigmaR(sg.r0 + (tc - sg.t0) * routeK);
  };
  /** Global time at which the route first reaches arc length s (null inside an in-place trick). */
  const timeAtS = (s) => {
    if (!prof) return 0;
    const r = prof.rAt(s);
    for (const sg of segs) {
      if (sg.kind !== "route") continue;
      const rEnd = sg.r0 + (sg.t1 - sg.t0) * routeK;
      if (r >= sg.r0 - 1e-9 && r <= rEnd + 1e-9) return sg.t0 + (r - sg.r0) / routeK;
    }
    return null;
  };
  const routePosAtR = (r) => lv.pos(sigmaR(r));

  // in-place trick motions (entry frame + C² correction onto the line at both ends)
  const hD = 0.004;
  const derivs = (f, x) => {
    const a = f(x - hD), b = f(x), c = f(x + hD);
    return { p: b, v: vscale(vsub(c, a), 1 / (2 * hD)), a: vscale(vadd(vsub(c, vscale(b, 2)), a), 1 / (hD * hD)) };
  };
  for (const t of inPlace()) {
    const tA = lv.tan(t.s);
    const fwd = tA;
    const nrm = vunit(vsub([0, 0, 1], vscale(fwd, fwd[2])), [0, 0, 1]);
    if (t.type === "split-s") {
      // the roll lead depends on the realised speed: rebuild the shape and re-find the re-join station nearby
      const again = findSplitS(lv, t, t.u, t.sb);
      if (again.ok) t.shape = again.shape;
    }
    const shape = t.shape;
    const u = t.u;
    const pA = routePosAtR(t.ra);
    const raw = (tau) => {
      const g = shape.at(u * tau);
      return [pA[0] + fwd[0] * g.x + nrm[0] * g.z, pA[1] + fwd[1] * g.x + nrm[1] * g.z, pA[2] + fwd[2] * g.x + nrm[2] * g.z];
    };
    const routeIn = (tau) => routePosAtR(t.ra + tau * routeK);
    const routeOut = (tau) => routePosAtR(t.rb + (tau - t.T) * routeK);
    const e0 = derivs(routeIn, 0), r0 = derivs(raw, 0);
    const e1 = derivs(routeOut, t.T), r1 = derivs(raw, t.T);
    const corr = quinticHermite(t.T, vsub(e0.p, r0.p), vsub(e0.v, r0.v), vsub(e0.a, r0.a), vsub(e1.p, r1.p), vsub(e1.v, r1.v), vsub(e1.a, r1.a));
    t.posAt = (tau) => vadd(raw(tau), corr(tau));
    t.fwd = fwd;
    t.nrm = nrm;
    t.lamAt = (tau) => u * tau;
    t.exitMismatchM = vlen(vsub(e1.p, r1.p));
    t.rec.t0 = t.t0;
    t.rec.t1 = t.t1;
    Object.assign(t.rec, t.type === "power-loop"
      ? { radius: t.radius, sEnd: t.sb, speed: u, heightM: shape.zMax, rejoinM: shape.end.x }
      : { radius: t.radius, dir: t.dir, sEnd: t.sb, speed: u, dropM: -shape.end.z, exitMismatchM: t.exitMismatchM });
  }

  // along-line tricks (and dives): time windows, overlap / end checks, motion
  const windows = inPlace().map((t) => [t.t0, t.t1, t.type, t.s]);
  const overlapsT = (a, b) => windows.find((w) => a < w[1] + 0.05 && b > w[0] - 0.05);
  const along = [];
  for (const t of tricks) {
    if (t.skipped || IN_PLACE.has(t.type)) continue;
    const t0 = timeAtS(t.s);
    if (t0 === null) {
      skip(t, "s lies inside a loop / split-S");
      continue;
    }
    if (t.type === "dive") {
      const tEnd = timeAtS(t.sEnd);
      const t1 = Math.min(D, (tEnd === null ? t0 + 1.5 : tEnd) + 0.5);
      t.T = t1 - t0;
      t.tEnd = tEnd === null ? t0 + 1 : tEnd;
    } else if (t.type === "float") {
      const fp = planFloat({ rise: t.rise, punchAccel: t.punchAccel, catchAccel: t.catchAccel, hangSec: t.hangSec });
      // headroom where it starts and where the apex is (a stepped ceiling)
      let room = Infinity;
      for (const sx of [t.s, sigmaAt(t0 + fp.tApex)]) {
        const px = lv.pos(sx);
        const cx = zSafe(ceilingAt, px);
        if (cx !== null) room = Math.min(room, cx - 0.6 - px[2]);
      }
      if (fp.apex > room) {
        if (room < 0.6) { skip(t, `no headroom for a float (${room.toFixed(2)} m under the ceiling)`); continue; }
        t.fp = planFloat({ rise: room, punchAccel: t.punchAccel, catchAccel: t.catchAccel, hangSec: t.hangSec });
        t.fp.notes.push(`rise lowered to ${room.toFixed(2)} m to clear the ceiling`);
      } else t.fp = fp;
      t.T = t.fp.T;
    } else if (t.type === "roll" || t.type === "yaw-spin") {
      const minT = (t.turns * 360 * SMOOTHERSTEP_PEAK) / C.maxTrickRateDeg;
      t.T = Math.max(t.durationSec, minT);
      if (t.T > t.durationSec + 1e-9) t.rec.stretchedSec = t.T;
      if (t.type === "roll") {
        const lim = (C.trickJerk * t.T ** 3) / BUMP_JERK;
        t.riseEff = Math.min(t.rise, lim);
      }
    } else if (t.type === "dip") {
      let depth = t.depth;
      const pa = lv.pos(t.s);
      const fl = zSafe(floorAt, pa) ?? (zSafe(groundAt, pa) !== null ? zSafe(groundAt, pa) + 0.2 : null);
      if (fl !== null && pa[2] - depth < fl + 0.5) {
        depth = pa[2] - fl - 0.5;
        if (depth < 0.1) { skip(t, "no room below the line for a dip"); continue; }
        t.rec.depthLowered = depth;
      }
      t.depthEff = depth;
      t.T = Math.max(t.durationSec, bumpMinSec(depth));
    }
    const t1 = t0 + t.T;
    if (t1 > D + 1e-9) {
      skip(t, `runs past the end of the shot (needs ${t.T.toFixed(2)} s from t=${t0.toFixed(2)} s)`);
      continue;
    }
    const hit = overlapsT(t0, t1);
    if (hit) {
      skip(t, `overlaps the ${hit[2]} at s=${hit[3]} m`);
      continue;
    }
    t.t0 = t0;
    t.t1 = t1;
    t.rec.t0 = t0;
    t.rec.t1 = t1;
    windows.push([t0, t1, t.type, t.s]);
    along.push(t);
    if (t.type === "float") {
      Object.assign(t.rec, {
        rise: t.fp.rise, apexM: t.fp.apex, apexT: t0 + t.fp.tApex, freeFall: [t0 + t.fp.freeFall[0], t0 + t.fp.freeFall[1]],
        punchAccel: t.fp.punchAccel, catchAccel: t.fp.catchAccel, hangSec: t.fp.hangSec,
      });
      if (t.fp.notes.length) t.rec.notes = t.fp.notes.slice();
    } else if (t.type === "roll") Object.assign(t.rec, { turns: t.turns, dir: t.dir, durationSec: t.T, rise: t.riseEff });
    else if (t.type === "yaw-spin") Object.assign(t.rec, { turns: t.turns, dir: t.dir, durationSec: t.T });
    else if (t.type === "dip") Object.assign(t.rec, { depth: t.depthEff, durationSec: t.T });
    else if (t.type === "dive") Object.assign(t.rec, { pitchDeg: t.pitchDeg, sEnd: t.sEnd, steepM: t.steep ? t.steep[1] - t.steep[0] : 0, bottomT: t.tEnd });
  }
  along.sort((a, b) => a.t0 - b.t0);
  for (const t of tricks) {
    if (t.skipped) {
      t.rec.t0 = null;
      t.rec.t1 = null;
    }
  }

  /** Vertical offset of the along-line tricks at t (float, dip, roll pop). */
  const offsetZ = (t) => {
    let dz = 0;
    for (const k of along) {
      if (t <= k.t0 || t >= k.t1) continue;
      const tau = t - k.t0;
      if (k.type === "float") dz += k.fp.at(tau).z;
      else if (k.type === "dip") dz -= k.depthEff * bumpC2(tau / k.T);
      else if (k.type === "roll" && k.riseEff > 0) dz += k.riseEff * bumpC2(tau / k.T);
    }
    return dz;
  };

  // throttle bob (faded out around every trick: free fall stays exactly −g)
  const bobN = createNoise1D(deriveSeed(o.seed, "fpv-run:bob"));
  const allWin = windows.map((w) => [w[0], w[1]]);
  const FADE = 1.0;
  // product (not min) of per-window fades: smooth even where two fades overlap
  const bobWeight = (t) => {
    let w = 1;
    for (const [a, b] of allWin) {
      if (t >= a && t <= b) return 0;
      if (t < a && a - t < FADE) w *= smootherstep((a - t) / FADE);
      else if (t > b && t - b < FADE) w *= smootherstep((t - b) / FADE);
    }
    return w;
  };
  const bobAt = (t) => (P.throttleBobM > 0 ? P.throttleBobM * bobN(t * P.bobHz) * bobWeight(t) : 0);

  const rawPositionAt = (t) => {
    const tc = clamp(t, 0, D);
    const sg = segAt(tc);
    let p;
    if (sg.kind === "trick") p = sg.trick.posAt(tc - sg.t0);
    else p = lv.pos(sigmaR(sg.r0 + (tc - sg.t0) * routeK));
    const dz = offsetZ(tc) + bobAt(tc);
    return [p[0], p[1], p[2] + dz];
  };
  const positionAt = (t) => clampToEnvelope(rawPositionAt(t), ctx);

  // ---- 4. camera: FPV body attitude tables -------------------------------------------------
  const hint = Number.isFinite(o.headingHint) ? o.headingHint : 0;
  const look = L > 1e-6 ? lookTables(lv, Math.max(0.5, P.lookAhead), hint) : { headingAt: () => hint, pitchAt: () => 0 };
  const nc = Math.max(8, Math.ceil(D * C.cameraHz)) + 1;
  const dtc = D / (nc - 1);
  const PX = new Float64Array(nc), PY = new Float64Array(nc), PZ = new Float64Array(nc);
  for (let i = 0; i < nc; i++) {
    const p = positionAt(i * dtc);
    PX[i] = p[0]; PY[i] = p[1]; PZ[i] = p[2];
  }
  const deriv1 = (A) => {
    const out = new Float64Array(nc);
    for (let i = 0; i < nc; i++) {
      const a = Math.max(0, i - 1), b = Math.min(nc - 1, i + 1);
      out[i] = b > a ? (A[b] - A[a]) / ((b - a) * dtc) : 0;
    }
    return out;
  };
  const deriv2 = (A) => {
    const out = new Float64Array(nc);
    for (let i = 1; i < nc - 1; i++) out[i] = (A[i + 1] - 2 * A[i] + A[i - 1]) / (dtc * dtc);
    out[0] = out[1];
    out[nc - 1] = out[nc - 2];
    return out;
  };
  // attitude response ≈ the fpv preset's attSmoothSec (0.1 s): the thrust the body follows is smoothed over ±0.1 s
  const ks = Math.max(1, Math.round(0.05 / dtc));
  const sm = (A) => boxSmooth(boxSmooth(A, ks), ks);
  const VX = deriv1(PX), VY = deriv1(PY), VZ = deriv1(PZ);
  const AX = sm(deriv2(PX)), AY = sm(deriv2(PY)), AZ = sm(deriv2(PZ));
  const HT = new Float64Array(nc), PT = new Float64Array(nc), RT = new Float64Array(nc), TH = new Float64Array(nc), PW = new Float64Array(nc);
  let peakSpeed = 0;
  const maxBank = P.maxBankDeg * DEG;
  const maxTilt = DRONE_PRESETS.fpv.maxTiltDeg * DEG;
  // pitch overrides of along-line tricks: {w, p} (camera pitch replaced by p with weight w)
  const floatOverride = (k, t, entryPitch) => {
    const tau = t - k.t0;
    const fp = k.fp;
    const w = smootherstep(tau / Math.max(1e-3, fp.punchEnd)) * (1 - smootherstep((tau - fp.freeFall[1]) / Math.max(1e-3, k.T - fp.freeFall[1])));
    const a = fp.freeFall[0], b = fp.freeFall[1], m = fp.tApex;
    let shape = 0;
    if (tau > a && tau < b) shape = tau <= m ? Math.sin((Math.PI / 2) * ((tau - a) / Math.max(1e-3, m - a))) ** 2 : Math.sin((Math.PI / 2) * ((b - tau) / Math.max(1e-3, b - m))) ** 2;
    return { w, p: entryPitch - k.lookDownDeg * DEG * shape };
  };
  const diveOverride = (k, t) => {
    const w = smootherstep((t - k.t0) / 0.4) * (1 - smootherstep((t - (k.tEnd - 0.2)) / 0.7));
    return { w, p: (k.pitchDeg + P.uptiltDeg) * DEG };
  };
  const entryPitch = new Map();
  for (let i = 0; i < nc; i++) {
    const t = i * dtc;
    const v = [VX[i], VY[i], VZ[i]];
    const sp = vlen(v);
    if (sp > peakSpeed) peakSpeed = sp;
    const s = sigmaAt(t);
    const H = look.headingAt(s);
    const Pp = look.pitchAt(s);
    const T = [AX[i] + C.drag * v[0] * sp, AY[i] + C.drag * v[1] * sp, AZ[i] + C.drag * v[2] * sp + GRAVITY];
    const f = [Math.sin(H), Math.cos(H), 0], r = [Math.cos(H), -Math.sin(H), 0];
    const tz = softMax(T[2], 0.2 * GRAVITY, 0.15 * GRAVITY);
    let thB = -Math.atan2(vdot(T, f), tz);
    let phB = Math.atan2(vdot(T, r), tz);
    // total body tilt ≤ the fpv preset's maxTiltDeg, saturating softly (identity below 70 % of it, C¹)
    const tilt = Math.hypot(thB, phB);
    if (tilt > 0.7 * maxTilt) {
      const sat = maxTilt * (0.7 + 0.3 * Math.tanh((tilt / maxTilt - 0.7) / 0.3));
      thB *= sat / tilt;
      phB *= sat / tilt;
    }
    let camP = (1 - lap) * (thB + uptilt) + lap * Pp;
    for (const k of along) {
      if (t < k.t0 || t > k.t1) continue;
      let ov = null;
      if (k.type === "float") {
        if (!entryPitch.has(k)) entryPitch.set(k, camP);
        ov = floatOverride(k, t, entryPitch.get(k));
      } else if (k.type === "dive") ov = diveOverride(k, t);
      if (ov) camP = (1 - ov.w) * camP + ov.w * ov.p;
    }
    HT[i] = H;
    PT[i] = clamp(camP, -89 * DEG, 89 * DEG);
    RT[i] = maxBank > 0 ? maxBank * Math.tanh((P.bankGain * phB) / maxBank) : 0;
    const thr = vlen(T) / GRAVITY;
    TH[i] = thr;
    const vh = Math.hypot(v[0], v[1]);
    const desc = clamp((-v[2] - 0.8) / 2.5, 0, 1) * clamp(1.4 - vh / 6, 0, 1);
    PW[i] = desc;
  }
  // prop wash also kicks in on hard catches (throttle rising fast after a chop)
  {
    const dTh = deriv1(TH);
    for (let i = 0; i < nc; i++) PW[i] = clamp(PW[i] + 0.4 * clamp(dTh[i] / 4, 0, 1), 0, 1);
  }
  const PWs = boxSmooth(boxSmooth(PW, Math.max(1, Math.round(0.12 / dtc))), Math.max(1, Math.round(0.12 / dtc)));
  // finite attitude bandwidth (zero-phase, ±0.12 s): an S-bend taken fast (or a time-compressed
  // overspeed run) never whips the bank or the heading faster than a quad can roll / yaw; the
  // tricks' own rotations are composed after these tables and are not touched
  {
    const ka = Math.max(1, Math.round(0.06 / dtc));
    for (const arr of [HT, PT, RT]) {
      const sm2 = boxSmooth(boxSmooth(arr, ka), ka);
      for (let i = 0; i < nc; i++) arr[i] = sm2[i];
    }
  }
  const tab = (arr, t) => catmull(arr, clamp(t, 0, D) / dtc);

  const roll0 = spec.roll || 0;
  const baseQ = (t) => quatFromHPR(tab(HT, t), tab(PT, t), tab(RT, t) + roll0);
  for (const t of inPlace()) {
    const tA = t.fwd;
    const qM0 = quatFromHPR(Math.atan2(tA[0], tA[1]), Math.asin(clamp(tA[2], -1, 1)), 0);
    t.qM0 = qM0;
    t.qOff = qMul(qConj(qM0), baseQ(t.t0));
    t.sgnRoll = t.dir === "left" ? -1 : 1;
  }
  const trickQ = (k, tau) => {
    const lam = k.lamAt(tau);
    const g = k.shape.at(lam);
    let dq;
    if (k.type === "power-loop") dq = qFromAxisAngle([1, 0, 0], g.theta);
    else {
      const lead = k.shape.lead;
      const wr = smootherstep(lead > 0 ? lam / lead : 1);
      dq = qMul(qFromAxisAngle([0, 1, 0], k.sgnRoll * Math.PI * wr), qFromAxisAngle([1, 0, 0], -g.theta));
    }
    return qMul(qMul(k.qM0, dq), k.qOff);
  };

  const wobN = ["h", "p", "r", "wh", "wp", "wr"].map((c) => createNoise1D(deriveSeed(o.seed, `fpv-run:wobble:${c}`)));
  const fbA = { octaves: 2, gain: 0.5 };
  const fbB = { octaves: 2, gain: 0.6 };
  const wobAt = (t) => {
    const a = P.wobbleDeg * DEG, b = P.propwashDeg * DEG * tab(PWs, t);
    return {
      dh: a * fbm1D(wobN[0], t * 2.3, fbA) + 0.5 * b * fbm1D(wobN[3], t * 6.5, fbB),
      dp: a * fbm1D(wobN[1], t * 2.3, fbA) + b * fbm1D(wobN[4], t * 6.5, fbB),
      dr: a * fbm1D(wobN[2], t * 2.3, fbA) + b * fbm1D(wobN[5], t * 6.5, fbB),
    };
  };

  const orientAt = (t) => {
    const tc = clamp(t, 0, D);
    let h = tab(HT, tc);
    const p = tab(PT, tc);
    const r = tab(RT, tc) + roll0;
    let rollAdd = 0;
    for (const k of along) {
      if (tc <= k.t0 || tc >= k.t1) continue;
      const u = smootherstep((tc - k.t0) / k.T);
      const sg = k.dir === "left" ? -1 : 1;
      if (k.type === "yaw-spin") h += sg * TAU * k.turns * u;
      else if (k.type === "roll") rollAdd += sg * TAU * k.turns * u;
    }
    let q = quatFromHPR(h, p, r);
    if (rollAdd !== 0) q = qMul(q, qFromAxisAngle([0, 1, 0], rollAdd));
    const sg = segAt(tc);
    if (sg.kind === "trick") {
      const k = sg.trick;
      const tau = tc - sg.t0;
      const w = smootherstep(tau / 0.12) * (1 - smootherstep((tau - (k.T - 0.35)) / 0.35));
      q = qSlerp(q, trickQ(k, tau), w);
    }
    const wb = wobAt(tc);
    q = qNorm(qMul(q, quatFromHPR(wb.dh, wb.dp, wb.dr)));
    return { q, h, r };
  };

  // ---- 5. meta -----------------------------------------------------------------------------
  const lockWindows = [];
  for (const w of windows.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0])) {
    const last = lockWindows[lockWindows.length - 1];
    if (last && w[0] <= last[1] + 0.05) last[1] = Math.max(last[1], w[1]);
    else lockWindows.push([w[0], w[1]]);
  }
  const recs = tricks.slice().sort((a, b) => a.index - b.index).map((t) => t.rec);
  const keyframes = [{ t: 0, label: "start" }];
  for (const t of tricks) if (!t.skipped) {
    keyframes.push({ t: t.t0, label: `${t.type}@${t.s}` });
  }
  keyframes.push({ t: D, label: "end" });
  const throttleAt = (t) => tab(TH, t);
  const meta = {
    flightPreset: "fpv",
    lengthM: L,
    peakSpeed,
    overspeed: saturated && routeK > 1 + 1e-6,
    cruiseSpeed: vc * routeK,
    routeTimeScale: routeK,
    startHoldSec: rest ? P.startHoldSec / routeK : 0,
    endHoldSec: H1 / routeK,
    profilePeakSpeed: prof ? prof.peak * routeK : 0,
    zones: (P.zones || []).map((z) => ({ s0: z.s0, s1: z.s1, speed: z.speed, applied: z.s0 < L })),
    tricks: recs,
    lockWindows,
    validate: { ...C.validate },
    throttleAt,
  };
  return { positionAt, orientAt, keyframes, meta };
}

/**
 * Split-S feasibility: after the half roll (lead = u·rollSec) the half loop down ends 2R-ish
 * lower, heading back; the line must pass there heading back too (|Δpos| ≤ max(0.75, 0.3·R),
 * tangent within ≈20° of reversed). Searches s ∈ (s + 2, s + 80] (or ±6 m around `near`).
 */
function findSplitS(lv, t, u, near) {
  const shape = loopShape(-Math.PI, t.radius, u * t.rollSec);
  const fwd = lv.tan(t.s);
  const nrm = vunit(vsub([0, 0, 1], vscale(fwd, fwd[2])), [0, 0, 1]);
  const pa = lv.pos(t.s);
  const X = vadd(pa, vadd(vscale(fwd, shape.end.x), vscale(nrm, shape.end.z)));
  const tol = Math.max(0.75, 0.3 * t.radius);
  const a = Number.isFinite(near) ? Math.max(t.s + 1, near - 6) : t.s + 2;
  const b = Number.isFinite(near) ? Math.min(lv.L, near + 6) : Math.min(lv.L, t.s + 80);
  let best = null;
  for (let s = a; s <= b; s += 0.1) {
    const d = vlen(vsub(lv.pos(s), X));
    const dir = vdot(lv.tan(s), fwd);
    if (dir <= -0.94 && (!best || d < best.d)) best = { s, d };
  }
  if (!best || best.d > tol) {
    return {
      ok: false,
      reason: best
        ? `no re-join point: the line passes ${best.d.toFixed(2)} m from where the split-S ends (needs ≤ ${tol.toFixed(2)} m, ${(-shape.end.z).toFixed(1)} m below s heading back)`
        : `no re-join point: the line never comes back heading the other way ${(-shape.end.z).toFixed(1)} m below s within 80 m`,
    };
  }
  return { ok: true, sb: best.s, shape };
}

/** Exported for tests: the C² bump's peak-jerk constant. */
export const FPV_BUMP_JERK = BUMP_JERK;

/** The trick types that leave the line and add their own time (power-loop, split-s). */
export function isInPlaceTrick(type) {
  return IN_PLACE.has(type);
}

/** Runtime check helper: throws a readable error for a run that has no racing line. */
export function requireRunLine(spec, ctx) {
  const path = Array.isArray(ctx.path) && ctx.path.length >= 2 ? ctx.path : null;
  const route = ctx.indoor && Array.isArray(ctx.indoor.route) && ctx.indoor.route.length >= 2 ? ctx.indoor.route : null;
  const line = path || route;
  if (!line) {
    throw new FilmShotError(`${spec.technique}: needs a racing line: ctx.path (shot.path) or ctx.indoor.route with at least 2 points`,
      { code: "MISSING_CONTEXT", details: { technique: spec.technique } });
  }
  return { points: line.map((p) => [p[0], p[1], p[2]]), source: path ? "path" : "route" };
}

