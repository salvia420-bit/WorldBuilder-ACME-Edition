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
 *     0x26000000 record. Only the ones a handler really dispatches
 *     are rebindable (input-options-6, `retailActionStatus`): those
 *     rebind the handler's own key; the rest show read-only.
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
 * input-options-3 (2026-10-13) — `?retailQuickslotMods` (DEFAULT-ON;
 * `=off`/`0`/`false` disables): retail's modifier quickslot defaults,
 * Ctrl+1..9 = Quickslot 1-9 and Alt+1..9 = Quickslot 10-18 (gmDefaultMap,
 * portal 0x14000000, input map 0x1000000C). Off = those rows ship unbound
 * (the pre-2026-10-13 keys). An escape in case a browser keeps Ctrl/Alt+digit
 * for tab switching despite the funnel's preventDefault. Never throws.
 */
export function readRetailQuickslotModsFlag(search) {
  try {
    const s =
      typeof search === "string"
        ? search
        : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    const v = new URLSearchParams(s).get("retailQuickslotMods");
    if (v == null) return true;
    const lc = v.toLowerCase();
    return !(lc === "off" || lc === "0" || lc === "false");
  } catch (_) {
    return true;
  }
}

let _retailQuickslotMods = null;
/** Cached flag accessor (parse once per page load). */
export function retailQuickslotModsOn() {
  if (_retailQuickslotMods === null) _retailQuickslotMods = readRetailQuickslotModsFlag();
  return _retailQuickslotMods;
}
/** Test seam. */
export function _resetRetailQuickslotModsForTest() {
  _retailQuickslotMods = null;
}

/**
 * Default binding of a modifier quickslot row: `{code: "Digit<n>", <mod>: true}`
 * (`mod` = "ctrl" | "alt"), or null (unbound) with `?retailQuickslotMods=off`.
 * Pass `search` to read that query string instead of the cached flag.
 */
export function quickslotModDefault(n, mod, search) {
  const on = typeof search === "string" ? readRetailQuickslotModsFlag(search) : retailQuickslotModsOn();
  return on ? { code: `Digit${n}`, [mod]: true } : null;
}

