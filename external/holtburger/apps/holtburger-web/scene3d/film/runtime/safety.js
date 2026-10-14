// scene3d/film/runtime/safety.js — the hard safety reflex of the film camera (SPEC §0, §3 runtime/safety.js).
//
// WHY: the JEV pilot nudges the camera ("drift left", "rise") and the drone
// model adds lag and overshoot, but neither may ever put the lens inside a
// wall, a tree trunk, a creature or the ground — one such frame ruins a take.
// So every frame, AFTER the pilot and before the camera write, a code reflex
// that always wins clamps the eye:
//   1. a SPHERE sweep prevEye → desiredEye through every collision layer
//      (scene/los.js segmentBlocked: building triangles, statics, scenery,
//      EnvCell shells + furniture, BSP doors, creatures/players, and terrain
//      outdoors). The sphere radius covers the near-plane CORNER at the shot's
//      fov (`radiusFor`: near·√(1 + tan²(fov/2)·(1 + aspect²)) + 0.05 skin) —
//      at 120° wide-angle the corner sits ≈0.37 m out, so the follow camera's
//      0.3 m sphere would let the near plane poke through dungeon walls;
//   2. on a hit the eye stops a skin short of the contact and SLIDES along the
//      hit normal (up to 3 slides), so a dolly grazing a wall keeps moving
//      instead of sticking;
//   3. outdoors a terrain floor: z ≥ groundZ(x, y) + 0.7 m (the follow
//      camera's terrain clearance); NEVER indoors — above a dungeon the
//      heightmap is the surface far above;
//   4. indoors `clipCameraToCellSpace(prev → eye, r, carriedCell)`: the eye
//      never leaves valid cell space through a wall or a stitch seam;
//   5. near-lens particles: emitters whose cloud comes within `lensRadiusM`
//      of the eye get the render-only `emitter.filmHidden` (the simulation
//      keeps running) and are restored once the eye moves away (hysteresis)
//      or on release().
// Orientation is never touched: safety moves the eye only.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: dependencies injected
// ({sh, worldQuery, los, particles, liveScene3d, log}); never imports a
// stateful scene3d module; wasm boxes are freed inside los.js. Deterministic.

import { FilmError, FILM_ERROR_CODES } from "../core/errors.js";
import { isIndoorCell } from "../core/units.js";
import { renderSetCells } from "../scene/world_query.js";

/** Camera near plane (m) the radius is computed for. */
export const SAFETY_NEAR_M = 0.1;
/** Skin added to the near-plane corner distance and kept between the eye and a hit (m). */
export const SAFETY_SKIN_M = 0.05;
/** Floor on the sweep radius (m). */
export const SAFETY_MIN_RADIUS_M = 0.25;
/** Terrain clearance outdoors (m): z ≥ groundZ + this. */
export const SAFETY_TERRAIN_CLEARANCE_M = 0.7;
/** Maximum slides along hit normals per frame. */
export const SAFETY_MAX_SLIDES = 3;
/** Particle clouds within this surface distance (m) of the eye are hidden. */
export const SAFETY_LENS_RADIUS_M = 1.0;
/** Extra distance (m) before a hidden cloud is shown again. */
export const SAFETY_LENS_HYSTERESIS_M = 1.0;
/** Collision layers swept by default (terrain only outdoors, with a ground oracle). */
export const SAFETY_LAYERS = Object.freeze(["terrain", "buildingMesh", "statics", "scenery", "cellMesh", "cellStatics", "entities", "objects"]);

const DEG = Math.PI / 180;

/** `[x,y,z]` copy of a finite vector; null otherwise. */
function vec3(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [+x, +y, +z];
}

