// scene3d/film/index.js — AC Film Mode page entry: installFilmMode(deps) → window.__film (SPEC §3).
//
// WHY: the director (a Claude Code session driving the off-screen Chrome over
// CDP) needs ONE small, JSON-in / JSON-out surface on the page that never
// throws into `page.evaluate`: take the camera, strip the HUD, teleport the
// hidden player and wait for the world, scout camera placements (with JPEG
// stills), prepare / rehearse / shoot takes and pull the encoded video out
// while it records. This module wires every runtime piece together behind
// `window.__film`:
//   camera owner + clean frame + film clock (with the particle / FX / scenery
//   time sources, loaded by dynamic import and typeof-guarded) + look + world
//   control + perception (world query, sensors, particles, los) + the hard
//   safety reflex + the JEV pilot (page bridge → window.__filmJev; code policy
//   without it) + the take player + the WebCodecs recorder + the technique
//   registry + the camera-position solver.
// Every method returns `{ok:false, error:{name, code, message}, code}` instead
// of throwing, and every output is made JSON-safe (non-finite numbers → null,
// typed arrays → arrays, no functions / cycles). Long operations (prepare,
// rehearse, shoot, scout) are mutually exclusive (`FILM_BUSY`); status and
// recorder.drain run any time (the CLI drains WHILE a take records).
//
// Loaded only with `?filmMode=on` (DEFAULT OFF) by the scene3d/index.js seam:
// `import("./film/index.js")` + the already-resident
// `import("./particles/particle_manager.js")`, then `m.installFilmMode({liveScene3d,
// THREE, sessionHandle, wasmExports, particleCull: {setParticleCullConfig,
// allParticleManagers}})`. Page module: every dependency arrives through `deps`
// (or window.liveScene3d); it never imports a stateful scene3d module.
// particleCull: takes and scout stills run the RP6 particle cull every tick
// (recheckInterval 1, restored after), and the particle query enumerates every
// registered manager. world.teleport parks the film viewer cell (cells.js
// follows the player-head walk while the next site loads; the next camera
// write re-seeds it). pose, release, world.teleport and world.command answer
// FILM_BUSY while a take, prepare, shoot, rehearse or scout runs (never a teleport
// or an admin command recorded mid-take, or sent while prepare reads the world).
// The FPV props lens overlay (runtime/lens_overlay.js) is made on the first take that
// asks for it (`take.overlay.props`) and draws only with `?filmProps=on`
// (deps.filmProps overrides the flag for tests / tools) on recorded frames. The pilot
// gets the mapper `limits` of take.pilot (and `pilot.fade: 'never'` → maxFadeIds 0).
// No Anthropic API anywhere: JEV is reached only through the CLI's broker.

import { FilmError, toErrorJSON } from "./core/errors.js";
import { hashString, mulberry32, seedOf } from "./core/rng.js";
import { hex32, parseCellId, worldFromLocal } from "./core/units.js";
import * as FLIGHT from "./drone/flight_model.js";
import { filmDofEnabled, filmModeEnabled, filmPropsEnabled } from "./flags.js";
import { createResidualMapper } from "./pilot/mapper.js";
import { createPilot } from "./pilot/pilot.js";
import { createCameraOwner } from "./runtime/camera_owner.js";
import { createCleanFrame } from "./runtime/clean_frame.js";
import { createFilmClock } from "./runtime/film_clock.js";
import { JEV_BRIDGE_TIMEOUTS, createPageBridge } from "./runtime/jev_bridge_page.js";
import { createLensOverlay } from "./runtime/lens_overlay.js";
import { createLook } from "./runtime/look.js";
import { createRecorder } from "./runtime/recorder.js";
import { createSafety } from "./runtime/safety.js";
import { createTakePlayer } from "./runtime/take_player.js";
import { createWorld } from "./runtime/world.js";
import { planIndoorPath } from "./scene/dungeon_route.js";
import * as LOS from "./scene/los.js";
import { createSensors } from "./scene/sensors.js";
import { createParticlesQuery } from "./scene/particles_query.js";
import { candidateMetrics, generateCandidates, rankCandidates } from "./scene/solver.js";
import { createStaticCatalogs, createWorldQuery } from "./scene/world_query.js";
import * as SHOTS from "./shots/index.js";
import { nightFactorFromAuthoredPitch } from "../night_ramp.js";
import { buildStitchedGraphFromWasm } from "../../rynth/indoor_router.js";

/** API version reported by `window.__film.version` and status(). */
export const FILM_API_VERSION = "film-1";

/**
 * Every method of `window.__film` (dotted paths): the SPEC §3 table plus the
 * extras `abort`, `dispose`, `logs`, `world.command`, `recorder.stats`.
 * @type {ReadonlyArray<string>}
 */
export const FILM_API_METHODS = Object.freeze([
  "status", "clean", "own", "release", "pose",
  "world.teleport", "world.ready", "world.prewarm", "world.avatar", "world.look", "world.restoreLook", "world.actor",
  "query.subject", "query.near", "query.groundZ",
  "techniques", "scout", "prepare", "rehearse", "shoot", "recorder.drain",
  "abort", "dispose", "logs", "world.command", "recorder.stats",
]);

/** Default subject body for a plan point subject (tools/film/plan/schema.mjs). */
const POINT_SUBJECT = Object.freeze({ radius: 0.6, height: 1.8 });
/** Default scout settings. */
const SCOUT_DEFAULTS = Object.freeze({ count: 8, maxCount: 64, stillWidth: 640, stillFrames: 2, jpegQuality: 0.85 });
/**
 * Horizontal speed (m/s) from which a live subject's prepare-time velocity is
 * extrapolated into the reference track the shot is built against (slower: the
 * reference stands still). The shot builders' own travelling threshold.
 */
const LIVE_REF_MIN_SPEED = 0.3;
/**
 * Night fraction (night_ramp's sin-altitude band, the one the sky, moons and
 * ground dim agree on) from which the sky has no usable directional sun.
 */
const SUN_NIGHT_LIMIT = 0.5;
const DEG = Math.PI / 180;
/** Log entries kept for logs(). */
const LOG_RING = 300;
/** console.warn budget of the default logger. */
const WARN_BUDGET = 50;

/** One api per liveScene3d (idempotent install). */
const INSTALLED = new WeakMap();

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * JSON-safe deep copy: non-finite numbers → null, −0 → 0, typed arrays → arrays, Map →
 * entry arrays, Set → arrays, Errors → toErrorJSON, functions / symbols /
 * undefined dropped (null inside arrays), cycles → null, depth capped at 40.
 * `JSON.parse(JSON.stringify(jsonSafe(v)))` deep-equals `jsonSafe(v)`.
 * @param {*} v
 * @returns {*}
 */
export function jsonSafe(v) {
  return conv(v, 0, new WeakSet());
}

function conv(v, depth, seen) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? (v === 0 ? 0 : v) : null; // -0 → 0 (JSON drops the sign)
  if (t === "string" || t === "boolean") return v;
  if (t === "bigint") return v.toString();
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (depth > 40) return null;
  if (v instanceof Error) return toErrorJSON(v);
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => (typeof x === "number" ? (Number.isFinite(x) ? (x === 0 ? 0 : x) : null) : String(x)));
  if (seen.has(v)) return null;
  seen.add(v);
  let out;
  const item = (x) => {
    const c = conv(x, depth + 1, seen);
    return c === undefined ? null : c;
  };
  if (Array.isArray(v)) out = v.map(item);
  else if (v instanceof Map) out = Array.from(v.entries(), ([k, x]) => [item(k), item(x)]);
  else if (v instanceof Set) out = Array.from(v, item);
  else {
    out = {};
    for (const k of Object.keys(v)) {
      let x;
      try {
        x = v[k];
      } catch (_) {
        continue;
      }
      const c = conv(x, depth + 1, seen);
      if (c !== undefined) out[k] = c;
    }
  }
  seen.delete(v);
  return out;
}

