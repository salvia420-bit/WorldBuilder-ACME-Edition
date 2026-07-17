// tools/memory.js — the playtester's persistent scratchpad: a model-editable
// memory block carried verbatim into EVERY observation, alongside the rolling
// journal tail. The tail is recency (last ~8 check-ins, then gone); the
// scratchpad is durability (goals, known places, verified lessons, dead ends)
// — the split every long-horizon game agent effort converged on (Reflexion /
// Voyager / the Pokémon harnesses: "notepad the model itself edits").
//
// One action: update_scratchpad — REPLACES the whole scratchpad (replace, not
// append, so the model curates instead of accreting). Content is injected by
// extensions.js observe() under a SCRATCHPAD header, never dropped by the
// observation budget. Persisted to localStorage under browsers so a page
// reload keeps memory; plain state under node.
//
// Survival invariant: every apply degrades to { ok:false, error }.

const SCRATCH_KEY = "holtburger_ai_scratchpad_v1";
const MAX_SCRATCH_CHARS = 1500;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Load persisted scratchpad into state (no-throw; node -> state only). */
export function loadScratchpad(state) {
  if (typeof state._scratchpad === "string") return state._scratchpad;
  let s = "";
  try { s = globalThis.localStorage?.getItem(SCRATCH_KEY) ?? ""; } catch {}
  state._scratchpad = typeof s === "string" ? s : "";
  return state._scratchpad;
}

function saveScratchpad(state, text) {
  state._scratchpad = text;
  try {
    if (text) globalThis.localStorage?.setItem(SCRATCH_KEY, text);
    else globalThis.localStorage?.removeItem(SCRATCH_KEY);
  } catch { /* blocked storage -> session-only memory */ }
}

/** The observation section (extensions.js prepends this every check-in). */
export function renderScratchpadSection(state) {
  const s = loadScratchpad(state);
  const body = s.trim()
    ? s
    : "(empty — write your goals and durable lessons here via update_scratchpad)";
  return `SCRATCHPAD (persistent memory; REPLACES on update_scratchpad; keep a goals: line first):\n${body}`;
}

/** "update_scratchpad" — replace the persistent scratchpad wholesale. */
export function updateScratchpadAction(state) {
  const def = {
    type: "update_scratchpad",
    params: {
      text: `full replacement text, <= ${MAX_SCRATCH_CHARS} chars. Start with "goals: primary=…; secondary=…; tertiary=…", then durable facts and lessons (verified only — no guesses), known places with guids, and dead ends marked BLOCKED`,
    },
    desc: "rewrite your persistent scratchpad — the memory block shown to you at every check-in. Unlike journal notes (which scroll away after ~8 check-ins), this persists. Curate it: keep goals, verified lessons, known places/guids, dead ends; drop stale lines.",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "update_scratchpad") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      if (typeof a.text !== "string") return { ok: false, error: "text must be a string" };
      if (a.text.length > MAX_SCRATCH_CHARS) return { ok: false, error: `text must be <= ${MAX_SCRATCH_CHARS} chars (curate, don't accrete)` };
      return { ok: true };
    },
  };
  def.apply = async function apply(_bot, a, ctx = {}) {
    const fail = (error) => {
      try { ctx.log && ctx.log(`[ai] action ${def.type}: ${error}`); } catch {}
      return { type: def.type, ok: false, error: String(error) };
    };
    try {
      const v = def.validate(a);
      if (!v.ok) return fail(v.error);
      saveScratchpad(state, clip(a.text, MAX_SCRATCH_CHARS));
      return { type: def.type, ok: true, result: { chars: a.text.length } };
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };
  return def;
}

/** Integrator seam, registerWorld-shaped. state is the caller-owned bag. */
export function registerMemory(actionsMap, state) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerMemory: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const def = updateScratchpadAction(state);
  actionsMap[def.type] = def;
  return def;
}
