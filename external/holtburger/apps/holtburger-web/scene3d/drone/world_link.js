// scene3d/drone/world_link.js — film runtime wiring for Drone Deploy (SPEC scene3d/drone/SPEC.md §3.8, §6.3, §6.5).
//
// WHY: the FPV drone flies the client's ONE render camera (`cameraSwitcher.persp`
// — composer passes, CSM, the frustum culler, the cell render set, dynamic LOD and
// the audio listener all read it), must never put the lens or its body inside a
// wall, a tree or the ground, needs the world streamed in around it, and wants
// film's FPV lens props in angle / acro. Film mode already owns all of that as
// page modules with injected dependencies that run without `?filmMode=on`: the
// camera owner (positionCamera wrap, viewer cell, light-pool eye, the
// `liveScene3d.film` preFrame / postRender hooks), the safety reflex (sphere
// sweep + slide through every collision layer, terrain floor, near-lens particle
// hide), world prewarm and the lens overlay. This module builds them per deploy
// the way scene3d/film/index.js does (SPEC §6.3 recipe) and disposes them at
// idle, plus the follow-camera helpers of SPEC §6.5:
//   * TWO safety instances: the EYE (film defaults: near-plane radius ≥ 0.25 m,
//     0.7 m terrain floor, near-lens particle hide through a 4 Hz-throttled
//     `particles.near`) while the camera is owned, and the BODY (radius = the
//     drone's, clearance = its rest height, no lens) otherwise — the eye's 0.7 m
//     floor would forbid landing and lift-off (DV-7);
//   * session-handle getters, so camera_owner / safety / world follow the current
//     `window.__sessionHandle` (liveScene3d.sessionHandle is the init3D handle);
//   * world prewarm only when the drone enters a new landblock, one in flight,
//     ≥ 2 s apart, never awaited, no collision populate (DV-9).
// Nothing here sends to the server: `world.teleport / command / actor / avatar`
// are never called, `liveScene3d.film.holdLoop` is never set.
//
// Flag: `?drone`, DEFAULT ON since 2026-10-25 (`=off` disables it) — loaded by scene3d/drone/index.js
// on the first deploy only.
//
// Page module: every dependency injected ({liveScene3d, THREE, window,
// getSessionHandle, wasmExports, body, particleManagers, log, now}); imports only
// film runtime pieces (no stateful scene3d module).

import { FilmError } from "../film/core/errors.js";
import { landblockOfWorld, LB_SIZE } from "../film/core/units.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";
import { createLensOverlay } from "../film/runtime/lens_overlay.js";
import { createSafety } from "../film/runtime/safety.js";
import { createWorld } from "../film/runtime/world.js";
import * as LOS from "../film/scene/los.js";
import { createParticlesQuery } from "../film/scene/particles_query.js";
import { createWorldQuery } from "../film/scene/world_query.js";

/**
 * World prewarm around the drone (DV-9): `world.prewarm` options (radius, maxLandblocks,
 * timeoutSec, envCells, collision, corridor) plus the throttle (minIntervalMs). Collision
 * populate is off (it skips the player's 3×3 ring, which bounds the 180 m tether); EnvCells
 * are indoor content (v1 flies outdoors).
 */
export const DRONE_PREWARM = Object.freeze({ radius: 96, maxLandblocks: 4, minIntervalMs: 2000, timeoutSec: 8,
  envCells: false, collision: false, corridor: true });

/** Minimum interval (ms) between two near-lens particle queries (each rebuilds an all-emitter snapshot). */
export const DRONE_LENS_QUERY_MS = 250;

/** Lens overlay per craft mode: null = off (cine); the shot overlay + uptilt otherwise (SPEC §3.8). */
const LENS_BY_MODE = Object.freeze({
  cine: null,
  angle: Object.freeze({ overlay: Object.freeze({ props: Object.freeze({ style: "freestyle" }) }), uptiltDeg: 20 }),
  acro: Object.freeze({ overlay: Object.freeze({ props: Object.freeze({ style: "freestyle" }) }), uptiltDeg: 25 }),
});

