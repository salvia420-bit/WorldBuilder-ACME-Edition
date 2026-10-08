// tests/social_commands.test.mjs — round-4 social-lists-1 (2026-10-08):
// retail client-side /friends, /friends_add, /friends_remove, /squelch,
// /unsquelch, /filter, /unfilter, /messagetypes (app/social_commands.js),
// driven through the REAL initSlashCommands() router with a recording fake
// SessionHandle. Retail sources: ClientCommunicationSystem::DoFriends
// (acclient.c:421494), DoFriendsAdd (:419061), DoFriendsRemove (:419108),
// gmFriendsUI display / remove / clear (:201085 / :201230 / :201571),
// ProcessSquelchArgs (:419701), DoSquelchQuery (:434826),
// PerformGlobalSquelchMod (:421888), DoGlobalSquelchQuery (:434707),
// GetListofSquelchChannels (:434637).
//
// NEGATIVE CONTROL: `?retailSocialCmds=off` must forward the verb to the
// server exactly like before (sendChat("@squelch …")).
//
// Run from apps/holtburger-web/:  node tests/social_commands.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
const printed = [];
window.__appendChatLine = (text, cat) => printed.push([text, cat]);
globalThis.location = { search: "" };

const { initSlashCommands, normalizeChatLine, RETAIL_CLIENT_VERBS } = await import("../app/slash_commands.js");
const SC = await import("../app/social_commands.js");
const { CHAT_CATEGORY } = await import("../app/chat_log.js");

function wasmBox(obj) {
  return { ...obj, freed: false, free() { this.freed = true; } };
}

function fakeHandle({ friends = [], squelch = null, clearFriends = true } = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const h = {
    calls,
    sendChat: rec("sendChat"),
    addFriend: rec("addFriend"),
    removeFriend: rec("removeFriend"),
    modifyCharacterSquelch: rec("modifyCharacterSquelch"),
    modifyAccountSquelch: rec("modifyAccountSquelch"),
    modifyGlobalSquelch: rec("modifyGlobalSquelch"),
    playerFriends: () => (friends ? wasmBox({
      friends: friends.map((f) => wasmBox({ friendId: f.id, name: f.name, isOnline: !!f.online })),
    }) : null),
    playerSquelch: () => (squelch ? wasmBox({
      globalsMask: squelch.globalsMask ?? 0,
      characters: (squelch.characters ?? []).map((c) => wasmBox({
        targetGuid: c.guid ?? 0, name: c.name, mask: c.mask, isAccount: !!c.isAccount,
      })),
    }) : null),
  };
  if (clearFriends) h.clearFriends = rec("clearFriends");
  return h;
}

const { routeSlashCommand } = initSlashCommands();
function route(line, opts) {
  printed.length = 0;
  const h = fakeHandle(opts);
  const r = routeSlashCommand(h, line);
  return { r, calls: h.calls, printed: printed.slice() };
}

const FRIENDS = [
  { id: 0x50000001, name: "Alice", online: true },
  { id: 0x50000002, name: "+Bob", online: false },
  { id: 0x50000003, name: "Carol", online: false },
];

test("social verbs are retail client verbs (an @ line reroutes)", () => {
  for (const v of SC.SOCIAL_CLIENT_VERBS) assert.ok(RETAIL_CLIENT_VERBS.has(v), v);
  assert.deepEqual(normalizeChatLine("@squelch Bob"), { kind: "command", line: "/squelch Bob" });
  assert.deepEqual(normalizeChatLine("@Friends add Bob"), { kind: "command", line: "/Friends add Bob" });
  const { r, calls } = route("@friends add Bob");
  assert.equal(r.dispatched, true);
  assert.deepEqual(calls, [["addFriend", "Bob"]], "never sent to the server as @friends");
});

