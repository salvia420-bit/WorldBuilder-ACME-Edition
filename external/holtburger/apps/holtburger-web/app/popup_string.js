// app/popup_string.js — chat-errors-7 (2026-10-13): GameEvent PopupString
// (0x0004) opens retail's OK message dialog instead of a chat line.
//
// Retail ClientCommunicationSystem::Handle_Communication__PopUpString
// (acclient.c:425219) wraps the text in a StringInfo literal, builds a
// PropertyCollection {0x8E = 3 (the OK message dialog), 0xC3 = 1, 0xC5 = the
// text} and calls DialogFactory::MakeDialogInCurrentUI. There is no
// AddTextToScroll, so nothing reaches the chat window. Vanilla ACE sends it on
// a character's first login (popup_header + popup_motd + popup_welcome, the
// Society Greeter instructions — WorldManager.cs PlayerEnterWorld), on every
// login while popup_motd is set, for EmoteType.PopUp quest emotes
// (EmoteManager.cs) and for the DAT version warning (DDDHandler.cs).
//
// The wasm keeps emitting the kind=2 ChatReceived event ("[Popup] <text>" at
// CHAT_CATEGORY_POPUP — the PopupString arm in src/session/messages/
// game_event.rs is the only wasm producer of that category), so the plugin
// chat hook, rynth's event tap (CHAT_KEEP includes 10) and VT ChatMatch see
// no change. Only the display moves: app/client_events.js asks
// routePopupString() first and appends the chat line only when it declines.
// The dialog is plugins/modal-dialog.js with `hideCancel` (one OK button, no
// title row, Enter / Esc close it); successive popups wait in its queue.
//
// The chat line stays (routePopupString returns false) when:
//   - `?popupDialog=off` (or 0 / false);
//   - an agent / bot session (`?agent=1`, `?autoLogin=1` unless
//     `autoSpawn=select`, `?bot=1`): a modal that captures Enter / Esc would
//     sit on a headless driver's screen from the first-login welcome popup
//     on. `?popupDialog=on` forces the dialog there too (eye tests);
//   - the dialog could not be opened (no DOM, the open call threw).

import { CHAT_CATEGORY } from "./chat_log.js";
import { modalConfirmCallback } from "../plugins/modal-dialog.js";

/** The wasm PopupString arm's chat-line prefix (`format!("[Popup] {}", …)`). */
export const POPUP_CHAT_PREFIX = "[Popup] ";

function searchOf(search) {
  if (typeof search === "string") return search;
  try { return globalThis.location?.search ?? ""; } catch (_) { return ""; }
}

/** The `?popupDialog` value, lower-cased, or null when absent. */
function popupDialogParam(search) {
  try {
    const v = new URLSearchParams(searchOf(search)).get("popupDialog");
    return v == null ? null : String(v).toLowerCase();
  } catch (_) {
    return null;
  }
}

/** `?popupDialog` — DEFAULT ON; `off` / `0` / `false` keep the chat line. */
export function popupDialogEnabled(search) {
  const v = popupDialogParam(search);
  return !(v === "off" || v === "0" || v === "false");
}

/**
 * sessionStorage key: the /logout return query that keeps the agent layout.
 * index.html __logOutToCharacterSelect writes it from an agent-mode page and
 * clears it from any other.
 */
export const LOGOUT_AGENT_RETURN_KEY = "hbLogoutAgentReturn";

/**
 * Does an agent drive this page? `?agent=1`, or `?autoLogin=1` with any
 * autoSpawn except `select`. SHELL-3 residual (2026-10-18 follow-up):
 * `?autoLogin=1&autoSpawn=select` is the /logout return (index.html
 * __logOutToCharacterSelect) and invite links — a person at the retail
 * character screen, as app/character_select.js characterSelectWanted already
 * reads it. The /logout return keeps the layout of the page that logged out,
 * though: from an agent-mode page (the desktop shortcut's `?autoLogin=1`) it
 * stays full-bleed, through LOGOUT_AGENT_RETURN_KEY holding exactly its query.
 * index.html's inline `agent-mode` toggle repeats this test (it runs before
 * any module loads); tests/shell_agent_mode_select.test.mjs keeps the two in
 * step.
 */
export function agentModeWanted(search, storage) {
  try {
    const q = searchOf(search);
    const p = new URLSearchParams(q);
    if (p.get("agent") === "1") return true;
    if (p.get("autoLogin") === "1") {
      if (p.get("autoSpawn") !== "select") return true;
      const s = storage === undefined ? globalThis.sessionStorage : storage;
      return s?.getItem?.(LOGOUT_AGENT_RETURN_KEY) === q;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** An agent / bot driven page (index.html's `agent-mode` test plus `?bot=1`). */
export function popupDialogAgentSession(search) {
  if (agentModeWanted(search)) return true;
  try {
    return new URLSearchParams(searchOf(search)).get("bot") === "1";
  } catch (_) {
    return false;
  }
}

/** Whether a PopupString opens the dialog on this page. */
export function popupDialogActive(search) {
  if (!popupDialogEnabled(search)) return false;
  const v = popupDialogParam(search);
  if (v === "on" || v === "1" || v === "true") return true;
  return !popupDialogAgentSession(search);
}

/**
 * The PopupString text carried by a kind=2 chat line, or null when the line
 * is not one (wrong category or no `[Popup] ` prefix).
 */
export function popupStringFromChat(text, category) {
  if (category !== CHAT_CATEGORY.POPUP) return null;
  if (typeof text !== "string" || !text.startsWith(POPUP_CHAT_PREFIX)) return null;
  return text.slice(POPUP_CHAT_PREFIX.length);
}

/**
 * Open retail's OK message dialog for a PopupString chat line. Returns true
 * when the dialog took the line (the caller must not append it to the chat
 * log), false otherwise. `opts.open` replaces modalConfirmCallback (tests).
 */
export function routePopupString(text, category, opts = {}) {
  const message = popupStringFromChat(text, category);
  if (message == null) return false;
  if (!popupDialogActive(opts.search)) return false;
  const open = typeof opts.open === "function" ? opts.open : modalConfirmCallback;
  try {
    open({ message, hideCancel: true, confirmLabel: "OK" });
    return true;
  } catch (e) {
    console.warn("[popupString] dialog failed, keeping the chat line:", e);
    return false;
  }
}
