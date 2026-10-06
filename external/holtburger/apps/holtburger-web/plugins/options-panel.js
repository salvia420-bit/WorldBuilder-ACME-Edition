// Options view — main-panel port of retail's gmOptionsUI (layout
// 0x2100002B) and its pages.
//
// HUD overhaul 2026-10-05 — rebuilt on the shared HUD kit (ui/hud_kit.js).
// Before: eight cramped tabs wrapped onto two rows, native blue range
// sliders / native checkboxes / native selects next to brass chrome, and
// the view resized the shared main panel to retail's 292×600 config page
// so Apply/OK/Cancel hung off the bottom of a 720-px window.
//
// Retail anatomy (ui-layout-render of client_local_English.dat, see
// /mnt/wbterminal2/hud-compare-2026-10-05/retail/m-2B.json):
//   0x1000020D GameplayOptionsTab  "Gameplay Options"  106×25
//   0x1000020E CharacterSettingsTab "Character"          64×25
//   0x1000050B ChatTab              "Chat"               50×25
//   0x1000020F ConfigTab            "Config"             56×25
//   pages 298×575 on the dark field 0x06004CC2, built from templates:
//     OptionHeaderTemplate 292×22, OptionSeperatorTemplate 0x060012C5,
//     BoolOptionTemplate (orb checkbox 0x06004D15, text right of it),
//     FloatOptionTemplate (130-px label + 120-px slider 0x06001285 with
//     the 7×12 thumb 0x06001286), MenuOptionTemplate (label + dropdown).
//   gmCharacterSettingsUI 0x21000028 / gmConfigUI 0x21000029 put three
//   80×32 buttons under the list (retail: Apply / Reset / Defaults).
//
// This view keeps retail's FOUR tabs (one clean strip — "Gameplay",
// "Character", "Chat", "Config") and fits the shared 300-wide main-panel
// body: tab strip on top, a scrolling page (`hbk-scroll`, gold rope
// scrollbar), and a footer that is always visible. Footer semantics:
//   - Apply  — commit: every control already applies live; Apply makes
//              the current values the new Cancel baseline.
//   - OK     — commit + close.
//   - Cancel — revert everything changed since the view opened (or since
//              the last Apply) and close: HUD scale, graphics, audio,
//              camera, key bindings and character options.
//
// Pages:
//   Gameplay  — Interface (HUD scale, reset window positions), Mouse &
//               Camera (UseMouseTurning 0x31 + ui/camera_settings.js),
//               Keyboard ("Configure keyboard…" → bindings page, like
//               retail's GameplayOptions_Keyboard_Button), About.
//   Character — CharacterOption groups (wire: setCharacterOption).
//   Chat      — chat-channel / chat-behaviour CharacterOptions.
//   Config    — Sound (AudioManager buses) + ui/graphics_settings.js.

import * as graphicsSettings from "../ui/graphics_settings.js";
import * as cameraSettings from "../ui/camera_settings.js";
import {
  LOCAL_ACTIONS,
  getKeybindings,
  setBinding,
  clearBinding,
  formatBinding,
  loadRetailKeyMap,
  getRetailKeyMap,
  lookupRetailDefault,
  getManifestHotkeyConflicts,
} from "../ui/keymap.js";
import {
  getHudScale,
  getHudScaleMultiplier,
  setHudScaleMultiplier,
  onHudScaleChange,
  computeAutoScale,
  HUD_SCALE_MULT_MIN,
  HUD_SCALE_MULT_MAX,
} from "../ui/hud_scale.js";
import * as windowPosition from "../ui/ac_window_position.js";
import { modalConfirmCallback } from "./modal-dialog.js";

const VIEW_STYLE_ID = "hb-options-view-style";
const SP = "./data/ui-sprites";

// ---------------------------------------------------------------------
// Pure helpers (exported for test_options_panel_helpers.mjs).

/** HUD-scale slider range, in percent of the auto scale. */
export const HUD_SCALE_PCT_MIN = Math.round(HUD_SCALE_MULT_MIN * 100);
export const HUD_SCALE_PCT_MAX = Math.round(HUD_SCALE_MULT_MAX * 100);
export const HUD_SCALE_PCT_STEP = 5;

/** Multiplier (0.6–2.0) → slider percent, snapped to the 5 % step. */
export function hudScalePercentFromMultiplier(mult) {
  const m = Number(mult);
  const pct = Number.isFinite(m) ? m * 100 : 100;
  const snapped = Math.round(pct / HUD_SCALE_PCT_STEP) * HUD_SCALE_PCT_STEP;
  return Math.max(HUD_SCALE_PCT_MIN, Math.min(HUD_SCALE_PCT_MAX, snapped));
}

/** Slider percent → multiplier, clamped to the hud_scale.js range. */
export function hudScaleMultiplierFromPercent(pct) {
  const p = Number(pct);
  const clamped = Math.max(HUD_SCALE_PCT_MIN, Math.min(HUD_SCALE_PCT_MAX, Number.isFinite(p) ? p : 100));
  return clamped / 100;
}

/** "1.88× (window 1.25× × 150 %)" — the effective-scale readout. */
export function describeHudScale({ effective, auto, percent, forced = null }) {
  const fx = (n) => `${(Math.round(Number(n) * 100) / 100).toFixed(2)}×`;
  if (forced != null) return `Fixed at ${fx(forced)} by the ?hudScale= link option.`;
  return `Effective size ${fx(effective)} (window ${fx(auto)} × ${Math.round(percent)}%)`;
}

/** localStorage prefixes ui/ac_window_position.js persists under. */
export const WINDOW_POSITION_KEY_PREFIXES = Object.freeze(["hb.window.", "hb_panel_pos_"]);

/**
 * Remove every saved window position / size / lock (`hb.window.<id>`, plus
 * the pre-consolidation `hb_panel_pos_<id>` keys) from `storage`. Returns
 * the number of keys removed.
 */
