// ui/spew_box.js — chat-errors-6 (2026-10-13): retail's spew box, the
// transient notice strip over the 3D view (gmSpewBoxUI). Pure model, no DOM;
// plugins/rejection_feedback.js draws the rows (its toast surface), and
// app/chat_log.js appendChatLine routes the lines here.
//
// Retail routing of text type 0x1A (holtburger's CHAT_CATEGORY_TRANSIENT, 9):
//   - gmSpewBoxUI::RecvNotice_DisplayFinalStringInfo (acclient.c:261680)
//     queues a line only when `i_type == 26`.
//   - gmSpewBoxUI::Update (:261533) right-trims each queued line, deletes the
//     top item when its text is identical, inserts the new item at index 0
//     and deletes the last item once the list holds more than
//     m_maxConcurrentItems.
//   - Every chat window's ChatInterface constructor (:288204) clears that one
//     bit of its text-type filter (`m_llTextTypeFilter &= 0xFBFFFFFF`,
//     :288232), so a 0x1A line reaches the chat log only when the player
//     turns the "Errors" chat option on.
//
// Constants checked against our client_local_English.dat (WB.Terminal
// `chorizite-dump-layout-tree` 0x21000011, 2026-10-13):
//   - ListBox 0x10000049 property 0x10000028 = 4. gmSpewBoxUI::PostInit
//     (:261331) reads it into m_maxConcurrentItems (default 1 when absent).
//   - Item template 0x1000004A, state 0x10000002: a Pause media of 5 s
//     (min = max = 5), then element message 0x10000003, which
//     gmSpewBoxUI::ListenToElementMessage (:261092) answers with DeleteItem.
//     Each row therefore lives 5 s from its own insertion.
// (WebAC packages/renderer/src/ui/SpewBoxModel.ts, AGPL-3.0, reads the same
// two values.)
//
// `?spewBox=off` (or 0 / false) restores the chat-log copy of every
// transient line and the single replace-in-place toast.

/** holtburger chat category for retail text type 0x1A (src/lib.rs). */
export const CHAT_CATEGORY_TRANSIENT = 9;
/** ListBox 0x10000049 property 0x10000028 (m_maxConcurrentItems). */
export const SPEW_MAX_ITEMS = 4;
/** Item template 0x1000004A state 0x10000002: Pause 5 s → message 0x10000003. */
export const SPEW_ITEM_LIFETIME_MS = 5000;
/** localStorage key of the per-viewer "Errors" chat option ("1" = on). */
export const CHAT_ERRORS_KEY = "hb_chat_errors";

// Lines holtburger tags TRANSIENT that retail prints at another text type,
// so they belong in the chat log and never in the spew box. src/lib.rs
// `spellcast_error_text` pushes WeenieError 0x402 at TRANSIENT, while retail
// HandleFailureEvent prints it at text type 7 (Magic) —
// crates/holtburger-core/src/retail_failure_table.rs. Drop the entry once the
// wasm pushes that line at another category.
const CHAT_ONLY_TRANSIENT_TEXTS = new Set([
  "Your spell fizzled.",
]);

const isOff = (v) => v === "off" || v === "0" || v === "false";
const isOn = (v) => v === "on" || v === "1" || v === "true";

function params(search) {
  try { return new URLSearchParams(search ?? globalThis.location?.search ?? ""); }
  catch (_) { return new URLSearchParams(""); }
}

/** `?spewBox` — DEFAULT-ON; `off` / `0` / `false` restore the old routing. */
export function spewBoxEnabled(search) {
  return !isOff(params(search).get("spewBox")?.toLowerCase());
}

/** True for a line retail shows in the spew box (text type 0x1A). */
export function isSpewLine(text, category) {
  if (Number(category) !== CHAT_CATEGORY_TRANSIENT) return false;
  return !CHAT_ONLY_TRANSIENT_TEXTS.has(String(text ?? "").trimEnd());
}

function storageOf(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}

/** The "Errors" chat option: retail default off (the cleared filter bit). */
export function chatErrorsEnabled(storage) {
  try { return storageOf(storage)?.getItem(CHAT_ERRORS_KEY) === "1"; } catch (_) { return false; }
}

export function setChatErrorsEnabled(on, storage) {
  try {
    const s = storageOf(storage);
    if (!s) return;
    if (on) s.setItem(CHAT_ERRORS_KEY, "1");
    else s.removeItem(CHAT_ERRORS_KEY);
  } catch (_) { /* private window / blocked storage: option stays off */ }
}

/**
 * `?chatErrors=1|on|true` turns the option on and `=0|off|false` off; either
 * is remembered for this viewer. Anything else leaves it as stored.
 */
export function applyChatErrorsParam(search, storage) {
  const v = params(search).get("chatErrors")?.toLowerCase();
  if (isOn(v)) setChatErrorsEnabled(true, storage);
  else if (isOff(v)) setChatErrorsEnabled(false, storage);
}

/**
 * The gmSpewBoxUI list: newest first, at most `max` rows. `push(text, now)`
 * returns `{ item, removed }` (the identical old top row and any overflow
 * tail are in `removed`), or null for a blank line. `remove(id)` drops a row
 * whose lifetime ran out.
 */
export function createSpewStack({ max = SPEW_MAX_ITEMS, lifetimeMs = SPEW_ITEM_LIFETIME_MS } = {}) {
  const items = [];
  let seq = 0;
  return {
    get items() { return items.slice(); },
    get size() { return items.length; },
    push(text, now = Date.now()) {
      const t = String(text ?? "").trimEnd();
      if (!t) return null;
      const removed = [];
      if (items.length > 0 && items[0].text === t) removed.push(items.shift());
      const item = { id: ++seq, text: t, expiresAt: now + lifetimeMs };
      items.unshift(item);
      while (items.length > max) removed.push(items.pop());
      return { item, removed };
    },
    remove(id) {
      const i = items.findIndex((it) => it.id === id);
      return i >= 0 ? items.splice(i, 1)[0] : null;
    },
  };
}
