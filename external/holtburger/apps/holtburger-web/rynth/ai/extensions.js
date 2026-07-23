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
import { isOperatorStopLatched } from "./operator_stop.js";
import { enrichObservation } from "./observe_ext.js";
import { assembleObservation } from "./observe_assemble.js";
import { KnowledgeBase, FileKnowledgeProvider, registerKnowledge } from "./tools/knowledge.js";
import { DungeonNavAdvisor, registerDungeonNav } from "./tools/dungeon_nav.js";
import { WbtOracle, registerWbt } from "./tools/wbt.js";
import { registerEconomy } from "./tools/economy.js";
import { registerAdvancement } from "./tools/advancement.js";
import { registerWorld } from "./tools/world.js";
import { registerMemory, renderScratchpadSection } from "./tools/memory.js";
import { registerRoutes, renderMissionLine, liveRunRate } from "./tools/routes.js";
import { DEFAULT_SYSTEM_PROMPT } from "./director.js";
import { ExploreMemory, compassOf, worldX, worldY } from "./explore_memory.js";

// = executePlan's own default (actions.js:197) + SPEC "Cost & safety" cap;
// guardPlan enforces it over ext + v1 actions combined. cfg.maxActions
// overrides (2026-07-17).
const MAX_ACTIONS_PER_CHECK = 5;

// ── observation assembly budget (C4-1, observe_assemble.js) ────────────────
// The check-in observation is composed from several subsystems. OUTPUT order is
// the injection order below (LOCATION first — highest authority); these tiers
// govern only what gets SHED when the block would exceed budget, sheddest-first
// being STEADY (unchanged reference the agent has already seen). The base
// observation is self-capped (observe.js maxChars); this ceiling bounds the
// prepended sections that were previously uncapped on top of it.
const OBS_SECTION_TIERS = {
  location: "DECISION", // harness ground truth — drives the next move
  mission: "DECISION", // live/last travel state — ground truth
  base: "DECISION", // the core observation (vitals/threats/nav/…)
  heard: "ANOMALY", // newly heard speech / server verdicts
  deltas: "CHANGE", // routine since-last-check-in deltas
  scratchpad: "STEADY", // self-authored persistent notes (not ground truth)
};
// P1 #7 (review 08 C1 / 11): sections here are handed to assembleObservation
// with pinned:true — never shed by tier, quota, or the final hard-slice. The
// scratchpad is the bot's durable memory; a budget squeeze must not silently
// drop it (tools/memory.js documents it as never-dropped).
const OBS_PINNED_SECTIONS = new Set(["scratchpad"]);
// ~12k chars: comfortably fits a maxed real observation (self-capped base +
// full scratchpad + full heard buffer) yet caps pathological runaway. Operators
// tightening to a small-context soak set cfg.observeTokens (e.g. 2048).
const DEFAULT_OBSERVE_TOKENS = 3000;
// Cumulative per-subsystem token caps on the growable prepends; non-biting in
// normal operation, they bound any single subsystem from hogging the budget.
const DEFAULT_OBSERVE_QUOTAS = { scratchpad: 450, heard: 650, deltas: 350 };

// ── active-goal gating (C4-2 / C4-3) ───────────────────────────────────────
// The steady-state lines (vitals/buffs/loot_min/priorities from observe.js;
// advancement/kill_trend/burden/portals from observe_ext.js) and the economy /
// advancement verb GROUPS are telemetry + hands for the combat/econ/
// advancement goals only. A pure explorer that surveys and never fights, buys,
// or trains reads none of them — they are dead prompt weight AND a documented
// self-reinforcement hazard (the 2026-07-21 Qalaba'r soak). Gated on the ACTIVE
// GOAL SET, never on the persona NAME: a future 'improve-equipment' goal re-
// enables exactly the lines/verbs it needs simply by being in the set (see
// activeGoalsFor), with no edit to any gate below.
const STEADY_STATE_GOALS = ["combat", "loot", "econ", "advancement", "survival"];
const ECON_GOALS = ["econ", "loot"];
const ADVANCEMENT_GOALS = ["advancement"];
// observe_ext.js is frozen for this package, so its four steady-state lines are
// stripped here at the composed-text seam (below) instead of at their source.
// Anchored to the line start so a stray occurrence mid-line can never match.
const STEADY_STATE_EXT_LINE_RE = /^(?:advancement|kill_trend|burden|portals):/;

const goalActive = (goals, wants) => wants.some((g) => goals.has(g));

// The ONE place a persona maps to a default goal set (the gates never see the
// name). An explicit cfg.goals string array always wins, so a config/persona
// can declare its own goals with no code change here.
function activeGoalsFor(cfg) {
  if (Array.isArray(cfg?.goals)) {
    const g = cfg.goals.filter((x) => typeof x === "string" && x);
    if (g.length) return new Set(g);
  }
  // Surveyor/explorer: movement + discovery only. hunt_start/hunt_stop remain
  // available (they are a world-verb toggle, not a telemetry-hungry goal), so
  // 'combat' is deliberately absent. Every other persona — incl. the default
  // grind — pursues the full set.
  if (cfg?.persona === "explorer") return new Set(["explore"]);
  return new Set(["explore", ...STEADY_STATE_GOALS]);
}

// Appended to the system prompt when the scratchpad (tools/memory.js) is on:
// the two-tier memory protocol every long-horizon agent harness converged on.
const MEMORY_DISCIPLINE = [
  "MEMORY DISCIPLINE",
  "You have TWO memory tiers. The SCRATCHPAD section of the observation is",
  "your persistent memory: it survives indefinitely, and update_scratchpad",
  "REPLACES it wholesale — keep it curated: a goals: line first (primary/",
  "secondary/tertiary), then verified lessons, known places with guids, and",
  "dead ends marked BLOCKED. The journal tail is recency only — anything not",
  "moved into the scratchpad is forgotten after ~8 check-ins. When you learn",
  "something durable or your goals change, update the scratchpad THAT turn",
  "(it costs one action). Only write VERIFIED facts there — the observation",
  "lines and the LOCATION block (Here/Was/Covered/Frontier) are ground truth;",
  "your scratchpad is not, so never let it contradict them.",
].join("\n");

