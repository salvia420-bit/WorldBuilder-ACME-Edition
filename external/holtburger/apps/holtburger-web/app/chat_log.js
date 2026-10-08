// app/chat_log.js — the chat log pane: category-classed line append (with
// the DOM cap + pinned-to-bottom autoscroll), tab filter switching, and the
// window.__appendChatLine exposure. Extracted verbatim from index.html's
// inline script (2026-10-05); index.html calls initChatLog() at the same point
// the code used to run.
//
// HUD overhaul 2026-10-05 — this module also owns the PURE chat-display
// model the HUD chat window (plugins/chat-panel.js) renders from: the retail
// per-text-type colour table, the filter groups behind the four left-edge
// buttons, the talk-focus (outgoing channel) table, sender-name parsing for
// click-to-tell, and the pin-to-bottom test. No DOM, no imports — covered by
// test_chat_panel_layout.mjs.

// ── CHAT_CATEGORY_* (src/lib.rs `const CHAT_CATEGORY_*`) ─────────────────
// The wasm tags every kind=2 line with one of these in ClientEvent
// u32Payload2; appendChatLine stamps it on the <li> as `data-cat`.
export const CHAT_CATEGORY = Object.freeze({
  SYSTEM: 0, LOCAL: 1, TELL: 2, CHANNEL: 3, EMOTE: 4, COMBAT: 5, DEATH: 6,
  MAGIC: 7, ADVANCEMENT: 8, TRANSIENT: 9, POPUP: 10, HELP: 11, TRADE: 12,
  LFG: 13, ROLEPLAY: 14, GENERAL: 15, FELLOWSHIP: 16, ALLEGIANCE: 17,
  RECALL: 18, CRAFT: 19, APPRAISAL: 20, BROADCAST: 21, SOCIETY: 22,
  OLTHOI: 23,
  // R-chat (2026-10-08): retail text types the old taxonomy folded away —
  // OutgoingTell (4, the server's `You tell X, "…"` copy), Social (10,
  // heard patron/vassal/co-vassal/AB lines), SocialSend (11, your own
  // `You say to your Vassals, "…"`).
  TELL_SEND: 24, SOCIAL: 25, SOCIAL_SEND: 26,
});

// ── Retail chat colours ───────────────────────────────────────────────────
// ChatInterface::BuildChatColorLookupTable (acclient.c:287161) seeds all 34
// eChatTypes with colorGreen, then overrides per type; the RGBAColor
// constants are acclient.c:45151-45164 (floats → 8-bit, rounded).
export const RETAIL_CHAT_RGB = Object.freeze({
  green: "#80ff7f",        // colorGreen   {0.5, 1.0, 0.498}  — default
  white: "#ffffff",        // colorWhite   — eTextTypeSpeech (2)
  grey: "#d2d2c8",         // colorGrey    — Emote (12)
  yellow: "#ffff3f",       // colorYellow  — Tell (3), Social (10), Fellowship (19), AdminTell (31)
  tan: "#d2d264",          // colorTan     — OutgoingTell (4), SocialSend (11)
  pink: "#ff9696",         // colorPink    — Channel (8), ChannelSend (9)
  orange: "#ee921e",       // colorOrange  — Allegiance (18), 33; Olthoi room (GetChatFormat → 18)
  blueGrey: "#b4dcf0",     // colorBlueGrey — Turbine rooms General/Trade/LFG/Roleplay/Society (27-30, 32)
  darkRed: "#ff3f3f",      // colorDarkRed — Combat (6), Help (15), CombatEnemy (21)
  lightRed: "#f57572",     // colorLightRed — CombatSelf (22)
  lightBlue: "#3fbfff",    // colorLightBlue — Magic (7), Spellcasting (17)
  cyan: "#3fdcdc",         // colorCyan    — Advancement (13)
  brightPurple: "#ff7fff", // colorBrightPurple — System (5)
  brightRed: "#ff0000",    // colorBrightRed — 26
});

const C = CHAT_CATEGORY;
const RGB = RETAIL_CHAT_RGB;

