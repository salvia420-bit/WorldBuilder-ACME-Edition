// rynth/vt/bridge/vt_bridge.js — the ONE adapter between the VTank panel
// (plugins/rynth-vt/) and the VT layer (bot.vt, PLAN §3.15) — W1-10, §3.16.
//
//   snapshot(tab)   a pure view-model for ONE tab plus the command bar
//                   (`header`: Run Macro, the five subsystem switches, the
//                   profile select); reads `bot.vt` exactly once per call,
//                   never throws, no wasm walks except through the layer's
//                   services (host reads the loops already make).
//   run / switches / opt / profiles / monsters / items / consumables /
//   buffs / loot / navProfiles / route / meta
//                   the commands the panel's controls drive. Every command
//                   returns a Promise of { ok, error?, … } and never rejects.
//
// Tabs (v2, 2026-10-19): main · monsters · items · buffs · route · loot ·
// meta · advanced. The v1 names still resolve (`/rs ui vitals` → main,
// `consumables` → items, `profiles` → main, `options` → main).
//
// Settings and profiles work without a bot (the page session's VtOptions,
// `win.__rynthVt.session()`), so a player can prepare a profile before START.
// Run Macro / Force Buff delegate to the RynthSuite HUD bridge when it is
// mounted (it owns START = boot-or-resume), else to bot.control (the one
// operator stop authority, V-6) — this bridge never starts/stops the kernel.
//
// Module discipline (C1/C2): no `document`, no static `window`; the page
// globals come through the injected `win`. Imports: own package files,
// rynth/nav_file.js (recall names) and — lazily, through `importer` —
// rynth/buff_loop.js (exports only: buildDynamicBuffList / loadSpellLadders /
// readSkillTraining, and — when present — buffFamilyInfo / toLadderSpec).

import {
  safe, ok, fail, command, asResult, isFn,
  createOptionsCommands, headerView, mainTabView, advancedTabView, rowsFor, readVitals, profileSummary, runState,
  forceRebuffState, SUBSYSTEM_KEYS, BUFFS_TAB_KEYS, LOOT_TAB_KEYS,
} from "./bridge_options.js";
import { createListsBridge } from "./bridge_lists.js";
import { createRouteMetaBridge } from "./bridge_route_meta.js";

export const VT_TABS = Object.freeze(["main", "monsters", "items", "buffs", "route", "loot", "meta", "advanced"]);
const TAB_ALIASES = Object.freeze({
  option: "main", options: "main", opt: "main", opts: "main", vital: "main", vitals: "main",
  profile: "main", profiles: "main", settings: "main", adv: "advanced",
  monster: "monsters", mobs: "monsters", item: "items", consumable: "items", consumables: "items", supplies: "items",
  buff: "buffs", nav: "route", navigation: "route", routes: "route", looting: "loot", utl: "loot", metas: "meta",
});

/** Normalise a tab name ("Route", "nav", "vitals" …) → a VT tab id, or null. */
export function normalizeTab(tab) {
  const t = String(tab ?? "").trim().toLowerCase();
  if (!t) return null;
  if (VT_TABS.includes(t)) return t;
  return TAB_ALIASES[t] ?? null;
}

const BUFF_LOOP_URL = new URL("../../buff_loop.js", import.meta.url).href;

/**
 * @param {{ win?: object, getBot?: () => object|null, getSession?: () => object|null,
 *           hud?: () => object|null, importer?: (url: string) => Promise<object>, now?: () => number }} env
 */
