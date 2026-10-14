// scene3d/film/pilot/questions.js — the JEV pilot's Decisions-API questions (SPEC §2.14).
//
// WHY: JEV (TypeSafe's System-One model, OpenRouter `POST /api/alpha/decisions`)
// answers typed questions about a words-only state. The JEV-plays-DOOM /
// jev-drone prior art showed what makes it reliable: one judgment per question,
// several independent questions per request, criteria written like specs with
// explicit boundaries that quote the state's exact words, and the conservative
// default option FIRST (JEV has a first-option bias). Question ids are NOT sent
// to the model, so every meaning lives in the instructions/criteria text.
//
// Text/code agreement: every boundary in the criteria is generated from
// `WORD_BOUNDS` (sense_words.js) and `PILOT_RULES` (below). policy_code.js
// evaluates the SAME `PILOT_RULES` against the SAME words, so the criteria JEV
// reads and the deterministic code policy (no-key fallback, test mock and the
// shadow-agreement baseline) cannot drift apart.
//
// Also here: `buildDecisionRequest` (the exact request body) and
// `parseDecisionAnswers` (answer-shape validation; probability keys looked up
// by name because the API returns them in arbitrary order).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks, no network (the key lives in Node: tools/film/lib/jev.mjs).

import { FilmError } from "../core/errors.js";
import { OCCLUDER_CLASSES, bandText, quoteBand, rankOf, scaleWords, wordsFrom, wordsUpTo } from "./sense_words.js";

/** The pinned JEV model id (thresholds were tuned against this snapshot). */
export const JEV_PILOT_MODEL = "typesafe/jev-1.13";

/** Error code thrown by parseDecisionAnswers / buildDecisionRequest. */
export const BAD_ANSWER_CODE = "JEV_BAD_ANSWER";

/** `maneuver` options, conservative default first (SPEC §2.14). */
export const MANEUVERS = Object.freeze(["hold_path", "drift_left", "drift_right", "rise", "sink", "slow_down", "back_off"]);
/** `occluder_action` options, conservative default first. */
export const OCCLUDER_ACTIONS = Object.freeze(["ignore", "fade", "reroute", "wait"]);
/** `framing` options, conservative default first. */
export const FRAMING_ACTIONS = Object.freeze(["keep", "recenter", "widen", "tighten"]);
/** `risk` score levels, low → high. */
export const RISK_LEVELS = Object.freeze(["open", "tight but manageable", "about to hit"]);

/**
 * Recursively freezes a plain object/array tree.
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * The decision rules, as data. questions.js renders them into criteria text and
 * policy_code.js evaluates them; both use only these words and WORD_BOUNDS.
 *
 * - `touching`: `nearest.range` word that means contact → back_off (unless behind is too close).
 * - `blockedWithin`: `obstacles.left/ahead/right` or `free_space.level_ahead` at or nearer than
 *   this distance word → BLOCKED. `blockingContact`: `path_ahead.contact_in` words → BLOCKED.
 * - `verticalSteps`: free space above/below ahead must be at least this many distance steps
 *   farther than `free_space.level_ahead` for rise/sink (with `limits.can_rise/can_sink` "yes").
 * - `driftSideFrom`: `obstacles.left/right` must be this far or farther to drift there;
 *   `driftRoomFrom`: `limits.room_left/right` (the SENSED free space beside the camera) must be
 *   at least this room word; a drift also needs `limits.can_drift_left/right` "yes" (the shot's
 *   lateral bound on that side is not used up — the same yes/no gate as `can_rise`/`can_sink`).
 * - `imminentContact`: contact word that demands back_off when no escape exists.
 * - `behindTooCloseWithin`: `obstacles.behind` at or nearer → never back_off (slow_down instead).
 * - risk: `riskHigh` / `riskTight` contact + nearest words (score 2 / 1; else 0).
 * - `lostUnseen`: `subject.unseen_for` words that mean the subject is lost.
 * - occluder: `ignoreVisibility` / `ignoreUnseen` / `ignoreOccluders` → ignore; otherwise the
 *   occluder class (OCCLUDER_CLASSES soft → fade, solid → reroute, moving → wait).
 * - framing: `framingUnjudgeable` visibility → keep; `recenterOffsets` (prefixes of
 *   `subject.in_frame`) → recenter; `widenSizes` → widen; `tightenSizes` → tighten; else keep.
 */
