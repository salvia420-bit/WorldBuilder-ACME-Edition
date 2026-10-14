// tools/film/lib/jev_tasks.mjs — planning-time JEV decisions for the film CLI.
//
// WHY: the director (a Claude Code session, SPEC §0) makes the creative calls. A few
// fast, bounded judgments inside CLI loops are cheaper and quicker as JEV typed
// decisions:
//   - which scouted camera candidate to keep
//   - keep or retake, given a take report
//   - how well a site fits a lyric line
//   - which technique family a song section wants
// Film mode is default OFF (`?filmMode=on` in the page); these helpers run only when
// the film CLI calls them.
//
// HOW (JEV prior art, SPEC §0): code turns numbers into WORDS. Criteria read like
// specs, with explicit boundaries that quote those words. The conservative default
// option goes first, because JEV has a first-option bias. Score answers are
// thresholded, never interpolated. Every result carries a band telling the director
// when to look for itself:
//   'act'      confidence ≥ 0.8
//   'confirm'  confidence ≥ 0.5
//   'escalate' below that
// keepOrRetake uses noul thresholds on max(p, 1−p): act ≥ 0.8, confirm ≥ 0.65. Every
// result also returns the raw (normalized) answer.
//
// NO KEY ⇒ pass client = null. Each task then returns a deterministic code verdict
// (source 'code') built from the same words and boundaries. JEV errors are thrown as
// JevError; the CLI can retry with client = null to get the code verdict.
//
// Exports: bandOf, intentWords, PICK_HIDDEN_WORDS, PICK_TOO_CLOSE_WORDS, PICK_INSTRUCTIONS,
// buildPickCandidateRequest, pickCandidate,
// takeReportWords, judgeTakeWords, buildKeepOrRetakeRequest, keepOrRetake,
// FIT_LEVELS, buildSiteFitRequest, scoreSiteForLine, ENERGY_WORDS, TEMPO_WORDS,
// SECTION_ROLES (re-exported from audio/structure.mjs), SECTION_ROLE_ALIASES, sectionRoleOf,
// energyWordOf, tempoWordOf, TECHNIQUE_FAMILIES, buildSectionFamilyRequest,
// codeTechniqueFamily, sectionTechniqueFamily, jevPing.

import { quoteBand, wordsUpTo } from "../../../scene3d/film/pilot/sense_words.js";
import { SECTION_ROLES } from "../audio/structure.mjs";
import { JEV_LIMITS, JevError, choiceQ, noulQ, scoreQ } from "./jev.mjs";

/** Band thresholds for choice/score confidence. */
export const BAND_THRESHOLDS = Object.freeze({ act: 0.8, confirm: 0.5 });
/** Band thresholds for a noul's decisiveness max(p, 1−p), which is never below 0.5. */
export const NOUL_BAND_THRESHOLDS = Object.freeze({ act: 0.8, confirm: 0.65 });

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const lower = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function trimNum(x) {
  return String(Math.round(x * 100) / 100);
}

/**
 * Confidence → 'act' | 'confirm' | 'escalate'. A null or non-finite confidence → 'escalate'.
 * @param {number|null|undefined} confidence
 * @param {{act?: number, confirm?: number}} [thresholds] defaults {act: 0.8, confirm: 0.5}
 * @returns {'act'|'confirm'|'escalate'}
 */
export function bandOf(confidence, thresholds = BAND_THRESHOLDS) {
  const act = thresholds?.act ?? BAND_THRESHOLDS.act;
  const confirm = thresholds?.confirm ?? BAND_THRESHOLDS.confirm;
  if (confidence == null) return "escalate";
  const c = Number(confidence);
  if (!Number.isFinite(c)) return "escalate";
  if (c >= act) return "act";
  if (c >= confirm) return "confirm";
  return "escalate";
}

// Words for criteria: a string as is, an array joined with "; ", an object as "k: v; …".
function wordsText(words) {
  if (typeof words === "string") return words.trim();
  if (typeof words === "number" || typeof words === "boolean") return String(words);
  if (Array.isArray(words)) return words.map((x) => String(x ?? "").trim()).filter(Boolean).join("; ");
  if (isPlainObject(words)) {
    return Object.entries(words)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("; ");
  }
  return "";
}

const PICK_OPTS = ["sessionId", "trace", "model", "timeoutMs", "maxRetries"];

async function decideWith(client, req, opts) {
  if (!client || typeof client.decide !== "function") {
    throw new JevError("config", "pass a JEV client (createJevClient) or null for the code fallback");
  }
  const extra = {};
  for (const k of PICK_OPTS) if (opts?.[k] !== undefined) extra[k] = opts[k];
  const r = await client.decide({ state: req.state, questions: req.questions, ...extra });
  for (const id of Object.keys(req.questions)) {
    if (!r?.answers?.[id]) throw new JevError("bad-response", `JEV answer '${id}' is missing`);
  }
  return r;
}

function meta(r) {
  return { id: r?.id ?? null, model: r?.model ?? null, ms: r?.ms ?? null, costUsd: r?.usage?.costUsd ?? null };
}

