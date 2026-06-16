/**
 * Client-side keybinding storage + matching primitives.
 *
 * Mirrors acclient.c's UIOption_ActionKeyMap model — purely local
 * (ACE has no server-side keybind protocol). Two layers:
 *
 *   - "Local actions" (LOCAL_ACTIONS): synthetic labelHashes that
 *     the JS handlers actually consult. Each has a default code
 *     so handlers work out of the box; users can override via the
 *     Options → Controls tab.
 *   - Retail-ActionMap actions: keyed by labelHash from the retail
 *     0x26000000 record. Read-only labels today — server-side
 *     dispatch isn't wired yet.
 *
 * Both share the same localStorage table at LS_KEY_KEYBINDINGS so
 * the UI can manage them with one rebind flow.
 *
 * The Controls tab in plugins/options-panel.js owns the capture +
 * render UI; this module owns the data layer.
 */

import { getActionMap } from "./ac_strings.js";

export const LS_KEY_KEYBINDINGS = "holtburger_keybindings_v1";

/**
 * The local-action table — the keys the JS-side code actually
 * consults. Add a row here whenever a JS handler should be
 * user-rebindable. The row's labelHash + defaultCode is the contract.
 *
 * Synthetic labelHashes use the `0xFF00…` prefix to avoid collision
 * with retail's lower-bit hashes; the prefix lets storage share the
 * same localStorage table with retail rebinds.
 */
export const LOCAL_ACTIONS = [
  { labelHash: "0xFF000001", label: "Hotbar Slot 1", defaultCode: "Digit1" },
  { labelHash: "0xFF000002", label: "Hotbar Slot 2", defaultCode: "Digit2" },
  { labelHash: "0xFF000003", label: "Hotbar Slot 3", defaultCode: "Digit3" },
  { labelHash: "0xFF000004", label: "Hotbar Slot 4", defaultCode: "Digit4" },
  { labelHash: "0xFF000005", label: "Hotbar Slot 5", defaultCode: "Digit5" },
  { labelHash: "0xFF000006", label: "Hotbar Slot 6", defaultCode: "Digit6" },
  { labelHash: "0xFF000007", label: "Hotbar Slot 7", defaultCode: "Digit7" },
  { labelHash: "0xFF000008", label: "Hotbar Slot 8", defaultCode: "Digit8" },
  { labelHash: "0xFF000009", label: "Hotbar Slot 9", defaultCode: "Digit9" },
  // Row 2 (ShortcutBar2 in retail / Chorizite). Retail leaves these
  // unbound by default — players opt in via Options → Controls. Null
  // defaultCode = no default binding.
  { labelHash: "0xFF00000A", label: "Hotbar Row 2 Slot 1", defaultCode: null },
  { labelHash: "0xFF00000B", label: "Hotbar Row 2 Slot 2", defaultCode: null },
  { labelHash: "0xFF00000C", label: "Hotbar Row 2 Slot 3", defaultCode: null },
  { labelHash: "0xFF00000D", label: "Hotbar Row 2 Slot 4", defaultCode: null },
  { labelHash: "0xFF00000E", label: "Hotbar Row 2 Slot 5", defaultCode: null },
  { labelHash: "0xFF00000F", label: "Hotbar Row 2 Slot 6", defaultCode: null },
  { labelHash: "0xFF000012", label: "Hotbar Row 2 Slot 7", defaultCode: null },
  { labelHash: "0xFF000013", label: "Hotbar Row 2 Slot 8", defaultCode: null },
  { labelHash: "0xFF000014", label: "Hotbar Row 2 Slot 9", defaultCode: null },
  { labelHash: "0xFF000010", label: "Close Panel / Popover", defaultCode: "Escape" },
  { labelHash: "0xFF000011", label: "Delete Selected Spell", defaultCode: "Delete" },
  // A14-I3 (?retailRunKeys=on) — autorun toggle (retail
  // CommandInterpreter::ToggleAutoRun, acclient.c:717657). Retail's
  // gmDefaultMap binds Autorun to Q (docs/action-map-finding-2026-05-24.md),
  // but Q is our turn-left key (deliberate WASD/QE modernization, survey
  // A14 §8) — default R instead, rebindable here. Consulted by the
  // index.html keydown handler only when ?retailRunKeys=on.
  { labelHash: "0xFF000015", label: "Autorun (toggle)", defaultCode: "KeyR" },
];