export const PILOT_RULES = deepFreeze({
  touching: "touching",
  blockedWithin: "close",
  blockingContact: ["imminent", "soon"],
  verticalSteps: 2,
  driftSideFrom: "near",
  driftRoomFrom: "some",
  imminentContact: "imminent",
  behindTooCloseWithin: "very close",
  riskHigh: { contact: ["imminent"], nearest: ["touching"] },
  riskTight: { contact: ["soon"], nearest: ["very close"] },
  lostUnseen: ["long"],
  ignoreVisibility: ["clear", "partly hidden"],
  ignoreUnseen: ["brief"],
  ignoreOccluders: ["nothing", "unknown"],
  framingUnjudgeable: ["fully hidden"],
  recenterOffsets: ["near the edge", "out of frame"],
  widenSizes: ["too large", "much too large"],
  tightenSizes: ["too small", "much too small"],
});

// ---------------------------------------------------------------------------
// Text helpers (all boundaries generated from WORD_BOUNDS)
// ---------------------------------------------------------------------------

/** @param {string} w @returns {string} the word in double quotes */
const q = (w) => `"${w}"`;

/**
 * Quoted word list joined with commas and a final conjunction.
 * @param {string[]} words
 * @param {string} [conj="or"]
 * @returns {string}
 */
function list(words, conj = "or") {
  const qs = words.map(q);
  if (qs.length <= 1) return qs.join("");
  return `${qs.slice(0, -1).join(", ")} ${conj} ${qs[qs.length - 1]}`;
}

/**
 * Quoted words each followed by its boundary, e.g. `"close" (2–4 m)`.
 * @param {string} scale
 * @param {string[]} words
 * @param {string} [conj="or"]
 * @returns {string}
 */
function bandList(scale, words, conj = "or") {
  const qs = words.map((w) => quoteBand(scale, w));
  if (qs.length <= 1) return qs.join("");
  return `${qs.slice(0, -1).join(", ")} ${conj} ${qs[qs.length - 1]}`;
}

/** @param {string} scale @returns {string} `"a" (…) < "b" (…) < …` ladder of a whole scale */
function ladder(scale) {
  return scaleWords(scale)
    .map((w) => quoteBand(scale, w))
    .join(" < ");
}

const R = PILOT_RULES;
const CLOSE = wordsUpTo("distance", R.blockedWithin); // touching, very close, close
const FAR_ENOUGH = wordsFrom("distance", R.driftSideFrom); // near … clear
const ROOM_OK = wordsFrom("room", R.driftRoomFrom); // some, plenty
const ROOM_NO = scaleWords("room").filter((w) => !ROOM_OK.includes(w)); // none, little
const BEHIND_TOO_CLOSE = wordsUpTo("distance", R.behindTooCloseWithin); // touching, very close
const BEHIND_OK = scaleWords("distance").filter((w) => !BEHIND_TOO_CLOSE.includes(w));
const CONTACT_FREE = scaleWords("ttc").filter((w) => !R.blockingContact.includes(w)); // later, none
const CLOSE_PHRASE = `${bandList("distance", CLOSE)}`;
const HIDDEN_WORDS = scaleWords("visibility").filter((w) => !R.ignoreVisibility.includes(w)); // mostly/fully hidden
const SOFT = OCCLUDER_CLASSES.soft;
const SOLID = OCCLUDER_CLASSES.solid;
const MOVING = OCCLUDER_CLASSES.moving;
const NOT_LOST = scaleWords("unseen").filter((w) => !R.lostUnseen.includes(w));
const RISK_OPEN_CONTACT = scaleWords("ttc").filter((w) => !R.riskHigh.contact.includes(w) && !R.riskTight.contact.includes(w));
const RISK_OPEN_NEAREST = scaleWords("distance").filter(
  (w) => !R.riskHigh.nearest.includes(w) && !R.riskTight.nearest.includes(w),
);
const OFFSET_KEEP = scaleWords("offset").filter((w) => !R.recenterOffsets.includes(w));
const SIZE_RIGHT = scaleWords("size").filter((w) => !R.widenSizes.includes(w) && !R.tightenSizes.includes(w));