// Logs the threshold that was applied (JEV guidance: log ids, probabilities, the
// threshold applied — never the state).
function note(opts, task, r, fields) {
  if (typeof opts?.log !== "function") return;
  try {
    opts.log({ event: "jev-task", task, id: r?.id ?? null, ...fields });
  } catch {
    // logging never breaks a task
  }
}

// ---------------------------------------------------------------------------
// pickCandidate — choose among scouted camera candidates
// ---------------------------------------------------------------------------

const FRAMING_WORDS = Object.freeze({
  EWS: "extreme wide shot", WS: "wide shot", FS: "full shot", MWS: "medium wide shot",
  MS: "medium shot", MCU: "medium close-up", CU: "close-up", ECU: "extreme close-up",
});
const ANGLE_WORDS = Object.freeze({
  eye: "eye level",
  high: "high angle, looking down on the subject",
  low: "low angle, looking up at the subject",
  top: "straight down from above",
});
const LIGHT_WORDS = Object.freeze({
  front: "sun behind the camera, subject lit from the front",
  back: "sun behind the subject (back-lit)",
  rim: "sun to the side behind the subject (rim light)",
});

/**
 * Shot intent (SPEC §2.15 `{framing, angle, side?, light?, minClearance, maxOcclusion}`)
 * → words for the JEV state. A string intent passes through unchanged. Numbers become
 * phrases ("camera at least 2 m from any obstacle"). maxOcclusion is read as a
 * fraction when ≤ 1, else as a percentage.
 * @param {string|object|null|undefined} intent
 * @returns {string|Record<string,string>}
 */
export function intentWords(intent) {
  if (typeof intent === "string") return intent.trim() || "frame the subject clearly";
  if (!isPlainObject(intent)) return "frame the subject clearly";
  const w = {};
  for (const [k, v] of Object.entries(intent)) {
    if (v == null || v === "") continue;
    switch (k) {
      case "framing":
        w.framing = FRAMING_WORDS[v] ? `${FRAMING_WORDS[v]} (${v})` : String(v);
        break;
      case "angle":
        w.angle = ANGLE_WORDS[v] ?? String(v);
        break;
      case "side":
        w.side = v === "left" || v === "right" ? `camera on the subject's ${v} side` : String(v);
        break;
      case "light":
        w.light = LIGHT_WORDS[v] ?? String(v);
        break;
      case "minClearance":
        if (Number.isFinite(v)) w.clearance = `camera at least ${trimNum(v)} m from any obstacle`;
        break;
      case "maxOcclusion":
        if (Number.isFinite(v)) w.occlusion = `subject at most ${Math.round(v <= 1 ? v * 100 : v)}% hidden`;
        break;
      default:
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") w[k] = String(v);
    }
  }
  return Object.keys(w).length ? w : "frame the subject clearly";
}

function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new JevError("bad-request", "candidates must be a non-empty array of {id, words}");
  }
  if (candidates.length > JEV_LIMITS.choiceOptionsMax) {
    throw new JevError("bad-request", `at most ${JEV_LIMITS.choiceOptionsMax} candidates (got ${candidates.length})`);
  }
  const seen = new Set();
  return candidates.map((c, i) => {
    const rawId = c?.id;
    const id = typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId)) ? String(rawId).trim() : "";
    if (!id || id === "__proto__" || id.length > 128) throw new JevError("bad-request", `candidate ${i} needs an id (a string or number)`);
    if (seen.has(id)) throw new JevError("bad-request", `duplicate candidate id '${id}'`);
    seen.add(id);
    const words = wordsText(c.words);
    if (!words) throw new JevError("bad-request", `candidate '${id}' needs words describing it`);
    return { id, words };
  });
}

// JS objects iterate integer-like keys ("0", "7", "42") first, in ascending numeric
// order, so criteria keyed by numeric candidate ids would lose the caller's order,
// and with it the conservative-default-first rule. Lists with such an id get
// positional option keys c1…cN, mapped back to the ids afterwards.
function isIndexLikeKey(k) {
  return /^(0|[1-9]\d{0,9})$/.test(k) && Number(k) <= 4294967294;
}

function optionKeysFor(list) {
  if (!list.some((c) => isIndexLikeKey(c.id))) return list.map((c) => c.id);
  return list.map((_, i) => `c${i + 1}`);
}

// The words the pick rule quotes come from the pilot's WORD_BOUNDS (sense_words.js), the same
// bands scene/solver.js describeCandidate writes into every option ("subject mostly hidden by
// tree", "nearest rock very close (1.5 m)"), so the rule's words always appear verbatim in the
// options it judges and the two cannot drift apart.
/** Visibility words that make a candidate unacceptable: "fully hidden", "mostly hidden". */
export const PICK_HIDDEN_WORDS = Object.freeze(wordsUpTo("visibility", "mostly hidden"));
/** Clearance (distance) words that make a candidate unacceptable: "touching", "very close". */
export const PICK_TOO_CLOSE_WORDS = Object.freeze(wordsUpTo("distance", "very close"));

function quotedOr(scale, words) {
  const qs = words.map((w) => quoteBand(scale, w));
  return qs.length <= 1 ? qs.join("") : `${qs.slice(0, -1).join(", ")} or ${qs[qs.length - 1]}`;
}

