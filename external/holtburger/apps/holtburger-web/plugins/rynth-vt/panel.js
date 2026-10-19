// plugins/rynth-vt/panel.js — the VTank panel (PLAN W1-10, §3.16, D20; v2
// layout 2026-10-19).
//
// One retail-styled window (ui/hud_kit.js titlebar + kit classes,
// ui/ac_window_position.js drag/lock, window id 0xFFFF0141):
//
//   titlebar  RynthSuite — VTank · Lock · − · + · ✕
//   bar       RUN · COMBAT BUFF NAV LOOT META · profile ▾ · ⋯   (bar.js)
//   tabs      Main · Monsters · Items · Buffs · Route · Loot · Meta · Advanced
//   content   the active tab
//   footer    the bot's status line · the last command's result
//
// v1 had nine tabs in two rows plus an Advanced sub-view, and the same
// controls in several places (navigation could be switched on from three
// tabs). v2 keeps each control in exactly one place: the switches and the
// profile live on the bar, Vitals joined Options as Main, Consumables joined
// Items, the Profiles tab's loot controls became the Loot tab, and Advanced
// lists only what no other tab shows (its filter searches everything).
// `/rs ui <tab>` still accepts the v1 names (vt_bridge.js normalizeTab).
//
// Everything goes through the pure bridge (rynth/vt/bridge/vt_bridge.js);
// this file owns layout, lifecycle and cadence only. Cadence: ≤ 2 Hz, only
// while the window is open AND the page is visible; only the active tab's
// view-model is computed; lists rebuild only when their data changed and
// never under a focused control (widgets.js). Escape closes (inside a field
// it only leaves the field). Per-viewer UI prefs (open, tab, opacity, show
// path) live in localStorage `rynth.vt.ui.v1` — never in a settings profile;
// the position is kept by ac_window_position.js.
//
// Loaded lazily: `window.__rynthVt.openPanel(tab)` (INT-2 rs_entry) imports
// this module on demand; nothing statically imports it (I-27). Opening also
// attaches the meta-view renderer (meta_views.js) to the live ViewManager.

import { makeTitlebar } from "../../ui/hud_kit.js";
import { attachWindowPosition } from "../../ui/ac_window_position.js";
import { createVtBridge, normalizeTab } from "../../rynth/vt/bridge/vt_bridge.js";
import { ensureVtStyles, removeVtStyles, VT_ROOT_ID } from "./styles.js";
import { el, btn, setText, setTitle } from "./widgets.js";
import { createCommandBar } from "./bar.js";
import { createViewRenderer } from "./meta_views.js";
import { createMainTab } from "./tab_main.js";
import { createMonstersTab } from "./tab_monsters.js";
import { createItemsTab } from "./tab_items.js";
import { createBuffsTab } from "./tab_buffs.js";
import { createRouteTab } from "./tab_route.js";
import { createLootTab } from "./tab_loot.js";
import { createMetaTab } from "./tab_meta.js";
import { createAdvancedTab } from "./tab_advanced.js";

export const VT_PANEL_WINDOW_ID = 0xFFFF0141;
export const VT_UI_KEY = "rynth.vt.ui.v1";
export const VT_REFRESH_MS = 500; // ≤ 2 Hz
const MSG_MS = 4500;
const ERROR_MSG_MS = 12000; // a refusal says how to fix it: give it time to be read
// The route drawn in the world (scene3d/route_overlay.js, lazy): shown while
// the Route tab is open, or always with the tab's "Show path" pinned.
const ROUTE_OVERLAY_URL = new URL("../../scene3d/route_overlay.js", import.meta.url).href;
// The profile's page-level display options (frame-rate limit, steep ground):
// the HUD installs the controller on mount; opening the panel installs it too
// (idempotent), so it also works on a ?rynthHud=off page.
const DISPLAY_URL = new URL("./display.js", import.meta.url).href;

