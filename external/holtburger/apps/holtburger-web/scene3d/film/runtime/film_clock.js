// scene3d/film/runtime/film_clock.js — the stepped film clock (SPEC §0 capture reality, §3 runtime/film_clock.js).
//
// WHY: the GTX 1070 renders 22–31 fps at mid quality, so smooth 1080p/ultra
// footage cannot be recorded in real time. A stepped take instead HOLDS the
// realtime loop and renders every frame on demand with an explicit timestamp:
// frame k is drawn at `tsMs = base + (k+1)·1000/fps`, so tick() derives
// dt = 1/fps exactly (index.js clamps dt to 0.1 s, so fps ≥ 10 is exact), and
// the recorder grabs the canvas synchronously in postRender. Everything that
// animates on its own clock must follow the film clock for the take, or smoke,
// sway and flicker would run at wall speed between slow frames:
//   * particle simulation + PhysicsScript queues: time_rng `setCurrentTime`
//     (seconds) + a SEEDED `setRng` (repeatable takes);
//   * the particle FX shader time: particle_fx `setFxTimeSource` (ms);
//   * animated scenery sway: animated_scenery `setSceneryTimeSource` (ms);
//   * sky time of day (optional): `sessionHandle.setSkyTimeOverride(t)` every
//     step, advanced by a time-lapse rate in GAME-DAYS PER FILM SECOND.
// The FX and scenery sources are fed the frame TIMESTAMP (the performance.now()
// time base the loop already uses), not "milliseconds since the take began":
// emitters, script queues and the FX shader hold absolute timestamps from the
// realtime frames before the take, and a clock that jumped back to 0 would
// freeze emission until wall time caught up. The particle clock follows the
// base the emitters were stamped in: the frame timestamp in seconds, or under
// `?particleClock=sim` (the CLI boot default) the loop's sim clock
// `liveScene3d._particleSimNowS` captured at begin() plus the film time since
// (the sim clock lags wall time by every clamped hitch, so the wall base would
// jump it forward and kill every live particle at frame 0). `filmMs` (since
// begin) is what the take player samples trajectories with.
//
// One animation frame per film frame: step() publishes the upcoming frame time
// (clockMs, lastTs) and then waits for one requestAnimationFrame callback
// (50 ms setTimeout fallback for a throttled page; one MessageChannel task on a
// hidden page or a window without rAF) BEFORE it renders. The client's private
// rAF drivers (animated_scenery wind, statics billboards / static particles,
// the texture drains) therefore run exactly once per film frame on the film
// clock and see the frame's camera pose, and network / encoder output / CDP
// recorder drains interleave every frame instead of piling up behind one
// unbroken microtask chain.
//
// Hazards handled (SEAMS.md): `base` comes from `liveScene3d.frameTime.tsMs`
// (a wall-clock base after a long hold would trip the >0.5 s dt freeze);
// timestamps strictly increase (a realtime frame sneaking in before a step, or
// the loop's re-arm still pending from before the hold firing during the first
// step's yield, re-bases past it); tick() is async under syncPhysicsTick, so
// each step awaits the postRender of ITS frame (matched on frameTime.tsMs;
// a stale realtime postRender is ignored) with a timeout; end() waits until
// performance.now() is past the last timestamp (and past the film particle
// time under ?particleClock=sim) before restoring the wall clocks (so no clock
// runs backwards), clears holdLoop and re-arms the loop with one bare
// `__renderOnce()` ONLY when the realtime chain is dead (a step issued an
// explicit-ts render, which cancels the pending re-arm, or a realtime tick ran
// during the hold and parked). A begin()→end() with neither leaves the
// pre-hold re-arm queued: it resumes the loop, and a second re-arm would run
// two rAF chains (two ticks per vsync) for the rest of the session.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: dependencies injected
// ({fps, liveScene3d, timeRng, fxTime, sceneryTime, sessionHandle, window,
// look, now, sleep, setTimeout, clearTimeout, log}); never imports a stateful
// scene3d module. The frame logic is deterministic (seeded RNG, timestamps
// from the frame index); wall time is read only to wait out the hand-back in
// end(), to time out a lost frame and to bound the per-frame yield.

