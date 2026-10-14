// scene3d/film/shots/drone.js — `drone.*` and `fpv.*` camera techniques (SPEC §2.12).
//
// WHY: the director (Claude Code) writes aerial shots as plain ids + params —
// `{technique:'drone.pass-over', duration:12, params:{heightAGL:25}}` — and
// expects every common drone and FPV move to exist, to honour its duration, to
// keep its subject in frame, to stay above the terrain, and to move smoothly
// through the two places naive cameras break: straight down (a pass-over or a
// top-down shot must never flip the image) and 90° dungeon corridor turns.
// Each technique here is a pure function (spec, ctx) → Trajectory:
//
//   - geometry is computed ONCE at build time (speed profiles, smoothed terrain
//     floors, look-ahead heading tables, pre-simulated gimbal), so sample(t) is
//     pure in t and cheap (scouting samples random times; takes replay exactly);
//   - path-following moves (flythrough, terrain-skim, canyon-run, all fpv
//     paths) fly a filleted Catmull-Rom path at a curvature-limited speed
//     profile (speedLimitedProfile) fitted to the shot duration, look ahead
//     along the path and bank into turns from the look-ahead heading rate;
//   - looking at a subject uses the stateless look-at with a heading hint for
//     the vertical cone, or — where the camera really passes overhead
//     (drone.pass-over) — the pre-simulated look controller with the 'yaw-slew'
//     nadir policy (the drone "gimbal flip": a smooth image rotation);
//   - FPV flips are quaternion paths (base orientation ⊗ axis-angle), never
//     gimbal angles, so a 360° pitch or roll has no singularity;
//   - outdoors every position is lifted over a smoothed terrain envelope
//     (window max ahead of the camera, soft max, so it rises early and
//     smoothly) and finally kept ≥ 0.7 m above ctx.groundZ (clampToEnvelope);
//     indoors ctx.indoor.floor/ceiling bound it instead.
//
// Heights called `heightAGL` are metres above the shot's reference ground: the
// subject's base when there is a subject, else the terrain under the anchor
// (else the anchor's z). `bearingDeg` is the compass bearing FROM the subject
// TO the camera, `headingDeg` a compass direction of travel; with
// `relativeToSubject` (default true) both are measured from the subject's
// facing heading when the subject has one (0 = in front / along its facing).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks, no Math.random.

import { FilmShotError } from "../core/errors.js";
import { ease as easeOf, linear, sineInOut, smoothstep } from "../core/easing.js";
import { lookRotation, quatFromHPR, unwrapAngle } from "../core/gimbal.js";
import { qFromAxisAngle, qMul } from "../core/quat.js";
import { filletPolyline, makePath, speedLimitedProfile } from "../core/spline.js";
import { isFiniteV } from "../core/vec3.js";
import { AC_DAY_LENGTH_S } from "../../sky_game_date.js";
import { DRONE_PRESETS } from "../drone/flight_model.js";
import { aimPointForFraming, distanceForFraming } from "./framing.js";
import { defineTechnique } from "./registry.js";
import { aimSubject, clampToEnvelope, makeTrajectory, orientLookAt, smoothLookAt, subjectAtTime } from "./trajectory.js";

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;
const TAU = 2 * Math.PI;
const GRAVITY = 9.80665;

// ---------------------------------------------------------------------------
// pilot bounds (how far the JEV pilot may push each kind of move)
// ---------------------------------------------------------------------------

const B_AERIAL = Object.freeze({ maxLateral: 3, maxRise: 4, maxSink: 1.5, minSpeedScale: 0.4, maxSpeedScale: 1.25, maxDistanceScale: 1.3 });
const B_ORBIT = Object.freeze({ maxLateral: 3, maxRise: 4, maxSink: 1.5, minSpeedScale: 0.4, maxSpeedScale: 1.2, maxDistanceScale: 1.35 });
const B_HOVER = Object.freeze({ maxLateral: 3, maxRise: 4, maxSink: 2, minSpeedScale: 0.5, maxSpeedScale: 1.2, maxDistanceScale: 1.2 });
const B_TOP = Object.freeze({ maxLateral: 3, maxRise: 6, maxSink: 2, minSpeedScale: 0.4, maxSpeedScale: 1.25, maxDistanceScale: 1.25 });
const B_REVEAL = Object.freeze({ maxLateral: 2, maxRise: 3, maxSink: 1, minSpeedScale: 0.5, maxSpeedScale: 1.2, maxDistanceScale: 1.2 });
const B_LOW = Object.freeze({ maxLateral: 2, maxRise: 2.5, maxSink: 0.5, minSpeedScale: 0.3, maxSpeedScale: 1.2, maxDistanceScale: 1.2 });
const B_FOLLOW = Object.freeze({ maxLateral: 2.5, maxRise: 3, maxSink: 1, minSpeedScale: 0.5, maxSpeedScale: 1.5, maxDistanceScale: 1.4 });
const B_CLOSE = Object.freeze({ maxLateral: 1.5, maxRise: 2, maxSink: 0.75, minSpeedScale: 0.5, maxSpeedScale: 1.2, maxDistanceScale: 1.25 });
const B_FPV = Object.freeze({ maxLateral: 1.5, maxRise: 1.5, maxSink: 0.75, minSpeedScale: 0.4, maxSpeedScale: 1.15, maxDistanceScale: 1.1 });
const B_GAP = Object.freeze({ maxLateral: 0.3, maxRise: 0.3, maxSink: 0.3, minSpeedScale: 0.4, maxSpeedScale: 1.1, maxDistanceScale: 1 });
const B_CORRIDOR = Object.freeze({ maxLateral: 0.5, maxRise: 0.4, maxSink: 0.3, minSpeedScale: 0.3, maxSpeedScale: 1.1, maxDistanceScale: 1 });

// ---------------------------------------------------------------------------
// shared parameter schemas
// ---------------------------------------------------------------------------

const P_REL = Object.freeze({
  type: "boolean", default: true,
  desc: "Measure headingDeg / bearingDeg from the subject's facing heading when the subject has one (0 = in front of / along its facing); false = compass degrees (0 = north, 90 = east).",
});
const pHeading = (d, what) => ({ type: "number", default: d, min: -360, max: 360, unit: "deg", desc: what });
const pBearing = (d) => pHeading(d, "Compass bearing FROM the subject (or anchor) TO the camera at the start, degrees (see relativeToSubject).");
const pTravel = (d) => pHeading(d, "Direction of travel, compass degrees (see relativeToSubject).");
const pMinClear = (d) => ({
  type: "number", default: d, min: 0.7, max: 50, unit: "m",
  desc: "Height kept above the smoothed terrain under the camera: the move rises early and smoothly over high ground instead of dipping into it (outdoors only).",
});
const pDir = Object.freeze({ type: "enum", values: ["cw", "ccw"], default: "cw", desc: "Orbit direction seen from above: cw (clockwise) or ccw." });
const pEnds = Object.freeze({
  type: "enum", values: ["cruise", "rest"], default: "cruise",
  desc: "cruise = the take starts and ends already moving (cut in on motion); rest = it starts and ends hovering.",
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** FilmShotError for a technique whose context cannot support it. */
function contextError(spec, msg) {
  return new FilmShotError(`${spec.technique}: ${msg}`, { code: "MISSING_CONTEXT", details: { technique: spec.technique } });
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Eased shot progress u(t) ∈ [0, 1] (spec.ease; t clamped). */
function progressFn(spec) {
  const E = easeOf(spec.ease, sineInOut);
  const D = spec.duration;
  return (t) => (D > 0 ? E(clamp(Number.isFinite(t) ? t / D : 0, 0, 1)) : 0);
}

/** Time at which a monotone progress function reaches `target` (bisection on [0, D]). */
function timeAtProgress(fn, target, D) {
  let lo = 0, hi = D;
  if (!(D > 0)) return 0;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (fn(m) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** Heading (radians) of a degrees param, relative to the subject's facing when requested and available. */
function relHeading(P, ctx, deg) {
  const s = ctx.subject;
  const base = P.relativeToSubject !== false && s && Number.isFinite(s.heading) ? s.heading : 0;
  return base + deg * DEG;
}

/** Horizontal unit vector of a compass heading. */
const dirOf = (h) => [Math.sin(h), Math.cos(h), 0];
/** Horizontal unit vector to the right of a compass heading. */
const rightOf = (h) => [Math.cos(h), -Math.sin(h), 0];

/** Base position of the subject at time t, else the anchor. */
function centreAt(ctx, t) {
  const s = subjectAtTime(ctx, t);
  return s && isFiniteV(s.pos) ? [s.pos[0], s.pos[1], s.pos[2]] : [ctx.anchor[0], ctx.anchor[1], ctx.anchor[2]];
}

/** Finite terrain height at (x, y) or null. */
function groundAt(ctx, x, y) {
  if (typeof ctx.groundZ !== "function") return null;
  let z;
  try {
    z = ctx.groundZ(x, y);
  } catch {
    return null;
  }
  return typeof z === "number" && Number.isFinite(z) ? z : null;
}

/** Reference ground height of the shot at time t: the subject base, else the terrain under the anchor, else anchor z. */
function refZ(ctx, t) {
  const s = subjectAtTime(ctx, t);
  if (s && isFiniteV(s.pos)) return s.pos[2];
  const g = groundAt(ctx, ctx.anchor[0], ctx.anchor[1]);
  return g !== null ? g : ctx.anchor[2];
}

/**
 * Smooth maximum: C¹, ≥ max(a, b), within k/4 of it, and EXACTLY max(a, b) once the two
 * differ by more than k (a nominal height well above the floor is never touched).
 */
function softMax(a, b, k = 1) {
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.max(a, b) + (h * h) / (4 * k);
}

/** Uniform Catmull-Rom interpolation of a sampled series at fractional index x (clamped). */
function interp1(arr, x) {
  const n = arr.length;
  if (n === 1) return arr[0];
  const xc = clamp(Number.isFinite(x) ? x : 0, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(xc));
  const f = xc - i;
  const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(n - 1, i + 2)];
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
}

/** Linear interpolation of a sampled series at fractional index x (clamped). */
function lerp1(arr, x) {
  const n = arr.length;
  if (n === 1) return arr[0];
  const xc = clamp(Number.isFinite(x) ? x : 0, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(xc));
  const f = xc - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
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

/** Symmetric box filter whose window shrinks at the ends (linear motion is reproduced exactly). */
function symSmooth(arr, k) {
  const n = arr.length;
  if (!(k >= 1) || n < 3) return Float64Array.from(arr);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = Math.min(k, i, n - 1 - i);
    out[i] = (pre[i + w + 1] - pre[i - w]) / (2 * w + 1);
  }
  return out;
}

/**
 * Smoothed terrain floor along a 1-D parameter u ∈ [u0, u1] (seconds or metres): the
 * ground under `xyAt(u)` is sampled every `step`, max-filtered over [u − behind, u + ahead]
 * (so the camera rises BEFORE a hill), then box-smoothed with a width that never lowers a
 * sampled peak. Returns `(u) → z` (C¹ Catmull-Rom) or null indoors / without ground data.
 */
function makeFloor(ctx, xyAt, u0, u1, o) {
  if (ctx.indoor) return null;
  const span = Math.max(0, u1 - u0);
  const n = Math.max(2, Math.min(o.maxSamples || 6000, Math.ceil(span / o.step) + 1));
  const du = span / (n - 1);
  const g = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const p = xyAt(u0 + i * du);
    const z = groundAt(ctx, p[0], p[1]);
    g[i] = z === null ? NaN : z;
    if (z !== null) any = true;
  }
  if (!any) return null;
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(g[i])) g[i] = last;
    else last = g[i];
  }
  last = NaN;
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isNaN(g[i])) g[i] = last;
    else last = g[i];
  }
  const na = du > 0 ? Math.ceil(o.ahead / du) : 0;
  const nb = du > 0 ? Math.ceil(o.behind / du) : 0;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let mx = -Infinity;
    const hi = Math.min(n - 1, i + na);
    for (let j = Math.max(0, i - nb); j <= hi; j++) if (g[j] > mx) mx = g[j];
    m[i] = mx;
  }
  const ns = Math.floor(Math.min(na, nb) / 2);
  const sm = boxSmooth(boxSmooth(m, ns), ns);
  return (u) => interp1(sm, du > 0 ? (u - u0) / du : 0);
}

/** Terrain floor over shot time (sampled at 30 Hz, 1.2 s look-ahead). */
function timeFloor(ctx, xyAt, D, o = {}) {
  return makeFloor(ctx, xyAt, 0, D, { step: 1 / 30, ahead: o.ahead ?? 1.2, behind: o.behind ?? 0.6, maxSamples: 18000 });
}

/** Lift a nominal height over a floor (soft max) — unchanged without a floor. */
function lift(z, floor, u, clear) {
  return floor ? softMax(z, floor(u) + clear) : z;
}

/** Camera distance that frames the subject at the shot framing, clamped to [min, max]. */
function framingDistance(spec, ctx, min, max) {
  const H = ctx.subject && ctx.subject.height > 0 ? ctx.subject.height : 1.8;
  let d;
  try {
    d = distanceForFraming(spec.framing, H, spec.fov);
  } catch {
    d = min;
  }
  return clamp(d, min, max);
}

/** Stateless look-at the shot's subject (framing aim point; anchor without one) with a heading hint. */
function lookAtSubject(spec, ctx, hint) {
  return orientLookAt(aimSubject(ctx, spec.framing), { headingHint: hint, roll: spec.roll });
}