/** Stable identifiers for synthetic local actions — handlers call
 *  `resolveLocalBinding(LOCAL_ACTION_IDS.CLOSE, "Escape")` without
 *  sprinkling hex literals. Keep in sync with LOCAL_ACTIONS. */
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
  HOTBAR_R2_1: "0xFF00000A",
  HOTBAR_R2_2: "0xFF00000B",
  HOTBAR_R2_3: "0xFF00000C",
  HOTBAR_R2_4: "0xFF00000D",
  HOTBAR_R2_5: "0xFF00000E",
  HOTBAR_R2_6: "0xFF00000F",
  HOTBAR_R2_7: "0xFF000012",
  HOTBAR_R2_8: "0xFF000013",
  HOTBAR_R2_9: "0xFF000014",
  CLOSE:    "0xFF000010",
  DELETE_SPELL: "0xFF000011",
  AUTORUN:  "0xFF000015",
});

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY_KEYBINDINGS);
    cache = raw ? JSON.parse(raw) : {};
  } catch (e) {
    try { window.__diag?.input?.onStorageError?.({ op: "read", error: e }); } catch (_) {}
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(LS_KEY_KEYBINDINGS, JSON.stringify(cache ?? {}));
  } catch (e) { /* quota / privacy mode — silent */
    try { window.__diag?.input?.onStorageError?.({ op: "write", error: e }); } catch (_) {}
  }
}

/**
 * Read the current keybindings table from localStorage. Returns a
 * plain object keyed by labelHash hex (`"0x..."`) — values are
 * `{code, shift, ctrl, alt, meta}` per `KeyboardEvent`.
 */
export function getKeybindings() {
  return load();
}

/**
 * Set / overwrite the binding for a labelHash + persist. Used by
 * the Controls-tab capture flow.
 *
 * @param {string} labelHashHex
 * @param {{code: string, shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean}} binding
 */
export function setBinding(labelHashHex, binding) {
  cache = load();
  const oldBinding = cache[labelHashHex] ? { ...cache[labelHashHex] } : null;
  const newBinding = {
    code: binding.code,
    shift: !!binding.shift,
    ctrl: !!binding.ctrl,
    alt: !!binding.alt,
    meta: !!binding.meta,
  };
  cache[labelHashHex] = newBinding;
  persist();
  try { window.__diag?.input?.onRebind?.({ labelHash: labelHashHex, oldBinding, newBinding, op: "set" }); } catch (_) {}
}

/**
 * Scan the persisted user-binding cache for entries that match the
 * given keystroke shape — used by the Controls-tab capture flow to
 * warn the player before a setBinding() overwrites a silent conflict.
 *
 * Returns an array of `{labelHash, label, binding}` for every user
 * override whose key/modifier shape matches. Empty array = no
 * conflict. Pass `excludeLabelHash` to exclude the row being
 * captured (so a no-op rebind doesn't report itself).
 *
 * Only the user-override cache is scanned today; retail-default
 * bindings live in `loadRetailKeyMap`'s ActionMap and a cross-table
 * scan is a follow-on.
 *
 * @param {string} code        — `KeyboardEvent.code` (e.g. "KeyR")
 * @param {boolean} [shift]
 * @param {boolean} [ctrl]
 * @param {boolean} [alt]
 * @param {boolean} [meta]
 * @param {string} [excludeLabelHash] — labelHash to skip
 * @returns {Array<{labelHash:string,label:string,binding:object}>}
 */
