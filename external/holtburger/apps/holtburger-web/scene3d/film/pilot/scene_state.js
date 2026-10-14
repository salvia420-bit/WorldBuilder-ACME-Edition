// scene3d/film/pilot/scene_state.js — SensorFrame → words-only JEV pilot state (SPEC §2.14, §3.1).
//
// WHY: the JEV pilot never sees numbers. Perception (scene/sensors.js) measures
// how close the film camera is to trees, walls, rocks, creatures and particle
// clouds and how visible the subject is; this module turns one SensorFrame into
// the compact, words-only `state` object that is sent to JEV (TypeSafe's
// System-One model) every consult, that the code policy (policy_code.js) reads,
// and that fingerprint.js hashes to decide whether the bucketed scene changed.
// It also carries the director's one-sentence standing order for the shot and
// the vertical / lateral limits (the jev-drone lesson: without "free above" and
// the ceiling in the state, a climb is never chosen).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic: same SensorFrame + options → same state.
//
// SensorFrame conventions the perception lane follows (SPEC §3.1): ranges in
// metres (Infinity = nothing within 25 m); `sectors` are the 5 forward sectors
// {range, kind}; `sides` values may be plain ranges or {range, kind};
// `subject.unseenSec` = seconds the subject has been FULLY hidden (<10% visible);
// `limits.roomLeft/roomRight` = metres of free space the sensors see beside the
// camera on that side (a boolean is accepted: true = plenty, false = none;
// missing → the side clearance `sides.left/right`); `limits.ceiling` = metres of
// free air above. The shot's own bounds (opts.bounds) never shrink the sensed
// room words: a spent bound is stated separately as `can_rise`/`can_sink`/
// `can_drift_left`/`can_drift_right` "no", so a drift stays possible for every
// technique whose maxLateral is smaller than the "some" room band.

import { MANEUVERS } from "./questions.js";
import {
  bearingWord,
  densityWord,
  distanceWord,
  elevationWord,
  kindWord,
  offsetWord,
  roomWord,
  sinceWord,
  sizeWord,
  speedWord,
  ttcWord,
  unseenWord,
  visibilityWord,
  yesNo,
} from "./sense_words.js";

/** Standing order used when the director wrote none for the shot. */
export const DEFAULT_STANDING_ORDER =
  "Fly the planned shot smoothly, keep clear of obstacles and keep the subject in frame.";

/** Word used for every `subject.*` field when the shot has no subject. */
export const NO_SUBJECT = "no subject";

/** Longest standing order (characters) passed to JEV; longer text is cut at a word boundary. */
export const MAX_STANDING_ORDER_CHARS = 300;

/**
 * Metres of shot bound (maxRise / maxSink / maxLateral) that must still be unused on a side
 * for `limits.can_rise` / `can_sink` / `can_drift_left` / `can_drift_right` to be "yes".
 * At or below this the bound counts as spent (the mapper clamps the offset there anyway).
 */
export const BOUND_SLACK_M = 0.05;

/**
 * Every leaf path of a pilot state, in the order buildPilotState writes them.
 * @type {readonly string[]}
 */