import { FilmError, FILM_ERROR_CODES } from "../core/errors.js";
import { mulberry32 } from "../core/rng.js";
import { ensureFilmHooks } from "./camera_owner.js";

/** Default capture rate (frames per film second). */
export const FILM_CLOCK_DEFAULT_FPS = 30;
/**
 * Accepted fps range (inclusive). The floor is 10: below it index.js clamps dt
 * to 0.1 s (frames would no longer advance by 1/fps), and at ≤ 2 fps the raw
 * frame gap reaches the 0.5 s recovery threshold, which freezes dt to 0 for 10
 * frames when the page is not booted with ?renderOnDemand=1.
 */
export const FILM_CLOCK_MIN_FPS = 10;
/** @see FILM_CLOCK_MIN_FPS */
export const FILM_CLOCK_MAX_FPS = 240;
/** Default wait (ms) for one stepped frame's postRender before step() rejects. */
export const FILM_CLOCK_STEP_TIMEOUT_MS = 15000;
/** Longest end() waits (ms) for performance.now() to pass the last film timestamp. */
export const FILM_CLOCK_MAX_HANDBACK_MS = 120000;
/**
 * The per-frame animation-frame yield gives up on requestAnimationFrame after this
 * many ms (a throttled / occluded page) and renders anyway. A rAF that never fires
 * therefore costs 50 ms per frame, never the 15 s step timeout.
 */
export const FILM_CLOCK_YIELD_FALLBACK_MS = 50;

/**
 * Named times of day (fraction of an AC day; noon = 0.5) — the look-pass values.
 * Shared with runtime/look.js.
 * @type {Readonly<Record<string, number>>}
 */
export const TIME_OF_DAY_PRESETS = Object.freeze({ night: 0.0, dawn: 0.21, morning: 0.33, noon: 0.5, golden: 0.82, dusk: 0.89 });

/**
 * A time of day in [0, 1): a finite number (1 wraps to 0; negatives wrap) or a
 * preset name (case-insensitive). null for anything else.
 * @param {number|string|null|undefined} v
 * @returns {number|null}
 */
export function parseTimeOfDay(v) {
  if (typeof v === "string") {
    const k = v.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TIME_OF_DAY_PRESETS, k)) return TIME_OF_DAY_PRESETS[k];
    if (k !== "" && Number.isFinite(Number(k))) return wrap01(Number(k));
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return wrap01(v);
  return null;
}

/** Wrap into [0, 1). */
function wrap01(t) {
  const x = t - Math.floor(t);
  return x >= 1 ? 0 : x;
}

/**
 * Time-lapse rate in game-days per film second from `{rate}` or a number; 0 when absent/invalid.
 * @param {*} tl
 * @returns {number}
 */
function lapseRate(tl) {
  if (typeof tl === "number" && Number.isFinite(tl)) return tl;
  if (tl && typeof tl === "object" && Number.isFinite(tl.rate)) return +tl.rate;
  return 0;
}