export function findConflictingBindings(code, shift, ctrl, alt, meta, excludeLabelHash) {
  if (!code) return [];
  cache = load();
  const conflicts = [];
  const want = {
    code,
    shift: !!shift,
    ctrl: !!ctrl,
    alt: !!alt,
    meta: !!meta,
  };
  for (const [labelHash, binding] of Object.entries(cache)) {
    if (labelHash === excludeLabelHash) continue;
    if (!binding || !binding.code) continue;
    if (binding.code === want.code
        && !!binding.shift === want.shift
        && !!binding.ctrl === want.ctrl
        && !!binding.alt === want.alt
        && !!binding.meta === want.meta) {
      const action = LOCAL_ACTIONS.find((a) => a.labelHash === labelHash);
      conflicts.push({
        labelHash,
        label: action?.label ?? `Action ${labelHash}`,
        binding: { ...binding },
      });
    }
  }
  return conflicts;
}

/**
 * Remove the override for a labelHash so the next read falls back
 * to the default. Returns true if something was removed.
 */
export function clearBinding(labelHashHex) {
  cache = load();
  if (cache[labelHashHex]) {
    const oldBinding = { ...cache[labelHashHex] };
    delete cache[labelHashHex];
    persist();
    try { window.__diag?.input?.onRebind?.({ labelHash: labelHashHex, oldBinding, newBinding: null, op: "clear" }); } catch (_) {}
    return true;
  }
  return false;
}

/**
 * Check if a KeyboardEvent matches a stored binding shape.
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
  const b = load()[labelHashHex];
  if (b && b.code) return b;
  return { code: defaultCode, shift: false, ctrl: false, alt: false, meta: false };
}

// ---------------------------------------------------------------------
// Retail KeyMap (DAT type 0x14) resolver — loads gmDefaultMap and
// exposes a Map<actionHash, [{inputMap, code, shift, ctrl, alt, meta}]>
// so the Controls tab can show retail's factory defaults.
//
// The KeyMap parser confirmed (114-hit / 0-miss vs ActionMap) that
// `QualifiedControl.action_hash` matches the ActionMap inner-dict key
// in the same input_map category — that's the link tying a binding
// to a retail action.
//
// `key` u32 layout (idxDevice | eSubControl | ofsKey):
//   bits  0-7  : index into devices[]  — keyboard if devices[idx].type == 1
//   bits  8-15 : eSubControl byte      — mouse button index for mice
//   bits 16-31 : ofsKey u16            — DirectInput scan code (DIK_*)
//
// `modifier` u32 bitfield (per gmDefaultMap.meta_keys):
//   0x80000000 = shift
//   0x40000000 = ctrl
//   0x20000000 = alt
//   0x10000000 = meta (Windows key)
//   0x08000000 / 0x04000000 — gmDefaultMap reserves these for two
//                            user-extensible meta slots (TAB / Q in
//                            the retail record) but options-panel
//                            doesn't surface them; ignored here.

/**
 * DirectInput keyboard scan code (`DIK_*`) → `KeyboardEvent.code`.
 *
 * Sparse; entries beyond this set fall back to the raw hex offset.
 * Sourced by reading retail's gmDefaultMap mappings against
 * `acclient.h` `dinput.h` enum constants.
 */