/** Normalised copy of a vec3 (null for zero / non-finite). */
function unit(v) {
  if (!isFiniteV(v)) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/** Rotate a vector's horizontal part by +δ compass radians (clockwise seen from above). */
function rotCompass(v, d) {
  const c = Math.cos(d), s = Math.sin(d);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}

/** Assemble the technique's Trajectory (family, fov, meta.flightPreset). */
function finish(spec, ctx, family, o) {
  const preset = family === "fpv" ? "fpv" : ctx.indoor ? "indoor" : "cinema";
  return makeTrajectory({
    id: spec.id || spec.technique,
    technique: spec.technique,
    family,
    duration: spec.duration,
    positionAt: o.positionAt,
    orientAt: o.orientAt,
    fovAt: o.fovAt === undefined ? spec.fov : o.fovAt,
    focusAt: o.focusAt,
    keyframes: o.keyframes,
    meta: { flightPreset: preset, ...(o.meta || {}) },
  });
}

// ---------------------------------------------------------------------------
// path following
// ---------------------------------------------------------------------------

/** Largest factor the fitted profile may scale the nominal vmax / amax by before falling back to a uniform time scale. */
const MAX_PROFILE_SCALE = 2;
/**
 * Speed / acceleration caps of the flight preset that will fly a family's path moves: the
 * preset's vmax and 87.5 % of its amax (headroom for the flight model's feedback), so the flown
 * take can follow the nominal one.
 */
const FLIGHT_CAPS = Object.freeze(Object.fromEntries(["cinema", "indoor", "fpv"].map((k) => [
  k, Object.freeze({ vmax: DRONE_PRESETS[k].vmax, amax: 0.875 * DRONE_PRESETS[k].amax }),
])));
/** Width (s) of the triangle kernel that jerk-smooths fitted speed profiles (no instantaneous acceleration reversals). */
const PROFILE_SMOOTH_SEC = 0.35;

/**
 * Jerk-smooth a speed profile: v(τ) sampled at 240 Hz (≤ 200k samples) is filtered with a
 * triangle kernel of PROFILE_SMOOTH_SEC (two box passes, end speeds held), re-integrated with
 * the trapezoid rule and rescaled so the distance at D is exactly L. sAt is C¹ (piecewise
 * quadratic), vAt continuous, both monotone-safe (v ≥ 0).
 */
function smoothProfile(vAt, D, L) {
  const n = Math.max(64, Math.min(200000, Math.ceil(D * 240)));
  const dt = D / n;
  let V = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) V[i] = Math.max(0, vAt(i * dt));
  const k = Math.max(0, Math.round(PROFILE_SMOOTH_SEC / 4 / dt));
  if (k >= 1) V = boxSmooth(boxSmooth(V, k), k);
  const S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) S[i + 1] = S[i] + 0.5 * (V[i] + V[i + 1]) * dt;
  const sc = S[n] > 0 ? L / S[n] : 0;
  for (let i = 0; i <= n; i++) {
    V[i] *= sc;
    S[i] *= sc;
  }
  const locate = (tau) => {
    const x = clamp(Number.isFinite(tau) ? tau : 0, 0, D) / dt;
    const i = Math.min(n - 1, Math.floor(x));
    return { i, f: (x - i) * dt };
  };
  return {
    sAt: (tau) => {
      const { i, f } = locate(tau);
      return clamp(S[i] + V[i] * f + (0.5 * (V[i + 1] - V[i]) * f * f) / dt, 0, L);
    },
    vAt: (tau) => {
      const { i, f } = locate(tau);
      return V[i] + ((V[i + 1] - V[i]) * f) / dt;
    },
  };
}

/**
 * Speed profile along `path` that lasts exactly D seconds: speedLimitedProfile with vmax and
 * amax scaled by one factor λ ≤ MAX_PROFILE_SCALE — and within the flight caps `o.caps`
 * {vmax, amax} of the preset that will fly it — (bisection) so its duration matches D while
 * the lateral acceleration cap alat (slowing into curves) and an optional slow zone stay
 * fixed; any residual mismatch (a path too long or too curvy for D) is absorbed by a uniform
 * time scale that keeps the profile's shape (`overspeed` true when that had to speed the move
 * up beyond the caps — turns then exceed alat). The result is jerk-smoothed (smoothProfile), so
 * the lateral cap is approximate within the 0.35 s smoothing window.
 */
function fitProfile(path, D, o) {
  const L = path.length;
  if (!(L > 1e-6) || !(D > 0)) {
    return { sAt: () => 0, vAt: () => 0, peakSpeed: 0, overspeed: false, lambda: 0 };
  }
  const memo = new Map();
  const kReal = (s) => {
    let k = memo.get(s);
    if (k === undefined) {
      k = path.curvatureAt(s);
      memo.set(s, k);
    }
    return k;
  };
  const make = (lam) => {
    const vm = o.vmax * lam, am = o.amax * lam;
    const slow = o.slow;
    const curvatureAt = slow
      ? (s) => {
        const k = kReal(s);
        const d = Math.abs(s - slow.s) / slow.width;
        if (d >= 1) return k;
        const vg = vm * (slow.fraction + (1 - slow.fraction) * d * d);
        return Math.max(k, o.alat / (vg * vg));
      }
      : kReal;
    const end = o.ends === "rest" ? 0 : vm;
    return speedLimitedProfile({ length: L, curvatureAt }, { vmax: vm, amax: am, alat: o.alat, startSpeed: end, endSpeed: end });
  };
  const caps = o.caps || null;
  const lamMax = Math.max(1e-3, Math.min(MAX_PROFILE_SCALE, caps ? caps.vmax / o.vmax : Infinity, caps ? caps.amax / o.amax : Infinity));
  let lo = Math.log(1e-4), hi = Math.log(lamMax);
  let prof = make(Math.exp(hi));
  if (prof.duration <= D) {
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      const p = make(Math.exp(mid));
      if (p.duration > D) lo = mid;
      else {
        hi = mid;
        prof = p;
      }
      if (Math.abs(p.duration - D) <= 1e-9 * D) {
        prof = p;
        break;
      }
    }
  }
  const scale = prof.duration / D;
  const sm = smoothProfile((tau) => prof.vAt(tau * scale) * scale, D, L);
  return {
    sAt: sm.sAt,
    vAt: sm.vAt,
    peakSpeed: prof.peakSpeed * scale,
    overspeed: scale > 1 + 1e-6,
    lambda: Math.exp(hi),
  };
}

/**
 * A camera that flies a path: positions from a (filleted, curvature-smoothed) path driven by a speed
 * profile fitted to the shot, heading/pitch looking `lookAhead` metres ahead along the flown
 * path (pre-tabulated, unwrapped — continuous through 90° turns and vertical dives), bank from
 * the look-ahead heading rate (roll > 0 = bank right into a right turn), saturating smoothly
 * (maxBank·tanh) so a hard turn never kinks the roll.
 * Options: fillet, vmax, amax, alat, ends, slow {s, width, fraction}, zMode ('path' | 'terrain' |
 * 'path-min'), zOffset, heightAGL, minClear, lateral (m, + = right of travel), lookAhead, tiltDeg,
 * uptiltDeg (FPV: steep dives show the camera uptilt), bankGain, maxBankDeg, leanDeg, headingHint.
 */
function makeFollower(spec, ctx, points, o) {
  const D = spec.duration;
  if (!o.caps) {
    const fam = String(spec.technique).startsWith("fpv.") ? "fpv" : ctx.indoor ? "indoor" : "cinema";
    o = { ...o, caps: FLIGHT_CAPS[fam] };
  }
  const pts = o.fillet > 0 ? filletPolyline(points, o.fillet, { arcSegments: 12 }) : points;
  const path = o.fillet > 0 ? smoothPath(makePath(pts, { samples: 2048 }), 0.6 * o.fillet) : makePath(pts, { samples: 2048 });
  const L = path.length;
  const prof = fitProfile(path, D, o);
  const E = easeOf(spec.ease, linear);
  const tau = (t) => (D > 0 ? D * E(clamp(t / D, 0, 1)) : 0);
  const sOf = (t) => prof.sAt(tau(t));
  const speedOf = (t) => {
    const d = Math.min(1e-3, D / 4);
    if (!(d > 0)) return 0;
    const a = Math.max(0, t - d), b = Math.min(D, t + d);
    return b > a ? (sOf(b) - sOf(a)) / (b - a) : 0;
  };
  const hint0 = Number.isFinite(o.headingHint) ? o.headingHint : 0;

  const horizTangent = (s) => {
    const tg = path.tangentAt(clamp(s, 0, L));
    const l = Math.hypot(tg[0], tg[1]);
    return l > 1e-9 ? [tg[0] / l, tg[1] / l] : null;
  };
  const baseAt = (s) => {
    if (L > 0 && s > L) {
      const p = path.at(L), tg = path.tangentAt(L), e = s - L;
      return [p[0] + tg[0] * e, p[1] + tg[1] * e, p[2] + tg[2] * e];
    }
    if (L > 0 && s < 0) {
      const p = path.at(0), tg = path.tangentAt(0);
      return [p[0] + tg[0] * s, p[1] + tg[1] * s, p[2] + tg[2] * s];
    }
    return path.at(s);
  };
  const tan0 = [Math.sin(hint0), Math.cos(hint0)];
  const xyAt = (s) => {
    const b = baseAt(s);
    if (!o.lateral) return b;
    const t = horizTangent(s) || tan0;
    return [b[0] + t[1] * o.lateral, b[1] - t[0] * o.lateral, b[2]];
  };
  const floor = o.zMode === "path" ? null : makeFloor(ctx, xyAt, 0, Math.max(L, 1e-6), {
    step: 0.5, ahead: Math.max(2, o.lookAhead || 4), behind: 2, maxSamples: 8000,
  });
  const posS = (s) => {
    const b = xyAt(s);
    let z;
    if (o.zMode === "terrain") z = floor ? floor(clamp(s, 0, L)) + o.heightAGL : b[2] + o.heightAGL;
    else if (o.zMode === "path-min") z = lift(b[2] + (o.zOffset || 0), floor, clamp(s, 0, L), o.minClear);
    else z = b[2] + (o.zOffset || 0);
    return clampToEnvelope([b[0], b[1], z], ctx);
  };

  // look-ahead heading / pitch tables over s, heading rate for the bank
  const LA = Math.max(0.25, o.lookAhead || 4);
  const n = L > 1e-6 ? Math.max(32, Math.min(4096, Math.ceil(L / 0.25) + 1)) : 1;
  const ds = n > 1 ? L / (n - 1) : 0;
  const H = new Float64Array(n), Pt = new Float64Array(n);
  let prevH = hint0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    const p = posS(s), q = posS(s + LA);
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    const hz = Math.hypot(dx, dy);
    const tot = Math.hypot(hz, dz);
    const hh = hz > 1e-6 * Math.max(1, tot) ? unwrapAngle(Math.atan2(dx, dy), prevH) : prevH;
    H[i] = hh;
    Pt[i] = tot > 1e-12 ? Math.atan2(dz, hz) : (i > 0 ? Pt[i - 1] : 0);
    prevH = hh;
  }
  let K = new Float64Array(n);
  if (n > 2 && ds > 0) {
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      K[i] = (H[b] - H[a]) / ((b - a) * ds);
    }
    const kw = Math.max(1, Math.round((0.5 * LA) / ds));
    K = boxSmooth(boxSmooth(K, kw), kw);
  }
  const atS = (arr, s) => lerp1(arr, ds > 0 ? s / ds : 0);
  const tilt = (o.tiltDeg || 0) * DEG;
  const up = (o.uptiltDeg || 0) * DEG;
  const maxBank = (o.maxBankDeg ?? 30) * DEG;
  const gain = o.bankGain ?? 1;
  const lean = (o.leanDeg || 0) * DEG;
  const bankAt = (t, s) => {
    if (gain === 0) return 0;
    const v = speedOf(t);
    const b = Math.atan((v * v * atS(K, s)) / GRAVITY) * gain;
    return maxBank > 0 ? maxBank * Math.tanh(b / maxBank) : 0;
  };
  const orientAt = (t) => {
    const s = sOf(t);
    const pl = atS(Pt, s);
    let p = pl + tilt;
    if (up !== 0 && pl < 0) {
      const sp = Math.sin(pl);
      p += up * sp * sp;
    }
    return { h: atS(H, s), p: clamp(p, -HALF_PI, HALF_PI), r: bankAt(t, s) + lean + (spec.roll || 0) };
  };
  return {
    path,
    length: L,
    profile: prof,
    sOf,
    speedOf,
    posS,
    positionAt: (t) => posS(sOf(t)),
    orientAt,
    timeAtS: (s) => timeAtProgress(sOf, s, D),
  };
}

/**
 * Give a filleted path continuous curvature: resample it every ≈0.25 m (≤ 4000 points) and
 * box-smooth the points twice over ≈w metres with a symmetric window that shrinks at the ends —
 * straight legs and end points are reproduced exactly, while each arc's curvature step (arc ↔
 * leg) becomes a ramp (clothoid-like), so the nominal centripetal acceleration never jumps.
 * Arcs move inward by only ≈ w²/(24·r).
 */
function smoothPath(path, w) {
  const L = path.length;
  if (!(L > 1e-6) || !(w > 0)) return path;
  const n = Math.max(8, Math.min(4000, Math.ceil(L / 0.25)));
  const ds = L / n;
  const k = Math.round(w / (2 * ds));
  if (k < 1) return path;
  const X = new Float64Array(n + 1), Y = new Float64Array(n + 1), Z = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const p = path.at(i === n ? L : i * ds);
    X[i] = p[0]; Y[i] = p[1]; Z[i] = p[2];
  }
  const Xs = symSmooth(symSmooth(X, k), k), Ys = symSmooth(symSmooth(Y, k), k), Zs = symSmooth(symSmooth(Z, k), k);
  const pts = new Array(n + 1);
  for (let i = 0; i <= n; i++) pts[i] = [Xs[i], Ys[i], Zs[i]];
  return makePath(pts, { tangents: null, samples: Math.max(2048, 2 * n) });
}

