// scene3d/film/runtime/take_player.js — plays one take: trajectory → drone → pilot → safety → camera → render → record
// (SPEC §3 runtime/take_player.js, §5.1 depth of field, §5.2 the Take object).
//
// WHY: every film frame must be produced in ONE fixed order, identically when
// rehearsing, shooting and replaying, or the take is not repeatable and the
// safety reflex could be bypassed:
//
//   nominal  = traj.sample(progress)            pure in film time (random access)
//   flown    = drone.step(nominal)              drone / fpv families only ("real drone feel")
//   desired  = flown + pilot residual           path-frame offsets from the trajectory tangent
//                                               (lateral right of travel, vertical up),
//                                               distanceScale along the line to the subject,
//                                               framing nudges as local yaw / pitch;
//                                               speedScale warps the PROGRESS rate
//   pose     = safety.clamp(prev, desired)      the code reflex ALWAYS wins
//   camera_owner.write(pose) → clock.step() (render) → recorder.grab() inside postRender
//
// Stepped takes (the default — the 1070 renders 22–31 fps, too slow for smooth
// 1080p in real time) hold the loop and advance a film clock: frame k is film
// time k/fps, the pilot is AWAITED when a decision is due (film time is
// paused, so the result depends only on inputs and answers). Realtime takes
// (server-driven subjects that move on the wall clock) are driven by
// requestAnimationFrame with wall-clock timestamps and the pipelined,
// synchronous pilot.tick, but RECORDED on the film grid: grid point n (film
// time n/fps) is grabbed from the first drawn display frame at wall time
// ≥ n/fps and stamped n/fps; a display frame that covers several grid points
// (display slower than fps, or a frame the engine never drew) is encoded once
// per point (held), display frames between grid points are not recorded, and
// the grid points after the last display frame are grabbed from one final
// frame at the end pose. Every take is therefore a constant-rate stream of
// ⌈wall duration·fps⌉ frames (= the planned count at speed 1) that the CLI
// muxes with `-r fps`, and its realised table holds one row per recorded frame
// at n/fps. Every take starts after a cut, so ≥ 6 pre-roll
// frames are rendered at the start pose and never recorded (cells, PVS,
// particles and the sensors warm up). Every frame's realised pose goes into a
// table `[t, x, y, z, qw, qx, qy, qz, fov, focus, roll]` (shots/trajectory.js
// format) whose checksum identifies the take; `locked` replays such a table
// with no pilot (and no drone: the table already flew) — a rehearsal's
// realised path, shot again bit-identically.
//
// Live subjects (a server-driven entity or the walking player, `take.liveSubject`
// = a t-ignoring "where is it now" function): the trajectory is built against a
// PURE reference track of the subject (prepare-time pose, extrapolated by its
// velocity), so the nominal stays random-access, validatable and checksummed.
// Every frame the take re-anchors the sampled nominal to the live subject
// BEFORE the drone / residual / safety stages: rigs that ride with the subject
// (tags moving-subject / follow / body-rig / subject-is-camera: tracking-*,
// steadicam, snorricam, pov, drone chase / lead / side-track / top-down-track)
// are moved rigidly by the smoothed live − reference offset and rotated about
// the subject by the change of its travel heading (from a short live position
// history, spring-lagged like the rig's own turn); every other technique keeps
// its camera position and re-aims at the live subject. A server position snap
// is eased in by a critically damped follower with velocity feed-forward (no
// steady lag at constant speed). The pre-roll (reference held at p = 0) and
// frame 0 (still p = 0) put the follower on the live subject in steady state,
// with the offset velocity the take will see once the progress runs: the
// subject's measured pre-roll velocity MINUS the reference's own (a reference
// extrapolated from a walking subject already carries its walk) — a subject
// that keeps walking through the pre-roll gives no surge or drop-back at the
// take start, and a flown craft is reset at the subject's speed, not double.
// A flown carry rig's craft is fed the FULL time derivative of that re-anchored
// pose (reference travel + the nominal's travel about it turned by θ + the swing
// rate θ̇ / θ̈ terms + the follower's ẋ / ẍ; liveDerivs), so it is exact for a
// subject walking off the reference heading, and its swing round a turning
// subject only spends the acceleration the subject leaves the craft (swingStep:
// tangential + centripetal ≤ amax − |subject acceleration| − the craft's radial
// error) — a turn sharper than the craft can follow freezes the swing until it
// is done instead of piling on lag. Takes without a live subject are untouched.
//
// Occluder fades (pilot occluder_action 'fade', setpoint `fadeIds`): rig guids →
// entityManager.setFilmHidden; particle keys → render-only `emitter.filmHidden`;
// static placement fade keys (world_query staticFadeTargets: tree / prop) →
// `userData.__filmHidden` + `visible = false` on a per-placement staticsGroup node,
// `setVisibleAt(id, false)` on a BatchedMesh instance, or a zero-scale instance
// matrix on a shared InstancedMesh. Each hide records the previous state and is
// undone exactly after the take (never clobbering a value someone else wrote since;
// a BatchedMesh instance is re-shown only when no other owner wrote its visibility
// during the take — its setVisibleAt is watched while held — and its geometry and
// matrix are unchanged).
// A reveal shot's own occluder (`traj.meta.revealOccluder`) is never faded. A fade
// that hides nothing takes the reroute bias for that frame instead, and the sensors
// see past what this take faded (`fadedIds`). The safety reflex's lens hides are
// released BEFORE the fades are restored (reverse order of application).
//
// Depth of field (owner decision 2026-10-13, binding): when `window.__dof`
// exists the take drives `__dof.focusDistance` from the Pose focus channel
// every frame (classic.rack-focus pulls focus), enables DoF for takes whose
// trajectory has a focus channel, and restores the previous __dof state
// afterwards; without __dof it is a no-op.
//
// Particle cull (SPEC §4 item 5): the RP6 particle cull re-evaluates only every
// `recheckInterval` (6) ticks, and a stepped film frame is one tick, so after an
// in-take cut or a whip pan an emitter entering the frame would stay culled for
// up to 5 recorded frames. With the injected `particleCull`
// ({setParticleCullConfig}) every rendered take runs with recheckInterval 1 and
// the previous interval is restored afterwards.
//
// AdminEnvirons fog (review contracts-5 / seams-3 / gate-1): a look.fog change
// (or a server fog) rolls in over ~20 s of WALL-clock fog ticks
// (environ_override.js, retail LScape::UseTime) and the ambient follows on the
// 15 s light tick, so a take that records at once shows fog thickening on wall
// time — non-repeatable under stepped capture. Before every rendered take
// (rehearse and shoot, stepped and realtime; before the recorder starts and
// before the film clock holds the loop, so the live loop keeps ticking the
// fog) the player polls the read-only `window.__environOverrideState()`
// (loop.js) until the override has settled: active → transition and the fog's
// latched transition at 1, then one forced light tick (`__setTerrainLightScale`
// at the current scale, as look.js relights) latches the ambient at 1; cleared
// → no override ambient latched. Bounded by TAKE_DEFAULTS.environSettleMaxMs
// (30 s), stopped early when the state stops moving; the result is the take
// report's `environ` {checked, settled, waitedMs, timedOut, stalled, …}.
// look.js keeps the override object when the fog is unchanged, so only a real
// change ever waits.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: every dependency is
// injected ({cameraOwner, clock, sensors, pilot, safety, recorder, drone,
// worldQuery, particleCull, log, …}); it never imports a stateful scene3d
// module. Stepped takes are deterministic (no wall clock in the frame logic).

import { FilmError } from "../core/errors.js";
import { hprFromQuat, unwrapAngle, wrapPi } from "../core/gimbal.js";
import { qEnsureContinuity, qFromAxisAngle, qFromTo, qMul, qNorm, qRotate } from "../core/quat.js";
import { hashString, seedOf } from "../core/rng.js";
import * as FLIGHT from "../drone/flight_model.js";
import { frontBearing } from "../shots/classic.js";
import { aimPointForFraming, normalizeSubject } from "../shots/framing.js";
import { buildShot as defaultBuildShot, getTechnique } from "../shots/index.js";
import {
  TABLE_STRIDE, bakeTrajectory, isTrajectory, normalizeBounds, tableChecksum, trajectoryFromTable, validateTrajectory,
} from "../shots/trajectory.js";
import { FADEABLE_STATIC_KINDS, FADEABLE_STATIC_SOURCES, isStaticFadeKey, staticFadeKey } from "../scene/world_query.js";
import { FILM_CLOCK_MAX_FPS, FILM_CLOCK_MIN_FPS } from "./film_clock.js";

/** Pre-roll floor: frames rendered at the start pose (never recorded) after the cut into a take. */
export const TAKE_PREROLL_MIN_FRAMES = 6;

/** Capture modes of a take. */
export const TAKE_CAPTURE_MODES = Object.freeze(["stepped", "realtime"]);

/** Take player defaults. */
export const TAKE_DEFAULTS = Object.freeze({
  fps: 30,
  /** Extra frames a slowed take may run, as a fraction of its nominal frame count. */
  maxOverrun: 1.0,
  /** Seconds of planned path handed to the sensors (pathAhead). */
  aheadSec: 2,
  /** Points of planned path handed to the sensors. */
  aheadPoints: 3,
  /** Pilot telemetry rows kept per run. */
  telemetryLimit: 4000,
  /** Safety events kept per run. */
  safetyEventLimit: 2000,
  /** Realtime: a run fails when no animation frame arrives for this long (ms). */
  realtimeFrameTimeoutMs: 5000,
  /** Realtime: wait at most this long (ms) for the last armed frame to be grabbed. */
  realtimeFinalGrabMs: 1000,
  /** Lateral speed (m/s) of the reroute bias toward the roomier side. */
  rerouteMps: 1.0,
  /** visibleFrac below this counts as "hidden" (sense_words 'fully hidden'). */
  hiddenFrac: 0.1,
  /** visibleFrac below this counts as "occluded" ('mostly hidden'). */
  occludedFrac: 0.4,
  /** A static placement within (revealOccluder.radius + this) m of a reveal shot's occluder is never faded. */
  revealGuardM: 1.5,
  /** Slack (m) of the point subject's body test (subjectBodyOf): footprint radius and height span. */
  subjectBodyPadM: 0.3,
  /** A point subject wider than this (m) is a place, not an object: it has no body (subjectBodyOf). */
  subjectBodyMaxRadiusM: 8,
  /** A static fade key with no live draw is looked up again only after this many frames (the scan is not per-frame). */
  fadeRetryFrames: 15,
  /**
   * Realtime grid tolerance (in frames): a display frame at wall time t covers the grid
   * points n ≤ t·fps + this (absorbs float error and coarsened rAF timestamps).
   */
  realtimeGridEps: 1e-3,
  /** RP6 particle recheckInterval while a take renders (1 = every tick: nothing stays culled after a cut). */
  particleRecheckInterval: 1,
  /**
   * Pre-roll wait for the AdminEnvirons fog (look.fog): the longest a rendered take waits (ms) for the
   * retail roll-in to settle before it records (~20 s of 0.8 s fog ticks + one forced light tick).
   */
  environSettleMaxMs: 30000,
  /** Poll interval (ms) of that wait (the live loop keeps running between polls). */
  environSettlePollMs: 100,
  /**
   * The wait stops early (reported `stalled`) when the override state has not moved for this long (ms):
   * the fog half is not ticking (the "Disable distance fog" option, a held loop), so waiting longer is useless.
   */
  environSettleStallMs: 5000,
});

/**
 * The setpoint applied when the pilot is off (locked replays, pre-roll): no
 * offsets, cruise speed, neutral framing.
 * @type {Readonly<object>}
 */
export const NEUTRAL_SETPOINT = Object.freeze({
  lateral: 0,
  vertical: 0,
  speedScale: 1,
  distanceScale: 1,
  framing: Object.freeze({ dh: 0, dp: 0, dfovDeg: 0 }),
  fadeIds: Object.freeze([]),
  reroute: false,
  maneuver: "hold_path",
  source: "none",
});

/** The film clock's fps floor: slower takes render at this clock rate (film time still advances 1/fps per frame). */
const CLOCK_FPS_FLOOR = FILM_CLOCK_MIN_FPS;

/** Live-subject re-anchoring of takes whose subject moves on the wall clock (see the header). */
export const LIVE_SUBJECT = Object.freeze({
  /** Smooth time (s) of the live − reference offset follower: a server position snap is eased in over ≈ this. */
  smoothTime: 0.25,
  /** Feed-forward speed cap (m/s) of the follower: a faster offset change is a snap, not motion. */
  maxFeedSpeed: 30,
  /** Window (s) of the live travel-heading estimate. */
  headingWindowSec: 0.4,
  /** Shortest history span (s) a travel heading is estimated over. */
  minHeadingSpanSec: 0.05,
  /** Horizontal speed (m/s) above which the subject counts as travelling (the shot builders' threshold). */
  minSpeed: 0.3,
  /** Turn lag (s) of the rig's swing when the subject turns, when the shot has no turnLag / smoothSec of its own. */
  turnLag: 0.9,
  /** Position history kept for the heading estimate (s). */
  historySec: 1.5,
  /**
   * Flown swings: m/s² of the swing's acceleration budget given up per metre the craft is off its
   * distance from the subject (radial error), so the craft can win the distance back first.
   */
  swingRadialYield: 1,
});

/** Technique tags whose camera rides with the subject: re-anchored by translation + travel-heading rotation. */
export const LIVE_CARRY_TAGS = Object.freeze(["moving-subject", "follow", "body-rig", "subject-is-camera"]);

/** Speed tolerance of the overspeed check (a peak within 2 % of the preset's vmax is flyable). */
const OVERSPEED_TOLERANCE = 1.02;

/**
 * The prepare-time flight check of drone / fpv takes (flightCheckOf / searchMinDuration): the
 * nominal is dry-flown through the flying preset's flight model (the take's own drone stepping)
 * at `fps`; a craft that trails it by more than `gapToleranceM` anywhere cannot fly the move
 * (speed OR acceleration). The minimum-duration search is bounded by `maxRebuilds` shot rebuilds
 * and `maxFlownSec` seconds of dry-flown film time — deterministic work, never the wall clock —
 * and reports its suggestion 'unverified' when the budget runs out first.
 */
export const FLIGHT_CHECK = Object.freeze({
  /** Frame rate of the dry flight (the drone still integrates at 240 Hz inside each step). */
  fps: 10,
  /** Largest dry-flown gap (m) between the craft and the nominal that still counts as flying the move. */
  gapToleranceM: 1,
  /** Shot rebuilds (each dry-flown) the minimum-duration search may spend. */
  maxRebuilds: 6,
  /** Seconds of film time the minimum-duration search may dry-fly in all. */
  maxFlownSec: 360,
});

/** flightCheckOf's speed-limited duration estimate per check object (searchMinDuration's bisection floor). */
const FLIGHT_SPEED_NEED = new WeakMap();

// ---------------------------------------------------------------------------
// pure helpers (exported for tests and the scout)
// ---------------------------------------------------------------------------

