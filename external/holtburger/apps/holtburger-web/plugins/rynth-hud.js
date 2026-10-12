// RynthSuite HUD — the bot's dashboard inside our GUI (2026-10-12).
//
// A web port of the original RynthAi ImGui dashboard
// (RynthCore.Plugin.RynthAi/LegacyUi/LegacyDashboardRenderer.cs:
// RenderDashHeader / RenderCombatPanel / RenderLauncherGrid) in the HUD kit's
// retail look:
//
//   header   RUNNING/STOPPED macro button + status dot, "State" (RynthAi's
//            Meta State) and "Activity" (Bot Activity); Profile / Route /
//            Loot selectors where RynthAi had Profile / Nav / Loot / Meta.
//   panel    Combat · Buff · Nav · Loot toggles + a wide AI toggle (RynthAi's
//            MACRO) + FR force-rebuff; target name + segmented health bar;
//            player HP / ST / MN.
//   launcher Monsters · Settings · Navigation · AI · Log sections (RynthAi's
//            Monsters / Settings / Navigation windows; AI hosts the director
//            panel, rynth/ai/ui.js).
//
// Launcher: a small ⚒ button on the toolbar floaty (owner decision
// 2026-10-12), mounted into plugins/hotbar.js's `.hb-hotbar-addons` column —
// outside the retail 310-px frame, so it moves with the toolbar and leaves
// gmToolbarUI's DAT rects alone. Green dot = bot running, red = stopped.
// Also reachable from the plugin bar's ⚒ slot (app/plugin_bar.js) and the
// manifest hotkey (Shift+F12).
//
// Every control drives the bot through rynth/hud_bridge.js (the one adapter
// that knows the bot API); a control the bot can't back is disabled with the
// reason in its tooltip. Cheap by construction: the window refreshes at 4 Hz
// only while open and the page is visible; the launcher dot polls at 1 Hz.
// Escape: ?rynthHud=off (exact match) mounts nothing.

import { makeTitlebar } from "../ui/hud_kit.js";
import { attachWindowPosition } from "../ui/ac_window_position.js";
import { listManifestBindings } from "../ui/keymap.js";
import { createHudBridge, VITALS_FIELDS } from "../rynth/hud_bridge.js";

const ROOT_ID = "hb-rynth-hud";
const STYLE_ID = "hb-rynth-hud-style";
const LAUNCHER_ID = "hb-rynth-hud-launcher";
const FLOAT_ID = "hb-rynth-hud-launcher-float";
// Synthetic window id — 0xFFFF01xx block (spell research is 0xFFFF0132).
export const RYNTH_HUD_WINDOW_ID = 0xFFFF0140;
const LS_UI = "rynth.hud.ui.v1";
const PLUGIN_ID = "rynth-hud";
const HOTKEY_FALLBACK = "Shift+F12";
const REFRESH_MS = 250; // 4 Hz while open
const LAUNCHER_MS = 1000;
const MSG_MS = 4500;
const SECTIONS = Object.freeze([
  { id: "monsters", label: "Monsters" },
  { id: "settings", label: "Settings" },
  { id: "nav", label: "Navigation" },
  { id: "ai", label: "AI" },
  { id: "log", label: "Log" },
]);
const SP = "./data/ui-sprites";

/** ?rynthHud=off (exact match) disables the whole plugin. */
export function rynthHudDisabled(search) {
  try {
    return new URLSearchParams(search ?? "").get("rynthHud") === "off";
  } catch {
    return false;
  }
}

// ── small helpers ──────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function btn(cls, text, title) {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}
function setText(e, v) {
  const s = v == null ? "" : String(v);
  if (e && e.textContent !== s) e.textContent = s;
}
function setTitle(e, v) {
  const s = v == null ? "" : String(v);
  if (e && e.title !== s) e.title = s;
}
function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function clock(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function loadUi() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_UI) || "null");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveUi(ui) {
  try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch { /* blocked storage */ }
}
function hotkeyLabel() {
  let list = null;
  try { list = listManifestBindings(); } catch { list = null; }
  if (!Array.isArray(list) || list.length === 0) return HOTKEY_FALLBACK;
  const hit = list.find((b) => b && b.pluginId === PLUGIN_ID && b.hotkeyId === "toggle");
  return hit ? String(hit.keyString || "") : "";
}

