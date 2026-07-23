// tools/memory.js — the playtester's persistent scratchpad: a model-editable
// memory block carried verbatim into EVERY observation, alongside the rolling
// journal tail. The tail is recency (last ~8 check-ins, then gone); the
// scratchpad is durability (goals, known places, verified lessons, dead ends)
// — the split every long-horizon game agent effort converged on (Reflexion /
// Voyager / the Pokémon harnesses: "notepad the model itself edits").
//
// One action: update_scratchpad — REPLACES the whole scratchpad (replace, not
// append, so the model curates instead of accreting). Content is injected by
// extensions.js observe() under a SCRATCHPAD header, meant to be NEVER
// DROPPED by the observation budget (unlike the recency-only journal tail).
// That contract needed code, not just a claim: observe_assemble.js's
// assembleObservation now has a `pinned` tier built for exactly this (P1
// #7) — a pinned section is always kept whole, exempt from both quotas and
// the total-token ceiling. The contract IS true end to end: extensions.js
// marks the scratchpad section pinned (OBS_PINNED_SECTIONS, wired into its
// push()), so assembleObservation treats it as un-droppable. Persisted to
// localStorage under browsers so a page reload keeps memory; plain state
// under node.
//
// Read-path contract (P1 #8 fix): whenever localStorage exists it is the
// SOURCE OF TRUTH and is re-read on every loadScratchpad() call — state.
// _scratchpad is only ever a mirror of it, never a cache that can outlive a
// removed key. Only when localStorage is absent (node / blocked storage)
// does state._scratchpad become the store of record. This means an external
// localStorage.removeItem(SCRATCH_KEY) — e.g. the STREAM-RIG-OPS wipe
// recipe — is honored on the very next read with NO extra call needed; the
// old bug was a short-circuit on state._scratchpad BEFORE ever consulting
// storage, so a removed key still resurrected the pre-wipe RAM value.
// clearScratchpad() below is the explicit, no-ambiguity wipe primitive for
// callers (wipeForCleanTest, an operator console) that want to state it.
//
// Survival invariant: every apply degrades to { ok:false, error }.

import { isOperatorStopLatched, OPERATOR_STOP_KEY } from "../operator_stop.js";

const SCRATCH_KEY = "holtburger_ai_scratchpad_v1";
const MAX_SCRATCH_CHARS = 1500;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function storage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === "function" && typeof s.setItem === "function" ? s : null;
  } catch {
    return null; // sandboxed contexts can throw on the localStorage getter itself
  }
}

/**
 * Load the scratchpad into state (no-throw). When localStorage exists it is
 * read fresh every call (source of truth — see header contract); state.
 * _scratchpad is written as a mirror but never trusted over storage. Absent
 * localStorage (node), state._scratchpad IS the store.
 */
