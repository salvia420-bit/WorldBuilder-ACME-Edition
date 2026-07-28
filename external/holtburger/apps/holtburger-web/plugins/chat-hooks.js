// chat-hooks.js — the two retail chat hooks (P6.1 / CORE-07, 2026-07-27).
//
// Retail exposed exactly two EATABLE plugin callbacks, both chat
// (decomp ground truth: docs delivered with P6.1, iasheronscall-vtable.md):
//
//   INBOUND  — IACPlugin::OnChatWindowText(text, logTextType, int* bEat),
//     fired from ClientSystem::AddTextToScroll (acclient.c @0x563C50)
//     AFTER wire-state side effects, BEFORE display. Eat = the line is
//     never displayed anywhere; game state is untouched (it already
//     applied upstream). Host-originated echoes (sendToAPI=false) never
//     traverse the hook — that is what makes plugin chat filtering
//     loop-free by construction. We preserve that rule: only the
//     kind=2 ClientEvent drain emits here; appendChatLine calls
//     elsewhere are local echoes by definition.
//
//   OUTBOUND — IACPlugin::OnChatBarEnter(line, out), fired from
//     ClientCommunicationSystem::OnChatCommand (acclient.c @0x581320)
//     on chat-bar submission BEFORE any prefix parsing (/, @, :, ;).
//     A non-null out-param = eaten: retail returns immediately and the
//     "replacement" string is never processed (proven from the function
//     tail — it is an eat flag with a string's type, not a rewrite
//     channel). We match: eat suppresses routing+send+echo; a plugin
//     that wants rewrite eats and re-injects via client.chat.send().
//     Bot/agent sendChat() calls do NOT traverse this hook — it is a
//     chat-BAR hook, exactly retail's isBotOriginated distinction.
//
// Both hooks ride the loader's createEatableBus (its first real
// consumers): handler order = subscription order, first eat()
// short-circuits the rest, a throwing handler is warned + skipped.
//
// Event shapes (frozen, v1):
//   incoming: "chatIncoming" { text, chatType, category }
//     - text:     wasm-preformatted display line (ClientEvent kind=2)
//     - chatType: wire ChatMessageType (evt.u32Payload; 0x03 = Tell)
//     - category: CHAT_CATEGORY_* display id (evt.u32Payload2) —
//                 retail's logTextType analogue
//   outgoing: "chatOutgoing" { text }
//     - text: the raw trimmed chat-bar line, pre-parse
//
// Import for side effect (sets window.__chatHooks) or use the named
// exports. index.html guards with `window.__chatHooks?.` so a missing
// module can never break chat.

import { createEatableBus } from "./loader.js";

/** Canonical event names — one spelling, shared by every emitter. */
export const CHAT_INCOMING = "chatIncoming";
export const CHAT_OUTGOING = "chatOutgoing";

const incoming = createEatableBus();
const outgoing = createEatableBus();

/**
 * Emit an inbound (server -> display) chat line. Called from index.html's
 * kind=2 ClientEvent drain, AFTER wire-state side effects and BEFORE
 * display. Returns the event; `.eaten === true` means the caller must NOT
 * display the line.
 *
 * @param {string} text      wasm-preformatted display line
 * @param {number} chatType  wire ChatMessageType (evt.u32Payload)
 * @param {number} category  display CHAT_CATEGORY (evt.u32Payload2)
 * @returns {{text:string, chatType:number, category:number, eaten:boolean}}
 */
export function emitIncoming(text, chatType, category) {
  return incoming.emit(CHAT_INCOMING, {
    text,
    chatType: (chatType ?? 0) >>> 0,
    category: typeof category === "number" ? category : 0,
  });
}

/**
 * Emit an outbound (chat-bar submit) line. Called from index.html's chat
 * form submit handler BEFORE any prefix parsing (`/`, `@`, `:`, `;`).
 * `.eaten === true` means the caller must not route, send or echo.
 *
 * Only the chat BAR emits here. Bot/agent `sendChat()` and host-originated
 * `InvokeChatParser()` re-injections deliberately bypass it — retail's
 * `isBotOriginated` distinction, and what makes eat-then-rewrite loop-free.
 *
 * @param {string} text raw trimmed chat-bar line
 * @returns {{text:string, eaten:boolean}}
 */
export function emitOutgoing(text) {
  return outgoing.emit(CHAT_OUTGOING, { text });
}

/**
 * Subscribe to inbound chat (retail `IACPlugin::OnChatWindowText`).
 * @param {(ev:{text:string,chatType:number,category:number,eat:()=>void})=>void} fn
 * @returns {() => void} unsubscribe
 */
export function onIncoming(fn) {
  return incoming.on(CHAT_INCOMING, fn);
}

/**
 * Subscribe to outbound chat (retail `IACPlugin::OnChatBarEnter`).
 * @param {(ev:{text:string,eat:()=>void})=>void} fn
 * @returns {() => void} unsubscribe
 */
export function onOutgoing(fn) {
  return outgoing.on(CHAT_OUTGOING, fn);
}

export const chatHooks = {
  /** Eatable bus for inbound (server->display) chat lines. */
  incoming,
  /** Eatable bus for outbound (chat-bar submit) lines. */
  outgoing,
  emitIncoming,
  emitOutgoing,
  onIncoming,
  onOutgoing,
  CHAT_INCOMING,
  CHAT_OUTGOING,
};

if (typeof window !== "undefined") {
  window.__chatHooks = chatHooks;
}

export default chatHooks;