test("/friends lists like gmFriendsUI (online tag, offline plain) into system chat", () => {
  const { r, calls, printed: out } = route("/friends", { friends: FRIENDS });
  assert.deepEqual(r.lines, ["Your friends:", "  Alice (Online)", "  +Bob", "  Carol"]);
  assert.equal(r.category, CHAT_CATEGORY.SYSTEM);
  assert.deepEqual(out.map(([, c]) => c), [0, 0, 0, 0]);
  assert.deepEqual(out.map(([t]) => t), r.lines, "printed straight to the chat window");
  assert.deepEqual(calls, []);
  assert.deepEqual(route("/friends", { friends: [] }).r.lines, ["Your friends list is empty!"]);
  assert.deepEqual(route("/friends", { friends: null }).r.lines, ["Your friends list is empty!"]);
});

test("/friends online shows online friends, or retail's none-online line", () => {
  assert.deepEqual(route("/friends online", { friends: FRIENDS }).r.lines, ["Your friends:", "  Alice (Online)"]);
  const offline = FRIENDS.filter((f) => !f.online);
  assert.deepEqual(route("/friends online", { friends: offline }).r.lines,
    ["Your friends:", "  You have no friends that are online."]);
});

test("/friends add (and /friends_add) → addFriend(name); missing name; 50 cap", () => {
  assert.deepEqual(route("/friends add Bob Smith").calls, [["addFriend", "Bob Smith"]]);
  assert.deepEqual(route("/friends_add Bob").calls, [["addFriend", "Bob"]]);
  const none = route("/friends add");
  assert.deepEqual(none.calls, []);
  assert.deepEqual(none.r.lines, ["You must specify the name of the friend you wish to add."]);
  const full = Array.from({ length: 50 }, (_, i) => ({ id: 0x50000100 + i, name: `F${i}` }));
  const capped = route("/friends add Zed", { friends: full });
  assert.deepEqual(capped.calls, []);
  assert.match(capped.r.lines[0], /maximum of 50 friends/);
});

test("/friends remove <name> resolves the guid (case-insensitive, leading + trimmed)", () => {
  assert.deepEqual(route("/friends remove bob", { friends: FRIENDS }).calls, [["removeFriend", 0x50000002]]);
  assert.deepEqual(route("/friends_remove CAROL", { friends: FRIENDS }).calls, [["removeFriend", 0x50000003]]);
  const miss = route("/friends remove Nobody", { friends: FRIENDS });
  assert.deepEqual(miss.calls, []);
  assert.deepEqual(miss.r.lines, ["That character is not on your friends list!"]);
  assert.deepEqual(route("/friends remove").r.lines, ["You must specify the name of the friend you wish to remove."]);
});

test("/friends remove -all → clearFriends (0x0025) + retail line; stale pkg removes one by one", () => {
  const all = route("/friends remove -all", { friends: FRIENDS });
  assert.deepEqual(all.calls, [["clearFriends"]]);
  assert.deepEqual(all.r.lines, ["Your friends list has been cleared."]);
  const stale = route("/friends remove -ALL", { friends: FRIENDS, clearFriends: false });
  assert.deepEqual(stale.calls, FRIENDS.map((f) => ["removeFriend", f.id]));
});

test("/friends <junk> → retail invalid line; /friends old sends nothing", () => {
  assert.deepEqual(route("/friends bogus").r.lines, ["Invalid friends command specified."]);
  const old = route("/friends old");
  assert.deepEqual(old.calls, []);
  assert.deepEqual(old.r.lines, []);
});

test("/squelch <name> / -<type> / -account / unsquelch", () => {
  assert.deepEqual(route("/squelch Bob").calls, [["modifyCharacterSquelch", 0, "Bob", true, 1]]);
  assert.deepEqual(route("/squelch -combat Bob Smith").calls, [["modifyCharacterSquelch", 0, "Bob Smith", true, 6]]);
  assert.deepEqual(route("/squelch -Tell Bob").calls, [["modifyCharacterSquelch", 0, "Bob", true, 3]]);
  assert.deepEqual(route("/squelch -account Bob").calls, [["modifyAccountSquelch", "Bob", true, 1]]);
  assert.deepEqual(route("/unsquelch Bob").calls, [["modifyCharacterSquelch", 0, "Bob", false, 1]]);
  assert.deepEqual(route("/unsquelch -account Bob").calls, [["modifyAccountSquelch", "Bob", false, 1]]);
});