/** The pickCandidate instructions (exported for the words-contract tests). */
export const PICK_INSTRUCTIONS =
  "Choose the camera candidate whose description best delivers the shot intent in the state. " +
  "Judge each option only by its description. An option is unacceptable when its subject is " +
  `${quotedOr("visibility", PICK_HIDDEN_WORDS)}, or when its nearest obstacle is ` +
  `${quotedOr("distance", PICK_TOO_CLOSE_WORDS)} to the camera; ` +
  "choose such an option only if every option has that problem. When options fit about equally well, " +
  "choose the one listed first.";

/**
 * Builds the pickCandidate request. Option order = candidate order, so pass the
 * solver's ranked list best-first: the first candidate is the conservative default.
 * Option keys are the candidate ids, unless some id is integer-like ("3"), which JS
 * would reorder; then every option gets a positional key c1…cN. `keyToId` maps
 * option keys back to candidate ids either way.
 * @param {{intent?: string|object, candidates: Array<{id: string|number, words: string|string[]|object}>}} input
 * @returns {{state: object, questions: {candidate: object}, keyToId: Record<string,string>}}
 * @throws {JevError} 'bad-request' for fewer than 2 candidates, duplicate ids or empty words
 */
export function buildPickCandidateRequest({ intent, candidates } = {}) {
  const list = normalizeCandidates(candidates);
  if (list.length < JEV_LIMITS.choiceOptionsMin) {
    throw new JevError("bad-request", "a JEV choice needs at least 2 candidates (pickCandidate short-circuits a single one)");
  }
  const keys = optionKeysFor(list);
  const criteria = {};
  const keyToId = {};
  list.forEach((c, i) => {
    criteria[keys[i]] = c.words;
    keyToId[keys[i]] = c.id;
  });
  return {
    state: { task: "choose the camera position for one shot", intent: intentWords(intent), options: list.length },
    questions: { candidate: choiceQ(PICK_INSTRUCTIONS, criteria) },
    keyToId,
  };
}

/**
 * Picks one scouted camera candidate. The choice criteria are the candidates'
 * words (e.g. scene/solver.js describeCandidate), in the given order.
 * - one candidate → returned without a call (source 'trivial')
 * - client null → the first candidate (the solver's best), band 'confirm', source 'code'
 * - `choice` and `probabilities` use candidate ids; `raw` is JEV's answer as sent,
 *   keyed by option key (c1…cN when some id was integer-like)
 * @param {{decide: Function}|null} client
 * @param {{intent?: string|object, candidates: Array<{id: string|number, words: string|string[]|object}>}} input
 * @param {{thresholds?: {act?: number, confirm?: number}, sessionId?: string, trace?: object, log?: Function}} [opts]
 * @returns {Promise<{choice: string, confidence: number|null, probabilities: Record<string,number>|null,
 *   band: 'act'|'confirm'|'escalate', raw: object|null, source: 'jev'|'code'|'trivial', meta?: object}>}
 */
export async function pickCandidate(client, input = {}, opts = {}) {
  const list = normalizeCandidates(input?.candidates);
  if (list.length === 1) {
    return { choice: list[0].id, confidence: 1, probabilities: { [list[0].id]: 1 }, band: "act", raw: null, source: "trivial" };
  }
  if (client == null) {
    return { choice: list[0].id, confidence: null, probabilities: null, band: "confirm", raw: null, source: "code" };
  }
  const req = buildPickCandidateRequest({ intent: input.intent, candidates: list });
  const r = await decideWith(client, req, opts);
  const a = r.answers.candidate;
  const idOf = (k) => (Object.prototype.hasOwnProperty.call(req.keyToId, k) ? req.keyToId[k] : k);
  const choice = idOf(a.choice);
  const confidence = a.confidence ?? a.probabilities?.[a.choice] ?? null;
  const probabilities = a.probabilities ? Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [idOf(k), p])) : null;
  const thresholds = { ...BAND_THRESHOLDS, ...opts?.thresholds };
  const band = bandOf(confidence, thresholds);
  note(opts, "pickCandidate", r, { choice, confidence, band, thresholds });
  return { choice, confidence, probabilities, band, raw: a, source: "jev", meta: meta(r) };
}

// ---------------------------------------------------------------------------
// keepOrRetake — judge a take report
// ---------------------------------------------------------------------------

