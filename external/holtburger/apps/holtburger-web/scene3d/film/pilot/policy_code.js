// scene3d/film/pilot/policy_code.js — deterministic code policy for the JEV pilot (SPEC §2.14).
//
// WHY: the film pilot must fly with or without JEV. This module answers the
// SAME questions (questions.js) with the SAME rules (PILOT_RULES + WORD_BOUNDS)
// that the criteria text describes, in the exact Decisions-API answer shape:
//   - the no-key / no-bridge / bridge-error fallback (the pilot keeps flying),
//   - the deterministic mock for tests and stepped rehearsals,
//   - the shadow-mode baseline: JEV's answers are compared with these to log an
//     agreement metric (a drop in agreement flags drifting criteria or a model
//     snapshot change).
// It reads ONLY the words of the pilot state, never raw sensor numbers, so it
// sees exactly what JEV sees.
//
// Answer distribution (documented choice): answers are HARD — the chosen option
// has probability 1 and confidence 1, every other option 0; scores are integer
// levels; noul is exactly 0 or 1. Code is certain about its own rules; the
// mapper's low-confidence path is reserved for JEV.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic.

import { FRAMING_ACTIONS, MANEUVERS, OCCLUDER_ACTIONS, PILOT_RULES, RISK_LEVELS, questionsFor } from "./questions.js";
import { NO_SUBJECT, buildPilotState, stateWord } from "./scene_state.js";
import { leadingWord, occluderClass, rankOf, scaleWords } from "./sense_words.js";

const R = PILOT_RULES;
const D_MAX = scaleWords("distance").length - 1; // rank of "clear"
const CLOSE_R = rankOf(R.blockedWithin, "distance");
const SIDE_R = rankOf(R.driftSideFrom, "distance");
const ROOM_R = rankOf(R.driftRoomFrom, "room");
const BEHIND_R = rankOf(R.behindTooCloseWithin, "distance");

/**
 * Distance rank of the word (or "<word> <kind>" text) at a state path. Unknown / missing
 * words rank as "clear" — the policy never acts on a word it cannot read (the code safety
 * reflex owns collisions).
 * @param {object} state
 * @param {string} path
 * @returns {number}
 */
function rd(state, path) {
  const r = rankOf(stateWord(state, path), "distance");
  return r < 0 ? D_MAX : r;
}

/**
 * Room rank at a state path (unknown → "none").
 * @param {object} state
 * @param {string} path
 * @returns {number}
 */
function rr(state, path) {
  const r = rankOf(stateWord(state, path), "room");
  return r < 0 ? 0 : r;
}

/**
 * The maneuver rule, evaluated on the state words exactly as the `maneuver` criteria state it.
 * Precedence: BACK-OFF-NEEDED (back_off, or slow_down when `obstacles.behind` is too close) →
 * not BLOCKED (hold_path) → RISE-OK (rise) → SINK-OK (sink) → LEFT-OK/RIGHT-OK (drift toward
 * the roomier side: sensed room words, then `obstacles.left/right`, then
 * `obstacles.far_left/far_right`, a full tie goes left) → slow_down (boxed in).
 * LEFT-OK / RIGHT-OK need `limits.can_drift_left/right` "yes" (the shot's lateral bound on that
 * side is not spent — the same yes/no gate as `can_rise`/`can_sink`), sensed
 * `limits.room_left/right` ≥ PILOT_RULES.driftRoomFrom and `obstacles.left/right` ≥ driftSideFrom.
 * @param {object} state a buildPilotState() result
 * @returns {{choice:string, rule:string, uses:string[]}} `uses` = the state paths whose words
 *   POSITIVELY matched the deciding rule (negated conditions are not listed); the criteria
 *   text names each of them and quotes its word
 */
