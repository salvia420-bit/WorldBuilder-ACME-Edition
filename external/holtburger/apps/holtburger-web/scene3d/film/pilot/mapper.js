// scene3d/film/pilot/mapper.js — JEV answers → bounded residual setpoint (SPEC §2.14).
//
// WHY: JEV (and the code policy) answer in WORDS — "drift_left", "risk 2",
// "fade". The take player needs smooth NUMBERS: a lateral / vertical offset in
// the path frame, a progress-rate scale, a subject-distance scale and framing
// nudges, all inside the bounds the shot declared. This mapper is that bridge,
// with the protections the jev-drone / jevs-fly prior art found necessary:
//   - commit window: a newly committed ACTIVE maneuver is held for `commitSec`,
//     so the camera never dithers left-right-left or snaps back to the path
//     mid-avoidance; only an answer with risk ≥ `overrideRisk` (score
//     thresholded, never interpolated) may switch inside the window. Leaving
//     hold_path (cruising on the planned shot) is always immediate, so a new
//     obstacle is never ignored because the camera only just got back on path;
//   - confidence: answers below `minConfidence` are not acted on — the
//     setpoint decays toward neutral instead;
//   - staleness: an answer about a scene older than `staleSec` (scene-time age)
//     is ignored and the setpoint FREEZES — a stale answer can never carry the
//     camera downward (or anywhere else);
//   - rate limits on every channel (offsets move at m/s, scales at 1/s), so the
//     setpoint is continuous and the footage smooth; and a return to the planned
//     path only while the side being returned toward is clear;
//   - hard clamps to the shot bounds (maxLateral, maxRise, maxSink,
//     minSpeedScale..maxSpeedScale, 1/maxDistanceScale..maxDistanceScale).
// The code safety reflex (runtime/safety.js) still runs after this and always
// wins over the pilot.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks — time arrives as `now` (seconds) in apply(). Deterministic.

import { MANEUVERS } from "./questions.js";
import { slotRange } from "./scene_state.js";

/**
 * Recursively freezes a plain object/array tree.
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Bounds used for any field the shot did not declare (Trajectory.bounds, SPEC §2.9).
 * @type {Readonly<{maxLateral:number, maxRise:number, maxSink:number, minSpeedScale:number,
 *   maxSpeedScale:number, maxDistanceScale:number}>}
 */
export const DEFAULT_PILOT_BOUNDS = Object.freeze({
  maxLateral: 3,
  maxRise: 3,
  maxSink: 1.5,
  minSpeedScale: 0,
  maxSpeedScale: 1.25,
  maxDistanceScale: 1.5,
});

/**
 * Channel rate limits (per second) and the low-confidence decay time constant.
 * `maxDtSec` caps one apply() step so a long pause never produces a jump.
 */
export const DEFAULT_MAPPER_RATES = Object.freeze({
  lateralMps: 1.5,
  verticalMps: 1.0,
  returnMps: 0.75,
  speedPerSec: 0.8,
  distancePerSec: 0.25,
  framingDegPerSec: 15,
  fovDegPerSec: 6,
  decayTauSec: 0.8,
  maxDtSec: 0.25,
});

/**
 * Setpoint limits / targets:
 * - slowSpeedScale: slow_down target; waitSpeedScale: cap while an occluder `wait` is active;
 *   lostSpeedScale: cap while the subject is lost (noul ≥ lostThreshold).
 * - maxFramingDeg: |framing.dh|, |framing.dp| limit; maxDfovDeg: |framing.dfovDeg| limit.
 * - returnClearanceM: a return toward the planned path (or a decay toward neutral) only moves
 *   an offset while the sensed clearance on the side it moves toward is at least this.
 * - aspect: frame aspect used for recentring when the SensorFrame carries none.
 * - maxFadeIds: most occluder ids a single setpoint asks to fade.
 */