/** Default drone body (props DRONE_BODY): sweep radius and rest height (m). */
const DEFAULT_BODY = Object.freeze({ radiusM: 0.18, restHeightM: 0.06 });

/**
 * Write an AC world pose onto a three object that lives directly under `liveScene3d.scene`
 * (three world frame): `position.set(x, z, −y)`, unit `quaternion.set(qx, qz, −qy, qw)`.
 * Allocation-free. Drone props use `props.setDronePose` instead (droneGroup carries the
 * worldRoot rotation).
 * @param {{position:{set:Function}, quaternion:{set:Function}}} obj
 * @param {ArrayLike<number>} pos AC `[x, y, z]` metres
 * @param {ArrayLike<number>} q AC `[w, x, y, z]`
 * @returns {boolean} false (object untouched) for a missing object or non-finite input
 */
export function writeAcPose(obj, pos, q) {
  if (!obj || !obj.position || !obj.quaternion || !pos || !q) return false;
  const x = pos[0], y = pos[1], z = pos[2];
  const qw = q[0], qx = q[1], qy = q[2], qz = q[3];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  if (!Number.isFinite(qw) || !Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz)) return false;
  const l = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
  if (!(l > 1e-9)) return false;
  obj.position.set(x, z, -y);
  obj.quaternion.set(qx / l, qz / l, -qy / l, qw / l);
  return true;
}

/**
 * @typedef {Object} CamPrep
 * @property {boolean} ok
 * @property {string|null} mode
 * @property {number|null} followYaw
 * @property {number|null} followPitch
 * @property {number|null} followDistance
 * @property {boolean} inHead
 */

/**
 * Deploy start (inputLock executor): leave orbit / topDown / first person BEFORE any held
 * motion (an orbit ↔ follow switch issues Ready on the pilot; in-head pushes the avatar
 * opacity to 0); restored at idle (DV-4).
 * @param {object} cs liveScene3d.cameraSwitcher
 * @returns {CamPrep}
 */
export function prepareFollowCamera(cs) {
  const saved = { ok: false, mode: null, followYaw: null, followPitch: null, followDistance: null, inHead: false };
  if (!cs || typeof cs !== "object") return saved;
  saved.ok = true;
  saved.mode = typeof cs.mode === "string" ? cs.mode : null;
  saved.followYaw = Number.isFinite(cs.followYaw) ? cs.followYaw : null;
  saved.followPitch = Number.isFinite(cs.followPitch) ? cs.followPitch : null;
  saved.followDistance = Number.isFinite(cs.followDistance) ? cs.followDistance : null;
  saved.inHead = cs._inHead === true;
  if (cs.mode !== "follow" && typeof cs.switchMode === "function") { try { cs.switchMode("follow"); } catch (_) {} }
  if (saved.inHead) { cs._inHead = false; cs._prevEyeAc = null; cs._stiffSeeded = false; }
  return saved;
}

/**
 * After the FINAL cameraOwner.release() (inputRestore executor): each own() re-snapshots,
 * so restore our own copy. Back into orbit, camera.js would dispatch Ready once on the pilot
 * (its `_orbitRigStopped` latch); the cycle already issued Ready or withheld it on purpose
 * (death, combat; DV-13), so the latch is set first and the mode restore sends nothing.
 * @param {object} cs liveScene3d.cameraSwitcher
 * @param {CamPrep} saved prepareFollowCamera's result
 * @returns {boolean}
 */
export function restoreFollowCamera(cs, saved) {
  if (!cs || !saved || !saved.ok) return false;
  if (saved.followYaw !== null) cs.followYaw = saved.followYaw;
  if (saved.followPitch !== null) cs.followPitch = saved.followPitch;
  if (saved.followDistance !== null) cs.followDistance = saved.followDistance;
  if (saved.inHead) cs._inHead = true;
  cs._prevEyeAc = null;
  if (saved.mode && cs.mode !== saved.mode && typeof cs.switchMode === "function") {
    if (saved.mode === "orbit") cs._orbitRigStopped = true; // no Ready from the orbit entry (a corpse stays down)
    try { cs.switchMode(saved.mode); } catch (_) {}
  }
  return true;
}

