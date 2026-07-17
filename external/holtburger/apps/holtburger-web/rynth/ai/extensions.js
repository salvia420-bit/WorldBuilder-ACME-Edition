// extensions.js — composes the post-v1 extension layers (safety, observe_ext,
// tools/knowledge, tools/dungeon_nav) into the director's injectable deps
// (director.js:41-47: observe/validate/execute/systemPrompt). This is the
// INTEGRATOR module the extension reports point at: the v1 files stay frozen;
// everything here goes through their documented seams.
//
// Composition shape (INTEGRATION-NOTES.md §1):
//   const ext = composeAiExtensions(bot, { base, journal, config });
//   new RynthAiDirector(bot, { client, journal, ...ext.directorDeps });
//
// Survival invariant: same as the rest of rynth/ai — a broken extension
// degrades to the v1 behaviour, never into a thrown check-in. Every wrapper
// below falls back to the frozen v1 entry points on error.

import { buildObservation } from "./observe.js";
import { validateAction, executePlan } from "./actions.js";
import { sanitizeAction, guardPlan } from "./safety.js";
import { enrichObservation } from "./observe_ext.js";
import { KnowledgeBase, FileKnowledgeProvider, registerKnowledge } from "./tools/knowledge.js";
import { DungeonNavAdvisor, registerDungeonNav } from "./tools/dungeon_nav.js";
import { WbtOracle, registerWbt } from "./tools/wbt.js";
import { registerEconomy } from "./tools/economy.js";
import { DEFAULT_SYSTEM_PROMPT } from "./director.js";

// = executePlan's own default (actions.js:197) + SPEC "Cost & safety" cap;
// guardPlan enforces it over ext + v1 actions combined.
const MAX_ACTIONS_PER_CHECK = 5;

/**
 * Browser-side knowledge provider: lazy-fetches a JSON corpus
 * ([{title, aliases?, text, url?}, ...]) from the first `urls` entry that
 * loads, then delegates ranking to FileKnowledgeProvider({entries}) so file-
 * and fetch-backed corpora rank identically. Missing fetch / 404 / bad JSON
 * on every URL -> empty results, never a throw (knowledge.js provider
 * contract).
 */
export class FetchKnowledgeProvider {
  constructor({ url, urls } = {}) {
    this.urls = (Array.isArray(urls) ? urls : [url]).filter((u) => typeof u === "string" && u);
    this._delegate = null;
    this._loading = null;
  }

  async _load() {
    if (this._delegate) return this._delegate;
    if (!this._loading) {
      this._loading = (async () => {
        for (const u of this.urls) {
          try {
            const res = await fetch(u);
            if (!res || !res.ok) continue;
            const entries = await res.json();
            if (Array.isArray(entries) && entries.length) {
              this._delegate = new FileKnowledgeProvider({ entries });
              return this._delegate;
            }
          } catch { /* try the next URL */ }
        }
        this._delegate = new FileKnowledgeProvider({ entries: [] });
        return this._delegate;
      })();
    }
    return this._loading;
  }

  /** Duck-typed provider surface (knowledge.js:4). */
  async search(query, limit) {
    try {
      return await (await this._load()).search(query, limit);
    } catch {
      return [];
    }
  }
}

// Same rendering as renderActionCatalog (actions.js:41-50), over the
// extension defs — appended to the system prompt so the LLM learns the extra
// action types.
function renderExtCatalog(extActions) {
  return Object.values(extActions)
    .map((def) => {
      const p = Object.entries(def.params ?? {})
        .map(([k, d]) => `${k}: ${d}`)
        .join("; ");
      return `${def.type} {${p}} — ${def.desc}`;
    })
    .join("\n");
}