function firstNumber(...vals) {
  for (const v of vals) {
    if (v == null || typeof v === "boolean") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function ratioWord(count, frames, few, some) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return "none";
  const r = frames > 0 ? n / frames : 1;
  if (r < few) return "a few";
  if (r < some) return "some";
  return "many";
}

/**
 * Take report → the words the keep/retake criteria quote. The canonical fields are
 * listed below; the aliases in brackets are accepted too.
 * - frames [frameCount, stats.frames] — frames recorded
 * - droppedFrames [dropped, stats.droppedFrames]
 *   → dropped_frames: 'none' | 'a few' (<0.5% of frames) | 'some' (<2%) | 'many'
 * - safetyAdjustedFrames [safety.adjustedFrames, safety.adjusted (a count)]
 *   → safety_adjustments: 'none' | 'a few' (<2%) | 'some' (<10%) | 'many'
 * - subjectMinVisibleFrac [subject.minVisibleFrac, minSubjectVisibility] (0..1)
 *   → subject_min_visibility: 'fully hidden' <0.1, 'mostly hidden' <0.4,
 *     'partly hidden' <0.8, else 'clear'; 'no subject' when subject === null or
 *     hasSubject === false; 'not measured' when absent
 * - subjectMaxUnseenSec [subject.maxUnseenSec] — longest stretch the subject was unseen
 *   → subject_longest_unseen: 'not hidden' (0) | 'brief' <1 s | 'a while' <3 s | 'long'
 * - popInEvents [popIn (a number), popIn.events, popIn.count] — objects or terrain
 *   appearing in frame mid-take
 *   → pop_in: 'none' | 'one' | 'a few' (2–3) | 'many' (≥4)
 * - reveal (boolean) or a technique id containing "reveal"
 *   → shot_kind: 'reveal' | 'normal'
 * The visibility and unseen buckets are the SPEC §2.14 sense_words bounds.
 * @param {object} report
 * @returns {{dropped_frames: string, safety_adjustments: string, subject_min_visibility: string,
 *   subject_longest_unseen: string, pop_in: string, shot_kind: string}}
 */
export function takeReportWords(report = {}) {
  const r = isPlainObject(report) ? report : {};
  const frames = firstNumber(r.frames, r.frameCount, r.stats?.frames) ?? 0;
  const dropped = firstNumber(r.droppedFrames, r.dropped, r.stats?.droppedFrames) ?? 0;
  const safety = isPlainObject(r.safety) ? r.safety : {};
  const adjusted = firstNumber(r.safetyAdjustedFrames, safety.adjustedFrames, safety.adjusted) ?? 0;
  const subject = isPlainObject(r.subject) ? r.subject : {};
  const noSubject = r.subject === null || r.hasSubject === false;
  const minVis = firstNumber(r.subjectMinVisibleFrac, subject.minVisibleFrac, r.minSubjectVisibility);
  const unseen = Math.max(0, firstNumber(r.subjectMaxUnseenSec, subject.maxUnseenSec) ?? 0);
  const popIn = Math.max(0, Math.floor(firstNumber(r.popInEvents, typeof r.popIn === "number" ? r.popIn : null, r.popIn?.events, r.popIn?.count) ?? 0));
  const reveal = r.reveal === true || /reveal/i.test(String(r.technique ?? ""));

  let visibility;
  if (noSubject) visibility = "no subject";
  else if (minVis == null) visibility = "not measured";
  else if (minVis < 0.1) visibility = "fully hidden";
  else if (minVis < 0.4) visibility = "mostly hidden";
  else if (minVis < 0.8) visibility = "partly hidden";
  else visibility = "clear";

  let unseenWord;
  if (unseen <= 0) unseenWord = "not hidden";
  else if (unseen < 1) unseenWord = "brief";
  else if (unseen < 3) unseenWord = "a while";
  else unseenWord = "long";

  let popWord;
  if (popIn === 0) popWord = "none";
  else if (popIn === 1) popWord = "one";
  else if (popIn <= 3) popWord = "a few";
  else popWord = "many";

  return {
    dropped_frames: ratioWord(dropped, frames, 0.005, 0.02),
    safety_adjustments: ratioWord(adjusted, frames, 0.02, 0.1),
    subject_min_visibility: visibility,
    subject_longest_unseen: unseenWord,
    pop_in: popWord,
    shot_kind: reveal ? "reveal" : "normal",
  };
}

const KEEP_INSTRUCTIONS =
  "Decide whether this film take is good enough to keep. Judge only the take facts in the state; " +
  "each fact is a word from a fixed scale.";
// Same boundaries as judgeTakeWords. Min visibility alone never forces a retake: a
// subject 'mostly hidden' or 'fully hidden' for a 'brief' pass behind a tree is
// normal footage; hidden for 'a while' or 'long' is not.
const KEEP_CRITERIA = Object.freeze({
  true:
    "Keep when ALL hold: dropped_frames is 'none' or 'a few'; safety_adjustments is 'none', 'a few' or 'some'; " +
    "pop_in is 'none' or 'one'; subject_longest_unseen is 'not hidden' or 'brief'; subject_min_visibility is " +
    "'clear', 'partly hidden' or 'not measured', or it is 'mostly hidden' or 'fully hidden' for only a short pass " +
    "behind something (subject_longest_unseen 'not hidden' or 'brief'). Both subject facts are ignored when " +
    "shot_kind is 'reveal' or subject_min_visibility is 'no subject'.",
  false:
    "Retake when ANY holds: dropped_frames is 'some' or 'many'; safety_adjustments is 'many'; pop_in is 'a few' or " +
    "'many'; or, for a shot with a subject whose shot_kind is not 'reveal', subject_longest_unseen is 'a while' or " +
    "'long' (the subject stayed hidden too long, whatever subject_min_visibility says).",
});

/**
 * The code verdict on take words, using the same boundaries as the JEV criteria.
 * `reasons` lists retake triggers; `borderline` lists facts that only justify a look.
 * @param {ReturnType<typeof takeReportWords>} w
 * @returns {{keep: boolean, reasons: string[], borderline: string[]}}
 */
export function judgeTakeWords(w) {
  const reasons = [];
  const borderline = [];
  if (w.dropped_frames === "some" || w.dropped_frames === "many") reasons.push(`dropped_frames is '${w.dropped_frames}'`);
  else if (w.dropped_frames === "a few") borderline.push("dropped_frames is 'a few'");
  if (w.safety_adjustments === "many") reasons.push("safety_adjustments is 'many'");
  else if (w.safety_adjustments === "some") borderline.push("safety_adjustments is 'some'");
  const subjectMatters = w.shot_kind !== "reveal" && w.subject_min_visibility !== "no subject";
  if (subjectMatters && (w.subject_longest_unseen === "a while" || w.subject_longest_unseen === "long")) {
    reasons.push(`subject_longest_unseen is '${w.subject_longest_unseen}'`);
  } else if (subjectMatters && (w.subject_min_visibility === "mostly hidden" || w.subject_min_visibility === "fully hidden")) {
    borderline.push(`subject_min_visibility is '${w.subject_min_visibility}'`);
  }
  if (w.pop_in === "a few" || w.pop_in === "many") reasons.push(`pop_in is '${w.pop_in}'`);
  else if (w.pop_in === "one") borderline.push("pop_in is 'one'");
  return { keep: reasons.length === 0, reasons, borderline };
}

/**
 * Builds the keepOrRetake request: state {take: words}, one noul 'keep' = P(keep).
 * @param {object} takeReport
 * @returns {{state: {take: object}, questions: {keep: object}, words: object}}
 */
export function buildKeepOrRetakeRequest(takeReport) {
  const words = takeReportWords(takeReport);
  return { state: { take: words }, questions: { keep: noulQ(KEEP_INSTRUCTIONS, { ...KEEP_CRITERIA }) }, words };
}

/**
 * Keep or retake a take. Asks JEV a noul for P(keep) and keeps when pKeep > 0.5
 * (exactly 0.5 → retake, the conservative call). The band uses max(p, 1−p) against
 * NOUL_BAND_THRESHOLDS. The code verdict's facts always come back as `reasons`.
 * client null → the code verdict (source 'code', pKeep 1|0, confidence null): 'act'
 * when no fact is borderline, else 'confirm'.
 * @param {{decide: Function}|null} client
 * @param {object} takeReport see takeReportWords
 * @param {{thresholds?: {act?: number, confirm?: number}, sessionId?: string, trace?: object, log?: Function}} [opts]
 * @returns {Promise<{keep: boolean, pKeep: number, confidence: number|null, band: 'act'|'confirm'|'escalate',
 *   words: object, reasons: string[], code: {keep: boolean, borderline: string[]}, raw: object|null,
 *   source: 'jev'|'code', meta?: object}>}
 */
export async function keepOrRetake(client, takeReport, opts = {}) {
  const req = buildKeepOrRetakeRequest(takeReport);
  const code = judgeTakeWords(req.words);
  if (client == null) {
    return {
      keep: code.keep,
      pKeep: code.keep ? 1 : 0,
      confidence: null,
      band: code.borderline.length ? "confirm" : "act",
      words: req.words,
      reasons: code.reasons,
      code: { keep: code.keep, borderline: code.borderline },
      raw: null,
      source: "code",
    };
  }
  const r = await decideWith(client, req, opts);
  const a = r.answers.keep;
  const pKeep = a.noul;
  const confidence = Math.max(pKeep, 1 - pKeep);
  const thresholds = { ...NOUL_BAND_THRESHOLDS, ...opts?.thresholds };
  const band = bandOf(confidence, thresholds);
  note(opts, "keepOrRetake", r, { pKeep, band, thresholds });
  return {
    keep: pKeep > 0.5,
    pKeep,
    confidence,
    band,
    words: req.words,
    reasons: code.reasons,
    code: { keep: code.keep, borderline: code.borderline },
    raw: a,
    source: "jev",
    meta: meta(r),
  };
}

// ---------------------------------------------------------------------------
// scoreSiteForLine — how well a location fits a lyric line
// ---------------------------------------------------------------------------

/** The 5-level fit scale (low → high) for scoreSiteForLine. */
export const FIT_LEVELS = Object.freeze([
  "no fit: nothing at the site matches the line's imagery, or the site's feel contradicts the mood",
  "weak fit: only a generic match (any outdoor place, any building), nothing specific from the line",
  "partial fit: the site matches the mood or one minor image of the line, but not the line's main image",
  "good fit: the line's main image is at the site (the same kind of place or feature) and the mood does not clash",
  "perfect fit: the line's main image is literally there (the same object, terrain or landmark) and the site's feel matches the mood",
]);

const FIT_INSTRUCTIONS =
  "Rate how well this Asheron's Call location fits the lyric line as the place to film it. Compare the " +
  "site's look (site.look, site.kind, site.name) with the line's main image (line) and its mood (mood).";

/**
 * Builds the scoreSiteForLine request: a 5-level score 'fit'.
 * @param {{line: string, mood?: string, site: {name: string, kind?: string, words?: string|string[]|object}}} input
 * @returns {{state: object, questions: {fit: object}}}
 * @throws {JevError} 'bad-request' when line or site.name is missing
 */
export function buildSiteFitRequest({ line, mood, site } = {}) {
  if (!nonEmpty(line)) throw new JevError("bad-request", "line must be a non-empty string");
  if (!isPlainObject(site) || !nonEmpty(site.name)) throw new JevError("bad-request", "site needs a name");
  const look = wordsText(site.words);
  return {
    state: {
      line: line.trim(),
      mood: nonEmpty(mood) ? mood.trim() : "unspecified",
      site: { name: site.name.trim(), kind: nonEmpty(site.kind) ? site.kind.trim() : "place", look: look || "no description" },
    },
    questions: { fit: scoreQ(FIT_INSTRUCTIONS, [...FIT_LEVELS]) },
  };
}

const STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have he her his i in into is it its me my no not of on " +
    "or our she so that the their them then there they this to was we were what when where which who will with " +
    "you your all just like can")
    .split(" "),
);

