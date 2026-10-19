// rynth/vt/index.js — the VTank layer composition root (PLAN §3.15, INT-2).
//
// The ONE place that imports across the vt packages (C2): it wires the
// Wave-1 modules — EXPR, SET, FMT, META, CMD, NAV, CMB, SEAM signals, SUP —
// into a live layer on a createGrindBot() bot, with ZERO behaviour change at
// the Default profile (V-2, pinned by tests/rynth_vt_parity.test.mjs):
//
//   createAuxShell()           the kernel's `aux` (PLAN §3.13) — bot.js builds it
//                              before the kernel and passes it in; empty until
//                              createVtLayer fills it, and every slot it gets is
//                              disabled at the schema defaults (Z2).
//   createVtLayer(bot, opts)   the layer (bot.vt). Never awaits a fetch: data
//                              JSON (combat spells, species, support tables)
//                              loads lazily after it returns (critic B5).
//
// Clock/event flow per host heartbeat (§3.3): router → unwedge → [explore
// pressure] → layer.preTick (registered by bot.js BEFORE the kernel closure)
// → kernel tick (aux slots inside) → operator-control flush → layer.postTick
// (registered here; every 5th heartbeat). One host.onEvent subscription for
// the whole layer: host_signals (V-9).
//
// While the operator holds the bot nothing here acts (V-7): the meta engine
// only flushes vars, the /ub delay queue and delayexec wait, the background
// item reflexes stay off — except ManaChargesWhenOff refills.
//
// dispose() detaches every listener and hook this layer attached (combat.vt,
// combat.acquireRangeFn, loot.classify, item buffs, the aux slots, the unwedge
// predicate), flushes vars/profile/creatures, cancels the nav executor and the
// delayexec queue. The page session survives (D6): a rebind on the same page
// continues nav index, meta state, overlay and session vars.

import {
  parse,
  ExprRuntime,
  FunctionRegistry,
  VarStore,
  truthy,
  toStr,
  equals,
  isErr,
  getRegex,
  registerPureStdlib,
} from "./expr/index.js";
import { getVtSession, createLiveCells } from "./settings/index.js";
import {
  parseMet,
  writeMet,
  parseAf,
  writeAf,
  parseViewXml,
  parseUtl,
  writeUtl,
  UTL_NODE_TYPES,
  newUtlProfile,
  validateUtl,
  importUsdProfile,
} from "./formats/index.js";
import { MetaEngine, ViewManager, registerViewFunctions, registerMetaFunctions } from "./meta/index.js";
import { createRsDispatcher, createVtActions, registerHostFunctions, QuestTracker } from "./cmd/index.js";
import { ActiveNav, NavProfiles } from "./nav/index.js";
import {
  MonsterList,
  MONSTER_VARIABLES,
  normalizeEntry,
  makeMonsterVars,
  DebuffLedger,
  AttackPlanner,
  ItemsModel,
  CreatureProfiles,
  itemBuffFamilies,
  bestCastable,
  isLoaded as combatSpellsLoaded,
  durationOf,
  nameOf,
} from "./combat/index.js";
import { createHostSignals } from "./host_signals.js";
import { createSupport, supportData } from "./support/index.js";
import { buildMetaContext } from "./glue/meta_context.js";
import { buildHostFnContext } from "./glue/host_fn_context.js";
import { makeLootClassify } from "./glue/loot_ctx.js";
import { installRsEntry, openVtPanel, loadViewRendererFactory } from "./rs_entry.js";
import * as gotoCompose from "../goto_compose.js";
import { createHostSkillCap, readTierThresholds } from "../skill_cap.js";

export const VT_LAYER_VERSION = 1;
/** postTick runs every Nth heartbeat (10 Hz host → 2 Hz, §3.3). */
export const POST_TICK_DIVIDER = 5;
const ONE_HZ_MS = 1000;
const CAT_SYSTEM = 0;
const VT_RANK_ORDER = ["Supplies", "JumpNow", "Pets", "Doors", "Navigate", "BuffItems", "IdleRebuff"];

const errText = (e) => String(e && e.message ? e.message : e);
const finite = (x) => typeof x === "number" && Number.isFinite(x);

function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

/** C3 logger: "[vt] " prefix on the console default; identical lines ≤ 1 / 10 s. */
function makeLog(log, now) {
  const base = typeof log === "function" ? log : (m) => console.log(`[vt] ${m}`);
  const seen = new Map();
  return (m0) => {
    const m = String(m0);
    let t = 0;
    try {
      t = Number(now()) || 0;
    } catch {
      t = 0;
    }
    const prev = seen.get(m);
    if (prev !== undefined && t >= prev && t - prev < 10_000) return;
    if (seen.size > 256) seen.clear();
    seen.set(m, t);
    try {
      base(m);
    } catch {
      /* a logger never throws into the layer */
    }
  };
}

/**
 * The kernel aux shell (PLAN §3.13): `{ slots, idleHooks, policy, status() }`.
 * The kernel reads the arrays live every tick, so the layer fills them after
 * the kernel exists. status() reports only enabled slots/hooks.
 */
export function createAuxShell() {
  const shell = {
    slots: [],
    idleHooks: [],
    policy: { boostLoot: () => false },
    status() {
      const out = { slots: [], idleHooks: [] };
      for (const s of shell.slots) {
        if (!s || safe(() => s.enabled() === true, false) !== true) continue;
        let rank = s.rank;
        if (typeof rank === "function") rank = safe(() => rank.call(s), null);
        out.slots.push({
          name: s.name,
          rank,
          pinned: safe(() => (typeof s.pinned === "function" ? s.pinned() === true : false), false),
          status: safe(() => s.status ?? null, null),
        });
      }
      for (const h of shell.idleHooks) {
        if (h && safe(() => h.enabled() === true, false)) out.idleHooks.push(h.name);
      }
      out.boostLoot = safe(() => shell.policy.boostLoot() === true, false);
      return out;
    },
  };
  return shell;
}

/** URL-pinned keys (§4.5): ?botBuffs ⇒ buffs; ?botPersona=explorer ⇒ EnableCombat/EnableLooting. */
export function urlPinnedKeys(win) {
  const pinned = new Set();
  const search = safe(() => win && win.location && win.location.search, "");
  if (typeof search !== "string" || !search) return pinned;
  let sp;
  try {
    sp = new URLSearchParams(search);
  } catch {
    return pinned;
  }
  const buffs = sp.get("botBuffs");
  if (buffs !== null && String(buffs).trim() !== "") pinned.add("buffs");
  if (String(sp.get("botPersona") ?? "").trim().toLowerCase() === "explorer") {
    pinned.add("EnableCombat");
    pinned.add("EnableLooting");
  }
  return pinned;
}

