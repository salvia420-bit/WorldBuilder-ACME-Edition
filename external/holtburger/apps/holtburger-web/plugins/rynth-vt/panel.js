// plugins/rynth-vt/panel.js — the VTank panel (PLAN W1-10, §3.16, D20).
//
// One retail-styled window (ui/hud_kit.js titlebar + kit classes,
// ui/ac_window_position.js drag/lock, window id 0xFFFF0141) with the nine
// VTank tabs in two rows:
//   Options · Profiles · Vitals · Monsters · Items
//   Consumables · Buffs · Route · Meta
// (Advanced is a sub-view of Options, as in VTank.) Everything goes through
// the pure bridge (rynth/vt/bridge/vt_bridge.js); this file owns layout,
// lifecycle and cadence only.
//
// Cadence: ≤ 2 Hz, only while the window is open AND the page is visible;
// only the active tab's view-model is computed; lists rebuild only when their
// data changed and never under a focused control (widgets.js). Escape closes
// (inside a field it only leaves the field). Per-viewer UI prefs (open, tab,
// sub-view, opacity) live in localStorage `rynth.vt.ui.v1` — never in a
// settings profile; the position is kept by ac_window_position.js.
//
// Loaded lazily: `window.__rynthVt.openPanel(tab)` (INT-2 rs_entry) imports
// this module on demand; nothing statically imports it (I-27). Opening also
// attaches the meta-view renderer (meta_views.js) to the live ViewManager.

import { makeTitlebar } from "../../ui/hud_kit.js";
import { attachWindowPosition } from "../../ui/ac_window_position.js";
import { createVtBridge, normalizeTab } from "../../rynth/vt/bridge/vt_bridge.js";
import { ensureVtStyles, removeVtStyles, VT_ROOT_ID } from "./styles.js";
import { el, btn, setText, setTitle } from "./widgets.js";
import { createViewRenderer } from "./meta_views.js";
import { createOptionsTab } from "./tab_options.js";
import { createProfilesTab } from "./tab_profiles.js";
import { createVitalsTab } from "./tab_vitals.js";
import { createMonstersTab } from "./tab_monsters.js";
import { createItemsTab } from "./tab_items.js";
import { createConsumablesTab } from "./tab_consumables.js";
import { createBuffsTab } from "./tab_buffs.js";
import { createRouteTab } from "./tab_route.js";
import { createMetaTab } from "./tab_meta.js";

export const VT_PANEL_WINDOW_ID = 0xFFFF0141;
export const VT_UI_KEY = "rynth.vt.ui.v1";
export const VT_REFRESH_MS = 500; // ≤ 2 Hz
const MSG_MS = 4500;

export const VT_TAB_ROWS = Object.freeze([
  Object.freeze([
    { id: "options", label: "Options" },
    { id: "profiles", label: "Profiles" },
    { id: "vitals", label: "Vitals" },
    { id: "monsters", label: "Monsters" },
    { id: "items", label: "Items" },
  ]),
  Object.freeze([
    { id: "consumables", label: "Consumables" },
    { id: "buffs", label: "Buffs" },
    { id: "route", label: "Route" },
    { id: "meta", label: "Meta" },
  ]),
]);

const FACTORIES = Object.freeze({
  options: createOptionsTab,
  profiles: createProfilesTab,
  vitals: createVitalsTab,
  monsters: createMonstersTab,
  items: createItemsTab,
  consumables: createConsumablesTab,
  buffs: createBuffsTab,
  route: createRouteTab,
  meta: createMetaTab,
});