// CHAT_CATEGORY → retail colour. Categories that fold several wire types
// take the colour of the dominant one (e.g. SYSTEM is mostly Broadcast →
// default green; Turbine room ids map per ChatRoomTracker::GetChatFormat,
// acclient.c:505642 — General/Trade/LFG/Roleplay → 27-30, Society → 32,
// Olthoi → 18).
const CATEGORY_COLOR = Object.freeze({
  [C.SYSTEM]: RGB.green,
  [C.LOCAL]: RGB.white,
  [C.TELL]: RGB.yellow,
  [C.CHANNEL]: RGB.pink,
  [C.EMOTE]: RGB.grey,
  [C.COMBAT]: RGB.darkRed,
  [C.DEATH]: RGB.darkRed,
  [C.MAGIC]: RGB.lightBlue,
  [C.ADVANCEMENT]: RGB.cyan,
  [C.TRANSIENT]: RGB.green,
  [C.POPUP]: RGB.green,
  [C.HELP]: RGB.darkRed,
  [C.TRADE]: RGB.blueGrey,
  [C.LFG]: RGB.blueGrey,
  [C.ROLEPLAY]: RGB.blueGrey,
  [C.GENERAL]: RGB.blueGrey,
  [C.FELLOWSHIP]: RGB.yellow,
  [C.ALLEGIANCE]: RGB.orange,
  [C.RECALL]: RGB.green,
  [C.CRAFT]: RGB.green,
  [C.APPRAISAL]: RGB.green,
  [C.BROADCAST]: RGB.green,
  [C.SOCIETY]: RGB.blueGrey,
  [C.OLTHOI]: RGB.orange,
  [C.TELL_SEND]: RGB.tan,
  [C.SOCIAL]: RGB.yellow,
  [C.SOCIAL_SEND]: RGB.tan,
});

/** Retail colour for a CHAT_CATEGORY id (unknown → default green). */
export function colorForCategory(category) {
  return CATEGORY_COLOR[category] ?? RGB.green;
}

// Local echoes (appendChatLine(text, null)) carry no category. Their text
// is produced by app/slash_commands.js / index.html's submit handler, so
// the prefix tells us which channel the player just spoke on.
const ECHO_CHANNEL_TAGS = Object.freeze({
  Allegiance: C.ALLEGIANCE, Patron: C.ALLEGIANCE, Monarch: C.ALLEGIANCE,
  Vassals: C.ALLEGIANCE, CoVassals: C.ALLEGIANCE, Fellowship: C.FELLOWSHIP,
  General: C.GENERAL, Trade: C.TRADE, LFG: C.LFG, Roleplay: C.ROLEPLAY,
  Society: C.SOCIETY, Olthoi: C.OLTHOI, Help: C.HELP,
});

/**
 * Category for an outbound local echo line. `You tell X, "…"` → TELL,
 * `[General] …` → that channel, `> @cmd` → SYSTEM, everything else (plain
 * say `> hi`, soul-emote `You bow`) → LOCAL.
 */
export function classifyEchoLine(text) {
  const t = String(text ?? "");
  if (t.startsWith("You tell ")) return C.TELL;
  const m = /^\[([A-Za-z]+)\]/.exec(t);
  if (m && ECHO_CHANNEL_TAGS[m[1]] != null) return ECHO_CHANNEL_TAGS[m[1]];
  if (t.startsWith("> @")) return C.SYSTEM;
  return C.LOCAL;
}

/**
 * Display style for one log line: `{ category, color, group }`. `category`
 * is the source <li>'s data-cat (number or numeric string) or null for a
 * local echo. Outgoing tells paint retail tan (eTextTypeSpeechDirectSend).
 */
export function chatLineStyle(category, text, isEcho = false) {
  let cat = category == null || category === "" ? null : Number(category);
  if (!Number.isFinite(cat)) cat = null;
  if (isEcho || cat == null) {
    const echoCat = classifyEchoLine(text);
    const color = echoCat === C.TELL ? RGB.tan : colorForCategory(echoCat);
    return { category: echoCat, color, group: filterGroupForCategory(echoCat) };
  }
  return { category: cat, color: colorForCategory(cat), group: filterGroupForCategory(cat) };
}

