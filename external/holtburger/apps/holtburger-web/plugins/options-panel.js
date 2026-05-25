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

const VIEW_STYLE_ID = "hb-options-view-style";

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
    .hb-opt-footer {
      flex: 0 0 auto;
      display: flex;
      gap: 4px;
      justify-content: flex-end;
      padding: 6px 8px;
      border-top: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
    }
    .hb-opt-btn {
      width: 64px;
      height: 22px;
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
  { id: "char",     label: "Character",render: stubTab("Character", "Auto-loot prefs / fellowship-XP/loot share defaults / PK opt-in. Maps to retail's CharacterOptionsPanel UI command group.") },
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
    const root = document.createElement("div");
    root.className = "hb-opt-root";

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
    root.appendChild(tabsEl);

    // Body — re-rendered per tab
    const bodyEl = document.createElement("div");
    bodyEl.className = "hb-opt-body";
    root.appendChild(bodyEl);

    // Footer with Apply / OK / Cancel
    const footer = document.createElement("div");
    footer.className = "hb-opt-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "hb-opt-btn";
    setAcText(cancelBtn, "Cancel");
    cancelBtn.addEventListener("click", () => {
      // graphics_settings.js commits on each control change, so a
      // pure "cancel = discard pending edits" path would need an
      // explicit pending-vs-saved diff. For now: close panel.
      window.__mainPanel?.closeView?.();
    });
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "hb-opt-btn";
    setAcText(applyBtn, "Apply");
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
    okBtn.addEventListener("click", () => {
      window.__mainPanel?.closeView?.();
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    footer.appendChild(okBtn);
    root.appendChild(footer);

    parentEl.appendChild(root);

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

    return () => {
      endCapture();
      root.remove();
    };
  },
};
