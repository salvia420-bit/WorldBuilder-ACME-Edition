// tests/film_jev_client.test.mjs
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) uses JEV (TypeSafe's System-One
// typed-decision model on the OpenRouter Decisions API) as the camera's real-time
// reflexes and for a few planning decisions. JEV is the ONLY metered API in film
// mode and its key lives only in Node, so tools/film/lib/jev.mjs owns every
// safeguard. This suite pins that client to the verified API contract
// (docs/film-mode-2026-10-13/research_jev.md §2, scene3d/film/SPEC.md §5):
//   J1 question builders + validateQuestions (types, criteria shapes, 2–255 choice
//      options, 2–10 score levels, noul criteria both keys, non-empty instructions)
//   J2 parseAnswers (all three answer types, probabilities looked up BY NAME in any
//      key order, normalisation, missing/mismatched answers → bad-response),
//      costFromUsage, parseRetryAfter, kindForStatus, summarizeAnswers
//   J3 the HTTP client against an in-process mock server on 127.0.0.1:0: exact
//      URL / method / headers / body keys, the parsed result, log lines that never
//      carry the state or the key
//   J4 error kinds: 400/401/402/403/404/413 (no retry), 429 + Retry-After (seconds
//      and HTTP date) then success, 500 then success, 502/503/524/529, a 2xx error
//      body, malformed JSON, a missing answer id, timeout (hanging handler),
//      network (closed port), deterministic jitter, close()
//   J5 budget: calls/minute and $/hour caps refuse with kind 'budget' WITHOUT a
//      network call; in-flight calls reserve their estimated cost
//   J6 resolveJevKey precedence + key-file mode check, redactKey
// No real network call is ever made (no key exists here): every request goes to
// the local mock server, a closed local port, or an injected fetchFn.
//
// Run from apps/holtburger-web/: node tests/film_jev_client.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_USD_PER_INPUT_TOKEN,
  JevError,
  choiceQ,
  costFromUsage,
  createJevClient,
  kindForStatus,
  noulQ,
  parseAnswers,
  parseRetryAfter,
  redactKey,
  resolveJevKey,
  scoreQ,
  summarizeAnswers,
  validateQuestions,
} from "../tools/film/lib/jev.mjs";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e?.message ?? e}`);
  }
}

async function expectJevError(promiseOrFn, kind) {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    assert.ok(e instanceof JevError, `expected a JevError, got ${e?.name}: ${e?.message}`);
    assert.equal(e.kind, kind, `kind (message: ${e.message})`);
    return e;
  }
  assert.fail(`expected JevError '${kind}', but the call succeeded`);
}

const KEY = "sk-or-v1-TESTKEY-0123456789abcdef0123456789abcdef";
const STATE_MARKER = "STATE-MARKER-7f3a";
const STATE = {
  standing_order: `Hold the statue in frame. ${STATE_MARKER}`,
  obstacles: { ahead: "near tree", left: "clear" },
  free_space: { level_ahead: "near", above_ahead: "clear" },
};
const Q = {
  maneuver: choiceQ("Pick the camera maneuver for the next second.", {
    hold_path: "keep the planned path: obstacles.ahead is 'medium', 'far' or 'clear'",
    rise: "rise: free_space.above_ahead is at least 2 buckets farther than free_space.level_ahead",
    back_off: "back off: obstacles.ahead is 'touching' or 'very close'",
  }),
  subject_lost: noulQ("Is the subject truly lost (not just briefly hidden)?", {
    true: "subject.unseen_for is 'a while' or 'long'",
    false: "subject.unseen_for is 'not hidden' or 'brief'",
  }),
  risk: scoreQ("How close is the camera to hitting something?", ["open", "tight but manageable", "about to hit"]),
};
const GOOD_RESPONSE = {
  id: "gen-dec-123",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    // Deliberately NOT in question order, and probabilities in arbitrary key order.
    risk: { type: "score", score: 0.4, confidence: 0.65, probabilities: { 2: 0.05, 0: 0.65, 1: 0.3 }, legend: { 0: "open" } },
    maneuver: { type: "choice", choice: "rise", confidence: 0.82, probabilities: { back_off: 0.08, rise: 0.82, hold_path: 0.1 } },
    subject_lost: { type: "noul", noul: 0.12 },
  },
  usage: { input_tokens: 1000, output_tokens: 3, cost: 0.000042 },
};

// Answers every asked question (first option / P=0.9 / level 0) with the given usage.
function autoAnswers(questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions ?? {})) {
    if (q.type === "choice") out[id] = { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9 };
    else if (q.type === "noul") out[id] = { type: "noul", noul: 0.9 };
    else out[id] = { type: "score", score: 0, confidence: 0.9 };
  }
  return out;
}
const autoOk = (usage = { input_tokens: 100, output_tokens: 1, cost: 0.0000042 }) => ({
  status: 200,
  body: (reqBody) => ({ id: "gen-auto", model: "typesafe/jev-1.13-20260917", answers: autoAnswers(reqBody?.questions), usage }),
});

// ---------------------------------------------------------------------------
// Mock Decisions API server (in-process, 127.0.0.1:0)
// ---------------------------------------------------------------------------
const srv = { queue: [], requests: [], hits: 0 };
const server = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    srv.hits++;
    let body = null;
    try {
      body = JSON.parse(buf);
    } catch {
      body = null;
    }
    srv.requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    // Steps are consumed in order; the last one repeats.
    const step = srv.queue.length > 1 ? srv.queue.shift() : srv.queue[0];
    if (!step || step === "hang") return; // never respond: the client timeout must fire
    const payload = typeof step.body === "function" ? step.body(body) : step.body;
    res.writeHead(step.status ?? 200, { "Content-Type": "application/json", ...(step.headers ?? {}) });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
});
function script(...steps) {
  srv.queue = steps;
  srv.requests = [];
  srv.hits = 0;
}
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ENDPOINT = `http://127.0.0.1:${server.address().port}/api/alpha/decisions`;