// Appended when the ticket surface (tools/wbt.js) is on: the QA mandate —
// expectation-vs-outcome mismatches are the product, coverage is the method.
const PLAYTESTER_DISCIPLINE = [
  "PLAYTESTER DISCIPLINE",
  'The "since last check-in:" line is what actually changed. After every',
  "action, compare it against what you EXPECTED: a purchase that left coins",
  "unchanged, a portal that moved you 0m, a door that leads nowhere, an NPC",
  "that ignores its own instructions — persistent mismatches are BUGS. File",
  "them with file_ticket: what you did (object guid), what you expected,",
  "what happened. Also keep coverage as a standing tertiary goal: prefer",
  "objects and areas you have NOT tried (see the LOCATION block's Here/",
  "already tried here/Frontier lines) — breadth of interaction is how a",
  "playtester earns their keep.",
].join("\n");

/**
 * Browser-side knowledge provider: lazy-fetches a JSON corpus
 * ([{title, aliases?, text, url?}, ...]) from the first `urls` entry that
 * loads, then delegates ranking to FileKnowledgeProvider({entries}) so file-
 * and fetch-backed corpora rank identically. Missing fetch / 404 / bad JSON
 * on every URL -> empty results, never a throw (knowledge.js provider
 * contract).
 */
export class FetchKnowledgeProvider {
  constructor({ url, urls, overlayUrls } = {}) {
    this.urls = (Array.isArray(urls) ? urls : [url]).filter((u) => typeof u === "string" && u);
    // Grounded overlay corpora (knowledge.grounded.json): world-DB-verified
    // entries that MERGE over the wiki bake and WIN on a same-title collision
    // — acpedia text is retail-era prose and sometimes names the wrong NPC
    // entirely (its "Jonathan" is the level-180 Eldrytch Web one, not the
    // academy exit guard). Overlay fetch failures degrade to base-only.
    this.overlayUrls = (Array.isArray(overlayUrls) ? overlayUrls : []).filter(
      (u) => typeof u === "string" && u,
    );
    this._delegate = null;
    this._loading = null;
  }