export const DEFAULT_MAPPER_LIMITS = Object.freeze({
  slowSpeedScale: 0.5,
  waitSpeedScale: 0.6,
  lostSpeedScale: 0.7,
  lostThreshold: 0.5,
  maxFramingDeg: 12,
  maxDfovDeg: 10,
  returnClearanceM: 2,
  aspect: 16 / 9,
  maxFadeIds: 16,
});

/**
 * The maneuver → setpoint table (motion channels; the subject-distance scale and framing are
 * driven by the `framing` answer, the fade/reroute flags by `occluder_action`):
 *
 * | maneuver    | lateral (m, + right)                 | vertical (m, + up)                 | speedScale target          |
 * |-------------|--------------------------------------|------------------------------------|----------------------------|
 * | hold_path   | return toward 0 at returnMps *       | return toward 0 at returnMps *     | 1 (cruise)                 |
 * | drift_left  | toward −maxLateral at lateralMps     | hold                               | 1                          |
 * | drift_right | toward +maxLateral at lateralMps     | hold                               | 1                          |
 * | rise        | hold                                 | toward +maxRise at verticalMps     | 1                          |
 * | sink        | hold                                 | toward −maxSink at verticalMps     | 1                          |
 * | slow_down   | hold                                 | hold                               | slowSpeedScale (0.5)       |
 * | back_off    | away from `nearest` (−sin bearing)   | away from `nearest` (−sin elev)    | minSpeedScale (stop/retreat)|
 *
 * (*) only while the clearance on the side being returned toward (SensorFrame `sides`) is at
 * least returnClearanceM. Speed targets are then capped by waitSpeedScale (occluder `wait`) and
 * lostSpeedScale (subject lost), and every channel moves at its rate limit and is clamped to the
 * shot bounds. framing: keep → hold; recenter → dh/dp turn toward the subject's NDC position at
 * framingDegPerSec (≤ maxFramingDeg); widen → distanceScale toward maxDistanceScale, then
 * dfovDeg toward +maxDfovDeg; tighten → distanceScale toward 1/maxDistanceScale, then dfovDeg
 * toward −maxDfovDeg. occluder_action: fade → fadeIds = SensorFrame `subject.occluderIds`
 * (or `occluderId`) — a fade with NO id to fade (an occluder the runtime cannot hide: any
 * procedural scenery tree or rock (v1: never keyed), a big or unsized prop, overlapping placements)
 * falls back to reroute = true, so the answer is
 * never a no-op; reroute → reroute = true (the runtime picks the new line); wait → speed cap.
 */
export const MANEUVER_SETPOINTS = deepFreeze({
  hold_path: { lateral: "return", vertical: "return", speed: "cruise" },
  drift_left: { lateral: "left", vertical: "hold", speed: "cruise" },
  drift_right: { lateral: "right", vertical: "hold", speed: "cruise" },
  rise: { lateral: "hold", vertical: "up", speed: "cruise" },
  sink: { lateral: "hold", vertical: "down", speed: "cruise" },
  slow_down: { lateral: "hold", vertical: "hold", speed: "slow" },
  back_off: { lateral: "away", vertical: "away", speed: "min" },
});

const DEG = Math.PI / 180;

/** @param {*} v @param {number} d @returns {number} v when finite, else d */
function fin(v, d) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : d;
}

