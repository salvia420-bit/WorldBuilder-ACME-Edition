// scene3d/film/shots/classic.js — `classic.*` camera techniques (SPEC §2.12).
//
// WHY: the director (a Claude Code session) writes shots in plan.json by
// technique id — `{technique:'classic.push-in', duration:6, framing:'MCU'}` —
// and expects the grammar of live-action cinematography: locked-off frames,
// pans and tilts on a fixed head (a tilt must reach straight down / straight
// up with no gimbal flip), dollies and pushes between shot sizes, trucks,
// pedestals, jib/crane arcs, arcs and orbits, tracking shots on moving
// subjects (with an operator's spring lag), the vertigo dolly-zoom, whip pans,
// rack focus (the Pose `focus` channel drives the depth-of-field effect),
// dialogue coverage (over-the-shoulder, two-shot), point-of-view, angle shots
// (high, low, bird's-eye at exactly −90°, worm's-eye), body-rig moves
// (handheld, steadicam, snorricam), reveals from behind an occluder and
// time-lapses. Every technique here is a PURE function of the normalised
// ShotSpec and the ShotContext (registry.js): it returns a Trajectory whose
// sample(t) is pure in film time, so scouting, rehearsal and the stepped
// shoot all see the same camera. Springs (tracking lag, body rigs) are
// pre-simulated once at build time on a fixed grid and sampled with cubic
// Hermite interpolation, so they too stay pure in t.
//
// Conventions (SPEC §1): AC world metres (x east, y north, z up); compass
// headings clockwise from north; pitch + looks up, [−π/2, π/2] inclusive;
// roll + = top of frame moves right. Degrees appear only in parameter names
// ending in `Deg`. A subject is `{pos (BASE), height, radius, heading?,
// velocity?}`. Techniques whose `needs.subject` is false also work without a
// subject: the shot then treats `ctx.anchor` as a 1.8 m point of interest.
// "Front" of a subject = its heading; without one, the side facing
// `ctx.anchor`; else the sun side (front-lit); else north. Camera positions
// pass through clampToEnvelope (≥ 0.7 m above `ctx.groundZ` outdoors,
// floor/ceiling indoors) and the camera re-aims from the clamped position.
// Framing distances never go below the subject radius + 0.3 m (min 0.5 m),
// so the lens never enters the subject's body; very tight framings at a wide
// fov therefore come out slightly wider than asked.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks, no Math.random (seeded noise only).

import { FilmShotError } from "../core/errors.js";
import { EASINGS, holdEase, smoothstep } from "../core/easing.js";
import { lookRotation, unwrapAngle } from "../core/gimbal.js";
import { createShake } from "../core/noise.js";
import { deriveSeed } from "../core/rng.js";
import { critDamp, critDampAngle } from "../core/spring.js";
import { isFiniteV } from "../core/vec3.js";
import {
  aimHeightFraction,
  DEFAULT_ASPECT,
  DEFAULT_SUBJECT_HEIGHT,
  distanceForFraming,
  FRAMING_NAMES,
  fovForFraming,
  normalizeSubject,
  thirdsAimOffset,
} from "./framing.js";
import { defineTechnique, REGISTRY_ERROR_CODES } from "./registry.js";
import { clampToEnvelope, makeTrajectory, orientLookAt, subjectAtTime } from "./trajectory.js";

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;
const TAU = 2 * Math.PI;

/** Pre-simulation rate (Hz) of the spring rigs (tracking, steadicam, pov, snorricam). */
const SIM_RATE = 60;
/** Lens standoff beyond the subject's radius (metres) and the absolute minimum distance. */
const STANDOFF_PAD = 0.3;
const MIN_STANDOFF = 0.5;
/** Radius of the virtual 1.8 m point of interest used without a subject. */
const VIRTUAL_RADIUS = 0.45;
/** fov range the techniques produce (degrees), inside the registry's [1, 170]. */
const FOV_MIN = 1;
const FOV_MAX = 170;

/**
 * Every classic technique id, in SPEC §2.12 catalog order (ids are API — the
 * director writes them in plans).
 * @type {ReadonlyArray<string>}
 */
export const CLASSIC_TECHNIQUE_IDS = Object.freeze([
  "classic.static", "classic.pan", "classic.tilt", "classic.roll", "classic.zoom", "classic.dolly-in",
  "classic.dolly-out", "classic.truck", "classic.pedestal", "classic.crane", "classic.arc", "classic.orbit",
  "classic.tracking-follow", "classic.tracking-lead", "classic.tracking-side", "classic.push-in",
  "classic.pull-out-reveal", "classic.dolly-zoom", "classic.whip-pan", "classic.rack-focus",
  "classic.over-the-shoulder", "classic.pov", "classic.two-shot", "classic.establishing", "classic.high-angle",
  "classic.low-angle", "classic.birds-eye", "classic.worms-eye", "classic.handheld", "classic.steadicam",
  "classic.snorricam", "classic.reveal-from-occluder", "classic.time-lapse", "classic.hyperlapse",
]);

// ---------------------------------------------------------------------------
// small math
// ---------------------------------------------------------------------------

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** a→b at u, exact at the ends (u ≤ 0 → a, u ≥ 1 → b). */
function mix(a, b, u) {
  if (u <= 0) return a;
  if (u >= 1) return b;
  return a + (b - a) * u;
}

/** Degrees → radians with ±90° mapped to exactly ±π/2. */
function degToRad(d) {
  if (d === 90) return HALF_PI;
  if (d === -90) return -HALF_PI;
  return d * DEG;
}

/** a + d·s (vec3). */
function addScaled3(a, d, s) {
  return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];
}

/** Unit vector pointing FROM a target TOWARD a camera at compass bearing b and elevation e. */
function awayDir(b, e) {
  const ce = Math.cos(e);
  return [Math.sin(b) * ce, Math.cos(b) * ce, Math.sin(e)];
}

/** Horizontal right of compass heading h (SPEC §1 right(h)). */
function rightH(h) {
  return [Math.cos(h), -Math.sin(h), 0];
}

/** Compass bearing a→b unwrapped next to ref (ref when b is straight above/below a). */
function bearingFromTo(a, b, ref) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (!(dx * dx + dy * dy > 1e-12)) return ref;
  return unwrapAngle(Math.atan2(dx, dy), ref);
}

/** Elevation angle of b seen from a (0 for coincident points). */
function elevationFromTo(a, b) {
  const dz = b[2] - a[2];
  const h = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(h > 1e-12) && !(Math.abs(dz) > 1e-12)) return 0;
  return Math.atan2(dz, h);
}

/** Euclidean distance. */
function dist3(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** True for exactly [0, 0, 0] (the "not given" sentinel of vec3 params). */
function isZeroV(v) {
  return Array.isArray(v) && v[0] === 0 && v[1] === 0 && v[2] === 0;
}

/** FilmShotError (code BAD_PARAM) naming the technique. */
function paramError(id, message, details) {
  return new FilmShotError(`${id}: ${message}`, { code: REGISTRY_ERROR_CODES.BAD_PARAM, details: { technique: id, ...details } });
}

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

/** The spec's easing applied to normalised shot time: (t) → [0, 1], exactly 0 at t ≤ 0 and 1 at t ≥ duration. */
function progressOf(spec) {
  const f = EASINGS[spec.ease] || EASINGS.sineInOut;
  const D = spec.duration;
  return (t) => {
    if (!(D > 0)) return 1;
    const x = t / D;
    if (!(x > 0)) return 0;
    return x >= 1 ? 1 : f(x);
  };
}

/** Largest slope of an easing over [0, 1] (numerical; ≥ 1). */
function peakSlope(f) {
  let m = 1;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const s = (f((i + 1) / n) - f(i / n)) * n;
    if (s > m) m = s;
  }
  return m;
}

// ---------------------------------------------------------------------------
// subjects and placement
// ---------------------------------------------------------------------------

/** The 1.8 m point of interest standing at ctx.anchor (used when the shot has no subject). */
function virtualSubject(ctx) {
  const a = ctx && isFiniteV(ctx.anchor) ? ctx.anchor : [0, 0, 0];
  return { pos: [a[0], a[1], a[2]], height: DEFAULT_SUBJECT_HEIGHT, radius: VIRTUAL_RADIUS, virtual: true };
}

/** Normalised copy of a subject-like value, or null when unusable. */
function asSubject(s) {
  if (s === undefined || s === null) return null;
  if (typeof s === "object" && !Array.isArray(s) && isFiniteV(s.pos) && s.height > 0 && s.radius > 0) return s;
  try {
    return normalizeSubject(s);
  } catch {
    return null;
  }
}

/** (t) → the shot subject at t (ctx.subjectAt / ctx.subject), else the virtual anchor subject. */
function subjectTrack(ctx) {
  const fallback = asSubject(ctx && ctx.subject) || virtualSubject(ctx);
  return (t) => asSubject(subjectAtTime(ctx, t)) || fallback;
}

/**
 * Compass bearing of a subject's FRONT (where a camera stands to see its
 * face): the subject's heading when finite; else the direction from the
 * subject toward `ctx.anchor` when that is ≥ 1 m away horizontally; else the
 * sun's compass bearing (camera on the sun side → front-lit); else 0 (north).
 * @param {{anchor?:number[], sun?:{h:number,p:number}}} ctx
 * @param {{pos:number[], heading?:number}} subject
 * @returns {number} radians
 */
export function frontBearing(ctx, subject) {
  const c = ctx || {};
  if (subject && Number.isFinite(subject.heading)) return subject.heading;
  if (subject && isFiniteV(subject.pos) && isFiniteV(c.anchor)) {
    const dx = c.anchor[0] - subject.pos[0], dy = c.anchor[1] - subject.pos[1];
    if (dx * dx + dy * dy >= 1) return Math.atan2(dx, dy);
  }
  if (c.sun && Number.isFinite(c.sun.h)) return c.sun.h;
  return 0;
}

/** Compass bearing from the subject to the camera from the azimuthDeg / azimuthRef params. */
function placementBearing(params, ctx, s) {
  const az = Number.isFinite(params.azimuthDeg) ? params.azimuthDeg * DEG : 0;
  return (params.azimuthRef === "compass" ? 0 : frontBearing(ctx, s)) + az;
}

/** Closest the lens may get to a subject's aim point (metres). */
function minStandoff(s) {
  return Math.max(MIN_STANDOFF, s.radius + STANDOFF_PAD);
}

/** Camera distance for a framing (the override when > 0), never inside the standoff. */
function framedDistance(framing, s, fovDeg, override) {
  if (Number.isFinite(override) && override > 0) return override;
  return Math.max(minStandoff(s), distanceForFraming(framing, s.height, fovDeg));
}

/** Aim point at `frac`·height (default: the framing's aim height). */
function aimAt(framing, s, frac) {
  const f = frac === undefined ? aimHeightFraction(framing) : frac;
  return [s.pos[0], s.pos[1], s.pos[2] + f * s.height];
}

/** Thirds offset {dh, dp} for 'left' | 'right', else null. */
function thirdsFor(side, fovDeg, aspect) {
  if (side !== "left" && side !== "right") return null;
  return thirdsAimOffset({ side }, fovDeg, Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT);
}

/** Position clamp into the legal envelope (ground / floor / ceiling). */
function envelope(ctx, opts) {
  return (p) => clampToEnvelope(p, ctx, opts);
}

/**
 * Standard rig: the subject at t = 0, the camera bearing / elevation /
 * distance from the placement params and the shot framing.
 * @returns {{S:Function, s0:Object, framing:string|number, fov:number, bearing:number, elev:number, dist:number,
 *   aim0:number[], dir:number[], eye:number[], lookHeading:number}}
 */
function rig(spec, ctx, opts = {}) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const framing = opts.framing !== undefined ? opts.framing : spec.framing;
  const fov = opts.fov !== undefined ? opts.fov : spec.fov;
  const bearing = opts.bearing !== undefined ? opts.bearing : placementBearing(p, ctx, s0);
  const elevDeg = opts.elevationDeg !== undefined ? opts.elevationDeg : Number.isFinite(p.elevationDeg) ? p.elevationDeg : 0;
  const elev = elevDeg * DEG;
  const dist = opts.dist !== undefined ? opts.dist : framedDistance(framing, s0, fov, p.distance);
  const aim0 = aimAt(framing, s0);
  const dir = awayDir(bearing, elev);
  return { S, s0, framing, fov, bearing, elev, dist, aim0, dir, eye: addScaled3(aim0, dir, dist), lookHeading: bearing + Math.PI };
}

/** Look-at orientation on the LIVE subject (aim follows ctx.subjectAt), thirds offset from params.thirds. */
function lookAtLive(spec, ctx, r, o = {}) {
  const aim = o.aim || ((t) => aimAt(r.framing, r.S(t)));
  const offset = o.offset !== undefined ? o.offset : thirdsFor(spec.params.thirds, r.fov, ctx.aspect);
  return orientLookAt(aim, {
    headingHint: o.hint !== undefined ? o.hint : r.lookHeading,
    roll: o.roll !== undefined ? o.roll : spec.roll,
    offset,
  });
}

/** JSON-safe rig summary for meta. */
function rigMeta(r, extra) {
  return {
    rig: {
      bearingDeg: r.bearing / DEG,
      elevationDeg: r.elev / DEG,
      distance: r.dist,
      aim: r.aim0.slice(),
      eye: r.eye.slice(),
      virtualSubject: !!r.s0.virtual,
    },
    ...(extra || {}),
  };
}

/** C¹ soft floor: d when d ≥ floor + k, else floor + k·exp((d − floor − k)/k) (> floor). */
function softFloor(d, floor, k) {
  if (d >= floor + k) return d;
  return floor + k * Math.exp((d - floor - k) / k);
}

/**
 * Keep a spring-rig camera out of the subject's body: the distance to the
 * live aim point never drops below radius + 0.15 m (soft, C¹, 0.1 m band).
 * Positions outside the band are returned unchanged.
 */
