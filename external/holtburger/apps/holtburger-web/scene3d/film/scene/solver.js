// scene3d/film/scene/solver.js — camera-position candidates for a shot intent (SPEC §2.15).
//
// WHY: before a take the director (Claude) and JEV must agree on WHERE the
// camera stands: "a medium shot, eye level, subject on the left third,
// backlit, not behind a tree". Searching that by hand per shot is slow and
// the director cannot see the scene geometry. The solver turns an INTENT
// into a handful of concrete, deterministic camera poses around the subject
// (generateCandidates), the page measures each one (visibility ray fan,
// clearance and particle risk through scene/los.js + perception), and the
// solver scores the measurements (scoreCandidate / rankCandidates) and
// describes each candidate in short words (describeCandidate) — the option
// criteria JEV picks from (tools/film/lib/jev_tasks.mjs pickCandidate):
// "clear view, nearest tree near (5 m), subject on left third, backlit,
// eye level". Visibility and clearance are stated with the pilot's
// sense_words bands ("mostly hidden", "very close"), the exact words the
// pick instructions quote. Code does the geometry; JEV only judges between
// finished, worded options; the solver's own best is the conservative first option.
//
//   intent  {framing: 'EWS'…'ECU' | k, angle: 'eye'|'high'|'low'|'top',
//            side?: 'left'|'center'|'right'|NDC  (where the SUBJECT sits on screen,
//                   framing.js thirdsAimOffset semantics; default: lead room for a
//                   moving subject, else centre),
//            vertical?: 'upper'|'center'|'lower'|NDC (default: eye line on the upper
//                   third for MS and tighter, centre for wider framings),
//            light?: 'front'|'back'|'rim' (camera azimuth relative to ctx.sun),
//            view?: 'front'|'three-quarter'|'profile'|'back'|'any' (relative to the
//                   subject's heading, when no light is asked),
//            minClearance (m, default 1), maxOcclusion (0..1, default 0.2),
//            fov? (deg), roll? (rad, Dutch angle)}
//
// Elevation convention: the camera's elevation ABOVE the framing aim point as
// seen from the subject (+ = camera above, looking down). Azimuth: compass
// bearing (clockwise from north) from the subject to the camera. ctx.sun
// {h, p} is the direction TOWARD the sun (shots/classic.js convention): a
// camera on the sun side is front-lit, opposite it backlit.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic (seeded rng only).

import { FilmShotError } from "../core/errors.js";
import { basisFromHPR, forwardFromHP, lookRotation } from "../core/gimbal.js";
import { mulberry32 } from "../core/rng.js";
import {
  aimHeightFraction, aimPointForFraming, canonicalFraming, compositionMetrics, DEFAULT_ASPECT, distanceForFraming,
  fovForFraming, framingFactor, leadRoomSide, normalizeSubject, poseQuat, projectToNdc, thirdsAimOffset,
} from "../shots/framing.js";
import { qToBasis } from "../core/quat.js";
import { DEFAULT_FOV, GROUND_CLEARANCE, makePose } from "../shots/trajectory.js";
import { densityWord, distanceWord, kindWord, sizeWord, visibilityWord } from "../pilot/sense_words.js";
import { normalizeKind } from "./los.js";

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;

/**
 * Camera elevation bands (degrees above the aim point) per intent angle, and
 * the word describeCandidate uses.
 * @type {Readonly<Record<'eye'|'high'|'low'|'top', {minDeg:number, maxDeg:number, word:string}>>}
 */
export const SOLVER_ANGLES = Object.freeze({
  eye: Object.freeze({ minDeg: -4, maxDeg: 4, word: "eye level" }),
  high: Object.freeze({ minDeg: 25, maxDeg: 50, word: "high angle" }),
  low: Object.freeze({ minDeg: -35, maxDeg: -12, word: "low angle" }),
  top: Object.freeze({ minDeg: 84, maxDeg: 90, word: "top-down" }),
});

/**
 * Lighting intents: camera azimuth offsets from the sun's bearing (lobes, degrees),
 * the sampling half-spread, and the light angle (0 = sun behind the camera,
 * 180 = sun behind the subject) the score aims for, with its tolerance.
 * @type {Readonly<Record<'front'|'back'|'rim', {lobesDeg:number[], spreadDeg:number, targetDeg:number, toleranceDeg:number}>>}
 */
export const SOLVER_LIGHTS = Object.freeze({
  front: Object.freeze({ lobesDeg: Object.freeze([0]), spreadDeg: 35, targetDeg: 0, toleranceDeg: 45 }),
  back: Object.freeze({ lobesDeg: Object.freeze([180]), spreadDeg: 25, targetDeg: 180, toleranceDeg: 30 }),
  rim: Object.freeze({ lobesDeg: Object.freeze([140, -140]), spreadDeg: 12, targetDeg: 140, toleranceDeg: 20 }),
});

/**
 * Views relative to the subject's heading: camera azimuth offsets (degrees) from
 * the direction the subject faces; `any` = no preference.
 * @type {Readonly<Record<string, ReadonlyArray<number>|null>>}
 */
export const SOLVER_VIEWS = Object.freeze({
  front: Object.freeze([0]),
  "three-quarter": Object.freeze([45, -45]),
  profile: Object.freeze([90, -90]),
  back: Object.freeze([180]),
  any: null,
});

/**
 * Weights of the candidate cost (scoreCandidate). `hard` is added once per hard
 * violation (out of frame, under ground, too occluded, too close), so a
 * violating candidate always ranks after every clean one.
 * @type {Readonly<Record<string, number>>}
 */
export const SCORE_WEIGHTS = Object.freeze({
  hard: 100,
  occlusion: 10,
  clearance: 4,
  particles: 8,
  size: 6,
  thirds: 4,
  headroom: 6,
  tiltPerDeg: 0.2,
  light: 4,
  sunInFrame: 2,
  angle: 3,
});

/** Intent defaults. */
export const DEFAULT_INTENT = Object.freeze({ framing: "MS", angle: "eye", minClearance: 1.0, maxOcclusion: 0.2 });

/** Indoor clearance (m) kept from ctx.indoor floor / ceiling. */
export const INDOOR_CLEARANCE = 0.3;

/** A lifted / lowered candidate is kept while its real elevation stays within this many degrees of its band. */
export const ANGLE_SLACK_DEG = 10;

/**
 * Machine-readable `.code`s of the FilmShotErrors thrown by this module.
 * @type {Readonly<{BAD_INTENT:string, MISSING_SUBJECT:string, BAD_ARGUMENT:string}>}
 */