export function createVtBridge({
  win = globalThis,
  getBot = () => safe(() => win.__bot ?? null),
  getSession = () => safe(() => win.__rynthVt?.session?.() ?? null),
  hud = () => safe(() => win.__rynthHud?.bridge ?? null),
  importer = (u) => import(u),
  now = Date.now,
} = {}) {
  const clock = () => {
    const t = safe(() => now(), null);
    return typeof t === "number" && Number.isFinite(t) ? t : Date.now();
  };
  const bot = () => safe(() => getBot(), null) || null;
  const hudBridge = () => safe(() => hud(), null) || null;
  /** THE single bot.vt read (callers pass the result around). */
  const layerOf = (b) => (b ? safe(() => b.vt ?? null) : null) || null;
  const sessionOf = (vt) => (vt ? safe(() => vt.session ?? null) : null) || safe(() => getSession(), null) || null;
  const optionsOf = (vt) => (vt ? safe(() => vt.options ?? null) : null) || safe(() => sessionOf(vt)?.options ?? null) || null;
  const hostOf = (b) => (b ? safe(() => b.host ?? null) : null) || null;

  const ctx = {
    win,
    now: clock,
    importer: (u) => Promise.resolve().then(() => importer(u)),
    buffLoopUrl: BUFF_LOOP_URL,
    getBot: bot,
    layerOf,
    optionsOf,
    hostOf,
    hud: hudBridge,
  };

  const optCmds = createOptionsCommands({ getOptions: () => optionsOf(layerOf(bot())) });
  const lists = createListsBridge(ctx);
  const rm = createRouteMetaBridge(ctx);
  let advancedFilter = "";
  const profileCache = { at: -Infinity, options: null, list: [] };

  // ── snapshot ─────────────────────────────────────────────────────────────
  function snapshot(tab) {
    const id = normalizeTab(tab) || "main";
    try {
      const b = bot();
      const vt = layerOf(b);
      const options = optionsOf(vt);
      const navStatus = rm.navStatus(vt); // one ActiveNav.status() read: the bar's NAV switch and the Route tab
      const base = {
        tab: id,
        at: clock(),
        present: !!b,
        layer: !!vt,
        settings: !!options,
        run: runState(b),
        profile: profileSummary(options),
        statusLine: vt && isFn(vt.statusLine) ? String(safe(() => vt.statusLine(), "") ?? "") : "",
        hud: !!hudBridge(),
        header: headerView(options, { now: clock(), cache: profileCache, navStatus }),
      };
      base.banner = base.profile && base.profile.readOnly ? "Default is read-only — Save As to keep changes" : null;
      let view;
      switch (id) {
        case "main":
          view = mainTabView(options, readVitals(safe(() => win.__sessionHandle ?? null)));
          break;
        case "monsters":
          view = lists.views.monsters(vt, b);
          break;
        case "items":
          view = lists.views.items(vt, b);
          break;
        case "buffs":
          view = { ...lists.views.buffs(vt, b), rows: rowsFor(options, BUFFS_TAB_KEYS), forceRebuff: forceRebuffState(b) };
          break;
        case "route":
          view = rm.views.route(vt, b, navStatus);
          break;
        case "loot":
          view = { ...lists.views.loot(vt), rows: rowsFor(options, LOOT_TAB_KEYS) };
          break;
        case "meta":
          view = rm.views.meta(vt);
          break;
        case "advanced":
          view = advancedTabView(options, advancedFilter);
          break;
        default:
          view = {};
      }
      return { ...base, view };
    } catch (e) {
      return { tab: id, at: clock(), present: false, layer: false, settings: false, run: runState(null), profile: null, statusLine: "", banner: null, header: null, view: {}, error: String(e && e.message ? e.message : e) };
    }
  }

  // ── the command bar's subsystem switches ─────────────────────────────────
  // NAV and META go through their live services when the layer has them (a
  // paused route resumes; the meta engine re-decides at once), else straight
  // to the option — so they work before START, on the active profile.
  const switches = {
    set: command((id, on) => {
      const key = SUBSYSTEM_KEYS[id];
      if (!key) return fail(`unknown switch ${id}`);
      const v = !!on;
      const vt = layerOf(bot());
      if (id === "nav" && vt && safe(() => vt.nav ?? null)) return rm.route.enable(v);
      if (id === "meta" && vt && safe(() => vt.meta ?? null)) return rm.meta.setEnabled(v);
      return optCmds.opt.set(key, v);
    }),
  };
  // Profile commands change the list the bar shows: drop the cached copy.
  const profiles = Object.fromEntries(
    Object.entries(optCmds.profiles).map(([k, fn]) => [k, (...a) => fn(...a).finally(() => { profileCache.at = -Infinity; })]),
  );

  // ── Run Macro / Force Buff (G:7-11) ──────────────────────────────────────
  const viaHud = (name, ...args) => {
    const h = hudBridge();
    if (h && isFn(h[name])) return Promise.resolve(h[name](...args)).then((r) => asResult(r), (e) => fail(e));
    return null;
  };
  const control = (b) => {
    const c = b ? safe(() => b.control ?? null) : null;
    return c && isFn(c.stop) && isFn(c.resume) ? c : null;
  };
  const noBot = () => fail("open the RynthSuite HUD or use ?bot=1 to start the bot");

  const run = {
    start: command(() => {
      const h = viaHud("start");
      if (h) return h;
      const b = bot();
      if (!b) return noBot();
      const c = control(b);
      if (!c) return fail("this bot has no operator control");
      return asResult(c.resume(), { resumed: true });
    }),
    stop: command(() => {
      const h = viaHud("stop");
      if (h) return h;
      const b = bot();
      if (!b) return fail("the bot is not running");
      const c = control(b);
      if (!c) return fail("this bot has no operator control");
      return asResult(c.stop({ persist: true, reason: "VT panel" }));
    }),
    toggle: command(() => {
      const h = viaHud("toggleRun");
      if (h) return h;
      const b = bot();
      if (!b) return noBot();
      const c = control(b);
      if (!c) return fail("this bot has no operator control");
      const held = !!safe(() => (isFn(c.isStopped) ? c.isStopped() : b.kernel?.operatorHeld === true), false);
      return held ? asResult(c.resume(), { resumed: true }) : asResult(c.stop({ persist: true, reason: "VT panel" }));
    }),
    forceBuff: command(() => {
      const h = viaHud("forceRebuff");
      if (h) return h;
      const buff = safe(() => bot()?.buff ?? null);
      if (!buff || !isFn(buff.forceRebuff)) return fail("force buff is not available on this bot");
      buff.forceRebuff();
      return ok();
    }),
    cancelForceBuff: command(() => {
      const h = viaHud("cancelForceRebuff");
      if (h) return h;
      const buff = safe(() => bot()?.buff ?? null);
      if (!buff || !isFn(buff.cancelForceRebuff)) return fail("cancel force buff is not available on this bot");
      buff.cancelForceRebuff();
      return ok();
    }),
  };

  // A subsystem switch edited anywhere (the Advanced search lists them too)
  // goes the command bar's way: NAV resumes a paused route, META re-decides.
  const SWITCH_BY_NAME = new Map(Object.entries(SUBSYSTEM_KEYS).map(([id, key]) => [key.toLowerCase(), id]));
  SWITCH_BY_NAME.set("enablenav", "nav"); // the VTank name of EnableNavigation

  return {
    snapshot,
    run,
    switches,
    opt: {
      ...optCmds.opt,
      set: command((name, value) => {
        const id = SWITCH_BY_NAME.get(String(name ?? "").trim().toLowerCase());
        return id && typeof value === "boolean" ? switches.set(id, value) : optCmds.opt.set(name, value);
      }),
      /** Additive: the Advanced tab's filter (kept between snapshots). */
      setFilter: command((f) => {
        advancedFilter = String(f ?? "");
        return ok({ filter: advancedFilter });
      }),
    },
    profiles,
    monsters: lists.monsters,
    items: lists.items,
    consumables: lists.consumables,
    buffs: lists.buffs,
    loot: lists.loot,
    navProfiles: rm.navProfiles,
    route: rm.route,
    meta: rm.meta,
    /** Additive: plain route data for the in-world path overlay (sync, never throws; null = no route). */
    routeOverlay: () => safe(() => rm.overlayData(layerOf(bot())), null),
    /** Additive: the overlay's look from the active profile — VTank's NavLineThickness /
     *  NavRingThickness, and rings drawn at the waypoint arrival radius (max(1.5, Follow/Nav Min), D16). */
    routeOverlayStyle: () => safe(() => {
      const o = optionsOf(layerOf(bot()));
      const v = (k, d) => {
        const x = Number(safe(() => o?.getValue?.(k), d));
        return Number.isFinite(x) ? x : d;
      };
      return { navLineThickness: v("NavLineThickness", 6), navRingThickness: v("NavRingThickness", 6), ringRadiusM: Math.max(1.5, v("FollowNavMin", 3)) };
    }, null),
    /** Additive: attach a meta-view renderer to the live ViewManager when it has none. */
    ensureViewRenderer: (factory) => safe(() => rm.ensureViewRenderer(factory), false),
    /** Additive: detach that renderer again (only while it is still the attached one). */
    releaseViewRenderer: (renderer) => safe(() => rm.releaseViewRenderer(renderer), false),
  };
}

export default createVtBridge;