// ── module state (one panel per page) ──────────────────────────────────────
const S = {
  cfg: {},
  bridge: null,
  ui: {},
  root: null,
  refs: null,
  tabs: {},
  active: null,
  timer: 0,
  msgTimer: 0,
  onKey: null,
  viewRenderer: null, // the meta-view renderer this panel attached
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

  const tabBtns = {};
  for (const rowDef of VT_TAB_ROWS) {
    const strip = el(doc, "div", "hbk-tabs rvt-tabs");
    strip.setAttribute("role", "tablist");
    for (const t of rowDef) {
      const b = btn(doc, t.label, null, "hbk-tab");
      b.dataset.tab = t.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", "false");
      b.addEventListener("click", () => setTab(t.id));
      tabBtns[t.id] = b;
      strip.appendChild(b);
    }
    root.appendChild(strip);
  }

  const banner = el(doc, "div", "rvt-banner");
  banner.hidden = true;
  root.appendChild(banner);
  const content = el(doc, "div", "rvt-content hbk-scroll");
  root.appendChild(content);
  const msg = el(doc, "div", "rvt-msg");
  root.appendChild(msg);
  const status = el(doc, "div", "rvt-status");
  root.appendChild(status);

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
  S.refs = { root, bar, lockBtn, tabBtns, banner, content, msg, status };
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

// ── tabs ───────────────────────────────────────────────────────────────────
function tabCtx() {
  const { doc } = env();
  return {
    doc,
    bridge: getBridge(),
    report,
    refresh: (opts) => refreshVtPanel(opts),
    setSub: (sub) => setSub(sub),
    setStatus: (text) => setText(S.refs?.status, text),
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
  const id = n === "advanced" ? "options" : n && FACTORIES[n] ? n : "options";
  const t = ensureTab(id);
  for (const [k, b] of Object.entries(S.refs.tabBtns)) {
    const on = k === id;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const [k, tt] of Object.entries(S.tabs)) tt.el.hidden = k !== id;
  S.active = id;
  if (n === "advanced") t.setSub?.("advanced");
  S.ui.tab = id;
  S.ui.sub = id === "options" && t.sub === "advanced" ? "advanced" : null;
  saveUi();
  if (refresh) refreshVtPanel({ force: true });
}

function setSub(sub) {
  const t = S.tabs.options;
  if (!t) return;
  t.setSub(sub === "advanced" ? "advanced" : null);
  S.ui.sub = sub === "advanced" ? "advanced" : null;
  saveUi();
  refreshVtPanel({ force: true });
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
  S.msgTimer = E.setTimeout(() => setText(m, ""), MSG_MS);
}

// ── refresh ────────────────────────────────────────────────────────────────
/**
 * One refresh pass of the ACTIVE tab (additive export; the timer and every
 * command call it). → true when it ran (open window), false otherwise.
 */
export function refreshVtPanel({ force = false } = {}) {
  if (!S.root || S.root.dataset.open !== "1" || !S.active) return false;
  const t = S.tabs[S.active];
  if (!t) return false;
  try {
    const bridge = getBridge();
    const snap = bridge.snapshot(t.snapshotId());
    const banner = S.refs.banner;
    banner.hidden = !snap.banner;
    setText(banner, snap.banner || "");
    if (S.active !== "route") setText(S.refs.status, snap.statusLine || (snap.present ? "" : snap.settings ? "Bot not started — settings edit the current profile." : "Not logged in."));
    t.update(snap, { force });
    attachViewRenderer();
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
  try {
    if (!S.root) {
      S.ui = loadUi();
      buildWindow();
      const wanted = tab ?? (S.ui.sub === "advanced" && (!S.ui.tab || S.ui.tab === "options") ? "advanced" : S.ui.tab);
      S.root.dataset.open = "1";
      setTab(wanted || "options", { refresh: false });
    } else {
      S.root.dataset.open = "1";
      if (tab != null) setTab(tab, { refresh: false });
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
}

export function toggleVtPanel(tab) {
  if (S.root && S.root.dataset.open === "1") {
    const want = tab == null ? null : normalizeTab(tab);
    const same = want == null || (want === "advanced" ? S.active === "options" : want === S.active);
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
  try {
    if (S.viewRenderer && S.bridge && typeof S.bridge.releaseViewRenderer === "function") S.bridge.releaseViewRenderer(S.viewRenderer);
  } catch { /* ignore */ }
  try {
    if (S.root && S.onKey) S.root.removeEventListener("keydown", S.onKey);
  } catch { /* ignore */ }
  try { S.root?.remove(); } catch { /* ignore */ }
  removeVtStyles(env().doc);
  Object.assign(S, { bridge: S.cfg?.bridge ?? null, root: null, refs: null, tabs: {}, active: null, timer: 0, msgTimer: 0, onKey: null, viewRenderer: null });
}

export default { openVtPanel, closeVtPanel, toggleVtPanel, isVtPanelOpen, disposeVtPanel };