// A LOCAL_ACTIONS row whose default is a modifier quickslot key. The default
// is a getter, read per use, so the flag holds for every reader of the table
// (Options → Controls and the hotbar alike).
function quickslotModRow(labelHash, label, n, mod) {
  return {
    labelHash,
    label,
    get defaultCode() { return quickslotModDefault(n, mod); },
  };
}

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
  // input-options-3 — retail binds Quickslot 1-9 twice, DigitN AND Ctrl+DigitN
  // (same action, map 0x1000000C, registered for the whole session by
  // ClientUISystem::OnBeginCharacterSession). The magic map 0x10000005
  // (ClientCombatSystem::RegisterInputMaps, magic mode only) takes the BARE
  // digits for Spell Slot 1-9 and has no Ctrl+digit rows, so Ctrl+N is how
  // retail reaches hotbar row 1 in magic stance. Separate rebindable rows,
  // like the Magic First/Last Ctrl variants below.
  quickslotModRow("0xFF000040", "Hotbar Slot 1 (Ctrl)", 1, "ctrl"),
  quickslotModRow("0xFF000041", "Hotbar Slot 2 (Ctrl)", 2, "ctrl"),
  quickslotModRow("0xFF000042", "Hotbar Slot 3 (Ctrl)", 3, "ctrl"),
  quickslotModRow("0xFF000043", "Hotbar Slot 4 (Ctrl)", 4, "ctrl"),
  quickslotModRow("0xFF000044", "Hotbar Slot 5 (Ctrl)", 5, "ctrl"),
  quickslotModRow("0xFF000045", "Hotbar Slot 6 (Ctrl)", 6, "ctrl"),
  quickslotModRow("0xFF000046", "Hotbar Slot 7 (Ctrl)", 7, "ctrl"),
  quickslotModRow("0xFF000047", "Hotbar Slot 8 (Ctrl)", 8, "ctrl"),
  quickslotModRow("0xFF000048", "Hotbar Slot 9 (Ctrl)", 9, "ctrl"),
  // Row 2 (ShortcutBar2 in retail / Chorizite) = retail Quickslot 10-18,
  // bound to Alt+1..Alt+9 in gmDefaultMap (checked against the portal.dat
  // 0x14000000 bytes, 2026-10-13; an older note here said retail left them
  // unbound). Alt+1..4 are also retail's Toggle Floating Chat Window 1-4
  // (map 0x10000009); this client has no floating chat windows, so the
  // quickslots keep them.
  quickslotModRow("0xFF00000A", "Hotbar Row 2 Slot 1", 1, "alt"),
  quickslotModRow("0xFF00000B", "Hotbar Row 2 Slot 2", 2, "alt"),
  quickslotModRow("0xFF00000C", "Hotbar Row 2 Slot 3", 3, "alt"),
  quickslotModRow("0xFF00000D", "Hotbar Row 2 Slot 4", 4, "alt"),
  quickslotModRow("0xFF00000E", "Hotbar Row 2 Slot 5", 5, "alt"),
  quickslotModRow("0xFF00000F", "Hotbar Row 2 Slot 6", 6, "alt"),
  quickslotModRow("0xFF000012", "Hotbar Row 2 Slot 7", 7, "alt"),
  quickslotModRow("0xFF000013", "Hotbar Row 2 Slot 8", 8, "alt"),
  quickslotModRow("0xFF000014", "Hotbar Row 2 Slot 9", 9, "alt"),
  { labelHash: "0xFF000010", label: "Close Panel / Popover", defaultCode: "Escape" },
  { labelHash: "0xFF000011", label: "Delete Selected Spell", defaultCode: "Delete" },
  // A14-I3 (?retailRunKeys=on) — autorun toggle (retail
  // CommandInterpreter::ToggleAutoRun, acclient.c:717657). Retail's
  // gmDefaultMap binds Autorun to Q (docs/action-map-finding-2026-05-24.md),
  // but Q is our turn-left key (deliberate WASD/QE modernization, survey
  // A14 §8) — default R instead, rebindable here. Consulted by the
  // index.html keydown handler only when ?retailRunKeys=on.
  { labelHash: "0xFF000015", label: "Autorun (toggle)", defaultCode: "KeyR" },
  // Task C v2 (2026-07-02) — retail MagicCombat input map, verbatim
  // defaults from the user's acclient.keymap capture:
  //   CombatPrevSpellTab  Insert     CombatFirstSpellTab  Ctrl+Insert
  //   CombatNextSpellTab  PageUp     CombatLastSpellTab   Ctrl+PageUp
  //   CombatPrevSpell     Delete     CombatFirstSpell     Ctrl+Delete
  //   CombatNextSpell     PageDown   CombatLastSpell      Ctrl+PageDown
  //   CombatCastCurrentSpell  End
  //   UseSpellSlot_1..9   Digit1..9 (magic stance takes the bare
  //                       digits; the hotbar's quickslots yield —
  //                       retail's per-mode map partition — but
  //                       Ctrl+1..9 / Alt+1..9 still reach them)
  // Only the BASE key is stored/rebindable here; the Ctrl+<same key>
  // first/last variants derive from it in combat-bar.js, exactly like
  // retail bound First/Last to the same physical key + metakey 0x2
  // (Ctrl per the MetaKeys table). All handlers are magic-stance-scoped
  // (ClientCombatSystem::HandleMagicAction scope) and none of them
  // touch KeyC — C stays reserved.
  { labelHash: "0xFF000016", label: "Magic: Previous Spell Tab", defaultCode: "Insert" },
  { labelHash: "0xFF000017", label: "Magic: Next Spell Tab", defaultCode: "PageUp" },
  { labelHash: "0xFF000018", label: "Magic: Previous Spell", defaultCode: "Delete" },
  { labelHash: "0xFF000019", label: "Magic: Next Spell", defaultCode: "PageDown" },
  { labelHash: "0xFF00001A", label: "Magic: Cast Current Spell", defaultCode: "End" },
  // First/Last variants — separate rebindable rows like retail's
  // Configure Keyboard; defaults are the retail Ctrl+<key> combos
  // (object defaults carry the modifier; resolveLocalBinding +
  // options-panel buildBindingRow both accept them).
  { labelHash: "0xFF00001B", label: "Magic: First Spell Tab", defaultCode: { code: "Insert", ctrl: true } },
  { labelHash: "0xFF00001C", label: "Magic: Last Spell Tab", defaultCode: { code: "PageUp", ctrl: true } },
  { labelHash: "0xFF00001D", label: "Magic: First Spell", defaultCode: { code: "Delete", ctrl: true } },
  { labelHash: "0xFF00001E", label: "Magic: Last Spell", defaultCode: { code: "PageDown", ctrl: true } },
  // UseSpellSlot_1..9 — retail's magic-mode number row (the hotbar's
  // bare quickslot digits yield to these in magic stance).
  { labelHash: "0xFF00001F", label: "Magic: Use Spell Slot 1", defaultCode: "Digit1" },
  { labelHash: "0xFF000020", label: "Magic: Use Spell Slot 2", defaultCode: "Digit2" },
  { labelHash: "0xFF000021", label: "Magic: Use Spell Slot 3", defaultCode: "Digit3" },
  { labelHash: "0xFF000022", label: "Magic: Use Spell Slot 4", defaultCode: "Digit4" },
  { labelHash: "0xFF000023", label: "Magic: Use Spell Slot 5", defaultCode: "Digit5" },
  { labelHash: "0xFF000024", label: "Magic: Use Spell Slot 6", defaultCode: "Digit6" },
  { labelHash: "0xFF000025", label: "Magic: Use Spell Slot 7", defaultCode: "Digit7" },
  { labelHash: "0xFF000026", label: "Magic: Use Spell Slot 8", defaultCode: "Digit8" },
  { labelHash: "0xFF000027", label: "Magic: Use Spell Slot 9", defaultCode: "Digit9" },
  // C2 (2026-07-12) — target-cycling binds (CPlayerSystem::SelectNext,
  // acclient.c:397944; Select Closest/Previous/Next Monster = ClientAction
  // 0x10000035/36/37). Tab / Shift+Tab / T are this client's own modern
  // defaults, not retail's: gmDefaultMap (portal.dat 0x14000000) binds
  // Closest/Previous/Next Monster to ' / L / ; and Tab to Enter/Exit Chat
  // Mode (0x10000024), which this client does not have (input-options-7
  // correction, 2026-10-13). T is free here (movement uses WASDQE; digits
  // are hotbar/magic slots). All three consult liveScene3d.entityManager.
  // cycleTarget via the index.html keydown dispatch; input-triggered only,
  // `?targetCycle=off` disables them. The other retail selection keys (P,
  // Home, the player / item / compass / fellow cycles) are input-funnel
  // actions bound under their ClientAction ids: ui/selection_keys.js.
  { labelHash: "0xFF000028", label: "Next Monster",     defaultCode: "Tab" },
  { labelHash: "0xFF000029", label: "Previous Monster", defaultCode: { code: "Tab", shift: true } },
  { labelHash: "0xFF00002A", label: "Closest Monster",  defaultCode: "KeyT" },
  // HUD overhaul 2026-10-05 — expanded world map (plugins/map-panel.js
  // #hb-map-overlay); retail only had the F3 gmMapUI panel. M is free
  // (movement WASDQE, T = target) and is ignored while typing.
  { labelHash: "0xFF00002B", label: "World Map (toggle)", defaultCode: "KeyM" },
  // death-5 (2026-10-08 round 2) — retail corpse-loot actions
  // (CPlayerSystem::OnAction acclient.c:399807-399833; action names
  // SelectionClosest/NextUnopenedCorpse 0x10000121/0x10000122 and
  // SelectionUseClosest/NextUnopenedCorpse 0x1000003E/0x1000003F). Unbound by
  // default (no retail default in the docs/action-map finding) — bind them in
  // Options → Controls. Dispatched by the index.html keydown handler to
  // EntityManager.unopenedCorpseAction.
  { labelHash: "0xFF00002C", label: "Closest Unopened Corpse", defaultCode: null },
  { labelHash: "0xFF00002D", label: "Next Unopened Corpse", defaultCode: null },
  { labelHash: "0xFF00002E", label: "Use Closest Unopened Corpse", defaultCode: null },
  { labelHash: "0xFF00002F", label: "Use Next Unopened Corpse", defaultCode: null },
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
  // input-options-3 — Ctrl+1..9 aliases of row 1 (retail Quickslot 1-9).
  HOTBAR_CTRL_1: "0xFF000040",
  HOTBAR_CTRL_2: "0xFF000041",
  HOTBAR_CTRL_3: "0xFF000042",
  HOTBAR_CTRL_4: "0xFF000043",
  HOTBAR_CTRL_5: "0xFF000044",
  HOTBAR_CTRL_6: "0xFF000045",
  HOTBAR_CTRL_7: "0xFF000046",
  HOTBAR_CTRL_8: "0xFF000047",
  HOTBAR_CTRL_9: "0xFF000048",
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
  MAGIC_PREV_TAB: "0xFF000016",
  MAGIC_NEXT_TAB: "0xFF000017",
  MAGIC_PREV_SPELL: "0xFF000018",
  MAGIC_NEXT_SPELL: "0xFF000019",
  MAGIC_CAST: "0xFF00001A",
  MAGIC_FIRST_TAB: "0xFF00001B",
  MAGIC_LAST_TAB: "0xFF00001C",
  MAGIC_FIRST_SPELL: "0xFF00001D",
  MAGIC_LAST_SPELL: "0xFF00001E",
  MAGIC_SLOT_1: "0xFF00001F",
  MAGIC_SLOT_2: "0xFF000020",
  MAGIC_SLOT_3: "0xFF000021",
  MAGIC_SLOT_4: "0xFF000022",
  MAGIC_SLOT_5: "0xFF000023",
  MAGIC_SLOT_6: "0xFF000024",
  MAGIC_SLOT_7: "0xFF000025",
  MAGIC_SLOT_8: "0xFF000026",
  MAGIC_SLOT_9: "0xFF000027",
  // C2 (2026-07-12) — target cycling.
  NEXT_MONSTER: "0xFF000028",
  PREV_MONSTER: "0xFF000029",
  CLOSEST_MONSTER: "0xFF00002A",
  WORLD_MAP: "0xFF00002B",
  // death-5 (round 2) — corpse-loot cycle.
  CLOSEST_UNOPENED_CORPSE: "0xFF00002C",
  NEXT_UNOPENED_CORPSE: "0xFF00002D",
  USE_CLOSEST_UNOPENED_CORPSE: "0xFF00002E",
  USE_NEXT_UNOPENED_CORPSE: "0xFF00002F",
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
 * input-options-6 — the live DEFAULTS are scanned too: every
 * LOCAL_ACTIONS row the player has not overridden (Autorun's R) and
 * the keys this client hard-codes for retail actions
 * (RETAIL_ACTION_FIXED_KEYS — WASD/QE movement, combat, chat). Those
 * entries carry `isDefault: true` (`fixed: true` for the hard-coded
 * ones). Retail's own KeyMap defaults are NOT conflicts here: most
 * retail actions have no handler in this client.
 *
 * @param {string} code        — `KeyboardEvent.code` (e.g. "KeyR")
 * @param {boolean} [shift]
 * @param {boolean} [ctrl]
 * @param {boolean} [alt]
 * @param {boolean} [meta]
 * @param {string} [excludeLabelHash] — labelHash to skip
 * @returns {Array<{labelHash:string,label:string,binding:object,isDefault?:boolean,fixed?:boolean}>}
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
  // input-options-6 — the defaults that are live right now.
  for (const action of LOCAL_ACTIONS) {
    const id = action.labelHash;
    if (id === excludeLabelHash) continue;
    if (cache[id] && cache[id].code) continue; // its override was scanned above
    const def = normalizeBinding(action.defaultCode);
    if (def && sameBinding(def, want)) {
      conflicts.push({ labelHash: id, label: action.label, binding: def, isDefault: true });
    }
  }
  for (const [actionHash, fixed] of RETAIL_ACTION_FIXED_KEYS) {
    const id = retailActionBindingId(actionHash);
    if (id === excludeLabelHash) continue;
    const def = normalizeBinding(fixed.code);
    if (def && sameBinding(def, want)) {
      conflicts.push({ labelHash: id, label: fixed.label, binding: def, isDefault: true, fixed: true });
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
  // Task C v2 (2026-07-02): defaults may carry modifiers — accept a
  // full {code, shift, ctrl, alt, meta} object (retail's MagicCombat
  // First/Last variants default to Ctrl+<key>), or the legacy bare
  // KeyboardEvent.code string.
  if (defaultCode && typeof defaultCode === "object") {
    return {
      code: defaultCode.code,
      shift: !!defaultCode.shift,
      ctrl: !!defaultCode.ctrl,
      alt: !!defaultCode.alt,
      meta: !!defaultCode.meta,
    };
  }
  return { code: defaultCode, shift: false, ctrl: false, alt: false, meta: false };
}

// ---------------------------------------------------------------------
// input-options-6 (2026-10-13) — which retail ActionMap actions this
// client really dispatches.
//
// Options → Controls lists every labelled action of the retail ActionMap
// (0x26000000). Retail's Configure Keyboard rows are commands its input
// manager dispatches (UIOption_ActionKeyMap::RefreshMappings; the handlers
// are ACCmdInterp::OnAction acclient.c:435951 and CPlayerSystem::OnAction).
// Here most rows had no handler: Bind stored a key under the row's
// labelHash that nothing read, and the default shown was retail's even
// where this client uses another key (Turn Left showed A, which strafes
// here). The tables below say what IS live, keyed by the ActionMap inner
// key (`actionHash` = the retail InputAction / ClientAction id):
//
//   RETAIL_ACTION_LOCAL_IDS         rebindable: the LOCAL_ACTIONS row whose
//                                   handler implements the action. The
//                                   Controls row rebinds THAT row's key.
//   RETAIL_ACTION_FIXED_KEYS        works, on a key this client hard-codes
//                                   (movement = index.html CMD_INTERP_ACTIONS,
//                                   combat-hud attack keys, backquote, Enter).
//   RETAIL_ACTION_MANIFEST_HOTKEYS  panel toggles owned by a plugin manifest
//                                   hotkey (read from the live manifest table).
//
// A handler keyed by the retail id itself goes live with no table edit: a
// LOCAL_ACTIONS row whose labelHash is that id (`retailActionBindingId`) or
// that carries `retailAction: <id>`, or an input-funnel action bound under
// that id (`window.__inputFunnel.actions`).

/** The canonical binding id of a retail action id, e.g. "0x10000037". */
export function retailActionBindingId(actionHash) {
  return `0x${(actionHash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** retail actionHash → the LOCAL_ACTIONS labelHash whose handler runs it. */
export const RETAIL_ACTION_LOCAL_IDS = (() => {
  const L = LOCAL_ACTION_IDS;
  const m = new Map();
  for (let n = 1; n <= 9; n++) {
    m.set(0x10000041 + n, L[`HOTBAR_${n}`]); // Quickslot 1-9 (map 0x1000000C)
    m.set(0x10000064 + n, L[`MAGIC_SLOT_${n}`]); // Spell Slot 1-9 (map 0x10000005)
  }
  // Quickslot 10-12 (0x1000004B-4D) and 13-18 (0x10000132-37) = hotbar row 2.
  for (let n = 1; n <= 3; n++) m.set(0x1000004A + n, L[`HOTBAR_R2_${n}`]);
  for (let n = 4; n <= 9; n++) m.set(0x1000012E + n, L[`HOTBAR_R2_${n}`]);
  // MagicCombat (map 0x10000005) — combat-bar.js installSpellBarHotkeys.
  m.set(0x10000060, L.MAGIC_CAST);
  m.set(0x10000061, L.MAGIC_PREV_SPELL);
  m.set(0x10000062, L.MAGIC_NEXT_SPELL);
  m.set(0x10000063, L.MAGIC_PREV_TAB);
  m.set(0x10000064, L.MAGIC_NEXT_TAB);
  m.set(0x10000102, L.MAGIC_FIRST_SPELL);
  m.set(0x10000103, L.MAGIC_LAST_SPELL);
  m.set(0x10000104, L.MAGIC_FIRST_TAB);
  m.set(0x10000105, L.MAGIC_LAST_TAB);
  // Selection (map 0x10000007) — index.html target-cycle / corpse keys.
  m.set(0x10000035, L.CLOSEST_MONSTER);
  m.set(0x10000036, L.PREV_MONSTER);
  m.set(0x10000037, L.NEXT_MONSTER);
  m.set(0x1000003E, L.USE_CLOSEST_UNOPENED_CORPSE);
  m.set(0x1000003F, L.USE_NEXT_UNOPENED_CORPSE);
  m.set(0x10000121, L.CLOSEST_UNOPENED_CORPSE);
  m.set(0x10000122, L.NEXT_UNOPENED_CORPSE);
  // Movement (map 0x00000004) — index.html retailRunKeys autorun toggle.
  m.set(0x00000030, L.AUTORUN);
  return m;
})();

const fixedKey = (label, code) => Object.freeze({ label, code });
/**
 * retail actionHash → the key this client hard-codes for it. Labels are the
 * retail StringTable 0x23000005 text (used by findConflictingBindings).
 */
export const RETAIL_ACTION_FIXED_KEYS = new Map([
  // Movement (map 0x00000004): index.html CMD_INTERP_ACTIONS forwards these
  // keys (matched on ev.key) as the retail InputAction ids. WASD/QE is a
  // deliberate modernization (survey A14 §8); retail turns on A/D, strafes
  // on Z/C and backs up on X.
  [0x29, fixedKey("Move Forward", "KeyW")],
  [0x2A, fixedKey("Move Backward", "KeyS")],
  [0x2C, fixedKey("Strafe Right", "KeyD")],
  [0x2D, fixedKey("Strafe Left", "KeyA")],
  [0x2E, fixedKey("Turn Right", "KeyE")],
  [0x2F, fixedKey("Turn Left", "KeyQ")],
  [0x31, fixedKey("Jump", "Space")],
  [0x32, fixedKey("Toggle Run/Walk", "ShiftLeft")],
  // Camera (maps 0x5 / 0x6): scene3d/camera.js A12-C2 zoom notches.
  [0x33, fixedKey("Zoom Camera In", "PageUp")],
  [0x34, fixedKey("Zoom Camera Out", "PageDown")],
  // Combat: index.html backquote toggle; combat-hud.js HEIGHTS / POWER_KEYS
  // (melee map 0x10000003, missile map 0x10000004).
  [0x1000005A, fixedKey("Toggle Combat Mode", "Backquote")],
  [0x1000005B, fixedKey("Decrease Power", "Insert")],
  [0x1000005C, fixedKey("Increase Power", "PageUp")],
  [0x1000005D, fixedKey("Low Attack", "Delete")],
  [0x1000005E, fixedKey("Medium Attack", "End")],
  [0x1000005F, fixedKey("High Attack", "PageDown")],
  [0x100000EF, fixedKey("Decrease Accuracy", "Insert")],
  [0x100000F0, fixedKey("Increase Accuracy", "PageUp")],
  [0x100000F1, fixedKey("Low Attack", "Delete")],
  [0x100000F2, fixedKey("Medium Attack", "End")],
  [0x100000F3, fixedKey("High Attack", "PageDown")],
  // Chat (map 0x1000000A): chat-panel.js Enter opens the chat bar.
  [0x10000023, fixedKey("Begin Chat Mode", "Enter")],
]);

/** retail actionHash → the "<plugin-id>::<hotkey-id>" manifest hotkey. */
export const RETAIL_ACTION_MANIFEST_HOTKEYS = new Map([
  [0x1000000D, "social-panel::toggle"],
  [0x1000000E, "allegiance-panel::toggle"],
  [0x1000000F, "fellowship-panel::toggle"],
  [0x10000011, "spellbook::toggle"],
  [0x10000017, "map-panel::toggle"],
  [0x10000018, "house-panel::toggle"],
  [0x10000019, "inventory::toggle"],
  [0x1000001A, "options-panel::toggle"],
  [0x1000012E, "contracts-panel::toggle"],
]);

/** `"KeyR"` / `{code, ctrl, …}` / null → a full binding shape, or null. */
function normalizeBinding(def) {
  if (!def) return null;
  if (typeof def === "string") {
    return { code: def, shift: false, ctrl: false, alt: false, meta: false };
  }
  if (typeof def === "object" && def.code) {
    return { code: def.code, shift: !!def.shift, ctrl: !!def.ctrl, alt: !!def.alt, meta: !!def.meta };
  }
  return null;
}

/** True when two binding shapes name the same key + modifiers. */
export function sameBinding(a, b) {
  if (!a || !b || !a.code || !b.code) return false;
  return a.code === b.code
    && !!a.shift === !!b.shift
    && !!a.ctrl === !!b.ctrl
    && !!a.alt === !!b.alt
    && !!a.meta === !!b.meta;
}

function idMatchesRetailAction(id, actionHash) {
  if (typeof id === "number") return (id >>> 0) === actionHash;
  if (typeof id !== "string" || !/^0x[0-9a-f]+$/i.test(id.trim())) return false;
  return (Number.parseInt(id.trim(), 16) >>> 0) === actionHash;
}

/** A manifest key-string's key ("F4", "I", "1") → a KeyboardEvent.code. */
function manifestKeyToCode(key) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

function defaultFunnelActions() {
  try {
    const list = globalThis.window?.__inputFunnel?.actions;
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/**
 * How this client handles one retail action. `status`:
 *   "rebindable"  — a handler reads `bindingId`; `binding` is its effective
 *                   key (override, else `defaultBinding`).
 *   "fixed"       — works on the hard-coded / manifest key `binding`.
 *   "unavailable" — nothing dispatches it.
 *
 * @param {number} actionHash — ActionMap inner key (retail action id).
 * @param {{funnelActions?: Array<{labelHash: string, defaultBinding: any}>}} [opts]
 *   funnel registrations to consider (default `window.__inputFunnel.actions`).
 * @returns {{actionHash: number, status: string, source: string|null,
 *   bindingId: string|null, defaultBinding: object|null, binding: object|null}}
 */
export function retailActionStatus(actionHash, opts = {}) {
  const ah = actionHash >>> 0;
  const out = (status, source, bindingId, defaultBinding, binding) => ({
    actionHash: ah, status, source, bindingId, defaultBinding, binding,
  });
  const rebindable = (source, id, def) => {
    const dflt = normalizeBinding(def);
    const user = load()[id];
    return out("rebindable", source, id, dflt, user && user.code ? normalizeBinding(user) : dflt);
  };
  const localId = RETAIL_ACTION_LOCAL_IDS.get(ah);
  const localRow = LOCAL_ACTIONS.find((a) => (localId != null && a.labelHash === localId)
    || a.retailAction === ah || idMatchesRetailAction(a.labelHash, ah));
  if (localRow) return rebindable("local", localRow.labelHash, localRow.defaultCode);
  const funnelActions = Array.isArray(opts.funnelActions) ? opts.funnelActions : defaultFunnelActions();
  const funnelRow = funnelActions.find((a) => idMatchesRetailAction(a?.labelHash, ah));
  if (funnelRow) return rebindable("funnel", String(funnelRow.labelHash), funnelRow.defaultBinding);
  const fixed = RETAIL_ACTION_FIXED_KEYS.get(ah);
  if (fixed) return out("fixed", "fixed", null, normalizeBinding(fixed.code), normalizeBinding(fixed.code));
  const hotkey = RETAIL_ACTION_MANIFEST_HOTKEYS.get(ah);
  if (hotkey) {
    for (const e of manifestBindings.values()) {
      if (`${e.pluginId}::${e.hotkeyId}` !== hotkey || !e.match) continue;
      const b = normalizeBinding({ ...e.match, code: manifestKeyToCode(e.match.key) });
      return out("fixed", "manifest", null, b, b);
    }
  }
  return out("unavailable", null, null, null, null);
}

function defaultActionList() {
  const am = getActionMap();
  if (Array.isArray(am?.actions) && am.actions.length > 0) return am.actions;
  try {
    const list = globalThis.window?.__acKeybindings;
    return Array.isArray(list) ? list : null;
  } catch (_) {
    return null;
  }
}

/**
 * Find a retail ActionMap row by its labelHash (number or "0x…" string —
 * the Controls rows' key) or by its label text ("Turn Left").
 *
 * @param {number|string} ref
 * @param {Array<{inputMap:number, actionHash:number, labelHash:number, label:string|null}>} [actions]
 *   defaults to the loaded ActionMap / `window.__acKeybindings`.
 */
export function retailActionForLabel(ref, actions) {
  const list = Array.isArray(actions) ? actions : defaultActionList();
  if (!list) return null;
  const isHex = typeof ref === "string" && /^0x[0-9a-f]+$/i.test(ref.trim());
  if (typeof ref === "number" || isHex) {
    const want = (typeof ref === "number" ? ref : Number.parseInt(ref.trim(), 16)) >>> 0;
    if (want === 0) return null; // unlabelled rows all carry labelHash 0
    return list.find((a) => (a?.labelHash >>> 0) === want) ?? null;
  }
  if (typeof ref !== "string") return null;
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  return list.find((a) => typeof a?.label === "string" && a.label.trim().toLowerCase() === want) ?? null;
}

/**
 * True when this client dispatches the retail action behind a Controls row
 * (labelHash or label). Unknown rows are not live.
 *
 * @param {number|string} labelHash
 * @param {{actions?: Array, funnelActions?: Array}} [opts]
 */
export function isRetailActionLive(labelHash, opts = {}) {
  const a = retailActionForLabel(labelHash, opts.actions);
  if (!a) return false;
  return retailActionStatus(a.actionHash, opts).status !== "unavailable";
}

/** The key that fires a retail action in this client (binding shape), or null. */
export function effectiveBindingFor(labelOrHash, opts = {}) {
  const a = retailActionForLabel(labelOrHash, opts.actions);
  if (!a) return null;
  const b = retailActionStatus(a.actionHash, opts).binding;
  return b ? { ...b } : null;
}

/** `effectiveBindingFor(...)?.code` — e.g. effectiveKeyFor("Turn Left") → "KeyQ". */
export function effectiveKeyFor(labelOrHash, opts = {}) {
  return effectiveBindingFor(labelOrHash, opts)?.code ?? null;
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
  if (!dev) return null;
  const ofsKey = (mapping.key >>> 16) & 0xFFFF;
  const modifiers = {
    shift: !!(mapping.modifier & 0x80000000),
    ctrl:  !!(mapping.modifier & 0x40000000),
    alt:   !!(mapping.modifier & 0x20000000),
    meta:  !!(mapping.modifier & 0x10000000),
  };
  if (dev.type === 1) { // Keyboard
    const code = DIK_TO_KEYBOARD_EVENT_CODE[ofsKey];
    if (!code) return null;
    return { code, ...modifiers };
  }
  // Rec #72 — engine-level mouse + joystick bindings. retail never
  // surfaces a rebind UI for them and the browser doesn't fire a
  // matching KeyboardEvent so matchesBinding can never hit; we return
  // a synthetic, labelled binding shape so the Controls capture UI
  // can render the retail default ("Mouse:Left", "Joystick:Button 4")
  // as read-only metadata.
  if (dev.type === 2) { // Mouse
    return { code: mouseCode(ofsKey, (mapping.key >>> 8) & 0xFF), ...modifiers };
  }
  if (dev.type >= 3) { // Joystick / GamePad family
    return { code: joystickCode(ofsKey), ...modifiers };
  }
  return null;
}

// input-options-6 — a mouse control's `ofsKey` is a DirectInput mouse data
// offset (ControlNameMapper::LoadSemantics acclient.c:674995: DIMOFS_X 0,
// DIMOFS_Y 4, DIMOFS_Z / DIMOFS_WHEEL 8, DIMOFS_BUTTON0-7 0xC-0x13), not a
// button index; the wheel's sub-control (key bits 8-15) is 1 = up, 2 = down.
// DefaultMap 0x14000002 binds DIMOFS_BUTTON2 (middle) to Toggle Mouselook.
const MOUSE_BUTTON_LABEL = Object.freeze({
  0x0C: "Mouse:Left",
  0x0D: "Mouse:Right",
  0x0E: "Mouse:Middle",
  0x0F: "Mouse:X1",
  0x10: "Mouse:X2",
});
function mouseCode(ofs, sub = 0) {
  if (ofs === 0x08) return sub === 1 ? "Mouse:WheelUp" : sub === 2 ? "Mouse:WheelDown" : "Mouse:Wheel";
  if (ofs === 0x00) return "Mouse:X";
  if (ofs === 0x04) return "Mouse:Y";
  if (ofs >= 0x0C && ofs <= 0x13) return MOUSE_BUTTON_LABEL[ofs] ?? `Mouse:Button${ofs - 0x0C}`;
  return `Mouse:${ofs}`;
}
function joystickCode(ofs) {
  // DirectInput offsets: low byte = button index, high byte = sub-axis
  // (hat / pov). We round-trip the raw offset into a stable label so
  // the Controls UI can still show "Joystick:Button 7" without our
  // having to fully decode the sub-control encoding.
  const button = ofs & 0xFF;
  const sub = (ofs >> 8) & 0xFF;
  if (sub === 0) return `Joystick:Button ${button}`;
  return `Joystick:Axis${sub}:${button}`;
}

let retailKeyMapPromise = null;
let retailKeyMapCache = null;

/** "gmDefaultMap" — the game key map (portal 0x14000000). */
export const RETAIL_GAME_KEYMAP_ID = 0x14000000;
/** "DefaultMap" — the engine key map retail merges after it (0x14000002). */
export const RETAIL_ENGINE_KEYMAP_ID = 0x14000002;

/**
 * Index parsed KeyMap records (`fetch_key_map` JSON), in merge order, into
 * `{ raw, raws, byActionHash, byCategoryAction }` (see loadRetailKeyMap).
 * Each record's mappings decode against ITS OWN `devices[]`. A
 * (category, action) default already set by an earlier map is kept
 * (input-options-6: gmDefaultMap wins over DefaultMap on a duplicate);
 * `byActionHash` collects every distinct binding of every map. Pure.
 *
 * @param {object|Array<object>} raws
 */
export function indexRetailKeyMaps(raws) {
  const maps = (Array.isArray(raws) ? raws : [raws]).filter((r) => r && Array.isArray(r.mappings));
  const byActionHash = new Map();
  const byCategoryAction = new Map();
  for (const raw of maps) {
    const mine = new Map(); // this map's bindings, for its primaries
    for (const m of raw.mappings) {
      const binding = qualifiedControlToBinding(m, raw.devices);
      if (!binding) continue;
      const enriched = { inputMap: m.input_map >>> 0, ...binding };
      const ah = m.action_hash >>> 0;
      let arr = mine.get(ah);
      if (!arr) { arr = []; mine.set(ah, arr); }
      arr.push(enriched);
      let all = byActionHash.get(ah);
      if (!all) { all = []; byActionHash.set(ah, all); }
      if (!all.some((b) => b.inputMap === enriched.inputMap && sameBinding(b, enriched))) all.push(enriched);
    }
    for (const [actionHash, bindings] of mine) {
      // Group bindings by inputMap (same action may have variants in
      // multiple categories), then pick a primary per category.
      const byCat = new Map();
      for (const b of bindings) {
        let arr = byCat.get(b.inputMap);
        if (!arr) { arr = []; byCat.set(b.inputMap, arr); }
        arr.push(b);
      }
      for (const [cat, arr] of byCat) {
        const key = `${cat}:${actionHash}`;
        if (byCategoryAction.has(key)) continue; // an earlier map's default stands
        const plain = arr.find((b) => !b.shift && !b.ctrl && !b.alt && !b.meta);
        byCategoryAction.set(key, plain ?? arr[0]);
      }
    }
  }
  return { raw: maps[0] ?? null, raws: maps, byActionHash, byCategoryAction };
}

/** Test seam — drop the cached retail KeyMap. */
export function _resetRetailKeyMapForTest() {
  retailKeyMapCache = null;
  retailKeyMapPromise = null;
}

/**
 * Load + index the retail KeyMap (DAT type 0x14). Default record is
 * `0x14000000` ("gmDefaultMap"), the factory binding set; loading it also
 * merges DefaultMap `0x14000002` after it, as retail does.
 *
 * Returns `{ raw, raws, byActionHash, byCategoryAction }`:
 *   - `raw` is the wasm JSON output verbatim (the requested record);
 *     `raws` lists every merged record in merge order.
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
 * @returns {Promise<null | {raw: object, raws: Array<object>, byActionHash: Map<number, Array>, byCategoryAction: Map<string, object>}>}
 */
export async function loadRetailKeyMap(id = 0x14000000) {
  if (retailKeyMapCache) return retailKeyMapCache;
  if (retailKeyMapPromise) return retailKeyMapPromise;
  retailKeyMapPromise = (async () => {
    // R9 (2026-08-03) — yield before touching anything. The `!wasm` branch
    // below is a SYNCHRONOUS early return inside this async IIFE, so its
    // `finally { retailKeyMapPromise = null }` used to run BEFORE the
    // `retailKeyMapPromise = (...)()` assignment completed; the assignment
    // then re-pinned the already-settled null promise and the
    // `if (retailKeyMapPromise) return retailKeyMapPromise` guard handed it
    // out for the rest of the session, so the retail keymap never loaded
    // once anything called this before wasm was up. ac_layout.js documents
    // the same ordering hazard on loadLayout.
    await Promise.resolve();
    try {
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      // Kept INSIDE the try so the `finally` still clears
      // retailKeyMapPromise — an early return above it pins the settled
      // promise, which is the very bug this block fixes.
      if (!wasm?.fetch_key_map) {
        retailKeyMapCache = null;
        return null;
      }
      const json = await wasm.fetch_key_map(id >>> 0);
      const raw = json === "null" ? null : JSON.parse(json);
      if (!raw) {
        retailKeyMapCache = null;
        return null;
      }
      const raws = [raw];
      // input-options-6 — retail merges the engine DefaultMap after
      // gmDefaultMap (gmKeyboardUI::InitOptions acclient.c:268397:
      // DBObj::GetByEnum(0x10000001, 10, 0x1D), then CMasterInputMap::Merge
      // with GetByEnum(1, 10, 0x1D)). It carries the camera keys (numpad
      // rotate / zoom / views, middle-button mouselook) gmDefaultMap lacks.
      // Best-effort: if it fails, gmDefaultMap alone is still shown (and
      // cached, so the Controls page does not re-fetch on every render).
      if ((id >>> 0) === RETAIL_GAME_KEYMAP_ID) {
        try {
          const json2 = await wasm.fetch_key_map(RETAIL_ENGINE_KEYMAP_ID);
          const raw2 = json2 === "null" ? null : JSON.parse(json2);
          if (raw2) raws.push(raw2);
        } catch (err) {
          console.warn("[keymap] retail DefaultMap 0x14000002 load failed (showing gmDefaultMap only):", err);
        }
      }
      const { byActionHash, byCategoryAction } = indexRetailKeyMaps(raws);
      retailKeyMapCache = { raw, raws, byActionHash, byCategoryAction };
      try {
        window.__diag?.input?.onRetailKeyMapLoaded?.({
          id,
          mappings: raws.reduce((n, r) => n + r.mappings.length, 0),
          actions: byActionHash.size,
          merged: raws.map((r) => r.id >>> 0),
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
 * Resolve an action hash to its retail-friendly label (from the
 * StringTable referenced by ActionMap.string_table_data_id). Returns
 * the human label when the ActionMap is loaded AND the lookup hits a
 * resolved label; otherwise falls back to `"0x{hash}"` so the Controls
 * tab can render a stable identifier in either state.
 *
 * Pass `opts.fallback = "—"` to use a different placeholder when no
 * label is known.
 *
 * @param {number} actionHash
 * @param {{fallback?: string}} [opts]
 * @returns {string}
 */
export function actionHashLabel(actionHash, opts) {
  const hash = (actionHash >>> 0);
  const a = findActionByHash(hash);
  const label = a?.label;
  if (typeof label === "string" && label.trim().length > 0) return label;
  if (opts?.fallback) return opts.fallback;
  return `0x${hash.toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * Build a `Map<actionHash, label>` for every action currently in the
 * cached ActionMap. Useful for the Controls capture UI's group-by-
 * category + alphabetize pass. Empty map when the ActionMap hasn't
 * loaded yet. Same fallback semantics as `actionHashLabel` —
 * unresolved labels are skipped from the map; the caller can call
 * `actionHashLabel(hash)` for the hex-string default.
 *
 * @returns {Map<number, string>}
 */
export function getActionHashLabelMap() {
  const out = new Map();
  const am = getActionMap();
  if (!am?.actions) return out;
  for (const a of am.actions) {
    const label = a?.label;
    if (typeof label !== "string" || label.trim().length === 0) continue;
    out.set(a.actionHash >>> 0, label);
  }
  return out;
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

// HUD rec #113 — manifest-hotkey-conflict store + accessors.
// buildManifestBindings() returns the duplicate list at build time but
// the previous host startup only console.warn'd it. Persist it now so
// the Controls tab (and any other UI) can surface conflicts to the
// player and offer rebind. setManifestHotkeyConflicts is called from
// the host alongside setManifestBindings; getManifestHotkeyConflicts
// returns a defensive copy of the most recent list.
let manifestConflicts = [];
export function setManifestHotkeyConflicts(list) {
  manifestConflicts = Array.isArray(list) ? list.map((d) => ({
    keyString: d?.keyString || "",
    conflicts: Array.isArray(d?.conflicts) ? [...d.conflicts] : [],
  })) : [];
}
export function getManifestHotkeyConflicts() {
  return manifestConflicts.map((d) => ({
    keyString: d.keyString,
    conflicts: [...d.conflicts],
  }));
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