/**
 * Pilot view (Tab), right after release(): the follow camera in FRONT of the pilot
 * (release() alone puts it behind).
 * @param {object} cs liveScene3d.cameraSwitcher
 * @param {number} nowMs performance.now() (camera.js compares `_lastUserYawMs` with it)
 * @returns {boolean}
 */
export function framePilotFront(cs, nowMs) {
  if (!cs || typeof cs.getPlayerHeading !== "function") return false;
  let h = null; try { h = cs.getPlayerHeading(); } catch (_) { h = null; }   // followYaw convention (CW from north)
  if (!Number.isFinite(h)) return false;
  cs.followYaw = h + Math.PI;
  if (Number.isFinite(nowMs)) cs._lastUserYawMs = nowMs;                      // autofollow grace (350 ms)
  cs._prevEyeAc = null;                                                      // snap, no swing through the pilot
  return true;
}

/**
 * Right after own(): while owned camera.js computes no near-fade, so the last pushed
 * opacity would persist.
 * @param {object} cs liveScene3d.cameraSwitcher
 * @returns {boolean}
 */
export function forcePilotOpaque(cs) {
  if (!cs || typeof cs._applyCameraPlayerFade !== "function") return false;
  try { cs._camFadeLastOpacity = undefined; cs._applyCameraPlayerFade(1); return true; } catch (_) { return false; }
}