function keepOut(p, center, s) {
  const dx = p[0] - center[0], dy = p[1] - center[1], dz = p[2] - center[2];
  const d = Math.hypot(dx, dy, dz);
  const floor = s.radius + 0.15;
  const k = 0.1;
  if (d >= floor + k || !(d > 1e-9)) return p;
  const f = softFloor(d, floor, k) / d;
  return [center[0] + dx * f, center[1] + dy * f, center[2] + dz * f];
}

/** Camera eye pushed `m` metres along the view axis toward the aim (never inside the standoff). */
function pushedEye(r, m, w) {
  const reach = Math.max(0, Math.min(m, r.dist - minStandoff(r.s0)));
  return addScaled3(r.eye, r.dir, -reach * w);
}

/** makeTrajectory with the classic header. */
function finish(spec, ctx, o) {
  return makeTrajectory({
    id: spec.technique,
    technique: spec.technique,
    family: "classic",
    duration: spec.duration,
    positionAt: o.positionAt,
    orientAt: o.orientAt,
    fovAt: o.fovAt !== undefined ? o.fovAt : spec.fov,
    focusAt: o.focusAt,
    keyframes: o.keyframes,
    subject: ctx.subject || undefined,
    meta: o.meta,
  });
}

/** Secondary character for dialogue shots: params.secondary (≠ [0,0,0]) > ctx.secondary > a virtual partner in front. */
function resolveSecondary(spec, ctx, s0) {
  const p = spec.params;
  const h = p.secondaryHeight;
  if (isFiniteV(p.secondary) && !isZeroV(p.secondary)) {
    return { pos: [p.secondary[0], p.secondary[1], p.secondary[2]], height: h, radius: 0.25 * h, source: "param" };
  }
  const fromCtx = asSubject(ctx.secondary);
  if (fromCtx) return { ...fromCtx, source: "ctx" };
  return virtualPartner(ctx, s0, p.partnerM, h);
}

/** A partner standing `distM` in front of the subject, on the ground when known. */
function virtualPartner(ctx, s0, distM, height) {
  const f = frontBearing(ctx, s0);
  const x = s0.pos[0] + Math.sin(f) * distM, y = s0.pos[1] + Math.cos(f) * distM;
  let z = s0.pos[2];
  if (typeof ctx.groundZ === "function") {
    const g = ctx.groundZ(x, y);
    if (typeof g === "number" && Number.isFinite(g)) z = g;
  }
  return { pos: [x, y, z], height, radius: 0.25 * height, source: "virtual" };
}

// ---------------------------------------------------------------------------
// pre-simulated rigs (exported for reuse by other technique lanes)
// ---------------------------------------------------------------------------

/** Cubic Hermite value of one component over a step of length dt. */
function herm(x0, v0, x1, v1, u, dt) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * x0 + (u3 - 2 * u2 + u) * dt * v0 + (-2 * u3 + 3 * u2) * x1 + (u3 - u2) * dt * v1;
}

/** Time derivative of herm. */
function hermRate(x0, v0, x1, v1, u, dt) {
  const u2 = u * u;
  return ((6 * u2 - 6 * u) * x0 + (3 * u2 - 4 * u + 1) * dt * v0 + (-6 * u2 + 6 * u) * x1 + (3 * u2 - 2 * u) * dt * v1) / dt;
}

/** Fixed simulation grid over [0, D] at ≈rate Hz (k = 0..N, last time exactly D). */
function gridOf(D, rate) {
  const N = D > 0 ? Math.max(1, Math.ceil(D * rate - 1e-9)) : 0;
  const dt = N > 0 ? D / N : 0;
  return { N, dt, D, time: (k) => (k >= N ? D : k * dt) };
}

/** Grid cell and fraction of time t (clamped; NaN → 0). */
function locate(g, t) {
  const tc = t > 0 ? (t < g.D ? t : g.D) : 0;
  if (g.N === 0) return { i: 0, u: 0 };
  const x = tc / g.dt;
  let i = Math.floor(x);
  if (i >= g.N) i = g.N - 1;
  if (i < 0) i = 0;
  const u = x - i;
  return { i, u: u < 0 ? 0 : u > 1 ? 1 : u };
}

/** Hermite sampler of a `dim`-component table (X values, V rates, row-major). */
function tableSampler(g, X, V, dim) {
  const pick = (t, fn) => {
    const { i, u } = locate(g, t);
    const out = new Array(dim);
    if (g.N === 0) {
      for (let c = 0; c < dim; c++) out[c] = fn === herm ? X[c] : 0;
      return out;
    }
    const a = i * dim, b = a + dim;
    for (let c = 0; c < dim; c++) out[c] = fn(X[a + c], V[a + c], X[b + c], V[b + c], u, g.dt);
    return out;
  };
  return { value: (t) => pick(t, herm), rate: (t) => pick(t, hermRate) };
}

/** Finite, in-range option or the default. */
function opt(v, def, lo, hi) {
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : def;
}

/**
 * Operator spring lag on a moving target, pre-simulated so the result is PURE
 * in t. The camera point x follows `targetAt(t)` as a critically damped
 * spring (ω = 2/smoothTime) with velocity feed-forward:
 *   x'' = ω²(T − x) + 2ω(ff·F − x'),
 * where F is the target velocity T' clamped to `maxFeedSpeed` and low-pass
 * filtered (τ = smoothTime/4), so a target that JUMPS (an entity position
 * snap) is not launched past — it is followed like a plain spring. Each grid
 * step is solved EXACTLY (target linear within a step), so a target moving at
 * constant velocity is trailed by a constant lag (1 − ff)·|T'|·smoothTime
 * (ff = 1 → no steady lag; the spring only smooths starts, stops and turns).
 * The simulation starts in that steady state (no start-up transient). Samples
 * are cubic-Hermite interpolated (C¹). smoothTime ≈ 0 returns the target.
 * @param {(t:number) => number[]} targetAt pure target position function
 * @param {number} duration seconds ≥ 0
 * @param {{smoothTime?:number, feedForward?:number, maxFeedSpeed?:number, rate?:number}} [opts]
 *   defaults smoothTime 0.5 s, feedForward 1, maxFeedSpeed 30 m/s, rate 60 Hz (10…1000)
 * @returns {{at:(t:number)=>number[], velocityAt:(t:number)=>number[], duration:number}}
 */
export function followSpring(targetAt, duration, opts = {}) {
  if (typeof targetAt !== "function") {
    throw new FilmShotError("followSpring: targetAt(t) → [x,y,z] is required", { code: "BAD_ARGUMENT" });
  }
  if (!(typeof duration === "number" && Number.isFinite(duration) && duration >= 0)) {
    throw new FilmShotError(`followSpring: duration must be a finite number ≥ 0 (got ${duration})`, { code: "BAD_ARGUMENT" });
  }
  const o = opts || {};
  const smoothTime = opt(o.smoothTime, 0.5, 0, 1e6);
  const ff = opt(o.feedForward, 1, 0, 1);
  const maxFeed = opt(o.maxFeedSpeed, 30, 0, 1e6);
  const g = gridOf(duration, opt(o.rate, SIM_RATE, 10, 1000));
  const n = g.N + 1;
  const T = new Float64Array(3 * n);
  for (let k = 0; k < n; k++) {
    const p = targetAt(g.time(k));
    if (!isFiniteV(p)) {
      throw new FilmShotError(`followSpring: target is not a finite [x,y,z] at t=${g.time(k)}`, { code: "NAN_POSE" });
    }
    T[3 * k] = p[0]; T[3 * k + 1] = p[1]; T[3 * k + 2] = p[2];
  }
  const X = new Float64Array(3 * n);
  const V = new Float64Array(3 * n);
  if (g.N === 0) {
    X.set(T);
    return { ...tableAccessors(g, X, V), duration };
  }
  const dt = g.dt;
  const omega = smoothTime > 1e-4 ? 2 / smoothTime : Infinity;
  if (!(omega < Infinity)) {
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1), b = Math.min(g.N, k + 1);
      for (let c = 0; c < 3; c++) {
        X[3 * k + c] = T[3 * k + c];
        V[3 * k + c] = (T[3 * b + c] - T[3 * a + c]) / ((b - a) * dt);
      }
    }
    return { ...tableAccessors(g, X, V), duration };
  }
  const ex = omega * dt > 700 ? 0 : Math.exp(-omega * dt);
  const aF = 1 - Math.exp(-dt / Math.max(dt, 0.25 * smoothTime));
  const stepVel = (k) => [(T[3 * k] - T[3 * k - 3]) / dt, (T[3 * k + 1] - T[3 * k - 2]) / dt, (T[3 * k + 2] - T[3 * k - 1]) / dt];
  const clampFeed = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > maxFeed ? [(v[0] / l) * maxFeed, (v[1] / l) * maxFeed, (v[2] / l) * maxFeed] : v;
  };
  // Steady state at t = 0: x = T + 2(ff·F − T')/ω, x' = T'.
  const vT0 = stepVel(1);
  const F = clampFeed(vT0).slice();
  const x = [0, 0, 0], v = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    x[c] = T[c] + (2 * (ff * F[c] - vT0[c])) / omega;
    v[c] = vT0[c];
    X[c] = x[c];
    V[c] = v[c];
  }
  for (let k = 1; k < n; k++) {
    const vT = stepVel(k);
    const fc = clampFeed(vT);
    for (let c = 0; c < 3; c++) {
      F[c] += (fc[c] - F[c]) * aF;
      // Exact step of e = x − T − lag (target linear at vT, feed F constant over the step).
      const lag = (2 * (ff * F[c] - vT[c])) / omega;
      const t0 = T[3 * (k - 1) + c];
      const e0 = x[c] - t0 - lag;
      const ev0 = v[c] - vT[c];
      const b = ev0 + omega * e0;
      x[c] = T[3 * k + c] + lag + (e0 + b * dt) * ex;
      v[c] = vT[c] + (ev0 - omega * b * dt) * ex;
      X[3 * k + c] = x[c];
      V[3 * k + c] = v[c];
    }
  }
  return { ...tableAccessors(g, X, V), duration };
}

/** {at, velocityAt} over a 3-component table. */
function tableAccessors(g, X, V) {
  const s = tableSampler(g, X, V, 3);
  return { at: s.value, velocityAt: s.rate };
}

/**
 * Smoothed travel heading and speed of the shot subject, pre-simulated so the
 * result is PURE in t. The raw heading is the horizontal velocity direction
 * of `ctx.subjectAt` (central difference over ±window s) while the subject
 * moves faster than `minSpeed`; otherwise its `heading`, else the last travel
 * heading, else frontBearing(ctx). Heading and speed then pass through
 * critically damped springs (turnLag / speedLag) — an operator who turns with
 * the subject a beat late. Headings are continuous (unwrapped), never wrapped.
 * Without a subject the virtual anchor subject is used (constant heading).
 * @param {Object} ctx ShotContext (subject / subjectAt / anchor / sun)
 * @param {number} duration seconds ≥ 0
 * @param {{turnLag?:number, speedLag?:number, minSpeed?:number, window?:number, rate?:number}} [opts]
 *   defaults turnLag 0.8 s, speedLag 0.5 s, minSpeed 0.3 m/s, window 0.12 s, rate 60 Hz
 * @returns {{headingAt:(t:number)=>number, speedAt:(t:number)=>number, headingRateAt:(t:number)=>number,
 *   duration:number}}
 */
export function travelHeadingTrack(ctx, duration, opts = {}) {
  if (!(typeof duration === "number" && Number.isFinite(duration) && duration >= 0)) {
    throw new FilmShotError(`travelHeadingTrack: duration must be a finite number ≥ 0 (got ${duration})`, { code: "BAD_ARGUMENT" });
  }
  const o = opts || {};
  const turnLag = opt(o.turnLag, 0.8, 1e-3, 1e6);
  const speedLag = opt(o.speedLag, 0.5, 1e-3, 1e6);
  const minSpeed = opt(o.minSpeed, 0.3, 0, 1e6);
  const win = opt(o.window, 0.12, 1e-3, 10);
  const c = ctx || {};
  const S = subjectTrack(c);
  const D = duration;
  const g = gridOf(D, opt(o.rate, SIM_RATE, 10, 1000));
  const vel = (t) => {
    const a = clamp(t - win, 0, D), b = clamp(t + win, 0, D);
    if (!(b - a > 1e-9)) return [0, 0];
    const pa = S(a).pos, pb = S(b).pos;
    return [(pb[0] - pa[0]) / (b - a), (pb[1] - pa[1]) / (b - a)];
  };
  const s0 = S(0);
  let held = Number.isFinite(s0.heading) ? s0.heading : frontBearing(c, s0);
  const desired = (t) => {
    const v = vel(t);
    const sp = Math.hypot(v[0], v[1]);
    if (sp > minSpeed) held = unwrapAngle(Math.atan2(v[0], v[1]), held);
    else {
      const s = S(t);
      if (Number.isFinite(s.heading)) held = unwrapAngle(s.heading, held);
    }
    return { h: held, sp: Number.isFinite(sp) ? sp : 0 };
  };
  const n = g.N + 1;
  const X = new Float64Array(2 * n);
  const V = new Float64Array(2 * n);
  const d0 = desired(0);
  let h = d0.h, hv = 0, sp = d0.sp, spv = 0;
  X[0] = h; X[1] = sp;
  for (let k = 1; k < n; k++) {
    const d = desired(g.time(k));
    const rh = critDampAngle(h, hv, d.h, 2 / turnLag, g.dt);
    const rs = critDamp(sp, spv, d.sp, 2 / speedLag, g.dt);
    h = rh.x; hv = rh.v; sp = rs.x; spv = rs.v;
    X[2 * k] = h; V[2 * k] = hv; X[2 * k + 1] = sp; V[2 * k + 1] = spv;
  }
  const s = tableSampler(g, X, V, 2);
  return {
    headingAt: (t) => s.value(t)[0],
    speedAt: (t) => Math.max(0, s.value(t)[1]),
    headingRateAt: (t) => s.rate(t)[0],
    duration,
  };
}

// ---------------------------------------------------------------------------
// parameter schemas (shared fragments)
// ---------------------------------------------------------------------------

