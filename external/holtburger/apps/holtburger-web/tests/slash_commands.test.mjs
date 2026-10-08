// tests/slash_commands.test.mjs — R-chat (round 2, 2026-10-08) retail chat
// command routing in app/slash_commands.js, driven through the REAL
// initSlashCommands() router with a recording fake SessionHandle:
//   chat-1  Turbine room ids = retail ChatTypeEnum (acclient.h:4464) and the
//           StartupTurbineChatSystem aliases (acclient.c:424334); /a /guild
//           /gu → Allegiance room 1; /ab → legacy AllegianceBroadcast.
//   chat-3  no local echo for lines the server echoes (tell / reply / say /
//           channel / Turbine / me); the soul-emote `You …` stays (EMOTE).
//   chat-4  OnChatCommand prefixes (acclient.c:426126): `@` reroutes only
//           retail client verbs, `:`/`;` = emote, case-insensitive verbs
//           with a trailing `,` trimmed, InitializeCommands channel aliases,
//           and PublicChat inline *pose* / <pose> extraction (mirrors OpenAC
//           RetailPublicChatParserTests).
//   chat-5  /reply retail DoReply strings (acclient.c:417665).
//
// Run from apps/holtburger-web/:  node tests/slash_commands.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};

const {
  initSlashCommands, extractPoses, normalizeChatLine, parseCommandLine,
  formatEmoteLine, TURBINE_CMDS, CHANNEL_MAP, RETAIL_CLIENT_VERBS,
} = await import("../app/slash_commands.js");
const { TALK_FOCUSES, CHAT_CATEGORY } = await import("../app/chat_log.js");

function fakeHandle(soul = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    sendTurbineChannel: rec("sendTurbineChannel"),
    sendChannel: rec("sendChannel"),
    sendChat: rec("sendChat"),
    sendTell: rec("sendTell"),
    sendEmote: rec("sendEmote"),
    sendSoulEmote: rec("sendSoulEmote"),
    broadcastEmoteMotion: rec("broadcastEmoteMotion"),
    resolveSoulEmote: (token) => soul[String(token).toLowerCase()] ?? null,
  };
}

// One router for the whole file (initSlashCommands resets the sticky tell
// targets, so tests set window.__chatLast* AFTER this).
const { routeSlashCommand, routePublicChat } = initSlashCommands();

function route(message, soul) {
  const h = fakeHandle(soul);
  const r = routeSlashCommand(h, message);
  return { r, calls: h.calls, h };
}

const WAVE = { pose: "Wave", motionFull: 0x13000087, myEmote: "wave.", otherEmote: "waves.", held: false };

test("chat-1: Turbine commands use retail ChatTypeEnum room ids", () => {
  const cases = [
    ["/cg hi", 2], ["/general hi", 2],
    ["/ct hi", 3], ["/trade hi", 3],
    ["/clfg hi", 4], ["/lfg hi", 4],
    ["/crp hi", 5], ["/roleplay hi", 5],
    ["/society hi", 6], ["/soc hi", 6],
    ["/olthoi hi", 10], ["/o hi", 10],
    ["/a hi", 1], ["/guild hi", 1], ["/gu hi", 1],
  ];
  for (const [line, type] of cases) {
    const { r, calls } = route(line);
    assert.equal(r.dispatched, true, line);
    assert.deepEqual(calls, [["sendTurbineChannel", type, "hi"]], line);
  }
});

test("chat-1: /ab is the legacy Allegiance Broadcast; /a is not legacy", () => {
  assert.deepEqual(route("/ab hi").calls, [["sendChannel", 0x02000000, "hi"]]);
  assert.equal(Object.prototype.hasOwnProperty.call(CHANNEL_MAP, "a"), false);
  assert.equal(TURBINE_CMDS.a.type, 1);
});

