// scene3d/film/runtime/look.js — per-shot look: time of day, weather, fog, exposure, grade, bloom, vignette, DoF
// (SPEC §3 world.look / world.restoreLook, §5.1 owner decision: depth of field ships in v1).
//
// WHY: the director writes a mood per site/shot ("golden hour", "white fog",
// "cool night grade", "shallow focus") and expects it applied before the take
// and fully undone afterwards — the same browser plays the next site, and the
// person on the 1070 may open it later. Every control already exists as a live
// client handle (recon_particles §3–5, recon_world §3); this module maps the
// plan's `look` object onto them and snapshots each touched value first:
//   timeOfDay  `sessionHandle.setSkyTimeOverride(t)` (0..1, or dawn 0.21 /
//              morning 0.33 / noon 0.5 / golden 0.82 / dusk 0.89 / night 0);
//              restored to the boot `?skytime` pin (`window.__skyTimePin`) or
//              NaN (= clear). The terrain light is forced to re-light
//              (`__setTerrainLightScale(cur)`), else the ground keeps the old
//              light up to 15 s;
//   dayGroup   `setGameDayOverride(day, year)` (AC weather sky set); cleared
//              with (0xFFFFFFFF, 0xFFFFFFFF);
//   fog        `window.__environFogOverride` = an object with exactly the
//              shape environ_override.js `environFogFor(option)` returns
//              (white 3, red 1, blue 2, green 4, black 5; 'none' = null); the
//              original object is put back on restore. environ_override.js
//              reads a NEW object identity as a new AdminEnvirons message and
//              restarts its retail roll-in (transition 0 → 1 over ~20 s of
//              wall-clock fog ticks), so a fog that is already showing — the
//              same option and row, or 'none' over no override — keeps its
//              object: re-applying a look (the CLI prepares a take again after
//              its rehearsal; later shots at the same site) is a no-op
//              (`changed: false`). A real change assigns a fresh object
//              (`changed: true`) and the take player waits, bounded, until the
//              roll-in has settled before it records (take_player.js
//              `waitEnvironSettled`, reported as `environ` in the take report).
//              `?environRetail=off` is NOT used: it changes the retail fog;
//   exposure   `__setExposure(v)` (read back from renderer.toneMappingExposure);
//   grade      `window.__grade.day/.night/.off` with the presets below;
//   bloom      `__setBloomIntensity` / `__setBloomThreshold` (null-safe: the
//              effect is absent below quality mid);
//   vignette   `__setVignetteDarkness` / `__setVignetteOffset` (null-safe);
//   dof        `window.__dof` {enabled, focusDistance, focusRange, bokehScale}
//              — only with `?filmDof=on`; a clean, reported no-op without it.
// Each apply() is the WHOLE look of a take: keys a previous apply touched that
// the new look omits go back to their originals (unless `merge: true`).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: dependencies injected
// ({liveScene3d, sessionHandle, window, log}); never imports a stateful scene3d
// module. Deterministic: no clocks.

import { TIME_OF_DAY_PRESETS, parseTimeOfDay } from "./film_clock.js";

/** Look keys this module understands (the plan schema's LOOK_KEYS). */
export const LOOK_KEYS = Object.freeze(["timeOfDay", "dayGroup", "fog", "exposure", "grade", "bloom", "vignette", "dof"]);

/** Named times of day (re-exported from film_clock.js). */
export const LOOK_TIME_PRESETS = TIME_OF_DAY_PRESETS;

/** `look.fog` name → AdminEnvirons option (EnvironChangeType 0x01..0x05). */
export const LOOK_FOG_OPTIONS = Object.freeze({ red: 0x01, blue: 0x02, white: 0x03, green: 0x04, black: 0x05 });

/**
 * The AdminEnvirons fog rows, verbatim from scene3d/environ_override.js
 * ENVIRON_FOG (decoded from acclient.c Handle_Admin__Environs); film code may
 * not import that module, so the rows are mirrored here and the film suite
 * pins them to `environFogFor`.
 * @type {Readonly<Record<number, Readonly<{name:string, fogRgb:number, fogMin:number, fogMax:number, ambRgb:number, ambLevel:number}>>>}
 */