export function decideManeuver(state) {
  const st = state && typeof state === "object" ? state : {};
  const touching = stateWord(st, "nearest.range") === R.touching;
  const contact = stateWord(st, "path_ahead.contact_in");
  const behindClose = rd(st, "obstacles.behind") <= BEHIND_R;
  const level = rd(st, "free_space.level_ahead");
  const blocked =
    rd(st, "obstacles.left") <= CLOSE_R ||
    rd(st, "obstacles.ahead") <= CLOSE_R ||
    rd(st, "obstacles.right") <= CLOSE_R ||
    level <= CLOSE_R ||
    R.blockingContact.includes(contact);
  const levelClose = level <= CLOSE_R;
  const riseOK =
    blocked && levelClose && rd(st, "free_space.above_ahead") >= level + R.verticalSteps && stateWord(st, "limits.can_rise") === "yes";
  const sinkOK =
    blocked && levelClose && rd(st, "free_space.below_ahead") >= level + R.verticalSteps && stateWord(st, "limits.can_sink") === "yes";
  const blockers = [
    ...["obstacles.left", "obstacles.ahead", "obstacles.right", "free_space.level_ahead"].filter((p) => rd(st, p) <= CLOSE_R),
    ...(R.blockingContact.includes(contact) ? ["path_ahead.contact_in"] : []),
  ];
  const leftOK =
    blocked &&
    stateWord(st, "limits.can_drift_left") === "yes" &&
    rr(st, "limits.room_left") >= ROOM_R &&
    rd(st, "obstacles.left") >= SIDE_R;
  const rightOK =
    blocked &&
    stateWord(st, "limits.can_drift_right") === "yes" &&
    rr(st, "limits.room_right") >= ROOM_R &&
    rd(st, "obstacles.right") >= SIDE_R;
  const escape = riseOK || sinkOK || leftOK || rightOK;
  const BLOCK_PATHS = ["obstacles.left", "obstacles.ahead", "obstacles.right", "free_space.level_ahead", "path_ahead.contact_in"];

  if (touching || (contact === R.imminentContact && !escape)) {
    const uses = [touching ? "nearest.range" : "path_ahead.contact_in", "obstacles.behind"];
    if (behindClose) return { choice: "slow_down", rule: "back-off-needed-but-behind-too-close", uses };
    return { choice: "back_off", rule: touching ? "touching" : "imminent-without-escape", uses };
  }
  if (!blocked) return { choice: "hold_path", rule: "not-blocked", uses: BLOCK_PATHS };
  if (riseOK) {
    return { choice: "rise", rule: "rise-ok", uses: ["free_space.level_ahead", "free_space.above_ahead", "limits.can_rise"] };
  }
  if (sinkOK) {
    return { choice: "sink", rule: "sink-ok", uses: ["free_space.level_ahead", "free_space.below_ahead", "limits.can_sink"] };
  }
  if (leftOK && rightOK) {
    const uses = [
      "limits.can_drift_left", "limits.can_drift_right", "limits.room_left", "limits.room_right", "obstacles.left", "obstacles.right",
    ];
    const roomL = rr(st, "limits.room_left");
    const roomR = rr(st, "limits.room_right");
    if (roomL !== roomR) return { choice: roomL > roomR ? "drift_left" : "drift_right", rule: "roomier-side-by-room", uses };
    const l = rd(st, "obstacles.left");
    const r = rd(st, "obstacles.right");
    if (l !== r) return { choice: l > r ? "drift_left" : "drift_right", rule: "roomier-side-by-sector", uses };
    uses.push("obstacles.far_left", "obstacles.far_right");
    const fl = rd(st, "obstacles.far_left");
    const fr = rd(st, "obstacles.far_right");
    return { choice: fr > fl ? "drift_right" : "drift_left", rule: fr > fl ? "roomier-side-by-far-sector" : "tie-goes-left", uses };
  }
  if (leftOK) return { choice: "drift_left", rule: "left-ok", uses: ["limits.can_drift_left", "limits.room_left", "obstacles.left"] };
  if (rightOK) return { choice: "drift_right", rule: "right-ok", uses: ["limits.can_drift_right", "limits.room_right", "obstacles.right"] };
  return { choice: "slow_down", rule: "boxed-in", uses: blockers };
}

/**
 * The risk rule: 2 when `path_ahead.contact_in` / `nearest.range` hit the riskHigh words,
 * 1 for the riskTight words, else 0.
 * @param {object} state
 * @returns {{score:number, rule:string, uses:string[]}}
 */
export function decideRisk(state) {
  const contact = stateWord(state, "path_ahead.contact_in");
  const nr = stateWord(state, "nearest.range");
  const hit = (lists) => [
    ...(lists.contact.includes(contact) ? ["path_ahead.contact_in"] : []),
    ...(lists.nearest.includes(nr) ? ["nearest.range"] : []),
  ];
  const high = hit(R.riskHigh);
  if (high.length) return { score: 2, rule: "about-to-hit", uses: high };
  const tight = hit(R.riskTight);
  if (tight.length) return { score: 1, rule: "tight", uses: tight };
  return { score: 0, rule: "open", uses: ["path_ahead.contact_in", "nearest.range"] };
}

/**
 * The subject-lost rule: lost iff `subject.unseen_for` is one of PILOT_RULES.lostUnseen.
 * @param {object} state
 * @returns {{lost:boolean, rule:string, uses:string[]}}
 */
export function decideSubjectLost(state) {
  const lost = R.lostUnseen.includes(stateWord(state, "subject.unseen_for"));
  return { lost, rule: lost ? "unseen-long" : "not-lost", uses: ["subject.unseen_for"] };
}

