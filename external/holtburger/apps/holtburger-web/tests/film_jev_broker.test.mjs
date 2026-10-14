// tests/film_jev_broker.test.mjs
//
// WHY: in film mode (`?filmMode=on`, DEFAULT OFF) the in-page JEV pilot asks bounded
// maneuver questions through window.__filmJev(json) → Promise<json> (SPEC §2.14,
// §3.2). The film CLI exposes that binding with Playwright page.exposeFunction, and
// tools/film/lib/jev_broker.mjs is the function behind it: the OpenRouter key stays
// in Node, the page gets JSON back and the broker NEVER throws into the page. The
// planning-time helpers in tools/film/lib/jev_tasks.mjs ride on the same client,
// so this suite covers them too:
//   B1 install(): exposeFunction('__filmJev', handler), idempotent (sequential and
//      concurrent), tolerates Playwright's "already registered", rejects other errors
//   B2 handler: success {answers, usage, ms, seq, id}; client errors → {error:{kind,
//      message}, seq}; malformed JSON / missing state / bad questions → bad-request
//      (client never called); oversize (> 48 KB) → too-large; maxInFlight → busy;
//      mode 'off' → disabled; seq echo rules; a throwing log sink is harmless
//   B3 the broker over the REAL createJevClient with an injected fetchFn: normalized
//      answers reach the page; neither the key nor the state reaches telemetry
//   B4 telemetry ring (last N, default 500) and dumpTelemetry(path) → JSONL; telemetryMark() +
//      {since} → a per-shot slice (one broker serves a whole `film shoot`)
//   T1 jev_tasks: bandOf; pickCandidate (criteria from candidate words, order kept
//      even for integer-like ids, ids mapped back; every word the pick rule quotes is a
//      WORD_BOUNDS word that scene/solver.js describeCandidate writes into the options,
//      in exactly the band it names); keepOrRetake (take words, noul
//      criteria on dropped frames / safety / min visibility / pop-in, bands);
//      scoreSiteForLine (5-level fit, thresholded); sectionTechniqueFamily (families,
//      conservative default first, code fallback table; role words = the song
//      analyser's SECTION_ROLES, 'solo' an alias of 'instrumental')
// No network: the page is a fake {exposeFunction}, the client a fake or the real
// client over a stub fetchFn.
//
// Run from apps/holtburger-web/: node tests/film_jev_broker.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { distanceWord, visibilityWord } from "../scene3d/film/pilot/sense_words.js";
import { describeCandidate } from "../scene3d/film/scene/solver.js";
import { SECTION_ROLES as ANALYSER_SECTION_ROLES } from "../tools/film/audio/structure.mjs";
import { JevError, choiceQ, createJevClient, noulQ, parseAnswers, scoreQ, validateQuestions } from "../tools/film/lib/jev.mjs";
import { BROKER_MAX_PAYLOAD_BYTES, BROKER_TELEMETRY_LIMIT, JEV_BINDING_NAME, createJevBroker } from "../tools/film/lib/jev_broker.mjs";
import {
  FIT_LEVELS,
  PICK_HIDDEN_WORDS,
  PICK_INSTRUCTIONS,
  PICK_TOO_CLOSE_WORDS,
  SECTION_ROLES,
  SECTION_ROLE_ALIASES,
  TECHNIQUE_FAMILIES,
  bandOf,
  buildKeepOrRetakeRequest,
  buildPickCandidateRequest,
  buildSectionFamilyRequest,
  buildSiteFitRequest,
  codeTechniqueFamily,
  keepOrRetake,
  pickCandidate,
  scoreSiteForLine,
  sectionRoleOf,
  sectionTechniqueFamily,
  takeReportWords,
} from "../tools/film/lib/jev_tasks.mjs";

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

