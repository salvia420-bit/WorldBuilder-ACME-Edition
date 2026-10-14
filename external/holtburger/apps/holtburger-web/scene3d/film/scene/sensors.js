// scene3d/film/scene/sensors.js — the film camera's perception: geometry → SensorFrame (SPEC §3.1).
//
// WHY: the JEV pilot (System One) judges words, not geometry, and the code
// policy / mapper / safety reflex need the same facts as numbers. This module
// turns the live scene around the film camera into ONE SensorFrame per
// perception tick — "how far can I fly ahead-left before I touch something,
// and what is it", "is there room above if I climb", "when does the planned
// path hit something", "how much of the subject can I see, and what hides it",
// "is there smoke on the lens" — exactly the inputs pilot/scene_state.js
// buckets into words (pilot/sense_words.js WORD_BOUNDS).
//
// Probes (each = ONE `los(sh, from, to, opts)` segment sweep through every
// collision layer, scene/los.js segmentBlocked):
//   * sectors — 5 horizontal rays across ±40° of the SENSING heading (sector
//     centres −32, −16, 0, +16, +32°), radius 0.25 m, length rangeM (25 m);
//   * freeAhead — vertical bands ahead: level (sphere r 0.75 at eye height =
//     ±0.75 m), above (origin +1.5 m, r 0.7 = 0.8–2.2 m above), below (−1.5 m);
//   * sides — left / right / up / down / back clearances;
//   * pathAhead — the planned path for the next ~2 s (`ctx.nominalAhead`, ≤ 3
//     chords, the first starting at the actual eye) or the velocity
//     extrapolation → time to contact + blocker kind;
//   * subject — a 5-ray fan (centre / top / bottom / left / right of the
//     subject body) with the subject's guid excluded (missile_guid), a hit near
//     the subject itself counting as visible → visibleFrac + an unseen timer;
//     occluding particle clouds on the centre ray (particles_query) thin it further.
//     `occluderIds` = what the pilot may fade: rig guids, particle keys and the
//     fade keys of placed tree / prop statics (world_query describeHit `fadeKey`); a
//     ray stopped by an occluder the runtime already faded (`ctx.fadedIds`) sees
//     the subject. A SCENERY (procedural collider) hit never carries an id (v1:
//     CollisionHit names no placement — world_query FADEABLE_STATIC_SOURCES), so it
//     is never in occluderIds and never seen through, whatever is in fadedIds.
// Indoors (`ctx.indoor`) every probe also sweeps the EnvCell layers: `ctx.cellIds`,
// else world_query `renderSetCells(sh)` (the viewer cell's depth-1 render set, the
// list the safety reflex sweeps), read once per sense().
// The SENSING heading is the horizontal travel direction while the camera moves
// (hysteresis: enter ≥ 0.6 m/s, leave < 0.3 m/s), else the camera heading —
// well-defined even looking straight down (heading is never derived from a
// vertical forward vector), so "ahead / left / right" match the pilot's path
// frame (drift_left = left of the travel direction).
//
// Budget: at most `budget.sweepsPerFrame` (16) los calls per sense(); probes run
// ROUND-ROBIN from a cursor, so a full refresh takes ~2 frames. Every value
// carries an age (seconds on the sensor clock since its probe last ran; Infinity
// = never measured); between refreshes ranges are motion-compensated (range −
// camera displacement along the probe direction). Ranges are metres from the
// probe origin to the obstacle surface; Infinity = nothing within rangeM.
// Kinds come from the hit layer (los.js kindForLayer), refined by world_query
// `describeHit` (a tree / rock / creature / player / door near the hit point).
// The shot's own subject (by guid) is excluded from the clearance probes as well
// (ctx.subjectIsObstacle opts back in): a follow / dolly-in approaches it on purpose.
// Terrain directly BELOW the camera is not an "obstacle" for `nearest` unless
// the camera is descending (a terrain-skim would otherwise always read
// "touching terrain" and back off); it still sets sides.down / limits.canSink.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page adapter: world query, session
// handle, los and particle query are injected; no window/document/three/wasm
// imports. Deterministic: time = the sum of the dt values passed in.

import { normalizeLayerName, segmentBlocked as defaultLos } from "./los.js";
import { FADEABLE_STATIC_SOURCES, parseStaticFadeKey, renderSetCells } from "./world_query.js";
import { framingScale } from "./solver.js";
import { hprFromQuat } from "../core/gimbal.js";
import { qToBasis } from "../core/quat.js";
import { aimPointForFraming, framingFactor, normalizeSubject, poseQuat, projectToNdc } from "../shots/framing.js";

/** Default sensing range (m): ranges beyond it read Infinity. */
export const SENSOR_RANGE_M = 25;

/** Default los calls per sense() (SPEC §3: ≤ 16 sweeps per frame). */
export const SENSOR_DEFAULT_BUDGET = 16;

/** Forward sector names, left to right. */
export const SECTOR_NAMES = Object.freeze(["far_left", "left", "center", "right", "far_right"]);

/** Sector centre bearings (degrees, + = right of the sensing heading). */
export const SECTOR_CENTRES_DEG = Object.freeze([-32, -16, 0, 16, 32]);