export const DIK_TO_KEYBOARD_EVENT_CODE = Object.freeze({
  0x01: "Escape",
  0x02: "Digit1", 0x03: "Digit2", 0x04: "Digit3", 0x05: "Digit4",
  0x06: "Digit5", 0x07: "Digit6", 0x08: "Digit7", 0x09: "Digit8",
  0x0A: "Digit9", 0x0B: "Digit0",
  0x0C: "Minus", 0x0D: "Equal", 0x0E: "Backspace", 0x0F: "Tab",
  0x10: "KeyQ", 0x11: "KeyW", 0x12: "KeyE", 0x13: "KeyR",
  0x14: "KeyT", 0x15: "KeyY", 0x16: "KeyU", 0x17: "KeyI",
  0x18: "KeyO", 0x19: "KeyP",
  0x1A: "BracketLeft", 0x1B: "BracketRight", 0x1C: "Enter",
  0x1D: "ControlLeft",
  0x1E: "KeyA", 0x1F: "KeyS", 0x20: "KeyD", 0x21: "KeyF",
  0x22: "KeyG", 0x23: "KeyH", 0x24: "KeyJ", 0x25: "KeyK",
  0x26: "KeyL",
  0x27: "Semicolon", 0x28: "Quote", 0x29: "Backquote",
  0x2A: "ShiftLeft", 0x2B: "Backslash",
  0x2C: "KeyZ", 0x2D: "KeyX", 0x2E: "KeyC", 0x2F: "KeyV",
  0x30: "KeyB", 0x31: "KeyN", 0x32: "KeyM",
  0x33: "Comma", 0x34: "Period", 0x35: "Slash",
  0x36: "ShiftRight", 0x37: "NumpadMultiply",
  0x38: "AltLeft", 0x39: "Space", 0x3A: "CapsLock",
  0x3B: "F1", 0x3C: "F2", 0x3D: "F3", 0x3E: "F4", 0x3F: "F5",
  0x40: "F6", 0x41: "F7", 0x42: "F8", 0x43: "F9", 0x44: "F10",
  0x45: "NumLock", 0x46: "ScrollLock",
  0x47: "Numpad7", 0x48: "Numpad8", 0x49: "Numpad9",
  0x4A: "NumpadSubtract",
  0x4B: "Numpad4", 0x4C: "Numpad5", 0x4D: "Numpad6",
  0x4E: "NumpadAdd",
  0x4F: "Numpad1", 0x50: "Numpad2", 0x51: "Numpad3",
  0x52: "Numpad0", 0x53: "NumpadDecimal",
  0x57: "F11", 0x58: "F12",
  0x9C: "NumpadEnter", 0x9D: "ControlRight",
  0xB5: "NumpadDivide", 0xB7: "PrintScreen", 0xB8: "AltRight",
  0xC5: "Pause",
  0xC7: "Home", 0xC8: "ArrowUp", 0xC9: "PageUp",
  0xCB: "ArrowLeft", 0xCD: "ArrowRight",
  0xCF: "End", 0xD0: "ArrowDown", 0xD1: "PageDown",
  0xD2: "Insert", 0xD3: "Delete",
  0xDB: "MetaLeft", 0xDC: "MetaRight",
});

/**
 * Convert a wire-format QualifiedControl mapping to a binding shape.
 *
 * Returns `null` if the mapping is a mouse binding (the Controls tab
 * only renders keyboard rebinds), or if `ofsKey` is outside the DIK
 * lookup table (e.g. virtual / joystick records).
 *
 * @param {{key: number, modifier: number}} mapping
 * @param {Array<{type: number}>} devices — KeyMap.devices[]
 * @returns {null | {code: string, shift: boolean, ctrl: boolean, alt: boolean, meta: boolean}}
 */
export function qualifiedControlToBinding(mapping, devices) {
  const idxDevice = mapping.key & 0xFF;
  const dev = devices?.[idxDevice];
  if (!dev || dev.type !== 1) return null; // 1 = Keyboard
  const ofsKey = (mapping.key >>> 16) & 0xFFFF;
  const code = DIK_TO_KEYBOARD_EVENT_CODE[ofsKey];
  if (!code) return null;
  return {
    code,
    shift: !!(mapping.modifier & 0x80000000),
    ctrl:  !!(mapping.modifier & 0x40000000),
    alt:   !!(mapping.modifier & 0x20000000),
    meta:  !!(mapping.modifier & 0x10000000),
  };
}

let retailKeyMapPromise = null;
let retailKeyMapCache = null;

/**
 * Load + index the retail KeyMap (DAT type 0x14). Default record is
 * `0x14000000` ("gmDefaultMap"), the factory binding set.
 *
 * Returns `{ raw, byActionHash, byCategoryAction }`:
 *   - `raw` is the wasm JSON output verbatim.
 *   - `byActionHash` is a Map<number, Array<binding>>; a single action
 *      may have N bindings (W + UpArrow both move forward).
 *   - `byCategoryAction` is a Map<string, binding-with-category> keyed
 *      by `"<inputMap>:<actionHash>"`, holding the *primary* binding
 *      for the Controls tab to show as the default. Primary = first
 *      modifier-less keyboard binding, falling back to first overall.
 *
 * Wasm-bindgen accessor is `wasm.fetch_key_map(id)`; same lookup
 * pattern as `loadActionMap()`.
 *
 * @param {number} [id=0x14000000]
 * @returns {Promise<null | {raw: object, byActionHash: Map<number, Array>, byCategoryAction: Map<string, object>}>}
 */
