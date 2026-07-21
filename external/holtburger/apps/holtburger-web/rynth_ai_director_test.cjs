#!/usr/bin/env node
// rynth_ai_director_test.cjs — unit tests for rynth/ai/director.js (the LLM
// check-in loop). No infra, no network: client/journal/observe/execute/
// validate are all injected mocks, so this passes independently of the
// llm_client/observe/actions implementations landing (SPEC fan-out).
//
// Run: node rynth_ai_director_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeJournal() {
  const entries = [];
  return {
    entries,
    add(kind, text) { entries.push({ kind, text: String(text) }); },
    renderTail() { return "JOURNAL-TAIL-MARKER"; },
    kinds(kind) { return entries.filter((e) => e.kind === kind); },
  };
}

// Scripted client: each chat() consumes the next script entry (last entry
// repeats). Entry = response object | Error (thrown) | async fn (awaited).
function makeClient(script) {
  let i = 0;
  const chatCalls = [];
  return {
    chatCalls,
    spend: { calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 },
    async chat(messages, opts) {
      chatCalls.push({ messages, opts });
      const s = script[Math.min(i, script.length - 1)]; i++;
      if (typeof s === "function") return s();
      if (s instanceof Error) throw s;
      return s;
    },
  };
}

const mockObserve = (bot, opts = {}) => ({ text: `OBS bot=${bot?.tag ?? "?"} tail=${opts.journalTail ?? ""}`, data: {} });
const mockValidate = (a) => (a && typeof a.type === "string" && a.type !== "bogus")
  ? { ok: true } : { ok: false, error: "bad action" };
