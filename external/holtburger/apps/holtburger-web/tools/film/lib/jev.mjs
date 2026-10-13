// tools/film/lib/jev.mjs — JEV client for the OpenRouter Decisions API (Node only).
//
// WHY: film mode (scene3d/film/SPEC.md §0, §2.14, §3.2, §5) uses JEV — TypeSafe's
// "System One" typed-decision model — as the camera's real-time reflexes and for a
// few fast planning decisions. JEV is the ONLY metered API in film mode, and its key
// lives only in this Node process: never in the page, never in a URL, never in a log.
// So this module owns every safeguard. It validates questions before a request
// leaves and answers after it returns. It throws typed errors and retries a bounded
// number of times. Rolling $/hour and calls/minute caps refuse a call WITHOUT
// touching the network. Film mode is default OFF (`?filmMode=on` in the page); this
// code runs only when the film CLI calls it. No Anthropic API anywhere: the director
// is a Claude Code session, and JEV is the only model this code calls.
//
// WHAT:
//   createJevClient(opts) → {decide, stats, close, model, endpoint}
//   JevError {kind, status, code, retryable, retryAfterMs?, attempts?, issues?}
//   validateQuestions / parseAnswers / summarizeAnswers / costFromUsage / kindForStatus
//   choiceQ / noulQ / scoreQ question builders; parseRetryAfter
//   resolveJevKey (env OPENROUTER_API_KEY → OPENROUTER_KEY →
//   ~/.config/holtburger-film/openrouter.key, mode 600) and redactKey for diagnostics.
//
// LOGGING (injected `log`): {event:'jev', id, model, questions:[ids], answers:{id:
// {choice|noul|score, confidence?, top:[[key,p]…]}}, ms, costUsd, attempts}, plus
// 'jev-retry', 'jev-error' and 'jev-budget' events. Never the state, never the key.
//
// API CONTRACT (OpenRouter docs, verified 2026-10-13):
//   POST https://openrouter.ai/api/alpha/decisions
//   headers Authorization: Bearer <key>, Content-Type: application/json (+ X-Title,
//   HTTP-Referer attribution). Body {model, state: string|object|array,
//   questions:{id: Q}, session_id? (≤256), trace?, user?, provider?}.
//   Q choice {type, instructions, criteria:{option: description}} (≤255 options)
//   Q noul   {type, instructions, criteria?:{true, false}} (both keys when present)
//   Q score  {type, instructions, criteria:[level texts low→high]} (2–10 levels)
//   → {id?, model, provider?, answers:{id: A}, usage:{input_tokens, output_tokens, cost?}}
//   A noul {type, noul: P(yes)}; choice {type, choice, confidence?, probabilities?};
//   score {type, score (0..n-1 expectation), confidence?, probabilities?:{"0":p…}, legend?}.
//   $0.042 per 1M input tokens, output free. Errors {error:{code, message, metadata?}}
//   with HTTP 400/401/402/403/404/413/429/500/502/503/524/529; 429/5xx/524/529 retry.
//
// Usage:
//   const {key} = resolveJevKey();
//   const jev = createJevClient({apiKey: key, log: (e) => logFile.write(JSON.stringify(e) + "\n")});
//   const r = await jev.decide({state, questions: {risk: scoreQ("…", ["open", "tight", "about to hit"])}});
//   r.answers.risk.score; r.usage.costUsd; jev.stats();

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Pinned JEV model id. Takes stay reproducible because the alias is never the default. */
export const JEV_MODEL = "typesafe/jev-1.13";
/** Floating alias for the newest JEV (opt-in only, via `model`). */
export const JEV_MODEL_ALIAS = "~typesafe/jev-latest";
/** OpenRouter Decisions API endpoint. */
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
/** USD per input token ($0.042 per 1M). Output tokens are free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042e-6;
/**
 * API limits mirrored locally so a malformed request never leaves the process.
 * `choiceOptionsMin` = 2 is a local rule: a one-option choice is always a caller bug.
 * `inputTokensMax` = 32k for state + the longest question, estimated at 4 bytes/token.
 */
export const JEV_LIMITS = Object.freeze({
  choiceOptionsMin: 2,
  choiceOptionsMax: 255,
  scoreLevelsMin: 2,
  scoreLevelsMax: 10,
  sessionIdMax: 256,
  inputTokensMax: 32000,
});
/** Environment variables searched for the key, in precedence order. */
export const JEV_KEY_ENV_VARS = Object.freeze(["OPENROUTER_API_KEY", "OPENROUTER_KEY"]);
/** Key file path relative to the home directory. It must be a regular file with mode 600. */
export const JEV_KEY_FILE = path.join(".config", "holtburger-film", "openrouter.key");
/** Every JevError kind. */
export const JEV_ERROR_KINDS = Object.freeze([
  "auth", "credits", "forbidden", "not-found", "too-large", "rate", "server",
  "timeout", "network", "bad-request", "bad-response", "budget", "config",
]);

const RETRYABLE_KINDS = new Set(["rate", "server", "timeout", "network"]);
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Typed JEV failure. Callers branch on `.kind`, never on message text.
 * - kind: one of JEV_ERROR_KINDS
 * - status: HTTP status (null for local, network and timeout failures)
 * - code: the API's error.code, else the status, else a local code
 *   ('calls-per-minute', 'usd-per-hour', 'ECONNREFUSED', …)
 * - retryable: whether repeating the same request may succeed
 * - retryAfterMs (optional): the server's Retry-After, or when a budget window frees up
 * - attempts (set by decide): HTTP attempts made before the failure
 * - issues (bad-request from validation): every problem found
 */
