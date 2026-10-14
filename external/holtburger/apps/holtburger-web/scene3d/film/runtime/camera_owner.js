// scene3d/film/runtime/camera_owner.js — the film camera owner (SPEC §3 runtime/camera_owner.js).
//
// WHY: every system that draws, culls, shadows, hears or projects through the
// camera reads ONE object — `cameraSwitcher.persp` (activeCamera in follow
// mode): the composer passes, SSAO/haze, CSM, the frustum culler, the cell
// render set, dynamic LOD, the audio listener. A film camera must therefore
// DRIVE that object, never introduce a new one (recon_render: a second camera
// silently breaks the pass retargeting and dyn-LOD). And it must keep the
// follow camera from re-deriving the pose every frame without stopping
// `CameraSwitcher.tick` (its `_smoothToIntegrator` feeds the player pose to
// lighting/LRU, `_dispatchMovement` feeds input). The proven seam is the
// per-instance `positionCamera` wrap that `?camDebug=on` uses (camera.js
// `_installCamDebug`): while owned the wrapper re-asserts the film pose and
// skips follow/orbit/topDown; released, it hands straight through.
//
// What this module owns:
//   * own() / release(): force follow mode (orbit's OrbitControls.update and
//     topDown's ortho camera would fight), wrap positionCamera, save and
//     restore followYaw / followPitch / mode / fov / csmFitFov, re-seed
//     `_prevEyeAc` and the local-avatar near-fade opacity on release;
//   * write(pose): AC pose → three: `position = acToThree(pos)`,
//     `quaternion = acQuatToThree(q)` (built from the quaternion, never lookAt —
//     straight-down and rolled shots have no gimbal flip), fov with
//     `updateProjectionMatrix` only on change (near/far are NEVER touched:
//     pmndrs copies them by value), `userData.csmFitFov` capped at 75° so CSM
//     keeps fitting a sane frustum during wide / dolly-zoom shots,
//     `updateMatrixWorld(true)`; the Pose `focus` channel drives
//     `window.__dof.focusDistance` when depth of field exists (owner decision:
//     DoF ships in v1);
//   * the film VIEWER CELL: the player-head → eye walk in cells.js cannot reach
//     a dungeon room with no straight line to the player, so the owner carries
//     its own cell with `sessionHandle.resolveViewerCell(prevEye, eye, 0.3,
//     prevCell)` (sub-stepped every 8 m — the wasm walk caps at 256 × 0.25 m),
//     seeded from the plan's cell on cuts (`setCutCell`), else from a
//     player-head walk, and publishes `liveScene3d.filmViewer = {cell}`;
//   * the per-frame film hooks `liveScene3d.film = {preFrame(ts, dt),
//     postRender(), holdLoop}` the hooks lane wired into index.js tick()
//     (`ensureFilmHooks`): listener lists so the take player (preFrame), the
//     stepped film clock and the recorder (postRender) share one object.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: every dependency is
// injected ({liveScene3d, THREE, sessionHandle, window, log}); it never imports
// a stateful scene3d module; every wasm export is typeof-guarded and every
// wasm box freed. Deterministic: no clocks.

import { FilmError, FILM_ERROR_CODES } from "../core/errors.js";
import { acQuatToThree, acToThreePos, hprFromQuat, quatFromHPR, threeQuatToAc, threeToAcPos } from "../core/gimbal.js";
import { qNorm } from "../core/quat.js";
import { isIndoorCell, localFromWorld } from "../core/units.js";

/** Film camera near plane (m) — the engine's value; film never animates it. */
export const FILM_CAMERA_NEAR = 0.1;
/** Film camera far plane (m) — the engine's value; film never animates it. */
export const FILM_CAMERA_FAR = 5000;
/** Above this vertical fov (deg) `camera.userData.csmFitFov` pins the CSM fit to it. */
export const CSM_FIT_FOV_MAX_DEG = 75;
/** Sphere radius (m) of the viewer-cell walk (scene3d/viewer_cell.js VIEWER_SPHERE_RADIUS_M). */
export const VIEWER_CELL_RADIUS_M = 0.3;
/** Longest single resolveViewerCell segment (m); longer moves are sub-stepped. */
export const VIEWER_CELL_STEP_M = 8;
/** A move longer than this (m) without a cut cell re-seeds the carried cell instead of walking. */
export const VIEWER_CELL_RESEED_M = 192;
/** Player head height above the pose z (m) — the cells.js walk pivot (viewer_cell.js VIEWER_PIVOT_Z_M). */
export const VIEWER_PIVOT_Z_M = 1.5;
/** Valid vertical fov range (deg, exclusive) accepted by write(). */
export const FOV_MIN_DEG = 1;
/** @see FOV_MIN_DEG */
export const FOV_MAX_DEG = 170;