// ── Filter groups (the four left-edge buttons) ────────────────────────────
// Retail's four 16×16 buttons (FloatingChat1-4, 0x10000522-525) toggled the
// four gmFloatyChatUI windows (gmMainChatUI::RecvNotice_SetPanelVisibility,
// acclient.c:254204), each of which carried its own text-type filter. We
// have one window, so the four buttons select four filter presets instead.
export const FILTER_GROUP = Object.freeze({ LOCAL: "local", TELL: "tell", CHAN: "chan", OTHER: "other" });

const LOCAL_CATS = new Set([C.LOCAL, C.EMOTE]);
const TELL_CATS = new Set([C.TELL, C.TELL_SEND]);
const CHAN_CATS = new Set([
  C.CHANNEL, C.HELP, C.TRADE, C.LFG, C.ROLEPLAY, C.GENERAL, C.FELLOWSHIP,
  C.ALLEGIANCE, C.SOCIETY, C.OLTHOI, C.SOCIAL, C.SOCIAL_SEND,
]);

export function filterGroupForCategory(category) {
  const c = Number(category);
  if (LOCAL_CATS.has(c)) return FILTER_GROUP.LOCAL;
  if (TELL_CATS.has(c)) return FILTER_GROUP.TELL;
  if (CHAN_CATS.has(c)) return FILTER_GROUP.CHAN;
  return FILTER_GROUP.OTHER;
}

// Filter ids keep the pre-overhaul spellings ("channels") because the
// dev-page #chat-log CSS filters on the same `data-tab` values.
export const CHAT_FILTERS = Object.freeze([
  Object.freeze({ id: "all", key: "A", title: "All messages", empty: "No messages yet." }),
  Object.freeze({ id: "local", key: "L", title: "Local — nearby speech and emotes", empty: "No nearby chat yet." }),
  Object.freeze({ id: "tell", key: "T", title: "Tells", empty: "No tells yet. Click a name, or type /t name, message." }),
  Object.freeze({ id: "channels", key: "C", title: "Channels — Fellowship, Allegiance, General, Trade, LFG…", empty: "No channel chat yet." }),
]);

const FILTER_TO_GROUP = Object.freeze({ local: FILTER_GROUP.LOCAL, tell: FILTER_GROUP.TELL, channels: FILTER_GROUP.CHAN });

export function normalizeFilterId(id) {
  return CHAT_FILTERS.some((f) => f.id === id) ? id : "all";
}

/** Whether a line in `group` shows under filter `filterId`. */
export function lineVisibleInFilter(filterId, group) {
  const want = FILTER_TO_GROUP[filterId];
  return want == null ? true : group === want;
}