function makeExec(resultFor) {
  const calls = [];
  const fn = async (bot, actions, opts) => {
    calls.push({ bot, actions, opts });
    return actions.map((a) => (resultFor ? resultFor(a) : { type: a.type, ok: true }));
  };
  fn.calls = calls;
  return fn;
}
const resp = (json) => ({ text: JSON.stringify(json), json, usage: { prompt: 10, completion: 5 }, model: "mock", ms: 1 });

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "director.js")).href);
  const { RynthAiDirector, DEFAULT_SYSTEM_PROMPT } = mod;

  // ---- DEFAULT_SYSTEM_PROMPT shape (stable parts only; the embedded action
  // catalog text belongs to actions.js and is not asserted here).
  check("prompt: is a string", typeof DEFAULT_SYSTEM_PROMPT === "string" && DEFAULT_SYSTEM_PROMPT.length > 200);
  check("prompt: role", /strategic director/i.test(DEFAULT_SYSTEM_PROMPT) && /grind bot/i.test(DEFAULT_SYSTEM_PROMPT));
  check("prompt: reply contract keys", ["\"analysis\"", "\"actions\"", "next_check_minutes", "\"note\""]
    .every((k) => DEFAULT_SYSTEM_PROMPT.includes(k)));
  check("prompt: cost discipline / prefer none", DEFAULT_SYSTEM_PROMPT.includes('{"actions":[{"type":"none"}]}')
    && /every few minutes/i.test(DEFAULT_SYSTEM_PROMPT) && /decisive/i.test(DEFAULT_SYSTEM_PROMPT));

  // ---- Happy path: plan -> validate -> execute -> journal -> reschedule.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([resp({
      analysis: "loot floor too low",
      actions: [{ type: "set_loot_min_value", value: 5000 }],
      next_check_minutes: 7,
      note: "raised loot floor",
    })]);
    const bot = { tag: "mockbot" };
    const d = new RynthAiDirector(bot, { client, journal, observe: mockObserve, execute: exec, validate: mockValidate });
    d.start();
    const r = await d.checkNow();
    check("happy: plan returned", !!r.plan && r.plan.analysis === "loot floor too low");
    check("happy: execute called with bot + validated actions",
      exec.calls.length === 1 && exec.calls[0].bot === bot
      && exec.calls[0].actions.length === 1
      && exec.calls[0].actions[0].type === "set_loot_min_value"
      && exec.calls[0].actions[0].value === 5000);
    check("happy: results", r.results.length === 1 && r.results[0].type === "set_loot_min_value" && r.results[0].ok === true);
    check("happy: journal plan+result+note",
      journal.kinds("plan").length === 1 && journal.kinds("result").length === 1
      && journal.kinds("note").length === 1 && journal.kinds("note")[0].text === "raised loot floor",
      JSON.stringify(journal.entries));
    check("happy: [system,user] messages, default system prompt",
      client.chatCalls[0].messages.length === 2
      && client.chatCalls[0].messages[0].role === "system"
      && client.chatCalls[0].messages[0].content === DEFAULT_SYSTEM_PROMPT
      && client.chatCalls[0].messages[1].role === "user");
    check("happy: observation carries journal tail",
      client.chatCalls[0].messages[1].content.includes("JOURNAL-TAIL-MARKER"));
    const st = d.status;
    check("happy: status shape", ["enabled", "running", "lastCheckAt", "nextCheckAt", "calls", "consecutiveErrors", "lastSummary", "spend"]
      .every((k) => k in st));
    check("happy: lastCheckAt recent", typeof st.lastCheckAt === "number" && Date.now() - st.lastCheckAt < 5000);
    check("happy: next_check_minutes applied (7m)",
      Math.abs(st.nextCheckAt - Date.now() - 7 * 60_000) < 2000,
      `delta=${st.nextCheckAt - Date.now()}`);
    check("happy: counters", st.calls === 1 && st.consecutiveErrors === 0 && st.running === false);
    check("happy: lastSummary", st.lastSummary === "loot floor too low");
    check("happy: spend passthrough", st.spend === client.spend);
    d.stop();
    check("happy: stop clears schedule", d.status.enabled === false && d.status.nextCheckAt === null);
  }

  // ---- Public busy/lastCheck accessors (WP-5): isBusy() reflects the
  // serialized in-flight guard; lastCheckAt mirrors status.lastCheckAt. These
  // are the stable surface bot.js's ExplorePressureController reads instead of
  // reaching into _running/_inflight/_lastCheckAt.
  {
    const client = makeClient([async () => { await sleep(60); return resp({ analysis: "slow", actions: [], next_check_minutes: 5 }); }]);
    const d = new RynthAiDirector({}, { client, journal: makeJournal(), observe: mockObserve, execute: makeExec(), validate: mockValidate });
    check("accessor: isBusy() is a method", typeof d.isBusy === "function");
    check("accessor: idle before the first check-in", d.isBusy() === false && d.lastCheckAt === null);
    const p = d.checkNow();
    await sleep(10);
    check("accessor: isBusy() true while a check-in is in flight", d.isBusy() === true);
    check("accessor: isBusy() agrees with status.running", d.isBusy() === d.status.running);
    await p;
    check("accessor: isBusy() false once the check resolves", d.isBusy() === false);
    check("accessor: lastCheckAt set after the check, mirrors status.lastCheckAt",
      typeof d.lastCheckAt === "number" && d.lastCheckAt === d.status.lastCheckAt && Date.now() - d.lastCheckAt < 5000);
  }

  // ---- Clamping of LLM next_check_minutes to [min, max]; custom systemPrompt.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([
      resp({ analysis: "a", actions: [], next_check_minutes: 999 }),
      resp({ analysis: "b", actions: [], next_check_minutes: 0.2 }),
      resp({ analysis: "c", actions: [] }), // missing -> intervalMinutes
    ]);
    const d = new RynthAiDirector({}, {
      client, journal, observe: mockObserve, execute: exec, validate: mockValidate,
      intervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 30, systemPrompt: "SP-CUSTOM",
    });
    d.start();
    await d.checkNow();
    check("clamp: 999 -> max 30m", Math.abs(d.status.nextCheckAt - Date.now() - 30 * 60_000) < 2000,
      `delta=${d.status.nextCheckAt - Date.now()}`);
    await d.checkNow();
    check("clamp: 0.2 -> min 1m", Math.abs(d.status.nextCheckAt - Date.now() - 1 * 60_000) < 2000,
      `delta=${d.status.nextCheckAt - Date.now()}`);
    await d.checkNow();
    check("clamp: missing -> intervalMinutes 5m", Math.abs(d.status.nextCheckAt - Date.now() - 5 * 60_000) < 2000,
      `delta=${d.status.nextCheckAt - Date.now()}`);
    check("clamp: custom system prompt used", client.chatCalls[0].messages[0].content === "SP-CUSTOM");
    d.stop();
  }

  // ---- Invalid actions are filtered out before execute, recorded as failures.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([resp({
      analysis: "mixed", actions: [{ type: "bogus" }, { type: "say", text: "hi" }], next_check_minutes: 5,
    })]);
    const d = new RynthAiDirector({}, { client, journal, observe: mockObserve, execute: exec, validate: mockValidate });
    const r = await d.checkNow();
    check("filter: only valid action executed",
      exec.calls.length === 1 && exec.calls[0].actions.length === 1 && exec.calls[0].actions[0].type === "say");
    check("filter: invalid action in results as failure",
      r.results.some((x) => x.type === "bogus" && x.ok === false)
      && r.results.some((x) => x.type === "say" && x.ok === true));
    check("filter: result journal marks the failure", journal.kinds("result")[0].text.includes("FAIL"));
  }

  // ---- Invalid / missing JSON from the LLM: error journaled, no execute.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([
      { text: "sorry, I cannot produce JSON right now", json: null, usage: { prompt: 1, completion: 1 }, model: "mock", ms: 1 },
      resp({ analysis: "recovered", actions: [], next_check_minutes: 5 }),
    ]);
    const d = new RynthAiDirector({}, { client, journal, observe: mockObserve, execute: exec, validate: mockValidate });
    const r = await d.checkNow().catch((e) => ({ threw: e }));
    check("badjson: does not reject", !r.threw, String(r.threw));
    check("badjson: no plan, no execute", r.plan === null && exec.calls.length === 0);
    check("badjson: error journaled", journal.kinds("error").length === 1, JSON.stringify(journal.entries));
    check("badjson: counts as consecutive error", d.status.consecutiveErrors === 1);
    await d.checkNow();
    check("badjson: success resets consecutive errors", d.status.consecutiveErrors === 0);
  }

  // ---- Client throws x N -> disabled after maxErrorsBeforeDisable.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([new Error("boom")]);
    const d = new RynthAiDirector({}, {
      client, journal, observe: mockObserve, execute: exec, validate: mockValidate,
      maxErrorsBeforeDisable: 3, intervalMinutes: 5,
    });
    d.start();
    const r1 = await d.checkNow().catch((e) => ({ threw: e }));
    check("disable: error checkNow does not reject", !r1.threw && r1.plan === null);
    check("disable: still enabled after 1 error, retry scheduled",
      d.status.enabled === true && d.status.consecutiveErrors === 1
      && Math.abs(d.status.nextCheckAt - Date.now() - 5 * 60_000) < 2000);
    await d.checkNow();
    await d.checkNow();
    check("disable: stopped after 3 consecutive errors",
      d.status.enabled === false && d.status.nextCheckAt === null && d.status.consecutiveErrors === 3);
    check("disable: journal notes the disable",
      journal.kinds("error").some((e) => /disabled after 3 consecutive errors/.test(e.text)),
      JSON.stringify(journal.kinds("error")));
    check("disable: calls counted", d.status.calls === 3);
  }

  // ---- Idle-guard: an AI-paused kernel is resumed when the director
  // self-disables (2026-07-16 live-soak finding: gpt-oss paused for mana,
  // the next model's failing check-ins left the bot parked forever).
  {
    const journal = makeJournal();
    let running = true, startCalls = 0;
    const bot = { kernel: { start() { running = true; startCalls++; }, stop() { running = false; }, get running() { return running; } } };
    const client = makeClient([
      resp({ analysis: "regen mana", actions: [{ type: "pause" }], next_check_minutes: 5 }),
      new Error("boom"),
    ]);
    const exec = makeExec((a) => {
      if (a.type === "pause") { bot.kernel.stop(); return { type: "pause", ok: true, result: "paused" }; }
      return { type: a.type, ok: true };
    });
    const d = new RynthAiDirector(bot, {
      client, journal, observe: mockObserve, execute: exec, validate: mockValidate,
      maxErrorsBeforeDisable: 2, intervalMinutes: 5,
    });
    d.start();
    await d.checkNow(); // plan 1: pause executes, guard armed
    check("idleguard: AI pause stops the kernel", running === false);
    await d.checkNow(); // error 1 -> still enabled, kernel stays paused
    check("idleguard: kernel stays paused below the disable threshold", running === false && d.status.enabled === true);
    await d.checkNow(); // error 2 -> self-disable -> guard resumes
    check("idleguard: self-disable resumes the AI-paused kernel",
      running === true && startCalls === 1 && d.status.enabled === false);
    check("idleguard: resume journaled",
      journal.kinds("note").some((e) => /idle-guard/.test(e.text)), JSON.stringify(journal.kinds("note")));
  }
  {
    // A dryRun pause executes nothing, so it must NOT arm the guard; and an
    // AI resume disarms it.
    const journal = makeJournal();
    let startCalls = 0;
    const bot = { kernel: { start() { startCalls++; }, stop() {}, get running() { return false; } } };
    const client = makeClient([
      resp({ analysis: "dry pause", actions: [{ type: "pause" }], next_check_minutes: 5 }),
      new Error("boom"),
    ]);
    const d = new RynthAiDirector(bot, {
      client, journal, observe: mockObserve, execute: makeExec(), validate: mockValidate,
      maxErrorsBeforeDisable: 1, intervalMinutes: 5, dryRun: true,
    });
    d.start();
    await d.checkNow(); // dryRun pause — synthesized result, nothing executed
    await d.checkNow(); // error -> immediate disable
    check("idleguard: dryRun pause does not arm the guard", startCalls === 0 && d.status.enabled === false);
  }

  // ---- Budget: rolling 60-min window vs maxCallsPerHour.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([resp({ analysis: "ok", actions: [], next_check_minutes: 5 })]);
    const d = new RynthAiDirector({}, {
      client, journal, observe: mockObserve, execute: exec, validate: mockValidate,
      maxCallsPerHour: 2, intervalMinutes: 5,
    });
    d.start();
    await d.checkNow();
    await d.checkNow();
    const r = await d.checkNow();
    check("budget: third call refused without chatting", client.chatCalls.length === 2 && r.plan === null && r.skipped === "budget");
    check("budget: journaled", journal.kinds("budget").length === 1, JSON.stringify(journal.kinds("budget")));
    check("budget: not an error", d.status.consecutiveErrors === 0);
    check("budget: rescheduled at intervalMinutes",
      Math.abs(d.status.nextCheckAt - Date.now() - 5 * 60_000) < 2000,
      `delta=${d.status.nextCheckAt - Date.now()}`);
    d.stop();
  }

  // ---- dryRun: full loop, no execute.
  {
    const journal = makeJournal();
    const exec = makeExec();
    const client = makeClient([resp({
      analysis: "would pause", actions: [{ type: "pause" }], next_check_minutes: 5,
    })]);
    const d = new RynthAiDirector({}, {
      client, journal, observe: mockObserve, execute: exec, validate: mockValidate, dryRun: true,
    });
    const r = await d.checkNow();
    check("dryRun: execute NOT called", exec.calls.length === 0);
    check("dryRun: plan + synthesized results", !!r.plan && r.results.length === 1
      && r.results[0].type === "pause" && r.results[0].ok === true && r.results[0].dryRun === true);
    check("dryRun: still journaled", journal.kinds("plan").length === 1 && journal.kinds("result").length === 1);
  }

  // ---- set_checkin action result overrides next_check_minutes (SPEC §actions).
  {
    const exec = makeExec((a) => (a.type === "set_checkin"
      ? { type: "set_checkin", ok: true, result: { minutes: a.minutes } }
      : { type: a.type, ok: true }));
    const client = makeClient([resp({
      analysis: "tighten cadence", actions: [{ type: "set_checkin", minutes: 3 }], next_check_minutes: 10,
    })]);
    const d = new RynthAiDirector({}, { client, journal: makeJournal(), observe: mockObserve, execute: exec, validate: mockValidate });
    d.start();
    await d.checkNow();
    check("set_checkin: applied over next_check_minutes (3m not 10m)",
      Math.abs(d.status.nextCheckAt - Date.now() - 3 * 60_000) < 2000,
      `delta=${d.status.nextCheckAt - Date.now()}`);
    d.stop();
  }

  // ---- Serialization: concurrent checkNow shares the in-flight check.
  {
    const exec = makeExec();
    const client = makeClient([async () => { await sleep(60); return resp({ analysis: "slow", actions: [], next_check_minutes: 5 }); }]);
    const d = new RynthAiDirector({}, { client, journal: makeJournal(), observe: mockObserve, execute: exec, validate: mockValidate });
    const p1 = d.checkNow();
    const p2 = d.checkNow();
    await sleep(10);
    check("serialize: running while in flight", d.status.running === true);
    const [r1, r2] = await Promise.all([p1, p2]);
    check("serialize: one chat for two concurrent calls", client.chatCalls.length === 1);
    check("serialize: same result object", r1 === r2 && r1.plan.analysis === "slow");
    check("serialize: running cleared", d.status.running === false);
    const r3 = await d.checkNow();
    check("serialize: next call is a fresh check", client.chatCalls.length === 2 && r3 !== r1);
  }

  // ---- Manual checkNow while stopped does not resurrect the timer chain.
  {
    const client = makeClient([resp({ analysis: "manual", actions: [], next_check_minutes: 5 })]);
    const d = new RynthAiDirector({}, { client, journal: makeJournal(), observe: mockObserve, execute: makeExec(), validate: mockValidate });
    const r = await d.checkNow(); // never started
    check("manual: works while disabled", !!r.plan && r.plan.analysis === "manual");
    check("manual: no schedule while disabled", d.status.enabled === false && d.status.nextCheckAt === null);
  }

  // ---- Broken journal / observe never break the loop; observe throw = error path.
  {
    const badJournal = { add() { throw new Error("quota"); }, renderTail() { throw new Error("corrupt"); } };
    const exec = makeExec();
    const client = makeClient([resp({ analysis: "resilient", actions: [{ type: "none" }], next_check_minutes: 5 })]);
    const d = new RynthAiDirector({}, { client, journal: badJournal, observe: mockObserve, execute: exec, validate: mockValidate });
    const r = await d.checkNow().catch((e) => ({ threw: e }));
    check("resilience: broken journal, check still succeeds", !r.threw && !!r.plan && exec.calls.length === 1);

    const journal = makeJournal();
    const client2 = makeClient([resp({ analysis: "x", actions: [], next_check_minutes: 5 })]);
    const d2 = new RynthAiDirector({}, {
      client: client2, journal, observe: () => { throw new Error("obs broke"); },
      execute: makeExec(), validate: mockValidate,
    });
    const r2 = await d2.checkNow().catch((e) => ({ threw: e }));
    check("resilience: observe throw -> error path, no chat",
      !r2.threw && r2.plan === null && client2.chatCalls.length === 0
      && journal.kinds("error").length === 1 && d2.status.consecutiveErrors === 1);
  }

  // ---- start/stop idempotence with a real short timer (fractional interval).
  {
    const journal = makeJournal();
    const exec = makeExec();
    // next_check_minutes 30 -> after the first fire the chain parks for 30 min
    // and can't re-fire inside this test.
    const client = makeClient([resp({ analysis: "timer fire", actions: [], next_check_minutes: 30 })]);
    const d = new RynthAiDirector({}, {
      client, journal, observe: mockObserve, execute: exec, validate: mockValidate,
      intervalMinutes: 0.003, // 180 ms — constructor interval is intentionally unclamped
    });
    d.start();
    const n1 = d.status.nextCheckAt;
    d.start(); // idempotent: must not reschedule
    check("timer: start idempotent", d.status.enabled === true && d.status.nextCheckAt === n1);
    check("timer: first check ~180ms out", n1 - Date.now() < 1000, `delta=${n1 - Date.now()}`);
    await sleep(600);
    check("timer: fired exactly once", client.chatCalls.length === 1, `calls=${client.chatCalls.length}`);
    check("timer: rescheduled from plan (~30m)",
      Math.abs(d.status.nextCheckAt - Date.now() - 30 * 60_000) < 5000,
      `delta=${d.status.nextCheckAt - Date.now()}`);
    d.stop();
    d.stop(); // idempotent
    check("timer: stop idempotent", d.status.enabled === false && d.status.nextCheckAt === null);

    // stop() cancels a pending short timer before it fires.
    const client2 = makeClient([resp({ analysis: "never", actions: [], next_check_minutes: 30 })]);
    const d2 = new RynthAiDirector({}, {
      client: client2, journal: makeJournal(), observe: mockObserve, execute: makeExec(), validate: mockValidate,
      intervalMinutes: 0.003,
    });
    d2.start();
    d2.stop();
    await sleep(400);
    check("timer: stop cancels pending check", client2.chatCalls.length === 0);
  }

  // ---- requestEarlyCheck (event-driven early check-ins, handoff-6 §3.4).
  {
    const journal = makeJournal();
    const d = new RynthAiDirector({}, { client: makeClient([]), journal, observe: mockObserve, execute: makeExec(), validate: mockValidate, intervalMinutes: 5 });
    check("early: disabled -> refused", d.requestEarlyCheck("x") === false);
    d.start();
    const before = d.status.nextCheckAt;
    const ok = d.requestEarlyCheck("received a tell");
    check("early: pulls the schedule forward", ok === true && d.status.nextCheckAt < before && d.status.nextCheckAt - Date.now() < 10_000,
      `next in ${d.status.nextCheckAt - Date.now()}ms`);
    check("early: journaled with the reason", journal.kinds("note").some((n) => /early check-in/.test(n.text) && /received a tell/.test(n.text)),
      JSON.stringify(journal.entries));
    check("early: imminent check not re-pulled", d.requestEarlyCheck("second event") === false);
    d.stop();
  }
  {
    // within minGapSeconds of the LAST check -> refused (burst debounce).
    const d = new RynthAiDirector({}, { client: makeClient([resp({ analysis: "", actions: [], next_check_minutes: 5 })]), journal: makeJournal(), observe: mockObserve, execute: makeExec(), validate: mockValidate });
    d.start();
    await d.checkNow();
    check("early: min-gap after a fresh check refused", d.requestEarlyCheck("x") === false);
    d.stop();
  }

  // ---- travel-hold (SPEC-navatlas §3-W3.2): scheduled fires skip the LLM
  // while holdWhile() is truthy; early checks and force bypass; cap releases.
  {
    const journal = makeJournal();
    const client = makeClient([resp({ analysis: "held-suite", actions: [], next_check_minutes: 5 })]);
    let holding = true;
    const d = new RynthAiDirector({}, {
      client, journal, observe: mockObserve, execute: makeExec(), validate: mockValidate,
      intervalMinutes: 5, holdWhile: () => (holding ? "travelling: test-route" : null),
      holdPollMinutes: 0.002, maxHoldMinutes: 60,
    });
    d.enabled = true; // schedule via checkNow paths below, no timer race
    const r1 = await d.checkNow();
    check("hold: scheduled check skipped while holding", r1.skipped === "hold" && client.chatCalls.length === 0);
    const r2 = await d.checkNow();
    check("hold: still held on the next poll", r2.skipped === "hold" && client.chatCalls.length === 0);
    check("hold: journaled ONCE per hold streak",
      journal.kinds("budget").filter((n) => /check-ins held/.test(n.text)).length === 1,
      JSON.stringify(journal.entries));
    const rf = await d.checkNow({ force: true });
    check("hold: force bypasses the hold", rf.plan != null && client.chatCalls.length === 1);
    holding = true;
    const r3 = await d.checkNow();
    check("hold: re-arms after a real check (new streak)", r3.skipped === "hold");
    check("hold: second streak journaled separately",
      journal.kinds("budget").filter((n) => /check-ins held/.test(n.text)).length === 2);
    holding = false;
    const r4 = await d.checkNow();
    check("hold: released when holdWhile goes falsy", r4.plan != null && client.chatCalls.length === 2);
    d.stop();
  }
  {
    // Early check bypasses the hold: the route-completion event must reach
    // the model even though holdWhile is still momentarily truthy.
    const client = makeClient([resp({ analysis: "early-through-hold", actions: [], next_check_minutes: 5 })]);
    const d = new RynthAiDirector({}, {
      client, journal: makeJournal(), observe: mockObserve, execute: makeExec(), validate: mockValidate,
      intervalMinutes: 5, holdWhile: () => "travelling: test-route", holdPollMinutes: 0.002,
    });
    d.start();
    const ok = d.requestEarlyCheck("route arrived: test-route", { delaySeconds: 0.05 });
    check("hold: early check accepted", ok === true);
    await sleep(400);
    check("hold: early check went through the hold", client.chatCalls.length === 1);
    d.stop();
  }
  {
    // Safety cap: a stuck route must not silence the director forever.
    const client = makeClient([resp({ analysis: "cap", actions: [], next_check_minutes: 5 })]);
    const d = new RynthAiDirector({}, {
      client, journal: makeJournal(), observe: mockObserve, execute: makeExec(), validate: mockValidate,
      intervalMinutes: 5, holdWhile: () => "travelling: stuck-route",
      holdPollMinutes: 5, maxHoldMinutes: 0.003, // cap ~180ms; poll far out so only the manual calls fire
    });
    d.enabled = true;
    const r1 = await d.checkNow();
    check("hold-cap: first fire held", r1.skipped === "hold");
    await sleep(300);
    const r2 = await d.checkNow();
    check("hold-cap: past the cap the check proceeds", r2.plan != null && client.chatCalls.length === 1);
    d.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