/** Finite number or the fallback. */
function fin(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** Clamp x to [lo, hi]. */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** `[x,y,z]` copy of a finite vector; null otherwise. */
function vec3(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [+x, +y, +z];
}

/** Indices of the 3×3 linear part of a column-major 4×4 (zeroed to hide one instance at its own origin). */
const LINEAR_3X3 = Object.freeze([0, 1, 2, 4, 5, 6, 8, 9, 10]);

/** A reveal shot's own occluder (classic.reveal-from-occluder `meta.revealOccluder`), or null. */
function revealOccluderOf(traj) {
  const ro = traj && traj.meta && typeof traj.meta === "object" ? traj.meta.revealOccluder : null;
  const pos = ro && typeof ro === "object" ? vec3(ro.pos) : null;
  if (!pos) return null;
  return { pos, radius: Number.isFinite(ro.radius) && ro.radius > 0 ? +ro.radius : 0 };
}

/**
 * Horizontal unit "right of travel" vector of the path frame at progress `p`:
 * from the trajectory tangent (central difference over ±h seconds, h =
 * clamp(0.01·D, 1 ms, 0.25 s)); when the path does not move horizontally there
 * (a static shot, a vertical crane) the camera's own right from its forward
 * vector; at the nadir / zenith from the pose heading. Never NaN.
 * @param {{sample:(t:number)=>object, duration:number}} traj
 * @param {number} p progress, seconds
 * @param {{q?:number[], h?:number}} pose
 * @returns {number[]} `[x, y, 0]`, unit length
 */
export function pathRightVector(traj, p, pose) {
  const D = traj && Number.isFinite(traj.duration) ? traj.duration : 0;
  if (D > 0 && traj && typeof traj.sample === "function") {
    const h = clamp(0.01 * D, 1e-3, 0.25);
    const a = clamp(p - h, 0, D), b = clamp(p + h, 0, D);
    if (b - a > 1e-9) {
      try {
        const pa = traj.sample(a).pos, pb = traj.sample(b).pos;
        const tx = pb[0] - pa[0], ty = pb[1] - pa[1];
        const l = Math.hypot(tx, ty);
        if (l > 1e-4 * (b - a) && Number.isFinite(l)) return [ty / l, -tx / l, 0];
      } catch (_) {
        /* fall back to the camera frame */
      }
    }
  }
  const q = pose && Array.isArray(pose.q) && pose.q.length === 4 && pose.q.every(Number.isFinite) ? qNorm(pose.q) : null;
  if (q) {
    const f = qRotate(q, [0, 1, 0]);
    const l = Math.hypot(f[0], f[1]);
    if (l > 1e-3) return [f[1] / l, -f[0] / l, 0];
  }
  const hh = pose && Number.isFinite(pose.h) ? pose.h : 0;
  return [Math.cos(hh), -Math.sin(hh), 0];
}

/** True when a setpoint changes nothing. */
function isNeutral(sp, rerouteBias) {
  const f = sp.framing || {};
  return !(Math.abs(fin(sp.lateral, 0) + rerouteBias) > 1e-12) && !(Math.abs(fin(sp.vertical, 0)) > 1e-12) &&
    !(Math.abs(fin(sp.distanceScale, 1) - 1) > 1e-12) && !(Math.abs(fin(f.dh, 0)) > 1e-12) &&
    !(Math.abs(fin(f.dp, 0)) > 1e-12) && !(Math.abs(fin(f.dfovDeg, 0)) > 1e-12);
}

/**
 * Apply a pilot residual setpoint to a (flown) pose (SPEC §2.14 Setpoint):
 *  1. `distanceScale` moves the eye along the line to the subject centre
 *     (the subject keeps its screen position);
 *  2. `lateral` (m, + right of travel along `right`) and `vertical` (m, + up)
 *     offset the eye; with a subject in front of the camera the view is turned
 *     by the shortest arc that keeps the subject centre where the flown pose
 *     framed it (a drift never throws the subject out of frame);
 *  3. `framing.dh` / `framing.dp` (radians, + = turn right / look up) rotate the
 *     camera about its own up / right axes (well-defined at any pitch, so a
 *     straight-down shot never flips) and `framing.dfovDeg` widens / narrows.
 * Offsets are clamped to `bounds` (maxLateral, maxRise, maxSink,
 * maxDistanceScale). A neutral setpoint returns the pose unchanged. Never NaN:
 * non-finite setpoint fields count as neutral.
 * @param {object} pose Pose `{pos, q, h, p, r, fov, focus?, t?}`
 * @param {object} setpoint
 * @param {{right:number[], subjectCenter?:number[]|null, bounds?:object, rerouteBias?:number}} frame
 * @returns {object} a new pose
 */
export function applyResidual(pose, setpoint, frame) {
  const sp = setpoint && typeof setpoint === "object" ? setpoint : NEUTRAL_SETPOINT;
  const fr = frame && typeof frame === "object" ? frame : {};
  const b = normalizeBounds(fr.bounds && typeof fr.bounds === "object" ? pickBounds(fr.bounds) : undefined);
  const bias = fin(fr.rerouteBias, 0);
  if (isNeutral(sp, bias)) return pose;
  const lateral = clamp(fin(sp.lateral, 0) + bias, -b.maxLateral, b.maxLateral);
  const vertical = clamp(fin(sp.vertical, 0), -b.maxSink, b.maxRise);
  const dScale = clamp(fin(sp.distanceScale, 1), 1 / b.maxDistanceScale, b.maxDistanceScale);
  const f = sp.framing && typeof sp.framing === "object" ? sp.framing : {};
  const dh = fin(f.dh, 0), dp = fin(f.dp, 0), dfov = fin(f.dfovDeg, 0);
  const q0 = qNorm(pose.q);
  let eye = pose.pos.slice();
  const c = vec3(fr.subjectCenter);
  if (c && Math.abs(dScale - 1) > 1e-12) {
    eye = [c[0] + (eye[0] - c[0]) * dScale, c[1] + (eye[1] - c[1]) * dScale, c[2] + (eye[2] - c[2]) * dScale];
  }
  const base = eye.slice();
  const right = vec3(fr.right) || [1, 0, 0];
  eye = [eye[0] + right[0] * lateral, eye[1] + right[1] * lateral, eye[2] + right[2] * lateral + vertical];
  let q = q0;
  if (c && (lateral !== 0 || vertical !== 0)) {
    const d0 = [c[0] - base[0], c[1] - base[1], c[2] - base[2]];
    const d1 = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
    const l0 = Math.hypot(d0[0], d0[1], d0[2]), l1 = Math.hypot(d1[0], d1[1], d1[2]);
    if (l0 > 1e-6 && l1 > 1e-6) {
      const fw = qRotate(q0, [0, 1, 0]);
      if ((d0[0] * fw[0] + d0[1] * fw[1] + d0[2] * fw[2]) / l0 > 0.2) q = qNorm(qMul(qFromTo(d0, d1), q));
    }
  }
  if (dh !== 0) q = qNorm(qMul(q, qFromAxisAngle([0, 0, 1], -dh)));
  if (dp !== 0) q = qNorm(qMul(q, qFromAxisAngle([1, 0, 0], dp)));
  const fov = clamp(fin(pose.fov, 60) + dfov, 1.5, 169);
  const e = hprFromQuat(q, fin(pose.h, 0), fin(pose.r, 0));
  const out = { ...pose, pos: eye, q, h: e.h, p: e.p, r: e.r, fov };
  return out;
}

/** Only the Bounds keys of an object (normalizeBounds rejects unknown keys). */
function pickBounds(b) {
  const out = {};
  for (const k of ["maxLateral", "maxRise", "maxSink", "minSpeedScale", "maxSpeedScale", "maxDistanceScale"]) {
    if (b[k] !== undefined && b[k] !== null) out[k] = b[k];
  }
  try {
    return normalizeBounds(out);
  } catch (_) {
    return undefined;
  }
}

/**
 * The 11 table values of a realised pose (`[t, x, y, z, qw, qx, qy, qz, fov,
 * focus, roll]`), quaternion sign-continuous with `prevQ`.
 * @param {number} t
 * @param {object} pose
 * @param {number[]|null} prevQ
 * @returns {{row:number[], q:number[]}}
 */
export function realisedRow(t, pose, prevQ) {
  let q = qNorm(pose.q);
  if (prevQ) q = qEnsureContinuity(prevQ, q);
  else if (q[0] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  const focus = Number.isFinite(pose.focus) && pose.focus > 0 ? pose.focus : 0;
  return {
    row: [t, pose.pos[0], pose.pos[1], pose.pos[2], q[0], q[1], q[2], q[3], pose.fov, focus, fin(pose.r, 0)],
    q,
  };
}

/**
 * Frame count of a take of `duration` seconds at `fps`: ⌈duration·fps⌉ (a
 * whole number of frames gets no sliver), at least 1 — frames at k/fps for
 * k = 0 … n−1, each covering [k/fps, (k+1)/fps).
 * @param {number} duration
 * @param {number} fps
 * @returns {number}
 */
export function takeFrameCount(duration, fps) {
  if (!(Number.isFinite(duration) && duration > 0 && Number.isFinite(fps) && fps > 0)) return 1;
  return Math.max(1, Math.ceil(duration * fps - 1e-6));
}

/** Copy a JSON-ish value without functions / cycles (take echoes in reports). */
function plainCopy(v, depth = 0) {
  if (depth > 12) return null;
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, (x) => plainCopy(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "function" || x === undefined) continue;
      out[k] = plainCopy(x, depth + 1);
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// live-subject helpers (pure)
// ---------------------------------------------------------------------------

/** Horizontal `[x, y]` of `v` turned by compass angle `th` (clockwise seen from above); z unchanged. */
function turnCompass(v, th) {
  const c = Math.cos(th), s = Math.sin(th);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}

/** A unit quaternion's rotation scaled to `w` × its angle (w ∈ [0, 1]; same axis). */
function qScaleAngle(q, w) {
  if (!(w < 1)) return q;
  if (!(w > 0)) return [1, 0, 0, 0];
  const n = qNorm(q);
  const sgn = n[0] < 0 ? -1 : 1;
  const qw = clamp(n[0] * sgn, -1, 1);
  const ang = 2 * Math.acos(qw);
  const s = Math.sqrt(Math.max(0, 1 - qw * qw));
  if (!(s > 1e-12) || !(ang > 1e-12)) return [1, 0, 0, 0];
  return qFromAxisAngle([(n[1] * sgn) / s, (n[2] * sgn) / s, (n[3] * sgn) / s], ang * w);
}

/**
 * How firmly a re-aim applies: 1 while the aim point lies inside the pose's
 * frame (|ndc| ≤ 1), fading smoothly to 0 at |ndc| = 1.5 or behind the camera,
 * so a shot that does not frame the subject is never turned toward it and a
 * subject entering the frame is picked up without a jump.
 */
function frameWeight(q, d, fovDeg, aspect) {
  const f = qRotate(q, [0, 1, 0]);
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  const l = Math.hypot(d[0], d[1], d[2]);
  if (!(l > 1e-6) || !(z > 0.05 * l)) return 0;
  const ty = Math.tan((clamp(fin(fovDeg, 60), 1.5, 169) * Math.PI) / 360);
  const tx = ty * (Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
  const r = qRotate(q, [1, 0, 0]), u = qRotate(q, [0, 0, 1]);
  const nx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z / tx;
  const ny = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z / ty;
  const m = Math.max(Math.abs(nx), Math.abs(ny));
  if (m <= 1) return 1;
  if (m >= 1.5) return 0;
  const x = (1.5 - m) / 0.5;
  return x * x * (3 - 2 * x);
}

/**
 * Re-aim a pose from aim point `a0` to `a1` (its position unchanged), keeping
 * the point where the pose framed it: a world-vertical yaw by the change of
 * the point's compass bearing then a pitch about the camera's own right axis
 * (the horizon stays level); for near-vertical lines of sight, where a
 * bearing is ill-defined, the shortest arc. Weighted by frameWeight.
 * @param {object} pose Pose `{pos, q, h, p, r, fov}`
 * @param {number[]} a0 @param {number[]} a1 @param {number} aspect
 * @returns {object} the pose (unchanged when nothing applies) or a new pose
 */
export function reAimPose(pose, a0, a1, aspect) {
  if (!a0 || !a1 || (a0[0] === a1[0] && a0[1] === a1[1] && a0[2] === a1[2])) return pose;
  const pos = pose.pos;
  return reAimDirs(pose, [a0[0] - pos[0], a0[1] - pos[1], a0[2] - pos[2]], [a1[0] - pos[0], a1[1] - pos[1], a1[2] - pos[2]], aspect);
}

/** reAimPose on lines of sight: turn the pose's view so what lay along `d0` lies along `d1`. */
function reAimDirs(pose, d0, d1, aspect) {
  const l0 = Math.hypot(d0[0], d0[1], d0[2]), l1 = Math.hypot(d1[0], d1[1], d1[2]);
  if (!(l0 > 1e-6) || !(l1 > 1e-6)) return pose;
  if (d0[0] === d1[0] && d0[1] === d1[1] && d0[2] === d1[2]) return pose;
  const q0 = qNorm(pose.q);
  const w = frameWeight(q0, d0, pose.fov, aspect);
  if (!(w > 0)) return pose;
  const h0 = Math.hypot(d0[0], d0[1]), h1 = Math.hypot(d1[0], d1[1]);
  let q;
  if (h0 > 0.2 * l0 && h1 > 0.2 * l1) {
    const dH = wrapPi(Math.atan2(d1[0], d1[1]) - Math.atan2(d0[0], d0[1])) * w;
    const dP = (Math.atan2(d1[2], h1) - Math.atan2(d0[2], h0)) * w;
    q = qMul(qFromAxisAngle([0, 0, 1], -dH), q0);
    q = qMul(q, qFromAxisAngle([1, 0, 0], dP));
  } else {
    q = qMul(qScaleAngle(qFromTo(d0, d1), w), q0);
  }
  q = qNorm(q);
  const e = hprFromQuat(q, fin(pose.h, 0), fin(pose.r, 0));
  return { ...pose, q, h: e.h, p: e.p, r: e.r };
}

/**
 * One exact step of the live-offset follower (the take-time twin of
 * classic.followSpring): x'' = ω²(T − x) + 2ω(F − x') with ω = 2/smoothTime and
 * F the target velocity clamped to maxFeedSpeed and low-passed (τ =
 * smoothTime/4). The target is linear within the step, so constant-velocity
 * motion is followed with no lag and a jump (a server snap) is eased in.
 * Mutates `S` ({x, v, F, T}).
 */
function liveFollowStep(S, T, dt) {
  const st = LIVE_SUBJECT.smoothTime;
  const omega = 2 / st;
  const ex = Math.exp(-omega * dt);
  const aF = 1 - Math.exp(-dt / Math.max(dt, 0.25 * st));
  const vT = [(T[0] - S.T[0]) / dt, (T[1] - S.T[1]) / dt, (T[2] - S.T[2]) / dt];
  const l = Math.hypot(vT[0], vT[1], vT[2]);
  const fc = l > LIVE_SUBJECT.maxFeedSpeed ? vT.map((x) => (x / l) * LIVE_SUBJECT.maxFeedSpeed) : vT;
  for (let c = 0; c < 3; c += 1) {
    S.F[c] += (fc[c] - S.F[c]) * aF;
    const lag = (2 * (S.F[c] - vT[c])) / omega;
    const e0 = S.x[c] - S.T[c] - lag;
    const ev0 = S.v[c] - vT[c];
    const b = ev0 + omega * e0;
    S.x[c] = T[c] + lag + (e0 + b * dt) * ex;
    S.v[c] = vT[c] + (ev0 - omega * b * dt) * ex;
  }
  S.T = T;
}

// ---------------------------------------------------------------------------
// the take player
// ---------------------------------------------------------------------------

/**
 * Create the take player (SPEC §3).
 *
 * Deps: `cameraOwner` ({write, currentPose, setCutCell?, viewerCell?, onPostRender, own?, owned}),
 * `clock` (film clock {begin, step, end, active, stats}; or `() → clock`), `sensors`
 * ({sense, reset}), `pilot` (a pilot {tick, tickStepped, reset, stats, decisions} or a factory
 * `(cfg) → pilot`, cfg = {mode, bounds, captureMode, ...take.pilot}), `safety` ({clamp, reset,
 * release, stats}), `recorder` (a factory `(opts) → recorder` or an instance; only shoot needs it),
 * `drone` (the flight_model module {createDrone, presetForTrajectory} or a factory
 * `(preset) → drone`; default the real module), `worldQuery` ({groundZ, particles, staticFadeTargets}), `log`.
 * Optional: `window` (for `__dof`, requestAnimationFrame), `requestAnimationFrame`,
 * `setTimeout`/`clearTimeout`, `now` (ms, the pre-roll fog wait's clock; default performance.now),
 * `liveScene3d` (frame stamps, pop-in signature, film hides),
 * `particles`, `buildShot` (default the shot registry), `actor` (`(cue) → Promise` for take.actor cues),
 * `particleCull` ({setParticleCullConfig} from particle_manager.js: every rendered take runs with
 * RP6 recheckInterval 1, the previous interval restored after it).
 *
 * - `prepare(take)` → summary `{ok, shotId, technique, family, duration, fps, plannedFrames,
 *   preRollFrames, hasSubject, hasFocus, fromTable, captureMode, pilotMode, bounds,
 *   nominalChecksum, validation, liveSubject, flight}`. `take` = `{spec (ShotSpec) | table
 *   (realised/baked table) | trajectory, ctx (ShotContext overrides; ctx.subjectAt must be PURE in t),
 *   liveSubject (`() → subject now`, t-ignoring: a moving entity / walking player), subjectGuid,
 *   pilot:{mode,…}, capture:{mode, fps, width, height}, standingOrder, goal, technique, family, shotId,
 *   cell, indoor, preRollSec, actor, seed}`. With a liveSubject the sensors / pilot / residual
 *   see the live subject and the nominal is re-anchored to it every frame (`liveSubject` in the
 *   summary: `{mode:'carry'|'aim'|'off', rotate, refHeadingDeg}`). Drone / fpv takes carry
 *   `flight: {preset, vmax, amax, peakSpeed, metaPeakSpeed, sampledPeakSpeed, lengthM, overspeed,
 *   limitedBy, profileOverspeed, minDurationSec, minDurationVerified, minDurationCheck,
 *   durationHelps, ease, gapToleranceM, dryFlight:{fps, frames, maxGapM, maxGapT, endGapM,
 *   peakAccel}|null}` (peakSpeed = the larger of the builder's profile peak and the peak measured
 *   on the baked nominal; dryFlight = the nominal flown through the preset's flight model at
 *   FLIGHT_CHECK.fps). A path the preset cannot fly — peak / mean speed above vmax (limitedBy
 *   'speed') or a dry-flown gap above FLIGHT_CHECK.gapToleranceM (limitedBy 'acceleration') —
 *   gets a validation issue `overspeed` (with `minDurationSec`, `minDurationVerified`,
 *   `maxGapM`); minDurationSec is searched by rebuilding and dry-flying the shot within a fixed
 *   work budget: minDurationVerified true / minDurationCheck 'verified' only when the shot
 *   dry-flies within the tolerance there, 'unverified' (an estimate) when the budget ran out,
 *   'failed' (null, durationHelps false) when lengthening does not help.
 *   Resets pilot / sensors / safety. Throws FilmError (FILM_BAD_TAKE, FILM_BUSY, shot errors).
 * - `rehearse({fps, render=true})` → `Promise<{ok, fps, frames, durationSec, realisedTable,
 *   checksum, pilotTelemetry, safetyEvents, pilot, safety, obstruction, validation, flight, …}>`
 *   — stepped, no capture.
 * - `shoot({mode, locked, fps, width, height, codec, bitrate, keyIntervalSec, includeTable})` →
 *   `Promise<take report {ok, frames, durationSec, realisedChecksum, pilot:{decisions, sources,
 *   agreement}, safety:{adjustedFrames}, obstruction:{minVisibleFrac, framesHidden}, recorder,
 *   validation (prepare's, incl. an 'overspeed' issue), flight (prepare's flight check + tracking:
 *   {frames, maxGapM, maxGapT, endGapM} of a flown run, else null; null for classic shots),
 *   realtime (realtime takes: {wallSec, gridFrames, displayFrames, heldFrames, skippedDisplayFrames,
 *   undrawnDisplayFrames, backpressureFrames, tailFrames}, else null), particleCull, environ
 *   (the pre-roll AdminEnvirons wait: {checked, settled, waitedMs, polls, relit, timedOut, stalled,
 *   aborted, reason, state}), …}>`.
 *   frames are always on the fps grid (timestamps k/fps), so durationSec = frames / fps.
 * - `abort()` → stops a running take at its next frame; `status()`; `currentRecorder()`;
 *   `lastRealisedTable()`; `running` getter.
 *
 * @param {object} deps
 * @returns {object}
 */
export function createTakePlayer(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const cam = d.cameraOwner && typeof d.cameraOwner === "object" ? d.cameraOwner : null;
  if (!cam || typeof cam.write !== "function") throw new FilmError("createTakePlayer: cameraOwner (with write) is required", "BAD_ARGUMENT");
  const sensors = d.sensors && typeof d.sensors.sense === "function" ? d.sensors : null;
  const safety = d.safety && typeof d.safety.clamp === "function" ? d.safety : null;
  if (!safety) throw new FilmError("createTakePlayer: safety (with clamp) is required — the reflex always runs", "BAD_ARGUMENT");
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const buildShot = typeof d.buildShot === "function" ? d.buildShot : defaultBuildShot;
  const flight = d.drone !== undefined && d.drone !== null ? d.drone : FLIGHT;
  const setT = typeof d.setTimeout === "function" ? d.setTimeout : (typeof setTimeout === "function" ? setTimeout : null);
  const clearT = typeof d.clearTimeout === "function" ? d.clearTimeout : (typeof clearTimeout === "function" ? clearTimeout : null);
  // Wall clock (ms) of the pre-roll fog wait only — never read by the frame logic.
  const nowMs = typeof d.now === "function"
    ? d.now
    : () => (typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now());
  const particleCull = d.particleCull && typeof d.particleCull === "object" && typeof d.particleCull.setParticleCullConfig === "function"
    ? d.particleCull
    : null;
  const emit = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-take", ...entry });
    } catch (_) {
      /* a logger never breaks a take */
    }
  };
  const liveOf = () => {
    if (d.liveScene3d && typeof d.liveScene3d === "object") return d.liveScene3d;
    const l = win && win.liveScene3d;
    return l && typeof l === "object" ? l : null;
  };
  const particlesOf = () => {
    const p = d.particles ?? (d.worldQuery && d.worldQuery.particles) ?? null;
    return p && typeof p === "object" ? p : null;
  };

  /** @type {object|null} */
  let plan = null;
  /** @type {object|null} */
  let run = null;
  let abortRequested = false;
  /** @type {object|null} */
  let recorderRef = null;
  /** @type {object|null} */
  let lastTable = null;
  /** @type {object|null} */
  let lastSummary = null;
  /** The override `sets` count the last fog wait confirmed settled (its light tick latched at 1). */
  let environSettledSets = null;

  function clockOf() {
    const c = typeof d.clock === "function" ? d.clock() : d.clock;
    return c && typeof c === "object" && typeof c.step === "function" ? c : null;
  }

  function onPostRender(fn) {
    if (typeof cam.onPostRender === "function") return cam.onPostRender(fn);
    const hooks = cam.hooks || (liveOf() && liveOf().film);
    if (hooks && typeof hooks.addPostRender === "function") return hooks.addPostRender(fn);
    throw new FilmError("take player: no postRender hook (cameraOwner.onPostRender) to grab frames in", "FILM_NO_HOOKS");
  }

  // ---- prepare --------------------------------------------------------------

  function resolveTrajectory(take) {
    if (isTrajectory(take.trajectory)) return { traj: take.trajectory, fromTable: false, table: null };
    if (take.table !== undefined && take.table !== null) {
      const traj = trajectoryFromTable(take.table);
      return { traj, fromTable: true, table: take.table };
    }
    let spec = take.spec && typeof take.spec === "object" ? take.spec : null;
    if (!spec && typeof take.technique === "string" && (take.duration !== undefined || take.params !== undefined)) {
      spec = { technique: take.technique, duration: take.duration, params: take.params, framing: take.framing, fov: take.fov, roll: take.roll, ease: take.ease, seed: take.seed };
    }
    if (!spec) throw new FilmError("prepare: the take needs a spec (ShotSpec), a table (realised / baked) or a trajectory", "FILM_BAD_TAKE");
    const ctx = { ...(take.ctx && typeof take.ctx === "object" ? take.ctx : {}) };
    // The builders pre-simulate rigs over [0, D]: they only ever see the pure reference track.
    delete ctx.liveSubject;
    if (typeof ctx.groundZ !== "function" && d.worldQuery && typeof d.worldQuery.groundZ === "function") {
      ctx.groundZ = (x, y) => d.worldQuery.groundZ(x, y);
    }
    return { traj: buildShot(spec, ctx), fromTable: false, table: null, spec, ctx };
  }

  /**
   * The subject function of a take: the trajectory's subjectAt / subject, else the
   * context's (a replayed table carries no subject of its own).
   */
  function subjectFnOf(traj, guid, ctx) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const src = typeof traj.subjectAt === "function" || (traj.subject !== undefined && traj.subject !== null)
      ? traj
      : { subjectAt: typeof c.subjectAt === "function" ? c.subjectAt : undefined, subject: c.subject };
    const norm = (s) => {
      if (s === undefined || s === null) return null;
      try {
        const n = normalizeSubject(s);
        if (guid && !n.guid) n.guid = guid;
        return n;
      } catch (_) {
        return null;
      }
    };
    if (typeof src.subjectAt === "function") {
      const fixed = norm(src.subject);
      return (p) => {
        let s = null;
        try {
          s = src.subjectAt(p);
        } catch (_) {
          s = null;
        }
        return norm(s) ?? fixed;
      };
    }
    const s0 = norm(src.subject);
    return s0 ? () => s0 : () => null;
  }

  /** The take's live subject `() → normalised subject | null` (with the guid), or null. */
  function liveFnOf(raw, guid) {
    if (typeof raw !== "function") return null;
    return () => {
      let s = null;
      try {
        s = raw();
      } catch (_) {
        s = null;
      }
      if (s === undefined || s === null) return null;
      try {
        const n = normalizeSubject(s);
        if (guid && !n.guid) n.guid = guid;
        return n;
      } catch (_) {
        return null;
      }
    };
  }

  /**
   * How a live subject re-anchors the nominal: `carry` (the rig rides with the
   * subject: translation, plus rotation by the travel-heading change unless the
   * shot keeps a fixed heading) or `aim` (camera position kept, view re-aimed),
   * from `traj.meta.liveRig` ('carry' | 'aim' | 'off') else the technique's tags.
   * `refHeading` is the travel heading the shot was built for: the reference
   * track's direction of travel, else the heading the builders fall back to
   * (the subject's heading; classic: frontBearing; drone: north).
   */
  function liveRigOf(traj, take, refFn) {
    const meta = traj.meta && typeof traj.meta === "object" ? traj.meta : {};
    let mode = meta.liveRig === "carry" || meta.liveRig === "aim" || meta.liveRig === "off" ? meta.liveRig : null;
    if (!mode) {
      const def = getTechnique(traj.technique);
      const tags = def && Array.isArray(def.tags) ? def.tags : [];
      mode = tags.some((x) => LIVE_CARRY_TAGS.includes(x)) ? "carry" : "aim";
    }
    if (mode === "off") return null;
    const ref0 = refFn(0);
    if (!ref0) return null;
    const D = Number.isFinite(traj.duration) ? traj.duration : 0;
    let refHeading = null;
    const dtRef = Math.min(0.5, D);
    if (dtRef > 1e-6) {
      const r1 = refFn(dtRef);
      if (r1) {
        const vx = (r1.pos[0] - ref0.pos[0]) / dtRef, vy = (r1.pos[1] - ref0.pos[1]) / dtRef;
        if (Math.hypot(vx, vy) > LIVE_SUBJECT.minSpeed) refHeading = Math.atan2(vx, vy);
      }
    }
    const family = traj.family || take.family;
    if (refHeading === null) {
      if (Number.isFinite(ref0.heading)) refHeading = ref0.heading;
      else if (family === "classic") {
        const c = take.ctx && typeof take.ctx === "object" ? take.ctx : {};
        refHeading = frontBearing({ anchor: vec3(c.anchor) || ref0.pos, sun: c.sun }, ref0);
      } else refHeading = 0;
    }
    const params = meta.spec && meta.spec.params && typeof meta.spec.params === "object" ? meta.spec.params : {};
    const turnLag = Number.isFinite(params.turnLag) && params.turnLag > 0
      ? params.turnLag
      : Number.isFinite(params.smoothSec) ? Math.max(0.4, params.smoothSec) : LIVE_SUBJECT.turnLag;
    return {
      mode,
      rotate: mode === "carry" && meta.headingMode !== "fixed",
      refHeading,
      // classic travelHeadingTrack follows the subject's facing while it stands; drone tracks hold.
      facing: family === "classic",
      turnLag,
    };
  }

  /**
   * Peak speed (m/s) of a baked nominal: the largest frame-to-frame chord speed,
   * intervals holding a cut excluded (a cut is not travel). Null without rows.
   */
  function sampledPeakSpeed(baked, traj) {
    if (!baked || !baked.rows || !(baked.frames > 1)) return null;
    const r = baked.rows;
    const cuts = traj.meta && Array.isArray(traj.meta.cuts) ? traj.meta.cuts.filter(Number.isFinite) : [];
    let peak = 0;
    for (let k = 1; k < baked.frames; k += 1) {
      const a = (k - 1) * TABLE_STRIDE, b = k * TABLE_STRIDE;
      const t0 = r[a], t1 = r[b];
      if (!(t1 > t0) || cuts.some((c) => c > t0 + 1e-9 && c <= t1 + 1e-9)) continue;
      const v = Math.hypot(r[b + 1] - r[a + 1], r[b + 2] - r[a + 2], r[b + 3] - r[a + 3]) / (t1 - t0);
      if (Number.isFinite(v) && v > peak) peak = v;
    }
    return peak;
  }

  /** A craft of `preset` from the injected flight model (the one makeDrone flies), or null. */
  function newDrone(preset) {
    if (typeof flight === "function") return flight(preset);
    if (flight && typeof flight.createDrone === "function") return flight.createDrone(preset);
    return null;
  }

  /**
   * Dry-fly a nominal through the flying preset's flight model exactly as a take flies it (reset at
   * t = 0 with the path's velocity / acceleration feed-forward, one step per frame with feed-forward,
   * re-set at every declared cut) on a coarse FLIGHT_CHECK.fps grid up to the end pose, and measure
   * how far the craft trails the nominal. Null when no craft can be made or the path throws.
   * @returns {{fps:number, frames:number, maxGapM:number, maxGapT:number, endGapM:number, peakAccel:number}|null}
   */
  function dryFly(traj, preset, D) {
    if (!(D > 0)) return null;
    let drone = null;
    try {
      drone = newDrone(preset);
    } catch (_) {
      drone = null;
    }
    if (!drone || typeof drone.reset !== "function" || typeof drone.step !== "function") return null;
    const fps = FLIGHT_CHECK.fps;
    const R = { D, fps, traj };
    const posAt = (t) => traj.sample(t).pos;
    const cuts = traj.meta && Array.isArray(traj.meta.cuts) ? traj.meta.cuts.filter(Number.isFinite) : [];
    const nearCut = (t) => cuts.some((c) => Math.abs(c - t) <= 0.03);
    const n = Math.max(1, Math.ceil(D * fps - 1e-6));
    let maxGap = 0, maxGapT = 0, endGap = 0, peakAccel = 0;
    try {
      const p0 = traj.sample(0);
      const d0 = derivsOf(R, posAt, 0, 1);
      drone.reset({ ...p0, t: 0 }, { velocity: d0.vel, acceleration: d0.acc });
      if (!nearCut(0)) peakAccel = Math.hypot(d0.acc[0], d0.acc[1], d0.acc[2]);
      let tPrev = 0;
      for (let k = 1; k <= n; k += 1) {
        const t = Math.min(D, k / fps);
        if (!(t > tPrev)) continue;
        const nom = traj.sample(t);
        const dv = derivsOf(R, posAt, t, 1);
        const cut = cuts.some((c) => c > tPrev + 1e-9 && c <= t + 1e-9);
        const pose = cut
          ? drone.reset({ ...nom, t }, { velocity: dv.vel, acceleration: dv.acc })
          : drone.step({ ...nom, t, vel: dv.vel, acc: dv.acc }, t - tPrev);
        if (!nearCut(t)) {
          const a = Math.hypot(dv.acc[0], dv.acc[1], dv.acc[2]);
          if (Number.isFinite(a) && a > peakAccel) peakAccel = a;
        }
        const g = Math.hypot(pose.pos[0] - nom.pos[0], pose.pos[1] - nom.pos[1], pose.pos[2] - nom.pos[2]);
        if (!Number.isFinite(g)) return null;
        if (g > maxGap) {
          maxGap = g;
          maxGapT = t;
        }
        endGap = g;
        tPrev = t;
      }
    } catch (_) {
      return null;
    }
    return { fps, frames: n + 1, maxGapM: maxGap, maxGapT, endGapM: endGap, peakAccel };
  }

  /** Round a duration UP to the 0.1 s grid the suggestions use. */
  function ceilTenth(x) {
    return Math.ceil(x * 10 - 1e-9) / 10;
  }

  /**
   * Can the flying preset follow a drone / fpv path in time? The preset is the
   * one makeDrone flies (pilot.flightPreset, else presetForTrajectory). Two checks:
   * - speed: the path's peak speed or its mean speed (`meta.lengthM` / duration)
   *   above the preset's vmax (2 % tolerance) — the craft's vmax clamp leaves it
   *   behind. The peak is the larger of the builder's profile peak
   *   (`meta.peakSpeed`) and the peak measured on the baked nominal
   *   (`sampledPeakSpeed`: a non-linear ease, unprofiled moves shortened below
   *   their natural duration);
   * - flight: the nominal DRY-FLOWN through the preset's flight model (dryFly,
   *   `dryFlight`) trails by more than FLIGHT_CHECK.gapToleranceM — catches
   *   moves limited by ACCELERATION (or jerk), which a speed check passes: a
   *   short boomerang or boom-rise within vmax that the craft trails by 5–30 m.
   * `overspeed` = either; `limitedBy` 'speed' | 'acceleration' (gap only) | null.
   * The builder's own `meta.overspeed` (its profile had to be time-compressed
   * beyond its style / acceleration caps) is reported as `profileOverspeed` and
   * fails the check only when nothing could be measured or flown.
   * `minDurationSec`: an ESTIMATE until searchMinDuration verifies it — the
   * duration at which the same move peaks at vmax (≥ lengthM / vmax) and, when
   * the gap failed, at which its peak acceleration fits amax
   * (D·√(peakAccel / amax), ≤ 4·D; uniform time scale); null when not overspeed.
   * @returns {object|null} the flight block (see the createTakePlayer docs)
   */
  function flightCheckOf(traj, take, pilotCfg, family, D, baked) {
    if (family !== "drone" && family !== "fpv") return null;
    const m = traj.meta && typeof traj.meta === "object" ? traj.meta : {};
    const presets = flight && typeof flight === "object" && flight.DRONE_PRESETS ? flight.DRONE_PRESETS : FLIGHT.DRONE_PRESETS;
    let preset = typeof pilotCfg.flightPreset === "string" && pilotCfg.flightPreset ? pilotCfg.flightPreset : null;
    if (!preset) {
      const pf = flight && typeof flight.presetForTrajectory === "function" ? flight.presetForTrajectory : FLIGHT.presetForTrajectory;
      try {
        preset = pf(traj, { indoor: take.indoor === true });
      } catch (_) {
        preset = null;
      }
    }
    preset = preset || "cinema";
    const cfg = presets && Object.prototype.hasOwnProperty.call(presets, preset) ? presets[preset] : null;
    const vmax = cfg && Number.isFinite(cfg.vmax) && cfg.vmax > 0 ? cfg.vmax : null;
    if (vmax === null) return null;
    const amax = Number.isFinite(cfg.amax) && cfg.amax > 0 ? cfg.amax : null;
    const metaPeak = Number.isFinite(m.peakSpeed) && m.peakSpeed >= 0 ? m.peakSpeed : null;
    const sampled = sampledPeakSpeed(baked, traj);
    const peak = metaPeak === null && sampled === null ? null : Math.max(metaPeak ?? 0, sampled ?? 0);
    const L = Number.isFinite(m.lengthM) && m.lengthM >= 0 ? m.lengthM : null;
    const avg = L !== null && D > 0 ? L / D : null;
    const profileOverspeed = m.overspeed === true;
    const fly = dryFly(traj, preset, D);
    const gapOver = fly !== null && fly.maxGapM > FLIGHT_CHECK.gapToleranceM;
    const speedOver = peak === null && avg === null
      ? profileOverspeed && fly === null
      : (peak !== null && peak > vmax * OVERSPEED_TOLERANCE) || (avg !== null && avg > vmax * OVERSPEED_TOLERANCE);
    const overspeed = speedOver || gapOver;
    const ease = m.spec && typeof m.spec.ease === "string" ? m.spec.ease : null;
    const out = {
      preset, vmax, amax, peakSpeed: peak, metaPeakSpeed: metaPeak, sampledPeakSpeed: sampled, lengthM: L, overspeed,
      limitedBy: !overspeed ? null : speedOver ? "speed" : "acceleration", profileOverspeed, minDurationSec: null, ease,
      minDurationVerified: null, minDurationCheck: null, durationHelps: null,
      gapToleranceM: FLIGHT_CHECK.gapToleranceM, dryFlight: fly,
    };
    if (overspeed) {
      // A speed-limited move's gap is mostly its speed shortfall: the speed estimate leads (the search
      // lengthens further if the craft still trails there); the acceleration estimate (peaks at kinks
      // make it conservative) only for a move within vmax.
      const need = speedOver
        ? Math.max(peak !== null ? (D * peak) / vmax : 0, L !== null ? L / vmax : 0)
        : amax !== null && fly.peakAccel > amax ? Math.min(4 * D, D * Math.sqrt(fly.peakAccel / amax)) : 0;
      out.minDurationSec = need > D + 1e-6 ? ceilTenth(need) : null;
      FLIGHT_SPEED_NEED.set(out, speedOver ? need : null);
    }
    return out;
  }

  /**
   * Search the shortest duration (on the 0.1 s grid) at which a too-fast shot built from a ShotSpec
   * passes BOTH checks — rebuilt there (a path move re-fits its profile, an unprofiled move slows
   * uniformly) and dry-flown within FLIGHT_CHECK.gapToleranceM. From fc's estimate it lengthens
   * (each failure's own estimate, at least ×1.25) until a duration passes, then bisects down to
   * the last failure (never below the speed estimate: that part is exact under uniform scaling).
   * A move whose length grows with its duration (a `speed` param without a path), whose speed
   * comes from its ease, or that follows a (live) subject's speed does not improve: lengthening
   * that brings neither a speed-limited peak nor the dry-flown gap down by ≥ 5 % never will. Bounded by FLIGHT_CHECK.maxRebuilds rebuilds and maxFlownSec dry-flown
   * seconds (deterministic work, never the wall clock). Mutates `fc`:
   * - verified: minDurationSec = the passing duration, minDurationVerified true, minDurationCheck 'verified';
   * - no duration helps: minDurationSec null, minDurationVerified false, durationHelps false, 'failed';
   * - budget spent (or a rebuild threw) first: minDurationSec = the next estimate, minDurationVerified
   *   null, minDurationCheck 'unverified' (prepare never blocks on the search).
   */
  function searchMinDuration(fc, o) {
    let rebuilds = FLIGHT_CHECK.maxRebuilds;
    let flownSec = FLIGHT_CHECK.maxFlownSec;
    const evalAt = (Dc) => {
      if (rebuilds <= 0 || flownSec < Dc) return undefined;
      rebuilds -= 1;
      flownSec -= Dc;
      try {
        const tr = buildShot({ ...o.spec, duration: Dc }, o.ctx);
        return flightCheckOf(tr, o.take, o.pilotCfg, o.family, tr.duration, bakeTrajectory(tr, o.fps));
      } catch (_) {
        return null;
      }
    };
    const speedFloor = (c) => {
      const s = FLIGHT_SPEED_NEED.get(c);
      return Number.isFinite(s) ? ceilTenth(s) - 0.1 : -Infinity;
    };
    // Progress = a speed-limited peak that came down, or a dry-flown gap that shrank (a move that
    // has just dropped under vmax may still trail as far as before: its acceleration is next).
    const improved = (c, prev) => (prev.limitedBy === "speed" && prev.peakSpeed !== null && c.peakSpeed !== null && c.peakSpeed < prev.peakSpeed * 0.95) ||
      (!!(c.dryFlight && prev.dryFlight) && c.dryFlight.maxGapM < prev.dryFlight.maxGapM * 0.95);
    let floor = Math.max(o.D, speedFloor(fc));
    let prev = fc;
    let cand = fc.minDurationSec !== null && fc.minDurationSec > o.D ? fc.minDurationSec : ceilTenth(o.D * 1.25);
    let pass = null;
    let helps = true;
    for (;;) {
      const c = evalAt(cand);
      if (!c) break; // budget spent (undefined) or the rebuild threw (null): unverified
      if (!c.overspeed) {
        pass = cand;
        break;
      }
      if (!improved(c, prev)) {
        helps = false;
        break;
      }
      floor = Math.max(cand, speedFloor(c));
      prev = c;
      cand = ceilTenth(Math.max(c.minDurationSec !== null ? c.minDurationSec : 0, cand * 1.25));
    }
    if (pass !== null) {
      // Bisect between the last failure and the pass (the acceleration estimate is conservative).
      while (pass - floor > 0.1 + 1e-9) {
        const mid = ceilTenth((floor + pass) / 2);
        if (!(mid < pass - 1e-9) || !(mid > floor + 1e-9)) break;
        const c = evalAt(mid);
        if (!c) break;
        if (c.overspeed) floor = Math.max(mid, speedFloor(c));
        else pass = mid;
      }
      fc.minDurationSec = pass;
      fc.minDurationVerified = true;
      fc.minDurationCheck = "verified";
      return;
    }
    if (!helps) {
      fc.minDurationSec = null;
      fc.minDurationVerified = false;
      fc.minDurationCheck = "failed";
      fc.durationHelps = false;
      return;
    }
    fc.minDurationSec = cand;
    fc.minDurationVerified = null;
    fc.minDurationCheck = "unverified";
  }

  /** The 'overspeed' validation issue of a failed flight check (speed- or acceleration-limited). */
  function overspeedIssue(fc, D) {
    const speed = fc.peakSpeed !== null ? `peaks at ${fc.peakSpeed.toFixed(1)} m/s` : fc.lengthM !== null && D > 0 ? `averages ${(fc.lengthM / D).toFixed(1)} m/s` : "is faster than the flight caps";
    const over = fc.lengthM !== null ? ` over ${fc.lengthM.toFixed(0)} m` : "";
    const fly = fc.dryFlight;
    const fix = fc.minDurationSec !== null
      ? fc.minDurationVerified === true
        ? `use duration ≥ ${fc.minDurationSec} s (dry-flown within ${fc.gapToleranceM} m there)`
        : `use duration ≥ ${fc.minDurationSec} s (an estimate: not dry-flown within the check's budget)`
      : fc.durationHelps === false
        ? "a longer duration does not slow this move (its speed comes from its params, its ease or the subject it follows): lower params.speed, use ease 'linear' or give a shorter path"
        : "use a longer duration or a shorter, straighter path";
    const alt = fc.preset === "fpv" ? "" : " (or pilot.flightPreset 'fpv')";
    const eased = fc.ease && fc.ease !== "linear" && fc.sampledPeakSpeed !== null && fc.metaPeakSpeed !== null && fc.sampledPeakSpeed > fc.metaPeakSpeed * 1.1
      ? `; the '${fc.ease}' ease speeds the middle of the move up (ease 'linear' flies it at ≤ ${fc.metaPeakSpeed.toFixed(1)} m/s)`
      : "";
    const trail = fly ? `dry-flown, the craft trails the planned path by up to ${fly.maxGapM.toFixed(1)} m` : "the flown camera falls behind the planned path";
    const message = fc.limitedBy === "acceleration"
      ? `the ${+D.toFixed(3)} s move ${speed}${over}, within the '${fc.preset}' drone's ${fc.vmax} m/s, but turns or changes speed harder than it can follow (≤ ${fc.amax} m/s²${fly && fly.peakAccel > 0 ? `; the path asks for up to ${fly.peakAccel.toFixed(1)} m/s²` : ""}): ${trail} (tolerance ${fc.gapToleranceM} m); ${fix}${alt}${eased}`
      : `the ${+D.toFixed(3)} s move ${speed}${over}, but the '${fc.preset}' drone flies ≤ ${fc.vmax} m/s: the flown camera falls behind the planned path and ends short of it${fly ? ` (${trail})` : ""}; ${fix}${alt}${eased}`;
    const out = {
      code: "overspeed",
      t: null,
      message,
      preset: fc.preset,
      vmax: fc.vmax,
      peakSpeed: fc.peakSpeed,
      limitedBy: fc.limitedBy,
      minDurationSec: fc.minDurationSec,
      minDurationVerified: fc.minDurationVerified,
      durationHelps: fc.durationHelps !== false,
    };
    if (fly) out.maxGapM = fly.maxGapM;
    return out;
  }

  function hasFocusChannel(traj) {
    if (Array.isArray(traj.keyframes) && traj.keyframes.some((k) => Number.isFinite(k.focus) && k.focus > 0)) return true;
    for (const u of [0, 0.5, 1]) {
      try {
        const p = traj.sample(u * traj.duration);
        if (Number.isFinite(p.focus) && p.focus > 0) return true;
      } catch (_) {
        /* checked by validation */
      }
    }
    return false;
  }

  function actorCuesOf(actor) {
    const list = Array.isArray(actor) ? actor : actor && typeof actor === "object" ? [actor] : [];
    return list
      .filter((c) => c && typeof c === "object")
      .map((c) => ({ at: Number.isFinite(c.at) && c.at >= 0 ? c.at : 0, cue: { ...c } }))
      .sort((a, b) => a.at - b.at);
  }

  function prepare(takeIn) {
    if (run) throw new FilmError("prepare: a take is running (abort it or wait)", "FILM_BUSY");
    if (!takeIn || typeof takeIn !== "object" || Array.isArray(takeIn)) throw new FilmError("prepare: the take must be an object", "FILM_BAD_TAKE");
    const take = takeIn;
    const { traj, fromTable, table, spec, ctx: buildCtx } = resolveTrajectory(take);
    if (!isTrajectory(traj) || !(traj.duration >= 0)) throw new FilmError("prepare: the take did not produce a trajectory", "FILM_BAD_TAKE");
    const cap = take.capture && typeof take.capture === "object" ? take.capture : {};
    const fps = Number.isFinite(cap.fps) && cap.fps > 0 && cap.fps <= 240
      ? +cap.fps
      : fromTable && table && Number.isFinite(table.fps) ? +table.fps : TAKE_DEFAULTS.fps;
    const width = Number.isFinite(cap.width) && cap.width > 0 ? cap.width : null;
    const height = Number.isFinite(cap.height) && cap.height > 0 ? cap.height : null;
    const ctxAspect = take.ctx && Number.isFinite(take.ctx.aspect) && take.ctx.aspect > 0 ? take.ctx.aspect : null;
    const aspect = width && height ? width / height : ctxAspect ?? 16 / 9;
    const captureMode = cap.mode === "realtime" ? "realtime" : "stepped";
    const pilotCfg = take.pilot && typeof take.pilot === "object" ? { ...take.pilot } : {};
    const subjectGuid = Number.isFinite(take.subjectGuid) && take.subjectGuid > 0 ? take.subjectGuid >>> 0 : 0;
    // The trajectory's own subject is the pure reference track; a live subject (moving
    // entity / walking player) is what the sensors, pilot and residual see, and what
    // the nominal is re-anchored to (not for replayed tables: they already flew).
    const refSubjectFn = subjectFnOf(traj, subjectGuid, take.ctx);
    const liveRaw = typeof take.liveSubject === "function"
      ? take.liveSubject
      : take.ctx && typeof take.ctx === "object" && typeof take.ctx.liveSubject === "function" ? take.ctx.liveSubject : null;
    const liveSubjectFn = liveFnOf(liveRaw, subjectGuid);
    const subjectFn = liveSubjectFn ? (p) => liveSubjectFn() ?? refSubjectFn(p) : refSubjectFn;
    const liveRig = liveSubjectFn && !fromTable ? liveRigOf(traj, take, refSubjectFn) : null;
    let bounds;
    try {
      bounds = normalizeBounds(pickBounds(traj.bounds || {}) ?? undefined);
    } catch (_) {
      bounds = normalizeBounds();
    }
    const metaSpec = traj.meta && traj.meta.spec && typeof traj.meta.spec === "object" ? traj.meta.spec : null;
    const seedSrc = take.seed ?? (metaSpec ? metaSpec.seed : undefined) ?? (spec ? spec.seed : undefined);
    const seed = seedSrc !== undefined && seedSrc !== null ? seedOf(seedSrc) : hashString(String(traj.id || "take"));
    let tableMeta = null;
    if (fromTable && table && table.meta && typeof table.meta === "object") tableMeta = table.meta;
    // A realised table covers frames × [k/fps, (k+1)/fps): its take lasts frames/fps,
    // one frame longer than its last row time.
    let D = traj.duration;
    if (fromTable) {
      if (tableMeta && Number.isFinite(tableMeta.takeDuration) && tableMeta.takeDuration > 0) D = tableMeta.takeDuration;
      else if (Number.isFinite(table.fps) && table.fps > 0) D = flatLength(table.rows) / TABLE_STRIDE / table.fps;
    }
    const preRollSec = Number.isFinite(take.preRollSec) && take.preRollSec >= 0 ? take.preRollSec : 0;
    let validation = null;
    try {
      const v = validateTrajectory(traj, { fps: Math.min(fps, 60), maxIssues: 5 });
      validation = { ok: v.ok, counts: v.counts, issues: v.issues.map((i) => ({ code: i.code, t: i.t, message: i.message })) };
    } catch (e) {
      validation = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    const family = typeof take.family === "string" && take.family ? take.family : traj.family || "classic";
    let baked = null;
    try {
      baked = bakeTrajectory(traj, fps);
    } catch (_) {
      baked = null;
    }
    const flightCheck = fromTable ? null : flightCheckOf(traj, take, pilotCfg, family, D, baked);
    if (flightCheck && flightCheck.overspeed) {
      if (spec && buildCtx) searchMinDuration(flightCheck, { spec, ctx: buildCtx, take, pilotCfg, family, fps, D });
      else if (flightCheck.minDurationSec !== null) flightCheck.minDurationCheck = "unverified";
    }
    if (flightCheck && flightCheck.overspeed) {
      if (!Array.isArray(validation.issues)) validation.issues = [];
      if (!validation.counts || typeof validation.counts !== "object") validation.counts = {};
      validation.issues.push(overspeedIssue(flightCheck, D));
      validation.counts.overspeed = (validation.counts.overspeed || 0) + 1;
      validation.ok = false;
    }
    const nominalChecksum = baked ? baked.checksum : null;
    plan = {
      traj,
      D,
      fromTable,
      table: fromTable ? table : null,
      family,
      technique: typeof take.technique === "string" && take.technique ? take.technique : traj.technique || "custom",
      shotId: typeof take.shotId === "string" ? take.shotId : null,
      bounds,
      fps,
      width,
      height,
      aspect,
      captureMode,
      pilotCfg,
      pilotMode: ["jev", "code", "shadow"].includes(pilotCfg.mode) ? pilotCfg.mode : "jev",
      subjectFn,
      refSubjectFn,
      liveSubjectFn,
      liveRig,
      flightCheck,
      subjectGuid,
      hasSubject: subjectFn(0) !== null,
      hasFocus: hasFocusChannel(traj),
      preRollSec,
      cell: take.cell ?? null,
      indoor: take.indoor === true,
      standingOrder: typeof take.standingOrder === "string" ? take.standingOrder : undefined,
      goal: typeof take.goal === "string" ? take.goal : undefined,
      framing: metaSpec && metaSpec.framing !== undefined ? metaSpec.framing : (spec && spec.framing) || "MS",
      reveal: !!(traj.meta && traj.meta.reveal === true),
      revealOccluder: revealOccluderOf(traj),
      timeLapse: traj.meta && traj.meta.timeLapse ? plainCopy(traj.meta.timeLapse) : null,
      actorCues: actorCuesOf(take.actor),
      seed,
      flightPreset: typeof pilotCfg.flightPreset === "string" ? pilotCfg.flightPreset : null,
      nominalChecksum,
      validation,
    };
    if (sensors && typeof sensors.reset === "function") sensors.reset();
    if (typeof safety.reset === "function") safety.reset();
    if (d.pilot && typeof d.pilot === "object" && typeof d.pilot.reset === "function") d.pilot.reset();
    lastSummary = summary();
    emit({ message: "prepared", technique: plan.technique, duration: plan.D, fromTable });
    return lastSummary;
  }

  function flatLength(rows) {
    if (ArrayBuffer.isView(rows)) return rows.length;
    if (Array.isArray(rows) && rows.length && Array.isArray(rows[0])) return rows.length * TABLE_STRIDE;
    return Array.isArray(rows) ? rows.length : 0;
  }

  function summary() {
    if (!plan) return null;
    return {
      ok: true,
      shotId: plan.shotId,
      technique: plan.technique,
      family: plan.family,
      duration: plan.D,
      fps: plan.fps,
      plannedFrames: takeFrameCount(plan.D, plan.fps),
      preRollFrames: preRollFrames(plan.fps),
      hasSubject: plan.hasSubject,
      hasFocus: plan.hasFocus,
      fromTable: plan.fromTable,
      captureMode: plan.captureMode,
      pilotMode: plan.pilotMode,
      bounds: { ...plan.bounds },
      reveal: plan.reveal,
      timeLapse: plan.timeLapse,
      nominalChecksum: plan.nominalChecksum,
      validation: plan.validation,
      liveSubject: plan.liveRig
        ? { mode: plan.liveRig.mode, rotate: plan.liveRig.rotate, refHeadingDeg: (plan.liveRig.refHeading * 180) / Math.PI }
        : plan.liveSubjectFn ? { mode: "off", rotate: false, refHeadingDeg: null } : null,
      flight: plan.flightCheck ? { ...plan.flightCheck } : null,
    };
  }

  function preRollFrames(fps) {
    const sec = plan ? plan.preRollSec : 0;
    return Math.max(TAKE_PREROLL_MIN_FRAMES, Math.ceil(sec * fps - 1e-9));
  }

  // ---- per-run machinery ------------------------------------------------------

  function makePilot(R) {
    if (R.locked) return null;
    const cfg = { ...plan.pilotCfg, mode: plan.pilotMode, bounds: { ...plan.bounds }, captureMode: R.mode };
    let p = null;
    if (typeof d.pilot === "function") p = d.pilot(cfg);
    else if (d.pilot && typeof d.pilot === "object") p = d.pilot;
    if (!p) return null;
    if (typeof p.reset === "function") p.reset();
    return p;
  }

  function makeDrone(R) {
    if (R.locked || plan.fromTable) return null;
    if (plan.family !== "drone" && plan.family !== "fpv") return null;
    let preset = plan.flightPreset;
    if (!preset && flight && typeof flight.presetForTrajectory === "function") preset = flight.presetForTrajectory(plan.traj, { indoor: plan.indoor });
    return newDrone(preset || "cinema");
  }

  function newRun(mode, opts) {
    const fps = Number.isFinite(opts.fps) && opts.fps > 0 && opts.fps <= 240 ? +opts.fps : plan.fps;
    const locked = opts.locked === true;
    let traj = plan.traj;
    let D = plan.D;
    if (locked) {
      const tbl = plan.fromTable ? plan.table : lastTable;
      if (!tbl) throw new FilmError("locked replay needs a realised table: prepare({table}) or rehearse() first", "FILM_NO_TABLE");
      if (!plan.fromTable) {
        traj = trajectoryFromTable(tbl);
        const tm = tbl.meta && Number.isFinite(tbl.meta.takeDuration) ? tbl.meta.takeDuration : null;
        D = tm ?? (flatLength(tbl.rows) / TABLE_STRIDE) / (tbl.fps || fps);
      }
    }
    const Nnom = takeFrameCount(D, fps);
    const maxOverrun = Number.isFinite(opts.maxOverrun) && opts.maxOverrun >= 0 ? opts.maxOverrun : TAKE_DEFAULTS.maxOverrun;
    const R = {
      mode,
      fps,
      locked,
      record: opts.record === true,
      render: opts.render !== false,
      traj,
      D,
      Nnom,
      maxOverrun,
      maxFrames: locked ? Nnom : Nnom + Math.ceil(Nnom * maxOverrun),
      // Realtime takes end on wall time; this only bounds a runaway display rate (240 Hz).
      realtimeFrameLimit: Math.ceil(D * 240 * (1 + maxOverrun)) + TAKE_PREROLL_MIN_FRAMES,
      progressFrames: 0,
      speedScale: 1,
      endT: null,
      prevPose: null,
      prevQ: null,
      rows: [],
      telemetry: [],
      telemetryDropped: 0,
      safetyEvents: [],
      safetyAdjusted: 0,
      safetyLayers: {},
      obstruction: { minVisibleFrac: null, framesHidden: 0, framesOccluded: 0, maxUnseenSec: 0, measuredFrames: 0 },
      newDecisions: 0,
      grabbed: 0,
      dropped: 0,
      armed: null,
      // Realtime film grid: `done` grid points recorded (rows + grab), `end` the take's grid
      // length once it ended; per-display-frame counters for the report.
      grid: { done: 0, end: null, display: 0, held: 0, skipped: 0, carried: 0, backpressure: 0, tail: 0 },
      lastSp: NEUTRAL_SETPOINT,
      cull: null,
      // The pre-roll AdminEnvirons wait's result (waitEnvironSettled).
      environ: null,
      rerouteBias: 0,
      rerouteSide: 0,
      popIn: 0,
      sceneSig: null,
      dof: { used: false, writes: 0, enabled: false, errors: 0 },
      fades: { entities: [], particles: [], statics: [] },
      // The point subject's own body (the Life Stone it is aimed at): never an occluder, never faded.
      subjectBody: subjectBodyOf(),
      fadeFallbacks: 0,
      fadeMisses: new Map(),
      actorResults: [],
      cueIndex: 0,
      capped: false,
      aborted: false,
      pilot: null,
      drone: null,
      recorder: null,
      lastSf: null,
      live: null,
      // Flown takes: how far the craft trailed its (re-anchored) nominal — the realised side of the
      // prepare-time flight check (a path faster or tighter than the preset lags behind it).
      flown: null,
    };
    R.pilot = makePilot(R);
    R.drone = makeDrone(R);
    if (R.drone) R.flown = { frames: 0, maxGapM: 0, maxGapT: null, endGapM: null };
    if (plan.liveRig && !locked && !plan.fromTable) R.live = newLiveState(plan.liveRig, R);
    return R;
  }

  // ---- live subject (re-anchoring the nominal) ----------------------------------

  /**
   * A flown carry rig may only swing round the subject as fast as its craft can
   * follow: angular acceleration ≤ ½·amax / r and rate ≤ ½·vmax / r, r = the
   * rig's horizontal radius at the start. Within those caps swingStep speeds the
   * swing up only with the acceleration the craft has left: the swing's own
   * (tangential θ̈·r and centripetal θ̇²·r) ≤ amax − |the subject's acceleration|
   * − swingRadialYield·|the craft's radial error| (braking is never limited) —
   * a subject that turns harder than the craft can follow freezes the swing
   * until its turn is done, and the craft wins its distance back first.
   * Null for unflown rigs (no limit).
   */
  function swingLimits(rig, R) {
    const cfg = R.drone && R.drone.config && typeof R.drone.config === "object" ? R.drone.config : null;
    if (!cfg || rig.mode !== "carry" || !rig.rotate) return null;
    const ref0 = plan.refSubjectFn(0);
    let r = 0;
    try {
      const n0 = R.traj.sample(0).pos;
      if (ref0) r = Math.hypot(n0[0] - ref0.pos[0], n0[1] - ref0.pos[1]);
    } catch (_) {
      r = 0;
    }
    if (!(r > 0.5) || !(cfg.amax > 0) || !(cfg.vmax > 0)) return null;
    return { alpha: (0.5 * cfg.amax) / r, rate: (0.5 * cfg.vmax) / r, r, amax: cfg.amax };
  }

  function newLiveState(rig, R) {
    const lim = swingLimits(rig, R);
    return {
      swingAlpha: lim ? lim.alpha : null,
      swingRate: lim ? lim.rate : null,
      swingR: lim ? lim.r : null,
      swingAmax: lim ? lim.amax : null,
      // Flown swings: the subject's horizontal acceleration (this frame) and the craft's radial
      // error from its re-anchored nominal (last frame), which the swing's budget yields to.
      subjAcc: 0,
      craftRadM: 0,
      gimbal: !!(R.drone && !(R.drone.config && R.drone.config.mount === "hard")),
      carry: rig.mode === "carry",
      rotate: rig.rotate,
      refHeading: rig.refHeading,
      facing: rig.facing,
      turnLag: rig.turnLag,
      init: false,
      x: [0, 0, 0],
      v: [0, 0, 0],
      F: [0, 0, 0],
      T: [0, 0, 0],
      theta: 0,
      thetaV: 0,
      // The swing's angular acceleration at the end of the last step (the drone feed-forward's θ̈).
      thetaA: 0,
      held: rig.refHeading,
      clock: 0,
      hist: [],
      settleHist: [],
      frames: 0,
      missing: 0,
      maxOffsetM: 0,
      maxLagM: 0,
      maxTurn: 0,
    };
  }

  /**
   * Live travel heading (unwrapped onto S.held) from the position history; facing
   * while it stands (classic). A jump faster than maxFeedSpeed (a server snap)
   * restarts the history, so a snap is never read as travel.
   */
  function liveHeading(S, L) {
    const last = S.hist.length ? S.hist[S.hist.length - 1] : null;
    if (last) {
      const jump = Math.hypot(L.pos[0] - last.pos[0], L.pos[1] - last.pos[1]);
      if (jump > LIVE_SUBJECT.maxFeedSpeed * Math.max(S.clock - last.c, 1e-3) + 0.05) S.hist.length = 0;
    }
    S.hist.push({ c: S.clock, pos: L.pos.slice() });
    while (S.hist.length > 2 && S.hist[0].c < S.clock - LIVE_SUBJECT.historySec) S.hist.shift();
    let old = S.hist[0];
    for (const e of S.hist) {
      if (e.c <= S.clock - LIVE_SUBJECT.headingWindowSec + 1e-9) old = e;
      else break;
    }
    const span = S.clock - old.c;
    let travelling = false;
    if (span >= LIVE_SUBJECT.minHeadingSpanSec) {
      const vx = (L.pos[0] - old.pos[0]) / span, vy = (L.pos[1] - old.pos[1]) / span;
      if (Math.hypot(vx, vy) > LIVE_SUBJECT.minSpeed) {
        S.held = unwrapAngle(Math.atan2(vx, vy), S.held);
        travelling = true;
      }
    }
    if (!travelling && S.facing && Number.isFinite(L.heading)) S.held = unwrapAngle(L.heading, S.held);
    return S.held - S.refHeading;
  }

  /**
   * The reference subject's own velocity at progress p (m/s of film time at the
   * current progress rate): what the live − reference offset loses per second
   * once the progress runs. Zero for a static reference.
   */
  function refVelocity(R, p) {
    const D = R.D;
    const span = Math.min(0.1, D);
    if (!(span > 1e-6)) return [0, 0, 0];
    const a = clamp(Math.min(p, D - span), 0, D), b = a + span;
    const ra = plan.refSubjectFn(a), rb = plan.refSubjectFn(b);
    if (!ra || !rb) return [0, 0, 0];
    const k = (R.speedScale > 0 ? R.speedScale : 1) / span;
    return [(rb.pos[0] - ra.pos[0]) * k, (rb.pos[1] - ra.pos[1]) * k, (rb.pos[2] - ra.pos[2]) * k];
  }

  /**
   * The live subject's velocity over the settle (pre-roll) frames: a straight
   * line through its positions of the last headingWindowSec (restarted at a
   * server snap), so a position stream that updates in bursts still gives its
   * mean speed. Null until two frames are known.
   */
  function settleSubjectVelocity(S, L) {
    const last = S.settleHist.length ? S.settleHist[S.settleHist.length - 1] : null;
    if (last) {
      const jump = Math.hypot(L.pos[0] - last.pos[0], L.pos[1] - last.pos[1], L.pos[2] - last.pos[2]);
      if (jump > LIVE_SUBJECT.maxFeedSpeed * Math.max(S.clock - last.c, 1e-3) + 0.05) S.settleHist.length = 0;
    }
    S.settleHist.push({ c: S.clock, pos: L.pos.slice() });
    while (S.settleHist.length > 2 && S.settleHist[0].c < S.clock - LIVE_SUBJECT.headingWindowSec - 1e-9) S.settleHist.shift();
    const old = S.settleHist[0];
    const span = S.clock - old.c;
    if (!(span > 1e-6)) return null;
    return [(L.pos[0] - old.pos[0]) / span, (L.pos[1] - old.pos[1]) / span, (L.pos[2] - old.pos[2]) / span];
  }

  /**
   * Advance the live state to progress p after `dt` seconds: the follower of
   * the live − reference subject offset T and the rig's turn θ (a critically
   * damped spring on the travel-heading change). `phase`:
   * - 'track' (the take): the follower eases the offset in;
   * - 'settle' (the pre-roll, never recorded; the reference is HELD at p = 0):
   *   the follower is put in steady state on the live subject — x = T, θ on the
   *   live heading — with the offset velocity the take will see once the
   *   progress runs: the subject's own velocity (measured over the pre-roll)
   *   MINUS the reference's (a reference extrapolated from a subject that was
   *   walking at prepare already moves at that speed: a subject that keeps
   *   walking holds a constant offset, so the rig neither surges nor drops back
   *   when the take starts, and a flown craft is not reset at double speed);
   * - 'anchor' (frame 0: recorded, but still p = 0 like the pre-roll): x = T
   *   exactly, the settled velocities kept (frame 0 sits a whole frame after the
   *   last pre-roll frame at a held reference — no velocity is read off it).
   */
  function liveUpdate(R, p, dt, phase) {
    const S = R.live;
    const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
    S.clock += h;
    const L = plan.liveSubjectFn();
    const ref = plan.refSubjectFn(p);
    if (!L || !ref) {
      S.missing += 1;
      return;
    }
    S.frames += 1;
    const settle = phase !== "track";
    const T = [L.pos[0] - ref.pos[0], L.pos[1] - ref.pos[1], L.pos[2] - ref.pos[2]];
    if (phase === "anchor" && S.init) {
      S.x = T.slice();
      S.T = T;
    } else if (!S.init || settle) {
      // Until the subject's own velocity is known (its first frame, or first seen mid-take)
      // it is assumed to move like the reference: the offset at rest.
      let v = [0, 0, 0];
      const vL = settle ? settleSubjectVelocity(S, L) : null;
      if (vL) {
        const vR = refVelocity(R, p);
        v = [vL[0] - vR[0], vL[1] - vR[1], vL[2] - vR[2]];
        if (Math.hypot(v[0], v[1], v[2]) > LIVE_SUBJECT.maxFeedSpeed) v = [0, 0, 0];
      }
      S.x = T.slice();
      S.v = v.slice();
      S.F = v.slice();
      S.T = T;
      S.init = true;
    } else if (h > 0) {
      liveFollowStep(S, T, h);
    }
    if (S.rotate) {
      const target = liveHeading(S, L);
      if (settle) {
        S.theta = target;
        S.thetaV = 0;
        S.thetaA = 0;
      } else if (h > 0) {
        if (S.swingAlpha > 0) {
          // The subject's own horizontal acceleration: the follower's (live − reference) + the reference's.
          const xa = liveFollowAcc(S);
          const aR = derivsOf(R, refPosAt, p, R.speedScale > 0 ? R.speedScale : 1);
          S.subjAcc = Math.hypot(xa[0] + (aR ? aR.acc[0] : 0), xa[1] + (aR ? aR.acc[1] : 0));
        }
        swingStep(S, target, h);
      }
      S.maxTurn = Math.max(S.maxTurn, Math.abs(S.theta));
    }
    S.maxOffsetM = Math.max(S.maxOffsetM, Math.hypot(S.x[0], S.x[1], S.x[2]));
    S.maxLagM = Math.max(S.maxLagM, Math.hypot(S.x[0] - T[0], S.x[1] - T[1], S.x[2] - T[2]));
  }

  /**
   * Swing the rig's turn θ toward `target` over h seconds: unflown rigs as a
   * critically damped spring (ω = 2/turnLag, exact step); flown rigs within
   * their craft's swing limits — rate ≤ min(ω·|e|, √(2·α·|e|), max rate),
   * reached at ≤ α (it brakes in time, so it never overshoots); speeding up
   * only within the budget the craft has left (swingLimits: tangential +
   * centripetal ≤ amax − |subject acceleration| − yield·|radial error|), braking
   * always at α. Keeps the angular acceleration at the end of the step
   * (S.thetaA) for the feed-forward.
   */
  function swingStep(S, target, h) {
    const omega = 2 / S.turnLag;
    if (!(S.swingAlpha > 0)) {
      const ex = Math.exp(-omega * h);
      const e = S.theta - target;
      const b = S.thetaV + omega * e;
      S.theta = target + (e + b * h) * ex;
      S.thetaV = (S.thetaV - omega * b * h) * ex;
      S.thetaA = -omega * omega * (S.theta - target) - 2 * omega * S.thetaV;
      return;
    }
    const n = Math.max(1, Math.ceil(h * 240));
    const dt = h / n;
    // The acceleration the craft has left for the swing (swingLimits).
    const budget = Math.max(0, S.swingAmax - S.subjAcc - LIVE_SUBJECT.swingRadialYield * Math.abs(S.craftRadM));
    let a = 0;
    for (let i = 0; i < n; i += 1) {
      const e = target - S.theta;
      const want = Math.sign(e) * Math.min(omega * Math.abs(e), Math.sqrt(2 * S.swingAlpha * Math.abs(e)), S.swingRate);
      // Speeding the swing up spends the budget (its centripetal part first); braking never waits.
      const cen = S.thetaV * S.thetaV * S.swingR;
      const up = Math.sqrt(Math.max(0, budget * budget - cen * cen)) / S.swingR;
      const hi = S.thetaV < 0 ? S.swingAlpha : Math.min(S.swingAlpha, up);
      const lo = S.thetaV > 0 ? -S.swingAlpha : -Math.min(S.swingAlpha, up);
      a = clamp((want - S.thetaV) / dt, lo, hi);
      S.thetaV += a * dt;
      S.theta += S.thetaV * dt;
    }
    S.thetaA = a;
  }

  /**
   * A flown gimbal shot keeps the live subject framed from where the craft really
   * is (it lags the re-anchored nominal through starts, stops and swings): the
   * view turns from the nominal's line of sight to the live aim point to the
   * flown pose's. Hard-mounted (fpv) cameras are not turned.
   */
  function liveGimbal(R, pose, nominal, p) {
    const S = R.live;
    if (!S || !S.init || !S.gimbal || pose === nominal) return pose;
    const ref = plan.refSubjectFn(p);
    if (!ref) return pose;
    const c = liveAimOf(ref);
    const A = [c[0] + S.x[0], c[1] + S.x[1], c[2] + S.x[2]];
    const n = nominal.pos, f = pose.pos;
    return reAimDirs(pose, [A[0] - n[0], A[1] - n[1], A[2] - n[2]], [A[0] - f[0], A[1] - f[1], A[2] - f[2]], plan.aspect);
  }

  /** A nominal position moved with the subject (carry rigs): turned about the reference subject by θ, offset by x. */
  function liveShiftPos(R, pos, p) {
    const S = R.live;
    if (!S || !S.init || !S.carry) return pos;
    const th = S.rotate ? S.theta : 0;
    let out = pos;
    if (Math.abs(th) > 1e-12) {
      const ref = plan.refSubjectFn(p);
      if (ref) {
        const r = turnCompass([pos[0] - ref.pos[0], pos[1] - ref.pos[1], pos[2]], th);
        out = [ref.pos[0] + r[0], ref.pos[1] + r[1], pos[2]];
      }
    }
    return [out[0] + S.x[0], out[1] + S.x[1], out[2] + S.x[2]];
  }

  /**
   * The nominal pose re-anchored to the live subject: carry rigs move rigidly
   * with it (turned about it by θ, offset by the smoothed live − reference
   * offset; the view turns with them, so the framing is the nominal's), other
   * techniques keep their position and re-aim from the reference subject to
   * the (smoothed) live one. Identity while the live subject sits on the reference.
   */
  function liveApply(R, pose, p) {
    const S = R.live;
    if (!S || !S.init) return pose;
    const ref = plan.refSubjectFn(p);
    if (!ref) return pose;
    if (S.carry) {
      const th = S.rotate ? S.theta : 0;
      const turn = Math.abs(th) > 1e-12;
      if (!turn && S.x[0] === 0 && S.x[1] === 0 && S.x[2] === 0) return pose;
      const pos = liveShiftPos(R, pose.pos, p);
      if (!turn) return { ...pose, pos };
      const q = qNorm(qMul(qFromAxisAngle([0, 0, 1], -th), qNorm(pose.q)));
      const e = hprFromQuat(q, fin(pose.h, 0) + th, fin(pose.r, 0));
      return { ...pose, pos, q, h: e.h, p: e.p, r: e.r };
    }
    const a0 = liveAimOf(ref);
    return reAimPose(pose, a0, [a0[0] + S.x[0], a0[1] + S.x[1], a0[2] + S.x[2]], plan.aspect);
  }

  /** The shot framing's aim point on a subject (eye line for close framings), else its centre. */
  function liveAimOf(s) {
    try {
      return aimPointForFraming(plan.framing, s);
    } catch (_) {
      return centerOf(s);
    }
  }

  /** The follower's acceleration ẍ = ω²(T − x) + 2ω(F − v) at the end of its last step (0 in steady state). */
  function liveFollowAcc(S) {
    const om = 2 / LIVE_SUBJECT.smoothTime;
    return [0, 1, 2].map((c) => om * om * (S.T[c] - S.x[c]) + 2 * om * (S.F[c] - S.v[c]));
  }

  /**
   * Drone feed-forward of a re-anchored carry rig: the FULL time derivative of
   * liveShiftPos's pose. With p advancing at `speed`, θ swinging at θ̇ / θ̈ and
   * the follower x moving at ẋ / ẍ, the rig sits at
   *   pos = ref(p) + R_θ(nom(p) − ref(p)) + x        (horizontal; z = nom_z + x_z)
   * so (r = nom − ref horizontal, R'_θ = R_{θ+π/2}, R''_θ = −R_θ):
   *   vel = vR + R_θ(vN − vR) + θ̇·R'_θ(r) + ẋ
   *   acc = aR + R_θ(aN − aR) + 2θ̇·R'_θ(vN − vR) + θ̈·R'_θ(r) − θ̇²·R_θ(r) + ẍ
   * vN / aN (`dv`) and vR / aR are the nominal's and the reference subject's own
   * derivatives on the same stencil (× speed, speed²). Round 2 returned only
   * R_θ(vN) + ẋ: wrong by (I − R_θ)·vR whenever the subject walks off the
   * reference heading (θ ≠ 0 — a flown craft reset at |2vL − vR|) and blind to
   * the swing rate while the rig swings round a turning subject.
   */
  function liveDerivs(R, p, speed, dv) {
    const S = R.live;
    if (!S || !S.init || !S.carry) return dv;
    const xa = liveFollowAcc(S);
    const th = S.rotate ? S.theta : 0;
    const w = S.rotate ? S.thetaV : 0;
    const al = S.rotate ? S.thetaA : 0;
    const ref = Math.abs(th) > 1e-12 || Math.abs(w) > 1e-12 || Math.abs(al) > 1e-12 ? plan.refSubjectFn(p) : null;
    if (!ref) {
      // No turn (or no reference to turn about — liveShiftPos then only translates).
      return {
        vel: [dv.vel[0] + S.v[0], dv.vel[1] + S.v[1], dv.vel[2] + S.v[2]],
        acc: [dv.acc[0] + xa[0], dv.acc[1] + xa[1], dv.acc[2] + xa[2]],
      };
    }
    const dR = derivsOf(R, refPosAt, p, speed) || { vel: [0, 0, 0], acc: [0, 0, 0] };
    let nom;
    try {
      nom = R.traj.sample(p).pos;
    } catch (_) {
      nom = ref.pos;
    }
    const r = [nom[0] - ref.pos[0], nom[1] - ref.pos[1], 0];
    const vRel = [dv.vel[0] - dR.vel[0], dv.vel[1] - dR.vel[1], 0];
    const aRel = [dv.acc[0] - dR.acc[0], dv.acc[1] - dR.acc[1], 0];
    const half = Math.PI / 2;
    const vT = turnCompass(vRel, th), vP = turnCompass(vRel, th + half);
    const aT = turnCompass(aRel, th);
    const rT = turnCompass(r, th), rP = turnCompass(r, th + half);
    const vel = [0, 1].map((c) => dR.vel[c] + vT[c] + w * rP[c] + S.v[c]);
    const acc = [0, 1].map((c) => dR.acc[c] + aT[c] + 2 * w * vP[c] + al * rP[c] - w * w * rT[c] + xa[c]);
    return { vel: [vel[0], vel[1], dv.vel[2] + S.v[2]], acc: [acc[0], acc[1], dv.acc[2] + xa[2]] };
  }

  /** The reference subject's position at progress t (liveDerivs' stencil), or null. */
  function refPosAt(t) {
    const s = plan.refSubjectFn(t);
    return s ? s.pos : null;
  }

  /**
   * "Right of travel" of a re-anchored carry rig: from its live travel — the
   * reference's travel, plus the nominal's travel relative to it turned by θ,
   * plus the offset velocity (liveDerivs without the swing term, so a rig
   * swinging round a standing subject keeps the camera frame, not the swing).
   */
  function liveRightVector(R, p, pose) {
    const S = R.live;
    const D = R.D;
    let tx = S.v[0], ty = S.v[1];
    if (D > 0) {
      const hh = clamp(0.01 * D, 1e-3, 0.25);
      const a = clamp(p - hh, 0, D), b = clamp(p + hh, 0, D);
      if (b - a > 1e-9) {
        try {
          const pa = R.traj.sample(a).pos, pb = R.traj.sample(b).pos;
          const ra = refPosAt(a), rb = refPosAt(b);
          const vR = ra && rb ? [(rb[0] - ra[0]) / (b - a), (rb[1] - ra[1]) / (b - a)] : [0, 0];
          const t = turnCompass([(pb[0] - pa[0]) / (b - a) - vR[0], (pb[1] - pa[1]) / (b - a) - vR[1], 0], S.rotate ? S.theta : 0);
          tx += vR[0] + t[0];
          ty += vR[1] + t[1];
        } catch (_) {
          /* camera frame below */
        }
      }
    }
    const l = Math.hypot(tx, ty);
    if (l > 0.05 && Number.isFinite(l)) return [ty / l, -tx / l, 0];
    return pathRightVector({ duration: 0 }, p, pose);
  }

  function liveReport(R) {
    const S = R.live;
    if (!S) return null;
    return {
      mode: S.carry ? "carry" : "aim",
      rotate: S.rotate,
      frames: S.frames,
      missingFrames: S.missing,
      maxOffsetM: S.maxOffsetM,
      maxLagM: S.maxLagM,
      maxTurnDeg: (S.maxTurn * 180) / Math.PI,
      refHeadingDeg: (S.refHeading * 180) / Math.PI,
    };
  }

  /** The shot's subject at progress p (normalised, with the guid), or null. */
  function subjectAt(p) {
    return plan.subjectFn(p);
  }

  function centerOf(s) {
    return s ? [s.pos[0], s.pos[1], s.pos[2] + s.height / 2] : null;
  }

  function aheadPoints(R, p, tPrev) {
    const out = [];
    const n = TAKE_DEFAULTS.aheadPoints;
    const sp = Math.max(0, R.speedScale);
    for (let i = 1; i <= n; i += 1) {
      const dtA = (i * TAKE_DEFAULTS.aheadSec) / n;
      const pa = clamp(p + dtA * sp, 0, R.D);
      try {
        const pos = R.traj.sample(pa).pos;
        out.push({ pos: R.live ? liveShiftPos(R, pos, pa) : pos.slice(), t: tPrev + dtA });
      } catch (_) {
        break;
      }
    }
    return out;
  }

  function senseFrame(R, dt) {
    if (!sensors || !R.prevPose) return null;
    const p = Math.min(R.D, R.progressFrames / R.fps);
    const subj = subjectAt(p);
    const ctx = {
      subject: subj ? { ...subj, guid: subj.guid || plan.subjectGuid || 0 } : null,
      framing: plan.framing,
      aspect: plan.aspect,
      indoor: plan.indoor,
      nominalAhead: aheadPoints(R, p, fin(R.prevPose.t, 0)),
      fadedIds: fadedIdsOf(R),
      subjectBodyIds: R.subjectBody,
    };
    try {
      return sensors.sense({ ...R.prevPose }, ctx, dt);
    } catch (e) {
      emit({ level: "warn", message: `sensors.sense threw: ${e && e.message ? e.message : e}` });
      return null;
    }
  }

  function pilotCtx() {
    return { standingOrder: plan.standingOrder, technique: plan.technique, goal: plan.goal, hasSubject: plan.hasSubject };
  }

  function noteTelemetry(R, k, out) {
    const tel = out && out.telemetry;
    if (!tel || typeof tel !== "object") return;
    if (tel.newDecision) R.newDecisions += 1;
    if (!(tel.consulted || tel.newDecision)) return;
    if (R.telemetry.length >= TAKE_DEFAULTS.telemetryLimit) {
      R.telemetryDropped += 1;
      return;
    }
    R.telemetry.push({ frame: k, ...plainCopy(tel) });
  }

  function setpointOf(out) {
    const sp = out && out.setpoint && typeof out.setpoint === "object" ? out.setpoint : null;
    return sp || NEUTRAL_SETPOINT;
  }

  /** Track the reroute bias (toward the roomier side while reroute is asked). */
  function updateReroute(R, sp, sf, dt) {
    const maxL = plan.bounds.maxLateral;
    if (sp.reroute === true) {
      if (R.rerouteSide === 0) {
        const L = sf && sf.limits ? fin(sf.limits.roomLeft, 0) : 0;
        const Rr = sf && sf.limits ? fin(sf.limits.roomRight, 0) : 0;
        R.rerouteSide = Rr >= L ? 1 : -1;
      }
    } else {
      R.rerouteSide = 0;
    }
    const target = R.rerouteSide * maxL;
    const step = TAKE_DEFAULTS.rerouteMps * Math.max(0, dt);
    const dx = target - R.rerouteBias;
    R.rerouteBias = Math.abs(dx) <= step ? target : R.rerouteBias + Math.sign(dx) * step;
  }

  // ---- fades (occluder_action 'fade') ---------------------------------------

  /** Every id this take has faded (for the sensors' `fadedIds`). */
  function fadedIdsOf(R) {
    const f = R.fades;
    if (!f.entities.length && !f.particles.length && !f.statics.length) return null;
    return [...f.entities, ...f.particles.map((p) => p.key), ...f.statics.map((s) => s.key)];
  }

  /**
   * A POINT subject's own body: the entities and fadeable placements whose footprint holds the
   * subject's axis — the Life Stone, statue or brazier the shot is aimed at. Its plan radius is
   * often the crystal / figure only, so a ray to the subject can stop on the body's outer parts
   * (a Life Stone's prongs): the sensors count that as seeing the subject (`subjectBodyIds`) and
   * fade() never hides it — it IS the shot, like a reveal shot's own occluder. Resolved once per
   * run, at its start (the site is streamed in by then). None for a guid subject (its guid is
   * excluded already), a moving or path subject, or a point wider than subjectBodyMaxRadiusM
   * (a town square is a place, not an object).
   * @returns {Array<number|string>} guids and static fade keys
   */
  function subjectBodyOf() {
    const ids = [];
    const wq = d.worldQuery;
    if (!wq || typeof wq.entitiesNear !== "function" || plan.subjectGuid || plan.liveSubjectFn) return ids;
    let s0 = null;
    let s1 = null;
    try {
      s0 = subjectAt(0);
      s1 = subjectAt(plan.D);
    } catch (_) {
      return ids;
    }
    const base = s0 && !s0.guid ? vec3(s0.pos) : null;
    const end = s1 ? vec3(s1.pos) : null;
    if (!base || !end || Math.hypot(end[0] - base[0], end[1] - base[1], end[2] - base[2]) > 1e-3) return ids;
    if (fin(s0.radius, 0) > TAKE_DEFAULTS.subjectBodyMaxRadiusM) return ids;
    const pad = TAKE_DEFAULTS.subjectBodyPadM;
    const h = Math.max(0, fin(s0.height, 0));
    // Footprint holds the subject's axis, and the height spans overlap.
    const holds = (pos, r, hh) => {
      const p = vec3(pos);
      if (!p || !Number.isFinite(r) || r < 0) return false;
      const top = p[2] + Math.max(0, fin(hh, 0));
      return Math.hypot(p[0] - base[0], p[1] - base[1]) <= r + pad && p[2] <= base[2] + h + pad && top >= base[2] - pad;
    };
    // A body holding the axis lies within h/2 of its middle (entitiesNear / staticsNear: surface distance).
    const mid = [base[0], base[1], base[2] + h / 2];
    const reach = h / 2 + pad;
    try {
      for (const e of wq.entitiesNear(mid, reach) || []) {
        if (e && !e.isLocal && Number.isFinite(e.guid) && e.guid > 0 && holds(e.pos, e.radius, e.height)) ids.push(e.guid >>> 0);
      }
    } catch (_) {
      /* no entities */
    }
    try {
      const rows = typeof wq.staticsNearCached === "function" ? wq.staticsNearCached(mid, reach) : [];
      for (const row of rows || []) {
        if (!row || !FADEABLE_STATIC_SOURCES.includes(row.source) || !FADEABLE_STATIC_KINDS.includes(row.kind)) continue;
        if (!holds(row.pos, row.radius, row.height)) continue;
        const key = staticFadeKey(row);
        if (key) ids.push(key);
      }
    } catch (_) {
      /* no statics */
    }
    return ids;
  }

  /** True when a placement sits on the reveal shot's own occluder (never faded: it IS the shot). */
  function revealProtected(pos) {
    const ro = plan.revealOccluder;
    const p = vec3(pos);
    if (!ro || !p) return false;
    return Math.hypot(p[0] - ro.pos[0], p[1] - ro.pos[1]) <= ro.radius + TAKE_DEFAULTS.revealGuardM;
  }

  /** Hide one static draw (world_query staticFadeTargets); returns its undo record, `{type:'noop'}` when it was already hidden, or null. */
  function hideStatic(tg) {
    if (!tg || typeof tg !== "object") return null;
    if (tg.type === "node") {
      const node = tg.node;
      if (!node || typeof node !== "object") return null;
      if (!node.userData || typeof node.userData !== "object") node.userData = {};
      const ud = node.userData;
      if (ud.__filmHidden === true) return { type: "noop" };
      const rec = { type: "node", node, hadMarker: Object.prototype.hasOwnProperty.call(ud, "__filmHidden"), prevMarker: ud.__filmHidden, prevVisible: node.visible };
      ud.__filmHidden = true; // statics.js cullStaticsGroup honours it every frame
      node.visible = false; // holds with ?frustumCull=off (nothing else rewrites it then)
      return rec;
    }
    if (tg.type === "instance") {
      const mesh = tg.mesh;
      const attr = mesh && mesh.instanceMatrix;
      const arr = attr && attr.array;
      const i = tg.index;
      if (!arr || !Number.isInteger(i) || i < 0 || 16 * i + 16 > arr.length) return null;
      const o = 16 * i;
      const prev = Array.from(arr.subarray ? arr.subarray(o, o + 16) : arr.slice(o, o + 16));
      if (LINEAR_3X3.every((k) => prev[k] === 0)) return { type: "noop" };
      for (const k of LINEAR_3X3) arr[o + k] = 0; // zero scale at its own origin: draws nothing, casts nothing
      attr.needsUpdate = true;
      return { type: "instance", mesh, index: i, prev, mine: Array.from(arr.subarray ? arr.subarray(o, o + 16) : arr.slice(o, o + 16)) };
    }
    if (tg.type === "batch") {
      const bm = tg.mesh;
      const id = tg.instanceId;
      if (!bm || typeof bm.setVisibleAt !== "function" || !Number.isInteger(id)) return null;
      try {
        if (typeof bm.getVisibleAt === "function" && bm.getVisibleAt(id) === false) return { type: "noop" };
        bm.setVisibleAt(id, false);
      } catch (_) {
        return null; // a deleted instance
      }
      // What we left (geometry + matrix) and a watch on every LATER visibility write to it.
      return { type: "batch", mesh: bm, instanceId: id, state: batchState(bm, id), watch: watchBatch(bm, id) };
    }
    return null;
  }

  /**
   * BatchedMesh visibility has no owner and three's setVisibleAt leaves no trace of a
   * redundant write (false → false), so while this take holds a batch hide the mesh's
   * setVisibleAt is shadowed by a pass-through that marks a write to a held instance as
   * FOREIGN (pool_registry park / unpark, static_atlas hide / show, static_batch_x). The
   * shadow is removed when the last hold on that mesh is released.
   * @type {WeakMap<object, {orig:Function, hadOwn:boolean, wrapper:Function, held:Map<number, {foreign:boolean}>}>}
   */
  const batchWatches = new WeakMap();

  /** Start watching instance `id` of `bm`; returns its token (null when the mesh cannot be watched). */
  function watchBatch(bm, id) {
    let w = batchWatches.get(bm);
    if (!w) {
      const orig = bm.setVisibleAt;
      const hadOwn = Object.prototype.hasOwnProperty.call(bm, "setVisibleAt");
      const held = new Map();
      const wrapper = function filmWatchedSetVisibleAt(instanceId, ...rest) {
        const tok = held.get(instanceId);
        if (tok) tok.foreign = true;
        return orig.call(this, instanceId, ...rest);
      };
      try {
        bm.setVisibleAt = wrapper;
      } catch (_) {
        return null; // a frozen / sealed mesh: restore falls back to the visible-state check
      }
      if (bm.setVisibleAt !== wrapper) return null;
      w = { orig, hadOwn, wrapper, held };
      batchWatches.set(bm, w);
    }
    const tok = { foreign: false };
    w.held.set(id, tok);
    return tok;
  }

  /** Stop watching instance `id`; drops the shadow when nothing on `bm` is held (if it is still ours). */
  function unwatchBatch(bm, id, tok) {
    const w = batchWatches.get(bm);
    if (!w) return;
    if (w.held.get(id) === tok) w.held.delete(id);
    if (w.held.size > 0) return;
    batchWatches.delete(bm);
    if (bm.setVisibleAt !== w.wrapper) return; // someone wrapped over it: leave ours as a pass-through
    try {
      if (w.hadOwn) bm.setVisibleAt = w.orig;
      else delete bm.setVisibleAt;
    } catch (_) {
      /* a sealed mesh keeps the pass-through */
    }
  }

  /** `{geom, m}` of a BatchedMesh instance (geometry id, 16 matrix floats); null parts when unreadable. */
  function batchState(bm, id) {
    let geom = null;
    let m = null;
    try {
      if (typeof bm.getGeometryIdAt === "function") geom = bm.getGeometryIdAt(id);
    } catch (_) {
      geom = null;
    }
    try {
      if (typeof bm.getMatrixAt === "function") {
        const sink = { elements: null, fromArray(a, off = 0) { this.elements = Array.from({ length: 16 }, (_, k) => a[off + k]); return this; } };
        const r = bm.getMatrixAt(id, sink);
        const e = (r && r.elements) || sink.elements;
        m = Array.isArray(e) && e.length === 16 ? e : null;
      }
    } catch (_) {
      m = null;
    }
    return { geom, m };
  }

  /** Undo one static hide, only where the value is still the one the fade wrote. */
  function restoreStatic(u) {
    try {
      if (u.type === "node") {
        const ud = u.node.userData && typeof u.node.userData === "object" ? u.node.userData : null;
        if (ud) {
          if (u.hadMarker) ud.__filmHidden = u.prevMarker;
          else delete ud.__filmHidden;
        }
        u.node.visible = u.prevVisible;
      } else if (u.type === "instance") {
        const attr = u.mesh.instanceMatrix;
        const arr = attr && attr.array;
        const o = 16 * u.index;
        if (!arr || o + 16 > arr.length) return;
        for (let k = 0; k < 16; k += 1) if (arr[o + k] !== u.mine[k]) return; // rewritten since: not ours any more
        for (let k = 0; k < 16; k += 1) arr[o + k] = u.prev[k];
        attr.needsUpdate = true;
      } else if (u.type === "batch") {
        // Re-show only an instance still exactly as we left it: no other owner wrote its
        // visibility since our hide (a park / atlas hide owns it now), still hidden, same
        // geometry and matrix (not a deleted + reused id). Residual: a write that bypasses
        // setVisibleAt (three internals) or a mesh that cannot be watched (frozen) falls
        // back to the hidden / geometry / matrix checks alone.
        const tok = u.watch || null;
        if (tok) unwatchBatch(u.mesh, u.instanceId, tok);
        if (tok && tok.foreign) return;
        if (typeof u.mesh.getVisibleAt === "function" && u.mesh.getVisibleAt(u.instanceId) !== false) return;
        const was = u.state || { geom: null, m: null };
        const now = batchState(u.mesh, u.instanceId);
        if (was.geom !== null && now.geom !== was.geom) return;
        if (was.m && (!now.m || now.m.some((v, k) => !Object.is(v, was.m[k])))) return;
        u.mesh.setVisibleAt(u.instanceId, true);
      }
    } catch (_) {
      /* a disposed node / deleted instance */
    }
  }

  /**
   * Fade the occluders a setpoint names. Returns how many of `ids` are hidden now
   * by this take (newly or earlier), or deliberately kept (a reveal shot's own
   * occluder / something already hidden by someone else): 0 = the fade did nothing.
   */
  function fade(R, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const live = liveOf();
    const em = live && live.entityManager;
    let handled = 0;
    for (const id of ids) {
      if (typeof id === "number" && Number.isFinite(id) && id > 0) {
        const guid = id >>> 0;
        if (guid === plan.subjectGuid || R.subjectBody.includes(guid)) continue;
        if (R.fades.entities.includes(guid)) {
          handled += 1;
          continue;
        }
        if (!em || typeof em.setFilmHidden !== "function") continue;
        const was = em._filmHiddenGuids instanceof Set ? em._filmHiddenGuids.has(guid) : false;
        if (was) {
          handled += 1;
          continue;
        }
        try {
          em.setFilmHidden(guid, true);
          R.fades.entities.push(guid);
          handled += 1;
        } catch (_) {
          /* a rig that cannot be hidden stays */
        }
      } else if (isStaticFadeKey(id)) {
        if (R.subjectBody.includes(id)) continue;
        if (R.fades.statics.some((f) => f.key === id)) {
          handled += 1;
          continue;
        }
        const wq = d.worldQuery;
        if (!wq || typeof wq.staticFadeTargets !== "function") continue;
        const retryAt = R.fadeMisses.get(id);
        if (retryAt !== undefined && R.rows.length < retryAt) continue;
        let res = null;
        try {
          res = wq.staticFadeTargets(id);
        } catch (_) {
          res = null;
        }
        if (res && Array.isArray(res.targets) && revealProtected(res.pos)) {
          handled += 1;
          continue;
        }
        const undo = [];
        for (const tg of res && Array.isArray(res.targets) ? res.targets : []) {
          let u = null;
          try {
            u = hideStatic(tg);
          } catch (_) {
            u = null;
          }
          if (u) undo.push(u);
        }
        if (undo.length === 0) {
          R.fadeMisses.set(id, R.rows.length + TAKE_DEFAULTS.fadeRetryFrames);
          continue;
        }
        R.fadeMisses.delete(id);
        R.fades.statics.push({ key: id, undo: undo.filter((u) => u.type !== "noop") });
        handled += 1;
      } else if (typeof id === "string" && id) {
        if (R.fades.particles.some((f) => f.key === id)) {
          handled += 1;
          continue;
        }
        const pq = particlesOf();
        if (!pq || typeof pq.snapshot !== "function") continue;
        let rows = [];
        try {
          rows = pq.snapshot() || [];
        } catch (_) {
          rows = [];
        }
        const row = rows.find((r) => r && r.key === id && r.emitter && typeof r.emitter === "object");
        if (!row) continue;
        const em2 = row.emitter;
        if (em2.filmHidden === true) {
          // Already hidden by its other owner (the safety lens): it is hidden, and taking
          // it over would record that owner's value as "previous" (one owner per emitter).
          handled += 1;
          continue;
        }
        R.fades.particles.push({ key: id, emitter: em2, hadOwn: Object.prototype.hasOwnProperty.call(em2, "filmHidden"), prev: em2.filmHidden });
        em2.filmHidden = true;
        handled += 1;
        // The same frame's safety lens query must see the cloud as hidden (one owner per emitter).
        if (typeof pq.invalidate === "function") {
          try {
            pq.invalidate();
          } catch (_) {
            /* the next frame rebuilds anyway */
          }
        }
      }
    }
    return handled;
  }

  function restoreFades(R) {
    const live = liveOf();
    const em = live && live.entityManager;
    for (const guid of R.fades.entities) {
      try {
        if (em && typeof em.setFilmHidden === "function") em.setFilmHidden(guid, false);
      } catch (_) {
        /* gone */
      }
    }
    for (const f of R.fades.particles) {
      try {
        if (f.hadOwn) f.emitter.filmHidden = f.prev;
        else delete f.emitter.filmHidden;
      } catch (_) {
        /* frozen emitter */
      }
    }
    for (let i = R.fades.statics.length - 1; i >= 0; i -= 1) {
      const undo = R.fades.statics[i].undo;
      for (let j = undo.length - 1; j >= 0; j -= 1) restoreStatic(undo[j]);
    }
    const out = { entities: R.fades.entities.length, particles: R.fades.particles.length, statics: R.fades.statics.length };
    R.fades = { entities: [], particles: [], statics: [] };
    return out;
  }

  // ---- depth of field -------------------------------------------------------

  function dofOf() {
    const dof = win && typeof win === "object" ? win.__dof : null;
    return dof && typeof dof === "object" ? dof : null;
  }

  function dofBegin(R) {
    const dof = dofOf();
    if (!dof) return null;
    const saved = { enabled: !!dof.enabled, focusDistance: Number.isFinite(dof.focusDistance) ? dof.focusDistance : null };
    R.dof.used = true;
    if (plan.hasFocus) {
      try {
        const p0 = R.traj.sample(0);
        if (Number.isFinite(p0.focus) && p0.focus > 0) dof.focusDistance = p0.focus;
        if (!dof.enabled) dof.enabled = true;
        R.dof.enabled = true;
      } catch (e) {
        R.dof.errors += 1;
        emit({ level: "warn", message: `__dof enable failed: ${e && e.message ? e.message : e}` });
      }
    }
    return saved;
  }

  function dofFrame(R, pose) {
    const dof = dofOf();
    if (!dof || !(Number.isFinite(pose.focus) && pose.focus > 0)) return;
    try {
      dof.focusDistance = pose.focus;
      R.dof.writes += 1;
    } catch (_) {
      R.dof.errors += 1;
    }
  }

  function dofEnd(saved) {
    const dof = dofOf();
    if (!dof || !saved) return;
    try {
      if (saved.focusDistance !== null && dof.focusDistance !== saved.focusDistance) dof.focusDistance = saved.focusDistance;
    } catch (_) {
      /* a value the seam no longer accepts */
    }
    try {
      if (!!dof.enabled !== saved.enabled) dof.enabled = saved.enabled;
    } catch (_) {
      /* cosmetic */
    }
  }

  // ---- particle cull ----------------------------------------------------------

  /**
   * A rendered take re-runs the RP6 particle cull every tick (recheckInterval 1)
   * against the film camera, so no emitter stays culled after a cut / whip pan;
   * the previous interval is restored by cullEnd. A dry (unrendered) run leaves it.
   */
  function cullBegin(R) {
    if (!particleCull || !R.render) return;
    const want = TAKE_DEFAULTS.particleRecheckInterval;
    try {
      const prev = particleCull.setParticleCullConfig({ recheckInterval: want });
      const previous = prev && Number.isInteger(prev.recheckInterval) && prev.recheckInterval >= 1 ? prev.recheckInterval : null;
      R.cull = { applied: want, previous, restored: false };
    } catch (e) {
      emit({ level: "warn", message: `setParticleCullConfig failed: ${e && e.message ? e.message : e}` });
    }
  }

  /** Put back the recheckInterval cullBegin replaced (only that field: maxDistance is never ours). */
  function cullEnd(R) {
    const c = R.cull;
    if (!c || c.previous === null || !particleCull) return;
    try {
      particleCull.setParticleCullConfig({ recheckInterval: c.previous });
      c.restored = true;
    } catch (e) {
      emit({ level: "warn", message: `restoring the particle recheckInterval failed: ${e && e.message ? e.message : e}` });
    }
  }

  // ---- pop-in signature -----------------------------------------------------

  function sceneSignature() {
    const live = liveOf();
    if (!live) return null;
    const t = live.terrainBakedLbs && typeof live.terrainBakedLbs.size === "number" ? live.terrainBakedLbs.size : -1;
    const s = live.staticsGroup && Array.isArray(live.staticsGroup.children) ? live.staticsGroup.children.length : -1;
    const c = live.cellContainers3d && typeof live.cellContainers3d.size === "number" ? live.cellContainers3d.size : -1;
    return t < 0 && s < 0 && c < 0 ? null : `${t}|${s}|${c}`;
  }

  // ---- the frame ------------------------------------------------------------

  /**
   * Central-difference velocity / acceleration of `posAt(progress)` at p (one-sided at the ends),
   * scaled by the progress rate; null when posAt has no position there.
   */
  function derivsOf(R, posAt, p, speed) {
    const D = R.D;
    const h = Math.min(0.5 / R.fps, 0.01);
    let a = p - h, b = p + h;
    if (a < 0) {
      b -= a;
      a = 0;
    }
    if (b > D) {
      a = Math.max(0, a - (b - D));
      b = D;
    }
    const w = b - a;
    if (!(w > 1e-9)) return { vel: [0, 0, 0], acc: [0, 0, 0] };
    const pa = posAt(a), pm = posAt((a + b) / 2), pb = posAt(b);
    if (!pa || !pm || !pb) return null;
    const hh = w / 2;
    const s2 = speed * speed;
    return {
      vel: [((pb[0] - pa[0]) / w) * speed, ((pb[1] - pa[1]) / w) * speed, ((pb[2] - pa[2]) / w) * speed],
      acc: [((pb[0] - 2 * pm[0] + pa[0]) / (hh * hh)) * s2, ((pb[1] - 2 * pm[1] + pa[1]) / (hh * hh)) * s2, ((pb[2] - 2 * pm[2] + pa[2]) / (hh * hh)) * s2],
    };
  }

  /** Drone feed-forward: path velocity / acceleration at progress p, scaled by the progress rate. */
  function derivs(R, p, speed) {
    return derivsOf(R, (t) => R.traj.sample(t).pos, p, speed);
  }

  /** The drone feed-forward of frame pose at progress p: the nominal's, or a re-anchored carry rig's (liveDerivs). */
  function feedForward(R, p, speed) {
    const dv = derivs(R, p, speed);
    return R.live ? liveDerivs(R, p, speed, dv) : dv;
  }

  function cutBetween(R, p0, p1) {
    const cuts = R.traj.meta && Array.isArray(R.traj.meta.cuts) ? R.traj.meta.cuts : [];
    return cuts.some((c) => Number.isFinite(c) && c > p0 + 1e-9 && c <= p1 + 1e-9);
  }

  function writePose(R, pose) {
    if (cam.write(pose) === true) return;
    if (typeof cam.own === "function" && cam.owned !== true) {
      try {
        cam.own();
      } catch (e) {
        throw new FilmError(`the film camera is not owned and own() failed: ${e && e.message ? e.message : e}`, "FILM_CAMERA_UNAVAILABLE");
      }
      if (cam.write(pose) === true) return;
    }
    throw new FilmError(`camera_owner.write rejected the pose at t=${pose.t} (not owned or non-finite)`, "FILM_CAMERA_WRITE");
  }

  function safetyCtx(R, pose, cut) {
    const cell = typeof cam.viewerCell === "function" ? cam.viewerCell() : 0;
    const ctx = { fovDeg: pose.fov, aspect: plan.aspect, cut: cut === true, ignoreGuid: 0 };
    if (Number.isFinite(cell) && cell !== 0) ctx.cell = cell;
    if (plan.indoor) ctx.indoor = true;
    return ctx;
  }

  /**
   * The start pose (pre-roll): nominal t = 0 (locked: the table's first row), the
   * craft reset there. With a live subject it is re-anchored to where the subject
   * is now (recomputed every pre-roll frame, `dt` after the previous one).
   */
  function startPose(R, dt) {
    let p0 = R.traj.sample(0);
    if (R.live) {
      liveUpdate(R, 0, dt, "settle");
      p0 = liveApply(R, p0, 0);
    }
    let pose = { ...p0, pos: p0.pos.slice(), q: p0.q.slice(), t: 0 };
    if (R.drone) {
      const dv = feedForward(R, 0, 1);
      pose = { ...R.drone.reset({ ...p0, t: 0 }, { velocity: dv.vel, acceleration: dv.acc }), t: 0 };
    }
    return pose;
  }

  function preRollStep(R, i, pose0, dt) {
    const prev = i === 0 ? (typeof cam.currentPose === "function" ? cam.currentPose() : null) : R.prevPose;
    const res = safety.clamp(prev, pose0, safetyCtx(R, pose0, i === 0));
    const pose = res && res.pose ? { ...res.pose, t: 0 } : { ...pose0, t: 0 };
    dofFrame(R, pose);
    writePose(R, pose);
    R.prevPose = pose;
    if (sensors) {
      try {
        const subj = subjectAt(0);
        sensors.sense({ ...pose }, {
          subject: subj ? { ...subj, guid: subj.guid || plan.subjectGuid || 0 } : null,
          framing: plan.framing,
          aspect: plan.aspect,
          indoor: plan.indoor,
          nominalAhead: aheadPoints(R, 0, 0),
          subjectBodyIds: R.subjectBody,
        }, i === 0 ? 0 : dt);
      } catch (_) {
        /* warm-up only */
      }
    }
  }

  /**
   * Advance the take to frame k with the progress rate the pilot set on the
   * previous frame (a setpoint governs the interval until the next frame).
   * Progress is counted in frames (exact integers at speed 1). Returns
   * `{done, p0, p}`: done when the progress reached the end, or at the cap —
   * stepped takes cap the FRAME count (frames are film time), realtime takes
   * cap the WALL time (display frames follow the display rate; the recorded
   * frames follow the film grid up to `R.endT`, the interpolated wall time of
   * the end); locked realtime replays end when wall time reaches the table's
   * duration.
   */
  function advance(R, k, t, dt) {
    const p0 = Math.min(R.D, R.progressFrames / R.fps);
    if (R.mode === "realtime") {
      if (k > 0) {
        const before = R.progressFrames;
        const tPrev = Math.max(0, t - dt);
        if (!R.locked) R.progressFrames += R.speedScale * dt * R.fps;
        const reached = R.locked ? t >= R.D - 1e-9 : R.progressFrames >= R.D * R.fps - 1e-6;
        if (reached) {
          // The wall time inside (t − dt, t] at which the progress crossed the end: the
          // take's realised duration, which sets its grid length (⌈endT·fps⌉ frames).
          let tEnd = R.locked ? R.D : t;
          if (!R.locked && R.progressFrames > before) tEnd = tPrev + ((R.D * R.fps - before) / (R.progressFrames - before)) * (t - tPrev);
          R.endT = clamp(tEnd, tPrev, t);
          return { done: true, p0, p: R.D };
        }
        const capT = R.D * (1 + R.maxOverrun);
        const wallCap = !R.locked && t >= capT - 1e-9;
        if (wallCap || k >= R.realtimeFrameLimit) {
          R.capped = true;
          R.endT = wallCap ? clamp(capT, tPrev, t) : t;
          return { done: true, p0, p: p0 };
        }
      }
      return { done: false, p0, p: R.locked ? Math.min(R.D, t) : Math.min(R.D, R.progressFrames / R.fps) };
    }
    if (k > 0 && !R.locked) {
      R.progressFrames += R.speedScale * dt * R.fps;
      if (R.progressFrames >= R.D * R.fps - 1e-6) return { done: true, p0, p: R.D };
    }
    if (k >= R.maxFrames) {
      if (!R.locked) R.capped = true;
      return { done: true, p0, p: p0 };
    }
    const p = R.locked ? Math.min(R.D, t) : Math.min(R.D, R.progressFrames / R.fps);
    return { done: false, p0, p };
  }

  /** Append one realised table row (film time t, the pose drawn), quaternion sign-continuous. */
  function pushRow(R, t, pose) {
    const rr = realisedRow(t, pose, R.prevQ);
    R.prevQ = rr.q;
    R.rows.push(rr.row);
  }

  /**
   * Build, clamp and write frame k's pose (after advance, sensing and the
   * pilot): nominal → drone → residual → safety → camera. The caller records
   * the row (stepped: at t; realtime: once per film-grid point the drawn frame covers).
   * @returns {{pose:object, adjusted:boolean}}
   */
  function poseStep(R, k, t, dt, sp, sf, adv) {
    const p0 = adv.p0;
    const p = adv.p;
    let nominal = R.traj.sample(p);
    if (R.live) {
      // Frame 0 is still p = 0 (the progress starts after it): anchored like the pre-roll, not eased.
      liveUpdate(R, p, dt, k === 0 ? "anchor" : "track");
      nominal = liveApply(R, nominal, p);
    }
    let pose = nominal;
    let cut = false;
    if (R.drone && k > 0) {
      cut = cutBetween(R, p0, p);
      const dv = feedForward(R, p, R.speedScale);
      pose = cut
        ? R.drone.reset({ ...nominal, t }, { velocity: dv.vel, acceleration: dv.acc })
        : R.drone.step({ ...nominal, t, vel: dv.vel, acc: dv.acc }, dt);
    } else if (R.drone && k === 0) {
      if (R.live && R.live.init) {
        // A live subject kept moving since the last pre-roll frame: the craft is re-set on the
        // re-anchored start pose (as every pre-roll frame did), not left a frame behind it.
        const dv = feedForward(R, p, R.speedScale);
        pose = R.drone.reset({ ...nominal, t }, { velocity: dv.vel, acceleration: dv.acc });
        R.droneStart = pose;
      } else {
        pose = R.droneStart || nominal;
      }
    } else if (!R.drone && k > 0) {
      cut = cutBetween(R, p0, p);
    }
    if (R.flown) {
      const g = Math.hypot(pose.pos[0] - nominal.pos[0], pose.pos[1] - nominal.pos[1], pose.pos[2] - nominal.pos[2]);
      if (R.live && R.live.swingAlpha > 0 && R.live.init) {
        // The craft's radial error about the (smoothed) live subject: what a flown swing yields to.
        const ref = plan.refSubjectFn(p);
        if (ref) {
          const cx = ref.pos[0] + R.live.x[0], cy = ref.pos[1] + R.live.x[1];
          const e = Math.hypot(pose.pos[0] - cx, pose.pos[1] - cy) - Math.hypot(nominal.pos[0] - cx, nominal.pos[1] - cy);
          R.live.craftRadM = Number.isFinite(e) ? e : 0;
        }
      }
      if (Number.isFinite(g)) {
        R.flown.frames += 1;
        R.flown.endGapM = g;
        if (g > R.flown.maxGapM) {
          R.flown.maxGapM = g;
          R.flown.maxGapT = t;
        }
      }
    }
    if (R.live && R.drone) pose = liveGimbal(R, pose, nominal, p);
    if (!R.locked) {
      // Fades first: a fade that hides nothing reroutes this frame instead (never a no-op).
      let spr = sp;
      if (Array.isArray(sp.fadeIds) && sp.fadeIds.length && fade(R, sp.fadeIds) === 0 && sp.reroute !== true) {
        spr = { ...sp, reroute: true };
        R.fadeFallbacks += 1;
      }
      updateReroute(R, spr, sf, k === 0 ? 0 : dt);
      const neutral = isNeutral(sp, R.rerouteBias);
      if (!neutral) {
        const subj = subjectAt(p);
        const lateral = fin(sp.lateral, 0) + R.rerouteBias;
        const right = lateral === 0 ? [1, 0, 0] : R.live && R.live.carry && R.live.init ? liveRightVector(R, p, pose) : pathRightVector(R.traj, p, pose);
        pose = applyResidual(pose, sp, {
          right,
          subjectCenter: centerOf(subj),
          bounds: plan.bounds,
          rerouteBias: R.rerouteBias,
        });
      }
    }
    if (cut && typeof cam.setCutCell === "function") cam.setCutCell(plan.cell ?? 0);
    const res = safety.clamp(R.prevPose, pose, safetyCtx(R, pose, cut));
    const adjusted = !!(res && res.adjusted);
    let finalPose = res && res.pose ? res.pose : pose;
    finalPose = { ...finalPose, t };
    if (adjusted) {
      R.safetyAdjusted += 1;
      const hits = Array.isArray(res.hits) ? res.hits : [];
      for (const h of hits) R.safetyLayers[h.layer || "unknown"] = (R.safetyLayers[h.layer || "unknown"] || 0) + 1;
      if (R.safetyEvents.length < TAKE_DEFAULTS.safetyEventLimit) {
        const moved = Math.hypot(finalPose.pos[0] - pose.pos[0], finalPose.pos[1] - pose.pos[1], finalPose.pos[2] - pose.pos[2]);
        R.safetyEvents.push({ frame: k, t, moved, hits: hits.slice(0, 4).map((h) => ({ layer: h.layer ?? null, kind: h.kind ?? null })) });
      }
    }
    dofFrame(R, finalPose);
    writePose(R, finalPose);
    R.prevPose = finalPose;
    if (!R.locked) {
      const maxS = Math.max(1, plan.bounds.maxSpeedScale);
      R.speedScale = clamp(fin(sp.speedScale, 1), 0, maxS);
    }
    return { pose: finalPose, adjusted };
  }

  function noteObstruction(R, sf) {
    const s = sf && sf.subject && typeof sf.subject === "object" ? sf.subject : null;
    if (!s || !Number.isFinite(s.visibleFrac)) return;
    const o = R.obstruction;
    o.measuredFrames += 1;
    o.minVisibleFrac = o.minVisibleFrac === null ? s.visibleFrac : Math.min(o.minVisibleFrac, s.visibleFrac);
    if (s.visibleFrac < TAKE_DEFAULTS.hiddenFrac) o.framesHidden += 1;
    if (s.visibleFrac < TAKE_DEFAULTS.occludedFrac) o.framesOccluded += 1;
    if (Number.isFinite(s.unseenSec)) o.maxUnseenSec = Math.max(o.maxUnseenSec, s.unseenSec);
  }

  function notePopIn(R) {
    const sig = sceneSignature();
    if (sig === null) return;
    if (R.sceneSig !== null && sig !== R.sceneSig) R.popIn += 1;
    R.sceneSig = sig;
  }

  function fireCues(R, t) {
    if (!R.record || typeof d.actor !== "function") return;
    while (R.cueIndex < plan.actorCues.length && plan.actorCues[R.cueIndex].at <= t + 1e-9) {
      const c = plan.actorCues[R.cueIndex];
      R.cueIndex += 1;
      const entry = { at: c.at, firedAt: t, ok: null };
      R.actorResults.push(entry);
      try {
        Promise.resolve(d.actor(c.cue)).then(
          (r) => {
            entry.ok = !!(r && r.ok !== false);
            if (r && r.ok === false && r.error) entry.error = plainCopy(r.error);
          },
          (e) => {
            entry.ok = false;
            entry.error = String(e && e.message ? e.message : e);
          },
        );
      } catch (e) {
        entry.ok = false;
        entry.error = String(e && e.message ? e.message : e);
      }
    }
  }

  // ---- grabbing -------------------------------------------------------------

  function installGrab(R) {
    if (!R.record) return () => {};
    return onPostRender(() => {
      const a = R.armed;
      if (!a) return;
      if (a.ts !== undefined) {
        const live = liveOf();
        const ft = live && live.frameTime && Number.isFinite(live.frameTime.tsMs) ? live.frameTime.tsMs : null;
        if (ft !== null && Number.isFinite(a.ts) && ft !== a.ts) return; // a stale frame, not ours
      }
      R.armed = null;
      if (a.grid === true) {
        // Realtime: this drawn frame is every film-grid point still due (one encode per point).
        const times = commitGrid(R, a.pose, a.upTo);
        if (!times.length) return;
        if (R.recorder.grab(times)) R.grabbed += times.length;
        else R.dropped += times.length;
        return;
      }
      const ok = R.recorder.grab(a.t);
      if (ok) R.grabbed += 1;
      else R.dropped += 1;
    });
  }

  // ---- the realtime film grid -------------------------------------------------

  /** Grid points due at wall time t: every n with n/fps ≤ t (a count, so the next index). */
  function gridDue(R, t) {
    return Math.floor(t * R.fps + TAKE_DEFAULTS.realtimeGridEps) + 1;
  }

  /** The grid points owed so far: recorded, or armed on a frame not drawn yet. */
  function gridOwed(R) {
    return Math.max(R.grid.done, R.armed && R.armed.grid === true ? R.armed.upTo : 0);
  }

  /** Record grid points [done, upTo) as drawn with `pose`: one table row each; their film times. */
  function commitGrid(R, pose, upTo) {
    const times = [];
    for (let n = R.grid.done; n < upTo; n += 1) {
      const tn = n / R.fps;
      times.push(tn);
      pushRow(R, tn, pose);
    }
    R.grid.done = Math.max(R.grid.done, upTo);
    if (times.length > 1) R.grid.held += times.length - 1;
    return times;
  }

  /**
   * After a realtime display frame wrote `pose`: arm the grab of every grid point
   * due by `upTo` that is not recorded yet (the postRender records them from this
   * frame). Nothing new due = a display frame between grid points (not recorded).
   * A previous frame's armed points that were never drawn ride on this frame.
   * Under encoder backpressure nothing is armed and the points stay due (the next
   * drawn frame records them), except on the `final` frame.
   */
  function armGrid(R, pose, upTo, final) {
    const g = R.grid;
    g.display += 1;
    if (R.armed) g.carried += 1;
    if (!(upTo > g.done)) {
      R.armed = null;
      g.skipped += 1;
      return;
    }
    if (!R.record) {
      R.armed = null;
      commitGrid(R, pose, upTo);
      return;
    }
    if (!final && R.recorder && typeof R.recorder.hasCapacity === "function" && !R.recorder.hasCapacity()) {
      R.armed = null;
      g.backpressure += 1;
      return;
    }
    R.armed = { grid: true, upTo, pose };
  }

  // ---- stepped runs ---------------------------------------------------------

  function expectedTs(clock) {
    try {
      const s = typeof clock.stats === "function" ? clock.stats() : null;
      return s && Number.isFinite(s.lastTsMs) ? s.lastTsMs : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function renderStep(R, clock, grabT) {
    if (!R.render) return;
    if (grabT !== null) R.armed = { t: grabT, ts: undefined };
    const pr = clock.step();
    // step() stamps its timestamp before rendering; a synchronous postRender inside
    // step() already saw ts undefined (accepted), an asynchronous one checks it.
    if (R.armed) R.armed.ts = expectedTs(clock);
    await pr;
    if (R.armed) {
      R.armed = null;
      R.dropped += 1;
    }
  }

  async function runStepped(R) {
    const clock = R.render ? clockOf() : null;
    if (R.render && !clock) throw new FilmError("stepped take: no film clock (window.__renderOnce / the index.js seam is missing)", "FILM_RENDER_UNAVAILABLE");
    if (R.render && clock.active) throw new FilmError("stepped take: the film clock is already running", "FILM_BUSY");
    const clockFps = clamp(R.fps, CLOCK_FPS_FLOOR, FILM_CLOCK_MAX_FPS);
    if (R.render) {
      const b = { fps: clockFps, seed: plan.seed };
      if (plan.timeLapse) b.timeLapse = plan.timeLapse;
      clock.begin(b);
    }
    const dt = 1 / R.fps;
    try {
      let pose0 = startPose(R, 0);
      R.droneStart = R.drone ? pose0 : null;
      if (typeof cam.setCutCell === "function") cam.setCutCell(plan.cell ?? 0);
      const pre = preRollFrames(R.fps);
      for (let i = 0; i < pre; i += 1) {
        if (abortRequested) break;
        if (R.live && i > 0) {
          pose0 = startPose(R, dt);
          R.droneStart = R.drone ? pose0 : null;
        }
        preRollStep(R, i, pose0, dt);
        await renderStep(R, clock, null);
      }
      for (let k = 0; ; k += 1) {
        if (abortRequested) {
          R.aborted = true;
          break;
        }
        const t = k / R.fps;
        const adv = advance(R, k, t, dt);
        if (adv.done) break;
        const sf = senseFrame(R, dt);
        R.lastSf = sf;
        let sp = NEUTRAL_SETPOINT;
        if (R.pilot) {
          const out = await R.pilot.tickStepped(sf || {}, pilotCtx(), t);
          sp = setpointOf(out);
          noteTelemetry(R, k, out);
        }
        const res = poseStep(R, k, t, dt, sp, sf, adv);
        pushRow(R, t, res.pose);
        noteObstruction(R, sf);
        if (R.record) {
          notePopIn(R);
          fireCues(R, t);
        }
        await renderStep(R, clock, R.record ? t : null);
        if (R.record && R.recorder) {
          if (R.recorder.state === "failed") {
            throw new FilmError(`the recorder failed: ${(R.recorder.stats().errors || []).slice(-1)[0] || "unknown error"}`, "FILM_RECORDER_FAILED");
          }
          if (typeof R.recorder.waitForCapacity === "function") await R.recorder.waitForCapacity();
        }
      }
    } finally {
      if (R.render && clock && clock.active) {
        try {
          await clock.end();
        } catch (e) {
          emit({ level: "warn", message: `clock.end failed: ${e && e.message ? e.message : e}` });
        }
      }
    }
  }

  // ---- realtime runs --------------------------------------------------------

  function rafOf() {
    if (typeof d.requestAnimationFrame === "function") return d.requestAnimationFrame;
    if (win && typeof win.requestAnimationFrame === "function") return (cb) => win.requestAnimationFrame(cb);
    return null;
  }

  function runRealtime(R) {
    const raf = rafOf();
    if (!raf) return Promise.reject(new FilmError("realtime take: requestAnimationFrame is unavailable", "FILM_RENDER_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const pre = preRollFrames(R.fps);
      let i = 0;
      let k = 0;
      let t0 = null;
      let prevTs = null;
      let pose0 = null;
      let finished = false;
      let watchdog = null;
      const clearWatch = () => {
        if (watchdog !== null && clearT) clearT(watchdog);
        watchdog = null;
      };
      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearWatch();
        if (err) reject(err);
        else resolve();
      };
      const schedule = () => {
        if (finished) return;
        if (setT) {
          clearWatch();
          watchdog = setT(() => finish(new FilmError(`realtime take: no animation frame for ${TAKE_DEFAULTS.realtimeFrameTimeoutMs} ms (is the render loop held?)`, "FILM_FRAME_TIMEOUT")),
            TAKE_DEFAULTS.realtimeFrameTimeoutMs);
        }
        raf(onFrame);
      };
      const onFrame = (ts) => {
        if (finished) return;
        try {
          const now = Number.isFinite(ts) ? ts : (prevTs ?? 0) + 1000 / R.fps;
          const dtw = prevTs === null ? 1 / R.fps : Math.max(0, (now - prevTs) / 1000);
          prevTs = now;
          if (abortRequested) {
            R.aborted = true;
            finish();
            return;
          }
          if (i < pre) {
            if (pose0 === null || R.live) {
              const first = pose0 === null;
              pose0 = startPose(R, first ? 0 : dtw);
              R.droneStart = R.drone ? pose0 : null;
              if (first && typeof cam.setCutCell === "function") cam.setCutCell(plan.cell ?? 0);
            }
            preRollStep(R, i, pose0, dtw);
            i += 1;
            schedule();
            return;
          }
          if (t0 === null) t0 = now;
          const t = (now - t0) / 1000;
          const dt = k === 0 ? 1 / R.fps : dtw;
          const adv = advance(R, k, t, dt);
          if (adv.done) {
            // The take ended at R.endT: its grid holds ⌈endT·fps⌉ frames. The points after the
            // last drawn frame are grabbed from one final frame at the end pose (held setpoint).
            R.grid.end = Math.max(gridOwed(R), takeFrameCount(R.endT, R.fps));
            if (R.grid.end > R.grid.done) {
              const res = poseStep(R, k, t, dt, R.lastSp, R.lastSf, adv);
              R.grid.tail = R.grid.end - gridOwed(R);
              armGrid(R, res.pose, R.grid.end, true);
            }
            finish();
            return;
          }
          const sf = senseFrame(R, dt);
          R.lastSf = sf;
          let sp = NEUTRAL_SETPOINT;
          if (R.pilot) {
            const out = R.pilot.tick(sf || {}, pilotCtx(), t);
            sp = setpointOf(out);
            noteTelemetry(R, k, out);
          }
          R.lastSp = sp;
          const res = poseStep(R, k, t, dt, sp, sf, adv);
          noteObstruction(R, sf);
          if (R.record) {
            notePopIn(R);
            fireCues(R, t);
          }
          armGrid(R, res.pose, gridDue(R, t), false);
          if (R.record && R.recorder && R.recorder.state === "failed") {
            finish(new FilmError("the recorder failed during a realtime take", "FILM_RECORDER_FAILED"));
            return;
          }
          k += 1;
          schedule();
        } catch (e) {
          finish(e);
        }
      };
      schedule();
    }).then(() => (R.record && R.armed ? waitLastGrab(R) : undefined));
  }

  function waitLastGrab(R) {
    return new Promise((resolve) => {
      let timer = null;
      let unsub = null;
      const done = () => {
        if (timer !== null && clearT) clearT(timer);
        if (unsub) unsub();
        if (R.armed) {
          // Never drawn: its grid points are lost (the take ends before them).
          R.dropped += R.armed.grid === true ? Math.max(0, R.armed.upTo - R.grid.done) : 1;
          R.armed = null;
        }
        resolve();
      };
      try {
        unsub = onPostRender(() => {
          if (!R.armed) done();
        });
      } catch (_) {
        unsub = null;
      }
      if (setT) timer = setT(done, TAKE_DEFAULTS.realtimeFinalGrabMs);
      else done();
    });
  }

  // ---- pre-roll AdminEnvirons wait ---------------------------------------------

  /** loop.js's read-only `window.__environOverrideState()`: undefined without it, null when unreadable. */
  function environState() {
    const f = win && typeof win.__environOverrideState === "function" ? win.__environOverrideState : null;
    if (!f) return undefined;
    try {
      const s = f();
      return s && typeof s === "object" ? s : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Re-light the landscape on the next frame, as look.js does after a time jump: loop.js
   * `__setTerrainLightScale(cur)` invalidates the retail light tick (the next one would be up to 15 s away).
   */
  function forceLightTick() {
    try {
      const set = win && typeof win.__setTerrainLightScale === "function" ? win.__setTerrainLightScale : null;
      const get = win && typeof win.__terrainLightState === "function" ? win.__terrainLightState : null;
      if (!set || !get) return false;
      const s = get();
      if (!s || !Number.isFinite(s.scale)) return false;
      set(s.scale);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** `?environRetail=off|0|false` (environ_override.js environRetailEnabled): the fog snaps on, nothing rolls in. */
  function environRetailOff() {
    try {
      const search = win && win.location && typeof win.location.search === "string" ? win.location.search : "";
      const v = new URLSearchParams(search).get("environRetail");
      return v === "off" || v === "0" || v === "false";
    } catch (_) {
      return false;
    }
  }

  /**
   * True when the override state already reflects `window.__environFogOverride`: loop.js adopts a new
   * message only on its next frame, so right after a look change the state still shows the previous one.
   */
  function environSynced(s) {
    const want = win ? win.__environFogOverride : null;
    const wantActive = !!(want && typeof want === "object" && Number.isFinite(want.fogRgb));
    if (!wantActive) return s.active !== true;
    return s.active === true && (s.option ?? null) === (want.option ?? null);
  }

  /** JSON-safe digest of an override state for the take report. */
  function environDigest(s) {
    if (!s) return null;
    const n = (v) => (Number.isFinite(+v) ? +v : null);
    return {
      active: s.active === true,
      option: s.option ?? null,
      name: s.name ?? null,
      transition: n(s.transition),
      fogT: n(s.fogT),
      lightT: n(s.lightT),
      sets: n(s.sets),
    };
  }

  /**
   * Hold a rendered take before its recorder / film clock start until the AdminEnvirons override has
   * settled (see the header): active → `transition ≥ 1` and the fog's latched `fogT ≥ 1`, then a light
   * tick AFTER that (forced) latches `lightT ≥ 1` — unless this override (`sets`) was already confirmed;
   * cleared → `lightT` 0 (no override ambient latched). The live loop keeps running meanwhile. Bounded
   * by TAKE_DEFAULTS.environSettleMaxMs, stopped early when the state stops moving (`stalled`) or on
   * abort(). Never throws.
   * @returns {Promise<{checked:boolean, settled:boolean|null, waitedMs:number, polls:number, relit:boolean,
   *   timedOut:boolean, stalled:boolean, aborted:boolean, reason:string|null, state:object|null}>}
   */
  async function waitEnvironSettled(R) {
    const out = { checked: false, settled: null, waitedMs: 0, polls: 0, relit: false, timedOut: false, stalled: false, aborted: false, reason: null, state: null };
    if (!R.render) {
      out.reason = "not rendered";
      return out;
    }
    if (environRetailOff()) {
      out.reason = "?environRetail=off (the fog snaps on; nothing rolls in)";
      return out;
    }
    let s = environState();
    if (s === undefined || s === null) {
      out.reason = s === undefined ? "no window.__environOverrideState" : "window.__environOverrideState() is unreadable";
      return out;
    }
    out.checked = true;
    const maxMs = TAKE_DEFAULTS.environSettleMaxMs;
    const t0 = nowMs();
    let lightMark = null;
    let markSets;
    let relightTried = false;
    let sig = null;
    let sigAt = t0;
    for (;;) {
      out.polls += 1;
      const active = s.active === true;
      // Not yet adopted by the loop (a look change this frame): the state is the previous message's.
      const synced = environSynced(s);
      const fogFull = synced && (!active || (s.transition >= 1 && s.fogT >= 1));
      const sets = Number.isFinite(s.sets) ? s.sets : null;
      if (sets !== markSets) {
        // A new message (a server fog mid-wait): its ambient needs its own light tick after it is full.
        markSets = sets;
        lightMark = null;
        relightTried = false;
      }
      const known = sets !== null && sets === environSettledSets;
      const lit = !Number.isFinite(s.lightTicks) || (lightMark !== null && s.lightTicks > lightMark);
      const ambOk = active ? s.lightT >= 1 && (known || lit) : !(s.lightT > 0);
      if (fogFull && ambOk) {
        out.settled = true;
        environSettledSets = sets;
        break;
      }
      if (fogFull) {
        if (active && lightMark === null) lightMark = Number.isFinite(s.lightTicks) ? s.lightTicks : -Infinity;
        if (!relightTried) {
          relightTried = true;
          out.relit = forceLightTick();
        }
      }
      if (abortRequested) {
        out.aborted = true;
        break;
      }
      const now = nowMs();
      const waited = now - t0;
      if (!(waited < maxMs)) {
        out.timedOut = true;
        break;
      }
      const k = [s.sets, s.transition, s.fogT, s.lightT, s.fogTicks, s.lightTicks].join("|");
      if (k !== sig) {
        sig = k;
        sigAt = now;
      } else if (now - sigAt >= TAKE_DEFAULTS.environSettleStallMs) {
        out.stalled = true;
        break;
      }
      if (!setT) {
        out.reason = "no setTimeout to wait with";
        break;
      }
      await new Promise((resolve) => setT(resolve, Math.max(1, Math.min(TAKE_DEFAULTS.environSettlePollMs, maxMs - waited))));
      const next = environState();
      if (!next) {
        out.reason = "window.__environOverrideState() went away";
        break;
      }
      s = next;
    }
    out.waitedMs = Math.max(0, nowMs() - t0);
    if (out.settled === null) out.settled = false;
    out.state = environDigest(s);
    if (!out.settled) {
      const why = out.timedOut ? `after ${Math.round(out.waitedMs)} ms (the bound)` : out.stalled ? "(the override state stopped moving)" : out.aborted ? "(aborted)" : `(${out.reason})`;
      emit({ level: "warn", message: `the AdminEnvirons fog had not settled ${why}; recording anyway`, environ: out.state });
    }
    return out;
  }

  // ---- run wrapper ------------------------------------------------------------

  async function execute(mode, opts) {
    if (!plan) throw new FilmError("no take prepared: call prepare(take) first", "FILM_NOT_PREPARED");
    if (run) throw new FilmError("a take is already running", "FILM_BUSY");
    const R = newRun(mode, opts);
    run = R;
    abortRequested = false;
    if (cam.owned !== true && typeof cam.own === "function") {
      try {
        cam.own();
      } catch (e) {
        run = null;
        throw new FilmError(`the film camera is unavailable: ${e && e.message ? e.message : e}`, "FILM_CAMERA_UNAVAILABLE");
      }
    }
    if (sensors && typeof sensors.reset === "function") sensors.reset();
    if (typeof safety.reset === "function") safety.reset();
    let dofSaved = null;
    let unsubGrab = () => {};
    let error = null;
    let recStats = null;
    let fades = { entities: 0, particles: 0, statics: 0 };
    try {
      // Pre-roll wait: the AdminEnvirons fog roll-in settles on the LIVE loop, before the recorder
      // starts and before a stepped take's film clock holds the loop (both modes, rehearse and shoot).
      R.environ = await waitEnvironSettled(R);
      if (R.record) {
        const rec = typeof d.recorder === "function"
          ? d.recorder({ fps: R.fps, width: opts.width ?? plan.width, height: opts.height ?? plan.height, codec: opts.codec, bitrate: opts.bitrate, keyIntervalSec: opts.keyIntervalSec })
          : d.recorder;
        if (!rec || typeof rec.grab !== "function") throw new FilmError("shoot: no recorder", "FILM_NO_RECORDER");
        R.recorder = rec;
        recorderRef = rec;
        if (rec.state === "idle" || rec.state === undefined) await rec.start();
        unsubGrab = installGrab(R);
      }
      dofSaved = dofBegin(R);
      cullBegin(R);
      if (mode === "realtime") await runRealtime(R);
      else await runStepped(R);
    } catch (e) {
      error = e;
    } finally {
      try {
        unsubGrab();
      } catch (_) {
        /* already gone */
      }
      cullEnd(R);
      dofEnd(dofSaved);
      // Undo in reverse order of application: the reflex's lens hides (applied after the
      // pilot's fades every frame) first, then the fades — so an emitter both touched is
      // left with its pre-take value, never the other restorer's stale one.
      try {
        if (typeof safety.release === "function") safety.release();
      } catch (_) {
        /* reflex cleanup is best effort */
      }
      fades = restoreFades(R);
      if (R.recorder) {
        try {
          recStats = error ? R.recorder.abort(error) : await R.recorder.stop();
        } catch (e) {
          recStats = typeof R.recorder.stats === "function" ? R.recorder.stats() : null;
          if (!error) error = e;
        }
      }
      run = null;
    }
    const report = buildReport(R, recStats, fades);
    if (error) {
      const fe = error instanceof FilmError ? error : new FilmError(String(error && error.message ? error.message : error), { code: "FILM_TAKE_FAILED", cause: error });
      if (fe.details === undefined) fe.details = { partial: strip(report, () => ({})) };
      throw fe;
    }
    return report;
  }

  function buildReport(R, recStats, fades) {
    const frames = R.rows.length;
    const flat = new Float64Array(frames * TABLE_STRIDE);
    R.rows.forEach((row, i) => {
      for (let c = 0; c < TABLE_STRIDE; c += 1) flat[i * TABLE_STRIDE + c] = row[c];
    });
    const checksum = frames > 0 ? tableChecksum(flat) : null;
    const table = frames > 0
      ? {
        fps: R.fps,
        frames,
        rows: Array.from(flat),
        duration: R.rows[frames - 1][0],
        id: `${R.traj.id || plan.technique}@realised`,
        technique: plan.technique,
        family: plan.family,
        bounds: { ...plan.bounds },
        meta: {
          // frames × 1/fps: stepped frames are film time, realtime frames sit on the same grid.
          takeDuration: frames / R.fps,
          mode: R.mode,
          locked: R.locked,
          shotId: plan.shotId,
          nominalChecksum: plan.nominalChecksum,
          realised: true,
        },
        checksum,
      }
      : null;
    if (table) lastTable = table;
    const ps = R.pilot && typeof R.pilot.stats === "function" ? safeCall(() => R.pilot.stats()) : null;
    const o = R.obstruction;
    const report = {
      ok: true,
      shotId: plan.shotId,
      technique: plan.technique,
      family: plan.family,
      mode: R.mode,
      locked: R.locked,
      fps: R.fps,
      frames,
      durationSec: frames / R.fps,
      plannedFrames: R.Nnom,
      overrunFrames: Math.max(0, frames - R.Nnom),
      preRollFrames: preRollFrames(R.fps),
      progressReached: R.locked ? 1 : (R.D > 0 ? Math.min(1, R.progressFrames / (R.D * R.fps)) : 1),
      capped: R.capped,
      aborted: R.aborted,
      realisedChecksum: checksum,
      nominalChecksum: plan.nominalChecksum,
      pilot: {
        mode: R.locked ? "off" : (ps && ps.mode) || plan.pilotMode,
        decisions: R.newDecisions,
        sources: ps && ps.sources ? { ...ps.sources } : { jev: 0, code: 0, reuse: 0, none: 0 },
        agreement: ps && ps.agreement ? plainCopy(ps.agreement) : null,
        consults: ps ? ps.consults ?? 0 : 0,
        errors: ps ? ps.errors ?? 0 : 0,
        fallbacks: ps ? ps.fallbacks ?? 0 : 0,
        costUsd: ps ? ps.costUsd ?? 0 : 0,
        telemetryRows: R.telemetry.length,
        telemetryDropped: R.telemetryDropped,
      },
      safety: {
        adjustedFrames: R.safetyAdjusted,
        layerHits: { ...R.safetyLayers },
        events: R.safetyEvents.length,
      },
      obstruction: {
        minVisibleFrac: o.minVisibleFrac,
        framesHidden: o.framesHidden,
        framesOccluded: o.framesOccluded,
        maxUnseenSec: o.maxUnseenSec,
        measuredFrames: o.measuredFrames,
      },
      subjectMinVisibleFrac: o.minVisibleFrac,
      subjectMaxUnseenSec: o.maxUnseenSec,
      droppedFrames: R.dropped,
      grabbedFrames: R.grabbed,
      // Realtime: how the display frames mapped onto the film grid (frames = grid points recorded).
      realtime: R.mode === "realtime"
        ? {
          wallSec: Number.isFinite(R.endT) ? R.endT : null,
          gridFrames: R.grid.end ?? R.grid.done,
          displayFrames: R.grid.display,
          heldFrames: R.grid.held,
          skippedDisplayFrames: R.grid.skipped,
          undrawnDisplayFrames: R.grid.carried,
          backpressureFrames: R.grid.backpressure,
          tailFrames: R.grid.tail,
        }
        : null,
      particleCull: R.cull ? { recheckInterval: R.cull.applied, previous: R.cull.previous, restored: R.cull.restored } : null,
      // The pre-roll AdminEnvirons fog wait (look.fog / a server fog): settled before recording, or why not.
      environ: R.environ ? plainCopy(R.environ) : null,
      popInEvents: R.popIn,
      reveal: plan.reveal,
      dof: { ...R.dof },
      faded: { ...fades, fallbackFrames: R.fadeFallbacks },
      // The point subject's own body (guids / placement keys): seen as the subject, never faded.
      subjectBody: R.subjectBody.slice(),
      // The prepare-time checks travel with every take report (rehearse, shoot, a failed take's
      // partial): the nominal's validation (issues incl. 'overspeed' with minDurationSec) and the
      // drone / fpv flight check, plus how far the craft really trailed the nominal this run.
      validation: plan.validation ? plainCopy(plan.validation) : null,
      flight: flightReport(R),
      liveSubject: liveReport(R),
      actor: R.actorResults.map((a) => ({ ...a })),
      recorder: recStats ? plainCopy(recStats) : null,
    };
    report._table = table;
    report._telemetry = R.telemetry;
    report._safetyEvents = R.safetyEvents;
    return report;
  }

  /**
   * The take report's `flight`: the prepare-time check (`{preset, vmax, peakSpeed, …, overspeed,
   * minDurationSec}`, null for classic shots and replayed tables) with the realised tracking of a
   * flown run (`tracking: {frames, maxGapM, maxGapT, endGapM}` = the craft's distance from its
   * nominal; null when nothing flew, e.g. a locked replay).
   */
  function flightReport(R) {
    if (!plan.flightCheck && !R.flown) return null;
    const out = plan.flightCheck ? plainCopy(plan.flightCheck) : { preset: null, overspeed: null };
    out.tracking = R.flown ? { ...R.flown } : null;
    return out;
  }

  function strip(report, extra) {
    const { _table, _telemetry, _safetyEvents, ...rest } = report;
    return { ...rest, ...extra(_table, _telemetry, _safetyEvents) };
  }

  async function rehearse(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    const report = await execute("stepped", { fps: o.fps, render: o.render !== false, record: false, locked: o.locked === true, maxOverrun: o.maxOverrun });
    const out = strip(report, (table, telemetry, events) => ({
      realisedTable: table,
      checksum: report.realisedChecksum,
      pilotTelemetry: telemetry.slice(),
      safetyEvents: events.slice(),
      rendered: o.render !== false,
    }));
    lastSummary = { ...(lastSummary || {}), lastRun: { kind: "rehearse", frames: out.frames, checksum: out.checksum } };
    return out;
  }

  async function shoot(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    if (!plan) throw new FilmError("no take prepared: call prepare(take) first", "FILM_NOT_PREPARED");
    const mode = o.mode === "realtime" || o.mode === "stepped" ? o.mode : plan.captureMode;
    if (o.mode !== undefined && o.mode !== null && !TAKE_CAPTURE_MODES.includes(o.mode)) {
      throw new FilmError(`shoot: mode must be 'stepped' or 'realtime' (got ${JSON.stringify(o.mode)})`, "BAD_ARGUMENT");
    }
    const report = await execute(mode, {
      fps: o.fps, width: o.width, height: o.height, codec: o.codec, bitrate: o.bitrate, keyIntervalSec: o.keyIntervalSec,
      locked: o.locked === true, record: true, render: true, maxOverrun: o.maxOverrun,
    });
    const out = strip(report, (table) => (o.includeTable === true ? { realisedTable: table } : {}));
    lastSummary = { ...(lastSummary || {}), lastRun: { kind: "shoot", frames: out.frames, checksum: out.realisedChecksum } };
    return out;
  }

  function abort() {
    const was = !!run;
    if (run) abortRequested = true;
    return { ok: true, wasRunning: was };
  }

  function status() {
    return {
      prepared: plan ? summary() : null,
      running: run ? { mode: run.mode, locked: run.locked, record: run.record, frames: run.rows.length, progress: run.D > 0 ? run.progressFrames / (run.D * run.fps) : 0 } : null,
      lastRun: lastSummary && lastSummary.lastRun ? { ...lastSummary.lastRun } : null,
      hasRealisedTable: !!lastTable,
      recorder: recorderRef && typeof recorderRef.stats === "function" ? safeCall(() => recorderRef.stats()) : null,
    };
  }

  return {
    prepare,
    rehearse,
    shoot,
    abort,
    status,
    currentRecorder: () => recorderRef,
    lastRealisedTable: () => lastTable,
    get running() {
      return !!run;
    },
    get prepared() {
      return !!plan;
    },
  };
}

/** Call fn, returning null if it throws. */
function safeCall(fn) {
  try {
    return fn();
  } catch (_) {
    return null;
  }
}
