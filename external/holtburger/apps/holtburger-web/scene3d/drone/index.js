// scene3d/drone/index.js — Drone Deploy wiring + the per-frame driver; installs `window.__drone`
// (SPEC scene3d/drone/SPEC.md §3.9, §5, §6.5, §6.7, §6.12, §6.13, §7).
//
// WHY: a deploy → fly → stow cycle touches the pilot's rig (gesture clips, the held
// ReadState, props on the hands and head, hidden wielded items), the ONE render
// camera, the input funnel, the HUD and the audio bus, and must hand every one of
// them back exactly — on the normal path and on every abort. The pure state machine
// (sequence.js) decides WHAT happens; this module decides HOW: it builds a cycle at
// deploy (§7.3) from injected factories (§7.2 — every sibling is a dynamic import
// or a `deps.modules` override, so the drone loads nothing until first use and the
// API runs in node with every other lane faked), executes the sequence's actions in
// order (§7.4; every executor idempotent), runs the per-frame driver in a
// `liveScene3d.film.preFrame` listener (§5: sticks → signals → gestures → tick →
// craft → tether → safety → contact → camera → props → OSD → audio → 4 Hz work →
// watchdog / prewarm / battery), and tears the cycle down at idle (no listener,
// hook, lock or camera left behind). `window.__drone` never throws and returns
// JSON-safe data (§2.7, §2.8). Local-only: the only outbound traffic it can cause is
// the opt-in `broadcastPose` (/read, plugin-side) at tablet-up.
//
// Flags (exact matches): `?drone` (DEFAULT ON since 2026-10-25, `=off` disables it;
// plugins/drone-hud.js mounts the launcher and loads this module on first use only), `?droneDebug=on` (adds
// `__drone.debug`), `?droneAudio=off` (no motor hum).
//
// Page module: every live object comes through `deps` or `window` (on
// index-bundled.html this module is a separate instance of everything it imports).
// Static imports: film core only (§1.4); everything else is dynamic.

import { wrapPi } from "../film/core/gimbal.js";

/** API version string of `window.__drone`. */
export const DRONE_API_VERSION = "drone-1";

/**
 * Deploy refusal reasons (SPEC §2.8; plugins/drone-hud.js REFUSAL_TEXT is the same table).
 * `covered` is index.js's own (the open-sky check at deploy, phase 4 F1): the plugin cannot
 * know it before the module loads, so it only ever arrives as a click's api refusal.
 */
export const DRONE_REFUSAL_REASONS = Object.freeze({
  "not-in-world": "Enter the world first",
  portal: "Not while in portal space",
  dead: "Not while dead",
  "film-busy": "A film take owns the camera",
  busy: "The drone is busy",
  targeting: "Finish targeting first",
  indoors: "Outdoors only",
  combat: "Leave combat mode first",
  moving: "Stand still to deploy",
  covered: "Needs open sky above you",
});

/** Settings defaults (SPEC §3.9). */
export const DRONE_SETTINGS_DEFAULTS = Object.freeze({
  mode: "cine",
  sensitivity: 1.0,
  invertY: false,
  gamepadLayout: "mode2",
  acroRc: 1.0,
  acroSuper: 0.7,
  acroExpo: 0,
  rangeM: 150,
  ceilingAglM: 120,
  batteryMin: 10,
  crash: true,
  crashMps: 7,
  quickDeploy: false,
  launchFacing: "pilot",
  broadcastPose: false,
  volume: 0.6,
  fovDeg: 75,
});

/** Validation rule per settings key (SPEC §3.9): enum values or a number range, or a boolean. */
export const SETTINGS_RULES = Object.freeze({
  mode: Object.freeze({ type: "enum", values: Object.freeze(["cine", "angle", "acro"]) }),
  sensitivity: Object.freeze({ type: "number", min: 0.1, max: 5 }),
  invertY: Object.freeze({ type: "boolean" }),
  gamepadLayout: Object.freeze({ type: "enum", values: Object.freeze(["mode2", "mode1"]) }),
  acroRc: Object.freeze({ type: "number", min: 0.1, max: 3 }),
  acroSuper: Object.freeze({ type: "number", min: 0, max: 0.95 }),
  acroExpo: Object.freeze({ type: "number", min: 0, max: 1 }),
  rangeM: Object.freeze({ type: "number", min: 20, max: 180 }),
  ceilingAglM: Object.freeze({ type: "number", min: 10, max: 120 }),
  batteryMin: Object.freeze({ type: "number", min: 0, max: 60 }),
  crash: Object.freeze({ type: "boolean" }),
  crashMps: Object.freeze({ type: "number", min: 2, max: 30 }),
  quickDeploy: Object.freeze({ type: "boolean" }),
  launchFacing: Object.freeze({ type: "enum", values: Object.freeze(["pilot", "away"]) }),
  broadcastPose: Object.freeze({ type: "boolean" }),
  volume: Object.freeze({ type: "number", min: 0, max: 1 }),
  fovDeg: Object.freeze({ type: "number", min: 60, max: 110 }),
});

// ---------------------------------------------------------------------------
// own constants (equal to the gestures / sequence / props values by contract, §7.2)
// ---------------------------------------------------------------------------

/** MotionCommand ReadState (the held tablet pose). */
const READ_STATE = 0x43000146;
/** Lift-off geometry: rise, back-off along `away`, duration at speed 1 (DV-31). */
const LIFTOFF = Object.freeze({ riseM: 1.7, backM: 3.4, durationSec: 2.2 });
/** Drop spot ahead of the pilot (m): the kneel's grip reach, or beside a no-hands rig. */
const DROP_AHEAD_M = Object.freeze({ humanoid: 0.72, noHands: 1.5 });
/**
 * The hand drops the drone where it is only when it reached the ground: at most `maxUpM` above
 * the pilot's feet and at least `minReachM` out (the place clip's release frame holds the drone
 * ~0.1 m up, ~0.72 m out; a standing hand is ~0.8 m up at the hip). Else the drop spot ahead.
 */
const HAND_DROP = Object.freeze({ maxUpM: 0.3, minReachM: 0.4 });
/** Look-at height above the pilot's feet for a launch facing the pilot (chest, m). */
const PILOT_LOOK_Z = 1.2;
/** Below this horizontal home − pilot distance (m) the lift-off backs away along the pilot's facing. */
const AWAY_MIN_M = 0.1;
/** RTH cruise height above ground (m). */
const RTH_CRUISE_AGL_M = 15;
/** A drop spot whose terrain is farther than this from the pilot's feet keeps the feet level (m, DV-22). */
const DROP_GROUND_TOL_M = 0.5;
/**
 * The pilot stands ON the terrain when the terrain under the feet is this close (m): the drop
 * then follows the terrain at the drop spot whatever the slope (phase 4 F2 — 1.5 m ahead on a
 * ~30° slope is ≈ 0.8 m off the feet, past DROP_GROUND_TOL_M, and the drone floated there).
 */
const PILOT_ON_TERRAIN_TOL_M = 0.25;
/**
 * The open-sky check at deploy (phase 4 F1): the return climbs to ground + RTH_CRUISE_AGL_M and
 * comes straight down onto home, so a roof or an arch over the launch spot catches it (1070: it
 * settled on an archway 14 m above home). Each column is swept from OPEN_SKY_FLOOR_M (ground
 * clutter below it never refuses) to OPEN_SKY_M (the cruise height + a margin) above the drop
 * height there (m).
 */
const OPEN_SKY_M = 16.5;
const OPEN_SKY_FLOOR_M = 0.5;
/** The open-sky columns, metres ahead along the pilot's facing: the pilot, both drop spots, the lift-off end. */
const OPEN_SKY_AHEAD_M = Object.freeze([0, DROP_AHEAD_M.humanoid, DROP_AHEAD_M.noHands, DROP_AHEAD_M.humanoid + LIFTOFF.backM]);
/**
 * The roof layers of the open-sky sweep (film scene/los.js names). Not terrain (the floor), not
 * `entities` (BSP doors and chests) and not `objects` (the cylsphere / sphere bodies of players,
 * NPCs, creatures and dynamic props — wasm `sweepSphereAgainstObjects`): none of them is a roof.
 * The two cell layers sweep only with cell ids, which an outdoor launch spot has none of.
 */
const OPEN_SKY_LAYERS = Object.freeze(["buildingMesh", "statics", "scenery", "cellMesh", "cellStatics"]);
/** Fallback drone body (props DRONE_BODY). */
const BODY_FALLBACK = Object.freeze({ spanM: 0.32, restHeightM: 0.06, radiusM: 0.18 });
/** Craft modes (manual_flight CRAFT_MODES). */
const CRAFT_MODE_NAMES = Object.freeze(["cine", "angle", "acro"]);
/** Abort reasons (sequence ABORT_REASONS). */
const ABORT_REASON_NAMES = Object.freeze(["damage", "death", "portal", "combat", "pilotMoved", "session", "film",
  "contextLost", "user", "dispose", "rigLost", "error"]);
/** `debug.trigger` signal names → the latch they set. */
const DEBUG_SIGNALS = Object.freeze({ damage: "damage", death: "death", portal: "portal", combat: "combat",
  pilotMoved: "pilotMoved", session: "session", film: "film", contextLost: "contextLost" });
