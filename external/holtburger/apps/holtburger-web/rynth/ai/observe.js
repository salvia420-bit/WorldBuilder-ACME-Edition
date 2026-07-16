// observe.js — compact world/bot observation for the AI director's prompt.
// INTERFACE FROZEN — see rynth/ai/SPEC.md §observe. Pure function of
// (bot, opts); every field individually degraded ("n/a") on error.
// STUB: implementation owned by fan-out agent A2.

/** -> { text, data } — token-lean prompt block + the structured source. */
export function buildObservation(bot, { journalTail = "", maxChars = 6000, now = Date.now() } = {}) {
  throw new Error("not implemented (A2)");
}