function resolveStorage(win, storage) {
  if (storage !== undefined) return storage;
  try {
    const ls = win && win.localStorage;
    return ls && typeof ls.getItem === "function" ? ls : null;
  } catch {
    return null;
  }
}

/**
 * The Monsters-tab expression runtime (mode "monster"): delayexec[] is refused
 * with an Err (review runtime-8). Nothing pumps this runtime's queue — only the
 * meta engine pumps the meta runtime — so a queued body silently never ran;
 * pumping it instead would give a passive monster scan side effects.
 */
class MonsterExprRuntime extends ExprRuntime {
  delay() {
    throw new Error("delayexec is not available in monster expressions");
  }
}

/** Does a meta read the player's enchantments? A SecsOnSpellGE condition, or a
 *  getspellexpiration[] / getspellexpirationbyname[] call anywhere in it (an
 *  Expr condition, an expression action, a view — review wiring-3). */
function metaReadsEnchantments(meta) {
  const walk = (c) => !!c && (c.t === "SecsOnSpellGE" || (Array.isArray(c.children) && c.children.some(walk)));
  try {
    if (!meta || !Array.isArray(meta.rules)) return false;
    if (meta.rules.some((r) => walk(r && r.cond))) return true;
    return /getspellexpiration/i.test(JSON.stringify(meta));
  } catch {
    return false;
  }
}

function knownSig(ids) {
  let sum = 0;
  for (const id of ids) sum = (sum + (Number(id) >>> 0)) % 2147483647;
  return `${ids.length}:${sum}`;
}

/**
 * Build the VTank layer on a createGrindBot() bot (PLAN §3.15 steps 1-18).
 * @param {object} bot   the bot (host, kernel, combat, buff, loot, router, unwedge, …)
 * @param {{ aux?: object, win?: object, storage?: object|null, log?: Function,
 *           now?: () => number, print?: (text, category) => void }} [opts]
 * @returns {Promise<object>} the VtLayer (bot.vt)
 */
