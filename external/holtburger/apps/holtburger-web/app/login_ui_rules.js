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
// list rendering.

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