// ── styles ─────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
  #${ROOT_ID} { right: 12px; top: 96px; width: 340px; z-index: 60; background: transparent; isolation: isolate; }
  #${ROOT_ID}[data-open="0"] { display: none; }
  #${ROOT_ID}::before {
    content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    opacity: var(--rhud-alpha, 0.95);
  }
  #${ROOT_ID} .hbk-titlebar { gap: 3px; }
  #${ROOT_ID} .hbk-titlebar > .hbk-title { flex: 1 1 auto; min-width: 0; text-align: center; }
  #${ROOT_ID} .rhud-hdr-btn {
    min-width: 18px; height: 16px; padding: 0 4px; margin: 0 1px;
    border: 1px solid var(--hbk-gold-deep, #4e3f1f); background: rgba(0, 0, 0, 0.55);
    color: var(--hbk-gold, #d9b45a); font: 11px/14px var(--hbk-font); cursor: pointer;
  }
  #${ROOT_ID} .rhud-hdr-btn:hover { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold-dim, #8a7544); }
  #${ROOT_ID} .rhud-body { padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 6px; }
  #${ROOT_ID}[data-min="1"] .rhud-body { display: none; }
  #${ROOT_ID} .rhud-mini { display: none; align-items: center; gap: 8px; padding: 4px 8px 6px; }
  #${ROOT_ID}[data-min="1"] .rhud-mini { display: flex; }
  #${ROOT_ID} .rhud-mini .rhud-run { width: 74px; height: 20px; font-size: 11px; }
  #${ROOT_ID} .rhud-head { display: grid; grid-template-columns: 136px 1fr; gap: 3px 8px; align-items: start; }
  #${ROOT_ID} .rhud-runwrap { display: flex; align-items: center; gap: 8px; }
  #${ROOT_ID} .rhud-run {
    width: 112px; height: 28px; padding: 0; border: 1px solid #000; border-radius: 4px;
    font: bold 13px/26px var(--hbk-font); letter-spacing: 1px; color: #f4ecd8; cursor: pointer;
    background: linear-gradient(180deg, #5c2a22 0%, #2c120e 100%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 1px 2px #000;
  }
  #${ROOT_ID} .rhud-run:hover { filter: brightness(1.2); }
  #${ROOT_ID} .rhud-run[data-state="running"] { background: linear-gradient(180deg, #2f6b3a 0%, #133a1c 100%); }
  #${ROOT_ID} .rhud-run[data-state="start"] { background: linear-gradient(180deg, #4e4520 0%, #241f0c 100%); }
  #${ROOT_ID} .rhud-run[data-state="booting"] { background: linear-gradient(180deg, #6b5a2f 0%, #3a2e16 100%); }
  #${ROOT_ID} .rhud-run:disabled { filter: grayscale(0.7) brightness(0.6); cursor: default; }
  #${ROOT_ID} .rhud-dot { width: 9px; height: 9px; border-radius: 50%; background: #555; box-shadow: 0 0 0 1px #000; flex: 0 0 9px; }
  #${ROOT_ID} .rhud-dot[data-state="running"] { background: #6fe36f; box-shadow: 0 0 0 1px #000, 0 0 6px #6fe36f; }
  #${ROOT_ID} .rhud-dot[data-state="stopped"] { background: #c85040; }
  #${ROOT_ID} .rhud-dot[data-state="booting"] { background: #e0b040; }
  #${ROOT_ID} .rhud-kv { font-size: 11px; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${ROOT_ID} .rhud-kv > span:first-child { color: var(--hbk-text-dim, #a8a090); margin-right: 5px; }
  #${ROOT_ID} .rhud-kv > span:last-child { color: #f0b84a; }
  #${ROOT_ID} .rhud-selectors { display: grid; grid-template-columns: 44px 1fr auto; gap: 3px 4px; align-items: center; font-size: 11px; }
  #${ROOT_ID} .rhud-selectors > label { color: var(--hbk-text-dim, #a8a090); }
  #${ROOT_ID} .rhud-selectors select, #${ROOT_ID} .rhud-selectors input { width: 100%; min-height: 18px; font-size: 11px; padding: 1px 4px; }
  #${ROOT_ID} .rhud-selectors .rhud-span2 { grid-column: span 2; }
  #${ROOT_ID} .rhud-panel {
    display: grid; grid-template-columns: 76px 1fr; gap: 8px; padding: 6px;
    border: 1px solid var(--hbk-gold-deep, #4e3f1f); background: rgba(0, 0, 0, 0.35);
  }
  #${ROOT_ID} .rhud-toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; align-content: start; }
  #${ROOT_ID} .rhud-tgl {
    height: 22px; padding: 0 2px; font: 11px/20px var(--hbk-font); cursor: pointer;
    border: 1px solid #000; border-radius: 3px; color: var(--hbk-text-dim, #a8a090);
    background: linear-gradient(180deg, #2a241a 0%, #120f09 100%);
  }
  #${ROOT_ID} .rhud-tgl.is-on { color: #10140c; background: linear-gradient(180deg, #e7c66a 0%, #9a7a2e 100%); }
  #${ROOT_ID} .rhud-tgl.is-deferred { outline: 1px dashed var(--hbk-gold, #d9b45a); outline-offset: -3px; }
  #${ROOT_ID} .rhud-tgl:disabled { filter: grayscale(0.8) brightness(0.55); cursor: default; }
  #${ROOT_ID} .rhud-tgl-wide { grid-column: span 2; }
  #${ROOT_ID} .rhud-fr { grid-column: span 2; height: 16px; font-size: 10px; line-height: 14px; }
  #${ROOT_ID} .rhud-fr.is-on { color: #10140c; background: linear-gradient(180deg, #e0a050 0%, #8a5a20 100%); }
  #${ROOT_ID} .rhud-target { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--hbk-text-dim, #a8a090); text-transform: uppercase; }
  #${ROOT_ID} .rhud-target > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${ROOT_ID} .rhud-target > span:last-child { color: #fff; }
  #${ROOT_ID} .rhud-seg { display: grid; grid-template-columns: repeat(10, 1fr); gap: 2px; height: 8px; margin: 2px 0 6px; }
  #${ROOT_ID} .rhud-seg > i { display: block; background: #1c0c09; box-shadow: inset 0 0 0 1px #000; }
  #${ROOT_ID} .rhud-seg > i.on { background: linear-gradient(180deg, #e0503c, #7a1810); }
  #${ROOT_ID} .rhud-seg.is-empty > i { background: #111; }
  #${ROOT_ID} .rhud-caption { font-size: 10px; letter-spacing: 1px; color: var(--hbk-text-faint, #77705f); margin-bottom: 2px; }
  #${ROOT_ID} .rhud-vital { display: grid; grid-template-columns: 20px 1fr; gap: 4px; align-items: center; margin-bottom: 3px; font-size: 10px; color: var(--hbk-text-dim, #a8a090); }
  #${ROOT_ID} .rhud-vital .hbk-meter { height: 11px; }
  #${ROOT_ID} .rhud-stats { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--hbk-text-dim, #a8a090); }
  #${ROOT_ID} .rhud-stats b { font-weight: normal; color: var(--hbk-value, #8aef6d); }
  #${ROOT_ID} .rhud-hold { font-size: 11px; color: #ffb060; }
  #${ROOT_ID} .rhud-hold[hidden] { display: none; }
  #${ROOT_ID} .rhud-msg { min-height: 14px; font-size: 11px; color: var(--hbk-gold-bright, #f3d27a); }
  #${ROOT_ID} .rhud-msg[data-kind="error"] { color: var(--hbk-warn, #ff6a50); }
  #${ROOT_ID} .rhud-launch { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; }
  #${ROOT_ID} .rhud-launch .hbk-btn-brass { min-width: 0; width: 100%; padding: 0 2px; font-size: 11px; }
  #${ROOT_ID} .rhud-section { border-top: 1px solid var(--hbk-gold-deep, #4e3f1f); padding-top: 6px; max-height: 270px; overflow-y: auto; font-size: 11px; }
  #${ROOT_ID} .rhud-section[hidden] { display: none; }
  #${ROOT_ID} .rhud-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
  #${ROOT_ID} .rhud-row > .rhud-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #${ROOT_ID} .rhud-row input.hbk-input { min-height: 18px; font-size: 11px; padding: 1px 4px; }
  #${ROOT_ID} .rhud-num { width: 52px; }
  #${ROOT_ID} .rhud-grid2 { display: grid; grid-template-columns: 1fr 56px; gap: 3px 6px; align-items: center; }
  #${ROOT_ID} .rhud-note { color: var(--hbk-text-faint, #77705f); font-style: italic; margin: 2px 0 4px; }
  #${ROOT_ID} .rhud-loglist { font-family: var(--hb-font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 10px; line-height: 14px; white-space: pre-wrap; word-break: break-word; }
  #${ROOT_ID} .rhud-ai-host > div { position: static !important; width: auto !important; right: auto !important; bottom: auto !important; z-index: auto !important; background: transparent !important; border: 0 !important; padding: 0 !important; }

  /* Toolbar launcher (inside #hb-hotbar .hb-hotbar-addons). */
  .rhud-launcher {
    position: relative; width: 30px; height: 30px; padding: 0;
    border: 1px solid var(--hbk-gold-dim, #8a7544);
    background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
    color: var(--hbk-gold, #d9b45a); font: 17px/28px var(--hbk-font, serif); cursor: pointer;
    box-shadow: 0 0 0 1px #000, 0 4px 10px rgba(0, 0, 0, 0.6);
  }
  .rhud-launcher:hover, .rhud-launcher:focus-visible { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold, #d9b45a); outline: none; }
  .rhud-launcher.is-open { box-shadow: 0 0 0 1px #000, 0 0 7px rgba(243, 210, 122, 0.65); }
  .rhud-launcher-dot { position: absolute; right: 2px; bottom: 2px; width: 7px; height: 7px; border-radius: 50%; background: #555; box-shadow: 0 0 0 1px #000; pointer-events: none; }
  .rhud-launcher[data-state="running"] .rhud-launcher-dot { background: #6fe36f; box-shadow: 0 0 0 1px #000, 0 0 5px #6fe36f; }
  .rhud-launcher[data-state="stopped"] .rhud-launcher-dot { background: #c85040; }
  .rhud-launcher[data-state="booting"] .rhud-launcher-dot { background: #e0b040; }
  #${FLOAT_ID} { position: fixed; right: 12px; bottom: 120px; z-index: 55; }
  `;
  document.head.appendChild(st);
}

// ── module state (one HUD per page) ────────────────────────────────────
const S = {
  bridge: null,
  ui: {},
  root: null,
  refs: null,
  timer: 0,
  launcher: null,
  launcherTimer: 0,
  msgTimer: 0,
  lastVm: null,
  lastVmAt: 0, // when lastVm was taken (the launcher reuses a fresh one)
  aiPanel: null, // { destroy, director }
  aiMounting: false,
  aiFailedAt: 0, // last failed AI-panel mount (backoff — no 4 Hz retry storm)
  urlPersona: null, // ?botPersona, the profile default when the HUD has none saved
  routesAt: 0,
  buffsLoaded: false,
  onHotbarMounted: null,
  onVisibility: null,
};

// ── the window ─────────────────────────────────────────────────────────
function buildWindow() {
  const root = el("div", "hbk-window rhud");
  root.id = ROOT_ID;
  root.dataset.open = "0";
  root.dataset.min = S.ui.minimized ? "1" : "0";
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "RynthSuite");
  applyOpacity(root);

  const { bar, title } = makeTitlebar("RynthSuite", { onClose: () => closeHud() });
  const close = bar.querySelector(".hbk-close");
  const lockBtn = btn("rhud-hdr-btn", "Lock", "Lock the window in place");
  const fadeBtn = btn("rhud-hdr-btn", "−", "More transparent");
  const solidBtn = btn("rhud-hdr-btn", "+", "Less transparent");
  const minBtn = btn("rhud-hdr-btn", S.ui.minimized ? "▴" : "_", "Minimize");
  for (const b of [lockBtn, fadeBtn, solidBtn, minBtn]) bar.insertBefore(b, close);
  fadeBtn.addEventListener("click", (e) => { e.stopPropagation(); stepOpacity(-0.1); });
  solidBtn.addEventListener("click", (e) => { e.stopPropagation(); stepOpacity(+0.1); });
  minBtn.addEventListener("click", (e) => { e.stopPropagation(); setMinimized(!S.ui.minimized); });
  root.appendChild(bar);

  // Minimized row: ON/OFF + state.
  const mini = el("div", "rhud-mini");
  const miniRun = btn("rhud-run", "OFF");
  const miniState = el("span", "rhud-kv");
  mini.append(miniRun, miniState);
  root.appendChild(mini);

  const body = el("div", "rhud-body");
  root.appendChild(body);

  // Header: macro button + state lines | selectors.
  const head = el("div", "rhud-head");
  const left = el("div");
  const runWrap = el("div", "rhud-runwrap");
  const run = btn("rhud-run", "START");
  const dot = el("span", "rhud-dot");
  runWrap.append(run, dot);
  const stateKv = el("div", "rhud-kv");
  stateKv.append(el("span", null, "State"), el("span"));
  const actKv = el("div", "rhud-kv");
  actKv.append(el("span", null, "Activity"), el("span"));
  left.append(runWrap, stateKv, actKv);

  const sel = el("div", "rhud-selectors");
  const profLbl = el("label", null, "Profile");
  const profile = el("select", "hbk-select rhud-span2");
  for (const [v, t] of [["grind", "Grind"], ["explorer", "Explorer"]]) {
    const o = el("option", null, t);
    o.value = v;
    profile.appendChild(o);
  }
  profile.title = "Grind: hunt + loot. Explorer: combat and looting off (the explorer AI prompt needs a restart with an AI key).";
  const routeLbl = el("label", null, "Route");
  const route = el("select", "hbk-select");
  route.title = "Saved atlas routes (record or import them first)";
  const routeGo = btn("rhud-hdr-btn", "▶", "Follow the selected route");
  const lootLbl = el("label", null, "Loot ≥");
  const lootMin = el("input", "hbk-input rhud-span2");
  lootMin.type = "number";
  lootMin.min = "0";
  lootMin.step = "1";
  lootMin.placeholder = "0";
  lootMin.title = "Minimum item value (pyreals) the loot loop picks up. 0 = everything.";
  sel.append(profLbl, profile, routeLbl, route, routeGo, lootLbl, lootMin);
  head.append(left, sel);
  body.appendChild(head);

  // Combat panel: toggles | target + vitals.
  const panel = el("div", "rhud-panel");
  const tg = el("div", "rhud-toggles");
  const tgl = {};
  for (const [key, label] of [["combat", "Combat"], ["buff", "Buff"], ["nav", "Nav"], ["loot", "Loot"]]) {
    tgl[key] = btn("rhud-tgl", label);
    tg.appendChild(tgl[key]);
  }
  tgl.ai = btn("rhud-tgl rhud-tgl-wide", "AI");
  tg.appendChild(tgl.ai);
  const fr = btn("rhud-tgl rhud-fr", "FR", "Force-recast all buffs (right-click: cancel)");
  tg.appendChild(fr);
  const vit = el("div");
  const tline = el("div", "rhud-target");
  const tName = el("span", null, "No target");
  const tPct = el("span", null, "");
  tline.append(tName, tPct);
  const seg = el("div", "rhud-seg is-empty");
  const segs = [];
  for (let i = 0; i < 10; i++) { const s = el("i"); seg.appendChild(s); segs.push(s); }
  const cap = el("div", "rhud-caption", "PLAYER VITALS");
  vit.append(tline, seg, cap);
  const meters = {};
  for (const [key, label, color] of [
    ["hp", "HP", "linear-gradient(180deg, #d84030, #6a1010)"],
    ["st", "ST", "linear-gradient(180deg, #e0c040, #6a5a10)"],
    ["mn", "MN", "linear-gradient(180deg, #4070e0, #102a6a)"],
  ]) {
    const row = el("div", "rhud-vital");
    const m = el("div", "hbk-meter");
    m.style.setProperty("--hbk-meter-color", color);
    const fill = el("div", "hbk-meter-fill");
    const lab = el("div", "hbk-meter-label", "—");
    m.append(fill, lab);
    row.append(el("span", null, label), m);
    vit.appendChild(row);
    meters[key] = { m, lab };
  }
  panel.append(tg, vit);
  body.appendChild(panel);

  const stats = el("div", "rhud-stats");
  const statEls = {};
  for (const [k, label] of [["kills", "Kills"], ["kph", "/hr"], ["looted", "Looted"], ["buffs", "Buffs"], ["up", "Up"]]) {
    const s = el("span");
    const b = el("b", null, "—");
    if (k === "kph") s.append(b, document.createTextNode(` ${label}`));
    else s.append(document.createTextNode(`${label} `), b);
    stats.appendChild(s);
    statEls[k] = b;
  }
  body.appendChild(stats);

  // Held casts (buff_loop / vitals status.blocked) — "Buffs held: …".
  const hold = el("div", "rhud-hold");
  hold.hidden = true;
  body.appendChild(hold);

  const msg = el("div", "rhud-msg");
  body.appendChild(msg);

  const launch = el("div", "rhud-launch");
  const tabBtns = {};
  const sections = {};
  for (const s of SECTIONS) {
    const b = btn("hbk-btn-brass", s.label);
    b.addEventListener("click", () => toggleSection(s.id));
    tabBtns[s.id] = b;
    launch.appendChild(b);
  }
  body.appendChild(launch);
  for (const s of SECTIONS) {
    const sec = el("div", "rhud-section hbk-scroll");
    sec.dataset.section = s.id;
    sec.hidden = true;
    sections[s.id] = sec;
    body.appendChild(sec);
  }

  document.body.appendChild(root);

  // Drag by the titlebar; lock + position persisted (zoom-aware).
  try {
    attachWindowPosition(root, {
      windowId: RYNTH_HUD_WINDOW_ID,
      dragHandle: bar,
      lockButton: lockBtn,
      ignoreSelector: "button, input, select, .hbk-close",
      onLockChange: (locked) => {
        setText(lockBtn, locked ? "Unlk" : "Lock");
        setTitle(lockBtn, locked ? "Unlock the window" : "Lock the window in place");
      },
    });
  } catch (e) {
    console.warn("[rynth-hud] window position attach failed:", e);
  }

  // ── wiring ─────────────────────────────────────────────────────────
  const onRun = async (b) => {
    b.disabled = true;
    try { report(await S.bridge.toggleRun()); } finally { b.disabled = false; refresh(); }
  };
  run.addEventListener("click", () => onRun(run));
  miniRun.addEventListener("click", () => onRun(miniRun));
  for (const key of ["combat", "buff", "loot", "ai"]) {
    tgl[key].addEventListener("click", async () => {
      const on = S.lastVm?.toggles?.[key]?.on;
      report(await S.bridge.setSubsystem(key, !on), key === "ai" ? (r) => (r.deferred ? "AI will start when the bot resumes" : null) : null);
      refresh();
    });
  }
  tgl.nav.addEventListener("click", async () => {
    const on = S.lastVm?.toggles?.nav?.on;
    report(await S.bridge.setSubsystem("nav", !on));
    refresh();
  });
  fr.addEventListener("click", () => { report(S.bridge.forceRebuff()); refresh(); });
  fr.addEventListener("contextmenu", (e) => { e.preventDefault(); report(S.bridge.cancelForceRebuff()); refresh(); });
  profile.addEventListener("change", async () => {
    const r = await S.bridge.setPersona(profile.value);
    report(r, () => (profile.value === "explorer" ? "Explorer: combat and looting off" : "Grind: combat and looting on"));
    refresh();
  });
  route.addEventListener("change", () => { S.bridge.selectRoute(route.value || null); });
  routeGo.addEventListener("click", async () => { report(await S.bridge.followRoute(route.value || null), () => "Following route"); refresh(); });
  lootMin.addEventListener("change", () => {
    const r = S.bridge.setLootMin(lootMin.value === "" ? 0 : lootMin.value);
    report(r, (x) => (x.live ? "Loot floor set" : "Loot floor saved for the next start"));
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const tag = (e.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") { e.target.blur?.(); return; }
    closeHud();
  });

  S.root = root;
  S.refs = { root, bar, title, lockBtn, minBtn, miniRun, miniState, run, dot, stateV: stateKv.lastChild, actV: actKv.lastChild,
    profile, route, routeGo, lootMin, tgl, fr, tName, tPct, seg, segs, meters, statEls, hold, msg, tabBtns, sections };
  if (S.ui.section && sections[S.ui.section]) openSection(S.ui.section);
  return root;
}

function applyOpacity(root = S.root) {
  const a = Number.isFinite(S.ui.opacity) ? Math.max(0.3, Math.min(1, S.ui.opacity)) : 0.95;
  root?.style?.setProperty?.("--rhud-alpha", String(a));
}
function stepOpacity(d) {
  const cur = Number.isFinite(S.ui.opacity) ? S.ui.opacity : 0.95;
  S.ui.opacity = Math.round(Math.max(0.3, Math.min(1, cur + d)) * 100) / 100;
  saveUi(S.ui);
  applyOpacity();
}
function setMinimized(min) {
  S.ui.minimized = !!min;
  saveUi(S.ui);
  if (!S.root) return;
  S.root.dataset.min = S.ui.minimized ? "1" : "0";
  setText(S.refs.minBtn, S.ui.minimized ? "▴" : "_");
  setTitle(S.refs.minBtn, S.ui.minimized ? "Restore" : "Minimize");
}

function report(r, okText = null) {
  if (!S.refs) return;
  const m = S.refs.msg;
  clearTimeout(S.msgTimer);
  if (!r) return;
  let text = null;
  let kind = "ok";
  if (r.ok === false) { text = r.error || "refused"; kind = "error"; }
  else if (typeof okText === "function") text = okText(r);
  else if (typeof okText === "string") text = okText;
  if (!text) { setText(m, ""); return; }
  m.dataset.kind = kind;
  setText(m, text);
  S.msgTimer = setTimeout(() => setText(m, ""), MSG_MS);
}

// ── sections ───────────────────────────────────────────────────────────
function toggleSection(id) {
  if (S.ui.section === id) closeSection();
  else openSection(id);
}
function closeSection() {
  if (!S.refs) return;
  for (const s of SECTIONS) {
    S.refs.sections[s.id].hidden = true;
    S.refs.tabBtns[s.id].classList.remove("is-active");
  }
  if (S.ui.section === "ai") destroyAiPanel();
  S.ui.section = null;
  saveUi(S.ui);
}
function openSection(id) {
  if (!S.refs) return;
  if (S.ui.section === "ai" && id !== "ai") destroyAiPanel();
  for (const s of SECTIONS) {
    const on = s.id === id;
    S.refs.sections[s.id].hidden = !on;
    S.refs.tabBtns[s.id].classList.toggle("is-active", on);
  }
  S.ui.section = id;
  saveUi(S.ui);
  const sec = S.refs.sections[id];
  if (id === "monsters") buildMonsters(sec);
  else if (id === "settings") buildSettings(sec);
  else if (id === "nav") buildNav(sec);
  else if (id === "ai") buildAi(sec);
  else if (id === "log") buildLog(sec);
  refresh();
}

// Monsters — RynthAi's Monsters window: name-substring → priority.
function buildMonsters(sec) {
  sec.textContent = "";
  sec.appendChild(el("div", "hbk-section-title", "Monster priorities"));
  sec.appendChild(el("div", "rhud-note", "Name contains → priority 0–20 (higher is attacked first). Applies to the running bot at once."));
  const list = el("div", "rhud-mon-list");
  sec.appendChild(list);
  const add = el("div", "rhud-row");
  const name = el("input", "hbk-input rhud-grow");
  name.placeholder = "monster name";
  const prio = el("input", "hbk-input rhud-num");
  prio.type = "number";
  prio.min = "0";
  prio.max = "20";
  prio.value = "5";
  const addBtn = btn("hbk-btn-small", "Add");
  add.append(name, prio, addBtn);
  sec.appendChild(add);
  const fromTarget = btn("hbk-btn-small", "Add current target");
  sec.appendChild(fromTarget);
  const doAdd = (n) => {
    const r = S.bridge.setPriority(n, prio.value);
    report(r, (x) => (x.live ? `Priority set for "${String(n).toLowerCase()}"` : "Saved for the next start"));
    if (r.ok) { name.value = ""; renderMonsterList(true); }
  };
  addBtn.addEventListener("click", () => doAdd(name.value));
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(name.value); });
  fromTarget.addEventListener("click", () => {
    const t = S.lastVm?.target;
    if (!t || !t.name) { report({ ok: false, error: "no target" }); return; }
    doAdd(t.name);
  });
  sec._list = list;
  sec._sig = null;
  renderMonsterList(true);
}
function renderMonsterList(force = false) {
  const sec = S.refs?.sections?.monsters;
  if (!sec || sec.hidden || !sec._list) return;
  const vm = S.lastVm;
  const rows = vm && vm.present ? vm.priorities : Object.entries(S.bridge.getSettings().priorities || {});
  const sig = JSON.stringify(rows);
  if (!force && sig === sec._sig) return;
  // Never rebuild under the player's cursor.
  if (!force && sec._list.contains(document.activeElement)) return;
  sec._sig = sig;
  const list = sec._list;
  list.textContent = "";
  if (!rows.length) { list.appendChild(el("div", "hbk-empty", "No rules — every monster scores by distance.")); return; }
  for (const [n, p] of rows) {
    const row = el("div", "rhud-row");
    row.appendChild(el("span", "rhud-grow", n));
    const inp = el("input", "hbk-input rhud-num");
    inp.type = "number";
    inp.min = "0";
    inp.max = "20";
    inp.value = String(p);
    inp.addEventListener("change", () => report(S.bridge.setPriority(n, inp.value)));
    const rm = btn("hbk-btn-small", "✕", `Remove "${n}"`);
    rm.addEventListener("click", () => { report(S.bridge.removePriority(n)); renderMonsterList(true); });
    row.append(inp, rm);
    list.appendChild(row);
  }
}

// Settings — vitals thresholds + the self-buff list + restart.
function buildSettings(sec) {
  sec.textContent = "";
  sec.appendChild(el("div", "hbk-section-title", "Vitals thresholds (%)"));
  const grid = el("div", "rhud-grid2");
  const inputs = {};
  const saved = S.bridge.getSettings().vitals || {};
  for (const f of VITALS_FIELDS) {
    grid.appendChild(el("span", null, f.label));
    const inp = el("input", "hbk-input");
    inp.type = "number";
    inp.min = "0";
    inp.max = "100";
    const live = S.lastVm?.vitalsCfg?.[f.key];
    inp.value = String(live ?? saved[f.key] ?? f.dflt);
    inp.addEventListener("change", () => {
      report(S.bridge.setVitalsThreshold(f.key, inp.value), (r) => (r.live ? `${f.label}: ${inp.value}%` : "Saved for the next start"));
    });
    grid.appendChild(inp);
    inputs[f.key] = inp;
  }
  sec.appendChild(grid);

  sec.appendChild(el("div", "hbk-divider"));
  sec.appendChild(el("div", "hbk-section-title", "Self-buffs to maintain"));
  const note = el("div", "rhud-note", "Your known self-buff spells. The bot keeps each one up (highest tier you know).");
  sec.appendChild(note);
  const list = el("div", "rhud-buff-list");
  list.appendChild(el("div", "hbk-empty", "Loading spells…"));
  sec.appendChild(list);
  const row = el("div", "rhud-row");
  const apply = btn("hbk-btn-small", "Apply buff list");
  const auto = btn("hbk-btn-small", "Auto", "Maintain every self-buff you know (the bot picks the best tier)");
  const restart = btn("hbk-btn-small", "Restart bot with these settings");
  row.append(apply, auto, restart);
  sec.appendChild(row);
  auto.addEventListener("click", async () => {
    auto.disabled = true;
    try {
      const r = await S.bridge.setBuffs("auto");
      report(r, (x) => (x.live ? "Maintaining all known self-buffs" : "Auto buffs saved — applies on the next start (or Restart)"));
      if (r && r.ok) for (const cb of list.querySelectorAll("input")) cb.checked = false;
    } finally { auto.disabled = false; refresh(); }
  });
  sec.appendChild(el("div", "hbk-divider"));
  const rec = el("div", "rhud-note", "");
  sec.appendChild(rec);
  sec._recovery = rec;
  apply.addEventListener("click", async () => {
    const ids = [];
    for (const cb of list.querySelectorAll("input")) if (cb.checked) ids.push(Number(cb.value));
    apply.disabled = true;
    try {
      const r = await S.bridge.setBuffs(ids);
      report(r, (x) => (x.live ? `Maintaining ${ids.length} buff(s)` : `Saved ${ids.length} buff(s) — applies on the next start (or Restart)`));
    } finally { apply.disabled = false; refresh(); }
  });
  restart.addEventListener("click", async () => {
    restart.disabled = true;
    try { report(await S.bridge.restart(), () => "Bot restarted with the HUD settings"); } finally { restart.disabled = false; refresh(); }
  });
  const savedBuffs = S.bridge.getSettings().buffs;
  const want = new Set(Array.isArray(savedBuffs) ? savedBuffs.map(Number) : []);
  if (savedBuffs === "auto") setText(note, "Buff list: AUTO — every self-buff you know (best tier). Tick spells + Apply for a fixed list.");
  S.bridge.knownSelfBuffs().then((spells) => {
    if (!list.isConnected && list.parentNode == null) return;
    list.textContent = "";
    if (!spells.length) {
      list.appendChild(el("div", "hbk-empty", "No known self-buff spells (or the spell catalog failed to load)."));
      return;
    }
    for (const s of spells) {
      const lab = el("label", "hbk-label rhud-row");
      const cb = el("input", "hbk-check");
      cb.type = "checkbox";
      cb.value = String(s.id);
      cb.checked = want.has(s.id);
      lab.append(cb, el("span", "rhud-grow", s.name));
      list.appendChild(lab);
    }
  }).catch(() => {
    list.textContent = "";
    list.appendChild(el("div", "hbk-empty", "Spell list unavailable."));
  });
  sec._inputs = inputs;
}

// Navigation — routes, goto, egress, stop.
function buildNav(sec) {
  sec.textContent = "";
  const status = el("div", "rhud-note", "");
  sec.appendChild(status);
  sec.appendChild(el("div", "hbk-section-title", "Saved routes"));
  const list = el("div", "rhud-route-list");
  sec.appendChild(list);
  const refreshBtn = btn("hbk-btn-small", "Refresh routes");
  refreshBtn.addEventListener("click", () => fillRoutes(true));
  sec.appendChild(refreshBtn);
  sec.appendChild(el("div", "hbk-divider"));
  sec.appendChild(el("div", "hbk-section-title", "Go to (/loc)"));
  const go = el("div", "rhud-row");
  const ns = el("input", "hbk-input rhud-num");
  ns.type = "number";
  ns.step = "0.1";
  ns.placeholder = "N/S";
  ns.title = "North positive, south negative (e.g. 42.1 or -33.5)";
  const ew = el("input", "hbk-input rhud-num");
  ew.type = "number";
  ew.step = "0.1";
  ew.placeholder = "E/W";
  ew.title = "East positive, west negative";
  const goBtn = btn("hbk-btn-small", "Go");
  go.append(el("span", null, "N/S"), ns, el("span", null, "E/W"), ew, goBtn);
  sec.appendChild(go);
  const row = el("div", "rhud-row");
  const egressBtn = btn("hbk-btn-small", "Exit building", "Walk out to the nearest outdoor exit");
  const stopBtn = btn("hbk-btn-small", "Stop moving", "Cancel any route / goto / egress (the bot keeps running)");
  row.append(egressBtn, stopBtn);
  sec.appendChild(row);
  goBtn.addEventListener("click", async () => report(await S.bridge.gotoLoc(ns.value, ew.value), () => "Routing…"));
  egressBtn.addEventListener("click", async () => report(await S.bridge.egress(), () => "Heading for the exit…"));
  stopBtn.addEventListener("click", async () => report(await S.bridge.cancelTravel(), () => "Stopped moving"));
  sec._status = status;
  sec._list = list;
  sec._goBtn = goBtn;
  fillRoutes(true);
}
async function fillRoutes(force = false) {
  const now = Date.now();
  if (!force && now - S.routesAt < 5000) return;
  S.routesAt = now;
  let routes = [];
  try { routes = await S.bridge.listRoutes(); } catch { routes = []; }
  if (!S.refs) return;
  // Header selector.
  const sel = S.refs.route;
  const want = S.bridge.getSettings().route || sel.value || "";
  const sig = JSON.stringify(routes.map((r) => [r.id, r.name]));
  if (sel._sig !== sig) {
    sel._sig = sig;
    sel.textContent = "";
    const none = el("option", null, routes.length ? "— pick a route —" : "(no saved routes)");
    none.value = "";
    sel.appendChild(none);
    for (const r of routes) {
      const o = el("option", null, `${r.name} (${r.legs})`);
      o.value = r.id;
      sel.appendChild(o);
    }
    sel.value = routes.some((r) => r.id === want) ? want : "";
  }
  // Navigation section list.
  const sec = S.refs.sections.nav;
  if (!sec || sec.hidden || !sec._list) return;
  const list = sec._list;
  list.textContent = "";
  if (!routes.length) {
    list.appendChild(el("div", "hbk-empty", "No saved routes. The bot records them as it travels; import a VTank .nav with rynthImportNav()."));
    return;
  }
  for (const r of routes) {
    const row = el("div", "rhud-row");
    row.appendChild(el("span", "rhud-grow", `${r.name} — ${r.legs} legs${r.portals ? `, ${r.portals} portal(s)` : ""}`));
    const f = btn("hbk-btn-small", "Follow");
    f.addEventListener("click", async () => {
      S.bridge.selectRoute(r.id);
      report(await S.bridge.followRoute(r.id), () => `Following ${r.name}`);
    });
    row.appendChild(f);
    list.appendChild(row);
  }
}

// AI — the director panel (rynth/ai/ui.js) hosted inside the section.
function buildAi(sec) {
  sec.textContent = "";
  const status = el("div", "rhud-note", "");
  sec.appendChild(status);
  const host = el("div", "rhud-ai-host");
  sec.appendChild(host);
  const restart = btn("hbk-btn-small", "Restart bot to activate the AI");
  restart.hidden = true;
  restart.addEventListener("click", async () => {
    restart.disabled = true;
    try { report(await S.bridge.restart(), () => "Bot restarted"); } finally { restart.disabled = false; }
  });
  sec.appendChild(restart);
  sec._status = status;
  sec._host = host;
  sec._restart = restart;
  mountAiPanel(sec);
}
function aiDirector() {
  try { return window.__bot?.ai?.director ?? null; } catch { return null; }
}
async function mountAiPanel(sec) {
  if (S.aiMounting) return;
  S.aiMounting = true;
  destroyAiPanel();
  const director = aiDirector();
  try {
    const u = (rel) => new URL(rel, location.href).href;
    const [ui, lc, pv] = await Promise.all([
      import(u("rynth/ai/ui.js")),
      import(u("rynth/ai/llm_client.js")),
      import(u("rynth/ai/providers.js")).catch(() => null),
    ]);
    if (!sec.isConnected || sec.hidden) return;
    const keyOps = {
      loadKey: () => lc.LlmClient.loadKey(),
      saveKey: (k) => lc.LlmClient.saveKey(k),
      clearKey: () => lc.LlmClient.clearKey(),
    };
    let models;
    try { models = pv ? pv.modelsFor(pv.DEFAULT_PROVIDER).map((m) => m.id) : undefined; } catch { models = undefined; }
    let control = null;
    try { control = window.__bot?.control ?? null; } catch { control = null; }
    sec._host.textContent = "";
    // ui.js embeds into `container` (flow layout) and routes its Enable
    // checkbox through the bot's OperatorControl (`control`).
    const p = ui.mountAiPanel(director, { client: keyOps, models, container: sec._host, control });
    if (p && p.el) {
      if (p.el.parentNode !== sec._host) sec._host.appendChild(p.el); // an older ui.js mounted on <body>
      S.aiPanel = { destroy: () => { try { p.destroy(); } catch { /* ignore */ } }, director };
    }
  } catch (e) {
    S.aiFailedAt = Date.now();
    setText(sec._status, `AI panel unavailable: ${e?.message ?? e}`);
  } finally {
    S.aiMounting = false;
  }
}
function destroyAiPanel() {
  if (S.aiPanel) { S.aiPanel.destroy(); S.aiPanel = null; }
}

// Log — what the bridge saw happen + the AI journal tail.
function buildLog(sec) {
  sec.textContent = "";
  const lines = el("div", "rhud-loglist");
  sec.appendChild(lines);
  sec.appendChild(el("div", "hbk-divider"));
  sec.appendChild(el("div", "hbk-section-title", "AI journal"));
  const journal = el("div", "rhud-loglist");
  sec.appendChild(journal);
  sec._lines = lines;
  sec._journal = journal;
  sec._sig = null;
}

// ── render ─────────────────────────────────────────────────────────────
function render(vm) {
  const R = S.refs;
  if (!R) return;
  // Macro button + dot.
  let runState;
  let runText;
  let runTip;
  if (vm.phase === "running") { runState = "running"; runText = "RUNNING"; runTip = "Click to stop the bot and take back control"; }
  else if (vm.phase === "stopped") { runState = "stopped"; runText = "STOPPED"; runTip = "Click to resume the bot"; }
  else if (vm.phase === "booting") { runState = "booting"; runText = "STARTING…"; runTip = "The bot is starting"; }
  else if (vm.phase === "not-started") { runState = "start"; runText = "START"; runTip = vm.ready ? "Start the bot on this character" : "Waiting for the world to load"; }
  else { runState = "offline"; runText = "OFFLINE"; runTip = "Log in first"; }
  for (const b of [R.run, R.miniRun]) {
    if (b.dataset.state !== runState) b.dataset.state = runState;
    setTitle(b, runTip);
    b.disabled = !(vm.phase === "running" || vm.phase === "stopped" || (vm.phase === "not-started" && vm.ready));
  }
  setText(R.run, runText);
  setText(R.miniRun, vm.phase === "running" ? "ON" : vm.phase === "booting" ? "…" : "OFF");
  if (R.dot.dataset.state !== runState) R.dot.dataset.state = runState;
  setText(R.stateV, vm.stateLine);
  setText(R.actV, vm.activityLine);
  setText(R.miniState, vm.stateLine);

  // Selectors (never fight a focused control).
  const settings = vm.settings || {};
  const persona = (settings.persona ?? S.urlPersona) === "explorer" ? "explorer" : "grind";
  if (document.activeElement !== R.profile && R.profile.value !== persona) R.profile.value = persona;
  if (document.activeElement !== R.lootMin) {
    const lv = vm.lootMin ?? settings.lootMin;
    const want = lv == null ? "" : String(lv);
    if (R.lootMin.value !== want) R.lootMin.value = want;
  }
  R.lootMin.disabled = vm.present && vm.lootMin == null;
  R.routeGo.disabled = !vm.present;
  fillRoutes(false);

  // Toggles.
  for (const key of ["combat", "buff", "nav", "loot", "ai"]) {
    const t = vm.toggles[key];
    const b = R.tgl[key];
    b.classList.toggle("is-on", !!t.on && vm.phase !== "stopped");
    b.classList.toggle("is-deferred", !!t.deferred);
    b.disabled = !vm.present || !t.available;
    const base = { combat: "Combat", buff: "Buffing", nav: "Navigation (follow the selected route)", loot: "Looting", ai: "AI director" }[key];
    setTitle(b, t.hint ? `${base} — ${t.hint}` : `${base}: ${t.on ? "on" : "off"} — click to turn ${t.on ? "off" : "on"}`);
  }
  R.fr.hidden = !vm.forceRebuff.available;
  R.fr.classList.toggle("is-on", !!vm.forceRebuff.active);
  R.fr.disabled = !vm.present;

  // Target.
  const t = vm.target;
  setText(R.tName, t ? (t.source === "selection" ? `${t.name} (selected)` : t.name) : "No target");
  setText(R.tPct, t && t.hp != null ? `${Math.round(t.hp * 100)}%` : "");
  const lit = t && t.hp != null ? Math.ceil(t.hp * 10 - 1e-9) : 0;
  R.seg.classList.toggle("is-empty", !(t && t.hp != null));
  R.segs.forEach((s, i) => s.classList.toggle("on", i < lit));

  // Vitals.
  for (const key of ["hp", "st", "mn"]) {
    const v = vm.vitals[key];
    const m = R.meters[key];
    const pct = v ? Math.max(0, Math.min(100, (v.cur / v.max) * 100)) : 0;
    m.m.style.setProperty("--hbk-fill", `${pct.toFixed(1)}%`);
    setText(m.lab, v ? `${Math.round(v.cur)}/${Math.round(v.max)}` : "—");
  }

  // Stats.
  const st = vm.stats;
  setText(R.statEls.kills, vm.present ? st.kills : "—");
  setText(R.statEls.kph, st.killsPerHour != null ? st.killsPerHour.toFixed(1) : "—");
  setText(R.statEls.looted, vm.present ? (st.lootRefused ? `${st.looted} (${st.lootRefused} refused)` : st.looted) : "—");
  setText(R.statEls.buffs, st.buffs ? `${st.buffs.active}/${st.buffs.desired}` : "—");
  setText(R.statEls.up, fmtDur(st.uptimeMs));
  const ch = vm.castHold || {};
  const holdParts = [];
  if (ch.combat) holdParts.push(`Combat held: ${ch.combat}`);
  if (ch.buffs) holdParts.push(`Buffs held: ${ch.buffs}`);
  if (ch.vitals) holdParts.push(`Healing held: ${ch.vitals}`);
  const lastRef = ch.buffRefusal && ch.buffRefusal.agoS != null && ch.buffRefusal.agoS < 300 ? ch.buffRefusal : null;
  if (!holdParts.length && lastRef && lastRef.cls && lastRef.cls !== "transient") {
    holdParts.push(`Last buff refused: ${lastRef.cls} (${fmtDur(lastRef.agoS * 1000)} ago)`);
  }
  setText(R.hold, holdParts.join(" · "));
  R.hold.hidden = holdParts.length === 0;

  // Open section live bits.
  const sec = S.ui.section ? R.sections[S.ui.section] : null;
  if (sec && !sec.hidden) {
    if (S.ui.section === "monsters") renderMonsterList(false);
    else if (S.ui.section === "settings" && sec._recovery) {
      const rs = vm.recoverySpells;
      const label = { healSelf: "heal", stamToHealth: "stam→health", stamToMana: "stam→mana", revitalize: "stamina" };
      const parts = rs ? Object.entries(rs).map(([k, id]) => `${label[k] ?? k}: ${S.bridge.spellName(id) || `spell ${id}`}`) : [];
      setText(sec._recovery, parts.length ? `Recovery spells — ${parts.join(" · ")}` : (vm.present ? "Recovery spells: none resolved yet." : ""));
    }
    else if (S.ui.section === "nav") {
      const parts = [];
      if (vm.mission) parts.push(`Travelling — ${vm.mission.kind}: ${vm.mission.label}${vm.mission.sinceMs != null ? ` (${fmtDur(vm.mission.sinceMs)})` : ""}`);
      else if (vm.routeState && vm.routeState !== "IDLE") parts.push(`Router: ${vm.routeState.toLowerCase()}`);
      if (vm.portalHold) parts.push("holding in portal space");
      if (vm.lastNav) parts.push(`Last: ${vm.lastNav.text}`);
      setText(sec._status, parts.join(" · ") || (vm.present ? "Not travelling." : "Start the bot to travel."));
      if (sec._goBtn) {
        sec._goBtn.disabled = !vm.present || !vm.gotoAvailable;
        setTitle(sec._goBtn, vm.gotoAvailable ? "Plan and walk there (RynthNav sidecar)" : "Needs the nav sidecar (page loaded with ?nav=off, or start the bot first)");
      }
    } else if (S.ui.section === "ai") {
      const a = vm.ai;
      let s;
      if (!vm.present) s = "Start the bot to use the AI director.";
      else if (!a.present) s = a.hasKey ? "Key saved — restart the bot to activate the director." : "No director: save an OpenRouter key below, then restart the bot.";
      else {
        s = `Director ${a.enabled ? "on" : "off"}${a.deferred ? " (starts on resume)" : ""}${a.busy ? " · thinking" : ""}` +
          `${a.nextInS != null && a.enabled ? ` · next check ${fmtDur(a.nextInS * 1000)}` : ""}` +
          `${a.calls != null ? ` · ${a.calls} call(s)` : ""}${a.errors ? ` · ${a.errors} error(s)` : ""}`;
      }
      setText(sec._status, s);
      if (sec._restart) sec._restart.hidden = !(vm.present && !a.present && a.hasKey);
      // Bot rebooted (new director) → remount the panel around it.
      const d = aiDirector();
      const mayRetry = Date.now() - S.aiFailedAt > 10_000;
      if (S.aiPanel && S.aiPanel.director !== d && !S.aiMounting && mayRetry) mountAiPanel(sec);
      if (!S.aiPanel && !S.aiMounting && d && mayRetry) mountAiPanel(sec);
    } else if (S.ui.section === "log") {
      const lines = (vm.log || []).map((l) => `${clock(l.t)}  ${l.text}`).join("\n") || "Nothing yet.";
      if (sec._lines.textContent !== lines) {
        const atBottom = sec.scrollTop + 300 >= (sec.scrollHeight || 0);
        sec._lines.textContent = lines;
        if (atBottom) sec.scrollTop = sec.scrollHeight || 0;
      }
      const j = (vm.journal || []).map((e) => `[${e.kind ?? "?"}] ${String(e.text ?? "").slice(0, 200)}`).join("\n") ||
        (vm.ai.present ? "No journal entries yet." : "No AI director on this bot.");
      setText(sec._journal, j);
    }
  }
}

function refresh() {
  if (!S.root || S.root.dataset.open !== "1" || !S.bridge) return;
  try {
    const vm = S.bridge.snapshot();
    S.lastVm = vm;
    S.lastVmAt = Date.now();
    render(vm);
  } catch (e) {
    console.warn("[rynth-hud] refresh failed:", e);
  }
}

function startTimer() {
  stopTimer();
  S.timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    refresh();
  }, REFRESH_MS);
}
function stopTimer() {
  if (S.timer) clearInterval(S.timer);
  S.timer = 0;
}

export function openHud() {
  if (!S.bridge) return false;
  if (!S.root) buildWindow();
  S.root.dataset.open = "1";
  S.ui.open = true;
  saveUi(S.ui);
  S.launcher?.classList.add("is-open");
  refresh();
  startTimer();
  return true;
}
export function closeHud() {
  if (!S.root) return false;
  S.root.dataset.open = "0";
  S.ui.open = false;
  saveUi(S.ui);
  S.launcher?.classList.remove("is-open");
  stopTimer();
  if (S.ui.section === "ai") destroyAiPanel();
  return true;
}
export function toggleHud() {
  return S.root && S.root.dataset.open === "1" ? (closeHud(), false) : openHud();
}

// ── toolbar launcher ───────────────────────────────────────────────────
function buildLauncher() {
  const b = btn("rhud-launcher", "⚒");
  b.id = LAUNCHER_ID;
  b.setAttribute("aria-label", "RynthSuite");
  b.dataset.tip = "";
  b.dataset.state = "off";
  b.appendChild(el("span", "rhud-launcher-dot"));
  b._hbTip = () => {
    const st = b.dataset.state;
    const sub = st === "running" ? "Bot running — click for the dashboard"
      : st === "stopped" ? "Bot stopped — click for the dashboard"
      : st === "booting" ? "Bot starting…"
      : "Bot dashboard — start, stop and configure the bot";
    return { text: "RynthSuite", key: hotkeyLabel(), sub };
  };
  b.addEventListener("click", (e) => { e.stopPropagation(); toggleHud(); });
  return b;
}
function attachLauncher() {
  const b = S.launcher;
  if (!b) return;
  let slot = null;
  try { slot = window.__hotbar?.addonSlot?.() ?? null; } catch { slot = null; }
  if (!slot) slot = document.querySelector?.("#hb-hotbar .hb-hotbar-addons") ?? null;
  if (slot) {
    document.getElementById(FLOAT_ID)?.remove();
    if (b.parentNode !== slot) slot.appendChild(b);
    b.removeAttribute("title"); // the toolbar's kit tooltip covers it
    return;
  }
  // No toolbar (plugins disabled / hotbar failed): keep the HUD reachable.
  let float = document.getElementById(FLOAT_ID);
  if (!float) {
    float = el("div");
    float.id = FLOAT_ID;
    document.body.appendChild(float);
  }
  if (b.parentNode !== float) float.appendChild(b);
  b.title = `RynthSuite — bot dashboard (${hotkeyLabel() || HOTKEY_FALLBACK})`;
}
function launcherTick() {
  const b = S.launcher;
  if (!b) return;
  if (!b.isConnected) attachLauncher();
  let state = "off";
  try {
    const bot = window.__bot;
    if (window.__botBooting) state = "booting";
    else if (bot) {
      // Cheap at 1 Hz: the open HUD's last snapshot when it is fresh, else the
      // kernel's operator hold (every stop path — the control, a boot-held
      // latch, !bot pause — sets it). Not OperatorControl.isStopped(): that
      // re-reads the persisted latch from localStorage on every call.
      const vm = S.lastVm;
      const fresh = !!(vm && vm.present && Date.now() - (S.lastVmAt || 0) < 3 * REFRESH_MS);
      const stopped = fresh ? vm.stopped === true : bot.kernel?.operatorHeld === true;
      state = stopped ? "stopped" : "running";
    }
  } catch { state = "off"; }
  if (b.dataset.state !== state) b.dataset.state = state;
  // Flip to the toolbar's left side when its right edge is at the screen edge.
  try {
    const slot = b.parentNode;
    const hb = slot?.parentNode;
    if (slot && hb && hb.id === "hb-hotbar" && typeof hb.getBoundingClientRect === "function") {
      const r = hb.getBoundingClientRect();
      const z = Number(hb.currentCSSZoom) > 0 ? Number(hb.currentCSSZoom) : 1;
      const flip = r.right + 36 * z > (window.innerWidth || 0);
      if (slot.classList.contains("flip") !== flip) slot.classList.toggle("flip", flip);
    }
  } catch { /* layout read failed — leave as is */ }
}

// ── plugin lifecycle ───────────────────────────────────────────────────
export function mount() {
  if (rynthHudDisabled(globalThis.location?.search)) return () => {};
  if (S.bridge) return () => {}; // one HUD per page (a re-mount keeps the first)
  ensureStyles();
  S.ui = loadUi();
  try { S.urlPersona = new URLSearchParams(globalThis.location?.search ?? "").get("botPersona"); } catch { S.urlPersona = null; }
  S.bridge = createHudBridge({ win: window });
  S.launcher = buildLauncher();
  attachLauncher();
  S.onHotbarMounted = () => attachLauncher();
  document.addEventListener("hb-hotbar-mounted", S.onHotbarMounted);
  S.launcherTimer = setInterval(launcherTick, LAUNCHER_MS);
  launcherTick();
  window.__toggleRynthHud = () => toggleHud();
  window.__openRynthHud = () => openHud();
  window.__closeRynthHud = () => closeHud();
  window.__rynthHud = Object.freeze({
    open: openHud, close: closeHud, toggle: toggleHud,
    snapshot: () => S.bridge?.snapshot?.() ?? null,
    bridge: S.bridge,
  });
  if (S.ui.open) openHud();
  return () => {
    stopTimer();
    clearInterval(S.launcherTimer);
    clearTimeout(S.msgTimer);
    document.removeEventListener("hb-hotbar-mounted", S.onHotbarMounted);
    destroyAiPanel();
    try { S.root?.remove(); } catch { /* ignore */ }
    try { S.launcher?.remove(); } catch { /* ignore */ }
    try { document.getElementById(FLOAT_ID)?.remove(); } catch { /* ignore */ }
    for (const k of ["__toggleRynthHud", "__openRynthHud", "__closeRynthHud", "__rynthHud"]) {
      try { delete window[k]; } catch { window[k] = undefined; }
    }
    Object.assign(S, { bridge: null, root: null, refs: null, launcher: null, lastVm: null, lastVmAt: 0, launcherTimer: 0, aiPanel: null });
  };
}

export default { mount };