export const SOLVER_ERROR_CODES = Object.freeze({
  BAD_INTENT: "BAD_INTENT",
  MISSING_SUBJECT: "MISSING_SUBJECT",
  BAD_ARGUMENT: "BAD_ARGUMENT",
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {string} message @param {string} code @param {*} [details] @returns {FilmShotError} */
function solverError(message, code, details) {
  return new FilmShotError(message, details === undefined ? { code } : { code, details });
}

/** @param {*} v @returns {boolean} */
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Finite z from an optional height callback (a throwing callback counts as unknown). */
function sampleZ(fn, x, y) {
  if (typeof fn !== "function") return null;
  let z;
  try {
    z = fn(x, y);
  } catch {
    return null;
  }
  return isNum(z) ? z : null;
}

/** Wrap degrees into [0, 360). */
function wrap360(d) {
  const x = d % 360;
  return x < 0 ? x + 360 : x;
}

/** Short metre text: "0.6 m", "2.5 m", "4 m", "12 m". */
function fmtM(m) {
  if (m < 1) return `${(Math.round(m * 10) / 10).toFixed(1)} m`;
  if (m < 10) return `${String(Math.round(m * 2) / 2)} m`;
  return `${Math.round(m)} m`;
}

/**
 * Obstacle kind word for reasons / descriptions: the pilot vocabulary
 * (sense_words kindWord: tree, rock, wall, building, prop, door, creature,
 * player, terrain, particles) with los.js aliases ("boulder" → rock,
 * "furniture" → prop), else `fallback`.
 * @param {*} kind @param {string} fallback
 * @returns {string}
 */
function kindText(kind, fallback) {
  const w = kindWord(kind, "");
  if (w) return w;
  return normalizeKind(kind) || fallback;
}

/** @param {number} v @returns {string} percent text */
function pct(v) {
  return `${Math.round(v * 100)}%`;
}

/**
 * Resolve the shot subject: the argument, else ctx.subject, else a 1.8 m point
 * subject at ctx.anchor. Throws FilmShotError (MISSING_SUBJECT) when none.
 * @param {*} subject @param {*} ctx
 * @returns {import('../shots/framing.js').Subject}
 */
function resolveSubject(subject, ctx) {
  if (subject !== undefined && subject !== null) return normalizeSubject(subject);
  const c = ctx || {};
  if (c.subject !== undefined && c.subject !== null) return normalizeSubject(c.subject);
  if (c.anchor !== undefined && c.anchor !== null) return normalizeSubject(c.anchor);
  throw solverError("the solver needs a subject (or ctx.anchor) to place cameras around", SOLVER_ERROR_CODES.MISSING_SUBJECT);
}

/** Valid ctx.sun above the horizon (outdoors), else null. */
function usableSun(ctx) {
  const c = ctx || {};
  if (c.indoor) return null;
  const s = c.sun;
  if (!s || !isNum(s.h) || !isNum(s.p)) return null;
  if (s.p < -0.05) return null; // below the horizon: no directional sunlight
  return { h: s.h, p: s.p };
}

// ---------------------------------------------------------------------------
// intent
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SolverIntent
 * @property {string|number} framing  canonical framing (FRAMINGS name or k)
 * @property {'eye'|'high'|'low'|'top'} angle
 * @property {string|number|undefined} side      screen side of the subject (undefined = auto)
 * @property {string|number|undefined} vertical  screen height of the aim point (undefined = auto)
 * @property {'front'|'back'|'rim'|null} light
 * @property {string|null} view
 * @property {number} minClearance metres
 * @property {number} maxOcclusion 0..1
 * @property {number|null} fov degrees
 * @property {number} roll radians
 */

/**
 * Validate an intent and fill its defaults (DEFAULT_INTENT). Throws
 * FilmShotError (BAD_INTENT / BAD_FRAMING) naming the valid values.
 * @param {*} intent
 * @returns {SolverIntent}
 */
export function normalizeIntent(intent) {
  const it = intent && typeof intent === "object" ? intent : {};
  const framing = canonicalFraming(it.framing === undefined || it.framing === null ? DEFAULT_INTENT.framing : it.framing);
  const angle = it.angle === undefined || it.angle === null ? DEFAULT_INTENT.angle : String(it.angle).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SOLVER_ANGLES, angle)) {
    throw solverError(`unknown intent.angle ${JSON.stringify(it.angle)} (valid: ${Object.keys(SOLVER_ANGLES).join(", ")})`,
      SOLVER_ERROR_CODES.BAD_INTENT);
  }
  let light = null;
  if (it.light !== undefined && it.light !== null && it.light !== "") {
    light = String(it.light).trim().toLowerCase();
    if (light === "backlit") light = "back";
    if (light === "frontlit" || light === "front-lit") light = "front";
    if (!Object.prototype.hasOwnProperty.call(SOLVER_LIGHTS, light)) {
      throw solverError(`unknown intent.light ${JSON.stringify(it.light)} (valid: ${Object.keys(SOLVER_LIGHTS).join(", ")})`,
        SOLVER_ERROR_CODES.BAD_INTENT);
    }
  }
  let view = null;
  if (it.view !== undefined && it.view !== null && it.view !== "") {
    view = String(it.view).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SOLVER_VIEWS, view)) {
      throw solverError(`unknown intent.view ${JSON.stringify(it.view)} (valid: ${Object.keys(SOLVER_VIEWS).join(", ")})`,
        SOLVER_ERROR_CODES.BAD_INTENT);
    }
  }
  const side = it.side === null || it.side === "" ? undefined : it.side;
  const vertical = it.vertical === null || it.vertical === "" ? undefined : it.vertical;
  // validate placements now (thirdsAimOffset throws a readable FilmShotError on bad values)
  thirdsAimOffset({ side: side === "auto" ? undefined : side, vertical: vertical === "auto" ? undefined : vertical }, 60, 1);
  const minClearance = isNum(it.minClearance) && it.minClearance >= 0 ? it.minClearance : DEFAULT_INTENT.minClearance;
  const maxOcclusion = isNum(it.maxOcclusion) ? clamp(it.maxOcclusion, 0, 1) : DEFAULT_INTENT.maxOcclusion;
  const fov = isNum(it.fov) && it.fov > 0 && it.fov < 180 ? it.fov : null;
  const roll = isNum(it.roll) ? it.roll : 0;
  return {
    framing,
    angle,
    side: side === "auto" ? undefined : side,
    vertical: vertical === "auto" ? undefined : vertical,
    light,
    view,
    minClearance,
    maxOcclusion,
    fov,
    roll,
  };
}

