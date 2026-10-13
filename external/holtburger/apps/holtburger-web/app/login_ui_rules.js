// app/login_ui_rules.js — retail character-select rules (round 4, 2026-10-08).
//
// login-2: gmUIFlow::RecvNotice_CharacterError (acclient.c:183837) maps each
//   CharacterError code to an ID_CHAR_ERROR_* string. Codes 1, 3, 4/8, 9,
//   10, 14, 21, 24 use UI mode 0x10000002 (fatal: back to the logon
//   screen); 5, 6, 11-13, 15-20, 23 use 0x1000000A (stay on character
//   select); anything else (2 LoggedOn, 7 NoPremade, 22 CharacterIsBooted)
//   shows nothing. The English texts are the client_local_English.dat
//   string-table values (ACE's CharacterError.cs comments quote the same
//   strings). ID_CHAR_ERROR_ENTER_GAME_GENERIC's table value really is the
//   literal "ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER" (ACE CharacterError.cs
//   documents the popup); OLD_CHARACTER itself has no text.
// login-3: CharacterIdentity.secondsGreyedOut_ (acclient.h:30557) — ACE
//   sends `Math.Max(1, now − DeleteTime)` while a deletion is pending, a
//   greyed-out flag, not an epoch. gmCharacterManagementUI::
//   RebuildCharacterList (acclient.c:281100) greys those rows and moves them
//   to the end (:281369-281375). The delete confirmation is
//   ID_CharacterManagement_DeleteCharacterConfirmation (string table),
//   which asks for DELETE to be typed.
//
// `?retailCharErrors=off` / `?retailCharList=off` restore the old texts /
// list rendering. `?retailCharErrors=off` also keeps the raw enum label for
// a 0xF643 character-creation rejection (chargenErrorInfo below).

function params(search) {
  try { return new URLSearchParams(search ?? globalThis.location?.search ?? ""); }
  catch (_) { return new URLSearchParams(""); }
}
const isOff = (v) => v === "off" || v === "0" || v === "false";

export function retailCharErrorsEnabled(search) {
  const v = params(search).get("retailCharErrors");
  return !isOff(v);
}
export function retailCharListEnabled(search) {
  const v = params(search).get("retailCharList");
  return !isOff(v);
}

const FATAL = "fatal";
const SELECT = "select";
const IGNORE = "ignore";

/** code → [mode, retail text]. */
const CHARACTER_ERRORS = Object.freeze({
  0x01: [FATAL, "Cannot have two accounts logged on at the same time."],
  0x03: [FATAL, "Server could not access your account information. Please try again in a few minutes."],
  0x04: [FATAL, "The server has disconnected. Please try again in a few minutes."],
  0x05: [SELECT, "Server could not log off your character."],
  0x06: [SELECT, "Server could not delete your character."],
  0x08: [FATAL, "The server has disconnected. Please try again in a few minutes."],
  0x09: [FATAL, "The account name you specified was not valid."],
  0x0A: [FATAL, "The account you specified doesn't exist."],
  0x0B: [SELECT, "ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER"],
  0x0C: [SELECT, "You cannot enter the game with a stress creating character."],
  0x0D: [SELECT, "One of your characters is still in the world. Please try again in a few minutes."],
  0x0E: [FATAL, "Server unable to find player account. Please try again later."],
  0x0F: [SELECT, "You do not own this character."],
  0x10: [SELECT, "One of your characters is currently in the world. Please try again later. This is likely an internal server error."],
  0x11: [SELECT, ""],
  0x12: [SELECT, "This character's data has been corrupted. Please delete it and create a new character."],
  0x13: [SELECT, "This character's starting server is experiencing difficulties.  Please try again in a few minutes."],
  0x14: [SELECT, "This character couldn't be placed in the world right now. Please try again in a few minutes."],
  0x15: [FATAL, "Sorry, but the Asheron's Call server is full currently. Please try again later."],
  0x17: [SELECT, "A save of this character is still in progress, please try again later."],
  0x18: [FATAL, "Your subscription to this game has expired."],
});

/**
 * Retail RecvNotice_CharacterError for `code`: `{ mode, text }` with mode
 * "fatal" (back to logon), "select" (stay on character select) or "ignore"
 * (show nothing).
 */
export function characterErrorInfo(code) {
  const row = CHARACTER_ERRORS[code >>> 0];
  if (!row) return { mode: IGNORE, text: "" };
  return { mode: row[0], text: row[1] };
}

// maps-chargen-barber-2 (2026-10-13): gmCharGenMainUI::
//   RecvNotice_CharGenVerificationResponse (acclient.c:278557) shows each
//   non-Ok 0xF643 CharGenVerificationResponse as one of four
//   ID_Character_Err_* strings: 3 NameInUse → NameReserved, 4 NameBanned →
//   NameBanned, 7 AdminPrivilegeDenied → NameAdminDenied, anything else
//   (Pending, Corrupt, DatabaseDown, unknown) → NameDBDown. The string is
//   looked up by compute_str_hash in table enum 0x10000002 (StringTable
//   0x23000002) and shown in MakeErrorMessageDialog; the player stays in
//   character creation. The English texts are that table's
//   client_local_English.dat values. Same `?retailCharErrors=off` escape.

