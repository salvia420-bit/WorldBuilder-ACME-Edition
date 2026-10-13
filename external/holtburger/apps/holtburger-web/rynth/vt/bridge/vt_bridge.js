// rynth/vt/bridge/vt_bridge.js — the ONE adapter between the VTank panel
// (plugins/rynth-vt/) and the VT layer (bot.vt, PLAN §3.15) — W1-10, §3.16.
//
//   snapshot(tab)   a pure view-model for ONE tab; reads `bot.vt` exactly once
//                   per call, never throws, no wasm walks except through the
//                   layer's services (host reads the loops already make).
//   run / opt / profiles / monsters / items / consumables / buffs / loot /
//   navProfiles / route / meta
//                   the commands the panel's controls drive. Every command
//                   returns a Promise of { ok, error?, … } and never rejects.
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
// rynth/buff_loop.js (exports only: buildDynamicBuffList / loadSpellLadders).

import {
  safe, ok, fail, command, asResult, isFn,
  createOptionsCommands, optionsTabView, advancedTabView, vitalsTabView, profilesTabView, profileSummary, runState,
} from "./bridge_options.js";
import { createListsBridge } from "./bridge_lists.js";
import { createRouteMetaBridge } from "./bridge_route_meta.js";

export const VT_TABS = Object.freeze(["options", "profiles", "vitals", "monsters", "items", "consumables", "buffs", "route", "meta"]);
const TAB_ALIASES = Object.freeze({
  option: "options", opt: "options", opts: "options", main: "options", advanced: "advanced", adv: "advanced",
  profile: "profiles", settings: "profiles", vital: "vitals", monster: "monsters", mobs: "monsters",
  item: "items", consumable: "consumables", supplies: "consumables", buff: "buffs", nav: "route", navigation: "route",
  routes: "route", metas: "meta",
});

/** Normalise a tab name ("Route", "nav", "advanced" …) → a VT tab id (+ "advanced"), or null. */
export function normalizeTab(tab) {
  const t = String(tab ?? "").trim().toLowerCase();
  if (!t) return null;
  if (VT_TABS.includes(t) || t === "advanced") return t;
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

  // ── snapshot ─────────────────────────────────────────────────────────────
  function snapshot(tab) {
    const id = normalizeTab(tab) || "options";
    try {
      const b = bot();
      const vt = layerOf(b);
      const options = optionsOf(vt);
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
      };
      base.banner = base.profile && base.profile.readOnly ? "Default is read-only — Save As to keep changes" : null;
      let view;
      switch (id) {
        case "options":
          view = optionsTabView(options, b);
          break;
        case "advanced":
          view = advancedTabView(options, advancedFilter);
          break;
        case "vitals":
          view = vitalsTabView(options);
          break;
        case "profiles":
          view = {
            ...profilesTabView(options),
            navProfiles: rm.views.navProfiles(vt),
            loot: lists.views.loot(vt),
          };
          break;
        case "monsters":
          view = lists.views.monsters(vt, b);
          break;
        case "items":
          view = lists.views.items(vt);
          break;
        case "consumables":
          view = lists.views.consumables(vt, b);
          break;
        case "buffs":
          view = lists.views.buffs(vt, b);
          break;
        case "route":
          view = rm.views.route(vt, b);
          break;
        case "meta":
          view = rm.views.meta(vt);
          break;
        default:
          view = {};
      }
      return { ...base, view };
    } catch (e) {
      return { tab: id, at: clock(), present: false, layer: false, settings: false, run: runState(null), profile: null, statusLine: "", banner: null, view: {}, error: String(e && e.message ? e.message : e) };
    }
  }

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

  return {
    snapshot,
    run,
    opt: {
      ...optCmds.opt,
      /** Additive: the Advanced sub-view's filter (kept between snapshots). */
      setFilter: command((f) => {
        advancedFilter = String(f ?? "");
        return ok({ filter: advancedFilter });
      }),
    },
    profiles: optCmds.profiles,
    monsters: lists.monsters,
    items: lists.items,
    consumables: lists.consumables,
    buffs: lists.buffs,
    loot: lists.loot,
    navProfiles: rm.navProfiles,
    route: rm.route,
    meta: rm.meta,
    /** Additive: attach a meta-view renderer to the live ViewManager when it has none. */
    ensureViewRenderer: (factory) => safe(() => rm.ensureViewRenderer(factory), false),
    /** Additive: detach that renderer again (only while it is still the attached one). */
    releaseViewRenderer: (renderer) => safe(() => rm.releaseViewRenderer(renderer), false),
  };
}

export default createVtBridge;