/** Explicit gap from flat params (gapNormal ≠ 0) or ctx.gap, else null. */
function resolveGap(P, ctx) {
  const n = unit(P.gapNormal);
  if (n) {
    const pos = P.gapPos[0] === 0 && P.gapPos[1] === 0 && P.gapPos[2] === 0
      ? [ctx.anchor[0], ctx.anchor[1], refZ(ctx, 0) + P.heightAGL]
      : P.gapPos.slice();
    return { pos, normal: n, width: P.gapWidth, height: P.gapHeight, source: "params" };
  }
  const g = ctx.gap;
  if (g && typeof g === "object" && isFiniteV(g.pos)) {
    const gn = unit(g.normal);
    if (gn) {
      return {
        pos: [g.pos[0], g.pos[1], g.pos[2]],
        normal: gn,
        width: Number.isFinite(g.width) && g.width > 0 ? g.width : P.gapWidth,
        height: Number.isFinite(g.height) && g.height > 0 ? g.height : P.gapHeight,
        source: "ctx",
      };
    }
  }
  return null;
}

/** Station on a path closest to a point (coarse scan + refinement). */
function nearestS(path, p) {
  const L = path.length;
  if (!(L > 0)) return 0;
  const n = Math.max(64, Math.min(4096, Math.ceil(L / 0.5)));
  let best = 0, bd = Infinity;
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n;
    const q = path.at(s);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  let lo = Math.max(0, best - L / n), hi = Math.min(L, best + L / n);
  const f = (s) => { const q = path.at(s); return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; };
  for (let i = 0; i < 40; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (f(a) < f(b)) hi = b;
    else lo = a;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// subject tracking (moving subjects)
// ---------------------------------------------------------------------------

/**
 * Smoothed track of the (possibly moving) subject over [0, D]: positions box-smoothed with a
 * symmetric window of `smoothSec` (constant-velocity motion is reproduced exactly), travel
 * heading from the smoothed velocity (held while slower than 0.25 m/s; `fallbackH` before
 * the subject ever moves) low-passed forward and backward (zero phase).
 */
function subjectTrack(ctx, D, smoothSec, fallbackH) {
  const rate = 30;
  const n = Math.max(2, Math.min(18001, Math.ceil(D * rate) + 1));
  const dt = D > 0 ? D / (n - 1) : 0;
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = centreAt(ctx, i * dt);
    X[i] = c[0]; Y[i] = c[1]; Z[i] = c[2];
  }
  const k = dt > 0 ? Math.round(smoothSec / (2 * dt)) : 0;
  const Xs = symSmooth(symSmooth(X, k), k), Ys = symSmooth(symSmooth(Y, k), k), Zs = symSmooth(symSmooth(Z, k), k);
  const Hd = new Float64Array(n);
  let moved = false;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const w = (b - a) * dt;
    const vx = w > 0 ? (Xs[b] - Xs[a]) / w : 0, vy = w > 0 ? (Ys[b] - Ys[a]) / w : 0;
    raw[i] = Math.hypot(vx, vy) > 0.25 ? Math.atan2(vx, vy) : null;
    if (raw[i] !== null) moved = true;
  }
  let prev = fallbackH;
  if (moved) {
    const first = raw.findIndex((x) => x !== null);
    prev = raw[first];
  }
  for (let i = 0; i < n; i++) {
    const h = raw[i] === null ? prev : unwrapAngle(raw[i], prev);
    Hd[i] = h;
    prev = h;
  }
  const tauH = Math.max(0.2, smoothSec);
  const al = dt > 0 ? 1 - Math.exp(-dt / tauH) : 1;
  for (let i = 1; i < n; i++) Hd[i] = Hd[i - 1] + (Hd[i] - Hd[i - 1]) * al;
  for (let i = n - 2; i >= 0; i--) Hd[i] = Hd[i + 1] + (Hd[i] - Hd[i + 1]) * al;
  const at = (arr, t) => lerp1(arr, dt > 0 ? t / dt : 0);
  return {
    moving: moved,
    posAt: (t) => [at(Xs, t), at(Ys, t), at(Zs, t)],
    headingAt: (t) => at(Hd, t),
  };
}

// ---------------------------------------------------------------------------
// shared builders
// ---------------------------------------------------------------------------

/**
 * Orbit family (orbit-poi, helix, spiral-descent, hyperlapse-orbit): circle around the subject's
 * start position with radius/height interpolated over the eased progress; the camera looks at
 * the live subject (heading hint = toward the centre, so the vertical cone never flips it).
 */
function orbitBuild(spec, ctx, o) {
  const D = spec.duration;
  const u = progressFn(spec);
  const P = spec.params;
  const C = centreAt(ctx, 0);
  const z0 = refZ(ctx, 0);
  const sgn = P.direction === "ccw" ? -1 : 1;
  const th0 = relHeading(P, ctx, P.bearingDeg);
  const th = (t) => th0 + sgn * TAU * o.revolutions * u(t);
  const rad = (t) => o.r0 + (o.r1 - o.r0) * u(t);
  const hgt = (t) => o.h0 + (o.h1 - o.h0) * u(t);
  const xy = (t) => {
    const a = th(t), r = rad(t);
    return [C[0] + r * Math.sin(a), C[1] + r * Math.cos(a)];
  };
  const floor = timeFloor(ctx, xy, D, { ahead: 1.5, behind: 0.75 });
  const positionAt = (t) => {
    const p = xy(t);
    return clampToEnvelope([p[0], p[1], lift(z0 + hgt(t), floor, t, P.minClearance)], ctx);
  };
  return finish(spec, ctx, "drone", {
    positionAt,
    orientAt: lookAtSubject(spec, ctx, (t) => th(t) + Math.PI),
    meta: {
      centre: C,
      revolutions: o.revolutions,
      direction: P.direction,
      startBearingDeg: th0 / DEG,
      ...(o.meta || {}),
    },
  });
}

/** Moving-subject follow family (chase, lead, side-track). */
function followBuild(spec, ctx, mode) {
  const P = spec.params;
  const D = spec.duration;
  const s0 = ctx.subject;
  const fallback = s0 && Number.isFinite(s0.heading) ? s0.heading : 0;
  const tr = subjectTrack(ctx, D, P.smoothSec, fallback);
  const off = P.offsetAngleDeg * DEG;
  const side = mode === "side" ? (P.side === "left" ? -1 : 1) : 0;
  const placeH = (t) => {
    const psi = tr.headingAt(t) + off;
    if (mode === "chase") return psi + Math.PI;
    if (mode === "lead") return psi;
    return psi + side * HALF_PI;
  };
  const xy = (t) => {
    const S = tr.posAt(t);
    const d = dirOf(placeH(t));
    return [S[0] + d[0] * P.distance, S[1] + d[1] * P.distance];
  };
  const floor = timeFloor(ctx, xy, D, { ahead: 1.0, behind: 0.5 });
  const positionAt = (t) => {
    const p = xy(t);
    const S = tr.posAt(t);
    return clampToEnvelope([p[0], p[1], lift(S[2] + P.heightAGL, floor, t, P.minClearance)], ctx);
  };
  const subj = s0 || { pos: ctx.anchor, height: 1.8, radius: 0.45 };
  const aim = (t) => aimPointForFraming(spec.framing, { ...subj, pos: tr.posAt(t) });
  return finish(spec, ctx, "drone", {
    positionAt,
    orientAt: orientLookAt(aim, { headingHint: (t) => placeH(t) + Math.PI, roll: spec.roll }),
    meta: { mode, moving: tr.moving, distance: P.distance },
  });
}

// ---------------------------------------------------------------------------
// drone.* techniques
// ---------------------------------------------------------------------------

const flyover = defineTechnique({
  id: "drone.flyover",
  name: "Flyover",
  description: "Straight, level pass over the subject or anchor at a fixed height above it, rising smoothly over high terrain. The gimbal either holds a fixed tilt along the direction of travel, or tracks the subject down to straight-down as the drone crosses it and then holds the top-down view.",
  whenToUse: "Opening or transition shots that cross a town, landmark or landscape. Use gimbal 'fixed' for a travelling vista. Use 'track' to keep a landmark in view until you pass over it. For a pass-over that keeps the subject in frame through vertical and beyond, use drone.pass-over.",
  params: {
    heightAGL: { type: "number", default: 30, min: 2, max: 300, unit: "m", desc: "Flight height above the subject's base (or the ground at the anchor)." },
    speed: { type: "number", default: 8, min: 0.5, max: 30, unit: "m/s", desc: "Average ground speed; the pass covers speed × duration metres, centred on the subject." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    gimbal: { type: "enum", values: ["fixed", "track"], default: "fixed", desc: "fixed = constant tilt along the travel direction; track = pitch follows the subject until it is straight below, then holds top-down." },
    tiltDeg: { type: "number", default: -35, min: -90, max: 30, unit: "deg", desc: "Gimbal pitch in 'fixed' mode (negative looks down)." },
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_AERIAL,
  defaultDuration: 10,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "establishing", "travel"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.headingDeg);
    const f = dirOf(h0);
    const C = centreAt(ctx, 0);
    const L = P.speed * D;
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const xy = (t) => {
      const s = (u(t) - 0.5) * L;
      return [C[0] + f[0] * s, C[1] + f[1] * s];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0, floor, t, P.minClearance)], ctx);
    };
    let orientAt;
    if (P.gimbal === "track") {
      const aim = aimSubject(ctx, spec.framing);
      orientAt = (t, pos) => {
        const A = aim(t);
        const along = (A[0] - pos[0]) * f[0] + (A[1] - pos[1]) * f[1];
        return { h: h0, p: Math.atan2(A[2] - pos[2], Math.max(along, 1e-3)), r: spec.roll };
      };
    } else {
      orientAt = { h: h0, p: P.tiltDeg * DEG, r: spec.roll };
    }
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt,
      meta: { lengthM: L, headingDeg: h0 / DEG, gimbal: P.gimbal },
    });
  },
});