function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

function stems(text) {
  const out = new Set();
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z']+/)) {
    const w = raw.replace(/'/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

// No-key fallback: shared content words between line+mood and the site. It is only a
// hint (it cannot see a mood clash), so its band is always 'escalate'.
function lexicalFitLevel(state) {
  const lineStems = stems(`${state.line} ${state.mood === "unspecified" ? "" : state.mood}`);
  const siteStems = stems(`${state.site.name} ${state.site.kind} ${state.site.look}`);
  let hits = 0;
  for (const s of lineStems) if (siteStems.has(s)) hits++;
  return hits === 0 ? 1 : Math.min(FIT_LEVELS.length - 1, hits + 1);
}

/**
 * Scores how well a site fits a lyric line on the 5-level FIT_LEVELS scale.
 * - score: JEV's expected level (0..4)
 * - level: the threshold reading Math.round(score), i.e. boundaries at .5
 * - levelText: FIT_LEVELS[level]
 * - confidence: JEV's, else P(level)
 * client null → a lexical-overlap hint (source 'code', band 'escalate').
 * @param {{decide: Function}|null} client
 * @param {{line: string, mood?: string, site: {name: string, kind?: string, words?: string|string[]|object}}} input
 * @param {{thresholds?: {act?: number, confirm?: number}, sessionId?: string, trace?: object, log?: Function}} [opts]
 * @returns {Promise<{score: number, level: number, levelText: string, confidence: number|null,
 *   probabilities: Record<string,number>|null, band: 'act'|'confirm'|'escalate', raw: object|null,
 *   source: 'jev'|'code', meta?: object}>}
 */
export async function scoreSiteForLine(client, input = {}, opts = {}) {
  const req = buildSiteFitRequest(input);
  if (client == null) {
    const level = lexicalFitLevel(req.state);
    return { score: level, level, levelText: FIT_LEVELS[level], confidence: null, probabilities: null, band: "escalate", raw: null, source: "code" };
  }
  const r = await decideWith(client, req, opts);
  const a = r.answers.fit;
  const level = Math.min(FIT_LEVELS.length - 1, Math.max(0, Math.round(a.score)));
  const confidence = a.confidence ?? a.probabilities?.[String(level)] ?? null;
  const thresholds = { ...BAND_THRESHOLDS, ...opts?.thresholds };
  const band = bandOf(confidence, thresholds);
  note(opts, "scoreSiteForLine", r, { score: a.score, level, confidence, band, thresholds });
  return {
    score: a.score,
    level,
    levelText: FIT_LEVELS[level],
    confidence,
    probabilities: a.probabilities ?? null,
    band,
    raw: a,
    source: "jev",
    meta: meta(r),
  };
}

// ---------------------------------------------------------------------------
// sectionTechniqueFamily — song section → camera technique family
// ---------------------------------------------------------------------------

/** Energy words, low → high (energyWordOf buckets a 0..1 section energy). */
export const ENERGY_WORDS = Object.freeze(["very low", "low", "medium", "high", "very high"]);
/** Tempo words, slow → fast (tempoWordOf buckets BPM). */
export const TEMPO_WORDS = Object.freeze(["very slow", "slow", "moderate", "fast", "very fast"]);
// Section roles: the song analyser's own vocabulary (tools/film/audio/structure.mjs SECTION_ROLES, written into
// SongAnalysis.sections[].role) — imported, not mirrored, so the family rules can't drift from what the analyser
// emits. structure.mjs is pure (no imports), so this stays Node-only and dependency-light.
export { SECTION_ROLES };

/**
 * Role words a director may type that the analyser spells differently → the analyser's role. A guitar 'solo' is
 * an 'instrumental' section.
 */
export const SECTION_ROLE_ALIASES = Object.freeze({ solo: "instrumental" });

/**
 * A section role (any case, aliases allowed) → the analyser's role word; empty or missing → 'unknown'. A word
 * that is neither a role nor an alias passes through lower-cased (no firm rule quotes it).
 * @param {string} role
 * @returns {string}
 */
export function sectionRoleOf(role) {
  const r = lower(role);
  if (!r) return "unknown";
  return Object.hasOwn(SECTION_ROLE_ALIASES, r) ? SECTION_ROLE_ALIASES[r] : r;
}

/**
 * Section energy (0..1, relative to the song) → ENERGY_WORDS. Buckets: <0.2 'very low',
 * <0.4 'low', <0.6 'medium', <0.8 'high', else 'very high'; non-finite → 'unknown'.
 * @param {number} energy
 * @returns {string}
 */
export function energyWordOf(energy) {
  if (energy == null) return "unknown";
  const e = Number(energy);
  if (!Number.isFinite(e)) return "unknown";
  if (e < 0.2) return "very low";
  if (e < 0.4) return "low";
  if (e < 0.6) return "medium";
  if (e < 0.8) return "high";
  return "very high";
}

/**
 * Tempo in BPM → TEMPO_WORDS. Buckets: <70 'very slow', <95 'slow', <120 'moderate',
 * <145 'fast', else 'very fast'; non-positive or non-finite → 'unknown'.
 * @param {number} bpm
 * @returns {string}
 */
export function tempoWordOf(bpm) {
  if (bpm == null) return "unknown";
  const b = Number(bpm);
  if (!Number.isFinite(b) || b <= 0) return "unknown";
  if (b < 70) return "very slow";
  if (b < 95) return "slow";
  if (b < 120) return "moderate";
  if (b < 145) return "fast";
  return "very fast";
}

/**
 * Technique families in option order (the conservative default first). Each entry
 * has the technique ids (SPEC §2.12 catalog) the director can draw from, and a
 * spec-like criterion quoting the ENERGY/TEMPO/role words.
 */
export const TECHNIQUE_FAMILIES = Object.freeze([
  Object.freeze({
    key: "static-slow",
    label: "static / slow move",
    techniques: Object.freeze(["classic.static", "classic.pan", "classic.tilt", "classic.push-in", "classic.dolly-in", "classic.establishing"]),
    criteria:
      "Static or slow move (locked-off frame, slow pan or tilt, gentle push-in). Choose when energy is 'very low' " +
      "or 'low', or tempo is 'very slow' or 'slow', or the lyric is quiet, intimate or reflective. This is also the " +
      "choice when no other option clearly applies.",
  }),
  Object.freeze({
    key: "tracking",
    label: "tracking",
    techniques: Object.freeze(["classic.tracking-follow", "classic.tracking-lead", "classic.tracking-side", "classic.steadicam", "drone.chase", "drone.lead", "drone.side-track"]),
    criteria:
      "Tracking move travelling with a subject (follow, lead, side-track, steadicam). Choose when energy is " +
      "'medium' or 'high' and the lyric is about walking, running, travelling, searching or a journey.",
  }),
  Object.freeze({
    key: "orbit",
    label: "orbit",
    techniques: Object.freeze(["classic.orbit", "classic.arc", "drone.orbit-poi", "drone.helix"]),
    criteria:
      "Orbit or arc around one subject. Choose when energy is 'medium', 'high' or 'very high' and the lyric centres " +
      "on one person, creature, object or landmark (a portrait moment), typically when role is 'chorus'.",
  }),
  Object.freeze({
    key: "drone-reveal",
    label: "drone reveal",
    techniques: Object.freeze(["drone.rising-reveal", "drone.boom-rise", "drone.tilt-reveal", "drone.flyover", "drone.dronie", "classic.pull-out-reveal"]),
    criteria:
      "Drone reveal (rising reveal, boom rise, tilt reveal, flyover). Choose when role is 'intro' or 'outro', or when " +
      "the lyric names a wide place (land, sea, sky, horizon, city, home, the world) and energy is 'medium' or 'high'.",
  }),
  Object.freeze({
    key: "fpv-kinetic",
    label: "FPV / kinetic",
    techniques: Object.freeze(["fpv.fpv-dive", "fpv.fpv-proximity", "fpv.fpv-gap", "fpv.fpv-corridor", "drone.fly-by", "classic.whip-pan"]),
    criteria:
      "FPV or kinetic move (dive, proximity pass, gap, fast fly-by). Choose only when energy is 'high' or 'very high' " +
      "AND tempo is 'fast' or 'very fast', and role is not 'intro' or 'outro'; best for a lyric about speed, flight, " +
      "falling, battle or danger.",
  }),
  Object.freeze({
    key: "top-down",
    label: "top-down",
    techniques: Object.freeze(["drone.top-down", "drone.top-down-rise", "drone.top-down-track", "classic.birds-eye", "drone.spiral-descent"]),
    criteria:
      "Top-down view (bird's-eye, top-down track or rise, spiral descent). Choose when role is 'bridge' or " +
      "'instrumental' and energy is 'low' or 'medium', or when the lyric is about patterns, maps, being lost or " +
      "looking down on the world.",
  }),
]);

const FAMILY_BY_KEY = new Map(TECHNIQUE_FAMILIES.map((f) => [f.key, f]));

// The firm rules are codeTechniqueFamily steps 1–4, in the same order; the lyric
// decides only among the options left open after them.
const FAMILY_INSTRUCTIONS =
  "Choose the camera technique family for this section of a music video from the section's role, energy, tempo " +
  "and lyric in the state. Apply these firm rules in order and stop at the first that matches: " +
  "1) role 'intro' or 'outro' → drone-reveal; " +
  "2) energy 'high' or 'very high' AND tempo 'fast' or 'very fast' → fpv-kinetic; " +
  "3) role 'bridge' or 'instrumental' with energy 'low' or 'medium' → top-down; " +
  "4) energy 'very low' or 'low', or tempo 'very slow' or 'slow' → static-slow. " +
  "If none matches, choose by the option descriptions, letting the lyric decide.";

function sectionWords({ role, energyWord, tempoWord, lyric } = {}) {
  return {
    role: sectionRoleOf(role),
    energy: lower(energyWord) || "unknown",
    tempo: lower(tempoWord) || "unknown",
    lyric: nonEmpty(lyric) ? lyric.trim() : "(instrumental)",
  };
}

/**
 * Builds the sectionTechniqueFamily request: one choice 'family' over TECHNIQUE_FAMILIES.
 * @param {{role?: string, energyWord?: string, tempoWord?: string, lyric?: string}} input
 * @returns {{state: {section: object}, questions: {family: object}}}
 */
export function buildSectionFamilyRequest(input = {}) {
  const criteria = {};
  for (const f of TECHNIQUE_FAMILIES) criteria[f.key] = f.criteria;
  return { state: { section: sectionWords(input) }, questions: { family: choiceQ(FAMILY_INSTRUCTIONS, criteria) } };
}

/**
 * The no-key rule table, using the same boundaries as the criteria. Precedence:
 *   1. intro/outro → 'drone-reveal'
 *   2. high energy and fast tempo → 'fpv-kinetic'
 *   3. bridge/instrumental (alias 'solo') with low or medium energy → 'top-down'
 *   4. low energy or slow tempo → 'static-slow'
 *   5. chorus with medium-or-higher energy, or any 'very high' energy → 'orbit'
 *   6. medium or high energy → 'tracking'
 *   7. otherwise → 'static-slow'
 * @param {{role?: string, energyWord?: string, tempoWord?: string}} input
 * @returns {string} a TECHNIQUE_FAMILIES key
 */
export function codeTechniqueFamily(input = {}) {
  const { role: r, energy: e, tempo: t } = sectionWords(input);
  const high = e === "high" || e === "very high";
  const fast = t === "fast" || t === "very fast";
  if (r === "intro" || r === "outro") return "drone-reveal";
  if (high && fast) return "fpv-kinetic";
  if ((r === "bridge" || r === "instrumental") && (e === "low" || e === "medium")) return "top-down";
  if (e === "very low" || e === "low" || t === "very slow" || t === "slow") return "static-slow";
  if (r === "chorus" && (e === "medium" || high)) return "orbit";
  if (e === "very high") return "orbit";
  if (e === "medium" || e === "high") return "tracking";
  return "static-slow";
}

/**
 * Chooses a technique family for one song section. Returns the family key as
 * `choice` plus its technique ids. client null → codeTechniqueFamily (source 'code',
 * band 'confirm').
 * @param {{decide: Function}|null} client
 * @param {{role?: string, energyWord?: string, tempoWord?: string, lyric?: string}} input
 * @param {{thresholds?: {act?: number, confirm?: number}, sessionId?: string, trace?: object, log?: Function}} [opts]
 * @returns {Promise<{choice: string, techniques: string[], confidence: number|null,
 *   probabilities: Record<string,number>|null, band: 'act'|'confirm'|'escalate', raw: object|null,
 *   source: 'jev'|'code', meta?: object}>}
 */
export async function sectionTechniqueFamily(client, input = {}, opts = {}) {
  if (client == null) {
    const key = codeTechniqueFamily(input);
    return { choice: key, techniques: [...FAMILY_BY_KEY.get(key).techniques], confidence: null, probabilities: null, band: "confirm", raw: null, source: "code" };
  }
  const req = buildSectionFamilyRequest(input);
  const r = await decideWith(client, req, opts);
  const a = r.answers.family;
  const confidence = a.confidence ?? a.probabilities?.[a.choice] ?? null;
  const thresholds = { ...BAND_THRESHOLDS, ...opts?.thresholds };
  const band = bandOf(confidence, thresholds);
  note(opts, "sectionTechniqueFamily", r, { choice: a.choice, confidence, band, thresholds });
  const fam = FAMILY_BY_KEY.get(a.choice);
  return {
    choice: a.choice,
    techniques: fam ? [...fam.techniques] : [],
    confidence,
    probabilities: a.probabilities ?? null,
    band,
    raw: a,
    source: "jev",
    meta: meta(r),
  };
}

// ---------------------------------------------------------------------------
// jevPing — the canonical `film jev ping` decision
// ---------------------------------------------------------------------------

/**
 * A trivial noul, ≈60 input tokens, that proves the key, the endpoint and the
 * answer parsing work end to end.
 * @param {{decide: Function}} client
 * @param {{sessionId?: string, timeoutMs?: number, maxRetries?: number}} [opts]
 * @returns {Promise<{ok: boolean, pYes: number, id: string|null, model: string|null, ms: number|null, costUsd: number|null}>}
 */
export async function jevPing(client, opts = {}) {
  const req = {
    state: { sky: "blue", grass: "green" },
    questions: {
      ping: noulQ("Does the state say the sky is blue?", {
        true: "state.sky is exactly 'blue'",
        false: "state.sky is anything other than 'blue'",
      }),
    },
  };
  const r = await decideWith(client, req, opts);
  const pYes = r.answers.ping.noul;
  return { ok: pYes > 0.5, pYes, ...meta(r) };
}