/** Side clearance names. */
export const SIDE_NAMES = Object.freeze(["left", "right", "up", "down", "back"]);

/** Probe geometry and policy constants (metres / seconds / m·s⁻¹). */
export const SENSOR_GEOMETRY = Object.freeze({
  probeRadius: 0.25,
  levelBandRadius: 0.75,
  bandOffset: 1.5,
  bandRadius: 0.7,
  canRiseMin: 2.0,
  canSinkMin: 2.0,
  roomMargin: 0.75,
  travelEnterMps: 0.6,
  travelExitMps: 0.3,
  aheadSec: 2,
  maxPathChords: 3,
  subjectRayRadius: 0.05,
  subjectSelfPad: 0.3,
  cutDistance: 20,
  lensRadius: 2,
  particleOcclusion: 0.6,
  descendingMps: 0.3,
  maxInView: 6,
  velocityTau: 0.25,
});

/** Canonical round-robin order of the probe jobs (important probes spread through the cycle). */
export const PROBE_ORDER = Object.freeze([
  "sector.center", "path", "band.level", "sector.left", "sector.right", "subject.0",
  "side.left", "side.right", "sector.far_left", "sector.far_right", "band.above", "band.below",
  "subject.1", "side.up", "side.down", "side.back", "subject.2", "subject.3", "subject.4",
]);

const G = SENSOR_GEOMETRY;
const DEG = Math.PI / 180;

/** `[x,y,z]` from an array-like / `{x,y,z}`; null unless finite. */
function vec(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

const addS = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Horizontal unit direction of a compass bearing (clockwise from north).
 * @param {number} h radians
 * @returns {number[]}
 */
export function compassDir(h) {
  return [Math.sin(h), Math.cos(h), 0];
}

/** A slot `{range, kind}` with nothing sensed. */
function clearSlot() {
  return { range: Infinity, kind: null };
}

/**
 * A SensorFrame with nothing measured (every range Infinity, every age Infinity,
 * no subject) — what sense() returns for an unusable pose, and a safe default
 * for the runtime before the first tick.
 * @param {object|null} [pose]
 * @returns {object}
 */
export function emptySensorFrame(pose = null) {
  const sectors = {};
  for (const k of SECTOR_NAMES) sectors[k] = clearSlot();
  const sides = {};
  for (const k of SIDE_NAMES) sides[k] = clearSlot();
  return {
    t: pose && Number.isFinite(pose.t) ? pose.t : 0,
    pose: pose && typeof pose === "object" ? { ...pose } : null,
    speedMps: 0,
    velocity: [0, 0, 0],
    senseHeading: null,
    aspect: 16 / 9,
    indoor: false,
    sectors,
    freeAhead: { level: Infinity, above: Infinity, below: Infinity },
    sides,
    nearest: { range: Infinity, kind: null, bearingDeg: null, elevDeg: null },
    pathAhead: { ttc: Infinity, kind: null, distance: Infinity },
    subject: null,
    particles: { onLens: null, inView: [] },
    limits: { canRise: false, canSink: false, roomLeft: 0, roomRight: 0, ceiling: Infinity },
    ages: { sectors: Infinity, freeAhead: Infinity, sides: Infinity, nearest: Infinity, pathAhead: Infinity, subject: Infinity, particles: Infinity, limits: Infinity },
    budget: { calls: 0, limit: 0 },
  };
}

/**
 * True when `key` is a static placement fade key of a table the runtime may fade
 * (world_query FADEABLE_STATIC_SOURCES: LandBlockInfo statics; never procedural scenery).
 * @param {*} key
 * @returns {boolean}
 */
export function isFadeableStaticKey(key) {
  const m = parseStaticFadeKey(key);
  return m !== null && FADEABLE_STATIC_SOURCES.includes(m.source);
}

/**
 * `ctx.fadedIds` (array / Set / iterable of guids and keys) as a Set; null when empty.
 * @param {*} raw
 * @returns {Set<number|string>|null}
 */
function fadedSet(raw) {
  if (raw == null || typeof raw !== "object" || typeof raw[Symbol.iterator] !== "function") return null;
  const out = new Set();
  for (const id of raw) {
    if (typeof id === "number" && Number.isFinite(id)) out.add(id >>> 0);
    else if (typeof id === "string" && id) out.add(id);
  }
  return out.size ? out : null;
}

/**
 * Read `ctx.nominalAhead` into `[{pos, dt}]` (dt = seconds from now, ascending).
 * Accepts an array (or a function returning one) of `[x,y,z]`, `{pos, t}` or
 * Pose objects; times come from `t` (absolute film time when `poseT` is finite,
 * else relative to the first point), otherwise points are spread evenly over
 * `aheadSec` (the first point = now).
 * @param {*} raw
 * @param {number} poseT
 * @param {number} aheadSec
 * @returns {{pos:number[], dt:number}[]}
 */
export function readNominalAhead(raw, poseT, aheadSec) {
  let list = raw;
  if (typeof list === "function") {
    try {
      list = list(aheadSec);
    } catch {
      list = null;
    }
  }
  if (!Array.isArray(list) || list.length === 0) return [];
  const pts = [];
  for (const it of list) {
    const p = Array.isArray(it) || ArrayBuffer.isView(it) ? vec(it) : it && typeof it === "object" ? vec(it.pos) ?? vec(it) : null;
    if (!p) continue;
    const t = it && typeof it === "object" && !Array.isArray(it) && Number.isFinite(it.t) ? it.t : NaN;
    pts.push({ pos: p, t });
  }
  if (pts.length === 0) return [];
  const timed = pts.every((p) => Number.isFinite(p.t));
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    let dt;
    if (timed) dt = Number.isFinite(poseT) ? pts[i].t - poseT : pts[i].t - pts[0].t;
    else dt = n === 1 ? aheadSec : (aheadSec * i) / (n - 1);
    out.push({ pos: pts[i].pos, dt: Math.max(0, dt) });
  }
  for (let i = 1; i < out.length; i++) if (out[i].dt < out[i - 1].dt) out[i].dt = out[i - 1].dt;
  return out;
}