export const VT_TABS_UI = Object.freeze([
  { id: "main", label: "Main", title: "Ranges, vitals and the Options switches (VTank Options + Vitals)" },
  { id: "monsters", label: "Monsters", title: "What to do with each monster: names or expressions, spells, priority, weapon" },
  { id: "items", label: "Items", title: "Combat items and consumables the macro may use" },
  { id: "buffs", label: "Buffs", title: "Self buffs to keep up, and the banes on your weapons and shields" },
  { id: "route", label: "Route", title: "Navigation route: waypoints, route type, saved routes" },
  { id: "loot", label: "Loot", title: "Loot profile (.utl) and its rules" },
  { id: "meta", label: "Meta", title: "Meta rules and states" },
  { id: "advanced", label: "Advanced", title: "Every other macro option; the filter searches all of them" },
].map((t) => Object.freeze(t)));
/** v1 export (two rows): the v2 tabs are one row. */
export const VT_TAB_ROWS = Object.freeze([VT_TABS_UI]);

const FACTORIES = Object.freeze({
  main: createMainTab,
  monsters: createMonstersTab,
  items: createItemsTab,
  buffs: createBuffsTab,
  route: createRouteTab,
  loot: createLootTab,
  meta: createMetaTab,
  advanced: createAdvancedTab,
});

// ── module state (one panel per page) ──────────────────────────────────────
const S = {
  cfg: {},
  bridge: null,
  ui: {},
  root: null,
  refs: null,
  bar: null,
  tabs: {},
  active: null,
  timer: 0,
  msgTimer: 0,
  onKey: null,
  viewRenderer: null, // the meta-view renderer this panel attached
  overlay: { handle: null, loading: null, failed: false, optSig: null }, // the in-world route
};

function env() {
  const g = globalThis;
  const c = S.cfg || {};
  const win = c.win || g.window || g;
  return {
    win,
    doc: c.doc || win.document || g.document,
    storage: c.storage !== undefined ? c.storage : (() => { try { return win.localStorage ?? null; } catch { return null; } })(),
    setInterval: c.setInterval || g.setInterval.bind(g),
    clearInterval: c.clearInterval || g.clearInterval.bind(g),
    setTimeout: c.setTimeout || g.setTimeout.bind(g),
    clearTimeout: c.clearTimeout || g.clearTimeout.bind(g),
    hidden: typeof c.hidden === "function" ? c.hidden : () => {
      try { return !!(c.doc || win.document || g.document)?.hidden; } catch { return false; }
    },
  };
}

/**
 * Additive (tests, INT-3): inject the bridge, the document/window, the
 * storage and the timers before the first open. Unset keys keep defaults.
 */
export function configureVtPanel(opts = {}) {
  S.cfg = { ...S.cfg, ...(opts && typeof opts === "object" ? opts : {}) };
  if (opts && opts.bridge) S.bridge = opts.bridge;
}

function getBridge() {
  if (!S.bridge) S.bridge = createVtBridge({ win: env().win });
  return S.bridge;
}