export class JevError extends Error {
  /**
   * @param {string} kind one of JEV_ERROR_KINDS
   * @param {string} message human-readable; never contains the key or the state
   * @param {{status?: number|null, code?: string|number|null, retryable?: boolean,
   *   retryAfterMs?: number|null, issues?: string[], metadata?: object, cause?: unknown}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "JevError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.code = extra.code ?? extra.status ?? null;
    this.retryable = extra.retryable ?? RETRYABLE_KINDS.has(kind);
    if (extra.retryAfterMs != null) this.retryAfterMs = extra.retryAfterMs;
    if (extra.issues) this.issues = extra.issues;
    if (extra.metadata) this.metadata = extra.metadata;
  }

  /** JSON form for CLI output and telemetry files. */
  toJSON() {
    const out = { name: this.name, kind: this.kind, message: this.message, status: this.status, code: this.code, retryable: this.retryable };
    if (this.retryAfterMs != null) out.retryAfterMs = this.retryAfterMs;
    if (this.attempts != null) out.attempts = this.attempts;
    if (this.issues) out.issues = this.issues;
    return out;
  }
}

/**
 * Maps an HTTP status to a JevError kind and says whether it is retryable.
 * 408 → timeout (retryable); 429 → rate (retryable); every 5xx, including 524 and
 * 529, → server (retryable); any other 4xx → bad-request.
 * @param {number} status
 * @returns {{kind: string, retryable: boolean}}
 */
