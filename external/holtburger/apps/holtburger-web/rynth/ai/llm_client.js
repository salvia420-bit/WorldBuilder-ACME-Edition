// llm_client.js — OpenAI-compatible chat client (OpenRouter default) for the
// rynth AI director. INTERFACE FROZEN — see rynth/ai/SPEC.md §llm_client.
//
// One POST to {baseUrl}/chat/completions per chat(); exactly 1 retry on
// 429/5xx/network (timeout and auth are NOT retried — a hung provider at
// 60s timeoutMs would double the stall, and a bad key never fixes itself).
// Every failure throws Error with .kind in
// {"auth","rate","server","network","timeout","bad-response"} so the
// director can branch without string-matching messages.

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
export const KEY_STORAGE = "holtburger_ai_key_v1";

/**
 * Tolerant JSON extraction: bare object, ```json fences, prose around it.
 * Returns the first parseable OBJECT (the reply contract is an object, so
 * bare arrays/scalars -> null). Never throws.
 */
export function extractJson(text) {
  if (typeof text !== "string" || !text) return null;
  const direct = tryParseObject(text.trim());
  if (direct) return direct;
  // Fenced blocks first — a model that fences its JSON usually puts prose
  // OUTSIDE the fence, so the fence body is the highest-confidence candidate.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m; (m = fenceRe.exec(text)); ) {
    const inner = m[1].trim();
    const parsed = tryParseObject(inner) ?? scanForObject(inner);
    if (parsed) return parsed;
  }
  return scanForObject(text);
}

function tryParseObject(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Walk each '{' and slice out the balanced object (string/escape aware, so
// braces inside string values don't fool the depth count); first slice that
// JSON.parses wins.
function scanForObject(s) {
  for (let i = s.indexOf("{"); i !== -1; i = s.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const v = tryParseObject(s.slice(i, j + 1));
        if (v) return v;
        break; // balanced but unparseable — advance to the next '{'
      }
    }
  }
  return null;
}

function kindError(kind, message, extra) {
  const e = new Error(message);
  e.kind = kind;
  if (extra) Object.assign(e, extra);
  return e;
}

const clip = (s, n = 200) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);

export class LlmClient {
  constructor({ apiKey, baseUrl, model, referer, title, timeoutMs = 60_000, log } = {}) {
    this.apiKey = apiKey ?? null;
    this.baseUrl = String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = model ?? DEFAULT_MODEL;
    this.referer = referer ?? null; // OpenRouter HTTP-Referer attribution header
    this.title = title ?? null;     // OpenRouter X-Title attribution header
    this.timeoutMs = timeoutMs;
    this.log = log ?? null;
    // spend: calls/tokens count COMPLETED chats (a failed 429 attempt costs
    // nothing); errors counts chat() invocations that ultimately threw.
    this._spend = { calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
  }

  // localStorage statics — safe under node (no localStorage global) and under
  // browsers with blocked storage: no-throw, load -> null.
  static loadKey() {
    try { return globalThis.localStorage?.getItem(KEY_STORAGE) ?? null; } catch { return null; }
  }
  static saveKey(key) {
    try {
      if (key == null || key === "") globalThis.localStorage?.removeItem(KEY_STORAGE);
      else globalThis.localStorage?.setItem(KEY_STORAGE, String(key));
    } catch { /* quota/blocked -> no-op */ }
  }
  static clearKey() {
    try { globalThis.localStorage?.removeItem(KEY_STORAGE); } catch { /* no-op */ }
  }

  get spend() {
    return { ...this._spend };
  }

  /** -> { text, json, usage:{prompt,completion}, model, ms }; throws Error with .kind */
  async chat(messages, { model, maxTokens = 1024, temperature = 0.4 } = {}) {
    const t0 = Date.now();
    const useModel = model ?? this.model;
    const url = `${this.baseUrl}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;
    const body = JSON.stringify({ model: useModel, messages, max_tokens: maxTokens, temperature });

    let lastErr = null;
    for (let attempt = 0; attempt <= 1; attempt++) { // <= 1: exactly 1 retry (SPEC)
      if (attempt > 0) {
        const backoffMs = Math.min(10_000, 500 * 2 ** (attempt - 1));
        this.log?.(`[llm] ${lastErr.kind} — retrying in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      try {
        return await this._attempt(url, headers, body, useModel, t0);
      } catch (e) {
        lastErr = e;
        if (e.kind !== "rate" && e.kind !== "server" && e.kind !== "network") break;
      }
    }
    this._spend.errors++;
    this.log?.(`[llm] chat failed (${lastErr.kind}): ${lastErr.message}`);
    throw lastErr;
  }

  async _attempt(url, headers, body, useModel, t0) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeoutMs);
    let res, raw;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
      raw = await res.text(); // body read stays under the same abort timer
    } catch (e) {
      throw kindError(timedOut ? "timeout" : "network",
        timedOut ? `timeout after ${this.timeoutMs}ms` : `network: ${e?.cause?.code ?? e?.message ?? e}`,
        { cause: e });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const kind =
        res.status === 401 || res.status === 403 ? "auth" :
        res.status === 429 ? "rate" :
        res.status >= 500 ? "server" :
        "bad-response"; // other 4xx: our request was malformed for this provider
      throw kindError(kind, `HTTP ${res.status}: ${clip(raw)}`, { status: res.status });
    }

    let data;
    try { data = JSON.parse(raw); } catch {
      throw kindError("bad-response", `unparseable body: ${clip(raw)}`);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw kindError("bad-response", `no choices[0].message.content: ${clip(raw)}`);
    }
    const usage = {
      prompt: Number(data?.usage?.prompt_tokens) || 0,
      completion: Number(data?.usage?.completion_tokens) || 0,
    };
    this._spend.calls++;
    this._spend.promptTokens += usage.prompt;
    this._spend.completionTokens += usage.completion;
    return { text, json: extractJson(text), usage, model: data?.model ?? useModel, ms: Date.now() - t0 };
  }
}