/** Marker on the hooks object this module installs on `liveScene3d.film`. */
const HOOKS_MARK = "__filmHooks";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** `[x,y,z]` from an array-like or `{x,y,z}`; null unless all finite. */
function vec3(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [+x, +y, +z];
}

/** Unit `[w,x,y,z]` copy of a finite, non-zero quaternion; null otherwise. */
function quat4(q) {
  if (q == null || typeof q !== "object" || q.length < 4) return null;
  const w = q[0], x = q[1], y = q[2], z = q[3];
  if (![w, x, y, z].every(Number.isFinite)) return null;
  const l = Math.sqrt(w * w + x * x + y * y + z * z);
  if (!(l > 1e-9)) return null;
  return [w / l, x / l, y / l, z / l];
}

/** free() a wasm box, swallowing double-free errors. */
function freeBox(b) {
  if (b && typeof b === "object" && typeof b.free === "function") {
    try {
      b.free();
    } catch (_) {
      /* already released */
    }
  }
}

/** Emit a structured log entry through an optional logger; never throws. */
function makeEmitter(log, event) {
  return (entry) => {
    if (typeof log !== "function") return;
    try {
      log({ event, ...entry });
    } catch (_) {
      /* a throwing logger never breaks the camera */
    }
  };
}

// ---------------------------------------------------------------------------
// film hooks (liveScene3d.film)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FilmHooks
 * @property {boolean} holdLoop  true parks the realtime loop (index.js scheduleNext);
 *   frames then come only from `window.__renderOnce(tsMs)`
 * @property {(tsMs:number, dt:number) => void} preFrame  called by index.js tick()
 *   after `frameTime` is stamped, before tickPerFrame
 * @property {() => void} postRender  called by index.js after the frame's final draw
 *   (every render exit), in the same task
 * @property {(fn:(tsMs:number, dt:number) => void) => (() => void)} addPreFrame  subscribe; returns unsubscribe
 * @property {(fn:() => void) => (() => void)} addPostRender  subscribe; returns unsubscribe
 * @property {() => {preFrames:number, postRenders:number, errors:number, preListeners:number, postListeners:number}} stats
 */

/**
 * Install (or return the already installed) film hooks object on
 * `liveScene3d.film` — the object index.js reads every frame
 * (`liveScene3dRef?.film?.preFrame?.(ts, dt)`, `…?.postRender?.()`,
 * `…?.holdLoop`). Listeners run in subscription order; a throwing listener is
 * counted and logged (once per listener) and never stops the others.
 * Idempotent: a second call returns the same object. A foreign `film` object
 * (not installed here) is replaced and its `holdLoop` carried over.
 * @param {object} liveScene3d
 * @param {{log?:(entry:object)=>void}} [opts]
 * @returns {FilmHooks}
 */
