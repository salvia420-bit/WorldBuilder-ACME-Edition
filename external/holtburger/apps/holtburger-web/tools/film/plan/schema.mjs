// tools/film/plan/schema.mjs — film-mode Plan JSON v1: field contract, defaults (normalizePlan) and validation
// (validatePlan) for the director's plan.json.
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF) has a Claude Code director that turns a pasted script / song into a
// filming plan. plan.json is the ONE hand-written artefact between that director and the machinery: the compiler
// (compile.mjs) turns it into a Timeline + shooting schedule, the CLI walks the schedule (teleport ≈10 s per
// site, never record across a teleport), the page's take player builds each shot from its technique spec, and
// the JEV pilot reads each shot's `standingOrder` every tick. A typo here costs a teleport and a take on the
// 1070, so validation is strict, total (never throws) and points at the exact field (`shots[3].params.radius`).
//
// WHAT
// ----
//   normalizePlan(plan, {registry?}) → plan with every default filled (pure, idempotent, never throws)
//   validatePlan(plan, {registry?, dryBuild?}) → {ok, errors:[{path, message}], warnings:[{path, message}], plan}
//   assertValidPlan(plan, opts) → normalized plan, or throws FilmPlanError (details.errors / details.warnings)
//   examplePlan() → a complete, valid music-video plan (3 sites, 8 shots) for docs and tests
//   PLAN_FIELDS → field reference table {path, type, required, default, desc} (docs lane renders it)
//   + constants: PLAN_VERSION, PLAN_DEFAULTS, TRANSITION_TYPES, XFADE_FOR, XFADE_TRANSITIONS, SUBJECT_KINDS,
//     PILOT_MODES, PILOT_FADE_MODES, CAPTURE_MODES, FRAMING_NAMES, KNOWN_TECHNIQUE_IDS, LOOK_TIMES, LOOK_FOGS,
//     LOOK_GRADES, LOOK_DOF_KEYS, SHOT_BOUND_RULES, TRIM_KEYS, EDIT_KEYS, TAIL_KEYS, PRIME_MAX, OVERLAY_KEYS,
//     OVERLAY_PROP_KEYS, OVERLAY_PROP_STYLES, PLAN_PARAM_TYPES, DRY_ROUTE_LEG_M, STANDING_ORDER_MAX, ID_PATTERN;
//     helpers parseDuration, parseStart, checkStandingOrder, techniqueFamily, tailIndexOf.
//
// Plan JSON v1 (all positions are SPEC §1 AC world metres [x east, y north, z up]; headings compass radians):
//   { version: 1, title, kind?: 'music-video'|'story'|'reel',
//     format: {width=1920, height=1080, fps=30, capture='stepped'},
//     song?: {file?, analysis?, offsetSec=0}          (edit t=0 ↔ song t=offsetSec; indices below are SONG indices)
//     defaults?: {transition='cut', pilot:{mode='jev'}, look:{}, framing?, ease?},
//     edit?: {fadeInSec=0, fadeOutSec=0, tail?:{from, gapSec=1.5, fadeOutSec=3}},
//     sites: [{id, name?, gazetteerId?, teleport:'@…', anchor:[x,y,z] | {cell, local:[x,y,z]}, cell?, indoor?,
//              lbKeys?, interiorLb?, settleSec=0, ready:{settleSec=3, timeoutSec=90}, prime?:['@…' ≤ 12], look?,
//              notes?}],
//     shots: [{id, site, technique, duration:{sec}|{beats}|{bars} (or 4 / "2 bars" / "8 beats" / "3.5s"),
//              start?:{sec}|{beat}|{bar}|{section}, params?, framing?, subject?, path?, route?, fov?, roll?, ease?,
//              seed?, bounds?, trim?, transition? (INTO this shot), standingOrder, pilot?:{mode, fade?}, capture?,
//              actor?, look?, cell?, overlay?, lyric?, notes?}] }
//   edit.tail: {from: '<shot id>', gapSec=1.5, fadeOutSec=3} (or the shot id string) — the shots from `from` on are a
//     SILENT TAIL appended after the music: exact seconds (never beat-snapped), no {beats}/{bars}, no `start`; the
//     music part compiles exactly as without a tail, edit.fadeOutSec fades its LAST shot (element-local), `gapSec` of
//     black follows, a non-cut transition into the first tail shot is a fade-in from black/white, and
//     tail.fadeOutSec is the program fade-out on the last shot. `from` may not be the first shot.
//   site.prime: ['@teleloc …', …] — up to PRIME_MAX admin commands (checked like `teleport`) that `film shoot` sends
//     BEFORE the site teleport, each followed by its readiness gate: walks the hidden player through a dungeon so the
//     server sends the creatures of every cell the run passes (its PVS), then the site teleport stands it at the
//     site. A failing prime only warns.
//   shot.overlay: {props: {style: 'freestyle'|'cinewhoop', opacity?: 0..1, tint?: '#rrggbb'}} → item.take.overlay
//     (null when absent): the page's lens overlay (FPV propellers at the top of the frame; drawn only with the boot
//     flag ?filmProps=on). Unknown keys warn (the page ignores them).
//   shot.pilot.fade: 'never' | 'auto' — 'never' forbids the JEV pilot to fade anything in the take (passed through).
//   bounds: {maxLateral?, maxRise?, maxSink?, minSpeedScale?, maxSpeedScale?, maxDistanceScale?} — ShotSpec.bounds,
//     the director's override of the JEV pilot bounds (missing keys = the technique's defaultBounds).
//   trim: {takeSec, inSec} — fly the move as a take of `takeSec` s (ShotSpec.duration) and cut the edit from `inSec`
//     into it: a shorter edit keeps the move's speed and shows its best stretch (the compiler places the window).
//   params: checked against the registry's param schema; a param type this file does not know (e.g. a technique's
//     `list` of zones/tricks) is checked by the registry itself (buildShot's own param validation, see
//     checkRegistryParams), so its errors are plan errors with the exact path.
//   subject: {kind:'point', pos, radius?, height?, heading?} | {kind:'entity', ref, moving=false, radius?, height?}
//          | {kind:'player', moving?} | {kind:'path', points:[[x,y,z]…≥2]}  ('player' string = {kind:'player'})
//     player `moving` is normalized to true when the shot's actor walks (actor.moveTo / actor.moves) — the page then
//     follows the avatar live like a `moving` entity; explicit `moving` wins.
//   transition: 'cut' | 'dissolve' | 'fade' | 'fadewhite' | {type, durationSec=0.5, xfade?}
//     dissolve = cross-dissolve (ffmpeg xfade 'fade'); fade = dip to black ('fadeblack'); fadewhite = dip to white.
//     A non-cut transition on the FIRST shot is a fade-in from black/white (no handles).
//
// Node-side but pure: no I/O, no clocks, deterministic. Imports only dependency-free scene3d/film/core modules.

import { FilmPlanError } from "../../../scene3d/film/core/errors.js";
import { EASINGS } from "../../../scene3d/film/core/easing.js";
import { hashString } from "../../../scene3d/film/core/rng.js";
import {
  hex32,
  isIndoorCell,
  landblockOfWorld,
  lbKeyOf,
  parseCellId,
  worldFromLocal,
} from "../../../scene3d/film/core/units.js";

/** Plan JSON schema version handled here. */
export const PLAN_VERSION = 1;

/** Max characters of a shot's standing order (the JEV pilot reads it every tick; tokens cost money). */
export const STANDING_ORDER_MAX = 300;

/** Shot and site ids: also used as file names (takes/<shotId>.h264), so no paths, spaces or dots-only. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Transition types a shot may begin with (the transition FROM the previous shot). */
export const TRANSITION_TYPES = Object.freeze(["cut", "dissolve", "fade", "fadewhite"]);

/** Default ffmpeg xfade transition per plan transition type. */
export const XFADE_FOR = Object.freeze({ dissolve: "fade", fade: "fadeblack", fadewhite: "fadewhite" });

/** ffmpeg xfade transition names accepted as an explicit `transition.xfade` override. */
export const XFADE_TRANSITIONS = Object.freeze([
  "fade", "fadeblack", "fadewhite", "fadegrays", "dissolve", "distance", "wipeleft", "wiperight", "wipeup",
  "wipedown", "slideleft", "slideright", "slideup", "slidedown", "smoothleft", "smoothright", "smoothup",
  "smoothdown", "circlecrop", "rectcrop", "circleclose", "circleopen", "horzclose", "horzopen", "vertclose",
  "vertopen", "diagbl", "diagbr", "diagtl", "diagtr", "hlslice", "hrslice", "vuslice", "vdslice", "pixelize",
  "radial", "hblur", "zoomin",
]);

/** Subject kinds. */
export const SUBJECT_KINDS = Object.freeze(["point", "entity", "player", "path"]);

/** JEV pilot modes (SPEC §2.14 createPilot). */
export const PILOT_MODES = Object.freeze(["jev", "code", "shadow"]);

/** `shot.pilot.fade`: 'never' = the pilot may fade nothing (mapper maxFadeIds 0); 'auto' = the pilot's own rules. */
export const PILOT_FADE_MODES = Object.freeze(["never", "auto"]);

/** Keys of `plan.edit` (others warn). */
export const EDIT_KEYS = Object.freeze(["fadeInSec", "fadeOutSec", "tail"]);

/** Keys of `plan.edit.tail` (`from` required; others are errors — a typo would silently fall back to a default). */
export const TAIL_KEYS = Object.freeze(["from", "gapSec", "fadeOutSec"]);

/** Most `site.prime` commands per site (each costs a teleport + a readiness gate before the site teleport). */
export const PRIME_MAX = 12;

/** Keys of `shot.overlay` (others warn: the page ignores them). */
export const OVERLAY_KEYS = Object.freeze(["props"]);

/** Keys of `shot.overlay.props` (others warn). */
export const OVERLAY_PROP_KEYS = Object.freeze(["style", "opacity", "tint"]);

/** `shot.overlay.props.style`: the FPV frame the propellers belong to. */
export const OVERLAY_PROP_STYLES = Object.freeze(["freestyle", "cinewhoop"]);

/**
 * Registry param types validated here (checkParams). A param of any other type (a technique's `list`, …) is
 * validated by the registry's own buildShot param check (checkRegistryParams).
 */
export const PLAN_PARAM_TYPES = Object.freeze(["number", "string", "boolean", "enum", "vec3"]);

/** Capture modes (SPEC §0: stepped film clock vs wall clock for server-driven motion). */
export const CAPTURE_MODES = Object.freeze(["stepped", "realtime"]);

/** Framing names (SPEC §2.10 FRAMINGS keys). */
export const FRAMING_NAMES = Object.freeze(["EWS", "WS", "FS", "MWS", "MS", "MCU", "CU", "ECU"]);

/** Plan kinds (informational). */
export const PLAN_KINDS = Object.freeze(["music-video", "story", "reel"]);

/** Named times of day accepted by `look.timeOfDay` (runtime/look.js presets). */
export const LOOK_TIMES = Object.freeze({ night: 0.0, dawn: 0.21, morning: 0.33, noon: 0.5, golden: 0.82, dusk: 0.89 });

/** `look.fog` values. */
export const LOOK_FOGS = Object.freeze(["none", "white", "red", "blue", "green", "black"]);

/** `look.grade` presets. */
export const LOOK_GRADES = Object.freeze(["neutral", "warm", "cool", "bleach", "night"]);

/** Known `look` keys (others warn). */
const LOOK_KEYS = Object.freeze(["timeOfDay", "dayGroup", "fog", "exposure", "grade", "bloom", "vignette", "dof"]);

/**
 * Keys of `look.dof` that runtime/look.js forwards to `window.__dof` (others are silently ignored there, so they
 * warn here). The seam's setters (atmosphere_pipeline.js createFilmDof) throw RangeError unless focusDistance and
 * bokehScale are finite ≥ 0 and focusRange is finite > 0; `target` is THREE-world [x, y, z] / {x, y, z} or null;
 * `enabled` is a boolean (default true when a dof look is applied). null number = leave unchanged.
 */
export const LOOK_DOF_KEYS = Object.freeze(["focusDistance", "focusRange", "bokehScale", "enabled", "target"]);

/**
 * Shot `bounds` keys and ranges: the director's override of the JEV pilot bounds (ShotSpec.bounds, SPEC §2.11).
 * Mirrors scene3d/film/shots/trajectory.js normalizeBounds (BOUND_KEYS), which buildShot applies on top of the
 * technique's defaultBounds — an unknown key or an out-of-range value makes the page refuse the shot.
 * maxLateral / maxRise / maxSink are metres of offset from the planned path; the speed scales multiply the
 * progress rate; distanceScale multiplies the subject distance within [1/maxDistanceScale, maxDistanceScale].
 * @type {Readonly<Record<string, Readonly<{min:number, max:number, unit:string}>>>}
 */