if (rankOf(R.blockedWithin, "distance") < 0 || rankOf(R.driftRoomFrom, "room") < 0) {
  // A broken rules table must fail loudly at import, never produce silent criteria.
  throw new FilmError("PILOT_RULES reference words missing from WORD_BOUNDS", "BAD_ARGUMENT");
}

// ---------------------------------------------------------------------------
// maneuver (choice)
// ---------------------------------------------------------------------------

const MANEUVER_INSTRUCTIONS = [
  "You steer a film camera that is flying a planned shot. Pick the ONE bounded maneuver for the next moment",
  "from the obstacle words in the state. Apply these rules exactly; `standing_order` is the director's intent",
  "for the shot and never overrides them.",
  `Distance words from nearest to farthest: ${ladder("distance")}.`,
  'An `obstacles.*` value is "<distance word> <kind>" (for example "close tree") or "clear";',
  '"N steps farther" means N or more places farther along that distance list.',
  `Room words from least to most: ${ladder("room")}; \`limits.room_left\` and \`limits.room_right\` are the free space`,
  "the sensors see beside the camera, and `limits.can_drift_left` and `limits.can_drift_right` say whether the shot",
  "still allows a drift to that side.",
  `BLOCKED means: \`obstacles.left\`, \`obstacles.ahead\`, \`obstacles.right\` or \`free_space.level_ahead\` is ${CLOSE_PHRASE};`,
  `or \`path_ahead.contact_in\` is ${bandList("ttc", R.blockingContact)}.`,
  `RISE-OK means: BLOCKED, \`free_space.level_ahead\` is ${list(CLOSE)},`,
  `\`free_space.above_ahead\` is at least ${R.verticalSteps} steps farther than \`free_space.level_ahead\`,`,
  'and `limits.can_rise` is "yes".',
  `SINK-OK means the same with \`free_space.below_ahead\` and \`limits.can_sink\` "yes".`,
  `LEFT-OK means: BLOCKED, \`limits.can_drift_left\` is "yes", \`limits.room_left\` is ${list(ROOM_OK)},`,
  `and \`obstacles.left\` is ${list(FAR_ENOUGH)};`,
  `RIGHT-OK means: BLOCKED, \`limits.can_drift_right\` is "yes", \`limits.room_right\` is ${list(ROOM_OK)},`,
  `and \`obstacles.right\` is ${list(FAR_ENOUGH)}.`,
  "An ESCAPE exists when RISE-OK, SINK-OK, LEFT-OK or RIGHT-OK holds.",
  `BACK-OFF-NEEDED means: \`nearest.range\` is ${quoteBand("distance", R.touching)},`,
  `or \`path_ahead.contact_in\` is ${quoteBand("ttc", R.imminentContact)} and no ESCAPE exists.`,
].join(" ");

