// scene3d/film/shots/registry.js — technique registry and shot builder (SPEC §2.11).
//
// WHY: the director (Claude Code) writes shots in plan.json as
// `{technique:'drone.orbit-poi', duration:8, params:{radius:30}}`. Technique
// ids are API. The registry is the single gate between that untrusted JSON
// and the technique code: it knows every technique's parameter schema, fills
// defaults, rejects unknown techniques / unknown or mistyped / out-of-range
// params with READABLE messages the director can act on, checks the shot
// context satisfies the technique's needs (subject, path, indoor/outdoor),
// seeds the shot's RNG deterministically from the spec, and stamps the
// result with its family and pilot bounds. listTechniques() is the JSON
// catalog the director reads (`film techniques`, `__film.techniques()`).
//
// Technique modules (classic.js, drone.js) export arrays of
// defineTechnique(...) results; shots/index.js registers them all into the
// default registry. createRegistry() gives isolated registries (tests, tools).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks.

import { FilmError, FilmShotError } from "../core/errors.js";
import { EASINGS } from "../core/easing.js";
import { hashString, mulberry32, seedOf } from "../core/rng.js";
import { isFiniteV } from "../core/vec3.js";
import { canonicalFraming, DEFAULT_ASPECT, normalizeSubject } from "./framing.js";
import {
  DEFAULT_BOUNDS,
  DEFAULT_FOV,
  hasExplicitBounds,
  isTrajectory,
  markBoundsExplicit,
  normalizeBounds,
} from "./trajectory.js";

/** Technique families (the id prefix). @type {ReadonlyArray<'classic'|'drone'|'fpv'>} */
export const FAMILIES = Object.freeze(["classic", "drone", "fpv"]);

/** Parameter schema types. @type {ReadonlyArray<'number'|'string'|'boolean'|'enum'|'vec3'>} */
export const PARAM_TYPES = Object.freeze(["number", "string", "boolean", "enum", "vec3"]);

/** Capture hints a technique may declare (moving server-driven subjects need realtime). */
export const CAPTURE_MODES = Object.freeze(["stepped", "realtime"]);

/** Longest shot buildShot accepts, seconds. */
export const MAX_SHOT_DURATION = 600;

/** Shot fov range buildShot accepts, degrees (inclusive). */
export const SHOT_FOV_RANGE = Object.freeze({ min: 1, max: 170 });

/** Default easing filled into a ShotSpec when neither the spec nor the technique names one. */
export const DEFAULT_EASE = "sineInOut";

/** Default framing filled into a ShotSpec when neither the spec nor the technique names one. */
export const DEFAULT_FRAMING = "MS";

/**
 * Machine-readable `.code`s of the FilmShotErrors thrown by this module.
 * @type {Readonly<{UNKNOWN_TECHNIQUE:string, BAD_TECHNIQUE_DEF:string, DUPLICATE_TECHNIQUE:string, BAD_SPEC:string,
 *   BAD_PARAM:string, MISSING_CONTEXT:string, BAD_CONTEXT:string, BUILD_FAILED:string, UNKNOWN_FAMILY:string}>}
 */
export const REGISTRY_ERROR_CODES = Object.freeze({
  UNKNOWN_TECHNIQUE: "UNKNOWN_TECHNIQUE",
  BAD_TECHNIQUE_DEF: "BAD_TECHNIQUE_DEF",
  DUPLICATE_TECHNIQUE: "DUPLICATE_TECHNIQUE",
  BAD_SPEC: "BAD_SPEC",
  BAD_PARAM: "BAD_PARAM",
  MISSING_CONTEXT: "MISSING_CONTEXT",
  BAD_CONTEXT: "BAD_CONTEXT",
  BUILD_FAILED: "BUILD_FAILED",
  UNKNOWN_FAMILY: "UNKNOWN_FAMILY",
});

/**
 * @typedef {Object} ParamSchema
 * @property {'number'|'string'|'boolean'|'enum'|'vec3'} type
 * @property {string} desc         what the parameter does (shown to the director)
 * @property {*} [default]          omitted → the parameter is required
 * @property {number} [min] @property {number} [max]   numbers only (inclusive, finite)
 * @property {boolean} [integer]    numbers only
 * @property {Array<string|number>} [values]           enum only
 * @property {string} [unit]        e.g. 'm', 'deg', 's', 'm/s'
 */

/**
 * @typedef {Object} TechniqueDef
 * @property {string} id            '<family>.<kebab-name>', e.g. 'classic.dolly-in'
 * @property {'classic'|'drone'|'fpv'} family
 * @property {string} name @property {string} description @property {string} whenToUse
 * @property {Object<string, ParamSchema>} params
 * @property {{subject:boolean, path:boolean, indoor:boolean|null}} needs
 * @property {import('./trajectory.js').Bounds} defaultBounds
 * @property {number} [defaultDuration] @property {string|number} [defaultFraming]
 * @property {number} [defaultFov] @property {string} [defaultEase]
 * @property {'stepped'|'realtime'} capture   capture hint (default 'stepped')
 * @property {boolean} reveal       subject may legitimately start out of frame
 * @property {string[]} tags
 * @property {(spec:ShotSpec, ctx:ShotContext) => import('./trajectory.js').Trajectory} build
 */