export function kindForStatus(status) {
  switch (status) {
    case 400: return { kind: "bad-request", retryable: false };
    case 401: return { kind: "auth", retryable: false };
    case 402: return { kind: "credits", retryable: false };
    case 403: return { kind: "forbidden", retryable: false };
    case 404: return { kind: "not-found", retryable: false };
    case 408: return { kind: "timeout", retryable: true };
    case 413: return { kind: "too-large", retryable: false };
    case 429: return { kind: "rate", retryable: true };
    default:
      if (status >= 500 && status <= 599) return { kind: "server", retryable: true };
      if (status >= 400 && status <= 499) return { kind: "bad-request", retryable: false };
      return { kind: "bad-response", retryable: false };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function clip(s, n = 200) {
  const t = typeof s === "string" ? s : String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function show(v) {
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return String(v);
  } catch {
    return typeof v;
  }
}

const round4 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

// Ids and option keys: 1–128 characters, no control characters, never "__proto__"
// (which would mutate a prototype instead of creating a key).
function validKey(k) {
  if (typeof k !== "string" || k.length === 0 || k.length > 128 || k === "__proto__") return false;
  for (let i = 0; i < k.length; i++) if (k.charCodeAt(i) < 32 || k.charCodeAt(i) === 127) return false;
  return true;
}

function isPrintableAscii(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}

// Deterministic PRNG for backoff jitter: the standard mulberry32 (SPEC §2.7 names the
// same generator for scene3d/film/core/rng.js). This module keeps a local copy so it
// imports nothing from the page tree.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rolling time window of (time, value) entries. Times must be pushed in
// non-decreasing order.
function createWindow(spanMs) {
  let times = [];
  let values = [];
  let head = 0;
  let sum = 0;
  return {
    push(t, v) {
      times.push(t);
      values.push(v);
      sum += v;
    },
    prune(t) {
      const cut = t - spanMs;
      while (head < times.length && times[head] <= cut) {
        sum -= values[head];
        head++;
      }
      if (head === times.length) {
        times = [];
        values = [];
        head = 0;
        sum = 0;
      } else if (head > 1024 && head * 2 > times.length) {
        times = times.slice(head);
        values = values.slice(head);
        head = 0;
      }
    },
    count: () => times.length - head,
    sum: () => (sum > 0 ? sum : 0),
    oldest: () => (head < times.length ? times[head] : null),
    // Milliseconds from t until the windowed sum is ≤ target (null = never).
    timeUntilSumAtMost(target, t) {
      if (!(target >= 0)) return null;
      let s = sum;
      if (s <= target) return 0;
      for (let i = head; i < times.length; i++) {
        s -= values[i];
        if (s <= target + 1e-12) return Math.max(0, times[i] + spanMs - t);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Question builders + validation
// ---------------------------------------------------------------------------

/**
 * Choice question. Put the conservative default option FIRST: JEV has a first-option bias.
 * @param {string} instructions
 * @param {Record<string,string>} criteria option key → spec-like description with explicit boundaries
 * @returns {{type:'choice', instructions:string, criteria:Record<string,string>}}
 */
export function choiceQ(instructions, criteria) {
  return { type: "choice", instructions, criteria: isPlainObject(criteria) ? { ...criteria } : criteria };
}

/**
 * Noul (yes/no) question. The answer is P(yes). Criteria are optional, but when given
 * they need both keys: {true: "when yes", false: "when no"}.
 * @param {string} instructions
 * @param {{true:string, false:string}} [criteria]
 * @returns {{type:'noul', instructions:string, criteria?:{true:string, false:string}}}
 */
export function noulQ(instructions, criteria) {
  const q = { type: "noul", instructions };
  if (criteria != null) q.criteria = isPlainObject(criteria) ? { ...criteria } : criteria;
  return q;
}

/**
 * Score question over 2–10 ordered levels (low → high). The answer is the expected
 * level index: threshold it, never interpolate it.
 * @param {string} instructions
 * @param {string[]} levels
 * @returns {{type:'score', instructions:string, criteria:string[]}}
 */
export function scoreQ(instructions, levels) {
  return { type: "score", instructions, criteria: Array.isArray(levels) ? [...levels] : levels };
}

/**
 * Checks a Decisions-API `questions` object without throwing. Rules: each question
 * is an object with a non-empty `instructions` string. A choice has 2–255 options,
 * each with a non-empty description. A score has an array of 2–10 non-empty level
 * texts. A noul's criteria, when present, have both 'true' and 'false' and nothing
 * else. Ids and option keys are 1–128 printable characters and never "__proto__".
 * @param {unknown} questions
 * @returns {{ok: boolean, issues: string[]}}
 */
export function validateQuestions(questions) {
  const issues = [];
  if (!isPlainObject(questions)) return { ok: false, issues: ["questions must be an object {id: question}"] };
  const ids = Object.keys(questions);
  if (ids.length === 0) issues.push("questions must contain at least one question");
  for (const id of ids) {
    const at = `question ${show(id)}`;
    if (!validKey(id)) {
      issues.push(`${at}: id must be 1–128 printable characters (and not "__proto__")`);
      continue;
    }
    const q = questions[id];
    if (!isPlainObject(q)) {
      issues.push(`${at}: must be an object {type, instructions, criteria}`);
      continue;
    }
    if (!nonEmpty(q.instructions)) issues.push(`${at}: instructions must be a non-empty string`);
    if (q.type === "choice") checkChoice(at, q.criteria, issues);
    else if (q.type === "noul") checkNoul(at, q.criteria, issues);
    else if (q.type === "score") checkScore(at, q.criteria, issues);
    else issues.push(`${at}: type must be 'choice', 'noul' or 'score' (got ${show(q.type)})`);
  }
  return { ok: issues.length === 0, issues };
}

function checkChoice(at, criteria, issues) {
  if (!isPlainObject(criteria)) {
    issues.push(`${at}: choice criteria must be an object {option: description}`);
    return;
  }
  const keys = Object.keys(criteria);
  if (keys.length < JEV_LIMITS.choiceOptionsMin) {
    issues.push(`${at}: choice needs at least ${JEV_LIMITS.choiceOptionsMin} options (has ${keys.length})`);
  }
  if (keys.length > JEV_LIMITS.choiceOptionsMax) {
    issues.push(`${at}: choice allows at most ${JEV_LIMITS.choiceOptionsMax} options (has ${keys.length})`);
  }
  for (const k of keys) {
    if (!validKey(k)) issues.push(`${at}: option key ${show(k)} must be 1–128 printable characters (and not "__proto__")`);
    else if (!nonEmpty(criteria[k])) issues.push(`${at}: option '${k}' needs a non-empty description`);
  }
}

function checkNoul(at, criteria, issues) {
  if (criteria == null) return;
  if (!isPlainObject(criteria)) {
    issues.push(`${at}: noul criteria must be an object {true, false}`);
    return;
  }
  if (!nonEmpty(criteria.true) || !nonEmpty(criteria.false)) {
    issues.push(`${at}: noul criteria need non-empty descriptions for both 'true' and 'false'`);
  }
  const extra = Object.keys(criteria).filter((k) => k !== "true" && k !== "false");
  if (extra.length) issues.push(`${at}: noul criteria allow only 'true' and 'false' (got ${extra.map(show).join(", ")})`);
}

function checkScore(at, criteria, issues) {
  if (!Array.isArray(criteria)) {
    issues.push(`${at}: score criteria must be an array of level descriptions (low → high)`);
    return;
  }
  if (criteria.length < JEV_LIMITS.scoreLevelsMin || criteria.length > JEV_LIMITS.scoreLevelsMax) {
    issues.push(`${at}: score needs ${JEV_LIMITS.scoreLevelsMin}–${JEV_LIMITS.scoreLevelsMax} levels (has ${criteria.length})`);
  }
  criteria.forEach((c, i) => {
    if (!nonEmpty(c)) issues.push(`${at}: score level ${i} needs a non-empty description`);
  });
}

// Copy holding only the contract fields (type, instructions, criteria), so stray
// fields never reach the API. A null noul criteria is treated as absent.
function normalizeQuestions(questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const n = { type: q.type, instructions: q.instructions };
    if (q.type === "choice") n.criteria = { ...q.criteria };
    else if (q.type === "score") n.criteria = [...q.criteria];
    else if (q.criteria != null) n.criteria = { true: q.criteria.true, false: q.criteria.false };
    out[id] = n;
  }
  return out;
}

function stateIssue(state) {
  if (state === undefined || state === null) return "state is required (a string, object or array)";
  if (typeof state === "string") return state.trim() ? null : "state must not be an empty string";
  if (typeof state === "object") return null;
  return `state must be a string, object or array (got ${typeof state})`;
}

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a response's `answers` map against the questions asked.
 * - Every asked id must be present. An answer's `type`, when given, must match the
 *   question; a missing `type` is accepted when the value field is valid.
 * - choice: `choice` must be one of the criteria keys.
 * - score: `score` must lie within 0..levels-1.
 * - noul: `noul` must lie within [0, 1].
 * - probabilities are looked up BY NAME, so the response's key order does not
 *   matter. They are rebuilt in criteria order (score: "0".."n-1"); missing keys
 *   become 0, and the result is normalized to sum to 1 (null when absent or all zero).
 * - confidence: the API's value, else derived from probabilities (choice:
 *   P(choice); score: P(round(score))), else null.
 * - answers for ids that were not asked are ignored.
 * Output shapes:
 *   {type:'choice', choice, confidence, probabilities}
 *   {type:'score', score, confidence, probabilities, legend?}
 *   {type:'noul', noul}
 * @param {unknown} raw the response body's `answers` object
 * @param {Record<string, object>} questions the questions that were sent
 * @returns {Record<string, object>} normalized answers keyed by question id
 * @throws {JevError} 'bad-response' for a malformed answer, 'bad-request' for invalid questions
 */
export function parseAnswers(raw, questions) {
  const v = validateQuestions(questions);
  if (!v.ok) throw new JevError("bad-request", `invalid questions: ${v.issues.join("; ")}`, { issues: v.issues });
  if (!isPlainObject(raw)) throw new JevError("bad-response", "response has no answers object");
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    if (!hasOwn(raw, id) || !isPlainObject(raw[id])) throw new JevError("bad-response", `answer '${id}' is missing`);
    const a = raw[id];
    if (a.type != null && a.type !== q.type) {
      throw new JevError("bad-response", `answer '${id}' has type ${show(a.type)} but the question is '${q.type}'`);
    }
    if (q.type === "choice") out[id] = parseChoice(id, a, q);
    else if (q.type === "score") out[id] = parseScore(id, a, q);
    else out[id] = parseNoul(id, a);
  }
  return out;
}

function unitOrNull(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function normalizeProbabilities(id, p, keys) {
  if (p == null) return null;
  if (!isPlainObject(p)) throw new JevError("bad-response", `answer '${id}': probabilities must be an object`);
  const out = {};
  let sum = 0;
  for (const k of keys) {
    const rawP = hasOwn(p, k) ? p[k] : 0;
    const n = rawP == null ? 0 : Number(rawP);
    if (!Number.isFinite(n) || n < 0) {
      throw new JevError("bad-response", `answer '${id}': probability for '${k}' is not a non-negative number`);
    }
    out[k] = n;
    sum += n;
  }
  if (!(sum > 0)) return null;
  if (Math.abs(sum - 1) > 1e-9) for (const k of keys) out[k] /= sum;
  return out;
}

function parseChoice(id, a, q) {
  if (typeof a.choice !== "string" || !hasOwn(q.criteria, a.choice)) {
    throw new JevError("bad-response", `answer '${id}': choice ${show(a.choice)} is not one of the asked options`);
  }
  const probabilities = normalizeProbabilities(id, a.probabilities, Object.keys(q.criteria));
  let confidence = unitOrNull(a.confidence);
  if (confidence == null && probabilities) confidence = probabilities[a.choice];
  return { type: "choice", choice: a.choice, confidence, probabilities };
}

function parseScore(id, a, q) {
  const n = q.criteria.length;
  const s = a.score == null ? NaN : Number(a.score);
  if (!Number.isFinite(s) || s < -1e-6 || s > n - 1 + 1e-6) {
    throw new JevError("bad-response", `answer '${id}': score ${show(a.score)} is outside 0..${n - 1}`);
  }
  const score = Math.min(n - 1, Math.max(0, s));
  const keys = Array.from({ length: n }, (_, i) => String(i));
  const probabilities = normalizeProbabilities(id, a.probabilities, keys);
  let confidence = unitOrNull(a.confidence);
  if (confidence == null && probabilities) confidence = probabilities[String(Math.round(score))];
  const out = { type: "score", score, confidence, probabilities };
  if (a.legend != null) out.legend = a.legend;
  return out;
}

function parseNoul(id, a) {
  const p = a.noul == null ? NaN : Number(a.noul);
  if (!Number.isFinite(p) || p < -1e-6 || p > 1 + 1e-6) {
    throw new JevError("bad-response", `answer '${id}': noul ${show(a.noul)} is not a probability in [0, 1]`);
  }
  return { type: "noul", noul: Math.min(1, Math.max(0, p)) };
}

/**
 * Log-safe summary of normalized answers: {id: {choice|noul|score, confidence?, top}},
 * where `top` lists the 3 most likely [key, p] pairs. It contains no state.
 * @param {Record<string, object>} answers
 * @returns {Record<string, object>}
 */
export function summarizeAnswers(answers) {
  const out = {};
  if (!isPlainObject(answers)) return out;
  for (const [id, a] of Object.entries(answers)) {
    if (!a || typeof a !== "object") continue;
    let s = null;
    if (a.type === "noul") s = { noul: round4(a.noul) };
    else if (a.type === "choice") s = { choice: a.choice };
    else if (a.type === "score") s = { score: round4(a.score) };
    else continue;
    if (a.confidence != null) s.confidence = round4(a.confidence);
    const top = topProbabilities(a.probabilities, 3);
    if (top) s.top = top;
    out[id] = s;
  }
  return out;
}

function topProbabilities(probs, n) {
  if (!isPlainObject(probs)) return null;
  return Object.entries(probs)
    .map(([k, p], i) => [k, p, i])
    .sort((x, y) => y[1] - x[1] || x[2] - y[2])
    .slice(0, n)
    .map(([k, p]) => [k, round4(p)]);
}

const tokenCount = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Usage → {inputTokens, outputTokens, costUsd}. Uses `usage.cost` when present, else
 * input_tokens × $0.042/M (output is free). A response with no usage at all is
 * charged at `fallbackInputTokens` (the pre-flight estimate) and gets
 * `estimated: true`, so budget caps never under-count.
 * @param {unknown} usage
 * @param {{fallbackInputTokens?: number}} [opts]
 * @returns {{inputTokens:number, outputTokens:number, costUsd:number, estimated?:boolean}}
 */
export function costFromUsage(usage, { fallbackInputTokens = 0 } = {}) {
  if (!isPlainObject(usage)) {
    const inputTokens = tokenCount(fallbackInputTokens);
    return { inputTokens, outputTokens: 0, costUsd: inputTokens * JEV_USD_PER_INPUT_TOKEN, estimated: true };
  }
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const c = usage.cost == null ? NaN : Number(usage.cost);
  const costUsd = Number.isFinite(c) && c >= 0 ? c : inputTokens * JEV_USD_PER_INPUT_TOKEN;
  return { inputTokens, outputTokens, costUsd };
}

/**
 * Retry-After header → milliseconds. Accepts delta-seconds ("2", "1.5") or an HTTP
 * date (relative to nowMs). Returns null when the value is absent or unparseable;
 * past dates give 0.
 * @param {string|null|undefined} value
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t - nowMs);
}

// Pre-flight size estimate. The 32k limit applies per pass (state + one question),
// and is checked at 4 bytes/token. Questions are judged in parallel, each against
// the state, so the conservative COST estimate charges every pass at 3 bytes/token.
function estimateInput(stateStr, questions) {
  const stateBytes = Buffer.byteLength(stateStr, "utf8");
  let maxPassTokens = 0;
  let inputTokens = 0;
  for (const q of Object.values(questions)) {
    const bytes = stateBytes + Buffer.byteLength(JSON.stringify(q), "utf8");
    maxPassTokens = Math.max(maxPassTokens, Math.ceil(bytes / 4));
    inputTokens += Math.ceil(bytes / 3);
  }
  return { maxPassTokens, inputTokens };
}

function safeMetadata(meta) {
  if (!isPlainObject(meta)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "flagged_input") continue; // a moderation echo of our input, which is the state
    out[k] = typeof v === "string" ? clip(v, 200) : v;
  }
  return out;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * Creates a JEV Decisions-API client.
 *
 * decide({state, questions, sessionId?, trace?, model?, timeoutMs?, maxRetries?})
 *   → Promise<{id, model, answers, usage:{inputTokens, outputTokens, costUsd}, ms, attempts}>
 *   `ms` is the wall time of the whole call, including retries. `timeoutMs` and
 *   `maxRetries` override the client defaults for one call (the page broker uses
 *   them so realtime pilot calls fail fast).
 *   Throws JevError:
 *   - questions or state invalid → 'bad-request', and no request is sent
 *   - state + longest question over 32k tokens → 'too-large', no request sent
 *   - over budget → 'budget', no request sent
 *   - client closed → 'config'
 *   - HTTP and network failures → mapped kinds, after retries on
 *     429/5xx/524/529/network/timeout
 *   - malformed response → 'bad-response'
 *   Before every attempt (retries included) the client checks the budget:
 *   calls/minute counts HTTP attempts; $/hour sums the reported cost of
 *   successful calls plus a pre-flight estimate for this one.
 * stats() → {calls, errors, retries, refused, inputTokens, outputTokens, costUsd,
 *   lastMinuteCalls, lastHourCostUsd, inFlight, errorsByKind, closed}
 *   - calls: decide() calls that succeeded
 *   - errors: decide() calls that threw (refused = budget refusals among them)
 *   - lastMinuteCalls: HTTP attempts in the rolling minute
 * close(): aborts in-flight requests and pending backoffs (they reject with
 *   'config'); later decide() calls reject without a request.
 *
 * Retry delay: min(maxBackoffMs, backoffMs·2^(n−1)) · (0.5 + 0.5·rng()), which is
 * deterministic for a given `seed`/`rng`. When the server sends Retry-After, the
 * delay is at least that value; if Retry-After exceeds maxRetryAfterMs, the call
 * stops retrying and throws, carrying `retryAfterMs`.
 *
 * @param {object} opts
 * @param {string} opts.apiKey OpenRouter key (see resolveJevKey); required
 * @param {string} [opts.model='typesafe/jev-1.13']
 * @param {string} [opts.endpoint='https://openrouter.ai/api/alpha/decisions']
 * @param {Function} [opts.fetchFn=globalThis.fetch]
 * @param {number} [opts.timeoutMs=4000] per HTTP attempt
 * @param {number} [opts.maxRetries=2] retries after the first attempt
 * @param {number} [opts.backoffMs=250] first retry's base delay
 * @param {number} [opts.maxBackoffMs=8000]
 * @param {number} [opts.maxRetryAfterMs=10000]
 * @param {{maxUsdPerHour?: number, maxCallsPerMin?: number}} [opts.budget] defaults 2 USD/h, 600 calls/min
 * @param {string} [opts.sessionId] default session_id (≤256 chars)
 * @param {string} [opts.title='holtburger-film'] X-Title header
 * @param {string} [opts.referer] HTTP-Referer header
 * @param {string} [opts.user] OpenRouter `user` passthrough
 * @param {object} [opts.provider] OpenRouter provider routing passthrough
 * @param {(entry: object) => void} [opts.log] structured log sink (never sees state or key)
 * @param {() => number} [opts.now=Date.now] injectable clock (budget windows, ms)
 * @param {(ms: number) => Promise<void>} [opts.sleep] injectable backoff sleep
 * @param {() => number} [opts.rng] jitter source in [0, 1); default mulberry32(seed)
 * @param {number} [opts.seed=0x5eed1e57]
 * @param {number} [opts.maxInputTokens=32000]
 * @returns {{decide: Function, stats: Function, close: Function, model: string, endpoint: string}}
 */
export function createJevClient(opts = {}) {
  const {
    apiKey,
    model = JEV_MODEL,
    endpoint = JEV_ENDPOINT,
    fetchFn = globalThis.fetch,
    timeoutMs = 4000,
    maxRetries = 2,
    backoffMs = 250,
    maxBackoffMs = 8000,
    maxRetryAfterMs = 10_000,
    budget,
    sessionId,
    title = "holtburger-film",
    referer,
    user,
    provider,
    log,
    now = () => Date.now(),
    sleep = defaultSleep,
    rng,
    seed = 0x5eed1e57,
    maxInputTokens = JEV_LIMITS.inputTokensMax,
  } = opts ?? {};

  const config = (msg) => new JevError("config", msg);
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw config("no OpenRouter API key: set OPENROUTER_API_KEY or create ~/.config/holtburger-film/openrouter.key (chmod 600)");
  }
  const key = apiKey.trim();
  if (!isPrintableAscii(key) || /\s/.test(key)) throw config("the OpenRouter API key contains whitespace or non-printable characters");
  if (typeof fetchFn !== "function") throw config("fetchFn must be a function (Node 20 provides global fetch)");
  try {
    new URL(endpoint);
  } catch {
    throw config(`endpoint is not a valid URL: ${show(endpoint)}`);
  }
  if (!nonEmpty(model)) throw config("model must be a non-empty string");
  if (!(typeof timeoutMs === "number" && timeoutMs > 0)) throw config("timeoutMs must be a positive number");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw config("maxRetries must be a non-negative integer");
  if (!(typeof backoffMs === "number" && backoffMs >= 0)) throw config("backoffMs must be a non-negative number");
  if (!(typeof maxBackoffMs === "number" && maxBackoffMs >= 0)) throw config("maxBackoffMs must be a non-negative number");
  if (!(typeof maxRetryAfterMs === "number" && maxRetryAfterMs >= 0)) throw config("maxRetryAfterMs must be a non-negative number");
  const maxUsdPerHour = budget?.maxUsdPerHour ?? 2;
  const maxCallsPerMin = budget?.maxCallsPerMin ?? 600;
  if (!(typeof maxUsdPerHour === "number" && maxUsdPerHour >= 0)) throw config("budget.maxUsdPerHour must be a number ≥ 0");
  if (!(typeof maxCallsPerMin === "number" && maxCallsPerMin >= 0)) throw config("budget.maxCallsPerMin must be a number ≥ 0");
  if (sessionId != null && (!nonEmpty(sessionId) || sessionId.length > JEV_LIMITS.sessionIdMax)) {
    throw config(`sessionId must be a non-empty string of at most ${JEV_LIMITS.sessionIdMax} characters`);
  }
  if (title != null && (typeof title !== "string" || !isPrintableAscii(title))) throw config("title must be printable ASCII");
  if (referer != null && (typeof referer !== "string" || !isPrintableAscii(referer))) throw config("referer must be printable ASCII");
  if (user != null && !nonEmpty(user)) throw config("user must be a non-empty string");
  if (provider != null && !isPlainObject(provider)) throw config("provider must be an object");
  if (log != null && typeof log !== "function") throw config("log must be a function");
  if (typeof now !== "function" || typeof sleep !== "function") throw config("now and sleep must be functions");
  if (!(typeof maxInputTokens === "number" && maxInputTokens > 0)) throw config("maxInputTokens must be a positive number");
  const rand = typeof rng === "function" ? rng : mulberry32(seed);

  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (nonEmpty(title)) headers["X-Title"] = title;
  if (nonEmpty(referer)) headers["HTTP-Referer"] = referer;

  let closed = false;
  let pending = 0;
  let wake;
  const closedPromise = new Promise((resolve) => {
    wake = resolve;
  });
  const inflight = new Set();
  const minuteCalls = createWindow(MINUTE_MS);
  const hourCost = createWindow(HOUR_MS);
  const totals = { calls: 0, errors: 0, retries: 0, refused: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const errorsByKind = {};

  const emit = (entry) => {
    if (!log) return;
    try {
      log(entry);
    } catch {
      // A broken log sink must never break a decision.
    }
  };

  function checkBudget(estCostUsd) {
    const t = now();
    minuteCalls.prune(t);
    hourCost.prune(t);
    const calls = minuteCalls.count();
    if (calls + 1 > maxCallsPerMin) {
      const oldest = minuteCalls.oldest();
      throw new JevError("budget", `JEV budget: ${calls} calls in the last minute; the cap is ${maxCallsPerMin}/min`, {
        code: "calls-per-minute",
        retryable: false,
        retryAfterMs: oldest == null ? null : Math.max(0, oldest + MINUTE_MS - t),
      });
    }
    const spent = hourCost.sum();
    if (spent + estCostUsd > maxUsdPerHour) {
      throw new JevError(
        "budget",
        `JEV budget: $${spent.toFixed(6)} spent in the last hour + ≈$${estCostUsd.toFixed(6)} for this call would exceed the $${maxUsdPerHour}/hour cap`,
        { code: "usd-per-hour", retryable: false, retryAfterMs: hourCost.timeUntilSumAtMost(maxUsdPerHour - estCostUsd, t) },
      );
    }
  }

  function retryDelay(attempt, retryAfterMs) {
    let d = Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1)) * (0.5 + 0.5 * rand());
    if (retryAfterMs != null) {
      if (retryAfterMs > maxRetryAfterMs) return null;
      d = Math.max(d, retryAfterMs);
    }
    return Math.round(d);
  }

  async function attemptOnce(bodyStr, attemptTimeoutMs) {
    const ctrl = new AbortController();
    inflight.add(ctrl);
    // Races fetch AND the body read against the abort, so a fetch implementation
    // that ignores `signal` still cannot hang a call past its timeout or close().
    const aborted = new Promise((_, reject) => {
      ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    const timer = setTimeout(() => {
      ctrl.abort(new JevError("timeout", `no response within ${attemptTimeoutMs} ms`));
    }, attemptTimeoutMs);
    try {
      const res = await Promise.race([
        fetchFn(endpoint, { method: "POST", headers, body: bodyStr, signal: ctrl.signal }),
        aborted,
      ]);
      const text = await Promise.race([Promise.resolve().then(() => res.text()), aborted]);
      return {
        status: Number(res.status),
        text: typeof text === "string" ? text : String(text ?? ""),
        retryAfter: readHeader(res.headers, "retry-after"),
      };
    } catch (e) {
      if (e instanceof JevError) throw e;
      const reason = ctrl.signal.aborted ? ctrl.signal.reason : null;
      if (reason instanceof JevError) throw reason;
      const sysCode = e?.cause?.code ?? e?.code ?? null;
      throw new JevError("network", `network error: ${clip(sysCode ?? e?.message ?? String(e), 160)}`, {
        code: sysCode,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
      inflight.delete(ctrl);
    }
  }

  function interpret(res, questions, requestedModel, estInputTokens) {
    const { status, text, retryAfter } = res;
    let data;
    let parsed = false;
    if (text) {
      try {
        data = JSON.parse(text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    const errBody = parsed && isPlainObject(data) && isPlainObject(data.error) ? data.error : null;
    const okStatus = status >= 200 && status <= 299;
    if (!okStatus || errBody) {
      let eff = status;
      if (okStatus) {
        // A 2xx carrying {error}: use its code when it is an HTTP status, else treat as upstream failure.
        const c = Number(errBody.code);
        eff = Number.isInteger(c) && c >= 400 && c <= 599 ? c : 502;
      }
      const { kind, retryable } = kindForStatus(eff);
      const apiMsg = errBody && typeof errBody.message === "string" ? errBody.message : parsed ? "" : text;
      const codeNote = errBody?.code != null && String(errBody.code) !== String(eff) ? ` (${clip(String(errBody.code), 40)})` : "";
      throw new JevError(kind, `HTTP ${eff}${codeNote}: ${clip(apiMsg || "no error message", 300)}`, {
        status: eff,
        code: errBody?.code ?? eff,
        retryable,
        retryAfterMs: parseRetryAfter(retryAfter, now()),
        metadata: safeMetadata(errBody?.metadata),
      });
    }
    if (!parsed || !isPlainObject(data)) {
      throw new JevError("bad-response", `response body is not a JSON object: ${clip(text, 160)}`, { status });
    }
    const answers = parseAnswers(data.answers, questions);
    const usage = costFromUsage(data.usage, { fallbackInputTokens: estInputTokens });
    return {
      id: data.id == null ? null : String(data.id),
      model: nonEmpty(data.model) ? data.model : requestedModel,
      answers,
      usage,
    };
  }

  /**
   * One typed decision. See createJevClient for the full contract.
   * @param {{state: string|object|unknown[], questions: Record<string, object>, sessionId?: string,
   *   trace?: object, model?: string, timeoutMs?: number, maxRetries?: number}} req
   * @returns {Promise<{id: string|null, model: string, answers: Record<string, object>,
   *   usage: {inputTokens: number, outputTokens: number, costUsd: number}, ms: number, attempts: number}>}
   */
  async function decide(reqIn) {
    const t0 = now();
    const req = isPlainObject(reqIn) ? reqIn : {};
    const { state, questions } = req;
    const qids = isPlainObject(questions) ? Object.keys(questions).slice(0, 64) : [];
    let attempts = 0;
    pending++;
    try {
      if (closed) throw new JevError("config", "the JEV client is closed");
      const vq = validateQuestions(questions);
      if (!vq.ok) throw new JevError("bad-request", `invalid questions: ${vq.issues.join("; ")}`, { issues: vq.issues });
      const si = stateIssue(state);
      if (si) throw new JevError("bad-request", si);
      const useModel = req.model ?? model;
      if (!nonEmpty(useModel)) throw new JevError("bad-request", "model must be a non-empty string");
      const sid = req.sessionId ?? sessionId;
      if (sid != null && (!nonEmpty(sid) || sid.length > JEV_LIMITS.sessionIdMax)) {
        throw new JevError("bad-request", `session_id must be a non-empty string of at most ${JEV_LIMITS.sessionIdMax} characters`);
      }
      if (req.trace != null && !isPlainObject(req.trace)) throw new JevError("bad-request", "trace must be an object");
      const attemptTimeoutMs = req.timeoutMs ?? timeoutMs;
      const retriesAllowed = req.maxRetries ?? maxRetries;
      if (!(typeof attemptTimeoutMs === "number" && attemptTimeoutMs > 0)) throw new JevError("config", "timeoutMs must be a positive number");
      if (!Number.isInteger(retriesAllowed) || retriesAllowed < 0) throw new JevError("config", "maxRetries must be a non-negative integer");

      const normQ = normalizeQuestions(questions);
      const body = { model: useModel, state, questions: normQ };
      if (sid != null) body.session_id = sid;
      if (req.trace != null) body.trace = req.trace;
      if (user != null) body.user = user;
      if (provider != null) body.provider = provider;
      let bodyStr;
      let stateStr;
      try {
        bodyStr = JSON.stringify(body);
        stateStr = typeof state === "string" ? state : JSON.stringify(state);
      } catch (e) {
        throw new JevError("bad-request", `the request is not JSON-serialisable: ${clip(e?.message, 120)}`);
      }
      const est = estimateInput(stateStr, normQ);
      if (est.maxPassTokens > maxInputTokens) {
        throw new JevError("too-large", `state + longest question ≈ ${est.maxPassTokens} tokens exceeds the ${maxInputTokens}-token limit`);
      }
      const estCostUsd = est.inputTokens * JEV_USD_PER_INPUT_TOKEN;

      for (;;) {
        checkBudget(estCostUsd);
        attempts++;
        minuteCalls.push(now(), 1);
        try {
          const res = await attemptOnce(bodyStr, attemptTimeoutMs);
          const out = interpret(res, normQ, useModel, est.inputTokens);
          const tDone = now();
          totals.calls++;
          totals.inputTokens += out.usage.inputTokens;
          totals.outputTokens += out.usage.outputTokens;
          totals.costUsd += out.usage.costUsd;
          hourCost.push(tDone, out.usage.costUsd);
          const ms = Math.max(0, tDone - t0);
          emit({
            event: "jev",
            id: out.id,
            model: out.model,
            questions: qids,
            answers: summarizeAnswers(out.answers),
            ms,
            costUsd: out.usage.costUsd,
            attempts,
          });
          return { id: out.id, model: out.model, answers: out.answers, usage: out.usage, ms, attempts };
        } catch (e) {
          const err = e instanceof JevError ? e : new JevError("bad-response", `unexpected failure: ${clip(e?.message ?? String(e), 160)}`, { cause: e });
          if (closed) throw err.kind === "config" ? err : new JevError("config", "the JEV client is closed", { cause: err });
          if (!err.retryable || attempts > retriesAllowed) throw err;
          const delay = retryDelay(attempts, err.retryAfterMs ?? null);
          if (delay == null) throw err;
          totals.retries++;
          emit({ event: "jev-retry", kind: err.kind, status: err.status, attempt: attempts, delayMs: delay, questions: qids });
          await Promise.race([sleep(delay), closedPromise]);
          if (closed) throw new JevError("config", "the JEV client is closed");
        }
      }
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError("bad-response", `unexpected failure: ${clip(e?.message ?? String(e), 160)}`, { cause: e });
      err.attempts = attempts;
      totals.errors++;
      errorsByKind[err.kind] = (errorsByKind[err.kind] ?? 0) + 1;
      if (err.kind === "budget") totals.refused++;
      emit({
        event: err.kind === "budget" ? "jev-budget" : "jev-error",
        kind: err.kind,
        status: err.status,
        code: err.code,
        message: clip(err.message, 240),
        questions: qids,
        attempts,
        ms: Math.max(0, now() - t0),
      });
      throw err;
    } finally {
      pending--;
    }
  }

  /** Counters + rolling budget windows (see createJevClient). */
  function stats() {
    const t = now();
    minuteCalls.prune(t);
    hourCost.prune(t);
    return {
      calls: totals.calls,
      errors: totals.errors,
      retries: totals.retries,
      refused: totals.refused,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
      lastMinuteCalls: minuteCalls.count(),
      lastHourCostUsd: hourCost.sum(),
      inFlight: pending,
      errorsByKind: { ...errorsByKind },
      closed,
    };
  }

  /** Aborts in-flight requests and backoffs; later decide() calls reject with 'config'. Idempotent. */
  function close() {
    if (closed) return;
    closed = true;
    wake();
    for (const ctrl of inflight) {
      try {
        ctrl.abort(new JevError("config", "the JEV client is closed"));
      } catch {
        // already aborted
      }
    }
  }

  return Object.freeze({ decide, stats, close, model, endpoint });
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Finds the OpenRouter key: env OPENROUTER_API_KEY, then OPENROUTER_KEY (empty or
 * whitespace-only values are skipped), then ~/.config/holtburger-film/openrouter.key.
 * The key file must be a regular file (symlinks are followed) with no group/other
 * permission bits (mode & 0o077 === 0); its first non-empty line, trimmed, is the key.
 * Returns {key: null, source: null} when nothing is configured. With no key, the
 * pilot flies on its code policy and the planning tasks use their code fallbacks.
 * Never prints the key; use redactKey for diagnostics.
 * @param {{env?: Record<string, string|undefined>, home?: string, fs?: {statSync: Function, readFileSync: Function}, keyFile?: string}} [opts]
 * @returns {{key: string|null, source: string|null, checked: string[]}} source is
 *   'env:OPENROUTER_API_KEY' | 'env:OPENROUTER_KEY' | 'file:<path>' | null
 * @throws {JevError} kind 'config' when the key file exists but is unsafe, unreadable or empty
 */
export function resolveJevKey({ env = process.env, home = os.homedir(), fs = nodeFs, keyFile } = {}) {
  const checked = [];
  for (const name of JEV_KEY_ENV_VARS) {
    checked.push(`env:${name}`);
    const v = env?.[name];
    if (typeof v === "string" && v.trim()) return { key: v.trim(), source: `env:${name}`, checked };
  }
  const file = keyFile ?? path.join(home ?? "", JEV_KEY_FILE);
  checked.push(`file:${file}`);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { key: null, source: null, checked };
    throw new JevError("config", `cannot stat the JEV key file ${file}: ${e?.code ?? e?.message ?? e}`, { cause: e });
  }
  if (!st.isFile()) throw new JevError("config", `the JEV key file ${file} is not a regular file`);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new JevError(
      "config",
      `the JEV key file ${file} is readable by group/others (mode ${mode.toString(8).padStart(3, "0")}); fix it with: chmod 600 ${file}`,
      { code: "insecure-key-file" },
    );
  }
  let text;
  try {
    text = String(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new JevError("config", `cannot read the JEV key file ${file}: ${e?.code ?? e?.message ?? e}`, { cause: e });
  }
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!line) throw new JevError("config", `the JEV key file ${file} is empty`);
  return { key: line, source: `file:${file}`, checked };
}

/**
 * Diagnostic form of a key: its first 6 characters + "…" ("sk-or-…" for OpenRouter
 * keys), showing at most a third of a short key; "(none)" for no key.
 * @param {string|null|undefined} key
 * @returns {string}
 */
export function redactKey(key) {
  if (typeof key !== "string" || key.length === 0) return "(none)";
  return `${key.slice(0, Math.min(6, Math.floor(key.length / 3)))}…`;
}