/** Rig rebuild watch (SPEC §6.12): wait for an in-flight respawn, give up on a missing rig. */
const RIG_MISSING_SEC = 1;
const RIG_REBUILD_SEC = 3;
/** Storage keys (SPEC §2.6). */
const KEY_SETTINGS = "hb.drone.v1";
const KEY_TUNE = "hb.drone.tune.v1";
const KEY_SEEN = "hb.drone.seen.v1";
/** Log ring size served by debug.events(). */
const LOG_RING = 200;
/** Anchor names → tunable fields (TuneProfile). */
const ANCHOR_FIELDS = Object.freeze({
  droneInHand: Object.freeze(["pos", "quat"]),
  tablet: Object.freeze(["pos", "quat"]),
  goggles: Object.freeze(["pos", "quat", "scale"]),
});
/** Sticks shape (controls.poll) at rest. */
const ZERO_STICKS = Object.freeze({ throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0 });
/** Raw-handle unwrap symbol (plugins/rejection_feedback.js Proxy-wraps the session handle). */
const RAW_SESSION = Symbol.for("holtburger.rawSessionHandle");
/** Setup keys of the profile tables: "0x" + 8 upper-case hex digits. */
const SETUP_KEY_RE = /^0x[0-9A-F]{8}$/;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round to k decimals (null for non-finite; no −0). */
function rnd(v, k) {
  if (!fin(v)) return null;
  const f = 10 ** k;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/** `0x` + 8 upper-case hex digits (never throws). */
function hex32(n) {
  return `0x${((Number(n) || 0) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** Message text of anything thrown. */
function errText(e) {
  return e && e.message ? String(e.message) : String(e);
}

/** Swallow the rejection of a promise-like (never-reject contracts, belt and braces). */
function swallow(p) {
  if (p && typeof p.then === "function") p.then(null, () => {});
}

// ---------------------------------------------------------------------------
// pure exports
// ---------------------------------------------------------------------------

/**
 * Parse the drone URL flags (SPEC §2.5): `?droneDebug=on` (exact) and `?droneAudio=off`
 * (exact; anything else keeps the hum on). Never throws (→ `{debug:false, audio:true}`).
 * @param {string|URLSearchParams|null|undefined} search
 * @returns {{debug:boolean, audio:boolean}}
 */
export function readDroneFlags(search) {
  try {
    const q = new URLSearchParams(search ?? "");
    return { debug: q.get("droneDebug") === "on", audio: !(q.get("droneAudio") === "off") };
  } catch (_) {
    return { debug: false, audio: true };
  }
}

/** Why `value` is not valid for settings key `key` (null when valid). */
function settingProblem(key, value) {
  const r = SETTINGS_RULES[key];
  if (!r) return `unknown setting "${key}"`;
  if (r.type === "boolean") return typeof value === "boolean" ? null : `${key} must be a boolean`;
  if (r.type === "enum") return r.values.includes(value) ? null : `${key} must be one of ${r.values.join(", ")}`;
  if (!fin(value) || value < r.min || value > r.max) return `${key} must be a number in [${r.min}, ${r.max}]`;
  return null;
}

/**
 * Validate a settings patch (SPEC §3.9): every key must be known and valid; one bad key
 * refuses the whole patch.
 * @param {*} patch
 * @returns {{ok:true, value:object}|{ok:false, code:'bad-argument', reason:string}}
 */
export function validateSettingsPatch(patch) {
  if (!isObj(patch)) return { ok: false, code: "bad-argument", reason: "settings patch must be an object" };
  const value = {};
  for (const k of Object.keys(patch)) {
    const why = settingProblem(k, patch[k]);
    if (why) return { ok: false, code: "bad-argument", reason: why };
    value[k] = patch[k] === 0 ? 0 : patch[k];
  }
  return { ok: true, value };
}

/** A copied, validated anchor field, or null. `normalize` applies to quats of the tuned layers. */
function anchorField(a, f, normalize) {
  if (!isObj(a) || !hasOwn(a, f)) return null;
  const v = a[f];
  if (f === "scale") return fin(v) && v > 0 ? v : null;
  const n = f === "pos" ? 3 : 4;
  if (!Array.isArray(v) || v.length !== n || !v.every(fin)) return null;
  if (f === "pos" || !normalize) return v.slice();
  const l = Math.hypot(v[0], v[1], v[2], v[3]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l, v[3] / l] : null;
}

/**
 * Merge prop anchors per anchor, per field: `local` wins over `profile` wins over `defaults`
 * (SPEC §7.6). Returns `{droneInHand, tablet, goggles, clipMode: 'clip'|'timer'|null,
 * source: 'default'|'profile'|'local'}` — `source` is the highest layer that contributed a
 * field or the clip mode. Invalid fields of a layer are skipped; tuned quaternions are
 * normalised; the defaults are copied as given.
 * @param {object} defaults props DEFAULT_ANCHORS
 * @param {object|null|undefined} profile data/drone-rig-profiles.json entry for the setup
 * @param {object|null|undefined} local hb.drone.tune.v1 entry for the setup
 * @returns {object}
 */
export function mergeAnchors(defaults, profile, local) {
  const D = isObj(defaults) ? defaults : {};
  const P = isObj(profile) ? profile : {};
  const L = isObj(local) ? local : {};
  let rank = 0;
  const out = {};
  for (const name of Object.keys(ANCHOR_FIELDS)) {
    const a = {};
    for (const f of ANCHOR_FIELDS[name]) {
      let v = anchorField(L[name], f, true);
      if (v !== null) {
        rank = 2;
        a[f] = v;
        continue;
      }
      v = anchorField(P[name], f, true);
      if (v !== null) {
        rank = Math.max(rank, 1);
        a[f] = v;
        continue;
      }
      v = anchorField(D[name], f, false);
      if (v !== null) a[f] = v;
    }
    out[name] = a;
  }
  let clipMode = null;
  if (L.clipMode === "clip" || L.clipMode === "timer") {
    clipMode = L.clipMode;
    rank = 2;
  } else if (P.clipMode === "clip" || P.clipMode === "timer") {
    clipMode = P.clipMode;
    rank = Math.max(rank, 1);
  }
  out.clipMode = clipMode;
  out.source = rank === 2 ? "local" : rank === 1 ? "profile" : "default";
  return out;
}

/** The three anchors only (what props consumes; JSON-safe copies). */
function anchorsOnly(m) {
  const out = {};
  for (const name of Object.keys(ANCHOR_FIELDS)) {
    const a = isObj(m) && isObj(m[name]) ? m[name] : {};
    const c = {};
    for (const f of ANCHOR_FIELDS[name]) {
      if (!hasOwn(a, f)) continue;
      c[f] = Array.isArray(a[f]) ? a[f].slice() : a[f];
    }
    out[name] = c;
  }
  return out;
}

/** jsonSafe worker: `stack` holds the ancestors (cycles → null; shared refs are fine). */
function safeCopy(v, stack, depth) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? (v === 0 ? 0 : v) : null;
  if (t === "string" || t === "boolean") return v;
  if (t === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : String(v);
  }
  if (t !== "object") return undefined; // undefined / function / symbol: dropped by the caller
  if (depth > 64 || stack.includes(v)) return null;
  if (ArrayBuffer.isView(v)) {
    if (typeof v.length !== "number") return null; // DataView
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i += 1) {
      const e = v[i];
      out[i] = typeof e === "bigint" ? safeCopy(e, stack, depth + 1) : (Number.isFinite(e) ? (e === 0 ? 0 : e) : null);
    }
    return out;
  }
  if (typeof v.toJSON === "function" && !Array.isArray(v)) {
    let j;
    try {
      j = v.toJSON();
    } catch (_) {
      return null;
    }
    if (j !== v) {
      stack.push(v);
      const r = safeCopy(j, stack, depth + 1);
      stack.pop();
      return r === undefined ? null : r;
    }
  }
  stack.push(v);
  let out;
  if (Array.isArray(v)) {
    out = v.map((e) => {
      const r = safeCopy(e, stack, depth + 1);
      return r === undefined ? null : r;
    });
  } else if (v instanceof Map) {
    out = {};
    for (const [k, e] of v) {
      const r = safeCopy(e, stack, depth + 1);
      if (r !== undefined) out[String(k)] = r;
    }
  } else if (v instanceof Set) {
    out = [];
    for (const e of v) {
      const r = safeCopy(e, stack, depth + 1);
      out.push(r === undefined ? null : r);
    }
  } else {
    out = {};
    for (const k of Object.keys(v)) {
      let e;
      try {
        e = v[k];
      } catch (_) {
        continue;
      }
      const r = safeCopy(e, stack, depth + 1);
      if (r !== undefined) out[k] = r;
    }
  }
  stack.pop();
  return out;
}

/**
 * A JSON-safe deep copy (SPEC §2.7): NaN / ±Infinity → null, −0 → 0, typed arrays → arrays,
 * Map → object, Set → array, functions / undefined / symbols dropped from objects (null in
 * arrays), cycles → null. `JSON.parse(JSON.stringify(jsonSafe(v)))` deep-equals `jsonSafe(v)`.
 * @param {*} v
 * @returns {*}
 */
export function jsonSafe(v) {
  const r = safeCopy(v, [], 0);
  return r === undefined ? null : r;
}

/**
 * The raw session handle behind up to four Proxy wraps (plugins/rejection_feedback.js);
 * stable across the wrapping (SPEC §6.7).
 * @param {*} h
 * @returns {*}
 */
export function sessionKey(h) {
  let cur = h ?? null;
  for (let i = 0; i < 4 && cur != null; i++) {
    let inner;
    try {
      inner = cur[RAW_SESSION];
    } catch {
      break;
    }
    if (inner == null || inner === cur) break;
    cur = inner;
  }
  return cur;
}

/**
 * Snapshot of the session at deploy (SPEC §6.7).
 * @param {object} win
 * @returns {{key:*, guid:number, discTs:number}}
 */
export function sessionMark(win) {
  const w = win || {};
  const d = w.__lastDisconnect;
  let guid = 0;
  try {
    guid = (w.getLocalPlayerGuid?.() ?? 0) >>> 0;
  } catch {
    guid = 0;
  }
  return { key: sessionKey(w.__sessionHandle), guid, discTs: d && Number.isFinite(d.ts) ? d.ts : 0 };
}

/**
 * True when the session the cycle started in is gone (SPEC §6.7): the handle was nulled or
 * replaced (unwrapped), the character changed, /logout, a new disconnect, or the boot state
 * left in-world / ready.
 * @param {object} win
 * @param {{key:*, guid:number, discTs:number}} mark
 * @returns {boolean}
 */
export function sessionChanged(win, mark) {
  const w = win || {};
  const m = mark || { key: null, guid: 0, discTs: 0 };
  const h = w.__sessionHandle;
  if (!h || sessionKey(h) !== m.key) return true; // pagehide nulls it; a reconnect replaces it
  let g = 0;
  try {
    g = (w.getLocalPlayerGuid?.() ?? 0) >>> 0;
  } catch {
    g = 0;
  }
  if (g !== m.guid) return true;
  if (w.__hbLoggingOff === true || w.__hbLoggedOff === true) return true; // /logout (the page reloads after)
  const d = w.__lastDisconnect;
  if (d && Number.isFinite(d.ts) && d.ts !== m.discTs) return true; // kind-4 disconnect, wasm panic
  const s = w.__bootState;
  return s !== "in-world" && s !== "ready";
}

/**
 * A film take / camera / clean frame is active (SPEC §6.7; allocates — poll ≤ 4 Hz).
 * @param {object} win
 * @returns {boolean}
 */
export function filmBusy(win) {
  try {
    const s = win?.__film?.status?.();
    return !!s && s.ok !== false && (s.active === true || s.cameraOwned === true || s.clean === true || s.take?.running != null);
  } catch (_) {
    return false;
  }
}

/**
 * The local pilot's rig pose, allocation-free: AC world + compass heading (the root yaw is
 * CCW, compass = −yaw). A preFrame read is the previous frame's pose.
 * @param {object} live liveScene3d
 * @param {object} win
 * @param {{x:number, y:number, z:number, compass:number}} out
 * @returns {object|null} the EntityInstance, or null
 */
export function readPilot(live, win, out) {
  if (!win || !out) return null;
  let g = null;
  try {
    g = typeof win.getLocalPlayerGuid === "function" ? win.getLocalPlayerGuid() : null;
  } catch {
    g = null;
  }
  if (g === null || g === undefined) return null;
  const inst = live?.entityManager?.entityMap?.get(g >>> 0) ?? null;
  const root = inst ? inst.root : null;
  if (!root || !root.position || !root.quaternion) return null;
  const p = root.position, q = root.quaternion;
  out.x = p.x; out.y = p.y; out.z = p.z;
  out.compass = -Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  return inst;
}

/**
 * Listen for WebGL context loss / restore on the canvas (SPEC §6.13). The render loop pauses
 * on loss, so the abort must come from the event.
 * @param {EventTarget|null} canvas
 * @param {() => void} onLost
 * @param {() => void} [onRestored]
 * @returns {() => void} unsubscribe
 */
export function watchContextLoss(canvas, onLost, onRestored) {
  if (!canvas || typeof canvas.addEventListener !== "function") return () => {};
  const lost = () => { try { onLost(); } catch (_) {} };            // the recovery module already preventDefault()s
  const restored = () => { try { onRestored?.(); } catch (_) {} };
  canvas.addEventListener("webglcontextlost", lost, false);
  canvas.addEventListener("webglcontextrestored", restored, false);
  return () => {
    try { canvas.removeEventListener("webglcontextlost", lost, false); } catch (_) {}
    try { canvas.removeEventListener("webglcontextrestored", restored, false); } catch (_) {}
  };
}

// ---------------------------------------------------------------------------
// module loading (SPEC §7.2)
// ---------------------------------------------------------------------------

/** Factory keys every cycle needs (functions). */
const FACTORY_KEYS = Object.freeze(["createSequence", "createGestureDriver", "createProps", "createManualCraft",
  "createTether", "createControls", "createOsd", "createDroneAudio", "createWorldLink"]);

/** Which file serves which override key, and the export it reads. */
const MODULE_SOURCES = Object.freeze([
  ["sequence", [["createSequence", "createSequence"]]],
  ["gestures", [["createGestureDriver", "createGestureDriver"]]],
  ["props", [["createProps", "createProps"], ["prewarmProps", "prewarm"], ["DEFAULT_ANCHORS", "DEFAULT_ANCHORS"], ["DRONE_BODY", "DRONE_BODY"]]],
  ["manual_flight", [["createManualCraft", "createManualCraft"]]],
  ["tether", [["createTether", "createTether"]]],
  ["controls", [["createControls", "createControls"]]],
  ["osd", [["createOsd", "createOsd"]]],
  ["audio", [["createDroneAudio", "createDroneAudio"]]],
  ["world_link", [["createWorldLink", "createWorldLink"]]],
]);

/**
 * Resolve every factory: `deps.modules` overrides first; each file with at least one missing
 * key is imported (all in parallel) relative to this module. A failed import rejects.
 */
async function loadModules(overrides) {
  const o = isObj(overrides) ? overrides : {};
  const files = MODULE_SOURCES.filter(([, keys]) => keys.some(([k]) => !hasOwn(o, k)));
  const loaded = await Promise.all(files.map(([file]) => import(new URL(`./${file}.js`, import.meta.url).href)));
  const byFile = new Map(files.map(([file], i) => [file, loaded[i]]));
  const M = {};
  for (const [file, keys] of MODULE_SOURCES) {
    for (const [key, exp] of keys) M[key] = hasOwn(o, key) ? o[key] : byFile.get(file)?.[exp];
  }
  for (const k of FACTORY_KEYS) {
    if (typeof M[k] !== "function") throw new Error(`drone: ${k} is not available`);
  }
  if (typeof M.prewarmProps !== "function") M.prewarmProps = null;
  if (!isObj(M.DEFAULT_ANCHORS)) M.DEFAULT_ANCHORS = {};
  const b = isObj(M.DRONE_BODY) ? M.DRONE_BODY : BODY_FALLBACK;
  M.DRONE_BODY = {
    spanM: fin(b.spanM) ? b.spanM : BODY_FALLBACK.spanM,
    restHeightM: fin(b.restHeightM) && b.restHeightM >= 0 ? b.restHeightM : BODY_FALLBACK.restHeightM,
    radiusM: fin(b.radiusM) && b.radiusM > 0 ? b.radiusM : BODY_FALLBACK.radiusM,
  };
  return M;
}

/** Default fetchJson: fetch + json; any failure → null. */
async function defaultFetchJson(url) {
  try {
    if (typeof fetch !== "function") return null;
    const r = await fetch(url);
    if (!r || !r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

/** Keep only `"0x" + 8 hex` keys with object values (a fresh plain object). */
function profileTable(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const k of Object.keys(raw)) if (SETUP_KEY_RE.test(k) && isObj(raw[k])) out[k] = raw[k];
  return out;
}

// ---------------------------------------------------------------------------
// the singleton
// ---------------------------------------------------------------------------

/** @type {{promise: Promise<object>, api: object|null}|null} */
let singleton = null;
/** The first-flight cheat sheet is considered once per page load. */
let cheatSheetConsidered = false;

/**
 * Install `window.__drone` (SPEC §3.9 / §7.1). Async (loads THREE, the default modules and
 * the tuned profiles) and idempotent: a concurrent or later call returns the same instance
 * (later deps are ignored) until `dispose()`. Needs no scene: settings and tune work before
 * any deploy. A failed default import rejects (the next call retries).
 * @param {{window?:object, document?:object, liveScene3d?:object, THREE?:object,
 *   getSessionHandle?:() => object|null, funnel?:object, refusal?:() => string|null,
 *   onSignal?:(fn:Function) => Function, broadcastPose?:() => object, clock?:() => number,
 *   search?:string, storage?:Storage, fetchJson?:(url:string) => Promise<object|null>,
 *   log?:(entry:object) => void, modules?:object}} [deps]
 * @returns {Promise<object>} the DroneApi
 */
export async function installDrone(deps = {}) {
  if (singleton) return singleton.promise;
  const rec = { promise: /** @type {any} */ (null), api: null };
  singleton = rec;
  rec.promise = buildDrone(deps, rec).catch((e) => {
    if (singleton === rec) singleton = null;
    throw e;
  });
  return rec.promise;
}

/** Test hook: dispose the installed api (if any) and clear the singleton and page-load latches. */
export function _resetDroneForTest() {
  const rec = singleton;
  singleton = null;
  cheatSheetConsidered = false;
  if (rec && rec.api) {
    try {
      rec.api.dispose();
    } catch (_) {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// the api
// ---------------------------------------------------------------------------

/** Build the api (installDrone's body). */
async function buildDrone(deps, rec) {
  const d = isObj(deps) ? deps : {};
  const win = d.window ?? (typeof window !== "undefined" ? window : null);
  const doc = d.document ?? win?.document ?? (typeof document !== "undefined" ? document : null);
  const clock = typeof d.clock === "function"
    ? () => {
      let t = NaN;
      try {
        t = Number(d.clock());
      } catch (_) {
        t = NaN;
      }
      return Number.isFinite(t) ? t : 0;
    }
    : () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() / 1000 : Date.now() / 1000);
  let search = "";
  try {
    search = d.search ?? win?.location?.search ?? "";
  } catch (_) {
    search = "";
  }
  const flags = readDroneFlags(search);
  const fetchJson = typeof d.fetchJson === "function" ? d.fetchJson : defaultFetchJson;

  const [M, THREE, rawProfiles] = await Promise.all([
    loadModules(d.modules),
    d.THREE ? Promise.resolve(d.THREE) : import("three"),
    Promise.resolve()
      .then(() => fetchJson(new URL("../../data/drone-rig-profiles.json", import.meta.url).href))
      .catch(() => null),
  ]);
  const rigProfiles = profileTable(isObj(rawProfiles) ? rawProfiles.profiles : null);
  const REST = M.DRONE_BODY.restHeightM;
  /**
   * `segmentBlocked` options of the open-sky columns: the drone's body sphere through the roof
   * layers; the pilot never counts (exemptLocalPlayer only matters to the `objects` layer, which
   * OPEN_SKY_LAYERS leaves out: kept so the pilot stays exempt if that layer is ever added).
   */
  const SKY_SWEEP = Object.freeze({ layers: OPEN_SKY_LAYERS, radius: M.DRONE_BODY.radiusM, exemptLocalPlayer: true });

  // ---- logging (SPEC §2.8) --------------------------------------------------------
  const ring = [];
  const warned = new Set();
  /** Log an entry: ring (debug.events), deps.log, else one console.warn per distinct warn. Never console.error. */
  function log(entry) {
    const e = isObj(entry) ? entry : { message: String(entry) };
    if (e.event === undefined) e.event = "drone";
    ring.push(e);
    if (ring.length > LOG_RING) ring.shift();
    if (typeof d.log === "function") {
      try {
        d.log(e);
      } catch (_) {
        /* a logger never breaks the drone */
      }
      return;
    }
    if (e.level === "warn" && typeof console !== "undefined") {
      const msg = String(e.message ?? "");
      if (!warned.has(msg)) {
        warned.add(msg);
        // eslint-disable-next-line no-console
        console.warn(`[drone] ${msg}`);
      }
    }
  }
  const warn = (message, extra) => log({ event: "drone", level: "warn", message, ...(extra || {}) });

  // ---- storage (SPEC §2.6) -------------------------------------------------------------
  let storage = null;
  try {
    storage = d.storage ?? win?.localStorage ?? null;
  } catch (_) {
    storage = null;
  }
  const readStore = (key) => {
    try {
      return storage && typeof storage.getItem === "function" ? storage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  };
  const writeStore = (key, value) => {
    try {
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(key, value);
        return true;
      }
    } catch (_) {
      /* blocked / full */
    }
    return false;
  };
  const readJson = (key) => {
    const raw = readStore(key);
    if (typeof raw !== "string" || raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  };

  /** Settings: defaults, then every valid stored key (unknown keys dropped, invalid → default). */
  const settings = { ...DRONE_SETTINGS_DEFAULTS };
  {
    const stored = readJson(KEY_SETTINGS);
    if (isObj(stored)) {
      for (const k of Object.keys(SETTINGS_RULES)) {
        if (hasOwn(stored, k) && settingProblem(k, stored[k]) === null) settings[k] = stored[k];
      }
    }
  }
  let settingsDirty = false;
  const persistSettings = () => {
    settingsDirty = false;
    return writeStore(KEY_SETTINGS, JSON.stringify(settings));
  };
  /** @type {Record<string, object>} hb.drone.tune.v1 profiles */
  const tuneLocal = profileTable(readJson(KEY_TUNE)?.profiles);
  const persistTune = () => writeStore(KEY_TUNE, JSON.stringify({ version: 1, profiles: tuneLocal }));

  // ---- api state -------------------------------------------------------------------------
  let state = "idle";
  let since = clock();
  let lastAbort = null;
  let disposed = false;
  /** The active cycle (null while idle). */
  let C = null;
  /** Last known rig of the local pilot ({guid, kind, setupId, parts}), kept across cycles for status(). */
  let lastRig = null;
  /** Abort edges latched until the next frame tick (bus, debug). */
  const latched = { damage: false, death: false, portal: false, combat: false, pilotMoved: false, session: false, film: false, contextLost: false };
  /** Clear the latches after a frame tick (every frame: allocation-free). */
  const clearLatches = () => {
    latched.damage = false;
    latched.death = false;
    latched.portal = false;
    latched.combat = false;
    latched.pilotMoved = false;
    latched.session = false;
    latched.film = false;
    latched.contextLost = false;
  };
  /**
   * The funnel whose 'gate' a film clean frame snapshotted from our lock (a take started
   * mid-cycle, SPEC A5): our restore released it, film puts it back at the end of its take.
   */
  let filmGate = null;
  /** Σdt of the frame driver (debug.setSticks counts on it). */
  let driverTime = 0;
  const dbg = { until: -Infinity, sticks: { ...ZERO_STICKS } };

  const liveOf = () => {
    const l = d.liveScene3d ?? win?.liveScene3d ?? null;
    return isObj(l) ? l : null;
  };
  const localGuid = () => {
    try {
      return (win?.getLocalPlayerGuid?.() ?? 0) >>> 0;
    } catch (_) {
      return 0;
    }
  };
  const getSessionHandle = typeof d.getSessionHandle === "function" ? d.getSessionHandle : () => win?.__sessionHandle ?? null;
  /** The session handle the world link sweeps with: its SPEC §6.3 `shOf` chain over the same getter. */
  const linkHandle = (live) => {
    let h = null;
    try {
      h = getSessionHandle();
    } catch (_) {
      h = null;
    }
    return h ?? live.sessionHandle ?? win?.__sessionHandle ?? null;
  };
  const perfNowMs = () => {
    try {
      const p = win?.performance ?? (typeof performance !== "undefined" ? performance : null);
      return p && typeof p.now === "function" ? p.now() : clock() * 1000;
    } catch (_) {
      return clock() * 1000;
    }
  };

  // ---- results -----------------------------------------------------------------------------
  const fail = (code, reason) => ({ ok: false, code, reason });
  const refusal = (code) => fail(code, DRONE_REFUSAL_REASONS[code] ?? `Cannot deploy (${code})`);
  const bad = (reason) => fail("bad-argument", reason);
  const notFlying = () => fail("not-flying", "The drone is not flying");
  const DISPOSED = () => fail("disposed", "The drone module was disposed");

  /** Wrap an api method: never throws, JSON-safe result, disposed-aware. */
  const method = (fn) => (...args) => {
    if (disposed) return DISPOSED();
    try {
      return jsonSafe(fn(...args));
    } catch (e) {
      warn(`api call failed: ${errText(e)}`);
      return fail("internal", errText(e));
    }
  };

  // ---- the cycle -----------------------------------------------------------------------------

  /** Pilot setup id of an instance. */
  const setupOf = (inst) => {
    try {
      return ((inst?.meta?.modelId ?? inst?.meta?.setupId ?? 0) >>> 0);
    } catch (_) {
      return 0;
    }
  };

  /**
   * Create every per-cycle object (SPEC §7.3); throws on a factory failure (deploy → internal).
   * Stops right after the world link when the open-sky check finds a roof (`c.covered`, F1).
   */
  function buildCycle(live, guid, inst, quick) {
    const em = live.entityManager;
    const cs = live.cameraSwitcher;
    const c = {
      live, em, cs, guid, inst, quick,
      dead: false, ticking: false, queue: [], errorAbort: false, covered: false,
      offs: [], offSignal: null,
      mark: sessionMark(win),
      pilotNow: { x: 0, y: 0, z: 0, compass: 0 },
      pilotAtDeploy: { x: 0, y: 0, z: 0, compass: 0 },
      anchor: { x: 0, y: 0, z: 0 },
      pilotMovedM: 0,
      setupHex: hex32(setupOf(inst)),
      anchors: null,
      launchFacing: settings.launchFacing,
      batteryOn: settings.batteryMin > 0,
      profile: null, rigSet: false, readyKind: null,
      link: null, props: null, gestures: null, craft: null, tether: null, controls: null, osd: null, audio: null, seq: null,
      locked: false, held: false, wieldedHidden: false, camPrep: null, clean: false,
      home: { pos: [0, 0, 0], yaw: 0 }, homeSet: false,
      lastPos: [0, 0, 0], lastFrame: null, lastSignal: 1, lastRange: false, lastAgl: 0, lastDistHome: 0,
      prevPose: null, prevEye: null, cut: true,
      arm: { level: 0, target: 0, rate: Infinity },
      lifted: false, timerSec: 0, theta: 0, tsMs: 0, acroSince: null,
      hz4Acc: 0, hz4Count: 0, hz10Acc: 0, firstFrame: true, filmBusyLevel: false,
      missingSince: null, lostSince: null, rigLost: false,
      scratch3: [0, 0, 0],
      // per-frame reused objects (SPEC §5 allocation rules)
      ti: {
        dt: 0, now: 0, request: null, arg: null, rig: null, rigKnown: null, beatEvent: false, beatDone: false,
        input: { sticksActive: false, anyInput: false },
        signals: { damage: false, death: false, portal: false, stanceCombat: false, pilotMovedM: 0, sessionChanged: false,
          filmBusy: false, contextLost: false, hidden: false },
        craft: { landed: false, aglM: 0, distHomeM: 0, distTouchdownM: null, impactSpeed: 0, autopilotDone: false, gone: false },
        battery: { level: 1, warn: false, rth: false, empty: false },
        crashMps: settings.crash ? settings.crashMps : 0,
      },
      stepIn: { sticks: ZERO_STICKS, dt: 0, groundZ: null, fovDeg: settings.fovDeg },
      hits: [],
      tetherHit: { layer: "tether", kind: null, t: 1, point: null, normal: null },
      want: { t: 0, pos: [0, 0, 0], q: [1, 0, 0, 0], h: 0, p: 0, r: 0, fov: settings.fovDeg },
      eyeCtx: { fovDeg: settings.fovDeg, aspect: 16 / 9, cell: 0, cut: false, ignoreGuid: 0 },
      bodyCtx: { fovDeg: 1, aspect: 16 / 9, cut: false },
      camPose: { pos: null, q: null, h: 0, p: 0, r: 0, fov: settings.fovDeg },
      osdView: { mode: settings.mode, battery: null, timerSec: 0, signal: 1, distHomeM: 0, aglM: 0, speedMps: 0, headingRad: 0,
        homeBearingRad: 0, banners: { rangeLimit: false, lowBattery: false, returning: false, crash: false, acroHint: false },
        reticle: "crosshair" },
      osdFrame: { headingRad: 0, rollRad: 0, pitchRad: 0 },
      audioIn: { throttle: 0, speed: 0, level: 0, fpv: false, pos: null },
      screen: { signal: 1, battery: null, homeBearingRad: 0, distM: 0, live: false },
      lensIn: { t: 0, theta: 0, throttle: 1, fov: settings.fovDeg },
    };
    readPilot(live, win, c.pilotNow);
    Object.assign(c.pilotAtDeploy, c.pilotNow);
    c.anchor.x = c.pilotNow.x;
    c.anchor.y = c.pilotNow.y;
    c.anchor.z = c.pilotNow.z;
    c.home.pos[0] = c.pilotNow.x;
    c.home.pos[1] = c.pilotNow.y;
    c.home.pos[2] = c.pilotNow.z + REST;
    c.lastPos[0] = c.home.pos[0];
    c.lastPos[1] = c.home.pos[1];
    c.lastPos[2] = c.home.pos[2];
    c.anchors = mergeAnchors(M.DEFAULT_ANCHORS, rigProfiles[c.setupHex], tuneLocal[c.setupHex]);
    C = c; // early: a failure below tears down what exists

    c.link = M.createWorldLink({ liveScene3d: live, THREE, window: win, getSessionHandle, wasmExports: live.wasmExports,
      body: { radiusM: M.DRONE_BODY.radiusM, restHeightM: REST }, log });
    // Phase 4 F1: the open-sky check needs the link (los, groundZ, its session handle) and runs
    // before anything else exists, so a refusal (deploy) tears down a cycle that holds only the
    // link: no listener, no hook, no lock, no prop, no audio graph was ever made.
    if (skyCovered(c)) {
      c.covered = true;
      return c;
    }
    c.props = M.createProps({ THREE, scene: live.scene, anchors: anchorsOnly(c.anchors), log });
    c.props.setRig({ guid, parts: inst.parts, rootScale: inst.root?.scale?.x ?? 1, profile: null });
    if (M.prewarmProps) {
      try {
        swallow(M.prewarmProps({ THREE, renderer: live.renderer, scene: live.scene, camera: live.camera, offscreen: !live.wireframeMode }));
      } catch (e) {
        warn(`props prewarm failed: ${errText(e)}`);
      }
    }
    const g = M.createGestureDriver({ entityManager: em, wasm: live.wasmExports, guid,
      clipMode: () => (c.anchors && c.anchors.clipMode) ?? "clip", log });
    c.gestures = g;
    c.readyKind = null;
    let readyP;
    try {
      readyP = Promise.resolve(g.ready());
    } catch (e) {
      readyP = Promise.reject(e);
    }
    readyP.then((r) => {
      if (C === c && c.gestures === g) c.readyKind = r?.profile?.kind ?? "no-hands";
    }, () => {
      if (C === c && c.gestures === g) c.readyKind = "no-hands";
    });
    c.craft = M.createManualCraft({ mode: settings.mode, rates: { rc: settings.acroRc, super: settings.acroSuper, expo: settings.acroExpo } });
    c.tether = M.createTether({ rangeM: settings.rangeM, ceilingAglM: settings.ceilingAglM, batterySec: settings.batteryMin * 60 });
    let nav = null;
    try {
      nav = win?.navigator ?? (typeof navigator !== "undefined" ? navigator : null);
    } catch (_) {
      nav = null;
    }
    c.controls = M.createControls({ window: win, document: doc, navigator: nav, canvas: cs.domElement, funnel: d.funnel,
      cameraSwitcher: cs, settings: () => settings });
    const offAction = c.controls.onAction(onControlAction);
    if (typeof offAction === "function") c.offs.push(offAction);
    c.osd = M.createOsd({ document: doc, window: win });
    c.audio = M.createDroneAudio({ bus: () => live.audioManager?.getEffectBus?.() ?? null, enabled: flags.audio,
      volume: () => settings.volume });
    // Inside the deploy click (a user gesture): create the AudioContext if it does not exist yet.
    const am = live.audioManager;
    if (flags.audio && am && !am.getEffectBus?.() && typeof am.resume === "function") {
      try {
        am.resume()?.catch?.(() => {});
      } catch (_) {
        /* silent hum */
      }
    }
    c.audio.start();
    c.seq = M.createSequence();
    c.offs.push(c.link.onPreFrame(onPreFrame), c.link.onPostRender(onPostRender));
    const canvas = live.renderer && live.renderer.domElement;
    c.offs.push(watchContextLoss(canvas, () => {
      if (C === c) request("abort", { reason: "contextLost" });
    }));
    if (win && typeof win.addEventListener === "function") {
      const onBoot = () => {
        if (C === c && sessionChanged(win, c.mark)) request("abort", { reason: "session" });
      };
      const onHide = () => {
        if (C === c) request("abort", { reason: "session" });
      };
      win.addEventListener("holtburger:state", onBoot);
      win.addEventListener("pagehide", onHide);
      c.offs.push(() => {
        try {
          win.removeEventListener("holtburger:state", onBoot);
        } catch (_) {
          /* gone */
        }
        try {
          win.removeEventListener("pagehide", onHide);
        } catch (_) {
          /* gone */
        }
      });
    }
    if (typeof d.onSignal === "function") {
      const off = d.onSignal((name) => {
        if (name === "damage" || name === "death" || name === "portal") latched[name] = true;
      });
      c.offSignal = typeof off === "function" ? off : null;
    }
    return c;
  }

  /**
   * Tear the cycle down (SPEC §7.3): listeners, controls (restores a lock still held), the
   * camera, gestures, OSD, audio, props, the world link; persist dirty settings. Idempotent.
   */
  function teardown(c) {
    if (!c || c.dead) return;
    c.dead = true;
    if (C === c) C = null;
    for (const off of c.offs.splice(0)) {
      try {
        off();
      } catch (_) {
        /* best effort */
      }
    }
    try {
      c.offSignal?.();
    } catch (_) {
      /* best effort */
    }
    c.offSignal = null;
    // Safety net for an abnormal exit (the inputRestore executor normally did all of this).
    try {
      if (c.link && c.link.cameraOwner.owned) c.link.cameraOwner.release();
    } catch (_) {
      /* released by link.dispose below */
    }
    try {
      c.controls?.dispose();
    } catch (e) {
      warn(`controls dispose threw: ${errText(e)}`);
    }
    if (c.locked) {
      try {
        c.link?.restoreFollowCamera(c.camPrep);
      } catch (_) {
        /* best effort */
      }
      c.locked = false;
    }
    for (const k of ["gestures", "osd", "audio", "props", "link"]) {
      try {
        c[k]?.dispose();
      } catch (e) {
        warn(`${k} dispose threw: ${errText(e)}`);
      }
    }
    if (settingsDirty) persistSettings();
    c.craft = null;
    c.tether = null;
    c.seq = null;
  }

  /** The sequence (or an executor path) broke: force idle and tear down. */
  function emergency(c, e) {
    warn(`drone cycle failed, tearing down: ${errText(e)}`);
    // HARD 'error' (§4.6) issues Ready for a held ReadState; gestures.dispose() below only
    // forgets the held command. release() is death-aware (no Ready on a death-held rig).
    if (c && !c.dead && c.held && c.gestures) {
      try {
        swallow(c.gestures.release());
      } catch (_) {
        /* best effort */
      }
      c.held = false;
    }
    if (state !== "idle") {
      const prev = state;
      const at = clock();
      lastAbort = { reason: "error", from: prev, at };
      setStateRecord("idle", prev, at);
    }
    teardown(c);
  }

  // ---- ticks ---------------------------------------------------------------------------------

  /** A synchronous request tick (dt = 0); requests made during a tick are queued. */
  function request(name, arg) {
    const c = C;
    if (!c || c.dead) return;
    if (c.ticking) {
      c.queue.push([name, arg ?? null]);
      return;
    }
    runRequest(c, name, arg ?? null);
    drain(c);
  }

  function runRequest(c, name, arg) {
    const ti = c.ti;
    ti.dt = 0;
    ti.now = clock();
    ti.request = name;
    ti.arg = arg;
    ti.beatEvent = false;
    ti.beatDone = false;
    ti.rig = c.readyKind;
    ti.rigKnown = profileKind(c);
    ti.crashMps = settings.crash ? settings.crashMps : 0;
    let actions;
    c.ticking = true;
    try {
      actions = c.seq.tick(ti);
    } catch (e) {
      c.ticking = false;
      ti.request = null;
      ti.arg = null;
      emergency(c, e);
      return;
    }
    ti.request = null;
    ti.arg = null;
    try {
      process(c, actions);
    } finally {
      c.ticking = false;
    }
  }

  function drain(c) {
    while (C === c && !c.dead && c.queue.length > 0) {
      const [n, a] = c.queue.shift();
      runRequest(c, n, a);
    }
  }

  /** Execute an action list in order; idle → teardown after the list; an executor throw → hard abort 'error'. */
  function process(c, actions) {
    if (!actions || actions.length === 0) return;
    let idle = false;
    let failed = null;
    for (const a of actions) {
      // A re-entrant teardown (dispose() from an hb-drone-state listener) ended the cycle
      // mid-list: nothing more may run on its disposed objects (own() would re-wrap the camera).
      if (c.dead) return;
      if (a && a.type === "state" && a.state === "idle") idle = true;
      try {
        exec(c, a);
      } catch (e) {
        if (!failed) failed = e;
        warn(`action ${a && a.type} failed: ${errText(e)}`);
      }
    }
    if (idle) {
      teardown(c);
      return;
    }
    if (failed && !c.errorAbort) {
      c.errorAbort = true;
      c.queue.push(["abort", { reason: "error" }]);
    }
  }

  /** gestures.profile()?.kind, never throwing. */
  function profileKind(c) {
    try {
      const p = c.gestures.profile();
      return p && typeof p.kind === "string" ? p.kind : null;
    } catch (_) {
      return null;
    }
  }

  // ---- executors (SPEC §7.4) -------------------------------------------------------------------

  /** Record a state change: log ring entry + exactly one `hb-drone-state` event on document. */
  function setStateRecord(next, prev, at) {
    state = next;
    since = at;
    log({ event: "drone", level: "info", message: "state", state: next, prev, at });
    const CE = (win && typeof win.CustomEvent === "function" ? win.CustomEvent : null)
      ?? (typeof CustomEvent === "function" ? CustomEvent : null);
    if (doc && typeof doc.dispatchEvent === "function" && CE) {
      try {
        doc.dispatchEvent(new CE("hb-drone-state", { bubbles: false, detail: { state: next, prev, at } }));
      } catch (_) {
        /* a listener threw: not ours */
      }
    }
  }

  function exec(c, a) {
    switch (a.type) {
      case "state": {
        const prev = typeof a.prev === "string" ? a.prev : state;
        try {
          const la = c.seq.state().lastAbort;
          if (la) lastAbort = la;
        } catch (_) {
          /* keep the previous */
        }
        setStateRecord(a.state, prev, clock());
        return;
      }
      case "inputLock":
        c.controls.lock();
        c.camPrep = c.link.prepareFollowCamera();
        c.locked = true;
        return;
      case "inputRestore": {
        if (c.link.cameraOwner.owned) cameraRelease(c, false);
        const busyFilm = filmBusy(win);
        const rr = c.controls.restore();
        // A film clean frame that started mid-cycle snapshotted OUR gate and restores it blindly
        // at the end of its take: remember the funnel this restore released (settleFilmGate).
        if (busyFilm && rr?.steps?.funnel?.unpoisoned === true) filmGate = d.funnel ?? win?.__inputFunnel ?? null;
        // The player has control again: H's clean view (no HUD, no cursor) ends with it.
        if (c.clean) c.clean = c.osd.clean(false) === true;
        c.link.restoreFollowCamera(c.camPrep);
        c.locked = false;
        return;
      }
      case "controlsPhase":
        c.controls.setPhase(a.phase);
        return;
      case "hideWielded":
        c.gestures.hideWielded(a.on === true);
        c.wieldedHidden = a.on === true;
        return;
      case "clip":
        c.gestures.clip(a.name, a.speed);
        return;
      case "stopClip":
        c.gestures.stop();
        return;
      case "motion":
        if (a.cmd === "ReadState") {
          swallow(c.gestures.hold(READ_STATE, 1));
          c.held = true;
        } else {
          swallow(c.gestures.release()); // death-aware inside gestures
          c.held = false;
        }
        return;
      case "attach":
        c.props.attach(a.prop, a.anchor);
        return;
      case "detach":
        if (a.to === "world") detachToWorld(c, a.prop);
        else c.props.remove(a.prop);
        return;
      case "place":
        placeDrone(c);
        return;
      case "fadeOut":
        c.props.fadeOut("drone", { delaySec: a.delaySec, durationSec: a.durationSec, now: clock() });
        return;
      case "cameraOwn":
        cameraOwn(c);
        return;
      case "cameraRelease":
        cameraRelease(c, a.framePilot === true);
        return;
      case "autopilot":
        autopilot(c, a.plan, a.speed);
        return;
      case "rotors": {
        const target = a.level > 0 ? 1 : 0;
        const r = fin(a.rampSec) && a.rampSec > 0 ? a.rampSec : 0;
        c.arm.target = target;
        if (r === 0) {
          c.arm.level = target;
          c.arm.rate = Infinity;
        } else c.arm.rate = Math.abs(target - c.arm.level) / r;
        return;
      }
      case "osd":
        c.osd.show(a.mode, a.durationSec !== undefined ? { durationSec: a.durationSec } : undefined);
        if (a.mode === "fpv" && !cheatSheetConsidered) {
          cheatSheetConsidered = true;
          if (readStore(KEY_SEEN) !== "1") {
            c.osd.cheatSheet(true);
            writeStore(KEY_SEEN, "1");
          }
        }
        return;
      case "audio":
        if (a.level === 0) c.audio.stop({ fadeSec: fin(a.rampSec) ? a.rampSec : 0 });
        return;
      case "broadcastPose":
        if (settings.broadcastPose === true && typeof d.broadcastPose === "function") d.broadcastPose();
        return;
      default:
        return;
    }
  }

  /** The pilot's current pose (the deploy pose while the rig is missing). */
  function pilotOf(c) {
    return readPilot(c.live, win, c.pilotNow) ? c.pilotNow : c.pilotAtDeploy;
  }

  /** The sequence's resolved rig kind (falls back to the gestures' answers). */
  function rigOf(c) {
    try {
      const r = c.seq.state().rig;
      if (r) return r;
    } catch (_) {
      /* fall through */
    }
    return c.readyKind ?? profileKind(c) ?? "no-hands";
  }

  /**
   * Drop height at (x, y) (SPEC §6.11; groundZ is terrain-only). A pilot standing ON the
   * terrain (the terrain under the feet within PILOT_ON_TERRAIN_TOL_M) drops onto the terrain
   * at the drop spot whatever the slope (phase 4 F2); a pilot on a floor / platform / unknown
   * terrain keeps DV-22: the terrain only within DROP_GROUND_TOL_M of the feet, else the feet
   * (never under the floor the pilot stands on). Unknown terrain at (x, y) → the feet.
   * @param {object} c the cycle
   * @param {number} x @param {number} y AC world metres of the drop spot
   * @param {{x:number, y:number, z:number}} pilot the pilot's feet
   * @returns {number}
   */
  function dropZ(c, x, y, pilot) {
    const gz = c.link.groundZ(x, y);
    if (gz === null) return pilot.z;
    const gp = c.link.groundZ(pilot.x, pilot.y);
    if (gp !== null && Math.abs(gp - pilot.z) <= PILOT_ON_TERRAIN_TOL_M) return gz;
    return Math.abs(gz - pilot.z) <= DROP_GROUND_TOL_M ? gz : pilot.z;
  }

  /**
   * Phase 4 F1 (SPEC §3.9 deploy): is the sky over the launch spot covered? Four vertical
   * columns along the pilot's facing (OPEN_SKY_AHEAD_M: the pilot, the humanoid and no-hands
   * drop spots, the lift-off end), each from OPEN_SKY_FLOOR_M to OPEN_SKY_M above the drop
   * height there (`dropZ`: the terrain under a pilot standing on it), swept with the drone's body
   * sphere through the roof layers (`link.los.segmentBlocked` with the link's session handle).
   * A layer the handle lacks finds nothing (an old pkg / a test fake: open sky); a throwing
   * column reads as open sky (a warn). Deploy-time only: allocates, ≤ 12 wasm sweeps.
   * @param {object} c the cycle (only its link exists yet)
   * @returns {boolean} true → refuse `covered`
   */
  function skyCovered(c) {
    const los = c.link.los;
    if (!los || typeof los.segmentBlocked !== "function") return false;
    const P = c.pilotNow;
    if (!fin(P.x) || !fin(P.y) || !fin(P.z) || !fin(P.compass)) return false;
    const sh = linkHandle(c.live);
    const fx = Math.sin(P.compass), fy = Math.cos(P.compass);
    for (const ahead of OPEN_SKY_AHEAD_M) {
      const x = P.x + fx * ahead, y = P.y + fy * ahead;
      const base = dropZ(c, x, y, P);
      let r = null;
      try {
        r = los.segmentBlocked(sh, [x, y, base + OPEN_SKY_FLOOR_M], [x, y, base + OPEN_SKY_M], SKY_SWEEP);
      } catch (e) {
        warn(`open-sky check failed: ${errText(e)}`);
        continue;
      }
      if (r && r.blocked === true) {
        const hitZ = Array.isArray(r.point) ? r.point[2] : NaN;
        log({ event: "drone", level: "info", message: "covered", aheadM: ahead, layer: r.layer ?? null, kind: r.kind ?? null,
          roofM: rnd(hitZ - base, 2) });
        return true;
      }
    }
    return false;
  }

  /** Drone yaw at the drop: facing the pilot (+π) or away. */
  function dropYaw(c, compass) {
    return wrapPi(c.launchFacing === "pilot" ? compass + Math.PI : compass);
  }

  /** The drone is on the ground at `pos`: home, a landed craft, a cut. */
  function setHome(c, pos, yaw) {
    c.home.pos[0] = pos[0];
    c.home.pos[1] = pos[1];
    c.home.pos[2] = pos[2];
    c.home.yaw = yaw;
    c.homeSet = true;
    c.lastPos[0] = pos[0];
    c.lastPos[1] = pos[1];
    c.lastPos[2] = pos[2];
    c.craft.reset({ pos: [pos[0], pos[1], pos[2]], h: yaw, p: 0 }, { landed: true });
    c.cut = true;
  }

  /** `place` executor: straight onto the drop spot ahead of the pilot. */
  function placeDrone(c) {
    const pilot = pilotOf(c);
    const ahead = rigOf(c) === "humanoid" ? DROP_AHEAD_M.humanoid : DROP_AHEAD_M.noHands;
    const x = pilot.x + Math.sin(pilot.compass) * ahead;
    const y = pilot.y + Math.cos(pilot.compass) * ahead;
    const pos = [x, y, dropZ(c, x, y, pilot) + REST];
    const yaw = dropYaw(c, pilot.compass);
    if (!c.props.place("drone", pos, yaw)) warn("props.place refused the drone");
    setHome(c, pos, yaw);
  }

  /**
   * `detach(drone, world)`: from the hand onto the ground under it when the hand reached the
   * ground (HAND_DROP, tested against the pilot's FEET: dropZ follows the terrain slope); else
   * the drop spot ahead — a timer place (no rig motion), a clip cut before its event or a
   * rebuilt rig leaves the hand at the hip. Both drops take their height from dropZ (F2).
   */
  function detachToWorld(c, prop) {
    if (prop !== "drone") {
      c.props.remove(prop);
      return;
    }
    if (c.props.where("drone") !== "rig") {
      placeDrone(c);
      return;
    }
    const p = c.props.worldPos("drone", c.scratch3);
    const px = p ? (p[0] ?? p.x) : NaN;
    const py = p ? (p[1] ?? p.y) : NaN;
    if (!fin(px) || !fin(py)) {
      placeDrone(c);
      return;
    }
    const pilot = pilotOf(c);
    const pz = p ? (p[2] ?? p.z) : NaN;
    if (!fin(pz) || pz - pilot.z > HAND_DROP.maxUpM || Math.hypot(px - pilot.x, py - pilot.y) < HAND_DROP.minReachM) {
      placeDrone(c);
      return;
    }
    const yaw = dropYaw(c, pilot.compass);
    const r = c.props.toWorld("drone", dropZ(c, px, py, pilot), yaw);
    if (r && r.ok && r.pos && fin(r.pos[0]) && fin(r.pos[1]) && fin(r.pos[2])) setHome(c, r.pos, yaw);
    else placeDrone(c);
  }

  function cameraOwn(c) {
    c.link.cameraOwner.own(); // throws FILM_CAMERA_UNAVAILABLE → hard abort 'error'
    c.link.forcePilotOpaque();
    c.props.setVisible("drone", false);
    c.link.configureLens(settings.mode);
    c.cut = true;
    if (settings.mode === "acro" && c.acroSince === null) c.acroSince = driverTime;
  }

  function cameraRelease(c, framePilot) {
    c.link.cameraOwner.release();
    if (framePilot) c.link.framePilotFront(perfNowMs());
    c.props.setVisible("drone", true);
    c.link.configureLens("cine");
    c.cut = true;
  }

  /** `autopilot` executor: build the plan (SPEC §7.4). */
  function autopilot(c, plan, speed) {
    switch (plan) {
      case "liftoff": {
        if (!c.homeSet) placeDrone(c);
        const pilot = pilotOf(c);
        const h = c.home.pos;
        let ax = h[0] - pilot.x;
        let ay = h[1] - pilot.y;
        const L = Math.hypot(ax, ay);
        // Degenerate (the drop sits at the pilot's feet): a few cm say nothing about a direction.
        if (L > AWAY_MIN_M) {
          ax /= L;
          ay /= L;
        } else {
          ax = Math.sin(pilot.compass);
          ay = Math.cos(pilot.compass);
        }
        const sp = fin(speed) && speed > 0 ? speed : 1;
        c.craft.autopilot({
          kind: "liftoff",
          from: [h[0], h[1], h[2]],
          to: [h[0] + ax * LIFTOFF.backM, h[1] + ay * LIFTOFF.backM, h[2] + LIFTOFF.riseM],
          durationSec: LIFTOFF.durationSec / sp,
          heading: c.home.yaw,
          lookAt: c.launchFacing === "pilot" ? [pilot.x, pilot.y, pilot.z + PILOT_LOOK_Z] : null,
        });
        c.lifted = true;
        c.timerSec = 0;
        return;
      }
      case "rth": {
        const p = c.lastPos;
        const h = c.home.pos;
        const path = c.tether.planReturn([p[0], p[1], p[2]], [h[0], h[1], h[2]], {
          cruiseAglM: RTH_CRUISE_AGL_M,
          groundZFrom: c.link.groundZ(p[0], p[1]),
          groundZHome: c.link.groundZ(h[0], h[1]),
        });
        // The drop yaw: the drone lands facing the way it was set down (no yaw snap at the pickup).
        c.craft.autopilot({ kind: "rth", path, yaw: c.home.yaw });
        return;
      }
      case "hold":
        c.craft.autopilot({ kind: "hold" });
        return;
      case "landHere": {
        const p = c.lastPos;
        const gz = c.link.groundZ(p[0], p[1]);
        const ground = gz ?? c.home.pos[2] - REST;
        c.craft.autopilot({ kind: "land", at: [p[0], p[1], ground + REST] });
        return;
      }
      case "crash":
        c.craft.autopilot({ kind: "crash" });
        c.cut = true;
        return;
      default:
        c.craft.autopilot(null);
        return;
    }
  }

  /** Control actions (controls.onAction, SPEC §7.3). */
  function onControlAction(ev) {
    const type = ev && ev.type;
    try {
      if (type === "pilotView") api.pilotView();
      else if (type === "mode") {
        const i = CRAFT_MODE_NAMES.indexOf(settings.mode);
        api.setMode(CRAFT_MODE_NAMES[(i + 1) % CRAFT_MODE_NAMES.length]);
      } else if (type === "hideHud") {
        const c = C;
        if (c && c.osd) c.clean = c.osd.clean(!c.clean) === true;
      } else if (type === "returnHome" || type === "recall") api.recall();
    } catch (e) {
      warn(`control action ${type} failed: ${errText(e)}`);
    }
  }

  // ---- the frame driver (SPEC §5) -------------------------------------------------------------

  function onPreFrame(tsMs, dtRaw) {
    const c = C;
    if (!c || c.dead || c.ticking) return;
    try {
      frame(c, tsMs, dtRaw);
    } catch (e) {
      if (C === c && !c.dead) {
        warn(`frame driver threw: ${errText(e)}`);
        c.ticking = false;
        request("abort", { reason: "error" });
      }
    }
  }

  function onPostRender() {
    const c = C;
    if (!c || c.dead) return;
    try {
      if (!c.link.cameraOwner.owned) return;
      const m = settings.mode;
      if (m !== "angle" && m !== "acro") return;
      const f = c.lensIn;
      const ft = c.live.frameTime;
      f.t = ft && fin(ft.tsSec) ? ft.tsSec : c.tsMs / 1000;
      f.theta = c.theta;
      f.throttle = c.lastFrame && fin(c.lastFrame.throttle) ? c.lastFrame.throttle : 1;
      f.fov = settings.fovDeg;
      c.link.drawLens(f);
    } catch (e) {
      if (C === c && !c.dead) {
        warn(`lens draw threw: ${errText(e)}`);
        request("abort", { reason: "error" });
      }
    }
  }

  /** Step 2: signals into the reused object; the 4 Hz film-busy poll and rig watch. */
  function readSignals(c, hz4, now) {
    const s = c.ti.signals;
    s.damage = latched.damage;
    let death = latched.death;
    if (!death) {
      try {
        death = c.em.isDeathHeld?.(c.guid) === true;
      } catch (_) {
        death = false;
      }
    }
    s.death = death;
    let portal = latched.portal;
    if (!portal) {
      try {
        portal = win?.__isPortalSpaceActive?.() === true;
      } catch (_) {
        portal = false;
      }
    }
    s.portal = portal;
    let combat = latched.combat;
    if (!combat) {
      try {
        const low = (win?.__getCurrentStanceLow?.() ?? 0x3d) & 0xffff;
        combat = low !== 0 && low !== 0x3d;
      } catch (_) {
        combat = false;
      }
    }
    s.stanceCombat = combat;
    if (readPilot(c.live, win, c.pilotNow)) {
      const dx = c.pilotNow.x - c.anchor.x, dy = c.pilotNow.y - c.anchor.y, dz = c.pilotNow.z - c.anchor.z;
      c.pilotMovedM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    s.pilotMovedM = latched.pilotMoved ? 1e9 : c.pilotMovedM;
    let sess = latched.session;
    if (!sess) {
      try {
        sess = sessionChanged(win, c.mark);
      } catch (_) {
        sess = false;
      }
    }
    s.sessionChanged = sess;
    if (hz4) {
      c.filmBusyLevel = filmBusy(win);
      rigWatch(c, now);
    }
    s.filmBusy = latched.film || c.filmBusyLevel;
    let lost = latched.contextLost;
    if (!lost) lost = c.live.__webglContextLost === true;
    s.contextLost = lost;
    let hidden = false;
    try {
      hidden = doc?.visibilityState === "hidden";
    } catch (_) {
      hidden = false;
    }
    s.hidden = hidden;
  }

  /** SPEC §6.12: the rig rebuild watch (4 Hz). */
  function rigWatch(c, now) {
    let cur;
    try {
      cur = c.em.entityMap?.get?.(c.guid);
    } catch (_) {
      cur = undefined;
    }
    if (cur === c.inst) {
      c.missingSince = null;
      c.lostSince = null;
      return;
    }
    if (cur === undefined || cur === null) {
      let inFlight = false;
      try {
        inFlight = !!c.em.spawnInFlight?.has?.(c.guid);
      } catch (_) {
        inFlight = false;
      }
      if (c.missingSince === null) c.missingSince = now;
      if (inFlight) c.lostSince = null;
      else if (c.lostSince === null) c.lostSince = now;
      if ((c.lostSince !== null && now - c.lostSince >= RIG_MISSING_SEC) || now - c.missingSince > RIG_REBUILD_SEC) {
        c.rigLost = true;
      }
      return;
    }
    // A NEW instance (a hot-swap fallback or a same-guid CreateObject): re-bind everything.
    c.missingSince = null;
    c.lostSince = null;
    c.inst = cur;
    let prof = null;
    try {
      prof = c.gestures.profile() ?? c.profile;
    } catch (_) {
      prof = c.profile;
    }
    c.props.setRig({ guid: c.guid, parts: cur.parts, rootScale: cur.root?.scale?.x ?? 1, profile: prof ?? null });
    c.rigSet = !!prof;
    c.gestures.rebind(cur);
    // Only while locked, as the step 14 watchdog: never re-assert ReadState after an abort (DV-13).
    if (c.held && c.locked) swallow(c.gestures.hold(READ_STATE, 1));
    if (c.wieldedHidden) c.gestures.applyWielded();
  }

  /** One frame (SPEC §5 steps 1–14). */
  function frame(c, tsMs, dtRaw) {
    const dt = typeof dtRaw === "number" && Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : 0;
    const now = clock();
    c.tsMs = fin(tsMs) ? tsMs : c.tsMs;
    driverTime += dt;
    const ti = c.ti;

    // 1. sticks
    const sticks = driverTime < dbg.until ? dbg.sticks : (c.controls.poll(dt) || ZERO_STICKS);
    if (C !== c) return; // a control action (gamepad edge) ended the cycle
    const sa = Math.abs(sticks.throttle) > 0.1 || Math.abs(sticks.yaw) > 0.1 || Math.abs(sticks.pitch) > 0.1 || Math.abs(sticks.roll) > 0.1;
    ti.input.sticksActive = sa;
    ti.input.anyInput = sa || Math.abs(sticks.gimbal) > 0.1 || !!sticks.boost || (fin(sticks.lookX) && sticks.lookX !== 0)
      || (fin(sticks.lookY) && sticks.lookY !== 0);
    if (fin(sticks.zoom) && sticks.zoom !== 0) {
      const fov = clamp(settings.fovDeg + 5 * sticks.zoom, 60, 110);
      if (fov !== settings.fovDeg) {
        settings.fovDeg = fov;
        settingsDirty = true; // persisted by the 1 Hz step 13, never here
      }
    }

    // 2. signals (+ the 4 Hz film-busy poll and rig watch)
    let hz4 = false;
    c.hz4Acc += dt;
    if (c.firstFrame || c.hz4Acc >= 0.25) {
      if (!c.firstFrame) c.hz4Acc -= 0.25;
      if (c.hz4Acc >= 0.25) c.hz4Acc = 0;
      c.firstFrame = false;
      c.hz4Count += 1;
      hz4 = true;
    }
    readSignals(c, hz4, now);
    if (c.rigLost) {
      request("abort", { reason: "rigLost" });
      return;
    }

    // 3. gestures
    const gp = c.gestures.poll(dt);
    ti.beatEvent = !!(gp && gp.event && !gp.rigChanged);
    ti.beatDone = !!(gp && gp.done && !gp.rigChanged);
    let prof = null;
    try {
      prof = c.gestures.profile();
    } catch (_) {
      prof = null;
    }
    ti.rigKnown = prof && typeof prof.kind === "string" ? prof.kind : null;
    ti.rig = c.readyKind;
    if (prof && !c.rigSet) {
      c.props.setRig({ guid: c.guid, parts: c.inst.parts, rootScale: c.inst.root?.scale?.x ?? 1, profile: prof });
      c.rigSet = true;
    }
    if (prof && (!c.profile || c.profile.kind !== prof.kind)) {
      c.profile = prof;
      lastRig = { guid: c.guid, kind: prof.kind, setupId: c.setupHex, parts: Array.isArray(c.inst.parts) ? c.inst.parts.length : 0 };
    }
    ti.craft.gone = c.props.where("drone") === "none" && !c.props.fading("drone");

    // 4. the sequence
    ti.dt = dt;
    ti.now = now;
    ti.request = null;
    ti.arg = null;
    ti.crashMps = settings.crash ? settings.crashMps : 0;
    c.ticking = true;
    let actions;
    try {
      actions = c.seq.tick(ti);
    } catch (e) {
      c.ticking = false;
      emergency(c, e);
      return;
    }
    clearLatches();
    ti.battery.rth = false; // the edge was delivered
    try {
      process(c, actions);
    } finally {
      c.ticking = false;
    }
    drain(c);
    if (C !== c || c.dead) return;

    // 5–12: only while the drone is in the world
    const props = c.props;
    if (c.arm.level !== c.arm.target) {
      const stepA = c.arm.rate * dt;
      c.arm.level = c.arm.level < c.arm.target ? Math.min(c.arm.target, c.arm.level + stepA) : Math.max(c.arm.target, c.arm.level - stepA);
    }
    const inWorld = props.where("drone") === "world";
    let pose = null;
    let frameC = null;
    if (!inWorld) {
      props.setRotor(0, now);
      ti.craft.impactSpeed = 0;
    } else {
      // 5. the craft
      const gz = c.link.groundZ(c.lastPos[0], c.lastPos[1]);
      const owned = c.link.cameraOwner.owned;
      const st = state;
      const active = st === "flying" || (st === "deploying" && owned) || (st === "returning" && owned);
      const si = c.stepIn;
      si.sticks = active ? sticks : ZERO_STICKS;
      si.dt = dt;
      si.groundZ = gz;
      si.fovDeg = settings.fovDeg;
      frameC = c.craft.step(si);
      // 6. the tether
      const t = c.tether.clamp(frameC.cam.pos, c.home.pos, gz);
      const hits = c.hits;
      hits.length = 0;
      if (t.limited) {
        const th = c.tetherHit;
        th.kind = t.kind;
        th.point = t.pos;
        th.normal = t.normal;
        hits.push(th);
      }
      // 7. safety (eye while owned, body otherwise — and always for a ground-ending plan)
      const want = c.want;
      want.t = driverTime;
      want.pos[0] = t.pos[0];
      want.pos[1] = t.pos[1];
      want.pos[2] = t.pos[2];
      const cq = frameC.cam.q;
      want.q[0] = cq[0];
      want.q[1] = cq[1];
      want.q[2] = cq[2];
      want.q[3] = cq[3];
      want.h = frameC.cam.h;
      want.p = frameC.cam.p;
      want.r = frameC.cam.r;
      want.fov = settings.fovDeg;
      const cut = c.prevPose === null || c.cut;
      c.cut = false;
      const aspect = c.link.aspect();
      // A crash, land or rth plan ends on the ground: the BODY reflex holds the craft even while
      // the camera is owned (the eye's 0.7 m terrain floor would rest or land it in mid-air, DV-7);
      // the owned camera then takes its own EYE clamp of the body pose (step 9).
      const ap = frameC.autopilot;
      const groundPlan = ap === "crash" || ap === "land" || ap === "rth";
      let res;
      if (owned && !groundPlan) {
        const x = c.eyeCtx;
        x.fovDeg = settings.fovDeg;
        x.aspect = aspect;
        x.cell = c.link.cameraOwner.viewerCell();
        x.cut = cut;
        res = c.link.safety.clamp(c.prevEye ?? c.prevPose, want, x);
      } else {
        const x = c.bodyCtx;
        x.aspect = aspect;
        x.cut = cut;
        res = c.link.safetyBody.clamp(c.prevPose, want, x);
      }
      const clamped = !!(res && res.pose && res.pose.pos);
      pose = clamped ? res.pose : want;
      if (res && Array.isArray(res.hits)) for (let k = 0; k < res.hits.length; k += 1) hits.push(res.hits[k]);
      // 8. contact feedback
      ti.craft.impactSpeed = 0;
      if (hits.length > 0) {
        const r = c.craft.contact(hits, pose.pos);
        ti.craft.impactSpeed = r && fin(r.impactSpeed) ? r.impactSpeed : 0;
      }
      // (the reused `want` never becomes the previous pose: its arrays change next frame)
      c.prevPose = clamped ? pose : null;
      const pp = pose.pos;
      // 9. the camera (a ground plan: a second, camera-only EYE clamp of the body pose)
      if (owned) {
        let eye = clamped ? pose : null;
        if (groundPlan) {
          const x = c.eyeCtx;
          x.fovDeg = settings.fovDeg;
          x.aspect = aspect;
          x.cell = c.link.cameraOwner.viewerCell();
          x.cut = cut || c.prevEye === null;
          const er = c.link.safety.clamp(c.prevEye ?? c.prevPose, pose, x);
          eye = er && er.pose && er.pose.pos ? er.pose : null;
        }
        // The last EYE pose (kept for the cycle): every eye sweep starts there, never inside the
        // body radius or under the eye floor after a ground plan.
        if (eye) c.prevEye = eye;
        const w = c.camPose;
        w.pos = eye ? eye.pos : pp;
        w.q = cq;
        w.h = frameC.cam.h;
        w.p = frameC.cam.p;
        w.r = frameC.cam.r;
        w.fov = settings.fovDeg;
        c.link.cameraOwner.write(w);
      }
      // 10. the drone mesh
      props.setDronePose(pp, frameC.body.q);
      props.setGround(gz);
      const thr = fin(frameC.throttle) ? frameC.throttle : 0;
      props.setRotor(c.arm.level * (frameC.landed ? 0.35 : clamp(thr, 0.35, 2.5)), now);
      // the next tick's craft facts
      const ground = gz ?? c.home.pos[2] - REST;
      const hx = c.home.pos[0] - pp[0], hy = c.home.pos[1] - pp[1], hz = c.home.pos[2] - pp[2];
      const distHome = Math.sqrt(hx * hx + hy * hy + hz * hz);
      ti.craft.landed = frameC.landed === true;
      ti.craft.autopilotDone = frameC.autopilotDone === true;
      ti.craft.distTouchdownM = fin(frameC.distTouchdownM) ? frameC.distTouchdownM : null;
      ti.craft.aglM = pp[2] - ground;
      ti.craft.distHomeM = distHome;
      c.lastPos[0] = pp[0];
      c.lastPos[1] = pp[1];
      c.lastPos[2] = pp[2];
      c.lastFrame = frameC;
      c.lastSignal = fin(t.signal) ? t.signal : 1;
      c.lastRange = t.kind === "range";
      c.lastAgl = ti.craft.aglM;
      c.lastDistHome = distHome;
      if (c.lifted) c.timerSec += dt;
      c.theta += thr * dt;
      // 11. the OSD (text at 10 Hz, transforms every frame)
      const bearing = Math.atan2(hx, hy);
      c.hz10Acc += dt;
      if (c.hz10Acc >= 0.1) {
        c.hz10Acc -= 0.1;
        if (c.hz10Acc >= 0.1) c.hz10Acc = 0;
        const v = c.osdView;
        v.mode = settings.mode;
        v.battery = c.batteryOn ? ti.battery.level : null;
        v.timerSec = c.timerSec;
        v.signal = c.lastSignal;
        v.distHomeM = distHome;
        v.aglM = ti.craft.aglM;
        v.speedMps = fin(frameC.speed) ? frameC.speed : 0;
        v.headingRad = wrapPi(frameC.cam.h);
        v.homeBearingRad = bearing;
        v.banners.rangeLimit = c.lastRange;
        v.banners.lowBattery = ti.battery.warn === true;
        v.banners.returning = state === "returning";
        v.banners.crash = state === "crashed";
        v.banners.acroHint = acroHint(c);
        v.reticle = settings.mode === "cine" ? "crosshair" : "horizon";
        c.osd.update(v);
      }
      const of = c.osdFrame;
      of.headingRad = wrapPi(frameC.cam.h);
      of.rollRad = frameC.body.r;
      of.pitchRad = frameC.body.p;
      c.osd.frame(of);
      c.osd.staticLevel(state === "crashed" ? 0 : c.lastSignal);
      // 12. the hum
      const ai = c.audioIn;
      ai.throttle = thr;
      ai.speed = fin(frameC.speed) ? frameC.speed : 0;
      ai.level = c.arm.level;
      ai.fpv = c.link.cameraOwner.owned;
      ai.pos = pp;
      c.audio.update(ai);
    }

    // 13. 4 Hz work
    if (hz4) {
      if (c.wieldedHidden) c.gestures.applyWielded();
      if (props.where("tablet") === "rig" && !c.link.cameraOwner.owned) {
        const sc = c.screen;
        sc.signal = c.lastSignal;
        sc.battery = c.batteryOn ? ti.battery.level : null;
        const hx = c.home.pos[0] - c.lastPos[0], hy = c.home.pos[1] - c.lastPos[1];
        // No arrow at home (< 1 m, the OSD's rule) or without the drone in the world.
        sc.homeBearingRad = !inWorld || c.lastDistHome < 1 ? NaN : Math.atan2(hx, hy);
        sc.distM = c.lastDistHome;
        sc.live = inWorld;
        props.setScreen(sc);
      }
      if (c.hz4Count % 4 === 0 && settingsDirty) persistSettings();
    }

    // 14. the held-motion watchdog, prewarm, battery
    if (c.held && c.locked) c.gestures.watch(now);
    if (inWorld && pose) {
      c.link.prewarmAround(pose.pos);
      if (!frameC.landed) {
        const r = c.tether.drain(dt, fin(frameC.throttle) ? frameC.throttle : 0);
        const b = ti.battery;
        b.level = r && fin(r.battery) ? r.battery : b.level;
        b.warn = !!(r && r.warn);
        b.rth = !!(r && r.rth);
        b.empty = !!(r && r.empty);
      }
    }
  }

  /** "ACRO: gamepad recommended" during the first 3 s of acro without a gamepad. */
  function acroHint(c) {
    if (settings.mode !== "acro" || c.acroSince === null || driverTime - c.acroSince >= 3) return false;
    try {
      const s = c.controls.status();
      return !(s && s.gamepad);
    } catch (_) {
      return true;
    }
  }

  // ---- api methods -------------------------------------------------------------------------------

  /**
   * Clear the orphan 'gate' a film take put back from its snapshot of our lock (SPEC A5): only
   * with no cycle running, film idle again and the slot still reading 'gate'. Called first by
   * status() (the plugin polls it every 500 ms) and deploy().
   */
  function settleFilmGate() {
    if (!filmGate || C || filmBusy(win)) return;
    const f = filmGate;
    filmGate = null;
    try {
      const fault = typeof f.snapshot === "function" ? f.snapshot()?.fault ?? null : f._fault ?? null;
      if (fault === "gate" && typeof f.unpoison === "function") f.unpoison();
    } catch (_) {
      /* a broken funnel: nothing to settle */
    }
  }

  /**
   * After the goggle cut (cameraOwn ran) but before T8, a recall / pilot-view press takes
   * control first: a skip after the own IS T8 (state flying, the pending osd(fpv),
   * autopilot(null)), then the press applies as it would from flying.
   */
  function takeControlAfterCut() {
    const c = C;
    if (state !== "deploying" || !c || c.dead || !c.seq) return;
    let own = false;
    try {
      own = c.seq.state().cutFired.own === true;
    } catch (_) {
      own = false;
    }
    if (own) request("skip");
  }

  function deploy(opts) {
    let quick = settings.quickDeploy;
    if (opts !== undefined && opts !== null) {
      if (!isObj(opts)) return bad("deploy options must be an object");
      if (opts.quick !== undefined) {
        if (typeof opts.quick !== "boolean") return bad("quick must be a boolean");
        quick = opts.quick;
      }
    }
    if (state !== "idle") return state === "deploying" ? { ok: true, already: true, state } : refusal("busy");
    settleFilmGate();
    // Idle already recorded but the last cycle not torn down yet (a call from inside its 'idle'
    // hb-drone-state event): its remaining actions (inputRestore) would undo the new lock.
    if (C) return refusal("busy");
    if (typeof d.refusal === "function") {
      let code = null;
      try {
        code = d.refusal();
      } catch (_) {
        code = null;
      }
      if (typeof code === "string" && code !== "") return refusal(code);
    }
    const live = liveOf();
    if (!live || !live.scene || !live.renderer || !live.cameraSwitcher || !live.entityManager) return refusal("not-in-world");
    // A lost WebGL context runs no frame until the restore: T1 would lock input with nothing to drive it.
    if (live.__webglContextLost === true) return refusal("not-in-world");
    const guid = localGuid();
    if (guid === 0) return refusal("not-in-world");
    let inst = null;
    try {
      inst = live.entityManager.entityMap?.get?.(guid) ?? null;
    } catch (_) {
      inst = null;
    }
    if (!inst || !inst.root) return refusal("not-in-world");
    clearLatches();
    let c;
    try {
      c = buildCycle(live, guid, inst, quick);
    } catch (e) {
      warn(`deploy failed: ${errText(e)}`);
      if (C) teardown(C);
      return fail("internal", errText(e));
    }
    // A roof over the launch spot (F1): refused before T1 locks input. Only the link was built;
    // the internal-error teardown removes it (and liveScene3d.film when the link made it).
    if (c.covered) {
      teardown(c);
      return refusal("covered");
    }
    request("deploy", { quick });
    if (!c.dead && state === "idle") teardown(c); // the request tick did not start the cycle
    if (c.errorAbort || c.dead) return fail("internal", "deploy failed (see debug.events)");
    return { ok: true, state, quick };
  }

  function recall(opts) {
    let instant = false;
    if (opts !== undefined && opts !== null) {
      if (!isObj(opts)) return bad("recall options must be an object");
      if (opts.instant !== undefined) {
        if (typeof opts.instant !== "boolean") return bad("instant must be a boolean");
        instant = opts.instant;
      }
    }
    takeControlAfterCut();
    if (state === "flying" || state === "pilotView") {
      request(instant ? "recallInstant" : "recall");
      return { ok: true, state };
    }
    if (state === "returning") {
      if (!instant) return { ok: true, already: true, state };
      const owned = !!(C && C.link && C.link.cameraOwner.owned);
      request("recallInstant");
      return owned ? { ok: true, state } : { ok: true, already: true, state };
    }
    if (state === "landing" || state === "stowing") return { ok: true, already: true, state };
    return notFlying();
  }

  function skip() {
    if (state !== "deploying") return notFlying();
    request("skip");
    return { ok: true, state };
  }

  function button(opts) {
    const shift = isObj(opts) && opts.shift === true;
    switch (state) {
      case "idle":
        return { ...deploy(), action: "deploy" };
      case "deploying":
        return { ...skip(), action: "skip" };
      case "flying":
      case "pilotView":
        return { ...recall({ instant: shift }), action: shift ? "recallInstant" : "recall" };
      case "returning":
        return { ...recall({ instant: true }), action: "recallInstant" };
      default:
        return { ok: true, action: "ignored", state };
    }
  }

  function abort(reason) {
    const r = ABORT_REASON_NAMES.includes(reason) ? reason : "user";
    if (state === "idle" || !C) return { ok: true, state: "idle", already: true };
    request("abort", { reason: r });
    return { ok: true, state };
  }

  /** Live effects of changed settings on a running cycle. */
  function applyLive(patch) {
    const c = C;
    if (!c || c.dead) return;
    if (hasOwn(patch, "mode")) {
      c.craft.setMode(settings.mode);
      if (c.link.cameraOwner.owned) c.link.configureLens(settings.mode);
      if (settings.mode === "acro") c.acroSince = driverTime;
    }
    if (hasOwn(patch, "acroRc") || hasOwn(patch, "acroSuper") || hasOwn(patch, "acroExpo")) {
      c.craft.setRates({ rc: settings.acroRc, super: settings.acroSuper, expo: settings.acroExpo });
    }
    if (hasOwn(patch, "rangeM") || hasOwn(patch, "ceilingAglM")) {
      c.tether.configure({ rangeM: settings.rangeM, ceilingAglM: settings.ceilingAglM });
    }
  }

  function setMode(mode) {
    if (!CRAFT_MODE_NAMES.includes(mode)) return bad(`mode must be one of ${CRAFT_MODE_NAMES.join(", ")}`);
    settings.mode = mode;
    persistSettings();
    applyLive({ mode });
    return { ok: true, mode };
  }

  function pilotView(on) {
    if (on !== undefined && typeof on !== "boolean") return bad("pilotView(on) takes a boolean or nothing");
    takeControlAfterCut();
    if (state === "flying") {
      if (on === false) return { ok: true, already: true, state };
      request("pilotView");
      return { ok: true, state };
    }
    if (state === "pilotView") {
      if (on === true) return { ok: true, already: true, state };
      request("pilotView");
      return { ok: true, state };
    }
    return notFlying();
  }

  function getSettings() {
    return { ok: true, settings: { ...settings }, defaults: { ...DRONE_SETTINGS_DEFAULTS } };
  }

  function setSettings(patch) {
    const v = validateSettingsPatch(patch);
    if (!v.ok) return v;
    Object.assign(settings, v.value);
    persistSettings();
    applyLive(v.value);
    return { ok: true, settings: { ...settings } };
  }

  /** The tune patch validated (SPEC §3.9 tune). */
  function validateTunePatch(p) {
    if (!isObj(p)) return bad("tune patch must be an object");
    const value = {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (k === "reset") {
        if (v !== true) return bad("reset must be true");
        value.reset = true;
        continue;
      }
      if (k === "clipMode") {
        if (v !== "clip" && v !== "timer") return bad("clipMode must be 'clip' or 'timer'");
        value.clipMode = v;
        continue;
      }
      if (!hasOwn(ANCHOR_FIELDS, k)) return bad(`unknown tune key "${k}"`);
      if (!isObj(v)) return bad(`${k} must be an object`);
      const out = {};
      for (const f of Object.keys(v)) {
        if (!ANCHOR_FIELDS[k].includes(f)) return bad(`${k}.${f} is not tunable`);
        const val = anchorField(v, f, true);
        if (val === null) {
          return bad(f === "pos" ? `${k}.pos must be 3 finite numbers` : f === "quat" ? `${k}.quat must be 4 finite numbers (non-zero)`
            : `${k}.scale must be a finite number > 0`);
        }
        out[f] = val;
      }
      value[k] = out;
    }
    return { ok: true, value };
  }

  function tune(patch) {
    const live = liveOf();
    const guid = localGuid();
    let inst = null;
    try {
      inst = guid !== 0 ? live?.entityManager?.entityMap?.get?.(guid) ?? null : null;
    } catch (_) {
      inst = null;
    }
    if (!inst) return refusal("not-in-world");
    const key = hex32(setupOf(inst));
    if (patch !== undefined) {
      const v = validateTunePatch(patch);
      if (!v.ok) return v;
      const prev = isObj(tuneLocal[key]) && !v.value.reset ? tuneLocal[key] : {};
      const entry = {};
      for (const name of Object.keys(ANCHOR_FIELDS)) {
        const a = { ...(isObj(prev[name]) ? prev[name] : {}), ...(v.value[name] || {}) };
        if (Object.keys(a).length > 0) entry[name] = a;
      }
      const cm = v.value.clipMode ?? prev.clipMode;
      if (cm === "clip" || cm === "timer") entry.clipMode = cm;
      if (Object.keys(entry).length > 0) tuneLocal[key] = entry;
      else delete tuneLocal[key];
      persistTune();
    }
    const merged = mergeAnchors(M.DEFAULT_ANCHORS, rigProfiles[key], tuneLocal[key]);
    const c = C;
    if (c && !c.dead && c.setupHex === key) {
      c.anchors = merged;
      c.props.setAnchors(anchorsOnly(merged));
    }
    return { ok: true, setupId: key, anchors: anchorsOnly(merged), clipMode: merged.clipMode ?? "clip", source: merged.source };
  }

  function rigStatus() {
    const c = C;
    if (c && c.profile) {
      return { kind: c.profile.kind, setupId: c.setupHex, parts: Array.isArray(c.inst.parts) ? c.inst.parts.length : 0 };
    }
    if (!c && lastRig && lastRig.guid === localGuid()) return { kind: lastRig.kind, setupId: lastRig.setupId, parts: lastRig.parts };
    return null;
  }

  function craftStatus() {
    const c = C;
    if (!c || !c.props || !c.lastFrame) return null;
    let where = "none";
    try {
      where = c.props.where("drone");
    } catch (_) {
      where = "none";
    }
    if (where !== "world") return null;
    const f = c.lastFrame;
    const v = Array.isArray(f.vel) || ArrayBuffer.isView(f.vel) ? f.vel : [0, 0, 0];
    const b = f.body || {};
    const deg = (a) => (fin(a) ? (a * 180) / Math.PI : null);
    const hDeg = fin(b.h) ? ((((b.h * 180) / Math.PI) % 360) + 360) % 360 : null;
    return {
      pos: [rnd(c.lastPos[0], 3), rnd(c.lastPos[1], 3), rnd(c.lastPos[2], 3)],
      vel: [rnd(v[0], 2), rnd(v[1], 2), rnd(v[2], 2)],
      hprDeg: { h: rnd(hDeg, 2), p: rnd(deg(b.p), 2), r: rnd(deg(b.r), 2) },
      aglM: rnd(c.lastAgl, 3),
      speed: rnd(f.speed, 2),
      distHomeM: rnd(c.lastDistHome, 3),
      signal: rnd(c.lastSignal, 3),
      battery: c.batteryOn ? rnd(c.ti.battery.level, 3) : null,
    };
  }

  function inputStatus() {
    const c = C;
    if (!c || !c.controls) return { source: null, pointerLocked: false, locked: false, gamepad: false };
    let s = null;
    try {
      s = c.controls.status();
    } catch (_) {
      s = null;
    }
    return {
      source: s && s.source !== undefined ? s.source : null,
      pointerLocked: c.controls.pointerLocked === true,
      locked: c.controls.locked === true,
      gamepad: s && s.gamepad !== undefined ? s.gamepad : false,
    };
  }

  function status() {
    settleFilmGate();
    const c = C;
    let beat = null;
    let quick = false;
    if (c && c.seq) {
      try {
        const s = c.seq.state();
        beat = s.beat;
        quick = s.quick === true;
      } catch (_) {
        /* report what we have */
      }
    }
    return {
      ok: true,
      version: DRONE_API_VERSION,
      state,
      beat,
      mode: settings.mode,
      since: rnd(since, 3),
      quick,
      rig: rigStatus(),
      craft: craftStatus(),
      input: inputStatus(),
      camera: { owned: !!(c && c.link && c.link.cameraOwner.owned), fovDeg: settings.fovDeg },
      flags: { debug: flags.debug, audio: flags.audio, signals: typeof d.onSignal === "function" ? "bus" : "levels-only" },
      lastAbort: lastAbort ? { reason: lastAbort.reason, from: lastAbort.from, at: rnd(lastAbort.at, 3) } : null,
    };
  }

  function dispose() {
    if (C) request("abort", { reason: "dispose" });
    if (C) emergency(C, new Error("dispose"));
    disposed = true;
    try {
      if (win && win.__drone === api) delete win.__drone;
    } catch (_) {
      /* a sealed window */
    }
    if (singleton === rec) singleton = null;
    return { ok: true };
  }

  // ---- debug (?droneDebug=on) -----------------------------------------------------------------

  function setSticks(axes, ms) {
    if (!isObj(axes)) return bad("setSticks(axes, ms): axes must be an object");
    if (!fin(ms) || ms < 0) return bad("setSticks(axes, ms): ms must be a finite number ≥ 0");
    const s = { ...ZERO_STICKS };
    for (const k of Object.keys(ZERO_STICKS)) {
      if (!hasOwn(axes, k)) continue;
      const v = axes[k];
      if (k === "boost") s.boost = v === true || (fin(v) && v > 0) ? 1 : 0;
      else if (fin(v)) s[k] = k === "lookX" || k === "lookY" ? v : clamp(v, -1, 1);
    }
    dbg.sticks = s;
    dbg.until = driverTime + ms / 1000;
    return { ok: true, untilSec: rnd(dbg.until, 3) };
  }

  function trigger(signal) {
    const k = typeof signal === "string" && hasOwn(DEBUG_SIGNALS, signal) ? DEBUG_SIGNALS[signal] : null;
    if (!k) return bad(`trigger(signal): one of ${Object.keys(DEBUG_SIGNALS).join(", ")}`);
    latched[k] = true;
    return { ok: true };
  }

  async function clipParity() {
    if (disposed) return DISPOSED();
    try {
      const c = C;
      if (c && c.gestures) {
        if (typeof c.gestures.clipParity !== "function") return fail("not-available", "gestures.clipParity is not available");
        return jsonSafe(await c.gestures.clipParity());
      }
      const live = liveOf();
      const guid = localGuid();
      const em = live?.entityManager;
      if (!em || guid === 0 || !em.entityMap?.get?.(guid)) return refusal("not-in-world");
      const g = M.createGestureDriver({ entityManager: em, wasm: live.wasmExports, guid, log });
      try {
        if (typeof g.clipParity !== "function") return fail("not-available", "gestures.clipParity is not available");
        return jsonSafe(await g.clipParity());
      } finally {
        try {
          g.dispose();
        } catch (_) {
          /* best effort */
        }
      }
    } catch (e) {
      return fail("internal", errText(e));
    }
  }

  function events(opts) {
    let limit = 100;
    if (opts !== undefined && opts !== null) {
      if (!isObj(opts)) return bad("events({limit}) takes an object");
      if (opts.limit !== undefined) {
        if (!fin(opts.limit) || opts.limit < 0) return bad("limit must be a finite number ≥ 0");
        limit = Math.floor(opts.limit);
      }
    }
    return { ok: true, events: limit > 0 ? ring.slice(-limit) : [] };
  }

  const api = {
    version: DRONE_API_VERSION,
    status: method(status),
    deploy: method(deploy),
    recall: method(recall),
    skip: method(skip),
    button: method(button),
    abort: method(abort),
    setMode: method(setMode),
    pilotView: method(pilotView),
    settings: method(getSettings),
    setSettings: method(setSettings),
    tune: method(tune),
    dispose: method(dispose),
  };
  if (flags.debug) {
    api.debug = Object.freeze({
      setSticks: method(setSticks),
      trigger: method(trigger),
      clipParity,
      events: method(events),
    });
  }
  Object.freeze(api);
  rec.api = api;
  if (win) {
    try {
      win.__drone = api;
    } catch (_) {
      /* a sealed window: the plugin keeps its own reference */
    }
  }
  return api;
}