/**
 * Create the perception module.
 *
 * `sense(pose, ctx, dt)` → SensorFrame (SPEC §3.1) with extras:
 * `{t, pose, speedMps, velocity, senseHeading, aspect, indoor,
 *   sectors:{far_left|left|center|right|far_right:{range, kind}},
 *   freeAhead:{level, above, below}, sides:{left|right|up|down|back:{range, kind}},
 *   nearest:{range, kind, bearingDeg, elevDeg}, pathAhead:{ttc, kind, distance},
 *   subject:{visibleFrac, unseenSec, ndc, sizeRatio, occluderKind, occluderIds,
 *            raysMeasured, guid}|null,
 *   particles:{onLens:{family, density, occludes, key}|null, inView:[{family, occludes, range, key, density}]},
 *   limits:{canRise, canSink, roomLeft, roomRight, ceiling},
 *   ages:{sectors, freeAhead, sides, nearest, pathAhead, subject, particles, limits},
 *   budget:{calls, limit}}`.
 *
 * `ctx` (all optional): `subject` ({pos (base) | center, radius, height, guid} or
 * null), `subjectRef` (resolved with worldQuery.subject when `subject` is absent),
 * `nominalAhead` (see readNominalAhead), `aheadSec` (2), `velocity` ([x,y,z],
 * overrides the pose-delta estimate), `senseHeading` (compass rad override),
 * `senseFrame:'camera'` (always the camera heading), `indoor` (no terrain march; the
 * EnvCell layers are swept), `cellIds` (cell sweeps; default indoors = renderSetCells(sh)),
 * `fadedIds` (ids the runtime has faded out — a subject ray they stop counts as clear),
 * `terrainZAt` (override; null disables terrain),
 * `layers`, `framing` ('MS'), `aspect` (16/9), `lensRadius` (2), `subjectIsObstacle`
 * (false: the subject's guid is excluded from the clearance / path probes too, so a
 * planned dolly-in or follow never reads as "close creature ahead" — the safety
 * reflex still owns real contact; true: the subject counts like any obstacle).
 * `dt` = seconds since the previous sense() (the sensor clock; ages and the
 * unseen timer run on it).
 *
 * @param {{worldQuery?:object|null, sh?:object|null, los?:Function, particles?:object|null,
 *   budget?:{sweepsPerFrame?:number}, rangeM?:number, probeRadius?:number,
 *   log?:(entry:object)=>void}} [deps]
 * @returns {{sense:(pose:object, ctx?:object, dt?:number)=>object, reset:()=>void, stats:()=>object}}
 */