const P_AZIMUTH = (def = 0, desc) => ({
  type: "number", default: def, min: -360, max: 360, unit: "deg",
  desc: desc || "Camera position around the subject, measured from azimuthRef: 0 = in front of the subject (facing it), +90 = on its right, −90 = on its left, ±180 = behind it.",
});
const P_AZIMUTH_REF = () => ({
  type: "enum", values: ["front", "compass"], default: "front",
  desc: "front: azimuthDeg is relative to the subject's front (its heading; else the side facing ctx.anchor; else the sun side; else north). compass: azimuthDeg is the compass bearing from the subject to the camera (0 = camera north of the subject).",
});
const P_ELEVATION = (def = 5, min = -60, max = 85) => ({
  type: "number", default: def, min, max, unit: "deg",
  desc: "Camera elevation above the aim point as seen from the subject (+ = camera above, looking down; − = below, looking up).",
});
const P_DISTANCE = (def = 0) => ({
  type: "number", default: def, min: 0, max: 5000, unit: "m",
  desc: "Camera distance from the aim point; 0 = derived from the shot framing and fov (distanceForFraming).",
});
const P_THIRDS = (def = "center") => ({
  type: "enum", values: ["center", "left", "right"], default: def,
  desc: "Where the subject sits horizontally: centred, or on the left / right third line.",
});
const P_FRAMING = (def, desc) => ({ type: "enum", values: FRAMING_NAMES.slice(), default: def, desc });
const P_PROFILE = (def) => ({
  type: "enum", values: ["linear", "perceptual"], default: def,
  desc: "linear: the distance changes at the eased dolly speed (screen size accelerates near the subject). perceptual: the distance changes geometrically, so the subject's screen size changes at an even rate (best for big CU↔EWS moves).",
});
const P_LR = (def = "right", desc) => ({ type: "enum", values: ["right", "left"], default: def, desc });

/** Placement fragment shared by framed techniques. */
function placementParams({ elevation = 5, elevMin = -60, elevMax = 85, thirds = true, distance = true } = {}) {
  const out = { azimuthDeg: P_AZIMUTH(), azimuthRef: P_AZIMUTH_REF(), elevationDeg: P_ELEVATION(elevation, elevMin, elevMax) };
  if (distance) out.distance = P_DISTANCE();
  if (thirds) out.thirds = P_THIRDS();
  return out;
}

/** Secondary-character fragment (over-the-shoulder, two-shot). */
function secondaryParams() {
  return {
    secondary: {
      type: "vec3", default: [0, 0, 0], unit: "m",
      desc: "World position of the SECOND character's base (feet). [0,0,0] = not given: use ctx.secondary, else a virtual partner partnerM in front of the subject.",
    },
    secondaryHeight: { type: "number", default: 1.8, min: 0.3, max: 50, unit: "m", desc: "Height of the second character." },
    partnerM: { type: "number", default: 1.6, min: 0.5, max: 30, unit: "m", desc: "Distance of the virtual partner in front of the subject when no secondary is given." },
  };
}

/** Pilot bound presets (SPEC §2.9 Bounds). */
const BOUNDS = Object.freeze({
  locked: { maxLateral: 0.5, maxRise: 0.5, maxSink: 0.3, minSpeedScale: 0.5, maxSpeedScale: 1, maxDistanceScale: 1.1 },
  move: { maxLateral: 1.5, maxRise: 1.5, maxSink: 0.8, minSpeedScale: 0.25, maxSpeedScale: 1.25, maxDistanceScale: 1.25 },
  close: { maxLateral: 0.6, maxRise: 0.5, maxSink: 0.3, minSpeedScale: 0.25, maxSpeedScale: 1.25, maxDistanceScale: 1.15 },
  track: { maxLateral: 2, maxRise: 1.5, maxSink: 0.8, minSpeedScale: 1, maxSpeedScale: 1, maxDistanceScale: 1.3 },
  wide: { maxLateral: 6, maxRise: 6, maxSink: 3, minSpeedScale: 0.25, maxSpeedScale: 1.25, maxDistanceScale: 1.3 },
  overhead: { maxLateral: 2, maxRise: 4, maxSink: 2, minSpeedScale: 0.25, maxSpeedScale: 1.25, maxDistanceScale: 1.3 },
  body: { maxLateral: 0.15, maxRise: 0.15, maxSink: 0.1, minSpeedScale: 1, maxSpeedScale: 1, maxDistanceScale: 1.05 },
  ground: { maxLateral: 0.8, maxRise: 0.4, maxSink: 0, minSpeedScale: 0.5, maxSpeedScale: 1, maxDistanceScale: 1.15 },
  timed: { maxLateral: 0.3, maxRise: 0.3, maxSink: 0.2, minSpeedScale: 1, maxSpeedScale: 1, maxDistanceScale: 1.05 },
});

// ---------------------------------------------------------------------------
// builders — fixed-rig shots
// ---------------------------------------------------------------------------

/** classic.static / classic.time-lapse: a locked-off frame on the subject. */
function buildLocked(spec, ctx, extraMeta) {
  const r = rig(spec, ctx);
  const eye = envelope(ctx)(r.eye);
  return finish(spec, ctx, { positionAt: eye, orientAt: lookAtLive(spec, ctx, r), meta: rigMeta(r, extraMeta) });
}

/** classic.pan: fixed head, heading sweeps; pitch holds the subject's elevation. */
function buildPan(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const eye = envelope(ctx)(r.eye);
  const from = p.fromDeg * DEG, to = p.toDeg * DEG;
  let orientAt;
  if (p.relative) {
    orientAt = (t) => {
      const a = aimAt(r.framing, r.S(t));
      return { h: bearingFromTo(eye, a, r.lookHeading) + mix(from, to, u(t)), p: elevationFromTo(eye, a), r: spec.roll };
    };
  } else {
    if (Math.abs(p.pitchDeg) > 90) throw paramError(spec.technique, `pitchDeg must be within [−90, 90] (got ${p.pitchDeg})`, { param: "pitchDeg" });
    const pitch = degToRad(p.pitchDeg);
    orientAt = (t) => ({ h: mix(from, to, u(t)), p: pitch, r: spec.roll });
  }
  return finish(spec, ctx, { positionAt: eye, orientAt, meta: rigMeta(r, { pan: { fromDeg: p.fromDeg, toDeg: p.toDeg, relative: p.relative } }) });
}

/** classic.tilt: fixed head, pitch sweeps (reaches ±90° exactly, heading held → no flip). */
function buildTilt(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const eye = envelope(ctx)(r.eye);
  const h0 = bearingFromTo(eye, r.aim0, r.lookHeading);
  let pitchAt;
  if (p.relative) {
    const from = p.fromDeg * DEG, to = p.toDeg * DEG;
    pitchAt = (t) => clamp(elevationFromTo(eye, aimAt(r.framing, r.S(t))) + mix(from, to, u(t)), -HALF_PI, HALF_PI);
  } else {
    for (const k of ["fromDeg", "toDeg"]) {
      if (Math.abs(p[k]) > 90) {
        throw paramError(spec.technique, `absolute ${k} must be within [−90, 90] (−90 = straight down, +90 = straight up; got ${p[k]})`, { param: k });
      }
    }
    const from = degToRad(p.fromDeg), to = degToRad(p.toDeg);
    pitchAt = (t) => clamp(mix(from, to, u(t)), -HALF_PI, HALF_PI);
  }
  return finish(spec, ctx, {
    positionAt: eye,
    orientAt: (t) => ({ h: h0, p: pitchAt(t), r: spec.roll }),
    meta: rigMeta(r, { tilt: { fromDeg: p.fromDeg, toDeg: p.toDeg, relative: p.relative } }),
  });
}

/** classic.roll: framed shot with a static or animated dutch angle (+ optional slow push). */
function buildRoll(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const from = p.fromDeg * DEG, to = p.toDeg * DEG;
  return finish(spec, ctx, {
    positionAt: (t) => env(pushedEye(r, p.pushM, u(t))),
    orientAt: lookAtLive(spec, ctx, r, { roll: (t) => spec.roll + mix(from, to, u(t)) }),
    meta: rigMeta(r, { dutch: { fromDeg: p.fromDeg, toDeg: p.toDeg } }),
  });
}

/** classic.zoom: locked camera, fov only (log-magnification interpolation), aim eases to the new framing's height. */
function buildZoom(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const eye = envelope(ctx)(r.eye);
  const fov0 = spec.fov;
  const fov1 = p.toFovDeg > 0 ? p.toFovDeg : clamp(fovForFraming(p.toFraming, r.s0.height, dist3(eye, r.aim0)), FOV_MIN, FOV_MAX);
  const k0 = Math.log(Math.tan((fov0 * DEG) / 2)), k1 = Math.log(Math.tan((fov1 * DEG) / 2));
  const fovAt = (t) => {
    const w = u(t);
    if (w <= 0) return fov0;
    if (w >= 1) return fov1;
    return clamp((2 * Math.atan(Math.exp(k0 + (k1 - k0) * w))) / DEG, FOV_MIN, FOV_MAX);
  };
  const f0 = aimHeightFraction(r.framing), f1 = aimHeightFraction(p.toFraming);
  const aim = (t) => aimAt(null, r.S(t), mix(f0, f1, u(t)));
  const side = p.thirds;
  const offset = side === "left" || side === "right" ? (t) => thirdsFor(side, fovAt(t), ctx.aspect) : null;
  return finish(spec, ctx, {
    positionAt: eye,
    orientAt: lookAtLive(spec, ctx, r, { aim, offset }),
    fovAt,
    meta: rigMeta(r, { zoom: { fromFovDeg: fov0, toFovDeg: fov1 } }),
  });
}

/** Dolly family: move along the view axis between two framings (dolly-in/out, push-in, pull-out-reveal). */
function buildDollyMove(spec, ctx, fromFraming, toFraming, o) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const fov = spec.fov;
  const b = placementBearing(p, ctx, s0);
  const d0 = framedDistance(fromFraming, s0, fov, 0);
  const d1 = framedDistance(toFraming, s0, fov, 0);
  const f0 = aimHeightFraction(fromFraming), f1 = aimHeightFraction(toFraming);
  const e0 = o.elevFromDeg * DEG, e1 = o.elevToDeg * DEG;
  const u = progressOf(spec);
  const perceptual = o.profile === "perceptual";
  const lr = Math.log(d1 / d0);
  const distAt = (w) => (w >= 1 ? d1 : perceptual ? d0 * Math.exp(lr * w) : mix(d0, d1, w));
  const env = envelope(ctx);
  const positionAt = (t) => {
    const w = u(t);
    return env(addScaled3(aimAt(null, s0, mix(f0, f1, w)), awayDir(b, mix(e0, e1, w)), distAt(w)));
  };
  const aim = (t) => aimAt(null, S(t), mix(f0, f1, u(t)));
  const r = { S, s0, framing: toFraming, fov, bearing: b, elev: e0, dist: d0, aim0: aimAt(null, s0, f0), eye: positionAt(0), lookHeading: b + Math.PI };
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r, { aim }),
    meta: rigMeta(r, { dolly: { fromFraming, toFraming, fromDistance: d0, toDistance: d1, profile: o.profile, ...(o.meta || {}) } }),
  });
}

/** classic.dolly-zoom: dolly along the axis while fov(t) keeps the subject's frame height constant. */
function buildDollyZoom(spec, ctx) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const framing = spec.framing;
  const H = s0.height;
  const b = placementBearing(p, ctx, s0);
  const e = p.elevationDeg * DEG;
  const d0 = framedDistance(framing, s0, spec.fov, 0);
  const d1 = framedDistance(framing, s0, p.toFovDeg, 0);
  const u = progressOf(spec);
  const distAt = (t) => mix(d0, d1, u(t));
  const fovAt = (t) => clamp(fovForFraming(framing, H, distAt(t)), FOV_MIN, FOV_MAX);
  const aim0 = aimAt(framing, s0);
  const env = envelope(ctx);
  const dir = awayDir(b, e);
  const r = { S, s0, framing, fov: spec.fov, bearing: b, elev: e, dist: d0, aim0, eye: addScaled3(aim0, dir, d0), lookHeading: b + Math.PI };
  return finish(spec, ctx, {
    positionAt: (t) => env(addScaled3(aim0, dir, distAt(t))),
    orientAt: lookAtLive(spec, ctx, r, { offset: null }),
    fovAt,
    meta: rigMeta(r, { dollyZoom: { fromDistance: d0, toDistance: d1, fromFovDeg: fovAt(0), toFovDeg: fovAt(spec.duration) } }),
  });
}

/** Horizontal right vector of a camera at `eye` looking at `target` (fallback: heading). */
function viewRight(eye, target, heading) {
  const dx = target[0] - eye[0], dy = target[1] - eye[1];
  const l = Math.hypot(dx, dy);
  if (!(l > 1e-6)) return rightH(heading);
  return [dy / l, -dx / l, 0];
}

/** classic.truck: lateral move across the view axis, keepAim pans to hold the subject. */
function buildTruck(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const right = viewRight(r.eye, r.aim0, r.lookHeading);
  const sgn = p.direction === "right" ? 1 : -1;
  const positionAt = (t) => env(addScaled3(r.eye, right, sgn * p.travelM * (u(t) - 0.5)));
  let orientAt;
  if (p.keepAim) orientAt = lookAtLive(spec, ctx, r);
  else {
    const la = lookRotation(r.eye, r.aim0, { headingHint: r.lookHeading, roll: spec.roll });
    orientAt = { h: la.h, p: la.p, r: spec.roll };
  }
  return finish(spec, ctx, { positionAt, orientAt, meta: rigMeta(r, { truck: { travelM: p.travelM, direction: p.direction, keepAim: p.keepAim } }) });
}