export async function loadRetailKeyMap(id = 0x14000000) {
  if (retailKeyMapCache) return retailKeyMapCache;
  if (retailKeyMapPromise) return retailKeyMapPromise;
  retailKeyMapPromise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_key_map) {
      retailKeyMapCache = null;
      return null;
    }
    try {
      const json = await wasm.fetch_key_map(id >>> 0);
      const raw = json === "null" ? null : JSON.parse(json);
      if (!raw) {
        retailKeyMapCache = null;
        return null;
      }
      const byActionHash = new Map();
      for (const m of raw.mappings) {
        const binding = qualifiedControlToBinding(m, raw.devices);
        if (!binding) continue;
        const enriched = { inputMap: m.input_map >>> 0, ...binding };
        let arr = byActionHash.get(m.action_hash >>> 0);
        if (!arr) { arr = []; byActionHash.set(m.action_hash >>> 0, arr); }
        arr.push(enriched);
      }
      const byCategoryAction = new Map();
      for (const [actionHash, bindings] of byActionHash) {
        // Group bindings by inputMap (same action may have variants in
        // multiple categories), then pick a primary per category.
        const byCat = new Map();
        for (const b of bindings) {
          let arr = byCat.get(b.inputMap);
          if (!arr) { arr = []; byCat.set(b.inputMap, arr); }
          arr.push(b);
        }
        for (const [cat, arr] of byCat) {
          const plain = arr.find((b) => !b.shift && !b.ctrl && !b.alt && !b.meta);
          byCategoryAction.set(`${cat}:${actionHash}`, plain ?? arr[0]);
        }
      }
      retailKeyMapCache = { raw, byActionHash, byCategoryAction };
      try {
        window.__diag?.input?.onRetailKeyMapLoaded?.({
          id, mappings: raw.mappings.length, actions: byActionHash.size,
        });
      } catch (_) {}
      return retailKeyMapCache;
    } catch (err) {
      console.warn(`[keymap] retail key map 0x${id.toString(16)} load failed:`, err);
      retailKeyMapCache = null;
      return null;
    } finally {
      retailKeyMapPromise = null;
    }
  })();
  return retailKeyMapPromise;
}

/** Sync accessor — returns the resolved KeyMap if loaded, else null. */
export function getRetailKeyMap() {
  return retailKeyMapCache;
}

/**
 * Look up the retail default binding for an action in a given input_map
 * category. Returns `null` if the action is unbound by default
 * (e.g. it's a category-only ActionMap stub like "Chat Mode → Enter")
 * or if the KeyMap hasn't loaded yet.
 *
 * @param {number} inputMap — ActionMap outer-dict key.
 * @param {number} actionHash — ActionMap inner-dict key.
 * @returns {null | {code: string, shift: boolean, ctrl: boolean, alt: boolean, meta: boolean}}
 */
export function lookupRetailDefault(inputMap, actionHash) {
  const km = retailKeyMapCache;
  if (!km) return null;
  return km.byCategoryAction.get(`${inputMap >>> 0}:${actionHash >>> 0}`) ?? null;
}

/**
 * Look up an entry in the cached retail ActionMap (loaded via
 * `ac_strings.loadActionMap`) by actionHash. Returns the first match
 * across input maps (the same action may appear in multiple categories;
 * `toggle` is a per-action property so any match is equivalent).
 *
 * @param {number} actionHash
 * @returns {null | {inputMap:number, actionHash:number, labelHash:number, toggle:number, label:string|null}}
 */
function findActionByHash(actionHash) {
  const am = getActionMap();
  if (!am?.actions) return null;
  const want = actionHash >>> 0;
  for (const a of am.actions) {
    if (a.actionHash === want) return a;
  }
  return null;
}

