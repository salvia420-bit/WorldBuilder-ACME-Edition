#!/usr/bin/env node
// rynth_ai_client_test.cjs — unit tests for rynth/ai/llm_client.js (A1).
// No infra, no network: an in-process http server on 127.0.0.1 plays the
// OpenAI-compatible provider (success, 429/500-then-ok, 401, hang, garbage).
//
// Run: node rynth_ai_client_test.cjs   (exits 1 on any FAIL)

"use strict";
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "llm_client.js")).href);
  const { LlmClient, extractJson, DEFAULT_BASE_URL, DEFAULT_MODEL, KEY_STORAGE } = mod;

  // ---- frozen constants (SPEC §llm_client) ----
  check("DEFAULT_BASE_URL", DEFAULT_BASE_URL === "https://openrouter.ai/api/v1", DEFAULT_BASE_URL);
  check("DEFAULT_MODEL", DEFAULT_MODEL === "openai/gpt-oss-120b", DEFAULT_MODEL);
  check("KEY_STORAGE", KEY_STORAGE === "holtburger_ai_key_v1", KEY_STORAGE);

  // ---- extractJson matrix ----
  check("extractJson bare", eq(extractJson('{"a":1}'), { a: 1 }));
  check("extractJson bare + whitespace", eq(extractJson('  \n {"a":1} \n'), { a: 1 }));
  check("extractJson ```json fence", eq(extractJson('```json\n{"a": 1, "b": [2]}\n```'), { a: 1, b: [2] }));
  check("extractJson bare fence", eq(extractJson('```\n{"b":2}\n```'), { b: 2 }));
  check("extractJson fence + outer prose", eq(
    extractJson('Sure, here is the plan:\n```json\n{"analysis":"ok","actions":[]}\n```\nHope that helps!'),
    { analysis: "ok", actions: [] }));
  check("extractJson fence + inner prose", eq(extractJson('```json\nHere: {"e":5}\n```'), { e: 5 }));
  check("extractJson prose-wrapped", eq(extractJson('I think {"c":3} is best.'), { c: 3 }));
  check("extractJson brace-in-string", eq(extractJson('take {"c":{"d":"}"}} ok'), { c: { d: "}" } }));
  check("extractJson escaped quote in string", eq(extractJson('{"s":"a\\"b}"}'), { s: 'a"b}' }));
  check("extractJson skips non-JSON braces", eq(extractJson("weights {not json} then {\"ok\":true}"), { ok: true }));
  check("extractJson invalid -> null", extractJson("no json here") === null);
  check("extractJson unbalanced -> null", extractJson('{"a":1') === null);
  check("extractJson bare array -> null (contract wants an object)", extractJson("[1,2]") === null);
  check("extractJson empty -> null", extractJson("") === null);
  check("extractJson non-string -> null", extractJson(null) === null && extractJson(undefined) === null && extractJson(42) === null);

  // ---- localStorage statics under node: no-throw, null/no-op ----
  {
    let threw = false;
    let loaded = "sentinel";
    try {
      LlmClient.saveKey("sk-or-test");
      loaded = LlmClient.loadKey(); // string if this node has webstorage, else null
      LlmClient.clearKey();
    } catch { threw = true; }
    check("key statics no-throw", !threw);
    check("loadKey after save is string|null", loaded === null || loaded === "sk-or-test", String(loaded));
    check("loadKey after clear is null", LlmClient.loadKey() === null);
    check("saveKey(null) no-throw", (() => { try { LlmClient.saveKey(null); return true; } catch { return false; } })());
  }

  // ---- mock provider server ----
  const FENCED = 'Analysis first.\n```json\n{"analysis":"ok","actions":[]}\n```\ndone';
  const state = { mode: "ok", modeHits: 0, content: FENCED, requests: [] };
  const server = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      state.modeHits++;
      let body = null;
      try { body = JSON.parse(buf); } catch {}
      state.requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      const ok = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "cmpl-1", model: "srv-model",
          choices: [{ index: 0, message: { role: "assistant", content: state.content } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }));
      };
      switch (state.mode) {
        case "ok": return ok();
        case "ok-nousage":
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ model: "srv-model", choices: [{ message: { content: "plain" } }] }));
        case "429-then-ok":
          if (state.modeHits === 1) { res.writeHead(429); return res.end('{"error":{"message":"slow down"}}'); }
          return ok();
        case "500-then-ok":
          if (state.modeHits === 1) { res.writeHead(500); return res.end("upstream boom"); }
          return ok();
        case "401": res.writeHead(401); return res.end('{"error":{"message":"bad key"}}');
        case "not-json":
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end("<html>definitely not json</html>");
        case "hang": return; // never respond — client timeout must fire
        default: res.writeHead(500); return res.end("bad test mode");
      }
    });
  });
  const setMode = (m) => { state.mode = m; state.modeHits = 0; };
  const lastReq = () => state.requests[state.requests.length - 1];
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const client = new LlmClient({
    apiKey: "test-key-123", baseUrl: base + "/", // trailing slash must normalize
    model: "ctor-model", referer: "https://example.test/app", title: "holtburger-test",
    timeoutMs: 5000, log: () => {},
  });

  // ---- success path: text + json + usage + model + ms, request shape ----
  {
    setMode("ok");
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "obs" }];
    const r = await client.chat(msgs);
    check("chat text", r.text === FENCED, r.text);
    check("chat json extracted", eq(r.json, { analysis: "ok", actions: [] }), JSON.stringify(r.json));
    check("chat usage", eq(r.usage, { prompt: 100, completion: 20 }), JSON.stringify(r.usage));
    check("chat model from response", r.model === "srv-model", r.model);
    check("chat ms", typeof r.ms === "number" && r.ms >= 0, String(r.ms));
    const q = lastReq();
    check("POST /chat/completions (slash normalized)", q.method === "POST" && q.url === "/v1/chat/completions", `${q.method} ${q.url}`);
    check("auth header", q.headers.authorization === "Bearer test-key-123", q.headers.authorization);
    check("referer header", q.headers["http-referer"] === "https://example.test/app", q.headers["http-referer"]);
    check("title header", q.headers["x-title"] === "holtburger-test", q.headers["x-title"]);
    check("body model/messages", q.body.model === "ctor-model" && eq(q.body.messages, msgs), JSON.stringify(q.body));
    check("body defaults", q.body.max_tokens === 1024 && q.body.temperature === 0.4, JSON.stringify(q.body));
  }

  // ---- per-call overrides + missing usage -> zeros, plain text -> json null ----
  {
    setMode("ok-nousage");
    const r = await client.chat([{ role: "user", content: "x" }], { model: "override-model", maxTokens: 64, temperature: 0 });
    const q = lastReq();
    check("override body", q.body.model === "override-model" && q.body.max_tokens === 64 && q.body.temperature === 0, JSON.stringify(q.body));
    check("missing usage -> zeros", eq(r.usage, { prompt: 0, completion: 0 }), JSON.stringify(r.usage));
    check("non-JSON content -> json null", r.text === "plain" && r.json === null);
  }

  // ---- retry: 429 then success (exactly one retry, one completed call) ----
  {
    setMode("429-then-ok");
    const callsBefore = client.spend.calls;
    const r = await client.chat([{ role: "user", content: "x" }]);
    check("429 retried once then ok", state.modeHits === 2 && r.text === FENCED, `hits=${state.modeHits}`);
    check("429 retry counts one call", client.spend.calls === callsBefore + 1, JSON.stringify(client.spend));
  }

  // ---- retry: 500 then success ----
  {
    setMode("500-then-ok");
    const r = await client.chat([{ role: "user", content: "x" }]);
    check("500 retried once then ok", state.modeHits === 2 && r.text === FENCED, `hits=${state.modeHits}`);
  }

  // ---- hard 401 -> kind "auth", NO retry ----
  {
    setMode("401");
    let err = null;
    try { await client.chat([{ role: "user", content: "x" }]); } catch (e) { err = e; }
    check("401 throws kind auth", err instanceof Error && err.kind === "auth", err && `${err.kind}: ${err.message}`);
    check("401 not retried", state.modeHits === 1, `hits=${state.modeHits}`);
  }

  // ---- 200 non-JSON body -> kind "bad-response", NO retry ----
  {
    setMode("not-json");
    let err = null;
    try { await client.chat([{ role: "user", content: "x" }]); } catch (e) { err = e; }
    check("garbage body throws bad-response", err?.kind === "bad-response", err && `${err.kind}: ${err.message}`);
    check("bad-response not retried", state.modeHits === 1, `hits=${state.modeHits}`);
  }

  // ---- timeout: server never responds, timeoutMs ~200 -> kind "timeout" ----
  {
    setMode("hang");
    const fast = new LlmClient({ apiKey: "k", baseUrl: base, timeoutMs: 200, log: () => {} });
    const t0 = Date.now();
    let err = null;
    try { await fast.chat([{ role: "user", content: "x" }]); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    check("timeout throws kind timeout", err?.kind === "timeout", err && `${err.kind}: ${err.message}`);
    check("timeout not retried", state.modeHits === 1, `hits=${state.modeHits}`);
    check("timeout is prompt", ms >= 150 && ms < 5000, `${ms}ms`);
    check("timeout counted in errors", fast.spend.errors === 1, JSON.stringify(fast.spend));
  }

  // ---- network error: connection refused -> kind "network" (after 1 retry) ----
  {
    const tmp = http.createServer(() => {});
    await new Promise((r) => tmp.listen(0, "127.0.0.1", r));
    const deadPort = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    const dead = new LlmClient({ apiKey: "k", baseUrl: `http://127.0.0.1:${deadPort}/v1`, timeoutMs: 2000, log: () => {} });
    let err = null;
    try { await dead.chat([{ role: "user", content: "x" }]); } catch (e) { err = e; }
    check("refused throws kind network", err?.kind === "network", err && `${err.kind}: ${err.message}`);
    check("network error counted", dead.spend.errors === 1, JSON.stringify(dead.spend));
  }

  // ---- spend accumulation on a fresh client ----
  {
    setMode("ok");
    const c = new LlmClient({ apiKey: "k", baseUrl: base, timeoutMs: 5000, log: () => {} });
    check("spend starts zeroed", eq(c.spend, { calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 }), JSON.stringify(c.spend));
    await c.chat([{ role: "user", content: "a" }]);
    await c.chat([{ role: "user", content: "b" }]);
    check("spend accumulates", eq(c.spend, { calls: 2, promptTokens: 200, completionTokens: 40, errors: 0 }), JSON.stringify(c.spend));
    setMode("401");
    try { await c.chat([{ role: "user", content: "c" }]); } catch {}
    check("spend errors accumulate, calls untouched",
      eq(c.spend, { calls: 2, promptTokens: 200, completionTokens: 40, errors: 1 }), JSON.stringify(c.spend));
    const snap = c.spend;
    snap.calls = 999;
    check("spend getter returns a copy", c.spend.calls === 2, JSON.stringify(c.spend));
  }

  // ---- keyless client sends no Authorization (local mock server case) ----
  {
    setMode("ok");
    const anon = new LlmClient({ baseUrl: base, timeoutMs: 5000, log: () => {} });
    await anon.chat([{ role: "user", content: "x" }]);
    check("no key -> no auth header", lastReq().headers.authorization === undefined, lastReq().headers.authorization);
    check("default model in body", lastReq().body.model === DEFAULT_MODEL, lastReq().body.model);
  }

  server.closeAllConnections?.(); // hung "hang"-mode sockets
  await new Promise((r) => server.close(r));

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
