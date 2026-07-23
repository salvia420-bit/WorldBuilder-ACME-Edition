#!/usr/bin/env node
// rynth_ai_mock_contract_test.cjs — pure-node contract test closing the
// "mock drift" gap (rynth-review 14 #4/C-2, 17-SYNTHESIS streamline #11):
// the high-fidelity HTTP OpenAI-compatible mock (rynth/ai/mock_llm_server.cjs
// — SPEC.md §Verification bar, A7) used to be exercised ONLY by the
// orphaned, live-infra rynth_ai_smoke.cjs (never auto-run by either
// harness); its own `--selftest` is a CLI mode, not a `*_test.cjs`, so the
// node runner never ran it either. A change to either side — the mock's
// canned script, OR the REAL parsing contract in rynth/ai/llm_client.js /
// rynth/ai/actions.js the live director actually uses — could silently
// diverge and would only be caught live, mid-soak (exactly the failure mode
// STREAM-RIG-OPS.md's "the director looked dead" postmortems describe).
//
// This test is pure node: it starts the REAL mock_llm_server.cjs in-process
// on an EPHEMERAL port (no fixed :8899, no collision risk), then drives it
// with the REAL rynth/ai/llm_client.js LlmClient (the exact class the live
// director uses) and validates every parsed action against the REAL
// rynth/ai/actions.js#validateAction catalog. If the mock's script ever
// stops matching what LlmClient.chat()/extractJson()/validateAction()
// currently accept, this goes red instead of silently rotting.
//
// Run: node rynth_ai_mock_contract_test.cjs

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { startMockLlmServer, DEFAULT_SCRIPT } = require("./rynth/ai/mock_llm_server.cjs");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const aiUrl = (f) => pathToFileURL(path.join(__dirname, "rynth", "ai", f)).href;

(async () => {
  const { LlmClient } = await import(aiUrl("llm_client.js"));
  const { validateAction } = await import(aiUrl("actions.js"));

  let mock = null;
  try {
    check("DEFAULT_SCRIPT shape: exactly 2 scripted replies (opening plan + steady no-op)",
      Array.isArray(DEFAULT_SCRIPT) && DEFAULT_SCRIPT.length === 2, String(DEFAULT_SCRIPT && DEFAULT_SCRIPT.length));

    // Ephemeral port (0) — no fixed-port collision with a concurrently
    // running rynth_ai_smoke.cjs (which pins :8899) or another CI shard.
    mock = await startMockLlmServer({ port: 0, log: () => {} });

    // The REAL client, pointed at the mock, with a REAL provider config
    // shape (reasoning/provider omitted -> fields omitted, same as a plain
    // OpenRouter-compatible backend the mock impersonates).
    const client = new LlmClient({ baseUrl: mock.url, model: "mock-contract-test", maxTokens: 512, timeoutMs: 5000 });

    // ---- Reply 1: the director's opening plan (set_loot_min_value + note) ----
    const r1 = await client.chat([{ role: "system", content: "sys" }, { role: "user", content: "observation 1" }]);
    check("reply1: LlmClient.chat() resolves (no thrown .kind error)", !!r1 && typeof r1 === "object");
    check("reply1: text is a non-empty string (choices[0].message.content contract)",
      typeof r1.text === "string" && r1.text.length > 0);
    check("reply1: usage.prompt/completion are finite numbers (usage.*_tokens contract)",
      Number.isFinite(r1.usage?.prompt) && Number.isFinite(r1.usage?.completion), JSON.stringify(r1.usage));
    check("reply1: model echoed back as a string", typeof r1.model === "string" && r1.model.length > 0, String(r1.model));
    // r1.json is populated by LlmClient's OWN extractJson call (llm_client.js
    // _attempt()) — this is the exact parse the director relies on.
    check("reply1: LlmClient's extractJson parsed a plan object", r1.json != null && typeof r1.json === "object", JSON.stringify(r1.json));
    check("reply1: plan.analysis is a string", typeof r1.json?.analysis === "string", JSON.stringify(r1.json));
    check("reply1: plan.actions is an array", Array.isArray(r1.json?.actions), JSON.stringify(r1.json));
    check("reply1: plan.next_check_minutes is a finite number", Number.isFinite(r1.json?.next_check_minutes), String(r1.json?.next_check_minutes));
    check("reply1: exactly 2 scripted actions (set_loot_min_value, note)",
      Array.isArray(r1.json?.actions) && r1.json.actions.length === 2, JSON.stringify(r1.json?.actions));
    // The mock-rot bar: every scripted action must still validate under
    // TODAY's actions.js catalog, not just parse as JSON.
    for (const a of r1.json?.actions || []) {
      const v = validateAction(a);
      check(`reply1: action '${a && a.type}' passes actions.js#validateAction`, v && v.ok === true, JSON.stringify(v));
    }
    check("reply1: scripted set_loot_min_value carries value 4321 (the smoke's own asserted fixture)",
      r1.json?.actions?.[0]?.type === "set_loot_min_value" && r1.json.actions[0].value === 4321,
      JSON.stringify(r1.json?.actions?.[0]));

    // ---- Reply 2..N: the steady no-op plan every subsequent check-in gets ----
    const r2 = await client.chat([{ role: "user", content: "observation 2" }]);
    check("reply2: plan.actions[0].type === 'none'", r2.json?.actions?.[0]?.type === "none", JSON.stringify(r2.json));
    const v2 = validateAction(r2.json?.actions?.[0]);
    check("reply2: 'none' action passes actions.js#validateAction", v2 && v2.ok === true, JSON.stringify(v2));

    const r3 = await client.chat([{ role: "user", content: "observation 3" }]);
    check("reply3: script repeats (2..N convention) — still 'none'", r3.json?.actions?.[0]?.type === "none", JSON.stringify(r3.json));

    // ---- Dual-mount contract: LlmClient above only ever posts the bare
    // `${baseUrl}/chat/completions` path (llm_client.js never adds /v1) —
    // r1/r2/r3 already pin that mount works. The mock's OWN stated contract
    // (mock_llm_server.cjs header) additionally claims a real OpenRouter-
    // style `/v1/chat/completions` mount and CORS on every response,
    // independent of what LlmClient happens to use — verify that half too,
    // with a raw fetch, so a regression there isn't masked by only ever
    // exercising the bare path.
    const rawV1 = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "obs" }], max_tokens: 512 }),
    });
    check("mock also answers the /v1/chat/completions mount", rawV1.status === 200, `status=${rawV1.status}`);
    check("mock's CORS header is present on every response (page at :8765 fetches this cross-origin)",
      rawV1.headers.get("access-control-allow-origin") === "*", rawV1.headers.get("access-control-allow-origin"));
  } finally {
    if (mock) await mock.close();
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e && e.stack || e);
  process.exit(1);
});
