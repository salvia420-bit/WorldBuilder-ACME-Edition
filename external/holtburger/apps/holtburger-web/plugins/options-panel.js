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
// Controls tab — keybinding capture + persist.
//
// ACE has no server-side keybind protocol; the model is purely
// client-side, mirroring acclient.c's UIOption_ActionKeyMap. Each row
// in the Controls tab is one retail action (deduped from
// window.__acKeybindings by labelHash). The user clicks "Bind", we
// capture the next keydown, encode it as a portable JS shape, and
// persist to localStorage at LS_KEY_KEYBINDINGS. Esc cancels capture.
//
// Storage shape (LS_KEY_KEYBINDINGS = "holtburger_keybindings_v1"):
//   { [labelHash_hex_8]: { code, shift, ctrl, alt, meta } }
// where `code` is a KeyboardEvent.code string ("KeyW", "F5", "Space")
// and the four mods are booleans. The hex labelHash is the stable
// identifier — labels are localised and `inputMap` differs per
// alt-binding, but labelHash is invariant for an action.
//
// The 389 actions in window.__acKeybindings already carry retail
// defaults via `inputMap`, but we don't reverse-decode that bitfield
// to a KeyboardEvent.code today — too many edge cases (controller,
// chord modifiers, alt-bindings). Default rows render "—" until the
// user binds them. Existing handlers (WASD, F5, 1-9) stay hardcoded
// for now; future work threads these bindings into the dispatcher.

const LS_KEY_KEYBINDINGS = "holtburger_keybindings_v1";
let keybindingsCache = null;
let captureFor = null; // labelHash (hex string) currently in capture mode
let captureHandler = null;

// Local-action table — the keys the JS-side code actually consults.
// Distinct from the 389 retail-ActionMap entries (which are read-only
// for now). Synthetic labelHashes use the `0xFF00…` prefix to avoid
// collision with retail's lower-bit hashes; the prefix lets storage
// share `LS_KEY_KEYBINDINGS` with retail rebinds.
//
// Add a row here whenever a JS handler should consult getKeybindings —
// the row's labelHash + defaultCode is the contract.
const LOCAL_ACTIONS = [
  { labelHash: "0xFF000001", label: "Hotbar Slot 1", defaultCode: "Digit1" },
  { labelHash: "0xFF000002", label: "Hotbar Slot 2", defaultCode: "Digit2" },
  { labelHash: "0xFF000003", label: "Hotbar Slot 3", defaultCode: "Digit3" },
  { labelHash: "0xFF000004", label: "Hotbar Slot 4", defaultCode: "Digit4" },
  { labelHash: "0xFF000005", label: "Hotbar Slot 5", defaultCode: "Digit5" },
  { labelHash: "0xFF000006", label: "Hotbar Slot 6", defaultCode: "Digit6" },
  { labelHash: "0xFF000007", label: "Hotbar Slot 7", defaultCode: "Digit7" },
  { labelHash: "0xFF000008", label: "Hotbar Slot 8", defaultCode: "Digit8" },
  { labelHash: "0xFF000009", label: "Hotbar Slot 9", defaultCode: "Digit9" },
  { labelHash: "0xFF000010", label: "Close Panel / Popover", defaultCode: "Escape" },
  { labelHash: "0xFF000011", label: "Delete Selected Spell", defaultCode: "Delete" },
];

/** Stable identifiers for synthetic local actions — re-exported so
 *  handlers can `resolveLocalBinding(LOCAL_ACTION_IDS.CLOSE, "Escape")`
 *  without sprinkling hex literals. Keep in sync with LOCAL_ACTIONS. */
export const LOCAL_ACTION_IDS = Object.freeze({
  HOTBAR_1: "0xFF000001",
  HOTBAR_2: "0xFF000002",
  HOTBAR_3: "0xFF000003",
  HOTBAR_4: "0xFF000004",
  HOTBAR_5: "0xFF000005",
  HOTBAR_6: "0xFF000006",
  HOTBAR_7: "0xFF000007",
  HOTBAR_8: "0xFF000008",
  HOTBAR_9: "0xFF000009",
  CLOSE:    "0xFF000010",
  DELETE_SPELL: "0xFF000011",
});

function loadKeybindings() {
  if (keybindingsCache) return keybindingsCache;
  try {
    const raw = localStorage.getItem(LS_KEY_KEYBINDINGS);
    keybindingsCache = raw ? JSON.parse(raw) : {};
  } catch (_) {
    keybindingsCache = {};
  }
  return keybindingsCache;
}