/**
 * Create the stepped film clock (SPEC §3).
 *
 * - `begin({seed, timeOfDay, timeLapse, fps})` → `{ok, fps, baseTsMs}`: holds the
 *   loop (`liveScene3d.film.holdLoop = true`), installs the film time sources
 *   (`timeRng.setCurrentTime` + seeded `setRng`, `fxTime.setFxTimeSource`,
 *   `sceneryTime.setSceneryTimeSource`) and the optional sky time
 *   (`timeOfDay` 0..1 or a preset name; `timeLapse` = `{rate}` or a number, game
 *   days per film second; with a time-lapse but no timeOfDay the current sky
 *   time is the start). Under `?particleClock=sim` the particle clock continues
 *   from `liveScene3d._particleSimNowS` (sim base + film time since begin), else it
 *   reads the frame timestamp in seconds. Throws FilmError `FILM_CLOCK_ACTIVE`
 *   when already begun.
 * - `step()` → `Promise<{frame, filmMs, tsMs, dt}>`: frame k (0-based) at
 *   `filmMs = k·1000/fps`. Synchronously publishes the frame (`clockMs`, sky,
 *   `stats().lastTsMs`), then yields one animation frame (rAF, 50 ms fallback),
 *   re-bases past a realtime frame that landed meanwhile, and renders with
 *   `window.__renderOnce(tsMs)` (strictly increasing `tsMs`); resolves on that
 *   frame's postRender. Rejects with FilmError `FILM_CLOCK_IDLE` (not begun),
 *   `FILM_CLOCK_BUSY` (a step in flight), `FILM_RENDER_UNAVAILABLE` (no
 *   __renderOnce), `FILM_RENDER_FAILED` or `FILM_FRAME_TIMEOUT`.
 * - `now()` → film seconds of the last stepped frame (0 before the first).
 * - `end({keepSky})` → `Promise<{ok, frames, lastTsMs, waitedMs, rearmed}>`: waits
 *   for an in-flight step, waits until `performance.now()` passes `lastTs` (and,
 *   under `?particleClock=sim`, the film particle time), restores every time
 *   source (the particle clock goes back to the `?particleClock=sim` loop clock,
 *   moved up to the film particle time and never back, when that mode is on,
 *   else to the wall clock), restores the sky (to `look.activeTimeOfDay()` when a
 *   look keeps a time of day, untouched with `keepSky`, else NaN = clear), clears
 *   `holdLoop` and, only when the realtime rAF chain is dead (a step rendered, or
 *   a realtime tick ran during the hold), calls a bare `__renderOnce()` to
 *   re-arm it. Idempotent.
 * - `active`, `frame`, `fps`, `skyTime()` (the sky t of the last step or null),
 *   `stats()`.
 *
 * @param {{fps?:number, liveScene3d:object, timeRng?:object|null, fxTime?:object|null,
 *   sceneryTime?:object|null, sessionHandle?:object|null, window?:object|null,
 *   look?:object|null, now?:()=>number, sleep?:(ms:number)=>Promise<void>,
 *   setTimeout?:Function, clearTimeout?:Function, stepTimeoutMs?:number,
 *   log?:(entry:object)=>void}} deps
 * @returns {object}
 */