const MANEUVER_CRITERIA = {
  hold_path:
    "Default: keep flying the planned path. Correct when the path is not BLOCKED — " +
    `\`obstacles.left\`, \`obstacles.ahead\`, \`obstacles.right\` and \`free_space.level_ahead\` are all ${list(FAR_ENOUGH)}, ` +
    `and \`path_ahead.contact_in\` is ${bandList("ttc", CONTACT_FREE)} — and \`nearest.range\` is not ${q(R.touching)}. ` +
    "Obstacles only in `obstacles.far_left`, `obstacles.far_right`, `obstacles.above`, `obstacles.below`, " +
    "`obstacles.left_side`, `obstacles.right_side` or `obstacles.behind` never block (a corridor wall beside the camera is normal). " +
    `Not when BLOCKED, and not when \`nearest.range\` is ${q(R.touching)}.`,
  drift_left:
    "Slide left around the obstacle. Correct when BLOCKED, BACK-OFF-NEEDED does not hold, RISE-OK and SINK-OK do not hold, " +
    "and LEFT-OK holds; if RIGHT-OK also holds, the left must be roomier: `limits.room_left` is more than `limits.room_right`, " +
    "or they are equal and `obstacles.left` is farther than `obstacles.right`, " +
    "or both are equal and `obstacles.far_left` is at least as far as `obstacles.far_right` (a full tie goes left). " +
    `Not when \`obstacles.left\` is ${list(CLOSE)}, \`limits.room_left\` is ${list(ROOM_NO)} ` +
    'or `limits.can_drift_left` is "no".',
  drift_right:
    "Slide right around the obstacle. Correct when BLOCKED, BACK-OFF-NEEDED does not hold, RISE-OK and SINK-OK do not hold, " +
    "and RIGHT-OK holds; if LEFT-OK also holds, the right must be roomier: `limits.room_right` is more than `limits.room_left`, " +
    "or they are equal and `obstacles.right` is farther than `obstacles.left`, " +
    "or both are equal and `obstacles.far_right` is farther than `obstacles.far_left`. " +
    `Not when \`obstacles.right\` is ${list(CLOSE)}, \`limits.room_right\` is ${list(ROOM_NO)} ` +
    'or `limits.can_drift_right` is "no", and not on a full tie (that goes left).',
  rise:
    "Climb over the obstacle (a low wall, rock or fence). Correct when RISE-OK holds and BACK-OFF-NEEDED does not: " +
    `the way ahead is blocked at camera height (\`free_space.level_ahead\` is ${list(CLOSE)}), ` +
    `\`free_space.above_ahead\` is at least ${R.verticalSteps} steps farther, and \`limits.can_rise\` is "yes". ` +
    "Preferred over sink and the drifts when it holds. " +
    `Not when \`limits.can_rise\` is "no", and not when the air above is fewer than ${R.verticalSteps} steps farther ` +
    "(for example tree crowns that also block above).",
  sink:
    "Drop under the obstacle (an overhang, branch or arch). Correct when SINK-OK holds, RISE-OK does not, " +
    `and BACK-OFF-NEEDED does not: \`free_space.level_ahead\` is ${list(CLOSE)}, ` +
    `\`free_space.below_ahead\` is at least ${R.verticalSteps} steps farther, and \`limits.can_sink\` is "yes". ` +
    'Not when `limits.can_sink` is "no", and not when RISE-OK also holds (rise wins).',
  slow_down:
    "Ease off the planned speed and let the way clear. Correct when BLOCKED, no ESCAPE exists and BACK-OFF-NEEDED " +
    `does not hold — boxed in with time to spare: \`nearest.range\` is not ${q(R.touching)} and ` +
    `\`path_ahead.contact_in\` is not ${q(R.imminentContact)}; ` +
    `also whenever BACK-OFF-NEEDED holds but \`obstacles.behind\` is ${list(BEHIND_TOO_CLOSE)} (no room to retreat). ` +
    "Not when an ESCAPE exists and BACK-OFF-NEEDED does not hold.",
  back_off:
    `Retreat away from the obstacle. Correct when BACK-OFF-NEEDED holds — \`nearest.range\` is ${quoteBand("distance", R.touching)}, ` +
    `or \`path_ahead.contact_in\` is ${quoteBand("ttc", R.imminentContact)} with no ESCAPE — ` +
    `and \`obstacles.behind\` is ${list(BEHIND_OK)}. ` +
    `Not when \`obstacles.behind\` is ${list(BEHIND_TOO_CLOSE)} (then slow_down), ` +
    `and not for an ${q(R.imminentContact)} contact that an ESCAPE avoids.`,
};

// ---------------------------------------------------------------------------
// risk (score, 3 levels)
// ---------------------------------------------------------------------------

const RISK_INSTRUCTIONS =
  "Rate how close the film camera is to hitting something, judging only `path_ahead.contact_in` " +
  "(time to contact along the planned path) and `nearest.range` (the nearest obstacle in any direction).";

const RISK_CRITERIA = [
  `open: \`path_ahead.contact_in\` is ${bandList("ttc", RISK_OPEN_CONTACT)}, and \`nearest.range\` is ${list(RISK_OPEN_NEAREST)}. ` +
    "Not when either value is nearer than that.",
  `tight but manageable: \`path_ahead.contact_in\` is ${bandList("ttc", R.riskTight.contact)} ` +
    `or \`nearest.range\` is ${bandList("distance", R.riskTight.nearest)}, ` +
    `and neither ${list([...R.riskHigh.contact, ...R.riskHigh.nearest], "nor")} appears (typical in dungeon corridors).`,
  `about to hit: \`path_ahead.contact_in\` is ${bandList("ttc", R.riskHigh.contact)} ` +
    `or \`nearest.range\` is ${bandList("distance", R.riskHigh.nearest)}.`,
];