/**
 * @typedef {Object} ShotSpec
 * @property {string} technique @property {number} duration
 * @property {Object<string, *>} params
 * @property {string|number} [framing] @property {*} [subject] @property {number} [fov]
 * @property {number} [roll] @property {string} [ease] @property {*} [seed]
 * @property {Partial<import('./trajectory.js').Bounds>} [bounds]  director override of the pilot bounds
 * @property {string} [id]
 */

/**
 * @typedef {Object} ShotContext
 * @property {import('./framing.js').Subject|null} subject
 * @property {((t:number) => import('./framing.js').Subject)|null} subjectAt
 * @property {number[]} anchor
 * @property {(x:number, y:number) => number|null} groundZ
 * @property {number[][]} [path]
 * @property {number} aspect @property {number} fps
 * @property {() => number} rng     mulberry32 seeded from the spec
 * @property {number} seed          the uint32 seed behind rng (derive sub-streams with rng.deriveSeed)
 * @property {{h:number, p:number}} [sun]
 * @property {{route?:number[][], ceiling?:Function, floor?:Function}|null} indoor
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ID_RE = /^(classic|drone|fpv)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** @param {string} message @param {string} code @param {*} [details] @returns {FilmShotError} */
function shotError(message, code, details) {
  return new FilmShotError(message, details === undefined ? { code } : { code, details });
}