/** classic.pedestal: vertical rise/sink; keepAim tilts to hold the subject. */
function buildPedestal(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const positionAt = (t) => env([r.eye[0], r.eye[1], r.eye[2] + p.riseM * u(t)]);
  let orientAt;
  if (p.keepAim) orientAt = lookAtLive(spec, ctx, r);
  else {
    const start = positionAt(0);
    const la = lookRotation(start, r.aim0, { headingHint: r.lookHeading, roll: spec.roll });
    orientAt = { h: la.h, p: la.p, r: spec.roll };
  }
  return finish(spec, ctx, { positionAt, orientAt, meta: rigMeta(r, { pedestal: { riseM: p.riseM, keepAim: p.keepAim } }) });
}

/** classic.crane: jib-arm arc — the tip rises through a symmetric elevation sweep and swings about the base. */
function buildCrane(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const rise = p.riseM;
  const A = Math.max(p.armM, Math.abs(rise) / 1.9);
  const el0 = -Math.asin(clamp(rise / (2 * A), -0.95, 0.95));
  const el1 = -el0;
  const psi0 = r.lookHeading;
  const swing = p.swingDeg * DEG;
  const arm = (psi, el) => [Math.sin(psi) * Math.cos(el) * A, Math.cos(psi) * Math.cos(el) * A, Math.sin(el) * A];
  const a0 = arm(psi0, el0);
  const base = [r.eye[0] - a0[0], r.eye[1] - a0[1], r.eye[2] - a0[2]];
  const positionAt = (t) => {
    const w = u(t);
    const a = arm(psi0 + swing * w, mix(el0, el1, w));
    return env([base[0] + a[0], base[1] + a[1], base[2] + a[2]]);
  };
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r),
    meta: rigMeta(r, { crane: { armM: A, riseM: rise, swingDeg: p.swingDeg, base } }),
  });
}

/** classic.arc / classic.orbit: circle the (live) subject at constant distance and elevation. */
function buildOrbitLike(spec, ctx, totalRad, centred) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const sgn = p.direction === "ccw" ? -1 : 1;
  const start = centred ? r.bearing - (sgn * totalRad) / 2 : r.bearing;
  const bearingAt = (t) => start + sgn * totalRad * u(t);
  const positionAt = (t) => env(addScaled3(aimAt(r.framing, r.S(t)), awayDir(bearingAt(t), r.elev), r.dist));
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r, { hint: (t) => bearingAt(t) + Math.PI }),
    meta: rigMeta(r, { orbit: { startBearingDeg: start / DEG, sweepDeg: (sgn * totalRad) / DEG } }),
  });
}

/** classic.whip-pan: hold, a very fast continuous pan (≤ 0.35 s), hold. */
function buildWhip(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const D = spec.duration;
  const eye = envelope(ctx)(r.eye);
  const f = EASINGS[spec.ease] || EASINGS.sineInOut;
  const w = Math.min(p.whipSec, 0.8 * D);
  const tc = clamp(p.at * D, w / 2, D - w / 2);
  const ta = tc - w / 2, tb = tc + w / 2;
  const sgn = p.direction === "right" ? 1 : -1;
  const ang = p.angleDeg * DEG;
  const off0 = p.land === "subject" ? -sgn * ang : 0;
  const off1 = p.land === "subject" ? 0 : sgn * ang;
  const offsetAt = (t) => (t <= ta ? off0 : t >= tb ? off1 : off0 + (off1 - off0) * f((t - ta) / w));
  const orientAt = (t) => {
    const a = aimAt(r.framing, r.S(t));
    return { h: bearingFromTo(eye, a, r.lookHeading) + offsetAt(t), p: elevationFromTo(eye, a), r: spec.roll };
  };
  const peakDegPerSec = (peakSlope(f) * p.angleDeg) / w;
  return finish(spec, ctx, {
    positionAt: eye,
    orientAt,
    keyframes: [{ t: 0, label: "hold" }, { t: ta, label: "whip-start" }, { t: tb, label: "whip-end" }, { t: D, label: "end" }],
    meta: rigMeta(r, {
      whip: { startSec: ta, endSec: tb, angleDeg: p.angleDeg, direction: p.direction, land: p.land, peakDegPerSec },
      motionLimits: { maxAngularSpeedDeg: Math.ceil(1.25 * peakDegPerSec + 30) },
    }),
  });
}

/** classic.rack-focus: locked (or slowly drifting) frame; the focus channel pulls from→to around `at`. */
function buildRackFocus(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const D = spec.duration;
  const env = envelope(ctx);
  const drift = (t) => (D > 0 ? clamp(t / D, 0, 1) : 1);
  const positionAt = (t) => env(pushedEye(r, p.driftM, smoothstep(drift(t))));
  const subjDist = (t) => Math.max(0.1, dist3(positionAt(t), aimAt(r.framing, r.S(t))));
  const d0 = subjDist(0);
  const target = (kind, m) => {
    if (kind === "subject") return subjDist;
    if (kind === "foreground") {
      const v = Math.max(0.3, 0.35 * d0);
      return () => v;
    }
    if (kind === "background") {
      const v = Math.max(3 * d0, d0 + 10);
      return () => v;
    }
    return () => m;
  };
  const from = target(p.fromTarget, p.fromM);
  const to = target(p.toTarget, p.toM);
  const f = EASINGS[spec.ease] || EASINGS.sineInOut;
  const pull = Math.min(p.pullSec, D);
  const tc = clamp(p.at * D, pull / 2, D - pull / 2);
  const ta = tc - pull / 2;
  const wAt = (t) => (pull > 0 ? (t <= ta ? 0 : t >= ta + pull ? 1 : f((t - ta) / pull)) : t >= tc ? 1 : 0);
  const focusAt = (t) => {
    const w = wAt(t);
    const a = from(t), b = to(t);
    return w <= 0 ? a : w >= 1 ? b : a + (b - a) * w;
  };
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r),
    focusAt,
    keyframes: [{ t: 0, label: "from" }, { t: ta, label: "pull-start" }, { t: Math.min(D, ta + pull), label: "pull-end" }, { t: D, label: "end" }],
    meta: rigMeta(r, { rackFocus: { fromM: focusAt(0), toM: focusAt(D), pullStartSec: ta, pullSec: pull, fromTarget: p.fromTarget, toTarget: p.toTarget } }),
  });
}

/** classic.over-the-shoulder: camera behind the secondary's shoulder, framing the subject on the shoulder-side third. */
function buildOts(spec, ctx) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  let B = resolveSecondary(spec, ctx, s0);
  if (Math.hypot(s0.pos[0] - B.pos[0], s0.pos[1] - B.pos[1]) < 0.3) B = virtualPartner(ctx, s0, p.partnerM, p.secondaryHeight);
  const ux0 = s0.pos[0] - B.pos[0], uy0 = s0.pos[1] - B.pos[1];
  const ul = Math.hypot(ux0, uy0);
  const u = [ux0 / ul, uy0 / ul, 0];
  const rB = [u[1], -u[0], 0];
  const sgn = p.shoulder === "right" ? 1 : -1;
  const shoulderZ = B.pos[2] + 0.82 * B.height + p.raiseM;
  const c0 = [B.pos[0] - u[0] * p.backM + rB[0] * sgn * p.shoulderM, B.pos[1] - u[1] * p.backM + rB[1] * sgn * p.shoulderM, shoulderZ];
  const aim0 = aimAt(spec.framing, s0);
  const d0 = dist3(c0, aim0);
  const fov = p.autoFov ? clamp(fovForFraming(spec.framing, s0.height, d0), 8, 90) : spec.fov;
  const dirIn = [(aim0[0] - c0[0]) / d0, (aim0[1] - c0[1]) / d0, (aim0[2] - c0[2]) / d0];
  const push = Math.max(0, Math.min(p.pushM, d0 - minStandoff(s0)));
  const prog = progressOf(spec);
  const env = envelope(ctx);
  const positionAt = (t) => env(addScaled3(c0, dirIn, push * prog(t)));
  const look = Math.atan2(u[0], u[1]);
  const r = { S, s0, framing: spec.framing, fov, bearing: look + Math.PI, elev: elevationFromTo(aim0, c0), dist: d0, aim0, eye: c0, lookHeading: look };
  const offset = p.composeThirds ? thirdsFor(p.shoulder, fov, ctx.aspect) : null;
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r, { offset }),
    fovAt: fov,
    meta: rigMeta(r, { secondary: { pos: B.pos.slice(), height: B.height, source: B.source }, shoulder: p.shoulder }),
  });
}

/** classic.two-shot: camera perpendicular to the subject↔secondary line, wide enough for both. */
function buildTwoShot(spec, ctx) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  let B = resolveSecondary(spec, ctx, s0);
  if (Math.hypot(B.pos[0] - s0.pos[0], B.pos[1] - s0.pos[1]) < 0.3) B = virtualPartner(ctx, s0, p.partnerM, p.secondaryHeight);
  const fA = aimHeightFraction(spec.framing);
  const mid = (sA) => {
    const a = aimAt(null, sA, fA), b = aimAt(null, B, fA);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  };
  const m0 = mid(s0);
  const ab = [B.pos[0] - s0.pos[0], B.pos[1] - s0.pos[1]];
  const L = Math.hypot(ab[0], ab[1]);
  const lineH = Math.atan2(ab[0], ab[1]);
  // Side of the A→B line the camera stands on: left normal = lineH − 90°, right = lineH + 90°.
  let side = p.side;
  if (side === "auto") {
    const pick = (dx, dy) => {
      const l = Math.hypot(dx, dy);
      if (!(l >= 1)) return null;
      const s = Math.sin(lineH + HALF_PI) * dx / l + Math.cos(lineH + HALF_PI) * dy / l;
      return Math.abs(s) > 0.05 ? (s > 0 ? "right" : "left") : null;
    };
    side = (isFiniteV(ctx.anchor) && pick(ctx.anchor[0] - m0[0], ctx.anchor[1] - m0[1]))
      || (ctx.sun && Number.isFinite(ctx.sun.h) && pick(2 * Math.sin(ctx.sun.h), 2 * Math.cos(ctx.sun.h)))
      || "left";
  }
  const b0 = lineH + (side === "right" ? HALF_PI : -HALF_PI);
  const asp = Number.isFinite(ctx.aspect) && ctx.aspect > 0 ? ctx.aspect : DEFAULT_ASPECT;
  const tanH = Math.tan((spec.fov * DEG) / 2) * asp;
  const halfW = L / 2 + Math.max(s0.radius, B.radius) + 0.3;
  const dW = halfW / (0.85 * tanH);
  const taller = s0.height >= B.height ? s0 : B;
  const dH = framedDistance(spec.framing, taller, spec.fov, 0);
  const d = p.distance > 0 ? p.distance : Math.max(dW, dH);
  const e = p.elevationDeg * DEG;
  const u = progressOf(spec);
  const drift = p.driftDeg * DEG;
  const bearingAt = (t) => b0 + drift * (u(t) - 0.5);
  const env = envelope(ctx);
  const positionAt = (t) => env(addScaled3(m0, awayDir(bearingAt(t), e), d));
  const r = { S, s0, framing: spec.framing, fov: spec.fov, bearing: b0, elev: e, dist: d, aim0: m0, eye: addScaled3(m0, awayDir(b0, e), d), lookHeading: b0 + Math.PI };
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r, { aim: (t) => mid(S(t)), hint: (t) => bearingAt(t) + Math.PI, offset: null }),
    meta: rigMeta(r, { secondary: { pos: B.pos.slice(), height: B.height, source: B.source }, side }),
  });
}

/** classic.establishing: wide, high, slow drift (arc + push) over the setting. */
function buildEstablishing(spec, ctx) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const b0 = placementBearing(p, ctx, s0);
  const u = progressOf(spec);
  const R0 = p.distance;
  const drift = p.driftDeg * DEG;
  const push = p.pushPct / 100;
  const zCam = s0.pos[2] + p.heightM;
  const bearingAt = (t) => b0 + drift * (u(t) - 0.5);
  const env = envelope(ctx);
  const positionAt = (t) => {
    const R = R0 * (1 - push * u(t));
    const b = bearingAt(t);
    return env([s0.pos[0] + Math.sin(b) * R, s0.pos[1] + Math.cos(b) * R, zCam]);
  };
  const aim0 = aimAt(spec.framing, s0);
  const eye0 = positionAt(0);
  const r = { S, s0, framing: spec.framing, fov: spec.fov, bearing: b0, elev: elevationFromTo(aim0, eye0), dist: dist3(eye0, aim0), aim0, eye: eye0, lookHeading: b0 + Math.PI };
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r, { hint: (t) => bearingAt(t) + Math.PI }),
    meta: rigMeta(r, { establishing: { distance: R0, heightM: p.heightM, driftDeg: p.driftDeg, pushPct: p.pushPct } }),
  });
}

/** classic.high-angle / classic.low-angle: elevation-defined angle shots with a slow push. */
function buildAngle(spec, ctx, envOpts) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx, envOpts);
  return finish(spec, ctx, {
    positionAt: (t) => env(pushedEye(r, p.pushM, u(t))),
    orientAt: lookAtLive(spec, ctx, r),
    meta: rigMeta(r),
  });
}

/** classic.birds-eye: straight down (p = −π/2 exactly) over the subject; heading change = image rotation. */
function buildBirdsEye(spec, ctx) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const u = progressOf(spec);
  const h0 = placementBearing(p, ctx, s0);
  const minAlt = s0.height + 0.5;
  const alt0 = p.heightM > 0 ? p.heightM : Math.max(s0.height + 1.5, framedDistance(spec.framing, s0, spec.fov, 0));
  if (alt0 < minAlt || alt0 + p.riseM < minAlt) {
    throw paramError(spec.technique, `the camera must stay ≥ ${minAlt.toFixed(2)} m above the subject's base (heightM ${alt0.toFixed(2)}, riseM ${p.riseM})`, { param: "riseM" });
  }
  const rot = p.rotateDeg * DEG;
  const env = envelope(ctx);
  const positionAt = (t) => env([s0.pos[0], s0.pos[1], s0.pos[2] + alt0 + p.riseM * u(t)]);
  const aim0 = aimAt(spec.framing, s0);
  const eye0 = positionAt(0);
  const r = { S, s0, framing: spec.framing, fov: spec.fov, bearing: h0, elev: HALF_PI, dist: dist3(eye0, aim0), aim0, eye: eye0, lookHeading: h0 };
  return finish(spec, ctx, {
    positionAt,
    orientAt: (t) => ({ h: h0 + rot * u(t), p: -HALF_PI, r: spec.roll }),
    meta: rigMeta(r, { birdsEye: { altitude: alt0, riseM: p.riseM, rotateDeg: p.rotateDeg } }),
  });
}

