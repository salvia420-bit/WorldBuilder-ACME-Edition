// app/jump_refusal_text.js — the chat line for a ClientEvent kind=56
// JUMP_REFUSED (`u32Payload` = the ?jumpParity charge / release refusal code).
//
// chat-errors-7 / area MISSED-1 (2026-10-13): retail prints its own
// client-side strings, not ACE-style wording. The globals are initialised at
// acclient.c:796298 (cant_jump_position), :796309 (cant_jump_in_air) and
// :796320 (cant_jump_load) — no trailing punctuation — and go out through
// ClientSystem::AddTextToScroll(…, 0x1A, …): ClientCombatSystem::CommenceJump
// (acclient.c:408045-408056, press: 72 position, 73 load) and DoJump
// (:408193-408203, release: 73 load, 72 position, 36 in air; any other code
// prints nothing — `default: return`). Text type 0x1A is the spew box, which
// holtburger files under CHAT_CATEGORY.TRANSIENT (as chat_format.rs
// failure_chat_category does for the same three WeenieErrors). That also
// leaves CHAT_CATEGORY.POPUP to PopupString alone.
//
// `?retailFailureText=off` (the WeenieError wording switch) restores the old
// ACE-style lines at the POPUP category.

import { CHAT_CATEGORY } from "./chat_log.js";
import { retailFailureTextEnabled } from "../plugins/weenie_error_messages.js";

/** Retail refusal code → the client global's text (acclient.c:796298-796320). */
export const RETAIL_JUMP_REFUSAL_TEXT = Object.freeze({
  72: "You can't jump from this position",
  36: "You can't jump while in the air",
  73: "You're too loaded down to jump",
});

function legacyJumpRefusalText(code) {
  return code === 73 ? "You are too encumbered to jump!"
    : code === 72 ? "You can't jump from this position!"
    : code === 36 ? "You're in the air!"
    : "You can't jump right now.";
}

/**
 * The chat line for refusal `code`: `{ text, category }`, or null when retail
 * prints nothing for it. `search` defaults to the page's query string.
 */
export function jumpRefusalLine(code, search) {
  const c = code >>> 0;
  if (!retailFailureTextEnabled(search)) {
    return { text: legacyJumpRefusalText(c), category: CHAT_CATEGORY.POPUP };
  }
  const text = RETAIL_JUMP_REFUSAL_TEXT[c];
  return text ? { text, category: CHAT_CATEGORY.TRANSIENT } : null;
}