export function loadScratchpad(state) {
  const ls = storage();
  if (!ls) return typeof state._scratchpad === "string" ? state._scratchpad : (state._scratchpad = "");
  let s = "";
  try { s = ls.getItem(SCRATCH_KEY) ?? ""; } catch { /* blocked read -> "" */ }
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

/**
 * Explicit wipe: clears the RAM mirror AND the persisted key. Whether or not
 * localStorage exists, after this call loadScratchpad(state) reads back "".
 * The one-call clean-model-test wipe (wipeForCleanTest) uses this so the
 * scratchpad half of a "no reload needed" wipe is actually clean (P1 #8).
 */
export function clearScratchpad(state) {
  saveScratchpad(state, "");
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

/**
 * wipeForCleanTest(ai) — the one-call, honest "clean model" wipe (P1 #7/#8,
 * 08 B-1/B-2, 11 B1, streamline #9). The old STREAM-RIG-OPS recipe was a
 * hand-typed one-liner that only ever cleared journal+scratchpad
 * localStorage — this clears every RAM survivor those reports found too.
 *
 * `ai` is the `bot.ai` shape bot.js assembles: { director, journal,
 * extensions: { state, exploreMemory, ... } }. Every field is optional and
 * every step best-effort (survival invariant): a missing/broken piece is
 * skipped and noted, never thrown — partial input still wipes what it can.
 *
 * Clears (see the returned `cleared` list for what actually ran):
 *   - journal entries (RAM array) + its localStorage key
 *   - scratchpad: state._scratchpad (RAM mirror) + its localStorage key,
 *     via clearScratchpad() — the actual P1 #8 fix (old recipe left the RAM
 *     mirror alive; loadScratchpad() no longer trusts it over storage either)
 *   - exploreMemory coverage/frontier/history RAM, via exploreMemory.reset()
 *     (08 B-1 — this was the "LOCATION block still shows the old run" leak)
 *   - state._usedObjects / state._triedTotal (the "already tried here" tracker)
 *   - combatMemory RAM, if a live instance is ever wired (dark/unattached
 *     today — see combat_memory.js; nothing to clear yet, so normally a no-op)
 *   - director._lastSummary (display-only status field; cosmetic, kept for
 *     parity with the old recipe)
 *
 * Deliberately NEVER clears (by design, not oversight):
 *   - holtburger_ai_key_v1 (OpenRouter key)
 *   - rynth.atlas.v1 (nav atlas)
 *   - the rynthAiOperatorStop latch (08 B-2) — a durable operator-stop must
 *     survive a "clean model" wipe; this only WARNS if it's set, via the
 *     returned `warnings`, so a tester isn't left silently confused about
 *     why the bot won't run after wiping.
 *
 * Returns { ok:true, cleared:string[], warnings:string[] }. Never throws.
 */
export function wipeForCleanTest(ai) {
  const cleared = [];
  const warnings = [];
  const note = (label, e) => warnings.push(`${label}: ${(e && e.message) || e}`);
  const a = ai && typeof ai === "object" ? ai : {};

  // 1) Journal: RAM entries + localStorage key.
  try {
    const j = a.journal || a.director?.journal || null;
    if (j && typeof j.clear === "function") {
      j.clear(); // AiJournal#clear(): entries=[] + persists "[]" (journal.js)
      cleared.push("journal.entries (RAM + persisted)");
    } else if (j && Array.isArray(j.entries)) {
      j.entries.length = 0;
      cleared.push("journal.entries (RAM)");
    } else if (a.journal || a.director) {
      warnings.push("journal not found on ai/ai.director — entries not cleared");
    }
    // Belt-and-suspenders: also remove the raw key (clear() persists "[]",
    // which is equivalent for reads, but a stale pre-clear() build or a key
    // written under a different storageKey should still be swept).
    const key = typeof j?.storageKey === "string" ? j.storageKey : "holtburger_ai_journal_v1";
    try {
      const cur = globalThis.localStorage?.getItem(key);
      if (cur != null && cur !== "[]") {
        globalThis.localStorage.removeItem(key);
        cleared.push(`localStorage:${key}`);
      }
    } catch { /* blocked storage -> nothing to remove */ }
  } catch (e) { note("journal", e); }

  const ext = a.extensions && typeof a.extensions === "object" ? a.extensions : null;
  const state = ext && ext.state && typeof ext.state === "object" ? ext.state : null;

  // 2) Scratchpad: RAM mirror + localStorage key — the actual P1 #8 fix.
  try {
    if (state) {
      clearScratchpad(state);
      cleared.push("scratchpad (state._scratchpad + localStorage)");
    } else {
      try {
        if (globalThis.localStorage?.getItem(SCRATCH_KEY) != null) {
          globalThis.localStorage.removeItem(SCRATCH_KEY);
          cleared.push(`localStorage:${SCRATCH_KEY}`);
        }
      } catch { /* blocked storage */ }
      warnings.push("ai.extensions.state not found — scratchpad RAM mirror (if any) not reachable");
    }
  } catch (e) { note("scratchpad", e); }

  // 3) ExploreMemory coverage/frontier/history RAM (08 B-1).
  try {
    const em = ext && ext.exploreMemory;
    if (em && typeof em.reset === "function") {
      em.reset();
      cleared.push("exploreMemory (coverage/frontier/history RAM)");
    } else if (em) {
      warnings.push("exploreMemory present but has no reset() — NOT cleared");
    }
  } catch (e) { note("exploreMemory", e); }

  // 4) _usedObjects / _triedTotal (extensions.js state bag, the "already
  //    tried here" tracker).
  try {
    if (state) {
      if (state._usedObjects) {
        try { state._usedObjects.clear?.(); } catch { /* not a Map -> drop the ref anyway */ }
        delete state._usedObjects;
        cleared.push("_usedObjects");
      }
      if (state._triedTotal !== undefined) {
        delete state._triedTotal;
        cleared.push("_triedTotal");
      }
    }
  } catch (e) { note("_usedObjects", e); }

  // 5) CombatMemory RAM, only if a caller has ever wired a live instance
  //    (dark/unattached module today — see combat_memory.js — so this is
  //    normally a no-op, kept here so wiring it later needs no wipe change).
  try {
    const cm = (ext && ext.combatMemory) || a.combatMemory || null;
    if (cm && typeof cm.reset === "function") {
      cm.reset();
      cleared.push("combatMemory (RAM)");
    }
  } catch (e) { note("combatMemory", e); }

  // 6) director._lastSummary — display-only status field (director.js),
  //    cosmetic but kept for parity with the old ad-hoc recipe.
  try {
    const d = a.director;
    if (d && "_lastSummary" in d) {
      d._lastSummary = null;
      cleared.push("director._lastSummary");
    }
  } catch (e) { note("_lastSummary", e); }

  // 7) Operator-stop latch: NEVER auto-cleared (08 B-2) — surfaced only.
  try {
    if (isOperatorStopLatched()) {
      warnings.push(
        `${OPERATOR_STOP_KEY} latch is SET — the bot stays halted after this wipe BY DESIGN; ` +
        "clear it separately (window.rynthAI.start()) if that's not what you want"
      );
    }
  } catch (e) { note("operator-stop check", e); }

  return { ok: true, cleared, warnings };
}