/** classic.worms-eye: lens just above the ground, close to the subject, looking up steeply. */
function buildWormsEye(spec, ctx) {
  const p = spec.params;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const b = placementBearing(p, ctx, s0);
  const hor = p.horizontalM > 0 ? p.horizontalM : Math.max(s0.radius + 0.45, 0.9);
  const x = s0.pos[0] + Math.sin(b) * hor, y = s0.pos[1] + Math.cos(b) * hor;
  let gz = typeof ctx.groundZ === "function" ? ctx.groundZ(x, y) : null;
  if (!(typeof gz === "number" && Number.isFinite(gz))) gz = s0.pos[2];
  const eye = clampToEnvelope([x, y, gz + p.heightM], ctx, { soft: 0.05 });
  const u = progressOf(spec);
  const spin = p.spinDeg * DEG;
  const aim0 = aimAt(spec.framing, s0);
  const r = { S, s0, framing: spec.framing, fov: spec.fov, bearing: b, elev: elevationFromTo(aim0, eye), dist: dist3(eye, aim0), aim0, eye, lookHeading: b + Math.PI };
  return finish(spec, ctx, {
    positionAt: eye,
    orientAt: lookAtLive(spec, ctx, r, { roll: (t) => spec.roll + spin * u(t), offset: null }),
    meta: rigMeta(r, { wormsEye: { heightM: p.heightM, horizontalM: hor } }),
  });
}

/** classic.handheld: static or push-in base + seeded, bounded, time-pure shake. */
function buildHandheld(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const shake = createShake({
    seed: deriveSeed(ctx.seed, "classic.handheld"),
    amplitudeDeg: p.amplitudeDeg, frequencyHz: p.frequencyHz, posAmplitude: p.posAmplitude, roughness: p.roughness,
  });
  const push = p.base === "push-in" ? p.pushM : 0;
  const look = lookAtLive(spec, ctx, r);
  const basePos = (t) => env(pushedEye(r, push, u(t)));
  const positionAt = (t) => {
    const s = shake(t);
    const base = pushedEye(r, push, u(t));
    return env([base[0] + s.dpos[0], base[1] + s.dpos[1], base[2] + s.dpos[2]]);
  };
  // The operator aims from the UNSHAKEN base; the positional shake then reads
  // on screen (the subject wobbles in frame) instead of being re-aimed away.
  const orientAt = (t) => {
    const o = look(t, basePos(t));
    const s = shake(t);
    return { h: o.h + s.dh, p: o.p + s.dp, r: o.r + s.dr };
  };
  return finish(spec, ctx, { positionAt, orientAt, meta: rigMeta(r, { handheld: { base: p.base, amplitudeDeg: p.amplitudeDeg, seed: ctx.seed >>> 0 } }) });
}

/** classic.reveal-from-occluder: start with the occluder hiding the subject, truck until the subject clears it. */
function buildReveal(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const A = r.aim0;
  let occ, occR = p.occluderRadius, source = "param";
  let ux, uy, dOS;
  if (isFiniteV(p.occluder) && !isZeroV(p.occluder)) {
    occ = [p.occluder[0], p.occluder[1], p.occluder[2]];
    ux = occ[0] - A[0]; uy = occ[1] - A[1];
    dOS = Math.hypot(ux, uy);
  }
  if (!occ || dOS < 0.05) {
    // Virtual occluder 45% of the way to the framed camera position, but clear of the subject's body.
    source = "virtual";
    const hd = Math.max(1e-6, r.dist * Math.cos(r.elev));
    dOS = Math.max(0.45 * hd, occR + r.s0.radius + 0.5);
    ux = Math.sin(r.bearing) * dOS; uy = Math.cos(r.bearing) * dOS;
    occ = [A[0] + ux, A[1] + uy, r.s0.pos[2]];
  }
  const ud = [ux / dOS, uy / dOS];
  const horiz = Math.max(r.dist * Math.cos(r.elev), dOS + Math.max(1.0, occR + 0.6));
  const z0 = A[2] + horiz * Math.tan(r.elev);
  const c0 = [A[0] + ud[0] * horiz, A[1] + ud[1] * horiz, z0];
  // Camera right when looking from c0 toward the subject (forward = −ud).
  const right = [-ud[1], ud[0], 0];
  const sgn = p.direction === "right" ? 1 : -1;
  const clearance = occR + r.s0.radius + p.marginM;
  const lateral = Math.min(3 * horiz, (1.1 * clearance * horiz) / dOS);
  const f = (t) => holdEase(spec.duration > 0 ? t / spec.duration : 1, p.holdFrac, p.settleFrac, spec.ease);
  const env = envelope(ctx);
  const positionAt = (t) => env(addScaled3(c0, right, sgn * lateral * f(t)));
  const look = Math.atan2(-ud[0], -ud[1]);
  const rr = { ...r, eye: c0, bearing: look + Math.PI, lookHeading: look, dist: dist3(c0, A) };
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, rr),
    meta: rigMeta(rr, { revealOccluder: { pos: occ.slice(), radius: occR, source }, reveal: { lateralM: lateral, direction: p.direction } }),
  });
}

/** classic.hyperlapse: slow move (truck / push / arc) with time-lapse sky. */
function buildHyperlapse(spec, ctx) {
  const p = spec.params;
  const r = rig(spec, ctx);
  const u = progressOf(spec);
  const env = envelope(ctx);
  const sgn = p.direction === "right" ? 1 : -1;
  let positionAt;
  let hint = r.lookHeading;
  if (p.move === "push") {
    positionAt = (t) => env(pushedEye(r, p.moveM, u(t)));
  } else if (p.move === "arc") {
    const radius = Math.max(1e-3, r.dist * Math.cos(r.elev));
    const sweep = sgn * Math.min(TAU, p.moveM / radius);
    const bearingAt = (t) => r.bearing + sweep * (u(t) - 0.5);
    positionAt = (t) => env(addScaled3(r.aim0, awayDir(bearingAt(t), r.elev), r.dist));
    hint = (t) => bearingAt(t) + Math.PI;
  } else {
    const right = viewRight(r.eye, r.aim0, r.lookHeading);
    positionAt = (t) => env(addScaled3(r.eye, right, sgn * p.moveM * (u(t) - 0.5)));
  }
  return finish(spec, ctx, {
    positionAt,
    orientAt: lookAtLive(spec, ctx, r, { hint }),
    meta: rigMeta(r, { timeLapse: { rate: p.rate, unit: "game-days/s" }, hyperlapse: { move: p.move, moveM: p.moveM } }),
  });
}

// ---------------------------------------------------------------------------
// builders — moving rigs (pre-simulated springs)
// ---------------------------------------------------------------------------

/** Lead-room thirds offset for a side track: subject on the trailing third, weighted by its speed. */
function leadRoomOffset(track, sideSign, fov, aspect) {
  return (t) => {
    const w = smoothstep(clamp(track.speedAt(t) / 1.0, 0, 1));
    if (!(w > 0)) return null;
    return thirdsAimOffset({ side: (-sideSign * w) / 3 }, fov, Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT);
  };
}

/** classic.tracking-*: camera on a spring rig at a fixed angle to the subject's smoothed travel heading. */
function buildTracking(spec, ctx, baseAngleDeg, o = {}) {
  const p = spec.params;
  const D = spec.duration;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const fov = spec.fov;
  const d = framedDistance(spec.framing, s0, fov, p.distance);
  const e = p.elevationDeg * DEG;
  const track = travelHeadingTrack(ctx, D, { turnLag: p.turnLag });
  const ang = (baseAngleDeg + p.offsetDeg) * DEG;
  const desired = (t) => addScaled3(aimAt(spec.framing, S(t)), awayDir(track.headingAt(t) + ang, e), d);
  const cam = followSpring(desired, D, { smoothTime: p.lag, feedForward: p.feedForward });
  const aim = followSpring((t) => aimAt(spec.framing, S(t)), D, { smoothTime: p.aimLag, feedForward: 1 });
  const env = envelope(ctx);
  let offset = thirdsFor(p.thirds, fov, ctx.aspect);
  if (o.sideSign && p.leadRoom) offset = leadRoomOffset(track, o.sideSign, fov, ctx.aspect);
  const aim0 = aimAt(spec.framing, s0);
  const r = { S, s0, framing: spec.framing, fov, bearing: track.headingAt(0) + ang, elev: e, dist: d, aim0, eye: cam.at(0), lookHeading: track.headingAt(0) + ang + Math.PI };
  return finish(spec, ctx, {
    positionAt: (t) => env(keepOut(cam.at(t), aimAt(spec.framing, S(t)), S(t))),
    orientAt: lookAtLive(spec, ctx, r, { aim: aim.at, hint: (t) => track.headingAt(t) + ang + Math.PI, offset }),
    meta: rigMeta(r, { tracking: { angleDeg: baseAngleDeg + p.offsetDeg, distance: d, lag: p.lag, feedForward: p.feedForward } }),
  });
}

/** classic.steadicam: floaty spring rig (follow / lead / side) with a slow glide and an operator's gait. */
function buildSteadicam(spec, ctx) {
  const p = spec.params;
  const D = spec.duration;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const fov = spec.fov;
  const d0 = framedDistance(spec.framing, s0, fov, p.distance);
  const dMin = minStandoff(s0);
  const e = p.elevationDeg * DEG;
  const angDeg = { lead: 0, follow: 180, "side-left": -90, "side-right": 90 }[p.mode];
  const ang = angDeg * DEG;
  const track = travelHeadingTrack(ctx, D, { turnLag: p.turnLag });
  const u = progressOf(spec);
  const glide = Math.max(0, Math.min(p.glideM, d0 - dMin));
  const desired = (t) => addScaled3(aimAt(spec.framing, S(t)), awayDir(track.headingAt(t) + ang, e), d0 - glide * u(t));
  const cam = followSpring(desired, D, { smoothTime: p.lag, feedForward: p.feedForward });
  const aim = followSpring((t) => aimAt(spec.framing, S(t)), D, { smoothTime: 0.2, feedForward: 1 });
  const micro = createShake({ seed: deriveSeed(ctx.seed, "classic.steadicam"), amplitudeDeg: 0.08, frequencyHz: 0.5, posAmplitude: 0.004, roughness: 0.3 });
  const walk = (t) => {
    const v = cam.velocityAt(t);
    return smoothstep(clamp(Math.hypot(v[0], v[1]) / 0.6, 0, 1));
  };
  const env = envelope(ctx);
  const omegaStep = TAU * p.stepHz;
  const positionAt = (t) => {
    const s = S(t);
    const c = keepOut(cam.at(t), aimAt(spec.framing, s), s);
    const w = walk(t);
    const h = track.headingAt(t) + ang + Math.PI;
    const side = 0.5 * p.bobM * w * Math.sin(0.5 * omegaStep * t);
    const m = micro(t);
    return env([
      c[0] + Math.cos(h) * side + m.dpos[0],
      c[1] - Math.sin(h) * side + m.dpos[1],
      c[2] + p.bobM * w * Math.sin(omegaStep * t) + m.dpos[2],
    ]);
  };
  const look = orientLookAt(aim.at, { headingHint: (t) => track.headingAt(t) + ang + Math.PI, roll: spec.roll });
  const orientAt = (t, pos) => {
    const o = look(t, pos);
    const m = micro(t);
    const sway = p.swayDeg * DEG * walk(t) * Math.sin(0.5 * omegaStep * t + 0.4);
    return { h: o.h + m.dh, p: o.p + m.dp, r: o.r + sway + m.dr };
  };
  const r = { S, s0, framing: spec.framing, fov, bearing: track.headingAt(0) + ang, elev: e, dist: d0, aim0: aimAt(spec.framing, s0), eye: cam.at(0), lookHeading: track.headingAt(0) + ang + Math.PI };
  return finish(spec, ctx, { positionAt, orientAt, meta: rigMeta(r, { steadicam: { mode: p.mode, glideM: glide } }) });
}

/** classic.snorricam: rig bolted to the subject's body, facing them at arm's length. */
function buildSnorricam(spec, ctx) {
  const p = spec.params;
  const D = spec.duration;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const track = travelHeadingTrack(ctx, D, { turnLag: p.turnLag, speedLag: 0.3 });
  const micro = createShake({ seed: deriveSeed(ctx.seed, "classic.snorricam"), amplitudeDeg: 0.15, frequencyHz: 0.9, posAmplitude: 0.003, roughness: 0.4 });
  const omegaStep = TAU * p.stepHz;
  const walk = (t) => smoothstep(clamp(track.speedAt(t) / 0.8, 0, 1));
  const arm = Math.max(p.armM, minStandoff(s0));
  const env = envelope(ctx);
  const positionAt = (t) => {
    const s = S(t);
    const hb = track.headingAt(t);
    const m = micro(t);
    const bob = p.bobM * walk(t) * Math.sin(omegaStep * t);
    return env([
      s.pos[0] + Math.sin(hb) * arm + m.dpos[0],
      s.pos[1] + Math.cos(hb) * arm + m.dpos[1],
      s.pos[2] + p.heightFrac * s.height + bob + m.dpos[2],
    ]);
  };
  const look = orientLookAt((t) => aimAt(spec.framing, S(t)), { headingHint: (t) => track.headingAt(t) + Math.PI, roll: spec.roll });
  const orientAt = (t, pos) => {
    const o = look(t, pos);
    const m = micro(t);
    const sway = p.swayDeg * DEG * walk(t) * Math.sin(0.5 * omegaStep * t);
    return { h: o.h + m.dh, p: o.p + m.dp, r: o.r + sway + m.dr };
  };
  const aim0 = aimAt(spec.framing, s0);
  const eye0 = positionAt(0);
  const r = { S, s0, framing: spec.framing, fov: spec.fov, bearing: track.headingAt(0), elev: elevationFromTo(aim0, eye0), dist: dist3(eye0, aim0), aim0, eye: eye0, lookHeading: track.headingAt(0) + Math.PI };
  return finish(spec, ctx, { positionAt, orientAt, meta: rigMeta(r, { snorricam: { armM: arm, heightFrac: p.heightFrac } }) });
}