function loadUi() {
  try {
    const o = JSON.parse(env().storage?.getItem?.(VT_UI_KEY) || "null");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveUi() {
  try { env().storage?.setItem?.(VT_UI_KEY, JSON.stringify(S.ui)); } catch { /* blocked storage */ }
}

// ── window ─────────────────────────────────────────────────────────────────
function buildWindow() {
  const { doc } = env();
  ensureVtStyles(doc);
  const root = el(doc, "div", "hbk-window rvt");
  root.id = VT_ROOT_ID;
  root.dataset.open = "0";
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "RynthSuite VTank");
  applyOpacity(root);

  const { bar } = makeTitlebar("RynthSuite — VTank", { onClose: () => closeVtPanel() });
  const close = bar.querySelector(".hbk-close");
  const lockBtn = btn(doc, "Lock", "Lock the window in place", "rvt-hdr-btn");
  const fadeBtn = btn(doc, "−", "More transparent", "rvt-hdr-btn");
  const solidBtn = btn(doc, "+", "Less transparent", "rvt-hdr-btn");
  for (const b of [lockBtn, fadeBtn, solidBtn]) bar.insertBefore(b, close);
  fadeBtn.addEventListener("click", (e) => { e.stopPropagation?.(); stepOpacity(-0.1); });
  solidBtn.addEventListener("click", (e) => { e.stopPropagation?.(); stepOpacity(+0.1); });
  root.appendChild(bar);

  const cmd = createCommandBar(tabCtx());
  root.append(cmd.el, cmd.drawer);

  const tabBtns = {};
  const strip = el(doc, "div", "hbk-tabs rvt-tabs");
  strip.setAttribute("role", "tablist");
  for (const t of VT_TABS_UI) {
    const b = btn(doc, t.label, t.title, "hbk-tab");
    b.dataset.tab = t.id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", "false");
    b.addEventListener("click", () => setTab(t.id));
    tabBtns[t.id] = b;
    strip.appendChild(b);
  }
  root.appendChild(strip);

  const content = el(doc, "div", "rvt-content hbk-scroll");
  root.appendChild(content);
  const foot = el(doc, "div", "rvt-foot");
  const status = el(doc, "div", "rvt-status");
  const msg = el(doc, "div", "rvt-msg");
  foot.append(status, msg);
  root.appendChild(foot);

  doc.body.appendChild(root);

  try {
    attachWindowPosition(root, {
      windowId: VT_PANEL_WINDOW_ID,
      dragHandle: bar,
      lockButton: lockBtn,
      ignoreSelector: "button, input, select, textarea, .hbk-close",
      onLockChange: (locked) => {
        setText(lockBtn, locked ? "Unlk" : "Lock");
        setTitle(lockBtn, locked ? "Unlock the window" : "Lock the window in place");
      },
    });
  } catch (e) {
    try { console.warn("[rynth-vt] window position attach failed:", e); } catch { /* ignore */ }
  }

  S.onKey = (e) => {
    if (e.key !== "Escape") return;
    const tag = String(e.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      e.target.blur?.();
      return;
    }
    closeVtPanel();
  };
  root.addEventListener("keydown", S.onKey);

  S.root = root;
  S.bar = cmd;
  S.refs = { root, bar, lockBtn, tabBtns, content, msg, status };
  S.tabs = {};
  return root;
}

function applyOpacity(root = S.root) {
  const a = Number.isFinite(S.ui.opacity) ? Math.max(0.3, Math.min(1, S.ui.opacity)) : 0.95;
  root?.style?.setProperty?.("--rvt-alpha", String(a));
}
function stepOpacity(d) {
  const cur = Number.isFinite(S.ui.opacity) ? S.ui.opacity : 0.95;
  S.ui.opacity = Math.round(Math.max(0.3, Math.min(1, cur + d)) * 100) / 100;
  saveUi();
  applyOpacity();
}

// ── the route in the world ─────────────────────────────────────────────────
// scene3d/route_overlay.js draws the loaded VTank route (rings, path, the
// current waypoint, a line from your feet) the way VTank did in the retail
// client. It is loaded on first use and fed through the bridge (the route at
// the overlay's own 4 Hz while visible — so a pinned path keeps up with the
// panel closed — and its look from the profile: NavLineThickness /
// NavRingThickness, rings at the arrival radius). Hidden = no timer and
// nothing in the scene; a page without a 3D scene just never attaches.
function overlayWanted() {
  if (S.ui.routeShowPath) return true;
  return !!S.root && S.root.dataset.open === "1" && S.active === "route";
}

function updateRouteOverlay() {
  const ov = S.overlay;
  const want = overlayWanted();
  if (!ov.handle) {
    if (!want || ov.loading || ov.failed) return;
    const bridge = getBridge();
    ov.loading = import(ROUTE_OVERLAY_URL)
      .then((m) => {
        if (S.overlay !== ov) return; // the panel was disposed meanwhile
        ov.handle = m.installRouteOverlay({ source: () => bridge.routeOverlay(), opts: bridge.routeOverlayStyle?.() || {} });
      })
      .catch((e) => {
        ov.failed = true; // no scene3d on this page (or it failed): don't retry every refresh
        try { console.warn("[rynth-vt] route overlay unavailable:", e); } catch { /* ignore */ }
      })
      .finally(() => {
        ov.loading = null;
        if (ov.handle) updateRouteOverlay();
      });
    return;
  }
  const style = getBridge().routeOverlayStyle?.() || null;
  const sig = style ? JSON.stringify(style) : null;
  if (sig && sig !== ov.optSig) {
    ov.optSig = sig;
    try { ov.handle.setOptions(style); } catch { /* ignore */ }
  }
  try { ov.handle.setVisible(want); } catch { /* ignore */ }
}

/**
 * Additive (the HUD at page load): draw the route when the player pinned
 * "Show path" last session, without opening the panel. → true when pinned.
 */
export function ensureRouteOverlay() {
  if (!S.root && !S.ui.routeShowPath) S.ui = loadUi();
  updateRouteOverlay();
  return !!S.ui.routeShowPath;
}

// ── tabs ───────────────────────────────────────────────────────────────────
function tabCtx() {
  const { doc } = env();
  return {
    doc,
    bridge: getBridge(),
    report,
    refresh: (opts) => refreshVtPanel(opts),
    setStatus: (text) => setText(S.refs?.status, text),
    /** Per-viewer UI prefs (localStorage `rynth.vt.ui.v1`), e.g. the Route tab's "show path". */
    pref: (key, value) => {
      if (value === undefined) return S.ui[key];
      S.ui[key] = value;
      saveUi();
      return value;
    },
    isActive: (id) => S.active === id && !!S.root && S.root.dataset.open === "1",
    /** The in-world route: re-evaluate whether it should show (tab, pin). */
    overlay: { update: () => updateRouteOverlay() },
  };
}

function ensureTab(id) {
  if (S.tabs[id]) return S.tabs[id];
  const f = FACTORIES[id];
  if (!f) return null;
  const t = f(tabCtx());
  t.el.hidden = true;
  S.refs.content.appendChild(t.el);
  S.tabs[id] = t;
  return t;
}

function setTab(tab, { refresh = true } = {}) {
  if (!S.root) return;
  const n = normalizeTab(tab);
  const id = n && FACTORIES[n] ? n : "main";
  const prev = S.active;
  ensureTab(id);
  for (const [k, b] of Object.entries(S.refs.tabBtns)) {
    const on = k === id;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const [k, tt] of Object.entries(S.tabs)) tt.el.hidden = k !== id;
  S.active = id;
  if (prev && prev !== id) S.tabs[prev]?.onHide?.();
  S.tabs[id]?.onShow?.();
  S.ui.tab = id;
  delete S.ui.sub; // v1 key (the Advanced sub-view)
  saveUi();
  if (refresh) refreshVtPanel({ force: true });
}

// ── messages ───────────────────────────────────────────────────────────────
function report(r, okText = null) {
  if (!S.refs || !r) return;
  const m = S.refs.msg;
  const E = env();
  try { E.clearTimeout(S.msgTimer); } catch { /* ignore */ }
  let text = null;
  let kind = "ok";
  if (r.ok === false) {
    text = r.error || "refused";
    kind = "error";
  } else if (typeof okText === "function") text = okText(r);
  else if (typeof okText === "string") text = okText;
  if (!text && r.echo) text = r.echo;
  if (!text) {
    setText(m, "");
    return;
  }
  m.dataset.kind = kind;
  setText(m, text);
  setTitle(m, text);
  S.msgTimer = E.setTimeout(() => setText(m, ""), kind === "error" ? ERROR_MSG_MS : MSG_MS);
}

// ── refresh ────────────────────────────────────────────────────────────────
/**
 * One refresh pass of the command bar and the ACTIVE tab (additive export;
 * the timer and every command call it). → true when it ran (open window).
 */
export function refreshVtPanel({ force = false } = {}) {
  if (!S.root || S.root.dataset.open !== "1" || !S.active) return false;
  const t = S.tabs[S.active];
  if (!t) return false;
  try {
    const bridge = getBridge();
    const snap = bridge.snapshot(t.snapshotId ? t.snapshotId() : S.active);
    S.bar?.update(snap);
    if (!t.ownsStatus) setText(S.refs.status, snap.statusLine || (snap.present ? "" : snap.settings ? "Bot not started — settings edit the current profile." : "Not logged in."));
    t.update(snap, { force });
    attachViewRenderer();
    updateRouteOverlay(); // a profile switch / thickness edit reaches a pinned path too
  } catch (e) {
    try { console.warn("[rynth-vt] refresh failed:", e); } catch { /* ignore */ }
  }
  return true;
}

function attachViewRenderer() {
  const bridge = getBridge();
  if (typeof bridge.ensureViewRenderer !== "function") return;
  const { doc } = env();
  bridge.ensureViewRenderer(() => {
    const r = createViewRenderer({ doc, onClick: (v, c) => { bridge.meta?.clickView?.(v, c); } });
    S.viewRenderer = r; // detached again by disposeVtPanel
    return r;
  });
}

function startTimer() {
  stopTimer();
  const E = env();
  S.timer = E.setInterval(() => {
    if (!S.root || S.root.dataset.open !== "1") return;
    if (E.hidden()) return;
    refreshVtPanel();
  }, VT_REFRESH_MS);
}
function stopTimer() {
  if (S.timer) {
    try { env().clearInterval(S.timer); } catch { /* ignore */ }
  }
  S.timer = 0;
}

// ── public API (§3.16) ─────────────────────────────────────────────────────
export function openVtPanel({ tab } = {}) {
  import(DISPLAY_URL).then((m) => m.installVtDisplay?.(env().win)).catch(() => {});
  try {
    if (!S.root) {
      S.ui = loadUi();
      buildWindow();
      const wanted = tab ?? (S.ui.sub === "advanced" ? "advanced" : S.ui.tab);
      S.root.dataset.open = "1";
      setTab(wanted || "main", { refresh: false });
    } else {
      S.root.dataset.open = "1";
      if (tab != null) setTab(tab, { refresh: false });
      else S.tabs[S.active]?.onShow?.();
    }
    S.ui.open = true;
    saveUi();
    refreshVtPanel({ force: true });
    startTimer();
  } catch (e) {
    try { console.warn("[rynth-vt] open failed:", e); } catch { /* ignore */ }
  }
  return Promise.resolve();
}

export function closeVtPanel() {
  if (!S.root) return;
  S.root.dataset.open = "0";
  S.ui.open = false;
  saveUi();
  stopTimer();
  S.tabs[S.active]?.onHide?.();
}

export function toggleVtPanel(tab) {
  if (S.root && S.root.dataset.open === "1") {
    const want = tab == null ? null : normalizeTab(tab);
    const same = want == null || want === S.active;
    if (same) {
      closeVtPanel();
      return Promise.resolve();
    }
  }
  return openVtPanel({ tab });
}

export function isVtPanelOpen() {
  return !!(S.root && S.root.dataset.open === "1");
}

/** Remove the window, the stylesheet, the timers, the listeners and the
 *  meta-view renderer this panel attached (its windows need the stylesheet). */
export function disposeVtPanel() {
  stopTimer();
  try { env().clearTimeout(S.msgTimer); } catch { /* ignore */ }
  for (const t of Object.values(S.tabs)) {
    try { t.dispose?.(); } catch { /* ignore */ }
  }
  try { S.overlay.handle?.dispose?.(); } catch { /* ignore */ }
  S.overlay = { handle: null, loading: null, failed: false, optSig: null };
  try {
    if (S.viewRenderer && S.bridge && typeof S.bridge.releaseViewRenderer === "function") S.bridge.releaseViewRenderer(S.viewRenderer);
  } catch { /* ignore */ }
  try {
    if (S.root && S.onKey) S.root.removeEventListener("keydown", S.onKey);
  } catch { /* ignore */ }
  try { S.root?.remove(); } catch { /* ignore */ }
  removeVtStyles(env().doc);
  Object.assign(S, { bridge: S.cfg?.bridge ?? null, root: null, refs: null, bar: null, tabs: {}, active: null, timer: 0, msgTimer: 0, onKey: null, viewRenderer: null });
}

export default { openVtPanel, closeVtPanel, toggleVtPanel, isVtPanelOpen, disposeVtPanel };