/** A JSON string argument ('{…}' / '[…]') parsed; anything else unchanged. */
function parseArg(x) {
  if (typeof x !== "string") return x;
  const s = x.trim();
  if (!(s.startsWith("{") || s.startsWith("["))) return x;
  try {
    return JSON.parse(s);
  } catch (_) {
    return x;
  }
}

/** Plain (non-array) object. */
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `[x,y,z]` from an array / `{x,y,z}`; null unless finite. */
function vec3(p) {
  if (p == null || typeof p !== "object") return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [+x, +y, +z];
}

/** `{ok:false, error, code}` for any thrown value (details kept JSON-safe). */
function failure(e) {
  const err = jsonSafe(toErrorJSON(e));
  return { ok: false, error: err, code: err && err.code ? err.code : "INTERNAL_ERROR" };
}

/**
 * Readable reason of a delegated `{ok:false, …}` result that carries no
 * `error` (look's `errors[]`, a timed-out readiness gate, failed actor parts).
 */
function describeFailure(v) {
  if (Array.isArray(v.errors) && v.errors.length) return v.errors.map((e) => (isObj(e) ? `${e.key ? `${e.key}: ` : ""}${e.message ?? ""}` : String(e))).join("; ");
  if (v.timedOut === true) return `timed out after ${Number.isFinite(v.waitedMs) ? v.waitedMs : "?"} ms`;
  if (isObj(v.checks)) {
    const bad = Object.entries(v.checks).filter(([, c]) => isObj(c) && c.ok === false).map(([k]) => k);
    if (bad.length) return `checks failing: ${bad.join(", ")}`;
  }
  if (isObj(v.parts)) {
    const bad = Object.entries(v.parts).filter(([, p]) => isObj(p) && p.ok === false).map(([k, p]) => `${k}: ${p.error ?? "failed"}`);
    if (bad.length) return bad.join("; ");
  }
  if (typeof v.note === "string") return v.note;
  return "the operation did not succeed";
}

/**
 * A result made JSON-safe with an `ok` field (defaults to true); an `{ok:false}`
 * result always carries `error:{name, code, message}` and `code`.
 */
function success(r) {
  const v = jsonSafe(r);
  if (isObj(v)) {
    if (!("ok" in v)) return { ok: true, ...v };
    if (v.ok === false && !isObj(v.error)) {
      const code = typeof v.code === "string" ? v.code : (v.timedOut === true ? "FILM_TIMEOUT" : "FILM_FAILED");
      const message = typeof v.error === "string" ? v.error : describeFailure(v);
      return { ...v, error: { name: "FilmError", code, message }, code };
    }
    if (v.ok === false && typeof v.code !== "string") return { ...v, code: typeof v.error.code === "string" ? v.error.code : "FILM_FAILED" };
    return v;
  }
  return { ok: true, value: v === undefined ? null : v };
}

/** Wrap a synchronous method: never throws. */
function safeSync(fn) {
  return (...args) => {
    try {
      return success(fn(...args));
    } catch (e) {
      return failure(e);
    }
  };
}

/** Wrap an async method: never rejects. */
function safeAsync(fn) {
  return async (...args) => {
    try {
      return success(await fn(...args));
    } catch (e) {
      return failure(e);
    }
  };
}

/** A take's actor cue(s) walk the player (`moves: true` or a `moveTo` target; one cue or an array). */
function actorMoves(actor) {
  const cues = Array.isArray(actor) ? actor : isObj(actor) ? [actor] : [];
  return cues.some((c) => isObj(c) && (c.moves === true || (c.moveTo !== undefined && c.moveTo !== null)));
}

/**
 * The PURE reference track of a live subject that the shot is built against:
 * its prepare-time pose, extrapolated horizontally by its velocity when that
 * is at least LIVE_REF_MIN_SPEED (else standing). null when it stands (the
 * static ctx.subject is the reference then).
 */
function referenceTrack(s0, velocity) {
  const v = vec3(velocity);
  if (!v || !(Math.hypot(v[0], v[1]) >= LIVE_REF_MIN_SPEED)) return null;
  return (t) => {
    const tt = Number.isFinite(t) ? t : 0;
    return { ...s0, pos: [s0.pos[0] + v[0] * tt, s0.pos[1] + v[1] * tt, s0.pos[2]] };
  };
}

/** Technique id → solver intent angle class. */
function angleForTechnique(id) {
  const s = String(id || "");
  if (/(birds-eye|top-down)/.test(s)) return "top";
  if (/high-angle/.test(s)) return "high";
  if (/(low-angle|worms-eye)/.test(s)) return "low";
  return "eye";
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Install AC Film Mode on the live page and expose `window.__film` (SPEC §3).
 * Idempotent: a second call with the same liveScene3d returns the same api
 * (and re-publishes it on window.__film).
 *
 * deps: `{liveScene3d, THREE, sessionHandle, wasmExports, particleCull, log}` (the seam;
 * `particleCull` = particle_manager.js `{setParticleCullConfig, allParticleManagers}`,
 * each optional), plus test / tool overrides: `window`, `document`, `canvas`, `VideoEncoder`,
 * `VideoFrame`, `requestAnimationFrame`, `modules` ({timeRng, fxTime, sceneryTime,
 * vfxCatalog} — a given key, even null, skips that dynamic import), `worldQuery`,
 * `filmProps` (boolean: replaces the `?filmProps=on` read), `lensOverlay` (an overlay
 * instance replacing the one built from THREE + liveScene3d.renderer).
 * The world query reads the client's VFX catalog (`../vfx_catalog.js`, dynamic import:
 * scenery archetype → tree vs rock, DAT bounds) and `wasmExports.fetchSetupSelectionSphere`
 * (other Setups' sizes) through world_query `createStaticCatalogs`.
 *
 * The api: `version`, `status()`, `clean(on=true, {bubbles})`, `own()`, `release()`,
 * `pose(pose)`, `world.{teleport, command, ready, prewarm, avatar, look, restoreLook, actor}`,
 * `query.{subject, near, groundZ}`, `techniques({family})`, `scout(shot, {count, stills,
 * width, intent})`, `prepare(take)`, `rehearse({fps, render})`, `shoot({fps, width, height,
 * codec, bitrate, mode, locked, includeTable})`, `recorder.{drain({maxBytes}), stats()}`,
 * `abort()`, `logs({limit})`, `dispose()`. Every method returns JSON-safe output and
 * `{ok:false, error}` instead of throwing; pose, release, world.teleport and world.command
 * answer `{ok:false, error:{code:'FILM_BUSY'}}` while a take, prepare, shoot, rehearse or scout runs.
 * rehearse / shoot reports carry prepare's `validation` and `flight` (+ the run's craft
 * `tracking`). scout and prepare report the live sun
 * (`sun: {available, reason, headingDeg, pitchDeg}`); scout lists `warnings` (an
 * `intent.light` without a usable sun); prepare's summary carries `liveSubject` (how a
 * moving subject re-anchors the take) and, for drone / fpv, `flight` (+ an `overspeed`
 * validation issue with `minDurationSec` when the preset cannot fly the path: too fast, or —
 * dry-flown through the flight model — too sharp for its acceleration; `limitedBy`,
 * `dryFlight`, `minDurationCheck` 'verified' | 'unverified' | 'failed').
 *
 * @param {{liveScene3d?:object, THREE?:object, sessionHandle?:object, wasmExports?:object,
 *   particleCull?:{setParticleCullConfig?:Function, allParticleManagers?:Function},
 *   log?:(entry:object)=>void, window?:object|null, document?:object|null, canvas?:object,
 *   VideoEncoder?:Function, VideoFrame?:Function, requestAnimationFrame?:Function,
 *   modules?:{timeRng?:object|null, fxTime?:object|null, sceneryTime?:object|null, vfxCatalog?:object|null},
 *   worldQuery?:object, filmProps?:boolean, lensOverlay?:object}} [deps]
 * @returns {object} the window.__film api
 */