export const LOOK_FOG_ROWS = Object.freeze({
  0x01: Object.freeze({ name: "RedFog", fogRgb: 0x960000, fogMin: 0, fogMax: 50, ambRgb: 0x960000, ambLevel: Math.fround(0.4) }),
  0x02: Object.freeze({ name: "BlueFog", fogRgb: 0x320096, fogMin: 0, fogMax: 50, ambRgb: 0x320096, ambLevel: Math.fround(0.3) }),
  0x03: Object.freeze({ name: "WhiteFog", fogRgb: 0x646464, fogMin: 0, fogMax: 30, ambRgb: 0x646464, ambLevel: Math.fround(0.4) }),
  0x04: Object.freeze({ name: "GreenFog", fogRgb: 0x1e6400, fogMin: 0, fogMax: 50, ambRgb: 0x1e6400, ambLevel: Math.fround(0.3) }),
  0x05: Object.freeze({ name: "BlackFog", fogRgb: 0x000000, fogMin: 0, fogMax: 40, ambRgb: 0x969696, ambLevel: Math.fround(0.8) }),
});

/**
 * A fresh fog override object for a look fog name (the environFogFor shape
 * `{option, name, fogRgb, fogMin, fogMax, ambRgb, ambLevel}`), null for 'none'.
 * Throws a RangeError for an unknown name.
 * @param {string} name
 * @returns {object|null}
 */
export function lookFogOverride(name) {
  const k = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (k === "none") return null;
  const opt = LOOK_FOG_OPTIONS[k];
  if (!opt) throw new RangeError(`look.fog must be one of none, ${Object.keys(LOOK_FOG_OPTIONS).join(", ")} (got ${JSON.stringify(name)})`);
  return { option: opt, ...LOOK_FOG_ROWS[opt] };
}

/** The AdminEnvirons row fields two fog overrides must share to be the same fog. */
const FOG_ROW_FIELDS = Object.freeze(["option", "fogRgb", "fogMin", "fogMax", "ambRgb", "ambLevel"]);

/**
 * True when the live override `cur` already shows the fog `want` (an
 * environFogFor-shaped object, or null for 'none'): then re-applying it must
 * keep `cur`'s identity, or environ_override.js restarts the roll-in.
 * @param {object|null|undefined} cur  window.__environFogOverride
 * @param {object|null} want           lookFogOverride(name)
 * @returns {boolean}
 */
export function sameFogOverride(cur, want) {
  if (want === null) return cur === null || cur === undefined;
  if (!cur || typeof cur !== "object" || !Number.isFinite(cur.fogRgb) || !want) return false;
  return FOG_ROW_FIELDS.every((k) => cur[k] === want[k]);
}

const g3 = (v) => Object.freeze([v, v, v]);

/**
 * Grade presets — full `__grade` parameter sets (color_grade.js: wb, tint,
 * lift, gain, gamma, contrast, pivot, saturation, vibrance), applied to BOTH
 * the day and the night set so the look holds whatever the sky's night
 * fraction. neutral = identity (no creative grade); warm = golden, lifted
 * reds; cool = steel blue; bleach = bleach-bypass (low saturation, hard
 * contrast); night = day-for-night (blue cast, crushed gain, desaturated).
 * @type {Readonly<Record<string, Readonly<object>>>}
 */