// ── Talk focus (outgoing channel) ─────────────────────────────────────────
// Retail gmMainChatUI::InitTalkFocusMenu (acclient.c:255019) fills the
// ChatTarget (0x10000014) popup with: Monarch, Selected, Patron, Chat (All),
// Vassals, Fellows, Allegiance, General, Trade, LFG, Roleplay, Society,
// Olthoi. Each entry here maps onto a slash command app/slash_commands.js
// already routes (/r /t /f /a /p /v /m /cg /ct /clfg /crp /society /olthoi
// /me), so the chat bar never grows a second send path. "Selected" (tell
// the selected object) is replaced by Reply / Tell…, which this client can
// actually address. Grouped into sections for the menu.
export const TALK_FOCUSES = Object.freeze([
  { id: "say", label: "Chat", menu: "Chat (nearby)", prefix: "", category: C.LOCAL, section: 0 },
  { id: "emote", label: "Emote", menu: "Emote (/me)", prefix: "/me ", category: C.EMOTE, section: 0 },
  { id: "reply", label: "Reply", menu: "Reply to last tell", prefix: "/r ", category: C.TELL, section: 1 },
  { id: "tell", label: "Tell", menu: "Tell… (name, message)", prefix: "/t ", category: C.TELL, section: 1 },
  { id: "fellowship", label: "Fellow", menu: "Fellowship", prefix: "/f ", category: C.FELLOWSHIP, section: 2 },
  { id: "allegiance", label: "Alleg", menu: "Allegiance", prefix: "/a ", category: C.ALLEGIANCE, section: 2 },
  { id: "patron", label: "Patron", menu: "Patron", prefix: "/p ", category: C.ALLEGIANCE, section: 2 },
  { id: "vassals", label: "Vassals", menu: "Vassals", prefix: "/v ", category: C.ALLEGIANCE, section: 2 },
  { id: "monarch", label: "Monarch", menu: "Monarch", prefix: "/m ", category: C.ALLEGIANCE, section: 2 },
  { id: "general", label: "General", menu: "General", prefix: "/cg ", category: C.GENERAL, section: 3 },
  { id: "trade", label: "Trade", menu: "Trade", prefix: "/ct ", category: C.TRADE, section: 3 },
  { id: "lfg", label: "LFG", menu: "Looking for group", prefix: "/clfg ", category: C.LFG, section: 3 },
  { id: "roleplay", label: "RP", menu: "Roleplay", prefix: "/crp ", category: C.ROLEPLAY, section: 3 },
  { id: "society", label: "Society", menu: "Society", prefix: "/society ", category: C.SOCIETY, section: 3 },
  { id: "olthoi", label: "Olthoi", menu: "Olthoi", prefix: "/olthoi ", category: C.OLTHOI, section: 3 },
].map((f) => Object.freeze(f)));

export function talkFocusById(id) {
  return TALK_FOCUSES.find((f) => f.id === id) ?? TALK_FOCUSES[0];
}

/**
 * Outgoing chat-bar line for `text` under `focus`. A line the player
 * starts with `/` or `@` is a command, and `:` / `;` an emote (retail
 * ClientCommunicationSystem::OnChatCommand, acclient.c:426126), so it goes
 * out verbatim whatever the focus (retail parses prefixes first).
 * Returns "" for blank input.
 */
export function buildOutgoingLine(focus, text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  if (/^[/@:;]/.test(t)) return t;
  return `${focus?.prefix ?? ""}${t}`;
}

// ── Sender names (click-to-tell) ──────────────────────────────────────────
// Retail tags the sender in every spoken line (`<Tell:IIDString:…>Name<\Tell>
// says, "…"`, ChatRoomTracker::GetChatFormat acclient.c:505642) and a click
// on it calls ChatInterface::StartTell (gmMainChatUI::RecvNotice_TextTag_
// IIDStringClick, acclient.c:254238). The wasm formats the same shapes
// as plain text (src/session/messages/chat.rs / game_event.rs):
//   `Name says, "…"`  ·  `[Channel] Name says, "…"`  ·  `Name tells you, "…"`
//   ·  `Your patron|vassal|follower Name says to you, "…"` (retail
//   ChannelBroadcast allegiance lines, acclient.c:412975).
const SENDER_RE = /^(\[[^\]]{1,32}\] |Your (?:patron|vassal|follower) )?([^\s"[\]][^"[\]]{0,40}?) (says to you|says|tells you), "/;

/** `{ name, start, end }` (char offsets into `text`) or null. */
export function parseChatSender(text) {
  const t = String(text ?? "");
  const m = SENDER_RE.exec(t);
  if (!m) return null;
  const name = m[2];
  if (!name || name === "You") return null;
  const start = m[1] ? m[1].length : 0;
  return { name, start, end: start + name.length };
}

// ── Scroll pinning ────────────────────────────────────────────────────────
/**
 * True when a scroll box is (within `slack` px of) its bottom. The chat
 * auto-scroll keys off a PINNED flag updated from user scrolls, not off a
 * measurement taken at append time — a line whose height is not final yet
 * used to un-pin the log (the pre-overhaul "stuck at the top" bug).
 */