const flythrough = defineTechnique({
  id: "drone.flythrough",
  name: "Fly-through",
  description: "Flies through an opening (an arch, a doorway, a gap between trees or towers), slowing as it threads the gap and lined up with the gap's normal. Give the gap as gapPos/gapNormal/gapWidth/gapHeight (or ctx.gap), or a ctx.path that threads it; with neither, the gap is heightAGL above the anchor, crossed along headingDeg.",
  whenToUse: "Transitions from outside to inside (through a town gate, a ruin's arch) and reveals of what lies behind an opening. Use fpv.fpv-gap for the fast, banked FPV version.",
  params: {
    gapPos: { type: "vec3", default: [0, 0, 0], unit: "m", desc: "World centre of the gap (AC metres). [0,0,0] = the anchor raised by heightAGL." },
    gapNormal: { type: "vec3", default: [0, 0, 0], desc: "Direction of travel through the gap (need not be unit). [0,0,0] = no explicit gap (use ctx.gap, ctx.path or the anchor + headingDeg)." },
    gapWidth: { type: "number", default: 3, min: 0.3, max: 100, unit: "m", desc: "Gap width (reported to the runtime in meta.gap for clearance checks)." },
    gapHeight: { type: "number", default: 3, min: 0.3, max: 100, unit: "m", desc: "Gap height (reported in meta.gap)." },
    heightAGL: { type: "number", default: 2, min: 0.5, max: 200, unit: "m", desc: "Gap centre height above the reference ground when the gap comes from the anchor." },
    speed: { type: "number", default: 5, min: 0.5, max: 20, unit: "m/s", desc: "Cruise speed; without a path the move covers speed × duration metres centred on the gap (the fitted profile keeps the duration exact)." },
    gapSpeed: { type: "number", default: 0.5, min: 0.1, max: 1, desc: "Speed at the gap as a fraction of the cruise speed." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    cornerRadius: { type: "number", default: 6, min: 0, max: 100, unit: "m", desc: "Fillet radius applied to the corners of ctx.path." },
    lookAhead: { type: "number", default: 6, min: 0.5, max: 50, unit: "m", desc: "How far ahead along the path the camera looks." },
    tiltDeg: { type: "number", default: 0, min: -45, max: 30, unit: "deg", desc: "Pitch added to the look-ahead direction." },
    ends: pEnds,
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_GAP,
  defaultDuration: 8,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "transition", "gap"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration;
    let gap = resolveGap(P, ctx);
    let points;
    let gapS = null;
    const hasPath = Array.isArray(ctx.path) && ctx.path.length >= 2;
    if (hasPath) {
      points = ctx.path.map((p) => p.slice());
    } else {
      if (!gap) {
        const h0 = relHeading(P, ctx, P.headingDeg);
        gap = { pos: [ctx.anchor[0], ctx.anchor[1], refZ(ctx, 0) + P.heightAGL], normal: dirOf(h0), width: P.gapWidth, height: P.gapHeight, source: "anchor" };
      }
      const half = Math.max(2, (P.speed * D) / 2);
      const G = gap.pos, n = gap.normal;
      points = [[G[0] - n[0] * half, G[1] - n[1] * half, G[2] - n[2] * half], G.slice(), [G[0] + n[0] * half, G[1] + n[1] * half, G[2] + n[2] * half]];
    }
    const probe = P.cornerRadius > 0
      ? smoothPath(makePath(filletPolyline(points, P.cornerRadius, { arcSegments: 12 }), { samples: 2048 }), 0.6 * P.cornerRadius)
      : makePath(points, { samples: 2048 });
    if (gap) gapS = hasPath ? nearestS(probe, gap.pos) : probe.length / 2;
    const slow = gap ? { s: gapS, width: Math.max(3, 0.2 * probe.length), fraction: P.gapSpeed } : null;
    const hintH = gap ? Math.atan2(gap.normal[0], gap.normal[1]) : relHeading(P, ctx, P.headingDeg);
    const F = makeFollower(spec, ctx, points, {
      fillet: P.cornerRadius, vmax: P.speed, amax: 1.75, alat: 3, ends: P.ends, slow, zMode: "path",
      lookAhead: P.lookAhead, tiltDeg: P.tiltDeg, bankGain: 0, headingHint: hintH,
    });
    const meta = { lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed };
    if (gap) {
      meta.gap = { pos: gap.pos, normal: gap.normal, width: gap.width, height: gap.height, source: gap.source };
      meta.gapT = F.timeAtS(gapS);
    }
    return finish(spec, ctx, "drone", {
      positionAt: F.positionAt,
      orientAt: F.orientAt,
      keyframes: gap ? [{ t: 0, label: "start" }, { t: meta.gapT, label: "gap" }, { t: D, label: "end" }] : undefined,
      meta,
    });
  },
});

const orbitPoi = defineTechnique({
  id: "drone.orbit-poi",
  name: "Orbit (point of interest)",
  description: "Circles the subject (or anchor) at a constant radius and height, always looking at it. The orbit is centred on the subject's start position and rises smoothly where the terrain under the orbit is high.",
  whenToUse: "Hero shots of a landmark, lifestone, statue or a standing character. A quarter turn over 8–10 s reads as calm; a full turn is a showcase. Use drone.helix to climb while orbiting, or drone.hyperlapse-orbit for time-lapse sky.",
  params: {
    radius: { type: "number", default: 30, min: 2, max: 500, unit: "m", desc: "Horizontal orbit radius." },
    heightAGL: { type: "number", default: 15, min: 1, max: 300, unit: "m", desc: "Orbit height above the subject's base." },
    revolutions: { type: "number", default: 0.25, min: 0.01, max: 10, desc: "Turns completed over the shot (0.25 = a quarter orbit)." },
    direction: pDir,
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_ORBIT,
  defaultDuration: 10,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "orbit", "hero"],
  build(spec, ctx) {
    const P = spec.params;
    return orbitBuild(spec, ctx, { r0: P.radius, r1: P.radius, h0: P.heightAGL, h1: P.heightAGL, revolutions: P.revolutions });
  },
});

const helix = defineTechnique({
  id: "drone.helix",
  name: "Helix",
  description: "Orbits the subject while climbing, and optionally widening, along a corkscrew. Radius and height move from their start to their end values over the shot while the camera keeps looking at the subject.",
  whenToUse: "Rising hero shots: a tower, a statue, a character on a hilltop. Climbing while widening gives an ending that reveals the surroundings. For the descending version use drone.spiral-descent.",
  params: {
    radiusStart: { type: "number", default: 15, min: 2, max: 500, unit: "m", desc: "Orbit radius at the start." },
    radiusEnd: { type: "number", default: 30, min: 2, max: 500, unit: "m", desc: "Orbit radius at the end." },
    heightStart: { type: "number", default: 4, min: 0.5, max: 300, unit: "m", desc: "Height above the subject's base at the start." },
    heightEnd: { type: "number", default: 40, min: 0.5, max: 300, unit: "m", desc: "Height above the subject's base at the end." },
    revolutions: { type: "number", default: 0.5, min: 0.05, max: 10, desc: "Turns completed over the shot." },
    direction: pDir,
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_ORBIT,
  defaultDuration: 14,
  defaultFraming: "WS",
  defaultEase: "sineInOut",
  tags: ["aerial", "orbit", "rise"],
  build(spec, ctx) {
    const P = spec.params;
    return orbitBuild(spec, ctx, { r0: P.radiusStart, r1: P.radiusEnd, h0: P.heightStart, h1: P.heightEnd, revolutions: P.revolutions });
  },
});

const dronie = defineTechnique({
  id: "drone.dronie",
  name: "Dronie",
  description: "Starts close on the subject and flies back and up in one straight line, keeping the subject centred, so the subject shrinks while the world opens up around it. When startDistance is 0 the start distance comes from the shot's framing.",
  whenToUse: "Endings and big reveals of where a character is: a player on a cliff, in a town square or by a portal. Works best when there is open sky behind the camera's line.",
  params: {
    startDistance: { type: "number", default: 0, min: 0, max: 100, unit: "m", desc: "Horizontal start distance from the subject; 0 = the distance that frames it at the shot framing (≥ 2.5 m)." },
    endDistance: { type: "number", default: 60, min: 2, max: 1000, unit: "m", desc: "Horizontal distance at the end." },
    startHeight: { type: "number", default: 1.5, min: 0.3, max: 100, unit: "m", desc: "Camera height above the subject's base at the start." },
    endHeight: { type: "number", default: 35, min: 0.5, max: 500, unit: "m", desc: "Camera height above the subject's base at the end." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1),
  },
  needs: { subject: true, path: false, indoor: false },
  defaultBounds: B_AERIAL,
  defaultDuration: 10,
  defaultFraming: "FS",
  defaultEase: "sineInOut",
  tags: ["aerial", "reveal", "character"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const b = dirOf(hB);
    const C = centreAt(ctx, 0);
    const z0 = refZ(ctx, 0);
    const d0 = P.startDistance > 0 ? P.startDistance : framingDistance(spec, ctx, 2.5, 30);
    const xy = (t) => {
      const d = d0 + (P.endDistance - d0) * u(t);
      return [C[0] + b[0] * d, C[1] + b[1] * d];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      const z = z0 + P.startHeight + (P.endHeight - P.startHeight) * u(t);
      return clampToEnvelope([p[0], p[1], lift(z, floor, t, P.minClearance)], ctx);
    };
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: lookAtSubject(spec, ctx, hB + Math.PI),
      meta: { startDistance: d0, endDistance: P.endDistance, bearingDeg: hB / DEG },
    });
  },
});

const boomRise = defineTechnique({
  id: "drone.boom-rise",
  name: "Boom rise",
  description: "Rises straight up at a fixed spot. With keepAim the camera keeps looking at the subject and tilts down as it climbs; without it the gimbal holds a fixed tilt toward the subject's direction, so the horizon drops through the frame.",
  whenToUse: "Pedestal-style reveals: rising from behind a wall or hedge or up a tower face, or lifting off from a character to show the town. Use drone.rising-reveal when there is a foreground obstacle to clear.",
  params: {
    distance: { type: "number", default: 10, min: 0.5, max: 300, unit: "m", desc: "Horizontal distance from the subject." },
    heightStart: { type: "number", default: 1.5, min: 0.3, max: 300, unit: "m", desc: "Start height above the subject's base." },
    heightEnd: { type: "number", default: 25, min: 0.5, max: 500, unit: "m", desc: "End height above the subject's base." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    keepAim: { type: "boolean", default: true, desc: "true = keep looking at the subject; false = hold tiltDeg (level boom)." },
    tiltDeg: { type: "number", default: 0, min: -90, max: 30, unit: "deg", desc: "Gimbal pitch when keepAim is false." },
    minClearance: pMinClear(0.7),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_REVEAL,
  defaultDuration: 8,
  defaultFraming: "WS",
  defaultEase: "sineInOut",
  tags: ["aerial", "rise", "pedestal"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const b = dirOf(hB);
    const C = centreAt(ctx, 0);
    const z0 = refZ(ctx, 0);
    const x = C[0] + b[0] * P.distance, y = C[1] + b[1] * P.distance;
    const floor = timeFloor(ctx, () => [x, y], D);
    const positionAt = (t) => {
      const z = z0 + P.heightStart + (P.heightEnd - P.heightStart) * u(t);
      return clampToEnvelope([x, y, lift(z, floor, t, P.minClearance)], ctx);
    };
    const orientAt = P.keepAim ? lookAtSubject(spec, ctx, hB + Math.PI) : { h: hB + Math.PI, p: P.tiltDeg * DEG, r: spec.roll };
    return finish(spec, ctx, "drone", { positionAt, orientAt, meta: { keepAim: P.keepAim } });
  },
});

const risingReveal = defineTechnique({
  id: "drone.rising-reveal",
  name: "Rising reveal",
  description: "Starts low behind a foreground obstacle (a wall, roofline, hedge or ridge) looking at its face, then rises over it while pitching from the obstacle toward the horizon to reveal the vista and the subject beyond. The obstacle sits obstacleDistance ahead of the camera on its line to the subject.",
  whenToUse: "The classic opener: rise over the rooftops toward a lifestone, or over a ridge to a valley town. Place the anchor or subject at what should be revealed and set the obstacle's height.",
  params: {
    distance: { type: "number", default: 40, min: 2, max: 1000, unit: "m", desc: "Horizontal distance from the camera's start to the subject/anchor being revealed." },
    obstacleDistance: { type: "number", default: 6, min: 0.5, max: 100, unit: "m", desc: "How far ahead of the camera the obstacle stands." },
    obstacleHeight: { type: "number", default: 8, min: 0.5, max: 200, unit: "m", desc: "Obstacle top above the ground at the camera's start." },
    heightStart: { type: "number", default: 1.5, min: 0.3, max: 100, unit: "m", desc: "Start height above the ground." },
    clearance: { type: "number", default: 5, min: 0.5, max: 100, unit: "m", desc: "End height above the obstacle top." },
    forward: { type: "number", default: 4, min: 0, max: 100, unit: "m", desc: "Forward drift toward the subject during the rise." },
    endPitchDeg: { type: "number", default: -8, min: -60, max: 20, unit: "deg", desc: "Pitch at the end (near the horizon reveals the vista)." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_REVEAL,
  defaultDuration: 9,
  defaultFraming: "EWS",
  defaultEase: "sineInOut",
  reveal: true,
  tags: ["aerial", "reveal", "opener"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const C = centreAt(ctx, 0);
    const b = dirOf(hB);
    const hc = hB + Math.PI;
    const f = dirOf(hc);
    const S0 = [C[0] + b[0] * P.distance, C[1] + b[1] * P.distance];
    const gS = groundAt(ctx, S0[0], S0[1]);
    const zg = gS !== null ? gS : refZ(ctx, 0);
    const zTop = P.obstacleHeight + P.clearance;
    const p0 = Math.atan2(0.5 * P.obstacleHeight - P.heightStart, P.obstacleDistance);
    const p1 = P.endPitchDeg * DEG;
    const xy = (t) => {
      const d = P.forward * u(t);
      return [S0[0] + f[0] * d, S0[1] + f[1] * d];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      const z = zg + P.heightStart + (zTop - P.heightStart) * u(t);
      return clampToEnvelope([p[0], p[1], lift(z, floor, t, P.minClearance)], ctx);
    };
    const orientAt = (t) => {
      const w = smoothstep(clamp((u(t) - 0.1) / 0.9, 0, 1));
      return { h: hc, p: p0 + (p1 - p0) * w, r: spec.roll };
    };
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt,
      meta: { obstacle: { distance: P.obstacleDistance, height: P.obstacleHeight }, startPitchDeg: p0 / DEG },
    });
  },
});

const tiltReveal = defineTechnique({
  id: "drone.tilt-reveal",
  name: "Tilt reveal",
  description: "Hovers at height looking almost straight down at the ground, then tilts up toward the horizon while drifting slightly forward, revealing the subject and the landscape beyond.",
  whenToUse: "Openers that start on a texture (a path, water, a rooftop) and reveal a town or landmark ahead. The camera starts `distance` metres from the subject on bearingDeg, facing it.",
  params: {
    startPitchDeg: { type: "number", default: -80, min: -90, max: 0, unit: "deg", desc: "Pitch at the start (−90 = straight down)." },
    endPitchDeg: { type: "number", default: -10, min: -60, max: 30, unit: "deg", desc: "Pitch at the end." },
    heightAGL: { type: "number", default: 20, min: 1, max: 300, unit: "m", desc: "Hover height above the subject's base." },
    distance: { type: "number", default: 60, min: 1, max: 2000, unit: "m", desc: "Horizontal distance from the subject at the start." },
    drift: { type: "number", default: 4, min: 0, max: 100, unit: "m", desc: "Forward drift toward the subject over the shot." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(2),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_REVEAL,
  defaultDuration: 8,
  defaultFraming: "EWS",
  defaultEase: "sineInOut",
  reveal: true,
  tags: ["aerial", "reveal", "tilt"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const C = centreAt(ctx, 0);
    const b = dirOf(hB);
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const xy = (t) => {
      const d = P.distance - P.drift * u(t);
      return [C[0] + b[0] * d, C[1] + b[1] * d];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0, floor, t, P.minClearance)], ctx);
    };
    const a = P.startPitchDeg * DEG, c = P.endPitchDeg * DEG;
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: (t) => ({ h: hB + Math.PI, p: a + (c - a) * u(t), r: spec.roll }),
      meta: { startPitchDeg: P.startPitchDeg, endPitchDeg: P.endPitchDeg },
    });
  },
});

/** Shared top-down placement: camera above the aim point, shifted back along heading for off-nadir pitch. */
function topDownPlace(aimP, zCam, h, p) {
  const back = p > -HALF_PI + 1e-9 ? (zCam - aimP[2]) / Math.tan(-p) : 0;
  const f = dirOf(h);
  return [aimP[0] - f[0] * back, aimP[1] - f[1] * back, zCam];
}