export function clearWindowPositionKeys(storage) {
  if (!storage || typeof storage.key !== "function") return 0;
  const doomed = [];
  for (let i = 0; i < (storage.length | 0); i++) {
    const k = storage.key(i);
    if (typeof k === "string" && WINDOW_POSITION_KEY_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
  }
  for (const k of doomed) {
    try { storage.removeItem(k); } catch (_) {}
  }
  return doomed.length;
}

/** Copy the raw values of `keys` (null when absent). */
export function snapshotStorage(storage, keys) {
  const snap = {};
  for (const k of keys) {
    let v = null;
    try { v = storage?.getItem?.(k) ?? null; } catch (_) {}
    snap[k] = v;
  }
  return snap;
}

/** Write a snapshot back; returns the keys whose value actually changed. */
export function restoreStorage(storage, snap) {
  const changed = [];
  for (const [k, v] of Object.entries(snap || {})) {
    let cur = null;
    try { cur = storage?.getItem?.(k) ?? null; } catch (_) {}
    if (cur === v) continue;
    try {
      if (v == null) storage.removeItem(k);
      else storage.setItem(k, v);
      changed.push(k);
    } catch (_) {}
  }
  return changed;
}

/** Old (8-tab) ids → the retail 4-tab ids, so `showView("options", {tab})`
 *  callers written against the old layout still land somewhere sensible. */
export function resolveTabId(id) {
  const LEGACY = {
    graphics: "config", audio: "config", sound: "config",
    mouse: "gameplay", controls: "gameplay", keys: "gameplay", network: "gameplay",
    about: "gameplay", interface: "gameplay", hud: "gameplay",
    char: "character",
  };
  const s = String(id || "").toLowerCase();
  if (TAB_IDS.includes(s)) return s;
  return LEGACY[s] || null;
}

const TAB_IDS = ["gameplay", "character", "chat", "config"];

// ---------------------------------------------------------------------
// Styles.

function ensureStyles() {
  if (document.getElementById(VIEW_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = VIEW_STYLE_ID;
  style.textContent = `
    .hb-opt-root {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hbk-font);
      font-size: 12px;
      color: var(--hbk-text);
      /* Retail option pages sit on the dark field 0x06004CC2. */
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink);
      overflow: hidden;
    }
    .hb-opt-tabs {
      flex: 0 0 auto;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .hb-opt-tabs::-webkit-scrollbar { display: none; }
    .hb-opt-tabs .hbk-tab {
      flex: 1 0 auto;
      padding: 3px 6px 3px;
      font-size: 12px;
      letter-spacing: 0.02em;
      text-transform: none;
    }
    .hb-opt-tabs .hbk-tab:focus-visible { outline: 1px solid var(--hbk-gold); outline-offset: -2px; }
    .hb-opt-body {
      flex: 1 1 auto;
      min-height: 0;
      padding: 2px 2px 10px 4px;
      outline: none;
    }
    .hb-opt-footer { flex: 0 0 auto; padding: 4px 6px; gap: 4px; }
    .hb-opt-footer .hbk-btn { min-width: 58px; padding: 0 8px; }
    .hb-opt-status {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--hbk-text-dim);
      font-size: 11px;
      font-style: italic;
    }
    .hb-opt-root .hbk-section-title { margin: 8px 0 3px; }
    .hb-opt-body > .hbk-section-title:first-child,
    .hb-opt-body > :first-child > .hbk-section-title:first-child { margin-top: 2px; }

    /* Rows — retail BoolOptionTemplate / FloatOptionTemplate /
       MenuOptionTemplate (272×20). Shared by our own rows and the rows
       ui/graphics_settings.js + ui/camera_settings.js build. */
    .hb-opt-root .hb-opt-row,
    .hb-opt-root .hb-graphics-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 20px;
      margin: 0;
      padding: 1px 6px;
      box-sizing: border-box;
    }
    .hb-opt-root .hb-opt-row:hover,
    .hb-opt-root .hb-graphics-row:hover { background: var(--hbk-hover); }
    .hb-opt-root .hb-opt-row > label,
    .hb-opt-root .hb-graphics-row > label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--hbk-text);
      cursor: pointer;
    }
    /* Retail puts the orb LEFT of its text (OptionCheckboxTemplate). */
    .hb-opt-root .hb-graphics-bool > input.hbk-check { order: -1; }
    .hb-opt-root .hb-opt-row.is-disabled,
    .hb-opt-root .hb-opt-row.is-disabled > label { opacity: 0.55; cursor: not-allowed; }
    .hb-opt-root .hb-graphics-range > label { flex: 0 0 104px; }
    .hb-opt-root .hb-graphics-range > input.hbk-range { flex: 1 1 auto; min-width: 60px; }
    .hb-opt-root .hb-settings-val {
      flex: 0 0 44px;
      text-align: right;
      color: var(--hbk-value);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      white-space: nowrap;
    }
    .hb-opt-root .hb-graphics-selectrow > select { flex: 0 1 auto; max-width: 128px; }

    /* Retail slider art: SliderOption track 0x06001285 + thumb 0x06001286. */
    .hb-opt-root input.hbk-range { height: 16px; }
    .hb-opt-root input.hbk-range::-webkit-slider-runnable-track {
      height: 12px; border: 0;
      background: url("${SP}/0x06001285.png") center / 100% 100% no-repeat;
      box-shadow: 0 0 0 1px #000;
    }
    .hb-opt-root input.hbk-range::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 7px; height: 12px; margin-top: 0;
      border: 0; border-radius: 0;
      background: url("${SP}/0x06001286.png") center / 100% 100% no-repeat;
      box-shadow: 0 0 3px #000;
    }
    .hb-opt-root input.hbk-range::-moz-range-track {
      height: 12px; border: 0;
      background: url("${SP}/0x06001285.png") center / 100% 100% no-repeat;
    }
    .hb-opt-root input.hbk-range::-moz-range-thumb {
      width: 7px; height: 12px; border: 0; border-radius: 0;
      background: url("${SP}/0x06001286.png") center / 100% 100% no-repeat;
    }
    .hb-opt-root input.hbk-range:focus-visible { outline: 1px solid var(--hbk-gold); outline-offset: 1px; }
    .hb-opt-root input.hbk-range:disabled { opacity: 0.45; cursor: not-allowed; }

    .hb-opt-note {
      padding: 2px 6px 4px;
      color: var(--hbk-text-dim);
      font-size: 11px;
      font-style: italic;
      line-height: 1.35;
    }
    .hb-opt-note.is-warn { color: var(--hbk-gold-bright); font-style: normal; }
    .hb-opt-btnrow {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
    }
    .hb-opt-btnrow > .hb-opt-note { padding: 0; flex: 1 1 auto; min-width: 0; }
    .hb-opt-root .hbk-btn-small:disabled { filter: grayscale(0.8) brightness(0.7); cursor: default; }

    /* Graphics module extras (preset tags, reload pill, reset row). */
    .hb-opt-root .hb-graphics-presets { display: flex; gap: 4px; padding: 2px 6px 4px; margin: 0; }
    .hb-opt-root .hb-graphics-presets > .hbk-btn-brass { flex: 1 1 0; min-width: 0; }
    .hb-opt-root .hb-graphics-reload {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin: 8px 6px 2px; padding: 4px 6px;
      border: 1px solid var(--hbk-gold-dim);
      background: rgba(243, 210, 122, 0.08);
      color: var(--hbk-gold-bright); font-size: 11px;
    }
    .hb-opt-root .hb-graphics-resetrow { display: flex; justify-content: flex-end; gap: 6px; padding: 6px 6px 2px; margin: 0; }
    .hb-opt-root .hb-graphics-fullscreen { flex-wrap: wrap; row-gap: 3px; }
    .hb-opt-root .hb-graphics-fullscreen > .hb-graphics-note {
      flex: 1 1 100%; color: var(--hbk-text-dim); font-size: 11px; font-style: italic;
    }
    .hb-opt-root .hb-graphics-fullscreen:hover { background: transparent; }

    /* Key bindings page. */
    .hb-opt-pagehead {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 4px 4px;
      border-bottom: 1px solid var(--hbk-gold-deep);
      color: var(--hbk-gold-bright);
      font-size: 13px; letter-spacing: 0.04em;
    }
    .hb-opt-keyrow { gap: 4px; }
    .hb-opt-keyrow > .hb-opt-keylabel {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    .hb-opt-key {
      flex: 0 0 86px;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      text-align: right;
      color: var(--hbk-value);
      font-size: 11px;
    }
    .hb-opt-key.is-default { color: var(--hbk-text-dim); }
    .hb-opt-key.is-capturing { color: var(--hbk-gold-bright); font-style: italic; }
    .hb-opt-keyrow .hbk-btn-small { min-width: 40px; }
    .hb-opt-keyrow .hbk-icon-btn { width: 16px; height: 16px; font-size: 11px; line-height: 1; }
    .hb-opt-keyrow .hbk-icon-btn:disabled { opacity: 0.3; cursor: default; }
    .hb-opt-subhead {
      padding: 6px 6px 1px;
      color: var(--hbk-gold);
      font-size: 11px; letter-spacing: 0.06em;
      border-bottom: 1px solid rgba(243, 210, 122, 0.18);
    }
    .hb-opt-conflicts {
      margin: 4px 6px 6px; padding: 4px 6px;
      border: 1px solid #802020;
      background: rgba(120, 32, 32, 0.25);
      font-size: 11px;
    }
    .hb-opt-conflicts > div { color: var(--hbk-text); }
    .hb-opt-conflicts > .hb-opt-conflicts-title { color: #f0a060; margin-bottom: 2px; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------
// Small DOM builders.

let _idSeq = 0;
function nextId(prefix = "hb-opt") {
  _idSeq += 1;
  return `${prefix}-${_idSeq}`;
}

function sectionTitle(text) {
  const h = document.createElement("div");
  h.className = "hbk-section-title";
  h.textContent = text;
  return h;
}

function note(text, { warn = false } = {}) {
  const n = document.createElement("div");
  n.className = "hb-opt-note" + (warn ? " is-warn" : "");
  n.textContent = text;
  return n;
}

function boolOptionRow(label, checked, onChange, { disabled = false, hint = null } = {}) {
  const row = document.createElement("div");
  row.className = "hb-opt-row hb-opt-bool";
  const id = nextId();
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "hbk-check";
  cb.id = id;
  cb.checked = !!checked;
  const lbl = document.createElement("label");
  lbl.htmlFor = id;
  lbl.textContent = label;
  lbl.title = hint || label;
  if (disabled) {
    cb.disabled = true;
    row.classList.add("is-disabled");
  }
  cb.addEventListener("change", () => onChange(!!cb.checked, cb));
  row.appendChild(cb);
  row.appendChild(lbl);
  return { row, cb };
}

// ---------------------------------------------------------------------
// Session — what Cancel reverts to (HUD overhaul 2026-10-05).

const LS_CHAR_OPTIONS_KEY = "holtburger_character_options_v1";
const LS_AUDIO_KEY = "hb.options.audio.v1";
const SNAPSHOT_KEYS = Object.freeze([
  "holtburger_graphics_v1",
  "holtburger_camera_v1",
  LS_AUDIO_KEY,
]);

function safeStorage() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (_) { return null; }
}

function createSession() {
  const q = (typeof window !== "undefined") ? window.__quality : null;
  return {
    storage: snapshotStorage(safeStorage(), SNAPSHOT_KEYS),
    hudMult: getHudScaleMultiplier(),
    keybindings: cloneJson(getKeybindings()),
    quality: q ? { preset: q.preset, flags: q.flags ? { ...q.flags } : null } : null,
    // CharacterOption index → its value before the first toggle this session.
    charOptions: new Map(),
  };
}

function cloneJson(v) {
  try { return JSON.parse(JSON.stringify(v ?? {})); } catch (_) { return {}; }
}

function revertSession(session) {
  // 1. Client-local blobs, then push them back onto the live systems.
  restoreStorage(safeStorage(), session.storage);
  if (session.quality && window.__quality) {
    window.__quality.preset = session.quality.preset;
    if (session.quality.flags && window.__quality.flags) {
      Object.assign(window.__quality.flags, session.quality.flags);
    }
  }
  try { graphicsSettings.reapplyLiveGraphics(); } catch (_) {}
  try { cameraSettings.applyCameraState(cameraSettings.loadCameraState()); } catch (_) {}
  applyAudioGains(loadAudioGains());
  if (getHudScaleMultiplier() !== session.hudMult) setHudScaleMultiplier(session.hudMult);
  // 2. Key bindings through the keymap API (keeps its cache + diag hooks).
  const before = session.keybindings || {};
  const now = getKeybindings() || {};
  for (const k of Object.keys(now)) {
    if (!(k in before)) clearBinding(k);
  }
  for (const [k, v] of Object.entries(before)) {
    if (JSON.stringify(now[k]) !== JSON.stringify(v)) setBinding(k, v);
  }
  // 3. Character options are server-side — re-send the originals.
  const handle = window.__sessionHandle ?? null;
  for (const [idx, orig] of session.charOptions) {
    saveCharacterOption(idx, orig);
    try { handle?.setCharacterOption?.(idx >>> 0, orig); } catch (_) {}
  }
  session.charOptions.clear();
}

// ---------------------------------------------------------------------
// Key bindings (Gameplay → Configure keyboard…).
//
// Data layer (storage, defaults, matchers, the LOCAL_ACTIONS table)
// lives in ../ui/keymap.js. This block owns capture orchestration and
// the row rendering.

let captureFor = null; // labelHash (hex string) currently in capture mode
let captureHandler = null;

function endCapture() {
  if (captureHandler) {
    window.removeEventListener("keydown", captureHandler, true);
    captureHandler = null;
  }
  captureFor = null;
}

function startCapture(labelHashHex, refresh) {
  endCapture();
  captureFor = labelHashHex;
  captureHandler = (ev) => {
    // Esc cancels without binding.
    if (ev.code === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      endCapture();
      refresh();
      return;
    }
    // Ignore bare modifier presses — capture should be "Ctrl+F5", not
    // just "Ctrl". User has to press a non-modifier to complete.
    const isBareModifier =
      ev.code === "ShiftLeft" || ev.code === "ShiftRight" ||
      ev.code === "ControlLeft" || ev.code === "ControlRight" ||
      ev.code === "AltLeft" || ev.code === "AltRight" ||
      ev.code === "MetaLeft" || ev.code === "MetaRight";
    if (isBareModifier) return;

    ev.preventDefault();
    ev.stopPropagation();

    setBinding(labelHashHex, {
      code: ev.code,
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      meta: ev.metaKey,
    });
    endCapture();
    refresh();
  };
  window.addEventListener("keydown", captureHandler, true);
}

// One row in the keybinding table. `defaultBinding` accepts a
// KeyboardEvent.code string (local actions), a {code,shift,ctrl,alt,meta}
// object (retail KeyMap defaults) or null (no default).
function buildBindingRow(labelHashHex, label, defaultBinding, bindings, refresh) {
  const defaultBindingObj = (typeof defaultBinding === "string")
    ? { code: defaultBinding, shift: false, ctrl: false, alt: false, meta: false }
    : defaultBinding;

  const row = document.createElement("div");
  row.className = "hb-opt-row hb-opt-keyrow";

  const l = document.createElement("span");
  l.className = "hb-opt-keylabel";
  l.textContent = label;
  l.title = label;
  row.appendChild(l);

  const inCapture = captureFor === labelHashHex;
  const userBinding = bindings[labelHashHex];
  const effectiveBinding = userBinding ?? defaultBindingObj;
  const isDefault = !userBinding && !!defaultBindingObj;
  const k = document.createElement("span");
  k.className = "hb-opt-key" + (inCapture ? " is-capturing" : (isDefault ? " is-default" : ""));
  k.textContent = inCapture
    ? "Press a key…"
    : (effectiveBinding ? formatBinding(effectiveBinding) : "—");
  k.title = inCapture
    ? "Press the new key (Esc cancels)"
    : (isDefault ? "Retail default" : (userBinding ? "Your binding" : "Unbound"));
  row.appendChild(k);

  const bindBtn = document.createElement("button");
  bindBtn.type = "button";
  bindBtn.className = "hbk-btn-small";
  bindBtn.textContent = inCapture ? "Cancel" : "Bind";
  bindBtn.addEventListener("click", () => {
    if (inCapture) { endCapture(); refresh(); }
    else startCapture(labelHashHex, refresh);
  });
  row.appendChild(bindBtn);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "hbk-icon-btn";
  clearBtn.textContent = "×";
  clearBtn.title = userBinding ? "Restore the default key" : "Using the default key";
  clearBtn.setAttribute("aria-label", `Restore default key for ${label}`);
  clearBtn.disabled = !userBinding;
  clearBtn.addEventListener("click", () => { if (clearBinding(labelHashHex)) refresh(); });
  row.appendChild(clearBtn);

  return row;
}

// inputMap (ActionMap outer-key) → human-readable category name.
// Derived from the action labels in each category. Categories with no
// named actions are omitted; unmapped ones fall back to "Other".
const ACTION_CATEGORY_NAMES = {
  0x00000004: "Movement",
  0x00000005: "Camera",
  0x00000006: "Camera (alternate)",
  0x10000002: "Combat Mode",
  0x10000003: "Melee Combat",
  0x10000004: "Missile Combat",
  0x10000005: "Magic",
  0x10000006: "Emotes",
  0x10000007: "Selection",
  0x10000008: "Options",
  0x10000009: "UI Panels",
  0x1000000A: "Chat",
  0x1000000B: "Floating Chat",
  0x1000000C: "Quickslots",
  0x1000000D: "Chat Mode",
};

function renderKeysPage(bodyEl, env) {
  bodyEl.innerHTML = "";
  const refresh = () => {
    const top = bodyEl.scrollTop;
    renderKeysPage(bodyEl, env);
    bodyEl.scrollTop = top;
  };

  const head = document.createElement("div");
  head.className = "hb-opt-pagehead";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "hbk-btn-small hbk-brown";
  back.textContent = "‹ Back";
  back.addEventListener("click", () => { endCapture(); env.showPage(null); });
  head.appendChild(back);
  const t = document.createElement("span");
  t.textContent = "Key Bindings";
  head.appendChild(t);
  bodyEl.appendChild(head);

  bodyEl.appendChild(note("Click Bind, then press the new key. Esc cancels. × restores the default."));

  // HUD rec #113 — plugin-manifest hotkey conflicts (two manifests
  // declaring the same default key; the host's last-wins resolution
  // dispatches only one).
  const conflicts = getManifestHotkeyConflicts();
  if (conflicts.length > 0) {
    const box = document.createElement("div");
    box.className = "hb-opt-conflicts";
    const title = document.createElement("div");
    title.className = "hb-opt-conflicts-title";
    title.textContent = `${conflicts.length} key${conflicts.length === 1 ? " is" : "s are"} claimed by more than one window:`;
    box.appendChild(title);
    for (const c of conflicts) {
      const r = document.createElement("div");
      r.textContent = `${c.keyString} — ${c.conflicts.join(", ")}`;
      box.appendChild(r);
    }
    bodyEl.appendChild(box);
  }

  const bindings = getKeybindings();

  bodyEl.appendChild(sectionTitle("Quick actions"));
  for (const action of LOCAL_ACTIONS) {
    bodyEl.appendChild(buildBindingRow(action.labelHash, action.label, action.defaultCode, bindings, refresh));
  }

  // Retail ActionMap actions grouped by their inputMap category. Defaults
  // come from the retail KeyMap (gmDefaultMap, DAT 0x14000000) joined by
  // (inputMap, actionHash).
  bodyEl.appendChild(sectionTitle("Game actions"));
  const actions = window.__acKeybindings;
  if (!Array.isArray(actions) || actions.length === 0) {
    bodyEl.appendChild(note("The game's key map is still loading — reopen this page in a moment."));
    return;
  }
  if (!getRetailKeyMap()) {
    loadRetailKeyMap().then((km) => { if (km && bodyEl.isConnected) refresh(); }).catch(() => {});
  }
  const byCategory = new Map();
  for (const a of actions) {
    if (!a.label) continue;
    let group = byCategory.get(a.inputMap);
    if (!group) { group = new Map(); byCategory.set(a.inputMap, group); }
    if (!group.has(a.labelHash)) group.set(a.labelHash, { label: a.label, actionHash: a.actionHash });
  }
  const orderedCats = [...byCategory.keys()].sort((a, b) => a - b);
  for (const inputMap of orderedCats) {
    const group = byCategory.get(inputMap);
    if (group.size === 0) continue;
    const sub = document.createElement("div");
    sub.className = "hb-opt-subhead";
    sub.textContent = ACTION_CATEGORY_NAMES[inputMap] ?? "Other";
    bodyEl.appendChild(sub);
    const sorted = [...group.entries()].sort(([, a], [, b]) => a.label.localeCompare(b.label));
    for (const [labelHash, info] of sorted) {
      const hashHex = `0x${labelHash.toString(16).toUpperCase().padStart(8, "0")}`;
      const retailDefault = lookupRetailDefault(inputMap, info.actionHash);
      bodyEl.appendChild(buildBindingRow(hashHex, info.label, retailDefault, bindings, refresh));
    }
  }
}

// ---------------------------------------------------------------------
// CharacterOption rows (Character / Chat / Gameplay→Mouse).
//
// Each row sends `sessionHandle.setCharacterOption(option, value)` on
// change (wasm fan-out: SessionCommand::SetCharacterOption →
// GameAction::SetSingleCharacterOption sub-opcode 0x0167, ACE handler
// `Player_Character.cs:80-106`). ACE persists to the Character row's
// `CharacterOptions1` / `CharacterOptions2` columns and echoes back via
// `Private/PublicUpdatePropertyInt`.
//
// `idx` is the `holtburger_common::CharacterOption` enum INDEX
// (0..0x36 — `crates/holtburger-common/src/character.rs:117`), NOT the
// retail bitfield mask. The wasm side validates it via FromRepr.

// Rec #89 — full ACE CharacterOption catalog (0x00-0x34 inclusive) per
// ace-server Source/ACE.Entity/Enum/CharacterOption.cs. 0x0E
// VividTargetingIndicator routes through scene3d/target_ring.js; 0x35 /
// 0x36 are *Default sentinels.
const CHARACTER_OPTION_GROUPS = [
  {
    section: "Combat",
    options: [
      { idx: 0x00, label: "Auto-repeat attacks" },
      { idx: 0x0D, label: "Auto-target combat" },
      { idx: 0x07, label: "Keep combat target in view" },
      { idx: 0x19, label: "Use charge attack" },
      { idx: 0x2A, label: "Lead missile targets" },
      { idx: 0x2B, label: "Use fast missiles" },
      { idx: 0x0C, label: "Advanced combat interface" },
      { idx: 0x09, label: "Attempt to deceive other players" },
    ],
  },
  {
    // Use mouse turning (0x31) lives on Gameplay → Mouse & Camera.
    section: "Movement",
    options: [
      { idx: 0x0A, label: "Run as default movement" },
    ],
  },
  {
    section: "Interface",
    options: [
      { idx: 0x13, label: "Side-by-side vitals" },
      { idx: 0x14, label: "Show coordinates by the radar" },
      { idx: 0x15, label: "Display spell durations" },
      { idx: 0x08, label: "Display 3D tooltips" },
      { idx: 0x33, label: "Lock UI" },
      { idx: 0x1A, label: "Show crafting success dialog" },
      { idx: 0x2D, label: "Confirm use of rare gems" },
    ],
  },
  {
    section: "Social",
    options: [
      { idx: 0x01, label: "Ignore allegiance requests" },
      { idx: 0x02, label: "Ignore fellowship requests" },
      { idx: 0x03, label: "Ignore all trade requests" },
      { idx: 0x06, label: "Let other players give you items" },
      { idx: 0x12, label: "Automatically accept fellowship requests" },
      { idx: 0x0F, label: "Share fellowship XP and luminance" },
      { idx: 0x11, label: "Share fellowship loot" },
      { idx: 0x18, label: "Show allegiance logons" },
      { idx: 0x10, label: "Accept corpse looting permissions" },
      { idx: 0x17, label: "Drag item onto player opens trade" },
      { idx: 0x27, label: "Appear offline" },
    ],
  },
  {
    section: "Privacy",
    options: [
      { idx: 0x1C, label: "Show date of birth" },
      { idx: 0x1D, label: "Show age" },
      { idx: 0x1E, label: "Show chess rank" },
      { idx: 0x1F, label: "Show fishing skill" },
      { idx: 0x20, label: "Show number of deaths" },
      { idx: 0x28, label: "Show number of titles" },
    ],
  },
  {
    section: "Inventory",
    options: [
      { idx: 0x22, label: "Salvage multiple materials at once" },
      { idx: 0x29, label: "Use main pack as default pickup destination" },
    ],
  },
  {
    section: "Visual",
    options: [
      { idx: 0x05, label: "Always daylight outdoors" },
      { idx: 0x04, label: "Disable most weather effects" },
      { idx: 0x2F, label: "Show helm/headgear" },
      { idx: 0x32, label: "Show cloak" },
      { idx: 0x30, label: "Disable distance fog" },
      { idx: 0x16, label: "Disable house restriction effects" },
    ],
  },
];

// Retail splits chat channel / behaviour options onto their own Chat page.
const CHAT_OPTION_GROUPS = [
  {
    section: "Channels",
    options: [
      { idx: 0x1B, label: "Listen to allegiance chat" },
      { idx: 0x23, label: "Listen to general chat" },
      { idx: 0x24, label: "Listen to trade chat" },
      { idx: 0x25, label: "Listen to LFG chat" },
      { idx: 0x26, label: "Listen to roleplay chat" },
      { idx: 0x2E, label: "Listen to society chat" },
      { idx: 0x34, label: "Listen to PK death messages" },
    ],
  },
  {
    section: "Behavior",
    options: [
      { idx: 0x0B, label: "Stay in chat mode after sending" },
      { idx: 0x21, label: "Display timestamps" },
      { idx: 0x2C, label: "Filter language" },
    ],
  },
];

const MOUSE_TURNING_OPTION = { idx: 0x31, label: "Use mouse turning" };

function loadCharacterOptions() {
  try {
    const raw = localStorage.getItem(LS_CHAR_OPTIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (_) { return {}; }
}

function saveCharacterOption(idx, value) {
  try {
    const state = loadCharacterOptions();
    state[String(idx)] = !!value;
    localStorage.setItem(LS_CHAR_OPTIONS_KEY, JSON.stringify(state));
  } catch (_) {}
}

// Server-authoritative bits via `isCharacterOptionEnabled` (hydrated by
// PlayerDescription on login, optimistically updated by the wasm
// SetCharacterOption arm); localStorage cache when offline.
function readCharacterOption(idx, handle, localCache) {
  if (handle && typeof handle.isCharacterOptionEnabled === "function") {
    try { return !!handle.isCharacterOptionEnabled(idx >>> 0); }
    catch (_) { /* unknown index — fall back to local cache */ }
  }
  return !!localCache[String(idx)];
}

function getCharacterOptionContext() {
  const localCache = loadCharacterOptions();
  const handle = window.__sessionHandle ?? null;
  const offline = !handle || typeof handle.setCharacterOption !== "function";
  return { localCache, handle, offline };
}

function renderOfflineBanner(bodyEl, ctx) {
  // HUD rec #106 — offline toggles are disabled (a local-only flip could
  // otherwise be pushed to the server unexpectedly on the next login).
  if (ctx.offline) {
    bodyEl.appendChild(note("You are not in the world — character options can be changed after you log in.", { warn: true }));
  }
}

function buildCharacterOptionRow(opt, ctx, env) {
  const { handle, localCache, offline } = ctx;
  const { row, cb } = boolOptionRow(
    opt.label,
    readCharacterOption(opt.idx, handle, localCache),
    (value) => {
      if (env?.session && !env.session.charOptions.has(opt.idx)) {
        env.session.charOptions.set(opt.idx, !value);
      }
      saveCharacterOption(opt.idx, value);
      try {
        handle?.setCharacterOption?.(opt.idx >>> 0, value);
      } catch (e) {
        // Wire failure is best-effort — keep local state, log only.
        console.warn(`[options-panel] setCharacterOption(0x${opt.idx.toString(16)}=${value}) failed:`, e);
      }
    },
    { disabled: offline },
  );
  env?.charBoxes?.set(opt.idx, cb);
  return row;
}

function renderCharacterOptionGroups(bodyEl, groups, ctx, env) {
  for (const group of groups) {
    bodyEl.appendChild(sectionTitle(group.section));
    for (const opt of group.options) bodyEl.appendChild(buildCharacterOptionRow(opt, ctx, env));
  }
}

// ---------------------------------------------------------------------
// Audio — real AudioManager gain buses (scene3d/audio/audio_manager.js,
// `liveScene3d.audioManager`). No CharacterOption exists for audio, so
// it persists to `hb.options.audio.v1` (read at AudioManager
// construction — tests/audio_manager_retail.test.mjs) and is re-applied
// to the live mixer on slider input.
const AUDIO_BUSES = [
  { key: "master",  label: "Master volume", setter: "setMasterGain" },
  { key: "effect",  label: "Sound effects", setter: "setEffectGain" },
  { key: "ambient", label: "Ambient sound", setter: "setAmbientGain" },
];

function loadAudioGains() {
  const defaults = { master: 1.0, effect: 1.0, ambient: 1.0 };
  try {
    const raw = localStorage.getItem(LS_AUDIO_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? { ...defaults, ...parsed } : defaults;
  } catch (_) { return defaults; }
}

function saveAudioGain(key, value) {
  try {
    const state = loadAudioGains();
    state[key] = value;
    localStorage.setItem(LS_AUDIO_KEY, JSON.stringify(state));
  } catch (_) {}
}

function getAudioManager() {
  return window.liveScene3d?.audioManager ?? null;
}

function applyAudioGains(gains) {
  const manager = getAudioManager();
  if (!manager) return;
  for (const bus of AUDIO_BUSES) {
    try { manager[bus.setter]?.(gains[bus.key]); } catch (_) {}
  }
}

function renderSoundSection(bodyEl) {
  bodyEl.appendChild(sectionTitle("Sound"));
  const gains = loadAudioGains();
  if (getAudioManager()) applyAudioGains(gains);
  for (const bus of AUDIO_BUSES) {
    bodyEl.appendChild(graphicsSettings.rangeRow({
      label: bus.label,
      min: 0, max: 100, step: 1,
      value: Math.round((gains[bus.key] ?? 1.0) * 100),
      format: (v) => `${Math.round(v)}%`,
      onInput: (pct) => {
        const g = pct / 100;
        saveAudioGain(bus.key, g);
        try { getAudioManager()?.[bus.setter]?.(g); } catch (_) {}
      },
    }));
  }
  if (!getAudioManager()) {
    bodyEl.appendChild(note("Sound starts with your first click in the world; your levels are saved until then."));
  }
}

// ---------------------------------------------------------------------
// Interface section — HUD scale + window layout (HUD overhaul 2026-10-05).

function urlHudScaleOverride() {
  try {
    const v = new URLSearchParams(window.location.search).get("hudScale");
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0.25 && n <= 6 ? n : null;
  } catch (_) { return null; }
}

function renderInterfaceSection(bodyEl, env) {
  bodyEl.appendChild(sectionTitle("Interface"));
  const forced = urlHudScaleOverride();

  // Applied on `change` (release / each keyboard step), previewed in the
  // readout on `input`: the slider lives INSIDE the zoomed HUD, so
  // re-zooming on every pointer move would slide the track out from
  // under the cursor and make the drag fight itself.
  const row = graphicsSettings.rangeRow({
    label: "HUD scale",
    min: HUD_SCALE_PCT_MIN, max: HUD_SCALE_PCT_MAX, step: HUD_SCALE_PCT_STEP,
    value: hudScalePercentFromMultiplier(getHudScaleMultiplier()),
    format: (v) => `${Math.round(v)}%`,
    hint: "Size of every window and bar, on top of the automatic size for your window height.",
    onInput: (pct) => updateReadout(pct),
    onChange: (pct) => {
      setHudScaleMultiplier(hudScaleMultiplierFromPercent(pct));
      updateReadout(pct);
    },
  });
  const slider = row.querySelector("input");
  if (forced != null && slider) slider.disabled = true;
  bodyEl.appendChild(row);

  const readout = note("");
  bodyEl.appendChild(readout);
  function updateReadout(pct) {
    const auto = computeAutoScale(window.innerHeight);
    const p = pct ?? hudScalePercentFromMultiplier(getHudScaleMultiplier());
    // Once applied, show the live getHudScale(); mid-drag, the preview.
    const applied = Math.abs(p / 100 - getHudScaleMultiplier()) < 1e-6;
    readout.textContent = describeHudScale({
      effective: forced ?? (applied ? getHudScale() : Math.round(auto * (p / 100) * 100) / 100),
      auto,
      percent: p,
      forced,
    });
  }
  updateReadout();
  env.addCleanup(onHudScaleChange(() => {
    if (slider && document.activeElement !== slider) {
      slider.value = String(hudScalePercentFromMultiplier(getHudScaleMultiplier()));
      slider.dispatchEvent(new Event("input"));
    }
    updateReadout();
  }));
  const onResize = () => updateReadout();
  window.addEventListener("resize", onResize);
  env.addCleanup(() => window.removeEventListener("resize", onResize));

  const btnRow = document.createElement("div");
  btnRow.className = "hb-opt-btnrow";
  const resetSize = document.createElement("button");
  resetSize.type = "button";
  resetSize.className = "hbk-btn-small hbk-brown";
  resetSize.textContent = "Default size";
  resetSize.title = "Set the HUD scale back to 100%";
  resetSize.disabled = forced != null;
  resetSize.addEventListener("click", () => {
    setHudScaleMultiplier(1);
    if (slider) {
      slider.value = "100";
      slider.dispatchEvent(new Event("input"));
    }
  });
  const resetPos = document.createElement("button");
  resetPos.type = "button";
  resetPos.className = "hbk-btn-small";
  resetPos.textContent = "Reset window positions";
  resetPos.title = "Move every window back to where it starts";
  resetPos.addEventListener("click", () => resetWindowPositions(env));
  btnRow.appendChild(resetSize);
  btnRow.appendChild(resetPos);
  bodyEl.appendChild(btnRow);
}

function resetWindowPositions(env) {
  const removed = clearWindowPositionKeys(safeStorage());
  // Live reset when ui/ac_window_position.js offers it; otherwise the
  // cleared keys take effect on the next load.
  if (typeof windowPosition.resetAllWindowPositions === "function") {
    try {
      windowPosition.resetAllWindowPositions();
      env.setStatus("Windows moved back to their default positions.");
      return;
    } catch (e) {
      console.warn("[options-panel] resetAllWindowPositions failed:", e);
    }
  }
  modalConfirmCallback({
    title: "Reset Window Positions",
    message: removed > 0
      ? "Saved window positions were cleared. Reload now to put every window back in its default place?"
      : "No window has been moved from its default place. Reload anyway?",
    confirmLabel: "Reload",
    cancelLabel: "Later",
    onConfirm: () => { try { window.location.reload(); } catch (_) {} },
    onCancel: () => { if (removed > 0) env.setStatus("Window positions reset on next reload."); },
  });
}

// ---------------------------------------------------------------------
// Pages.

function renderGameplayTab(bodyEl, env) {
  bodyEl.innerHTML = "";
  renderInterfaceSection(bodyEl, env);

  // Mouse & Camera — UseMouseTurning (CharacterOption 0x31, the one wire
  // mouse option) plus the live camera controls from camera_settings.js.
  const ctx = getCharacterOptionContext();
  const camWrap = document.createElement("div");
  camWrap.className = "hb-opt-camera";
  const disposeCam = cameraSettings.renderCameraTab(camWrap, {
    extraMouseRows: () => [buildCharacterOptionRow(MOUSE_TURNING_OPTION, ctx, env)],
  });
  env.addCleanup(disposeCam);
  bodyEl.appendChild(camWrap);

  // Keyboard — retail GameplayOptions_Keyboard_Button "Configure Keyboard".
  bodyEl.appendChild(sectionTitle("Keyboard"));
  const keyRow = document.createElement("div");
  keyRow.className = "hb-opt-btnrow";
  const keyBtn = document.createElement("button");
  keyBtn.type = "button";
  keyBtn.className = "hbk-btn";
  keyBtn.textContent = "Configure keyboard…";
  keyBtn.addEventListener("click", () => env.showPage("keys"));
  keyRow.appendChild(keyBtn);
  const conflicts = getManifestHotkeyConflicts();
  if (conflicts.length > 0) {
    keyRow.appendChild(note(`${conflicts.length} key conflict${conflicts.length === 1 ? "" : "s"}`, { warn: true }));
  }
  bodyEl.appendChild(keyRow);

  bodyEl.appendChild(sectionTitle("About"));
  bodyEl.appendChild(note("Holtburger — an Asheron's Call client that runs in your browser, built against the retail client and the ACE server."));
}

function renderCharacterTab(bodyEl, env) {
  bodyEl.innerHTML = "";
  const ctx = getCharacterOptionContext();
  renderOfflineBanner(bodyEl, ctx);
  renderCharacterOptionGroups(bodyEl, CHARACTER_OPTION_GROUPS, ctx, env);
}

function renderChatTab(bodyEl, env) {
  bodyEl.innerHTML = "";
  const ctx = getCharacterOptionContext();
  renderOfflineBanner(bodyEl, ctx);
  renderCharacterOptionGroups(bodyEl, CHAT_OPTION_GROUPS, ctx, env);
}

function renderConfigTab(bodyEl, env) {
  bodyEl.innerHTML = "";
  renderSoundSection(bodyEl);
  // graphics_settings clears its container on every (re-)render — give it
  // its own wrapper.
  const gfx = document.createElement("div");
  gfx.className = "hb-opt-graphics";
  bodyEl.appendChild(gfx);
  const first = graphicsSettings.renderGraphicsTab(gfx, {});
  // A preset click re-renders in place and swaps the dispose hook — always
  // dispose whichever render is current.
  env.addCleanup(() => (gfx.__hbGraphicsDispose || first)?.());
}

const TABS = [
  { id: "gameplay",  label: "Gameplay",  render: renderGameplayTab },
  { id: "character", label: "Character", render: renderCharacterTab },
  { id: "chat",      label: "Chat",      render: renderChatTab },
  { id: "config",    label: "Config",    render: renderConfigTab },
];

// Last tab the player looked at (per page-session convenience).
let _lastTab = "gameplay";

// ---------------------------------------------------------------------
// Public view export — registered in app/plugin_bar.js
// (`mainPanelPlugin.registerView("options", optionsPanelPlugin.view)`).
export const view = {
  name: "Options",
  nameFor: () => "Options",
  mount: (parentEl, ctx) => {
    ensureStyles();
    let session = createSession();

    const root = document.createElement("div");
    root.className = "hb-opt-root";

    const tabsEl = document.createElement("div");
    tabsEl.className = "hbk-tabs hb-opt-tabs";
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Options pages");
    root.appendChild(tabsEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "hb-opt-body hbk-scroll";
    bodyEl.setAttribute("role", "tabpanel");
    bodyEl.tabIndex = -1;
    root.appendChild(bodyEl);

    const footer = document.createElement("div");
    footer.className = "hbk-footer hb-opt-footer";
    const status = document.createElement("span");
    status.className = "hb-opt-status";
    status.setAttribute("aria-live", "polite");
    footer.appendChild(status);
    const mkBtn = (label, title, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hbk-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", onClick);
      footer.appendChild(b);
      return b;
    };
    let statusTimer = 0;
    const setStatus = (text) => {
      status.textContent = text || "";
      clearTimeout(statusTimer);
      if (text) statusTimer = setTimeout(() => { status.textContent = ""; }, 4000);
    };
    mkBtn("Apply", "Keep the current settings (Cancel will no longer undo them)", () => {
      session = createSession();
      env.session = session;
      setStatus("Settings saved.");
    });
    mkBtn("OK", "Keep the current settings and close", () => {
      window.__mainPanel?.closeView?.();
    });
    mkBtn("Cancel", "Undo changes made since the window opened (or since Apply) and close", () => {
      endCapture();
      try { revertSession(session); } catch (e) { console.warn("[options-panel] revert failed:", e); }
      window.__mainPanel?.closeView?.();
    });
    root.appendChild(footer);

    // Per-page cleanups (graphics fullscreen listener, HUD-scale listener…).
    let pageCleanups = [];
    const runPageCleanups = () => {
      for (const fn of pageCleanups) {
        try { if (typeof fn === "function") fn(); } catch (_) {}
      }
      pageCleanups = [];
    };
    const env = {
      session,
      charBoxes: new Map(),
      addCleanup: (fn) => { if (typeof fn === "function") pageCleanups.push(fn); },
      setStatus,
      showPage: (page) => renderActive(page),
    };

    const tabBtns = new Map();
    let activeId = resolveTabId(ctx?.tab) || _lastTab || "gameplay";
    for (const t of TABS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hbk-tab";
      b.id = nextId("hb-opt-tab");
      b.dataset.tab = t.id;
      b.setAttribute("role", "tab");
      b.textContent = t.label;
      b.addEventListener("click", () => switchTo(t.id));
      tabsEl.appendChild(b);
      tabBtns.set(t.id, b);
    }
    // Retail-style keyboard: ←/→ (Home/End) walk the tab strip.
    tabsEl.addEventListener("keydown", (ev) => {
      const order = TABS.map((t) => t.id);
      let i = order.indexOf(activeId);
      if (ev.key === "ArrowRight") i = (i + 1) % order.length;
      else if (ev.key === "ArrowLeft") i = (i - 1 + order.length) % order.length;
      else if (ev.key === "Home") i = 0;
      else if (ev.key === "End") i = order.length - 1;
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      switchTo(order[i]);
      tabBtns.get(order[i])?.focus({ preventScroll: true });
    });

    function renderActive(page) {
      endCapture();
      runPageCleanups();
      env.charBoxes.clear();
      bodyEl.scrollTop = 0;
      if (page === "keys") {
        renderKeysPage(bodyEl, env);
        return;
      }
      const t = TABS.find((x) => x.id === activeId) || TABS[0];
      t.render(bodyEl, env);
    }

    function switchTo(tabId, page = null) {
      activeId = tabId;
      _lastTab = tabId;
      for (const [id, b] of tabBtns) {
        const on = id === tabId;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
        if (on) bodyEl.setAttribute("aria-labelledby", b.id);
      }
      renderActive(page);
      try { tabBtns.get(tabId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); } catch (_) {}
    }

    parentEl.appendChild(root);
    switchTo(activeId, ctx?.page === "keys" ? "keys" : null);

    // Rec #90 — keep CharacterOption checkboxes in sync with server truth
    // (PlayerDescription on login, SetCharacterOption echoes). Updates the
    // live boxes in place so the page keeps its scroll position.
    let unsubStats = null;
    try {
      const client = window.__pluginClient ?? null;
      if (typeof client?.events?.on === "function") {
        const onStats = () => {
          if (env.charBoxes.size === 0) return;
          const c = getCharacterOptionContext();
          for (const [idx, cb] of env.charBoxes) {
            cb.checked = readCharacterOption(idx, c.handle, c.localCache);
          }
        };
        client.events.on("playerStatsUpdated", onStats);
        unsubStats = () => { try { client.events.off?.("playerStatsUpdated", onStats); } catch (_) {} };
      }
    } catch (e) {
      console.warn("[options-panel] playerStatsUpdated subscribe failed:", e);
    }

    return () => {
      endCapture();
      runPageCleanups();
      clearTimeout(statusTimer);
      try { unsubStats?.(); } catch (_) {}
      root.remove();
    };
  },
};