/**
 * Screen placement for a subject in a pose: the intent's side / vertical, else
 * lead room for a moving subject (framing.js leadRoomSide) and the eye line on
 * the upper third for MS and tighter (centre for wider framings).
 * @param {SolverIntent} it
 * @param {import('../shots/framing.js').Subject} subj
 * @param {number[]} [camForward]
 * @returns {{side:string|number, vertical:string|number}}
 */
function placementFor(it, subj, camForward) {
  let side = it.side;
  if (side === undefined) {
    side = Array.isArray(subj.velocity) && Array.isArray(camForward) ? leadRoomSide(subj.velocity, camForward) : "center";
  }
  let vertical = it.vertical;
  if (vertical === undefined) vertical = aimHeightFraction(it.framing) >= 0.85 ? "upper" : "center";
  return { side, vertical };
}

/**
 * Angle class of a camera elevation (degrees above the aim point):
 * ≥ 65 → top, ≥ 15 → high, ≤ −5 → low, else eye.
 * @param {number} elevationDeg
 * @returns {'eye'|'high'|'low'|'top'}
 */
export function angleForElevation(elevationDeg) {
  if (!isNum(elevationDeg)) return "eye";
  if (elevationDeg >= 65) return "top";
  if (elevationDeg >= 15) return "high";
  if (elevationDeg <= -5) return "low";
  return "eye";
}

/**
 * Light angle in degrees [0, 180]: the angle at the subject between the
 * (horizontal) directions to the camera and to the sun — 0 = front-lit (sun
 * behind the camera), 90 = side-lit, 180 = backlit (camera faces the sun).
 * Null without a usable sun or when the camera is straight above the subject.
 * @param {number[]} eye camera position
 * @param {number[]} subjectPos subject position (base or centre; only xy is used)
 * @param {{h:number, p:number}|null} sun direction toward the sun
 * @returns {number|null}
 */
export function lightAngleDeg(eye, subjectPos, sun) {
  if (!sun || !isNum(sun.h) || !Array.isArray(eye) || !Array.isArray(subjectPos)) return null;
  const cx = eye[0] - subjectPos[0], cy = eye[1] - subjectPos[1];
  const l = Math.hypot(cx, cy);
  if (!(l > 1e-6) || !Number.isFinite(l)) return null;
  const sx = Math.sin(sun.h), sy = Math.cos(sun.h);
  const c = clamp((cx * sx + cy * sy) / l, -1, 1);
  return Math.acos(c) / DEG;
}

/**
 * Word for a light angle: < 45 "front-lit", < 110 "side-lit", < 155 "rim-lit", else "backlit".
 * @param {number|null} deg
 * @returns {string|null}
 */
export function lightWord(deg) {
  if (!isNum(deg)) return null;
  if (deg < 45) return "front-lit";
  if (deg < 110) return "side-lit";
  if (deg < 155) return "rim-lit";
  return "backlit";
}

/**
 * Shot-size scale of a camera: the intended frame height k·H divided by the
 * real frame height at the aim point's depth, `k·H / (2·depth·tan(fov/2))` —
 * 1 = exactly the intended framing (the pinhole definition distanceForFraming
 * inverts), > 1 = tighter, < 1 = wider. Unlike framing.js
 * compositionMetrics.sizeRatio (the projected extent of the whole body axis)
 * it stays meaningful for low-angle close-ups (feet far off-frame) and
 * top-down shots (body axis foreshortened to a point). Null when the aim point
 * is not in front of the camera.
 * @param {number[]} eye camera position
 * @param {number[]} forward camera forward (unit)
 * @param {number[]} aim framing aim point
 * @param {number} frameHeight k·H, metres
 * @param {number} fovDeg vertical fov
 * @returns {number|null}
 */