/** @param {*} v @param {number} d @returns {number} v when finite and ≥ 0, else d */
function nonNeg(v, d) {
  const n = fin(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Move x toward target by at most maxStep. @param {number} x @param {number} target @param {number} maxStep */
function stepToward(x, target, maxStep) {
  const d = target - x;
  if (Math.abs(d) <= maxStep) return target;
  return x + Math.sign(d) * maxStep;
}

/**
 * Sanitise shot bounds: missing / non-finite / negative fields take DEFAULT_PILOT_BOUNDS; the
 * speed range always contains 1 and maxDistanceScale ≥ 1 (neutral must be reachable).
 * @param {*} b
 * @returns {{maxLateral:number, maxRise:number, maxSink:number, minSpeedScale:number,
 *   maxSpeedScale:number, maxDistanceScale:number}}
 */
export function sanitizeBounds(b) {
  const src = b && typeof b === "object" ? b : {};
  const D = DEFAULT_PILOT_BOUNDS;
  const out = {
    maxLateral: nonNeg(src.maxLateral, D.maxLateral),
    maxRise: nonNeg(src.maxRise, D.maxRise),
    maxSink: nonNeg(src.maxSink, D.maxSink),
    minSpeedScale: fin(src.minSpeedScale, D.minSpeedScale),
    maxSpeedScale: fin(src.maxSpeedScale, D.maxSpeedScale),
    maxDistanceScale: fin(src.maxDistanceScale, D.maxDistanceScale),
  };
  out.minSpeedScale = Math.min(1, out.minSpeedScale);
  out.maxSpeedScale = Math.max(1, out.maxSpeedScale);
  out.maxDistanceScale = Math.max(1, out.maxDistanceScale);
  return out;
}

/**
 * Confidence of an answer: its `confidence` when finite (clamped to [0, 1]), else the
 * probability of its choice / rounded score, else 1 (no information → trusted).
 * @param {*} a
 * @returns {number}
 */
export function answerConfidence(a) {
  if (!a || typeof a !== "object") return 0;
  const c = Number(a.confidence);
  if (a.confidence != null && Number.isFinite(c)) return clamp(c, 0, 1);
  const p = a.probabilities;
  if (p && typeof p === "object") {
    const key = a.type === "score" ? String(Math.round(Number(a.score))) : a.choice;
    const v = Number(p[key]);
    if (key != null && Number.isFinite(v)) return clamp(v, 0, 1);
  }
  return 1;
}

/**
 * Ids of the occluders to fade, from SensorFrame `subject.occluderIds` (array) or
 * `subject.occluderId`: finite numbers or non-empty strings, de-duplicated, capped.
 * @param {*} sf
 * @param {number} max
 * @returns {Array<number|string>}
 */
function occluderIds(sf, max) {
  const s = sf && typeof sf === "object" && sf.subject && typeof sf.subject === "object" ? sf.subject : null;
  if (!s) return [];
  const raw = Array.isArray(s.occluderIds) ? s.occluderIds : s.occluderId != null ? [s.occluderId] : [];
  const out = [];
  for (const id of raw) {
    const ok = (typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id.length > 0);
    if (ok && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Create the residual mapper (SPEC §2.14).
 *
 * `apply(answers, {sceneTime, now, sensorFrame, source})` → Setpoint
 * `{lateral, vertical, speedScale, distanceScale, framing:{dh, dp, dfovDeg}, fadeIds, reroute,
 * maneuver, source, status, risk, subjectLost, since}` — lateral metres (+ right of the path),
 * vertical metres (+ up), framing dh/dp radians (+ = turn right / look up), dfovDeg degrees.
 * Extra fields beyond SPEC: `status` ('init'|'applied'|'held'|'override'|'decay'|'stale'|'empty'),
 * `risk` (thresholded input score), `subjectLost`, `since` (seconds the maneuver is committed).
 *
 * - answers null / without `maneuver` → status 'empty': setpoint frozen.
 * - `now − sceneTime > staleSec` (or a NaN sceneTime) → status 'stale': setpoint frozen (never
 *   descends). A missing sceneTime counts as fresh (age 0).
 * - maneuver confidence < minConfidence → status 'decay': motion channels decay toward neutral
 *   with time constant decayTauSec, never faster than their rate limits (the committed maneuver
 *   is kept). Framing / occluder answers
 *   below minConfidence likewise decay / are ignored.
 * - commit window: a different maneuver replaces a committed ACTIVE maneuver only after
 *   commitSec, or at once when `answers.risk.score ≥ overrideRisk` (status 'override'); otherwise
 *   status 'held'. A committed hold_path is left immediately (no window on the neutral state).
 * @param {{bounds?:object, commitSec?:number, overrideRisk?:number, staleSec?:number,
 *   minConfidence?:number, rates?:object, limits?:object}} [opts]
 * @returns {{apply:(answers:object|null, ctx?:{sceneTime?:number, now?:number, sensorFrame?:object,
 *   source?:string}) => object, current:() => object, reset:() => void, stats:() => object,
 *   readonly bounds: object, readonly config: object}}
 */
export function createResidualMapper(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const bounds = Object.freeze(sanitizeBounds(o.bounds));
  const commitSec = nonNeg(o.commitSec, 1.0);
  const overrideRisk = fin(o.overrideRisk, 1.6);
  const staleSec = nonNeg(o.staleSec, 0.6);
  const minConfidence = clamp(fin(o.minConfidence, 0.45), 0, 1);
  const rates = { ...DEFAULT_MAPPER_RATES };
  if (o.rates && typeof o.rates === "object") {
    for (const k of Object.keys(rates)) rates[k] = nonNeg(o.rates[k], rates[k]);
  }
  rates.decayTauSec = Math.max(1e-3, rates.decayTauSec);
  const limits = { ...DEFAULT_MAPPER_LIMITS };
  if (o.limits && typeof o.limits === "object") {
    for (const k of Object.keys(limits)) limits[k] = nonNeg(o.limits[k], limits[k]);
  }
  limits.slowSpeedScale = clamp(limits.slowSpeedScale, bounds.minSpeedScale, bounds.maxSpeedScale);
  limits.waitSpeedScale = clamp(limits.waitSpeedScale, bounds.minSpeedScale, bounds.maxSpeedScale);
  limits.lostSpeedScale = clamp(limits.lostSpeedScale, bounds.minSpeedScale, bounds.maxSpeedScale);
  const minDist = 1 / bounds.maxDistanceScale;
  const maxFraming = limits.maxFramingDeg * DEG;
  const config = Object.freeze({ commitSec, overrideRisk, staleSec, minConfidence, rates: { ...rates }, limits: { ...limits } });

  let sp;
  let committed;
  let commitAt;
  let lastNow;
  let counters;

  function reset() {
    sp = {
      lateral: 0,
      vertical: 0,
      speedScale: 1,
      distanceScale: 1,
      framing: { dh: 0, dp: 0, dfovDeg: 0 },
      fadeIds: [],
      reroute: false,
      maneuver: "hold_path",
      source: "none",
      status: "init",
      risk: 0,
      subjectLost: false,
    };
    committed = null;
    commitAt = null;
    lastNow = null;
    counters = { applies: 0, applied: 0, held: 0, overrides: 0, switches: 0, decayed: 0, stale: 0, empty: 0, fadeFallbacks: 0 };
  }
  reset();

  /** @param {number} t @returns {object} JSON-safe copy of the setpoint */
  function snapshot(t) {
    const tt = Number.isFinite(t) ? t : lastNow;
    return {
      lateral: sp.lateral,
      vertical: sp.vertical,
      speedScale: sp.speedScale,
      distanceScale: sp.distanceScale,
      framing: { dh: sp.framing.dh, dp: sp.framing.dp, dfovDeg: sp.framing.dfovDeg },
      fadeIds: [...sp.fadeIds],
      reroute: sp.reroute,
      maneuver: sp.maneuver,
      source: sp.source,
      status: sp.status,
      risk: sp.risk,
      subjectLost: sp.subjectLost,
      since: commitAt != null && Number.isFinite(tt) ? Math.max(0, tt - commitAt) : 0,
    };
  }

  /**
   * Sensed clearance (m) toward a side ('left'|'right'|'up'|'down') from SensorFrame `sides`.
   * @param {*} sf @param {string} side @returns {number} Infinity when unknown
   */
  function clearance(sf, side) {
    const sides = sf && typeof sf === "object" && sf.sides && typeof sf.sides === "object" ? sf.sides : null;
    return sides ? slotRange(sides[side]) : Infinity;
  }

  /**
   * Move an offset toward `target`, but never toward a side whose clearance is below
   * returnClearanceM. `posSide` is the side a positive change moves toward.
   * @returns {number}
   */
  function guardedMove(x, next, sf, posSide, negSide) {
    if (next > x && clearance(sf, posSide) < limits.returnClearanceM) return x;
    if (next < x && clearance(sf, negSide) < limits.returnClearanceM) return x;
    return next;
  }

  /**
   * Exponential approach toward `target` (time constant decayTauSec), never faster than
   * `maxRate` per second — so a decay is as smooth as any commanded move.
   * @returns {number}
   */
  function decayToward(x, target, dt, maxRate) {
    const k = 1 - Math.exp(-dt / rates.decayTauSec);
    return stepToward(x, target, Math.min(Math.abs(target - x) * k, maxRate * dt));
  }

  /** Low-confidence decay of the motion channels toward neutral. */
  function decayMotion(dt, sf, speedCap) {
    sp.lateral = guardedMove(sp.lateral, decayToward(sp.lateral, 0, dt, rates.returnMps), sf, "right", "left");
    sp.vertical = guardedMove(sp.vertical, decayToward(sp.vertical, 0, dt, rates.returnMps), sf, "up", "down");
    sp.speedScale = decayToward(sp.speedScale, Math.min(1, speedCap), dt, rates.speedPerSec);
  }

  /** Drive the motion channels for the committed maneuver (see MANEUVER_SETPOINTS). */
  function driveMotion(name, dt, sf, speedCap) {
    const row = MANEUVER_SETPOINTS[name] ?? MANEUVER_SETPOINTS.hold_path;
    const latStep = rates.lateralMps * dt;
    const vertStep = rates.verticalMps * dt;
    const retStep = rates.returnMps * dt;
    // lateral
    if (row.lateral === "return") sp.lateral = guardedMove(sp.lateral, stepToward(sp.lateral, 0, retStep), sf, "right", "left");
    else if (row.lateral === "left") sp.lateral = stepToward(sp.lateral, -bounds.maxLateral, latStep);
    else if (row.lateral === "right") sp.lateral = stepToward(sp.lateral, bounds.maxLateral, latStep);
    // vertical
    if (row.vertical === "return") sp.vertical = guardedMove(sp.vertical, stepToward(sp.vertical, 0, retStep), sf, "up", "down");
    else if (row.vertical === "up") sp.vertical = stepToward(sp.vertical, bounds.maxRise, vertStep);
    else if (row.vertical === "down") sp.vertical = stepToward(sp.vertical, -bounds.maxSink, vertStep);
    // back_off: away from the nearest obstacle
    if (row.lateral === "away" || row.vertical === "away") {
      const n = sf && typeof sf === "object" && sf.nearest && typeof sf.nearest === "object" ? sf.nearest : null;
      const b = n ? fin(n.bearingDeg, NaN) * DEG : NaN;
      const e = n ? fin(n.elevDeg, 0) * DEG : 0;
      if (Number.isFinite(b)) {
        const latDir = -Math.sin(b) * Math.cos(e);
        const vertDir = -Math.sin(e);
        if (Math.abs(latDir) > 1e-6) {
          sp.lateral = stepToward(sp.lateral, latDir > 0 ? bounds.maxLateral : -bounds.maxLateral, latStep * Math.abs(latDir));
        }
        if (Math.abs(vertDir) > 1e-6) {
          sp.vertical = stepToward(sp.vertical, vertDir > 0 ? bounds.maxRise : -bounds.maxSink, vertStep * Math.abs(vertDir));
        }
      }
    }
    // speed
    let target = 1;
    if (row.speed === "slow") target = limits.slowSpeedScale;
    else if (row.speed === "min") target = bounds.minSpeedScale;
    target = Math.min(target, speedCap);
    sp.speedScale = stepToward(sp.speedScale, target, rates.speedPerSec * dt);
  }

  /** Drive distanceScale / framing from a confident framing answer. */
  function driveFraming(choice, dt, sf) {
    const fr = sp.framing;
    if (choice === "recenter") {
      const s = sf && typeof sf === "object" && sf.subject && typeof sf.subject === "object" ? sf.subject : null;
      const ndc = s && Array.isArray(s.ndc) ? s.ndc : null;
      const x = ndc ? fin(ndc[0], NaN) : NaN;
      const y = ndc ? fin(ndc[1], NaN) : NaN;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const vfovDeg = clamp(fin(sf?.pose?.fov, 60), 1, 170);
        const aspect = fin(sf?.aspect, limits.aspect) > 0 ? fin(sf?.aspect, limits.aspect) : limits.aspect;
        const tv = Math.tan((vfovDeg * DEG) / 2);
        const errH = Math.atan(clamp(x, -3, 3) * aspect * tv);
        const errP = Math.atan(clamp(y, -3, 3) * tv);
        const step = limits.maxFramingDeg > 0 ? rates.framingDegPerSec * DEG * dt : 0;
        fr.dh = stepToward(fr.dh, fr.dh + errH, step);
        fr.dp = stepToward(fr.dp, fr.dp + errP, step);
      }
    } else if (choice === "widen") {
      if (sp.distanceScale < bounds.maxDistanceScale - 1e-9) {
        sp.distanceScale = stepToward(sp.distanceScale, bounds.maxDistanceScale, rates.distancePerSec * dt);
      } else {
        fr.dfovDeg = stepToward(fr.dfovDeg, limits.maxDfovDeg, rates.fovDegPerSec * dt);
      }
    } else if (choice === "tighten") {
      if (sp.distanceScale > minDist + 1e-9) {
        sp.distanceScale = stepToward(sp.distanceScale, minDist, rates.distancePerSec * dt);
      } else {
        fr.dfovDeg = stepToward(fr.dfovDeg, -limits.maxDfovDeg, rates.fovDegPerSec * dt);
      }
    }
  }

  /** Low-confidence framing answer: framing channels decay toward neutral (rate-limited). */
  function decayFraming(dt) {
    const fr = sp.framing;
    fr.dh = decayToward(fr.dh, 0, dt, rates.framingDegPerSec * DEG);
    fr.dp = decayToward(fr.dp, 0, dt, rates.framingDegPerSec * DEG);
    fr.dfovDeg = decayToward(fr.dfovDeg, 0, dt, rates.fovDegPerSec);
    sp.distanceScale = decayToward(sp.distanceScale, 1, dt, rates.distancePerSec);
  }

  /** Clamp every channel to its bounds; NaN → neutral. */
  function clampAll() {
    const f = (v, n) => (Number.isFinite(v) ? v : n);
    sp.lateral = clamp(f(sp.lateral, 0), -bounds.maxLateral, bounds.maxLateral);
    sp.vertical = clamp(f(sp.vertical, 0), -bounds.maxSink, bounds.maxRise);
    sp.speedScale = clamp(f(sp.speedScale, 1), bounds.minSpeedScale, bounds.maxSpeedScale);
    sp.distanceScale = clamp(f(sp.distanceScale, 1), minDist, bounds.maxDistanceScale);
    sp.framing.dh = clamp(f(sp.framing.dh, 0), -maxFraming, maxFraming);
    sp.framing.dp = clamp(f(sp.framing.dp, 0), -maxFraming, maxFraming);
    sp.framing.dfovDeg = clamp(f(sp.framing.dfovDeg, 0), -limits.maxDfovDeg, limits.maxDfovDeg);
  }

  /**
   * Apply one tick's answers (see createResidualMapper).
   * @param {object|null} answers Decisions-API shaped answers
   * @param {{sceneTime?:number, now?:number, sensorFrame?:object, source?:string}} [ctx]
   * @returns {object} Setpoint
   */
  function apply(answers, ctx = {}) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const sf = c.sensorFrame && typeof c.sensorFrame === "object" ? c.sensorFrame : null;
    let t = Number(c.now);
    if (c.now == null || !Number.isFinite(t)) t = lastNow ?? 0;
    const dt = lastNow == null ? 0 : clamp(t - lastNow, 0, rates.maxDtSec);
    if (lastNow == null || t > lastNow) lastNow = t;
    counters.applies += 1;
    sp.source = typeof c.source === "string" && c.source ? c.source : "none";

    if (!answers || typeof answers !== "object" || !answers.maneuver || typeof answers.maneuver !== "object") {
      sp.status = "empty";
      counters.empty += 1;
      return snapshot(t);
    }
    const sceneTime = c.sceneTime == null ? t : Number(c.sceneTime);
    const age = t - sceneTime;
    if (!(age <= staleSec + 1e-9)) {
      sp.status = "stale";
      counters.stale += 1;
      return snapshot(t);
    }

    // risk (thresholded against overrideRisk only)
    const riskAns = answers.risk && typeof answers.risk === "object" ? answers.risk : null;
    const risk = riskAns ? fin(riskAns.score, 0) : 0;
    sp.risk = risk;

    // subject lost (noul)
    const lostAns = answers.subject_lost && typeof answers.subject_lost === "object" ? answers.subject_lost : null;
    sp.subjectLost = lostAns ? fin(lostAns.noul, 0) >= limits.lostThreshold : false;

    // occluder
    const occ = answers.occluder_action && typeof answers.occluder_action === "object" ? answers.occluder_action : null;
    const occChoice = occ && answerConfidence(occ) >= minConfidence ? occ.choice : "ignore";
    sp.fadeIds = occChoice === "fade" ? occluderIds(sf, limits.maxFadeIds) : [];
    // A fade with nothing to fade would leave the subject hidden: reroute instead.
    const fadeFallback = occChoice === "fade" && sp.fadeIds.length === 0;
    if (fadeFallback) counters.fadeFallbacks += 1;
    sp.reroute = occChoice === "reroute" || fadeFallback;
    let speedCap = Infinity;
    if (occChoice === "wait") speedCap = Math.min(speedCap, limits.waitSpeedScale);
    if (sp.subjectLost) speedCap = Math.min(speedCap, limits.lostSpeedScale);

    // maneuver (commit window, confidence)
    const m = answers.maneuver;
    let status = "applied";
    if (answerConfidence(m) < minConfidence) {
      decayMotion(dt, sf, speedCap);
      status = "decay";
      counters.decayed += 1;
    } else {
      const proposed = MANEUVERS.includes(m.choice) ? m.choice : "hold_path";
      if (committed == null) {
        committed = proposed;
        commitAt = t;
      } else if (proposed !== committed) {
        if (committed === "hold_path" || t - commitAt >= commitSec - 1e-9) {
          committed = proposed;
          commitAt = t;
          counters.switches += 1;
        } else if (risk >= overrideRisk) {
          committed = proposed;
          commitAt = t;
          counters.overrides += 1;
          status = "override";
        } else {
          counters.held += 1;
          status = "held";
        }
      }
      driveMotion(committed, dt, sf, speedCap);
      counters.applied += 1;
    }
    sp.maneuver = committed ?? "hold_path";
    sp.status = status;

    // framing
    const fr = answers.framing && typeof answers.framing === "object" ? answers.framing : null;
    if (fr && !sp.subjectLost) {
      if (answerConfidence(fr) >= minConfidence) driveFraming(fr.choice, dt, sf);
      else decayFraming(dt);
    }

    clampAll();
    return snapshot(t);
  }

  return {
    apply,
    /** @returns {object} copy of the current setpoint */
    current: () => snapshot(lastNow),
    reset,
    /** @returns {{applies:number, applied:number, held:number, overrides:number, switches:number,
     *   decayed:number, stale:number, empty:number, fadeFallbacks:number}} */
    stats: () => ({ ...counters }),
    get bounds() {
      return bounds;
    },
    get config() {
      return config;
    },
  };
}