/** StringTable holding the ID_Character_Err_* texts (table enum 0x10000002). */
export const CHARGEN_ERROR_STRING_TABLE = 0x23000002;

/**
 * Retail compute_str_hash (acclient.c:78974): h = c + 16·h over the signed
 * chars, folding the top nibble back in; a result of −1 becomes −2. Equals
 * holtburger-dat utils::spellbase_string_hash (NOT utils::string_hash,
 * which is a rotate-xor). Characters are taken as their low byte (the
 * tokens are ASCII).
 */
export function computeStrHash(str) {
  const s = String(str ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i) & 0xFF;
    if (c >= 0x80) c -= 0x100; // signed char
    h = (c + h * 16) >>> 0;
    if (h & 0xF0000000) h = ((h ^ ((h & 0xF0000000) >>> 24)) & 0x0FFFFFFF) >>> 0;
  }
  return h === 0xFFFFFFFF ? 0xFFFFFFFE : h;
}

const CHARGEN_ERROR_TEXTS = Object.freeze({
  ID_Character_Err_NameReserved: "The name you have selected is already in use.",
  ID_Character_Err_NameBanned: "Sorry, but that name is not permitted. Please choose another.",
  ID_Character_Err_NameAdminDenied: "Sorry, but you do not have the privileges to make an administrator character.",
  ID_Character_Err_NameDBDown: "The server cannot create your new character at this time. Please try again later.",
});

/** The retail string token for a 0xF643 code; null for Ok (1). */
export function chargenErrorToken(code) {
  switch (code >>> 0) {
    case 1: return null;
    case 3: return "ID_Character_Err_NameReserved";
    case 4: return "ID_Character_Err_NameBanned";
    case 7: return "ID_Character_Err_NameAdminDenied";
    default: return "ID_Character_Err_NameDBDown";
  }
}

/**
 * Retail rejection for a 0xF643 code: `{ token, stringId, text, nameError }`,
 * or null for Ok. `lookup(tableId, stringId)` (ui/ac_strings.js acString)
 * gives the DAT text once StringTable 0x23000002 is loaded; until then the
 * English value is used. `nameError` marks the three name codes, whose fix
 * is on the name page.
 */
export function chargenErrorInfo(code, lookup) {
  const token = chargenErrorToken(code);
  if (!token) return null;
  const stringId = computeStrHash(token);
  let text = null;
  if (typeof lookup === "function") {
    try { text = lookup(CHARGEN_ERROR_STRING_TABLE, stringId); } catch (_) { text = null; }
  }
  if (typeof text !== "string" || !text) text = CHARGEN_ERROR_TEXTS[token];
  return { token, stringId, text, nameError: token !== "ID_Character_Err_NameDBDown" };
}

/** `deleteTime` / secondsGreyedOut ≠ 0 → the row is greyed (pending deletion). */
export function isGreyedOut(c) {
  return (Number(c?.deleteTime) || 0) !== 0;
}

/**
 * RebuildCharacterList order: active characters first, greyed-out ones at
 * the end, each keeping its ORIGINAL list index (`slot`) — the wire
 * CharacterDelete takes the server's slot, not the display row.
 */
export function orderCharacterRows(list) {
  const rows = Array.from(list ?? [], (c, slot) => ({ c, slot, greyed: isGreyedOut(c) }));
  return [...rows.filter((r) => !r.greyed), ...rows.filter((r) => r.greyed)];
}

/** ID_CharacterManagement_DeleteCharacterConfirmation with %Player_1. */
export function deleteConfirmationText(name) {
  return `WARNING! ${name} will be deleted. Restoration can be attempted only within one hour of deletion, ` +
    "and may not be successful. Even if you restore, you will permanently lose all allegiance information " +
    "AND any house you own.\nIf you wish to delete this character anyway, type 'DELETE' in the box below " +
    "and press the Done button.";
}

/** The confirmation passes only when DELETE was typed. */
export function deleteConfirmationAccepted(input) {
  return String(input ?? "").trim().toUpperCase() === "DELETE";
}

// login-1 (round 4, 2026-10-08): retail CPlayerSystem::RequestLogOff
// (acclient.c:400355) prints "Logging off..." and sends
// Proto_UI::LogOffCharacter (0xF653) so the server saves and removes the
// character instead of leaving it in the world until the dead-session
// timeout. This page cannot yet return to the character list in place (one
// spawn per page load), so the only caller is page teardown; the send is
// best-effort there (the wasm loop must still run once before the socket
// closes). `?logOffOnUnload=off` skips it.
export function logOffOnUnloadEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("logOffOnUnload");
    return !isOff(v);
  } catch (_) { return true; }
}

/**
 * Request a retail log-off on `handle` (needs the round-4 `logOffCharacter`
 * export). `append(text)` prints the chat line. Returns true when sent.
 */
export function requestLogOff(handle, append) {
  if (typeof handle?.logOffCharacter !== "function") return false;
  try { if (typeof append === "function") append("Logging off..."); } catch (_) { /* display only */ }
  try { handle.logOffCharacter(); return true; } catch (_) { return false; }
}
