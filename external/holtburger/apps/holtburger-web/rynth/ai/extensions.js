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
import { registerAdvancement } from "./tools/advancement.js";
import { registerWorld } from "./tools/world.js";
import { registerMemory, renderScratchpadSection } from "./tools/memory.js";
import { DEFAULT_SYSTEM_PROMPT } from "./director.js";

// = executePlan's own default (actions.js:197) + SPEC "Cost & safety" cap;
// guardPlan enforces it over ext + v1 actions combined. cfg.maxActions
// overrides (2026-07-17).
const MAX_ACTIONS_PER_CHECK = 5;

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
  "lines and the tried:/explored: lines are ground truth; your scratchpad is",
  "not, so never let it contradict them.",
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
  "objects and areas you have NOT tried (see tried:/explored:) — breadth of",
  "interaction is how a playtester earns their keep.",
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
    economy = registerEconomy(extActions);
  }

  // Advancement hands (tools/advancement.js): raise_attribute / raise_vital /
  // raise_skill / train_skill over the RynthWebHost advancement plane. Default-
  // on; a host without those capabilities degrades to ok:false. cfg.advancement:
  // false -> off.
  let advancement = null;
  if (cfg.advancement !== false) {
    advancement = registerAdvancement(extActions);
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

  const extFor = (a) =>
    a && typeof a === "object" && typeof a.type === "string"
      ? extActions[a.type] ?? null
      : null;

  // trend history for observe_ext lives here, caller-owned per contract
  // (observe_ext.js:15-16).
  const state = {};

  // Persistent scratchpad (tools/memory.js): model-editable memory carried
  // into every observation — the durability tier the rolling journal tail
  // lacks. Default-on. cfg.memory: false -> off.
  let memory = null;
  if (cfg.memory !== false) {
    memory = registerMemory(extActions, state);
  }

  // ── loop detection (2026-07-17) ────────────────────────────────────────
  // Movement-intent actions (use_object/goto/goto_lb) that repeat with no
  // position change get an authoritative WARNING prepended to the next
  // observation. Ground-truth injection beats prompt persuasion: the live
  // soak showed the model journaling "exited the academy" while standing
  // still, then trusting that false note on later check-ins.
  const LOOP_TYPES = new Set(["use_object", "goto", "goto_lb"]);
  const LOOP_WINDOW_MS = 45 * 60_000;
  const LOOP_MAX_ACTS = 24;
  const LOOP_MOVED_M = 3;
  const poseOf = (b) => {
    try {
      const p = b?.host?.TryGetPlayerPose?.();
      return p ? { cell: p.objCellId >>> 0, x: p.x, y: p.y, z: p.z } : null;
    } catch { return null; }
  };
  const fpOf = (a) => {
    try {
      const { type, ...rest } = a;
      return `${type} ${JSON.stringify(rest, Object.keys(rest).sort())}`;
    } catch { return String(a?.type); }
  };
  const recordAct = (b, a) => {
    if (!LOOP_TYPES.has(a?.type)) return;
    const acts = (state._recentActs ??= []);
    acts.push({ fp: fpOf(a), t: Date.now(), pose: poseOf(b) });
    if (acts.length > LOOP_MAX_ACTS) acts.splice(0, acts.length - LOOP_MAX_ACTS);
  };
  const loopWarning = (b) => {
    const now = Date.now();
    const acts = (state._recentActs ?? []).filter((r) => now - r.t < LOOP_WINDOW_MS);
    state._recentActs = acts;
    if (!acts.length) return "";
    const cur = poseOf(b);
    if (!cur) return "";
    const byFp = new Map();
    for (const r of acts) {
      if (!byFp.has(r.fp)) byFp.set(r.fp, []);
      byFp.get(r.fp).push(r);
    }
    const lines = [];
    for (const [fp, rs] of byFp) {
      if (rs.length < 2) continue;
      // vs the LAST attempt's pose: use_object walks you to the target, so a
      // first-attempt baseline would count that approach walk as progress.
      const last = rs[rs.length - 1].pose;
      if (!last) continue;
      const moved =
        last.cell !== cur.cell ||
        Math.hypot(cur.x - last.x, cur.y - last.y, cur.z - last.z) > LOOP_MOVED_M;
      if (!moved)
        lines.push(
          `WARNING: ${fp} attempted ${rs.length}x with NO position change — it is NOT working. Do not repeat it; pick a different object or approach.`
        );
    }
    return lines.slice(0, 3).join("\n");
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
  const deltasLine = (b) => {
    const cur = snapshot(b);
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

  const coverageLines = (b) => {
    const cur = poseOf(b);
    if (cur) (state._visitedCells ??= new Set()).add(cur.cell);
    const lines = [];
    const used = state._usedObjects;
    if (used?.size) {
      const items = [...used.entries()].slice(-12).map(
        ([g, r]) => `${r.name} 0x${g.toString(16).toUpperCase()}${r.n > 1 ? ` (x${r.n})` : ""}`
      );
      lines.push(`tried: ${items.join("; ")}`);
    }
    if (state._visitedCells?.size) lines.push(`explored: ${state._visitedCells.size} cells this session`);
    return lines.join("\n");
  };

  // ── area-stall detection (2026-07-17) ──────────────────────────────────
  // The loop detector catches REPEATS; it is blind to novelty-dithering —
  // touring a fresh sign/door each check-in forever (observed live: 30+ min
  // in the academy, a different object every cycle, zero area progress).
  // Track the landblock; when it hasn't changed for cfg.stallMinutes
  // (default 10) and several objects have been tried since, say so with the
  // same authority as the loop WARNING. cfg.stall: false -> off.
  const STALL_MIN = Number.isFinite(cfg.stallMinutes) ? cfg.stallMinutes : 10;
  const STALL_TRIES = 4;
  const stallLine = (b) => {
    if (cfg.stall === false) return "";
    const cur = poseOf(b);
    if (!cur) return "";
    const lb = cur.cell >>> 16;
    const now = Date.now();
    if (state._stallLb !== lb) {
      state._stallLb = lb;
      state._stallSinceT = now;
      state._stallTriedBase = state._triedTotal ?? 0;
      return "";
    }
    const mins = (now - (state._stallSinceT ?? now)) / 60_000;
    const tried = (state._triedTotal ?? 0) - (state._stallTriedBase ?? 0);
    if (mins < STALL_MIN || tried < STALL_TRIES) return "";
    return (
      `STALLED: ${Math.round(mins)} min in the same area, ${tried} object uses with NO area change — ` +
      `what you keep trying is NOT working. Change approach CLASS: an NPC you have not used, ` +
      `give_item, ${knowledge ? "a knowledge lookup with NEW terms, " : ""}or walk to the farthest visible object.`
    );
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
    const obs = enrichObservation(b, buildObservation(b, o), { ...o, state });
    const baseText = typeof obs?.text === "string" ? obs.text : String(obs ?? "");
    const parts = [];
    const warn = loopWarning(b);
    if (warn) parts.push(warn);
    const stall = stallLine(b);
    if (stall) parts.push(stall);
    if (memory) parts.push(renderScratchpadSection(state));
    const dl = deltasLine(b);
    if (dl) parts.push(dl);
    const hl = heardLines();
    if (hl) parts.push(hl);
    const cov = coverageLines(b);
    if (cov) parts.push(cov);
    parts.push(baseText);
    const text = parts.join("\n");
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
        recordAct(b, a); // pose BEFORE the action runs — loop detector baseline
        const def = extFor(a);
        if (def) results.push(await def.apply(b, a, { journal, log: opts.log, track }));
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
    memory,
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