/**
 * Build the extension composition for one bot.
 *
 * opts:
 * - base:    module base URL (bot.js:26) — locates the default knowledge
 *            corpus next to this module. Optional; without it (node unit
 *            harnesses) the default fetch provider is skipped.
 * - journal: AiJournal duck type — lookup/dungeon results + sanitizer clamp
 *            notes are journaled so the next observation carries them back.
 * - log:     optional line logger.
 * - config:  the config.ai object (or null). Recognized here:
 *     knowledge:  false -> no lookup action; { provider } duck type |
 *                 { entries } inline corpus | { url } corpus URL.
 *     dungeonNav: false -> no dungeon_suggest action.
 *     systemPrompt: replaces DEFAULT_SYSTEM_PROMPT as the base prompt
 *                 (the extra-actions catalog is still appended).
 *
 * -> { directorDeps: { observe, validate, execute, systemPrompt },
 *      extActions, knowledge, dungeonNav, state }
 * Never throws for config-shaped input; the registration helpers still throw
 * on programmer error (frozen maps), which bot.js's wiring guard absorbs.
 */
// (the bot arg is reserved for future per-bot composition — every wrapper
// receives the live bot at call time, matching the director's deps contract)
export function composeAiExtensions(_bot, { base, journal, log, config } = {}) {
  const cfg = config && typeof config === "object" ? config : {};
  const extActions = {};

  let knowledge = null;
  if (cfg.knowledge !== false) {
    const k = cfg.knowledge && typeof cfg.knowledge === "object" ? cfg.knowledge : {};
    const provider =
      k.provider && typeof k.provider.search === "function" ? k.provider
      : Array.isArray(k.entries) ? new FileKnowledgeProvider({ entries: k.entries })
      : typeof k.url === "string" && k.url ? new FetchKnowledgeProvider({ url: k.url })
      : typeof base === "string" && base && typeof fetch === "function"
        ? new FetchKnowledgeProvider({
            // Real corpus first (built from the acpedia wikidump, gitignored
            // like other baked data), sample as the fresh-clone fallback.
            urls: [`${base}/ai/tools/knowledge.acpedia.json`, `${base}/ai/tools/knowledge.sample.json`],
          })
        : null;
    knowledge = new KnowledgeBase({ provider });
    registerKnowledge(extActions, knowledge);
  }

  let dungeonNav = null;
  if (cfg.dungeonNav !== false) {
    dungeonNav = new DungeonNavAdvisor({ log });
    registerDungeonNav(extActions, dungeonNav);
  }

  // WorldBuilder.Terminal oracle (tools/wbt.js): wbt_query / wbt_catalog /
  // file_ticket over the wbt-sidecar. Default-on like the other extensions —
  // a down sidecar degrades to ok:false action results, never a throw.
  // cfg.wbt: false -> off; { oracle } duck type | { endpoint } sidecar URL.
  let wbt = null;
  if (cfg.wbt !== false) {
    const w = cfg.wbt && typeof cfg.wbt === "object" ? cfg.wbt : {};
    wbt =
      w.oracle && typeof w.oracle.query === "function"
        ? w.oracle
        : new WbtOracle({ endpoint: w.endpoint, fetchFn: w.fetchFn });
    registerWbt(extActions, wbt);
  }

  // Economy hands (tools/economy.js): inventory / open_vendor / buy_items /
  // sell_items / equip_item / unequip_item / use_item over the RynthWebHost
  // economy plane. Default-on; a host without those capabilities degrades to
  // ok:false action results. cfg.economy: false -> off.
  let economy = null;
  if (cfg.economy !== false) {
    economy = registerEconomy(extActions);
  }

  const extFor = (a) =>
    a && typeof a === "object" && typeof a.type === "string"
      ? extActions[a.type] ?? null
      : null;

  // trend history for observe_ext lives here, caller-owned per contract
  // (observe_ext.js:15-16).
  const state = {};
  const observe = (b, o) => enrichObservation(b, buildObservation(b, o), { ...o, state });

  // Extension actions carry their own {ok,error} bounds check; everything
  // else keeps the v1 validator (director rejects invalid actions before
  // execute, director.js:168-173).
  const validate = (a) => {
    const def = extFor(a);
    if (!def) return validateAction(a);
    try {
      return def.validate(a);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };

  // guardPlan's sanitize seam: ext actions validate through their def (they
  // never reach chat — sanitizeAction would reject them as unknown types),
  // v1 actions get the full safety screen (control chars, hidden "@"/"/",
  // clamps).
  const sanitize = (a) => {
    const def = extFor(a);
    if (!def) return sanitizeAction(a);
    let v;
    try {
      v = def.validate(a);
    } catch (e) {
      v = { ok: false, error: String(e?.message ?? e) };
    }
    return v && v.ok === true ? { ok: true, action: a } : { ok: false, error: (v && v.error) || "invalid" };
  };

  const journalNote = (text) => {
    try {
      journal?.add?.("note", text);
    } catch { /* journal loss must not stop the plan */ }
  };

  // guardPlan in front of execution (safety.js header recipe), then route:
  // ext actions to their never-throws apply, v1 actions to the frozen
  // executePlan. On any composition error, fall back to plain v1 executePlan
  // so a broken extension can't cost the bot a check-in.
  const execute = async (b, actions, opts = {}) => {
    try {
      const { actions: kept, rejected, notes } = guardPlan(actions, { sanitize, maxActions: MAX_ACTIONS_PER_CHECK });
      const results = rejected.map((r) => ({
        type: r?.action?.type ?? "?",
        ok: false,
        error: r?.error ?? "rejected",
      }));
      for (const n of notes) journalNote(`sanitized ${n.action?.type}: ${n.note}`);
      for (const a of kept) {
        const def = extFor(a);
        if (def) results.push(await def.apply(b, a, { journal, log: opts.log }));
        else results.push(...(await executePlan(b, [a], { log: opts.log })));
      }
      return results;
    } catch (e) {
      try {
        opts.log && opts.log(`[ai] extension execute failed, falling back to v1 plan: ${String(e?.message ?? e)}`);
      } catch {}
      return executePlan(b, actions, { log: opts.log });
    }
  };

  const basePrompt = typeof cfg.systemPrompt === "string" && cfg.systemPrompt ? cfg.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  const extCatalog = renderExtCatalog(extActions);
  const persona = renderPersonaPreamble(cfg.persona);
  const withPersona = persona ? `${persona}\n\n${basePrompt}` : basePrompt;
  const systemPrompt = extCatalog ? `${withPersona}\n\nEXTRA ACTIONS\n${extCatalog}` : withPersona;

  return {
    directorDeps: { observe, validate, execute, systemPrompt },
    extActions,
    knowledge,
    dungeonNav,
    wbt,
    economy,
    state,
  };
}

/**
 * Persona preamble: the playtester's sense of self, prepended to the system
 * prompt. cfg.persona: { name?, background?, goals? } — all optional strings;
 * absent/false/non-object -> "" (plain v1 director voice). This is the "ego"
 * seam: identity + self-awareness live in the prompt; the technical
 * capabilities (observation, wbt_query, lookup, goto, file_ticket) are what
 * let the character actually act on them.
 */
export function renderPersonaPreamble(p) {
  if (!p || typeof p !== "object") return "";
  const s = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : "");
  const name = s(p.name, 100);
  const background = s(p.background, 1000);
  const goals = s(p.goals, 1000);
  if (!name && !background && !goals) return "";
  const lines = ["WHO YOU ARE"];
  if (name) lines.push(`You are ${name}, a character living in the world of Dereth.`);
  if (background) lines.push(`Background: ${background}`);
  if (goals) lines.push(`Your goals: ${goals}`);
  lines.push(
    "You have a persistent sense of self. Track your own state — vitals, buffs,",
    "gear, money, where you are and whether you can survive what's ahead — and",
    "before entering unfamiliar or dangerous ground, find out what lives there.",
    "Prefer figuring things out yourself (look it up, go and see, try it) over",
    "waiting to be told. When the game itself misbehaves — bugs, blockers,",
    "things that feel wrong — report it with file_ticket."
  );
  return lines.join("\n");
}