/** `0x` + 8 upper-case hex digits (no throw). */
function hexLb(n) {
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Build the drone's film runtime link (SPEC §3.8 / §6.3). Build it at deploy and dispose it
 * at idle: createCameraOwner installs `liveScene3d.film` at construction and createWorldQuery
 * pins the session handle at construction.
 *
 * Members: `cameraOwner`, `hooks`, `onPreFrame(fn) → off`, `onPostRender(fn) → off`
 * (listeners added here are removed by dispose), `safety` (eye), `safetyBody` (body),
 * `world`, `worldQuery`, `particles`, `los`, `groundZ(x, y)`, `prewarmAround(pos)`,
 * `aspect()`, `configureLens(mode)`, `drawLens({t, theta, throttle, fov})`, the camera
 * helpers bound to `liveScene3d.cameraSwitcher` (`prepareFollowCamera()`,
 * `restoreFollowCamera(saved)`, `framePilotFront(nowMs)`, `forcePilotOpaque()`), `stats()`,
 * `dispose()`.
 *
 * Throws FilmError `DRONE_NO_SCENE` without `liveScene3d` (the only throw).
 * @param {{liveScene3d:object, THREE?:object|null, window?:object|null,
 *   getSessionHandle?:() => object|null, wasmExports?:object|null,
 *   body?:{radiusM:number, restHeightM:number}, particleManagers?:object[]|(() => object[]),
 *   log?:(entry:object) => void, now?:() => number}} deps
 * @returns {object} the WorldLink
 */
export function createWorldLink(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : null;
  if (!live) throw new FilmError("createWorldLink: liveScene3d is required", "DRONE_NO_SCENE");
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const THREE = d.THREE ?? null;
  const log = typeof d.log === "function" ? d.log : undefined;
  const b = d.body && typeof d.body === "object" ? d.body : DEFAULT_BODY;
  const body = {
    radiusM: Number.isFinite(b.radiusM) && b.radiusM > 0 ? b.radiusM : DEFAULT_BODY.radiusM,
    restHeightM: Number.isFinite(b.restHeightM) && b.restHeightM >= 0 ? b.restHeightM : DEFAULT_BODY.restHeightM,
  };
  const NO_ROWS = Object.freeze([]);
  const nowMs = typeof d.now === "function"
    ? d.now
    : () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0);
  const managers = typeof d.particleManagers === "function"
    ? d.particleManagers
    : Array.isArray(d.particleManagers) ? () => d.particleManagers : null;
  const emit = (entry) => {
    if (!log) return;
    try {
      log({ event: "drone", ...entry });
    } catch (_) {
      /* a logger never breaks the link */
    }
  };

  // ---- the SPEC §6.3 recipe --------------------------------------------------------
  const shOf = () => {
    const h = typeof d.getSessionHandle === "function" ? d.getSessionHandle() : null;
    return h ?? live.sessionHandle ?? (win ? win.__sessionHandle : null) ?? null;
  };
  // init3D's curated object (no scenery-collider populate; moot: DRONE_PREWARM.collision is false).
  const wasm = d.wasmExports ?? live.wasmExports ?? null;
  // camera_owner / safety / world read their handle LAZILY from the deps object they were
  // given, so a getter keeps them on the current window.__sessionHandle.
  const priorFilm = live.film;
  const cameraOwner = createCameraOwner({ liveScene3d: live, THREE, window: win, log, get sessionHandle() { return shOf(); } });
  const hooks = cameraOwner.hooks; // ensureFilmHooks(live) ran at construction
  // Film mode installs its hooks object at init3D, before any deploy: ensureFilmHooks handed us
  // THAT object (shared with film's camera owner, take grabs, scout stills), so dispose() only
  // releases the camera and removes our own listeners — it never deletes film's object.
  const foreignHooks = priorFilm !== null && typeof priorFilm === "object" && priorFilm === hooks;
  const worldQuery = createWorldQuery({ // pins its handle at construction → one link per deploy
    liveScene3d: live, sessionHandle: shOf(), wasmExports: wasm, THREE, log,
    getLocalPlayerGuid: () => (win && typeof win.getLocalPlayerGuid === "function" ? win.getLocalPlayerGuid() : 0),
    ...(managers ? { particles: createParticlesQuery({ liveScene3d: live, THREE, managers }) } : {}),
  });
  const particles = worldQuery.particles && typeof worldQuery.particles.near === "function" ? worldQuery.particles : null;
  let lensAt = -Infinity; // particles.near rebuilds an all-emitter snapshot: ≤ 4 Hz
  const lensParticles = particles
    ? {
      near(c, r) {
        const t = nowMs();
        if (t - lensAt < DRONE_LENS_QUERY_MS) return NO_ROWS;
        lensAt = t;
        return particles.near(c, r);
      },
    }
    : null;
  const safety = createSafety({ get sh() { return shOf(); }, worldQuery, los: LOS, particles: lensParticles, liveScene3d: live, log });
  const safetyBody = createSafety({ get sh() { return shOf(); }, worldQuery, los: LOS, particles: null, particleLens: false,
    liveScene3d: live, log, minRadius: body.radiusM, terrainClearance: body.restHeightM });
  const world = createWorld({ liveScene3d: live, window: win, worldQuery, corridor: worldQuery.corridor, wasmExports: wasm, log,
    get sessionHandle() { return shOf(); } }); // no parkViewerCell: the drone never teleports
  let overlay = null; // lazily: createLensOverlay({THREE, renderer: live.renderer, log})

  // ---- state ------------------------------------------------------------------------
  /** @type {Set<Function>} unsubscribers of the hook listeners added through this link */
  const offs = new Set();
  let disposed = false;
  const pw = { started: 0, finished: 0, failed: 0, inFlight: false, lastLb: /** @type {number|null} */ (null), lastAt: -Infinity, last: null,
    gx: NaN, gy: NaN, gLb: 0 }; // gx / gy / gLb: the grid cell of the last call and its landblock
  const lens = { configures: 0, draws: 0, mode: "cine", on: false };

  // ---- hooks --------------------------------------------------------------------------
  function track(off) {
    let active = true;
    const un = () => {
      if (!active) return;
      active = false;
      offs.delete(un);
      try {
        off();
      } catch (_) {
        /* the hooks object is gone */
      }
    };
    offs.add(un);
    return un;
  }

  /** Subscribe a preFrame listener (removed by dispose). */
  function onPreFrame(fn) {
    if (disposed) return () => {};
    return track(hooks.addPreFrame(fn));
  }

  /** Subscribe a postRender listener (removed by dispose). */
  function onPostRender(fn) {
    if (disposed) return () => {};
    return track(hooks.addPostRender(fn));
  }

  // ---- world ---------------------------------------------------------------------------
  /** Terrain height under (x, y) (never floors / roofs); null when unknown (queues a corridor fetch). */
  function groundZ(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    try {
      const z = worldQuery.groundZ(x, y);
      return typeof z === "number" && Number.isFinite(z) ? z : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Prewarm around `pos` when the drone entered a new landblock: one in flight, ≥ minIntervalMs
   * apart, never awaited. The first position only sets the baseline (the player's own ring is
   * resident). True when a prewarm started.
   */
  function prewarmAround(pos) {
    if (disposed || !pos) return false;
    const x = pos[0], y = pos[1], z = pos[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    // landblockOfWorld (film units) allocates on every call, and this runs every frame: the
    // landblock only changes with the 192 m grid cell, so re-derive it only then (SPEC §5).
    const gx = Math.floor(x / LB_SIZE), gy = Math.floor(y / LB_SIZE);
    let lb;
    if (gx === pw.gx && gy === pw.gy) lb = pw.gLb;
    else {
      try {
        lb = landblockOfWorld(x, y) >>> 0;
      } catch (_) {
        return false;
      }
      pw.gx = gx;
      pw.gy = gy;
      pw.gLb = lb;
    }
    if (pw.lastLb === null) {
      pw.lastLb = lb;
      return false;
    }
    if (lb === pw.lastLb || pw.inFlight) return false;
    const t = nowMs();
    if (t - pw.lastAt < DRONE_PREWARM.minIntervalMs) return false;
    pw.lastLb = lb;
    pw.lastAt = t;
    pw.inFlight = true;
    pw.started += 1;
    const P = DRONE_PREWARM;
    let p;
    try {
      p = Promise.resolve(world.prewarm({ points: [[x, y, z]], radius: P.radius, maxLandblocks: P.maxLandblocks,
        timeoutSec: P.timeoutSec, envCells: P.envCells, collision: P.collision, corridor: P.corridor }));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((r) => {
      pw.finished += 1;
      pw.last = { lb: hexLb(lb), ok: !!(r && r.ok), timedOut: !!(r && r.timedOut), waitedMs: r && Number.isFinite(r.waitedMs) ? r.waitedMs : null };
    }, (e) => {
      pw.failed += 1;
      emit({ level: "warn", message: `world prewarm failed: ${e && e.message ? e.message : e}` });
    }).finally(() => {
      pw.inFlight = false;
    }).catch(() => {});
    return true;
  }

  /** Canvas width / height (renderer.domElement), else the persp camera's aspect, else 16/9. */
  function aspect() {
    const el = live.renderer && live.renderer.domElement;
    const w = el ? Number(el.width) : NaN;
    const h = el ? Number(el.height) : NaN;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
    const a = live.cameraSwitcher && live.cameraSwitcher.persp ? Number(live.cameraSwitcher.persp.aspect) : NaN;
    return Number.isFinite(a) && a > 0 ? a : 16 / 9;
  }

  // ---- lens overlay ----------------------------------------------------------------
  /** Build the overlay on first need; null without THREE / a renderer. */
  function overlayOf() {
    if (overlay) return overlay;
    const r = live.renderer;
    if (!THREE || !r || typeof r.render !== "function") return null;
    overlay = createLensOverlay({ THREE, renderer: r, log });
    return overlay;
  }

  /**
   * Lens props for a craft mode: 'cine' off; 'angle' freestyle 20° uptilt; 'acro' freestyle 25°.
   * @param {string} mode
   * @returns {{ok:boolean, on:boolean}}
   */
  function configureLens(mode) {
    lens.configures += 1;
    if (disposed) return { ok: false, on: false };
    const known = Object.prototype.hasOwnProperty.call(LENS_BY_MODE, mode);
    const cfg = known ? LENS_BY_MODE[mode] : null;
    lens.mode = known ? mode : "cine";
    if (!cfg) {
      if (overlay) {
        try {
          overlay.configure(null);
        } catch (_) {
          /* off anyway */
        }
      }
      lens.on = false;
      return { ok: known, on: false };
    }
    const ov = overlayOf();
    if (!ov) {
      lens.on = false;
      return { ok: false, on: false };
    }
    let r;
    try {
      r = ov.configure(cfg.overlay, { uptiltDeg: cfg.uptiltDeg });
    } catch (e) {
      emit({ level: "warn", message: `lens overlay configure failed: ${e && e.message ? e.message : e}` });
      lens.on = false;
      return { ok: false, on: false };
    }
    lens.on = !!(r && r.on);
    return { ok: !!(r && r.ok), on: lens.on };
  }

  /**
   * Draw the lens props over the finished frame — only while the camera is owned and the
   * overlay is active. True when drawn.
   * @param {{t:number, theta:number, throttle:number, fov:number}} f
   * @returns {boolean}
   */
  function drawLens(f) {
    if (disposed || !overlay || !overlay.active || !cameraOwner.owned) return false;
    try {
      const r = overlay.draw(f);
      if (r && r.drawn) lens.draws += 1;
      return !!(r && r.drawn);
    } catch (_) {
      return false;
    }
  }

  // ---- dispose -------------------------------------------------------------------------
  /**
   * Reverse order: our hook listeners, both safety releases, the camera owner (release; plus
   * delete `liveScene3d.film` when the link created it and nobody else listens — a film hooks
   * object that existed before the link stays), the lens overlay, the world query caches and
   * the corridor. Idempotent; a prewarm in flight finishes on its own.
   * @returns {{ok:true, already:boolean, emittersShown:number}}
   */
  function dispose() {
    if (disposed) return { ok: true, already: true, emittersShown: 0 };
    disposed = true;
    for (const off of [...offs]) off();
    offs.clear();
    let shown = 0;
    try {
      shown += safety.release();
    } catch (_) {
      /* best effort */
    }
    try {
      shown += safetyBody.release();
    } catch (_) {
      /* best effort */
    }
    try {
      if (foreignHooks) cameraOwner.release();
      else cameraOwner.dispose();
    } catch (e) {
      emit({ level: "warn", message: `camera owner dispose threw: ${e && e.message ? e.message : e}` });
    }
    if (overlay) {
      try {
        overlay.dispose();
      } catch (_) {
        /* best effort */
      }
    }
    try {
      worldQuery.reset();
    } catch (_) {
      /* best effort */
    }
    try {
      if (worldQuery.corridor && typeof worldQuery.corridor.clear === "function") worldQuery.corridor.clear();
    } catch (_) {
      /* best effort */
    }
    return { ok: true, already: false, emittersShown: shown };
  }

  const csOf = () => (live.cameraSwitcher && typeof live.cameraSwitcher === "object" ? live.cameraSwitcher : null);

  return {
    cameraOwner,
    hooks,
    onPreFrame,
    onPostRender,
    safety,
    safetyBody,
    world,
    worldQuery,
    particles,
    los: LOS,
    groundZ,
    prewarmAround,
    aspect,
    configureLens,
    drawLens,
    /** @returns {CamPrep} */
    prepareFollowCamera: () => prepareFollowCamera(csOf()),
    /** @param {CamPrep} saved @returns {boolean} */
    restoreFollowCamera: (saved) => restoreFollowCamera(csOf(), saved),
    /** @param {number} nowMs @returns {boolean} */
    framePilotFront: (nowMs2) => framePilotFront(csOf(), nowMs2),
    /** @returns {boolean} */
    forcePilotOpaque: () => forcePilotOpaque(csOf()),
    /** JSON-safe diagnostics. */
    stats() {
      let hs = null;
      try {
        hs = hooks.stats();
      } catch (_) {
        hs = null;
      }
      return {
        disposed,
        camera: cameraOwner.stats(),
        hooks: hs,
        listeners: offs.size,
        safety: safety.stats(),
        safetyBody: safetyBody.stats(),
        lens: { ...lens, overlay: overlay ? overlay.stats() : null },
        prewarm: { started: pw.started, finished: pw.finished, failed: pw.failed, inFlight: pw.inFlight,
          lastLb: pw.lastLb === null ? null : hexLb(pw.lastLb), last: pw.last ? { ...pw.last } : null },
      };
    },
    dispose,
  };
}