export function framingScale(eye, forward, aim, frameHeight, fovDeg) {
  if (!Array.isArray(eye) || !Array.isArray(forward) || !Array.isArray(aim)) return null;
  const depth = (aim[0] - eye[0]) * forward[0] + (aim[1] - eye[1]) * forward[1] + (aim[2] - eye[2]) * forward[2];
  if (!(depth > 1e-6) || !isNum(frameHeight) || !(fovDeg > 0 && fovDeg < 180)) return null;
  const v = frameHeight / (2 * depth * Math.tan((fovDeg * DEG) / 2));
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// candidate generation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CandidateMeta
 * @property {number} index        position in the returned list
 * @property {string} id           "c1", "c2", … (never integer-like: JEV choice keys keep their order)
 * @property {'eye'|'high'|'low'|'top'} angle  the intent angle it was generated for
 * @property {number} azimuthDeg   compass bearing subject → camera, [0, 360)
 * @property {number} elevationDeg camera elevation above the aim point (after any lift)
 * @property {number} distance     camera → aim point (m)
 * @property {number[]} aim        the framing aim point
 * @property {string|number} framing
 * @property {string|number} side
 * @property {string|number} vertical
 * @property {number|null} lightAngleDeg
 * @property {boolean} lifted      moved onto the ground / floor clearance plane (or under a ceiling)
 * @property {boolean} relaxed     produced by the relaxed fill (its angle may differ from the intent)
 * @property {number} aspect
 */

/**
 * Deterministic camera candidates around a subject for an intent (SPEC §2.15).
 *
 * - Lens: opts.fov, else intent.fov, else ctx.fov, else 60°.
 * - Distance: distanceForFraming(framing, subject height, fov), never under
 *   radius + 0.5 m — a tighter framing then narrows the fov instead (unless
 *   opts / intent fixed it); each candidate aims at a shot-size scale in
 *   [0.92, 1.08] (variety) and is slid along its line to the aim point (or
 *   level, when parked on the ground plane) until framingScale hits it.
 * - Elevation: sampled inside SOLVER_ANGLES[angle]; top shots start ≥ 1 m above
 *   the subject's head.
 * - Azimuth: stratified over the preference lobes — ctx.sun + intent.light
 *   (front: the sun side; back: opposite; rim: 140° off the sun, both sides),
 *   else intent.view relative to subject.heading, else the subject's front
 *   (±70°) when it has a heading, else the full circle.
 * - Orientation: lookRotation at the aim point plus the placement's thirds
 *   offset, refined by Newton steps so the aim point lands EXACTLY on its NDC
 *   mark at any pitch and roll (intent.roll = Dutch angle); steep shots
 *   (|pitch| > ≈70°, incl. straight down) keep the look direction and slide
 *   the camera in the image plane instead, so top-down placements never spin
 *   the gimbal (heading = subject heading at the nadir).
 * - Legality (below-ground rejection): a camera under groundZ + 0.7 m
 *   (outdoors) or outside floor + 0.3 … ceiling − 0.3 (ctx.indoor; groundZ is
 *   never consulted indoors) is moved onto that plane only when its real
 *   elevation stays within ANGLE_SLACK_DEG of the asked band, otherwise
 *   discarded; cameras inside the subject's volume are discarded. No returned
 *   pose is ever under the clearance plane.
 * - Sampling stops after count × 8 attempts. When NOTHING honours the angle
 *   (a pit, a low ceiling, a low angle on a wide shot) a relaxed pass fills
 *   the list with legal cameras whatever their angle (`meta.relaxed`; the score
 *   then explains the angle mismatch). The array's non-enumerable `stats`
 *   counts attempts, rejections and relaxed fills.
 *
 * Deterministic: the same intent, subject, ctx and rng seed give identical
 * poses. rng = opts.rng, else ctx.rng, else mulberry32(opts.seed ?? 0).
 * @param {object} intent see SolverIntent (normalizeIntent fills defaults)
 * @param {*} subject ShotContext subject {pos (base), radius, height, heading?, velocity?} or [x,y,z];
 *   null → ctx.subject → ctx.anchor
 * @param {{groundZ?:(x:number,y:number)=>number|null, sun?:{h:number,p:number}, aspect?:number,
 *   fov?:number, indoor?:{floor?:Function, ceiling?:Function}|null, rng?:()=>number, subject?:*, anchor?:number[]}} [ctx]
 * @param {{count?:number, rng?:()=>number, seed?:*, fov?:number}} [opts] count 12 (0..256)
 * @returns {Array<import('../shots/trajectory.js').Pose & {meta: CandidateMeta}> &
 *   {stats?: {attempts:number, relaxed:number, rejected:{ground:number, indoor:number, inside:number, invalid:number}}}}
 */
export function generateCandidates(intent, subject, ctx, opts = {}) {
  const it = normalizeIntent(intent);
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const o = opts || {};
  const subj = resolveSubject(subject, c);
  const count = isNum(o.count) ? Math.max(0, Math.min(256, Math.floor(o.count))) : 12;
  const stats = { attempts: 0, relaxed: 0, rejected: { ground: 0, indoor: 0, inside: 0, invalid: 0 } };
  const out = [];
  Object.defineProperty(out, "stats", { value: stats, enumerable: false });
  if (count === 0) return out;

  const lensFixed = (isNum(o.fov) && o.fov > 0 && o.fov < 180) || it.fov !== null;
  const fovRaw = isNum(o.fov) ? o.fov : it.fov !== null ? it.fov : isNum(c.fov) ? c.fov : DEFAULT_FOV;
  let fov = fovRaw > 0 && fovRaw < 180 ? fovRaw : DEFAULT_FOV;
  const aspect = isNum(c.aspect) && c.aspect > 0 ? c.aspect : DEFAULT_ASPECT;
  const rng = typeof o.rng === "function" ? o.rng : typeof c.rng === "function" ? c.rng : mulberry32(o.seed ?? 0);
  const indoor = c.indoor && typeof c.indoor === "object" ? c.indoor : null;
  const sun = usableSun(c);
  const band = SOLVER_ANGLES[it.angle];
  const aim = aimPointForFraming(it.framing, subj);
  const top = subj.pos[2] + subj.height;
  // Never closer than radius + 0.5 m: a tight framing then takes a longer lens
  // (narrower fov keeps the framing) unless the intent fixed the fov.
  const kFrame = framingFactor(it.framing);
  let d0 = distanceForFraming(it.framing, subj.height, fov);
  const dMin = subj.radius + 0.5;
  if (d0 < dMin) {
    d0 = dMin;
    if (!lensFixed) fov = fovForFraming(it.framing, subj.height, dMin);
  }
  const heading = isNum(subj.heading) ? subj.heading / DEG : null;

  // Azimuth preference: lobes (degrees) + half-spread, or null = full circle.
  let lobes = null;
  let spread = 0;
  if (it.light && sun) {
    const L = SOLVER_LIGHTS[it.light];
    lobes = L.lobesDeg.map((l) => sun.h / DEG + l);
    spread = L.spreadDeg;
  } else if (it.view && SOLVER_VIEWS[it.view] && heading !== null) {
    lobes = SOLVER_VIEWS[it.view].map((l) => heading + l);
    spread = 20;
  } else if (heading !== null && it.view !== "any") {
    lobes = [heading];
    spread = 70;
  }
  const phase = rng() * 360;

  /** Camera elevation (deg) of an eye above the aim point. */
  const elevationOf = (eye) => Math.atan2(eye[2] - aim[2], Math.hypot(eye[0] - aim[0], eye[1] - aim[1])) / DEG;
  /** Distance (deg) of an elevation from the asked band. */
  const offBand = (e) => Math.abs(e - clamp(e, band.minDeg, band.maxDeg));

  /** Vertical legality: `{z, lifted}` (z moved onto the clearance plane when lifted) or `{reject}` (no room). */
  const legalZ = (x, y, z) => {
    if (indoor) {
      const fl = sampleZ(indoor.floor, x, y);
      const ce = sampleZ(indoor.ceiling, x, y);
      const lo = fl !== null ? fl + INDOOR_CLEARANCE : -Infinity;
      const hi = ce !== null ? ce - INDOOR_CLEARANCE : Infinity;
      if (lo > hi) return { reject: "indoor" };
      if (z < lo) return { z: lo, lifted: true };
      if (z > hi) return { z: hi, lifted: true };
      return { z, lifted: false };
    }
    const g = sampleZ(c.groundZ, x, y);
    if (g !== null && z < g + GROUND_CLEARANCE) return { z: g + GROUND_CLEARANCE, lifted: true };
    return { z, lifted: false };
  };

  const insideSubject = (eye) => {
    const hd = Math.hypot(eye[0] - subj.pos[0], eye[1] - subj.pos[1]);
    return hd < subj.radius + 0.25 && eye[2] > subj.pos[2] - 0.2 && eye[2] < top + 0.2;
  };

  /**
   * Orientation for an eye: look at the aim point, then place the subject on its
   * mark. Ordinary shots: the thirds gimbal offsets (thirdsAimOffset, exact at
   * pitch 0) followed by a few Newton steps on (h, p) that put the aim point
   * exactly on its NDC mark at any pitch and roll. Steep / top-down shots
   * (|pitch| > ≈70°) keep the look direction and slide the camera in the
   * (rolled) image plane instead, so the gimbal never spins at the nadir.
   */
  const orient = (eye0, f, hint) => {
    const tY = Math.tan((f * DEG) / 2), tX = tY * aspect;
    const look = lookRotation(eye0, aim, { headingHint: hint, holdConeDeg: 1.5 });
    const place = placementFor(it, subj, forwardFromHP(look.h, look.p));
    const off = thirdsAimOffset(place, f, aspect);
    const sx = -Math.tan(off.dh) / tX, sy = -Math.tan(off.dp) / tY; // the placement's NDC target
    const r = it.roll;
    let h = look.h, p = look.p, eye = eye0;
    if (Math.cos(p) > 0.35) {
      h += off.dh;
      p = clamp(p + off.dp, -HALF_PI, HALF_PI);
      const ndc = (hh, pp) => projectToNdc({ pos: eye0, h: hh, p: pp, r }, aim, f, aspect);
      for (let i = 0; i < 6; i++) {
        const P = ndc(h, p);
        const ex = P.x - sx, ey = P.y - sy;
        if (!P.inFront || (Math.abs(ex) < 1e-10 && Math.abs(ey) < 1e-10)) break;
        const e = 1e-6;
        const Ph = ndc(h + e, p), Pp = ndc(h, p + e);
        const a = (Ph.x - P.x) / e, b = (Pp.x - P.x) / e, c2 = (Ph.y - P.y) / e, d2 = (Pp.y - P.y) / e;
        const det = a * d2 - b * c2;
        if (!(Math.abs(det) > 1e-12)) break;
        h -= (d2 * ex - b * ey) / det;
        p = clamp(p - (-c2 * ex + a * ey) / det, -HALF_PI, HALF_PI);
      }
    } else {
      // (inside the lookRotation hold cone the look may miss the aim by up to 3°: the
      // shift below corrects that too — it moves the aim exactly onto its NDC mark)
      const B = basisFromHPR(h, p, r);
      const rel = [aim[0] - eye0[0], aim[1] - eye0[1], aim[2] - eye0[2]];
      const depth = rel[0] * B.forward[0] + rel[1] * B.forward[1] + rel[2] * B.forward[2];
      const xc = rel[0] * B.right[0] + rel[1] * B.right[1] + rel[2] * B.right[2];
      const yc = rel[0] * B.up[0] + rel[1] * B.up[1] + rel[2] * B.up[2];
      const kx = sx * depth * tX - xc, ky = sy * depth * tY - yc;
      eye = [
        eye0[0] - kx * B.right[0] - ky * B.up[0],
        eye0[1] - kx * B.right[1] - ky * B.up[1],
        eye0[2] - kx * B.right[2] - ky * B.up[2],
      ];
    }
    return { eye, h, p, place };
  };

  /**
   * orient() whose final eye is legal: a steep shot's image-plane slide that dips
   * under the ground / floor clearance plane is answered by raising the base and
   * orienting again (≤ 3 tries). Null when no legal placement exists.
   */
  const orientLegal = (base0, f, hint) => {
    let b = base0;
    for (let i = 0; i < 3; i++) {
      const o2 = orient(b, f, hint);
      const v = legalZ(o2.eye[0], o2.eye[1], o2.eye[2]);
      if (v.reject) return null;
      if (!v.lifted) return insideSubject(o2.eye) ? null : { base: b, built: o2, adjusted: i > 0 };
      const dz = v.z - o2.eye[2];
      b = [b[0], b[1], b[2] + dz + (dz >= 0 ? 1e-6 : -1e-6)];
    }
    return null;
  };

  /** Framing scale (framingScale) of an oriented eye. */
  const sizeRatioOf = (o2, f) => framingScale(o2.eye, forwardFromHP(o2.h, o2.p), aim, kFrame * subj.height, f);

  /** The point `dist` from the aim point on the aim→base line. */
  const slideAlong = (base, dist) => {
    const L = Math.hypot(base[0] - aim[0], base[1] - aim[1], base[2] - aim[2]);
    if (!(L > 1e-9)) return null;
    const k = dist / L;
    return [aim[0] + (base[0] - aim[0]) * k, aim[1] + (base[1] - aim[1]) * k, aim[2] + (base[2] - aim[2]) * k];
  };
  /** The point `dist` from the aim point at the base's height (a camera parked on the ground plane slides level). */
  const slideLevel = (base, dist) => {
    const dz = base[2] - aim[2];
    const hd2 = dist * dist - dz * dz;
    const minH = subj.radius + 0.3;
    if (!(hd2 > minH * minH)) return null;
    const hx = base[0] - aim[0], hy = base[1] - aim[1];
    const hl = Math.hypot(hx, hy);
    if (!(hl > 1e-9)) return null;
    const hd = Math.sqrt(hd2);
    return [aim[0] + (hx / hl) * hd, aim[1] + (hy / hl) * hd, base[2]];
  };

  /** One sampling attempt; pushes a pose or counts the rejection. `slack` = ANGLE_SLACK_DEG or Infinity. */
  const attemptOnce = (attempt, slack) => {
    stats.attempts += 1;
    const slot = attempt % count;
    let azDeg;
    if (lobes) {
      const lobe = lobes[slot % lobes.length];
      const per = Math.ceil(count / lobes.length);
      const k = Math.floor(slot / lobes.length);
      azDeg = lobe + spread * (2 * ((k + rng()) / per) - 1);
    } else {
      azDeg = phase + (360 * (slot + rng())) / count;
    }
    const eDeg = band.minDeg + (band.maxDeg - band.minDeg) * rng();
    const targetSize = 1 + 0.08 * (2 * rng() - 1); // ±8 % shot-size variety
    const az = azDeg * DEG, e = eDeg * DEG;
    const d = Math.max(dMin, d0 / targetSize);
    let eye = [
      aim[0] + d * Math.sin(az) * Math.cos(e),
      aim[1] + d * Math.cos(az) * Math.cos(e),
      aim[2] + d * Math.sin(e),
    ];
    if (it.angle === "top") eye[2] = Math.max(eye[2], top + 1);

    let lifted = false;
    const v = legalZ(eye[0], eye[1], eye[2]);
    if (v.reject) {
      stats.rejected.indoor += 1;
      return;
    }
    if (v.lifted) {
      eye = [eye[0], eye[1], v.z];
      lifted = true;
      if (offBand(elevationOf(eye)) > slack) {
        stats.rejected[indoor ? "indoor" : "ground"] += 1;
        return;
      }
    }
    if (insideSubject(eye)) {
      stats.rejected.inside += 1;
      return;
    }
    // From here the camera only slides toward / away from the aim point (and may narrow its lens).
    const hint = it.angle === "top" && heading !== null ? heading * DEG : az + Math.PI;
    let f = fov;
    const first = orientLegal(eye, f, hint);
    if (!first) {
      stats.rejected[indoor ? "indoor" : "ground"] += 1;
      return;
    }
    let base = first.base;
    let built = first.built;
    if (first.adjusted) lifted = true;
    // Size refinement: the thirds offset and perspective move the aim depth off
    // the pinhole distance; re-measure and slide / re-lens (converges in 1-2 steps).
    for (let iter = 0; iter < 4; iter++) {
      const sr = sizeRatioOf(built, f);
      if (!(sr > 0) || !Number.isFinite(sr)) break;
      const k = sr / targetSize;
      if (Math.abs(k - 1) < 0.005) break;
      const d = Math.hypot(base[0] - aim[0], base[1] - aim[1], base[2] - aim[2]);
      let dNew = d * clamp(k, 0.5, 2);
      let fNew = f;
      if (dNew < dMin) {
        if (!lensFixed) {
          const t = Math.tan((f * DEG) / 2) * (dNew / dMin);
          fNew = clamp((2 * Math.atan(t)) / DEG, 1, 170);
        }
        dNew = Math.max(dMin, Math.min(d, dNew));
      }
      let moved = null;
      for (const cand of [slideAlong(base, dNew), slideLevel(base, dNew)]) {
        if (!cand) continue;
        moved = orientLegal(cand, fNew, hint);
        if (moved) break;
      }
      if (!moved) break;
      base = moved.base;
      built = moved.built;
      f = fNew;
      if (moved.adjusted) lifted = true;
    }

    let pose;
    try {
      pose = makePose({ t: 0, pos: built.eye, h: built.h, p: built.p, r: it.roll, fov: f });
    } catch {
      stats.rejected.invalid += 1;
      return;
    }
    const fe = built.eye;
    const index = out.length;
    pose.meta = {
      index,
      id: `c${index + 1}`,
      angle: it.angle,
      azimuthDeg: wrap360(Math.atan2(fe[0] - subj.pos[0], fe[1] - subj.pos[1]) / DEG),
      elevationDeg: elevationOf(fe),
      distance: Math.hypot(fe[0] - aim[0], fe[1] - aim[1], fe[2] - aim[2]),
      aim: aim.slice(),
      framing: it.framing,
      side: built.place.side,
      vertical: built.place.vertical,
      lightAngleDeg: it.angle === "top" ? null : lightAngleDeg(fe, subj.pos, sun),
      lifted,
      relaxed: slack === Infinity,
      aspect,
    };
    out.push(pose);
  };

  const maxAttempts = count * 8;
  for (let attempt = 0; out.length < count && attempt < maxAttempts; attempt++) attemptOnce(attempt, ANGLE_SLACK_DEG);
  if (out.length === 0) {
    // Nothing honours the angle here (a pit, a low ceiling, a low angle on a wide shot):
    // fill with cameras moved onto the legal plane whatever their angle, flagged relaxed.
    for (let attempt = 0; out.length < count && attempt < maxAttempts; attempt++) attemptOnce(attempt, Infinity);
    stats.relaxed = out.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// metrics, scoring, words
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CandidateMetrics
 * @property {number|null} visibleFrac   0..1 visible fraction of the subject (perception ray fan); null = not measured
 * @property {string|null} occluderKind  what hides it (los kind words)
 * @property {number|null} clearance     metres from the camera to the nearest obstacle (Infinity = nothing in range)
 * @property {string|null} nearestKind   kind of that obstacle
 * @property {number} particleRisk       0..1 particle density in view / on the lens
 * @property {string|null} particleFamily e.g. "smoke"
 * @property {object|null} composition   framing.compositionMetrics(pose, subject, fov, aspect, {framing, thirds})
 * @property {number|null} sizeRatio     shot-size scale (framingScale: 1 = the intended framing); the size
 *                                       the solver scores and words (composition.sizeRatio is the projected
 *                                       body-axis extent, unstable for low close-ups and top-down shots)
 * @property {number|null} lightAngleDeg 0 front-lit … 180 backlit (null: no sun / indoors / top-down)
 * @property {boolean} sunInFrame        the sun's direction projects inside the frame
 * @property {boolean} belowGround       camera under the outdoor ground (never set indoors)
 * @property {number|null} groundClearance camera height above the outdoor ground (m)
 * @property {number} elevationDeg       camera elevation above the aim point
 * @property {'eye'|'high'|'low'|'top'} angle angleForElevation(elevationDeg)
 * @property {number} distance           camera → aim point (m)
 */

/**
 * Assemble the CandidateMetrics of one pose: geometry the solver can compute
 * itself (composition via framing.compositionMetrics against the intent's
 * placement, light angle and sun-in-frame from ctx.sun, ground clearance from
 * ctx.groundZ outdoors, elevation / angle class) merged with what the page
 * MEASURED (`measured`: visibleFrac, occluderKind, clearance, nearestKind,
 * particleRisk, particleFamily — from the perception ray fan / los sweeps).
 * @param {{pos:number[], q?:number[], h?:number, p?:number, r?:number, fov?:number, meta?:object}} pose
 * @param {*} subject subject (or null → ctx.subject / ctx.anchor)
 * @param {object} [ctx] {groundZ, sun, aspect, indoor}
 * @param {{visibleFrac?:number, occluderKind?:string, clearance?:number, nearestKind?:string,
 *   particleRisk?:number, particleFamily?:string}} [measured]
 * @param {object} [intent]
 * @returns {CandidateMetrics}
 */
export function candidateMetrics(pose, subject, ctx = {}, measured = {}, intent = {}) {
  const it = normalizeIntent(intent);
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const m = measured && typeof measured === "object" ? measured : {};
  const subj = resolveSubject(subject, c);
  if (!pose || !Array.isArray(pose.pos) || !pose.pos.every(isNum)) {
    throw solverError("candidateMetrics: pose.pos must be a finite [x,y,z]", SOLVER_ERROR_CODES.BAD_ARGUMENT);
  }
  const fov = isNum(pose.fov) && pose.fov > 0 && pose.fov < 180 ? pose.fov : DEFAULT_FOV;
  const aspect = isNum(c.aspect) && c.aspect > 0 ? c.aspect
    : pose.meta && isNum(pose.meta.aspect) && pose.meta.aspect > 0 ? pose.meta.aspect : DEFAULT_ASPECT;
  const aim = aimPointForFraming(it.framing, subj);
  const eye = pose.pos;
  const look = lookRotation(eye, aim);
  const place = placementFor(it, subj, forwardFromHP(look.h, look.p));
  const composition = compositionMetrics(pose, subj, fov, aspect, { framing: it.framing, thirds: place });
  const sun = usableSun(c);
  let sunInFrame = false;
  if (sun) {
    const d = forwardFromHP(sun.h, sun.p);
    sunInFrame = projectToNdc(pose, [eye[0] + d[0] * 1e4, eye[1] + d[1] * 1e4, eye[2] + d[2] * 1e4], fov, aspect).onScreen;
  }
  let groundClearance = null;
  if (!c.indoor) {
    const g = sampleZ(c.groundZ, eye[0], eye[1]);
    if (g !== null) groundClearance = eye[2] - g;
  }
  const elevationDeg = Math.atan2(eye[2] - aim[2], Math.hypot(eye[0] - aim[0], eye[1] - aim[1])) / DEG;
  const angle = angleForElevation(elevationDeg);
  const sizeRatio = framingScale(eye, qToBasis(poseQuat(pose)).forward, aim, framingFactor(it.framing) * subj.height, fov);
  const num = (v) => (typeof v === "number" && !Number.isNaN(v) ? v : null);
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    visibleFrac: num(m.visibleFrac) === null ? null : clamp(m.visibleFrac, 0, 1),
    occluderKind: str(m.occluderKind),
    clearance: num(m.clearance) === null ? null : Math.max(0, m.clearance),
    nearestKind: str(m.nearestKind),
    particleRisk: num(m.particleRisk) === null ? 0 : clamp(m.particleRisk, 0, 1),
    particleFamily: str(m.particleFamily),
    composition,
    sizeRatio,
    lightAngleDeg: angle === "top" ? null : lightAngleDeg(eye, subj.pos, sun),
    sunInFrame,
    belowGround: groundClearance !== null && groundClearance < 0,
    groundClearance,
    elevationDeg,
    angle,
    distance: Math.hypot(eye[0] - aim[0], eye[1] - aim[1], eye[2] - aim[2]),
  };
}

/**
 * Cost of one candidate's metrics against an intent (lower is better), with
 * the human reasons behind every notable contribution (SPEC §2.15). Hard
 * violations add SCORE_WEIGHTS.hard (+ a proportional term) and set ok=false:
 * camera under ground, subject out of frame / behind the camera, occlusion
 * above intent.maxOcclusion, clearance under intent.minClearance. Soft terms:
 * occlusion, clearance (decays above the minimum), particle risk, size error
 * |ln sizeRatio| (metrics.sizeRatio, else composition.sizeRatio), distance from the placement mark (thirdsError), headroom
 * (MS and wider), horizon tilt vs intent.roll, light angle vs intent.light,
 * sun in frame (unless backlit was asked), angle class vs intent.angle.
 * Missing measurements (null) cost nothing. Never throws on metrics content.
 * @param {CandidateMetrics} metrics
 * @param {object} intent
 * @returns {{cost:number, reasons:string[], ok:boolean}}
 */
export function scoreCandidate(metrics, intent) {
  const it = normalizeIntent(intent);
  const m = metrics && typeof metrics === "object" ? metrics : {};
  const W = SCORE_WEIGHTS;
  const reasons = [];
  let cost = 0;
  let ok = true;
  const hard = (msg, extra) => {
    ok = false;
    cost += W.hard + (isNum(extra) ? Math.max(0, extra) : 0);
    reasons.push(msg);
  };
  const soft = (amount, msg) => {
    if (!(amount > 0) || !Number.isFinite(amount)) return;
    cost += amount;
    if (msg && amount >= 0.5) reasons.push(msg);
  };

  if (m.belowGround === true) hard("camera under the ground", 9 * W.hard);

  const comp = m.composition && typeof m.composition === "object" ? m.composition : null;
  if (!comp || comp.inFrame !== true) {
    hard(comp && comp.inFront === false ? "subject behind the camera" : "subject out of frame", comp ? 0 : W.hard);
  }

  if (isNum(m.visibleFrac)) {
    const occl = 1 - clamp(m.visibleFrac, 0, 1);
    const by = m.occluderKind ? ` by ${kindText(m.occluderKind, "something")}` : "";
    if (occl > it.maxOcclusion + 1e-9) {
      hard(`subject ${pct(occl)} hidden${by} (max ${pct(it.maxOcclusion)})`, 50 * occl);
    } else {
      soft(W.occlusion * occl, `subject ${pct(occl)} hidden${by}`);
    }
  }

  if (isNum(m.clearance) || m.clearance === Infinity) {
    const cl = m.clearance;
    const kind = kindText(m.nearestKind, "obstacle");
    if (cl < it.minClearance) {
      hard(`${fmtM(cl)} from ${kind}, under the ${fmtM(it.minClearance)} minimum`, 20 * (it.minClearance - cl));
    } else if (Number.isFinite(cl)) {
      soft(W.clearance * Math.exp(-(cl - it.minClearance) / 2), `${fmtM(cl)} from nearest ${kind}`);
    }
  }

  if (isNum(m.particleRisk) && m.particleRisk > 0) {
    const risk = clamp(m.particleRisk, 0, 1);
    soft(W.particles * risk, `${densityWord(risk)} ${m.particleFamily || "particles"} in view`);
  }

  if (comp) {
    const sr = isNum(m.sizeRatio) ? m.sizeRatio : comp.sizeRatio;
    if (isNum(sr) && sr > 0) {
      const sw = sizeWord(sr);
      soft(W.size * Math.abs(Math.log(sr)), `subject ${sw === "right" ? "slightly off size" : sw} (${sr.toFixed(2)}× ${it.framing})`);
    }
    if (isNum(comp.thirdsError)) {
      soft(W.thirds * comp.thirdsError, `subject ${comp.thirdsError.toFixed(2)} off its mark`);
    }
    if (isNum(comp.headroom) && framingFactor(it.framing) >= 0.5) {
      if (comp.headroom < 0) soft(W.headroom * Math.min(1, -comp.headroom * 4), "head cut off");
      else if (comp.headroom > 0.35) soft(W.headroom * (comp.headroom - 0.35), "too much headroom");
    }
    if (isNum(comp.horizonTiltDeg)) {
      let dt = comp.horizonTiltDeg - it.roll / DEG;
      dt = ((dt + 180) % 360 + 360) % 360 - 180;
      if (Math.abs(dt) >= 2.5) soft(W.tiltPerDeg * Math.abs(dt), `horizon tilted ${Math.round(Math.abs(dt))}°`);
    }
  }

  if (it.light && isNum(m.lightAngleDeg)) {
    const L = SOLVER_LIGHTS[it.light];
    const err = Math.abs(m.lightAngleDeg - L.targetDeg);
    if (err > L.toleranceDeg) {
      soft(W.light * ((err / 90) ** 2), `${lightWord(m.lightAngleDeg)}, wanted ${it.light === "back" ? "backlit" : `${it.light}-lit`}`);
    }
  }
  if (m.sunInFrame === true && it.light !== "back") soft(W.sunInFrame, "sun in frame");

  if (typeof m.angle === "string" && m.angle !== it.angle && SOLVER_ANGLES[m.angle]) {
    soft(W.angle, `${SOLVER_ANGLES[m.angle].word}, wanted ${SOLVER_ANGLES[it.angle].word}`);
  }

  return { cost, reasons, ok };
}

/**
 * Metres for describeCandidate's clearance detail, TRUNCATED (never rounded up) so the
 * number always lies inside the band its distance word names: 0.01 m steps under 1 m,
 * 0.1 m under 10 m, whole metres above (every WORD_BOUNDS distance edge — 0.75, 2, 4, 8,
 * 16, 40 — is exact at that precision). 1.98 → "1.9 m" ("very close"), never "2 m".
 * @param {number} m finite, ≥ 0
 * @returns {string}
 */
function clearanceM(m) {
  const step = m < 1 ? 100 : m < 10 ? 10 : 1;
  let n = Math.floor(m * step + 1e-9); // the epsilon absorbs float noise (0.29 * 100 = 28.999…)
  if (distanceWord(n / step) !== distanceWord(m)) n -= 1; // only within ~1e-10 m under a band edge
  return `${n / step} m`;
}

/**
 * Short words describing a candidate, for JEV choice criteria and the
 * director's contact sheet, e.g. "clear view, nearest tree near (5 m), subject
 * on left third, backlit, eye level". Parts (each only when known): view
 * ("clear view" / "subject partly hidden by tree", sense_words visibilityWord),
 * clearance ("nearest tree very close (1.5 m)": the sense_words distanceWord band
 * — touching, very close, close, near, medium, far — leads, the metres (truncated
 * into that band) follow as a detail, so the words pickCandidate's instructions
 * quote appear verbatim; 40 m or
 * more / nothing measured → "open space around the camera"), placement ("subject
 * centred" / "on left third" / "near right edge" / "out of frame") and size
 * when not right, light ("front-lit" / "side-lit" / "rim-lit" / "backlit",
 * "sun in frame"), particles ("thick smoke in view"), angle ("eye level",
 * "high angle", "low angle", "top-down"). Never throws; {} → "".
 * @param {CandidateMetrics} metrics
 * @returns {string}
 */
export function describeCandidate(metrics) {
  const m = metrics && typeof metrics === "object" ? metrics : {};
  const parts = [];
  if (isNum(m.visibleFrac)) {
    const w = visibilityWord(m.visibleFrac);
    if (w === "clear") parts.push("clear view");
    else parts.push(`subject ${w}${m.occluderKind ? ` by ${kindText(m.occluderKind, "something")}` : ""}`);
  }
  if (m.clearance === Infinity) parts.push("open space around the camera");
  else if (isNum(m.clearance)) {
    const cl = Math.max(0, m.clearance);
    const kind = kindText(m.nearestKind, "obstacle");
    const w = distanceWord(cl);
    parts.push(w === "clear" ? `open space around the camera (nearest ${kind} ${clearanceM(cl)})` : `nearest ${kind} ${w} (${clearanceM(cl)})`);
  }
  const comp = m.composition && typeof m.composition === "object" ? m.composition : null;
  if (comp) {
    if (comp.inFrame !== true || !Array.isArray(comp.ndc)) {
      parts.push("subject out of frame");
    } else {
      const x = comp.ndc[0];
      if (Math.abs(x) < 1 / 6) parts.push("subject centred");
      else if (Math.abs(x) <= 0.5) parts.push(`subject on ${x < 0 ? "left" : "right"} third`);
      else parts.push(`subject near ${x < 0 ? "left" : "right"} edge`);
      const sr = isNum(m.sizeRatio) ? m.sizeRatio : comp.sizeRatio;
      if (isNum(sr)) {
        const sw = sizeWord(sr);
        if (sw !== "right") parts.push(`subject ${sw}`);
      }
    }
  }
  const lw = lightWord(m.lightAngleDeg);
  if (lw) parts.push(lw);
  if (m.sunInFrame === true) parts.push("sun in frame");
  if (isNum(m.particleRisk) && m.particleRisk >= 0.15) {
    parts.push(`${densityWord(m.particleRisk)} ${typeof m.particleFamily === "string" && m.particleFamily ? m.particleFamily : "particles"} in view`);
  }
  if (typeof m.angle === "string" && SOLVER_ANGLES[m.angle]) parts.push(SOLVER_ANGLES[m.angle].word);
  return parts.join(", ");
}

/**
 * @typedef {Object} RankedCandidate
 * @property {number} index         position in the input arrays
 * @property {string} id            pose.meta.id, else "c<index+1>"
 * @property {object} pose
 * @property {CandidateMetrics} metrics
 * @property {number} cost
 * @property {boolean} ok           no hard violation
 * @property {string[]} reasons
 * @property {string} words         describeCandidate(metrics)
 */

/**
 * Score every candidate and sort best-first (SPEC §2.15): clean candidates
 * (ok) before violating ones, then by cost, ties by input order — so the
 * first row is the conservative default option for a JEV choice. Throws
 * FilmShotError (BAD_ARGUMENT) when the arrays are missing or differ in length.
 * @param {object[]} cands poses (generateCandidates output)
 * @param {CandidateMetrics[]} metricsArr one per pose
 * @param {object} intent
 * @returns {RankedCandidate[]}
 */
export function rankCandidates(cands, metricsArr, intent) {
  if (!Array.isArray(cands) || !Array.isArray(metricsArr)) {
    throw solverError("rankCandidates: candidates and metrics must be arrays", SOLVER_ERROR_CODES.BAD_ARGUMENT);
  }
  if (cands.length !== metricsArr.length) {
    throw solverError(`rankCandidates: ${cands.length} candidates but ${metricsArr.length} metrics`, SOLVER_ERROR_CODES.BAD_ARGUMENT);
  }
  normalizeIntent(intent);
  const rows = cands.map((pose, index) => {
    const metrics = metricsArr[index];
    const s = scoreCandidate(metrics, intent);
    const id = pose && pose.meta && typeof pose.meta.id === "string" ? pose.meta.id : `c${index + 1}`;
    return { index, id, pose, metrics, cost: s.cost, ok: s.ok, reasons: s.reasons, words: describeCandidate(metrics) };
  });
  rows.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1) || a.cost - b.cost || a.index - b.index);
  return rows;
}
