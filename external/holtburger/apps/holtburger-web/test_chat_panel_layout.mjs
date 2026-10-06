// HUD overhaul 2026-10-05 — pure chat-window model (app/chat_log.js) behind
// plugins/chat-panel.js. Asserts:
//   1. retail colour table (ChatInterface::BuildChatColorLookupTable,
//      acclient.c:287161 + RGBAColor consts acclient.c:45151-45164) — tells
//      yellow, speech white, emote grey, Turbine rooms blue-grey, allegiance
//      orange, unknown → default green; outgoing tell echo → tan.
//   2. echo classification + filter groups (A/L/T/C buttons).
//   3. talk-focus prefixes ride existing app/slash_commands.js routes and a
//      typed / or @ command is never double-prefixed.
//   4. sender parsing for click-to-tell (says / tells you / [Channel]).
//   5. pin-to-bottom test, unread pill label, timestamp format.
//   6. retail maximize geometry (gmMainChatUI::HandleMaximizeButton).
import {
  CHAT_CATEGORY as C, RETAIL_CHAT_RGB as RGB, colorForCategory, classifyEchoLine,
  chatLineStyle, filterGroupForCategory, lineVisibleInFilter, CHAT_FILTERS,
  normalizeFilterId, TALK_FOCUSES, talkFocusById, buildOutgoingLine,
  parseChatSender, isNearBottom, unreadLabel, formatChatTimestamp,
  computeMaximizedRect,
} from "./app/chat_log.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("1. retail colours");
check("tell = colorYellow", colorForCategory(C.TELL) === "#ffff3f");
check("speech = colorWhite", colorForCategory(C.LOCAL) === "#ffffff");
check("emote = colorGrey", colorForCategory(C.EMOTE) === "#d2d2c8");
check("general/trade/lfg/roleplay/society = colorBlueGrey",
  [C.GENERAL, C.TRADE, C.LFG, C.ROLEPLAY, C.SOCIETY].every((c) => colorForCategory(c) === RGB.blueGrey));
check("allegiance + olthoi = colorOrange", colorForCategory(C.ALLEGIANCE) === RGB.orange && colorForCategory(C.OLTHOI) === RGB.orange);
check("fellowship = colorYellow", colorForCategory(C.FELLOWSHIP) === RGB.yellow);
check("magic = colorLightBlue", colorForCategory(C.MAGIC) === "#3fbfff");
check("advancement = colorCyan", colorForCategory(C.ADVANCEMENT) === "#3fdcdc");
check("combat = colorDarkRed", colorForCategory(C.COMBAT) === "#ff3f3f");
check("system + unknown = default colorGreen",
  colorForCategory(C.SYSTEM) === "#80ff7f" && colorForCategory(99) === "#80ff7f");