const topDown = defineTechnique({
  id: "drone.top-down",
  name: "Top-down",
  description: "Looks straight down (nadir) from a hover above the subject's start position. It can rotate the image (rotateDeg) or drift across the ground. The image never flips: the heading only rotates the image. pitchDeg slightly above −90 tilts the view off nadir while the subject stays centred.",
  whenToUse: "Graphic, map-like shots of town squares, patterns, crowds, roads and water, and as a transition. Rotate 30–90° for motion. Use pitchDeg ≈ −88 when fire, portal or smoke particles sit directly below (billboards spin at exact nadir).",
  params: {
    heightAGL: { type: "number", default: 40, min: 3, max: 500, unit: "m", desc: "Height above the subject's base." },
    rotateDeg: { type: "number", default: 0, min: -1080, max: 1080, unit: "deg", desc: "Image rotation over the shot (+ = clockwise heading change)." },
    headingDeg: pHeading(0, "Image 'up' direction at the start, compass degrees (see relativeToSubject)."),
    relativeToSubject: P_REL,
    pitchDeg: { type: "number", default: -90, min: -90, max: -60, unit: "deg", desc: "Gimbal pitch (−90 = exact nadir)." },
    drift: { type: "number", default: 0, min: 0, max: 300, unit: "m", desc: "Ground distance drifted along driftHeadingDeg, centred on the subject." },
    driftHeadingDeg: pHeading(0, "Drift direction, compass degrees (see relativeToSubject)."),
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_TOP,
  defaultDuration: 8,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "nadir", "90-degree"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.headingDeg);
    const rot = P.rotateDeg * DEG;
    const p = P.pitchDeg * DEG;
    const C = centreAt(ctx, 0);
    const aim0 = aimSubject(ctx, spec.framing)(0);
    const df = dirOf(relHeading(P, ctx, P.driftHeadingDeg));
    const top = ctx.subject ? C[2] + ctx.subject.height + 1.5 : -Infinity;
    const zc = Math.max(refZ(ctx, 0) + P.heightAGL, top);
    const hAt = (t) => h0 + rot * u(t);
    const xy = (t) => {
      const d = P.drift * (u(t) - 0.5);
      return topDownPlace([aim0[0] + df[0] * d, aim0[1] + df[1] * d, aim0[2]], zc, hAt(t), p);
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const q = xy(t);
      return clampToEnvelope([q[0], q[1], lift(zc, floor, t, P.minClearance)], ctx);
    };
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: (t) => ({ h: hAt(t), p, r: spec.roll }),
      meta: { rotateDeg: P.rotateDeg, pitchDeg: P.pitchDeg },
    });
  },
});

const topDownRise = defineTechnique({
  id: "drone.top-down-rise",
  name: "Top-down rise (god's-eye pull-up)",
  description: "Looks straight down at the subject and climbs vertically, optionally rotating the image. The subject shrinks to a dot in its surroundings.",
  whenToUse: "Endings and scale reveals: a lone character in a big landscape, a camp in a forest, a dungeon entrance in the wilds.",
  params: {
    heightStart: { type: "number", default: 6, min: 1, max: 300, unit: "m", desc: "Start height above the subject's base (raised to at least 1.5 m over the subject's top)." },
    heightEnd: { type: "number", default: 80, min: 2, max: 1000, unit: "m", desc: "End height above the subject's base." },
    rotateDeg: { type: "number", default: 0, min: -1080, max: 1080, unit: "deg", desc: "Image rotation over the shot." },
    headingDeg: pHeading(0, "Image 'up' direction at the start, compass degrees (see relativeToSubject)."),
    relativeToSubject: P_REL,
    pitchDeg: { type: "number", default: -90, min: -90, max: -60, unit: "deg", desc: "Gimbal pitch (−90 = exact nadir)." },
    minClearance: pMinClear(2),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_TOP,
  defaultDuration: 10,
  defaultFraming: "WS",
  defaultEase: "sineInOut",
  tags: ["aerial", "nadir", "rise", "90-degree"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.headingDeg);
    const rot = P.rotateDeg * DEG;
    const p = P.pitchDeg * DEG;
    const C = centreAt(ctx, 0);
    const aim0 = aimSubject(ctx, spec.framing)(0);
    const zr = refZ(ctx, 0);
    const top = ctx.subject ? C[2] + ctx.subject.height + 1.5 : -Infinity;
    const z0 = Math.max(zr + P.heightStart, top);
    const z1 = Math.max(zr + P.heightEnd, z0);
    const hAt = (t) => h0 + rot * u(t);
    const zAt = (t) => z0 + (z1 - z0) * u(t);
    const xy = (t) => topDownPlace(aim0, zAt(t), hAt(t), p);
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const q = xy(t);
      return clampToEnvelope([q[0], q[1], lift(zAt(t), floor, t, P.minClearance)], ctx);
    };
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: (t) => ({ h: hAt(t), p, r: spec.roll }),
      meta: { heightStart: z0 - zr, heightEnd: z1 - zr },
    });
  },
});

const topDownTrack = defineTechnique({
  id: "drone.top-down-track",
  name: "Top-down track",
  description: "Flies straight down over a moving subject and follows it (subjectAt). The subject's track is smoothed so server jitter never shakes the frame. The image 'up' follows the subject's direction of travel ('travel') or stays fixed.",
  whenToUse: "Overhead follows of a running character, a caravan or a creature on the move. Moving server-driven subjects need realtime capture.",
  params: {
    heightAGL: { type: "number", default: 25, min: 3, max: 300, unit: "m", desc: "Height above the subject's base." },
    headingMode: { type: "enum", values: ["travel", "fixed"], default: "travel", desc: "travel = image up follows the subject's travel direction; fixed = constant headingDeg." },
    headingDeg: pHeading(0, "Fixed image-up heading (fixed mode) or an offset added to the travel heading (travel mode)."),
    relativeToSubject: P_REL,
    smoothSec: { type: "number", default: 0.6, min: 0, max: 5, unit: "s", desc: "Smoothing window of the subject track." },
    pitchDeg: { type: "number", default: -90, min: -90, max: -60, unit: "deg", desc: "Gimbal pitch (−90 = exact nadir)." },
    minClearance: pMinClear(3),
  },
  needs: { subject: true, path: false, indoor: false },
  defaultBounds: B_FOLLOW,
  defaultDuration: 10,
  defaultFraming: "WS",
  defaultEase: "linear",
  capture: "realtime",
  tags: ["aerial", "nadir", "follow", "90-degree"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration;
    const s0 = ctx.subject;
    const fixedH = relHeading(P, ctx, P.headingDeg);
    const tr = subjectTrack(ctx, D, P.smoothSec, s0 && Number.isFinite(s0.heading) ? s0.heading : fixedH);
    const p = P.pitchDeg * DEG;
    const H = s0 ? s0.height : 1.8;
    const hAt = (t) => (P.headingMode === "travel" ? tr.headingAt(t) + P.headingDeg * DEG : fixedH);
    const xy = (t) => {
      const S = tr.posAt(t);
      return topDownPlace([S[0], S[1], S[2] + 0.5 * H], S[2] + Math.max(P.heightAGL, H + 1.5), hAt(t), p);
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const q = xy(t);
      return clampToEnvelope([q[0], q[1], lift(q[2], floor, t, P.minClearance)], ctx);
    };
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: (t) => ({ h: hAt(t), p, r: spec.roll }),
      meta: { moving: tr.moving, headingMode: P.headingMode },
    });
  },
});

const passOver = defineTechnique({
  id: "drone.pass-over",
  name: "Pass-over (gimbal through vertical)",
  description: "Flies forward straight over the subject while the gimbal tracks it all the way down through −90° and back up behind. A pre-simulated look controller handles the overhead moment. With 'yaw-slew' (default) the heading holds while the subject is straight below and then slews round at ≤ maxYawRateDeg: a smooth image rotation (the drone 'gimbal flip'), never a snap. 'pitch-through' keeps pitching past vertical (the image inverts, FPV style); 'hold' freezes the heading while overhead.",
  whenToUse: "The flagship crossing shot: pass over a meeting hall, a portal or a character and keep it in frame the whole way. Slow speeds and a higher pass make the slew gentler.",
  params: {
    heightAGL: { type: "number", default: 25, min: 3, max: 300, unit: "m", desc: "Pass height above the subject's base." },
    speed: { type: "number", default: 6, min: 0.5, max: 25, unit: "m/s", desc: "Ground speed; the pass covers speed × duration metres centred on the subject." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    nadirMode: { type: "enum", values: ["yaw-slew", "pitch-through", "hold"], default: "yaw-slew", desc: "What the gimbal does when the subject is straight below (see description)." },
    maxYawRateDeg: { type: "number", default: 90, min: 10, max: 720, unit: "deg/s", desc: "Heading slew-rate limit of the gimbal." },
    maxPitchRateDeg: { type: "number", default: 90, min: 10, max: 720, unit: "deg/s", desc: "Pitch rate limit of the gimbal." },
    smoothTime: { type: "number", default: 0.25, min: 0, max: 2, unit: "s", desc: "Gimbal smoothing time (critically damped)." },
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_AERIAL,
  defaultDuration: 12,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "nadir", "90-degree", "flagship"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.headingDeg);
    const f = dirOf(h0);
    const C = centreAt(ctx, 0);
    const L = P.speed * D;
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const xy = (t) => {
      const s = (u(t) - 0.5) * L;
      return [C[0] + f[0] * s, C[1] + f[1] * s];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0, floor, t, P.minClearance)], ctx);
    };
    const orientAt = smoothLookAt(positionAt, aimSubject(ctx, spec.framing), D, {
      nadirMode: P.nadirMode,
      maxYawRate: P.maxYawRateDeg * DEG,
      maxPitchRate: P.maxPitchRateDeg * DEG,
      smoothTime: P.smoothTime,
      holdConeDeg: 2,
      roll: spec.roll,
    });
    const tOver = timeAtProgress(u, 0.5, D);
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt,
      keyframes: [{ t: 0, label: "start" }, { t: tOver, label: "overhead" }, { t: D, label: "end" }],
      meta: { nadirMode: P.nadirMode, maxYawRateDeg: P.maxYawRateDeg, overheadT: tOver, lengthM: L, headingDeg: h0 / DEG },
    });
  },
});

const parallaxSlide = defineTechnique({
  id: "drone.parallax-slide",
  name: "Parallax slide",
  description: "Trucks sideways past the subject at low height, facing it. A partial counter-pan (panAmount) keeps the subject in frame while foreground and background slide past at different speeds.",
  whenToUse: "Adding depth to a static scene: sliding past a tree line, a statue or a gate with something in the foreground. Lower heights and closer foregrounds give stronger parallax.",
  params: {
    distance: { type: "number", default: 15, min: 1, max: 500, unit: "m", desc: "Horizontal distance from the subject (camera line centre)." },
    heightAGL: { type: "number", default: 3, min: 0.5, max: 200, unit: "m", desc: "Height above the subject's base." },
    slide: { type: "number", default: 12, min: 0.5, max: 500, unit: "m", desc: "Total sideways travel, centred on the subject's bearing." },
    panAmount: { type: "number", default: 0.35, min: 0, max: 1, desc: "Share of the subject's bearing change the camera follows (0 = pure truck, 1 = full pan)." },
    direction: { type: "enum", values: ["right", "left"], default: "right", desc: "Slide direction relative to the camera." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_CLOSE,
  defaultDuration: 8,
  defaultFraming: "WS",
  defaultEase: "sineInOut",
  tags: ["aerial", "parallax", "truck"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const C = centreAt(ctx, 0);
    const b = dirOf(hB);
    const hc = hB + Math.PI;
    const r = rightOf(hc);
    const sgn = P.direction === "left" ? -1 : 1;
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const xy = (t) => {
      const d = sgn * P.slide * (u(t) - 0.5);
      return [C[0] + b[0] * P.distance + r[0] * d, C[1] + b[1] * P.distance + r[1] * d];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0, floor, t, P.minClearance)], ctx);
    };
    const aim = aimSubject(ctx, spec.framing);
    const orientAt = (t, pos) => {
      const la = lookRotation(pos, aim(t), { headingHint: hc });
      const h = hc + P.panAmount * (unwrapAngle(la.h, hc) - hc);
      return { h, p: la.p, r: spec.roll };
    };
    return finish(spec, ctx, "drone", { positionAt, orientAt, meta: { panAmount: P.panAmount, slide: P.slide } });
  },
});

