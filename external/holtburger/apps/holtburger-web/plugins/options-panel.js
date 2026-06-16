// Options view — main-panel port of retail's gmConfigUI (layout
// 0x21000029, ClassID 0x10000028).
//
// Retail layout decoded via chorizite-dump-layout-tree:
//   Root 0x100001FF — 292x600 panel
//     0x10000200 — 276x560 type-5 tab list with 8 tab entries
//                  (StringId → child element ID pairs)
//     0x10000201 — 16x560 scrollbar
//     0x100001FC — 80x32 button (StringId 163200057)  ← Apply
//     0x100001FD — 80x32 button (StringId 164267204)  ← OK
//     0x100001FE — 80x32 button (StringId 253245491)  ← Cancel
//   No image DIDs — the floaty-panel chrome (border + title) is
//   provided by the wrapping gmFloatyPanelUI, which we mirror with
//   main-panel's container slot (the same one that hosts Inventory /
//   Skills / Magic etc.).
//
// Follows the standard main-panel convention shared with
// plugins/character-info.js, inventory.js, journal-panel.js, etc:
//   - export `const view = { name, nameFor(ctx), mount(parentEl, ctx) }`
//   - main-panel owns the brass border + title strip + close X
//   - view body fills `parentEl` (absolute inset:0)
//   - styles use the shared `--hb-*` token system (brass / stone /
//     cream / serif) — not bar.js's older glass-morphism chrome
//
// Tabs:
//   1. Graphics  — embeds the existing ui/graphics_settings.js form
//                  (renderer flags + quality preset + subdiv level)
//   2-8. Audio / Network / Mouse / Controls / Chat / Character / About
//        — placeholder stubs marked "decoder pending" until each
//        retail sub-layout is wired (gmConfigUI's 8 tab content
//        templates each point to layout DataId 0x21000293 which is
//        a per-tab content layout — port one at a time as needed).
//
// Apply / OK / Cancel semantics match retail:
//   - Apply  — persist + keep panel open (so users can preview)
//   - OK     — persist + close
//   - Cancel — discard pending edits + close
//
// The graphics tab delegates persistence to ui/graphics_settings.js
// which already owns the `holtburger_graphics_v1` localStorage shape
// and the `hb-quality-changed` event. Other tabs are stubs and have
// no pending state to persist yet.

import * as graphicsSettings from "../ui/graphics_settings.js";
import { setAcText } from "../ui/ac_font.js";
import {
  LOCAL_ACTIONS,
  getKeybindings,
  setBinding,
  clearBinding,
  formatBinding,
  loadRetailKeyMap,
  getRetailKeyMap,
  lookupRetailDefault,
} from "../ui/keymap.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const VIEW_STYLE_ID = "hb-options-view-style";

// gmConfigUI — retail layout that drives the options panel.
// Element-id map confirmed by options_panel_layout_dump 2026-05-24:
//   0x100001FF — root panel (292×600 at 0,0)
//   0x10000200 — type-5 tab list (276×560 at 0,0)
//                In retail this is the combined tab strip + content
//                area (the 8 tab buttons live INSIDE the type-5
//                container, populated from StringId pairs via
//                StateDesc — which v1 fetch_layout does not yet
//                serialize, see G3 in layout-port-plan-2026-05-24.md).
//                Our impl splits this into a flex `.hb-opt-tabs`
//                strip on top + a scrollable `.hb-opt-body` below,
//                both contained within this layout-driven rectangle.
//   0x10000201 — scrollbar track (16×560 at 276,0)
//                Retail had an explicit scrollbar element to the
//                right of the tab list; we use CSS scrollbar on
//                .hb-opt-body so this element is intentionally
//                non-DOM (geometry stays available for future
//                explicit-scrollbar pass).
//   0x100001FC — Apply button   (80×32 at 16,564)  StringId 163200057
//   0x100001FD — OK button      (80×32 at 106,564) StringId 164267204
//   0x100001FE — Cancel button  (80×32 at 196,564) StringId 253245491
//
// Per the plugin head-comment, sub-layout 0x21000293 holds per-tab
// content templates. That layout is referenced via StateDesc inside
// 0x10000200 (the type-5 tab list) and is NOT surfaced by v1
// fetch_layout (G3). Tab-label strings + per-tab content layouts
// remain hand-tuned until G3 lands.
const OPTIONS_LAYOUT_ID         = 0x21000029;
// Reference-only:
//   0x100001FF — 292×600 root (size applied via main-panel overlay resize).
//   0x10000201 — (276,0) 16×560 scrollbar slot, replaced by CSS scrollbar.
const OPT_ELEM_TAB_LIST         = 0x10000200;
const OPT_ELEM_BTN_APPLY        = 0x100001FC;
const OPT_ELEM_BTN_OK           = 0x100001FD;
const OPT_ELEM_BTN_CANCEL       = 0x100001FE;