check("every CHAT_CATEGORY has a hex colour",
  Object.values(C).every((c) => /^#[0-9a-f]{6}$/.test(colorForCategory(c))));

console.log("2. echo + filter groups");
check("`You tell` echo → TELL", classifyEchoLine('You tell Bob, "hi"') === C.TELL);
check("[General] echo → GENERAL", classifyEchoLine("[General] wts keys") === C.GENERAL);
check("[Fellowship] echo → FELLOWSHIP", classifyEchoLine('[Fellowship] You say, "go"') === C.FELLOWSHIP);
check("[Patron] echo → ALLEGIANCE", classifyEchoLine('[Patron] You say, "hi"') === C.ALLEGIANCE);
check("> @cmd echo → SYSTEM", classifyEchoLine("> @telepoi holtburg") === C.SYSTEM);
check("> say echo → LOCAL", classifyEchoLine("> hello") === C.LOCAL);
const tellEcho = chatLineStyle(null, 'You tell Bob, "hi"', true);
check("outgoing tell echo paints retail tan", tellEcho.color === "#d2d264" && tellEcho.group === "tell");
const inbound = chatLineStyle("2", 'Bob tells you, "hi"');
check("inbound tell (string data-cat) → yellow / tell group", inbound.color === "#ffff3f" && inbound.group === "tell" && inbound.category === 2);
check("emote → local group", filterGroupForCategory(C.EMOTE) === "local");
check("allegiance → chan group", filterGroupForCategory(C.ALLEGIANCE) === "chan");
check("combat → other group", filterGroupForCategory(C.COMBAT) === "other");
check("All shows other", lineVisibleInFilter("all", "other"));
check("Local hides tells", !lineVisibleInFilter("local", "tell"));
check("Channels shows chan", lineVisibleInFilter("channels", "chan"));
check("Tells hides system", !lineVisibleInFilter("tell", "other"));
check("four filters A/L/T/C", eq(CHAT_FILTERS.map((f) => f.key), ["A", "L", "T", "C"]));
check("every filter has an empty-state string", CHAT_FILTERS.every((f) => typeof f.empty === "string" && f.empty.length > 0));
check("unknown filter id → all", normalizeFilterId("bogus") === "all" && normalizeFilterId("tell") === "tell");

console.log("3. talk focus");
check("default focus is retail 'Chat'", TALK_FOCUSES[0].id === "say" && TALK_FOCUSES[0].label === "Chat");
check("unknown focus id → Chat", talkFocusById("nope").id === "say");
check("say adds no prefix", buildOutgoingLine(talkFocusById("say"), "  hello ") === "hello");
check("general → /cg", buildOutgoingLine(talkFocusById("general"), "wts") === "/cg wts");
check("fellowship → /f", buildOutgoingLine(talkFocusById("fellowship"), "inc") === "/f inc");
check("reply → /r", buildOutgoingLine(talkFocusById("reply"), "ok") === "/r ok");
check("typed /command ignores focus", buildOutgoingLine(talkFocusById("trade"), "/a hi") === "/a hi");
check("typed @command ignores focus", buildOutgoingLine(talkFocusById("trade"), "@loc") === "@loc");
check("blank → empty", buildOutgoingLine(talkFocusById("trade"), "   ") === "");
// Every prefix must be one app/slash_commands.js routes (no `/b` broadcast
// fall-through to `@b`, the pre-overhaul bug).
const ROUTED = new Set(["", "/me ", "/r ", "/t ", "/f ", "/a ", "/p ", "/v ", "/m ", "/cg ", "/ct ", "/clfg ", "/crp ", "/society ", "/olthoi "]);
check("every talk-focus prefix is routed by slash_commands", TALK_FOCUSES.every((f) => ROUTED.has(f.prefix)),
  TALK_FOCUSES.filter((f) => !ROUTED.has(f.prefix)).map((f) => f.id).join(","));
check("tag labels fit the 46-px brass tag (≤7 chars)", TALK_FOCUSES.every((f) => f.label.length <= 7));

console.log("4. sender parsing");
const s1 = parseChatSender('Bob says, "hi"');
check("`Name says,`", s1 && s1.name === "Bob" && s1.start === 0 && s1.end === 3, JSON.stringify(s1));
const s2 = parseChatSender('[Trade] Sir Fancy Pants says, "wts"');
check("`[Trade] Name says,`", s2 && s2.name === "Sir Fancy Pants" && s2.start === 8, JSON.stringify(s2));
const s3 = parseChatSender('+Admin tells you, "hello"');
check("`Name tells you,`", s3 && s3.name === "+Admin", JSON.stringify(s3));
check("`You say` is not a sender", parseChatSender('You say, "x"') === null);
check("system line has no sender", parseChatSender("You have entered the General channel.") === null);
check("echo `You tell` has no sender", parseChatSender('You tell Bob, "hi"') === null);

console.log("5. pinning / pill / timestamps");
check("at bottom", isNearBottom({ scrollTop: 100, scrollHeight: 173, clientHeight: 73 }));
check("within slack", isNearBottom({ scrollTop: 96, scrollHeight: 173, clientHeight: 73 }));
check("scrolled up", !isNearBottom({ scrollTop: 40, scrollHeight: 173, clientHeight: 73 }));
check("pill singular", unreadLabel(1) === "1 new message");
check("pill plural", unreadLabel(7) === "7 new messages");
check("timestamp [HH:MM]", /^\[\d{2}:\d{2}\]$/.test(formatChatTimestamp(Date.UTC(2026, 9, 5, 13, 7))));

console.log("6. maximize geometry (retail HandleMaximizeButton)");
// 720-px HUD viewport, chat docked at the bottom: grows UP by half (360).
const m1 = computeMaximizedRect({ top: 612, height: 100 }, 720);
check("bottom-docked grows up by vh/2, bottom edge fixed", m1.top === 252 && m1.height === 460 && m1.top + m1.height === 712, JSON.stringify(m1));
// Docked at the top: no room above, room below → grows downward.
const m2 = computeMaximizedRect({ top: 8, height: 100 }, 720);
check("top-docked grows down", m2.top === 8 && m2.height === 460, JSON.stringify(m2));
// Mid-screen near top: clamps y to 0 and height to the screen.
const m3 = computeMaximizedRect({ top: 200, height: 300 }, 720);
check("clamped inside the viewport", m3.top >= 0 && m3.top + m3.height <= 720 && m3.height >= 300, JSON.stringify(m3));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