export async function createVtLayer(bot, { aux = null, win = globalThis, storage = undefined, log = null, now = null, print = null } = {}) {
  if (!bot || typeof bot !== "object" || !bot.host) throw new Error("createVtLayer: a createGrindBot() bot is required");
  const host = bot.host;
  const W = win && (typeof win === "object" || typeof win === "function") ? win : null;
  const clock = typeof now === "function" ? now : () => Date.now();
  const say = makeLog(log, clock);
  const callHost = (name, ...args) => {
    const f = host && host[name];
    if (typeof f !== "function") return undefined;
    try {
      return f.apply(host, args);
    } catch {
      return undefined;
    }
  };

  let disposed = false;
  const layer = { version: VT_LAYER_VERSION, bot, host, win: W };
  // Side effects made so far, undone in reverse if construction fails half
  // way (bot.js then boots without the layer — I-24 spirit).
  const undo = [];
  try {
    return buildLayer();
  } catch (e) {
    disposed = true;
    for (const fn of undo.reverse()) safe(fn);
    throw e;
  }

  function buildLayer() {
    // ── (1)-(2) the page session for this character ──────────────────────────
    const guid = (Number(callHost("GetPlayerId")) >>> 0) || (Number(safe(() => host.s?.playerGuid?.(), 0)) >>> 0);
    const scope = guid ? String(guid) : "pending";
    // A character that is not known yet gets an in-memory session: nothing is
    // persisted under a bogus key, and it is never migrated (SET review §8.2).
    const st = guid ? resolveStorage(W, storage) : null;
    if (!guid) say("player guid unknown at attach — this layer keeps its settings in memory only");
    const charName = guid ? String(callHost("TryGetObjectName", guid) ?? "") : "";
    const session = getVtSession(W || {}, scope, { storage: st, charName, now: clock, log: say });
    const firstAttach = session.attachCount++ === 0;
    undo.push(() => {
      session.attachCount = Math.max(0, session.attachCount - 1);
    });
    const options = session.options;
    const profiles = session.profiles;
    Object.assign(layer, { session, options, profiles, scope, firstAttach });
    if (!session.ext || typeof session.ext !== "object") session.ext = {};

    // ── output + the local command chain ────────────────────────────────────
    const printOut = (text, category = CAT_SYSTEM) => {
      try {
        if (typeof print === "function") return void print(String(text), category);
        const append = W && W.__appendChatLine;
        if (typeof append === "function") return void append(String(text), category);
        if (callHost("WriteToChatWindow", String(text), category) === true) return;
        say(String(text));
      } catch {
        /* output is best effort */
      }
    };
    layer.now = clock;
    layer.log = say;
    layer.print = printOut;
    layer.runChat = (line, { source = "meta" } = {}) => {
      try {
        return layer.rs ? layer.rs.runChat(line, { source }) : { handled: false, lines: [] };
      } catch (e) {
        say(`runChat failed: ${errText(e)}`);
        return { handled: false, lines: [], error: errText(e) };
      }
    };

    // ── (3)-(4) live cells + profile application (§4.5) ──────────────────────
    const cells = createLiveCells(bot);
    options.bindCells(cells);
    undo.push(() => options.bindCells(null));
    // HUD Restart under a user profile re-applies the profile's legacy keys
    // (Enable*, attack, blacklist…) — hudBootOverrides() carries only
    // {buffs, priorities, lootMin, vitals} (SET review §8.1, binding).
    const hudBoot = safe(() => W?.__botBootSpec?.source === "hud", false) === true;
    const legacy = firstAttach || (hudBoot && safe(() => profiles.isUserProfileActive() === true, false) === true);
    const urlPinned = urlPinnedKeys(W);
    options.applyToCells({ legacy, urlPinned });

    // ── (5) host signals: THE one host.onEvent subscription ──────────────────
    const signals = createHostSignals(host, { win: W && typeof W.addEventListener === "function" ? W : null, now: clock, log: say });
    const subscribe = (type, fn) => signals.on(type, fn);
    layer.signals = signals;
    undo.push(() => signals.dispose());

    // ── (6) expression runtimes + the function registry ──────────────────────
    const functions = new FunctionRegistry({ log: say });
    // Session vars live in the page session (D6/D33): one VarStore per session.
    let vars = session.ext.vars;
    if (!(vars instanceof VarStore)) {
      vars = new VarStore({ storage: st, scope, now: clock, log: say });
      try {
        if (session.varsSession && Array.isArray(session.varsSession.vars)) vars.importSession(session.varsSession);
      } catch {
        /* a broken export starts empty */
      }
      session.ext.vars = vars;
    }
    const expr = new ExprRuntime({ functions, vars, mode: "meta", now: clock, log: say });
    const monsterExpr = new MonsterExprRuntime({ functions, vars, mode: "monster", now: clock, log: say });
    registerPureStdlib(functions);
    Object.assign(layer, { functions, vars, expr, monsterExpr, parseExpr: (text, o) => parse(text, o), monsterVariables: MONSTER_VARIABLES });

    // ── (7) combat: monster list, planner, ledger, items, creature profiles ──
    let creatures = session.ext.creatures;
    if (!(creatures instanceof CreatureProfiles)) {
      creatures = new CreatureProfiles({ storage: st, now: clock, log: say });
      session.ext.creatures = creatures;
    }
    const items = new ItemsModel({
      options,
      host,
      log: say,
      isPetDevice: (inv) => {
        const t = supportData("pet_essences");
        return !!(t && t.essences && inv && t.essences[String(Number(inv.wcid) >>> 0)]);
      },
    });
    const monsters = new MonsterList({
      entries: options.getList("monsters"),
      parse,
      evaluate: (p, ri) => monsterExpr.evaluate(p, { resolveIdent: ri }),
      truthy,
      equalsCI: equals,
      varsFor: makeMonsterVars({ host, options, creatures, getMetaState: () => safe(() => layer.meta.state, ""), now: clock, log: say }),
      log: say,
    });
    const ledger = new DebuffLedger({ now: clock, durationOf, nameOf, log: say });
    const planner = new AttackPlanner({
      host,
      options,
      monsters,
      ledger,
      items,
      creatures,
      subscribe, // castLine / useFailed / equip reach the ledger ONLY through here (CMB review §7.4)
      getCombat: () => bot.combat || null,
      getNav: () => layer.nav || null,
      // The SwitchWandsToDebuff pre-swap loadout lives in the page session, so
      // a rebind mid-debuff still puts the weapon back (review runtime-3).
      state: (session.ext.plannerState ||= {}),
      now: clock,
      log: say,
    });
    Object.assign(layer, { items, monsters, ledger, planner, creatures });
    undo.push(() => planner.dispose());
    const combat = bot.combat || null;
    // (7b) The acquire radius hook is ALWAYS set (critic G9); m at defaults.
    const acquireFn = (m) => planner.acquireRangeM(m);
    if (combat) {
      combat.acquireRangeFn = acquireFn;
      undo.push(() => {
        if (combat.acquireRangeFn === acquireFn) combat.acquireRangeFn = null;
        if (combat.vt === planner) combat.vt = null;
        safe(() => combat.invalidateScan?.());
      });
    }
    function refreshPlanner() {
      if (!combat || disposed) return;
      // Stay attached while a SwitchWandsToDebuff swap still owes the weapon
      // back (CMB review §7.6): detaching mid-swap would strand the wand.
      const owes = safe(() => planner.status().saved != null, false) === true;
      const want = planner.isActive() || owes ? planner : null;
      if (combat.vt !== want) {
        combat.vt = want;
        safe(() => combat.invalidateScan?.());
      }
    }
    refreshPlanner();

    // ── (8) navigation ───────────────────────────────────────────────────────
    const navProfiles = new NavProfiles({ store: session.stores.nav, now: clock, log: say });
    const nav = new ActiveNav({
      host,
      router: bot.router || null,
      bot,
      options,
      profiles: navProfiles,
      state: session.navState,
      subscribe,
      runChat: (line) => layer.runChat(line, { source: "nav" }),
      gotoCompose,
      onNpcTell: (_name, text) => safe(() => vars.set("session", "navlasttell", text)),
      // Meta-visible nav state (PLAN R22 / R9, review guide-3).
      onReversed: (v) => safe(() => vars.set("session", "navreversed", v ? 1 : 0)),
      onResult: (t) => safe(() => vars.set("session", "navlastresult", t)),
      log: say,
      now: clock,
      print: printOut,
    });
    Object.assign(layer, { nav, navProfiles });
    undo.push(() => nav.dispose());

    // ── (9) meta engine + views ──────────────────────────────────────────────
    let meta = null;
    const views = new ViewManager({
      parseXml: parseViewXml,
      evaluate: (src) => expr.evaluate(src),
      setState: (s) => meta && meta.enterState(s, "manual"),
      log: say,
      now: clock,
    });
    // Meta views created before the VT panel was ever opened still get a DOM
    // renderer: the first successful create lazily attaches one (UI review §4.3).
    let rendererKicked = false;
    const createView = views.create.bind(views);
    views.create = (name, xml) => {
      const r = createView(name, xml);
      if (r && r.ok && !views.renderer && !rendererKicked && !disposed) {
        const p = loadViewRendererFactory(W);
        if (p) {
          rendererKicked = true;
          p.then((factory) => {
            if (!factory || disposed || views.renderer) return;
            views.setRenderer(factory({ doc: W.document, onClick: (v, c) => views.click(v, c) }));
          }).catch((e) => say(`meta view renderer unavailable: ${errText(e)}`));
        }
      }
      return r;
    };
    layer.views = views;
    const metaCtx = buildMetaContext({ bot, host, layer });
    meta = new MetaEngine({
      ctx: metaCtx,
      expr,
      getRegex,
      values: { truthy, toStr, isErr },
      setVar: (n, v) => expr.setVar(n, v),
      state: session.metaState,
      now: clock,
      log: say,
    });
    layer.meta = meta;
    undo.push(() => meta.destroy());
    registerMetaFunctions(functions, () => layer.meta);
    registerViewFunctions(functions, views, { truthy });
    let metaWantsEnchantments = false;
    if (session.meta) {
      const r = meta.replaceMeta(session.meta, { keepState: true }); // never load(): that re-enters Default
      if (!r.ok) say(`could not restore the session meta: ${r.error}`);
      metaWantsEnchantments = metaReadsEnchantments(session.meta);
    }
    const offMetaChange = meta.onMetaChange((m) => {
      session.meta = m || null;
      metaWantsEnchantments = metaReadsEnchantments(m);
    });
    // (9) host signals → the meta engine's one-pass events (chat with its
    // category, OUR death, portal edges, vendor open/close) and creature
    // appraisals → the learned creature profiles. castLine / useFailed / equip
    // reach the debuff ledger ONLY through the planner's own subscription (CMB
    // review §7.4: forwarding them here too would consume each cast twice).
    const fwd = (type, fn) =>
      signals.on(type, (sig) => {
        if (disposed) return;
        try {
          fn(sig);
        } catch (e) {
          say(`${type} forwarding failed: ${errText(e)}`);
        }
      });
    fwd("chat", (sig) => meta.pushEvent({ type: "chat", text: sig.text, chatType: sig.chatType, cat: sig.cat }));
    fwd("death", (sig) => {
      if (sig.self === true) meta.pushEvent({ type: "death" });
    });
    fwd("portalIn", () => meta.pushEvent({ type: "portalIn" }));
    fwd("portalOut", () => meta.pushEvent({ type: "portalOut" }));
    fwd("vendorOpen", (sig) => meta.pushEvent({ type: "vendorOpen", guid: sig.guid, name: sig.name }));
    fwd("vendorClose", (sig) => meta.pushEvent({ type: "vendorClose", guid: sig.guid }));
    fwd("appraised", (sig) => {
      const g = Number(sig.guid) >>> 0;
      if (!g) return;
      creatures.noteAppraisal(g, callHost("TryGetObjectWcid", g), callHost("TryGetObjectName", g), callHost("TryGetObjectAppraisal", g));
    });

    // ── (10) commands, actions, quests, the host function library ───────────
    const actions = createVtActions({ host: () => bot.host, getBot: () => bot, print: printOut, log: say, now: clock, getRegex });
    const quests = new QuestTracker({ subscribe, runChat: (line) => layer.runChat(line, { source: "meta" }), now: clock, log: say });
    Object.assign(layer, { actions, quests });
    undo.push(() => quests.dispose());
    registerHostFunctions(functions, buildHostFnContext({ bot, host, layer, getRegex }));
    const rsCtx = {
      source: "console",
      print: (text, category) => printOut(text, category),
      now: () => clock(),
      bot: () => bot,
      vt: () => layer,
      session: () => session,
      hud: () => safe(() => W?.__rynthHud?.bridge ?? null, null),
      host: () => bot.host,
      operatorHeld: () => safe(() => bot.kernel?.operatorHeld === true, false),
      openPanel: (tab) => openVtPanel(W, tab),
      invokeChatParser: (line) => callHost("InvokeChatParser", line) === true,
    };
    const rs = createRsDispatcher({ getCtx: () => rsCtx });
    layer.rs = rs;

    // ── (11) support: supplies, mana, inventory, pets, fellow, doors, buff items, idle
    const support = createSupport({
      host,
      bot,
      options,
      subscribe,
      items,
      now: clock,
      log: say,
      buff: () => bot.buff || null,
      combat: () => bot.combat || null,
      monsterPetDmg: (g) => safe(() => monsters.resolve(Number(g) >>> 0, { seq: host.snap?.seq, now: clock() }).entry.petDmg, "PAuto"),
      doorsRank: () => nav.slot.rank(),
      navWants: (ctx) => nav.slot.enabled() === true && nav.slot.wants(ctx) === true,
    });
    Object.assign(layer, { support, consumables: support.consumables });
    undo.push(() => support.dispose());

    // (11a) Buff items preempt the route — D39 extended to the Consumables
    // BuffItem (G:174/G:181; V-23; review guide-1/wiring-1). Navigate wants
    // every tick of a Circular/Linear route, is registered ahead of BuffItems
    // in the same rank (beforeIdle), and under Boost Nav outranks it, so a
    // beer or food was never used while a route ran. While a BuffItem is due
    // Navigate declines at EVERY rank (BuffItems never moves up: a beer must
    // not preempt threat Combat); an executor in flight (pinned: recall,
    // portal, jump) is never preempted. Doors reads nav.slot.wants too, so it
    // steps aside the same way. Nothing changes while no BuffItem is due.
    const navWantsOwn = nav.slot.wants;
    nav.slot.wants = (ctx) => {
      if (navWantsOwn(ctx) !== true) return false;
      if (safe(() => nav.slot.pinned() === true, false) === true) return true;
      const items = support.buffItems.slot;
      return !(safe(() => items.enabled() === true && items.wants(ctx) === true, false) === true);
    };

    // ── the library: meta + loot files for CMD and the UI (critic C2) ───────
    const lootBinding = { name: null, profile: null, classify: null };
    layer.loot = { profileName: null, classify: null };
    function bindLoot(name, profile) {
      const classify = makeLootClassify({ profile, getHost: () => bot.host, getRegex, log: say });
      lootBinding.name = name;
      lootBinding.profile = profile;
      lootBinding.classify = classify;
      layer.loot = { profileName: name, classify };
      session.ext.lootProfile = { name, profile };
      if (bot.loot) bot.loot.classify = classify;
    }
    function unbindLoot() {
      if (bot.loot && lootBinding.classify && bot.loot.classify === lootBinding.classify) bot.loot.classify = null;
      lootBinding.name = null;
      lootBinding.profile = null;
      lootBinding.classify = null;
      layer.loot = { profileName: null, classify: null };
      session.ext.lootProfile = null;
    }
    const nm = (name) => (typeof name === "string" || typeof name === "number" ? String(name).trim() : "");
    const wrap = (fn) => {
      try {
        return fn();
      } catch (e) {
        return { ok: false, error: errText(e), warnings: [] };
      }
    };
    const library = {
      listMetas: () => safe(() => session.stores.meta.list(), []) || [],
      loadMeta: (name) =>
        wrap(() => {
          const n = nm(name);
          if (!n) return { ok: false, error: "a meta name is required" };
          const m = session.stores.meta.get(n);
          if (!m) return { ok: false, error: `no meta named "${n}"` };
          const r = meta.load(m, { name: n, source: "library" });
          if (!r.ok) return { ok: false, error: r.error || "load failed", warnings: r.warnings || [] };
          options.setRef("metaName", n, { source: "ui" });
          return { ok: true, warnings: r.warnings || [] };
        }),
      importMeta: (name, data, kind = "json") =>
        wrap(() => {
          const n = nm(name);
          if (!n) return { ok: false, error: "a meta name is required", warnings: [] };
          let r;
          if (kind === "met") r = parseMet(data, { fileName: n });
          else if (kind === "af") r = parseAf(typeof data === "string" ? data : new TextDecoder().decode(data), { fileName: n });
          else if (kind === "json") {
            const obj = typeof data === "string" ? JSON.parse(data) : data;
            r = obj && typeof obj === "object" && Array.isArray(obj.rules) ? { ok: true, meta: obj, warnings: [] } : { ok: false, error: "not a meta JSON", warnings: [] };
          } else return { ok: false, error: `unknown meta format ${JSON.stringify(kind)} (met, af, json)`, warnings: [] };
          if (!r || !r.ok || !r.meta) return { ok: false, error: (r && r.error) || "parse failed", warnings: (r && r.warnings) || [] };
          const put = session.stores.meta.put(n, r.meta);
          return put.ok ? { ok: true, warnings: r.warnings || [] } : { ok: false, error: put.error, warnings: r.warnings || [] };
        }),
      exportMeta: (name, kind = "json") =>
        wrap(() => {
          const n = nm(name);
          const m = n ? session.stores.meta.get(n) : meta.meta();
          if (!m) return { ok: false, error: n ? `no meta named "${n}"` : "no meta loaded", warnings: [] };
          const warnings = [];
          if (kind === "met") {
            const off = Array.isArray(m.rules) ? m.rules.filter((r) => r && r.enabled === false).length : 0;
            if (off) warnings.push(`${off} disabled rule(s) left out (VTank .met has no enabled flag)`);
            return { ok: true, data: writeMet(m), warnings };
          }
          if (kind === "af") return { ok: true, data: writeAf(m), warnings };
          if (kind === "json") return { ok: true, data: JSON.stringify(m, null, 2), warnings };
          return { ok: false, error: `unknown meta format ${JSON.stringify(kind)} (met, af, json)`, warnings };
        }),
      saveMeta: (name, m = undefined) =>
        wrap(() => {
          const n = nm(name);
          if (!n) return { ok: false, error: "a meta name is required" };
          const value = m === undefined ? meta.meta() : m;
          if (!value) return { ok: false, error: "no meta to save" };
          const r = session.stores.meta.put(n, value);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        }),
      removeMeta: (name) => wrap(() => session.stores.meta.remove(nm(name))),
      listLoot: () => safe(() => session.stores.loot.list(), []) || [],
      loadLoot: (name) =>
        wrap(() => {
          const n = nm(name);
          if (!n) return { ok: false, error: "a loot profile name is required" };
          const p = session.stores.loot.get(n);
          if (!p) return { ok: false, error: `no loot profile named "${n}"` };
          bindLoot(n, p);
          options.setRef("lootProfile", n, { source: "ui" });
          return { ok: true };
        }),
      clearLoot: () =>
        wrap(() => {
          unbindLoot();
          options.setRef("lootProfile", null, { source: "ui" });
          return { ok: true };
        }),
      importLoot: (name, text) =>
        wrap(() => {
          const n = nm(name);
          if (!n) return { ok: false, error: "a loot profile name is required", warnings: [] };
          const r = parseUtl(typeof text === "string" ? text : new TextDecoder().decode(text));
          if (!r || !r.ok || !r.profile) return { ok: false, error: (r && r.error) || "parse failed", warnings: (r && r.warnings) || [] };
          const put = session.stores.loot.put(n, r.profile);
          if (put.ok && lootBinding.name && lootBinding.name.toLowerCase() === n.toLowerCase()) bindLoot(lootBinding.name, r.profile);
          return put.ok ? { ok: true, warnings: r.warnings || [] } : { ok: false, error: put.error, warnings: r.warnings || [] };
        }),
      exportLoot: (name) =>
        wrap(() => {
          const n = nm(name);
          const p = n ? session.stores.loot.get(n) : lootBinding.profile;
          if (!p) return { ok: false, error: n ? `no loot profile named "${n}"` : "no loot profile loaded" };
          return { ok: true, text: writeUtl(p) };
        }),
      getLoot: (name) => safe(() => session.stores.loot.get(nm(name)), null),
      putLoot: (name, profile) =>
        wrap(() => {
          const n = nm(name);
          if (!n) return { ok: false, error: "a loot profile name is required", errors: ["a loot profile name is required"] };
          const v = validateUtl(profile);
          if (!v.ok) return { ok: false, error: (v.errors || [])[0] || "invalid loot profile", errors: v.errors || [] };
          const r = session.stores.loot.put(n, profile);
          if (!r.ok) return { ok: false, error: r.error, errors: [r.error] };
          if (lootBinding.name && lootBinding.name.toLowerCase() === n.toLowerCase()) bindLoot(lootBinding.name, profile);
          return { ok: true };
        }),
      newLoot: () => newUtlProfile(),
      lootNodeTypes: () => UTL_NODE_TYPES,
      removeLoot: (name) =>
        wrap(() => {
          const n = nm(name);
          if (lootBinding.name && lootBinding.name.toLowerCase() === n.toLowerCase()) {
            unbindLoot();
            options.setRef("lootProfile", null, { source: "ui" });
          }
          return session.stores.loot.remove(n);
        }),
      // A VTank settings profile (.usd) → a NEW user profile (Save As, then
      // its Settings by VTank name and its Monsters tab through the
      // MonsterList validator); refused for Default and existing names.
      importUsd: (name, data, opts) =>
        wrap(() => importUsdProfile(options, name, data, { mineOnly: !!opts && opts.mineOnly === true, normalizeMonster: normalizeEntry })),
    };
    layer.library = library;

    // ── refs: a session's first attach loads what the profile names; a rebind
    //    continues the session's own nav/meta/loot (D6) ────────────────────────
    function loadProfileRefs() {
      const navRef = options.getRef("navProfile");
      if (navRef) {
        const r = nav.loadByName(navRef);
        if (!r.ok) say(`profile nav "${navRef}": ${r.error}`);
      }
      const metaRef = options.getRef("metaName");
      if (metaRef) {
        // The meta that is already running stays as it is — state, call
        // stack, (P) clock, fired flags (review logic-1). Every profile saved
        // or active while meta X ran names X (library.loadMeta → setRef;
        // saveAs copies the refs), so reloading here restarted X in Default
        // on every `/vt settings load …` from its own Chat action, and a meta
        // alternating two such profiles livelocked. C# SwitchProfile never
        // touches the MetaManager; a DIFFERENT meta still loads (12c, V-14).
        const cur = meta.meta() ? safe(() => meta.snapshot().name, null) : null;
        if (!cur || String(cur).trim().toLowerCase() !== String(metaRef).trim().toLowerCase()) {
          const r = library.loadMeta(metaRef);
          if (!r.ok) say(`profile meta "${metaRef}": ${r.error}`);
        }
      } else if (meta.meta()) meta.unload();
      const lootRef = options.getRef("lootProfile");
      if (lootRef) {
        const r = library.loadLoot(lootRef);
        if (!r.ok) say(`profile loot "${lootRef}": ${r.error}`);
      } else unbindLoot();
    }
    if (firstAttach) {
      if (options.getRef("navProfile") && nav.isEmpty()) {
        const r = nav.loadByName(options.getRef("navProfile"));
        if (!r.ok) say(`profile nav: ${r.error}`);
      }
      if (options.getRef("metaName") && !meta.meta()) {
        const r = library.loadMeta(options.getRef("metaName"));
        if (!r.ok) say(`profile meta: ${r.error}`);
      }
      if (options.getRef("lootProfile")) {
        const r = library.loadLoot(options.getRef("lootProfile"));
        if (!r.ok) say(`profile loot: ${r.error}`);
      }
    } else if (session.ext.lootProfile && session.ext.lootProfile.profile) {
      bindLoot(session.ext.lootProfile.name, session.ext.lootProfile.profile);
    }
    undo.push(() => {
      if (bot.loot && lootBinding.classify && bot.loot.classify === lootBinding.classify) bot.loot.classify = null;
    });

    // ── (12) item buffs (D38): the Items tab projected onto buff.setItemBuffs ─
    const ib = { buff: undefined, sig: null, wrote: false, knownSig: null, loaded: false };
    function projectItemBuffs(force = false) {
      if (disposed) return;
      const buff = bot.buff || null;
      const entries = safe(() => items.list(), []) || [];
      const loaded = combatSpellsLoaded() === true;
      let list = [];
      let ksig = null;
      if (entries.length) {
        if (!loaded) {
          ib.loaded = false;
          return; // the table loads lazily; the 1 Hz check re-projects once it is in
        }
        const known = (callHost("TryGetKnownSpells") || []).map((x) => Number(x) >>> 0);
        ksig = knownSig(known);
        const knownSet = new Set(known);
        const buffsList = options.getList("buffs");
        for (const e of entries) {
          const g = items.resolveGuid(e);
          if (!g) continue;
          for (const fam of itemBuffFamilies(e, buffsList)) {
            const s = bestCastable(fam, { known: knownSet });
            if (s) list.push({ spellId: s.id, itemGuid: g, itemName: e.name });
          }
        }
      }
      ib.loaded = loaded;
      ib.knownSig = ksig;
      const sig = JSON.stringify(list);
      if (!buff || typeof buff.setItemBuffs !== "function") {
        ib.buff = buff;
        ib.sig = sig;
        return;
      }
      if (!force && buff === ib.buff && sig === ib.sig) return;
      // Nothing to project and nothing projected before: leave the loop alone
      // (its dormant B7 list is today's []).
      if (!list.length && !ib.wrote && !(Array.isArray(buff.itemBuffs) && buff.itemBuffs.length)) {
        ib.buff = buff;
        ib.sig = sig;
        return;
      }
      buff.setItemBuffs(list);
      ib.wrote = list.length > 0;
      ib.buff = buff;
      ib.sig = sig;
    }
    projectItemBuffs(true);
    undo.push(() => {
      if (ib.wrote && bot.buff && typeof bot.buff.setItemBuffs === "function") bot.buff.setItemBuffs([]);
    });

    // ── (12b) buff/vital tier cap by magic skill: BuffTierSkillCap +
    // BuffMinSkillLevelTier1..8 projected onto buff/vitals setSkillCap
    // (rynth/skill_cap.js; RynthAi GetHighestBuffSpellTier). Off — the
    // default — never touches a loop, so Default stays byte-identical (V-2);
    // turned off after being on, both loops get setSkillCap(null). One host cap
    // (one 5 s skills read) serves both loops; it is rebuilt only when the
    // thresholds change, and re-applied to a loop bot.setBuffs replaced (1 Hz).
    const sc = { buff: undefined, vitals: undefined, sig: "off", cap: null, wrote: false };
    function projectSkillCap(force = false) {
      if (disposed) return;
      const buff = bot.buff || null;
      const vitals = bot.vitals || null;
      const on = safe(() => options.getValue("BuffTierSkillCap") === true, false) === true;
      const tiers = on ? readTierThresholds((k, d) => safe(() => options.getValue(k), d), "BuffMinSkillLevelTier") : null;
      const sig = on ? tiers.join(",") : "off";
      if (!force && buff === sc.buff && vitals === sc.vitals && sig === sc.sig) return;
      const capChanged = sig !== sc.sig;
      const prev = { buff: sc.buff, vitals: sc.vitals };
      sc.buff = buff;
      sc.vitals = vitals;
      sc.sig = sig;
      if (!on && !sc.wrote) return; // never projected: leave the loops' own (absent) cap alone
      if (!on) sc.cap = null;
      else if (capChanged || !sc.cap) sc.cap = createHostSkillCap(host, { tiers });
      for (const [loop, before] of [[buff, prev.buff], [vitals, prev.vitals]]) {
        if (!loop || typeof loop.setSkillCap !== "function") continue;
        if (!force && !capChanged && loop === before) continue;
        safe(() => loop.setSkillCap(sc.cap));
      }
      sc.wrote = on;
    }
    function clearSkillCap() {
      if (!sc.wrote) return;
      for (const loop of [bot.buff, bot.vitals]) {
        if (loop && typeof loop.setSkillCap === "function") safe(() => loop.setSkillCap(null));
      }
      sc.wrote = false;
      sc.cap = null;
    }
    projectSkillCap(true);
    undo.push(() => clearSkillCap());

    // ── (12c) the profile's buff list stays on the scroll ladder (2026-10-19).
    // spell_ladders.json now marks each family's scroll spells, and the buff
    // loop casts an off-ladder id in a spec exactly as named (a deliberate
    // pick, e.g. ?botBuffs). A VT list never means that: it is the Buffs
    // tab's family selection, and one saved before the ladder flags (a
    // developer who knows every spell got Zongo's Fist for Strength, Combat
    // Medication for Regeneration) would keep casting those. Once the buff
    // module and its table are loaded, any off-ladder id in the active list
    // is rewritten onto its family's ladder (buff_loop.js toLadderSpec; the
    // loop upgrades it to the best known tier) — through setList, so the bot
    // gets the same push a Buffs-tab edit makes. A list already on the ladder
    // is never written.
    const ladderMig = { lib: null, sig: null };
    import(new URL("../buff_loop.js", import.meta.url).href)
      .then(async (m) => {
        if (!m || typeof m.toLadderSpec !== "function" || typeof m.loadSpellLadders !== "function") return;
        await m.loadSpellLadders();
        if (!disposed) ladderMig.lib = m;
      })
      .catch(() => { /* no buff module: lists stay as saved */ });
    function migrateBuffList() {
      const m = ladderMig.lib;
      if (!m || disposed) return;
      const list = safe(() => options.getList("buffs"), null);
      const spec = list && Array.isArray(list.spec) ? list.spec.map((x) => Number(x) >>> 0) : null;
      const sig = spec ? spec.join(",") : "";
      if (!spec || sig === ladderMig.sig) return;
      ladderMig.sig = sig; // this list is handled — rewritten below, or left as it is
      const next = [...new Set((safe(() => m.toLadderSpec(spec), spec) || spec).map((x) => Number(x) >>> 0))];
      if (next.join(",") === sig) return;
      const r = safe(() => options.setList("buffs", { ...list, spec: next }, { source: "migrate" }), null);
      if (!r || r.ok === false) return; // refused: not retried until the list changes
      ladderMig.sig = next.join(",");
      say(`buff list: ${spec.length - next.filter((x) => spec.includes(x)).length} off-ladder spell(s) moved onto their family's scroll ladder`);
    }

    // ── option changes → the services that mirror them ───────────────────────
    const offOptions = options.onChange((evt) => {
      if (disposed || !evt) return;
      try {
        if (evt.kind === "list") {
          if (evt.key === "monsters") {
            monsters.setEntries(options.getList("monsters"));
            refreshPlanner();
            safe(() => combat?.invalidateScan?.());
          } else if (evt.key === "items") {
            refreshPlanner();
            projectItemBuffs(true);
          } else if (evt.key === "buffs") projectItemBuffs(true);
        } else if (evt.kind === "setting") {
          if (evt.key === "WarSpellMode" || evt.key === "SwitchWandsToDebuff") refreshPlanner();
          else if (evt.key === "BuffTierSkillCap" || String(evt.key).startsWith("BuffMinSkillLevelTier")) projectSkillCap();
        } else if (evt.kind === "profile") {
          // A selected profile: re-read every list, then load the refs it
          // names (never on kind:"ref" — ActiveNav.loadByName sets the ref
          // itself, reacting to it would loop; critic C6).
          monsters.setEntries(options.getList("monsters"));
          refreshPlanner();
          safe(() => combat?.invalidateScan?.());
          projectItemBuffs(true);
          projectSkillCap();
          loadProfileRefs();
        }
      } catch (e) {
        say(`settings change handling failed: ${errText(e)}`);
      }
    });
    undo.push(() => offOptions());

    // ── (11) kernel aux slots (§3.13 order) + the boost-loot policy ─────────
    const ourSlots = [
      support.supplies.slot,
      nav.jumpSlot,
      support.pets.slot,
      support.doors.slot,
      nav.slot,
      support.buffItems.slot,
      support.idle.rebuffSlot,
    ];
    const ourHooks = [support.idle.peaceHook];
    const boostLoot = () => safe(() => options.getValue("BoostLootPriority") === true, false) === true;
    // A VT-nav executor in flight (recall cast, portal/NPC use, jump waypoint) keeps the tick ahead of
    // Combat/Loot/Buffing, below only Vitals/Unwedge: a cancel throws the action away (attemptJumpLeg drives
    // input ~10 s and stops before the fire once aborted, RYNTH-4) and C# keeps nav ticking through it. Never true at Default (nav disabled ⇒ not pinned).
    const pinnedFirst = () => safe(() => nav.slot.pinned() === true, false) === true;
    if (aux && typeof aux === "object") {
      if (!Array.isArray(aux.slots)) aux.slots = [];
      if (!Array.isArray(aux.idleHooks)) aux.idleHooks = [];
      aux.slots.push(...ourSlots);
      aux.idleHooks.push(...ourHooks);
      if (!aux.policy || typeof aux.policy !== "object") aux.policy = {};
      aux.policy.boostLoot = boostLoot;
      aux.policy.pinnedFirst = pinnedFirst;
      undo.push(() => removeAux());
    }
    function removeAux() {
      if (!aux || typeof aux !== "object") return;
      if (Array.isArray(aux.slots)) {
        for (const s of ourSlots) {
          const i = aux.slots.indexOf(s);
          if (i >= 0) aux.slots.splice(i, 1);
        }
      }
      if (Array.isArray(aux.idleHooks)) {
        for (const h of ourHooks) {
          const i = aux.idleHooks.indexOf(h);
          if (i >= 0) aux.idleHooks.splice(i, 1);
        }
      }
      if (aux.policy && aux.policy.boostLoot === boostLoot) aux.policy.boostLoot = () => false;
      if (aux.policy && aux.policy.pinnedFirst === pinnedFirst) delete aux.policy.pinnedFirst;
    }

    // ── (15) unwedge: no lifestone recall / @teleloc while VT nav owns a route (D26)
    const allowEscalation = () => !(nav.enabled && nav.hasRoute() && !nav.paused);
    if (bot.unwedge) {
      bot.unwedge.allowEscalation = allowEscalation;
      undo.push(() => {
        if (bot.unwedge.allowEscalation === allowEscalation) bot.unwedge.allowEscalation = null;
      });
    }

    // ── page-only seams: rs entry, pagehide flush ────────────────────────────
    if (W && safe(() => W.document, null)) {
      try {
        installRsEntry(W);
      } catch (e) {
        say(`rs entry unavailable: ${errText(e)}`);
      }
    }
    const onPageHide = () => {
      try {
        flushAll();
      } catch {
        /* best effort on the way out */
      }
    };
    let pageHideAttached = false;
    if (W && typeof W.addEventListener === "function" && safe(() => W.document, null)) {
      try {
        W.addEventListener("pagehide", onPageHide);
        pageHideAttached = true;
        undo.push(() => W.removeEventListener("pagehide", onPageHide));
      } catch {
        pageHideAttached = false;
      }
    }
    function flushAll() {
      safe(() => vars.flush({ force: true }));
      safe(() => {
        session.varsSession = vars.exportSession();
      });
      safe(() => options.flushNow());
      safe(() => creatures.flush());
    }

    // ── ticks ────────────────────────────────────────────────────────────────
    let last1Hz = -Infinity;
    let postN = 0;
    function oneHz(t) {
      safe(() => ledger.prune());
      safe(() => options.syncCells());
      migrateBuffList();
      // A new buff loop (bot.setBuffs built one) or a newly loaded spell table
      // or a changed spellbook re-projects the item buffs.
      const entries = safe(() => items.list().length, 0);
      if ((bot.buff || null) !== sc.buff || (bot.vitals || null) !== sc.vitals) projectSkillCap();
      if (bot.buff !== ib.buff) projectItemBuffs(true);
      else if (entries && (!ib.loaded ? combatSpellsLoaded() === true : knownSig((callHost("TryGetKnownSpells") || []).map((x) => Number(x) >>> 0)) !== ib.knownSig)) {
        projectItemBuffs(true);
      }
      // A finished wand restore lets an inactive planner detach.
      if (combat && combat.vt === planner && !planner.isActive()) refreshPlanner();
      // The receivedAt book of TryGetSelfEnchantments stamps on first sight:
      // keep it warm only while something reads enchantments (SEAM note 2) —
      // incl. a BuffItems entry, whose slot reads the book only when the
      // kernel offers it the tick: a row first read after a fight would
      // overstate its remaining time by the fight's length and eat the
      // G:181 rebuff margin (review wiring-3).
      if (
        metaWantsEnchantments ||
        options.getValue("UseDispelItems") === true ||
        options.getValue("CastDispelSelf") === true ||
        safe(() => support.buffItems.slot.enabled() === true, false) === true
      ) {
        callHost("TryGetSelfEnchantments");
      }
      void t;
    }

    function reflexGateOpen(info) {
      if (info.kernelAction !== "Idle" && info.kernelAction !== "Navigate") return false;
      const lootState = safe(() => bot.loot?.state ?? null, null);
      if (bot.loot && lootState !== null && lootState !== "SCAN") return false;
      if (Number(callHost("GetBusyState") ?? 0) !== 0) return false;
      if ((Number(callHost("GetGroundContainerId") ?? 0) >>> 0) !== 0) return false;
      if (safe(() => host.itemActionToken, null)) return false;
      return true;
    }

    /** Before the kernel tick (bot.js registers it ahead of the kernel closure). */
    layer.preTick = (nowArg) => {
      if (disposed) return;
      const t = finite(nowArg) ? nowArg : clock();
      const k = bot.kernel || null;
      const held = safe(() => k?.operatorHeld === true, false) === true;
      try {
        signals.sample();
      } catch (e) {
        say(`signals.sample failed: ${errText(e)}`);
      }
      try {
        meta.noteKernelAction(k ? k.action : null);
        meta.tick(t, { running: !held });
      } catch (e) {
        say(`meta tick failed: ${errText(e)}`);
      }
      if (!held) {
        try {
          rs.pump(t);
        } catch (e) {
          say(`command pump failed: ${errText(e)}`);
        }
      }
      safe(() => quests.tick(t));
      safe(() => options.autosaveTick(t));
      if (held && options.getValue("ManaChargesWhenOff") === true) {
        safe(() => support.manaStones.reflex.tick(t, { held: true, kernelAction: k ? k.action : "Idle", running: false }));
      }
      if (t - last1Hz >= ONE_HZ_MS || t < last1Hz) {
        last1Hz = t;
        try {
          oneHz(t);
        } catch (e) {
          say(`1 Hz upkeep failed: ${errText(e)}`);
        }
      }
    };

    /** After the kernel tick, every POST_TICK_DIVIDER heartbeats (§3.3 gate). */
    layer.postTick = (nowArg) => {
      if (disposed) return;
      postN = (postN + 1) % POST_TICK_DIVIDER;
      if (postN !== 0) return;
      const t = finite(nowArg) ? nowArg : clock();
      const k = bot.kernel || null;
      if (safe(() => k?.operatorHeld === true, false) === true) return;
      const info = { held: false, kernelAction: k ? k.action : "Idle", running: safe(() => k?.running === true, false) === true };
      try {
        const invOn = safe(() => support.inventory.reflex.enabled() === true, false) === true;
        const manaOn = safe(() => support.manaStones.reflex.enabled() === true, false) === true;
        if ((invOn || manaOn) && reflexGateOpen(info)) {
          if (invOn) support.inventory.reflex.tick(t, info);
          if (manaOn) support.manaStones.reflex.tick(t, info);
        }
        support.fellow.reflex.tick(t, info);
      } catch (e) {
        say(`post-tick failed: ${errText(e)}`);
      }
    };
    // (14) the post-tick closure (the pre-tick one is bot.js's, before the kernel's).
    host.onTick(() => layer.postTick());

    layer.statusLine = () => {
      try {
        const parts = [];
        const a = profiles.active();
        parts.push(`profile ${a && a.name ? a.name : "Default"}`);
        const ns = nav.status();
        if (ns.enabled || ns.n) {
          const where = ns.n ? `${Math.min(ns.i + 1, ns.n)}/${ns.n}` : "empty";
          parts.push(`nav ${ns.name || ns.typeName || "route"} ${where}${ns.enabled ? "" : " (off)"}${ns.paused ? ` paused: ${ns.paused.reason}` : ""}`);
        }
        if (meta.meta()) parts.push(`meta ${meta.state}${meta.enabled ? "" : " (off)"}`);
        if (layer.loot.profileName) parts.push(`loot ${layer.loot.profileName}`);
        return `VT · ${parts.join(" · ")}`;
      } catch {
        return "VT";
      }
    };

    layer.dispose = () => {
      if (disposed) return;
      disposed = true;
      safe(() => offOptions());
      safe(() => offMetaChange());
      if (pageHideAttached) safe(() => W.removeEventListener("pagehide", onPageHide));
      safe(() => meta.destroy()); // views destroyed, vars force-flushed
      safe(() => nav.dispose()); // cancels our leg / executor, unsubscribes
      safe(() => expr.clearDelayed());
      safe(() => monsterExpr.clearDelayed());
      safe(() => planner.dispose());
      safe(() => support.dispose());
      safe(() => quests.dispose());
      safe(() => signals.dispose());
      flushAll();
      safe(() => options.bindCells(null)); // the session outlives this bot
      // Hand every loop hook back to the literal path.
      if (combat) {
        if (combat.vt === planner) combat.vt = null;
        if (combat.acquireRangeFn === acquireFn) combat.acquireRangeFn = null;
        safe(() => combat.invalidateScan?.());
      }
      if (bot.loot && lootBinding.classify && bot.loot.classify === lootBinding.classify) bot.loot.classify = null;
      if (ib.wrote && bot.buff && typeof bot.buff.setItemBuffs === "function") safe(() => bot.buff.setItemBuffs([]));
      clearSkillCap();
      safe(() => removeAux());
      if (bot.unwedge && bot.unwedge.allowEscalation === allowEscalation) bot.unwedge.allowEscalation = null;
    };
    Object.defineProperty(layer, "disposed", { get: () => disposed, enumerable: true });
    layer.auxSlotOrder = VT_RANK_ORDER;
    return layer;
  }
}

export default createVtLayer;