// ---------------------------------------------------------------------------
// subject_lost (noul)
// ---------------------------------------------------------------------------

const LOST_INSTRUCTIONS =
  "Is the shot's subject truly lost, rather than briefly occluded? Judge only `subject.unseen_for` " +
  "(how long the subject has been fully hidden).";

const LOST_CRITERIA = {
  true:
    `Lost: \`subject.unseen_for\` is ${bandList("unseen", R.lostUnseen)}. ` +
    "The camera must widen or change its approach to find the subject again.",
  false:
    `Not lost: \`subject.unseen_for\` is ${bandList("unseen", NOT_LOST)} — for example a tree trunk or a passing ` +
    "creature crossing the line of sight. A partly or mostly hidden subject is never lost.",
};

// ---------------------------------------------------------------------------
// occluder_action (choice)
// ---------------------------------------------------------------------------

const OCCLUDER_INSTRUCTIONS =
  "Decide what to do about whatever stands between the camera and the subject, judging " +
  "`subject.visibility`, `subject.unseen_for` and `subject.occluded_by`. " +
  `Occluder kinds: soft = ${list(SOFT)} (foliage, small props, smoke or fire clouds: the film runtime fades ` +
  "placed props and placed trees of known size, entities and particle smoke; procedural (terrain) trees and rocks " +
  "are rerouted around, as are a big prop (only a small one such as a barrel or a crate fades) and placements too " +
  "close together to tell apart; the runtime makes that reroute by itself, so the fade rule below still applies " +
  "to every soft kind); " +
  `solid = ${list(SOLID)} (structure that cannot be faded); moving = ${list(MOVING)} (they pass by themselves). ` +
  `HIDDEN means: \`subject.visibility\` is ${bandList("visibility", HIDDEN_WORDS)}, ` +
  `and \`subject.unseen_for\` is not ${list(R.ignoreUnseen)}.`;

const OCCLUDER_CRITERIA = {
  ignore:
    `Default: leave it. Correct when \`subject.visibility\` is ${bandList("visibility", R.ignoreVisibility)} ` +
    "— thin branches or a sliver of wall —, " +
    `or \`subject.unseen_for\` is ${bandList("unseen", R.ignoreUnseen)} — a passing trunk —, ` +
    `or \`subject.occluded_by\` is ${list(R.ignoreOccluders)}. ` +
    "Not when the subject is HIDDEN by a known soft, solid or moving kind.",
  fade:
    `Fade the occluder out of the shot. Correct when HIDDEN and \`subject.occluded_by\` is soft: ${list(SOFT)}. ` +
    "Not for solid or moving kinds, and not when the subject is only partly hidden.",
  reroute:
    `Move the camera to regain the line of sight. Correct when HIDDEN and \`subject.occluded_by\` is solid: ${list(SOLID)}. ` +
    "Not for soft kinds (fade) or moving kinds (wait).",
  wait:
    `Hold the line and let the occluder pass. Correct when HIDDEN and \`subject.occluded_by\` is moving: ${list(MOVING)}. ` +
    "Not for static kinds.",
};

// ---------------------------------------------------------------------------
// framing (choice)
// ---------------------------------------------------------------------------

const FRAMING_INSTRUCTIONS =
  "Judge the subject's framing from `subject.in_frame` (where it sits in the frame), `subject.size` " +
  "(its size against the intended framing) and `subject.visibility`. " +
  `\`subject.in_frame\` is one of ${list(scaleWords("offset"))}, followed by a direction in brackets ` +
  'such as "(left)" or "(up-right)" unless centred.';