export function ensureFilmHooks(liveScene3d, opts = {}) {
  if (!liveScene3d || typeof liveScene3d !== "object") {
    throw new FilmError("ensureFilmHooks: liveScene3d is required", FILM_ERROR_CODES.BAD_ARGUMENT);
  }
  const existing = liveScene3d.film;
  if (existing && typeof existing === "object" && existing[HOOKS_MARK] === true) return existing;
  const emit = makeEmitter(opts && opts.log, "film-hooks");
  /** @type {Array<Function>} */
  const pre = [];
  /** @type {Array<Function>} */
  const post = [];
  const warned = new WeakSet();
  const counters = { preFrames: 0, postRenders: 0, errors: 0 };
  const run = (list, args, phase) => {
    for (const fn of list.slice()) {
      try {
        fn(...args);
      } catch (e) {
        counters.errors += 1;
        if (!warned.has(fn)) {
          warned.add(fn);
          emit({ level: "warn", phase, message: String(e && e.message ? e.message : e) });
          if (typeof (opts && opts.log) !== "function" && typeof console !== "undefined") {
            // eslint-disable-next-line no-console
            console.warn(`[film] ${phase} listener threw (others still run):`, e);
          }
        }
      }
    }
  };
  const subscribe = (list, fn) => {
    if (typeof fn !== "function") throw new FilmError("film hooks: listener must be a function", FILM_ERROR_CODES.BAD_ARGUMENT);
    list.push(fn);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  };
  const hooks = {
    [HOOKS_MARK]: true,
    holdLoop: !!(existing && typeof existing === "object" && existing.holdLoop),
    preFrame(tsMs, dt) {
      counters.preFrames += 1;
      if (pre.length) run(pre, [tsMs, dt], "preFrame");
    },
    postRender() {
      counters.postRenders += 1;
      if (post.length) run(post, [], "postRender");
    },
    addPreFrame(fn) {
      return subscribe(pre, fn);
    },
    addPostRender(fn) {
      return subscribe(post, fn);
    },
    stats() {
      return { ...counters, preListeners: pre.length, postListeners: post.length };
    },
  };
  if (existing && typeof existing === "object") emit({ level: "warn", message: "replaced a foreign liveScene3d.film object" });
  liveScene3d.film = hooks;
  return hooks;
}

// ---------------------------------------------------------------------------
// camera owner
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} OwnedPose
 * @property {number[]} pos  AC world metres
 * @property {number[]} q    unit AC quaternion `[w,x,y,z]`
 * @property {number} h @property {number} p @property {number} r  gimbal angles (radians)
 * @property {number} fov    vertical degrees
 * @property {number} [focus] metres
 * @property {number} [t]    film time when the writer supplied it
 * @property {number} cell   carried film viewer cell (0 = none)
 */

/**
 * Create the film camera owner (SPEC §3).
 *
 * - `own()` → `{ok, mode, camera:'persp'|'camera'}`: takes `cameraSwitcher.persp`
 *   (fallback `liveScene3d.camera`); forces follow mode (`switchMode('follow')`,
 *   else `activeCamera = persp`); installs the per-instance `positionCamera`
 *   wrapper (while owned it re-asserts the film pose and skips the follow /
 *   orbit / topDown derivation); snapshots mode, followYaw, followPitch, fov,
 *   csmFitFov and the avatar fade. Idempotent. Throws FilmError
 *   `FILM_CAMERA_UNAVAILABLE` when no camera exists yet (cameraSwitcher arrives
 *   ≈35 s after in-world).
 * - `release()` → `{ok, wasOwned}`: unwraps positionCamera (an own-property
 *   wrapper from `?camDebug=on` is put back), restores mode / followYaw /
 *   followPitch / fov / csmFitFov, `_prevEyeAc = null` (the next follow frame
 *   snaps), pushes the saved avatar fade (default 1) through
 *   `_applyCameraPlayerFade`, deletes `liveScene3d.filmViewer`. Idempotent.
 * - `owned` (getter).
 * - `write(pose)` → boolean: `pose = {pos, q?|h,p,r?, fov?, focus?, t?}` (AC). A
 *   non-finite position or orientation is rejected (false, camera untouched);
 *   false also when not owned. fov outside (1, 170)° keeps the current fov.
 * - `currentPose()` → OwnedPose (last write, else read back from the camera) or null.
 * - `viewerCell()` → carried viewer cell (0 = none).
 * - `setCutCell(cell)` → the parsed cell: the NEXT write seeds the carried cell
 *   with it instead of walking from the previous eye (hard cuts, dungeon sites).
 *   0 / null / invalid = a cut with no plan cell: the next write re-seeds from
 *   the player-head walk (never walks from the previous eye through walls).
 * - `parkCell()` → `{ok, parked, cell}`: forget the carried cell (and a pending cut),
 *   delete `liveScene3d.filmViewer` so cells.js follows the player-head walk; the
 *   next write re-seeds. world.teleport calls it (a new site loads around the player).
 * - `hooks`, `onPreFrame(fn)`, `onPostRender(fn)` — the shared film hooks.
 * - `camera()` → the owned (or ownable) persp camera, or null.
 * - `dispose()` → release + remove `liveScene3d.film` when it has no listeners.
 * - `stats()` → counters.
 *
 * @param {{liveScene3d:object, THREE?:object|null, sessionHandle?:object|null,
 *   window?:object|null, log?:(entry:object)=>void}} deps
 * @returns {object}
 */
