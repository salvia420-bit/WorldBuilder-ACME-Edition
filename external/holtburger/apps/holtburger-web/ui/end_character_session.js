// ui/end_character_session.js — retail CM_UI::SendNotice_EndCharacterSession(1)
// for the HUD (inventory-session-5, 2026-10-13).
//
// Retail has two HUD ways to log off, and both raise EndCharacterSession(1):
//   * the indicator strip's seventh button, LogoffButton 0x100000FA
//     (gmFloatyIndicatorsUI::ListenToElementMessage, acclient.c:259108);
//   * Options → Gameplay "Exit to Character Selection",
//     GameplayOptions_LeaveWorld_Button 0x10000203
//     (gmGameplayOptionsUI::ListenToElementMessage, :215373).
// gmGamePlayUI::RecvNotice_EndCharacterSession (:280799) then opens the
// Yes / No dialog ID_Client_EndCharacterSessionConfirm (table enum
// 0x10000001 = StringTable 0x23000001) through MakeLogoutConfirmationDialog
// (:280413), which refuses a second dialog while one is open
// (m_logoutContext). Yes is the confirmed log-off: index.html
// window.__logOutToCharacterSelect (mid-air refusal, "Logging off...",
// 0xF653, back to the character screen). `/logout` takes that path without
// the dialog, like retail's End Character Session key (HandleKeyPress action
// 0x10000026, :279352).

import { acString, loadStringTable } from "./ac_strings.js";

/** StringTable holding ID_Client_EndCharacterSessionConfirm (table enum 0x10000001). */
export const END_CHARACTER_SESSION_STRING_TABLE = 0x23000001;
export const END_CHARACTER_SESSION_CONFIRM_TOKEN = "ID_Client_EndCharacterSessionConfirm";
/** compute_str_hash(END_CHARACTER_SESSION_CONFIRM_TOKEN) — the table key. */
export const END_CHARACTER_SESSION_CONFIRM_KEY = 0x0EB1C41D;
/**
 * The client_local_English.dat value (StringTable 0x23000001, key
 * 0x0EB1C41D; the DAT spells each newline as the two characters `\n`).
 * Used until the table is loaded.
 */
export const END_CHARACTER_SESSION_CONFIRM_TEXT =
  "This will exit your character from the game world.\n\nAre you sure?";

/** True when this page has the log-off path (index.html). */
export function logOffAvailable(win = globalThis.window) {
  return typeof win?.__logOutToCharacterSelect === "function";
}

/**
 * The dialog text: the DAT string when `lookup(tableId, key)` (ui/ac_strings.js
 * acString) has it, its literal `\n` escapes turned into newlines; else the
 * English value.
 */
export function endCharacterSessionConfirmText(lookup) {
  let text = null;
  if (typeof lookup === "function") {
    try {
      text = lookup(END_CHARACTER_SESSION_STRING_TABLE, END_CHARACTER_SESSION_CONFIRM_KEY);
    } catch (_) { text = null; }
  }
  if (typeof text !== "string" || !text) return END_CHARACTER_SESSION_CONFIRM_TEXT;
  return text.replace(/\\n/g, "\n");
}

// gmGamePlayUI::m_logoutContext — one confirmation at a time.
let dialogOpen = false;

/** True while the confirmation is up (tests). */
export function endCharacterSessionDialogOpen() {
  return dialogOpen;
}

/**
 * EndCharacterSession(1): ask, then log off on Yes. Resolves true when the
 * log-off started; false when the page has no log-off path, a confirmation
 * is already open, the player said No, or the log-off was refused (mid-air).
 *
 * @param {object} [opts]
 * @param {object} [opts.win]       window (tests pass a stub)
 * @param {Function} [opts.confirm] ({message, confirmLabel, cancelLabel}) → Promise<boolean>;
 *                                  default win.__modalConfirm (plugins/modal-dialog.js)
 * @param {Function} [opts.lookup]  (tableId, key) → string|null; default acString
 * @param {Function} [opts.load]    (tableId) → Promise; default loadStringTable
 * @returns {Promise<boolean>}
 */
export async function requestEndCharacterSession(opts = {}) {
  const win = opts.win ?? globalThis.window;
  if (!logOffAvailable(win)) return false;
  if (dialogOpen) return false;
  const ask = typeof opts.confirm === "function" ? opts.confirm
    : typeof win.__modalConfirm === "function" ? win.__modalConfirm
    : null;
  if (!ask) return false;
  dialogOpen = true;
  let yes = false;
  try {
    const load = typeof opts.load === "function" ? opts.load : loadStringTable;
    try { await load(END_CHARACTER_SESSION_STRING_TABLE); } catch (_) { /* English fallback */ }
    const message = endCharacterSessionConfirmText(opts.lookup ?? acString);
    yes = (await ask({ message, confirmLabel: "Yes", cancelLabel: "No" })) === true;
  } catch (_) {
    yes = false;
  } finally {
    dialogOpen = false;
  }
  if (!yes || !logOffAvailable(win)) return false;
  try {
    return (await win.__logOutToCharacterSelect()) === true;
  } catch (_) {
    return false;
  }
}