/** Readable value for messages. */
function show(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Plain (non-array, non-null) object. */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

/** Non-empty trimmed string. */
function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/** Levenshtein distance (small strings). */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Up to 3 closest names (by edit distance, also matching the part after the family prefix). */
function suggest(name, candidates) {
  const s = String(name).toLowerCase();
  const tail = s.includes(".") ? s.slice(s.indexOf(".") + 1) : s;
  const scored = candidates.map((c) => {
    const ct = c.includes(".") ? c.slice(c.indexOf(".") + 1) : c;
    return { c, d: Math.min(editDistance(s, c), editDistance(tail, ct)) };
  });
  scored.sort((a, b) => a.d - b.d || (a.c < b.c ? -1 : 1));
  const limit = Math.max(2, Math.ceil(tail.length / 3));
  return scored.filter((x) => x.d <= limit).slice(0, 3).map((x) => x.c);
}

/**
 * Canonical JSON (sorted keys; functions / undefined dropped; NaN/Infinity →
 * null; depth-capped) used to hash a spec into a seed.
 */
function stableStringify(v, depth = 0) {
  if (depth > 32) return "null";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (t === "string" || t === "boolean") return JSON.stringify(v);
  if (t === "bigint") return JSON.stringify(v.toString());
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    return `[${Array.from(v, (x) => {
      const s = stableStringify(x, depth + 1);
      return s === undefined ? "null" : s;
    }).join(",")}]`;
  }
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    const s = stableStringify(v[k], depth + 1);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic uint32 seed of a shot spec: `seedOf(spec.seed)` when the spec
 * names one, else a hash of the canonical JSON of the spec (keys sorted,
 * `seed` excluded).
 * @param {Object} spec
 * @returns {number}
 */
export function specSeed(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  if (s.seed !== undefined && s.seed !== null) return seedOf(s.seed);
  const rest = { ...s };
  delete rest.seed;
  return hashString(stableStringify(rest) || "{}");
}

// ---------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------

/** Validate one param schema; returns a frozen normalised copy. */
function normalizeParamSchema(defId, name, schema) {
  const where = `technique ${defId}: param "${name}"`;
  const bad = (msg) => shotError(`${where}: ${msg}`, REGISTRY_ERROR_CODES.BAD_TECHNIQUE_DEF, { technique: defId, param: name });
  if (!PARAM_NAME_RE.test(name)) throw bad("name must be an identifier (letters, digits, _)");
  if (!isPlainObject(schema)) throw bad("schema must be an object {type, desc, default, ...}");
  if (!PARAM_TYPES.includes(schema.type)) throw bad(`type must be one of ${PARAM_TYPES.join(" | ")} (got ${show(schema.type)})`);
  if (!nonEmpty(schema.desc)) throw bad("desc (documentation for the director) is required");
  const out = { type: schema.type, desc: schema.desc.trim() };
  if (schema.unit !== undefined) {
    if (!nonEmpty(schema.unit)) throw bad("unit must be a non-empty string");
    out.unit = schema.unit;
  }
  const isNum = schema.type === "number";
  for (const k of ["min", "max"]) {
    if (schema[k] === undefined || schema[k] === null) continue;
    if (!isNum) throw bad(`${k} is only valid for number params`);
    if (!(typeof schema[k] === "number" && Number.isFinite(schema[k]))) throw bad(`${k} must be a finite number`);
    out[k] = schema[k];
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw bad(`min ${out.min} > max ${out.max}`);
  if (schema.integer !== undefined) {
    if (!isNum) throw bad("integer is only valid for number params");
    if (typeof schema.integer !== "boolean") throw bad("integer must be a boolean");
    if (schema.integer) out.integer = true;
  }
  if (schema.type === "enum") {
    const vals = schema.values;
    if (!Array.isArray(vals) || vals.length === 0) throw bad("enum params need a non-empty values array");
    for (const v of vals) {
      if (!(typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) throw bad(`enum value ${show(v)} must be a string or finite number`);
    }
    if (new Set(vals).size !== vals.length) throw bad("enum values must be unique");
    out.values = Object.freeze(vals.slice());
  } else if (schema.values !== undefined) {
    throw bad("values is only valid for enum params");
  }
  if (schema.default !== undefined) {
    let d;
    try {
      d = coerceParam(defId, name, out, schema.default);
    } catch (e) {
      throw bad(`default is invalid: ${e && e.message ? e.message.replace(/^.*?param "[^"]*" /, "") : String(e)}`);
    }
    out.default = Array.isArray(d) ? Object.freeze(d) : d;
  }
  return Object.freeze(out);
}

/**
 * Validate one param value against its schema; returns the (copied) value.
 * Throws FilmShotError BAD_PARAM with a readable message.
 */
function coerceParam(techId, name, schema, v) {
  const where = `${techId}: param "${name}"`;
  const bad = (msg, extra) => shotError(`${where} ${msg}`, REGISTRY_ERROR_CODES.BAD_PARAM,
    { technique: techId, param: name, value: v === undefined ? null : v, ...extra });
  switch (schema.type) {
    case "number": {
      if (!(typeof v === "number" && Number.isFinite(v))) throw bad(`must be a finite number (got ${show(v)})`);
      if (schema.integer && !Number.isInteger(v)) throw bad(`must be an integer (got ${v})`);
      const lo = schema.min, hi = schema.max;
      if ((lo !== undefined && v < lo) || (hi !== undefined && v > hi)) {
        const range = lo !== undefined && hi !== undefined ? `in [${lo}, ${hi}]` : lo !== undefined ? `≥ ${lo}` : `≤ ${hi}`;
        throw bad(`must be ${range}${schema.unit ? ` ${schema.unit}` : ""} (got ${v})`, { min: lo ?? null, max: hi ?? null });
      }
      return v;
    }
    case "string":
      if (typeof v !== "string") throw bad(`must be a string (got ${show(v)})`);
      return v;
    case "boolean":
      if (typeof v !== "boolean") throw bad(`must be true or false (got ${show(v)})`);
      return v;
    case "enum":
      if (!schema.values.includes(v)) throw bad(`must be one of ${schema.values.map(show).join(" | ")} (got ${show(v)})`, { values: schema.values.slice() });
      return v;
    case "vec3":
      if (!(Array.isArray(v) && v.length === 3 && isFiniteV(v))) throw bad(`must be a finite [x, y, z] array (got ${show(v)})`);
      return [v[0], v[1], v[2]];
    default:
      throw bad(`has unknown type ${show(schema.type)}`);
  }
}

/**
 * Validate a technique definition and return a frozen, normalised copy with
 * every optional field filled (needs {subject:false, path:false, indoor:null},
 * params {}, defaultBounds completed from DEFAULT_BOUNDS, capture 'stepped',
 * reveal false, tags []). Technique modules export arrays of these.
 *
 * Required: `id` ('classic.*' | 'drone.*' | 'fpv.*', kebab-case), `name`,
 * `description`, `whenToUse` (non-empty strings), `build(spec, ctx)`.
 * `family` defaults to the id prefix and must match it. Every param needs a
 * `type` and a `desc`; defaults must satisfy their own schema. Optional
 * `defaultDuration` (s), `defaultFraming`, `defaultFov` (°), `defaultEase`,
 * `capture`, `reveal`, `tags`. Unknown extra keys are kept (not catalogued).
 * Throws FilmShotError (code BAD_TECHNIQUE_DEF) with a readable message.
 * @param {Object} def
 * @returns {Readonly<TechniqueDef>}
 */
export function defineTechnique(def) {
  if (!isPlainObject(def)) throw shotError("defineTechnique: a definition object is required", REGISTRY_ERROR_CODES.BAD_TECHNIQUE_DEF);
  const id = def.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw shotError(`defineTechnique: id must look like "classic.dolly-in" (family classic|drone|fpv, kebab-case) (got ${show(id)})`,
      REGISTRY_ERROR_CODES.BAD_TECHNIQUE_DEF, { technique: typeof id === "string" ? id : null });
  }
  const bad = (msg) => shotError(`technique ${id}: ${msg}`, REGISTRY_ERROR_CODES.BAD_TECHNIQUE_DEF, { technique: id });
  const prefix = id.slice(0, id.indexOf("."));
  const family = def.family === undefined ? prefix : def.family;
  if (family !== prefix) throw bad(`family ${show(family)} must match the id prefix "${prefix}"`);
  for (const k of ["name", "description", "whenToUse"]) {
    if (!nonEmpty(def[k])) throw bad(`${k} must be a non-empty string`);
  }
  if (typeof def.build !== "function") throw bad("build(spec, ctx) → Trajectory is required");

  const paramsIn = def.params === undefined || def.params === null ? {} : def.params;
  if (!isPlainObject(paramsIn)) throw bad("params must be an object {name: schema}");
  const params = {};
  for (const name of Object.keys(paramsIn)) params[name] = normalizeParamSchema(id, name, paramsIn[name]);

  const needsIn = def.needs === undefined || def.needs === null ? {} : def.needs;
  if (!isPlainObject(needsIn)) throw bad("needs must be an object {subject, path, indoor}");
  for (const k of Object.keys(needsIn)) {
    if (!["subject", "path", "indoor"].includes(k)) throw bad(`unknown needs key "${k}" (valid: subject, path, indoor)`);
  }
  const needs = {
    subject: needsIn.subject === undefined ? false : needsIn.subject,
    path: needsIn.path === undefined ? false : needsIn.path,
    indoor: needsIn.indoor === undefined ? null : needsIn.indoor,
  };
  if (typeof needs.subject !== "boolean") throw bad("needs.subject must be a boolean");
  if (typeof needs.path !== "boolean") throw bad("needs.path must be a boolean");
  if (!(needs.indoor === null || typeof needs.indoor === "boolean")) throw bad("needs.indoor must be true, false or null (either)");

  let defaultBounds;
  try {
    defaultBounds = normalizeBounds(def.defaultBounds, DEFAULT_BOUNDS);
  } catch (e) {
    throw bad(`defaultBounds: ${e.message}`);
  }

  const out = { ...def, id, family, name: def.name.trim(), description: def.description.trim(), whenToUse: def.whenToUse.trim() };
  out.params = Object.freeze(params);
  out.needs = Object.freeze(needs);
  out.defaultBounds = Object.freeze(defaultBounds);

  if (def.defaultDuration !== undefined) {
    const d = def.defaultDuration;
    if (!(typeof d === "number" && Number.isFinite(d) && d > 0 && d <= MAX_SHOT_DURATION)) {
      throw bad(`defaultDuration must be a number in (0, ${MAX_SHOT_DURATION}] seconds`);
    }
  }
  if (def.defaultFraming !== undefined) {
    try {
      out.defaultFraming = canonicalFraming(def.defaultFraming);
    } catch (e) {
      throw bad(`defaultFraming: ${e.message}`);
    }
  }
  if (def.defaultFov !== undefined) {
    const f = def.defaultFov;
    if (!(typeof f === "number" && f >= SHOT_FOV_RANGE.min && f <= SHOT_FOV_RANGE.max)) {
      throw bad(`defaultFov must be a number in [${SHOT_FOV_RANGE.min}, ${SHOT_FOV_RANGE.max}] degrees`);
    }
  }
  if (def.defaultEase !== undefined && !Object.prototype.hasOwnProperty.call(EASINGS, def.defaultEase)) {
    throw bad(`defaultEase ${show(def.defaultEase)} is not an easing (valid: ${Object.keys(EASINGS).join(", ")})`);
  }
  out.capture = def.capture === undefined ? "stepped" : def.capture;
  if (!CAPTURE_MODES.includes(out.capture)) throw bad(`capture must be ${CAPTURE_MODES.join(" | ")}`);
  out.reveal = def.reveal === undefined ? false : def.reveal;
  if (typeof out.reveal !== "boolean") throw bad("reveal must be a boolean");
  const tags = def.tags === undefined ? [] : def.tags;
  if (!Array.isArray(tags) || !tags.every(nonEmpty)) throw bad("tags must be an array of non-empty strings");
  out.tags = Object.freeze(tags.slice());
  return Object.freeze(out);
}

/** JSON-safe catalog entry of a normalised def. */
function catalogEntry(def) {
  const params = {};
  for (const [name, s] of Object.entries(def.params)) {
    const p = { type: s.type, desc: s.desc };
    if (s.default !== undefined) p.default = Array.isArray(s.default) ? s.default.slice() : s.default;
    else p.required = true;
    if (s.min !== undefined) p.min = s.min;
    if (s.max !== undefined) p.max = s.max;
    if (s.integer) p.integer = true;
    if (s.values) p.values = s.values.slice();
    if (s.unit) p.unit = s.unit;
    params[name] = p;
  }
  const e = {
    id: def.id,
    family: def.family,
    name: def.name,
    description: def.description,
    whenToUse: def.whenToUse,
    params,
    needs: { ...def.needs },
    defaultBounds: { ...def.defaultBounds },
    capture: def.capture,
    reveal: def.reveal,
    tags: def.tags.slice(),
  };
  if (def.defaultDuration !== undefined) e.defaultDuration = def.defaultDuration;
  if (def.defaultFraming !== undefined) e.defaultFraming = def.defaultFraming;
  if (def.defaultFov !== undefined) e.defaultFov = def.defaultFov;
  if (def.defaultEase !== undefined) e.defaultEase = def.defaultEase;
  return e;
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/** Sanitised z(x, y) callback: non-finite results and throws become null. */
function zFn(fn) {
  if (typeof fn !== "function") return () => null;
  return (x, y) => {
    let z;
    try {
      z = fn(x, y);
    } catch {
      return null;
    }
    return typeof z === "number" && Number.isFinite(z) ? z : null;
  };
}

/** Validated copy of a polyline (array of finite vec3), or throws BAD_CONTEXT. */
function copyPath(path, what) {
  if (!Array.isArray(path)) throw shotError(`${what} must be an array of [x,y,z] points`, REGISTRY_ERROR_CODES.BAD_CONTEXT);
  return path.map((p, i) => {
    if (!isFiniteV(p)) throw shotError(`${what}[${i}] must be a finite [x,y,z] (got ${show(p)})`, REGISTRY_ERROR_CODES.BAD_CONTEXT);
    return [p[0], p[1], p[2]];
  });
}

/** Normalised subject with optional finite heading / velocity kept; BAD_CONTEXT on garbage. */
function contextSubject(s, what) {
  let n;
  try {
    n = normalizeSubject(s);
  } catch (e) {
    throw shotError(`${what}: ${e.message}`, REGISTRY_ERROR_CODES.BAD_CONTEXT);
  }
  if (n.heading !== undefined && !(typeof n.heading === "number" && Number.isFinite(n.heading))) delete n.heading;
  if (n.velocity !== undefined) {
    if (isFiniteV(n.velocity)) n.velocity = [n.velocity[0], n.velocity[1], n.velocity[2]];
    else delete n.velocity;
  }
  return n;
}

/**
 * Fill ShotContext defaults so technique code never null-checks the basics
 * (SPEC §2.11):
 *  - `subject` normalised ({pos base, height, radius, heading?, velocity?}) or
 *    null; when the context has none, a spec subject with a position is used,
 *    else `ctx.subjectAt(0)` when only a subject function is given;
 *  - `subjectAt(t)` — the given function (results normalised), else the
 *    subject extrapolated along its velocity, else constant; null without a subject;
 *  - `anchor` — given, else the subject position, else the first path point, else [0,0,0];
 *  - `groundZ(x, y)` → number|null (missing → always null; throws/NaN → null);
 *  - `path` validated copy (or undefined); `aspect` 16/9; `fps` 30;
 *  - `seed` = specSeed(spec) (or ctx.seed when no spec is given), `rng` =
 *    the given rng or mulberry32(seed);
 *  - `sun` kept when {h, p} are finite; `indoor` normalised (route copy,
 *    sanitised floor/ceiling) or null.
 * Other context fields are passed through. Throws FilmShotError (BAD_CONTEXT)
 * for malformed subjects / paths / anchors.
 * @param {Partial<ShotContext>|null|undefined} partialCtx
 * @param {Partial<ShotSpec>} [spec]
 * @returns {ShotContext}
 */
export function ctxDefaults(partialCtx, spec) {
  const c = partialCtx === undefined || partialCtx === null ? {} : partialCtx;
  if (!isPlainObject(c)) throw shotError("shot context must be an object", REGISTRY_ERROR_CODES.BAD_CONTEXT);
  const sp = isPlainObject(spec) ? spec : null;
  const out = { ...c };

  let subject = null;
  if (c.subject !== undefined && c.subject !== null) subject = contextSubject(c.subject, "ctx.subject");
  else if (sp && sp.subject !== undefined && sp.subject !== null && (isPlainObject(sp.subject) || Array.isArray(sp.subject))) {
    const s = sp.subject;
    const hasPos = Array.isArray(s) ? isFiniteV(s) : isFiniteV(s.pos) || isFiniteV(s.position) || isFiniteV(s.center);
    if (hasPos) subject = contextSubject(s, "spec.subject");
  }
  if (typeof c.subjectAt === "function") {
    const fn = c.subjectAt;
    if (!subject) {
      const s0 = fn(0);
      if (s0 !== undefined && s0 !== null) subject = contextSubject(s0, "ctx.subjectAt(0)");
    }
    const fallback = subject;
    out.subjectAt = (t) => {
      const s = fn(t);
      return s === undefined || s === null ? fallback : contextSubject(s, `ctx.subjectAt(${t})`);
    };
  } else if (subject && subject.velocity) {
    const s0 = subject;
    const v = subject.velocity;
    out.subjectAt = (t) => {
      const tt = Number.isFinite(t) ? t : 0;
      return { ...s0, pos: [s0.pos[0] + v[0] * tt, s0.pos[1] + v[1] * tt, s0.pos[2] + v[2] * tt] };
    };
  } else if (subject) {
    out.subjectAt = () => subject;
  } else {
    out.subjectAt = null;
  }
  out.subject = subject;

  out.path = c.path === undefined || c.path === null ? undefined : copyPath(c.path, "ctx.path");
  if (out.path === undefined) delete out.path;

  if (c.anchor !== undefined && c.anchor !== null) {
    if (!isFiniteV(c.anchor)) throw shotError(`ctx.anchor must be a finite [x,y,z] (got ${show(c.anchor)})`, REGISTRY_ERROR_CODES.BAD_CONTEXT);
    out.anchor = [c.anchor[0], c.anchor[1], c.anchor[2]];
  } else if (subject) out.anchor = subject.pos.slice();
  else if (out.path && out.path.length) out.anchor = out.path[0].slice();
  else out.anchor = [0, 0, 0];

  out.groundZ = zFn(c.groundZ);
  out.aspect = typeof c.aspect === "number" && Number.isFinite(c.aspect) && c.aspect > 0 ? c.aspect : DEFAULT_ASPECT;
  out.fps = typeof c.fps === "number" && Number.isFinite(c.fps) && c.fps > 0 ? c.fps : 30;
  out.seed = sp ? specSeed(sp) : c.seed !== undefined && c.seed !== null ? seedOf(c.seed) : 0;
  out.rng = typeof c.rng === "function" ? c.rng : mulberry32(out.seed);

  if (c.sun && Number.isFinite(c.sun.h) && Number.isFinite(c.sun.p)) out.sun = { h: c.sun.h, p: c.sun.p };
  else delete out.sun;

  if (c.indoor !== undefined && c.indoor !== null && c.indoor !== false) {
    if (!isPlainObject(c.indoor)) throw shotError("ctx.indoor must be an object {route?, ceiling?, floor?}", REGISTRY_ERROR_CODES.BAD_CONTEXT);
    const ind = { ...c.indoor };
    if (c.indoor.route !== undefined && c.indoor.route !== null) ind.route = copyPath(c.indoor.route, "ctx.indoor.route");
    if (typeof c.indoor.ceiling === "function") ind.ceiling = zFn(c.indoor.ceiling);
    if (typeof c.indoor.floor === "function") ind.floor = zFn(c.indoor.floor);
    out.indoor = ind;
  } else {
    out.indoor = null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Validate spec.params against a def's schema; returns the filled params object. */
function fillParams(def, given) {
  const p = given === undefined || given === null ? {} : given;
  if (!isPlainObject(p)) throw shotError(`${def.id}: params must be an object (got ${show(p)})`, REGISTRY_ERROR_CODES.BAD_PARAM, { technique: def.id });
  const names = Object.keys(def.params);
  for (const k of Object.keys(p)) {
    if (!Object.prototype.hasOwnProperty.call(def.params, k)) {
      const near = suggest(k, names);
      throw shotError(
        `${def.id}: unknown param "${k}"${near.length ? ` (did you mean ${near.map((x) => `"${x}"`).join(" or ")}?)` : ""}` +
          ` — valid params: ${names.length ? names.join(", ") : "(none)"}`,
        REGISTRY_ERROR_CODES.BAD_PARAM,
        { technique: def.id, param: k, valid: names },
      );
    }
  }
  const out = {};
  for (const name of names) {
    const schema = def.params[name];
    const v = p[name];
    if (v === undefined) {
      if (schema.default === undefined) {
        throw shotError(`${def.id}: param "${name}" is required (${schema.desc})`, REGISTRY_ERROR_CODES.BAD_PARAM, { technique: def.id, param: name });
      }
      out[name] = Array.isArray(schema.default) ? schema.default.slice() : schema.default;
    } else {
      out[name] = coerceParam(def.id, name, schema, v);
    }
  }
  return out;
}

/**
 * Create an isolated technique registry. The module-level registerTechnique /
 * getTechnique / listTechniques / buildShot operate on a default one (filled
 * by shots/index.js).
 * @returns {{
 *   registerTechnique:(def:Object, opts?:{replace?:boolean})=>Readonly<TechniqueDef>,
 *   getTechnique:(id:string)=>Readonly<TechniqueDef>|null,
 *   hasTechnique:(id:string)=>boolean,
 *   techniqueIds:()=>string[],
 *   listTechniques:(opts?:{family?:string|string[]})=>Object[],
 *   buildShot:(spec:ShotSpec, ctx?:Partial<ShotContext>)=>import('./trajectory.js').Trajectory,
 *   size:()=>number
 * }}
 */
export function createRegistry() {
  /** @type {Map<string, Readonly<TechniqueDef>>} */
  const map = new Map();

  function registerTechnique(def, opts = {}) {
    const d = defineTechnique(def);
    if (map.has(d.id) && !(opts && opts.replace === true)) {
      throw shotError(`technique ${d.id} is already registered`, REGISTRY_ERROR_CODES.DUPLICATE_TECHNIQUE, { technique: d.id });
    }
    map.set(d.id, d);
    return d;
  }

  function getTechnique(id) {
    return typeof id === "string" && map.has(id) ? map.get(id) : null;
  }

  function hasTechnique(id) {
    return typeof id === "string" && map.has(id);
  }

  function techniqueIds() {
    return Array.from(map.keys());
  }

  function listTechniques(opts = {}) {
    const fam = opts && opts.family !== undefined && opts.family !== null ? opts.family : null;
    let wanted = null;
    if (fam !== null) {
      wanted = Array.isArray(fam) ? fam : [fam];
      for (const f of wanted) {
        if (!FAMILIES.includes(f)) {
          throw shotError(`unknown technique family ${show(f)} (valid: ${FAMILIES.join(", ")})`, REGISTRY_ERROR_CODES.UNKNOWN_FAMILY, { family: f });
        }
      }
    }
    const out = [];
    for (const def of map.values()) if (!wanted || wanted.includes(def.family)) out.push(catalogEntry(def));
    return out;
  }

  function buildShot(spec, ctx) {
    if (!isPlainObject(spec)) throw shotError("buildShot: spec must be an object {technique, duration, params, ...}", REGISTRY_ERROR_CODES.BAD_SPEC);
    const tid = spec.technique;
    if (typeof tid !== "string" || tid.length === 0) {
      throw shotError(`buildShot: spec.technique must be a technique id string (got ${show(tid)})`, REGISTRY_ERROR_CODES.BAD_SPEC);
    }
    const def = map.get(tid);
    if (!def) {
      const near = suggest(tid, Array.from(map.keys()));
      throw shotError(
        `unknown technique ${show(tid)}${near.length ? ` (did you mean ${near.map((x) => `"${x}"`).join(" or ")}?)` : ""}` +
          ` — ${map.size} techniques are registered; see listTechniques()`,
        REGISTRY_ERROR_CODES.UNKNOWN_TECHNIQUE,
        { technique: tid, suggestions: near },
      );
    }
    const bad = (msg, extra) => shotError(`${def.id}: ${msg}`, REGISTRY_ERROR_CODES.BAD_SPEC, { technique: def.id, ...extra });

    const duration = spec.duration === undefined || spec.duration === null ? def.defaultDuration : spec.duration;
    if (!(typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= MAX_SHOT_DURATION)) {
      throw bad(`duration must be a number in (0, ${MAX_SHOT_DURATION}] seconds (got ${show(spec.duration)})`, { field: "duration" });
    }
    const params = fillParams(def, spec.params);

    let framing;
    try {
      framing = canonicalFraming(spec.framing === undefined || spec.framing === null ? def.defaultFraming ?? DEFAULT_FRAMING : spec.framing);
    } catch (e) {
      throw bad(e.message, { field: "framing" });
    }
    const fov = spec.fov === undefined || spec.fov === null ? def.defaultFov ?? DEFAULT_FOV : spec.fov;
    if (!(typeof fov === "number" && Number.isFinite(fov) && fov >= SHOT_FOV_RANGE.min && fov <= SHOT_FOV_RANGE.max)) {
      throw bad(`fov must be a number in [${SHOT_FOV_RANGE.min}, ${SHOT_FOV_RANGE.max}] degrees (got ${show(spec.fov)})`, { field: "fov" });
    }
    const roll = spec.roll === undefined || spec.roll === null ? 0 : spec.roll;
    if (!(typeof roll === "number" && Number.isFinite(roll) && Math.abs(roll) <= Math.PI)) {
      throw bad(`roll must be a number of RADIANS in [−π, π] (got ${show(spec.roll)})`, { field: "roll" });
    }
    const easeName = spec.ease === undefined || spec.ease === null ? def.defaultEase ?? DEFAULT_EASE : spec.ease;
    if (typeof easeName !== "string" || !Object.prototype.hasOwnProperty.call(EASINGS, easeName)) {
      throw bad(`ease ${show(spec.ease)} is not an easing (valid: ${Object.keys(EASINGS).join(", ")})`, { field: "ease" });
    }
    let bounds = def.defaultBounds;
    if (spec.bounds !== undefined && spec.bounds !== null) {
      try {
        bounds = normalizeBounds(spec.bounds, def.defaultBounds);
      } catch (e) {
        throw bad(e.message, { field: "bounds" });
      }
    }

    const norm = { technique: def.id, duration, params, framing, fov, roll, ease: easeName };
    if (spec.subject !== undefined && spec.subject !== null) norm.subject = spec.subject;
    if (typeof spec.id === "string" && spec.id) norm.id = spec.id;
    norm.seed = specSeed(spec.seed !== undefined && spec.seed !== null ? { seed: spec.seed } : { ...norm });

    let fullCtx;
    try {
      fullCtx = ctxDefaults(ctx, norm);
    } catch (e) {
      if (e instanceof FilmShotError) throw shotError(`${def.id}: ${e.message}`, e.code, { technique: def.id });
      throw e;
    }
    fullCtx.seed = norm.seed;
    fullCtx.rng = mulberry32(norm.seed);

    const need = (msg) => shotError(`${def.id}: ${msg}`, REGISTRY_ERROR_CODES.MISSING_CONTEXT, { technique: def.id });
    if (def.needs.subject && !fullCtx.subject && typeof fullCtx.subjectAt !== "function") {
      throw need("needs a subject (ctx.subject {pos, height, radius} or a spec.subject with a position)");
    }
    if (def.needs.path && !(Array.isArray(fullCtx.path) && fullCtx.path.length >= 2)) {
      throw need("needs a path (ctx.path with at least 2 points)");
    }
    if (def.needs.indoor === true && !fullCtx.indoor) throw need("is an indoor technique and needs ctx.indoor (dungeon/building interior)");
    if (def.needs.indoor === false && fullCtx.indoor) throw need("is an outdoor-only technique but the context is indoor");

    let traj;
    try {
      traj = def.build(norm, fullCtx);
    } catch (e) {
      if (e instanceof FilmShotError) throw e;
      if (e instanceof FilmError) throw new FilmShotError(`${def.id}: ${e.message}`, { code: e.code, details: e.details, cause: e });
      throw new FilmShotError(`${def.id}: build failed: ${e && e.message ? e.message : String(e)}`,
        { code: REGISTRY_ERROR_CODES.BUILD_FAILED, details: { technique: def.id }, cause: e });
    }
    if (!isTrajectory(traj)) {
      throw shotError(`${def.id}: build() did not return a Trajectory (use makeTrajectory)`, REGISTRY_ERROR_CODES.BUILD_FAILED, { technique: def.id });
    }
    if (Math.abs(traj.duration - duration) > 1e-6 * Math.max(1, duration)) {
      throw shotError(`${def.id}: build() returned duration ${traj.duration}, the spec asked for ${duration}`,
        REGISTRY_ERROR_CODES.BUILD_FAILED, { technique: def.id, duration: traj.duration, expected: duration });
    }
    const finalBounds = spec.bounds !== undefined && spec.bounds !== null
      ? bounds
      : hasExplicitBounds(traj) ? normalizeBounds(traj.bounds, def.defaultBounds) : { ...def.defaultBounds };
    const meta = isPlainObject(traj.meta) ? { ...traj.meta } : {};
    meta.spec = JSON.parse(stableStringify(norm));
    meta.techniqueName = def.name;
    meta.capture = def.capture;
    meta.reveal = def.reveal;
    const out = {
      ...traj,
      id: norm.id || (typeof traj.id === "string" && traj.id && traj.id !== def.id ? traj.id : `${def.id}#${norm.seed.toString(16).padStart(8, "0")}`),
      technique: def.id,
      family: def.family,
      bounds: finalBounds,
      meta,
    };
    if ((out.subject === undefined || out.subject === null) && fullCtx.subject) out.subject = fullCtx.subject;
    if (typeof out.subjectAt !== "function" && typeof fullCtx.subjectAt === "function") out.subjectAt = fullCtx.subjectAt;
    return markBoundsExplicit(out);
  }

  return {
    registerTechnique,
    getTechnique,
    hasTechnique,
    techniqueIds,
    listTechniques,
    buildShot,
    size: () => map.size,
  };
}

/** The default registry (filled by shots/index.js). */
const DEFAULT_REGISTRY = createRegistry();

/**
 * Register a technique in the default registry (validated by
 * defineTechnique). Duplicate ids throw (code DUPLICATE_TECHNIQUE) unless
 * `{replace: true}`.
 * @param {Object} def
 * @param {{replace?:boolean}} [opts]
 * @returns {Readonly<TechniqueDef>}
 */
export function registerTechnique(def, opts) {
  return DEFAULT_REGISTRY.registerTechnique(def, opts);
}

/**
 * A registered technique definition, or null for an unknown id.
 * @param {string} id
 * @returns {Readonly<TechniqueDef>|null}
 */
export function getTechnique(id) {
  return DEFAULT_REGISTRY.getTechnique(id);
}

/**
 * True when `id` is registered in the default registry.
 * @param {string} id
 * @returns {boolean}
 */
export function hasTechnique(id) {
  return DEFAULT_REGISTRY.hasTechnique(id);
}

/**
 * Ids of every technique in the default registry, in registration order.
 * @returns {string[]}
 */
export function techniqueIds() {
  return DEFAULT_REGISTRY.techniqueIds();
}

/**
 * JSON-safe technique catalog of the default registry (registration order),
 * optionally filtered by family (a name or an array). Entries:
 * `{id, family, name, description, whenToUse, params:{name:{type, desc,
 * default|required, min?, max?, integer?, values?, unit?}}, needs,
 * defaultBounds, capture, reveal, tags, defaultDuration?, defaultFraming?,
 * defaultFov?, defaultEase?}`. Unknown families throw (UNKNOWN_FAMILY).
 * @param {{family?:string|string[]}} [opts]
 * @returns {Object[]}
 */
export function listTechniques(opts) {
  return DEFAULT_REGISTRY.listTechniques(opts);
}

/**
 * Build a shot from a ShotSpec with the default registry (SPEC §2.11).
 * Validates the technique id (unknown → UNKNOWN_TECHNIQUE with suggestions),
 * duration ((0, 600] s; falls back to the technique's defaultDuration),
 * params (unknown names, wrong types, out-of-range numbers, bad enum values →
 * BAD_PARAM; missing → schema default; required without default → BAD_PARAM),
 * framing / fov ([1, 170]°) / roll (radians, |roll| ≤ π) / ease / bounds
 * (→ BAD_SPEC), and the technique's needs (→ MISSING_CONTEXT). The technique's
 * build receives the NORMALISED spec `{technique, duration, params, framing,
 * fov, roll, ease, seed, subject?, id?}` and ctxDefaults(ctx) with `rng`
 * re-seeded from spec.seed (or a hash of the spec) — so the same spec always
 * builds the same shot. The result must honour the duration (else
 * BUILD_FAILED). The returned Trajectory carries technique/family, bounds
 * (spec.bounds > explicit trajectory bounds > technique defaultBounds),
 * subject/subjectAt from the context when the technique did not set them, and
 * `meta.spec` (JSON), `meta.capture`, `meta.reveal`, `meta.techniqueName`.
 * @param {ShotSpec} spec
 * @param {Partial<ShotContext>} [ctx]
 * @returns {import('./trajectory.js').Trajectory}
 */
export function buildShot(spec, ctx) {
  return DEFAULT_REGISTRY.buildShot(spec, ctx);
}
