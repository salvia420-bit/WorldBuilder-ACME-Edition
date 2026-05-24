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
  { labelHash: "0xFF000010", label: "Close Panel / Popover", defaultCode: "Escape" },
  { labelHash: "0xFF000011", label: "Delete Selected Spell", defaultCode: "Delete" },
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
  CLOSE:    "0xFF000010",
  DELETE_SPELL: "0xFF000011",
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