export function isNearBottom(box, slack = 6) {
  if (!box) return true;
  const { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = box;
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/** "1 new message" / "N new messages" for the jump-to-latest pill. */
export function unreadLabel(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  return `${k} new message${k === 1 ? "" : "s"}`;
}

/** `[HH:MM]` local-time prefix for CharacterOption DisplayTimestamps. */
export function formatChatTimestamp(ms) {
  const d = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

// ── Maximize ──────────────────────────────────────────────────────────────
/**
 * Retail gmMainChatUI::HandleMaximizeButton (acclient.c:254248): the
 * maximised height is the current height plus HALF the parent (screen)
 * height; the window grows UPWARD by that half unless that would cross the
 * top edge while there is room below, in which case it grows downward from
 * its current y; y clamps to 0 and the height to what fits on screen.
 * All values in HUD px. Returns `{ top, height }`.
 */
export function computeMaximizedRect({ top, height }, viewportHeight) {
  const vh = Math.max(0, Number(viewportHeight) || 0);
  const half = Math.floor(vh / 2);
  const y = Number(top) || 0;
  const h = Number(height) || 0;
  let maxH = h + half;
  let newTop = (y - half < 0 && y + h < vh) ? y : y - half;
  if (newTop < 0) newTop = 0;
  if (newTop + maxH > vh) maxH = vh - newTop;
  return { top: newTop, height: Math.max(h, maxH) };
}

export function initChatLog(D) {
  const { chatLog, chatTabs } = D;
  const CHAT_LOG_LIMIT = 400;
  // Phase 4 step 4: append a chat line keyed by the wasm-bundle's
  // CHAT_CATEGORY_* id (`category` is `evt.u32Payload2`). The id
  // becomes a `cat-N` CSS class which paints the line in its
  // category-specific colour (see #chat-log li.cat-N rules) and
  // also lets the data-tab filter on #chat-log show/hide whole
  // category clusters. Outbound user echo passes `category=null`
  // (or any non-number) which routes to the `.echo` neutral
  // class and is always visible regardless of active tab.
  function appendChatLine(text, category) {
    // Drop the empty-state placeholder on first real message.
    const empty = chatLog.querySelector("li.empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    if (typeof category === "number") {
      li.className = `cat-${category}`;
      li.dataset.cat = String(category);
    } else {
      li.className = "echo";
    }
    // HUD overhaul 2026-10-05 — arrival time, so the HUD chat window's
    // DisplayTimestamps prefix shows when the line came in rather than when
    // the window happened to mirror it.
    li.dataset.ts = String(Date.now());
    li.textContent = text;
    // Trim to prevent unbounded DOM growth in long sessions.
    chatLog.appendChild(li);
    while (chatLog.childElementCount > CHAT_LOG_LIMIT) {
      chatLog.firstElementChild.remove();
    }
    // Auto-scroll only if the user was already pinned to the
    // bottom — don't yank scroll position when they're reading
    // backscroll.
    const nearBottom =
      chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }
  // P6.1 (2026-07-27): expose for client.ui.writeToChat — the retail
  // IAsheronsCall::WriteToChat analogue (display echo only; local
  // echoes deliberately do NOT traverse the chat.incoming hook,
  // retail's sendToAPI=false rule).
  window.__appendChatLine = appendChatLine;
  // Phase 4 step 4: tab switching. Updates `data-tab` on #chat-log
  // (which CSS uses to filter visible <li>s) and the `.active`
  // class on the chosen button. Layout-only — no per-message work.
  function setChatTab(tab) {
    chatLog.dataset.tab = tab;
    for (const btn of chatTabs.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
  }
  chatTabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-tab]");
    if (!btn) return;
    setChatTab(btn.dataset.tab);
    // Re-pin to bottom when switching tabs so the user sees the
    // most recent line in the new filter without scrolling.
    chatLog.scrollTop = chatLog.scrollHeight;
  });
  return { appendChatLine };
}