/**
 * The occluder rule: ignore when visible enough / only briefly hidden / occluder unknown;
 * otherwise by occluder class — soft → fade, solid → reroute, moving → wait.
 * @param {object} state
 * @returns {{choice:string, rule:string, uses:string[]}}
 */
export function decideOccluder(state) {
  const vis = stateWord(state, "subject.visibility");
  const unseen = stateWord(state, "subject.unseen_for");
  const occ = stateWord(state, "subject.occluded_by");
  const uses = ["subject.visibility", "subject.occluded_by"];
  if (R.ignoreVisibility.includes(vis)) return { choice: "ignore", rule: "visible-enough", uses: ["subject.visibility"] };
  if (R.ignoreUnseen.includes(unseen)) return { choice: "ignore", rule: "brief", uses: ["subject.unseen_for"] };
  if (R.ignoreOccluders.includes(occ)) return { choice: "ignore", rule: "occluder-unknown", uses: ["subject.occluded_by"] };
  const cls = occluderClass(occ);
  if (cls === "soft") return { choice: "fade", rule: "soft-occluder", uses };
  if (cls === "solid") return { choice: "reroute", rule: "solid-occluder", uses };
  if (cls === "moving") return { choice: "wait", rule: "moving-occluder", uses };
  return { choice: "ignore", rule: "no-occluder-class", uses: [] };
}

/**
 * The framing rule: keep when the subject is fully hidden; recenter when `subject.in_frame`
 * starts with a recenterOffsets word (priority over size); widen / tighten by size; else keep.
 * @param {object} state
 * @returns {{choice:string, rule:string, uses:string[]}}
 */
export function decideFraming(state) {
  const vis = stateWord(state, "subject.visibility");
  const where = leadingWord(stateWord(state, "subject.in_frame"), "offset");
  const size = stateWord(state, "subject.size");
  if (vis === NO_SUBJECT) return { choice: "keep", rule: "no-subject", uses: [] };
  if (R.framingUnjudgeable.includes(vis)) return { choice: "keep", rule: "unjudgeable", uses: ["subject.visibility"] };
  if (R.recenterOffsets.includes(where)) {
    return { choice: "recenter", rule: "near-edge", uses: ["subject.in_frame"] };
  }
  if (R.widenSizes.includes(size)) return { choice: "widen", rule: "too-large", uses: ["subject.size"] };
  if (R.tightenSizes.includes(size)) return { choice: "tighten", rule: "too-small", uses: ["subject.size"] };
  return { choice: "keep", rule: "well-framed", uses: ["subject.in_frame", "subject.size"] };
}

/**
 * Every rule's decision with its reason, for logs and tests.
 * @param {object} state
 * @returns {{maneuver:object, risk:object, subject_lost:object, occluder_action:object, framing:object}}
 */
export function explainPolicy(state) {
  return {
    maneuver: decideManeuver(state),
    risk: decideRisk(state),
    subject_lost: decideSubjectLost(state),
    occluder_action: decideOccluder(state),
    framing: decideFraming(state),
  };
}

/**
 * Hard choice answer in Decisions-API shape (probabilities in option order).
 * @param {string[]} options
 * @param {string} choice
 * @returns {{type:'choice', choice:string, confidence:number, probabilities:Record<string,number>}}
 */
function choiceAnswer(options, choice) {
  const probabilities = {};
  for (const k of options) probabilities[k] = k === choice ? 1 : 0;
  return { type: "choice", choice, confidence: 1, probabilities };
}

/**
 * Hard score answer (probabilities keyed "0".."n−1").
 * @param {number} levels
 * @param {number} score integer level
 * @returns {{type:'score', score:number, confidence:number, probabilities:Record<string,number>}}
 */
function scoreAnswer(levels, score) {
  const probabilities = {};
  for (let i = 0; i < levels; i++) probabilities[String(i)] = i === score ? 1 : 0;
  return { type: "score", score, confidence: 1, probabilities };
}

/**
 * Generic conservative answer for a question this policy has no rule for: the first
 * choice option, score 0, noul 0.
 * @param {object} q a Decisions-API question
 * @returns {object|null}
 */
function defaultAnswer(q) {
  if (!q || typeof q !== "object") return null;
  if (q.type === "choice" && q.criteria && typeof q.criteria === "object") {
    const keys = Object.keys(q.criteria);
    return keys.length ? choiceAnswer(keys, keys[0]) : null;
  }
  if (q.type === "score" && Array.isArray(q.criteria)) return scoreAnswer(q.criteria.length, 0);
  if (q.type === "noul") return { type: "noul", noul: 0 };
  return null;
}