function ensureStyles() {
  if (document.getElementById(VIEW_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = VIEW_STYLE_ID;
  style.textContent = `
    .hb-opt-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
    }
    /* Tab strip + body live inside the retail tab-list area
       (0x10000200 — 276×560 at 0,0). applyOptionsPanelLayout()
       positions .hb-opt-tablist absolutely; .hb-opt-tabs is the
       fixed-height strip on top (28px) and .hb-opt-body fills the
       remaining height inside the tablist box. */
    .hb-opt-tablist {
      position: absolute;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .hb-opt-tabs {
      flex: 0 0 auto;
      display: flex;
      flex-wrap: wrap;
      gap: 1px;
      padding: 4px 6px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-opt-tab {
      padding: 3px 8px;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .hb-opt-tab:hover { background: var(--hb-overlay-hover); }
    .hb-opt-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    .hb-opt-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 8px 10px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
      color: var(--hb-text-cream);
      font-size: 11px;
    }
    .hb-opt-body .hb-opt-section {
      font-size: 9px;
      color: var(--hb-text-gold);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      padding-bottom: 3px;
      margin: 8px 0 6px;
    }
    .hb-opt-body .hb-opt-section:first-child { margin-top: 2px; }
    .hb-opt-body .hb-opt-row,
    .hb-opt-body .hb-settings-row,
    .hb-opt-body .hb-graphics-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 11px;
    }
    .hb-opt-body label {
      flex: 1 1 auto;
      color: var(--hb-text-cream);
    }
    .hb-opt-body input[type="checkbox"] {
      flex: 0 0 auto;
      width: 14px; height: 14px;
      accent-color: var(--hb-text-gold);
    }
    .hb-opt-body input[type="range"] {
      flex: 1 1 90px;
      min-width: 0;
    }
    .hb-opt-body select,
    .hb-opt-body .hb-graphics-select {
      flex: 0 0 auto;
      background: var(--hb-overlay-dark-deep);
      color: var(--hb-text-cream);
      border: 1px solid var(--hb-border-brass-dim);
      border-radius: 2px;
      font-family: inherit;
      font-size: 11px;
      padding: 1px 3px;
    }
    .hb-opt-body .hb-settings-val {
      flex: 0 0 36px;
      text-align: right;
      color: var(--hb-text-gold-dim);
      font-variant-numeric: tabular-nums;
      font-size: 10px;
    }
    .hb-opt-body .hb-graphics-tag {
      flex: 0 0 auto;
      color: var(--hb-text-muted-3);
      font-size: 9px;
      margin-left: 4px;
    }
    .hb-opt-body .hb-graphics-reload {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
      padding: 6px 8px;
      background: rgba(120, 84, 32, 0.18);
      border: 1px solid var(--hb-border-brass);
      border-radius: 3px;
      color: var(--hb-text-cream-bright);
      font-size: 10px;
    }
    .hb-opt-body .hb-settings-btnrow {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .hb-opt-body .hb-settings-btn {
      padding: 3px 10px;
      background: linear-gradient(180deg, rgba(120, 84, 32, 0.45) 0%, rgba(50, 35, 15, 0.55) 100%);
      color: var(--hb-text-cream-bright);
      border: 1px solid var(--hb-border-brass);
      border-radius: 2px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      letter-spacing: 0.04em;
      cursor: pointer;
    }
    .hb-opt-body .hb-settings-btn:hover {
      background: linear-gradient(180deg, rgba(150, 105, 40, 0.55) 0%, rgba(70, 50, 20, 0.65) 100%);
      color: var(--hb-text-gold);
    }
    .hb-opt-body .hb-settings-btn:active {
      background: linear-gradient(180deg, rgba(40, 25, 10, 0.7) 0%, rgba(80, 55, 20, 0.5) 100%);
    }
    .hb-opt-body .hb-settings-btn.active {
      background: linear-gradient(180deg, rgba(180, 130, 50, 0.6) 0%, rgba(90, 60, 25, 0.7) 100%);
      color: var(--hb-text-gold);
      border-color: var(--hb-text-gold-dim);
    }
    .hb-opt-stub {
      padding: 20px 8px;
      text-align: center;
      color: var(--hb-text-muted-3);
      font-style: italic;
      font-size: 11px;
      line-height: 1.6;
    }
    .hb-opt-stub b {
      color: var(--hb-text-cream);
      font-style: normal;
    }
    /* Cancel / Apply / OK buttons live as direct root children
       (matching retail's gmConfigUI 0x100001FC/FD/FE — siblings of
       the tab list 0x10000200 under panel root 0x100001FF).
       applyOptionsPanelLayout writes their explicit x/y/w/h
       (80×32 at 16/106/196, y=564). */
    .hb-opt-btn {
      position: absolute;
      box-sizing: border-box;
      padding: 0;
      background: linear-gradient(180deg, rgba(120, 84, 32, 0.55) 0%, rgba(50, 35, 15, 0.7) 100%);
      color: var(--hb-text-cream-bright);
      border: 1px solid var(--hb-border-brass);
      border-radius: 2px;
      font-family: var(--hb-font-serif);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      cursor: pointer;
    }
    .hb-opt-btn:hover {
      background: linear-gradient(180deg, rgba(150, 105, 40, 0.65) 0%, rgba(70, 50, 20, 0.75) 100%);
      color: var(--hb-text-gold);
    }
    .hb-opt-btn:active {
      background: linear-gradient(180deg, rgba(40, 25, 10, 0.75) 0%, rgba(80, 55, 20, 0.6) 100%);
    }
    .hb-opt-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
    .hb-opt-btn.primary { color: var(--hb-text-gold); }
  `;
  document.head.appendChild(style);
}

// Tab definitions. Order mirrors retail's 8-tab list in gmConfigUI's
// 0x10000200 element. Labels are descriptive placeholders until the
// retail StringIds (~0x10000256+) are decoded from a per-tab layout
// content lookup.
const TABS = [
  { id: "graphics", label: "Graphics", render: renderGraphicsTab },
  { id: "audio",    label: "Audio",    render: stubTab("Audio", "Master volume / SFX / music / ambient / voice / chat sounds. Wires to AudioManager + AmbientRuntime — see scene3d/sound_table.js.") },
  { id: "mouse",    label: "Mouse",    render: stubTab("Mouse & Camera", "Mouse-turn sensitivity / invert / camera distance / FOV. Plumbing already exists in scene3d/picking.js + ui/graphics_settings.js (FOV slider).") },
  { id: "controls", label: "Controls", render: renderControlsTab },
  { id: "chat",     label: "Chat",     render: stubTab("Chat", "Channel colours / timestamps / per-channel mute. Plumbing partially in plugins/chat-panel.js (tab filters).") },
  { id: "network",  label: "Network",  render: stubTab("Network", "Server latency display / packet-loss warning / autoreconnect. Surfacing requires Login_WorldInfo bus event (api.js coverage row 8 — currently MISSING).") },
  { id: "char",     label: "Character",render: renderCharacterTab },
  { id: "about",    label: "About",    render: renderAboutTab },
];

function stubTab(title, blurb) {
  return (bodyEl) => {
    bodyEl.innerHTML = `
      <div class="hb-opt-stub">
        <b>${title}</b><br>
        ${blurb}<br><br>
        <i>(Retail layout port pending — gmConfigUI tab content layout 0x21000293, decode StringId for tab label.)</i>
      </div>
    `;
  };
}

// ---------------------------------------------------------------------
// Controls tab — keybinding capture + persist UI.
//
// Data layer (storage, defaults, matchers, the LOCAL_ACTIONS table)
// lives in ../ui/keymap.js. This block owns capture orchestration and
// the row-rendering helper.

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

// Build one row in the keybinding table. Used for both the local
// (functional) actions and the read-only retail-ActionMap rows.
// `defaultBinding` is what's shown when no user override exists. It
// accepts:
//   - a string (KeyboardEvent.code, e.g. "Digit1") — for local actions
//     that ship hard-coded defaults;
//   - a {code, shift, ctrl, alt, meta} object — for retail-KeyMap
//     defaults that may carry modifiers;
//   - null — for retail actions with no default in the loaded KeyMap.
function buildBindingRow(labelHashHex, label, defaultBinding, bindings, refresh) {
  const defaultBindingObj = (typeof defaultBinding === "string")
    ? { code: defaultBinding, shift: false, ctrl: false, alt: false, meta: false }
    : defaultBinding;

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "8px";
  row.style.padding = "2px 4px";
  row.style.borderBottom = "1px solid rgba(138, 117, 68, 0.15)";

  const l = document.createElement("span");
  l.style.flex = "1 1 auto";
  setAcText(l, label);
  row.appendChild(l);

  const k = document.createElement("span");
  k.style.flex = "0 0 110px";
  k.style.textAlign = "right";
  k.style.opacity = "0.85";
  const inCapture = captureFor === labelHashHex;
  const userBinding = bindings[labelHashHex];
  const effectiveBinding = userBinding ?? defaultBindingObj;
  const isDefault = !userBinding && !!defaultBindingObj;
  const text = inCapture
    ? "Press a key… (Esc=cancel)"
    : (effectiveBinding ? formatBinding(effectiveBinding) + (isDefault ? " (default)" : "") : "—");
  setAcText(k, text, { color: inCapture ? "#f0c87c" : (isDefault ? "#a8a090" : "#f0d8a0") });
  row.appendChild(k);

  const bindBtn = document.createElement("button");
  bindBtn.type = "button";
  bindBtn.style.flex = "0 0 auto";
  bindBtn.style.padding = "1px 6px";
  bindBtn.style.fontSize = "10px";
  bindBtn.style.cursor = "pointer";
  setAcText(bindBtn, inCapture ? "Cancel" : "Bind");
  bindBtn.addEventListener("click", () => {
    if (inCapture) { endCapture(); refresh(); }
    else startCapture(labelHashHex, refresh);
  });
  row.appendChild(bindBtn);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.style.flex = "0 0 auto";
  clearBtn.style.padding = "1px 6px";
  clearBtn.style.fontSize = "10px";
  clearBtn.style.cursor = "pointer";
  clearBtn.disabled = !userBinding;
  setAcText(clearBtn, "×");
  clearBtn.addEventListener("click", () => { if (clearBinding(labelHashHex)) refresh(); });
  row.appendChild(clearBtn);

  return row;
}

function renderControlsTab(bodyEl) {
  bodyEl.innerHTML = "";

  const title = document.createElement("div");
  title.className = "hb-opt-section";
  setAcText(title, "Key Bindings");
  bodyEl.appendChild(title);

  const note = document.createElement("div");
  note.style.marginBottom = "8px";
  note.style.opacity = "0.75";
  setAcText(note, "Click Bind, press a key (Esc to cancel). Local actions below route through live JS handlers. Retail actions are grouped by their ActionMap category and show their factory-default key (from KeyMap 0x14000000 / gmDefaultMap).");
  bodyEl.appendChild(note);

  const bindings = getKeybindings();
  const refresh = () => renderControlsTab(bodyEl);

  // Local (functional) actions — JS handlers consult these.
  const localHeader = document.createElement("div");
  localHeader.className = "hb-opt-section";
  localHeader.style.marginTop = "0";
  setAcText(localHeader, "Local Actions");
  bodyEl.appendChild(localHeader);

  const localList = document.createElement("div");
  localList.style.background = "rgba(0, 0, 0, 0.35)";
  localList.style.border = "1px solid var(--hb-border-brass-dim)";
  localList.style.padding = "4px 6px";
  localList.style.marginBottom = "12px";
  localList.style.fontFamily = "var(--hb-font-mono)";
  localList.style.fontSize = "11px";
  bodyEl.appendChild(localList);

  for (const action of LOCAL_ACTIONS) {
    localList.appendChild(buildBindingRow(action.labelHash, action.label, action.defaultCode, bindings, refresh));
  }

  // Retail ActionMap actions — grouped by inputMap category. Each entry
  // in __acKeybindings carries an `inputMap` field (ActionMap outer-dict
  // key — categories like Movement / Camera / Magic). Defaults for each
  // action come from the retail KeyMap (gmDefaultMap, DAT 0x14000000),
  // joined by (inputMap, actionHash) — the action_hash field in KeyMap
  // mappings matches ActionMap's inner-dict key 114-hit / 0-miss across
  // gmDefaultMap (see external/holtburger/docs/keymap_actionmap_xcheck).
  const retailHeader = document.createElement("div");
  retailHeader.className = "hb-opt-section";
  setAcText(retailHeader, "Retail Actions (grouped by ActionMap category)");
  bodyEl.appendChild(retailHeader);

  const list = document.createElement("div");
  list.style.maxHeight = "240px";
  list.style.overflowY = "auto";
  list.style.background = "rgba(0, 0, 0, 0.35)";
  list.style.border = "1px solid var(--hb-border-brass-dim)";
  list.style.padding = "4px 6px";
  list.style.fontFamily = "var(--hb-font-mono)";
  list.style.fontSize = "11px";
  bodyEl.appendChild(list);

  const actions = window.__acKeybindings;
  if (!Array.isArray(actions) || actions.length === 0) {
    setAcText(list, "(loading — open the Controls tab again in a few seconds)");
    return;
  }

  // Kick off retail KeyMap load if it hasn't started yet. Defaults are
  // shown only when the load completes — re-render once loaded so users
  // who open the tab during the (~1s) wasm fetch see the "(default)" col
  // appear without manual refresh.
  if (!getRetailKeyMap()) {
    loadRetailKeyMap().then((km) => { if (km) refresh(); }).catch(() => {});
  }

  // Group by (inputMap category) → Map<labelHash, {label, actionHash}>.
  // Deduping by labelHash collapses alt-bindings into one row; we keep
  // the first actionHash seen so KeyMap lookup has a join key.
  const byCategory = new Map();
  for (const a of actions) {
    if (!a.label) continue;
    let group = byCategory.get(a.inputMap);
    if (!group) { group = new Map(); byCategory.set(a.inputMap, group); }
    if (!group.has(a.labelHash)) {
      group.set(a.labelHash, { label: a.label, actionHash: a.actionHash });
    }
  }

  // Stable category ordering: numerically by inputMap (0x000000xx first
  // then 0x100000xx) so Movement/Camera lead, then combat/magic/etc.
  const orderedCats = [...byCategory.keys()].sort((a, b) => a - b);

  for (const inputMap of orderedCats) {
    const group = byCategory.get(inputMap);
    if (group.size === 0) continue;
    const catName = ACTION_CATEGORY_NAMES[inputMap]
      ?? `Category 0x${inputMap.toString(16).toUpperCase().padStart(8, "0")}`;

    const catHeader = document.createElement("div");
    catHeader.style.padding = "6px 4px 2px";
    catHeader.style.fontSize = "10px";
    catHeader.style.color = "#6acaca";
    catHeader.style.textTransform = "uppercase";
    catHeader.style.letterSpacing = "0.08em";
    catHeader.style.borderBottom = "1px solid rgba(106, 202, 202, 0.3)";
    catHeader.style.marginTop = "4px";
    setAcText(catHeader, `${catName} — ${group.size}`, { color: "#6acaca" });
    list.appendChild(catHeader);

    const sortedActions = [...group.entries()].sort(([, a], [, b]) => a.label.localeCompare(b.label));
    for (const [labelHash, info] of sortedActions) {
      const hashHex = `0x${labelHash.toString(16).toUpperCase().padStart(8, "0")}`;
      const retailDefault = lookupRetailDefault(inputMap, info.actionHash);
      list.appendChild(buildBindingRow(hashHex, info.label, retailDefault, bindings, refresh));
    }
  }
}

// inputMap (ActionMap outer-key) → human-readable category name.
// Derived from the action labels in each category (see
// /mnt/wbterminal1/tmp/claude-scratch/actionmap/ for the survey).
// Categories with no named actions are omitted; renderer falls back to
// "Category 0x…" for any unmapped value that does carry actions.
const ACTION_CATEGORY_NAMES = {
  0x00000004: "Movement",
  0x00000005: "Camera",
  0x00000006: "Camera (alt)",
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

// ---------------------------------------------------------------------
// Character tab — CharacterOption bitfield toggles.
//
// Each row sends `sessionHandle.setCharacterOption(option, value)` on
// change (wasm fan-out: SessionCommand::SetCharacterOption →
// GameAction::SetSingleCharacterOption sub-opcode 0x0167, ACE handler
// `Player_Character.cs:80-106`). ACE persists to the Character row's
// `CharacterOptions1` / `CharacterOptions2` columns and echoes back via
// `Private/PublicUpdatePropertyInt`; the existing player-stats pipeline
// consumes the echo.
//
// The `option` value is the `holtburger_common::CharacterOption` enum
// INDEX (0..0x36 — `crates/holtburger-common/src/character.rs:117`),
// NOT the retail bitfield mask (which uses 0x2 / 0x200000 / 0x10000000
// style bit values). The wasm side validates the index via FromRepr
// before serializing.
//
// We hold the last user click in `LS_CHAR_OPTIONS_KEY` so the panel
// can render the right checkbox state on reopen. Server-side authority
// remains the truth — a future follow-up will reconcile by reading
// CharacterOptions1/2 off the player-stats stream.

const LS_CHAR_OPTIONS_KEY = "holtburger_character_options_v1";

// Subset of CharacterOption indices exposed in v1 of the Character tab.
// Grouped roughly by retail's gmConfigUI Character sub-panel layout.
// Add more entries as the panel matures.
// Rec #89 — full ACE CharacterOption catalog (0x00-0x34 inclusive)
// per ace-server Source/ACE.Entity/Enum/CharacterOption.cs. Indices
// not listed below are intentionally excluded: 0x0E
// VividTargetingIndicator routes through scene3d/target_ring.js
// (pass-1 #129 fable-skip). 0x35 / 0x36 are *Default sentinels.
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
    section: "Movement & Camera",
    options: [
      { idx: 0x0A, label: "Run as default movement" },
      { idx: 0x31, label: "Use mouse turning" },
    ],
  },
  {
    section: "Interface",
    options: [
      { idx: 0x13, label: "Side-by-side vitals" },
      { idx: 0x14, label: "Show coordinates by the radar" },
      { idx: 0x15, label: "Display spell durations" },
      { idx: 0x08, label: "Display 3D tooltips" },
      { idx: 0x21, label: "Display timestamps" },
      { idx: 0x0B, label: "Stay in chat mode after sending" },
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
    section: "Chat channels",
    options: [
      { idx: 0x1B, label: "Listen to allegiance chat" },
      { idx: 0x23, label: "Listen to general chat" },
      { idx: 0x24, label: "Listen to trade chat" },
      { idx: 0x25, label: "Listen to LFG chat" },
      { idx: 0x26, label: "Listen to roleplay chat" },
      { idx: 0x2E, label: "Listen to society chat" },
      { idx: 0x34, label: "Listen to PK death messages" },
      { idx: 0x2C, label: "Filter language" },
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

// Pull the current state of a CharacterOption — prefer the server-
// authoritative bits exposed by `isCharacterOptionEnabled` (hydrated by
// `PlayerDescription` on login, optimistically updated in the wasm
// SetCharacterOption arm). Fall back to the localStorage cache when
// offline (pre-login or wasm method absent — older bundle).
function readCharacterOption(idx, handle, localCache) {
  if (handle && typeof handle.isCharacterOptionEnabled === "function") {
    try { return !!handle.isCharacterOptionEnabled(idx >>> 0); }
    catch (_) { /* unknown index — fall back to local cache */ }
  }
  return !!localCache[String(idx)];
}

function renderCharacterTab(bodyEl) {
  bodyEl.innerHTML = "";
  const localCache = loadCharacterOptions();
  const handle = window.__sessionHandle ?? null;
  const offline = !handle || typeof handle.setCharacterOption !== "function";
  const hasServerState =
    !!handle && typeof handle.isCharacterOptionEnabled === "function";

  if (offline) {
    const banner = document.createElement("div");
    banner.className = "hb-opt-stub";
    banner.style.marginBottom = "10px";
    banner.innerHTML =
      "<b>Offline preview</b><br>Toggles record locally but won't sync to the server until login completes.";
    bodyEl.appendChild(banner);
  } else if (!hasServerState) {
    const banner = document.createElement("div");
    banner.className = "hb-opt-stub";
    banner.style.marginBottom = "10px";
    banner.innerHTML =
      "<b>Local-state mode</b><br>Wasm bundle predates the <code>isCharacterOptionEnabled</code> getter — toggles still sync via <code>setCharacterOption</code> but checkboxes read from localStorage. Refresh after the next wasm rebuild.";
    bodyEl.appendChild(banner);
  }

  for (const group of CHARACTER_OPTION_GROUPS) {
    const sec = document.createElement("div");
    sec.className = "hb-opt-section";
    setAcText(sec, group.section);
    bodyEl.appendChild(sec);
    for (const opt of group.options) {
      const row = document.createElement("label");
      row.className = "hb-opt-row";
      row.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:4px 8px;cursor:pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = readCharacterOption(opt.idx, handle, localCache);
      cb.style.cssText = "accent-color: var(--hb-text-gold);";
      // HUD rec #106 — when offline, the banner above already tells the
      // player toggles won't sync. Enforce that by disabling the inputs
      // so flipping a checkbox doesn't write a localStorage row that the
      // next login could then push to the server unexpectedly.
      if (offline) {
        cb.disabled = true;
        row.style.opacity = "0.6";
        row.style.cursor = "not-allowed";
      }
      cb.addEventListener("change", () => {
        const value = cb.checked;
        saveCharacterOption(opt.idx, value);
        try {
          handle?.setCharacterOption?.(opt.idx >>> 0, value);
        } catch (e) {
          // Wire failure is best-effort — keep local state, log only.
          console.warn(
            `[options-panel] setCharacterOption(0x${opt.idx.toString(16)}=${value}) failed:`,
            e,
          );
        }
      });
      const label = document.createElement("ac-text");
      label.textContent = opt.label;
      row.appendChild(cb);
      row.appendChild(label);
      bodyEl.appendChild(row);
    }
  }
}

function renderAboutTab(bodyEl) {
  bodyEl.innerHTML = `
    <div class="hb-opt-section">Holtburger</div>
    <div>Asheron's Call retail client port — Wave 2.</div>
    <div class="hb-opt-section" style="margin-top:14px">Sources</div>
    <div>ACE.Server &middot; Chorizite.ACProtocol &middot; DatReaderWriter &middot; acclient.c</div>
    <div class="hb-opt-section" style="margin-top:14px">UI</div>
    <div>Retail gmConfigUI (layout 0x21000029) + brass / stone / serif theme tokens.</div>
  `;
}

function renderGraphicsTab(bodyEl) {
  // Delegate to ui/graphics_settings.js — it already owns the form
  // building + localStorage persistence + `hb-quality-changed`
  // events. Pass the body element directly; its CSS class names
  // (hb-graphics-row, hb-settings-btn, etc.) are re-styled by our
  // .hb-opt-body scoped rules above so they pick up the brass /
  // stone palette instead of bar.js's older glass chrome.
  graphicsSettings.renderGraphicsTab(bodyEl, {
    onAnyChange: () => { /* persistence handled inside graphics_settings */ },
  });
}

// Apply gmConfigUI 0x21000029 layout to the options-panel sub-elements.
// Options panel mounts via main-panel.showView() (user-initiated), so
// wasm IS ready by then — no 8 × 2s retry loop needed. We still guard
// against a transient null layout (G3 / shard prefetch) by retrying
// 3 × 1s; if it never lands we keep the hand-tuned fallback positions
// from CSS.
//
// Retail dims:
//   - root (panel): 292×600 — sized via parentEl resize in view.mount
//   - tab list (combined tab strip + content area): 276×560 at (0,0)
//   - Apply/OK/Cancel buttons: 80×32 at (16/106/196, 564)
//
// Geometry is applied relative to the view root (the main-panel
// body), so .hb-opt-root spans the full 292×600 body and child
// elements get layout-driven x/y/width/height.
function applyOptionsPanelLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 3) {
        setTimeout(() => applyOptionsPanelLayout(refs, attempt + 1), 1000);
      }
      return;
    }
    let applied = 0;
    // Pairs: (element_id, DOM ref). We map retail elements to our DOM:
    //   - tab list (0x10000200) → .hb-opt-tablist wrapper (which holds
    //     both the tab strip and the scrolled body)
    //   - Apply/OK/Cancel buttons → direct children of .hb-opt-root
    //     (same as retail; the buttons are root-level, not nested in
    //     a footer wrapper)
    // Root (0x100001FF) and scrollbar (0x10000201) are intentionally
    // NOT in this map: root sizing is applied to the main-panel
    // overlay directly (so the retail chrome dims drive both the
    // visible window and the body); the scrollbar element is replaced
    // by a CSS scrollbar on .hb-opt-body, per the head-comment.
    const pairs = [
      [OPT_ELEM_TAB_LIST,   refs.tablistEl],
      [OPT_ELEM_BTN_APPLY,  refs.applyBtnEl],
      [OPT_ELEM_BTN_OK,     refs.okBtnEl],
      [OPT_ELEM_BTN_CANCEL, refs.cancelBtnEl],
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      // Clear conflicting CSS anchors (right/bottom) so explicit
      // left/top win — same pattern as radar/chat-panel ports.
      el.style.right = "";
      el.style.bottom = "";
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }
    // Per-tab content (0x21000293) is NOT applied here — that
    // layout drives the inner widgets per tab (Graphics radio
    // buttons, Audio sliders, etc) and is gated by StateDesc which
    // v1 fetch_layout does not yet serialize. See G3 in
    // docs/layout-port-plan-2026-05-24.md.
    try {
      window.__diag?.layout?.onOptionsPanelApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(OPTIONS_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(OPTIONS_LAYOUT_ID).then(apply).catch(() => {});
}

// Resize the main-panel overlay to match retail's 292×600 root
// while this view is mounted; restore previous dims on cleanup.
// Border-box accounts for the 6-px border on each side; the
// 25-px title strip is part of main-panel's chrome (gmFloatyPanelUI
// equivalent) and sits ABOVE the body — so overlay height = 25
// (title) + 600 (body) + 12 (top/bottom border) = 637.
//
// retail width = 292 + 12 (border) = 304 (overlay box-sizing:border-box
//   makes the inner content area = 292).
const OPTIONS_OVERLAY_WIDTH = 292 + 12;   // 304
const OPTIONS_OVERLAY_HEIGHT = 25 + 600 + 12; // 637

function resizeMainPanelForOptions() {
  const overlay = document.getElementById("hb-main-panel");
  if (!overlay) return null;
  const prev = {
    width: overlay.style.width,
    height: overlay.style.height,
  };
  overlay.style.width = `${OPTIONS_OVERLAY_WIDTH}px`;
  overlay.style.height = `${OPTIONS_OVERLAY_HEIGHT}px`;
  return prev;
}

function restoreMainPanelSize(prev) {
  if (!prev) return;
  const overlay = document.getElementById("hb-main-panel");
  if (!overlay) return;
  overlay.style.width = prev.width;
  overlay.style.height = prev.height;
}

// Public view export — main-panel registration site is in index.html
// (`mainPanelPlugin.registerView("options", optionsPanelPlugin.view)`).
export const view = {
  name: "Options",
  nameFor: (ctx) => {
    const t = TABS.find((x) => x.id === (ctx?.tab || "graphics"));
    return t ? `Options — ${t.label}` : "Options";
  },
  mount: (parentEl, ctx) => {
    ensureStyles();
    // Resize main-panel to retail's 292×600 root for the duration of
    // this view (restored in cleanup).
    const prevMainPanelSize = resizeMainPanelForOptions();

    const root = document.createElement("div");
    root.className = "hb-opt-root";

    // Tab list wrapper — corresponds to retail element 0x10000200
    // (the type-5 tab list container). applyOptionsPanelLayout()
    // positions it absolutely (276×560 at 0,0). Holds both the tab
    // strip and the scrolled body in our impl (retail puts both
    // inside the type-5 element, populated via StateDesc).
    const tablistEl = document.createElement("div");
    tablistEl.className = "hb-opt-tablist";
    // Fallback CSS-driven dims if layout doesn't load.
    tablistEl.style.left = "0";
    tablistEl.style.top = "0";
    tablistEl.style.width = "276px";
    tablistEl.style.height = "560px";

    // Tab strip
    const tabsEl = document.createElement("div");
    tabsEl.className = "hb-opt-tabs";
    const tabBtns = {};
    let activeId = ctx?.tab || "graphics";

    for (const t of TABS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hb-opt-tab" + (t.id === activeId ? " active" : "");
      b.dataset.tab = t.id;
      setAcText(b, t.label);
      b.addEventListener("click", () => switchTo(t.id));
      tabsEl.appendChild(b);
      tabBtns[t.id] = b;
    }
    tablistEl.appendChild(tabsEl);

    // Body — re-rendered per tab. Lives inside tablistEl so the
    // tab strip + body together form the type-5 area.
    const bodyEl = document.createElement("div");
    bodyEl.className = "hb-opt-body";
    tablistEl.appendChild(bodyEl);

    root.appendChild(tablistEl);

    // Cancel / Apply / OK buttons as direct root children (same as
    // retail — they're siblings of the tab list under panel root).
    // Layout positions them at (16/106/196, 564) all 80×32. Per
    // the head-comment dump:
    //   0x100001FC ← Apply  (left)
    //   0x100001FD ← OK     (middle)
    //   0x100001FE ← Cancel (right)
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "hb-opt-btn";
    setAcText(applyBtn, "Apply");
    // Fallback CSS dims (layout overrides these).
    applyBtn.style.left = "16px";
    applyBtn.style.top = "564px";
    applyBtn.style.width = "80px";
    applyBtn.style.height = "32px";
    applyBtn.addEventListener("click", () => {
      // Persistence is per-control today; explicit Apply is a no-op
      // pending the diff-based pending-state model. Flash the button
      // to acknowledge the click.
      applyBtn.classList.add("active");
      setTimeout(() => applyBtn.classList.remove("active"), 200);
    });

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "hb-opt-btn primary";
    setAcText(okBtn, "OK");
    okBtn.style.left = "106px";
    okBtn.style.top = "564px";
    okBtn.style.width = "80px";
    okBtn.style.height = "32px";
    okBtn.addEventListener("click", () => {
      window.__mainPanel?.closeView?.();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "hb-opt-btn";
    setAcText(cancelBtn, "Cancel");
    cancelBtn.style.left = "196px";
    cancelBtn.style.top = "564px";
    cancelBtn.style.width = "80px";
    cancelBtn.style.height = "32px";
    cancelBtn.addEventListener("click", () => {
      // graphics_settings.js commits on each control change, so a
      // pure "cancel = discard pending edits" path would need an
      // explicit pending-vs-saved diff. For now: close panel.
      window.__mainPanel?.closeView?.();
    });

    // Append in retail read-order: Apply, OK, Cancel.
    root.appendChild(applyBtn);
    root.appendChild(okBtn);
    root.appendChild(cancelBtn);

    parentEl.appendChild(root);

    // Apply retail layout positions to tab list + 3 buttons.
    // Wasm is ready at this point (view mounted via user-initiated
    // showView, not early-boot mountBar), so layout typically lands
    // on first call. 3 × 1s retry covers transient null from a
    // late-arriving eor/local shard.
    applyOptionsPanelLayout({
      tablistEl,
      applyBtnEl: applyBtn,
      okBtnEl: okBtn,
      cancelBtnEl: cancelBtn,
    });

    function switchTo(tabId) {
      // Cancel any in-flight keybind capture when leaving Controls.
      if (activeId === "controls" && tabId !== "controls") endCapture();
      activeId = tabId;
      for (const id of Object.keys(tabBtns)) {
        tabBtns[id].classList.toggle("active", id === tabId);
      }
      bodyEl.innerHTML = "";
      const t = TABS.find((x) => x.id === tabId);
      if (t) t.render(bodyEl);
      // Update main-panel title strip via nameFor convention.
      window.__mainPanel?.refreshTitle?.();
    }

    // Initial render
    const initial = TABS.find((x) => x.id === activeId) || TABS[0];
    initial.render(bodyEl);

    // Rec #90 — re-render the Character tab whenever the player's
    // CharacterOptions bits change server-side. The wasm side fires
    // playerStatsUpdated on each PlayerDescription drain + after every
    // accepted SetCharacterOption echo, so this catches both the login
    // hydration ("server truth replaces empty localStorage on first
    // arrival") and any out-of-band toggle from /options-style command
    // flows. Only refresh when the tab is the one actually visible to
    // avoid wasting render cycles on other tabs.
    let _charStatsUnsub = null;
    try {
      const client = window.__pluginClient ?? null;
      if (typeof client?.events?.on === "function") {
        const onStats = () => {
          if (activeId !== "char") return;
          const t = TABS.find((x) => x.id === "char");
          if (!t) return;
          bodyEl.innerHTML = "";
          t.render(bodyEl);
        };
        client.events.on("playerStatsUpdated", onStats);
        _charStatsUnsub = () => {
          try { client.events.off?.("playerStatsUpdated", onStats); } catch (_) {}
        };
      }
    } catch (e) {
      console.warn("[options-panel] playerStatsUpdated subscribe failed:", e);
    }

    return () => {
      endCapture();
      try { _charStatsUnsub?.(); } catch (_) {}
      root.remove();
      restoreMainPanelSize(prevMainPanelSize);
    };
  },
};