/**
 * True if the retail ActionMap marks this action as a toggle
 * (`ActionMapValue.toggle_type != 0`). Toggles fire on key-down and
 * latch state until the next key-down; press-release semantics gate
 * the alternative (hold to keep active). Controls UI uses this to
 * label the rebind row "(toggle)" so the player knows the binding's
 * activation semantics.
 *
 * Returns `false` when the ActionMap isn't loaded yet OR the action
 * is not present — safe to call before `loadActionMap()` resolves.
 *
 * @param {number} actionHash
 * @returns {boolean}
 */
export function isToggleAction(actionHash) {
  const a = findActionByHash(actionHash);
  if (!a) return false;
  return (a.toggle >>> 0) !== 0;
}

/**
 * True if the player should be allowed to bind a key to this action
 * in the Options → Controls capture UI. The retail ActionMap stores
 * an ActivationType field, but the current wasm-side serializer
 * (`src/lib.rs#fetch_action_map`) does not surface it — so this
 * heuristic falls back to "has a user-facing label". Actions with no
 * resolved label are presumed system / category-stubs (e.g. internal
 * dispatch entries) and not user-rebindable.
 *
 * Returns `false` when the ActionMap isn't loaded yet — the Controls
 * UI should re-render after `loadActionMap()` resolves.
 *
 * @param {number} actionHash
 * @returns {boolean}
 */
export function canUserBind(actionHash) {
  const a = findActionByHash(actionHash);
  if (!a) return false;
  const label = a.label;
  if (typeof label !== "string") return false;
  return label.trim().length > 0;
}

/**
 * Format a binding as a human-readable label. "—" if empty.
 * "Ctrl+Shift+F5" / "W" / "Escape" / "Num 7".
 */
export function formatBinding(b) {
  if (!b || !b.code) return "—";
  const parts = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  if (b.meta) parts.push("Meta");
  let key = b.code;
  if (key.startsWith("Key")) key = key.slice(3);
  else if (key.startsWith("Digit")) key = key.slice(5);
  else if (key.startsWith("Numpad")) key = `Num ${key.slice(6)}`;
  parts.push(key);
  return parts.join("+");
}

// ---------------------------------------------------------------------
// Manifest-declared hotkey registry (Polish B, 2026-05-27).
//
// Each plugin manifest declares `hotkeys: [{ id, default, label? }]`
// (see plugins/schemas/plugin-manifest.json#/properties/hotkeys). PR 8
// added the *schema* for these but enforcement lived as inline F-key
// tables in `index.html` — completely decoupled from the manifests.
// This module is the missing glue: at startup, the host walks every
// loaded manifest's `hotkeys[]` and calls `setManifestBindings(map)`
// with `{ '<KEY-STRING>': '<plugin-id>::<hotkey-id>' }`. After that,
// hotkey dispatch becomes a single `matchHotkeyEvent(ev)` lookup
// instead of two hardcoded `FKEY_VIEWS` / `FKEY_SHIFT_TOGGLES` tables.
//
// We DO NOT register a window keydown listener here — the host owns
// the dispatch flow (it has to decide what to do with the resolved
// action, e.g. `__mainPanel.toggleView(view)` vs `__toggleHousePanel()`
// vs `pluginClient.events.emit('togglePanel', id)`). This module is
// the resolver, not the dispatcher.
//
// Key-string grammar (matches manifest `default` strings):
//   modifier-prefix ::= ("Ctrl" | "Shift" | "Alt" | "Meta") "+"
//   key             ::= "F" digits | letter | digit | "Escape" | …
//   key-string      ::= modifier-prefix* key
//
// Examples: "F4", "Shift+F2", "Ctrl+Shift+F5", "I", "Escape".
//
// The key portion is matched against `KeyboardEvent.key` (the
// printable identifier) so manifest authors stay in human-readable
// land. Modifier names line up with `KeyboardEvent.shiftKey` etc.

/** @type {Map<string, {pluginId: string, hotkeyId: string, label: string|null, keyString: string}>} */
let manifestBindings = new Map();