/** Euclidean length of a 3-vector. */
function len3(a) {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/**
 * Sweep-sphere radius that covers the near-plane corner at a vertical fov and
 * aspect, plus the skin, floored at `minRadius`:
 * `max(minRadius, near·√(1 + tan²(fov/2)·(1 + aspect²)) + skin)`.
 * Non-finite / out-of-range inputs fall back to fov 60°, aspect 16/9.
 * @param {number} fovDeg vertical fov, degrees
 * @param {number} aspect width / height
 * @param {{near?:number, skin?:number, minRadius?:number}} [opts]
 * @returns {number} metres
 */
export function safetyRadius(fovDeg, aspect, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const near = Number.isFinite(o.near) && o.near > 0 ? o.near : SAFETY_NEAR_M;
  const skin = Number.isFinite(o.skin) && o.skin >= 0 ? o.skin : SAFETY_SKIN_M;
  const minR = Number.isFinite(o.minRadius) && o.minRadius >= 0 ? o.minRadius : SAFETY_MIN_RADIUS_M;
  const f = Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 179 ? fovDeg : 60;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const t = Math.tan((f * DEG) / 2);
  const corner = near * Math.sqrt(1 + t * t * (1 + a * a));
  return Math.max(minR, corner + skin);
}

/**
 * Create the safety reflex (SPEC §3).
 *
 * - `clamp(prevPose, desiredPose, ctx)` → `{pose, adjusted, hits, radius, particles}`:
 *   `ctx = {fovDeg?, aspect?, indoor?, cell?, cellIds?, cut?, ignoreGuid?, layers?,
 *   terrain?:boolean}` — `indoor` defaults to "the carried `cell` is an EnvCell";
 *   `cellIds` default indoors = world_query `renderSetCells(sh)` (a copy of the viewer
 *   cell's `getViewerRenderSet()`, else `getRenderSet(1)`); `cut` skips the
 *   sweep and the cell clip (a hard cut may legitimately cross a wall);
 *   `ignoreGuid` is the los `subjectGuid` (default 0 — the subject is an
 *   obstacle too). `hits` = `[{layer, kind, t, point, normal}]` (+ `terrain-floor`,
 *   `cell-space`). A non-finite desired eye returns the previous pose (or
 *   `pose: null` when there is none). Never throws.
 * - `radiusFor(fovDeg, aspect)` → metres (`safetyRadius` with this instance's options).
 * - `release()` → restores every emitter it hid (returns how many).
 * - `reset()` → forget per-take state (keeps hidden emitters until release()).
 * - `stats()`.
 *
 * @param {{sh?:object|null, worldQuery?:object|null, los?:{segmentBlocked:Function}|null,
 *   particles?:object|null, liveScene3d?:object|null, log?:(entry:object)=>void,
 *   near?:number, skin?:number, minRadius?:number, terrainClearance?:number,
 *   maxSlides?:number, lensRadiusM?:number, lensHysteresisM?:number,
 *   particleLens?:boolean}} deps
 * @returns {object}
 */
export function createSafety(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : null;
  const los = d.los && typeof d.los.segmentBlocked === "function" ? d.los : null;
  if (!los) throw new FilmError("createSafety: los (scene/los.js with segmentBlocked) is required", FILM_ERROR_CODES.BAD_ARGUMENT);
  const wq = d.worldQuery && typeof d.worldQuery === "object" ? d.worldQuery : null;
  const particles = d.particles && typeof d.particles === "object" ? d.particles : null;
  const radiusOpts = { near: d.near, skin: d.skin, minRadius: d.minRadius };
  const skin = Number.isFinite(d.skin) && d.skin >= 0 ? d.skin : SAFETY_SKIN_M;
  const clearance = Number.isFinite(d.terrainClearance) ? d.terrainClearance : SAFETY_TERRAIN_CLEARANCE_M;
  const maxSlides = Number.isInteger(d.maxSlides) && d.maxSlides >= 0 ? d.maxSlides : SAFETY_MAX_SLIDES;
  const lensR = Number.isFinite(d.lensRadiusM) && d.lensRadiusM >= 0 ? d.lensRadiusM : SAFETY_LENS_RADIUS_M;
  const lensHyst = Number.isFinite(d.lensHysteresisM) && d.lensHysteresisM >= 0 ? d.lensHysteresisM : SAFETY_LENS_HYSTERESIS_M;
  const lensOn = d.particleLens !== false && !!particles && typeof particles.near === "function";
  const emitLog = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-safety", ...entry });
    } catch (_) {
      /* never break the reflex on a logger */
    }
  };
  const sh = () => {
    const h = d.sh ?? (live ? live.sessionHandle : null) ?? null;
    return h && (typeof h === "object" || typeof h === "function") ? h : null;
  };

  /** @type {Map<object, {key:string|null, center:number[], radius:number, prev:*, hadOwn:boolean}>} */
  const hidden = new Map();
  const counters = { frames: 0, adjusted: 0, sweeps: 0, slides: 0, floors: 0, clips: 0, invalid: 0, losErrors: 0, hiddenTotal: 0, shownTotal: 0 };
  const layerHits = {};
  let losWarned = false;

  /** Ground height under (x, y) from the world query; null when unknown. */
  function groundZ(x, y) {
    if (!wq || typeof wq.groundZ !== "function") return null;
    try {
      const z = wq.groundZ(x, y);
      return Number.isFinite(z) ? z : null;
    } catch (_) {
      return null;
    }
  }

  // Indoor cell list: scene/world_query.js renderSetCells (shared with the sensors,
  // so perception and the reflex sweep the same walls).

  /** One los sweep; null on error (counted, logged once). */
  function sweep(h, from, to, opts) {
    counters.sweeps += 1;
    try {
      return los.segmentBlocked(h, from, to, opts);
    } catch (e) {
      counters.losErrors += 1;
      if (!losWarned) {
        losWarned = true;
        emitLog({ level: "warn", message: `segmentBlocked threw: ${e && e.message ? e.message : e}` });
      }
      return null;
    }
  }

  /** Record a los hit. */
  function noteHit(hits, r) {
    const layer = r.layer || "unknown";
    layerHits[layer] = (layerHits[layer] || 0) + 1;
    hits.push({
      layer,
      kind: r.kind ?? null,
      t: r.t,
      point: Array.isArray(r.point) ? r.point.slice() : null,
      normal: Array.isArray(r.normal) ? r.normal.slice() : null,
    });
  }

  /** Sweep with sliding: from `a` toward `b`; returns the reached point. */
  function sweepSlide(h, a, b, opts, hits) {
    let from = a;
    let to = b;
    for (let i = 0; i <= maxSlides; i += 1) {
      const seg = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const L = len3(seg);
      if (!(L > 1e-9)) return to;
      const r = sweep(h, from, to, opts);
      if (!r || r.blocked !== true || !Number.isFinite(r.t)) return to;
      noteHit(hits, r);
      const s = Math.max(0, Math.min(1, r.t) - skin / L);
      const contact = [from[0] + seg[0] * s, from[1] + seg[1] * s, from[2] + seg[2] * s];
      const n = vec3(r.normal);
      const nl = n ? len3(n) : 0;
      if (i === maxSlides || !(nl > 0.5)) return contact;
      const nu = [n[0] / nl, n[1] / nl, n[2] / nl];
      const rem = [to[0] - contact[0], to[1] - contact[1], to[2] - contact[2]];
      const dn = rem[0] * nu[0] + rem[1] * nu[1] + rem[2] * nu[2];
      const slide = [rem[0] - nu[0] * dn, rem[1] - nu[1] * dn, rem[2] - nu[2] * dn];
      if (!(len3(slide) > 1e-4)) return contact;
      counters.slides += 1;
      from = contact;
      to = [contact[0] + slide[0], contact[1] + slide[1], contact[2] + slide[2]];
    }
    return to;
  }

  /** Hide / re-show emitters around the eye. */
  function updateLens(eye) {
    const out = { hidden: [], shown: [] };
    if (!lensOn) return out;
    for (const [em, rec] of hidden) {
      const dist = Math.hypot(eye[0] - rec.center[0], eye[1] - rec.center[1], eye[2] - rec.center[2]) - rec.radius;
      if (dist > lensR + lensHyst) {
        restoreEmitter(em, rec);
        hidden.delete(em);
        counters.shownTotal += 1;
        out.shown.push(rec.key);
      }
    }
    let rows = [];
    try {
      rows = particles.near(eye, lensR) || [];
    } catch (_) {
      rows = [];
    }
    for (const row of rows) {
      const em = row && row.emitter;
      if (!em || typeof em !== "object" || hidden.has(em)) continue;
      if (!(Number.isFinite(row.range) ? row.range <= lensR : true)) continue;
      const center = vec3(row.center) || eye.slice();
      const rec = {
        key: row.key ?? null,
        center,
        radius: Number.isFinite(row.radius) ? row.radius : 0,
        prev: em.filmHidden,
        hadOwn: Object.prototype.hasOwnProperty.call(em, "filmHidden"),
      };
      em.filmHidden = true;
      hidden.set(em, rec);
      counters.hiddenTotal += 1;
      out.hidden.push(rec.key);
    }
    return out;
  }

  function restoreEmitter(em, rec) {
    try {
      if (rec.hadOwn) em.filmHidden = rec.prev;
      else delete em.filmHidden;
    } catch (_) {
      /* a frozen emitter */
    }
  }

  function clamp(prevPose, desiredPose, ctx = {}) {
    counters.frames += 1;
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const hits = [];
    const prev = prevPose && typeof prevPose === "object" ? vec3(prevPose.pos) : null;
    const want = desiredPose && typeof desiredPose === "object" ? vec3(desiredPose.pos) : null;
    const fov = Number.isFinite(c.fovDeg) ? c.fovDeg : (desiredPose && Number.isFinite(desiredPose.fov) ? desiredPose.fov : 60);
    const R = safetyRadius(fov, c.aspect, radiusOpts);
    if (!want) {
      counters.invalid += 1;
      counters.adjusted += 1;
      hits.push({ layer: "invalid", kind: null, t: 0, point: null, normal: null });
      return {
        pose: prev ? { ...prevPose, pos: prev } : null,
        adjusted: true,
        hits,
        radius: R,
        particles: { hidden: [], shown: [] },
      };
    }
    const cell = Number.isFinite(c.cell) ? c.cell >>> 0 : 0;
    const indoor = typeof c.indoor === "boolean" ? c.indoor : (cell !== 0 && safeIndoor(cell));
    const h = sh();
    let eye = want.slice();
    const cut = c.cut === true || !prev;

    if (!cut) {
      const layers = Array.isArray(c.layers) ? c.layers : SAFETY_LAYERS;
      const useTerrain = !indoor && c.terrain !== false && !!wq && typeof wq.groundZ === "function";
      const opts = {
        radius: R,
        subjectGuid: Number.isFinite(c.ignoreGuid) ? c.ignoreGuid >>> 0 : 0,
        cellIds: c.cellIds ?? (indoor ? renderSetCells(h) : null),
        layers: layers.filter((l) => l !== "terrain" || useTerrain),
        exemptLocalPlayer: true,
      };
      if (useTerrain) opts.terrainZAt = (x, y) => groundZ(x, y);
      eye = sweepSlide(h, prev, want, opts, hits);
    }

    // Terrain floor (outdoors only).
    if (!indoor && c.terrain !== false) {
      const gz = groundZ(eye[0], eye[1]);
      if (gz !== null && eye[2] < gz + clearance) {
        hits.push({ layer: "terrain-floor", kind: "terrain", t: 1, point: [eye[0], eye[1], gz], normal: [0, 0, 1] });
        layerHits["terrain-floor"] = (layerHits["terrain-floor"] || 0) + 1;
        eye[2] = gz + clearance;
        counters.floors += 1;
      }
    }

    // Indoor cell-space containment (from the carried cell).
    if (indoor && !cut && cell !== 0 && h && typeof h.clipCameraToCellSpace === "function") {
      const seg = [eye[0] - prev[0], eye[1] - prev[1], eye[2] - prev[2]];
      const L = len3(seg);
      if (L > 1e-9) {
        let t;
        try {
          t = h.clipCameraToCellSpace(prev[0], prev[1], prev[2], eye[0], eye[1], eye[2], R, cell);
        } catch (_) {
          t = undefined;
        }
        if (typeof t === "number" && t >= 0 && t < 1) {
          const s = Math.max(0, t - skin / L);
          eye = [prev[0] + seg[0] * s, prev[1] + seg[1] * s, prev[2] + seg[2] * s];
          hits.push({ layer: "cell-space", kind: "wall", t, point: eye.slice(), normal: null });
          layerHits["cell-space"] = (layerHits["cell-space"] || 0) + 1;
          counters.clips += 1;
        }
      }
    }

    const lens = updateLens(eye);
    const moved = Math.hypot(eye[0] - want[0], eye[1] - want[1], eye[2] - want[2]);
    const adjusted = moved > 1e-6;
    if (adjusted) counters.adjusted += 1;
    return { pose: { ...desiredPose, pos: eye }, adjusted, hits, radius: R, particles: lens };
  }

  function release() {
    let n = 0;
    for (const [em, rec] of hidden) {
      restoreEmitter(em, rec);
      n += 1;
    }
    hidden.clear();
    counters.shownTotal += n;
    return n;
  }

  return {
    clamp,
    radiusFor: (fovDeg, aspect) => safetyRadius(fovDeg, aspect, radiusOpts),
    release,
    reset: () => {
      losWarned = false;
    },
    hiddenEmitters: () => hidden.size,
    stats: () => ({ ...counters, hiddenNow: hidden.size, layerHits: { ...layerHits } }),
  };
}

/** isIndoorCell without throwing. */
function safeIndoor(cell) {
  try {
    return isIndoorCell(cell);
  } catch (_) {
    return false;
  }
}