export const GRADE_PRESETS = Object.freeze({
  neutral: Object.freeze({ wb: g3(1), tint: g3(1), lift: g3(0), gain: g3(1), gamma: g3(1), contrast: 1.0, pivot: 0.42, saturation: 1.0, vibrance: 0.0 }),
  warm: Object.freeze({
    wb: Object.freeze([1.08, 1.0, 0.88]), tint: Object.freeze([1.02, 1.0, 0.95]), lift: Object.freeze([0.012, 0.006, 0.0]),
    gain: Object.freeze([1.02, 1.0, 0.97]), gamma: g3(1), contrast: 1.1, pivot: 0.42, saturation: 1.08, vibrance: 0.22,
  }),
  cool: Object.freeze({
    wb: Object.freeze([0.92, 0.99, 1.09]), tint: Object.freeze([0.96, 1.0, 1.05]), lift: Object.freeze([0.0, 0.004, 0.016]),
    gain: Object.freeze([0.98, 1.0, 1.03]), gamma: g3(1), contrast: 1.06, pivot: 0.42, saturation: 0.94, vibrance: 0.1,
  }),
  bleach: Object.freeze({
    wb: g3(1), tint: g3(1), lift: g3(0.02), gain: g3(1.03), gamma: g3(0.95), contrast: 1.32, pivot: 0.45, saturation: 0.42, vibrance: 0.0,
  }),
  night: Object.freeze({
    wb: Object.freeze([0.86, 0.95, 1.14]), tint: Object.freeze([0.72, 0.86, 1.22]), lift: Object.freeze([0.004, 0.008, 0.024]),
    gain: Object.freeze([0.82, 0.84, 0.9]), gamma: Object.freeze([1.08, 1.06, 1.0]), contrast: 1.12, pivot: 0.3, saturation: 0.5, vibrance: 0.0,
  }),
});

/** Sentinel that clears setGameDayOverride. */
const DAY_CLEAR = 0xffffffff;

/** Deep, JSON-safe copy of a grade param set (arrays copied). */
function copyGrade(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) out[k] = Array.from(v);
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Create the look controller.
 *
 * - `apply(look, {merge=false})` → `{ok, applied:{key:{ok, value?, skipped?, error?}}, errors[], warnings[]}`
 *   (never throws; unknown keys are warnings; a failed key is an error and the
 *   others still apply). The FIRST touch of a key snapshots its original.
 *   `applied.fog.changed` is false when the fog already showing was kept
 *   (same override object: no roll-in restart), true when a new one was set.
 * - `restore()` → `{ok, restored:[keys]}`: every touched key back to its
 *   original; idempotent.
 * - `snapshot()` → `{active, look, saved}` JSON-safe (the applied look and the
 *   saved originals).
 * - `activeTimeOfDay()` → the applied time of day (0..1) or null — the film
 *   clock re-asserts it after a take instead of clearing the sky.
 *
 * @param {{liveScene3d?:object|null, sessionHandle?:object|null, window?:object|null,
 *   log?:(entry:object)=>void}} deps
 * @returns {{apply:Function, restore:Function, snapshot:Function, activeTimeOfDay:Function}}
 */