function saveKeybindings() {
  try {
    localStorage.setItem(LS_KEY_KEYBINDINGS, JSON.stringify(keybindingsCache ?? {}));
  } catch (_) { /* quota / privacy mode — silent */ }
}

function formatBinding(b) {
  if (!b || !b.code) return "—";
  const parts = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  if (b.meta) parts.push("Meta");
  // Strip "Key" / "Digit" prefix for cleaner labels: "KeyW" → "W".
  let key = b.code;
  if (key.startsWith("Key")) key = key.slice(3);
  else if (key.startsWith("Digit")) key = key.slice(5);
  else if (key.startsWith("Numpad")) key = `Num ${key.slice(6)}`;
  parts.push(key);
  return parts.join("+");
}

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

    keybindingsCache = loadKeybindings();
    keybindingsCache[labelHashHex] = {
      code: ev.code,
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      meta: ev.metaKey,
    };
    saveKeybindings();
    endCapture();
    refresh();
  };
  window.addEventListener("keydown", captureHandler, true);
}

function clearBinding(labelHashHex, refresh) {
  keybindingsCache = loadKeybindings();
  if (keybindingsCache[labelHashHex]) {
    delete keybindingsCache[labelHashHex];
    saveKeybindings();
    refresh();
  }
}

// Build one row in the keybinding table. Used for both the local
// (functional) actions and the read-only retail-ActionMap rows.
// `defaultCode` is shown when no user override exists.
function buildBindingRow(labelHashHex, label, defaultCode, bindings, refresh) {
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
  const effectiveBinding = userBinding ?? (defaultCode ? { code: defaultCode } : null);
  const isDefault = !userBinding && !!defaultCode;
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
  clearBtn.addEventListener("click", () => clearBinding(labelHashHex, refresh));
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
  setAcText(note, "Click Bind, press a key (Esc to cancel). Local actions below route through live JS handlers. Retail ActionMap entries are read-only labels — server-side dispatch isn't wired yet.");
  bodyEl.appendChild(note);

  const bindings = loadKeybindings();
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

  // Retail ActionMap actions — informational, no live dispatch yet.
  const retailHeader = document.createElement("div");
  retailHeader.className = "hb-opt-section";
  setAcText(retailHeader, "Retail ActionMap (read-only labels)");
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

  // De-duplicate by labelHash to collapse the many input_maps that
  // share the same action (alt-bindings, controller, etc.) into one
  // visible row each.
  const byLabel = new Map();
  for (const a of actions) {
    if (!a.label) continue;
    if (!byLabel.has(a.labelHash)) byLabel.set(a.labelHash, a.label);
  }
  const rows = [...byLabel.entries()]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .slice(0, 200);

  for (const [hash, label] of rows) {
    const hashHex = `0x${hash.toString(16).toUpperCase().padStart(8, "0")}`;
    list.appendChild(buildBindingRow(hashHex, label, null, bindings, refresh));
  }
}

/**
 * Read the current keybindings table from localStorage.
 *
 * Exposed for future dispatchers that want to consult user-bound
 * keys before invoking hardcoded handlers. Returns a plain object
 * keyed by labelHash hex (`"0x..."`) — values are `{code, shift,
 * ctrl, alt, meta}` per `KeyboardEvent`.
 */
export function getKeybindings() {
  return loadKeybindings();
}

/**
 * Check if a KeyboardEvent matches a stored binding shape. Useful
 * for handlers that route through getKeybindings().
 *
 * @param {KeyboardEvent} ev
 * @param {{code: string, shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean}} binding
 * @returns {boolean}
 */
export function matchesBinding(ev, binding) {
  if (!binding || !binding.code) return false;
  return ev.code === binding.code
    && ev.shiftKey === !!binding.shift
    && ev.ctrlKey === !!binding.ctrl
    && ev.altKey === !!binding.alt
    && ev.metaKey === !!binding.meta;
}

/**
 * Resolve a synthetic-local-action keybinding to its effective
 * binding shape — user override if set, otherwise the default.
 *
 * @param {string} labelHashHex — e.g. "0xFF000001" for Hotbar Slot 1.
 * @param {string} defaultCode — KeyboardEvent.code default ("Digit1").
 * @returns {{code: string, shift: boolean, ctrl: boolean, alt: boolean, meta: boolean}}
 */
export function resolveLocalBinding(labelHashHex, defaultCode) {
  const b = loadKeybindings()[labelHashHex];
  if (b && b.code) return b;
  return { code: defaultCode, shift: false, ctrl: false, alt: false, meta: false };
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