export const SHOT_BOUND_RULES = Object.freeze({
  maxLateral: Object.freeze({ min: 0, max: Infinity, unit: "m" }),
  maxRise: Object.freeze({ min: 0, max: Infinity, unit: "m" }),
  maxSink: Object.freeze({ min: 0, max: Infinity, unit: "m" }),
  minSpeedScale: Object.freeze({ min: 0, max: 1, unit: "×" }),
  maxSpeedScale: Object.freeze({ min: 1, max: Infinity, unit: "×" }),
  maxDistanceScale: Object.freeze({ min: 1, max: Infinity, unit: "×" }),
});

/**
 * Leg length (metres) of the synthetic indoor route the offline dry build gives a shot with a `route`: an L of two
 * legs (west → anchor → north). The real route comes from planIndoorPath in the page; this one only lets the
 * technique (fpv.fpv-corridor, …) build so its params and duration are exercised.
 */
export const DRY_ROUTE_LEG_M = 10;

/**
 * Technique ids of the SPEC §2.12 catalogue. Used when no registry is injected: an id outside this list is a
 * WARNING (pass the real registry to make it an error).
 */
export const KNOWN_TECHNIQUE_IDS = Object.freeze([
  ...["static", "pan", "tilt", "roll", "zoom", "dolly-in", "dolly-out", "truck", "pedestal", "crane", "arc", "orbit",
    "tracking-follow", "tracking-lead", "tracking-side", "push-in", "pull-out-reveal", "dolly-zoom", "whip-pan",
    "rack-focus", "over-the-shoulder", "pov", "two-shot", "establishing", "high-angle", "low-angle", "birds-eye",
    "worms-eye", "handheld", "steadicam", "snorricam", "reveal-from-occluder", "time-lapse", "hyperlapse",
  ].map((n) => `classic.${n}`),
  ...["flyover", "flythrough", "orbit-poi", "helix", "dronie", "boom-rise", "rising-reveal", "tilt-reveal", "top-down",
    "top-down-rise", "top-down-track", "pass-over", "parallax-slide", "terrain-skim", "canyon-run", "chase", "lead",
    "side-track", "boomerang", "fly-by", "spiral-descent", "pano-360", "hyperlapse-orbit", "vertigo-drone",
  ].map((n) => `drone.${n}`),
  ...["fpv-dive", "fpv-proximity", "fpv-gap", "fpv-flip", "fpv-corridor", "fpv-run"].map((n) => `fpv.${n}`),
]);

const TECHNIQUE_ID_RE = /^(classic|drone|fpv)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Defaults filled by normalizePlan. */
export const PLAN_DEFAULTS = Object.freeze({
  format: Object.freeze({ width: 1920, height: 1080, fps: 30, capture: "stepped" }),
  transition: "cut",
  transitionSec: 0.5,
  pilotMode: "jev",
  captureMode: "stepped",
  siteSettleSec: 0,
  ready: Object.freeze({ settleSec: 3, timeoutSec: 90 }),
  songOffsetSec: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  /** edit.tail.gapSec: black hold between the music part's fade-out and the tail. */
  tailGapSec: 1.5,
  /** edit.tail.fadeOutSec: program fade-out on the last tail shot. */
  tailFadeOutSec: 3,
});

const TOP_KEYS = ["version", "title", "kind", "format", "song", "defaults", "edit", "sites", "shots", "notes", "script", "meta"];
const SITE_KEYS = ["id", "name", "gazetteerId", "teleport", "anchor", "cell", "indoor", "lbKeys", "interiorLb", "settleSec",
  "ready", "prime", "look", "notes", "tags"];
const SHOT_KEYS = ["id", "site", "technique", "family", "duration", "start", "params", "framing", "subject", "path", "route",
  "fov", "roll", "ease", "seed", "bounds", "trim", "transition", "standingOrder", "pilot", "capture", "actor", "look", "cell",
  "overlay", "lyric", "notes", "goal"];
/** Shot keys that look like positions but are not: point the director at `start`. */
const START_LIKE_KEYS = { section: "start: {section: N}", bar: "start: {bar: N}", beat: "start: {beat: N}", at: "start: {sec: T}", startSec: "start: {sec: T}" };
const ACTOR_KEYS = ["emote", "motion", "face", "moveTo", "moves", "at"];

// ── tiny helpers ──────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Deep copy of plain JSON-like data (objects/arrays); other values are passed through. */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

/** Levenshtein distance (small strings; used for "did you mean"). */
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