export function createLook(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const live = d.liveScene3d && typeof d.liveScene3d === "object" ? d.liveScene3d : null;
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const sh = () => {
    const h = d.sessionHandle ?? (live ? live.sessionHandle : null) ?? null;
    return h && (typeof h === "object" || typeof h === "function") ? h : null;
  };
  const emitLog = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-look", ...entry });
    } catch (_) {
      /* never break the look on a logger */
    }
  };

  /** key → saved original (only keys touched since the last restore). */
  const saved = new Map();
  /** The currently applied look values (normalised). */
  let current = {};

  const pipeline = () => (live && live.atmospherePipeline) || (win && win.__atmospherePipeline) || null;
  const fn = (name) => (win && typeof win[name] === "function" ? win[name] : null);

  // ---- per-key snapshot / set / restore ------------------------------------

  const handlers = {
    timeOfDay: {
      snap() {
        const pin = win ? win.__skyTimePin : undefined;
        return { pin: typeof pin === "number" && Number.isFinite(pin) && pin >= 0 && pin < 1 ? pin : null };
      },
      set(v) {
        const t = parseTimeOfDay(v);
        if (t === null) throw new RangeError(`timeOfDay must be 0..1 or one of ${Object.keys(TIME_OF_DAY_PRESETS).join(", ")} (got ${JSON.stringify(v)})`);
        const h = sh();
        if (!h || typeof h.setSkyTimeOverride !== "function") return { ok: false, skipped: "sessionHandle.setSkyTimeOverride unavailable", value: t };
        const ok = h.setSkyTimeOverride(t) !== false;
        relight();
        const out = { ok, value: t };
        if (!ok) out.note = "setSkyTimeOverride returned false (sky description not loaded yet)";
        if (optionOn(5)) out.warning = "character option 'Always daylight outdoors' (0x05) is on and re-pins noon every 250 ms";
        return out;
      },
      restore(s) {
        const h = sh();
        if (h && typeof h.setSkyTimeOverride === "function") h.setSkyTimeOverride(s && s.pin !== null ? s.pin : NaN);
        relight();
      },
    },
    dayGroup: {
      snap() {
        return { cleared: true };
      },
      set(v) {
        if (!v || typeof v !== "object" || !Number.isInteger(v.day) || !Number.isInteger(v.year) || v.day < 0 || v.year < 0) {
          throw new RangeError(`dayGroup must be {day, year} non-negative integers (got ${JSON.stringify(v)})`);
        }
        const h = sh();
        if (!h || typeof h.setGameDayOverride !== "function") return { ok: false, skipped: "sessionHandle.setGameDayOverride unavailable" };
        const ok = h.setGameDayOverride(v.day >>> 0, v.year >>> 0) !== false;
        return { ok, value: { day: v.day, year: v.year } };
      },
      restore() {
        const h = sh();
        if (h && typeof h.setGameDayOverride === "function") h.setGameDayOverride(DAY_CLEAR, DAY_CLEAR);
      },
    },
    fog: {
      snap() {
        return { value: win ? win.__environFogOverride ?? null : null };
      },
      set(v) {
        if (!win) return { ok: false, skipped: "no window" };
        const o = lookFogOverride(v);
        const value = o ? o.name : "none";
        // The fog already showing keeps its object: a new identity restarts the
        // ~20 s retail roll-in (environ_override.js sync → transition 0).
        if (sameFogOverride(win.__environFogOverride, o)) return { ok: true, value, changed: false };
        win.__environFogOverride = o;
        return { ok: true, value, changed: true };
      },
      restore(s) {
        if (win) win.__environFogOverride = s ? s.value : null;
      },
    },
    exposure: {
      snap() {
        const r = live && live.renderer;
        return { value: r && Number.isFinite(r.toneMappingExposure) ? r.toneMappingExposure : null };
      },
      set(v) {
        if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) throw new RangeError(`exposure must be a number > 0 (got ${JSON.stringify(v)})`);
        const f = fn("__setExposure");
        if (!f) return { ok: false, skipped: "window.__setExposure unavailable (composer not ready)" };
        return { ok: true, value: f(v) };
      },
      restore(s) {
        const f = fn("__setExposure");
        if (f && s && s.value !== null) f(s.value);
      },
    },
    grade: {
      snap() {
        const g = win && win.__grade;
        if (!g || typeof g !== "object") return null;
        return { day: copyGrade(g.day), night: copyGrade(g.night), off: !!g.off };
      },
      set(v) {
        const k = typeof v === "string" ? v.trim().toLowerCase() : "";
        const preset = GRADE_PRESETS[k];
        if (!preset) throw new RangeError(`grade must be one of ${Object.keys(GRADE_PRESETS).join(", ")} (got ${JSON.stringify(v)})`);
        const g = win && win.__grade;
        if (!g || typeof g !== "object") return { ok: false, skipped: "window.__grade unavailable (?grade=off or composer not ready)" };
        g.day = copyGrade(preset);
        g.night = copyGrade(preset);
        g.off = false;
        return { ok: true, value: k };
      },
      restore(s) {
        const g = win && win.__grade;
        if (!g || !s) return;
        if (s.day) g.day = s.day;
        if (s.night) g.night = s.night;
        g.off = !!s.off;
      },
    },
    bloom: {
      snap() {
        const b = pipeline() && pipeline().bloom;
        if (!b) return { intensity: null, threshold: null };
        const th = b.luminanceMaterial && Number.isFinite(b.luminanceMaterial.threshold) ? b.luminanceMaterial.threshold : null;
        return { intensity: Number.isFinite(b.intensity) ? b.intensity : null, threshold: th };
      },
      set(v) {
        const spec = typeof v === "number" ? { intensity: v } : v;
        if (!spec || typeof spec !== "object") throw new RangeError(`bloom must be a number (intensity) or {intensity?, threshold?} (got ${JSON.stringify(v)})`);
        const out = { ok: true, value: {} };
        if (spec.intensity !== undefined) {
          if (!(Number.isFinite(spec.intensity) && spec.intensity >= 0)) throw new RangeError(`bloom.intensity must be ≥ 0 (got ${spec.intensity})`);
          const f = fn("__setBloomIntensity");
          const r = f ? f(spec.intensity) : null;
          if (r === null || r === undefined) return { ok: false, skipped: "bloom effect not built (quality preset below mid)" };
          out.value.intensity = r;
        }
        if (spec.threshold !== undefined) {
          if (!Number.isFinite(spec.threshold)) throw new RangeError(`bloom.threshold must be finite (got ${spec.threshold})`);
          const f = fn("__setBloomThreshold");
          const r = f ? f(spec.threshold) : null;
          if (r === null || r === undefined) return { ok: false, skipped: "bloom effect not built (quality preset below mid)" };
          out.value.threshold = r;
        }
        return out;
      },
      restore(s) {
        if (!s) return;
        const fi = fn("__setBloomIntensity");
        const ft = fn("__setBloomThreshold");
        if (fi && s.intensity !== null) fi(s.intensity);
        if (ft && s.threshold !== null) ft(s.threshold);
      },
    },
    vignette: {
      snap() {
        const v = pipeline() && pipeline().vignette;
        if (!v) return { darkness: null, offset: null };
        return { darkness: Number.isFinite(v.darkness) ? v.darkness : null, offset: Number.isFinite(v.offset) ? v.offset : null };
      },
      set(v) {
        const spec = typeof v === "number" ? { darkness: v } : v;
        if (!spec || typeof spec !== "object") throw new RangeError(`vignette must be a number (darkness) or {darkness?, offset?} (got ${JSON.stringify(v)})`);
        const out = { ok: true, value: {} };
        for (const [k, name] of [["darkness", "__setVignetteDarkness"], ["offset", "__setVignetteOffset"]]) {
          if (spec[k] === undefined) continue;
          if (!Number.isFinite(spec[k])) throw new RangeError(`vignette.${k} must be finite (got ${spec[k]})`);
          const f = fn(name);
          const r = f ? f(spec[k]) : null;
          if (r === null || r === undefined) return { ok: false, skipped: "vignette effect not built (quality preset below high)" };
          out.value[k] = r;
        }
        return out;
      },
      restore(s) {
        if (!s) return;
        const fd = fn("__setVignetteDarkness");
        const fo = fn("__setVignetteOffset");
        if (fd && s.darkness !== null) fd(s.darkness);
        if (fo && s.offset !== null) fo(s.offset);
      },
    },
    dof: {
      snap() {
        const dof = win && win.__dof;
        if (!dof || typeof dof !== "object") return null;
        return {
          enabled: !!dof.enabled,
          focusDistance: Number.isFinite(dof.focusDistance) ? dof.focusDistance : null,
          focusRange: Number.isFinite(dof.focusRange) ? dof.focusRange : null,
          bokehScale: Number.isFinite(dof.bokehScale) ? dof.bokehScale : null,
          target: dof.target ?? null,
        };
      },
      set(v) {
        if (!v || typeof v !== "object") throw new RangeError(`dof must be {focusDistance?, focusRange?, bokehScale?, enabled?} (got ${JSON.stringify(v)})`);
        const dof = win && win.__dof;
        if (!dof || typeof dof !== "object") return { ok: false, skipped: "window.__dof unavailable (boot with ?filmDof=on)" };
        const value = {};
        // Values first, then enabled (one recompile, never per frame).
        for (const k of ["focusRange", "bokehScale", "focusDistance"]) {
          if (v[k] === undefined || v[k] === null) continue;
          dof[k] = v[k]; // the seam validates (RangeError / TypeError)
          value[k] = dof[k];
        }
        if (v.target !== undefined) {
          dof.target = v.target;
          value.target = v.target === null ? null : "set";
        }
        const en = v.enabled === undefined ? true : !!v.enabled;
        if (!!dof.enabled !== en) dof.enabled = en;
        value.enabled = !!dof.enabled;
        return { ok: true, value };
      },
      restore(s) {
        const dof = win && win.__dof;
        if (!dof || !s) return;
        for (const k of ["focusRange", "bokehScale", "focusDistance"]) {
          if (s[k] !== null && dof[k] !== s[k]) {
            try {
              dof[k] = s[k];
            } catch (_) {
              /* a value the seam no longer accepts */
            }
          }
        }
        try {
          dof.target = s.target;
        } catch (_) {
          /* target types the seam rejects */
        }
        if (!!dof.enabled !== s.enabled) dof.enabled = s.enabled;
      },
    },
  };

  function relight() {
    try {
      const set = fn("__setTerrainLightScale");
      const get = fn("__terrainLightState");
      if (set && get) {
        const s = get();
        if (s && Number.isFinite(s.scale)) set(s.scale);
      }
    } catch (_) {
      /* cosmetic */
    }
  }

  function optionOn(opt) {
    const h = sh();
    if (!h || typeof h.isCharacterOptionEnabled !== "function") return false;
    try {
      return h.isCharacterOptionEnabled(opt) === true;
    } catch (_) {
      return false;
    }
  }

  function restoreKey(k) {
    if (!saved.has(k)) return false;
    const s = saved.get(k);
    try {
      handlers[k].restore(s);
    } catch (e) {
      emitLog({ level: "warn", key: k, message: `restore failed: ${e && e.message ? e.message : e}` });
    }
    saved.delete(k);
    delete current[k];
    return true;
  }

  function apply(look, opts = {}) {
    const out = { ok: true, applied: {}, errors: [], warnings: [] };
    if (look !== null && look !== undefined && typeof look !== "object") {
      out.ok = false;
      out.errors.push({ key: null, message: "look must be an object" });
      return out;
    }
    const l = look || {};
    const merge = !!(opts && opts.merge);
    for (const k of Object.keys(l)) {
      if (!LOOK_KEYS.includes(k)) out.warnings.push({ key: k, message: `unknown look key "${k}" (known: ${LOOK_KEYS.join(", ")})` });
    }
    if (!merge) {
      for (const k of [...saved.keys()]) {
        if (l[k] === undefined || l[k] === null) restoreKey(k);
      }
    }
    for (const k of LOOK_KEYS) {
      const v = l[k];
      if (v === undefined || v === null) continue;
      if (!saved.has(k)) {
        try {
          saved.set(k, handlers[k].snap());
        } catch (_) {
          saved.set(k, null);
        }
      }
      try {
        const r = handlers[k].set(v);
        out.applied[k] = r;
        if (r && r.ok === false && r.skipped === undefined) out.warnings.push({ key: k, message: r.note || "not applied" });
        if (r && r.warning) out.warnings.push({ key: k, message: r.warning });
        // A requested time of day counts even before the sky description lands
        // (setSkyTimeOverride → false): the film clock keeps re-asserting it.
        if (r && (r.ok !== false || (k === "timeOfDay" && Number.isFinite(r.value)))) current[k] = r.value !== undefined ? r.value : v;
      } catch (e) {
        out.ok = false;
        const message = String(e && e.message ? e.message : e);
        out.applied[k] = { ok: false, error: message };
        out.errors.push({ key: k, message });
      }
    }
    emitLog({ message: "apply", keys: Object.keys(out.applied), ok: out.ok });
    return out;
  }

  function restore() {
    const restored = [];
    for (const k of LOOK_KEYS) if (restoreKey(k)) restored.push(k);
    current = {};
    emitLog({ message: "restore", restored });
    return { ok: true, restored };
  }

  function snapshot() {
    const s = {};
    for (const [k, v] of saved) {
      if (k === "fog") s[k] = v && v.value ? { value: v.value.name ?? v.value.option ?? "set" } : { value: null };
      else if (k === "dof") s[k] = v ? { ...v, target: v.target === null ? null : "set" } : null;
      else s[k] = v;
    }
    return { active: saved.size > 0, look: JSON.parse(JSON.stringify(current)), saved: JSON.parse(JSON.stringify(s)) };
  }

  return {
    apply,
    restore,
    snapshot,
    activeTimeOfDay: () => (typeof current.timeOfDay === "number" && Number.isFinite(current.timeOfDay) ? current.timeOfDay : null),
  };
}