export function createFilmClock(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : null;
  if (!live) throw new FilmError("createFilmClock: liveScene3d is required", FILM_ERROR_CODES.BAD_ARGUMENT);
  const defaultFps = validFps(d.fps === undefined ? FILM_CLOCK_DEFAULT_FPS : d.fps);
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const timeRng = d.timeRng && typeof d.timeRng === "object" ? d.timeRng : null;
  const fxTime = d.fxTime && typeof d.fxTime === "object" ? d.fxTime : null;
  const sceneryTime = d.sceneryTime && typeof d.sceneryTime === "object" ? d.sceneryTime : null;
  const look = d.look && typeof d.look === "object" ? d.look : null;
  const setT = typeof d.setTimeout === "function" ? d.setTimeout : (typeof setTimeout === "function" ? setTimeout : null);
  const clearT = typeof d.clearTimeout === "function" ? d.clearTimeout : (typeof clearTimeout === "function" ? clearTimeout : null);
  const stepTimeoutMs = Number.isFinite(d.stepTimeoutMs) && d.stepTimeoutMs > 0 ? d.stepTimeoutMs : FILM_CLOCK_STEP_TIMEOUT_MS;
  const nowMs = typeof d.now === "function"
    ? d.now
    : () => {
      const perf = (win && win.performance) || (typeof performance !== "undefined" ? performance : null);
      return perf && typeof perf.now === "function" ? perf.now() : 0;
    };
  const sleep = typeof d.sleep === "function"
    ? d.sleep
    : (ms) => new Promise((resolve) => {
      if (setT) setT(resolve, Math.max(0, ms));
      else resolve();
    });
  const emitLog = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-clock", ...entry });
    } catch (_) {
      /* never break the clock on a logger */
    }
  };
  const sh = () => {
    const h = d.sessionHandle ?? live.sessionHandle ?? null;
    return h && (typeof h === "object" || typeof h === "function") ? h : null;
  };

  const st = {
    active: false,
    fps: defaultFps,
    interval: 1000 / defaultFps,
    base: 0, // re-based past an intruding realtime frame
    base0: 0, // the base at begin() (never re-based): film particle time is measured from it
    heldTs: null, // liveScene3d.frameTime.tsMs at begin() (null when unstamped)
    n: 0, // steps since `base`
    frame: -1, // last stepped (published) film frame
    lastTs: -Infinity,
    clockMs: 0, // what the time sources read
    rng: null,
    sky: null, // {t0, rate, last}
    simMode: false,
    simBase: null, // ?particleClock=sim: liveScene3d._particleSimNowS at begin(), else null
    issued: 0, // explicit-ts __renderOnce calls this hold (each cancels a pending re-arm)
    /** @type {null|{tsMs:number, resolve:Function, reject:Function, timer:*}} */
    pending: null,
    /** @type {Promise|null} */
    inflight: null,
    unsubPost: null,
    installed: { time: false, rng: false, fx: false, scenery: false },
  };
  const counters = {
    steps: 0, staleRenders: 0, timeouts: 0, rebases: 0, skySets: 0, skyFailures: 0,
    yields: 0, yieldFallbacks: 0, rearms: 0, rearmsSkipped: 0,
  };

  function validFps(f) {
    if (!(typeof f === "number" && Number.isFinite(f) && f >= FILM_CLOCK_MIN_FPS && f <= FILM_CLOCK_MAX_FPS)) {
      throw new FilmError(`film clock: fps must be a number in [${FILM_CLOCK_MIN_FPS}, ${FILM_CLOCK_MAX_FPS}] (got ${f})`, FILM_ERROR_CODES.BAD_ARGUMENT);
    }
    return f;
  }

  /** The last stamped frame timestamp, or null. */
  function frameTs() {
    const ft = live.frameTime;
    return ft && typeof ft === "object" && Number.isFinite(ft.tsMs) ? ft.tsMs : null;
  }

  /** Read the current normalised sky time (wasm SkyState copied + freed), or null. */
  function readSkyTime() {
    const h = sh();
    if (!h || typeof h.getSkyState !== "function") return null;
    let s = null;
    try {
      s = h.getSkyState();
      const t = s ? s.timeOfDayNormalized : undefined;
      return Number.isFinite(t) ? wrap01(t) : null;
    } catch (_) {
      return null;
    } finally {
      if (s && typeof s === "object" && typeof s.free === "function") {
        try {
          s.free();
        } catch (_) {
          /* already released */
        }
      }
    }
  }

  /** setSkyTimeOverride(t) — returns the wasm boolean (false before the SkyDesc lands). */
  function setSky(t) {
    const h = sh();
    if (!h || typeof h.setSkyTimeOverride !== "function") return false;
    try {
      return h.setSkyTimeOverride(t) !== false;
    } catch (_) {
      return false;
    }
  }

  /** Force the 15 s retail terrain light tick to re-light (time-lapse / first frame). */
  function relightTerrain() {
    if (!win) return;
    try {
      if (typeof win.__setTerrainLightScale === "function" && typeof win.__terrainLightState === "function") {
        const s = win.__terrainLightState();
        if (s && Number.isFinite(s.scale)) win.__setTerrainLightScale(s.scale);
      }
    } catch (_) {
      /* cosmetic */
    }
  }

  /**
   * The film particle time (s). `?particleClock=sim`: the sim clock captured at
   * begin() plus the film time since (measured from `base0`, so a re-base adds
   * exactly the intruding realtime frame's gap — continuous, as tick() saw it).
   * Otherwise the frame timestamp in seconds (wall-based emitters).
   */
  function filmParticleSeconds() {
    return st.simBase !== null ? st.simBase + (st.clockMs - st.base0) / 1000 : st.clockMs / 1000;
  }

  /** Install the film time sources (read `st.clockMs`). */
  function installSources(seed) {
    const msFn = () => st.clockMs;
    const secFn = filmParticleSeconds;
    if (timeRng && typeof timeRng.setCurrentTime === "function") {
      timeRng.setCurrentTime(secFn);
      st.installed.time = true;
    }
    if (timeRng && typeof timeRng.setRng === "function") {
      st.rng = mulberry32(seed);
      const rng = st.rng;
      timeRng.setRng(() => rng());
      st.installed.rng = true;
    }
    if (fxTime && typeof fxTime.setFxTimeSource === "function") {
      fxTime.setFxTimeSource(msFn);
      st.installed.fx = true;
    }
    if (sceneryTime && typeof sceneryTime.setSceneryTimeSource === "function") {
      sceneryTime.setSceneryTimeSource(msFn);
      st.installed.scenery = true;
    }
  }

  /** Restore every installed source (after the hand-back wait). */
  function restoreSources() {
    if (st.installed.time && timeRng) {
      if (st.simMode) {
        // ?particleClock=sim: re-install the loop-owned clock index.js installed at
        // boot, moved up to where the take left the particle clock and never back
        // (monotonic for emitters / script queues). The film particle time is on
        // the sim base, so this never pushes the sim clock toward wall time.
        const film = filmParticleSeconds();
        const cur = live._particleSimNowS;
        live._particleSimNowS = Number.isFinite(cur) ? Math.max(cur, film) : film;
        timeRng.setCurrentTime(() => live._particleSimNowS);
      } else {
        timeRng.setCurrentTime(null);
      }
    }
    if (st.installed.rng && timeRng) timeRng.setRng(null);
    if (st.installed.fx && fxTime) fxTime.setFxTimeSource(null);
    if (st.installed.scenery && sceneryTime) sceneryTime.setSceneryTimeSource(null);
    st.installed = { time: false, rng: false, fx: false, scenery: false };
  }

  /** True when the page reports itself hidden (rAF never fires; timers clamp to ~1 s). */
  function pageHidden() {
    try {
      return !!(win && win.document && win.document.visibilityState === "hidden");
    } catch (_) {
      return false;
    }
  }

  /**
   * Yield one animation frame (seams-0). Resolves with "raf" on the next
   * requestAnimationFrame callback, "fallback" after FILM_CLOCK_YIELD_FALLBACK_MS
   * when rAF is throttled (the pending rAF is cancelled), or "task" after one
   * macrotask on a hidden page / a window without rAF (MessageChannel: hidden
   * pages throttle timers, not message tasks), else after a setTimeout(0) or, with
   * no timer at all, a microtask ("none").
   * @returns {Promise<"raf"|"fallback"|"task"|"none">}
   */
  function yieldFrame() {
    return new Promise((resolve) => {
      let done = false;
      let rafId = null;
      let timer = null;
      const fin = (how) => {
        if (done) return;
        done = true;
        if (how !== "raf" && rafId !== null && win && typeof win.cancelAnimationFrame === "function") {
          try {
            win.cancelAnimationFrame(rafId);
          } catch (_) {
            /* already gone */
          }
        }
        if (how !== "fallback" && timer !== null && clearT) {
          try {
            clearT(timer);
          } catch (_) {
            /* already fired */
          }
        }
        resolve(how);
      };
      if (win && typeof win.requestAnimationFrame === "function" && !pageHidden()) {
        let ok = false;
        try {
          rafId = win.requestAnimationFrame(() => fin("raf")); // called as a method (`this` = window)
          ok = true;
        } catch (_) {
          rafId = null;
        }
        if (ok) {
          if (setT) timer = setT(() => fin("fallback"), FILM_CLOCK_YIELD_FALLBACK_MS);
          return;
        }
      }
      const MC = win && typeof win.MessageChannel === "function"
        ? win.MessageChannel
        : (typeof MessageChannel === "function" ? MessageChannel : null);
      if (MC) {
        try {
          const ch = new MC();
          ch.port1.onmessage = () => {
            try {
              ch.port1.close();
            } catch (_) {
              /* closed */
            }
            fin("task");
          };
          ch.port2.postMessage(0);
          return;
        } catch (_) {
          /* fall through to a timer */
        }
      }
      if (setT) {
        setT(() => fin("task"), 0);
        return;
      }
      Promise.resolve().then(() => fin("none"));
    });
  }

  /** Settle the pending frame promise from a postRender. */
  function onPostRender() {
    const p = st.pending;
    if (!p) return;
    const ts = frameTs();
    if (ts !== null && ts !== p.tsMs) {
      counters.staleRenders += 1;
      return;
    }
    st.pending = null;
    if (p.timer !== null && clearT) clearT(p.timer);
    p.resolve();
  }

  function begin(opts = {}) {
    if (st.active) throw new FilmError("film clock already running (call end() first)", "FILM_CLOCK_ACTIVE");
    const o = opts && typeof opts === "object" ? opts : {};
    const fps = o.fps === undefined ? defaultFps : validFps(o.fps);
    const hooks = ensureFilmHooks(live, { log: d.log });
    st.fps = fps;
    st.interval = 1000 / fps;
    const ft = frameTs();
    const wall = nowMs();
    st.base = ft !== null ? ft : (Number.isFinite(wall) ? wall : 0);
    st.base0 = st.base;
    st.heldTs = ft;
    st.issued = 0;
    st.n = 0;
    st.frame = -1;
    st.lastTs = st.base;
    st.clockMs = st.base;
    st.simMode = !!((timeRng && typeof timeRng.particleClockMode === "function" && safeCall(() => timeRng.particleClockMode()) === "sim")
      || Number.isFinite(live._particleSimNowS));
    // ?particleClock=sim: emitters and script queues hold timestamps on the sim
    // base, which lags wall time; the film particle clock continues from it.
    st.simBase = st.simMode && Number.isFinite(live._particleSimNowS) ? live._particleSimNowS : null;
    // Sky time.
    const t0 = o.timeOfDay === undefined || o.timeOfDay === null ? null : parseTimeOfDay(o.timeOfDay);
    if (o.timeOfDay !== undefined && o.timeOfDay !== null && t0 === null) {
      throw new FilmError(`film clock: bad timeOfDay ${JSON.stringify(o.timeOfDay)} (0..1 or ${Object.keys(TIME_OF_DAY_PRESETS).join("/")})`,
        FILM_ERROR_CODES.BAD_ARGUMENT);
    }
    const rate = lapseRate(o.timeLapse);
    st.sky = null;
    if (t0 !== null || rate !== 0) {
      const start = t0 !== null ? t0 : (readSkyTime() ?? safeCall(() => look && look.activeTimeOfDay && look.activeTimeOfDay()) ?? 0.5);
      st.sky = { t0: Number.isFinite(start) ? start : 0.5, rate, last: null, relit: false };
    }
    installSources(o.seed === undefined ? 0 : o.seed);
    st.unsubPost = hooks.addPostRender(onPostRender);
    hooks.holdLoop = true;
    st.active = true;
    emitLog({ message: "begin", fps, baseTsMs: st.base, sky: st.sky ? { t0: st.sky.t0, rate } : null, simMode: st.simMode, simBaseS: st.simBase });
    return { ok: true, fps, baseTsMs: st.base, sky: st.sky ? { t0: st.sky.t0, rate } : null };
  }

  function step() {
    if (!st.active) return Promise.reject(new FilmError("film clock: step() before begin()", "FILM_CLOCK_IDLE"));
    if (st.inflight) return Promise.reject(new FilmError("film clock: a step is already in flight", "FILM_CLOCK_BUSY"));
    const render = win && typeof win.__renderOnce === "function" ? win.__renderOnce : null;
    if (!render) {
      return Promise.reject(new FilmError("film clock: window.__renderOnce is unavailable (index.js seam missing)", "FILM_RENDER_UNAVAILABLE"));
    }
    const hooks = ensureFilmHooks(live, { log: d.log });
    hooks.holdLoop = true;
    // A frame stamped after our last timestamp (a realtime frame that slipped in
    // before the hold took effect) → re-base past it so dt stays 1/fps.
    const ft0 = frameTs();
    if (ft0 !== null && ft0 > st.lastTs) {
      st.base = ft0;
      st.n = 0;
      st.lastTs = ft0; // the engine's last frame: dt is measured from it
      counters.rebases += 1;
    }
    const frame = st.frame + 1;
    const filmMs = frame * st.interval;
    let from = st.lastTs; // the engine's last frame timestamp
    let ts = st.base + (st.n + 1) * st.interval;
    if (!(ts > from)) ts = from + st.interval;
    // Publish the upcoming frame BEFORE the yield: the client's private rAF
    // drivers read the film time sources during it, and callers read
    // stats().lastTsMs (take_player's grab match) as soon as step() returns.
    st.n += 1;
    st.lastTs = ts;
    st.clockMs = ts;
    st.frame = frame;
    counters.steps += 1;
    if (st.sky) {
      const t = wrap01(st.sky.t0 + st.sky.rate * (filmMs / 1000));
      st.sky.last = t;
      if (setSky(t)) counters.skySets += 1;
      else counters.skyFailures += 1;
      if (st.sky.rate !== 0 || !st.sky.relit) {
        relightTerrain();
        st.sky.relit = true;
      }
    }
    const run = async () => {
      // seams-0: one animation frame per film frame, so rAF-paced subsystems
      // (scenery wind, billboards, static particles, texture drains) advance
      // between film frames and CDP / encoder callbacks interleave.
      const how = await yieldFrame();
      counters.yields += 1;
      if (how === "fallback") counters.yieldFallbacks += 1;
      // A realtime frame that landed during the yield — on the first step, the
      // loop's re-arm still pending from before the hold (registered before our
      // rAF, so it runs first and parks on holdLoop) — re-base past it: ts stays
      // strictly increasing and tick() still derives dt = 1/fps. The film time
      // sources only move forward (ft + interval > the published ts).
      const ft = frameTs();
      if (ft !== null && ft > from) {
        st.base = ft;
        st.n = 1;
        from = ft;
        ts = ft + st.interval;
        st.lastTs = ts;
        st.clockMs = ts;
        counters.rebases += 1;
      }
      const dt = (ts - from) / 1000;
      const promise = new Promise((resolve, reject) => {
        const p = { tsMs: ts, resolve, reject, timer: null };
        if (setT) {
          p.timer = setT(() => {
            if (st.pending !== p) return;
            st.pending = null;
            counters.timeouts += 1;
            reject(new FilmError(`film clock: frame ${frame} (ts ${ts.toFixed(3)} ms) did not render within ${stepTimeoutMs} ms`,
              "FILM_FRAME_TIMEOUT"));
          }, stepTimeoutMs);
        }
        st.pending = p;
      });
      // An explicit-ts __renderOnce under holdLoop cancels any re-arm still
      // pending (index.js _cancelSchedule): from here on the realtime chain is dead.
      st.issued += 1;
      try {
        const ok = render(ts);
        if (ok === false) throw new Error("__renderOnce returned false");
      } catch (e) {
        const p = st.pending;
        st.pending = null;
        if (p && p.timer !== null && clearT) clearT(p.timer);
        const err = new FilmError(`film clock: __renderOnce(${ts}) failed: ${e && e.message ? e.message : e}`, "FILM_RENDER_FAILED");
        if (p) p.reject(err);
      }
      await promise;
      return { frame, filmMs, tsMs: ts, dt };
    };
    st.inflight = run().then(
      (out) => {
        st.inflight = null;
        return out;
      },
      (err) => {
        st.inflight = null;
        throw err;
      },
    );
    return st.inflight;
  }

  async function end(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    if (!st.active) return { ok: true, frames: 0, lastTsMs: null, waitedMs: 0, wasActive: false };
    if (st.inflight) {
      try {
        await st.inflight;
      } catch (_) {
        /* a failed last frame does not block the hand-back */
      }
    }
    // Wait until wall time passes the last film timestamp, so no clock that the
    // realtime loop reads after the hand-back runs backwards. Under
    // ?particleClock=sim also past the film particle time: loop.js caps the sim
    // clock at wall time (min(prev + dt, now)), so a sim clock handed back ahead
    // of wall time would be pulled back on the next realtime tick.
    const handbackMs = Math.max(st.lastTs, st.simBase !== null ? filmParticleSeconds() * 1000 : -Infinity);
    const t0 = nowMs();
    let waited = 0;
    while (Number.isFinite(handbackMs) && !(nowMs() > handbackMs) && waited < FILM_CLOCK_MAX_HANDBACK_MS) {
      const gap = Math.min(250, Math.max(1, handbackMs - nowMs() + 1));
      await sleep(gap);
      waited = nowMs() - t0;
      if (!Number.isFinite(waited)) break;
    }
    restoreSources();
    // Sky: back to the look's time of day, untouched, or cleared.
    if (st.sky && o.keepSky !== true) {
      const keep = safeCall(() => look && typeof look.activeTimeOfDay === "function" ? look.activeTimeOfDay() : null);
      setSky(Number.isFinite(keep) ? keep : NaN);
      relightTerrain();
    }
    if (st.unsubPost) st.unsubPost();
    st.unsubPost = null;
    const frames = st.frame + 1;
    const lastTsMs = st.lastTs;
    // seams-6: re-arm only a DEAD realtime chain. A step's explicit-ts render
    // cancelled the pre-hold re-arm, and a realtime tick that ran during the
    // hold parked on holdLoop (scheduleNext) — either way nothing is queued.
    // With neither (begin → end with no step and no realtime frame since: an
    // abort while the recorder starts, a pre-roll pose rejected at i = 0, every
    // scout candidate rejected) the pre-hold re-arm is still pending and resumes
    // the loop by itself; a bare __renderOnce() would arm a second chain (two
    // ticks per vsync for the rest of the session). A tick mid-hop under
    // syncPhysicsTick has not stamped frameTime yet and re-arms at its own
    // scheduleNext, which runs after holdLoop is cleared below.
    const chainDead = st.issued > 0 || frameTs() !== st.heldTs;
    st.active = false;
    st.sky = null;
    st.rng = null;
    st.issued = 0;
    const hooks = ensureFilmHooks(live, { log: d.log });
    hooks.holdLoop = false;
    let rearmed = false;
    const render = win && typeof win.__renderOnce === "function" ? win.__renderOnce : null;
    if (chainDead && render) {
      try {
        render();
        rearmed = true;
        counters.rearms += 1;
      } catch (e) {
        emitLog({ level: "warn", message: `re-arm __renderOnce() threw: ${e && e.message ? e.message : e}` });
      }
    } else if (!chainDead) {
      counters.rearmsSkipped += 1;
    }
    emitLog({ message: "end", frames, lastTsMs, waitedMs: Math.max(0, waited), rearmed });
    return { ok: true, frames, lastTsMs, waitedMs: Math.max(0, waited), wasActive: true, rearmed };
  }

  return {
    begin,
    step,
    end,
    now: () => (st.frame >= 0 ? (st.frame * st.interval) / 1000 : 0),
    get active() {
      return st.active;
    },
    get frame() {
      return st.frame;
    },
    get fps() {
      return st.fps;
    },
    /** The timestamp (ms, performance.now base) the film time sources currently return. */
    clockMs: () => st.clockMs,
    /** The film particle time (s) the installed particle clock returns (sim base under ?particleClock=sim). */
    particleTimeS: () => filmParticleSeconds(),
    skyTime: () => (st.sky && st.sky.last !== null ? st.sky.last : null),
    stats: () => ({
      ...counters,
      active: st.active,
      frame: st.frame,
      fps: st.fps,
      lastTsMs: Number.isFinite(st.lastTs) ? st.lastTs : null,
      simBaseS: st.simBase,
    }),
  };
}

/** Call fn, returning undefined if it throws. */
function safeCall(fn) {
  try {
    return fn();
  } catch (_) {
    return undefined;
  }
}
