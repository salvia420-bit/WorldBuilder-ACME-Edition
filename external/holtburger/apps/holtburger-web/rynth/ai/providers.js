// providers.js — static catalog of OpenAI-compatible providers + cost/token
// estimation for the AI director UI/prompts (B3, post-v1 layer).
//
// Grounds what ui.js currently hardcodes (ui.js:38-43 MODEL_SUGGESTIONS) and
// gives the director a way to pre-check an observation against a token budget
// without an API round-trip. Pure data + pure functions: no network, no fs,
// no globals. This module does NOT touch llm_client.js or ui.js — the
// integrator wires it later.
//
// PRICING IS APPROXIMATE: inUsdPerMtok/outUsdPerMtok are rough mid-2026
// list-price hints (USD per 1M tokens) for UI cost display only — never
// billing truth. Providers reprice without notice; check docsUrl.
//
// `estimated: true` (09 S2/D1, 2026-07-23) marks an entry priced from
// category/sibling-model comparison rather than a confirmed current
// OpenRouter listing — still a real number (never null/0-by-default), just
// lower-confidence; kept conservative (rounded up) so a $ spend guard reading
// it (director.js) over-, never under-, estimates cost. Untagged entries are
// the original catalog's own confidence level (unchanged).

// Default model must stay in sync with llm_client.js DEFAULT_MODEL
// ("openai/gpt-oss-120b") — asserted in rynth_ai_providers_test.cjs.
export const DEFAULT_PROVIDER = "openrouter";

export const PROVIDERS = deepFreeze({
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPrefix: "sk-or-",
    corsOk: true, // SPEC.md:13 — browser CORS is supported
    docsUrl: "https://openrouter.ai/docs",
    models: [
      // Superset of the ui.js datalist; keep the SPEC default first.
      { id: "openai/gpt-oss-120b", inUsdPerMtok: 0.037, outUsdPerMtok: 0.17 },
      { id: "meta-llama/llama-3.1-8b-instruct", inUsdPerMtok: 0.05, outUsdPerMtok: 0.08 },
      { id: "anthropic/claude-haiku-4.5", inUsdPerMtok: 1.0, outUsdPerMtok: 5.0 },
      { id: "anthropic/claude-sonnet-4.6", inUsdPerMtok: 3.0, outUsdPerMtok: 15.0 },
      { id: "openai/gpt-4o-mini", inUsdPerMtok: 0.15, outUsdPerMtok: 0.6 },
      { id: "google/gemini-2.0-flash-001", inUsdPerMtok: 0.1, outUsdPerMtok: 0.4 },
      // Live-rig model history (09 S2/D1, STREAM-RIG-OPS.md): the fast-
      // provider pin + this cost catalog only ever covered z-ai/gpt-oss, so
      // `estimateCost` returned known:false for every model the rig actually
      // ran — including the CURRENT live model. Added so the new $ spend
      // guard (director.js) isn't blind to them.
      // z-ai/glm-5.2: soak-8-pinned fast fp8 sale endpoints (streamlake/
      // novita/baidu), ~$0.05/hour measured at 400-800 completion tok/call
      // (HANDOFF-playtester-soak-8.md) — sale pricing, category estimate.
      { id: "z-ai/glm-5.2", inUsdPerMtok: 0.14, outUsdPerMtok: 0.58, estimated: true },
      // microsoft/phi-4: small-class open model, ran the director for the
      // 2026-07-20 rig (HANDOFF-wedge-closeout-phi4-rig-2026-07-20.md);
      // no soak $/hour figure recorded — conservative small-model estimate.
      { id: "microsoft/phi-4", inUsdPerMtok: 0.07, outUsdPerMtok: 0.14, estimated: true },
      // minimax/minimax-m3: CURRENT live rig model (STREAM-RIG-OPS.md), the
      // subject of 09 C1 — was completely absent from this catalog. ~$0.33/
      // hour measured, 3.5k completion tok/call, i.e. markedly pricier than
      // the pinned z-ai run above (HANDOFF-playtester-soak-4.md) — priced at
      // the high end of its size class, rounded up (conservative).
      { id: "minimax/minimax-m3", inUsdPerMtok: 0.55, outUsdPerMtok: 2.2, estimated: true },
    ],
  },
  custom: {
    id: "custom",
    label: "Custom (any OpenAI-compatible)",
    baseUrl: "", // user-supplied; providerForBaseUrl falls back here
    keyPrefix: "",
    corsOk: null, // unknown — depends on the provider
    docsUrl: null,
    models: [],
  },
  local: {
    id: "local",
    label: "Local (LM Studio / llama.cpp)",
    baseUrl: "http://127.0.0.1:1234/v1", // LM Studio default port
    keyPrefix: "", // local servers generally ignore the key
    corsOk: false, // off by default in LM Studio; must be enabled for browser pages
    docsUrl: "https://lmstudio.ai/docs/api/openai-api",
    models: [
      // "local-model" is LM Studio's generic id for whatever is loaded.
      { id: "local-model", inUsdPerMtok: 0, outUsdPerMtok: 0 },
    ],
  },
});

/**
 * Rough cost for one call. -> { usd, known } — known:false + usd:null when
 * the model id isn't in the table (custom/local ids the user typed in).
 * Missing/non-numeric token counts are treated as 0, so a known model always
 * yields a number (0-cost local models included: known:true, usd:0).
 */
export function estimateCost({ model, promptTokens, completionTokens } = {}) {
  const m = findModel(model);
  if (!m) return { usd: null, known: false };
  const inTok = Number(promptTokens) || 0;
  const outTok = Number(completionTokens) || 0;
  return {
    usd: (inTok * m.inUsdPerMtok + outTok * m.outUsdPerMtok) / 1e6,
    known: true,
  };
}

/**
 * chars/4 heuristic (the usual English-ish BPE ballpark), min 1 — lets the
 * director budget-check an observation without an API round-trip. Non-string
 * input is treated as empty.
 */
export function estimateTokens(text) {
  const len = typeof text === "string" ? text.length : 0;
  return Math.max(1, Math.ceil(len / 4));
}

/**
 * Match a configured baseUrl to a catalog provider. Tolerates trailing
 * slashes and case (llm_client.js:82 strips trailing "/" the same way).
 * Unmatched but non-empty -> the generic "custom" entry; empty/invalid -> null.
 */
export function providerForBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string") return null;
  const norm = normalizeBaseUrl(baseUrl);
  if (!norm) return null;
  for (const p of Object.values(PROVIDERS)) {
    if (p.baseUrl && normalizeBaseUrl(p.baseUrl) === norm) return p;
  }
  return PROVIDERS.custom;
}

/** Model entries for a provider id; unknown id -> [] (safe to iterate). */
export function modelsFor(providerId) {
  const p = typeof providerId === "string" ? PROVIDERS[providerId] : null;
  return p ? p.models : [];
}

function normalizeBaseUrl(u) {
  return u.trim().replace(/\/+$/, "").toLowerCase();
}

function findModel(id) {
  if (typeof id !== "string" || !id) return null;
  for (const p of Object.values(PROVIDERS)) {
    for (const m of p.models) if (m.id === id) return m;
  }
  return null;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") deepFreeze(v);
  }
  return Object.freeze(obj);
}