const KEY = "sk-or-v1-BROKERKEY-0123456789abcdef";
const STATE_MARKER = "STATE-MARKER-b40c";
const STATE = { standing_order: `Track the rider. ${STATE_MARKER}`, obstacles: { ahead: "near tree" } };
const QUESTIONS = {
  maneuver: choiceQ("Pick the camera maneuver.", {
    hold_path: "keep the planned path: obstacles.ahead is 'medium', 'far' or 'clear'",
    back_off: "back off: obstacles.ahead is 'touching' or 'very close'",
  }),
  subject_lost: noulQ("Is the subject truly lost?", { true: "unseen_for is 'long'", false: "unseen_for is not 'long'" }),
  risk: scoreQ("How close is a collision?", ["open", "tight but manageable", "about to hit"]),
};
const payload = (seq, extra = {}) => JSON.stringify({ state: STATE, questions: QUESTIONS, seq, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeAnswers(questions) {
  const raw = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") raw[id] = { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9 };
    else if (q.type === "noul") raw[id] = { type: "noul", noul: 0.2 };
    else raw[id] = { type: "score", score: 0, confidence: 0.8 };
  }
  return parseAnswers(raw, questions);
}

// A fake JEV client: records requests; behaviour per call is a function or the default success.
function fakeClient() {
  const c = {
    requests: [],
    next: [],
    async decide(req) {
      c.requests.push(req);
      const step = c.next.shift();
      if (step) return step(req);
      return {
        id: `gen-${c.requests.length}`,
        model: "typesafe/jev-1.13-20260917",
        answers: fakeAnswers(req.questions),
        usage: { inputTokens: 120, outputTokens: 3, costUsd: 120 * 0.042e-6 },
        ms: 111,
      };
    },
    stats: () => ({ calls: c.requests.length }),
  };
  return c;
}

function fakePage({ preRegistered = false, failWith = null } = {}) {
  const page = {
    exposeCalls: 0,
    bindings: {},
    async exposeFunction(name, fn) {
      page.exposeCalls++;
      await tick();
      if (failWith) throw new Error(failWith);
      if (preRegistered || page.bindings[name]) throw new Error(`Function "${name}" has been already registered`);
      page.bindings[name] = fn;
    },
  };
  return page;
}

// ---------------------------------------------------------------------------
console.log("-- B1 install --------------------------------------------------------");

await check("install() exposes window.__filmJev = handler once; repeat and concurrent calls are idempotent", async () => {
  const page = fakePage();
  const broker = createJevBroker({ client: fakeClient(), page });
  const [a, b] = await Promise.all([broker.install(), broker.install()]);
  assert.equal(JEV_BINDING_NAME, "__filmJev");
  assert.equal(page.exposeCalls, 1);
  assert.equal(page.bindings.__filmJev, broker.handler);
  assert.deepEqual(a, { ok: true, already: false });
  assert.deepEqual(b, { ok: true, already: false });
  assert.deepEqual(await broker.install(), { ok: true, already: true });
  assert.equal(page.exposeCalls, 1);
  assert.equal(broker.stats().installed, true);
});

await check("install() tolerates Playwright's 'has been already registered'", async () => {
  const logs = [];
  const broker = createJevBroker({ client: fakeClient(), page: fakePage({ preRegistered: true }), log: (e) => logs.push(e) });
  assert.deepEqual(await broker.install(), { ok: true, already: true });
  assert.ok(logs.some((l) => l.outcome === "install"));
});

await check("install() rejects other exposeFunction errors and a missing page", async () => {
  const broker = createJevBroker({ client: fakeClient(), page: fakePage({ failWith: "Target page, context or browser has been closed" }) });
  await assert.rejects(broker.install(), /closed/);
  assert.equal(broker.stats().installed, false);
  const noPage = createJevBroker({ client: fakeClient() });
  await assert.rejects(noPage.install(), (e) => e instanceof JevError && e.kind === "config");
});

await check("createJevBroker config errors", () => {
  assert.throws(() => createJevBroker({}), (e) => e.kind === "config");
  assert.throws(() => createJevBroker({ client: fakeClient(), mode: "shadow" }), (e) => e.kind === "config");
  assert.throws(() => createJevBroker({ client: fakeClient(), maxInFlight: 0 }), (e) => e.kind === "config");
});

// ---------------------------------------------------------------------------
console.log("-- B2 handler --------------------------------------------------------");

await check("success: {answers, usage, ms, seq, id}; decide gets state, questions, sessionId + decide options", async () => {
  const client = fakeClient();
  const broker = createJevBroker({ client, sessionId: "take-3", decideOptions: { timeoutMs: 1200, maxRetries: 0, bogus: 1 } });
  const text = await broker.handler(payload(7));
  assert.equal(typeof text, "string");
  const out = JSON.parse(text);
  assert.deepEqual(Object.keys(out).sort(), ["answers", "id", "model", "ms", "seq", "usage"]);
  assert.equal(out.seq, 7);
  assert.equal(out.id, "gen-1");
  assert.equal(out.ms, 111);
  assert.equal(out.answers.maneuver.choice, "hold_path");
  assert.equal(out.answers.subject_lost.noul, 0.2);
  assert.equal(out.answers.risk.score, 0);
  assert.equal(out.usage.inputTokens, 120);
  const req = client.requests[0];
  assert.deepEqual(req.state, STATE);
  assert.deepEqual(req.questions, QUESTIONS);
  assert.equal(req.sessionId, "take-3");
  assert.equal(req.timeoutMs, 1200);
  assert.equal(req.maxRetries, 0);
  assert.equal("bogus" in req, false, "only known decide options are forwarded");
  broker.setDecideOptions({ timeoutMs: 4000, maxRetries: 2 });
  await broker.handler(payload(8));
  assert.equal(client.requests[1].timeoutMs, 4000);
});

await check("an already-structured object payload is accepted too", async () => {
  const broker = createJevBroker({ client: fakeClient() });
  const out = JSON.parse(await broker.handler({ state: STATE, questions: QUESTIONS, seq: 9 }));
  assert.equal(out.seq, 9);
  assert.equal(out.answers.maneuver.choice, "hold_path");
});

await check("client JevError → {error:{kind, message, retryable}, seq}; nothing thrown", async () => {
  const client = fakeClient();
  client.next.push(() => {
    throw new JevError("rate", "HTTP 429: slow down", { status: 429 });
  });
  const broker = createJevBroker({ client });
  const out = JSON.parse(await broker.handler(payload(11)));
  assert.deepEqual(out, { error: { kind: "rate", message: "HTTP 429: slow down", retryable: true }, seq: 11 });
});

await check("a non-JevError from the client → kind 'internal', message without the state", async () => {
  const client = fakeClient();
  client.next.push(() => {
    throw new TypeError("boom");
  });
  client.next.push(() => ({ nope: true }));
  const broker = createJevBroker({ client });
  const a = JSON.parse(await broker.handler(payload(12)));
  assert.equal(a.error.kind, "internal");
  assert.ok(a.error.message.includes("boom"));
  assert.ok(!JSON.stringify(a).includes(STATE_MARKER));
  const b = JSON.parse(await broker.handler(payload(13)));
  assert.equal(b.error.kind, "internal", "a result without answers");
});

await check("malformed JSON / not an object / missing state / invalid questions → bad-request, client never called", async () => {
  const client = fakeClient();
  const broker = createJevBroker({ client });
  const cases = [
    "{not json",
    "[1,2,3]",
    42,
    undefined,
    null,
    JSON.stringify({ questions: QUESTIONS, seq: 1 }),
    JSON.stringify({ state: STATE, questions: { q: scoreQ("x", ["only one level"]) }, seq: 2 }),
    JSON.stringify({ state: STATE, seq: 3 }),
  ];
  for (const c of cases) {
    const out = JSON.parse(await broker.handler(c));
    assert.equal(out.error?.kind, "bad-request", `input ${String(c).slice(0, 40)}`);
  }
  assert.equal(client.requests.length, 0);
  const withSeq = JSON.parse(await broker.handler(JSON.stringify({ questions: QUESTIONS, seq: 21 })));
  assert.equal(withSeq.seq, 21, "seq is echoed even on a refusal");
});

await check("oversize payload (> 48 KB) → too-large without parsing or calling the client; ≤ 48 KB passes", async () => {
  const client = fakeClient();
  const broker = createJevBroker({ client });
  assert.equal(BROKER_MAX_PAYLOAD_BYTES, 48 * 1024);
  const base = Buffer.byteLength(JSON.stringify({ state: "", questions: QUESTIONS, seq: 1 }), "utf8");
  const exact = JSON.stringify({ state: "x".repeat(BROKER_MAX_PAYLOAD_BYTES - base), questions: QUESTIONS, seq: 1 });
  assert.equal(Buffer.byteLength(exact, "utf8"), BROKER_MAX_PAYLOAD_BYTES);
  const ok = JSON.parse(await broker.handler(exact));
  assert.ok(ok.answers, "exactly 48 KB is accepted");
  const big = JSON.stringify({ state: "x".repeat(BROKER_MAX_PAYLOAD_BYTES - base + 1), questions: QUESTIONS, seq: 2 });
  const out = JSON.parse(await broker.handler(big));
  assert.equal(out.error.kind, "too-large");
  assert.equal(out.seq, null, "an oversize payload is never parsed, so no seq");
  const bigObj = JSON.parse(await broker.handler({ state: "é".repeat(30_000), questions: QUESTIONS, seq: 3 }));
  assert.equal(bigObj.error.kind, "too-large", "measured in UTF-8 bytes");
  assert.equal(client.requests.length, 1);
});

await check("maxInFlight: the extra request gets 'busy' at once; the others complete", async () => {
  const client = fakeClient();
  const releases = [];
  const gated = (req) =>
    new Promise((resolve) => releases.push(() => resolve({ id: "g", model: "m", answers: fakeAnswers(req.questions), usage: null, ms: 5 })));
  client.next.push(gated, gated);
  const broker = createJevBroker({ client, maxInFlight: 2 });
  const p1 = broker.handler(payload(1));
  const p2 = broker.handler(payload(2));
  await tick();
  assert.equal(broker.stats().inFlight, 2);
  const busy = JSON.parse(await broker.handler(payload(3)));
  assert.deepEqual(busy.error.kind, "busy");
  assert.equal(busy.error.retryable, true);
  assert.equal(busy.seq, 3);
  assert.equal(client.requests.length, 2);
  releases.forEach((r) => r());
  const [r1, r2] = (await Promise.all([p1, p2])).map((t) => JSON.parse(t));
  assert.equal(r1.seq, 1);
  assert.equal(r2.seq, 2);
  assert.ok(r1.answers && r2.answers);
  assert.equal(broker.stats().inFlight, 0);
  const after = JSON.parse(await broker.handler(payload(4)));
  assert.ok(after.answers, "capacity is released");
});

await check("a slot is released when decide throws (no leaked in-flight count)", async () => {
  const client = fakeClient();
  client.next.push(() => Promise.reject(new JevError("timeout", "no response")));
  const broker = createJevBroker({ client, maxInFlight: 1 });
  const e = JSON.parse(await broker.handler(payload(1)));
  assert.equal(e.error.kind, "timeout");
  assert.equal(broker.stats().inFlight, 0);
  assert.ok(JSON.parse(await broker.handler(payload(2))).answers);
});

await check("mode 'off' → {error:{kind:'disabled'}, seq} for every input; setMode switches and validates", async () => {
  const client = fakeClient();
  const logs = [];
  const broker = createJevBroker({ client, mode: "off", log: (e) => logs.push(e) });
  const off = JSON.parse(await broker.handler(payload(5)));
  assert.equal(off.error.kind, "disabled");
  assert.equal(off.seq, 5);
  assert.equal(JSON.parse(await broker.handler("{garbage")).error.kind, "disabled");
  assert.equal(client.requests.length, 0);
  assert.equal(broker.setMode("jev"), "off");
  assert.equal(broker.mode, "jev");
  assert.ok(JSON.parse(await broker.handler(payload(6))).answers);
  assert.throws(() => broker.setMode("code"), (e) => e instanceof JevError && e.kind === "config");
  assert.ok(logs.some((l) => l.outcome === "mode" && l.from === "off" && l.to === "jev"));
});

await check("seq echo: numbers and short strings; anything else → null", async () => {
  const broker = createJevBroker({ client: fakeClient() });
  assert.equal(JSON.parse(await broker.handler(payload("scene-4"))).seq, "scene-4");
  assert.equal(JSON.parse(await broker.handler(payload("x".repeat(65)))).seq, null);
  assert.equal(JSON.parse(await broker.handler(payload({ nested: 1 }))).seq, null);
  assert.equal(broker.stats().lastSeq, "scene-4");
});

await check("a throwing log sink never breaks the handler", async () => {
  const client = fakeClient();
  client.next.push(() => {
    throw new JevError("server", "HTTP 500");
  });
  const broker = createJevBroker({
    client,
    log: () => {
      throw new Error("log sink exploded");
    },
  });
  const out = JSON.parse(await broker.handler(payload(1)));
  assert.equal(out.error.kind, "server");
});

await check("stats(): counters, byKind and the client's stats", async () => {
  const client = fakeClient();
  const broker = createJevBroker({ client, maxInFlight: 3 });
  await broker.handler(payload(1));
  await broker.handler("{bad");
  const s = broker.stats();
  assert.equal(s.requests, 2);
  assert.equal(s.ok, 1);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.byKind, { "bad-request": 1 });
  assert.equal(s.maxInFlight, 3);
  assert.deepEqual(s.client, { calls: 1 });
});