/**
 * Parse a hotkey key-string ("F4", "Shift+F2", "Ctrl+Alt+I") into a
 * normalised match shape. Returns `null` on malformed input.
 *
 * Modifier names accepted: `Ctrl`, `Shift`, `Alt`, `Meta` (case
 * sensitive — manifests are authored, not user-typed). Order is
 * irrelevant during parse but normalisation re-emits in canonical
 * Ctrl→Alt→Shift→Meta order to match `formatBinding` output.
 *
 * @param {string} s
 * @returns {null | {key: string, shift: boolean, ctrl: boolean, alt: boolean, meta: boolean, canonical: string}}
 */
export function parseHotkeyString(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const parts = s.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const key = parts.pop();
  if (!key) return null;
  let shift = false, ctrl = false, alt = false, meta = false;
  for (const mod of parts) {
    if (mod === "Shift") shift = true;
    else if (mod === "Ctrl") ctrl = true;
    else if (mod === "Alt") alt = true;
    else if (mod === "Meta") meta = true;
    else return null; // Unknown modifier — reject rather than silently match.
  }
  const canonicalParts = [];
  if (ctrl) canonicalParts.push("Ctrl");
  if (alt) canonicalParts.push("Alt");
  if (shift) canonicalParts.push("Shift");
  if (meta) canonicalParts.push("Meta");
  canonicalParts.push(key);
  return { key, shift, ctrl, alt, meta, canonical: canonicalParts.join("+") };
}

/**
 * Replace the current manifest-binding table. Pass an object keyed by
 * hotkey-string (`"F4"`, `"Shift+F2"`) with values of shape
 * `"<plugin-id>::<hotkey-id>"`. Keys are normalised via
 * `parseHotkeyString`; malformed entries are skipped (with a console
 * warn) so one bad manifest does not break the rest.
 *
 * Idempotent — calling twice with the same map is a no-op beyond the
 * cache rebuild. The host should call this once at startup after the
 * plugin loader has resolved its manifest set.
 *
 * @param {Record<string, string>} map
 * @returns {{ registered: number, skipped: Array<{keyString: string, reason: string}> }}
 */
export function setManifestBindings(map) {
  const next = new Map();
  const skipped = [];
  if (map == null || typeof map !== "object") {
    manifestBindings = next;
    return { registered: 0, skipped };
  }
  for (const [keyString, value] of Object.entries(map)) {
    const parsed = parseHotkeyString(keyString);
    if (!parsed) {
      skipped.push({ keyString, reason: "malformed hotkey string" });
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      skipped.push({ keyString, reason: "value must be non-empty string" });
      continue;
    }
    const sepIdx = value.indexOf("::");
    if (sepIdx < 1 || sepIdx > value.length - 3) {
      skipped.push({ keyString, reason: `value must be "<plugin-id>::<hotkey-id>" (got ${JSON.stringify(value)})` });
      continue;
    }
    const pluginId = value.slice(0, sepIdx);
    const hotkeyId = value.slice(sepIdx + 2);
    next.set(parsed.canonical, {
      pluginId,
      hotkeyId,
      label: null,
      keyString: parsed.canonical,
      match: parsed,
    });
  }
  manifestBindings = next;
  try {
    window.__diag?.input?.onManifestBindingsSet?.({
      registered: next.size, skipped: skipped.length,
    });
  } catch (_) {}
  return { registered: next.size, skipped };
}

/**
 * Build the manifest-binding map from an array of loaded manifests.
 * Convenience helper for the host startup path; mirrors the shape of
 * `loadPlugins()` return values from `plugins/loader.js`.
 *
 * Each manifest's `hotkeys[]` entry contributes one binding:
 *   `<hotkey.default>` → `"<manifest.id>::<hotkey.id>"`
 *
 * Duplicate key-strings are resolved last-wins (with a console warn),
 * mirroring the `index.html` legacy behavior where F2 + F5 both routed
 * to `spellbook`. The duplicate is *recorded* — the caller can decide
 * whether it's intentional (multi-key alias) or a bug.
 *
 * @param {Array<{id: string, hotkeys?: Array<{id: string, default: string, label?: string}>}>} manifests
 * @returns {{ map: Record<string, string>, labels: Record<string, string>, duplicates: Array<{keyString: string, conflicts: string[]}> }}
 */
