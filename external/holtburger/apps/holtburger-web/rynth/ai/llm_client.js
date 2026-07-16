// llm_client.js — OpenAI-compatible chat client (OpenRouter default) for the
// rynth AI director. INTERFACE FROZEN — see rynth/ai/SPEC.md §llm_client.
// STUB: implementation owned by fan-out agent A1.

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
export const KEY_STORAGE = "holtburger_ai_key_v1";

/** Tolerant JSON extraction: bare object, ```json fences, prose around it. */
export function extractJson(text) {
  throw new Error("not implemented (A1)");
}

export class LlmClient {
  constructor({ apiKey, baseUrl, model, referer, title, timeoutMs = 60_000, log } = {}) {
    throw new Error("not implemented (A1)");
  }
  static loadKey() { throw new Error("not implemented (A1)"); }
  static saveKey(key) { throw new Error("not implemented (A1)"); }
  static clearKey() { throw new Error("not implemented (A1)"); }
  /** -> { text, json, usage:{prompt,completion}, model, ms }; throws Error with .kind */
  async chat(messages, { model, maxTokens = 1024, temperature = 0.4 } = {}) {
    throw new Error("not implemented (A1)");
  }
  get spend() { throw new Error("not implemented (A1)"); }
}
