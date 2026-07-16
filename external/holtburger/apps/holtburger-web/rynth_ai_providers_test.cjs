#!/usr/bin/env node
// rynth_ai_providers_test.cjs — unit tests for rynth/ai/providers.js (the
// provider/model catalog + cost/token estimation, B3). No infra, no network:
// everything under test is pure data/functions. llm_client.js is imported
// READ-ONLY to assert the catalog stays in sync with the frozen v1 defaults.
//
// Run: node rynth_ai_providers_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const aiUrl = (f) => pathToFileURL(path.join(__dirname, "rynth", "ai", f)).href;
  const mod = await import(aiUrl("providers.js"));
  const { PROVIDERS, DEFAULT_PROVIDER, estimateCost, estimateTokens, providerForBaseUrl, modelsFor } = mod;
  const { DEFAULT_MODEL, DEFAULT_BASE_URL } = await import(aiUrl("llm_client.js"));

  // ---- Table integrity.
  check("table: expected provider ids", ["openrouter", "custom", "local"]
    .every((id) => PROVIDERS[id] && PROVIDERS[id].id === id),
    Object.keys(PROVIDERS).join(","));
  check("table: default provider is openrouter", DEFAULT_PROVIDER === "openrouter");
  for (const [id, p] of Object.entries(PROVIDERS)) {
    check(`table: ${id} has baseUrl+models`,
      typeof p.baseUrl === "string" && Array.isArray(p.models));
    check(`table: ${id} models well-formed`, p.models.every((m) =>
      typeof m.id === "string" && m.id.length > 0
      && Number.isFinite(m.inUsdPerMtok) && m.inUsdPerMtok >= 0
      && Number.isFinite(m.outUsdPerMtok) && m.outUsdPerMtok >= 0));
  }
  check("table: openrouter matches v1 client default baseUrl",
    PROVIDERS.openrouter.baseUrl === DEFAULT_BASE_URL, PROVIDERS.openrouter.baseUrl);
  check("table: openrouter keyPrefix/corsOk/docsUrl",
    PROVIDERS.openrouter.keyPrefix === "sk-or-"
    && PROVIDERS.openrouter.corsOk === true
    && typeof PROVIDERS.openrouter.docsUrl === "string");
  check("table: SPEC default model present in openrouter catalog",
    PROVIDERS.openrouter.models.some((m) => m.id === DEFAULT_MODEL), DEFAULT_MODEL);
  check("table: local baseUrl", PROVIDERS.local.baseUrl === "http://127.0.0.1:1234/v1");
  check("table: deep-frozen (models array immutable)", (() => {
    try { PROVIDERS.openrouter.models.push({ id: "hax" }); } catch { /* strict-mode throw */ }
    try { PROVIDERS.openrouter.models[0].inUsdPerMtok = 999; } catch { /* strict-mode throw */ }
    return PROVIDERS.openrouter.models.every((m) => m.id !== "hax")
      && PROVIDERS.openrouter.models[0].inUsdPerMtok !== 999;
  })());

  // ---- estimateCost: known model — expected value computed FROM the table so
  // price hint updates don't break the test.
  {
    const m = PROVIDERS.openrouter.models.find((x) => x.id === DEFAULT_MODEL);
    const r = estimateCost({ model: DEFAULT_MODEL, promptTokens: 2_000_000, completionTokens: 500_000 });
    const want = (2_000_000 * m.inUsdPerMtok + 500_000 * m.outUsdPerMtok) / 1e6;
    check("cost: known model math", r.known === true && Math.abs(r.usd - want) < 1e-9,
      `usd=${r.usd} want=${want}`);
    check("cost: known model, zero tokens -> usd 0",
      (() => { const z = estimateCost({ model: DEFAULT_MODEL }); return z.known === true && z.usd === 0; })());
    const local = estimateCost({ model: "local-model", promptTokens: 1e6, completionTokens: 1e6 });
    check("cost: zero-priced local model is known, usd 0", local.known === true && local.usd === 0);
  }
  check("cost: unknown model -> {usd:null, known:false}", (() => {
    const r = estimateCost({ model: "totally/made-up", promptTokens: 1000, completionTokens: 1000 });
    return r.usd === null && r.known === false;
  })());
  check("cost: no args / missing model -> unknown", (() => {
    const a = estimateCost();
    const b = estimateCost({ promptTokens: 5 });
    return a.known === false && a.usd === null && b.known === false && b.usd === null;
  })());
  check("cost: non-numeric token counts treated as 0", (() => {
    const r = estimateCost({ model: DEFAULT_MODEL, promptTokens: "junk", completionTokens: undefined });
    return r.known === true && r.usd === 0;
  })());

  // ---- estimateTokens: chars/4, min 1, integer, monotonic.
  check("tokens: min 1 on empty/non-string",
    estimateTokens("") === 1 && estimateTokens(null) === 1 && estimateTokens(undefined) === 1
    && estimateTokens(42) === 1);
  check("tokens: chars/4 ceil", estimateTokens("abcd") === 1 && estimateTokens("abcde") === 2
    && estimateTokens("x".repeat(400)) === 100);
  check("tokens: always integer", Number.isInteger(estimateTokens("abc")) && Number.isInteger(estimateTokens("x".repeat(4097))));
  check("tokens: monotonic in length", (() => {
    let prev = 0;
    for (let n = 0; n <= 64; n++) {
      const t = estimateTokens("y".repeat(n));
      if (t < prev) return false;
      prev = t;
    }
    return true;
  })());

  // ---- providerForBaseUrl: exact, trailing slash, case, fallback, invalid.
  check("baseUrl: exact openrouter match",
    providerForBaseUrl("https://openrouter.ai/api/v1") === PROVIDERS.openrouter);
  check("baseUrl: trailing slash(es) normalized",
    providerForBaseUrl("https://openrouter.ai/api/v1/") === PROVIDERS.openrouter
    && providerForBaseUrl("https://openrouter.ai/api/v1//") === PROVIDERS.openrouter);
  check("baseUrl: case + whitespace normalized",
    providerForBaseUrl("  HTTPS://OpenRouter.AI/api/v1  ") === PROVIDERS.openrouter);
  check("baseUrl: local match", providerForBaseUrl("http://127.0.0.1:1234/v1/") === PROVIDERS.local);
  check("baseUrl: unknown non-empty -> custom fallback",
    providerForBaseUrl("https://api.example.com/v1") === PROVIDERS.custom);
  check("baseUrl: empty/invalid -> null",
    providerForBaseUrl("") === null && providerForBaseUrl("   ") === null
    && providerForBaseUrl(null) === null && providerForBaseUrl(undefined) === null
    && providerForBaseUrl(123) === null);

  // ---- modelsFor.
  check("modelsFor: openrouter includes SPEC default",
    modelsFor("openrouter").some((m) => m.id === DEFAULT_MODEL));
  check("modelsFor: returns the catalog arrays",
    modelsFor("openrouter") === PROVIDERS.openrouter.models
    && modelsFor("local") === PROVIDERS.local.models
    && modelsFor("custom") === PROVIDERS.custom.models);
  check("modelsFor: unknown/invalid id -> []", (() => {
    const a = modelsFor("nope"), b = modelsFor(null), c = modelsFor();
    return Array.isArray(a) && a.length === 0 && Array.isArray(b) && b.length === 0
      && Array.isArray(c) && c.length === 0;
  })());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