const terrainSkim = defineTechnique({
  id: "drone.terrain-skim",
  name: "Terrain skim",
  description: "Flies fast and low (1.5–4 m) over the ground, following ctx.groundZ. The terrain is max-filtered ahead and smoothed, so the drone rises before a bump rather than after it. The camera looks ahead along the flight, pitching with the slope and banking gently into turns. It follows ctx.path when given, else a straight line through the anchor along headingDeg.",
  whenToUse: "Energy and speed: racing over fields, across water, along a road into town. Keep the speed believable (8–14 m/s). Use drone.canyon-run for valleys and fpv.fpv-proximity to hug a wall.",
  params: {
    heightAGL: { type: "number", default: 2.5, min: 1.5, max: 4, unit: "m", desc: "Height above the smoothed terrain." },
    speed: { type: "number", default: 10, min: 1, max: 25, unit: "m/s", desc: "Ground speed without a path (covers speed × duration metres centred on the anchor); with a path the fitted profile sets the speed." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    lookAhead: { type: "number", default: 12, min: 1, max: 100, unit: "m", desc: "How far ahead along the flight the camera looks (also the terrain look-ahead)." },
    tiltDeg: { type: "number", default: -4, min: -45, max: 20, unit: "deg", desc: "Pitch added to the look-ahead direction." },
    cornerRadius: { type: "number", default: 10, min: 0, max: 200, unit: "m", desc: "Fillet radius applied to the corners of ctx.path." },
    alat: { type: "number", default: 3, min: 0.5, max: 20, unit: "m/s²", desc: "Lateral acceleration limit (slows into curves)." },
    maxBankDeg: { type: "number", default: 15, min: 0, max: 45, unit: "deg", desc: "Largest bank into turns." },
    ends: pEnds,
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_LOW,
  defaultDuration: 10,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "low", "speed", "terrain"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration;
    const h0 = relHeading(P, ctx, P.headingDeg);
    let points;
    if (Array.isArray(ctx.path) && ctx.path.length >= 2) points = ctx.path.map((p) => p.slice());
    else {
      const f = dirOf(h0);
      const A = ctx.anchor;
      const z = refZ(ctx, 0);
      const half = (P.speed * D) / 2;
      points = [[A[0] - f[0] * half, A[1] - f[1] * half, z], [A[0] + f[0] * half, A[1] + f[1] * half, z]];
    }
    const F = makeFollower(spec, ctx, points, {
      fillet: P.cornerRadius, vmax: P.speed, amax: 1.75, alat: P.alat, ends: P.ends, zMode: "terrain", heightAGL: P.heightAGL,
      lookAhead: P.lookAhead, tiltDeg: P.tiltDeg, bankGain: 0.6, maxBankDeg: P.maxBankDeg, headingHint: h0,
    });
    return finish(spec, ctx, "drone", {
      positionAt: F.positionAt,
      orientAt: F.orientAt,
      meta: { lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed },
    });
  },
});

const canyonRun = defineTechnique({
  id: "drone.canyon-run",
  name: "Canyon run",
  description: "Follows a valley, river or canyon floor polyline (ctx.path) at a height above it. Corners are filleted into curves, the drone slows into tight bends, banks with the turn and looks ahead along the valley. It rises over the smoothed terrain wherever the ground climbs above the path.",
  whenToUse: "Flowing journeys through valleys, gorges, riverbeds or along a town's main street. Give the path as points along the valley floor.",
  params: {
    heightAGL: { type: "number", default: 8, min: 1, max: 200, unit: "m", desc: "Height above the path points." },
    speed: { type: "number", default: 12, min: 1, max: 30, unit: "m/s", desc: "Nominal cruise speed; the fitted profile scales it so the run lasts exactly the shot duration." },
    alat: { type: "number", default: 4, min: 0.5, max: 20, unit: "m/s²", desc: "Lateral acceleration limit (slows into bends)." },
    cornerRadius: { type: "number", default: 15, min: 0, max: 300, unit: "m", desc: "Fillet radius of the path corners." },
    lookAhead: { type: "number", default: 20, min: 1, max: 200, unit: "m", desc: "How far ahead along the valley the camera looks." },
    tiltDeg: { type: "number", default: -3, min: -45, max: 20, unit: "deg", desc: "Pitch added to the look-ahead direction." },
    maxBankDeg: { type: "number", default: 25, min: 0, max: 60, unit: "deg", desc: "Largest bank into bends." },
    bankGain: { type: "number", default: 1, min: 0, max: 3, desc: "Bank multiplier (0 = level horizon)." },
    minClearance: pMinClear(3),
    ends: pEnds,
  },
  needs: { subject: false, path: true, indoor: false },
  defaultBounds: B_LOW,
  defaultDuration: 12,
  defaultFraming: "EWS",
  defaultEase: "linear",
  tags: ["aerial", "path", "speed", "terrain"],
  build(spec, ctx) {
    const P = spec.params;
    const points = ctx.path.map((p) => p.slice());
    const F = makeFollower(spec, ctx, points, {
      fillet: P.cornerRadius, vmax: P.speed, amax: 1.75, alat: P.alat, ends: P.ends, zMode: "path-min", zOffset: P.heightAGL,
      minClear: P.minClearance, lookAhead: P.lookAhead, tiltDeg: P.tiltDeg, bankGain: P.bankGain, maxBankDeg: P.maxBankDeg,
      headingHint: 0,
    });
    return finish(spec, ctx, "drone", {
      positionAt: F.positionAt,
      orientAt: F.orientAt,
      meta: { lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed },
    });
  },
});

/** Param schema shared by chase / lead / side-track. */
function followParams(distance, height) {
  return {
    distance: { type: "number", default: distance, min: 1, max: 200, unit: "m", desc: "Horizontal distance from the subject." },
    heightAGL: { type: "number", default: height, min: 0.5, max: 200, unit: "m", desc: "Height above the subject's base." },
    offsetAngleDeg: { type: "number", default: 0, min: -180, max: 180, unit: "deg", desc: "Rotate the camera's placement around the subject (+ = clockwise seen from above)." },
    smoothSec: { type: "number", default: 0.6, min: 0, max: 5, unit: "s", desc: "Smoothing window of the subject track (removes server jitter)." },
    minClearance: pMinClear(1.5),
  };
}

const chase = defineTechnique({
  id: "drone.chase",
  name: "Chase",
  description: "Follows a moving subject from behind (relative to its direction of travel) at a set distance and height and looks at it. The subject's track is smoothed. The camera swings smoothly behind the subject when it turns. A static subject is framed from behind its facing.",
  whenToUse: "Following a running character, a mount or a fleeing creature. Use realtime capture for server-driven motion.",
  params: followParams(8, 3),
  needs: { subject: true, path: false, indoor: null },
  defaultBounds: B_FOLLOW,
  defaultDuration: 10,
  defaultFraming: "FS",
  defaultEase: "linear",
  capture: "realtime",
  tags: ["aerial", "follow", "moving-subject"],
  build: (spec, ctx) => followBuild(spec, ctx, "chase"),
});

const lead = defineTechnique({
  id: "drone.lead",
  name: "Lead",
  description: "Flies ahead of a moving subject, backwards, facing it, so the subject walks or runs toward the lens with its path behind it.",
  whenToUse: "Heroic advances (an army marching, a character striding toward the camera) and showing who follows the subject.",
  params: followParams(8, 2.5),
  needs: { subject: true, path: false, indoor: null },
  defaultBounds: B_FOLLOW,
  defaultDuration: 10,
  defaultFraming: "FS",
  defaultEase: "linear",
  capture: "realtime",
  tags: ["aerial", "follow", "moving-subject"],
  build: (spec, ctx) => followBuild(spec, ctx, "lead"),
});

const sideTrack = defineTechnique({
  id: "drone.side-track",
  name: "Side track",
  description: "Flies parallel to a moving subject on its left or right side and looks at it. The background streams past behind the subject.",
  whenToUse: "Showing speed and the landscape a subject travels through: riders on a road, a creature along a shore.",
  params: {
    ...followParams(8, 2),
    side: { type: "enum", values: ["right", "left"], default: "right", desc: "Which side of the subject (relative to its travel) the camera flies on." },
  },
  needs: { subject: true, path: false, indoor: null },
  defaultBounds: B_FOLLOW,
  defaultDuration: 10,
  defaultFraming: "FS",
  defaultEase: "linear",
  capture: "realtime",
  tags: ["aerial", "follow", "moving-subject"],
  build: (spec, ctx) => followBuild(spec, ctx, "side"),
});

const boomerang = defineTechnique({
  id: "drone.boomerang",
  name: "Boomerang",
  description: "Flies in toward the subject along bearingDeg, eases to a stop at the near distance, then retreats back out while climbing by `rise`. The turnaround has zero velocity, so it reads as one continuous gesture.",
  whenToUse: "Rhythmic, music-video beats (in on the verse, out on the hook) and showing a subject twice at different scales.",
  params: {
    far: { type: "number", default: 30, min: 2, max: 1000, unit: "m", desc: "Horizontal start/end distance." },
    near: { type: "number", default: 8, min: 1, max: 500, unit: "m", desc: "Horizontal distance at the turnaround." },
    heightStart: { type: "number", default: 6, min: 0.5, max: 300, unit: "m", desc: "Height above the subject's base at the start." },
    heightNear: { type: "number", default: 3, min: 0.5, max: 300, unit: "m", desc: "Height at the turnaround." },
    rise: { type: "number", default: 8, min: 0, max: 300, unit: "m", desc: "Extra height gained on the way out." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1.5),
  },
  needs: { subject: true, path: false, indoor: null },
  defaultBounds: B_AERIAL,
  defaultDuration: 10,
  defaultFraming: "FS",
  defaultEase: "linear",
  tags: ["aerial", "rhythm", "music-video"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const C = centreAt(ctx, 0);
    const b = dirOf(hB);
    const z0 = refZ(ctx, 0);
    const bell = (t) => {
      const s = Math.sin(Math.PI * u(t));
      return s * s;
    };
    const xy = (t) => {
      const d = P.far - (P.far - P.near) * bell(t);
      return [C[0] + b[0] * d, C[1] + b[1] * d];
    };
    const zRel = (t) => {
      const w = bell(t);
      if (u(t) <= 0.5) return P.heightStart + (P.heightNear - P.heightStart) * w;
      return P.heightNear + (P.heightStart + P.rise - P.heightNear) * (1 - w);
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0 + zRel(t), floor, t, P.minClearance)], ctx);
    };
    const tTurn = timeAtProgress(u, 0.5, D);
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: lookAtSubject(spec, ctx, hB + Math.PI),
      keyframes: [{ t: 0, label: "start" }, { t: tTurn, label: "turn" }, { t: D, label: "end" }],
      meta: { turnT: tTurn },
    });
  },
});

const flyBy = defineTechnique({
  id: "drone.fly-by",
  name: "Fly-by",
  description: "Flies a straight line past the subject at speed, offset to one side, while the camera yaws to keep it centred. The fastest pan happens at the closest point, so the subject whips through the frame's centre and the background streaks.",
  whenToUse: "Energetic beats and transitions: whipping past a character, a banner or a guard tower. Peak yaw rate ≈ speed / offset (keep it under ≈ 3 rad/s).",
  params: {
    offset: { type: "number", default: 6, min: 1, max: 200, unit: "m", desc: "Closest horizontal distance to the subject." },
    heightAGL: { type: "number", default: 3, min: 0.5, max: 200, unit: "m", desc: "Height above the subject's base." },
    speed: { type: "number", default: 12, min: 1, max: 30, unit: "m/s", desc: "Ground speed; the line is speed × duration long, closest approach at mid-shot." },
    side: { type: "enum", values: ["left", "right"], default: "left", desc: "Side of the camera the subject passes on." },
    headingDeg: pTravel(90),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1),
  },
  needs: { subject: true, path: false, indoor: null },
  defaultBounds: B_CLOSE,
  defaultDuration: 6,
  defaultFraming: "FS",
  defaultEase: "linear",
  tags: ["aerial", "speed", "whip"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.headingDeg);
    const f = dirOf(h0);
    const r = rightOf(h0);
    const C = centreAt(ctx, 0);
    const lat = P.side === "left" ? 1 : -1;
    const L = P.speed * D;
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const xy = (t) => {
      const s = (u(t) - 0.5) * L;
      return [C[0] + r[0] * lat * P.offset + f[0] * s, C[1] + r[1] * lat * P.offset + f[1] * s];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0, floor, t, P.minClearance)], ctx);
    };
    const tMid = timeAtProgress(u, 0.5, D);
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: lookAtSubject(spec, ctx, h0),
      keyframes: [{ t: 0, label: "start" }, { t: tMid, label: "closest" }, { t: D, label: "end" }],
      meta: { lengthM: L, peakYawRateDeg: (P.speed / P.offset) / DEG },
    });
  },
});

const spiralDescent = defineTechnique({
  id: "drone.spiral-descent",
  name: "Spiral descent",
  description: "Descends in a tightening spiral around the subject while looking at it. The reverse of a helix: a high, wide establishing view becomes a close one.",
  whenToUse: "Arriving at a place: from above a town down to its square, from the sky down to a character, into a crater or a courtyard.",
  params: {
    radiusStart: { type: "number", default: 40, min: 2, max: 500, unit: "m", desc: "Orbit radius at the start." },
    radiusEnd: { type: "number", default: 12, min: 2, max: 500, unit: "m", desc: "Orbit radius at the end." },
    heightStart: { type: "number", default: 50, min: 0.5, max: 500, unit: "m", desc: "Height above the subject's base at the start." },
    heightEnd: { type: "number", default: 6, min: 0.5, max: 300, unit: "m", desc: "Height above the subject's base at the end." },
    revolutions: { type: "number", default: 0.5, min: 0.05, max: 10, desc: "Turns completed over the shot." },
    direction: pDir,
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_ORBIT,
  defaultDuration: 14,
  defaultFraming: "WS",
  defaultEase: "sineInOut",
  tags: ["aerial", "orbit", "descend"],
  build(spec, ctx) {
    const P = spec.params;
    return orbitBuild(spec, ctx, { r0: P.radiusStart, r1: P.radiusEnd, h0: P.heightStart, h1: P.heightEnd, revolutions: P.revolutions });
  },
});

const pano360 = defineTechnique({
  id: "drone.pano-360",
  name: "Panorama 360",
  description: "Hovers above the subject's position (or the anchor) with the gimbal level and yaws through a full turn (yawDeg), easing in and out.",
  whenToUse: "Showing the whole surroundings of a place from above: a town's skyline, a mountain top, a lake. The subject itself is not kept in frame.",
  params: {
    heightAGL: { type: "number", default: 30, min: 1, max: 500, unit: "m", desc: "Hover height above the subject's base." },
    yawDeg: { type: "number", default: 360, min: 10, max: 1080, unit: "deg", desc: "Total yaw over the shot." },
    direction: pDir,
    startHeadingDeg: pHeading(0, "Heading at the start, compass degrees (see relativeToSubject)."),
    relativeToSubject: P_REL,
    tiltDeg: { type: "number", default: 0, min: -60, max: 30, unit: "deg", desc: "Gimbal pitch (0 = level horizon)." },
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_HOVER,
  defaultDuration: 14,
  defaultFraming: "EWS",
  defaultEase: "sineInOut",
  tags: ["aerial", "pan", "vista"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.startHeadingDeg);
    const sgn = P.direction === "ccw" ? -1 : 1;
    const C = centreAt(ctx, 0);
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const floor = timeFloor(ctx, () => [C[0], C[1]], D);
    const positionAt = (t) => clampToEnvelope([C[0], C[1], lift(z0, floor, t, P.minClearance)], ctx);
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: (t) => ({ h: h0 + sgn * P.yawDeg * DEG * u(t), p: P.tiltDeg * DEG, r: spec.roll }),
      meta: { yawDeg: P.yawDeg, direction: P.direction },
    });
  },
});