/** classic.pov: the subject's eyes and heading, with a walking bob (and an optional creep forward). */
function buildPov(spec, ctx) {
  const p = spec.params;
  const D = spec.duration;
  const S = subjectTrack(ctx);
  const s0 = S(0);
  const track = travelHeadingTrack(ctx, D, { turnLag: p.turnLag, speedLag: 0.4 });
  const u = progressOf(spec);
  const micro = createShake({ seed: deriveSeed(ctx.seed, "classic.pov"), amplitudeDeg: 0.12, frequencyHz: 0.45, posAmplitude: 0, roughness: 0.3 });
  const omegaStep = TAU * p.stepHz;
  const walk = (t) => smoothstep(clamp(track.speedAt(t) / 1.0, 0, 1));
  const env = envelope(ctx);
  const positionAt = (t) => {
    const s = S(t);
    const hb = track.headingAt(t);
    const w = walk(t);
    const ahead = 0.6 * s.radius + p.advanceM * u(t);
    const side = 0.5 * p.bobM * w * Math.sin(0.5 * omegaStep * t);
    const breathe = 0.004 * Math.sin(TAU * 0.23 * t);
    return env([
      s.pos[0] + Math.sin(hb) * ahead + Math.cos(hb) * side,
      s.pos[1] + Math.cos(hb) * ahead - Math.sin(hb) * side,
      s.pos[2] + p.eyeFrac * s.height + p.bobM * w * Math.sin(omegaStep * t) + breathe,
    ]);
  };
  const yaw = p.lookYawDeg * DEG;
  const pitch = p.pitchDeg * DEG;
  const orientAt = (t) => {
    const w = walk(t);
    const m = micro(t);
    return {
      h: track.headingAt(t) + yaw + m.dh,
      p: clamp(pitch + 0.4 * DEG * w * Math.sin(omegaStep * t + 0.8) + m.dp, -HALF_PI, HALF_PI),
      r: spec.roll + 0.7 * DEG * w * Math.sin(0.5 * omegaStep * t) + m.dr,
    };
  };
  const eye0 = positionAt(0);
  const aim0 = aimAt(spec.framing, s0);
  const r = { S, s0, framing: spec.framing, fov: spec.fov, bearing: track.headingAt(0), elev: 0, dist: 0, aim0, eye: eye0, lookHeading: track.headingAt(0) };
  return finish(spec, ctx, { positionAt, orientAt, meta: rigMeta(r, { pov: { eyeFrac: p.eyeFrac, advanceM: p.advanceM }, subjectIsCamera: true }) });
}

// ---------------------------------------------------------------------------
// tracking params
// ---------------------------------------------------------------------------