export function installFilmMode(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : (win && isObj(win.liveScene3d) ? win.liveScene3d : null);
  if (!live) throw new FilmError("installFilmMode: liveScene3d is required (pass it, or install after window.liveScene3d exists)", "BAD_ARGUMENT");
  const existing = INSTALLED.get(live);
  if (existing) {
    if (win && win.__film !== existing) win.__film = existing;
    return existing;
  }
  const doc = d.document !== undefined ? d.document : (win && win.document) || (typeof document !== "undefined" ? document : null);
  const sh = d.sessionHandle ?? live.sessionHandle ?? (win ? win.__sessionHandle : null) ?? null;
  const wasm = d.wasmExports ?? live.wasmExports ?? null;

  // ---- logging ----------------------------------------------------------------
  const ring = [];
  let warned = 0;
  const log = (entry) => {
    const e = isObj(entry) ? entry : { message: String(entry) };
    ring.push(e);
    if (ring.length > LOG_RING) ring.shift();
    if (typeof d.log === "function") {
      try {
        d.log(e);
      } catch (_) {
        /* a logger never breaks film mode */
      }
      return;
    }
    if ((e.level === "warn" || e.level === "error") && warned < WARN_BUDGET && typeof console !== "undefined") {
      warned += 1;
      // eslint-disable-next-line no-console
      console.warn(`[film] ${e.event ?? "film"}: ${e.message ?? ""}`);
    }
  };

  // ---- components ---------------------------------------------------------------
  // particle_manager.js seams (index.js passes the resident module's exports; each optional).
  const pc = isObj(d.particleCull) ? d.particleCull : {};
  const particleCull = typeof pc.setParticleCullConfig === "function" ? { setParticleCullConfig: pc.setParticleCullConfig } : null;
  const allParticleManagers = typeof pc.allParticleManagers === "function" ? pc.allParticleManagers : null;
  const cameraOwner = createCameraOwner({ liveScene3d: live, THREE: d.THREE ?? null, sessionHandle: sh, window: win, log });
  const cleanFrame = createCleanFrame({ document: doc, window: win, liveScene3d: live, log });
  // Static placement catalogs (review r2-perception): the client's VFX descriptor catalog
  // (scene3d/vfx_catalog.js — imports nothing; this dynamic import returns the SAME module
  // instance the client's statics bake fills) gives scenery its archetype (tree vs rock) and
  // catalogued models their DAT bounds; the wasm Setup selection sphere sizes the rest.
  // Read-only: film mode never loads the catalog itself (createStaticCatalogs).
  // deps.modules.vfxCatalog (even null) replaces the import.
  const mods = isObj(d.modules) ? d.modules : {};
  let vfxCatalog = null;
  const vfxReady = (Object.prototype.hasOwnProperty.call(mods, "vfxCatalog")
    ? Promise.resolve(mods.vfxCatalog)
    : import("../vfx_catalog.js"))
    .then((m) => {
      vfxCatalog = m && typeof m.vfxDescriptorFor === "function" ? m : null;
      return vfxCatalog !== null;
    })
    .catch((e) => {
      log({ event: "film-install", level: "warn", message: `could not load the VFX catalog (scenery reads as rock): ${e && e.message ? e.message : e}` });
      return false;
    });
  const staticCatalogs = createStaticCatalogs({
    descriptorFor: (did) => (vfxCatalog ? vfxCatalog.vfxDescriptorFor(did) : null),
    ready: vfxReady,
    selectionSphere: wasm && typeof wasm.fetchSetupSelectionSphere === "function" ? (id) => wasm.fetchSetupSelectionSphere(id) : null,
  });
  const worldQuery = d.worldQuery && isObj(d.worldQuery)
    ? d.worldQuery
    : createWorldQuery({
      liveScene3d: live,
      sessionHandle: sh,
      wasmExports: wasm,
      THREE: d.THREE ?? null,
      catalogs: staticCatalogs,
      getLocalPlayerGuid: () => (win && typeof win.getLocalPlayerGuid === "function" ? win.getLocalPlayerGuid() : 0),
      log,
      // Every registered manager (world + static), not only the ones the facade / owner registry reach.
      ...(allParticleManagers
        ? { particles: createParticlesQuery({ liveScene3d: live, THREE: d.THREE ?? null, managers: () => allParticleManagers() }) }
        : {}),
    });
  const particles = worldQuery.particles && isObj(worldQuery.particles) ? worldQuery.particles : null;
  const sensors = createSensors({ worldQuery, sh, los: LOS.segmentBlocked, particles, log });
  const safety = createSafety({ sh, worldQuery, los: LOS, particles, liveScene3d: live, log });
  const look = createLook({ liveScene3d: live, sessionHandle: sh, window: win, log });
  const world = createWorld({
    liveScene3d: live,
    sessionHandle: sh,
    window: win,
    worldQuery,
    corridor: worldQuery.corridor,
    wasmExports: wasm,
    log,
    // A teleport leaves the previous site's film viewer cell behind: park it so cells.js
    // follows the player-head walk (viewer-indoor / sealed-dungeon state of the NEW site)
    // during ready / prewarm. Never under a running take (its cell carry stays intact).
    parkViewerCell: () => {
      if (cameraBusy()) return false;
      return cameraOwner.parkCell().parked;
    },
  });
  const bridge = createPageBridge({ window: win, mode: "stepped", log });

  // Time sources: module-scoped seams in the hooks lane's modules (typeof-guarded;
  // a stale build without them just leaves that clock on the wall).
  const given = isObj(d.modules) ? d.modules : {};
  const pick = async (key, loader, fn) => {
    if (Object.prototype.hasOwnProperty.call(given, key)) return given[key] && typeof given[key] === "object" ? given[key] : null;
    try {
      const m = await loader();
      return m && typeof m[fn] === "function" ? m : null;
    } catch (e) {
      log({ event: "film-install", level: "warn", message: `could not load the ${key} time source: ${e && e.message ? e.message : e}` });
      return null;
    }
  };
  let clock = null;
  const modulesReady = Promise.all([
    pick("timeRng", () => import("../particles/time_rng.js"), "setCurrentTime"),
    pick("fxTime", () => import("../particles/particle_fx.js"), "setFxTimeSource"),
    pick("sceneryTime", () => import("../animated_scenery.js"), "setSceneryTimeSource"),
  ]).then(([timeRng, fxTime, sceneryTime]) => {
    clock = createFilmClock({ fps: 30, liveScene3d: live, timeRng, fxTime, sceneryTime, sessionHandle: sh, window: win, look, log });
    return { timeRng: !!timeRng, fxTime: !!fxTime, sceneryTime: !!sceneryTime };
  }).catch((e) => {
    log({ event: "film-install", level: "warn", message: `film clock setup failed: ${e && e.message ? e.message : e}` });
    return { timeRng: false, fxTime: false, sceneryTime: false, error: String(e && e.message ? e.message : e) };
  });
  let timeSources = null;
  modulesReady.then((r) => {
    timeSources = r;
  });

  const pilotFactory = (cfg) => {
    const c = isObj(cfg) ? cfg : {};
    bridge.configure({ mode: c.captureMode === "realtime" ? "realtime" : "stepped" });
    const mapperOpts = { bounds: c.bounds };
    for (const k of ["commitSec", "overrideRisk", "staleSec", "minConfidence"]) if (Number.isFinite(c[k])) mapperOpts[k] = c[k];
    // take.pilot.limits (mapper DEFAULT_MAPPER_LIMITS keys) and pilot.fade: 'never' (nothing is
    // ever faded: maxFadeIds 0, a 'fade' answer reroutes) reach the residual mapper.
    const limits = isObj(c.limits) ? { ...c.limits } : null;
    if (c.fade === "never") mapperOpts.limits = { ...(limits || {}), maxFadeIds: 0 };
    else if (limits) mapperOpts.limits = limits;
    return createPilot({
      bridge,
      mode: c.mode,
      decisionHz: c.decisionHz,
      maxInFlight: c.maxInFlight,
      minDispatchSec: c.minDispatchSec,
      consult: isObj(c.consult) ? c.consult : undefined,
      reuseSec: c.reuseSec,
      mapper: createResidualMapper(mapperOpts),
      log,
      timeoutSec: JEV_BRIDGE_TIMEOUTS.realtime / 1000,
      // The page bridge answers 'timeout' at 15 s; the pilot's own limit sits just above it.
      steppedTimeoutMs: JEV_BRIDGE_TIMEOUTS.stepped + 500,
    });
  };
  const canvasOf = () => {
    if (d.canvas && typeof d.canvas === "object") return d.canvas;
    const r = live.renderer;
    if (r && r.domElement && typeof r.domElement === "object") return r.domElement;
    try {
      return doc && typeof doc.getElementById === "function" ? doc.getElementById("canvas") : null;
    } catch (_) {
      return null;
    }
  };
  const recorderFactory = (o) => createRecorder({
    canvas: canvasOf(),
    fps: o.fps,
    width: o.width,
    height: o.height,
    codec: o.codec,
    bitrate: o.bitrate,
    keyIntervalSec: o.keyIntervalSec,
    VideoEncoder: d.VideoEncoder !== undefined ? d.VideoEncoder : (win && typeof win.VideoEncoder === "function" ? win.VideoEncoder : undefined),
    VideoFrame: d.VideoFrame !== undefined ? d.VideoFrame : (win && typeof win.VideoFrame === "function" ? win.VideoFrame : undefined),
    log,
  });
  // The FPV props lens overlay: built on the first take that asks for it (THREE + the live renderer).
  let lensOverlay = isObj(d.lensOverlay) ? d.lensOverlay : null;
  const lensOverlayOf = () => {
    if (lensOverlay) return lensOverlay;
    const r = live.renderer;
    if (!d.THREE || !r || typeof r.render !== "function") return null;
    lensOverlay = createLensOverlay({ THREE: d.THREE, renderer: r, log });
    return lensOverlay;
  };
  const propsEnabled = () => (typeof d.filmProps === "boolean" ? d.filmProps : filmPropsEnabled());
  const takePlayer = createTakePlayer({
    cameraOwner,
    clock: () => clock,
    sensors,
    pilot: pilotFactory,
    safety,
    recorder: recorderFactory,
    drone: FLIGHT,
    worldQuery,
    log,
    window: win,
    liveScene3d: live,
    particles,
    buildShot: SHOTS.buildShot,
    actor: (cue) => world.actor(cue),
    requestAnimationFrame: typeof d.requestAnimationFrame === "function" ? d.requestAnimationFrame : undefined,
    particleCull,
    lensOverlay: lensOverlayOf,
    propsEnabled,
  });

  // ---- state --------------------------------------------------------------------
  let busy = null;
  let shootPending = false;
  let prevRecorder = null;
  let lastReport = null;
  let preparedTake = null;
  let disposed = false;

  /**
   * The long operation that holds the camera and the world right now — a running take, or a
   * prepare / shoot / rehearse / scout call (also while it waits before its take starts, and
   * through prepare's own awaits: the runtime, the live subject / sun / route it resolves) —
   * else null. pose, release, world.teleport and world.command refuse with FILM_BUSY while it
   * runs: a teleport or an admin command mid-take would record across a site change, and one
   * during prepare would move the world under the subject, sun and route it is reading.
   */
  function cameraBusy() {
    if (busy === "prepare" || busy === "shoot" || busy === "rehearse" || busy === "scout") return busy;
    return takePlayer.running ? "a take" : null;
  }

  /** Throw FILM_BUSY for `what` while cameraBusy(). */
  function refuseWhileBusy(what) {
    const b = cameraBusy();
    if (b) throw new FilmError(`${what}: ${b} is running — abort() it and wait for status().active === false first`, "FILM_BUSY");
  }

  async function exclusive(name, fn) {
    if (disposed) throw new FilmError("film mode was disposed", "FILM_DISPOSED");
    if (busy) throw new FilmError(`film is busy (${busy} is running)`, "FILM_BUSY");
    busy = name;
    try {
      return await fn();
    } finally {
      busy = null;
    }
  }

  async function ready() {
    await modulesReady;
    if (!clock) throw new FilmError("the film clock could not be created", "FILM_RENDER_UNAVAILABLE");
  }

  // ---- take resolution (plan Take → ShotContext) ----------------------------------

  function resolveAnchor(a) {
    const v = vec3(a);
    if (v) return v;
    if (isObj(a) && a.cell !== undefined && a.local !== undefined) {
      const l = vec3(a.local);
      if (!l) throw new FilmError(`take.anchor.local must be a finite [x, y, z] (got ${JSON.stringify(a.local)})`, "FILM_BAD_TAKE");
      return worldFromLocal(parseCellId(a.cell), l[0], l[1], l[2]);
    }
    return null;
  }

  /**
   * A per-frame cached live subject function for a moving entity / walking player:
   * "where is it NOW" (it ignores any t). Never handed to the shot builders —
   * the take player re-anchors the nominal to it every frame (take.liveSubject).
   */
  function liveSubject(ref, ov) {
    let lastKey;
    let last = null;
    return () => {
      const key = live.frameTime && Number.isFinite(live.frameTime.tsMs) ? live.frameTime.tsMs : undefined;
      if (last && key !== undefined && key === lastKey) return last;
      const f = worldQuery.subject(ref);
      if (f && vec3(f.pos)) {
        last = { pos: f.pos.slice(), radius: ov.radius ?? f.radius, height: ov.height ?? f.height, guid: f.guid };
        if (Number.isFinite(f.heading)) last.heading = f.heading;
        if (vec3(f.velocity)) last.velocity = f.velocity.slice();
        lastKey = key;
      }
      return last;
    };
  }

  /**
   * The live sun as ShotContext.sun `{h, p}` (radians: compass bearing TOWARD the
   * sun, clockwise from north, and elevation): from the sky snapshot the client
   * takes every frame (`skyLightingController._lastState`), else one
   * `sessionHandle.getSkyState()` read (copied, then freed). SkyState's
   * dirHeading / dirPitch are DEGREES, heading clockwise from +Y north toward
   * the sun (particle_fx / cloud_volume / sun_direction read them so; the d.ts
   * "radians" note is wrong). Dereth's authored sun never sets (pitch floors at
   * 0.9°), so night is judged like the sky does (night_ramp) and gives no sun.
   * @returns {{sun:{h:number,p:number}|null, reason:string|null, headingDeg:number|null, pitchDeg:number|null}}
   */
  function sunNow() {
    let h = NaN;
    let p = NaN;
    let st = null;
    try {
      st = live.skyLightingController ? live.skyLightingController._lastState : null;
    } catch (_) {
      st = null;
    }
    if (isObj(st) && Number.isFinite(st.dirHeading) && Number.isFinite(st.dirPitch)) {
      h = +st.dirHeading;
      p = +st.dirPitch;
    } else if (sh && typeof sh.getSkyState === "function") {
      let s = null;
      try {
        s = sh.getSkyState();
        if (s) {
          h = Number(s.dirHeading);
          p = Number(s.dirPitch);
        }
      } catch (_) {
        h = NaN;
      } finally {
        if (s && typeof s.free === "function") {
          try {
            s.free();
          } catch (_) {
            /* already freed */
          }
        }
      }
    }
    if (!Number.isFinite(h) || !Number.isFinite(p)) return { sun: null, reason: "the sky state is not available yet", headingDeg: null, pitchDeg: null };
    let night = 0;
    try {
      night = nightFactorFromAuthoredPitch(p);
    } catch (_) {
      night = 0;
    }
    if (night >= SUN_NIGHT_LIMIT) return { sun: null, reason: "it is night (the sun is down)", headingDeg: h, pitchDeg: p };
    return { sun: { h: h * DEG, p: p * DEG }, reason: null, headingDeg: h, pitchDeg: p };
  }

  async function routeOf(route) {
    const from = parseCellId(route.fromCell);
    const to = parseCellId(route.toCell);
    const fetch = wasm && typeof wasm.fetchEnvCellsInLandblock === "function" ? wasm.fetchEnvCellsInLandblock : null;
    if (!fetch) throw new FilmError("indoor route: wasmExports.fetchEnvCellsInLandblock is unavailable (stale pkg?)", "FILM_NO_ROUTE_GRAPH");
    const graph = await buildStitchedGraphFromWasm([from, to], { fetchEnvCells: fetch });
    if (!graph) throw new FilmError(`indoor route: no EnvCell graph for ${hex32(from)} → ${hex32(to)}`, "FILM_NO_ROUTE_GRAPH");
    const fillet = Number.isFinite(route.fillet) && route.fillet >= 0 ? route.fillet : undefined;
    const p = planIndoorPath(graph, from, to, fillet === undefined ? {} : { fillet });
    return { points: p.points, info: { fromCell: hex32(from), toCell: hex32(to), cells: p.cells.map(hex32), length: p.length, search: p.search, points: p.points.length } };
  }

  /**
   * Plan Take (SPEC §5.2) → take player input: subject kinds resolved
   * (point / entity / player / path), anchor, path, indoor route
   * (planIndoorPath → ctx.indoor.route), ctx.sun outdoors (sunNow).
   * A live subject — an entity with `moving: true`, or the player when
   * `moving: true` or (unless `moving: false`) its actor cue walks or the take
   * captures realtime — gets a PURE reference track for the shot builders
   * (ctx.subject + ctx.subjectAt extrapolated by its velocity) and its live
   * function separately (`liveSubject`, re-anchored per frame by the take player).
   */
  async function resolveTake(take) {
    let spec = isObj(take.spec) ? take.spec : null;
    if (!spec && typeof take.technique === "string" && !take.table) {
      spec = { technique: take.technique, duration: take.duration, params: take.params, framing: take.framing, fov: take.fov, roll: take.roll, ease: take.ease, seed: take.seed };
      for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
    }
    const cap = isObj(take.capture) ? take.capture : {};
    const ctx = {};
    if (Number.isFinite(cap.width) && Number.isFinite(cap.height) && cap.width > 0 && cap.height > 0) ctx.aspect = cap.width / cap.height;
    if (Number.isFinite(cap.fps) && cap.fps > 0) ctx.fps = cap.fps;
    const anchor = resolveAnchor(take.anchor);
    if (anchor) ctx.anchor = anchor;
    let subjectGuid = 0;
    let subjectInfo = null;
    let liveFn = null;
    let subj = take.subject !== undefined && take.subject !== null ? take.subject : spec && spec.subject !== undefined ? spec.subject : null;
    if (subj === "player") subj = { kind: "player" };
    if (Array.isArray(subj)) subj = { kind: "point", pos: subj };
    if (isObj(subj)) {
      const kind = subj.kind ?? (vec3(subj.pos) ? "point" : null);
      if (kind === "point") {
        const pos = vec3(subj.pos);
        if (!pos) throw new FilmError("a point subject needs pos: [x, y, z]", "FILM_BAD_TAKE");
        ctx.subject = { pos, radius: Number.isFinite(subj.radius) && subj.radius > 0 ? subj.radius : POINT_SUBJECT.radius, height: Number.isFinite(subj.height) && subj.height > 0 ? subj.height : POINT_SUBJECT.height };
        if (Number.isFinite(subj.heading)) ctx.subject.heading = subj.heading;
        subjectInfo = { kind, pos };
      } else if (kind === "entity" || kind === "player") {
        const ref = kind === "player" ? "player" : subj.ref;
        const f = worldQuery.subject(ref);
        if (!f || !vec3(f.pos)) {
          // A replayed table flies without its subject when it left the scene; a shot cannot.
          if (!take.table) {
            throw new FilmError(`subject ${JSON.stringify(ref)} is not in the scene (not streamed in, or no such ${kind === "player" ? "player" : "entity"})`, "FILM_SUBJECT_NOT_FOUND");
          }
          subjectInfo = { kind, ref, missing: true };
        } else {
          const ov = { radius: Number.isFinite(subj.radius) && subj.radius > 0 ? subj.radius : undefined, height: Number.isFinite(subj.height) && subj.height > 0 ? subj.height : undefined };
          ctx.subject = { pos: f.pos.slice(), radius: ov.radius ?? f.radius, height: ov.height ?? f.height, guid: f.guid };
          if (Number.isFinite(f.heading)) ctx.subject.heading = f.heading;
          subjectGuid = Number.isFinite(f.guid) ? f.guid >>> 0 : 0;
          // The player is live when it walks in this take (its actor cue moves it) or the take
          // captures on the wall clock; an explicit `moving` wins either way.
          const isLive = subj.moving === true ||
            (kind === "player" && subj.moving !== false && (actorMoves(take.actor) || cap.mode === "realtime"));
          if (isLive) {
            const refTrack = referenceTrack(ctx.subject, f.velocity);
            if (refTrack) {
              const v = vec3(f.velocity);
              ctx.subject.velocity = [v[0], v[1], 0];
              ctx.subjectAt = refTrack;
            }
            liveFn = liveSubject(ref, ov);
          }
          subjectInfo = { kind, ref, guid: subjectGuid ? hex32(subjectGuid) : null, name: f.name ?? null, pos: f.pos, moving: isLive };
        }
      } else if (kind === "path") {
        if (!Array.isArray(subj.points) || subj.points.length < 2) throw new FilmError("a path subject needs points: [[x,y,z], …] (≥ 2)", "FILM_BAD_TAKE");
        ctx.path = subj.points;
        subjectInfo = { kind, points: subj.points.length };
      } else {
        throw new FilmError(`unknown subject kind ${JSON.stringify(subj.kind)} (point | entity | player | path)`, "FILM_BAD_TAKE");
      }
    }
    if (Array.isArray(take.path) && take.path.length >= 2) ctx.path = take.path;
    let routeInfo = null;
    if (isObj(take.route) && take.route.fromCell !== undefined && take.route.toCell !== undefined && !take.table) {
      const r = await routeOf(take.route);
      ctx.indoor = { route: r.points };
      routeInfo = r.info;
    } else if (take.indoor === true) {
      ctx.indoor = {};
    }
    // ShotContext.sun: the live sun outdoors (light intents, sun-side framing), none indoors.
    let sunInfo;
    if (ctx.indoor) sunInfo = { available: false, reason: "indoors", headingDeg: null, pitchDeg: null };
    else {
      const s = sunNow();
      if (s.sun) ctx.sun = s.sun;
      sunInfo = { available: !!s.sun, reason: s.reason, headingDeg: s.headingDeg, pitchDeg: s.pitchDeg };
    }
    return { spec, ctx, subjectGuid, subjectInfo, routeInfo, liveSubject: liveFn, sunInfo };
  }

  // ---- scout ----------------------------------------------------------------

  function captureStill(canvas, width, quality) {
    if (!canvas || typeof canvas.toDataURL !== "function") throw new FilmError("no canvas to capture a still from", "FILM_NO_CANVAS");
    const cw = Number(canvas.width) || 0, ch = Number(canvas.height) || 0;
    if (Number.isFinite(width) && width > 0 && cw > 0 && ch > 0 && width < cw && doc && typeof doc.createElement === "function") {
      const w = Math.round(width), h = Math.max(1, Math.round((width * ch) / cw));
      const c2 = doc.createElement("canvas");
      c2.width = w;
      c2.height = h;
      const g = typeof c2.getContext === "function" ? c2.getContext("2d") : null;
      if (g && typeof g.drawImage === "function" && typeof c2.toDataURL === "function") {
        g.drawImage(canvas, 0, 0, w, h);
        return c2.toDataURL("image/jpeg", quality);
      }
    }
    return canvas.toDataURL("image/jpeg", quality);
  }

  function measureCandidate(pose, subject, subjectGuid, framing, aspect, indoor) {
    if (typeof sensors.reset === "function") sensors.reset();
    const ctx = { subject: subject ? { ...subject, guid: subject.guid || subjectGuid || 0 } : null, framing, aspect, indoor };
    let sf = null;
    for (let i = 0; i < 2; i += 1) sf = sensors.sense({ ...pose, t: 0 }, ctx, 0);
    const m = {};
    if (sf && sf.subject && Number.isFinite(sf.subject.visibleFrac)) {
      m.visibleFrac = sf.subject.visibleFrac;
      if (sf.subject.occluderKind) m.occluderKind = sf.subject.occluderKind;
    }
    if (sf && sf.nearest) {
      m.clearance = Number.isFinite(sf.nearest.range) ? sf.nearest.range : Infinity;
      if (sf.nearest.kind) m.nearestKind = sf.nearest.kind;
    }
    let risk = 0;
    let fam = null;
    if (sf && sf.particles) {
      const lens = sf.particles.onLens;
      if (lens && Number.isFinite(lens.density) && lens.density > risk) {
        risk = lens.density;
        fam = lens.family ?? null;
      }
      for (const r of Array.isArray(sf.particles.inView) ? sf.particles.inView : []) {
        if (r && r.occludes && Number.isFinite(r.density) && r.density > risk) {
          risk = r.density;
          fam = r.family ?? null;
        }
      }
    }
    m.particleRisk = Math.max(0, Math.min(1, risk));
    if (fam) m.particleFamily = fam;
    return m;
  }

  async function scout(shotIn, optsIn) {
    const shot = parseArg(shotIn);
    if (!isObj(shot)) throw new FilmError("scout: the shot must be a take / ShotSpec object", "FILM_BAD_TAKE");
    const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
    return exclusive("scout", async () => {
      await ready();
      const count = Number.isInteger(o.count) ? Math.max(1, Math.min(SCOUT_DEFAULTS.maxCount, o.count)) : SCOUT_DEFAULTS.count;
      const width = Number.isFinite(o.width) && o.width > 0 ? o.width : SCOUT_DEFAULTS.stillWidth;
      const resolved = await resolveTake(shot);
      const spec = resolved.spec || {};
      const technique = spec.technique ?? shot.technique ?? null;
      const def = technique ? SHOTS.getTechnique(technique) : null;
      const intent = {
        framing: spec.framing ?? shot.framing ?? (def && def.defaultFraming) ?? "MS",
        angle: angleForTechnique(technique),
        ...(isObj(shot.intent) ? shot.intent : {}),
        ...(isObj(o.intent) ? o.intent : {}),
      };
      const ctx = { ...resolved.ctx, groundZ: (x, y) => worldQuery.groundZ(x, y) };
      const aspect = Number.isFinite(ctx.aspect) ? ctx.aspect : 16 / 9;
      const seed = seedOf(spec.seed ?? o.seed ?? hashString(JSON.stringify({ technique, count, anchor: ctx.anchor ?? null })));
      const subject = ctx.subject ?? null;
      const genOpts = { count, rng: mulberry32(seed) };
      if (Number.isFinite(spec.fov)) genOpts.fov = spec.fov;
      const cands = generateCandidates(intent, subject, ctx, genOpts);
      if (!cands.length) throw new FilmError("scout: no legal camera position for this intent (try another angle / framing)", "FILM_NO_CANDIDATES");
      const metrics = cands.map((pose) => candidateMetrics(pose, subject, ctx,
        measureCandidate(pose, subject, resolved.subjectGuid, intent.framing, aspect, !!ctx.indoor), intent));
      if (typeof sensors.reset === "function") sensors.reset();
      const ranked = rankCandidates(cands, metrics, intent);
      const rows = ranked.map((r, rank) => ({
        id: r.id,
        rank,
        index: r.index,
        ok: r.ok,
        cost: r.cost,
        reasons: r.reasons,
        words: r.words,
        description: r.words,
        pose: { pos: r.pose.pos, h: r.pose.h, p: r.pose.p, r: r.pose.r, q: r.pose.q, fov: r.pose.fov },
        metrics: r.metrics,
      }));
      let stills = null;
      if (o.stills === true) stills = await renderStills(rows, shot, width, seed);
      // A light intent is honoured only with a usable sun (outdoors, daytime, sky state read):
      // say so instead of ranking as if no light had been asked for.
      const warnings = [];
      if (intent.light !== undefined && intent.light !== null && intent.light !== "" && !ctx.sun) {
        warnings.push(`intent.light ${JSON.stringify(intent.light)} was ignored: no usable sun (${resolved.sunInfo ? resolved.sunInfo.reason : "unknown"})`);
      }
      return {
        ok: true,
        technique,
        intent,
        count: rows.length,
        subject: resolved.subjectInfo,
        sun: resolved.sunInfo,
        warnings,
        stills,
        candidates: rows,
        stats: cands.stats ? { ...cands.stats } : null,
      };
    });
  }

  async function renderStills(rows, shot, width, seed) {
    const canvas = canvasOf();
    const wasOwned = cameraOwner.owned;
    const before = wasOwned ? cameraOwner.currentPose() : null;
    if (!wasOwned) cameraOwner.own();
    const quality = SCOUT_DEFAULTS.jpegQuality;
    let armed = false;
    let captured = null;
    let captureError = null;
    const unsub = cameraOwner.onPostRender(() => {
      if (!armed) return;
      armed = false;
      try {
        captured = captureStill(canvas, width, quality);
      } catch (e) {
        captureError = String(e && e.message ? e.message : e);
      }
    });
    const out = { captured: 0, failed: 0 };
    let begun = false;
    // Every still is a cut to a new pose: re-run the RP6 particle cull on every frame so the
    // emitters around the candidate are live in its still (restored afterwards).
    let prevRecheck = null;
    if (particleCull) {
      try {
        const prev = particleCull.setParticleCullConfig({ recheckInterval: 1 });
        prevRecheck = prev && Number.isInteger(prev.recheckInterval) ? prev.recheckInterval : null;
      } catch (e) {
        log({ event: "film-scout", level: "warn", message: `setParticleCullConfig failed: ${e && e.message ? e.message : e}` });
      }
    }
    try {
      clock.begin({ fps: 30, seed });
      begun = true;
      for (const row of rows) {
        captured = null;
        captureError = null;
        try {
          cameraOwner.setCutCell(shot.cell ?? 0);
          if (!cameraOwner.write({ ...row.pose })) throw new FilmError("the camera rejected the candidate pose", "FILM_CAMERA_WRITE");
          for (let i = 0; i < SCOUT_DEFAULTS.stillFrames; i += 1) {
            armed = i === SCOUT_DEFAULTS.stillFrames - 1;
            await clock.step();
          }
          armed = false;
          if (captured) {
            row.still = captured;
            out.captured += 1;
          } else {
            row.stillError = captureError ?? "no frame was rendered";
            out.failed += 1;
          }
        } catch (e) {
          row.stillError = String(e && e.message ? e.message : e);
          out.failed += 1;
        }
      }
    } finally {
      armed = false;
      unsub();
      if (begun) {
        try {
          await clock.end();
        } catch (e) {
          log({ event: "film-scout", level: "warn", message: `clock.end failed: ${e && e.message ? e.message : e}` });
        }
      }
      if (prevRecheck !== null) {
        try {
          particleCull.setParticleCullConfig({ recheckInterval: prevRecheck });
        } catch (e) {
          log({ event: "film-scout", level: "warn", message: `restoring the particle recheckInterval failed: ${e && e.message ? e.message : e}` });
        }
      }
      if (wasOwned && before) cameraOwner.write(before);
      else if (!wasOwned) cameraOwner.release();
    }
    return out;
  }

  // ---- api ----------------------------------------------------------------------

  function status() {
    const tp = takePlayer.status();
    let clockStats = null;
    try {
      clockStats = clock ? clock.stats() : null;
    } catch (_) {
      clockStats = null;
    }
    const dof = win && isObj(win.__dof) ? win.__dof : null;
    return {
      ok: true,
      version: FILM_API_VERSION,
      active: busy !== null || takePlayer.running,
      busy,
      runtimeReady: clock !== null,
      timeSources: timeSources ? { ...timeSources } : null,
      cameraOwned: cameraOwner.owned,
      viewerCell: cameraOwner.owned ? hex32(cameraOwner.viewerCell()) : null,
      clean: cleanFrame.active,
      cleanState: cleanFrame.state(),
      take: {
        prepared: tp.prepared,
        running: tp.running,
        lastRun: tp.lastRun,
        hasRealisedTable: tp.hasRealisedTable,
        shotId: preparedTake ? preparedTake.shotId ?? null : null,
      },
      recorder: tp.recorder,
      pilot: lastReport ? lastReport.pilot : null,
      lastTake: lastReport ? { frames: lastReport.frames, realisedChecksum: lastReport.realisedChecksum, droppedFrames: lastReport.droppedFrames, safetyAdjustedFrames: lastReport.safety ? lastReport.safety.adjustedFrames : null } : null,
      clock: clockStats,
      look: look.snapshot(),
      flags: {
        filmMode: filmModeEnabled(),
        filmDof: filmDofEnabled(),
        filmProps: propsEnabled(),
        dof: !!dof,
        dofEnabled: dof ? !!dof.enabled : false,
        jevBridge: bridge.available,
      },
      bridge: bridge.stats(),
    };
  }

  async function prepare(takeIn) {
    const take = parseArg(takeIn);
    if (!isObj(take)) throw new FilmError("prepare: the take must be an object (a compiled Take, a ShotSpec or {table})", "FILM_BAD_TAKE");
    return exclusive("prepare", async () => {
      await ready();
      if (!cameraOwner.owned) {
        try {
          cameraOwner.own();
        } catch (e) {
          log({ event: "film-prepare", level: "info", message: `camera not owned yet: ${e && e.message ? e.message : e}` });
        }
      }
      const r = await resolveTake(take);
      const summary = takePlayer.prepare({
        spec: r.spec,
        table: take.table ?? null,
        ctx: r.ctx,
        liveSubject: r.liveSubject,
        subjectGuid: r.subjectGuid,
        pilot: isObj(take.pilot) ? take.pilot : {},
        capture: isObj(take.capture) ? take.capture : {},
        standingOrder: take.standingOrder,
        goal: take.goal,
        technique: take.technique,
        family: take.family,
        shotId: take.shotId,
        cell: take.cell ?? null,
        indoor: take.indoor === true,
        preRollSec: take.preRollSec,
        actor: take.actor ?? null,
        seed: take.seed ?? (r.spec ? r.spec.seed : undefined),
        overlay: isObj(take.overlay) ? take.overlay : null,
      });
      preparedTake = { shotId: typeof take.shotId === "string" ? take.shotId : null };
      // The take's look (defaults ← site ← shot) is applied once the take is valid:
      // the WHOLE look, so keys an earlier take set and this one omits are restored.
      const lookResult = isObj(take.look) ? look.apply(take.look) : null;
      return { ...summary, subject: r.subjectInfo, route: r.routeInfo, sun: r.sunInfo, look: lookResult };
    });
  }

  async function rehearse(optsIn) {
    const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
    return exclusive("rehearse", async () => {
      await ready();
      return takePlayer.rehearse({ fps: o.fps, render: o.render !== false, locked: o.locked === true, maxOverrun: o.maxOverrun });
    });
  }

  async function shootImpl(o) {
    return exclusive("shoot", async () => {
      await ready();
      let cleanApplied = false;
      if (o.clean !== false && !cleanFrame.active) {
        cleanFrame.apply({});
        cleanApplied = true;
      }
      const report = await takePlayer.shoot({
        fps: o.fps, width: o.width, height: o.height, codec: o.codec, bitrate: o.bitrate, keyIntervalSec: o.keyIntervalSec,
        mode: o.mode, locked: o.locked === true, includeTable: o.includeTable === true, maxOverrun: o.maxOverrun,
      });
      lastReport = report;
      return { ...report, cleanApplied };
    });
  }

  function shoot(optsIn) {
    const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
    if (busy || disposed) return Promise.resolve(failure(new FilmError(disposed ? "film mode was disposed" : `film is busy (${busy} is running)`, disposed ? "FILM_DISPOSED" : "FILM_BUSY")));
    // Synchronously, before the first await: a concurrent recorder.drain must wait for
    // THIS take's recorder instead of reporting the previous take as done.
    prevRecorder = takePlayer.currentRecorder();
    shootPending = true;
    return safeAsync(shootImpl)(o).finally(() => {
      shootPending = false;
    });
  }

  function drain(optsIn) {
    const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
    const rec = takePlayer.currentRecorder();
    if (shootPending && (!rec || rec === prevRecorder)) return { ok: true, chunks: [], done: false, stats: { state: "starting" } };
    if (!rec || typeof rec.drain !== "function") return { ok: true, chunks: [], done: true, stats: null };
    const r = rec.drain({ maxBytes: Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : undefined });
    return { ok: true, chunks: r.chunks, done: r.done, stats: r.stats };
  }

  function pose(poseIn, optsIn) {
    const p = parseArg(poseIn);
    if (!isObj(p)) throw new FilmError("pose: an AC pose object {pos, q | h,p,r, fov, focus?} is required", "BAD_ARGUMENT");
    const running = cameraBusy();
    if (running) throw new FilmError(`pose: ${running} is running`, "FILM_BUSY");
    const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
    if (!cameraOwner.owned) cameraOwner.own();
    if (p.cell !== undefined || o.cell !== undefined) cameraOwner.setCutCell(p.cell ?? o.cell);
    if (!cameraOwner.write(p)) throw new FilmError("pose: rejected (pos must be a finite [x, y, z] and q / h,p a finite orientation)", "BAD_ARGUMENT");
    return { ok: true, pose: cameraOwner.currentPose() };
  }

  function near(argIn) {
    const a = parseArg(argIn);
    if (!isObj(a)) throw new FilmError("query.near: {center:[x,y,z], radius, kinds?} is required", "BAD_ARGUMENT");
    const c = vec3(a.center);
    if (!c) throw new FilmError("query.near: center must be a finite [x, y, z]", "BAD_ARGUMENT");
    const radius = a.radius === undefined ? 10 : a.radius;
    if (!(Number.isFinite(radius) && radius >= 0)) throw new FilmError("query.near: radius must be a finite number ≥ 0", "BAD_ARGUMENT");
    const kinds = Array.isArray(a.kinds) && a.kinds.length ? a.kinds.map(String) : null;
    const want = (k) => !kinds || kinds.includes(k);
    const entities = worldQuery.entitiesNear(c, radius, kinds ? { kinds } : {});
    let statics = typeof worldQuery.staticsNearCached === "function" ? worldQuery.staticsNearCached(c, radius) : [];
    if (kinds) statics = statics.filter((s) => kinds.includes(s.kind));
    const parts = want("particles") ? worldQuery.particlesNear(c, radius) : [];
    return { ok: true, center: c, radius, entities, statics, particles: parts };
  }

  function groundZ(x, y) {
    let X = x, Y = y;
    const a = parseArg(x);
    if (Array.isArray(a)) [X, Y] = a;
    else if (isObj(a)) {
      X = a.x;
      Y = a.y;
    }
    if (!Number.isFinite(X) || !Number.isFinite(Y)) throw new FilmError("query.groundZ: finite x, y (AC world metres) are required", "BAD_ARGUMENT");
    const z = worldQuery.groundZ(X, Y);
    if (!Number.isFinite(z)) return { ok: false, error: { name: "FilmError", code: "FILM_NO_GROUND", message: `no ground height known at (${X}, ${Y}) yet (the corridor fetch was queued)` }, code: "FILM_NO_GROUND", x: X, y: Y };
    return { ok: true, x: X, y: Y, z };
  }

  function subjectQuery(ref) {
    const r = parseArg(ref);
    if (r === undefined || r === null || r === "") throw new FilmError("query.subject: a guid, \"0x…\" guid, name, 'player' or {guid|name} is required", "BAD_ARGUMENT");
    const f = worldQuery.subject(r);
    if (!f) return { ok: false, error: { name: "FilmError", code: "FILM_SUBJECT_NOT_FOUND", message: `no subject ${JSON.stringify(r)} in the scene` }, code: "FILM_SUBJECT_NOT_FOUND" };
    return { ok: true, subject: { ...f, guidHex: Number.isFinite(f.guid) ? hex32(f.guid) : null } };
  }

  function dispose() {
    takePlayer.abort();
    try {
      if (lensOverlay && typeof lensOverlay.dispose === "function" && lensOverlay !== d.lensOverlay) lensOverlay.dispose();
    } catch (_) {
      /* best effort */
    }
    try {
      cleanFrame.restore();
    } catch (_) {
      /* best effort */
    }
    try {
      if (!busy) cameraOwner.release();
    } catch (_) {
      /* best effort */
    }
    disposed = true;
    INSTALLED.delete(live);
    if (win && win.__film === api) {
      try {
        delete win.__film;
      } catch (_) {
        win.__film = undefined;
      }
    }
    return { ok: true, disposed: true };
  }

  const api = {
    version: FILM_API_VERSION,
    status: safeSync(status),
    clean: safeSync((on = true, optsIn) => {
      const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
      const flag = isObj(on) ? on.on !== false : on !== false;
      const bubbles = isObj(on) ? on.bubbles === true : o.bubbles === true;
      if (!flag) return { ok: true, on: false, ...cleanFrame.restore() };
      return { on: true, ...cleanFrame.apply({ bubbles }) };
    }),
    own: safeSync(() => ({ ...cameraOwner.own(), owned: cameraOwner.owned })),
    release: safeSync(() => {
      if (cameraBusy()) throw new FilmError("release: a take is running", "FILM_BUSY");
      return { ...cameraOwner.release(), owned: cameraOwner.owned };
    }),
    pose: safeSync(pose),
    world: {
      // Never mid-take (review tooling-2, defence in depth for the CLI's own check).
      teleport: safeSync((cmd) => {
        refuseWhileBusy("world.teleport");
        return world.teleport(cmd);
      }),
      command: safeSync((cmd) => {
        refuseWhileBusy("world.command");
        return world.command(cmd);
      }),
      ready: safeAsync(async (optsIn) => {
        const o = parseArg(optsIn);
        if (o !== undefined && o !== null && !isObj(o)) throw new FilmError("world.ready: options must be an object {lbKeys, interiorLb, settleSec, timeoutSec}", "BAD_ARGUMENT");
        return world.ready(o || {});
      }),
      prewarm: safeAsync(async (optsIn) => {
        const o = parseArg(optsIn);
        if (!isObj(o)) throw new FilmError("world.prewarm: options must be an object {points, radius, lbKeys?, interiorLb?}", "BAD_ARGUMENT");
        return world.prewarm(o);
      }),
      avatar: safeSync((visible) => world.avatar(visible !== false)),
      look: safeSync((lookIn) => look.apply(parseArg(lookIn))),
      restoreLook: safeSync(() => look.restore()),
      actor: safeAsync(async (cueIn) => world.actor(parseArg(cueIn))),
    },
    query: {
      subject: safeSync(subjectQuery),
      near: safeSync(near),
      groundZ: safeSync(groundZ),
    },
    techniques: safeSync((optsIn) => {
      const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
      const list = SHOTS.listTechniques(o.family !== undefined ? { family: o.family } : {});
      return { ok: true, version: FILM_API_VERSION, count: list.length, techniques: list };
    }),
    scout: safeAsync(scout),
    prepare: safeAsync(prepare),
    rehearse: safeAsync(rehearse),
    shoot,
    recorder: {
      drain: safeSync(drain),
      stats: safeSync(() => {
        const rec = takePlayer.currentRecorder();
        return { ok: true, stats: rec && typeof rec.stats === "function" ? rec.stats() : null };
      }),
    },
    abort: safeSync(() => takePlayer.abort()),
    logs: safeSync((optsIn) => {
      const o = isObj(parseArg(optsIn)) ? parseArg(optsIn) : {};
      const n = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, LOG_RING) : 50;
      return { ok: true, entries: ring.slice(-n) };
    }),
    dispose: safeSync(dispose),
  };
  Object.defineProperty(api, "__runtime", {
    enumerable: false,
    value: Object.freeze({ cameraOwner, cleanFrame, worldQuery, sensors, safety, look, world, bridge, takePlayer, clock: () => clock, ready: () => modulesReady }),
  });
  INSTALLED.set(live, api);
  if (win) win.__film = api;
  log({ event: "film-install", level: "info", message: `installed ${FILM_API_VERSION}` });
  return api;
}