/**
 * The deterministic code policy (SPEC §2.14): answers the pilot questions from the state's
 * words in the exact Decisions-API answer shape —
 * `{maneuver:{type:'choice', choice, confidence, probabilities}, risk:{type:'score', score,
 * confidence, probabilities}, subject_lost:{type:'noul', noul}, occluder_action:{…}, framing:{…}}`.
 * Hard answers (chosen option p = 1, confidence 1). Answers only the asked questions:
 * `opts.questions`, else questionsFor({hasSubject}) where hasSubject follows the state.
 * @param {object|null} sensorFrame used only to build the state when `state` is missing
 * @param {object|null} state a buildPilotState() result
 * @param {{questions?:Record<string, object>}} [opts]
 * @returns {Record<string, object>}
 */
export function codePolicy(sensorFrame, state, opts = {}) {
  const st = state && typeof state === "object" ? state : buildPilotState(sensorFrame, {});
  const hasSubject = stateWord(st, "subject.visibility") !== NO_SUBJECT && stateWord(st, "subject.visibility") !== undefined;
  const questions = opts && opts.questions && typeof opts.questions === "object" ? opts.questions : questionsFor({ hasSubject });
  const out = {};
  for (const id of Object.keys(questions)) {
    const q = questions[id];
    if (id === "maneuver") out[id] = choiceAnswer(optionKeys(q, MANEUVERS), decideManeuver(st).choice);
    else if (id === "risk") out[id] = scoreAnswer(levelCount(q, RISK_LEVELS.length), decideRisk(st).score);
    else if (id === "subject_lost") out[id] = { type: "noul", noul: decideSubjectLost(st).lost ? 1 : 0 };
    else if (id === "occluder_action") out[id] = choiceAnswer(optionKeys(q, OCCLUDER_ACTIONS), decideOccluder(st).choice);
    else if (id === "framing") out[id] = choiceAnswer(optionKeys(q, FRAMING_ACTIONS), decideFraming(st).choice);
    else {
      const a = defaultAnswer(q);
      if (a) out[id] = a;
    }
  }
  return out;
}

/** @param {*} q @param {readonly string[]} fallback @returns {string[]} the question's option keys */
function optionKeys(q, fallback) {
  return q && q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [...fallback];
}

/** @param {*} q @param {number} fallback @returns {number} the question's level count */
function levelCount(q, fallback) {
  return q && Array.isArray(q.criteria) && q.criteria.length >= 2 ? q.criteria.length : fallback;
}

/**
 * The neutral answers ("nothing to do"): every choice at its conservative first option
 * (hold_path / ignore / keep), risk 0, subject_lost 0 — what the pilot feeds the mapper when
 * no consult is needed, so the camera relaxes back onto the planned shot.
 * @param {Record<string, object>} [questions] defaults to questionsFor() (all five)
 * @returns {Record<string, object>}
 */
export function neutralAnswers(questions) {
  const qs = questions && typeof questions === "object" ? questions : questionsFor();
  const out = {};
  for (const id of Object.keys(qs)) {
    const a = defaultAnswer(qs[id]);
    if (a) out[id] = a;
  }
  return out;
}

/**
 * Thresholded level of a score answer (round to the nearest level; scores are never
 * interpolated into magnitudes).
 * @param {*} a
 * @returns {number|null}
 */
export function scoreLevel(a) {
  const s = a && typeof a === "object" ? Number(a.score) : NaN;
  return Number.isFinite(s) ? Math.max(0, Math.round(s)) : null;
}

/**
 * Agreement between two answer sets (e.g. JEV vs codePolicy for the same scene): per shared
 * question id — choice: same option; score: same thresholded level; noul: same side of 0.5.
 * @param {Record<string, object>|null} a
 * @param {Record<string, object>|null} b
 * @returns {{agree:boolean|null, compared:number, perQuestion:Record<string, boolean>}}
 *   `agree` is null when no question could be compared
 */
export function answersAgree(a, b) {
  const perQuestion = {};
  let compared = 0;
  let all = true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const id of Object.keys(a)) {
      const x = a[id];
      const y = b[id];
      if (!x || !y || typeof x !== "object" || typeof y !== "object") continue;
      let same;
      if (x.type === "choice" || y.type === "choice") same = x.choice === y.choice;
      else if (x.type === "score" || y.type === "score") same = scoreLevel(x) === scoreLevel(y);
      else if (x.type === "noul" || y.type === "noul") same = Number(x.noul) >= 0.5 === Number(y.noul) >= 0.5;
      else continue;
      perQuestion[id] = same;
      compared += 1;
      if (!same) all = false;
    }
  }
  return { agree: compared > 0 ? all : null, compared, perQuestion };
}