// ---------------------------------------------------------------------------
console.log("-- B3 broker over the real client --------------------------------------");

await check("real createJevClient + stub fetchFn: normalized answers reach the page; no key or state in telemetry", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return new Response(
      JSON.stringify({
        id: "gen-real-1",
        model: "typesafe/jev-1.13-20260917",
        answers: {
          risk: { type: "score", score: 1.2, probabilities: { 2: 0.2, 1: 0.6, 0: 0.2 } },
          maneuver: { type: "choice", choice: "back_off", probabilities: { back_off: 0.7, hold_path: 0.3 } },
          subject_lost: { type: "noul", noul: 0.05 },
        },
        usage: { input_tokens: 400, output_tokens: 3 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const logs = [];
  const client = createJevClient({ apiKey: KEY, fetchFn, log: (e) => logs.push(e) });
  const page = fakePage();
  const broker = createJevBroker({ client, page, log: (e) => logs.push(e) });
  await broker.install();
  const out = JSON.parse(await page.bindings.__filmJev(payload(31)));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions", "the default endpoint (stubbed fetch, no network)");
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(out.id, "gen-real-1");
  assert.equal(out.seq, 31);
  assert.equal(out.answers.maneuver.choice, "back_off");
  assert.equal(out.answers.maneuver.confidence, 0.7);
  assert.deepEqual(Object.keys(out.answers.maneuver.probabilities), ["hold_path", "back_off"]);
  assert.equal(out.answers.risk.confidence, 0.6);
  assert.ok(Math.abs(out.usage.costUsd - 400 * 0.042e-6) < 1e-15);
  const leakText = JSON.stringify(out) + JSON.stringify(broker.telemetry()) + JSON.stringify(logs) + JSON.stringify(broker.stats());
  assert.ok(!leakText.includes("BROKERKEY"), "the key never reaches the page, telemetry or logs");
  assert.ok(!JSON.stringify(broker.telemetry()).includes(STATE_MARKER), "telemetry never holds the state");
  // over budget → the page gets a typed error, not an exception
  const capped = createJevBroker({ client: createJevClient({ apiKey: KEY, fetchFn, budget: { maxCallsPerMin: 0 } }) });
  const refused = JSON.parse(await capped.handler(payload(32)));
  assert.equal(refused.error.kind, "budget");
  assert.equal(seen.length, 1, "a budget refusal makes no request");
});

// ---------------------------------------------------------------------------
console.log("-- B4 telemetry ---------------------------------------------------------");

await check("the telemetry ring keeps the last N entries (default 500)", async () => {
  assert.equal(BROKER_TELEMETRY_LIMIT, 500);
  const broker = createJevBroker({ client: fakeClient(), telemetryLimit: 5 });
  for (let i = 0; i < 8; i++) await broker.handler(payload(i));
  const t = broker.telemetry();
  assert.equal(t.length, 5);
  assert.deepEqual(t.map((e) => e.seq), [3, 4, 5, 6, 7]);
  assert.equal(t[0].outcome, "ok");
  assert.deepEqual(t[0].questions, ["maneuver", "subject_lost", "risk"]);
  assert.ok(Math.abs(t[0].costUsd - 120 * 0.042e-6) < 1e-15);
  const big = createJevBroker({ client: fakeClient() });
  for (let i = 0; i < 503; i++) await big.handler(payload(i));
  assert.equal(big.telemetry().length, 500);
  assert.equal(big.telemetry()[0].seq, 3);
});

await check("dumpTelemetry(path) writes JSONL (parents created), errors included, no state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "film-jev-broker-"));
  try {
    const broker = createJevBroker({ client: fakeClient(), maxInFlight: 1 });
    await broker.handler(payload(1));
    await broker.handler("{bad json");
    broker.setMode("off");
    await broker.handler(payload(3));
    const file = path.join(dir, "take-01", "jev.jsonl");
    const r = broker.dumpTelemetry(file);
    assert.deepEqual(r, { path: file, count: 3 });
    const lines = fs.readFileSync(file, "utf8").split("\n");
    assert.equal(lines.at(-1), "", "newline-terminated");
    const rows = lines.filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((e) => [e.seq, e.outcome, e.kind ?? null]), [[1, "ok", null], [null, "error", "bad-request"], [3, "error", "disabled"]]);
    assert.ok(!fs.readFileSync(file, "utf8").includes(STATE_MARKER));
    const empty = createJevBroker({ client: fakeClient() }).dumpTelemetry(path.join(dir, "empty.jsonl"));
    assert.equal(empty.count, 0);
    assert.equal(fs.readFileSync(path.join(dir, "empty.jsonl"), "utf8"), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("telemetryMark() + {since}: a per-shot dump holds only the entries after the mark, even after ring overflow (jev-3)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "film-jev-broker-"));
  try {
    const broker = createJevBroker({ client: fakeClient(), telemetryLimit: 4 });
    assert.equal(broker.telemetryMark(), 0);
    // shot A: 2 calls
    const markA = broker.telemetryMark();
    await broker.handler(payload(1));
    await broker.handler(payload(2));
    const a = broker.dumpTelemetry(path.join(dir, "A.jev.jsonl"), { since: markA });
    assert.equal(a.count, 2);
    // shot B: a rehearsal call + a take call (+ one refused request — errors are telemetry too)
    const markB = broker.telemetryMark();
    assert.equal(markB, 2);
    await broker.handler(payload(10));
    await broker.handler("{bad json");
    await broker.handler(payload(11));
    const rowsOf = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).seq);
    const b = broker.dumpTelemetry(path.join(dir, "B.jev.jsonl"), { since: markB });
    assert.equal(b.count, 3);
    assert.deepEqual(rowsOf(path.join(dir, "B.jev.jsonl")), [10, null, 11], "B's file never carries A's entries");
    assert.deepEqual(rowsOf(path.join(dir, "A.jev.jsonl")), [1, 2]);
    assert.deepEqual(broker.telemetry({ since: markB }).map((e) => e.seq), [10, null, 11]);
    // the ring (limit 4) has dropped A's first entry: the mark still counts from the start, so C's slice is exact
    assert.equal(broker.telemetryMark(), 5);
    const markC = broker.telemetryMark();
    await broker.handler(payload(20));
    await broker.handler(payload(21));
    await broker.handler(payload(22));
    assert.deepEqual(broker.telemetry().map((e) => e.seq), [11, 20, 21, 22]);
    assert.deepEqual(broker.telemetry({ since: markC }).map((e) => e.seq), [20, 21, 22]);
    // a mark older than the ring returns what is left; no since → the whole ring (old callers unchanged)
    assert.deepEqual(broker.telemetry({ since: markB }).map((e) => e.seq), [11, 20, 21, 22]);
    assert.equal(broker.dumpTelemetry(path.join(dir, "all.jsonl")).count, 4);
    assert.equal(broker.dumpTelemetry(path.join(dir, "all2.jsonl"), { since: null }).count, 4);
    assert.throws(() => broker.telemetry({ since: -1 }), (e) => e instanceof JevError && e.kind === "config");
    assert.throws(() => broker.dumpTelemetry(path.join(dir, "x.jsonl"), { since: 1.5 }), (e) => e instanceof JevError && e.kind === "config");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
console.log("-- T1 planning tasks (jev_tasks.mjs) -----------------------------------");

// A fake client that answers with a fixed raw answer per question id, normalized by the real parseAnswers.
function taskClient(rawById) {
  const c = {
    requests: [],
    async decide(req) {
      c.requests.push(req);
      const v = validateQuestions(req.questions);
      if (!v.ok) throw new JevError("bad-request", v.issues.join("; "));
      return { id: "gen-task", model: "typesafe/jev-1.13-20260917", answers: parseAnswers(rawById, req.questions), usage: { inputTokens: 50, outputTokens: 1, costUsd: 2.1e-6 }, ms: 90 };
    },
  };
  return c;
}

await check("bandOf: act ≥ 0.8, confirm ≥ 0.5, else escalate; null → escalate", () => {
  assert.equal(bandOf(0.8), "act");
  assert.equal(bandOf(0.79), "confirm");
  assert.equal(bandOf(0.5), "confirm");
  assert.equal(bandOf(0.49), "escalate");
  assert.equal(bandOf(null), "escalate");
  assert.equal(bandOf(Number.NaN), "escalate");
});

await check("pickCandidate: criteria from candidate words in order (solver best first); band + raw", async () => {
  const candidates = [
    { id: "front-low", words: "subject clear, nearest obstacle far, low angle" },
    { id: "side", words: ["subject partly hidden", "tree close on the left"] },
    { id: "top", words: { subject: "clear", angle: "straight down" } },
  ];
  const client = taskClient({ candidate: { type: "choice", choice: "side", probabilities: { top: 0.1, side: 0.85, "front-low": 0.05 } } });
  const r = await pickCandidate(client, { intent: { framing: "MS", angle: "low", minClearance: 2, maxOcclusion: 0.3 }, candidates });
  const q = client.requests[0].questions.candidate;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys(q.criteria), ["front-low", "side", "top"]);
  assert.equal(q.criteria.side, "subject partly hidden; tree close on the left");
  assert.equal(q.criteria.top, "subject: clear; angle: straight down");
  assert.ok(/listed first/.test(q.instructions), "first-option default stated");
  assert.equal(client.requests[0].state.intent.framing, "medium shot (MS)");
  assert.equal(client.requests[0].state.intent.clearance, "camera at least 2 m from any obstacle");
  assert.equal(r.choice, "side");
  assert.equal(r.confidence, 0.85);
  assert.equal(r.band, "act");
  assert.deepEqual(r.probabilities, { "front-low": 0.05, side: 0.85, top: 0.1 });
  assert.equal(r.raw.choice, "side");
  assert.equal(r.source, "jev");
});

await check("pickCandidate: integer-like ids keep their order (positional keys) and map back", async () => {
  const req = buildPickCandidateRequest({ candidates: [{ id: 3, words: "solver best" }, { id: 1, words: "second" }, { id: "2", words: "third" }] });
  assert.deepEqual(Object.keys(req.questions.candidate.criteria), ["c1", "c2", "c3"]);
  assert.deepEqual(Object.values(req.questions.candidate.criteria), ["solver best", "second", "third"]);
  assert.deepEqual(req.keyToId, { c1: "3", c2: "1", c3: "2" });
  const client = taskClient({ candidate: { type: "choice", choice: "c2", confidence: 0.6, probabilities: { c3: 0.1, c1: 0.3, c2: 0.6 } } });
  const r = await pickCandidate(client, { candidates: [{ id: 3, words: "solver best" }, { id: 1, words: "second" }, { id: "2", words: "third" }] });
  assert.equal(r.choice, "1");
  assert.equal(r.band, "confirm");
  assert.deepEqual(r.probabilities, { 1: 0.6, 2: 0.1, 3: 0.3 });
  assert.equal(r.raw.choice, "c2");
});

await check("pickCandidate: one candidate is trivial, null client → first candidate (code), bad input → bad-request", async () => {
  const one = await pickCandidate(null, { candidates: [{ id: "only", words: "x" }] });
  assert.deepEqual([one.choice, one.band, one.source], ["only", "act", "trivial"]);
  const code = await pickCandidate(null, { candidates: [{ id: "a", words: "x" }, { id: "b", words: "y" }] });
  assert.deepEqual([code.choice, code.band, code.source], ["a", "confirm", "code"]);
  await assert.rejects(pickCandidate(null, { candidates: [] }), (e) => e.kind === "bad-request");
  await assert.rejects(pickCandidate(null, { candidates: [{ id: "a", words: "x" }, { id: "a", words: "y" }] }), (e) => e.kind === "bad-request");
  await assert.rejects(pickCandidate(null, { candidates: [{ id: "a", words: "" }, { id: "b", words: "y" }] }), (e) => e.kind === "bad-request");
});

await check("pickCandidate words contract: every word the instructions quote appears in describeCandidate options (jev-2)", async () => {
  // The rule quotes exactly the WORD_BOUNDS words (generated, with their band edges), nothing hand-written.
  const quoted = [...PICK_INSTRUCTIONS.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(quoted, [...PICK_HIDDEN_WORDS, ...PICK_TOO_CLOSE_WORDS]);
  assert.deepEqual([...PICK_HIDDEN_WORDS], ["fully hidden", "mostly hidden"]);
  assert.deepEqual([...PICK_TOO_CLOSE_WORDS], ["touching", "very close"]);
  assert.ok(PICK_INSTRUCTIONS.includes('"touching" (under 0.75 m)') && PICK_INSTRUCTIONS.includes('"very close" (0.75–2 m)'));
  assert.ok(!/'[a-z ]+'/.test(PICK_INSTRUCTIONS), "no single-quoted hand-written words left");
  // Sweep the measurements: a quoted word appears in the option text exactly when the measurement is in its band,
  // and every quoted word does appear for some measurement.
  const seen = new Set();
  for (let i = 0; i <= 100; i++) {
    const v = i / 100;
    const t = describeCandidate({ visibleFrac: v, occluderKind: "tree" });
    for (const w of PICK_HIDDEN_WORDS) {
      assert.equal(t.includes(w), visibilityWord(v) === w, `visibleFrac ${v} → "${t}" vs "${w}"`);
      if (t.includes(w)) seen.add(w);
    }
  }
  for (let i = 0; i <= 1000; i++) {
    const v = i / 20; // 0 … 50 m
    const t = describeCandidate({ clearance: v, nearestKind: "tree" });
    for (const w of PICK_TOO_CLOSE_WORDS) {
      assert.equal(t.includes(w), distanceWord(v) === w, `clearance ${v} → "${t}" vs "${w}"`);
      if (t.includes(w)) seen.add(w);
    }
  }
  assert.deepEqual([...seen].sort(), [...quoted].sort(), "every quoted word can appear in an option");
  // End to end: solver words become the criteria JEV reads; each option carries exactly its problem words.
  const metrics = [
    { visibleFrac: 1, clearance: 6, nearestKind: "rock", angle: "eye" },
    { visibleFrac: 1, clearance: 0.5, nearestKind: "tree", angle: "eye" },
    { visibleFrac: 1, clearance: 1.5, nearestKind: "tree", angle: "eye" },
    { visibleFrac: 0.25, occluderKind: "tree", clearance: 6, nearestKind: "rock" },
    { visibleFrac: 0.05, occluderKind: "wall", clearance: Infinity },
  ];
  const candidates = metrics.map((m, i) => ({ id: `k${i}`, words: describeCandidate(m) }));
  const req = buildPickCandidateRequest({ intent: { framing: "MS", minClearance: 1 }, candidates });
  const crit = req.questions.candidate.criteria;
  assert.equal(req.questions.candidate.instructions, PICK_INSTRUCTIONS);
  assert.ok(validateQuestions(req.questions).ok);
  const hits = (text) => quoted.filter((w) => text.includes(w));
  assert.deepEqual(hits(crit.k0), [], `the acceptable option quotes none: ${crit.k0}`);
  assert.deepEqual(hits(crit.k1), ["touching"], crit.k1);
  assert.deepEqual(hits(crit.k2), ["very close"], crit.k2);
  assert.deepEqual(hits(crit.k3), ["mostly hidden"], crit.k3);
  assert.deepEqual(hits(crit.k4), ["fully hidden"], crit.k4);
  const client = taskClient({ candidate: { type: "choice", choice: "k0", confidence: 0.9 } });
  const r = await pickCandidate(client, { candidates });
  assert.equal(r.choice, "k0");
  assert.equal(client.requests[0].questions.candidate.instructions, PICK_INSTRUCTIONS);
  assert.deepEqual(client.requests[0].questions.candidate.criteria, crit);
});

await check("takeReportWords buckets dropped frames, safety, min visibility, unseen and pop-in", () => {
  const w = (r) => takeReportWords({ frames: 1000, ...r });
  assert.equal(w({ droppedFrames: 0 }).dropped_frames, "none");
  assert.equal(w({ droppedFrames: 3 }).dropped_frames, "a few");
  assert.equal(w({ droppedFrames: 10 }).dropped_frames, "some");
  assert.equal(w({ droppedFrames: 30 }).dropped_frames, "many");
  assert.equal(w({ safety: { adjustedFrames: 10 } }).safety_adjustments, "a few");
  assert.equal(w({ safety: { adjustedFrames: 50 } }).safety_adjustments, "some");
  assert.equal(w({ safety: { adjustedFrames: 200 } }).safety_adjustments, "many");
  assert.equal(w({ subject: { minVisibleFrac: 0.05 } }).subject_min_visibility, "fully hidden");
  assert.equal(w({ subject: { minVisibleFrac: 0.3 } }).subject_min_visibility, "mostly hidden");
  assert.equal(w({ subject: { minVisibleFrac: 0.7 } }).subject_min_visibility, "partly hidden");
  assert.equal(w({ subject: { minVisibleFrac: 0.95 } }).subject_min_visibility, "clear");
  assert.equal(w({ subject: null }).subject_min_visibility, "no subject");
  assert.equal(w({}).subject_min_visibility, "not measured");
  assert.equal(w({ subjectMaxUnseenSec: 0.5 }).subject_longest_unseen, "brief");
  assert.equal(w({ subjectMaxUnseenSec: 4 }).subject_longest_unseen, "long");
  assert.equal(w({ popInEvents: 1 }).pop_in, "one");
  assert.equal(w({ popIn: { count: 5 } }).pop_in, "many");
  assert.equal(w({ technique: "drone.rising-reveal" }).shot_kind, "reveal");
});

await check("keepOrRetake: noul P(keep) whose criteria cover dropped frames, safety, min visibility, pop-in", async () => {
  const req = buildKeepOrRetakeRequest({ frames: 900 });
  assert.equal(req.questions.keep.type, "noul");
  assert.ok(validateQuestions(req.questions).ok);
  const crit = `${req.questions.keep.criteria.true} || ${req.questions.keep.criteria.false}`;
  for (const fact of ["dropped_frames", "safety_adjustments", "subject_min_visibility", "subject_longest_unseen", "pop_in"]) {
    assert.ok(crit.includes(fact), `criteria mention ${fact}`);
  }
  assert.deepEqual(req.state, { take: req.words }, "the state is the take words only");
  const report = { frames: 1000, droppedFrames: 2, subject: { minVisibleFrac: 0.9 } };
  const yes = await keepOrRetake(taskClient({ keep: { type: "noul", noul: 0.9 } }), report);
  assert.deepEqual([yes.keep, yes.pKeep, yes.band, yes.source], [true, 0.9, "act", "jev"]);
  assert.deepEqual(yes.raw, { type: "noul", noul: 0.9 });
  const unsure = await keepOrRetake(taskClient({ keep: { type: "noul", noul: 0.7 } }), report);
  assert.deepEqual([unsure.keep, unsure.band], [true, "confirm"]);
  const coin = await keepOrRetake(taskClient({ keep: { type: "noul", noul: 0.5 } }), report);
  assert.deepEqual([coin.keep, coin.band], [false, "escalate"], "exactly 0.5 → retake, escalate");
  const no = await keepOrRetake(taskClient({ keep: { type: "noul", noul: 0.04 } }), report);
  assert.deepEqual([no.keep, no.band], [false, "act"]);
});

await check("keepOrRetake with no client: the code verdict on the same boundaries", async () => {
  const good = await keepOrRetake(null, { frames: 1000, droppedFrames: 0, subject: { minVisibleFrac: 0.9 } });
  assert.deepEqual([good.keep, good.band, good.source, good.pKeep], [true, "act", "code", 1]);
  const brief = await keepOrRetake(null, { frames: 1000, subject: { minVisibleFrac: 0.05, maxUnseenSec: 0.4 } });
  assert.deepEqual([brief.keep, brief.band], [true, "confirm"], "a brief full occlusion is a keep, but borderline");
  const hidden = await keepOrRetake(null, { frames: 1000, subject: { minVisibleFrac: 0.05, maxUnseenSec: 2 } });
  assert.equal(hidden.keep, false);
  assert.ok(hidden.reasons.some((r) => r.includes("subject_longest_unseen")));
  const reveal = await keepOrRetake(null, { frames: 1000, technique: "classic.reveal-from-occluder", subject: { minVisibleFrac: 0, maxUnseenSec: 3 } });
  assert.equal(reveal.keep, true, "a reveal may hide its subject");
  const dropped = await keepOrRetake(null, { frames: 1000, droppedFrames: 40, popInEvents: 4 });
  assert.equal(dropped.keep, false);
  assert.equal(dropped.reasons.length, 2);
});

await check("scoreSiteForLine: 5-level fit score, thresholded level, band from P(level)", async () => {
  const req = buildSiteFitRequest({ line: "the river runs to the sea", mood: "longing", site: { name: "Lin", kind: "town", words: ["coastal town", "docks"] } });
  assert.equal(req.questions.fit.type, "score");
  assert.equal(req.questions.fit.criteria.length, 5);
  assert.deepEqual(req.questions.fit.criteria, [...FIT_LEVELS]);
  assert.equal(req.state.site.look, "coastal town; docks");
  const client = taskClient({ fit: { type: "score", score: 3.4, probabilities: { 4: 0.35, 3: 0.55, 2: 0.1 } } });
  const r = await scoreSiteForLine(client, { line: "the river runs to the sea", mood: "longing", site: { name: "Lin", kind: "town", words: "coastal town" } });
  assert.equal(r.score, 3.4);
  assert.equal(r.level, 3);
  assert.equal(r.levelText, FIT_LEVELS[3]);
  assert.equal(r.confidence, 0.55);
  assert.equal(r.band, "confirm");
  assert.equal(r.raw.score, 3.4);
  const hint = await scoreSiteForLine(null, { line: "torches burn in the dark dungeon", site: { name: "Dark Dungeon", kind: "dungeon", words: "torches" } });
  assert.equal(hint.source, "code");
  assert.equal(hint.band, "escalate");
  assert.ok(hint.level >= 2);
  await assert.rejects(scoreSiteForLine(null, { line: "", site: { name: "x" } }), (e) => e.kind === "bad-request");
});

await check("sectionTechniqueFamily: six families, conservative default first, JEV answer → techniques", async () => {
  const req = buildSectionFamilyRequest({ role: "chorus", energyWord: "high", tempoWord: "moderate", lyric: "she stands alone on the hill" });
  const keys = Object.keys(req.questions.family.criteria);
  assert.deepEqual(keys, ["static-slow", "tracking", "orbit", "drone-reveal", "fpv-kinetic", "top-down"]);
  assert.deepEqual(keys, TECHNIQUE_FAMILIES.map((f) => f.key));
  assert.ok(validateQuestions(req.questions).ok);
  assert.deepEqual(req.state.section, { role: "chorus", energy: "high", tempo: "moderate", lyric: "she stands alone on the hill" });
  const client = taskClient({ family: { type: "choice", choice: "orbit", confidence: 0.91 } });
  const r = await sectionTechniqueFamily(client, { role: "chorus", energyWord: "high", tempoWord: "moderate", lyric: "she stands alone" });
  assert.equal(r.choice, "orbit");
  assert.equal(r.band, "act");
  assert.ok(r.techniques.includes("classic.orbit") && r.techniques.includes("drone.orbit-poi"));
  assert.equal(r.raw.choice, "orbit");
});

await check("codeTechniqueFamily rule table (the no-key fallback) matches the instructions' precedence", async () => {
  const cases = [
    [{ role: "intro", energyWord: "very high", tempoWord: "very fast" }, "drone-reveal"],
    [{ role: "verse", energyWord: "high", tempoWord: "fast" }, "fpv-kinetic"],
    [{ role: "bridge", energyWord: "low", tempoWord: "moderate" }, "top-down"],
    [{ role: "verse", energyWord: "low", tempoWord: "fast" }, "static-slow"],
    [{ role: "chorus", energyWord: "medium", tempoWord: "moderate" }, "orbit"],
    [{ role: "verse", energyWord: "very high", tempoWord: "moderate" }, "orbit"],
    [{ role: "verse", energyWord: "medium", tempoWord: "moderate" }, "tracking"],
    [{}, "static-slow"],
  ];
  for (const [input, want] of cases) assert.equal(codeTechniqueFamily(input), want, JSON.stringify(input));
  const code = await sectionTechniqueFamily(null, { role: "outro" });
  assert.deepEqual([code.choice, code.band, code.source], ["drone-reveal", "confirm", "code"]);
  assert.ok(code.techniques.includes("drone.rising-reveal"));
  const instr = buildSectionFamilyRequest({}).questions.family.instructions;
  assert.ok(instr.indexOf("drone-reveal") < instr.indexOf("fpv-kinetic") && instr.indexOf("fpv-kinetic") < instr.indexOf("top-down"));
});

await check("section roles = the song analyser's SECTION_ROLES; 'instrumental' (alias 'solo') reaches the top-down rule", async () => {
  // The family rules must quote the words structure.mjs assignRoles actually writes into sections[].role.
  assert.equal(SECTION_ROLES, ANALYSER_SECTION_ROLES);
  assert.deepEqual([...SECTION_ROLES], ["intro", "verse", "prechorus", "chorus", "bridge", "instrumental", "outro", "unknown"]);
  assert.ok(!SECTION_ROLES.includes("solo"));
  // Every role word a firm rule or a criterion quotes is one the analyser can emit.
  const texts = [buildSectionFamilyRequest({}).questions.family.instructions, ...TECHNIQUE_FAMILIES.map((f) => f.criteria)];
  const quoted = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(/\brole (?:is )?(?:not )?('[a-z]+'(?:(?:,| or|, or) '[a-z]+')*)/g)) {
      for (const w of m[1].matchAll(/'([a-z]+)'/g)) quoted.add(w[1]);
    }
  }
  assert.ok(quoted.has("instrumental") && quoted.has("bridge") && quoted.has("intro") && quoted.has("chorus"), [...quoted].join(","));
  for (const w of quoted) assert.ok(SECTION_ROLES.includes(w), `criteria quote role '${w}' the analyser never emits`);
  const topDown = TECHNIQUE_FAMILIES.find((f) => f.key === "top-down").criteria;
  assert.match(topDown, /role is 'bridge' or 'instrumental' and energy is 'low' or 'medium'/);
  assert.doesNotMatch(topDown + buildSectionFamilyRequest({}).questions.family.instructions, /solo/);
  // Aliases map onto analyser roles; normalisation is case/space-insensitive and prototype-safe.
  for (const [alias, role] of Object.entries(SECTION_ROLE_ALIASES)) assert.ok(SECTION_ROLES.includes(role), `${alias} → ${role}`);
  assert.equal(sectionRoleOf("solo"), "instrumental");
  assert.equal(sectionRoleOf("  Solo "), "instrumental");
  assert.equal(sectionRoleOf("INSTRUMENTAL"), "instrumental");
  assert.equal(sectionRoleOf("bridge"), "bridge");
  assert.equal(sectionRoleOf(""), "unknown");
  assert.equal(sectionRoleOf(undefined), "unknown");
  assert.equal(sectionRoleOf("constructor"), "constructor");
  assert.equal(sectionRoleOf("hook"), "hook");
  // Code verdict: an analysed instrumental section (low/medium energy) → top-down, same as a bridge.
  const cases = [
    [{ role: "instrumental", energyWord: "low", tempoWord: "moderate" }, "top-down"],
    [{ role: "instrumental", energyWord: "medium", tempoWord: "slow" }, "top-down"],
    [{ role: "solo", energyWord: "medium", tempoWord: "moderate" }, "top-down"],
    [{ role: "Solo", energyWord: "low", tempoWord: "moderate" }, "top-down"],
    [{ role: "instrumental", energyWord: "high", tempoWord: "fast" }, "fpv-kinetic"],
    [{ role: "instrumental", energyWord: "very low", tempoWord: "moderate" }, "static-slow"],
    [{ role: "instrumental", energyWord: "high", tempoWord: "moderate" }, "tracking"],
    [{ role: "verse", energyWord: "low", tempoWord: "moderate" }, "static-slow"],
  ];
  for (const [input, want] of cases) assert.equal(codeTechniqueFamily(input), want, JSON.stringify(input));
  const code = await sectionTechniqueFamily(null, { role: "instrumental", energyWord: "medium", tempoWord: "moderate" });
  assert.deepEqual([code.choice, code.source], ["top-down", "code"]);
  assert.ok(code.techniques.includes("drone.top-down"));
  // The JEV request carries the analyser's word, so the model sees the role the criteria quote.
  assert.equal(buildSectionFamilyRequest({ role: "solo", energyWord: "low" }).state.section.role, "instrumental");
  assert.equal(buildSectionFamilyRequest({ role: "Instrumental" }).state.section.role, "instrumental");
});

await check("task errors propagate as JevError (the CLI can fall back to client = null)", async () => {
  const client = {
    decide: async () => {
      throw new JevError("budget", "cap");
    },
  };
  await assert.rejects(sectionTechniqueFamily(client, { role: "verse" }), (e) => e instanceof JevError && e.kind === "budget");
});

console.log(`\nfilm jev broker + tasks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