const hyperlapseOrbit = defineTechnique({
  id: "drone.hyperlapse-orbit",
  name: "Hyperlapse orbit",
  description: "A slow orbit around the subject while the runtime speeds the sky up `timeRate`× (meta.timeLapse, in game-days per film second like classic.time-lapse). Clouds race and the light sweeps around the landmark.",
  whenToUse: "Passage of time over a landmark or town: sunset into night, a storm rolling in. Use a static subject; moving NPCs would blur.",
  params: {
    radius: { type: "number", default: 40, min: 2, max: 500, unit: "m", desc: "Orbit radius." },
    heightAGL: { type: "number", default: 25, min: 1, max: 300, unit: "m", desc: "Orbit height above the subject's base." },
    revolutions: { type: "number", default: 0.5, min: 0.01, max: 10, desc: "Turns completed over the shot." },
    timeRate: {
      type: "number", default: 150, min: 1, max: 3600, unit: "sky-s/s",
      desc: `Sky speed-up: seconds of the live sky clock (one Dereth day = ${AC_DAY_LENGTH_S} s) per film second. 1 = real time; 150 ≈ 0.02 game-days (≈ 28 game-minutes) per film second, so the default 15 s shot spans ≈ 7 game-hours; 3600 ≈ 0.47 game-days per second.`,
    },
    direction: pDir,
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(3),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_ORBIT,
  defaultDuration: 15,
  defaultFraming: "WS",
  defaultEase: "linear",
  tags: ["aerial", "orbit", "time-lapse"],
  build(spec, ctx) {
    const P = spec.params;
    return orbitBuild(spec, ctx, {
      r0: P.radius, r1: P.radius, h0: P.heightAGL, h1: P.heightAGL, revolutions: P.revolutions,
      // film_clock reads timeLapse.rate in GAME-DAYS per film second (as classic.time-lapse
      // emits it): convert the sky-clock seconds with the client's day length.
      meta: { timeLapse: { rate: P.timeRate / AC_DAY_LENGTH_S, unit: "game-days/s" } },
    });
  },
});

const vertigoDrone = defineTechnique({
  id: "drone.vertigo-drone",
  name: "Vertigo (drone dolly-zoom)",
  description: "A drone dolly-zoom. The drone flies away from the subject (or toward it, direction 'in') while the fov narrows (or widens) so the subject keeps exactly the same size on screen and the background stretches or compresses behind it. The shot fov applies at the near end: 'out' starts at it and narrows, 'in' starts narrow and widens to it.",
  whenToUse: "Unease, epiphany or dread: a character realising the scale of what is behind them, a tower looming. Needs open space along the bearing behind the camera.",
  params: {
    nearDistance: { type: "number", default: 0, min: 0, max: 200, unit: "m", desc: "Horizontal near distance; 0 = the distance that frames the subject at the shot framing and fov (≥ 3 m)." },
    farDistance: { type: "number", default: 18, min: 2, max: 1000, unit: "m", desc: "Horizontal far distance." },
    direction: { type: "enum", values: ["out", "in"], default: "out", desc: "out = fly away while zooming in (background grows); in = push in while zooming out." },
    heightAGL: { type: "number", default: 1.8, min: 0.3, max: 200, unit: "m", desc: "Camera height above the subject's base." },
    minFovDeg: { type: "number", default: 6, min: 1, max: 60, unit: "deg", desc: "Narrowest fov allowed." },
    maxFovDeg: { type: "number", default: 110, min: 30, max: 160, unit: "deg", desc: "Widest fov allowed." },
    bearingDeg: pBearing(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1),
  },
  needs: { subject: true, path: false, indoor: null },
  defaultBounds: B_CLOSE,
  defaultDuration: 8,
  defaultFraming: "MS",
  defaultEase: "sineInOut",
  tags: ["aerial", "zoom", "dolly-zoom"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const hB = relHeading(P, ctx, P.bearingDeg);
    const C = centreAt(ctx, 0);
    const b = dirOf(hB);
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const near = P.nearDistance > 0 ? P.nearDistance : framingDistance(spec, ctx, 3, 100);
    const far = Math.max(P.farDistance, near + 0.5);
    const [dA, dB] = P.direction === "in" ? [far, near] : [near, far];
    const xy = (t) => {
      const d = dA + (dB - dA) * u(t);
      return [C[0] + b[0] * d, C[1] + b[1] * d];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      return clampToEnvelope([p[0], p[1], lift(z0, floor, t, P.minClearance)], ctx);
    };
    const aim = aimSubject(ctx, spec.framing);
    const dist = (t) => {
      const p = positionAt(t), A = aim(t);
      return Math.max(0.05, Math.hypot(p[0] - A[0], p[1] - A[1], p[2] - A[2]));
    };
    const K = dist(P.direction === "in" ? D : 0) * Math.tan((spec.fov * DEG) / 2);
    const lo = Math.min(P.minFovDeg, P.maxFovDeg), hi = Math.max(P.minFovDeg, P.maxFovDeg);
    const fovAt = (t) => clamp((2 * Math.atan(K / dist(t))) / DEG, lo, hi);
    return finish(spec, ctx, "drone", {
      positionAt,
      orientAt: lookAtSubject(spec, ctx, hB + Math.PI),
      fovAt,
      meta: { nearDistance: near, farDistance: far, direction: P.direction, sizeConstant: K },
    });
  },
});

// ---------------------------------------------------------------------------
// fpv.* techniques
// ---------------------------------------------------------------------------

const fpvDive = defineTechnique({
  id: "fpv.fpv-dive",
  name: "FPV dive",
  description: "Comes in level over the top of a face (cliff, tower, waterfall, wall), crests the edge and dives down it at diveAngleDeg (−60…−90°), then pulls out in a smooth arc into level flight near the ground. The view is a hard-mounted FPV camera looking along the flight. On the steep part the uptilt shows: the camera looks uptiltDeg·sin²(dive) above the dive line, as on a real FPV quad.",
  whenToUse: "Adrenaline moments: diving off a tower, down a cliff or a waterfall. The subject or anchor is the base of the face. The dive heads along headingDeg.",
  params: {
    heightStart: { type: "number", default: 30, min: 3, max: 500, unit: "m", desc: "Height of the face top (crest) above its base." },
    bottomAGL: { type: "number", default: 2.5, min: 0.8, max: 50, unit: "m", desc: "Pull-out height above the base." },
    diveAngleDeg: { type: "number", default: -80, min: -90, max: -60, unit: "deg", desc: "Dive line pitch." },
    approach: { type: "number", default: 12, min: 2, max: 200, unit: "m", desc: "Level run-up before the edge." },
    standoff: { type: "number", default: 3, min: 0.5, max: 50, unit: "m", desc: "Horizontal distance from the face's base point to the dive line." },
    exitLength: { type: "number", default: 25, min: 2, max: 500, unit: "m", desc: "Level flight after the pull-out." },
    pullOutRadius: { type: "number", default: 8, min: 1, max: 100, unit: "m", desc: "Radius of the crest and pull-out arcs." },
    speed: { type: "number", default: 16, min: 2, max: 30, unit: "m/s", desc: "Nominal cruise speed (the fitted profile keeps the duration exact)." },
    alat: { type: "number", default: 11, min: 1, max: 40, unit: "m/s²", desc: "Lateral (centripetal) acceleration limit in the arcs." },
    uptiltDeg: { type: "number", default: 20, min: 0, max: 45, unit: "deg", desc: "FPV camera uptilt shown on steep dives." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(1.5),
  },
  needs: { subject: false, path: false, indoor: false },
  defaultBounds: B_FPV,
  defaultDuration: 7,
  defaultFraming: "WS",
  defaultFov: 75,
  defaultEase: "linear",
  tags: ["fpv", "dive", "90-degree"],
  build(spec, ctx) {
    const P = spec.params;
    const h0 = relHeading(P, ctx, P.headingDeg);
    const f = dirOf(h0);
    const C = centreAt(ctx, 0);
    const zg = refZ(ctx, 0);
    const top = zg + Math.max(P.heightStart, P.bottomAGL + 1);
    const bottom = zg + P.bottomAGL;
    const steep = Math.min(90, Math.abs(P.diveAngleDeg)) * DEG;
    const run = ((top - bottom) * Math.cos(steep)) / Math.sin(steep);
    const at = (d, z) => [C[0] + f[0] * d, C[1] + f[1] * d, z];
    const points = [
      at(-P.approach, top + 1),
      at(P.standoff, top),
      at(P.standoff + run, bottom),
      at(P.standoff + run + P.exitLength, bottom),
    ];
    const F = makeFollower(spec, ctx, points, {
      fillet: P.pullOutRadius, vmax: P.speed, amax: 6.5, alat: P.alat, ends: "cruise", zMode: "path-min", zOffset: 0,
      minClear: P.minClearance, lookAhead: 5, uptiltDeg: P.uptiltDeg, bankGain: 0, headingHint: h0,
    });
    return finish(spec, ctx, "fpv", {
      positionAt: F.positionAt,
      orientAt: F.orientAt,
      meta: { lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed, diveAngleDeg: P.diveAngleDeg },
    });
  },
});

const fpvProximity = defineTechnique({
  id: "fpv.fpv-proximity",
  name: "FPV proximity",
  description: "Hugs a surface at close range: it follows ctx.path (the line of a wall, cliff, tree line or hull) offset `offset` metres away with the surface on `side`, low over the smoothed terrain. It banks into curves and leans toward the surface. Without a path it flies a straight line through the anchor along headingDeg, with the surface along that line.",
  whenToUse: "Intimate speed: skimming a town wall, a cliff face, a row of trees or a ship's hull. Keep offset ≥ 1 m; the safety layer and the pilot own the last metre.",
  params: {
    offset: { type: "number", default: 1.5, min: 0.5, max: 10, unit: "m", desc: "Distance kept from the surface line." },
    side: { type: "enum", values: ["right", "left"], default: "right", desc: "Side of the camera the surface is on." },
    heightAGL: { type: "number", default: 2.5, min: 0.8, max: 50, unit: "m", desc: "Height above the smoothed terrain." },
    speed: { type: "number", default: 12, min: 1, max: 30, unit: "m/s", desc: "Ground speed without a path (speed × duration metres centred on the anchor); with a path the fitted profile sets it." },
    cornerRadius: { type: "number", default: 5, min: 0, max: 100, unit: "m", desc: "Fillet radius of the path corners." },
    alat: { type: "number", default: 10, min: 1, max: 40, unit: "m/s²", desc: "Lateral acceleration limit." },
    lookAhead: { type: "number", default: 8, min: 1, max: 100, unit: "m", desc: "How far ahead the camera looks." },
    leanDeg: { type: "number", default: 8, min: 0, max: 45, unit: "deg", desc: "Constant bank toward the surface." },
    maxBankDeg: { type: "number", default: 40, min: 0, max: 80, unit: "deg", desc: "Largest bank into curves." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    ends: pEnds,
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_FPV,
  defaultDuration: 8,
  defaultFraming: "WS",
  defaultFov: 75,
  defaultEase: "linear",
  tags: ["fpv", "proximity", "speed"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration;
    const h0 = relHeading(P, ctx, P.headingDeg);
    const sideSign = P.side === "left" ? -1 : 1;
    let points;
    if (Array.isArray(ctx.path) && ctx.path.length >= 2) points = ctx.path.map((p) => p.slice());
    else {
      const f = dirOf(h0);
      const A = ctx.anchor;
      const z = refZ(ctx, 0);
      const half = (P.speed * D) / 2;
      points = [[A[0] - f[0] * half, A[1] - f[1] * half, z], [A[0] + f[0] * half, A[1] + f[1] * half, z]];
    }
    const F = makeFollower(spec, ctx, points, {
      fillet: P.cornerRadius, vmax: P.speed, amax: 6.5, alat: P.alat, ends: P.ends, zMode: "terrain", heightAGL: P.heightAGL,
      lateral: -sideSign * P.offset, lookAhead: P.lookAhead, bankGain: 1, maxBankDeg: P.maxBankDeg, leanDeg: sideSign * P.leanDeg,
      headingHint: h0,
    });
    return finish(spec, ctx, "fpv", {
      positionAt: F.positionAt,
      orientAt: F.orientAt,
      meta: { lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed, side: P.side, offset: P.offset },
    });
  },
});

const fpvGap = defineTechnique({
  id: "fpv.fpv-gap",
  name: "FPV gap",
  description: "Threads a gap fast. It approaches at an angle from one side, carves a banked turn onto the gap's axis alignDistance before it, shoots through the exact gap centre along the gap normal and exits straight. The gap comes from gapPos/gapNormal (or ctx.gap). Without a gap it follows ctx.path (filleted); with neither, the gap is heightAGL above the anchor, crossed along headingDeg.",
  whenToUse: "Through arches, between tree trunks, under bridges, through a window. Use drone.flythrough for the slow, level cinematic version.",
  params: {
    gapPos: { type: "vec3", default: [0, 0, 0], unit: "m", desc: "World centre of the gap. [0,0,0] = the anchor raised by heightAGL." },
    gapNormal: { type: "vec3", default: [0, 0, 0], desc: "Direction of travel through the gap; [0,0,0] = no explicit gap (ctx.gap / ctx.path / anchor + headingDeg)." },
    gapWidth: { type: "number", default: 2.5, min: 0.3, max: 50, unit: "m", desc: "Gap width (meta.gap, for the runtime's clearance checks)." },
    gapHeight: { type: "number", default: 2.5, min: 0.3, max: 50, unit: "m", desc: "Gap height (meta.gap)." },
    heightAGL: { type: "number", default: 2, min: 0.5, max: 200, unit: "m", desc: "Gap centre height above the reference ground when the gap comes from the anchor." },
    approachAngleDeg: { type: "number", default: 25, min: 0, max: 80, unit: "deg", desc: "Angle between the approach leg and the gap axis." },
    approachFrom: { type: "enum", values: ["left", "right"], default: "left", desc: "Side of the gap axis the approach comes from." },
    approachDistance: { type: "number", default: 30, min: 2, max: 500, unit: "m", desc: "Length of the angled approach leg." },
    alignDistance: { type: "number", default: 10, min: 1, max: 100, unit: "m", desc: "Straight, aligned run before the gap." },
    exitDistance: { type: "number", default: 25, min: 1, max: 500, unit: "m", desc: "Straight run after the gap." },
    cornerRadius: { type: "number", default: 10, min: 0, max: 100, unit: "m", desc: "Fillet radius of the approach turn (and of ctx.path corners)." },
    speed: { type: "number", default: 16, min: 1, max: 30, unit: "m/s", desc: "Nominal cruise speed (the fitted profile keeps the duration exact)." },
    alat: { type: "number", default: 10, min: 1, max: 40, unit: "m/s²", desc: "Lateral acceleration limit." },
    lookAhead: { type: "number", default: 6, min: 0.5, max: 50, unit: "m", desc: "How far ahead the camera looks." },
    maxBankDeg: { type: "number", default: 45, min: 0, max: 80, unit: "deg", desc: "Largest bank in the approach turn." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    ends: pEnds,
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_GAP,
  defaultDuration: 6,
  defaultFraming: "WS",
  defaultFov: 75,
  defaultEase: "linear",
  tags: ["fpv", "gap", "speed"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration;
    let gap = resolveGap(P, ctx);
    const hasPath = Array.isArray(ctx.path) && ctx.path.length >= 2;
    let points;
    if (!gap && hasPath) {
      points = ctx.path.map((p) => p.slice());
    } else {
      if (!gap) {
        const h0 = relHeading(P, ctx, P.headingDeg);
        gap = { pos: [ctx.anchor[0], ctx.anchor[1], refZ(ctx, 0) + P.heightAGL], normal: dirOf(h0), width: P.gapWidth, height: P.gapHeight, source: "anchor" };
      }
      const G = gap.pos, n = gap.normal;
      const horiz = Math.hypot(n[0], n[1]);
      const ang = horiz > 0.3 ? P.approachAngleDeg * DEG * (P.approachFrom === "left" ? 1 : -1) : 0;
      const a = unit(rotCompass(n, ang)) || n;
      const A1 = [G[0] - n[0] * P.alignDistance, G[1] - n[1] * P.alignDistance, G[2] - n[2] * P.alignDistance];
      const A0 = [A1[0] - a[0] * P.approachDistance, A1[1] - a[1] * P.approachDistance, A1[2] - a[2] * P.approachDistance];
      const A3 = [G[0] + n[0] * P.exitDistance, G[1] + n[1] * P.exitDistance, G[2] + n[2] * P.exitDistance];
      points = ang !== 0 ? [A0, A1, G.slice(), A3] : [A0, G.slice(), A3];
    }
    const hint = gap ? Math.atan2(gap.normal[0], gap.normal[1]) : relHeading(P, ctx, P.headingDeg);
    const F = makeFollower(spec, ctx, points, {
      fillet: P.cornerRadius, vmax: P.speed, amax: 6.5, alat: P.alat, ends: P.ends, zMode: "path", lookAhead: P.lookAhead,
      bankGain: 1, maxBankDeg: P.maxBankDeg, headingHint: hint,
    });
    const meta = { lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed };
    let keyframes;
    if (gap) {
      const gs = nearestS(F.path, gap.pos);
      meta.gap = { pos: gap.pos, normal: gap.normal, width: gap.width, height: gap.height, source: gap.source };
      meta.gapT = F.timeAtS(gs);
      keyframes = [{ t: 0, label: "start" }, { t: meta.gapT, label: "gap" }, { t: D, label: "end" }];
    }
    return finish(spec, ctx, "fpv", { positionAt: F.positionAt, orientAt: F.orientAt, keyframes, meta });
  },
});

const fpvFlip = defineTechnique({
  id: "fpv.fpv-flip",
  name: "FPV flip",
  description: "Flies forward (or hovers, speed 0) and performs a full 360° roll or pitch flip mid-shot, popping up by `rise` metres during the flip. The orientation is a quaternion path (base orientation ⊗ axis-angle), so the camera passes through inverted and vertical with no gimbal-angle singularity and no flip artefacts. The default 3 s flip peaks near 190°/s and is readable on film. Shorter flips are allowed: validate the take with a higher angular limit.",
  whenToUse: "Punctuation on a beat drop, celebration moments and transitions: barrel-roll past a banner or flip over a gate. Roll flips keep the horizon in view longer than pitch flips.",
  params: {
    axis: { type: "enum", values: ["roll", "pitch"], default: "roll", desc: "roll = barrel roll about the view axis; pitch = loop about the camera's right axis." },
    direction: { type: "enum", values: ["positive", "negative"], default: "positive", desc: "positive = roll right / pitch up (backflip); negative = roll left / pitch down (front flip)." },
    turns: { type: "number", default: 1, min: 1, max: 3, integer: true, desc: "Number of full rotations." },
    flipDuration: { type: "number", default: 3, min: 0.3, max: 20, unit: "s", desc: "Duration of the flip (shortened to 80% of the shot when longer)." },
    flipAt: { type: "number", default: 0.5, min: 0.1, max: 0.9, desc: "Centre of the flip as a fraction of the shot." },
    speed: { type: "number", default: 6, min: 0, max: 25, unit: "m/s", desc: "Forward speed (0 = hover flip)." },
    heightAGL: { type: "number", default: 6, min: 1, max: 200, unit: "m", desc: "Height above the reference ground." },
    rise: { type: "number", default: 2, min: 0, max: 30, unit: "m", desc: "Pop-up height during the flip." },
    tiltDeg: { type: "number", default: 0, min: -45, max: 30, unit: "deg", desc: "Base camera pitch." },
    headingDeg: pTravel(0),
    relativeToSubject: P_REL,
    minClearance: pMinClear(2),
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_FPV,
  defaultDuration: 8,
  defaultFraming: "WS",
  defaultFov: 75,
  defaultEase: "linear",
  tags: ["fpv", "flip", "trick", "90-degree"],
  build(spec, ctx) {
    const P = spec.params, D = spec.duration, u = progressFn(spec);
    const h0 = relHeading(P, ctx, P.headingDeg);
    const f = dirOf(h0);
    const C = centreAt(ctx, 0);
    const L = P.speed * D;
    const z0 = refZ(ctx, 0) + P.heightAGL;
    const fd = Math.min(P.flipDuration, 0.8 * D);
    const t0 = clamp(P.flipAt * D - fd / 2, 0, Math.max(0, D - fd));
    const t1 = t0 + fd;
    const sgn = P.direction === "negative" ? -1 : 1;
    const axis = P.axis === "pitch" ? [1, 0, 0] : [0, 1, 0];
    const total = sgn * TAU * P.turns;
    const w = (t) => (fd > 0 ? clamp((t - t0) / fd, 0, 1) : t >= t0 ? 1 : 0);
    const angle = (t) => total * sineInOut(w(t));
    const qBase = quatFromHPR(h0, P.tiltDeg * DEG, spec.roll || 0);
    const xy = (t) => {
      const s = (u(t) - 0.5) * L;
      return [C[0] + f[0] * s, C[1] + f[1] * s];
    };
    const floor = timeFloor(ctx, xy, D);
    const positionAt = (t) => {
      const p = xy(t);
      const s = Math.sin(Math.PI * w(t));
      return clampToEnvelope([p[0], p[1], lift(z0 + P.rise * s * s, floor, t, P.minClearance)], ctx);
    };
    const orientAt = (t) => ({ q: qMul(qBase, qFromAxisAngle(axis, angle(t))), h: h0, r: spec.roll || 0 });
    return finish(spec, ctx, "fpv", {
      positionAt,
      orientAt,
      keyframes: [{ t: 0, label: "start" }, { t: t0, label: "flip-start" }, { t: t1, label: "flip-end" }, { t: D, label: "end" }],
      meta: {
        flip: { axis: P.axis, direction: P.direction, turns: P.turns, start: t0, end: t1, peakRateDeg: fd > 0 ? (Math.abs(total) * HALF_PI / fd) / DEG : 0 },
      },
    });
  },
});

const fpvCorridor = defineTechnique({
  id: "fpv.fpv-corridor",
  name: "FPV corridor",
  description: "Flies a dungeon or building route (ctx.indoor.route, e.g. from planIndoorPath, else ctx.path) like an FPV through corridors. Every corner is filleted into an arc (90° turns become quarter circles). A curvature-limited speed profile slows into each turn. The heading looks ahead along the route, so it swings smoothly through the turn, and the craft banks into it. Height stays at the route's height, bounded by indoor floor and ceiling.",
  whenToUse: "Dungeon and interior fly-throughs: down a hallway, round corners, through doorways into a hall. The route's z should already be at camera height (doorway control points at ≈55% of door height).",
  params: {
    cornerRadius: { type: "number", default: 1.5, min: 0.2, max: 20, unit: "m", desc: "Fillet radius of the route corners (capped at 45% of the adjacent legs)." },
    speed: { type: "number", default: 6, min: 0.5, max: 25, unit: "m/s", desc: "Nominal straight-line speed (the fitted profile keeps the duration exact)." },
    amax: { type: "number", default: 4, min: 0.5, max: 30, unit: "m/s²", desc: "Nominal acceleration limit along the route." },
    alat: { type: "number", default: 3, min: 0.5, max: 30, unit: "m/s²", desc: "Lateral acceleration limit in turns (sets turn speed: v ≤ √(alat·r))." },
    lookAhead: { type: "number", default: 3, min: 0.3, max: 30, unit: "m", desc: "How far ahead along the route the camera looks (leads the turns)." },
    heightOffset: { type: "number", default: 0, min: -3, max: 3, unit: "m", desc: "Added to the route's height." },
    tiltDeg: { type: "number", default: 0, min: -30, max: 30, unit: "deg", desc: "Pitch added to the look-ahead direction." },
    bankGain: { type: "number", default: 1.5, min: 0, max: 4, desc: "Bank multiplier (0 = level horizon)." },
    maxBankDeg: { type: "number", default: 35, min: 0, max: 70, unit: "deg", desc: "Largest bank into turns." },
    ends: pEnds,
  },
  needs: { subject: false, path: false, indoor: null },
  defaultBounds: B_CORRIDOR,
  defaultDuration: 10,
  defaultFraming: "WS",
  defaultFov: 75,
  defaultEase: "linear",
  tags: ["fpv", "indoor", "dungeon", "corridor", "90-degree"],
  build(spec, ctx) {
    const P = spec.params;
    const route = ctx.indoor && Array.isArray(ctx.indoor.route) && ctx.indoor.route.length >= 2
      ? ctx.indoor.route
      : Array.isArray(ctx.path) && ctx.path.length >= 2 ? ctx.path : null;
    if (!route) throw contextError(spec, "needs a route: ctx.indoor.route (planIndoorPath) or ctx.path with at least 2 points");
    const points = route.map((p) => [p[0], p[1], p[2]]);
    let hint = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[0][0], dy = points[i][1] - points[0][1];
      if (Math.hypot(dx, dy) > 1e-6) {
        hint = Math.atan2(dx, dy);
        break;
      }
    }
    const F = makeFollower(spec, ctx, points, {
      fillet: P.cornerRadius, vmax: P.speed, amax: P.amax, alat: P.alat, ends: P.ends, zMode: "path", zOffset: P.heightOffset,
      lookAhead: P.lookAhead, tiltDeg: P.tiltDeg, bankGain: P.bankGain, maxBankDeg: P.maxBankDeg, headingHint: hint,
    });
    return finish(spec, ctx, "fpv", {
      positionAt: F.positionAt,
      orientAt: F.orientAt,
      meta: {
        lengthM: F.length, overspeed: F.profile.overspeed, peakSpeed: F.profile.peakSpeed, cornerRadius: P.cornerRadius,
        flightPreset: "fpv",
      },
    });
  },
});

/**
 * Drone technique definitions (`drone.*`, SPEC §2.12), normalised defineTechnique results in
 * catalog order — registered by shots/index.js: flyover, flythrough, orbit-poi, helix, dronie,
 * boom-rise, rising-reveal, tilt-reveal, top-down, top-down-rise, top-down-track, pass-over,
 * parallax-slide, terrain-skim, canyon-run, chase, lead, side-track, boomerang, fly-by,
 * spiral-descent, pano-360, hyperlapse-orbit, vertigo-drone.
 * @type {Array<Readonly<import('./registry.js').TechniqueDef>>}
 */
export const DRONE_TECHNIQUES = [
  flyover, flythrough, orbitPoi, helix, dronie, boomRise, risingReveal, tiltReveal, topDown, topDownRise, topDownTrack,
  passOver, parallaxSlide, terrainSkim, canyonRun, chase, lead, sideTrack, boomerang, flyBy, spiralDescent, pano360,
  hyperlapseOrbit, vertigoDrone,
];

/**
 * FPV technique definitions (`fpv.*`, SPEC §2.12), normalised defineTechnique results —
 * registered by shots/index.js: fpv-dive, fpv-proximity, fpv-gap, fpv-flip, fpv-corridor.
 * @type {Array<Readonly<import('./registry.js').TechniqueDef>>}
 */
export const FPV_TECHNIQUES = [fpvDive, fpvProximity, fpvGap, fpvFlip, fpvCorridor];