  async _load() {
    if (this._delegate) return this._delegate;
    if (!this._loading) {
      this._loading = (async () => {
        const fetchJson = async (u) => {
          try {
            const res = await fetch(u);
            if (!res || !res.ok) return null;
            const entries = await res.json();
            return Array.isArray(entries) && entries.length ? entries : null;
          } catch {
            return null;
          }
        };
        let base = null;
        for (const u of this.urls) {
          base = await fetchJson(u);
          if (base) break;
        }
        let entries = base ?? [];
        for (const u of this.overlayUrls) {
          const overlay = await fetchJson(u);
          if (!overlay) continue;
          const overlayTitles = new Set(
            overlay.map((e) => (typeof e?.title === "string" ? e.title.trim().toLowerCase() : "")),
          );
          entries = [
            ...overlay,
            ...entries.filter(
              (e) => !overlayTitles.has(typeof e?.title === "string" ? e.title.trim().toLowerCase() : ""),
            ),
          ];
        }
        this._delegate = new FileKnowledgeProvider({ entries });
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
// action types. `hidden` is an optional Set of type names to omit (goal-gated
// verb groups, C4-3): a verb the current goal set has no use for is never
// advertised, so it costs no prompt tokens and is not a distractor. Omitting a
// verb from the catalog does NOT disable it — validate/execute still accept it
// — this only trims what the prompt teaches.
function renderExtCatalog(extActions, hidden = null) {
  return Object.values(extActions)
    .filter((def) => !(hidden && hidden.has(def.type)))
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
// Portal-only dungeon Exit hint (2026-07-21, academy-wedge fix; locationBlock
// below). ODF_PORTAL matches goto_compose.js:102/observe_ext.js:248's own
// constant. A small LOCAL scan over NearbyGuids, deliberately NOT imported
// from bot.js's _nearestUnvisitedDoor (house convention: same query SHAPE
// duplicated per file, not shared — that fn also wants a different flag/
// exclusion-set than this one). "NPC-ish" here means named + not attackable
// + not a portal — enough to surface an exit guard like "Jonathan" without
// pulling in observe_ext.js's full classifyDesc.
const ODF_PORTAL_HINT = 0x40000;
const ODF_ATTACKABLE_HINT = 0x10;
function nearestExitHint(b, curWx, curWy) {
  const h = b?.host;
  if (typeof h?.NearbyGuids !== "function" || typeof h?.TryGetObjectPosition !== "function") return null;
  let guids = [];
  try { guids = h.NearbyGuids() || []; } catch { return null; }
  let best = null;
  for (const g of guids) {
    try {
      const guid = g >>> 0;
      const p = h.TryGetObjectPosition(guid);
      if (!p) continue;
      const flags = h.TryGetObjectDescFlags?.(guid);
      const isPortal = flags != null && (flags & ODF_PORTAL_HINT) !== 0;
      const name = h.TryGetObjectName?.(guid);
      const attackable = flags != null && (flags & ODF_ATTACKABLE_HINT) !== 0;
      const isNpcish = !isPortal && !!name && flags != null && !attackable;
      if (!isPortal && !isNpcish) continue;
      const pwx = worldX(p.objCellId >>> 0, p.x), pwy = worldY(p.objCellId >>> 0, p.y);
      const d = Math.hypot(pwx - curWx, pwy - curWy);
      if (!best || d < best.d) best = { guid, name: name || (isPortal ? "portal" : "NPC"), d };
    } catch { /* one bad object must not break the scan */ }
  }
  return best;
}

// (the bot arg is reserved for future per-bot composition — every wrapper
// receives the live bot at call time, matching the director's deps contract)
export function composeAiExtensions(_bot, { base, journal, log, config } = {}) {
  const cfg = config && typeof config === "object" ? config : {};
  const extActions = {};

  // Active-goal gating (C4-2 / C4-3): computed once here, applied to the
  // observation lines (showSteadyState below) and the verb catalog (hiddenVerbs
  // at prompt-assembly time). Default persona -> full goal set -> nothing gated.
  const activeGoals = activeGoalsFor(cfg);
  const showSteadyState = goalActive(activeGoals, STEADY_STATE_GOALS);
  // Verb type names each register* helper adds, captured by set-difference so no
  // verb name is hardcoded here (fully general — a helper gaining/losing a verb
  // needs no change). Populated during registration below.
  let economyVerbs = [];
  let advancementVerbs = [];

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
            overlayUrls: [`${base}/ai/tools/knowledge.grounded.json`],
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
  // cfg.wbt: false -> off; { oracle } duck type | { endpoint } sidecar URL;
  // { query: false } -> file_ticket ONLY (no-hints soak mode: the oracle
  // lookup verbs vanish but the playtester keeps its bug reporting).
  let wbt = null;
  if (cfg.wbt !== false) {
    const w = cfg.wbt && typeof cfg.wbt === "object" ? cfg.wbt : {};
    wbt =
      w.oracle && typeof w.oracle.query === "function"
        ? w.oracle
        : new WbtOracle({ endpoint: w.endpoint, fetchFn: w.fetchFn });
    registerWbt(extActions, wbt, { query: w.query !== false });
  }

  // Economy hands (tools/economy.js): inventory / open_vendor / buy_items /
  // sell_items / equip_item / unequip_item / use_item over the RynthWebHost
  // economy plane. Default-on; a host without those capabilities degrades to
  // ok:false action results. cfg.economy: false -> off.
  let economy = null;
  if (cfg.economy !== false) {
    const before = new Set(Object.keys(extActions));
    economy = registerEconomy(extActions);
    economyVerbs = Object.keys(extActions).filter((k) => !before.has(k));
  }

  // Advancement hands (tools/advancement.js): raise_attribute / raise_vital /
  // raise_skill / train_skill over the RynthWebHost advancement plane. Default-
  // on; a host without those capabilities degrades to ok:false. cfg.advancement:
  // false -> off.
  let advancement = null;
  if (cfg.advancement !== false) {
    const before = new Set(Object.keys(extActions));
    advancement = registerAdvancement(extActions);
    advancementVerbs = Object.keys(extActions).filter((k) => !before.has(k));
  }

  // World hands (tools/world.js): use_object / take_item / give_item /
  // goto_object / open_container / appraise / use_item_on / drop_item /
  // confirm — general interact with / take / hand / examine any nearby world
  // object (portals, NPCs, doors, chests). Pairs with the 'nearby' perception
  // line (observe_ext.js). Default-on. cfg.world: false -> off.
  let world = null;
  if (cfg.world !== false) {
    world = registerWorld(extActions);
  }

  // Route-level travel (tools/routes.js, SPEC-navatlas §3-W3.1): follow_route
  // / list_routes / name_route over the W2 route atlas. Default-on; a missing
  // atlas module degrades every action to ok:false. cfg.routes: false -> off;
  // { atlas } injects a duck-typed atlas (tests).
  let routes = null;
  if (cfg.routes !== false) {
    try {
      routes = registerRoutes(extActions, {
        base,
        atlas: cfg.routes && typeof cfg.routes === "object" ? cfg.routes.atlas ?? null : null,
      });
    } catch { routes = null; }
  }

  const extFor = (a) =>
    a && typeof a === "object" && typeof a.type === "string"
      ? extActions[a.type] ?? null
      : null;

  // trend history for observe_ext lives here, caller-owned per contract
  // (observe_ext.js:15-16).
  const state = {};

  // Observation-assembly budget (C4-1). cfg.observeTokens: total token ceiling
  // (default DEFAULT_OBSERVE_TOKENS); cfg.observeQuotas: per-subsystem token
  // caps (default DEFAULT_OBSERVE_QUOTAS). Both degrade to the built-in default.
  const observeTokens =
    Number.isFinite(cfg.observeTokens) && cfg.observeTokens > 0 ? cfg.observeTokens : DEFAULT_OBSERVE_TOKENS;
  const observeQuotas =
    cfg.observeQuotas && typeof cfg.observeQuotas === "object" ? cfg.observeQuotas : DEFAULT_OBSERVE_QUOTAS;

  // Persistent scratchpad (tools/memory.js): model-editable memory carried
  // into every observation — the durability tier the rolling journal tail
  // lacks. Default-on. cfg.memory: false -> off.
  let memory = null;
  if (cfg.memory !== false) {
    memory = registerMemory(extActions, state);
  }

  // ── ExploreMemory (DESIGN-surveyor-frontier-2026-07-21, WS-A/WS-B) ────────
  // Single shared coverage/frontier/loop core — replaces the old scattered
  // loopWarning/coverageLines/stallLine trio (see locationBlock() below).
  // Landed at bot.ai.extensions.exploreMemory so bot.js's ExplorePressure-
  // Controller (WS-C) and director.js (WS-D) can reach the SAME instance.
  const exploreMemory = new ExploreMemory();

  const poseOf = (b) => {
    try {
      const p = b?.host?.TryGetPlayerPose?.();
      return p ? { cell: p.objCellId >>> 0, x: p.x, y: p.y, z: p.z } : null;
    } catch { return null; }
  };
  // ExploreMemory.observe() is frozen to the RAW {objCellId,x,y,z} shape
  // (VALIDATION COROLLARY) — poseOf() above renames to {cell,...} for the
  // rest of this module's math, so this is a separate accessor over the same
  // host seam rather than a transform of poseOf's output.
  const rawPoseOf = (b) => {
    try {
      const p = b?.host?.TryGetPlayerPose?.();
      // cellResolved (W4a): honest "position resolved" signal; null when the
      // wasm build predates getLocalPlayerPoseCellResolved.
      return p
        ? { objCellId: p.objCellId >>> 0, x: p.x, y: p.y, z: p.z, cellResolved: p.cellResolved ?? null }
        : null;
    } catch { return null; }
  };

  // Coverage + tried-object memory (2026-07-17): harness-tracked ground truth
  // the model can't corrupt — visited cells (from the pose each check-in) and
  // objects already interacted with (via the ctx.track seam in tools/world.js).
  // Surfaced as a "tried:" line so "use an object you have NOT tried" is
  // checkable, not vibes.
  const track = (guid, name) => {
    const used = (state._usedObjects ??= new Map());
    const g = guid >>> 0;
    const prev = used.get(g);
    used.set(g, { name: String(name ?? "?"), n: (prev?.n ?? 0) + 1 });
    if (used.size > 40) used.delete(used.keys().next().value);
    state._triedTotal = (state._triedTotal ?? 0) + 1;
  };
  // Deltas since the last check-in — harness-verified ground truth of what
  // actually CHANGED, so expectation-vs-outcome is checkable ("bought but
  // coins unchanged" = bug material, "used exit but moved 0m" = not an exit).
  const worldXY = (p) => p && {
    x: (((p.cell >>> 24) & 0xff) * 192) + p.x,
    y: (((p.cell >>> 16) & 0xff) * 192) + p.y,
  };
  const snapshot = (b) => {
    const s = { pose: poseOf(b) };
    try { s.coins = b?.host?.TryGetCoins?.() ?? null; } catch { s.coins = null; }
    try { s.inv = b?.host?.TryGetPlayerInventory?.()?.length ?? null; } catch { s.inv = null; }
    try { s.kills = b?.kernel?.status?.kills ?? null; } catch { s.kills = null; }
    return s;
  };
  const deltasLine = (b, cur) => {
    const prev = state._lastSnapshot;
    state._lastSnapshot = cur;
    if (!prev) return "";
    const out = [];
    const a = worldXY(prev.pose), z = worldXY(cur.pose);
    if (a && z) {
      const m = Math.hypot(z.x - a.x, z.y - a.y);
      out.push(m >= 1 ? `moved ${m.toFixed(0)}m` : "did NOT move");
    }
    const num = (k, label) => {
      if (typeof prev[k] === "number" && typeof cur[k] === "number" && cur[k] !== prev[k])
        out.push(`${label} ${cur[k] > prev[k] ? "+" : ""}${cur[k] - prev[k]}`);
    };
    num("coins", "coins");
    num("inv", "inventory");
    num("kills", "kills");
    return out.length ? `since last check-in: ${out.join("; ")}` : "";
  };

  // ── interaction-outcome memory (general no-effect tracking, 2026-07-21) ──
  // Content-agnostic companion to `track` above: a use_object that produces
  // no observable world change by the NEXT check-in is memoized so (a) the
  // pressure rung's ambient auto-use (bot.js ExplorePressureController.
  // _escalatePortal) can stop hammering it — the SAME treatment its own
  // _deadEscapeGuids blacklist gets, kept a DISTINCT set since "dead-escape"
  // specifically means "no movement during an escape attempt" while this is
  // general-purpose (covers any use_object, not just escape walks) — and (b)
  // the LOCATION block below (locationBlock) tells the director outright,
  // rather than it rediscovering the same dead end every few minutes by
  // trial and error.
  //
  // Owned HERE, not the ExplorePressureController: it must see BOTH
  // UseObject call sites — the director's own use_object action
  // (tools/world.js, via ctx.interactions.record in execute() below) AND the
  // pressure rung's ambient use (bot.js, via bot.ai.extensions.interactions)
  // — and this module is the ONE place both already reach through the same
  // cross-reach seam exploreMemory/dungeonNav use (bot.ai.extensions.*); a
  // controller-local Map would only ever observe one of the two callers.
  // Capped like state._usedObjects for long-session hygiene (LRU: re-
  // recording a guid bumps it to the back before the cap check).
  const INTERACTION_MEMORY_MAX = 64;
  const interactionMemory = new Map(); // guid -> { name, noEffect, pending }

  // Record a use attempt. Resolution is DEFERRED to the next snapshot
  // (resolvePendingInteractions below), not evaluated here — the
  // interaction's own effects (a quest flag, a popup, a teleport) may take a
  // beat to land server-side, which is exactly why this isn't checked
  // immediately after firing.
  const recordInteractionUse = (b, guid, name) => {
    try {
      const g = guid >>> 0;
      const prev = interactionMemory.get(g);
      interactionMemory.delete(g); // bump LRU order even on repeat use
      interactionMemory.set(g, {
        name: String(name ?? prev?.name ?? "?"),
        noEffect: prev?.noEffect ?? 0,
        pending: snapshot(b),
      });
      if (interactionMemory.size > INTERACTION_MEMORY_MAX) {
        interactionMemory.delete(interactionMemory.keys().next().value);
      }
    } catch { /* memory loss is not fatal */ }
  };

  // "Did anything observable change?" over the SAME dimensions deltasLine
  // already tracks (pose, coins, inventory count, kills) — unknown/missing
  // data never falsely marks "no effect" (fail-open: assume changed).
  const noEffectSnapshotChanged = (a, z) => {
    if (!a || !z) return true;
    const ap = worldXY(a.pose), zp = worldXY(z.pose);
    if (!ap !== !zp) return true; // one side unresolved -> can't prove "unchanged"
    if ((a.pose?.cell ?? null) !== (z.pose?.cell ?? null)) return true;
    if (ap && zp && Math.hypot(zp.x - ap.x, zp.y - ap.y) > 1) return true;
    for (const k of ["coins", "inv", "kills"]) {
      if (typeof a[k] === "number" && typeof z[k] === "number" && a[k] !== z[k]) return true;
    }
    return false;
  };

  // Resolve every still-pending interaction against the FRESH snapshot the
  // observe() cycle just took (the same `cur` deltasLine computes) — once
  // per check-in, the "next evaluation" an interaction fired before.
  // Unchanged -> noEffect++; ANY change -> reset to 0 (proof it did
  // *something*, even if not what was wanted) — a use that changes the cell
  // never marks, matching the spec's "resets/never marks" contract.
  const resolvePendingInteractions = (cur) => {
    for (const entry of interactionMemory.values()) {
      if (!entry.pending) continue;
      entry.noEffect = noEffectSnapshotChanged(entry.pending, cur) ? 0 : entry.noEffect + 1;
      entry.pending = null;
    }
  };

  const noEffectOf = (guid) => interactionMemory.get(guid >>> 0)?.noEffect ?? 0;

  // Public surface: tools/world.js's use_object gets this via ctx.interactions
  // (execute() below); bot.js's ExplorePressureController reaches it via
  // bot.ai.extensions.interactions (returned object below) — same seam as
  // exploreMemory/dungeonNav.
  const interactions = { record: recordInteractionUse, noEffectOf, entries: () => interactionMemory };

  // ── LOCATION block (DESIGN-surveyor-frontier-2026-07-21 WS-B) ────────────
  // ONE authoritative, deterministic block sourced from exploreMemory,
  // replacing loopWarning + coverageLines + stallLine. Injected FIRST
  // (highest authority) in the observe assembly below. Root cause this
  // fixes: four independent, incomplete visit-trackers, none of which owned
  // a frontier or forced an escape — the live 2026-07-21 soak wedged in the
  // Renald shop (landblock 0xA9B4), re-poking the same NPCs/chest, while the
  // director fixated on a town on the opposite corner of the map.
  // rawPose is passed in (not re-derived) so this uses the EXACT same pose
  // exploreMemory.observe() was just fed this check-in — objCellId===0 is a
  // death/respawn streaming gap (academy respawn reports cell 0 for a beat),
  // not a real location. exploreMemory.observe() already no-ops on it (last
  // known-good tile stays current), but the LOCATION block must not silently
  // keep reporting that stale tile as "here" — and must never point Frontier/
  // CORRECTION at coordinates derived from a garbage pose.
  const locationBlock = (b, rawPose) => {
    // Status lines independent of position validity (2026-07-21 scope items
    // 3/4c) — computed up front so both the normal path and the "position
    // unknown" early-return below carry them; a client-side freeze or the
    // current hunting mode is ground truth regardless of whether the pose
    // just streamed.
    const statusLines = [];
    // MOVEMENT-DEAD watchdog (item 3): bot.js's ExplorePressureController
    // sets this when hops keep firing with a frozen pose — a client-side
    // issue, NOT a routing decision, so the AI must not "fix" it with more
    // goto/exit_building attempts. Same lazy optional-chain style as the
    // dungeonNav/exploreMemory reaches elsewhere in this file.
    try {
      if (b?.explorePressure?._movementDead === true) {
        statusLines.push(
          "  MOVEMENT: appears frozen — a client-side issue, not a routing decision; standing down until it recovers."
        );
      }
    } catch { /* defensive read only */ }
    // Hunting toggle status (item 4c): bot.kernel.combat.enabled is the
    // director's hunt_start/hunt_stop knob (tools/world.js) — surface the
    // current mode so the AI knows which one it's in before deciding.
    try {
      const combat = b?.kernel?.combat;
      if (combat) {
        statusLines.push(
          combat.enabled === false
            ? "  Hunting: OFF (combat kernel standing down — hunt_start to resume)"
            : "  Hunting: ON (combat kernel engages attackables — hunt_stop to stand down)"
        );
      }
    } catch { /* defensive read only */ }
    // No-effect interactions (change #3, general no-effect tracking):
    // objects used 2+ times with zero observable change since — named at
    // RENDER time via TryGetObjectName (never the recorded name), so a
    // renamed/reused guid always shows its CURRENT name. Independent of
    // position validity, same as the two status lines above.
    try {
      for (const [guid, entry] of interactionMemory) {
        if (entry.noEffect < 2) continue;
        const name =
          (typeof b?.host?.TryGetObjectName === "function" ? b.host.TryGetObjectName(guid) : null) ||
          entry.name ||
          "?";
        statusLines.push(
          `  no-effect: you have used "${name}" ${entry.noEffect}× with no observable change — try something else.`
        );
      }
    } catch { /* defensive read only */ }

    if (!rawPose || (rawPose.objCellId >>> 0) === 0) {
      return [
        "LOCATION (harness ground truth — trust this over your own memory):",
        "  Here: position unknown (respawn/streaming gap) — hold and re-read next check-in.",
        ...statusLines,
      ].join("\n");
    }
    const cur = exploreMemory.current;
    if (!cur) return "";
    const verdict = exploreMemory.loopVerdict();
    const cov = exploreMemory.coverage();
    const fr = exploreMemory.frontier();

    const lines = ["LOCATION (harness ground truth — trust this over your own memory):"];

    // Truthful sense of place from the three-way cell taxonomy (outdoor /
    // building interior / parked dungeon-apartment). A far "nearest town" is
    // NOT named — that mislabel is what seeded the "Qalaba'r" fixation.
    const place = exploreMemory.classifyPlace(cur.cell, cur.worldX, cur.worldY);
    const cellHex = `0x${cur.cell.toString(16).toUpperCase().padStart(8, "0")}`;
    const lbHex = `0x${place.lb.toString(16).toUpperCase()}`;
    let here;
    if (place.kind === "building") here = `inside a building in ${place.town} (cell ${cellHex})`;
    else if (place.kind === "dungeon") here = `inside a dungeon/apartment (env cell ${cellHex}, landblock ${lbHex}) — this is portal-only, NOT reachable overland; there is no surface town here`;
    else here = place.town ? `outdoors in ${place.town} (landblock ${lbHex})` : `outdoors in open country (landblock ${lbHex})`;
    lines.push(
      `  Here: ${here} (tile ${cur.tx},${cur.ty}, floor ${cur.zb}). Been here ${cur.visits}×.`
    );

    // Portal-only dungeon Exit hint (2026-07-21, academy-wedge root cause):
    // dungeonNav/indoor_router's exit_building only knows baked CellPortal
    // architecture and correctly fails forever in a portal-only dungeon
    // (no walkable ground-level exit exists) — point straight at the
    // nearest portal/exit-NPC instead so the director has a concrete
    // use_object target rather than looping exit_building.
    if (place.kind === "dungeon") {
      const hint = nearestExitHint(b, cur.worldX, cur.worldY);
      if (hint) {
        lines.push(
          `  Exit hint: no walkable ground-level exit from here — nearest portal/NPC is "${hint.name}" (~${Math.round(
            hint.d
          )}m); use_object it. Caution: not every portal here leads anywhere (some are decorative) — if one produces no position/landblock change next check-in, try a different one instead of repeating it.`
        );
      }
    }

    const used = state._usedObjects;
    if (used?.size) {
      const items = [...used.entries()].slice(-12).map(
        ([g, r]) => `${r.name} 0x${g.toString(16).toUpperCase()}${r.n > 1 ? ` (x${r.n})` : ""}`
      );
      lines.push(`  already tried here: ${items.join("; ")}`);
    }

    const prev = exploreMemory.previous;
    if (prev) {
      const bouncing = verdict.looping && /bouncing/.test(verdict.reason);
      lines.push(
        `  Was: cell 0x${prev.cell.toString(16).toUpperCase().padStart(8, "0")}${
          bouncing ? " (you keep bouncing between these two — THIS IS A LOOP)" : ""
        }`
      );
    }

    lines.push(
      `  Covered: ${cov.tiles} tiles / ${cov.landblocks} landblocks this session; ${cov.thisLbTiles} tiles in this landblock.`
    );

    if (fr) {
      lines.push(
        `  Frontier: nearest UNVISITED ground is ~${Math.round(fr.dist)}m ${compassOf(fr.bearingDeg)} (landblock 0x${fr.lb
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}).`
      );
    }

    if (verdict.looping) lines.push(`  CORRECTION: ${verdict.correction}`);

    lines.push(...statusLines);

    return lines.join("\n");
  };

  // ── heard chat (2026-07-17) ────────────────────────────────────────────
  // NPC speech, tells, popups and server feedback ride the webhost push-event
  // plane (ClientEvent kind 2, ChatReceived) — which nothing in the AI layer
  // subscribed to, so the bot could talk to NPCs but never hear the answers.
  // Ring-buffered here at compose time, surfaced as a "heard since last
  // check-in:" section. Categories are the lib.rs CHAT_CATEGORY_* ids in
  // u32Payload2; combat/magic spam stays out. Default-on. cfg.chat: false ->
  // off; { categories: [..], maxLines } to tune.
  const chatCfg = cfg.chat && typeof cfg.chat === "object" ? cfg.chat : {};
  const CHAT_KEEP = new Set(
    Array.isArray(chatCfg.categories) && chatCfg.categories.length
      ? chatCfg.categories.map((n) => n >>> 0)
      : [0, 1, 2, 4, 6, 9, 10] // system, local speech, tell, emote, death, transient, popup
    // 0 = system (2026-07-18): server verdicts ride System chat — e.g. ACE's
    // 'Portal destination for portal ID N not yet implemented!' answered every
    // use of the destination-less Central Courtyard portal, and the filter
    // dropped it; the bot filed a ticket for a 'silent' failure the server
    // had been explaining all along.
  );
  const CHAT_RING_MAX = 60;
  const CHAT_MAX_LINES = Number.isFinite(chatCfg.maxLines) ? chatCfg.maxLines : 12;
  if (cfg.chat !== false && typeof _bot?.host?.onEvent === "function") {
    _bot.host.onEvent((e) => {
      if (!e || !e.text) return;
      // kind 13 = UseFailed: the server's answer to a bad Use/give (OutOfRange,
      // Locked, …). This is the outcome channel "use_object:ok" can't see —
      // without it a failed Use is indistinguishable from a silent success.
      let line;
      if (e.kind === 13) line = `use FAILED: ${e.text}`;
      else if (e.kind === 2 && CHAT_KEEP.has((e.u32b ?? 0) >>> 0)) line = e.text;
      else return;
      const ring = (state._heardChat ??= []);
      ring.push({ t: Date.now(), text: String(line).slice(0, 200) });
      if (ring.length > CHAT_RING_MAX) ring.splice(0, ring.length - CHAT_RING_MAX);
    });
  }
  const heardLines = () => {
    const ring = state._heardChat;
    if (!ring?.length) return "";
    const fresh = ring.splice(0); // drain: each line is heard exactly once
    if (!fresh.length) return "";
    // Collapse consecutive repeats (NPC greeting spam) into "line (xN)".
    const rows = [];
    for (const r of fresh) {
      const last = rows[rows.length - 1];
      if (last && last.text === r.text) last.n++;
      else rows.push({ text: r.text, n: 1 });
    }
    const shown = rows.slice(-CHAT_MAX_LINES);
    const omitted = rows.length - shown.length;
    return (
      `heard since last check-in:${omitted > 0 ? ` (+${omitted} earlier omitted)` : ""}\n` +
      shown.map((r) => `  ${r.text}${r.n > 1 ? ` (x${r.n})` : ""}`).join("\n")
    );
  };

  // NB: buildObservation/enrichObservation return { text, data } — the
  // director reads obs.text (director.js:164). Preserve the shape; only the
  // text gains our prepended sections.
  const observe = (b, o) => {
    // showSteadyState suppresses observe.js's own combat/econ lines at source;
    // observe_ext.js is frozen for this package, so its four steady-state lines
    // (advancement/kill_trend/burden/portals) are stripped from the composed
    // text below when the goal set has no use for them.
    const obs = enrichObservation(b, buildObservation(b, { ...o, showSteadyState }), { ...o, state });
    let baseText = typeof obs?.text === "string" ? obs.text : String(obs ?? "");
    if (!showSteadyState && baseText) {
      baseText = baseText.split("\n").filter((ln) => !STEADY_STATE_EXT_LINE_RE.test(ln)).join("\n");
    }
    // Feed the shared coverage/frontier/loop core BEFORE building the block —
    // exploreMemory.observe() is idempotent-ish (dual-driver de-dupe guard),
    // so a director check-in landing close to a pressure tick's observe()
    // doesn't double-count a tile visit. rawPose is captured once and reused
    // by locationBlock() so both see the SAME pose this check-in.
    const rawPose = rawPoseOf(b);
    exploreMemory.observe(rawPose);
    // Resolve any pending interaction-outcome snapshots (change #3) BEFORE
    // building the LOCATION block below — locationBlock renders the
    // no-effect status line off `interactionMemory`'s CURRENT noEffect
    // counts, so this must land first or the line lags one whole observe()
    // cycle behind the resolution that actually produced it. The same `cur`
    // snapshot is threaded into deltasLine (its own prev/cur diff) so the
    // world isn't sampled twice for one check-in.
    const curSnapshot = snapshot(b);
    resolvePendingInteractions(curSnapshot);
    // Build SALIENCE-TAGGED sections in injection order. `parts` shadows them
    // as strings so the raw `parts.join("\n")` (today's behaviour) survives as
    // the degrade-to-today fallback if assembly ever throws — the survival
    // invariant: a broken assembler must never break a check-in.
    const sections = [];
    const parts = [];
    const push = (subsystem, text) => {
      if (typeof text !== "string" || !text) return;
      sections.push({
        subsystem,
        tier: OBS_SECTION_TIERS[subsystem] || "STEADY",
        ...(OBS_PINNED_SECTIONS.has(subsystem) ? { pinned: true } : {}),
        text,
      });
      parts.push(text);
    };
    // LOCATION is injected FIRST — highest authority (design doc WS-B).
    push("location", locationBlock(b, rawPose));
    // Mission line (SPEC-navatlas §3-W3.3): live/last travel state is
    // harness ground truth, reported every check-in like pos/nav.
    push("mission", renderMissionLine(b));
    if (memory) push("scratchpad", renderScratchpadSection(state));
    push("deltas", deltasLine(b, curSnapshot));
    push("heard", heardLines());
    push("base", baseText);
    let text;
    try {
      const r = assembleObservation(sections, { totalTokens: observeTokens, quotas: observeQuotas });
      text = r && typeof r.text === "string" ? r.text : parts.join("\n");
    } catch {
      text = parts.join("\n"); // degrade-to-today: never break a check-in
    }
    return obs && typeof obs === "object" ? { ...obs, text } : { text, data: null };
  };

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

  // ── route auto-record (SPEC-navatlas §3-W3.1) ──────────────────────────
  // Successful novel gotos are ALWAYS recorded under an auto-name; the
  // director promotes keepers via name_route. Recorder + atlas are the W2
  // modules (rynth/route_recorder.js, rynth/atlas.js), lazy-imported —
  // absence degrades to no recording, never a throw. follow_route walks are
  // reuse, not new experience: recorded for cleanup but not re-saved.
  // cfg.routeRecord: false -> off.
  if (cfg.routeRecord !== false && _bot && typeof base === "string" && base) {
    let recorderP = null;
    const loadRecorder = () => (recorderP ??= import(`${base}/route_recorder.js`).catch(() => null));
    let rec = null;
    let lastSampleT = 0;
    try {
      _bot.host?.onTick?.(() => {
        if (!rec) return;
        const now = Date.now();
        if (now - lastSampleT < 500) return;
        lastSampleT = now;
        try {
          const p = _bot.host.TryGetPlayerPose?.();
          if (p) rec.sample(p);
        } catch { /* sampling must never reach the pump */ }
      });
    } catch { /* no tick plane -> no recording */ }
    _bot._onTravelStart = (ev) => {
      void (async () => {
        try {
          const m = await loadRecorder();
          if (!m?.RouteRecorder) return;
          const from = _bot.host?.TryGetPlayerPose?.() ?? null;
          const r = new m.RouteRecorder({ log });
          r.start({ from, name: ev?.label, runRate: liveRunRate(_bot), source: "walk" });
          rec = r;
        } catch { rec = null; }
      })();
    };
    _bot._onTravelDone = (ev) => {
      const r = rec;
      rec = null;
      void (async () => {
        try {
          if (!r) return;
          const to = _bot.host?.TryGetPlayerPose?.() ?? null;
          const route = r.finish({ ok: ev?.result?.ok === true, to });
          if (!route || ev?.kind !== "goto" || ev?.result?.ok !== true) return;
          const at = await (routes?.getAtlas?.() ?? null);
          if (!at) return;
          const saved = at.saveRoute(route);
          if (_bot._metrics) _bot._metrics.routesRecorded++;
          journalNote(`route recorded: "${saved?.name ?? route.name ?? "?"}" (${route.legs?.length ?? "?"} legs) — use name_route to keep it under a durable name`);
        } catch { /* recording must never break travel */ }
      })();
    };
  }

  // guardPlan in front of execution (safety.js header recipe), then route:
  // ext actions to their never-throws apply, v1 actions to the frozen
  // executePlan. On any composition error, fall back to plain v1 executePlan
  // so a broken extension can't cost the bot a check-in.
  const maxActions =
    Number.isInteger(cfg.maxActions) && cfg.maxActions >= 1 ? cfg.maxActions : MAX_ACTIONS_PER_CHECK;

  const execute = async (b, actions, opts = {}) => {
    try {
      const { actions: kept, rejected, notes } = guardPlan(actions, { sanitize, maxActions });
      const results = rejected.map((r) => ({
        type: r?.action?.type ?? "?",
        ok: false,
        error: r?.error ?? "rejected",
      }));
      for (const n of notes) journalNote(`sanitized ${n.action?.type}: ${n.note}`);
      // (over-cap actions come back in `rejected` as "plan truncated: over
      // maxActions=N" — guardPlan reports them per-action, so the result line
      // the model reads next check-in already carries the truncation.)
      // Guarded chains (2026-07-17): an action may carry `if` — evaluated
      // HERE, mid-plan, against what the preceding actions actually changed
      // (polled ~3s: server outcomes are async). This packs contingent
      // sequences into ONE check-in ("use the NPC; give_item if the token
      // arrived") instead of burning a whole LLM round-trip per rung.
      const guardSnap = () => {
        const s = { pose: poseOf(b), heardLen: (state._heardChat ?? []).length, inv: null };
        try { s.inv = b?.host?.TryGetPlayerInventory?.()?.length ?? null; } catch {}
        return s;
      };
      const guardMet = (cond, snap) => {
        if (cond === "inventory_gained") {
          try {
            const inv = b?.host?.TryGetPlayerInventory?.()?.length ?? null;
            return typeof inv === "number" && typeof snap.inv === "number" && inv > snap.inv;
          } catch { return false; }
        }
        if (cond === "moved") {
          const cur = poseOf(b);
          if (!cur || !snap.pose) return false;
          return cur.cell !== snap.pose.cell ||
            Math.hypot(cur.x - snap.pose.x, cur.y - snap.pose.y, cur.z - snap.pose.z) > 3;
        }
        // Bare "heard" (2026-07-18): the model writes it naturally ("run
        // this if the server said anything") and it previously fell through
        // to unknown-guard fail-open with a warning; met = ANY chat line
        // arrived since the snapshot.
        if (cond === "heard") return (state._heardChat ?? []).length > snap.heardLen;
        if (cond.startsWith("heard:")) {
          const needle = cond.slice(6).trim().toLowerCase();
          if (!needle) return false;
          return (state._heardChat ?? []).slice(snap.heardLen).some((r) => r.text.toLowerCase().includes(needle));
        }
        return null; // unknown guard
      };
      const waitGuard = async (cond, snap) => {
        const t0 = Date.now();
        for (;;) {
          const met = guardMet(cond, snap);
          // Unknown guard -> FAIL-OPEN: run the action, warn in the result.
          // An invented guard ("kernel_running", v6.2) almost always decorates
          // an action the model fundamentally wants; skipping it cost a whole
          // check-in round with 8 golems on a 5-HP character.
          if (met === null) return { met: true, warn: `ran despite unknown if-guard "${cond}" — valid: inventory_gained, moved, heard, heard:<text>` };
          if (met) return { met: true };
          if (Date.now() - t0 >= (Number.isFinite(cfg.guardWaitMs) ? cfg.guardWaitMs : 3000)) return { met: false };
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      let prevSnap = guardSnap();
      for (const a of kept) {
        // Mid-plan abort (report 10 #2): re-check the operator's stop
        // surfaces BETWEEN actions, not just once before the loop starts —
        // a multi-action plan (goto + buy + say, chained in one reply) must
        // halt everything after the action in flight when the operator
        // stops mid-execution, not run to completion. `b.ai.director` is
        // absent in bare/unit-test bots, so an unwired director never blocks
        // execution here (matches guardPlan's fail-open-on-absent-surface
        // pattern elsewhere in this file).
        let stopped = false;
        try { stopped = isOperatorStopLatched() || b?.ai?.director?.enabled === false; } catch { stopped = false; }
        if (stopped) {
          results.push({ type: a?.type ?? "?", ok: false, error: "aborted: operator stop" });
          continue;
        }
        const cond = typeof a?.if === "string" ? a.if.trim() : "";
        let guardWarn = null;
        if (cond) {
          const g = await waitGuard(cond, prevSnap);
          if (!g.met) {
            results.push({ type: a.type, ok: false, error: `skipped: if "${cond}" unmet after prior actions` });
            continue;
          }
          guardWarn = g.warn ?? null;
          if (guardWarn) journalNote(`if-guard: ${guardWarn}`);
        }
        prevSnap = guardSnap();
        const def = extFor(a);
        if (def) results.push(await def.apply(b, a, { journal, log: opts.log, track, interactions }));
        else results.push(...(await executePlan(b, [a], { log: opts.log, journal })));
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
  // Goal-gated verb groups (C4-3): drop the economy verbs when no econ/loot
  // goal is active and the advancement verbs when no advancement goal is —
  // keyed on the goal set, so a future gear-focused goal restores exactly the
  // group it needs. World / knowledge / nav / memory / route verbs (and the
  // hunt toggle) are never gated: an explorer uses them.
  const hiddenVerbs = new Set();
  if (!goalActive(activeGoals, ECON_GOALS)) for (const v of economyVerbs) hiddenVerbs.add(v);
  if (!goalActive(activeGoals, ADVANCEMENT_GOALS)) for (const v of advancementVerbs) hiddenVerbs.add(v);
  const extCatalog = renderExtCatalog(extActions, hiddenVerbs.size ? hiddenVerbs : null);
  const persona = renderPersonaPreamble(cfg.persona);
  const withPersona = persona ? `${persona}\n\n${basePrompt}` : basePrompt;
  const GUARDS_NOTE =
    'Any action may add "if": "inventory_gained" | "moved" | "heard:<text>" — checked mid-plan against what the PREVIOUS actions actually changed, so contingent chains fit in ONE plan (e.g. use an NPC, then give_item with "if":"inventory_gained"). Unmet guard = that action is skipped and the result line says so. Any OTHER guard name is not evaluated: the action runs unconditionally and a journal warning notes the invalid guard.';
  const withCatalog = extCatalog ? `${withPersona}\n\nEXTRA ACTIONS\n${extCatalog}\n\n${GUARDS_NOTE}` : withPersona;
  const withMemory = memory ? `${withCatalog}\n\n${MEMORY_DISCIPLINE}` : withCatalog;
  const systemPrompt = wbt ? `${withMemory}\n\n${PLAYTESTER_DISCIPLINE}` : withMemory;

  return {
    directorDeps: { observe, validate, execute, systemPrompt },
    extActions,
    knowledge,
    dungeonNav,
    wbt,
    economy,
    advancement,
    world,
    routes,
    memory,
    state,
    exploreMemory,
    interactions,
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