export function createSensors(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const wq = d.worldQuery && typeof d.worldQuery === "object" ? d.worldQuery : null;
  const sh = d.sh ?? null;
  const los = typeof d.los === "function" ? d.los : defaultLos;
  const particles = d.particles && typeof d.particles === "object" ? d.particles
    : wq && wq.particles && typeof wq.particles === "object" ? wq.particles : null;
  const budgetLimit = d.budget && Number.isFinite(d.budget.sweepsPerFrame) ? Math.max(0, Math.floor(d.budget.sweepsPerFrame)) : SENSOR_DEFAULT_BUDGET;
  const rangeM = Number.isFinite(d.rangeM) && d.rangeM > 0 ? d.rangeM : SENSOR_RANGE_M;
  const probeR = Number.isFinite(d.probeRadius) && d.probeRadius >= 0 ? d.probeRadius : G.probeRadius;
  const log = typeof d.log === "function" ? d.log : null;

  // --- state -----------------------------------------------------------------
  let clock = 0;
  let cursor = 0;
  let prevEye = null;
  let velSmooth = [0, 0, 0];
  let travelMode = false;
  let lastCamHeading = 0;
  let unseenSec = 0;
  let subjectKey = null;
  /** @type {Map<string, object>} probe id → measurement */
  const probes = new Map();
  const counters = { frames: 0, calls: 0, lastCalls: 0, maxCalls: 0, wasmCalls: 0, cuts: 0, losErrors: 0 };
  let losErrorLogged = false;

  function resetAll() {
    clock = 0;
    cursor = 0;
    prevEye = null;
    velSmooth = [0, 0, 0];
    travelMode = false;
    lastCamHeading = 0;
    unseenSec = 0;
    subjectKey = null;
    probes.clear();
  }

  function dropSubjectProbes() {
    for (const k of [...probes.keys()]) if (k.startsWith("subject.")) probes.delete(k);
  }

  // --- the per-frame context -------------------------------------------------
  /** @type {any} */
  let F = null;

  /** One los call (counted against the budget). */
  function probe(from, to, radius, extra = {}) {
    F.calls += 1;
    counters.calls += 1;
    const opts = { radius, ...extra };
    if (F.cellIds) opts.cellIds = F.cellIds;
    if (F.layers) opts.layers = F.layers;
    if (typeof F.terrainZAt === "function") opts.terrainZAt = F.terrainZAt;
    let r = null;
    try {
      r = los(sh, from, to, opts);
    } catch (e) {
      counters.losErrors += 1;
      if (log && !losErrorLogged) {
        losErrorLogged = true;
        try {
          log({ event: "film-sensors", level: "warn", message: `los failed: ${e && e.message ? e.message : String(e)}` });
        } catch {
          /* ignore */
        }
      }
      r = null;
    }
    if (r && Number.isFinite(r.calls)) counters.wasmCalls += r.calls;
    return r && typeof r === "object" ? r : { blocked: false };
  }

  /**
   * Refined kind (+ guid, + static fade key) of a blocking los result. A scenery-layer
   * hit keeps its kind / did label but never an id (v1: no placement on a CollisionHit,
   * so neither "fade it" nor "already faded" can be true of it), and a fade key is kept
   * only for a fadeable placement table (isFadeableStaticKey).
   */
  function refine(r) {
    let kind = typeof r.kind === "string" ? r.kind : null;
    let guid = null;
    let did = null;
    let fadeKey = null;
    const scenery = normalizeLayerName(r.layer) === "scenery";
    if (wq && typeof wq.describeHit === "function") {
      try {
        const h = wq.describeHit({ layer: r.layer, point: r.point, normal: r.normal, kind }, { indoor: F.indoor });
        if (h && typeof h === "object") {
          if (typeof h.kind === "string") kind = h.kind;
          if (Number.isFinite(h.guid) && !scenery) guid = h.guid >>> 0;
          if (Number.isFinite(h.did)) did = h.did >>> 0;
          if (!scenery && isFadeableStaticKey(h.fadeKey)) fadeKey = h.fadeKey;
        }
      } catch {
        /* keep the layer kind */
      }
    }
    return { kind, guid, did, fadeKey };
  }

  /** Extra los options of obstacle probes: the shot's own subject is not an obstacle (unless asked). */
  function obstacleOpts() {
    return F.subject && F.subject.guid && !F.subjectIsObstacle ? { subjectGuid: F.subject.guid } : {};
  }

  /** Run a clearance probe along a world direction and store it. */
  function rayJob(id, origin, dir, radius) {
    const to = addS(origin, dir, rangeM);
    const r = probe(origin, to, radius, obstacleOpts());
    const rec = { at: clock, eye: F.eye.slice(), dir: dir.slice(), range: Infinity, kind: null, point: null, guid: null, layer: null };
    if (r.blocked) {
      const tl = Number.isFinite(r.distance) ? r.distance : (Number.isFinite(r.t) ? r.t * rangeM : 0);
      // Wasm layers report the swept SPHERE's contact (surface = travel + radius);
      // the terrain march is centre-line only (its distance IS the surface distance).
      const range = r.layer === "terrain" ? tl : tl > 1e-6 ? tl + radius : 0;
      if (range <= rangeM) {
        const k = refine(r);
        rec.range = range;
        rec.kind = k.kind;
        rec.guid = k.guid;
        rec.point = vec(r.point) ?? addS(origin, dir, tl);
        rec.layer = typeof r.layer === "string" ? r.layer : null;
      }
    }
    probes.set(id, rec);
  }

  /** The path chords for this frame: `[{from, to, dt0, dt1}]` (≤ maxChords). */
  function pathChords(maxChords) {
    const ahead = F.nominal;
    if (ahead.length >= 2) {
      const n = ahead.length;
      const K = Math.max(1, Math.min(maxChords, n - 1));
      const idx = [];
      for (let k = 0; k <= K; k++) idx.push(Math.round((k * (n - 1)) / K));
      const chords = [];
      for (let k = 0; k < K; k++) {
        const a = ahead[idx[k]], b = ahead[idx[k + 1]];
        chords.push({ from: k === 0 ? F.eye : a.pos, to: b.pos, dt0: a.dt, dt1: b.dt });
      }
      return chords;
    }
    if (ahead.length === 1) return [{ from: F.eye, to: ahead[0].pos, dt0: 0, dt1: Math.max(ahead[0].dt, 1e-3) }];
    if (F.speed > G.travelExitMps) return [{ from: F.eye, to: addS(F.eye, F.vel, F.aheadSec), dt0: 0, dt1: F.aheadSec }];
    return [];
  }

  /** Sweep the path chords (stops at the first contact). Returns calls used. */
  function pathJob(maxChords) {
    const chords = pathChords(maxChords);
    const rec = { at: clock, eye: F.eye.slice(), ttc: Infinity, kind: null, distance: Infinity, point: null, analytic: chords.length === 0 };
    let travelled = 0;
    let used = 0;
    for (const c of chords) {
      const L = len(sub(c.to, c.from));
      if (!(L > 1e-6)) continue;
      const r = probe(c.from, c.to, probeR, obstacleOpts());
      used += 1;
      if (r.blocked) {
        const t = Number.isFinite(r.t) ? Math.max(0, Math.min(1, r.t)) : 0;
        const k = refine(r);
        rec.ttc = c.dt0 + t * (c.dt1 - c.dt0);
        rec.kind = k.kind;
        rec.distance = travelled + t * L;
        rec.point = vec(r.point);
        break;
      }
      travelled += L;
    }
    probes.set("path", rec);
    return used;
  }

  /** Subject sample point i (0 centre, 1 top, 2 bottom, 3 left, 4 right) from the current eye. */
  function subjectPoint(i) {
    const s = F.subject;
    const base = s.pos;
    const H = s.height;
    const c = [base[0], base[1], base[2] + H / 2];
    if (i === 0) return c;
    if (i === 1) return [base[0], base[1], base[2] + 0.85 * H];
    if (i === 2) return [base[0], base[1], base[2] + 0.15 * H];
    const v = sub(c, F.eye);
    let rv = [v[1], -v[0], 0];
    const l = Math.hypot(rv[0], rv[1]);
    rv = l > 1e-6 ? [rv[0] / l, rv[1] / l, 0] : F.camRight;
    const off = 0.8 * s.radius * (i === 3 ? -1 : 1);
    return addS(c, rv, off);
  }

  /** One subject visibility ray. */
  function subjectJob(i) {
    const s = F.subject;
    const target = subjectPoint(i);
    const L = len(sub(target, F.eye));
    const rec = { at: clock, key: subjectKey, visible: true, kind: null, guid: null, fadeKey: null, distance: Infinity, seenThrough: false };
    if (L > 1e-6) {
      const r = probe(F.eye, target, G.subjectRayRadius, s.guid ? { subjectGuid: s.guid } : {});
      if (r.blocked) {
        const p = vec(r.point);
        const hitD = Number.isFinite(r.distance) ? r.distance : (Number.isFinite(r.t) ? r.t * L : 0);
        // A hit on (or right at) the subject's own body counts as seeing it.
        let self = hitD >= L - (s.radius + G.subjectSelfPad);
        if (!self && p) {
          const z = Math.min(Math.max(p[2], s.pos[2]), s.pos[2] + s.height);
          self = Math.hypot(p[0] - s.pos[0], p[1] - s.pos[1], p[2] - z) <= s.radius + G.subjectSelfPad;
        }
        if (!self) {
          const k = refine(r);
          const id = k.guid !== null ? k.guid : k.fadeKey;
          if (id !== null && F.faded && F.faded.has(id)) {
            // Faded out by the runtime for this take: the camera sees past it.
            rec.seenThrough = true;
          } else {
            rec.visible = false;
            rec.kind = k.kind;
            rec.guid = k.guid;
            rec.fadeKey = k.fadeKey;
            rec.distance = hitD;
          }
        }
      }
    }
    probes.set(`subject.${i}`, rec);
  }

  /** Job table: id → {applicable, cost, run(maxCalls) → calls}. */
  function jobFor(id) {
    if (id.startsWith("sector.")) {
      const name = id.slice(7);
      const k = SECTOR_NAMES.indexOf(name);
      return {
        applicable: true,
        cost: 1,
        run: () => {
          rayJob(id, F.eye, compassDir(F.hs + SECTOR_CENTRES_DEG[k] * DEG), probeR);
          return 1;
        },
      };
    }
    if (id.startsWith("band.")) {
      const which = id.slice(5);
      return {
        applicable: true,
        cost: 1,
        run: () => {
          if (which === "level") rayJob(id, F.eye, F.fwd, G.levelBandRadius);
          else rayJob(id, addS(F.eye, [0, 0, 1], which === "above" ? G.bandOffset : -G.bandOffset), F.fwd, G.bandRadius);
          return 1;
        },
      };
    }
    if (id.startsWith("side.")) {
      const which = id.slice(5);
      const dir = which === "left" ? [-F.right[0], -F.right[1], 0] : which === "right" ? F.right
        : which === "up" ? [0, 0, 1] : which === "down" ? [0, 0, -1] : [-F.fwd[0], -F.fwd[1], 0];
      return {
        applicable: true,
        cost: 1,
        run: () => {
          rayJob(id, F.eye, dir, probeR);
          return 1;
        },
      };
    }
    if (id === "path") {
      const n = pathChords(G.maxPathChords).length;
      return {
        applicable: n > 0,
        cost: Math.max(1, n),
        run: (maxCalls) => pathJob(Math.max(1, Math.min(G.maxPathChords, maxCalls))),
      };
    }
    if (id.startsWith("subject.")) {
      const i = Number(id.slice(8));
      return {
        applicable: F.subject !== null,
        cost: 1,
        run: () => {
          subjectJob(i);
          return 1;
        },
      };
    }
    return { applicable: false, cost: 0, run: () => 0 };
  }

  /** Round-robin the probe jobs within the budget (one full cycle at most). */
  function runJobs() {
    const N = PROBE_ORDER.length;
    let scanned = 0;
    while (scanned < N) {
      const id = PROBE_ORDER[cursor % N];
      const job = jobFor(id);
      if (!job.applicable) {
        cursor = (cursor + 1) % N;
        scanned += 1;
        continue;
      }
      const left = budgetLimit - F.calls;
      if (left <= 0) break;
      if (job.cost > left && id !== "path") break;
      job.run(left);
      cursor = (cursor + 1) % N;
      scanned += 1;
    }
  }

  /** Motion-compensated range of a stored clearance probe. */
  function compRange(rec) {
    if (!rec || !Number.isFinite(rec.range)) return Infinity;
    const disp = sub(F.eye, rec.eye);
    return Math.max(0, rec.range - dot(disp, rec.dir));
  }

  /** Age of a probe (Infinity when never measured). */
  function ageOf(id) {
    const rec = probes.get(id);
    return rec ? Math.max(0, clock - rec.at) : Infinity;
  }

  /** `{range, kind}` slot of a stored clearance probe. */
  function slot(id) {
    const rec = probes.get(id);
    const range = compRange(rec);
    return { range, kind: Number.isFinite(range) && rec ? rec.kind : null };
  }

  // --- sense -----------------------------------------------------------------

  /**
   * One perception tick (see createSensors).
   * @param {object} pose SPEC Pose `{t, pos, h, p, r, q, fov}` (AC)
   * @param {object} [ctx]
   * @param {number} [dt] seconds since the previous tick
   * @returns {object} SensorFrame
   */
  function sense(pose, ctx = {}, dt = 0) {
    counters.frames += 1;
    const eye = pose && typeof pose === "object" ? vec(pose.pos) : null;
    if (!eye) {
      const empty = emptySensorFrame(pose && typeof pose === "object" ? pose : null);
      empty.budget = { calls: 0, limit: budgetLimit };
      counters.lastCalls = 0;
      return empty;
    }
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    clock += step;

    // Cut detection + velocity.
    let cut = false;
    if (prevEye && len(sub(eye, prevEye)) > G.cutDistance) {
      cut = true;
      counters.cuts += 1;
      probes.clear();
      unseenSec = 0;
      velSmooth = [0, 0, 0];
      travelMode = false;
    }
    let vel = [0, 0, 0];
    const vOverride = vec(c.velocity);
    if (vOverride) vel = vOverride;
    else if (prevEye && !cut && step > 0) vel = [(eye[0] - prevEye[0]) / step, (eye[1] - prevEye[1]) / step, (eye[2] - prevEye[2]) / step];
    const a = step > 0 ? Math.min(1, step / G.velocityTau) : vOverride ? 1 : 0;
    velSmooth = [velSmooth[0] + (vel[0] - velSmooth[0]) * a, velSmooth[1] + (vel[1] - velSmooth[1]) * a, velSmooth[2] + (vel[2] - velSmooth[2]) * a];
    prevEye = eye.slice();
    const speed = len(vel);

    // Camera basis + heading (never derived from a vertical forward: hprFromQuat holds the hint there).
    const q = poseQuat(pose);
    const B = qToBasis(q);
    let hc = Number.isFinite(pose.h) ? pose.h : hprFromQuat(q, lastCamHeading).h;
    if (!Number.isFinite(hc)) hc = lastCamHeading;
    lastCamHeading = hc;
    const vh = Math.hypot(velSmooth[0], velSmooth[1]);
    if (travelMode ? vh < G.travelExitMps : vh >= G.travelEnterMps) travelMode = !travelMode;
    let hs;
    if (Number.isFinite(c.senseHeading)) hs = c.senseHeading;
    else if (c.senseFrame === "camera" || !travelMode) hs = hc;
    else hs = Math.atan2(velSmooth[0], velSmooth[1]);

    // Subject.
    let subject = null;
    let rawSubject = c.subject;
    if (rawSubject === undefined && c.subjectRef !== undefined && c.subjectRef !== null && wq && typeof wq.subject === "function") {
      try {
        rawSubject = wq.subject(c.subjectRef);
      } catch {
        rawSubject = null;
      }
    }
    if (rawSubject && typeof rawSubject === "object") {
      try {
        const s = normalizeSubject(rawSubject);
        subject = { pos: s.pos, radius: s.radius, height: s.height, guid: Number.isFinite(rawSubject.guid) ? rawSubject.guid >>> 0 : 0 };
      } catch {
        subject = null;
      }
    }
    const newKey = subject ? (subject.guid ? `g${subject.guid}` : "point") : null;
    if (newKey !== subjectKey) {
      dropSubjectProbes();
      unseenSec = 0;
      subjectKey = newKey;
    }

    const indoor = c.indoor === true;
    let terrainZAt;
    if (c.terrainZAt === null) terrainZAt = undefined;
    else if (typeof c.terrainZAt === "function") terrainZAt = c.terrainZAt;
    else if (!indoor && wq && typeof wq.groundZ === "function") terrainZAt = (x, y) => wq.groundZ(x, y);
    const aheadSec = Number.isFinite(c.aheadSec) && c.aheadSec > 0 ? c.aheadSec : G.aheadSec;
    const fov = Number.isFinite(pose.fov) && pose.fov > 0 && pose.fov < 180 ? pose.fov : 60;
    const aspect = Number.isFinite(c.aspect) && c.aspect > 0 ? c.aspect : 16 / 9;

    F = {
      eye,
      hs,
      fwd: compassDir(hs),
      right: [Math.cos(hs), -Math.sin(hs), 0],
      camRight: B.right,
      vel: vOverride ? vel : velSmooth.slice(),
      speed: vOverride ? speed : len(velSmooth),
      indoor,
      cellIds: c.cellIds ?? (indoor ? renderSetCells(sh) : null),
      faded: fadedSet(c.fadedIds),
      layers: c.layers ?? null,
      terrainZAt: indoor ? undefined : terrainZAt,
      subject,
      subjectIsObstacle: c.subjectIsObstacle === true,
      nominal: readNominalAhead(c.nominalAhead, Number.isFinite(pose.t) ? pose.t : NaN, aheadSec),
      aheadSec,
      calls: 0,
    };

    runJobs();
    counters.lastCalls = F.calls;
    if (F.calls > counters.maxCalls) counters.maxCalls = F.calls;

    // --- assemble ------------------------------------------------------------
    const sectors = {};
    for (const k of SECTOR_NAMES) sectors[k] = slot(`sector.${k}`);
    const sides = {};
    for (const k of SIDE_NAMES) sides[k] = slot(`side.${k}`);
    const upR = sides.up.range;
    const downR = sides.down.range;
    const bandTop = G.bandOffset + G.bandRadius;
    const freeAhead = {
      level: compRange(probes.get("band.level")),
      above: upR < bandTop ? 0 : compRange(probes.get("band.above")),
      below: downR < bandTop ? 0 : compRange(probes.get("band.below")),
    };

    // nearest obstacle
    const descending = velSmooth[2] < -G.descendingMps;
    let nearest = { range: Infinity, kind: null, bearingDeg: null, elevDeg: null };
    const cand = [...SECTOR_NAMES.map((k) => `sector.${k}`), "band.level", "side.left", "side.right", "side.up", "side.back", "side.down"];
    for (const id of cand) {
      const rec = probes.get(id);
      if (!rec || !rec.point) continue;
      if (id === "side.down" && rec.kind === "terrain" && !descending) continue;
      const range = compRange(rec);
      if (!(range < nearest.range)) continue;
      const v = sub(rec.point, eye);
      const fx = dot(v, F.fwd), rx = dot(v, F.right);
      nearest = {
        range,
        kind: rec.kind,
        bearingDeg: Math.hypot(fx, rx) > 1e-9 ? Math.atan2(rx, fx) / DEG : 0,
        elevDeg: Math.atan2(v[2], Math.hypot(fx, rx)) / DEG,
      };
    }

    // path ahead
    let pathAhead;
    const prec = probes.get("path");
    if (jobFor("path").applicable === false) {
      pathAhead = { ttc: Infinity, kind: null, distance: Infinity };
      probes.set("path", { at: clock, eye: eye.slice(), ttc: Infinity, kind: null, distance: Infinity, point: null, analytic: true });
    } else if (prec && Number.isFinite(prec.ttc)) {
      const age = Math.max(0, clock - prec.at);
      const moved = len(sub(eye, prec.eye));
      pathAhead = { ttc: Math.max(0, prec.ttc - age), kind: prec.kind, distance: Math.max(0, prec.distance - moved) };
    } else {
      pathAhead = { ttc: Infinity, kind: null, distance: Infinity };
    }

    // subject
    let subjectOut = null;
    let subjectAge = 0;
    if (subject) {
      let measured = 0;
      let clear = 0;
      const blockedKinds = new Map();
      const occIds = [];
      let nearestBlock = Infinity;
      let nearestKind = null;
      subjectAge = 0;
      for (let i = 0; i < 5; i++) {
        const rec = probes.get(`subject.${i}`);
        if (!rec || rec.key !== subjectKey) {
          subjectAge = Infinity;
          continue;
        }
        subjectAge = Math.max(subjectAge, clock - rec.at);
        measured += 1;
        if (rec.visible) {
          clear += 1;
          continue;
        }
        const k = rec.kind ?? "unknown";
        blockedKinds.set(k, (blockedKinds.get(k) ?? 0) + 1);
        if (rec.distance < nearestBlock) {
          nearestBlock = rec.distance;
          nearestKind = k;
        }
        const occId = rec.guid !== null ? rec.guid : rec.fadeKey ?? null;
        if (occId !== null && !occIds.includes(occId)) occIds.push(occId);
      }
      if (measured === 0) subjectAge = Infinity;
      const geomFrac = measured > 0 ? clear / measured : 1;
      let occluderKind = null;
      if (blockedKinds.size > 0) {
        let bestN = -1;
        for (const [k, n] of blockedKinds) {
          if (n > bestN || (n === bestN && k === nearestKind)) {
            bestN = n;
            occluderKind = k;
          }
        }
      }
      // Occluding particle clouds on the centre ray.
      let pFactor = 1;
      const centre = [subject.pos[0], subject.pos[1], subject.pos[2] + subject.height / 2];
      if (particles && typeof particles.alongSegment === "function") {
        let rows = [];
        try {
          rows = particles.alongSegment(eye, centre, 0) || [];
        } catch {
          rows = [];
        }
        for (const r of rows) {
          if (!r || r.occludes !== true) continue;
          const dens = Number.isFinite(r.density) ? Math.max(0, Math.min(1, r.density)) : 0;
          if (dens <= 0) continue;
          pFactor *= 1 - G.particleOcclusion * dens;
          if (r.key !== undefined && !occIds.includes(r.key)) occIds.push(r.key);
        }
      }
      const visibleFrac = Math.max(0, Math.min(1, geomFrac * pFactor));
      if (pFactor < 0.8 && geomFrac >= 0.8) occluderKind = "particles";
      if (visibleFrac >= 0.8 && geomFrac >= 1) occluderKind = null;
      if (visibleFrac < 0.1) unseenSec += step;
      else unseenSec = 0;

      const framing = c.framing ?? "MS";
      let k = 0.5;
      try {
        k = framingFactor(framing);
      } catch {
        k = 0.5;
      }
      let ndc = null;
      let sizeRatio = null;
      try {
        const aim = aimPointForFraming(k, { pos: subject.pos, radius: subject.radius, height: subject.height });
        const P = projectToNdc(pose, aim, fov, aspect);
        ndc = P.inFront ? [P.x, P.y] : null;
        sizeRatio = framingScale(eye, B.forward, aim, k * subject.height, fov);
      } catch {
        ndc = null;
        sizeRatio = null;
      }
      subjectOut = {
        visibleFrac,
        unseenSec,
        ndc,
        sizeRatio,
        occluderKind: visibleFrac >= 0.8 && occluderKind !== "particles" ? null : occluderKind,
        occluderIds: occIds,
        raysMeasured: measured,
        guid: subject.guid || null,
      };
    } else {
      unseenSec = 0;
    }

    // particles
    let onLens = null;
    let inView = [];
    if (particles) {
      try {
        const l = typeof particles.onLens === "function"
          ? particles.onLens({ ...pose, pos: eye }, { radius: Number.isFinite(c.lensRadius) && c.lensRadius > 0 ? c.lensRadius : G.lensRadius })
          : null;
        if (l && typeof l === "object") onLens = { family: l.family ?? "particles", density: l.density, occludes: l.occludes === true, key: l.key };
      } catch {
        onLens = null;
      }
      try {
        const rows = typeof particles.inView === "function" ? particles.inView({ ...pose, pos: eye }, { rangeM, fovDeg: fov, aspect }) || [] : [];
        inView = rows.slice(0, G.maxInView).map((r) => ({
          family: r.family ?? "particles",
          occludes: r.occludes === true,
          range: Number.isFinite(r.range) ? r.range : Infinity,
          key: r.key,
          density: Number.isFinite(r.density) ? r.density : 0,
        }));
      } catch {
        inView = [];
      }
    }

    // limits
    const room = (r) => (Number.isFinite(r) ? Math.max(0, r - G.roomMargin) : Infinity);
    const limits = {
      canRise: upR >= G.canRiseMin,
      canSink: downR >= G.canSinkMin,
      roomLeft: room(sides.left.range),
      roomRight: room(sides.right.range),
      ceiling: upR,
    };

    const maxAge = (ids) => ids.reduce((m, id) => Math.max(m, ageOf(id)), 0);
    const ages = {
      sectors: maxAge(SECTOR_NAMES.map((k) => `sector.${k}`)),
      freeAhead: maxAge(["band.level", "band.above", "band.below"]),
      sides: maxAge(SIDE_NAMES.map((k) => `side.${k}`)),
      nearest: maxAge(cand),
      pathAhead: ageOf("path"),
      subject: subject ? subjectAge : 0,
      particles: particles ? 0 : Infinity,
      limits: maxAge(["side.up", "side.down", "side.left", "side.right"]),
    };

    const frame = {
      t: Number.isFinite(pose.t) ? pose.t : clock,
      pose: {
        t: pose.t,
        pos: eye.slice(),
        h: Number.isFinite(pose.h) ? pose.h : hc,
        p: Number.isFinite(pose.p) ? pose.p : undefined,
        r: Number.isFinite(pose.r) ? pose.r : undefined,
        q: q.slice(),
        fov,
      },
      speedMps: speed,
      velocity: vel.slice(),
      senseHeading: hs,
      aspect,
      indoor,
      sectors,
      freeAhead,
      sides,
      nearest,
      pathAhead,
      subject: subjectOut,
      particles: { onLens, inView },
      limits,
      ages,
      budget: { calls: F.calls, limit: budgetLimit },
    };
    F = null;
    return frame;
  }

  return {
    sense,
    /** Forget every measurement, the clock, the unseen timer and the round-robin cursor. */
    reset() {
      resetAll();
    },
    /** @returns {{frames:number, calls:number, lastCalls:number, maxCalls:number, wasmCalls:number, cuts:number, losErrors:number, budget:number}} */
    stats() {
      return { ...counters, budget: budgetLimit };
    },
  };
}