const FRAMING_CRITERIA = {
  keep:
    `Default: keep the framing. Correct when \`subject.in_frame\` starts with ${list(OFFSET_KEEP)} ` +
    `(off-centre is deliberate thirds placement) and \`subject.size\` is ${bandList("size", SIZE_RIGHT)}; ` +
    `also whenever \`subject.visibility\` is ${bandList("visibility", R.framingUnjudgeable)}, because framing cannot be judged then. ` +
    `Not when the subject is ${list(R.recenterOffsets)} or its size is wrong while it is visible.`,
  recenter:
    `Turn to bring the subject back into place. Correct when \`subject.in_frame\` starts with ${list(R.recenterOffsets)} ` +
    `(${R.recenterOffsets.map((w) => `${q(w)} = ${bandText("offset", w)}`).join("; ")}) ` +
    `and \`subject.visibility\` is not ${list(R.framingUnjudgeable)}. Takes priority over size. ` +
    `Not when the subject is only ${list(OFFSET_KEEP.filter((w) => w !== "centred"))} or centred.`,
  widen:
    `Pull back to widen the shot. Correct when \`subject.size\` is ${bandList("size", R.widenSizes)}, ` +
    `\`subject.in_frame\` does not start with ${list(R.recenterOffsets)}, ` +
    `and \`subject.visibility\` is not ${list(R.framingUnjudgeable)}. Not when the size is ${list(SIZE_RIGHT)} or too small.`,
  tighten:
    `Push in to tighten the shot. Correct when \`subject.size\` is ${bandList("size", R.tightenSizes)}, ` +
    `\`subject.in_frame\` does not start with ${list(R.recenterOffsets)}, ` +
    `and \`subject.visibility\` is not ${list(R.framingUnjudgeable)}. Not when the size is ${list(SIZE_RIGHT)} or too large.`,
};

/**
 * The full Decisions-API `questions` object of the pilot (deep-frozen). Ids:
 * `maneuver` (choice, MANEUVERS order), `risk` (score, 3 levels low → high),
 * `subject_lost` (noul with explicit true/false criteria), `occluder_action` (choice,
 * OCCLUDER_ACTIONS order), `framing` (choice, FRAMING_ACTIONS order).
 * @type {Readonly<Record<string, {type:string, instructions:string, criteria:object}>>}
 */
export const PILOT_QUESTIONS = deepFreeze({
  maneuver: {
    type: "choice",
    instructions: MANEUVER_INSTRUCTIONS,
    criteria: Object.fromEntries(MANEUVERS.map((k) => [k, MANEUVER_CRITERIA[k]])),
  },
  risk: { type: "score", instructions: RISK_INSTRUCTIONS, criteria: RISK_CRITERIA },
  subject_lost: { type: "noul", instructions: LOST_INSTRUCTIONS, criteria: LOST_CRITERIA },
  occluder_action: {
    type: "choice",
    instructions: OCCLUDER_INSTRUCTIONS,
    criteria: Object.fromEntries(OCCLUDER_ACTIONS.map((k) => [k, OCCLUDER_CRITERIA[k]])),
  },
  framing: {
    type: "choice",
    instructions: FRAMING_INSTRUCTIONS,
    criteria: Object.fromEntries(FRAMING_ACTIONS.map((k) => [k, FRAMING_CRITERIA[k]])),
  },
});

/** Question ids that only make sense when the shot has a subject. */
export const SUBJECT_QUESTION_IDS = Object.freeze(["subject_lost", "occluder_action", "framing"]);

/**
 * The questions to ask for one consult: always `maneuver` and `risk`; `subject_lost` and
 * `occluder_action` only with a subject; `framing` only with a subject and `framing !== false`.
 * Returns a new top-level object that references the frozen question objects.
 * @param {{hasSubject?:boolean, framing?:boolean}} [opts]
 * @returns {Record<string, object>}
 */
