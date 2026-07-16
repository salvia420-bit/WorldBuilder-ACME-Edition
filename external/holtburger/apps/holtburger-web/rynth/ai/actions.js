// actions.js — the typed action surface the LLM may invoke, with validation
// and a never-throws executor over the live bot API. INTERFACE FROZEN — see
// rynth/ai/SPEC.md §actions (exact v1 action list + bounds + the no-admin
// "say" rule). STUB: implementation owned by fan-out agent A3.

export const ACTIONS = {
  // type -> { params: { name: "description" }, desc: "..." }  (A3 fills)
};

export function renderActionCatalog() {
  throw new Error("not implemented (A3)");
}

/** Shape+bounds validation only. -> { ok, error? } */
export function validateAction(a) {
  throw new Error("not implemented (A3)");
}

/** Apply one action to the live bot. NEVER throws. -> { type, ok, result?|error? } */
export async function executeAction(bot, a, { log } = {}) {
  throw new Error("not implemented (A3)");
}

/** Sequential, capped, never-throws plan execution. -> results[] */
export async function executePlan(bot, actions, { maxActions = 5, log } = {}) {
  throw new Error("not implemented (A3)");
}