export const STATE_PATHS = Object.freeze([
  "standing_order",
  "shot.technique",
  "shot.goal",
  "camera.speed",
  "obstacles.far_left",
  "obstacles.left",
  "obstacles.ahead",
  "obstacles.right",
  "obstacles.far_right",
  "obstacles.above",
  "obstacles.below",
  "obstacles.left_side",
  "obstacles.right_side",
  "obstacles.behind",
  "free_space.level_ahead",
  "free_space.above_ahead",
  "free_space.below_ahead",
  "nearest.kind",
  "nearest.range",
  "nearest.side",
  "path_ahead.contact_in",
  "path_ahead.blocker",
  "subject.visibility",
  "subject.unseen_for",
  "subject.in_frame",
  "subject.size",
  "subject.occluded_by",
  "particles.on_lens",
  "particles.in_view",
  "limits.can_rise",
  "limits.can_sink",
  "limits.can_drift_left",
  "limits.can_drift_right",
  "limits.room_left",
  "limits.room_right",
  "limits.ceiling",
  "current.maneuver",
  "current.since",
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {*} v @returns {boolean} */
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Range of a sensor slot: a number, or `{range}`; anything else → Infinity (nothing sensed).
 * @param {*} slot
 * @returns {number}
 */
export function slotRange(slot) {
  if (typeof slot === "number") return Number.isNaN(slot) ? Infinity : slot;
  if (isObj(slot) && slot.range != null) {
    const r = Number(slot.range);
    return Number.isNaN(r) ? Infinity : r;
  }
  return Infinity;
}

/** @param {*} slot @returns {*} the slot's kind (undefined for plain ranges) */
function slotKind(slot) {
  return isObj(slot) ? slot.kind : undefined;
}

/**
 * "<distance word> <kind>" or "clear" (the obstacle slot format of SPEC §2.14).
 * @param {number} range metres
 * @param {*} kind raw kind (normalised by kindWord; unknown → "obstacle")
 * @returns {string}
 */
export function obstacleText(range, kind) {
  const w = distanceWord(range);
  if (w === "clear") return "clear";
  return `${w} ${kindWord(kind)}`;
}

/**
 * Collapse whitespace, strip control characters, cut at `max` characters on a word boundary.
 * @param {*} s
 * @param {string} fallback used when `s` is not a non-empty string
 * @param {number} max
 * @returns {string}
 */
function cleanText(s, fallback, max) {
  if (typeof s !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
  }
  return t;
}

/** @param {*} s @returns {string} a short particle family word */
function familyWord(s) {
  if (typeof s !== "string") return "particles";
  const t = s.toLowerCase().replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24).trim();
  return t || "particles";
}

/**
 * Value at a dotted path of a pilot state (e.g. "obstacles.ahead").
 * @param {object} state
 * @param {string} path
 * @returns {*} undefined when absent
 */
export function stateWord(state, path) {
  let cur = state;
  for (const k of String(path).split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * True when every leaf of the state is a string (the state carries words only).
 * @param {*} state
 * @returns {boolean}
 */
export function isWordsOnly(state) {
  if (typeof state === "string") return true;
  if (!isObj(state)) return false;
  for (const v of Object.values(state)) if (!isWordsOnly(v)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the words-only pilot state from a SensorFrame (SPEC §2.14):
 * `{standing_order, shot:{technique, goal}, camera:{speed}, obstacles:{far_left, left, ahead,
 * right, far_right, above, below, left_side, right_side, behind}, free_space:{level_ahead,
 * above_ahead, below_ahead}, nearest:{kind, range, side}, path_ahead:{contact_in, blocker},
 * subject:{visibility, unseen_for, in_frame, size, occluded_by}, particles:{on_lens, in_view},
 * limits:{can_rise, can_sink, can_drift_left, can_drift_right, room_left, room_right, ceiling},
 * current:{maneuver, since}}`.
 *
 * Mapping:
 * - obstacles: sectors far_left/left/center→ahead/right/far_right; sides up→above, down→below,
 *   left→left_side, right→right_side, back→behind. Each "<distance word> <kind>" or "clear".
 * - nearest.side: "above"/"below" when the elevation word is overhead/underneath, else the
 *   bearing word; "none" (kind "none", range "clear") when nothing is within 40 m.
 * - path_ahead.blocker: "none" when contact_in is "none".
 * - subject: every field NO_SUBJECT when `sensorFrame.subject` is null (or opts.hasSubject is
 *   false). `unseen_for` is "brief" (not "not hidden") when the subject is already
 *   "fully hidden" but the unseen timer has not started. `occluded_by` is "nothing" while the
 *   visibility is "clear", else the occluder kind ("unknown" when not reported).
 * - limits: can_rise / can_sink "yes" only when `limits.canRise/canSink === true` AND the
 *   shot bounds still leave more than BOUND_SLACK_M (opts.bounds.maxRise/maxSink vs
 *   opts.current.vertical); can_drift_left / can_drift_right "yes" when the lateral bound on
 *   that side still leaves more than BOUND_SLACK_M (opts.bounds.maxLateral vs
 *   opts.current.lateral, + = right; no maxLateral → "yes"); room_left/right = the SENSED room
 *   only (limits.roomLeft/Right, fallback sides.left/right) as a room word, never capped by the
 *   shot bounds; ceiling = distance word ("clear" = none).
 *
 * @param {object|null} sensorFrame SPEC §3.1 SensorFrame (partial frames are tolerated)
 * @param {{standingOrder?:string, technique?:string, goal?:string,
 *   current?:{maneuver?:string, since?:number|string, lateral?:number, vertical?:number},
 *   bounds?:{maxLateral?:number, maxRise?:number, maxSink?:number}, hasSubject?:boolean}} [opts]
 * @returns {object} words-only state (every leaf a string)
 */
export function buildPilotState(sensorFrame, opts = {}) {
  const sf = isObj(sensorFrame) ? sensorFrame : {};
  const o = isObj(opts) ? opts : {};
  const sectors = isObj(sf.sectors) ? sf.sectors : {};
  const sides = isObj(sf.sides) ? sf.sides : {};
  const free = isObj(sf.freeAhead) ? sf.freeAhead : {};
  const nearest = isObj(sf.nearest) ? sf.nearest : {};
  const path = isObj(sf.pathAhead) ? sf.pathAhead : {};
  const limits = isObj(sf.limits) ? sf.limits : {};
  const parts = isObj(sf.particles) ? sf.particles : {};
  const cur = isObj(o.current) ? o.current : {};
  const bounds = isObj(o.bounds) ? o.bounds : {};

  const sec = (k) => obstacleText(slotRange(sectors[k]), slotKind(sectors[k]));
  const side = (k) => obstacleText(slotRange(sides[k]), slotKind(sides[k]));

  // nearest
  const nRange = distanceWord(slotRange(nearest));
  let nearestOut;
  if (nRange === "clear") {
    nearestOut = { kind: "none", range: "clear", side: "none" };
  } else {
    const ew = elevationWord(nearest.elevDeg);
    const sideWord = ew === "overhead" ? "above" : ew === "underneath" ? "below" : bearingWord(nearest.bearingDeg);
    nearestOut = { kind: kindWord(nearest.kind), range: nRange, side: sideWord };
  }

  // path ahead
  const contact = ttcWord(path.ttc);
  const pathOut = { contact_in: contact, blocker: contact === "none" ? "none" : kindWord(path.kind) };

  // subject
  const hasSubject = o.hasSubject === false ? false : isObj(sf.subject);
  let subjectOut;
  if (!hasSubject) {
    subjectOut = {
      visibility: NO_SUBJECT,
      unseen_for: NO_SUBJECT,
      in_frame: NO_SUBJECT,
      size: NO_SUBJECT,
      occluded_by: NO_SUBJECT,
    };
  } else {
    const s = sf.subject;
    const visibility = visibilityWord(s.visibleFrac);
    let unseen = unseenWord(s.unseenSec);
    if (visibility === "fully hidden" && unseen === "not hidden") unseen = "brief";
    subjectOut = {
      visibility,
      unseen_for: unseen,
      in_frame: offsetWord(Array.isArray(s.ndc) ? s.ndc : null),
      size: sizeWord(s.sizeRatio),
      occluded_by: visibility === "clear" ? "nothing" : kindWord(s.occluderKind, "unknown"),
    };
  }

  // particles
  let onLens = "none";
  if (isObj(parts.onLens)) onLens = `${densityWord(parts.onLens.density)} ${familyWord(parts.onLens.family)}`;
  let inView = "none";
  if (Array.isArray(parts.inView) && parts.inView.length) {
    const list = parts.inView
      .filter(isObj)
      .map((p, i) => ({ p, i, r: slotRange(p) }))
      .sort((a, b) => (b.p.occludes === true) - (a.p.occludes === true) || a.r - b.r || a.i - b.i);
    if (list.length) {
      const first = list[0].p;
      inView = `${distanceWord(list[0].r)} ${familyWord(first.family)}${first.occludes === true ? " blocking the view" : ""}`;
      if (list.length > 1) inView += ` (+${list.length - 1} more)`;
    }
  }

  // limits: the sensed room stays the sensed room; what is left of the shot's own bounds is
  // stated as yes/no per direction (vertical and lateral alike), so a technique whose
  // maxLateral is below the "some" room band can still drift up to its bound.
  const lat = Number.isFinite(cur.lateral) ? cur.lateral : 0;
  const vert = Number.isFinite(cur.vertical) ? cur.vertical : 0;
  const maxLat = Number.isFinite(bounds.maxLateral) && bounds.maxLateral >= 0 ? bounds.maxLateral : Infinity;
  const roomSrc = (key, sideKey) => {
    const v = limits[key];
    if (typeof v === "boolean") return v ? Infinity : 0;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    return slotRange(sides[sideKey]);
  };
  const leftBoundLeft = maxLat + lat; // lateral is + right
  const rightBoundLeft = maxLat - lat;
  const riseLeft = Number.isFinite(bounds.maxRise) ? bounds.maxRise - vert : Infinity;
  const sinkLeft = Number.isFinite(bounds.maxSink) ? bounds.maxSink + vert : Infinity;
  const limitsOut = {
    can_rise: yesNo(limits.canRise === true && riseLeft > BOUND_SLACK_M),
    can_sink: yesNo(limits.canSink === true && sinkLeft > BOUND_SLACK_M),
    can_drift_left: yesNo(leftBoundLeft > BOUND_SLACK_M),
    can_drift_right: yesNo(rightBoundLeft > BOUND_SLACK_M),
    room_left: roomWord(roomSrc("roomLeft", "left")),
    room_right: roomWord(roomSrc("roomRight", "right")),
    ceiling: distanceWord(limits.ceiling == null ? Infinity : limits.ceiling),
  };

  // current maneuver
  const maneuver = MANEUVERS.includes(cur.maneuver) ? cur.maneuver : "hold_path";
  const since = typeof cur.since === "string" && cur.since ? cleanText(cur.since, "just now", 24) : sinceWord(cur.since);

  return {
    standing_order: cleanText(o.standingOrder, DEFAULT_STANDING_ORDER, MAX_STANDING_ORDER_CHARS),
    shot: {
      technique: cleanText(o.technique, "unknown", 80),
      goal: cleanText(o.goal, "follow the planned path", 160),
    },
    camera: { speed: speedWord(sf.speedMps) },
    obstacles: {
      far_left: sec("far_left"),
      left: sec("left"),
      ahead: sec("center"),
      right: sec("right"),
      far_right: sec("far_right"),
      above: side("up"),
      below: side("down"),
      left_side: side("left"),
      right_side: side("right"),
      behind: side("back"),
    },
    free_space: {
      level_ahead: distanceWord(slotRange(free.level)),
      above_ahead: distanceWord(slotRange(free.above)),
      below_ahead: distanceWord(slotRange(free.below)),
    },
    nearest: nearestOut,
    path_ahead: pathOut,
    subject: subjectOut,
    particles: { on_lens: onLens, in_view: inView },
    limits: limitsOut,
    current: { maneuver, since },
  };
}