/** Params shared by the tracking techniques. */
function trackingParams(extra) {
  return {
    distance: P_DISTANCE(),
    elevationDeg: P_ELEVATION(8, -45, 75),
    offsetDeg: { type: "number", default: 0, min: -90, max: 90, unit: "deg", desc: "Extra angle added to the technique's base angle around the subject's travel heading (e.g. 30 = a three-quarter angle)." },
    lag: { type: "number", default: 0.6, min: 0, max: 5, unit: "s", desc: "Operator spring smooth time: how softly the camera reacts to starts, stops and turns (0 = rigid)." },
    feedForward: { type: "number", default: 1, min: 0, max: 1, desc: "How much of the subject's velocity the operator anticipates: 1 = holds the framing distance at any constant speed (lag only on starts, stops, turns); lower = trails its spot by (1 − ff)·speed·lag (a lead/side camera then drifts closer to the subject)." },
    turnLag: { type: "number", default: 0.9, min: 0.05, max: 10, unit: "s", desc: "Smooth time of the travel-heading spring (how late the rig swings round when the subject turns)." },
    aimLag: { type: "number", default: 0.12, min: 0, max: 2, unit: "s", desc: "Smooth time of the aim point (filters jitter in the subject position; no steady lag)." },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// the catalog
// ---------------------------------------------------------------------------

/** Technique definitions in SPEC order (raw; normalised by defineTechnique below). */
const DEFS = [
  {
    id: "classic.static",
    name: "Static (locked-off)",
    description: "A locked-off frame: the camera does not move. Placed by azimuth/elevation and the framing distance; the head follows the subject only if it moves.",
    whenToUse: "Dialogue, contemplation, letting the action play inside the frame; the default neutral coverage shot.",
    params: placementParams(),
    needs: { subject: false },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 5,
    defaultFraming: "MS",
    defaultEase: "linear",
    tags: ["locked"],
    build: (spec, ctx) => buildLocked(spec, ctx),
  },
  {
    id: "classic.pan",
    name: "Pan",
    description: "Fixed camera position, the head turns horizontally. Relative mode pans from fromDeg to toDeg around the subject's bearing (default: drifts onto the subject); absolute mode sweeps compass headings at pitchDeg.",
    whenToUse: "Following action across a scene, connecting two points of interest, a slow survey of a vista ending on the subject.",
    params: {
      ...placementParams({ thirds: false }),
      fromDeg: { type: "number", default: -30, min: -720, max: 720, unit: "deg", desc: "Start heading: offset from the subject's bearing (relative) or a compass heading (absolute). + = clockwise (to the right)." },
      toDeg: { type: "number", default: 0, min: -720, max: 720, unit: "deg", desc: "End heading, same convention as fromDeg." },
      relative: { type: "boolean", default: true, desc: "true: headings are offsets from the bearing to the (live) subject and pitch holds the subject; false: absolute compass headings at pitchDeg." },
      pitchDeg: { type: "number", default: 0, min: -90, max: 90, unit: "deg", desc: "Camera pitch in absolute mode (+ up)." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 5,
    defaultFraming: "WS",
    defaultEase: "sineInOut",
    tags: ["locked-position", "pan"],
    build: buildPan,
  },
  {
    id: "classic.tilt",
    name: "Tilt",
    description: "Fixed camera position, the head tilts vertically with the heading held, so it can reach exactly −90° (straight down) or +90° (straight up) with no gimbal flip. Relative mode offsets from the pitch that centres the subject.",
    whenToUse: "Revealing height (a tower, a creature), tilting down from the sky onto the subject, or tilting to look straight down a shaft.",
    params: {
      ...placementParams({ thirds: false }),
      fromDeg: { type: "number", default: 20, min: -180, max: 180, unit: "deg", desc: "Start pitch: offset above (+) / below (−) the subject (relative) or absolute pitch in [−90, 90] (−90 = straight down)." },
      toDeg: { type: "number", default: 0, min: -180, max: 180, unit: "deg", desc: "End pitch, same convention as fromDeg." },
      relative: { type: "boolean", default: true, desc: "true: pitches are offsets from the pitch that centres the (live) subject; false: absolute camera pitches (±90 reachable exactly)." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 5,
    defaultFraming: "FS",
    defaultEase: "sineInOut",
    tags: ["locked-position", "tilt", "vertical-90"],
    build: buildTilt,
  },
  {
    id: "classic.roll",
    name: "Roll (dutch angle)",
    description: "A framed shot with the horizon tilted: static (fromDeg = toDeg) or rolling from fromDeg to toDeg, with an optional slow push. + = top of frame moves right.",
    whenToUse: "Unease, disorientation, menace, a world off balance.",
    params: {
      ...placementParams(),
      fromDeg: { type: "number", default: 0, min: -90, max: 90, unit: "deg", desc: "Roll at the start (added to the shot roll)." },
      toDeg: { type: "number", default: 15, min: -90, max: 90, unit: "deg", desc: "Roll at the end (equal to fromDeg for a static dutch)." },
      pushM: { type: "number", default: 0, min: 0, max: 50, unit: "m", desc: "Optional slow push toward the subject over the shot." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 5,
    defaultFraming: "MS",
    defaultEase: "sineInOut",
    tags: ["dutch", "roll"],
    build: buildRoll,
  },
  {
    id: "classic.zoom",
    name: "Zoom",
    description: "Locked camera; only the field of view changes, from the shot fov (framing at the start) to the fov that frames toFraming (or toFovDeg), at an even rate of magnification. The aim eases to the new framing's height.",
    whenToUse: "Isolating a detail without moving, the 70s crash zoom (ease expoInOut), compressing perspective; contrast with dolly-in.",
    params: {
      ...placementParams(),
      toFraming: P_FRAMING("MCU", "Framing the zoom ends on (the shot framing is the start)."),
      toFovDeg: { type: "number", default: 0, min: 0, max: 170, unit: "deg", desc: "Explicit end fov; 0 = derived from toFraming." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 4,
    defaultFraming: "WS",
    defaultEase: "sineInOut",
    tags: ["locked-position", "fov"],
    build: buildZoom,
  },
  {
    id: "classic.dolly-in",
    name: "Dolly in",
    description: "The camera travels along the view axis toward the subject, from the fromFraming distance to the shot framing distance; the aim eases between the two framings' aim heights.",
    whenToUse: "Building intensity, drawing the audience into a character's moment, moving from context to detail.",
    params: {
      ...placementParams({ distance: false }),
      fromFraming: P_FRAMING("WS", "Framing at the start of the move (the shot framing is where it lands)."),
      profile: P_PROFILE("linear"),
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.move,
    defaultDuration: 6,
    defaultFraming: "MS",
    defaultFov: 50,
    defaultEase: "sineInOut",
    tags: ["move", "dolly"],
    build: (spec, ctx) => buildDollyMove(spec, ctx, spec.params.fromFraming, spec.framing,
      { profile: spec.params.profile, elevFromDeg: spec.params.elevationDeg, elevToDeg: spec.params.elevationDeg }),
  },
  {
    id: "classic.dolly-out",
    name: "Dolly out",
    description: "The camera travels back along the view axis, from the shot framing distance to the toFraming distance.",
    whenToUse: "Revealing context around a character, isolation, ending a scene.",
    params: {
      ...placementParams({ distance: false }),
      toFraming: P_FRAMING("WS", "Framing at the end of the move (the shot framing is the start)."),
      profile: P_PROFILE("linear"),
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.move,
    defaultDuration: 6,
    defaultFraming: "MS",
    defaultFov: 50,
    defaultEase: "sineInOut",
    tags: ["move", "dolly"],
    build: (spec, ctx) => buildDollyMove(spec, ctx, spec.framing, spec.params.toFraming,
      { profile: spec.params.profile, elevFromDeg: spec.params.elevationDeg, elevToDeg: spec.params.elevationDeg }),
  },
  {
    id: "classic.truck",
    name: "Truck",
    description: "Lateral move across the view axis (travelM, centred on the framed position). keepAim pans to hold the subject (an arcing feel); keepAim false keeps the head fixed so the subject crosses the frame with parallax.",
    whenToUse: "Parallax past foreground objects, moving alongside a scene, revealing depth.",
    params: {
      ...placementParams(),
      travelM: { type: "number", default: 3, min: 0.1, max: 500, unit: "m", desc: "Total lateral travel." },
      direction: P_LR("right", "Direction of travel as seen by the camera."),
      keepAim: { type: "boolean", default: true, desc: "true: pan to keep the subject framed; false: fixed head (subject crosses the frame, centred mid-move)." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.move,
    defaultDuration: 6,
    defaultFraming: "FS",
    defaultEase: "sineInOut",
    tags: ["move", "lateral"],
    build: buildTruck,
  },
  {
    id: "classic.pedestal",
    name: "Pedestal",
    description: "Vertical camera move (riseM up, negative down) from the framed position; keepAim tilts to hold the subject.",
    whenToUse: "Rising from a low vantage to eye level, sinking below a ledge, revealing over a foreground edge.",
    params: {
      ...placementParams(),
      riseM: { type: "number", default: 1.5, min: -100, max: 100, unit: "m", desc: "Vertical travel (+ up, − down; the ground clamp still applies)." },
      keepAim: { type: "boolean", default: true, desc: "true: tilt to keep the subject framed; false: fixed head." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.move,
    defaultDuration: 5,
    defaultFraming: "FS",
    defaultEase: "sineInOut",
    tags: ["move", "vertical"],
    build: buildPedestal,
  },
  {
    id: "classic.crane",
    name: "Crane (jib arc)",
    description: "The camera rides the tip of a jib arm: it rises riseM through a symmetric arc of the arm while swinging swingDeg about the jib base, always aimed at the subject. Arms too short for the rise are lengthened (rise ≤ 1.9 × arm).",
    whenToUse: "Grand openings and endings, rising above a crowd or a wall to reveal the scene, swooping down to a character.",
    params: {
      ...placementParams({ elevation: 0 }),
      riseM: { type: "number", default: 3, min: -40, max: 40, unit: "m", desc: "Height gained by the camera (negative = crane down)." },
      swingDeg: { type: "number", default: 25, min: -150, max: 150, unit: "deg", desc: "Swing of the arm about the jib base (+ = clockwise seen from above)." },
      armM: { type: "number", default: 4, min: 1, max: 30, unit: "m", desc: "Jib arm length (longer = flatter arc)." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.move,
    defaultDuration: 7,
    defaultFraming: "WS",
    defaultEase: "sineInOut",
    tags: ["move", "vertical", "jib"],
    build: buildCrane,
  },
  {
    id: "classic.arc",
    name: "Arc",
    description: "Partial orbit: the camera sweeps arcDeg around the (live) subject at constant distance and elevation, centred on azimuthDeg, always aimed.",
    whenToUse: "Adding dimension to a static moment, revealing a character against a changing background, heroic emphasis.",
    params: {
      ...placementParams({ elevation: 8, elevMax: 80 }),
      arcDeg: { type: "number", default: 45, min: 5, max: 350, unit: "deg", desc: "Angle swept around the subject." },
      direction: { type: "enum", values: ["cw", "ccw"], default: "cw", desc: "cw = clockwise seen from above (camera bearing increases), ccw = counter-clockwise." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.move,
    defaultDuration: 7,
    defaultFraming: "MWS",
    defaultEase: "sineInOut",
    tags: ["move", "orbit"],
    build: (spec, ctx) => buildOrbitLike(spec, ctx, spec.params.arcDeg * DEG, true),
  },
  {
    id: "classic.orbit",
    name: "Orbit",
    description: "Full circle(s) around the (live) subject at constant distance and elevation, starting at azimuthDeg; one revolution returns exactly to the start.",
    whenToUse: "Showcasing a hero or a landmark, a moment frozen in time, loopable footage (ease linear).",
    params: {
      ...placementParams({ elevation: 12, elevMax: 80 }),
      revolutions: { type: "number", default: 1, min: 0.25, max: 10, desc: "Number of revolutions." },
      direction: { type: "enum", values: ["cw", "ccw"], default: "cw", desc: "cw = clockwise seen from above (camera bearing increases), ccw = counter-clockwise." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.move,
    defaultDuration: 12,
    defaultFraming: "FS",
    defaultEase: "linear",
    tags: ["move", "orbit"],
    build: (spec, ctx) => buildOrbitLike(spec, ctx, spec.params.revolutions * TAU, false),
  },
  {
    id: "classic.tracking-follow",
    name: "Tracking — follow",
    description: "The camera follows behind the moving subject (ctx.subjectAt) on a spring rig keyed to its smoothed travel heading; constant speed is tracked without lag, starts/stops/turns are felt a beat late.",
    whenToUse: "Following a character into the unknown, journeys, chases from behind. Shoot with capture realtime when the subject is server-driven.",
    params: trackingParams({ thirds: P_THIRDS() }),
    needs: { subject: true },
    defaultBounds: BOUNDS.track,
    defaultDuration: 8,
    defaultFraming: "WS",
    capture: "realtime",
    tags: ["move", "tracking", "moving-subject"],
    build: (spec, ctx) => buildTracking(spec, ctx, 180),
  },
  {
    id: "classic.tracking-lead",
    name: "Tracking — lead",
    description: "The camera travels ahead of the moving subject, facing it, on a spring rig keyed to its smoothed travel heading.",
    whenToUse: "Walk-and-talk, a character striding toward the audience, determination, pursuit seen from the front.",
    params: trackingParams({ thirds: P_THIRDS() }),
    needs: { subject: true },
    defaultBounds: BOUNDS.track,
    defaultDuration: 8,
    defaultFraming: "FS",
    capture: "realtime",
    tags: ["move", "tracking", "moving-subject"],
    build: (spec, ctx) => buildTracking(spec, ctx, 0),
  },
  {
    id: "classic.tracking-side",
    name: "Tracking — side",
    description: "The camera travels beside the moving subject (its left or right), profile view, spring-lagged; lead room places the subject on the trailing third while it moves.",
    whenToUse: "Running, riding, marching; showing speed against a passing background.",
    params: trackingParams({
      side: P_LR("right", "Which side of the subject the camera travels on (relative to its travel direction)."),
      leadRoom: { type: "boolean", default: true, desc: "Shift the subject to the trailing third (space ahead of it) in proportion to its speed." },
    }),
    needs: { subject: true },
    defaultBounds: BOUNDS.track,
    defaultDuration: 8,
    defaultFraming: "FS",
    capture: "realtime",
    tags: ["move", "tracking", "moving-subject"],
    build: (spec, ctx) => buildTracking(spec, ctx, spec.params.side === "right" ? 90 : -90, { sideSign: spec.params.side === "right" ? 1 : -1 }),
  },
  {
    id: "classic.push-in",
    name: "Push-in",
    description: "A slow, emotional dolly along the view axis between two close framings (fromFraming → shot framing), eased sineInOut on a longer lens.",
    whenToUse: "A realisation, a decision, rising emotion; the audience leans in with the character.",
    params: {
      ...placementParams({ distance: false }),
      fromFraming: P_FRAMING("MWS", "Framing at the start of the push (the shot framing is where it lands)."),
      profile: P_PROFILE("linear"),
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.close,
    defaultDuration: 6,
    defaultFraming: "MCU",
    defaultFov: 40,
    defaultEase: "sineInOut",
    tags: ["move", "dolly", "emotional"],
    build: (spec, ctx) => buildDollyMove(spec, ctx, spec.params.fromFraming, spec.framing,
      { profile: spec.params.profile, elevFromDeg: spec.params.elevationDeg, elevToDeg: spec.params.elevationDeg }),
  },
  {
    id: "classic.pull-out-reveal",
    name: "Pull-out reveal",
    description: "Starts tight on the subject (shot framing, default CU) and pulls back along the view axis to toFraming (default EWS), optionally rising to endElevationDeg, at a perceptually even rate.",
    whenToUse: "Revealing where a character is (alone in a vast place, surrounded), endings, scale reveals.",
    params: {
      ...placementParams({ thirds: false, distance: false }),
      toFraming: P_FRAMING("EWS", "Framing the pull-out ends on (the shot framing is the start)."),
      rise: { type: "boolean", default: true, desc: "Rise while pulling out (elevation eases from elevationDeg to endElevationDeg)." },
      endElevationDeg: { type: "number", default: 25, min: -30, max: 85, unit: "deg", desc: "Elevation at the end of the move when rise is true." },
      profile: P_PROFILE("perceptual"),
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.wide,
    defaultDuration: 8,
    defaultFraming: "CU",
    defaultFov: 35,
    defaultEase: "sineInOut",
    reveal: true,
    tags: ["move", "dolly", "reveal"],
    build: (spec, ctx) => buildDollyMove(spec, ctx, spec.framing, spec.params.toFraming, {
      profile: spec.params.profile,
      elevFromDeg: spec.params.elevationDeg,
      elevToDeg: spec.params.rise ? spec.params.endElevationDeg : spec.params.elevationDeg,
      meta: { rise: spec.params.rise },
    }),
  },
  {
    id: "classic.dolly-zoom",
    name: "Dolly zoom (vertigo)",
    description: "The camera dollies along the view axis while the fov changes so the subject's frame height stays constant (fov(t) from the framing math); the background stretches or compresses. Shot fov → toFovDeg (narrowing fov = dolly out). The lens never enters the subject's standoff, which caps how wide a tight framing can end (use a wider framing for very wide end fovs).",
    whenToUse: "Vertigo, shock, a sudden realisation, the world shifting around a character.",
    params: {
      ...placementParams({ elevation: 0, elevMin: -30, elevMax: 30, thirds: false, distance: false }),
      toFovDeg: { type: "number", default: 25, min: 5, max: 120, unit: "deg", desc: "fov at the end (the shot fov is the start); smaller = dolly out + zoom in, larger = dolly in + zoom out." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.close,
    defaultDuration: 5,
    defaultFraming: "MS",
    defaultFov: 60,
    defaultEase: "sineInOut",
    tags: ["move", "fov", "vertigo"],
    build: buildDollyZoom,
  },
  {
    id: "classic.whip-pan",
    name: "Whip pan",
    description: "Hold, then a very fast continuous pan of angleDeg in whipSec (≤ 0.35 s) centred at `at`, then hold. land 'subject' whips ONTO the subject; 'away' whips off it. Peak angular speed is reported in meta.motionLimits.",
    whenToUse: "Energetic transitions, sudden attention shifts, comedic beats; cut on the blur.",
    params: {
      ...placementParams({ thirds: false }),
      angleDeg: { type: "number", default: 90, min: 20, max: 180, unit: "deg", desc: "Angle of the whip." },
      direction: P_LR("right", "Direction of the whip as seen by the camera."),
      whipSec: { type: "number", default: 0.25, min: 0.12, max: 0.35, unit: "s", desc: "Duration of the whip itself." },
      at: { type: "number", default: 0.5, min: 0, max: 1, desc: "Centre of the whip as a fraction of the shot." },
      land: { type: "enum", values: ["subject", "away"], default: "subject", desc: "subject: start off-subject and whip onto it; away: start on the subject and whip off." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.timed,
    defaultDuration: 3,
    defaultFraming: "MS",
    defaultEase: "sineInOut",
    reveal: true,
    tags: ["locked-position", "pan", "fast", "transition"],
    build: buildWhip,
  },
  {
    id: "classic.rack-focus",
    name: "Rack focus",
    description: "A locked (or slowly drifting) frame whose focus channel pulls from one distance to another over pullSec around `at`. Targets: foreground (0.35 × subject distance), subject (live distance), background (3 × subject distance), or explicit metres.",
    whenToUse: "Shifting attention between foreground and subject, revealing a second element, a character noticing something. Needs ?filmDof=on to show.",
    params: {
      ...placementParams(),
      fromTarget: { type: "enum", values: ["foreground", "subject", "background", "metres"], default: "foreground", desc: "Focus target at the start." },
      toTarget: { type: "enum", values: ["foreground", "subject", "background", "metres"], default: "subject", desc: "Focus target at the end." },
      fromM: { type: "number", default: 2, min: 0.1, max: 5000, unit: "m", desc: "Start focus distance when fromTarget is 'metres'." },
      toM: { type: "number", default: 20, min: 0.1, max: 5000, unit: "m", desc: "End focus distance when toTarget is 'metres'." },
      at: { type: "number", default: 0.5, min: 0, max: 1, desc: "Centre of the focus pull as a fraction of the shot." },
      pullSec: { type: "number", default: 1.2, min: 0.05, max: 60, unit: "s", desc: "Duration of the focus pull." },
      driftM: { type: "number", default: 0, min: 0, max: 20, unit: "m", desc: "Optional slow push toward the subject over the shot (the 'subject' focus target follows it)." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 5,
    defaultFraming: "MS",
    defaultFov: 40,
    defaultEase: "sineInOut",
    tags: ["locked", "focus"],
    build: buildRackFocus,
  },
  {
    id: "classic.over-the-shoulder",
    name: "Over the shoulder",
    description: "Camera just behind the second character's shoulder, framing the subject on the shoulder-side third (a long lens by default: fov from the framing). The second character comes from params.secondary / ctx.secondary, else a virtual partner in front of the subject.",
    whenToUse: "Dialogue coverage, confrontation, establishing the relationship between two characters.",
    params: {
      ...secondaryParams(),
      shoulder: P_LR("right", "Which of the second character's shoulders the camera looks over."),
      shoulderM: { type: "number", default: 0.3, min: 0, max: 2, unit: "m", desc: "Lateral offset from the second character's centre line." },
      backM: { type: "number", default: 0.45, min: 0.1, max: 5, unit: "m", desc: "Distance behind the second character." },
      raiseM: { type: "number", default: 0.12, min: -1, max: 2, unit: "m", desc: "Height above the second character's shoulder (≈ 0.82 × height)." },
      composeThirds: { type: "boolean", default: true, desc: "Place the subject on the third on the shoulder side (the shoulder fills the other side)." },
      autoFov: { type: "boolean", default: true, desc: "Derive the fov from the shot framing and the resulting distance (long lens); false = use the shot fov." },
      pushM: { type: "number", default: 0.15, min: 0, max: 5, unit: "m", desc: "Subtle push toward the subject over the shot." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.close,
    defaultDuration: 5,
    defaultFraming: "MCU",
    defaultEase: "sineInOut",
    tags: ["dialogue", "coverage"],
    build: buildOts,
  },
  {
    id: "classic.pov",
    name: "Point of view",
    description: "The camera IS the subject's eyes: eye height, travel/facing heading (spring-smoothed), a walking bob and sway while it moves, a breathing drift at rest, optional creep forward (advanceM). The subject itself is not in frame.",
    whenToUse: "Subjective experience, horror, discovery, entering a dungeon through a character's eyes. Hide the avatar for player POV.",
    params: {
      eyeFrac: { type: "number", default: 0.92, min: 0.3, max: 1.2, desc: "Eye height as a fraction of the subject height." },
      pitchDeg: { type: "number", default: -4, min: -80, max: 80, unit: "deg", desc: "Look pitch (+ up)." },
      lookYawDeg: { type: "number", default: 0, min: -180, max: 180, unit: "deg", desc: "Look direction relative to the subject's heading (+ = right)." },
      advanceM: { type: "number", default: 0, min: 0, max: 200, unit: "m", desc: "Creep forward along the heading over the shot (eased)." },
      bobM: { type: "number", default: 0.025, min: 0, max: 0.2, unit: "m", desc: "Walking bob amplitude (scaled by the subject's speed)." },
      stepHz: { type: "number", default: 1.8, min: 0.5, max: 4, unit: "Hz", desc: "Step frequency of the walking bob." },
      turnLag: { type: "number", default: 0.35, min: 0.05, max: 5, unit: "s", desc: "Smooth time of the head turning with the subject's heading." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.body,
    defaultDuration: 5,
    defaultFov: 75,
    defaultEase: "sineInOut",
    tags: ["subjective", "body-rig", "subject-is-camera"],
    build: buildPov,
  },
  {
    id: "classic.two-shot",
    name: "Two-shot",
    description: "Frames the subject and a second character together: camera perpendicular to the line between them (side auto/left/right), far enough that both fit in 85% of the frame width, with a slow drift.",
    whenToUse: "Conversations, partnerships, two characters sharing a moment or a confrontation.",
    params: {
      ...secondaryParams(),
      side: { type: "enum", values: ["auto", "left", "right"], default: "auto", desc: "Side of the subject→secondary line for the camera (auto = the side facing ctx.anchor, else the sun, else left)." },
      distance: P_DISTANCE(),
      elevationDeg: P_ELEVATION(5, -30, 60),
      driftDeg: { type: "number", default: 6, min: -90, max: 90, unit: "deg", desc: "Slow arc drift around the pair over the shot (centred)." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.move,
    defaultDuration: 6,
    defaultFraming: "MWS",
    defaultEase: "sineInOut",
    tags: ["dialogue", "coverage"],
    build: buildTwoShot,
  },
  {
    id: "classic.establishing",
    name: "Establishing",
    description: "Wide, high and slow: the camera hangs distance metres out and heightM up from the subject (or the anchor), drifting driftDeg around it and pushing pushPct closer.",
    whenToUse: "Opening a scene or a new location, showing geography and scale.",
    params: {
      azimuthDeg: P_AZIMUTH(),
      azimuthRef: P_AZIMUTH_REF(),
      distance: { type: "number", default: 80, min: 5, max: 5000, unit: "m", desc: "Horizontal distance from the subject / anchor." },
      heightM: { type: "number", default: 25, min: 0, max: 2000, unit: "m", desc: "Camera height above the subject's base." },
      driftDeg: { type: "number", default: 10, min: -180, max: 180, unit: "deg", desc: "Slow arc drift around the subject over the shot (centred; + = clockwise)." },
      pushPct: { type: "number", default: 8, min: -50, max: 90, unit: "%", desc: "Percentage of the distance closed over the shot (negative = pull back)." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.wide,
    defaultDuration: 8,
    defaultFraming: "EWS",
    defaultFov: 50,
    defaultEase: "sineInOut",
    tags: ["wide", "aerial", "slow"],
    build: buildEstablishing,
  },
  {
    id: "classic.high-angle",
    name: "High angle",
    description: "Camera above the subject looking down at elevationDeg (default 40°), with a slow push.",
    whenToUse: "Vulnerability, smallness, being watched or overwhelmed; overview of a situation.",
    params: {
      ...placementParams({ elevation: 40, elevMin: 10, elevMax: 85 }),
      pushM: { type: "number", default: 0.3, min: 0, max: 50, unit: "m", desc: "Slow push toward the subject over the shot." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.move,
    defaultDuration: 5,
    defaultFraming: "MWS",
    defaultEase: "sineInOut",
    tags: ["angle"],
    build: (spec, ctx) => buildAngle(spec, ctx),
  },
  {
    id: "classic.low-angle",
    name: "Low angle",
    description: "Camera below the subject's eye line looking up at it (elevationDeg default −25°), with a slow push; the ground clamp lifts it if needed.",
    whenToUse: "Power, dominance, heroism, menace; making a character or creature loom.",
    params: {
      ...placementParams({ elevation: -25, elevMin: -75, elevMax: -3 }),
      pushM: { type: "number", default: 0.2, min: 0, max: 50, unit: "m", desc: "Slow push toward the subject over the shot." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.close,
    defaultDuration: 5,
    defaultFraming: "MWS",
    defaultFov: 55,
    defaultEase: "sineInOut",
    tags: ["angle"],
    build: (spec, ctx) => buildAngle(spec, ctx, { soft: 0.2 }),
  },
  {
    id: "classic.birds-eye",
    name: "Bird's-eye",
    description: "Straight down from directly above the subject (pitch exactly −90°). The heading sets which way is image-up (azimuthDeg, default the subject's front); rotateDeg turns the image continuously; riseM climbs or descends.",
    whenToUse: "Patterns, maps, god's-eye detachment, choreography seen from above.",
    params: {
      azimuthDeg: P_AZIMUTH(0, "Compass direction that is UP in the image, measured from azimuthRef (0 = the subject's front at the top of the frame)."),
      azimuthRef: P_AZIMUTH_REF(),
      heightM: { type: "number", default: 0, min: 0, max: 3000, unit: "m", desc: "Camera height above the subject's base; 0 = from the framing (ground area framed = framing × subject height)." },
      rotateDeg: { type: "number", default: 0, min: -1440, max: 1440, unit: "deg", desc: "Image rotation over the shot (heading change at nadir; + = clockwise heading)." },
      riseM: { type: "number", default: 0, min: -2000, max: 2000, unit: "m", desc: "Height change over the shot (+ up)." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.overhead,
    defaultDuration: 6,
    defaultFraming: "WS",
    defaultEase: "sineInOut",
    tags: ["overhead", "vertical-90"],
    build: buildBirdsEye,
  },
  {
    id: "classic.worms-eye",
    name: "Worm's-eye",
    description: "Lens just above the ground (heightM), close to the subject (horizontalM), looking up steeply at it on a wide lens; spinDeg optionally rolls the sky around.",
    whenToUse: "Towering figures and architecture, awe, threat, a fallen character's view of an attacker.",
    params: {
      azimuthDeg: P_AZIMUTH(),
      azimuthRef: P_AZIMUTH_REF(),
      heightM: { type: "number", default: 0.75, min: 0, max: 3, unit: "m", desc: "Lens height above the ground (never below the 0.7 m clearance outdoors)." },
      horizontalM: { type: "number", default: 0, min: 0, max: 100, unit: "m", desc: "Horizontal distance from the subject; 0 = just outside its radius (≥ 0.9 m)." },
      spinDeg: { type: "number", default: 0, min: -720, max: 720, unit: "deg", desc: "Roll rotation over the shot." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.ground,
    defaultDuration: 5,
    defaultFraming: "MS",
    defaultFov: 75,
    defaultEase: "sineInOut",
    tags: ["angle", "ground"],
    build: buildWormsEye,
  },
  {
    id: "classic.handheld",
    name: "Handheld",
    description: "A static or push-in base with seeded, bounded, organic camera shake (createShake); the same seed always reproduces the same shake.",
    whenToUse: "Urgency, documentary realism, chaos, combat.",
    params: {
      ...placementParams(),
      base: { type: "enum", values: ["static", "push-in"], default: "static", desc: "Underlying move." },
      pushM: { type: "number", default: 0.5, min: 0, max: 20, unit: "m", desc: "Push distance for the push-in base." },
      amplitudeDeg: { type: "number", default: 0.6, min: 0, max: 5, unit: "deg", desc: "Angular shake amplitude (heading/pitch; roll is half)." },
      frequencyHz: { type: "number", default: 1.2, min: 0.05, max: 10, unit: "Hz", desc: "Base shake frequency." },
      posAmplitude: { type: "number", default: 0.03, min: 0, max: 0.5, unit: "m", desc: "Positional shake amplitude per axis." },
      roughness: { type: "number", default: 0.5, min: 0, max: 1, desc: "0 = one smooth octave, 1 = jittery." },
    },
    needs: { subject: false },
    defaultBounds: BOUNDS.locked,
    defaultDuration: 5,
    defaultFraming: "MS",
    defaultEase: "sineInOut",
    tags: ["handheld", "shake", "seeded"],
    build: buildHandheld,
  },
  {
    id: "classic.steadicam",
    name: "Steadicam",
    description: "A floating walk with the subject: spring rig leading, following or beside it (smoothed travel heading), a slow glide closer, and the operator's gentle gait bob and sway while walking.",
    whenToUse: "Long fluid takes, walk-and-talks, immersive movement through spaces.",
    params: {
      mode: { type: "enum", values: ["lead", "follow", "side-left", "side-right"], default: "lead", desc: "Where the operator walks relative to the subject's travel direction." },
      distance: P_DISTANCE(),
      elevationDeg: P_ELEVATION(3, -30, 60),
      glideM: { type: "number", default: 0.8, min: 0, max: 50, unit: "m", desc: "Distance the operator closes over the shot." },
      lag: { type: "number", default: 1.0, min: 0.05, max: 5, unit: "s", desc: "Spring smooth time (floatiness)." },
      feedForward: { type: "number", default: 1, min: 0, max: 1, desc: "Velocity anticipation (see tracking-*): 1 holds the distance at constant speed; lower trails the spot by (1 − ff)·speed·lag." },
      turnLag: { type: "number", default: 1.2, min: 0.05, max: 10, unit: "s", desc: "Smooth time of the travel-heading spring." },
      bobM: { type: "number", default: 0.012, min: 0, max: 0.1, unit: "m", desc: "Gait bob amplitude while walking." },
      stepHz: { type: "number", default: 1.8, min: 0.5, max: 4, unit: "Hz", desc: "Operator step frequency." },
      swayDeg: { type: "number", default: 0.35, min: 0, max: 5, unit: "deg", desc: "Roll sway amplitude while walking." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.move,
    defaultDuration: 8,
    defaultFraming: "MWS",
    defaultEase: "sineInOut",
    tags: ["move", "body-rig", "moving-subject"],
    build: buildSteadicam,
  },
  {
    id: "classic.snorricam",
    name: "Snorricam",
    description: "Camera rigidly mounted on the subject's body at arm's length, facing them: the subject stays locked in frame while the world moves and sways around them.",
    whenToUse: "Intoxication, panic, disorientation, intense subjective focus on a moving character.",
    params: {
      armM: { type: "number", default: 0.7, min: 0.3, max: 3, unit: "m", desc: "Rig arm length (lens distance in front of the subject)." },
      heightFrac: { type: "number", default: 0.85, min: 0.3, max: 1.2, desc: "Lens height as a fraction of the subject height." },
      bobM: { type: "number", default: 0.02, min: 0, max: 0.2, unit: "m", desc: "Body bob amplitude while the subject walks." },
      swayDeg: { type: "number", default: 1.0, min: 0, max: 10, unit: "deg", desc: "Body roll sway while the subject walks." },
      stepHz: { type: "number", default: 1.8, min: 0.5, max: 4, unit: "Hz", desc: "Step frequency." },
      turnLag: { type: "number", default: 0.2, min: 0.02, max: 5, unit: "s", desc: "Smoothing of the subject's body heading." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.body,
    defaultDuration: 6,
    defaultFraming: "MCU",
    defaultFov: 70,
    defaultEase: "sineInOut",
    tags: ["body-rig", "moving-subject"],
    build: buildSnorricam,
  },
  {
    id: "classic.reveal-from-occluder",
    name: "Reveal from occluder",
    description: "Starts with the occluder (params.occluder: tree, pillar, wall end; radius occluderRadius) between camera and subject, holds, then trucks sideways just far enough that the subject clears it, aimed throughout. meta.revealOccluder tells the runtime not to fade it.",
    whenToUse: "Discovering a character, suspense, a slow reveal from behind foreground scenery.",
    params: {
      ...placementParams({ elevation: 3, thirds: false }),
      occluder: { type: "vec3", default: [0, 0, 0], unit: "m", desc: "World position of the occluder's base/centre; [0,0,0] = a virtual occluder between camera and subject (≈45% of the way, clear of the subject) — the move without a real blocker. A real occluder hugging the subject caps the truck at 3× the camera distance." },
      occluderRadius: { type: "number", default: 0.6, min: 0.05, max: 50, unit: "m", desc: "Radius of the occluder." },
      direction: P_LR("right", "Direction of the reveal truck as seen by the camera."),
      holdFrac: { type: "number", default: 0.2, min: 0, max: 0.6, desc: "Fraction of the shot held hidden before moving." },
      settleFrac: { type: "number", default: 0.15, min: 0, max: 0.6, desc: "Fraction of the shot held revealed at the end." },
      marginM: { type: "number", default: 0.25, min: 0, max: 20, unit: "m", desc: "Extra clearance between the occluder and the line of sight at the end." },
    },
    needs: { subject: true },
    defaultBounds: BOUNDS.move,
    defaultDuration: 6,
    defaultFraming: "MS",
    defaultEase: "sineInOut",
    reveal: true,
    tags: ["move", "reveal"],
    build: buildReveal,
  },
  {
    id: "classic.time-lapse",
    name: "Time-lapse",
    description: "A locked-off frame while the runtime advances sky time at meta.timeLapse.rate game-days per film second.",
    whenToUse: "Passage of time, day turning to night, clouds racing over a landmark.",
    params: {
      ...placementParams(),
      rate: { type: "number", default: 0.02, min: 0, max: 5, unit: "game-days/s", desc: "Sky time advanced per film second (0.02 ≈ 29 game-minutes per second)." },
    },
    needs: { subject: false },
    defaultBounds: { ...BOUNDS.locked, minSpeedScale: 1 },
    defaultDuration: 8,
    defaultFraming: "WS",
    defaultEase: "linear",
    tags: ["locked", "time-lapse"],
    build: (spec, ctx) => buildLocked(spec, ctx, { timeLapse: { rate: spec.params.rate, unit: "game-days/s" } }),
  },
  {
    id: "classic.hyperlapse",
    name: "Hyperlapse",
    description: "A slow, steady move (truck, push or arc of moveM metres) while the runtime advances sky time at meta.timeLapse.rate game-days per film second.",
    whenToUse: "Time and space passing together: approaching a city as the day ends, circling a landmark through dusk.",
    params: {
      ...placementParams({ elevation: 8 }),
      move: { type: "enum", values: ["truck", "push", "arc"], default: "truck", desc: "Type of move." },
      moveM: { type: "number", default: 12, min: 0.5, max: 2000, unit: "m", desc: "Distance travelled (arc: arc length around the subject)." },
      direction: P_LR("right", "Direction of the truck / arc as seen by the camera."),
      rate: { type: "number", default: 0.02, min: 0, max: 5, unit: "game-days/s", desc: "Sky time advanced per film second." },
    },
    needs: { subject: false },
    defaultBounds: { ...BOUNDS.move, minSpeedScale: 1, maxSpeedScale: 1 },
    defaultDuration: 8,
    defaultFraming: "WS",
    defaultEase: "linear",
    tags: ["move", "time-lapse"],
    build: buildHyperlapse,
  },
];

/**
 * Classic technique definitions (normalised `defineTechnique` results, SPEC
 * §2.12 order), registered into the default registry by shots/index.js. Each
 * def documents its params (type, default, range, unit, desc), declares
 * `needs` (subject-optional techniques use ctx.anchor as a 1.8 m point of
 * interest), `defaultBounds` for the pilot, a default duration / framing /
 * fov / ease, `capture` hint ('realtime' for tracking shots of moving,
 * server-driven subjects), `reveal` (pull-out-reveal, whip-pan,
 * reveal-from-occluder) and tags. Builds are pure and deterministic per spec
 * (seeded shake from ctx.seed).
 * @type {Array<Readonly<import('./registry.js').TechniqueDef>>}
 */
export const CLASSIC_TECHNIQUES = DEFS.map((d) => defineTechnique(d));