test("chat-1: every talk-focus prefix routes client-side (never a server @command)", () => {
  window.__chatLastIncomingTellSender = null;
  for (const focus of TALK_FOCUSES) {
    if (!focus.prefix) continue; // "Chat" focus = plain speech
    const { r, calls } = route(`${focus.prefix}x`);
    assert.equal(r.dispatched, true, focus.id);
    assert.equal(calls.some(([n, a]) => n === "sendChat" && String(a).startsWith("@")), false, focus.id);
  }
});

test("chat-3: no local echo for server-echoed lines", () => {
  for (const line of ["/t Bob, hi", "/f inc", "/cg hi", "/me waves", "/s hello", "/a hi", "/p hi"]) {
    const { r } = route(line);
    assert.equal(r.dispatched, true, line);
    assert.equal(r.echo, null, line);
    assert.equal(r.error, undefined, line);
  }
  window.__chatLastIncomingTellSender = "Bob";
  const reply = route("/r ok");
  assert.equal(reply.r.echo, null);
  assert.deepEqual(reply.calls, [["sendTell", "Bob", "ok"]]);
});

test("chat-3: soul emote keeps its local `You …` line as an EMOTE line", () => {
  const { r, calls } = route("/wave", { wave: WAVE });
  assert.equal(r.dispatched, true);
  assert.equal(r.echo, "You wave.");
  assert.equal(r.category, CHAT_CATEGORY.EMOTE);
  assert.deepEqual(calls, [["sendSoulEmote", "waves."], ["broadcastEmoteMotion", 0x13000087]]);
});

test("chat-4: '@' reroutes retail client verbs only", () => {
  assert.deepEqual(route("@tell Bob, hi").calls, [["sendTell", "Bob", "hi"]]);
  assert.deepEqual(route("@T Bob, hi").calls, [["sendTell", "Bob", "hi"]]);
  assert.deepEqual(route("@cg wts").calls, [["sendTurbineChannel", 2, "wts"]]);
  const loc = route("@loc");
  assert.equal(loc.r.dispatched, false);
  assert.deepEqual(loc.calls, []);
  // A soul-emote token is NOT a retail client verb: `@wave` goes to the server.
  const wave = route("@wave", { wave: WAVE });
  assert.equal(wave.r.dispatched, false);
  assert.deepEqual(wave.calls, []);
  // Non-retail holtburger aliases are slash-only.
  assert.equal(RETAIL_CLIENT_VERBS.has("h"), false);
  assert.equal(route("@h hi").r.dispatched, false);
});

test("chat-4: ':' / ';' and the e/em/emote/me aliases send a free-text emote", () => {
  for (const line of ["/e waves", "/em waves", "/emote waves", "/me waves", ":waves", ";waves", "/E waves"]) {
    const { r, calls } = route(line);
    assert.equal(r.dispatched, true, line);
    assert.deepEqual(calls, [["sendEmote", "waves"]], line);
  }
  for (const line of [":", ";", "/me", "/me   "]) {
    const { r, calls } = route(line);
    assert.equal(r.dispatched, true, line);
    assert.equal(r.error, undefined, line);
    assert.deepEqual(calls, [], line);
  }
});

test("chat-4: retail legacy channel aliases", () => {
  const cases = [
    ["/c hi", 0x01000000], ["/covassals hi", 0x01000000], ["/co-vassals hi", 0x01000000],
    ["/f hi", 0x800], ["/fellowship hi", 0x800], ["/g hi", 0x800], ["/group hi", 0x800], ["/party hi", 0x800],
    ["/m hi", 0x4000], ["/monarch hi", 0x4000],
    ["/p hi", 0x2000], ["/patron hi", 0x2000],
    ["/v hi", 0x1000], ["/vassals hi", 0x1000],
  ];
  for (const [line, chan] of cases) {
    assert.deepEqual(route(line).calls, [["sendChannel", chan, "hi"]], line);
  }
  const empty = route("/f");
  assert.equal(empty.r.error, "You must specify the text you wish to broadcast!");
  assert.deepEqual(empty.calls, []);
});