test("/squelch errors: bad category, no target, -reply without a teller", () => {
  const bad = route("/squelch -bogus Bob");
  assert.deepEqual(bad.calls, []);
  assert.deepEqual(bad.r.lines, ['"-bogus" is not a valid squelch category.']);
  const noName = route("/squelch -combat");
  assert.deepEqual(noName.calls, []);
  assert.deepEqual(noName.r.lines, ["You have not specified a squelch target."]);
  window.__chatLastIncomingTellSender = null;
  const noTeller = route("/squelch -reply");
  assert.deepEqual(noTeller.calls, []);
  assert.deepEqual(noTeller.r.lines, ["A player must @tell you before you can squelch them with this command."]);
  window.__chatLastIncomingTellSender = "Spammer";
  assert.deepEqual(route("/squelch -reply").calls, [["modifyCharacterSquelch", 0, "Spammer", true, 1]]);
  window.__chatLastIncomingTellSender = null;
});

test("/squelch with no args prints the squelch list (DoSquelchQuery)", () => {
  const q = route("/squelch", { squelch: { characters: [
    { name: "Bob", mask: 0xFFFFFFFF },
    { name: "Eve", mask: (1 << 6) | (1 << 3), isAccount: true },
  ] } });
  assert.deepEqual(q.r.lines, [
    "(account) denotes a character whose account has also been squelched.",
    "Format: Name : List of squelched message types.",
    "--------",
    "  Name: Bob All message types",
    "  Name: Eve (account)  Tell, Combat",
  ]);
  assert.equal(route("/squelch", { squelch: { characters: [] } }).r.lines.at(-1), "none");
});

test("/filter, /unfilter → ModifyGlobalSquelch; query and usage errors", () => {
  assert.deepEqual(route("/filter -tell").calls, [["modifyGlobalSquelch", true, 3]]);
  assert.deepEqual(route("/unfilter -all").calls, [["modifyGlobalSquelch", false, 1]]);
  assert.deepEqual(route("/filter tell").r.lines, ["You must specify a valid message type prefixed by a dash."]);
  const usage = route("/filter -tell Bob");
  assert.deepEqual(usage.calls, []);
  assert.deepEqual(usage.r.lines, ["Incorrect usage, use @help for proper arguements."]);
  assert.deepEqual(route("/filter", { squelch: { globalsMask: 1 << 6 } }).r.lines, [
    "The following types of messages are currently being filtered globally:",
    "Combat",
    "(For a list of filter options, type @help filter)",
  ]);
  assert.equal(route("/filter").r.lines[1], "none");
});

test("/messagetypes lists the legal squelch channels", () => {
  assert.deepEqual(route("/messagetypes").r.lines, [
    "Squelch channels are as follows:",
    "  Speech, Tell, Combat, Magic, Emote, Appraisal, Spellcasting, Allegiance, Fellowship, Combat_Enemy, Combat_Self, Recall, Craft, Salvaging",
  ]);
});

test("wasm boxes from playerFriends / playerSquelch are freed", () => {
  const h = fakeHandle({ friends: FRIENDS });
  let box = null;
  const orig = h.playerFriends;
  h.playerFriends = () => (box = orig());
  routeSlashCommand(h, "/friends");
  assert.equal(box.freed, true);
  assert.ok(box.friends.every((f) => f.freed));
});

test("negative control: ?retailSocialCmds=off forwards to the server like before", () => {
  globalThis.location = { search: "?retailSocialCmds=off" };
  try {
    assert.deepEqual(normalizeChatLine("@squelch Bob"), { kind: "server", line: "@squelch Bob" });
    const { r, calls } = route("/squelch Bob");
    assert.deepEqual(calls, [["sendChat", "@squelch Bob"]]);
    assert.equal(r.echo, "> @squelch Bob");
  } finally {
    globalThis.location = { search: "" };
  }
});
