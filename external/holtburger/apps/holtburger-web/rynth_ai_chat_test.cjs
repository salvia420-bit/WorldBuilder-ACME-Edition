#!/usr/bin/env node
// rynth_ai_chat_test.cjs — unit tests for the heard-chat observation section
// (extensions.js): ClientEvent kind-2 lines from the webhost push-event plane
// ring-buffered and surfaced as "heard since last check-in:". No infra, no
// network — the host event plane is a plain recording mock.
//
// Run: node rynth_ai_chat_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Mock bot with an event-capable host: onEvent registers listeners, emit()
// pushes normalized events ({kind, text, u32, u32b}) like webhost._dispatchEvent.
function makeBot() {
  const listeners = [];
  return {
    emit: (e) => listeners.forEach((fn) => fn(e)),
    listenerCount: () => listeners.length,
    kernel: { status: { running: true, kills: 0 } },
    host: {
      onEvent: (fn) => listeners.push(fn),
      WriteToChat: () => {},
    },
  };
}

function makeJournal() {
  const entries = [];
  return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "" };
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));
  const mk = (bot, config) =>
    composeAiExtensions(bot, { journal: makeJournal(), config: { knowledge: false, wbt: false, ...config } });

  const speech = (text, cat = 1) => ({ kind: 2, text, u32: 0, u32b: cat });

  // ---- capture + render -------------------------------------------------
  {
    const bot = makeBot();
    const ext = mk(bot);
    check("subscribes to host.onEvent", bot.listenerCount() === 1);
    bot.emit(speech("Jonathan says, \"Give the token back to me and I will send you to Holtburg.\""));
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("heard section present", /heard since last check-in:/.test(obs));
    check("speech line surfaced", /Give the token back/.test(obs));
  }

  // ---- category filter --------------------------------------------------
  {
    const bot = makeBot();
    const ext = mk(bot);
    bot.emit(speech("You evaded the Drudge!", 5)); // combat — filtered
    bot.emit(speech("A tell arrives", 2));
    bot.emit(speech("Quest popup text", 10));
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("combat category filtered", !/evaded the Drudge/.test(obs));
    check("tell kept", /A tell arrives/.test(obs));
    check("popup kept", /Quest popup text/.test(obs));
  }

  // ---- kind=13 UseFailed surfaced ---------------------------------------
  {
    const bot = makeBot();
    const ext = mk(bot);
    bot.emit({ kind: 13, text: "ObjectGone", u32: 0x3d, u32b: 0 });
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("use-failure surfaced with label", /use FAILED: ObjectGone/.test(obs));
  }

  // ---- non-chat events + malformed ignored ------------------------------
  {
    const bot = makeBot();
    const ext = mk(bot);
    bot.emit({ kind: 1, text: null, u32: 123, u32b: 0 }); // PlayerSpawned
    bot.emit({ kind: 2, text: "", u32: 0, u32b: 1 }); // empty text
    bot.emit(null);
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("non-chat/malformed ignored", !/heard since last check-in:/.test(obs));
  }

  // ---- drained between check-ins ----------------------------------------
  {
    const bot = makeBot();
    const ext = mk(bot);
    bot.emit(speech("First greeting"));
    const o1 = ext.directorDeps.observe(bot, {}).text;
    const o2 = ext.directorDeps.observe(bot, {}).text;
    check("first observe hears it", /First greeting/.test(o1));
    check("second observe silent (no new chat)", !/heard since last check-in:/.test(o2));
    bot.emit(speech("Second greeting"));
    const o3 = ext.directorDeps.observe(bot, {}).text;
    check("new chat after drain surfaced", /Second greeting/.test(o3) && !/First greeting/.test(o3));
  }

  // ---- consecutive-repeat collapse --------------------------------------
  {
    const bot = makeBot();
    const ext = mk(bot);
    for (let i = 0; i < 3; i++) bot.emit(speech("Guard says, \"Move along.\""));
    bot.emit(speech("Something else"));
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("repeats collapsed to xN", /Move along\." \(x3\)/.test(obs));
    check("distinct line kept separate", /Something else/.test(obs) && !/Something else \(x/.test(obs));
  }

  // ---- maxLines cap + omitted note + truncation -------------------------
  {
    const bot = makeBot();
    const ext = mk(bot, { chat: { maxLines: 3 } });
    for (let i = 0; i < 6; i++) bot.emit(speech(`line number ${i}`));
    bot.emit(speech("y".repeat(400)));
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("omitted note present", /\(\+4 earlier omitted\)/.test(obs));
    check("keeps most recent", /line number 5/.test(obs) && !/line number 1\b/.test(obs));
    const heard = obs.split("heard since last check-in:")[1] || "";
    check("long line truncated to 200", !heard.includes("y".repeat(201)) && heard.includes("y".repeat(200)));
  }

  // ---- config -----------------------------------------------------------
  {
    const bot = makeBot();
    mk(bot, { chat: false });
    check("chat:false skips subscription", bot.listenerCount() === 0);

    const bot2 = makeBot();
    const ext2 = mk(bot2, { chat: { categories: [5] } });
    bot2.emit(speech("You evaded!", 5));
    bot2.emit(speech("Hello there", 1));
    const obs = ext2.directorDeps.observe(bot2, {}).text;
    check("categories override honored", /You evaded!/.test(obs) && !/Hello there/.test(obs));
  }

  // ---- host without onEvent degrades ------------------------------------
  {
    const bot = makeBot();
    delete bot.host.onEvent;
    const ext = mk(bot);
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("no onEvent host degrades silently", typeof obs === "string" && !/heard since/.test(obs));
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