test("chat-4: verbs are case-insensitive with a trailing comma trimmed", () => {
  assert.deepEqual(parseCommandLine("/Tell, Bob, hi"), { rawCmd: "tell,", cmd: "tell", rest: "Bob, hi" });
  assert.deepEqual(route("/TELL, Bob, hi").calls, [["sendTell", "Bob", "hi"]]);
  assert.deepEqual(route("/CG hi").calls, [["sendTurbineChannel", 2, "hi"]]);
});

test("chat-4: unknown slash still goes to the server as @cmd (with its echo)", () => {
  const { r, calls } = route("/telepoi holtburg");
  assert.deepEqual(calls, [["sendChat", "@telepoi holtburg"]]);
  assert.equal(r.echo, "> @telepoi holtburg");
});

test("chat-4: normalizeChatLine classification", () => {
  assert.deepEqual(normalizeChatLine("hello"), { kind: "say", line: "hello" });
  assert.deepEqual(normalizeChatLine(":bows"), { kind: "command", line: "/emote bows" });
  assert.deepEqual(normalizeChatLine("@r hi"), { kind: "command", line: "/r hi" });
  assert.deepEqual(normalizeChatLine("@loc"), { kind: "server", line: "@loc" });
});

test("chat-4: extractPoses — retail PublicChat token handling", () => {
  const stub = { one: { motionFull: 1 }, two: { motionFull: 2 }, nomotion: { motionFull: 0 } };
  const resolve = (t) => stub[t] ?? null;
  const a = extractPoses("a *one* b <two> c", resolve);
  assert.equal(a.spoken, "a  b  c");
  assert.deepEqual(a.poses.map((p) => p.resolved.motionFull), [1, 2]);
  const b = extractPoses("x *nomotion* y", resolve);
  assert.equal(b.spoken, "x *nomotion* y");
  assert.deepEqual(b.poses.map((p) => p.token), ["nomotion"]);
  const c = extractPoses("*unknown* and *unfinished", resolve);
  assert.equal(c.spoken, "*unknown* and *unfinished");
  assert.deepEqual(c.poses, []);
  const d = extractPoses("*one*", resolve);
  assert.equal(d.spoken, "");
  const e = extractPoses("i <3 you", resolve);
  assert.equal(e.spoken, "i <3 you");
});

test("chat-4: routePublicChat runs inline poses and returns the remainder", () => {
  const h = fakeHandle({ wave: WAVE });
  const pub = routePublicChat(h, "hi *wave*");
  assert.equal(pub.spoken, "hi");
  assert.deepEqual(pub.echoes, ["You wave."]);
  assert.equal(pub.category, CHAT_CATEGORY.EMOTE);
  assert.deepEqual(h.calls, [["sendSoulEmote", "waves."], ["broadcastEmoteMotion", 0x13000087]]);
  const h2 = fakeHandle({ wave: WAVE });
  const only = routePublicChat(h2, "*wave*");
  assert.equal(only.spoken, "");
  const plain = routePublicChat(fakeHandle(), "just talking");
  assert.equal(plain.spoken, "just talking");
  assert.deepEqual(plain.echoes, []);
});

test("chat-4: emote line join skips the space before an apostrophe", () => {
  assert.equal(formatEmoteLine("You", "wave."), "You wave.");
  assert.equal(formatEmoteLine("Bob", "'s eyes narrow."), "Bob's eyes narrow.");
});

test("chat-5: /reply retail strings", () => {
  window.__chatLastIncomingTellSender = null;
  const none = route("/r hi");
  assert.equal(none.r.error, "Someone must @tell you first!");
  assert.deepEqual(none.calls, []);
  window.__chatLastIncomingTellSender = "Bob";
  const empty = route("/r   ");
  assert.equal(empty.r.error, "You must specify the text you wish to say!");
  assert.deepEqual(empty.calls, []);
  window.__chatLastIncomingTellSender = "Bob";
  assert.deepEqual(route("/r hi").calls, [["sendTell", "Bob", "hi"]]);
});
