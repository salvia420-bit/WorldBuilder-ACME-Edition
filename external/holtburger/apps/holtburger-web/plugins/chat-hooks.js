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

export const chatHooks = {
  /** Eatable bus for inbound (server->display) chat lines. */
  incoming: createEatableBus(),
  /** Eatable bus for outbound (chat-bar submit) lines. */
  outgoing: createEatableBus(),
};

if (typeof window !== "undefined") {
  window.__chatHooks = chatHooks;
}

export default chatHooks;