const sleeps = [];
const fastSleep = (ms) => {
  sleeps.push(ms);
  return Promise.resolve();
};
function mkClient(extra = {}) {
  return createJevClient({ apiKey: KEY, endpoint: ENDPOINT, sleep: fastSleep, timeoutMs: 2000, ...extra });
}

const allLogs = [];
const allErrors = [];

try {
  // -------------------------------------------------------------------------
  console.log("-- J1 builders + validateQuestions ----------------------------------");

  await check("constants: pinned model, endpoint, $0.042 per 1M input tokens", () => {
    assert.equal(JEV_MODEL, "typesafe/jev-1.13");
    assert.equal(JEV_ENDPOINT, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(JEV_USD_PER_INPUT_TOKEN, 0.042e-6);
  });

  await check("builders produce the Decisions-API question shapes (criteria copied)", () => {
    const crit = { a: "first", b: "second" };
    const c = choiceQ("pick", crit);
    assert.deepEqual(c, { type: "choice", instructions: "pick", criteria: { a: "first", b: "second" } });
    assert.notEqual(c.criteria, crit);
    assert.deepEqual(noulQ("yes?"), { type: "noul", instructions: "yes?" });
    assert.deepEqual(noulQ("yes?", { true: "t", false: "f" }), { type: "noul", instructions: "yes?", criteria: { true: "t", false: "f" } });
    const levels = ["lo", "hi"];
    const s = scoreQ("rate", levels);
    assert.deepEqual(s, { type: "score", instructions: "rate", criteria: ["lo", "hi"] });
    assert.notEqual(s.criteria, levels);
  });

  await check("validateQuestions accepts all three types and the 255-option / 2- and 10-level edges", () => {
    assert.deepEqual(validateQuestions(Q), { ok: true, issues: [] });
    const many = {};
    for (let i = 0; i < 255; i++) many[`o${i}`] = `option ${i}`;
    const tenLevels = Array.from({ length: 10 }, (_, i) => `level ${i}`);
    const v = validateQuestions({ c: choiceQ("x", many), s2: scoreQ("x", ["a", "b"]), s10: scoreQ("x", tenLevels), n: noulQ("x") });
    assert.equal(v.ok, true, v.issues.join("; "));
  });

  await check("validateQuestions rejects bad shapes with one readable issue each", () => {
    const tooMany = {};
    for (let i = 0; i < 256; i++) tooMany[`o${i}`] = `option ${i}`;
    const bad = [
      [null, /object/],
      [[], /object/],
      [{}, /at least one/],
      [{ q: { type: "rank", instructions: "x", criteria: {} } }, /type must be/],
      [{ q: { type: "noul", instructions: "  " } }, /instructions/],
      [{ q: { type: "noul" } }, /instructions/],
      [{ q: choiceQ("x", { only: "one" }) }, /at least 2 options/],
      [{ q: choiceQ("x", tooMany) }, /at most 255/],
      [{ q: choiceQ("x", ["a", "b"]) }, /choice criteria must be an object/],
      [{ q: choiceQ("x", { a: "fine", b: "" }) }, /non-empty description/],
      [{ q: scoreQ("x", ["one"]) }, /2–10 levels/],
      [{ q: scoreQ("x", Array.from({ length: 11 }, (_, i) => `l${i}`)) }, /2–10 levels/],
      [{ q: { type: "score", instructions: "x", criteria: { 0: "a", 1: "b" } } }, /must be an array/],
      [{ q: scoreQ("x", ["a", ""]) }, /level 1/],
      [{ q: noulQ("x", { true: "yes" }) }, /both 'true' and 'false'/],
      [{ q: noulQ("x", { true: "yes", false: "no", maybe: "?" }) }, /only 'true' and 'false'/],
      [{ q: { type: "noul", instructions: "x", criteria: "yes" } }, /noul criteria must be an object/],
      [{ q: "not a question" }, /must be an object/],
      [JSON.parse('{"__proto__": {"type": "noul", "instructions": "x"}}'), /__proto__/],
      [{ "": noulQ("x") }, /id must be/],
    ];
    for (const [qs, re] of bad) {
      const v = validateQuestions(qs);
      assert.equal(v.ok, false, `accepted ${JSON.stringify(qs)?.slice(0, 80)}`);
      assert.ok(v.issues.some((s) => re.test(s)), `issues ${JSON.stringify(v.issues)} do not match ${re}`);
    }
  });

  // -------------------------------------------------------------------------
  console.log("-- J2 parseAnswers + helpers ----------------------------------------");

  await check("parseAnswers: choice/score/noul, probabilities by name in criteria order", () => {
    const a = parseAnswers(GOOD_RESPONSE.answers, Q);
    assert.deepEqual(Object.keys(a), ["maneuver", "subject_lost", "risk"]);
    assert.equal(a.maneuver.type, "choice");
    assert.equal(a.maneuver.choice, "rise");
    assert.equal(a.maneuver.confidence, 0.82);
    assert.deepEqual(Object.keys(a.maneuver.probabilities), ["hold_path", "rise", "back_off"]);
    assert.deepEqual(a.maneuver.probabilities, { hold_path: 0.1, rise: 0.82, back_off: 0.08 });
    assert.deepEqual(a.subject_lost, { type: "noul", noul: 0.12 });
    assert.equal(a.risk.type, "score");
    assert.equal(a.risk.score, 0.4);
    assert.equal(a.risk.confidence, 0.65);
    assert.deepEqual(Object.keys(a.risk.probabilities), ["0", "1", "2"]);
    assert.deepEqual(a.risk.probabilities, { 0: 0.65, 1: 0.3, 2: 0.05 });
    assert.deepEqual(a.risk.legend, { 0: "open" });
  });

  await check("parseAnswers: normalises probabilities, derives confidence, fills missing keys with 0", () => {
    const a = parseAnswers(
      {
        maneuver: { choice: "hold_path", probabilities: { hold_path: 1.2, back_off: 0.8 } }, // no type, sums to 2
        subject_lost: { type: "noul", noul: 1 },
        risk: { type: "score", score: 1.6, probabilities: { 1: 0.3, 2: 0.7 } }, // no confidence
      },
      Q,
    );
    assert.deepEqual(a.maneuver.probabilities, { hold_path: 0.6, rise: 0, back_off: 0.4 });
    assert.equal(a.maneuver.confidence, 0.6);
    assert.equal(a.risk.confidence, 0.7, "score confidence = P(round(score))");
    const none = parseAnswers({ ...GOOD_RESPONSE.answers, maneuver: { type: "choice", choice: "rise" } }, Q);
    assert.equal(none.maneuver.confidence, null);
    assert.equal(none.maneuver.probabilities, null);
  });

  await check("parseAnswers: malformed answers → bad-response; unasked ids ignored", () => {
    const base = GOOD_RESPONSE.answers;
    const cases = [
      [{ maneuver: base.maneuver, risk: base.risk }, /subject_lost/],
      [{ ...base, maneuver: { type: "choice", choice: "dive" } }, /not one of the asked options/],
      [{ ...base, maneuver: { type: "noul", noul: 0.5 } }, /type/],
      [{ ...base, risk: { type: "score", score: 2.5 } }, /outside 0..2/],
      [{ ...base, risk: { type: "score", score: "high" } }, /outside/],
      [{ ...base, subject_lost: { type: "noul", noul: 1.4 } }, /probability/],
      [{ ...base, maneuver: { type: "choice", choice: "rise", probabilities: { rise: -1 } } }, /non-negative/],
      [null, /no answers/],
    ];
    for (const [raw, re] of cases) {
      assert.throws(() => parseAnswers(raw, Q), (e) => e instanceof JevError && e.kind === "bad-response" && re.test(e.message));
    }
    const extra = parseAnswers({ ...base, bonus: { type: "noul", noul: 1 } }, Q);
    assert.equal("bonus" in extra, false);
  });

  await check("costFromUsage: usage.cost wins, else input_tokens × 0.042e-6, else the estimate", () => {
    assert.deepEqual(costFromUsage({ input_tokens: 1000, output_tokens: 5, cost: 0.5 }), { inputTokens: 1000, outputTokens: 5, costUsd: 0.5 });
    const c = costFromUsage({ input_tokens: 1_000_000, output_tokens: 7 });
    assert.equal(c.inputTokens, 1_000_000);
    assert.ok(Math.abs(c.costUsd - 0.042) < 1e-12);
    const est = costFromUsage(undefined, { fallbackInputTokens: 500 });
    assert.equal(est.estimated, true);
    assert.ok(Math.abs(est.costUsd - 500 * 0.042e-6) < 1e-15);
    const blank = costFromUsage({ output_tokens: 2 }, { fallbackInputTokens: 500 });
    assert.equal(blank.estimated, true, "a usage object without cost or input_tokens is never free");
    assert.equal(blank.inputTokens, 500);
  });

  await check("parseRetryAfter: delta-seconds, HTTP date, past date, garbage", () => {
    const T = Date.UTC(2026, 9, 13, 12, 0, 0);
    assert.equal(parseRetryAfter("2", T), 2000);
    assert.equal(parseRetryAfter("1.5", T), 1500);
    assert.equal(parseRetryAfter(new Date(T + 7000).toUTCString(), T), 7000);
    assert.equal(parseRetryAfter(new Date(T - 7000).toUTCString(), T), 0);
    assert.equal(parseRetryAfter("soon", T), null);
    assert.equal(parseRetryAfter(null, T), null);
    assert.equal(parseRetryAfter("", T), null);
  });

  await check("kindForStatus maps every documented status", () => {
    const table = {
      400: ["bad-request", false], 401: ["auth", false], 402: ["credits", false], 403: ["forbidden", false],
      404: ["not-found", false], 413: ["too-large", false], 429: ["rate", true], 500: ["server", true],
      502: ["server", true], 503: ["server", true], 524: ["server", true], 529: ["server", true],
      418: ["bad-request", false],
    };
    for (const [s, [kind, retryable]] of Object.entries(table)) {
      assert.deepEqual(kindForStatus(Number(s)), { kind, retryable }, `status ${s}`);
    }
  });

  await check("summarizeAnswers: value, confidence and the top-3 probabilities only", () => {
    const sum = summarizeAnswers(parseAnswers(GOOD_RESPONSE.answers, Q));
    assert.deepEqual(sum.maneuver, { choice: "rise", confidence: 0.82, top: [["rise", 0.82], ["hold_path", 0.1], ["back_off", 0.08]] });
    assert.deepEqual(sum.subject_lost, { noul: 0.12 });
    assert.equal(sum.risk.score, 0.4);
    assert.deepEqual(sum.risk.top[0], ["0", 0.65]);
  });

  // -------------------------------------------------------------------------
  console.log("-- J3 request + response against the mock server -------------------");

  await check("success: exact URL, method, headers, body keys; parsed result; key/state never logged", async () => {
    script({ status: 200, body: GOOD_RESPONSE });
    const logs = [];
    const jev = mkClient({ referer: "https://holtburger.local/film", sessionId: "take-007", log: (e) => logs.push(e) });
    const questions = { ...Q, maneuver: { ...Q.maneuver, note: "stray field must not be sent" } };
    const r = await jev.decide({ state: STATE, questions, trace: { take: "007" } });
    allLogs.push(...logs);
    assert.equal(srv.hits, 1);
    const req = srv.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/alpha/decisions");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["x-title"], "holtburger-film");
    assert.equal(req.headers["http-referer"], "https://holtburger.local/film");
    assert.deepEqual(Object.keys(req.body).sort(), ["model", "questions", "session_id", "state", "trace"]);
    assert.equal(req.body.model, "typesafe/jev-1.13");
    assert.equal(req.body.session_id, "take-007");
    assert.deepEqual(req.body.state, STATE);
    assert.deepEqual(req.body.trace, { take: "007" });
    assert.deepEqual(req.body.questions, Q, "questions sent exactly as built, stray field stripped");
    assert.equal(r.id, "gen-dec-123");
    assert.equal(r.model, "typesafe/jev-1.13-20260917");
    assert.equal(r.answers.maneuver.choice, "rise");
    assert.equal(r.answers.subject_lost.noul, 0.12);
    assert.equal(r.answers.risk.score, 0.4);
    assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 3, costUsd: 0.000042 });
    assert.equal(typeof r.ms, "number");
    assert.ok(r.ms >= 0);
    const entry = logs.find((e) => e.event === "jev");
    assert.ok(entry, "a 'jev' log entry");
    assert.equal(entry.id, "gen-dec-123");
    assert.equal(entry.model, "typesafe/jev-1.13-20260917");
    assert.deepEqual(entry.questions, ["maneuver", "subject_lost", "risk"]);
    assert.equal(entry.answers.maneuver.choice, "rise");
    assert.equal(entry.answers.maneuver.confidence, 0.82);
    assert.deepEqual(entry.answers.maneuver.top[0], ["rise", 0.82]);
    assert.equal(entry.costUsd, 0.000042);
    assert.equal(typeof entry.ms, "number");
    const text = JSON.stringify(logs);
    assert.ok(!text.includes(STATE_MARKER), "the log never contains the state");
    assert.ok(!text.includes(KEY) && !text.includes("TESTKEY"), "the log never contains the key");
  });

  await check("no X-Title/HTTP-Referer/session_id/trace when not configured; per-call model + sessionId", async () => {
    script(autoOk());
    const jev = mkClient({ title: null });
    await jev.decide({ state: "plain string state", questions: { ok: noulQ("ok?") } });
    const req = srv.requests[0];
    assert.equal(req.headers["x-title"], undefined);
    assert.equal(req.headers["http-referer"], undefined);
    assert.deepEqual(Object.keys(req.body).sort(), ["model", "questions", "state"]);
    assert.equal(req.body.state, "plain string state");
    await jev.decide({ state: ["a", "b"], questions: { ok: noulQ("ok?") }, model: "~typesafe/jev-latest", sessionId: "s-2" });
    assert.equal(srv.requests[1].body.model, "~typesafe/jev-latest");
    assert.equal(srv.requests[1].body.session_id, "s-2");
    assert.deepEqual(srv.requests[1].body.state, ["a", "b"]);
  });

  await check("usage without cost is priced at input_tokens × $0.042/M", async () => {
    script({ status: 200, body: { ...GOOD_RESPONSE, usage: { input_tokens: 2000, output_tokens: 3 } } });
    const r = await mkClient().decide({ state: STATE, questions: Q });
    assert.equal(r.usage.inputTokens, 2000);
    assert.ok(Math.abs(r.usage.costUsd - 2000 * 0.042e-6) < 1e-15);
  });

  await check("invalid questions / empty state / oversize state → no request sent", async () => {
    script(autoOk());
    const jev = mkClient();
    const e1 = await expectJevError(jev.decide({ state: STATE, questions: { q: scoreQ("x", ["one"]) } }), "bad-request");
    assert.ok(Array.isArray(e1.issues) && e1.issues.length === 1);
    await expectJevError(jev.decide({ state: "   ", questions: Q }), "bad-request");
    await expectJevError(jev.decide({ state: undefined, questions: Q }), "bad-request");
    await expectJevError(jev.decide({ state: "x".repeat(200_000), questions: Q }), "too-large");
    assert.equal(srv.hits, 0);
  });

  // -------------------------------------------------------------------------
  console.log("-- J4 error kinds, retries, timeout, close ---------------------------");

  await check("400/401/402/403/404/413 → typed kinds, not retried, API code + message kept", async () => {
    const table = [[400, "bad-request"], [401, "auth"], [402, "credits"], [403, "forbidden"], [404, "not-found"], [413, "too-large"]];
    for (const [status, kind] of table) {
      script({ status, body: { error: { code: status, message: `mock says ${status}`, metadata: { flagged_input: STATE_MARKER, reason: "r" } } } });
      const jev = mkClient({ log: (e) => allLogs.push(e) });
      const e = await expectJevError(jev.decide({ state: STATE, questions: Q }), kind);
      allErrors.push(e);
      assert.equal(srv.hits, 1, `${status} must not be retried`);
      assert.equal(e.status, status);
      assert.equal(e.code, status);
      assert.equal(e.retryable, false);
      assert.ok(e.message.includes(`mock says ${status}`), e.message);
      assert.equal(e.metadata?.flagged_input, undefined, "flagged_input (an echo of the state) is dropped");
    }
  });

  await check("429 with Retry-After: 2 → waits ≥ 2 s (injected sleep) then succeeds", async () => {
    script({ status: 429, headers: { "Retry-After": "2" }, body: { error: { code: 429, message: "slow down" } } }, { status: 200, body: GOOD_RESPONSE });
    sleeps.length = 0;
    const logs = [];
    const jev = mkClient({ log: (e) => logs.push(e) });
    const r = await jev.decide({ state: STATE, questions: Q });
    assert.equal(srv.hits, 2);
    assert.equal(r.attempts, 2);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(jev.stats().retries, 1);
    const retry = logs.find((e) => e.event === "jev-retry");
    assert.equal(retry.kind, "rate");
    assert.equal(retry.delayMs, 2000);
  });

  await check("429 with an HTTP-date Retry-After is honoured relative to the injected clock", async () => {
    const T = Date.UTC(2026, 9, 13, 12, 0, 0);
    script({ status: 429, headers: { "Retry-After": new Date(T + 3000).toUTCString() }, body: { error: { code: 429, message: "x" } } }, { status: 200, body: GOOD_RESPONSE });
    sleeps.length = 0;
    await mkClient({ now: () => T }).decide({ state: STATE, questions: Q });
    assert.deepEqual(sleeps, [3000]);
  });

  await check("429 whose Retry-After exceeds maxRetryAfterMs stops at once and carries retryAfterMs", async () => {
    script({ status: 429, headers: { "Retry-After": "60" }, body: { error: { code: 429, message: "x" } } }, { status: 200, body: GOOD_RESPONSE });
    const e = await expectJevError(mkClient().decide({ state: STATE, questions: Q }), "rate");
    assert.equal(srv.hits, 1);
    assert.equal(e.retryAfterMs, 60_000);
    assert.equal(e.retryable, true);
  });

  await check("500 then success: one retry with jittered exponential backoff", async () => {
    script({ status: 500, body: "upstream boom" }, { status: 200, body: GOOD_RESPONSE });
    sleeps.length = 0;
    const r = await mkClient({ backoffMs: 200 }).decide({ state: STATE, questions: Q });
    assert.equal(r.answers.maneuver.choice, "rise");
    assert.equal(srv.hits, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 100 && sleeps[0] <= 200, `delay ${sleeps[0]} within [0.5, 1] × 200 ms`);
  });

  await check("jitter is deterministic for a seed; delays double per attempt", async () => {
    const run = async () => {
      script({ status: 503, body: "x" }, { status: 503, body: "x" }, { status: 200, body: GOOD_RESPONSE });
      sleeps.length = 0;
      await mkClient({ seed: 42, backoffMs: 100 }).decide({ state: STATE, questions: Q });
      return [...sleeps];
    };
    const a = await run();
    const b = await run();
    assert.deepEqual(a, b);
    assert.equal(a.length, 2);
    assert.ok(a[0] >= 50 && a[0] <= 100, `first ${a[0]}`);
    assert.ok(a[1] >= 100 && a[1] <= 200, `second ${a[1]}`);
  });

  await check("persistent 524 → 1 + maxRetries attempts, then kind 'server'", async () => {
    script({ status: 524, body: { error: { code: 524, message: "timeout at the edge" } } });
    const jev = mkClient({ maxRetries: 2 });
    const e = await expectJevError(jev.decide({ state: STATE, questions: Q }), "server");
    assert.equal(srv.hits, 3);
    assert.equal(e.attempts, 3);
    assert.equal(e.status, 524);
    const s = jev.stats();
    assert.equal(s.retries, 2);
    assert.equal(s.errors, 1);
  });

  await check("529 overloaded then success; 502/503 retryable 'server' with maxRetries 0", async () => {
    script({ status: 529, body: { error: { code: 529, message: "overloaded" } } }, { status: 200, body: GOOD_RESPONSE });
    const r = await mkClient().decide({ state: STATE, questions: Q });
    assert.equal(r.id, "gen-dec-123");
    assert.equal(srv.hits, 2);
    for (const status of [502, 503]) {
      script({ status, body: { error: { code: status, message: "x" } } });
      const e = await expectJevError(mkClient({ maxRetries: 0 }).decide({ state: STATE, questions: Q }), "server");
      assert.equal(e.retryable, true);
      assert.equal(srv.hits, 1);
    }
  });

  await check("a 2xx body carrying {error} is an error, mapped by its code", async () => {
    script({ status: 200, body: { error: { code: 429, message: "mid-flight limit" } } });
    const e = await expectJevError(mkClient({ maxRetries: 0 }).decide({ state: STATE, questions: Q }), "rate");
    assert.equal(e.status, 429);
  });

  await check("malformed JSON on 200 → bad-response, not retried", async () => {
    script({ status: 200, body: "{not json at all" });
    await expectJevError(mkClient().decide({ state: STATE, questions: Q }), "bad-response");
    assert.equal(srv.hits, 1);
  });

  await check("a missing answer id → bad-response naming the id", async () => {
    const { subject_lost: _drop, ...partial } = GOOD_RESPONSE.answers;
    script({ status: 200, body: { ...GOOD_RESPONSE, answers: partial } });
    const e = await expectJevError(mkClient().decide({ state: STATE, questions: Q }), "bad-response");
    assert.ok(e.message.includes("subject_lost"), e.message);
    assert.equal(srv.hits, 1);
  });

  await check("timeout: a hanging handler + timeoutMs 150 → kind 'timeout' (retried when allowed)", async () => {
    script("hang");
    const t0 = Date.now();
    const e = await expectJevError(mkClient({ timeoutMs: 150, maxRetries: 0 }).decide({ state: STATE, questions: Q }), "timeout");
    assert.ok(Date.now() - t0 < 3000, "gave up promptly");
    assert.equal(e.retryable, true);
    assert.equal(srv.hits, 1);
    script("hang");
    await expectJevError(mkClient({ timeoutMs: 120, maxRetries: 1 }).decide({ state: STATE, questions: Q }), "timeout");
    assert.equal(srv.hits, 2);
    // a per-call timeoutMs override (the broker uses it for realtime takes)
    script("hang");
    await expectJevError(mkClient({ timeoutMs: 60_000 }).decide({ state: STATE, questions: Q, timeoutMs: 100, maxRetries: 0 }), "timeout");
  });

  await check("network: a closed local port → kind 'network'", async () => {
    const tmp = http.createServer();
    await new Promise((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const port = tmp.address().port;
    await new Promise((resolve) => tmp.close(resolve));
    const jev = createJevClient({ apiKey: KEY, endpoint: `http://127.0.0.1:${port}/api/alpha/decisions`, sleep: fastSleep, maxRetries: 1 });
    sleeps.length = 0;
    const e = await expectJevError(jev.decide({ state: STATE, questions: Q }), "network");
    allErrors.push(e);
    assert.equal(e.retryable, true);
    assert.equal(sleeps.length, 1, "network errors are retried");
  });

  await check("close(): aborts an in-flight call and refuses later calls with 'config'", async () => {
    script("hang");
    const jev = mkClient({ timeoutMs: 10_000 });
    const p = jev.decide({ state: STATE, questions: Q });
    while (srv.hits < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    jev.close();
    await expectJevError(p, "config");
    const hits = srv.hits;
    await expectJevError(jev.decide({ state: STATE, questions: Q }), "config");
    assert.equal(srv.hits, hits);
    assert.equal(jev.stats().closed, true);
  });

  await check("createJevClient config errors (no key, bad endpoint) never echo the key", () => {
    assert.throws(() => createJevClient({}), (e) => e instanceof JevError && e.kind === "config" && /OPENROUTER_API_KEY/.test(e.message));
    assert.throws(() => createJevClient({ apiKey: "  " }), (e) => e.kind === "config");
    assert.throws(() => createJevClient({ apiKey: KEY, endpoint: "not a url" }), (e) => e.kind === "config" && !e.message.includes(KEY));
    assert.throws(() => createJevClient({ apiKey: "sk or bad" }), (e) => e.kind === "config" && !e.message.includes("sk or bad"));
    assert.throws(() => createJevClient({ apiKey: KEY, budget: { maxUsdPerHour: -1 } }), (e) => e.kind === "config");
  });

  // -------------------------------------------------------------------------
  console.log("-- J5 budget -----------------------------------------------------------");

  await check("calls/minute cap refuses with 'budget' and NO network call; the window rolls", async () => {
    script(autoOk());
    let clock = 1_000_000;
    const logs = [];
    const jev = mkClient({ now: () => clock, budget: { maxCallsPerMin: 2 }, log: (e) => logs.push(e) });
    await jev.decide({ state: STATE, questions: Q });
    clock += 1000;
    await jev.decide({ state: STATE, questions: Q });
    const e = await expectJevError(jev.decide({ state: STATE, questions: Q }), "budget");
    assert.equal(srv.hits, 2, "the refused call never reached the server");
    assert.equal(e.code, "calls-per-minute");
    assert.equal(e.retryable, false);
    assert.equal(e.retryAfterMs, 59_000);
    const s = jev.stats();
    assert.equal(s.refused, 1);
    assert.equal(s.lastMinuteCalls, 2);
    assert.ok(logs.some((l) => l.event === "jev-budget"));
    clock += 60_000;
    await jev.decide({ state: STATE, questions: Q });
    assert.equal(srv.hits, 3);
  });

  await check("$/hour cap refuses with 'budget' and NO network call; the hour rolls", async () => {
    script(autoOk({ input_tokens: 100, output_tokens: 1, cost: 0.5 }));
    let clock = 5_000_000;
    const jev = mkClient({ now: () => clock, budget: { maxUsdPerHour: 1 } });
    await jev.decide({ state: STATE, questions: Q });
    clock += 10;
    await jev.decide({ state: STATE, questions: Q });
    clock += 10;
    const e = await expectJevError(jev.decide({ state: STATE, questions: Q }), "budget");
    assert.equal(e.code, "usd-per-hour");
    assert.equal(srv.hits, 2);
    assert.equal(e.retryAfterMs, 3_600_000 - 20);
    const s = jev.stats();
    assert.equal(s.lastHourCostUsd, 1);
    assert.equal(s.costUsd, 1);
    clock += 3_600_000;
    await jev.decide({ state: STATE, questions: Q });
    assert.equal(srv.hits, 3);
    assert.equal(jev.stats().lastHourCostUsd, 0.5);
  });

  await check("in-flight calls reserve their estimated cost against the $/hour cap", async () => {
    // A response without usage is charged the client's own pre-flight estimate,
    // which tells this test what one call reserves.
    const q1 = { ok: noulQ("ok?") };
    script({ status: 200, body: { id: "x", model: "m", answers: { ok: { type: "noul", noul: 1 } } } });
    const probe = await mkClient().decide({ state: STATE, questions: q1 });
    assert.equal(probe.usage.estimated, true);
    const est = probe.usage.costUsd;
    assert.ok(est > 0);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let fetches = 0;
    const fetchFn = async () => {
      fetches++;
      await gate;
      return new Response(JSON.stringify({ id: "y", model: "m", answers: { ok: { type: "noul", noul: 1 } }, usage: { input_tokens: 1, cost: 0 } }), { status: 200 });
    };
    const jev = createJevClient({ apiKey: KEY, fetchFn, budget: { maxUsdPerHour: est * 1.5 } });
    const first = jev.decide({ state: STATE, questions: q1 });
    await expectJevError(jev.decide({ state: STATE, questions: q1 }), "budget");
    assert.equal(fetches, 1, "the second call was refused before fetch");
    release();
    await first;
    const again = await jev.decide({ state: STATE, questions: q1 });
    assert.equal(again.id, "y", "the reservation is released once the call completes");
  });

  await check("stats() exposes the spec counters", async () => {
    script(autoOk({ input_tokens: 200, output_tokens: 1 }));
    const jev = mkClient();
    await jev.decide({ state: STATE, questions: Q });
    const s = jev.stats();
    for (const k of ["calls", "errors", "retries", "inputTokens", "costUsd", "lastMinuteCalls", "lastHourCostUsd"]) {
      assert.equal(typeof s[k], "number", k);
    }
    assert.equal(s.calls, 1);
    assert.equal(s.inputTokens, 200);
    assert.ok(Math.abs(s.costUsd - 200 * 0.042e-6) < 1e-15);
    assert.equal(s.lastMinuteCalls, 1);
  });

  await check("no error message or log line anywhere in this suite contains the key or the state", () => {
    const text = JSON.stringify(allLogs) + allErrors.map((e) => `${e.message} ${JSON.stringify(e)}`).join("\n");
    assert.ok(allLogs.length > 0 && allErrors.length > 0);
    assert.ok(!text.includes("TESTKEY"), "key leaked");
    assert.ok(!text.includes(STATE_MARKER), "state leaked");
  });

  // -------------------------------------------------------------------------
  console.log("-- J6 resolveJevKey + redactKey -------------------------------------");

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "film-jev-key-"));
  try {
    const keyDir = path.join(tmpHome, ".config", "holtburger-film");
    const keyFile = path.join(keyDir, "openrouter.key");
    fs.mkdirSync(keyDir, { recursive: true });

    await check("env OPENROUTER_API_KEY wins over OPENROUTER_KEY and the key file", () => {
      fs.writeFileSync(keyFile, "sk-or-file-key\n", { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600);
      const r = resolveJevKey({ env: { OPENROUTER_API_KEY: " sk-or-env-api ", OPENROUTER_KEY: "sk-or-env-key" }, home: tmpHome });
      assert.equal(r.key, "sk-or-env-api");
      assert.equal(r.source, "env:OPENROUTER_API_KEY");
    });

    await check("OPENROUTER_KEY is next (an empty OPENROUTER_API_KEY is skipped)", () => {
      const r = resolveJevKey({ env: { OPENROUTER_API_KEY: "   ", OPENROUTER_KEY: "sk-or-env-key" }, home: tmpHome });
      assert.equal(r.key, "sk-or-env-key");
      assert.equal(r.source, "env:OPENROUTER_KEY");
    });

    await check("then ~/.config/holtburger-film/openrouter.key with mode 600 (first non-empty line)", () => {
      fs.writeFileSync(keyFile, "\n  sk-or-file-key  \nsecond line\n");
      fs.chmodSync(keyFile, 0o600);
      const r = resolveJevKey({ env: {}, home: tmpHome });
      assert.equal(r.key, "sk-or-file-key");
      assert.equal(r.source, `file:${keyFile}`);
    });

    await check("a group/other-readable key file → 'config' with the chmod 600 fix, key not echoed", () => {
      for (const mode of [0o644, 0o640, 0o604]) {
        fs.chmodSync(keyFile, mode);
        assert.throws(
          () => resolveJevKey({ env: {}, home: tmpHome }),
          (e) => e instanceof JevError && e.kind === "config" && e.message.includes(`chmod 600 ${keyFile}`) && !e.message.includes("sk-or-file-key"),
          `mode ${mode.toString(8)}`,
        );
      }
      fs.chmodSync(keyFile, 0o600);
    });

    await check("an empty key file or a directory → 'config'; no file → {key: null}", () => {
      fs.writeFileSync(keyFile, "\n \n");
      fs.chmodSync(keyFile, 0o600);
      assert.throws(() => resolveJevKey({ env: {}, home: tmpHome }), (e) => e.kind === "config" && /empty/.test(e.message));
      fs.rmSync(keyFile);
      fs.mkdirSync(keyFile);
      assert.throws(() => resolveJevKey({ env: {}, home: tmpHome }), (e) => e.kind === "config" && /regular file/.test(e.message));
      fs.rmdirSync(keyFile);
      const none = resolveJevKey({ env: {}, home: tmpHome });
      assert.equal(none.key, null);
      assert.equal(none.source, null);
      assert.deepEqual(none.checked, ["env:OPENROUTER_API_KEY", "env:OPENROUTER_KEY", `file:${keyFile}`]);
    });

    await check("an injected fs is used (statSync/readFileSync)", () => {
      const fakeFs = {
        statSync: () => ({ isFile: () => true, mode: 0o100600 }),
        readFileSync: () => "sk-or-injected\n",
      };
      const r = resolveJevKey({ env: {}, home: "/nonexistent-home", fs: fakeFs });
      assert.equal(r.key, "sk-or-injected");
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  await check("redactKey shows at most the first 6 characters + '…'", () => {
    assert.equal(redactKey(KEY), "sk-or-…");
    assert.equal(redactKey(null), "(none)");
    assert.equal(redactKey(""), "(none)");
    assert.ok(redactKey("abcdef").length <= 3, "a short key shows at most a third of itself");
  });
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\nfilm jev client: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