export function buildManifestBindings(manifests) {
  /** @type {Record<string, string>} */
  const map = {};
  /** @type {Record<string, string>} */
  const labels = {};
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  if (!Array.isArray(manifests)) {
    return { map, labels, duplicates: [] };
  }
  for (const m of manifests) {
    if (m == null || typeof m.id !== "string") continue;
    const hotkeys = Array.isArray(m.hotkeys) ? m.hotkeys : [];
    for (const hk of hotkeys) {
      if (hk == null || typeof hk.id !== "string" || typeof hk.default !== "string") continue;
      const parsed = parseHotkeyString(hk.default);
      if (!parsed) continue;
      const value = `${m.id}::${hk.id}`;
      const prevList = seen.get(parsed.canonical) || [];
      prevList.push(value);
      seen.set(parsed.canonical, prevList);
      map[parsed.canonical] = value;
      if (typeof hk.label === "string" && hk.label.length > 0) {
        labels[parsed.canonical] = hk.label;
      }
    }
  }
  const duplicates = [];
  for (const [k, list] of seen) {
    if (list.length > 1) duplicates.push({ keyString: k, conflicts: list });
  }
  return { map, labels, duplicates };
}

/**
 * Look up the manifest binding for a normalised key-string (e.g.
 * `"F4"`, `"Shift+F2"`). Returns `null` if no manifest claims it.
 *
 * Used by retail-default lookup paths — the dispatcher should prefer
 * `matchHotkeyEvent` which already handles user overrides + matching.
 *
 * @param {string} keyString
 * @returns {null | {pluginId: string, hotkeyId: string, label: string|null, keyString: string}}
 */
export function getManifestBinding(keyString) {
  const parsed = parseHotkeyString(keyString);
  if (!parsed) return null;
  const entry = manifestBindings.get(parsed.canonical);
  if (!entry) return null;
  return {
    pluginId: entry.pluginId,
    hotkeyId: entry.hotkeyId,
    label: entry.label,
    keyString: entry.keyString,
  };
}

/**
 * Resolve a `KeyboardEvent` to a manifest-declared plugin action.
 * Returns `null` if no manifest binding matches.
 *
 * Walks the entire manifest-binding set (small — bounded by ~30
 * plugins × ~few hotkeys each) checking modifier + key equality. The
 * straightforward shape is correct for this size; revisit only if
 * the binding set grows past ~200 entries.
 *
 * @param {KeyboardEvent} ev
 * @returns {null | {pluginId: string, hotkeyId: string, label: string|null, keyString: string}}
 */
export function matchHotkeyEvent(ev) {
  if (!ev || typeof ev.key !== "string") return null;
  for (const entry of manifestBindings.values()) {
    const m = entry.match;
    if (!m) continue;
    if (ev.key !== m.key) continue;
    if (ev.shiftKey !== m.shift) continue;
    if (ev.ctrlKey !== m.ctrl) continue;
    if (ev.altKey !== m.alt) continue;
    if (ev.metaKey !== m.meta) continue;
    return {
      pluginId: entry.pluginId,
      hotkeyId: entry.hotkeyId,
      label: entry.label,
      keyString: entry.keyString,
    };
  }
  return null;
}

/**
 * Snapshot the current manifest bindings — entry per active binding,
 * sorted by key-string. Used by the settings UI to render the bind
 * list, and by tests for assertions.
 *
 * @returns {Array<{keyString: string, pluginId: string, hotkeyId: string}>}
 */
export function listManifestBindings() {
  return [...manifestBindings.values()]
    .map((e) => ({
      keyString: e.keyString,
      pluginId: e.pluginId,
      hotkeyId: e.hotkeyId,
    }))
    .sort((a, b) => a.keyString.localeCompare(b.keyString));
}

/**
 * Clear all manifest bindings. Mostly useful in tests; the host
 * generally calls `setManifestBindings(newMap)` instead.
 */
export function clearManifestBindings() {
  manifestBindings = new Map();
}