export function questionsFor(opts = {}) {
  const hasSubject = opts?.hasSubject !== false;
  const framing = opts?.framing !== false;
  const out = { maneuver: PILOT_QUESTIONS.maneuver, risk: PILOT_QUESTIONS.risk };
  if (hasSubject) {
    out.subject_lost = PILOT_QUESTIONS.subject_lost;
    out.occluder_action = PILOT_QUESTIONS.occluder_action;
    if (framing) out.framing = PILOT_QUESTIONS.framing;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request / answer helpers
// ---------------------------------------------------------------------------

/** @param {*} v @returns {boolean} */
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {string} msg @param {*} [details] @returns {FilmError} */
function bad(msg, details) {
  return new FilmError(msg, details === undefined ? { code: BAD_ANSWER_CODE } : { code: BAD_ANSWER_CODE, details });
}

/**
 * Plain copy of one question with only the contract fields (type, instructions, criteria).
 * @param {string} id
 * @param {*} qn
 * @returns {object}
 */
function copyQuestion(id, qn) {
  if (!isObj(qn) || typeof qn.instructions !== "string" || !qn.instructions.trim()) {
    throw bad(`question '${id}' needs a non-empty instructions string`);
  }
  if (qn.type === "choice") {
    if (!isObj(qn.criteria) || Object.keys(qn.criteria).length < 2) throw bad(`choice '${id}' needs ≥ 2 options`);
    return { type: "choice", instructions: qn.instructions, criteria: { ...qn.criteria } };
  }
  if (qn.type === "score") {
    if (!Array.isArray(qn.criteria) || qn.criteria.length < 2 || qn.criteria.length > 10) {
      throw bad(`score '${id}' needs 2–10 levels`);
    }
    return { type: "score", instructions: qn.instructions, criteria: [...qn.criteria] };
  }
  if (qn.type === "noul") {
    const out = { type: "noul", instructions: qn.instructions };
    if (qn.criteria != null) {
      if (!isObj(qn.criteria) || typeof qn.criteria.true !== "string" || typeof qn.criteria.false !== "string") {
        throw bad(`noul '${id}' criteria need both 'true' and 'false' texts`);
      }
      out.criteria = { true: qn.criteria.true, false: qn.criteria.false };
    }
    return out;
  }
  throw bad(`question '${id}' has unknown type ${JSON.stringify(qn.type)}`);
}

/**
 * The exact Decisions-API request body `{model, state, questions}`
 * (`POST https://openrouter.ai/api/alpha/decisions`; the key is added by the Node client).
 * Questions are copied down to their contract fields so stray fields never reach the API.
 * @param {object|string} state the words-only pilot state (buildPilotState)
 * @param {Record<string, object>} questions e.g. questionsFor({hasSubject})
 * @param {{model?:string}} [opts] model defaults to JEV_PILOT_MODEL ("typesafe/jev-1.13")
 * @returns {{model:string, state:object|string, questions:Record<string, object>}}
 * @throws {FilmError} code JEV_BAD_ANSWER for a missing state or malformed questions
 */
export function buildDecisionRequest(state, questions, opts = {}) {
  const model = typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : JEV_PILOT_MODEL;
  if (state == null || (typeof state !== "object" && typeof state !== "string")) {
    throw bad("decision request needs a state object or string");
  }
  if (!isObj(questions) || Object.keys(questions).length === 0) throw bad("decision request needs at least one question");
  const qs = {};
  for (const [id, qn] of Object.entries(questions)) qs[id] = copyQuestion(id, qn);
  return { model, state, questions: qs };
}

/** @param {*} x @returns {number|null} x clamped to [0, 1], or null when not a finite number */
function unit(x) {
  if (x == null || x === "") return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Probabilities looked up BY NAME (the API's key order is arbitrary), rebuilt in `keys` order
 * when keys are known, normalised to sum 1; null when absent or all zero.
 * @param {string} id
 * @param {*} p
 * @param {string[]|null} keys
 * @returns {Record<string, number>|null}
 */
function probs(id, p, keys) {
  if (p == null) return null;
  if (!isObj(p)) throw bad(`answer '${id}': probabilities must be an object`);
  const names = keys ?? Object.keys(p);
  const out = {};
  let sum = 0;
  for (const k of names) {
    const raw = Object.prototype.hasOwnProperty.call(p, k) ? p[k] : 0;
    const n = raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0) throw bad(`answer '${id}': probability for '${k}' is not a non-negative number`);
    out[k] = n;
    sum += n;
  }
  if (!(sum > 0)) return null;
  for (const k of names) out[k] /= sum;
  return out;
}

/**
 * Validate and normalise a Decisions-API answers map.
 *
 * Accepts the response body (`{answers:{…}}`), the bare answers map, or a JSON string of
 * either. Shapes: noul `{type, noul}` (P(yes) in [0, 1]); choice `{type, choice, confidence?,
 * probabilities?}`; score `{type, score, confidence?, probabilities?}` (score = expectation over
 * 0..n−1; probabilities keyed "0".."n−1"). Probability keys are looked up by NAME in any order.
 * With `questions`: every asked id must be answered, `type` (when present) must match, a choice
 * must be one of the options, a score must lie in 0..n−1; answers to unasked ids are ignored.
 * Without `questions`: every entry is validated by its own `type`.
 * `confidence`: the answer's value clamped to [0, 1], else P(choice) / P(round(score)) from the
 * probabilities, else null (callers treat null as fully confident).
 * @param {*} raw
 * @param {Record<string, object>} [questions]
 * @returns {Record<string, {type:string, choice?:string, score?:number, noul?:number,
 *   confidence?:number|null, probabilities?:Record<string,number>|null}>}
 * @throws {FilmError} code JEV_BAD_ANSWER with a readable message
 */
export function parseDecisionAnswers(raw, questions) {
  let src = raw;
  if (typeof src === "string") {
    try {
      src = JSON.parse(src);
    } catch {
      throw bad("answers are not valid JSON");
    }
  }
  if (isObj(src) && isObj(src.answers)) src = src.answers;
  if (!isObj(src)) throw bad("answers must be an object {id: answer}");
  const asked = isObj(questions) ? questions : null;
  const ids = asked ? Object.keys(asked) : Object.keys(src);
  if (ids.length === 0) throw bad("no answers");
  const out = {};
  for (const id of ids) {
    const a = src[id];
    if (!isObj(a)) throw bad(`answer '${id}' is missing`);
    const qn = asked ? asked[id] : null;
    if (qn && a.type != null && a.type !== qn.type) {
      throw bad(`answer '${id}' has type ${JSON.stringify(a.type)} but the question is '${qn.type}'`);
    }
    const type = qn ? qn.type : a.type;
    if (type === "choice") {
      const keys = qn && isObj(qn.criteria) ? Object.keys(qn.criteria) : null;
      if (typeof a.choice !== "string" || !a.choice || (keys && !keys.includes(a.choice))) {
        throw bad(`answer '${id}': choice ${JSON.stringify(a.choice)} is not one of the asked options`);
      }
      const p = probs(id, a.probabilities, keys);
      let confidence = unit(a.confidence);
      if (confidence == null && p && Object.prototype.hasOwnProperty.call(p, a.choice)) confidence = p[a.choice];
      out[id] = { type: "choice", choice: a.choice, confidence, probabilities: p };
    } else if (type === "score") {
      const n = qn && Array.isArray(qn.criteria) ? qn.criteria.length : null;
      const s = a.score == null || a.score === "" ? NaN : Number(a.score);
      if (!Number.isFinite(s) || s < -1e-6 || (n != null && s > n - 1 + 1e-6)) {
        throw bad(`answer '${id}': score ${JSON.stringify(a.score)} is outside ${n != null ? `0..${n - 1}` : "0.."}`);
      }
      const score = Math.max(0, n != null ? Math.min(n - 1, s) : s);
      const keys = n != null ? Array.from({ length: n }, (_, i) => String(i)) : null;
      const p = probs(id, a.probabilities, keys);
      let confidence = unit(a.confidence);
      const k = String(Math.round(score));
      if (confidence == null && p && Object.prototype.hasOwnProperty.call(p, k)) confidence = p[k];
      out[id] = { type: "score", score, confidence, probabilities: p };
    } else if (type === "noul") {
      const v = a.noul == null || a.noul === "" ? NaN : Number(a.noul);
      if (!Number.isFinite(v) || v < -1e-6 || v > 1 + 1e-6) {
        throw bad(`answer '${id}': noul ${JSON.stringify(a.noul)} is not a probability in [0, 1]`);
      }
      out[id] = { type: "noul", noul: Math.min(1, Math.max(0, v)) };
    } else {
      throw bad(`answer '${id}' has unknown type ${JSON.stringify(type)}`);
    }
  }
  return out;
}