export function createCameraOwner(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : null;
  if (!live) throw new FilmError("createCameraOwner: liveScene3d is required", FILM_ERROR_CODES.BAD_ARGUMENT);
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const emit = makeEmitter(d.log, "film-camera-owner");
  const hooks = ensureFilmHooks(live, { log: d.log });

  /** The session handle (injected, else the scene's). */
  const sh = () => {
    const h = d.sessionHandle ?? live.sessionHandle ?? null;
    return h && (typeof h === "object" || typeof h === "function") ? h : null;
  };

  const state = {
    owned: false,
    /** @type {object|null} */ cs: null,
    /** @type {object|null} */ camera: null,
    /** @type {Function|null} */ wrapper: null,
    /** @type {Function|null} */ prevPosition: null,
    hadOwnPosition: false,
    saved: null,
    /** @type {OwnedPose|null} */ pose: null,
    cell: 0,
    /** @type {number[]|null} */ cellEye: null,
    pendingCut: 0,
    pendingReseed: false,
  };
  const counters = { writes: 0, rejected: 0, reasserts: 0, cellWalks: 0, cellSeeds: 0, cuts: 0, focusWrites: 0, parks: 0 };

  /** The persp camera to own (cameraSwitcher.persp, else liveScene3d.camera). */
  function findCamera() {
    const cs = live.cameraSwitcher && typeof live.cameraSwitcher === "object" ? live.cameraSwitcher : null;
    const cam = (cs && cs.persp) || live.camera || null;
    return { cs, cam: cam && typeof cam === "object" && cam.position && cam.quaternion ? cam : null };
  }

  /** Apply the stored pose transform to the camera (position + quaternion + matrices). */
  function applyTransform(cam, pose) {
    const tp = acToThreePos(pose.pos);
    cam.position.set(tp[0], tp[1], tp[2]);
    const tq = acQuatToThree(pose.q);
    cam.quaternion.set(tq[0], tq[1], tq[2], tq[3]);
    if (typeof cam.updateMatrixWorld === "function") cam.updateMatrixWorld(true);
  }

  /** Apply a vertical fov (projection + CSM fit pin). */
  function applyFov(cam, fov) {
    if (Number.isFinite(fov) && Math.abs((cam.fov ?? NaN) - fov) > 1e-9) {
      cam.fov = fov;
      if (typeof cam.updateProjectionMatrix === "function") cam.updateProjectionMatrix();
    }
    const f = Number.isFinite(cam.fov) ? cam.fov : fov;
    if (!cam.userData || typeof cam.userData !== "object") cam.userData = {};
    if (Number.isFinite(f) && f > CSM_FIT_FOV_MAX_DEG) cam.userData.csmFitFov = CSM_FIT_FOV_MAX_DEG;
    else if ("csmFitFov" in cam.userData) delete cam.userData.csmFitFov;
  }

  /** Read the camera's current pose back into the AC frame. */
  function readCamera(cam) {
    const pos = vec3(threeToAcPos(cam.position));
    const q = quat4(threeQuatToAc(cam.quaternion));
    if (!pos || !q) return null;
    const hpr = hprFromQuat(q, 0);
    return { pos, q, h: hpr.h, p: hpr.p, r: hpr.r, fov: Number.isFinite(cam.fov) ? cam.fov : 60, cell: state.cell };
  }

  // ---- viewer cell --------------------------------------------------------

  /** Publish (or clear) the carried cell on the scene facade cells.js reads. */
  function publishCell() {
    if (state.owned && state.cell !== 0) live.filmViewer = { cell: state.cell >>> 0 };
    else if ("filmViewer" in live) delete live.filmViewer;
  }

  /** One resolveViewerCell call (copy; 0 on failure). */
  function resolveOnce(h, a, b, seed) {
    try {
      const c = h.resolveViewerCell(a[0], a[1], a[2], b[0], b[1], b[2], VIEWER_CELL_RADIUS_M, seed >>> 0);
      return Number.isFinite(c) ? c >>> 0 : 0;
    } catch (_) {
      return 0;
    }
  }

  /** Walk `from → to` from `seed`, sub-stepped every VIEWER_CELL_STEP_M; returns the reached cell. */
  function walk(h, from, to, seed) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const n = Math.max(1, Math.ceil(L / VIEWER_CELL_STEP_M));
    let cell = seed >>> 0;
    let a = from;
    for (let i = 1; i <= n; i += 1) {
      const s = i / n;
      const b = i === n ? to : [from[0] + dx * s, from[1] + dy * s, from[2] + dz * s];
      const c = resolveOnce(h, a, b, cell);
      counters.cellWalks += 1;
      if (c !== 0) cell = c;
      a = b;
    }
    return cell;
  }

  /** Local player head (AC world) + cell, wasm pose copied and freed; null when unknown. */
  function playerHead(h) {
    if (!h || typeof h.getLocalPlayerPose !== "function") return null;
    let p = null;
    try {
      p = h.getLocalPlayerPose();
      if (!p) return null;
      const lb = p.landblockId >>> 0;
      const out = {
        cell: lb,
        head: [((lb >>> 24) & 0xff) * 192 + p.x, ((lb >>> 16) & 0xff) * 192 + p.y, p.z + VIEWER_PIVOT_Z_M],
      };
      return vec3(out.head) && out.cell !== 0 ? out : null;
    } catch (_) {
      return null;
    } finally {
      freeBox(p);
    }
  }

  /** A fresh carried cell for `eye`: the player-head walk, else the outdoor cell under the eye. */
  function seedCell(h, eye) {
    counters.cellSeeds += 1;
    if (h && typeof h.resolveViewerCell === "function") {
      const ph = playerHead(h);
      if (ph) {
        const c = walk(h, ph.head, eye, ph.cell);
        if (c !== 0) return c;
      }
    }
    try {
      return localFromWorld(eye[0], eye[1], eye[2]).cellId >>> 0;
    } catch (_) {
      return 0;
    }
  }

  /** Carry the film viewer cell from the previous eye to `eye`. */
  function carryCell(eye) {
    const h = sh();
    if (state.pendingCut !== 0) {
      state.cell = state.pendingCut >>> 0;
      state.pendingCut = 0;
      counters.cuts += 1;
    } else if (state.pendingReseed || state.cell === 0 || state.cellEye === null) {
      state.cell = seedCell(h, eye);
      state.pendingReseed = false;
    } else {
      const a = state.cellEye;
      const L = Math.hypot(eye[0] - a[0], eye[1] - a[1], eye[2] - a[2]);
      if (L > VIEWER_CELL_RESEED_M) state.cell = seedCell(h, eye);
      else if (L > 1e-6 && h && typeof h.resolveViewerCell === "function") state.cell = walk(h, a, eye, state.cell);
    }
    state.cellEye = eye.slice();
    publishCell();
  }

  // ---- ownership ----------------------------------------------------------

  function own() {
    if (state.owned) return { ok: true, already: true, mode: state.cs ? state.cs.mode : null, camera: state.cs ? "persp" : "camera" };
    const { cs, cam } = findCamera();
    if (!cam) {
      throw new FilmError("film camera unavailable: liveScene3d.cameraSwitcher.persp / liveScene3d.camera not ready (it arrives ~35 s after in-world)",
        "FILM_CAMERA_UNAVAILABLE");
    }
    const ud = cam.userData && typeof cam.userData === "object" ? cam.userData : null;
    const saved = {
      fov: Number.isFinite(cam.fov) ? cam.fov : null,
      hadCsmFitFov: !!(ud && Object.prototype.hasOwnProperty.call(ud, "csmFitFov")),
      csmFitFov: ud ? ud.csmFitFov : undefined,
      mode: cs ? cs.mode : null,
      activeCamera: cs ? cs.activeCamera : null,
      followYaw: cs ? cs.followYaw : undefined,
      followPitch: cs ? cs.followPitch : undefined,
      fade: cs && Number.isFinite(cs._camFadeLastOpacity) ? cs._camFadeLastOpacity : null,
    };
    if (cs) {
      if (cs.mode !== "follow" && typeof cs.switchMode === "function") {
        try {
          cs.switchMode("follow");
        } catch (e) {
          emit({ level: "warn", message: `switchMode('follow') threw: ${e && e.message ? e.message : e}` });
        }
      }
      if (cs.activeCamera !== cam) cs.activeCamera = cam;
      state.hadOwnPosition = Object.prototype.hasOwnProperty.call(cs, "positionCamera");
      state.prevPosition = typeof cs.positionCamera === "function" ? cs.positionCamera : null;
      const prev = state.prevPosition;
      const wrapper = function filmPositionCamera(dt) {
        if (state.owned && state.wrapper === wrapper) {
          if (state.pose && state.camera) {
            applyTransform(state.camera, state.pose);
            if (Number.isFinite(state.pose.fov) && state.camera.fov !== state.pose.fov) applyFov(state.camera, state.pose.fov);
            counters.reasserts += 1;
          }
          return undefined;
        }
        return prev ? prev.call(this, dt) : undefined;
      };
      state.wrapper = wrapper;
      cs.positionCamera = wrapper;
    }
    state.cs = cs;
    state.camera = cam;
    state.saved = saved;
    state.owned = true;
    state.cell = 0;
    state.cellEye = null;
    const cur = readCamera(cam);
    state.pose = cur;
    emit({ message: "owned", mode: cs ? cs.mode : null });
    return { ok: true, already: false, mode: cs ? cs.mode : null, camera: cs ? "persp" : "camera" };
  }

  function release() {
    if (!state.owned) return { ok: true, wasOwned: false };
    const cs = state.cs;
    const cam = state.camera;
    const saved = state.saved || {};
    state.owned = false;
    if (cs) {
      if (cs.positionCamera === state.wrapper) {
        if (state.hadOwnPosition) cs.positionCamera = state.prevPosition;
        else delete cs.positionCamera;
      }
      cs._prevEyeAc = null;
      if (saved.followYaw !== undefined) cs.followYaw = saved.followYaw;
      if (saved.followPitch !== undefined) cs.followPitch = saved.followPitch;
      if (saved.mode && cs.mode !== saved.mode && typeof cs.switchMode === "function") {
        try {
          cs.switchMode(saved.mode);
        } catch (e) {
          emit({ level: "warn", message: `switchMode('${saved.mode}') threw on release: ${e && e.message ? e.message : e}` });
        }
      } else if (saved.activeCamera && cs.activeCamera !== saved.activeCamera && cs.mode === saved.mode) {
        cs.activeCamera = saved.activeCamera;
      }
      if (typeof cs._applyCameraPlayerFade === "function") {
        try {
          cs._camFadeLastOpacity = undefined; // force the push past the dedupe cache
          cs._applyCameraPlayerFade(saved.fade !== null && saved.fade !== undefined ? saved.fade : 1);
        } catch (_) {
          /* fade is cosmetic */
        }
      }
    }
    if (cam) {
      if (Number.isFinite(saved.fov) && cam.fov !== saved.fov) {
        cam.fov = saved.fov;
        if (typeof cam.updateProjectionMatrix === "function") cam.updateProjectionMatrix();
      }
      if (cam.userData && typeof cam.userData === "object") {
        if (saved.hadCsmFitFov) cam.userData.csmFitFov = saved.csmFitFov;
        else delete cam.userData.csmFitFov;
      }
    }
    state.wrapper = null;
    state.prevPosition = null;
    state.saved = null;
    state.cell = 0;
    state.cellEye = null;
    state.pendingCut = 0;
    state.pendingReseed = false;
    publishCell();
    emit({ message: "released" });
    return { ok: true, wasOwned: true };
  }

  // ---- writes -------------------------------------------------------------

  function write(pose) {
    if (!state.owned || !state.camera) {
      counters.rejected += 1;
      return false;
    }
    if (!pose || typeof pose !== "object") {
      counters.rejected += 1;
      return false;
    }
    const pos = vec3(pose.pos);
    let q = quat4(pose.q);
    if (!q && Number.isFinite(pose.h) && Number.isFinite(pose.p)) {
      q = quat4(quatFromHPR(pose.h, pose.p, Number.isFinite(pose.r) ? pose.r : 0));
    }
    if (!pos || !q) {
      counters.rejected += 1;
      emit({ level: "warn", message: "rejected a non-finite pose", t: pose.t });
      return false;
    }
    const cam = state.camera;
    const fov = Number.isFinite(pose.fov) && pose.fov > FOV_MIN_DEG && pose.fov < FOV_MAX_DEG
      ? +pose.fov
      : (Number.isFinite(cam.fov) ? cam.fov : 60);
    const hint = state.pose && Number.isFinite(state.pose.h) ? state.pose.h : 0;
    let h, p, r;
    if (Number.isFinite(pose.h) && Number.isFinite(pose.p)) {
      h = +pose.h;
      p = +pose.p;
      r = Number.isFinite(pose.r) ? +pose.r : 0;
    } else {
      const hpr = hprFromQuat(q, hint);
      h = hpr.h;
      p = hpr.p;
      r = hpr.r;
    }
    const next = { pos, q: qNorm(q), h, p, r, fov, cell: state.cell };
    if (Number.isFinite(pose.focus) && pose.focus > 0) next.focus = +pose.focus;
    if (Number.isFinite(pose.t)) next.t = +pose.t;
    applyFov(cam, fov);
    applyTransform(cam, next);
    state.pose = next;
    counters.writes += 1;
    carryCell(pos);
    next.cell = state.cell;
    if (next.focus !== undefined) applyFocus(next.focus);
    return true;
  }

  /** Drive `window.__dof.focusDistance` from the Pose focus channel (no-op without DoF). */
  function applyFocus(focus) {
    const dof = win && typeof win === "object" ? win.__dof : null;
    if (!dof || typeof dof !== "object") return;
    try {
      if (dof.focusDistance !== focus) dof.focusDistance = focus;
      counters.focusWrites += 1;
    } catch (e) {
      emit({ level: "warn", message: `__dof.focusDistance rejected ${focus}: ${e && e.message ? e.message : e}` });
    }
  }

  function currentPose() {
    if (state.pose) {
      const p = state.pose;
      const out = { pos: p.pos.slice(), q: p.q.slice(), h: p.h, p: p.p, r: p.r, fov: p.fov, cell: state.cell };
      if (p.focus !== undefined) out.focus = p.focus;
      if (p.t !== undefined) out.t = p.t;
      return out;
    }
    const { cam } = findCamera();
    return cam ? readCamera(cam) : null;
  }

  function setCutCell(cell) {
    let c = 0;
    if (typeof cell === "number" && Number.isFinite(cell)) c = cell >>> 0;
    else if (typeof cell === "string" && /^\s*(?:0x)?[0-9a-fA-F]{1,8}\s*$/.test(cell)) c = parseInt(cell.trim().replace(/^0x/i, ""), 16) >>> 0;
    state.pendingCut = c;
    state.pendingReseed = c === 0;
    return c;
  }

  /**
   * Park the film viewer cell (world.teleport): forget the carried cell, drop a
   * pending cut and stop publishing `liveScene3d.filmViewer`, so cells.js roots
   * the viewer at the player (its player-head walk) while the next site loads —
   * the previous site's cell would otherwise keep deciding viewer-indoor and the
   * sealed-dungeon state there. The camera stays owned at its pose; the next
   * write re-seeds the cell (the plan cell after setCutCell, else the
   * player-head walk).
   * @returns {{ok:true, parked:boolean, cell:number}} parked = a cell was carried or published
   */
  function parkCell() {
    const was = state.cell >>> 0;
    const published = "filmViewer" in live;
    state.cell = 0;
    state.cellEye = null;
    state.pendingCut = 0;
    state.pendingReseed = true;
    publishCell();
    counters.parks += 1;
    if (state.pose) state.pose.cell = 0;
    return { ok: true, parked: was !== 0 || published, cell: was };
  }

  function dispose() {
    release();
    const h = live.film;
    if (h && h[HOOKS_MARK] === true && h === hooks) {
      const s = hooks.stats();
      if (s.preListeners === 0 && s.postListeners === 0 && !hooks.holdLoop) delete live.film;
    }
  }

  return {
    own,
    release,
    get owned() {
      return state.owned;
    },
    write,
    currentPose,
    viewerCell: () => state.cell >>> 0,
    setCutCell,
    parkCell,
    /** True when the carried cell is an EnvCell (indoor). */
    viewerIndoor: () => state.cell !== 0 && isIndoorCell(state.cell),
    hooks,
    onPreFrame: (fn) => hooks.addPreFrame(fn),
    onPostRender: (fn) => hooks.addPostRender(fn),
    camera: () => state.camera || findCamera().cam,
    dispose,
    stats: () => ({ ...counters, owned: state.owned, cell: state.cell >>> 0, pendingCut: state.pendingCut >>> 0 }),
  };
}