/** Up to 3 closest candidates for a "did you mean" hint. */
function suggest(word, candidates) {
  if (typeof word !== "string" || !word) return "";
  const scored = candidates
    .map((c) => ({ c, d: editDistance(word.toLowerCase(), String(c).toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a.d - b.d || (a.c < b.c ? -1 : 1))
    .slice(0, 3)
    .map((x) => x.c);
  return scored.length ? ` (did you mean ${scored.map((s) => JSON.stringify(s)).join(" or ")}?)` : "";
}

/** Safe uint32 parse; null when unparseable. */
function tryCell(v) {
  try {
    return parseCellId(v);
  } catch {
    return null;
  }
}

/**
 * Technique family from an id prefix (`drone.pass-over` → `drone`); null when the id has no known prefix.
 * @param {string} id
 * @returns {'classic'|'drone'|'fpv'|null}
 */
export function techniqueFamily(id) {
  if (typeof id !== "string") return null;
  const m = /^(classic|drone|fpv)\./.exec(id);
  return m ? /** @type {'classic'|'drone'|'fpv'} */ (m[1]) : null;
}

/**
 * Parse a duration: `{sec}`, `{beats}`, `{bars}`, a number (seconds) or a string ("3.5s", "8 beats", "2 bars").
 * Returns the canonical one-key object, or null when the input is not a recognisable duration (the value inside
 * is NOT range-checked here — validatePlan does that with a precise message).
 * @param {*} d
 * @returns {{sec:number}|{beats:number}|{bars:number}|null}
 */
export function parseDuration(d) {
  if (typeof d === "number") return { sec: d };
  if (typeof d === "string") {
    const m = /^\s*([0-9]*\.?[0-9]+)\s*(s|sec|secs|second|seconds|beat|beats|bar|bars)?\s*$/i.exec(d);
    if (!m) return null;
    const n = Number(m[1]);
    const u = (m[2] || "s").toLowerCase();
    if (u.startsWith("beat")) return { beats: n };
    if (u.startsWith("bar")) return { bars: n };
    return { sec: n };
  }
  if (isObj(d)) {
    const keys = Object.keys(d);
    if (keys.length === 1 && ["sec", "beats", "bars"].includes(keys[0])) return { [keys[0]]: d[keys[0]] };
  }
  return null;
}

/**
 * Parse an explicit start: `{sec}`, `{beat}`, `{bar}`, `{section}` (song indices, 0-based) or a number (seconds).
 * @param {*} s
 * @returns {{sec:number}|{beat:number}|{bar:number}|{section:number}|null}
 */
export function parseStart(s) {
  if (typeof s === "number") return { sec: s };
  if (isObj(s)) {
    const keys = Object.keys(s);
    if (keys.length === 1 && ["sec", "beat", "bar", "section"].includes(keys[0])) return { [keys[0]]: s[keys[0]] };
  }
  return null;
}

/** True when a duration/start needs the song's beat grid. */
function isMusical(o) {
  return isObj(o) && (has(o, "beats") || has(o, "bars") || has(o, "beat") || has(o, "bar") || has(o, "section"));
}

/**
 * Check a standing order: one sentence, one line, ≤ STANDING_ORDER_MAX characters.
 * A sentence boundary is a `.`, `!` or `?` followed by whitespace and an upper-case letter ("2.5 m" and "e.g. foliage"
 * are fine).
 * @param {*} text
 * @returns {{ok:boolean, message:string|null}}
 */
export function checkStandingOrder(text) {
  if (typeof text !== "string") return { ok: false, message: "standingOrder must be a string (one sentence)" };
  const t = text.trim();
  if (!t) return { ok: false, message: "standingOrder is empty" };
  if (/[\r\n]/.test(t)) return { ok: false, message: "standingOrder must be a single line (one sentence)" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return { ok: false, message: "standingOrder contains control characters" };
  if (t.length > STANDING_ORDER_MAX) {
    return { ok: false, message: `standingOrder is ${t.length} characters; the JEV pilot reads it every tick — keep it to one sentence of at most ${STANDING_ORDER_MAX}` };
  }
  if (/[.!?]["'”’)\]]*\s+["'“‘(]*[A-Z]/.test(t)) {
    return { ok: false, message: "standingOrder must be ONE sentence (found a sentence break); join the clauses with ';' or ','" };
  }
  return { ok: true, message: null };
}

// ── normalisation ────────────────────────────────────────────────────────────────────────────────────────────

/** Canonical transition object; leaves unrecognisable input untouched for validation to report. */
function normTransition(t, fallback) {
  if (t === undefined || t === null) t = fallback;
  if (typeof t === "string") t = { type: t };
  if (!isObj(t)) return t;
  const out = clone(t);
  if (out.type === undefined) out.type = "cut";
  if (out.type === "cut") {
    out.durationSec = 0;
    delete out.xfade;
  } else if (TRANSITION_TYPES.includes(out.type)) {
    if (out.durationSec === undefined || out.durationSec === null) out.durationSec = PLAN_DEFAULTS.transitionSec;
    if (out.xfade === undefined || out.xfade === null) out.xfade = XFADE_FOR[out.type];
  }
  return out;
}

/** Merge look objects left→right (shallow; later wins). */
function mergeLook(...looks) {
  const out = {};
  for (const l of looks) if (isObj(l)) Object.assign(out, clone(l));
  return out;
}

function normSite(site) {
  if (!isObj(site)) return site;
  const s = clone(site);
  // anchor: [x,y,z] world metres, or {cell, local:[x,y,z]} / {cell, x, y, z} landblock-local → world.
  if (isObj(s.anchor)) {
    const a = s.anchor;
    const local = Array.isArray(a.local) ? a.local : [a.x, a.y, a.z];
    const cell = tryCell(a.cell);
    if (cell !== null && local.length === 3 && local.every(isNum)) {
      try {
        s.anchor = worldFromLocal(cell, local[0], local[1], local[2]);
        if (s.cell === undefined) s.cell = cell;
      } catch { /* leave as-is; validate reports */ }
    }
  }
  const cell = s.cell === undefined || s.cell === null ? null : tryCell(s.cell);
  if (s.cell !== undefined && s.cell !== null && cell !== null) s.cell = hex32(cell);
  if (s.cell === undefined) s.cell = null;
  if (s.indoor === undefined) s.indoor = cell !== null ? isIndoorCell(cell) : false;
  if (s.lbKeys === undefined) {
    if (cell !== null) s.lbKeys = [hex32(lbKeyOf(cell))];
    else if (isVec3(s.anchor)) {
      try { s.lbKeys = [hex32(landblockOfWorld(s.anchor[0], s.anchor[1]))]; } catch { s.lbKeys = []; }
    } else s.lbKeys = [];
  } else if (Array.isArray(s.lbKeys)) {
    s.lbKeys = s.lbKeys.map((k) => {
      const u = tryCell(k);
      return u === null ? k : hex32((u & 0xffff0000) >>> 0);
    });
  }
  if (s.interiorLb === undefined) s.interiorLb = s.indoor === true && cell !== null ? hex32(lbKeyOf(cell)) : null;
  else if (s.interiorLb !== null) {
    const u = tryCell(s.interiorLb);
    if (u !== null) s.interiorLb = hex32((u & 0xffff0000) >>> 0);
  }
  if (s.settleSec === undefined) s.settleSec = PLAN_DEFAULTS.siteSettleSec;
  s.ready = isObj(s.ready) ? { ...PLAN_DEFAULTS.ready, ...s.ready } : s.ready === undefined ? { ...PLAN_DEFAULTS.ready } : s.ready;
  if (s.look === undefined) s.look = {};
  if (s.name === undefined) s.name = s.id;
  return s;
}

/** The player-as-actor cue walks (`moves: true` or a `moveTo` target). */
function actorMoves(actor) {
  return isObj(actor) && (actor.moves === true || (actor.moveTo !== undefined && actor.moveTo !== null));
}

/** Shot needs wall-clock capture (server-driven motion): moving actor or a `moving` entity/player subject. */
function needsRealtime(shot) {
  const subjectMoves = isServerSubject(shot.subject) && shot.subject.moving === true;
  return actorMoves(shot.actor) || subjectMoves;
}

/** Subject the server drives (its pose arrives on the wall clock): an entity or the player. */
function isServerSubject(subj) {
  return isObj(subj) && (subj.kind === "entity" || subj.kind === "player");
}

/**
 * The technique's capture hint from an injected registry (`def.capture`, the same value buildShot stamps on
 * `meta.capture`): 'realtime' for the moving-subject techniques (classic.tracking-*, drone.chase / lead /
 * side-track / top-down-track), 'stepped' otherwise; null without a registry, for an unknown id or no hint.
 * @param {TechniqueRegistry|null|undefined} registry
 * @param {*} id
 * @returns {'stepped'|'realtime'|null}
 */
function captureHint(registry, id) {
  if (typeof id !== "string") return null;
  const def = getDef(registry, id);
  return def && CAPTURE_MODES.includes(def.capture) ? def.capture : null;
}

function normShot(shot, ctx) {
  if (!isObj(shot)) return shot;
  const s = clone(shot);
  const parsedDur = parseDuration(s.duration);
  if (parsedDur) s.duration = parsedDur;
  if (s.start !== undefined && s.start !== null) {
    const ps = parseStart(s.start);
    if (ps) s.start = ps;
  } else s.start = null;
  if (s.family === undefined) s.family = techniqueFamily(s.technique);
  if (s.params === undefined || s.params === null) s.params = {};
  if (s.framing === undefined) s.framing = ctx.defaults.framing ?? null;
  if (s.ease === undefined) s.ease = ctx.defaults.ease ?? null;
  if (s.fov === undefined) s.fov = null;
  if (s.roll === undefined) s.roll = null;
  if (s.subject === "player") s.subject = { kind: "player" };
  if (s.subject === undefined) s.subject = null;
  if (isObj(s.subject) && s.subject.kind === "entity" && s.subject.moving === undefined) s.subject.moving = false;
  if (s.path === undefined) s.path = null;
  if (s.route === undefined) s.route = null;
  if (s.seed === undefined || s.seed === null) s.seed = hashString(`${ctx.title}|${typeof s.id === "string" ? s.id : ""}`);
  if (s.bounds === undefined) s.bounds = null;
  if (s.trim === undefined) s.trim = null;
  s.transition = normTransition(s.transition, ctx.defaults.transition);
  if (typeof s.standingOrder === "string") s.standingOrder = s.standingOrder.trim() || null;
  else if (s.standingOrder === undefined) s.standingOrder = null;
  if (s.pilot === undefined || s.pilot === null) s.pilot = {};
  if (isObj(s.pilot)) s.pilot = { ...clone(ctx.defaults.pilot), ...s.pilot };
  if (s.actor === undefined) s.actor = null;
  if (isObj(s.actor) && s.actor.moves === undefined) s.actor.moves = s.actor.moveTo !== undefined && s.actor.moveTo !== null;
  // The player as subject AND walking actor is live: `moving: true` makes the page follow it every frame
  // (ctx.subjectAt — sensors, pilot framing, take metrics), the same contract as a `moving` entity. Explicit wins.
  if (isObj(s.subject) && s.subject.kind === "player" && s.subject.moving === undefined && actorMoves(s.actor)) s.subject.moving = true;
  // capture: explicit wins; otherwise wall clock when the shot shows server-driven motion (a moving actor or entity,
  // or — with a registry — a technique whose capture hint is 'realtime' following an entity/player subject), else
  // the plan default.
  if (s.capture === undefined || s.capture === null) s.capture = {};
  if (typeof s.capture === "string") s.capture = { mode: s.capture };
  if (isObj(s.capture) && s.capture.mode === undefined) {
    if (needsRealtime(s) || (isServerSubject(s.subject) && captureHint(ctx.registry, s.technique) === "realtime")) {
      s.capture.mode = "realtime";
      s.capture.auto = true;
    } else s.capture.mode = ctx.format.capture;
  }
  const site = ctx.siteById.get(s.site);
  s.look = mergeLook(ctx.defaults.look, site && site.look, s.look);
  if (s.cell === undefined) s.cell = null;
  if (s.cell !== null) {
    const u = tryCell(s.cell);
    if (u !== null) s.cell = hex32(u);
  }
  if (s.lyric === undefined) s.lyric = null;
  if (s.notes === undefined) s.notes = null;
  return s;
}

/**
 * Fill every default of Plan JSON v1. Pure: returns a new object (the input is not modified), idempotent
 * (`normalizePlan(normalizePlan(p))` deep-equals `normalizePlan(p)`) and total — malformed values are left in place
 * for validatePlan to report, it never throws. Non-object input is returned unchanged.
 *
 * Defaults: version 1; format 1920×1080 @ 30 fps, capture 'stepped'; defaults.transition 'cut' (non-cut durationSec
 * 0.5, xfade per XFADE_FOR); defaults.pilot.mode 'jev'; song.offsetSec 0; edit fades 0; edit.tail (only when given;
 * a string is the `from` shot id) gapSec 1.5, fadeOutSec 3; site cell → hex string,
 * indoor from the cell, lbKeys from the cell (else the anchor's landblock), interiorLb for indoor cells, settleSec 0,
 * ready {settleSec:3, timeoutSec:90}; shot duration/start shorthand parsed, family from the technique id, params {},
 * seed = hashString(`${title}|${id}`), bounds null, a player subject `moving: true` when the actor walks (moveTo /
 * moves; explicit wins), capture.mode 'realtime' (+ `auto:true`) when the actor moves, an entity/player subject is
 * `moving`, or (with `opts.registry`) the technique's capture hint is 'realtime' and the subject is an entity or the
 * player — else format.capture; look = defaults.look ← site.look ← shot.look.
 * validatePlan / compilePlan normalize the RAW plan with their registry, so the capture hint is honoured there; a
 * plan normalized earlier without a registry keeps the capture modes it already has.
 * @param {object} plan
 * @param {{registry?:TechniqueRegistry|null}} [opts]
 * @returns {object}
 */
export function normalizePlan(plan, opts = {}) {
  if (!isObj(plan)) return plan;
  const registry = isObj(opts) && opts.registry ? opts.registry : null;
  const p = clone(plan);
  if (p.version === undefined) p.version = PLAN_VERSION;
  if (p.title === undefined || p.title === null) p.title = "";
  if (p.format === undefined || p.format === null) p.format = {};
  if (isObj(p.format)) p.format = { ...PLAN_DEFAULTS.format, ...p.format };
  if (p.song === undefined) p.song = null;
  if (isObj(p.song)) {
    if (p.song.offsetSec === undefined || p.song.offsetSec === null) p.song.offsetSec = PLAN_DEFAULTS.songOffsetSec;
  }
  if (p.defaults === undefined || p.defaults === null) p.defaults = {};
  if (isObj(p.defaults)) {
    const d = p.defaults;
    d.transition = normTransition(d.transition, PLAN_DEFAULTS.transition);
    if (d.pilot === undefined || d.pilot === null) d.pilot = {};
    if (isObj(d.pilot) && d.pilot.mode === undefined) d.pilot.mode = PLAN_DEFAULTS.pilotMode;
    if (d.look === undefined || d.look === null) d.look = {};
  }
  if (p.edit === undefined || p.edit === null) p.edit = {};
  if (isObj(p.edit)) {
    if (p.edit.fadeInSec === undefined) p.edit.fadeInSec = PLAN_DEFAULTS.fadeInSec;
    if (p.edit.fadeOutSec === undefined) p.edit.fadeOutSec = PLAN_DEFAULTS.fadeOutSec;
    // edit.tail only when given (a plan without one normalizes — and hashes — exactly as before it existed)
    if (typeof p.edit.tail === "string") p.edit.tail = { from: p.edit.tail };
    if (isObj(p.edit.tail)) {
      if (p.edit.tail.gapSec === undefined) p.edit.tail.gapSec = PLAN_DEFAULTS.tailGapSec;
      if (p.edit.tail.fadeOutSec === undefined) p.edit.tail.fadeOutSec = PLAN_DEFAULTS.tailFadeOutSec;
    }
  }
  if (Array.isArray(p.sites)) p.sites = p.sites.map(normSite);
  const siteById = new Map();
  if (Array.isArray(p.sites)) for (const s of p.sites) if (isObj(s) && typeof s.id === "string" && !siteById.has(s.id)) siteById.set(s.id, s);
  const ctx = {
    title: typeof p.title === "string" ? p.title : "",
    format: isObj(p.format) ? p.format : PLAN_DEFAULTS.format,
    defaults: isObj(p.defaults)
      ? { ...p.defaults, pilot: isObj(p.defaults.pilot) ? p.defaults.pilot : { mode: PLAN_DEFAULTS.pilotMode } }
      : { transition: normTransition(PLAN_DEFAULTS.transition), pilot: { mode: PLAN_DEFAULTS.pilotMode }, look: {} },
    siteById,
    registry,
  };
  if (!CAPTURE_MODES.includes(ctx.format.capture)) ctx.format = { ...ctx.format, capture: PLAN_DEFAULTS.captureMode };
  if (Array.isArray(p.shots)) p.shots = p.shots.map((s) => normShot(s, ctx));
  return p;
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PlanIssue
 * @property {string} path JSON path of the offending field, e.g. `shots[3].params.radius` ('' = the whole plan)
 * @property {string} message human-readable explanation (shown to the director)
 */

/**
 * @typedef {object} TechniqueRegistry injected technique registry (scene3d/film/shots/index.js)
 * @property {(id:string) => (object|null)} getTechnique def `{id, family, params:{name:{type,default,min,max,values}},
 *   needs:{subject, path, indoor}}` or null for unknown ids
 * @property {(spec:object, ctx:object) => object} [buildShot] used only with `dryBuild:true`
 */

/** Validate a number field. Returns true when valid. */
function checkNum(v, path, err, { min = -Infinity, max = Infinity, integer = false, exclusiveMin = false, label } = {}) {
  const name = label || path;
  if (!isNum(v)) {
    err(path, `${name} must be a finite number (got ${JSON.stringify(v)})`);
    return false;
  }
  if (integer && !Number.isInteger(v)) {
    err(path, `${name} must be an integer (got ${v})`);
    return false;
  }
  if (exclusiveMin ? !(v > min) : v < min) {
    err(path, `${name} must be ${exclusiveMin ? ">" : "≥"} ${min} (got ${v})`);
    return false;
  }
  if (v > max) {
    err(path, `${name} must be ≤ ${max} (got ${v})`);
    return false;
  }
  return true;
}

function checkPoints(v, path, err, min = 2) {
  if (!Array.isArray(v) || v.length < min) {
    err(path, `must be an array of at least ${min} [x,y,z] world points`);
    return false;
  }
  let ok = true;
  v.forEach((p, i) => {
    if (!isVec3(p)) {
      err(`${path}[${i}]`, `point must be [x, y, z] finite world metres (got ${JSON.stringify(p)})`);
      ok = false;
    }
  });
  return ok;
}

function checkLook(look, path, err, warn) {
  if (look === undefined || look === null) return;
  if (!isObj(look)) {
    err(path, "look must be an object");
    return;
  }
  for (const k of Object.keys(look)) {
    if (!LOOK_KEYS.includes(k)) warn(`${path}.${k}`, `unknown look key "${k}"${suggest(k, LOOK_KEYS)} (known: ${LOOK_KEYS.join(", ")})`);
  }
  if (look.timeOfDay !== undefined && look.timeOfDay !== null) {
    const t = look.timeOfDay;
    if (typeof t === "string") {
      if (!has(LOOK_TIMES, t)) err(`${path}.timeOfDay`, `unknown timeOfDay "${t}" (use 0..1 or one of ${Object.keys(LOOK_TIMES).join(", ")})`);
    } else checkNum(t, `${path}.timeOfDay`, err, { min: 0, max: 1 });
  }
  if (look.fog !== undefined && look.fog !== null && !LOOK_FOGS.includes(look.fog)) {
    err(`${path}.fog`, `fog must be one of ${LOOK_FOGS.join(", ")} (got ${JSON.stringify(look.fog)})`);
  }
  if (look.grade !== undefined && look.grade !== null && !LOOK_GRADES.includes(look.grade)) {
    err(`${path}.grade`, `grade must be one of ${LOOK_GRADES.join(", ")} (got ${JSON.stringify(look.grade)})${suggest(String(look.grade), LOOK_GRADES)}`);
  }
  if (look.exposure !== undefined && look.exposure !== null) checkNum(look.exposure, `${path}.exposure`, err, { min: 0, max: 16, exclusiveMin: true });
  if (look.dayGroup !== undefined && look.dayGroup !== null) {
    const dg = look.dayGroup;
    if (!isObj(dg)) err(`${path}.dayGroup`, "dayGroup must be {day, year}");
    else {
      checkNum(dg.day, `${path}.dayGroup.day`, err, { min: 0, integer: true });
      checkNum(dg.year, `${path}.dayGroup.year`, err, { min: 0, integer: true });
    }
  }
  if (look.dof !== undefined && look.dof !== null) checkDof(look.dof, `${path}.dof`, err, warn);
}

/**
 * `look.dof` against what runtime/look.js forwards and the `window.__dof` setters accept (atmosphere_pipeline.js
 * createFilmDof): focusDistance / bokehScale finite ≥ 0, focusRange finite > 0 (the setter throws RangeError on 0),
 * null = leave unchanged; enabled boolean; target null or THREE-world [x, y, z] / {x, y, z}. Unknown keys warn (the
 * runtime ignores them).
 */
function checkDof(dof, path, err, warn) {
  if (!isObj(dof)) {
    err(path, `dof must be {focusDistance?, focusRange?, bokehScale?, enabled?, target?} (got ${JSON.stringify(dof)})`);
    return;
  }
  for (const k of Object.keys(dof)) {
    if (!LOOK_DOF_KEYS.includes(k)) warn(`${path}.${k}`, `unknown dof key "${k}"${suggest(k, LOOK_DOF_KEYS)} — window.__dof ignores it (known: ${LOOK_DOF_KEYS.join(", ")})`);
  }
  const num = (k, exclusiveMin, unit) => {
    if (dof[k] === undefined || dof[k] === null) return;
    checkNum(dof[k], `${path}.${k}`, err, { min: 0, exclusiveMin, label: `dof.${k}${unit}` });
  };
  num("focusDistance", false, " (metres)");
  num("focusRange", true, "");
  num("bokehScale", false, "");
  if (dof.enabled !== undefined && typeof dof.enabled !== "boolean") err(`${path}.enabled`, `dof.enabled must be true or false (got ${JSON.stringify(dof.enabled)})`);
  if (dof.target !== undefined && dof.target !== null) {
    const t = dof.target;
    const xyz = Array.isArray(t) ? t : isObj(t) ? [t.x, t.y, t.z] : null;
    if (!xyz || xyz.length !== 3 || !xyz.every(isNum)) {
      err(`${path}.target`, `dof.target must be [x, y, z] or {x, y, z} finite THREE-world metres (an AC point [x, y, z] is [x, z, -y]), or null (got ${JSON.stringify(t)})`);
    } else if (xyz[1] < -200 || xyz[1] > 2000) {
      warn(`${path}.target`, `dof.target is THREE-world (y = up): y = ${xyz[1]} m is not a plausible height — AC world coordinates pasted? (an AC point [x, y, z] is [x, z, -y]; or drop target and set focusDistance)`);
    }
  }
}

/** A site teleport (or, with `what` 'prime command', one of its `prime` commands): '@…', one line, ≤ 200 chars. */
function checkTeleport(cmd, path, err, warn, what = "teleport") {
  if (!isNonEmptyStr(cmd)) {
    err(path, `${what} must be an ACE admin command string starting with '@' (e.g. "${what === "teleport" ? "@telepoi Holtburg" : "@teleloc 0x002B035D 469.8 -130.2 -6"}")`);
    return;
  }
  if (!cmd.startsWith("@")) err(path, `${what} must start with '@' (world.teleport only sends admin commands); got ${JSON.stringify(cmd)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cmd)) err(path, `${what} must be a single line without control characters`);
  if (cmd.length > 200) err(path, `${what === "teleport" ? "teleport command" : what} is ${cmd.length} characters (max 200)`);
  if (cmd.startsWith("@") && !/^@(teleloc|telepoi|tele|teledungeon|teleto)\b/.test(cmd)) {
    warn(path, `${what} ${JSON.stringify(cmd.split(/\s+/)[0])} is not one of @teleloc/@telepoi/@tele/@teledungeon/@teleto`);
  }
}

/**
 * `site.prime`: an array of at most PRIME_MAX admin commands, each checked like the site teleport. `film shoot`
 * sends them before the site teleport (each followed by its readiness gate), so the hidden player walks through a
 * dungeon and the server streams the creatures along the way.
 */
function checkPrime(prime, path, err, warn) {
  if (prime === undefined || prime === null) return;
  if (!Array.isArray(prime)) {
    err(path, `prime must be an array of '@…' admin commands (≤ ${PRIME_MAX}) sent before the site teleport, e.g. ["@teleloc 0x002B035D 469.8 -130.2 -6"] (got ${JSON.stringify(prime)})`);
    return;
  }
  if (prime.length > PRIME_MAX) err(path, `prime has ${prime.length} commands (max ${PRIME_MAX}): each costs a teleport + a readiness gate before the site teleport`);
  prime.forEach((c, j) => checkTeleport(c, `${path}[${j}]`, err, warn, "prime command"));
}

/**
 * The index of the first silent-tail shot of a NORMALIZED plan (`edit.tail.from`), or -1 when the plan has no tail
 * or `from` is not a shot id after the first.
 * @param {object} plan normalized plan
 * @returns {number}
 */
export function tailIndexOf(plan) {
  const t = isObj(plan) && isObj(plan.edit) ? plan.edit.tail : null;
  if (!isObj(t) || typeof t.from !== "string" || !Array.isArray(plan.shots)) return -1;
  const k = plan.shots.findIndex((s) => isObj(s) && s.id === t.from);
  return k >= 1 ? k : -1;
}

/**
 * `edit.tail` {from, gapSec, fadeOutSec} (normalized): `from` names a shot after the first; gapSec / fadeOutSec are
 * seconds in [0, 10]; unknown keys are errors. Returns the tail's first shot index, or -1.
 */
function checkTail(t, shots, err) {
  const path = "edit.tail";
  if (!isObj(t)) {
    err(path, `edit.tail must be {from: "<shot id>", gapSec?, fadeOutSec?} or the shot id (got ${JSON.stringify(t)})`);
    return -1;
  }
  for (const k of Object.keys(t)) if (!TAIL_KEYS.includes(k)) err(`${path}.${k}`, `unknown edit.tail key "${k}"${suggest(k, TAIL_KEYS)} (valid: ${TAIL_KEYS.join(", ")})`);
  checkNum(t.gapSec, `${path}.gapSec`, err, { min: 0, max: 10, label: "edit.tail.gapSec (seconds of black between the music and the tail)" });
  checkNum(t.fadeOutSec, `${path}.fadeOutSec`, err, { min: 0, max: 10, label: "edit.tail.fadeOutSec (program fade-out on the last tail shot)" });
  const ids = Array.isArray(shots) ? shots.filter(isObj).map((s) => s.id).filter((id) => typeof id === "string") : [];
  if (typeof t.from !== "string" || !t.from) {
    err(`${path}.from`, `edit.tail.from must be the id of the first shot of the silent tail (got ${JSON.stringify(t.from)})`);
    return -1;
  }
  const k = Array.isArray(shots) ? shots.findIndex((s) => isObj(s) && s.id === t.from) : -1;
  if (k < 0) {
    err(`${path}.from`, `edit.tail.from "${t.from}" is not a shot id${suggest(t.from, ids)}`);
    return -1;
  }
  if (k === 0) {
    err(`${path}.from`, `edit.tail.from "${t.from}" is the first shot: the tail is appended AFTER the music part, so at least one shot must come before it`);
    return -1;
  }
  return k;
}

/**
 * `shot.overlay`: {props: {style, opacity?, tint?}} — the page's lens overlay (FPV propellers). style is
 * 'freestyle' | 'cinewhoop', opacity 0..1, tint '#rrggbb'; unknown keys warn (the page ignores them).
 */
function checkOverlay(o, path, err, warn) {
  if (o === undefined || o === null) return;
  if (!isObj(o)) {
    err(path, `overlay must be an object {props: {style, opacity?, tint?}} (got ${JSON.stringify(o)})`);
    return;
  }
  for (const k of Object.keys(o)) {
    if (!OVERLAY_KEYS.includes(k)) warn(`${path}.${k}`, `unknown overlay key "${k}"${suggest(k, OVERLAY_KEYS)} — the page ignores it (known: ${OVERLAY_KEYS.join(", ")})`);
  }
  const pr = o.props;
  if (pr === undefined || pr === null) return;
  if (!isObj(pr)) {
    err(`${path}.props`, `overlay.props must be {style: ${OVERLAY_PROP_STYLES.map((s) => JSON.stringify(s)).join("|")}, opacity?, tint?} (got ${JSON.stringify(pr)})`);
    return;
  }
  for (const k of Object.keys(pr)) {
    if (!OVERLAY_PROP_KEYS.includes(k)) warn(`${path}.props.${k}`, `unknown overlay.props key "${k}"${suggest(k, OVERLAY_PROP_KEYS)} — the page ignores it (known: ${OVERLAY_PROP_KEYS.join(", ")})`);
  }
  if (!OVERLAY_PROP_STYLES.includes(pr.style)) {
    err(`${path}.props.style`, `overlay.props.style must be one of ${OVERLAY_PROP_STYLES.map((s) => JSON.stringify(s)).join(", ")} (got ${JSON.stringify(pr.style)})${typeof pr.style === "string" ? suggest(pr.style, OVERLAY_PROP_STYLES) : ""}`);
  }
  if (pr.opacity !== undefined && pr.opacity !== null) checkNum(pr.opacity, `${path}.props.opacity`, err, { min: 0, max: 1, label: "overlay.props.opacity" });
  if (pr.tint !== undefined && pr.tint !== null && !(typeof pr.tint === "string" && /^#[0-9a-fA-F]{6}$/.test(pr.tint))) {
    err(`${path}.props.tint`, `overlay.props.tint must be a "#rrggbb" colour (got ${JSON.stringify(pr.tint)})`);
  }
}

function checkSubject(subj, path, err) {
  if (subj === null || subj === undefined) return;
  if (!isObj(subj)) {
    err(path, `subject must be an object {kind, …} or "player" (got ${JSON.stringify(subj)})`);
    return;
  }
  if (!SUBJECT_KINDS.includes(subj.kind)) {
    err(`${path}.kind`, `subject.kind must be one of ${SUBJECT_KINDS.join(", ")} (got ${JSON.stringify(subj.kind)})`);
    return;
  }
  if (subj.radius !== undefined && subj.radius !== null) checkNum(subj.radius, `${path}.radius`, err, { min: 0, max: 500, exclusiveMin: true });
  if (subj.height !== undefined && subj.height !== null) checkNum(subj.height, `${path}.height`, err, { min: 0, max: 500, exclusiveMin: true });
  if (subj.heading !== undefined && subj.heading !== null) checkNum(subj.heading, `${path}.heading`, err);
  switch (subj.kind) {
    case "point":
      if (!isVec3(subj.pos)) err(`${path}.pos`, `a point subject needs pos: [x, y, z] world metres (got ${JSON.stringify(subj.pos)})`);
      break;
    case "entity": {
      const r = subj.ref;
      const okRef = (typeof r === "number" && Number.isInteger(r) && r > 0 && r < 4294967296) || isNonEmptyStr(r);
      if (!okRef) err(`${path}.ref`, `an entity subject needs ref: a guid (number or "0x…") or a name (got ${JSON.stringify(r)})`);
      if (subj.moving !== undefined && typeof subj.moving !== "boolean") err(`${path}.moving`, "moving must be true or false");
      break;
    }
    case "path":
      checkPoints(subj.points, `${path}.points`, err, 2);
      break;
    default:
      // player: only `moving` (normalized true when the shot's actor walks)
      if (subj.moving !== undefined && typeof subj.moving !== "boolean") err(`${path}.moving`, "moving must be true or false");
      break;
  }
}

/**
 * A shot's `bounds` override against SHOT_BOUND_RULES (= trajectory.js normalizeBounds): an object of known keys,
 * each a finite number in its range or null (= the technique default). buildShot throws on anything else, so these
 * are errors.
 */
function checkBounds(b, path, err) {
  if (b === null || b === undefined) return;
  const keys = Object.keys(SHOT_BOUND_RULES);
  if (!isObj(b)) {
    err(path, `bounds must be an object {${keys.map((k) => `${k}?`).join(", ")}} (got ${JSON.stringify(b)})`);
    return;
  }
  for (const k of Object.keys(b)) {
    const rule = SHOT_BOUND_RULES[k];
    if (!rule) {
      err(`${path}.${k}`, `unknown bounds key "${k}"${suggest(k, keys)} (valid: ${keys.join(", ")})`);
      continue;
    }
    if (b[k] === null) continue;
    const unit = rule.unit === "m" ? " (metres)" : "";
    checkNum(b[k], `${path}.${k}`, err, { min: rule.min, max: rule.max, label: `bounds.${k}${unit}` });
  }
}

/** Keys of a shot's `trim` (both required). */
export const TRIM_KEYS = Object.freeze(["takeSec", "inSec"]);

function checkTrim(t, duration, path, err, warn, songDeclared) {
  if (t === null || t === undefined) return;
  if (!isObj(t)) {
    err(path, `trim must be an object {takeSec, inSec} (got ${JSON.stringify(t)})`);
    return;
  }
  for (const k of Object.keys(t)) if (!TRIM_KEYS.includes(k)) err(`${path}.${k}`, `unknown trim key "${k}"${suggest(k, TRIM_KEYS)} (valid: ${TRIM_KEYS.join(", ")})`);
  const okTake = checkNum(t.takeSec, `${path}.takeSec`, err, { min: 0, max: 600, exclusiveMin: true, label: "trim.takeSec (seconds the move is flown)" });
  const okIn = checkNum(t.inSec, `${path}.inSec`, err, { min: 0, label: "trim.inSec (seconds into the take where the edit starts)" });
  if (!okTake || !okIn) return;
  if (t.inSec >= t.takeSec) {
    err(`${path}.inSec`, `trim.inSec ${t.inSec} s must be inside the ${t.takeSec} s take`);
    return;
  }
  if (isObj(duration) && isNum(duration.sec) && duration.sec > t.takeSec + 1e-9) {
    // With a song the beat grid may still cut the edit inside the take (compile is the real check); without one the
    // seconds are used as written, so the window can never fit.
    const msg = `the ${duration.sec} s edit is longer than the ${t.takeSec} s take it is cut from (shorten duration; a longer trim.takeSec slows the move)`;
    if (songDeclared) warn(path, `${msg} — compile fails unless the beat grid shortens the edit`);
    else err(path, msg);
  }
}

function checkParams(params, def, path, err) {
  if (!isObj(params)) {
    err(path, "params must be an object");
    return;
  }
  const schema = isObj(def && def.params) ? def.params : {};
  const known = Object.keys(schema);
  for (const name of Object.keys(params)) {
    const p = `${path}.${name}`;
    const v = params[name];
    const ps = schema[name];
    if (!ps) {
      err(p, `unknown param "${name}" for ${def.id}${suggest(name, known)} (known: ${known.length ? known.join(", ") : "none"})`);
      continue;
    }
    switch (ps.type) {
      case "number": {
        if (!isNum(v)) {
          err(p, `${name} must be a number (got ${JSON.stringify(v)})`);
          break;
        }
        if (isNum(ps.min) && v < ps.min) err(p, `${name} = ${v} is below the minimum ${ps.min}`);
        if (isNum(ps.max) && v > ps.max) err(p, `${name} = ${v} is above the maximum ${ps.max}`);
        break;
      }
      case "string":
        if (typeof v !== "string") err(p, `${name} must be a string (got ${JSON.stringify(v)})`);
        break;
      case "boolean":
        if (typeof v !== "boolean") err(p, `${name} must be true or false (got ${JSON.stringify(v)})`);
        break;
      case "enum": {
        const values = Array.isArray(ps.values) ? ps.values : [];
        if (!values.includes(v)) err(p, `${name} must be one of ${values.map((x) => JSON.stringify(x)).join(", ")} (got ${JSON.stringify(v)})`);
        break;
      }
      case "vec3":
        if (!isVec3(v)) err(p, `${name} must be [x, y, z] finite numbers (got ${JSON.stringify(v)})`);
        break;
      default:
        break; // a type this file does not know (e.g. 'list'): checkRegistryParams asks the registry itself
    }
  }
}

/**
 * Framing name the param probe passes so the registry's buildShot stops right after its own param check
 * (registry.js buildShot: duration → fillParams/coerceParam → framing), before any context or build work.
 */
const PARAM_PROBE_FRAMING = "\u0000plan-param-probe";

/**
 * Params whose registry type is not one of PLAN_PARAM_TYPES (a technique's `list` of zones / tricks, …) are checked
 * by the registry's OWN validation: `registry.buildShot({technique, duration: 1, params, framing: <invalid>}, {})`
 * runs its param check first and stops at the framing check right after it, so nothing is built. A BAD_PARAM that
 * names one of those params becomes an error at `<path>.<param>` with the registry's message; anything else (the
 * probe's own framing error, a missing context, a registry without that order) proves nothing and is ignored — the
 * params of known types are checkParams' job and the dry build still runs.
 */
function checkRegistryParams(params, def, technique, registry, path, err) {
  if (!isObj(params) || !def || !registry || typeof registry.buildShot !== "function") return;
  const schema = isObj(def.params) ? def.params : {};
  const own = Object.keys(params).filter((k) => isObj(schema[k]) && !PLAN_PARAM_TYPES.includes(schema[k].type));
  if (!own.length) return;
  try {
    registry.buildShot({ technique, duration: 1, params: clone(params), framing: PARAM_PROBE_FRAMING }, {});
  } catch (e) {
    const name = e && isObj(e.details) ? e.details.param : undefined;
    if (e && e.code === "BAD_PARAM" && own.includes(name)) {
      err(`${path}.${name}`, `${name} (${schema[name].type}): ${e.message ? String(e.message) : "rejected by the registry"}`);
    }
  }
}

function getDef(registry, id) {
  if (!registry || typeof registry.getTechnique !== "function") return undefined;
  try {
    return registry.getTechnique(id) || null;
  } catch {
    return null;
  }
}

/**
 * The synthetic indoor route of the dry build: a 2-leg L through the anchor (DRY_ROUTE_LEG_M west of it → the
 * anchor → DRY_ROUTE_LEG_M north of it, at the anchor's height) — one 90° corner, like a corridor turn.
 * @param {number[]} a anchor [x, y, z]
 * @returns {number[][]}
 */
function dryRoute(a) {
  const L = DRY_ROUTE_LEG_M;
  return [[a[0] - L, a[1], a[2]], [a[0], a[1], a[2]], [a[0], a[1] + L, a[2]]];
}

/**
 * Minimal offline ShotContext for an optional dry build, shaped like the page's (scene3d/film/index.js
 * resolveTake): subject at its point (entity/player → the anchor), path from shot.path / a path subject, and
 * `indoor` = {route} for a shot with a `route` (a synthetic L — the real one is planned in the page) or {} at an
 * indoor site.
 */
function dryContext(shot, site, plan) {
  const anchor = isVec3(site && site.anchor) ? site.anchor : [0, 0, 0];
  let subject = null;
  const s = shot.subject;
  if (isObj(s)) {
    const pos = s.kind === "point" && isVec3(s.pos) ? s.pos : anchor;
    if (s.kind !== "path") subject = { pos, radius: isNum(s.radius) ? s.radius : 0.6, height: isNum(s.height) ? s.height : 1.8 };
  }
  const path = Array.isArray(shot.path) ? shot.path : isObj(s) && s.kind === "path" ? s.points : undefined;
  const ctx = {
    subject,
    anchor,
    groundZ: () => null,
    path,
    aspect: plan.format.width / plan.format.height,
    fps: plan.format.fps,
  };
  if (isObj(shot.route)) ctx.indoor = { route: dryRoute(anchor) };
  else if (site && site.indoor === true) ctx.indoor = {};
  return ctx;
}

/**
 * Validate a plan (raw or normalized). Total: never throws, whatever the input.
 * Errors make `ok` false; warnings are advice the director should read (missing standing order, a moving actor
 * captured stepped, beats without a song, unused sites, unknown keys…).
 *
 * edit.tail: `from` must name a shot after the first, gapSec / fadeOutSec in [0, 10], unknown tail keys are errors,
 * and every tail shot needs a {sec} duration and no `start`. site.prime: ≤ PRIME_MAX commands, each checked like the
 * teleport. shot.overlay: props.style 'freestyle' | 'cinewhoop', opacity 0..1, tint '#rrggbb' (unknown keys warn).
 * shot.pilot.fade: 'never' | 'auto'. Unknown edit keys warn.
 * With `registry` (SPEC §2.11), unknown technique ids are errors (with "did you mean"), params are checked against
 * `def.params` (unknown name, number min/max, string, boolean, enum values, vec3; any other type — a `list` — by the
 * registry's own param check, see checkRegistryParams), `needs.subject` / `needs.path`
 * are enforced and `needs.indoor` mismatches the page cannot satisfy are errors. Without it, ids outside KNOWN_TECHNIQUE_IDS only warn.
 * With a registry, the technique's capture hint is honoured: a 'realtime' hint (moving-subject techniques) makes
 * capture default to realtime for an entity/player subject, and WARNS when the take stays stepped because the
 * subject is a fixed point (or missing).
 * With `dryBuild:true` and `registry.buildShot`, each {sec}-duration shot is also built against a flat offline
 * context (beats/bars need the song, so they are skipped); a shot with a `route` gets a synthetic indoor L route
 * (DRY_ROUTE_LEG_M legs through the anchor), an indoor site `indoor:{}` as in the page; a shot whose technique
 * already warned about an indoor/outdoor mismatch is not built again. Failures are WARNINGS (the real context
 * exists only in the page).
 * @param {object} plan
 * @param {{registry?:TechniqueRegistry|null, dryBuild?:boolean}} [opts]
 * @returns {{ok:boolean, errors:PlanIssue[], warnings:PlanIssue[], plan:object|null}}
 */
export function validatePlan(plan, opts = {}) {
  const { registry = null, dryBuild = false } = opts || {};
  /** @type {PlanIssue[]} */ const errors = [];
  /** @type {PlanIssue[]} */ const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isObj(plan)) {
    err("", `a plan must be a JSON object (got ${Array.isArray(plan) ? "an array" : JSON.stringify(plan)})`);
    return { ok: false, errors, warnings, plan: null };
  }

  // Raw-only checks (normalisation would hide them).
  if (plan.version === undefined) warn("version", `version missing; assuming ${PLAN_VERSION}`);
  else if (plan.version !== PLAN_VERSION) err("version", `unsupported plan version ${JSON.stringify(plan.version)} (this tool reads version ${PLAN_VERSION})`);
  for (const k of Object.keys(plan)) {
    if (!TOP_KEYS.includes(k)) warn(k, `unknown top-level key "${k}"${suggest(k, TOP_KEYS)}`);
  }

  let p;
  try {
    p = normalizePlan(plan, { registry });
  } catch (e) {
    err("", `plan could not be normalised: ${e && e.message ? e.message : e}`);
    return { ok: false, errors, warnings, plan: null };
  }

  // title / kind
  if (!isNonEmptyStr(p.title)) warn("title", "title missing (it names the timeline, the EDL and seeds every shot)");
  if (p.kind !== undefined && p.kind !== null && !PLAN_KINDS.includes(p.kind)) {
    warn("kind", `kind ${JSON.stringify(p.kind)} is not one of ${PLAN_KINDS.join(", ")}`);
  }

  // format
  if (!isObj(p.format)) err("format", "format must be an object {width, height, fps, capture}");
  else {
    const f = p.format;
    for (const k of ["width", "height"]) {
      if (checkNum(f[k], `format.${k}`, err, { min: 16, max: k === "width" ? 7680 : 4320, integer: true }) && f[k] % 2 !== 0) {
        err(`format.${k}`, `format.${k} must be even (H.264 4:2:0 output; got ${f[k]})`);
      }
    }
    checkNum(f.fps, "format.fps", err, { min: 1, max: 120, integer: true });
    if (!CAPTURE_MODES.includes(f.capture)) err("format.capture", `format.capture must be one of ${CAPTURE_MODES.join(", ")} (got ${JSON.stringify(f.capture)})`);
  }

  // song
  if (p.song !== null && p.song !== undefined) {
    if (!isObj(p.song)) err("song", "song must be an object {file?, analysis?, offsetSec?}");
    else {
      if (p.song.file !== undefined && p.song.file !== null && !isNonEmptyStr(p.song.file)) err("song.file", "song.file must be a path string");
      if (p.song.analysis !== undefined && p.song.analysis !== null && !isNonEmptyStr(p.song.analysis)) err("song.analysis", "song.analysis must be a path string (song.json from `film.mjs song analyze`)");
      checkNum(p.song.offsetSec, "song.offsetSec", err, { min: 0, max: 3600 });
    }
  }

  // defaults
  if (!isObj(p.defaults)) err("defaults", "defaults must be an object");
  else {
    const d = p.defaults;
    checkTransition(d.transition, "defaults.transition", err);
    if (!isObj(d.pilot)) err("defaults.pilot", "defaults.pilot must be an object {mode}");
    else if (!PILOT_MODES.includes(d.pilot.mode)) err("defaults.pilot.mode", `pilot mode must be one of ${PILOT_MODES.join(", ")} (got ${JSON.stringify(d.pilot.mode)})`);
    checkLook(d.look, "defaults.look", err, warn);
    if (d.framing !== undefined && d.framing !== null && !FRAMING_NAMES.includes(d.framing)) err("defaults.framing", `framing must be one of ${FRAMING_NAMES.join(", ")}`);
    if (d.ease !== undefined && d.ease !== null && !has(EASINGS, d.ease)) err("defaults.ease", `unknown easing ${JSON.stringify(d.ease)}${suggest(String(d.ease), Object.keys(EASINGS))}`);
  }

  // edit
  let tailAt = -1;
  if (!isObj(p.edit)) err("edit", "edit must be an object {fadeInSec?, fadeOutSec?, tail?}");
  else {
    for (const k of Object.keys(p.edit)) {
      if (!EDIT_KEYS.includes(k)) warn(`edit.${k}`, `unknown edit key "${k}"${suggest(k, EDIT_KEYS)} (known: ${EDIT_KEYS.join(", ")})`);
    }
    checkNum(p.edit.fadeInSec, "edit.fadeInSec", err, { min: 0, max: 10 });
    checkNum(p.edit.fadeOutSec, "edit.fadeOutSec", err, { min: 0, max: 10 });
    if (p.edit.tail !== undefined && p.edit.tail !== null) tailAt = checkTail(p.edit.tail, p.shots, err);
  }

  // sites
  const siteIds = new Map();
  if (!Array.isArray(p.sites) || p.sites.length === 0) err("sites", "sites must be a non-empty array (each site = one teleport)");
  else {
    p.sites.forEach((s, i) => {
      const path = `sites[${i}]`;
      if (!isObj(s)) {
        err(path, "site must be an object {id, teleport, anchor, …}");
        return;
      }
      for (const k of Object.keys(s)) if (!SITE_KEYS.includes(k)) warn(`${path}.${k}`, `unknown site key "${k}"${suggest(k, SITE_KEYS)}`);
      if (typeof s.id !== "string" || !ID_PATTERN.test(s.id)) {
        err(`${path}.id`, `site id must match ${ID_PATTERN} (letters, digits, _ . -; ≤ 64; got ${JSON.stringify(s.id)})`);
      } else if (siteIds.has(s.id)) err(`${path}.id`, `duplicate site id "${s.id}" (first at sites[${siteIds.get(s.id)}])`);
      else siteIds.set(s.id, i);
      checkTeleport(s.teleport, `${path}.teleport`, err, warn);
      checkPrime(s.prime, `${path}.prime`, err, warn);
      if (!isVec3(s.anchor)) {
        err(`${path}.anchor`, `anchor must be [x, y, z] AC world metres or {cell, local:[x, y, z]} (got ${JSON.stringify(s.anchor)})`);
      } else if (s.indoor !== true) {
        // Outdoor anchors are world metres: catch landblock-local numbers pasted as world (the commonest slip).
        const [x, y, z] = s.anchor;
        const cell = s.cell === null ? null : tryCell(s.cell);
        if (x < 0 || y < 0 || x >= 256 * 192 || y >= 256 * 192) {
          warn(`${path}.anchor`, `anchor [${x}, ${y}] is outside the 0..49152 m world square — local coordinates passed as world?`);
        } else if (cell !== null && landblockOfWorld(x, y) !== lbKeyOf(cell)) {
          warn(`${path}.anchor`, `anchor [${x}, ${y}] lies in landblock ${hex32(landblockOfWorld(x, y))}, not the cell's ${hex32(lbKeyOf(cell))} — local coordinates passed as world? (use {cell, local:[x,y,z]})`);
        } else if (cell === null && x < 192 && y < 192) {
          warn(`${path}.anchor`, `anchor [${x}, ${y}] is in landblock 0x00000000 (open ocean) — local coordinates passed as world? (use {cell, local:[x,y,z]})`);
        }
        if (z < -200 || z > 2000) warn(`${path}.anchor`, `anchor z = ${z} looks implausible`);
      }
      if (s.cell !== null && tryCell(s.cell) === null) err(`${path}.cell`, `cell must be a cell id like "0xA9B4001C" (got ${JSON.stringify(s.cell)})`);
      if (typeof s.indoor !== "boolean") err(`${path}.indoor`, "indoor must be true or false");
      else if (s.indoor && s.cell === null) warn(`${path}.cell`, "indoor site without a cell: the film viewer cell cannot be seeded on cuts (give the EnvCell id)");
      if (!Array.isArray(s.lbKeys)) err(`${path}.lbKeys`, "lbKeys must be an array of landblock ids");
      else s.lbKeys.forEach((k, j) => { if (tryCell(k) === null) err(`${path}.lbKeys[${j}]`, `not a landblock id: ${JSON.stringify(k)}`); });
      if (s.interiorLb !== null && tryCell(s.interiorLb) === null) err(`${path}.interiorLb`, `not a landblock id: ${JSON.stringify(s.interiorLb)}`);
      checkNum(s.settleSec, `${path}.settleSec`, err, { min: 0, max: 60 });
      if (!isObj(s.ready)) err(`${path}.ready`, "ready must be an object {settleSec, timeoutSec}");
      else {
        checkNum(s.ready.settleSec, `${path}.ready.settleSec`, err, { min: 0, max: 120 });
        checkNum(s.ready.timeoutSec, `${path}.ready.timeoutSec`, err, { min: 1, max: 600 });
      }
      if (s.name !== undefined && s.name !== null && typeof s.name !== "string") err(`${path}.name`, "name must be a string");
      checkLook(s.look, `${path}.look`, err, warn);
    });
  }

  // shots
  const shotIds = new Map();
  const usedSites = new Set();
  const songDeclared = isObj(p.song);
  if (!Array.isArray(p.shots) || p.shots.length === 0) err("shots", "shots must be a non-empty array, in EDIT order");
  else {
    p.shots.forEach((s, i) => {
      const path = `shots[${i}]`;
      if (!isObj(s)) {
        err(path, "shot must be an object {id, site, technique, duration, …}");
        return;
      }
      for (const k of Object.keys(s)) {
        if (SHOT_KEYS.includes(k)) continue;
        if (Object.prototype.hasOwnProperty.call(START_LIKE_KEYS, k)) warn(`${path}.${k}`, `"${k}" is ignored — to place the shot write ${START_LIKE_KEYS[k]}`);
        else warn(`${path}.${k}`, `unknown shot key "${k}"${suggest(k, SHOT_KEYS)}`);
      }
      const label = typeof s.id === "string" ? s.id : path;
      // id
      if (typeof s.id !== "string" || !ID_PATTERN.test(s.id)) {
        err(`${path}.id`, `shot id must match ${ID_PATTERN} (it names takes/<id>.mp4; got ${JSON.stringify(s.id)})`);
      } else if (shotIds.has(s.id)) err(`${path}.id`, `duplicate shot id "${s.id}" (first at shots[${shotIds.get(s.id)}])`);
      else shotIds.set(s.id, i);
      // site
      let site = null;
      if (typeof s.site !== "string" || !s.site) err(`${path}.site`, "site must reference a sites[].id");
      else if (!siteIds.has(s.site)) {
        err(`${path}.site`, `unknown site "${s.site}"${suggest(s.site, [...siteIds.keys()])} (sites: ${[...siteIds.keys()].join(", ") || "none"})`);
      } else {
        usedSites.add(s.site);
        site = p.sites[siteIds.get(s.site)];
      }
      // technique
      let def;
      if (typeof s.technique !== "string" || !TECHNIQUE_ID_RE.test(s.technique)) {
        err(`${path}.technique`, `technique must be an id like "drone.pass-over" (family classic|drone|fpv; got ${JSON.stringify(s.technique)})${typeof s.technique === "string" ? suggest(s.technique, KNOWN_TECHNIQUE_IDS) : ""}`);
      } else {
        def = getDef(registry, s.technique);
        if (def === null) {
          err(`${path}.technique`, `unknown technique "${s.technique}"${suggest(s.technique, KNOWN_TECHNIQUE_IDS)} (list them with \`film.mjs techniques\`)`);
        } else if (def === undefined && !KNOWN_TECHNIQUE_IDS.includes(s.technique)) {
          warn(`${path}.technique`, `technique "${s.technique}" is not in the SPEC §2.12 catalogue${suggest(s.technique, KNOWN_TECHNIQUE_IDS)}; validate with the registry to be sure`);
        }
      }
      // duration
      const d = s.duration;
      if (d === undefined || d === null) err(`${path}.duration`, "duration is required: {sec}, {beats} or {bars}");
      else if (!isObj(d) || Object.keys(d).length !== 1 || !["sec", "beats", "bars"].includes(Object.keys(d)[0])) {
        err(`${path}.duration`, `duration must be exactly one of {sec}, {beats}, {bars} (or 4 / "8 beats" / "2 bars"; got ${JSON.stringify(d)})`);
      } else {
        const k = Object.keys(d)[0];
        checkNum(d[k], `${path}.duration.${k}`, err, { min: 0, max: k === "sec" ? 600 : k === "beats" ? 2048 : 512, exclusiveMin: true });
        if (k !== "sec" && !songDeclared) warn(`${path}.duration`, `{${k}} needs a song analysis at compile time (plan.song is missing; pass --song=song.json)`);
      }
      // start
      if (s.start !== null && s.start !== undefined) {
        const st = s.start;
        if (!isObj(st) || Object.keys(st).length !== 1 || !["sec", "beat", "bar", "section"].includes(Object.keys(st)[0])) {
          err(`${path}.start`, `start must be one of {sec}, {beat}, {bar}, {section} (0-based song indices; got ${JSON.stringify(st)})`);
        } else {
          const k = Object.keys(st)[0];
          checkNum(st[k], `${path}.start.${k}`, err, { min: 0, integer: k !== "sec" });
          if (k !== "sec" && !songDeclared) warn(`${path}.start`, `{${k}} needs a song analysis at compile time (plan.song is missing)`);
        }
      }
      // the silent tail (edit.tail.from and every shot after it): exact seconds, placed after the music part
      const inTail = tailAt > 0 && i >= tailAt;
      if (inTail) {
        const tailFrom = p.edit.tail.from;
        if (isObj(d) && (has(d, "beats") || has(d, "bars"))) {
          err(`${path}.duration`, `${label} is in the silent tail (edit.tail.from "${tailFrom}"): its duration must be {sec} — the tail is not on the song's beat grid (got ${JSON.stringify(d)})`);
        }
        if (s.start !== null && s.start !== undefined) {
          err(`${path}.start`, `${label} is in the silent tail (edit.tail.from "${tailFrom}"): no explicit start — the tail follows the music part after edit.tail.gapSec of black`);
        }
      }
      // params + registry needs
      let indoorMismatch = false;
      if (def) {
        checkParams(s.params, def, `${path}.params`, err);
        checkRegistryParams(s.params, def, s.technique, registry, `${path}.params`, err);
        const needs = isObj(def.needs) ? def.needs : {};
        const hasPath = Array.isArray(s.path) || (isObj(s.subject) && s.subject.kind === "path") || isObj(s.route);
        if (needs.subject === true && (!isObj(s.subject) || s.subject.kind === "path")) {
          err(`${path}.subject`, `${s.technique} needs a subject (point, entity or player)`);
        }
        if (needs.path === true && !hasPath) err(`${path}.path`, `${s.technique} needs a path: shot.path points, a {kind:'path'} subject or an indoor route`);
        // The page's resolveTake gives the shot an indoor context exactly when it has a route or its site is
        // indoors, and registry.buildShot throws MISSING_CONTEXT on a mismatch — i.e. the take would fail only
        // AFTER the ≈10 s teleport. So a mismatch the page cannot satisfy is an ERROR here; an indoor technique
        // at an outdoor site that carries its own indoor route still builds (warning only).
        if (site && needs.indoor === true && site.indoor !== true) {
          indoorMismatch = true;
          if (isObj(s.route)) warn(`${path}.technique`, `${s.technique} is an indoor technique but site "${site.id}" is outdoors (the shot's route supplies the indoor context; make sure the player is streamed inside that dungeon)`);
          else err(`${path}.technique`, `${s.technique} is an indoor technique but site "${site.id}" is outdoors and the shot has no indoor route — the take would fail after the teleport (move it to an indoor site or add route:{fromCell, toCell})`);
        }
        if (site && needs.indoor === false && site.indoor === true) {
          indoorMismatch = true;
          err(`${path}.technique`, `${s.technique} is an outdoor technique but site "${site.id}" is indoors — the take would fail after the teleport (pick an indoor-capable technique or an outdoor site)`);
        }
      } else if (!isObj(s.params)) err(`${path}.params`, "params must be an object");
      // framing / fov / roll / ease / seed
      if (s.framing !== null && s.framing !== undefined && !FRAMING_NAMES.includes(s.framing)) {
        err(`${path}.framing`, `framing must be one of ${FRAMING_NAMES.join(", ")} (got ${JSON.stringify(s.framing)})${suggest(String(s.framing), FRAMING_NAMES)}`);
      }
      if (s.fov !== null && s.fov !== undefined) checkNum(s.fov, `${path}.fov`, err, { min: 5, max: 150, label: "fov (vertical degrees)" });
      if (s.roll !== null && s.roll !== undefined) checkNum(s.roll, `${path}.roll`, err, { min: -Math.PI, max: Math.PI, label: "roll (radians)" });
      if (s.ease !== null && s.ease !== undefined && !has(EASINGS, s.ease)) {
        err(`${path}.ease`, `unknown easing ${JSON.stringify(s.ease)}${suggest(String(s.ease), Object.keys(EASINGS))} (valid: ${Object.keys(EASINGS).join(", ")})`);
      }
      checkNum(s.seed, `${path}.seed`, err, { min: 0, max: 4294967295, integer: true });
      checkBounds(s.bounds, `${path}.bounds`, err);
      // a tail shot's seconds are used as written (no beat grid), so a {sec} edit longer than its take never fits
      checkTrim(s.trim, s.duration, `${path}.trim`, err, warn, songDeclared && !inTail);
      checkOverlay(s.overlay, `${path}.overlay`, err, warn);
      // subject / path / route
      checkSubject(s.subject, `${path}.subject`, err);
      if (s.path !== null && s.path !== undefined) checkPoints(s.path, `${path}.path`, err, 2);
      if (s.route !== null && s.route !== undefined) {
        if (!isObj(s.route)) err(`${path}.route`, "route must be {fromCell, toCell} (indoor EnvCell ids)");
        else {
          for (const k of ["fromCell", "toCell"]) {
            const u = tryCell(s.route[k]);
            if (u === null) err(`${path}.route.${k}`, `${k} must be an EnvCell id like "0x01F60289" (got ${JSON.stringify(s.route[k])})`);
            else if (!isIndoorCell(u)) err(`${path}.route.${k}`, `${k} ${hex32(u)} is not an indoor EnvCell`);
          }
          if (site && site.indoor !== true) warn(`${path}.route`, `indoor route on outdoor site "${site.id}"`);
        }
      }
      if (s.cell !== null && s.cell !== undefined && tryCell(s.cell) === null) err(`${path}.cell`, `cell must be a cell id (got ${JSON.stringify(s.cell)})`);
      // transition
      checkTransition(s.transition, `${path}.transition`, err);
      // standing order
      if (s.standingOrder === null || s.standingOrder === undefined) {
        warn(`${path}.standingOrder`, `${label}: no standingOrder — the JEV pilot reads this one sentence every tick (distances, what may be faded vs avoided)`);
      } else {
        const so = checkStandingOrder(s.standingOrder);
        if (!so.ok) err(`${path}.standingOrder`, so.message);
      }
      // pilot
      if (!isObj(s.pilot)) err(`${path}.pilot`, "pilot must be an object {mode, …}");
      else {
        if (!PILOT_MODES.includes(s.pilot.mode)) err(`${path}.pilot.mode`, `pilot mode must be one of ${PILOT_MODES.join(", ")} (got ${JSON.stringify(s.pilot.mode)})`);
        if (s.pilot.fade !== undefined && s.pilot.fade !== null && !PILOT_FADE_MODES.includes(s.pilot.fade)) {
          err(`${path}.pilot.fade`, `pilot.fade must be "never" (the pilot fades nothing in this take) or "auto" (got ${JSON.stringify(s.pilot.fade)})${typeof s.pilot.fade === "string" ? suggest(s.pilot.fade, PILOT_FADE_MODES) : ""}`);
        }
      }
      // actor
      if (s.actor !== null && s.actor !== undefined) {
        if (!isObj(s.actor)) err(`${path}.actor`, "actor must be an object {emote?, motion?, face?, moveTo?, moves?, at?}");
        else {
          const a = s.actor;
          for (const k of Object.keys(a)) if (!ACTOR_KEYS.includes(k)) warn(`${path}.actor.${k}`, `unknown actor key "${k}"${suggest(k, ACTOR_KEYS)}`);
          if (a.emote !== undefined && !isNonEmptyStr(a.emote)) err(`${path}.actor.emote`, "emote must be a string like \"/wave\"");
          if (a.motion !== undefined && !isNonEmptyStr(a.motion)) err(`${path}.actor.motion`, "motion must be a string");
          if (a.face !== undefined) checkNum(a.face, `${path}.actor.face`, err, { label: "face (compass radians)" });
          if (a.moveTo !== undefined && a.moveTo !== null && !isVec3(a.moveTo)) err(`${path}.actor.moveTo`, "moveTo must be [x, y, z] world metres");
          if (typeof a.moves !== "boolean") err(`${path}.actor.moves`, "moves must be true or false");
          if (a.at !== undefined) checkNum(a.at, `${path}.actor.at`, err, { min: 0 });
          if (isObj(s.subject) && s.subject.kind === "player" && s.subject.moving === false && actorMoves(a)) {
            warn(`${path}.subject.moving`, `${label}: the actor walks but the player subject says moving: false — the sensors, the pilot's framing and the take metrics stay on the start point while the avatar walks away (drop moving to follow it)`);
          }
        }
      }
      // capture
      if (!isObj(s.capture)) err(`${path}.capture`, "capture must be an object {mode}");
      else if (!CAPTURE_MODES.includes(s.capture.mode)) err(`${path}.capture.mode`, `capture mode must be one of ${CAPTURE_MODES.join(", ")} (got ${JSON.stringify(s.capture.mode)})`);
      else if (s.capture.mode === "stepped" && needsRealtime(s)) {
        warn(`${path}.capture.mode`, `${label}: ${actorMoves(s.actor) ? "the actor moves" : `the subject ${s.subject.kind} is moving`} — server-driven motion runs on the wall clock, so capture.mode must be "realtime" (stepped would freeze or stutter it)`);
      } else if (s.capture.mode === "stepped" && def && def.capture === "realtime" && !isServerSubject(s.subject)) {
        const what = isObj(s.subject) && s.subject.kind === "point" ? "a fixed point" : isObj(s.subject) ? `a ${s.subject.kind}` : "missing";
        warn(`${path}.capture.mode`, `${label}: ${s.technique} is made for a moving, server-driven subject (capture hint "realtime") but the subject is ${what}, so the take is captured stepped — follow {kind:"entity"} or {kind:"player"} (capture then defaults to realtime), or set capture.mode "realtime" if something server-driven must move in frame`);
      }
      checkLook(s.look, `${path}.look`, err, warn);
      // optional dry build with the real registry (a trimmed shot is built at its take length)
      const dryDur = isObj(s.trim) && isNum(s.trim.takeSec) && s.trim.takeSec > 0 ? s.trim.takeSec
        : isObj(s.duration) && has(s.duration, "sec") ? s.duration.sec : null;
      if (dryBuild && def && registry && typeof registry.buildShot === "function" && site && !indoorMismatch && dryDur !== null) {
        try {
          registry.buildShot(shotSpec(s, dryDur), dryContext(s, site, p));
        } catch (e) {
          warn(path, `${label}: dry build of ${s.technique} failed against a flat offline context: ${e && e.message ? e.message : e}`);
        }
      }
    });
  }

  if (Array.isArray(p.sites)) {
    p.sites.forEach((s, i) => {
      if (isObj(s) && typeof s.id === "string" && siteIds.get(s.id) === i && !usedSites.has(s.id)) {
        warn(`sites[${i}]`, `site "${s.id}" is never used by a shot (it would cost nothing, but check the plan)`);
      }
    });
  }
  return { ok: errors.length === 0, errors, warnings, plan: p };
}

function checkTransition(t, path, err) {
  if (!isObj(t)) {
    err(path, `transition must be one of ${TRANSITION_TYPES.join(", ")} or {type, durationSec} (got ${JSON.stringify(t)})`);
    return;
  }
  if (!TRANSITION_TYPES.includes(t.type)) {
    err(`${path}.type`, `transition type must be one of ${TRANSITION_TYPES.join(", ")} (got ${JSON.stringify(t.type)})${suggest(String(t.type), TRANSITION_TYPES)}`);
    return;
  }
  if (t.type !== "cut") {
    checkNum(t.durationSec, `${path}.durationSec`, err, { min: 0, max: 5, exclusiveMin: true });
    if (t.xfade !== undefined && t.xfade !== null && !XFADE_TRANSITIONS.includes(t.xfade)) {
      err(`${path}.xfade`, `unknown ffmpeg xfade transition ${JSON.stringify(t.xfade)}${suggest(String(t.xfade), XFADE_TRANSITIONS)}`);
    }
  }
}

/**
 * The SPEC §2.11 ShotSpec of a normalized shot for a given take duration. `bounds` carries only the keys the plan
 * sets to a number (an empty / all-null override is omitted: buildShot treats ANY spec.bounds as a full override
 * of the trajectory's own bounds, completed from the technique's defaultBounds).
 * @param {object} shot normalized shot
 * @param {number} durationSec
 * @returns {{technique:string, duration:number, params:object, framing?:string, subject?:object, fov?:number,
 *   roll?:number, ease?:string, bounds?:object, seed:number}}
 */
export function shotSpec(shot, durationSec) {
  const spec = { technique: shot.technique, duration: durationSec, params: clone(shot.params || {}), seed: shot.seed };
  if (shot.framing) spec.framing = shot.framing;
  if (shot.subject) spec.subject = clone(shot.subject);
  if (shot.fov !== null && shot.fov !== undefined) spec.fov = shot.fov;
  if (shot.roll !== null && shot.roll !== undefined) spec.roll = shot.roll;
  if (shot.ease) spec.ease = shot.ease;
  if (isObj(shot.bounds)) {
    const b = {};
    for (const k of Object.keys(shot.bounds)) if (shot.bounds[k] !== null && shot.bounds[k] !== undefined) b[k] = shot.bounds[k];
    if (Object.keys(b).length) spec.bounds = b;
  }
  return spec;
}

/**
 * Validate and return the normalized plan, or throw FilmPlanError whose message lists the first errors and whose
 * `details` carry `{errors, warnings}`.
 * @param {object} plan
 * @param {{registry?:TechniqueRegistry|null, dryBuild?:boolean}} [opts]
 * @returns {object} normalized plan
 */
export function assertValidPlan(plan, opts = {}) {
  const v = validatePlan(plan, opts);
  if (!v.ok) {
    const head = v.errors.slice(0, 4).map((e) => `${e.path || "(plan)"}: ${e.message}`).join("; ");
    const more = v.errors.length > 4 ? ` (+${v.errors.length - 4} more)` : "";
    throw new FilmPlanError(`plan is invalid — ${v.errors.length} error(s): ${head}${more}`, {
      code: "PLAN_INVALID",
      details: { errors: v.errors, warnings: v.warnings },
    });
  }
  return v.plan;
}

/** True when a normalized shot needs the song's beat grid. */
export function shotUsesSong(shot) {
  return isObj(shot) && (isMusical(shot.duration) || isMusical(shot.start));
}

// ── docs: field table + example ──────────────────────────────────────────────────────────────────────────────

/**
 * Field reference for Plan JSON v1 (the docs lane renders reference/plan-format.md from this).
 * @type {ReadonlyArray<{path:string, type:string, required:boolean, default:*, desc:string}>}
 */
export const PLAN_FIELDS = Object.freeze([
  { path: "version", type: "1", required: true, default: 1, desc: "schema version (missing → 1 with a warning)" },
  { path: "title", type: "string", required: false, default: "", desc: "names the timeline/EDL; seeds every shot's RNG" },
  { path: "kind", type: "'music-video'|'story'|'reel'", required: false, default: null, desc: "informational" },
  { path: "format.width / format.height", type: "even integer", required: false, default: "1920 / 1080", desc: "output and capture size" },
  { path: "format.fps", type: "integer 1..120", required: false, default: 30, desc: "film frame rate (EDL timecodes are non-drop at this rate)" },
  { path: "format.capture", type: "'stepped'|'realtime'", required: false, default: "stepped", desc: "default capture mode (stepped = film clock, smooth at any quality)" },
  { path: "song.file", type: "path", required: false, default: null, desc: "audio for assembly" },
  { path: "song.analysis", type: "path", required: false, default: null, desc: "song.json from `film.mjs song analyze` (the CLI loads it for compile)" },
  { path: "song.offsetSec", type: "seconds ≥ 0", required: false, default: 0, desc: "song time at edit t=0 (assembly uses -ss offset)" },
  { path: "defaults.transition", type: "transition", required: false, default: "cut", desc: "transition into each shot unless the shot sets one" },
  { path: "defaults.pilot.mode", type: "'jev'|'code'|'shadow'", required: false, default: "jev", desc: "JEV pilot mode for every shot" },
  { path: "defaults.look / defaults.framing / defaults.ease", type: "look / framing / easing", required: false, default: "{} / null / null", desc: "plan-wide fallbacks" },
  { path: "edit.fadeInSec / edit.fadeOutSec", type: "seconds 0..10", required: false, default: "0 / 0", desc: "fade from / to black at the very start / end (with edit.tail: fadeOutSec fades the last MUSIC shot, element-local)" },
  { path: "edit.tail", type: "{from, gapSec?, fadeOutSec?} | shot id", required: false, default: "absent; gapSec 1.5, fadeOutSec 3", desc: "a SILENT TAIL after the music: the shots from `from` (not the first shot) on are exact seconds (snap 'none'; no {beats}/{bars}, no start); the music part compiles as without a tail; gapSec (0..10) of black follows the music's fade-out; a non-cut transition into `from` is a fade-in from black/white (no handles); fadeOutSec (0..10) is the program fade-out; timeline.musicEnd {sec, frame, fadeOutSec}; assembly pads the song with silence" },
  { path: "sites[].id", type: "id", required: true, default: null, desc: "unique; referenced by shots[].site" },
  { path: "sites[].teleport", type: "'@…' command", required: true, default: null, desc: "the ACE admin teleport (gazetteer teleport.best), e.g. \"@telepoi Holtburg\"" },
  { path: "sites[].anchor", type: "[x,y,z] | {cell, local:[x,y,z]}", required: true, default: null, desc: "site centre in AC world metres (orders the schedule; ShotContext.anchor)" },
  { path: "sites[].cell", type: "cell id", required: false, default: null, desc: "EnvCell for dungeons (seeds the film viewer cell); outdoor cell otherwise" },
  { path: "sites[].indoor", type: "boolean", required: false, default: "from cell", desc: "dungeon/interior site" },
  { path: "sites[].lbKeys / sites[].interiorLb", type: "landblock ids", required: false, default: "from cell or anchor", desc: "readiness gate inputs (world.ready)" },
  { path: "sites[].settleSec", type: "seconds", required: false, default: 0, desc: "extra pre-roll before every take at this site (particles/foliage warm-up)" },
  { path: "sites[].ready", type: "{settleSec, timeoutSec}", required: false, default: "{3, 90}", desc: "world.ready options after the teleport" },
  { path: "sites[].prime", type: "['@…' admin commands] (≤ 12)", required: false, default: null, desc: "sent by `film shoot` BEFORE the site teleport, each followed by its readiness gate (event 'prime' in shoot-log.jsonl; a failure only warns): walk the hidden player through a dungeon so the server streams every creature along the route (its PVS), then the site teleport stands it at the site; each checked like `teleport`; estimateShootTime counts each as a teleport + settle" },
  { path: "sites[].look / name / gazetteerId / notes", type: "look / strings", required: false, default: null, desc: "site look applies to its shots" },
  { path: "shots[].id", type: "id", required: true, default: null, desc: "unique; names takes/<id>.mp4" },
  { path: "shots[].site", type: "site id", required: true, default: null, desc: "where the take is shot" },
  { path: "shots[].technique", type: "technique id", required: true, default: null, desc: "SPEC §2.12 id, e.g. drone.pass-over" },
  { path: "shots[].duration", type: "{sec}|{beats}|{bars}", required: true, default: null, desc: "edit length; beats/bars need the song; seconds snap to the nearest beat (section start within ½ bar) when a song is given" },
  { path: "shots[].start", type: "{sec}|{beat}|{bar}|{section}", required: false, default: null, desc: "explicit edit position (0-based SONG indices); otherwise follows the previous shot" },
  { path: "shots[].params", type: "object", required: false, default: {}, desc: "technique params (checked against the registry schema)" },
  { path: "shots[].framing / fov / roll / ease / seed", type: "FRAMING / deg / rad / easing / uint32", required: false, default: "null … seed=hash(title|id)", desc: "ShotSpec fields" },
  { path: "shots[].bounds", type: "{maxLateral?, maxRise?, maxSink?, minSpeedScale?, maxSpeedScale?, maxDistanceScale?}", required: false, default: null, desc: "ShotSpec.bounds: override of how far the JEV pilot may push the shot — metres ≥ 0 (lateral / rise / sink off the path), minSpeedScale 0..1, maxSpeedScale ≥ 1, maxDistanceScale ≥ 1; missing keys = the technique's defaultBounds" },
  { path: "shots[].trim", type: "{takeSec, inSec}", required: false, default: null, desc: "fly the move as a take of takeSec s (ShotSpec.duration, 0 < s ≤ 600) and cut the edit from inSec into it: a shorter edit keeps the move's speed and shows its best stretch. Compile keeps the window inside the take (moved to fit the dissolve handles, with a warning); an edit + handles longer than takeSec is a compile error (a {sec} request longer than takeSec: a validation error without a song, a warning with one)" },
  { path: "shots[].subject", type: "{kind:'point'|'entity'|'player'|'path', …}", required: false, default: null, desc: "point {pos}; entity {ref, moving}; player {moving?: true when the actor walks}; path {points}" },
  { path: "shots[].path / shots[].route", type: "[[x,y,z]…] / {fromCell, toCell}", required: false, default: null, desc: "ShotContext.path; indoor route request for dungeon techniques" },
  { path: "shots[].transition", type: "'cut'|'dissolve'|'fade'|'fadewhite'|{type, durationSec, xfade?}", required: false, default: "defaults.transition", desc: "INTO this shot; non-cuts add handles (= durationSec) to both takes" },
  { path: "shots[].standingOrder", type: "one sentence ≤ 300 chars", required: false, default: null, desc: "read by the JEV pilot every tick (warns when missing)" },
  { path: "shots[].pilot", type: "{mode, fade?, …}", required: false, default: "defaults.pilot", desc: "pilot config for the take; fade 'never' | 'auto' ('never': the pilot may fade nothing — e.g. a monster run)" },
  { path: "shots[].overlay", type: "{props: {style: 'freestyle'|'cinewhoop', opacity?: 0..1, tint?: '#rrggbb'}}", required: false, default: null, desc: "→ item.take.overlay (null when absent): the page's lens overlay — FPV propellers at the top of the frame, drawn only on a page booted with ?filmProps=on; unknown keys warn" },
  { path: "shots[].capture.mode", type: "'stepped'|'realtime'", required: false, default: "realtime when the actor/entity moves, or the technique hints realtime (registry) and the subject is an entity/player; else format.capture", desc: "moving server-driven content needs realtime (a realtime-hint technique on a point subject warns)" },
  { path: "shots[].actor", type: "{emote?, motion?, face?, moveTo?, moves?, at?}", required: false, default: null, desc: "player-as-actor cue (world.actor)" },
  { path: "shots[].look / cell / lyric / notes", type: "look / cell id / strings", required: false, default: null, desc: "look merges defaults ← site ← shot" },
]);

/**
 * A complete, valid Plan JSON v1 example: a music video over 3 real sites (Holtburg, Glenden Wood, Holtburg
 * Dungeon 0x01F60289 — coordinates from WorldBuilder/Data/Locations.txt), 8 shots including a dungeon
 * fpv.fpv-corridor, a drone.pass-over and a classic.rack-focus. Returns a fresh object every call.
 * @returns {object}
 */
export function examplePlan() {
  return {
    version: 1,
    title: "Lanterns over Holtburg",
    kind: "music-video",
    format: { width: 1920, height: 1080, fps: 30, capture: "stepped" },
    song: { file: "song/lanterns.mp3", analysis: "song/song.json", offsetSec: 0 },
    defaults: { transition: "cut", pilot: { mode: "jev" }, look: { timeOfDay: "golden", grade: "warm" } },
    edit: { fadeInSec: 1, fadeOutSec: 2 },
    sites: [
      {
        id: "holtburg", name: "Holtburg town square", gazetteerId: "town-holtburg", teleport: "@telepoi Holtburg",
        anchor: { cell: "0xA9B40019", local: [84, 7.1, 94] }, settleSec: 1,
      },
      {
        id: "glenden", name: "Glenden Wood", teleport: "@telepoi Glenden Wood",
        anchor: { cell: "0xA0A40025", local: [96.302, 119.847, 59.955] }, look: { timeOfDay: "dusk" },
      },
      {
        id: "holtburg-dungeon", name: "Holtburg Dungeon", indoor: true, cell: "0x01F60289",
        teleport: "@teleloc 0x01F60289 96.70 -10.00 0.00 -0.7193 0.0000 0.0000 -0.6947",
        anchor: { cell: "0x01F60289", local: [96.7, -10, 0] }, settleSec: 2, look: { grade: "cool" },
      },
    ],
    shots: [
      {
        id: "s010", site: "holtburg", technique: "drone.rising-reveal", duration: { bars: 4 }, framing: "EWS",
        subject: { kind: "point", pos: [32532, 34567.1, 96] },
        standingOrder: "Rise slowly over the rooftops toward the lifestone; keep 3 m from every roof and chimney; never lose the lifestone for more than a second.",
        lyric: "(intro)",
      },
      {
        id: "s020", site: "glenden", technique: "classic.establishing", duration: { bars: 2 }, transition: "dissolve",
        subject: { kind: "point", pos: [30816.3, 31607.8, 61] },
        standingOrder: "Drift wide and slow past the treeline; branches may cross the frame, trunks may not come closer than 4 m.",
      },
      {
        id: "s030", site: "holtburg", technique: "classic.rack-focus", duration: { beats: 8 }, framing: "MCU",
        subject: { kind: "player" }, actor: { emote: "/bow", at: 0.5 },
        standingOrder: "Hold still and keep the avatar centred; nothing may pass between the lens and the avatar.",
      },
      {
        id: "s040", site: "holtburg-dungeon", technique: "fpv.fpv-corridor", duration: { bars: 2 },
        route: { fromCell: "0x01F60289", toCell: "0x01F6027A" }, pilot: { mode: "shadow" },
        standingOrder: "Thread the corridor at speed and bank through the turns; walls must stay at least 1 m away, torches and smoke may be faded.",
      },
      {
        id: "s050", site: "holtburg-dungeon", technique: "classic.pov", duration: { sec: 3.5 },
        subject: { kind: "point", pos: [288.7, 47222, 1.5] },
        standingOrder: "Creep forward at walking pace and keep the doorway centred; stop short of anything within 1.5 m.",
      },
      {
        id: "s060", site: "glenden", technique: "drone.pass-over", duration: { bars: 4 }, start: { section: 2 },
        subject: { kind: "point", pos: [30816.3, 31607.8, 61] }, transition: { type: "fade", durationSec: 0.5 },
        standingOrder: "Pass straight over the meeting hall at 25 m with the gimbal tracking it through vertical; climb rather than swerve if a tree top comes within 5 m.",
      },
      {
        id: "s070", site: "glenden", technique: "drone.orbit-poi", duration: { bars: 2 },
        subject: { kind: "point", pos: [30816.3, 31607.8, 61] }, params: {},
        standingOrder: "Orbit the hall at a steady 30 m; foliage may be faded, never cut through a trunk or roof.",
      },
      {
        id: "s080", site: "holtburg", technique: "drone.dronie", duration: { bars: 4 }, transition: "dissolve",
        subject: { kind: "player" },
        standingOrder: "Pull back and up away from the avatar in one smooth line; keep 3 m from rooftops and keep the avatar in frame.",
      },
    ],
  };
}
