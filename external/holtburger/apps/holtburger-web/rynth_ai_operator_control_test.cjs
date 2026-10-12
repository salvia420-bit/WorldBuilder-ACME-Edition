#!/usr/bin/env node
// rynth_ai_operator_control_test.cjs — the ONE stop/resume/state authority
// (rynth/ai/operator_stop.js OperatorControl, 2026-10-12) driven against the
// REAL RynthBotKernel (rynth/kernel.js) and the REAL RynthAiDirector, plus the
// seams that must honour it: the director's check-in refusal, the portal-space
// hold, dispose(), billed-usage cost tracking, the extensions mid-plan abort,
// world.js approach() pausing the kernel, wbt file_ticket's character name and
// the clean-test wipe.
//
// No infra, no browser, no network: fake host/router/unwedge, scripted LLM
// client, injected Storage. Run: node rynth_ai_operator_control_test.cjs

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const imp = (...p) => import(pathToFileURL(path.join(__dirname, ...p)).href);

function makeStore(seed) {
  const m = new Map(seed ? Object.entries(seed) : undefined);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function makeJournal() {
  const entries = [];
  return {
    entries,
    add(kind, text) { entries.push({ t: Date.now(), kind, text: String(text) }); },
    tail(n = 10) { return entries.slice(-n); },
    renderTail() { return ""; },
  };
}

const resp = (json, usage = { prompt: 1000, completion: 500 }) => ({
  text: JSON.stringify(json), json, usage, billedUsage: usage, model: "openai/gpt-oss-120b", ms: 1,
});

(async () => {
  const os = await imp("rynth", "ai", "operator_stop.js");
  const { RynthBotKernel } = await imp("rynth", "kernel.js");
  const { RynthAiDirector } = await imp("rynth", "ai", "director.js");

  // A bot shaped like createGrindBot()'s, with the REAL kernel and director.
  const ME = 0x50000001; // the default fake character guid (bot-stop latch scope)
  const KEY = os.botStopKey(ME);
  function makeBot({ kernelRunning = true, aiEnabled = true, withDirector = true, chat, guid = ME } = {}) {
    const calls = [];
    const ticks = [];
    const host = {
      guid,
      onTick(fn) { ticks.push(fn); },
      GetPlayerId() { return this.guid; },
      IsPlayerReady: () => true,
      StopStick: () => calls.push("StopStick"),
      StopCompletely: () => calls.push("StopCompletely"),
    };
    const combat = { enabled: true, locked: 0, kills: 4, _scanTargets: () => [] };
    const loot = { enabled: true, state: "SCAN", lootedCount: 2, _findCorpse: () => null };
    const kernel = new RynthBotKernel(host, { combat, buff: null, loot, vitals: null, unwedge: null }, { log: () => {} });
    if (kernelRunning) kernel.start();
    const router = { cancels: 0, status: { state: "WALK" }, cancel() { this.cancels++; this.status = { state: "IDLE" }; } };
    const unwedge = {
      state: "RETREAT", enabled: true, cancelled: [],
      active() { return this.state !== "MONITOR"; },
      cancel(why) { this.cancelled.push(why); this.state = "MONITOR"; },
    };
    const bot = { host, kernel, combat, loot, buff: null, vitals: null, router, unwedge, globalRouter: { busy: false }, mission: null, _calls: calls, _ticks: ticks };
    if (withDirector) {
      const journal = makeJournal();
      const chats = [];
      const client = {
        model: "openai/gpt-oss-120b",
        spend: { calls: 0 },
        async chat(messages) {
          chats.push(messages);
          return chat ? chat() : resp({ analysis: "ok", actions: [{ type: "none" }], next_check_minutes: 5 });
        },
      };
      const director = new RynthAiDirector(bot, {
        client, journal,
        observe: () => ({ text: "OBS", data: {} }),
        validate: () => ({ ok: true }),
        execute: async (_b, actions) => actions.map((a) => ({ type: a.type, ok: true })),
        portalSpaceActive: () => false,
        log: () => {},
      });
      bot.ai = { director, client, journal };
      if (aiEnabled) director.start();
      bot._chats = chats;
    }
    return bot;
  }
  const quiet = { log: () => {} };

  // ── 1. getOperatorControl: one attached instance ───────────────────────
  {
    const bot = makeBot();
    const s = makeStore();
    const c1 = os.getOperatorControl(bot, { storage: s, ...quiet });
    const c2 = os.getOperatorControl(bot, { storage: s, ...quiet });
    check("getOperatorControl attaches bot.control", bot.control === c1 && c1 instanceof os.OperatorControl);
    check("getOperatorControl is idempotent", c1 === c2);
    check("getOperatorControl(null) -> null", os.getOperatorControl(null) === null);
    const st = c1.state();
    check("initial state: running", st.running === true && st.stopped === false && st.reason === null);
    check("initial state: kernel running, not held", st.kernel && st.kernel.running === true && st.kernel.held === false);
    check("initial state: ai enabled", st.ai && st.ai.enabled === true);
    check("initial state: subsystems", st.subsystems.combat === true && st.subsystems.loot === true && st.subsystems.buff === null);
    check("initial state: movement mirrors router/unwedge", st.movement.router === "WALK" && st.movement.unwedge === "RETREAT");
    bot.ai.director.dispose();
  }

  // ── 2. stop(): everything halts, persisted; resume() undoes it ─────────
  {
    const bot = makeBot();
    const s = makeStore();
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    const seen = [];
    const off = ctl.onChange((st) => seen.push(st.stopped));
    ctl.onChange(() => { throw new Error("broken listener"); });
    const st = ctl.stop({ reason: "hud" });
    check("stop: state stopped with reason", st.stopped === true && st.running === false && st.reason === "hud");
    check("stop: kernel held + not running", bot.kernel.operatorHeld === true && bot.kernel.running === false);
    check("stop: kernel.start() refused for every caller", bot.kernel.start() === false && bot.kernel.running === false);
    check("stop: director disabled", bot.ai.director.enabled === false);
    check("stop: router cancelled", bot.router.cancels === 1);
    check("stop: unwedge recovery cancelled", bot.unwedge.cancelled.length === 1 && bot.unwedge.state === "MONITOR");
    check("stop: pursuit + stick stopped", bot._calls.includes("StopCompletely") && bot._calls.includes("StopStick"));
    check("stop: persisted under THIS character's key (never the bare key)", s.getItem(KEY) === "1" && s.getItem(os.BOT_STOP_KEY) === null && st.latched.bot === true);
    check("stop: AI latch untouched", st.latched.ai === false);
    check("onChange fired (a throwing listener did not break it)", seen.length === 1 && seen[0] === true);

    // the director refuses while the bot is held — no LLM call
    const r = await bot.ai.director.checkNow();
    check("held: director check-in refused", r.skipped === "operator-hold" && bot._chats.length === 0, JSON.stringify(r));
    check("held: refusal journaled", bot.ai.journal.entries.some((e) => /operator-stopped/.test(e.text)));
    check("held: director status reports operatorHeld", bot.ai.director.status.operatorHeld === true);

    // a repeat stop keeps the FIRST stop's memory (kernel/director were running)
    ctl.stop({ reason: "again" });
    const st2 = ctl.resume();
    check("resume: running", st2.running === true && st2.stopped === false);
    check("resume: latch cleared", s.getItem(KEY) === null);
    check("resume: kernel released + running", bot.kernel.operatorHeld === false && bot.kernel.running === true);
    check("resume: director restarted", bot.ai.director.enabled === true);
    check("onChange fired on stop/stop/resume", seen.length === 3 && seen[2] === false, JSON.stringify(seen));
    off();
    ctl.stop({ persist: false });
    check("unsubscribe stops notifications", seen.length === 3);
    check("stop({persist:false}) writes no latch", s.getItem(KEY) === null && s.getItem(os.BOT_STOP_KEY) === null);
    ctl.resume();
    const r2 = await bot.ai.director.checkNow();
    check("after resume: director check-in runs", !r2.skipped && bot._chats.length === 1, JSON.stringify(r2));
    bot.ai.director.dispose();
  }

  // ── 3. resume restores ONLY what ran before the stop ───────────────────
  {
    // AI-paused kernel (plain stop, no hold) stays paused across stop/resume.
    const bot = makeBot();
    bot.kernel.stop();
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    ctl.stop();
    ctl.resume();
    check("AI-paused kernel stays paused after resume", bot.kernel.running === false && bot.kernel.operatorHeld === false);
    bot.ai.director.dispose();
  }
  {
    // An AI-latched director stays off across a bot stop/resume.
    const bot = makeBot();
    const s = makeStore();
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    ctl.setAi(false);
    check("setAi(false): AI latch set + director stopped", s.getItem(os.OPERATOR_STOP_KEY) === "1" && bot.ai.director.enabled === false);
    ctl.stop();
    ctl.resume();
    check("AI-latched director stays off after resume", bot.ai.director.enabled === false && bot.kernel.running === true);
    const on = ctl.setAi(true);
    check("setAi(true): latch cleared + director started", on.ok && s.getItem(os.OPERATOR_STOP_KEY) === null && bot.ai.director.enabled === true);
    bot.ai.director.dispose();
  }
  {
    // setAi(true) while STOPPED defers the start to resume().
    const bot = makeBot({ aiEnabled: false });
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    ctl.stop();
    const r = ctl.setAi(true);
    check("setAi(true) while stopped: deferred, director still off", r.ok && r.deferred === true && bot.ai.director.enabled === false);
    ctl.resume();
    check("deferred AI start happens on resume", bot.ai.director.enabled === true);
    bot.ai.director.dispose();
  }
  {
    // toggle() flips; setAi(true) with no director is an honest failure.
    const bot = makeBot({ withDirector: false });
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    check("toggle -> stopped", ctl.toggle().stopped === true);
    check("toggle -> running", ctl.toggle().running === true);
    const r = ctl.setAi(true);
    check("setAi(true) without a director -> ok:false", r.ok === false && /no AI director/.test(r.error));
    check("state.ai null without a director", ctl.state().ai === null);
  }

  // ── 4. setEnabled ───────────────────────────────────────────────────────
  {
    const bot = makeBot({ withDirector: false });
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    const r = ctl.setEnabled("combat", false);
    check("setEnabled(combat,false)", r.ok && bot.combat.enabled === false && r.state.subsystems.combat === false);
    check("setEnabled(loot,false)", ctl.setEnabled("loot", false).ok && bot.loot.enabled === false);
    check("setEnabled(unknown) -> ok:false", ctl.setEnabled("teleport", true).ok === false);
    check("setEnabled(__proto__) -> ok:false", ctl.setEnabled("__proto__", true).ok === false);
    check("setEnabled(buff) with no buff loop -> ok:false", ctl.setEnabled("buff", true).ok === false);
    check("cancelTravel cancels the router without stopping loops",
      ctl.cancelTravel().running === true && bot.router.cancels === 1 && bot.kernel.running === true);
  }

  // ── 5. boot-held reboot (bot.js startHeld) + enforce-on-create ─────────
  {
    // bot.js with startHeld: kernel boots held, director built but deferred.
    const bot = makeBot({ kernelRunning: false, aiEnabled: false });
    bot.kernel.holdForOperator();
    bot.ai.deferredAutoStart = true;
    const s = makeStore({ [KEY]: "1" });
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    const st = ctl.state();
    check("boot-held: reads stopped (hold + latch)", st.stopped === true && st.latched.bot === true && st.ai.deferredAutoStart === true);
    check("boot-held: control did not re-stop (no router cancel)", bot.router.cancels === 0);
    ctl.resume();
    check("boot-held resume: kernel started", bot.kernel.running === true && bot.kernel.operatorHeld === false);
    check("boot-held resume: deferred director started", bot.ai.director.enabled === true && bot.ai.deferredAutoStart === false);
    check("boot-held resume: latch cleared", s.getItem(KEY) === null);
    bot.ai.director.dispose();
  }
  {
    // bot.js WITHOUT startHeld support booted running despite the latch:
    // the control enforces the persisted stop on creation.
    const bot = makeBot();
    const s = makeStore({ [KEY]: "1" });
    os.getOperatorControl(bot, { storage: s, ...quiet });
    check("enforce-on-create: latch stops a running bot", bot.kernel.operatorHeld === true && bot.kernel.running === false && bot.ai.director.enabled === false);
    bot.control.resume();
    check("enforce-on-create: resume restores it", bot.kernel.running === true && bot.ai.director.enabled === true);
    bot.ai.director.dispose();
  }
  {
    // unwedge without a public cancel(): an active recovery is finished.
    const bot = makeBot({ withDirector: false });
    let finished = null;
    bot.unwedge = { state: "RETREAT", active() { return this.state !== "MONITOR"; }, _finish(ok, why) { finished = { ok, why }; this.state = "MONITOR"; } };
    os.getOperatorControl(bot, { storage: makeStore(), ...quiet }).stop();
    check("unwedge fallback: _finish(false, operator…)", finished && finished.ok === false && /operator/.test(finished.why));
  }

  // ── 6. director: portal hold, dispose, billed cost ─────────────────────
  {
    let inPortal = true;
    const journal = makeJournal();
    const chats = [];
    const d = new RynthAiDirector({}, {
      client: { model: "openai/gpt-oss-120b", async chat(m) { chats.push(m); return resp({ analysis: "a", actions: [] , note: "n" }); } },
      journal, observe: () => ({ text: "OBS" }), validate: () => ({ ok: true }),
      execute: async () => [], portalSpaceActive: () => inPortal, log: () => {},
    });
    let r = await d.checkNow();
    check("portal: check-in held, no LLM call", r.skipped === "portal" && chats.length === 0, JSON.stringify(r));
    r = await d.checkNow();
    check("portal: hold journaled once", journal.entries.filter((e) => /portal space/.test(e.text)).length === 1);
    check("portal: status.portalHold", d.status.portalHold === true);
    r = await d.checkNow({ force: true });
    check("portal: force bypasses the hold", !r.skipped && chats.length === 1);
    d._portalHoldSince = Date.now() - 3 * 60_000; // past the 2-minute cap
    r = await d.checkNow();
    check("portal: capped hold falls through", !r.skipped && chats.length === 2);
    inPortal = false;
    r = await d.checkNow();
    check("portal: arrival clears the hold", !r.skipped && d.status.portalHold === false && chats.length === 3);
    // billed usage feeds the $ cap (gpt-oss list price: 0.037 in / 0.17 out per Mtok)
    check("billed cost recorded", d.status.estSpendLastHourUsd > 0, String(d.status.estSpendLastHourUsd));
    d.dispose();
    d.start();
    check("dispose: start() is a no-op afterwards", d.enabled === false && d.disposed === true && d.status.disposed === true);
  }
  {
    // a FAILED chat that still billed tokens counts toward the $ cap
    const err = Object.assign(new Error("empty completion"), { kind: "length", billedUsage: { prompt: 4000, completion: 16000 }, model: "minimax/minimax-m3" });
    const d = new RynthAiDirector({}, {
      client: { model: "minimax/minimax-m3", async chat() { throw err; } },
      journal: makeJournal(), observe: () => ({ text: "OBS" }), validate: () => ({ ok: true }),
      execute: async () => [], portalSpaceActive: () => false, log: () => {},
    });
    const r = await d.checkNow();
    check("billed failure: check-in fails", !!r.error);
    check("billed failure: cost recorded", d.status.estSpendLastHourUsd > 0.03, String(d.status.estSpendLastHourUsd));
    d.dispose();
  }

  // ── 7. extensions: mid-plan abort honours the kernel operator hold ─────
  {
    const ext = (await imp("rynth", "ai", "extensions.js")).composeAiExtensions(null, { config: { chat: false, routeRecord: false, wbt: false, knowledge: false } });
    const held = { kernel: { operatorHeld: true }, host: {} };
    const res = await ext.directorDeps.execute(held, [{ type: "none" }, { type: "note", text: "x" }], { log: () => {} });
    check("extensions: held bot aborts every action",
      res.length === 2 && res.every((x) => x.ok === false && /operator stop/.test(x.error)), JSON.stringify(res));
    const free = { kernel: { operatorHeld: false }, host: {} };
    const res2 = await ext.directorDeps.execute(free, [{ type: "none" }], { log: () => {} });
    check("extensions: un-held bot runs the plan", res2.length === 1 && res2[0].ok === true, JSON.stringify(res2));
  }

  // ── 8. world.js approach(): ONE kernel pause around the whole walk ─────
  {
    const world = await imp("rynth", "ai", "tools", "world.js");
    const kernel = { _r: true, stops: 0, starts: 0, get running() { return this._r; }, stop() { this.stops++; this._r = false; }, start() { this.starts++; this._r = true; return true; } };
    const bot = { kernel, host: {} }; // no mover -> approach returns "no-mover" at once
    const tag = await world.approach(bot, 0x5001, 500);
    check("approach: kernel paused once and restored", tag === "no-mover" && kernel.stops === 1 && kernel.starts === 1 && kernel.running === true, `${tag} ${kernel.stops}/${kernel.starts}`);
    const idle = { _r: false, stops: 0, starts: 0, get running() { return this._r; }, stop() { this.stops++; }, start() { this.starts++; return true; } };
    await world.approach({ kernel: idle, host: {} }, 0x5001, 500);
    check("approach: a stopped/held kernel is left alone", idle.stops === 0 && idle.starts === 0);

    // Portal-space gate (move fork's rynth/portal_gate.js, 2026-10-12): no
    // walking action starts — and approach() issues no final hop — in the
    // teleport tunnel. host.IsPortalSpaceActive is the gate's first source.
    const calls = [];
    const host = {
      IsPortalSpaceActive: () => true,
      NearbyGuids: () => [0x5001],
      TryGetObjectName: (g) => (g === 0x5001 ? "Exit Portal" : null),
      TryGetObjectPosition: () => ({ objCellId: 0xa9b40014, x: 10, y: 10, z: 0 }),
      TryGetPlayerPose: () => ({ objCellId: 0xa9b40014, x: 40, y: 40, z: 0 }),
      MoveToPosition: (...a) => { calls.push(["moveTo", ...a]); return true; },
      UseObject: (g) => { calls.push(["use", g]); return true; },
      TakeObject: (g) => { calls.push(["take", g]); return true; },
    };
    const byType = Object.fromEntries(world.worldActions().map((d) => [d.type, d]));
    const g1 = await byType.goto_object.apply({ host }, { type: "goto_object", object: "0x5001" }, { journal: makeJournal() });
    check("portal: goto_object refused, no movement", g1.ok === false && /in portal space/.test(g1.error) && calls.length === 0, JSON.stringify(g1));
    const u1 = await byType.use_object.apply({ host }, { type: "use_object", object: "Exit Portal" }, { journal: makeJournal() });
    check("portal: use_object refused, nothing used", u1.ok === false && /in portal space/.test(u1.error) && calls.length === 0, JSON.stringify(u1));
    const ptag = await world.approach({ host }, 0x5001, 500);
    check("portal: approach() returns portal-space without a final hop", ptag === "portal-space" && calls.length === 0, `${ptag} ${JSON.stringify(calls)}`);
    host.IsPortalSpaceActive = () => false;
    const g2 = await byType.goto_object.apply({ host }, { type: "goto_object", object: "0x5001" }, { journal: makeJournal() });
    check("portal: out of the tunnel goto_object walks again", calls.some((c) => c[0] === "moveTo"), JSON.stringify(calls));
    void g2;
  }

  // ── 9. wbt file_ticket: character name from the player guid ────────────
  {
    const wbt = await imp("rynth", "ai", "tools", "wbt.js");
    let filed = null;
    const oracle = { async fileTicket(t) { filed = t; return { ok: true, id: "T-1" }; } };
    const def = wbt.wbtActions(oracle, { query: false })[0];
    const host = { GetPlayerId: () => 0x50000001, TryGetObjectName: (g) => (g === 0x50000001 ? "Surveyor" : null), TryGetPlayerPose: () => null };
    const r = await def.apply({ host }, { type: "file_ticket", title: "door leads nowhere", body: "used it, nothing", severity: "low" }, { journal: makeJournal() });
    check("file_ticket: ok", r.ok === true, JSON.stringify(r));
    check("file_ticket: carries the character name", filed && filed.character === "Surveyor", JSON.stringify(filed));
  }

  // ── 10. wipeForCleanTest: RAM survivors + bot latch warning ────────────
  {
    const store = makeStore({ [os.BOT_STOP_KEY]: "1" });
    const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
    try {
      const mem = await imp("rynth", "ai", "tools", "memory.js");
      const interactions = new Map([[1, { name: "Door", noEffect: 3 }]]);
      const state = { _heardChat: [{ t: 1, text: "hi" }], _lastSnapshot: { pose: null }, _killSamples: [{ t: 1, kills: 2 }] };
      const out = mem.wipeForCleanTest({ extensions: { state, interactions: { entries: () => interactions } } });
      check("wipe: heard ring / deltas baseline / kill samples cleared",
        !("_heardChat" in state) && !("_lastSnapshot" in state) && !("_killSamples" in state), JSON.stringify(out.cleared));
      check("wipe: interaction memory cleared", interactions.size === 0);
      check("wipe: warns about the bot-wide latch", out.warnings.some((w) => w.includes(os.BOT_STOP_KEY)), JSON.stringify(out.warnings));
      check("wipe: never clears the bot latch", store.getItem(os.BOT_STOP_KEY) === "1");
    } finally {
      if (prev) Object.defineProperty(globalThis, "localStorage", prev);
      else delete globalThis.localStorage;
    }
  }

  // ── review #4: the bot-stop latch is per character (shared storage) ─────
  {
    const A = 0x50000011, B = 0x50000012;
    const s = makeStore();
    const botA = makeBot(), botB = makeBot();
    botA.host.GetPlayerId = () => A;
    botB.host.GetPlayerId = () => B;
    const ca = os.getOperatorControl(botA, { storage: s, ...quiet });
    const cb = os.getOperatorControl(botB, { storage: s, ...quiet });
    ca.stop({ reason: "hud A" });
    check("scope: A stopped, latch keyed by A", ca.isStopped() === true && s.getItem(os.botStopKey(A)) === "1");
    check("scope: B NOT stopped by A's STOP", cb.isStopped() === false && cb.state().latched.bot === false);
    check("scope: B's director not operator-held", botB.ai.director.status.operatorHeld === false);
    check("scope: no bare key written", s.getItem(os.BOT_STOP_KEY) === null);
    check("scope: state().scope", ca.state().scope === A && cb.state().scope === B);
    ca.resume();
    check("scope: resume clears A's key", s.getItem(os.botStopKey(A)) === null);
    // A control created for B while A's latch is set must not enforce it on B.
    ca.stop({ reason: "again" });
    const botB2 = makeBot();
    botB2.host.GetPlayerId = () => B;
    const cb2 = os.getOperatorControl(botB2, { storage: s, ...quiet });
    check("scope: boot enforcement ignores another character's latch", cb2.isStopped() === false && botB2.kernel.running === true);
    for (const b of [botA, botB, botB2]) b.ai.director.dispose();
  }

  // ── review #1: STOP while a mover had the kernel paused ─────────────────
  {
    const s = makeStore();
    const bot = makeBot();
    bot.kernelEnabled = true;
    let claimed = false;
    bot.movementClaimed = () => claimed;
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    // goto/route/approach: pause the running kernel for the walk, claim the body.
    bot.kernel.stop();
    claimed = true;
    ctl.stop({ reason: "mid-goto" });
    claimed = false; // router.cancel ended the walk
    check("mover: its kernel restore is refused under the hold", bot.kernel.start() === false);
    ctl.resume();
    check("mover: resume() restarts the kernel the mover had paused", bot.kernel.running === true);
    bot.ai.director.dispose();
  }
  {
    // The AI's `pause` action (plain kernel.stop(), no mover claim) stays paused.
    const s = makeStore();
    const bot = makeBot();
    bot.kernelEnabled = true;
    bot.movementClaimed = () => false;
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    bot.kernel.stop(); // AI pause
    ctl.stop({ reason: "hud" });
    ctl.resume();
    check("AI-paused kernel (no mover claim) stays off after resume", bot.kernel.running === false);
    bot.ai.director.dispose();
  }
  {
    // A kernel-off bot (explorer) never starts its kernel, claim or not.
    const s = makeStore();
    const bot = makeBot({ kernelRunning: false });
    bot.kernelEnabled = false;
    bot.movementClaimed = () => true;
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    ctl.stop({ reason: "hud" });
    ctl.resume();
    check("kernel-off bot stays off after stop/resume", bot.kernel.running === false);
    bot.ai.director.dispose();
  }

  // ── 12. review-2: approach claim (#3), AI pause (#4), pending persist
  //        (#5), one status read through the control (#8) ──────────────────
  {
    // #3 — STOP during an AI approach() walk, then RESUME: the grind kernel
    // the approach had paused restarts (the approach's claim told the control).
    const world = await imp("rynth", "ai", "tools", "world.js");
    const bot = makeBot();
    const claims = new Set();
    bot.kernelEnabled = true;
    bot.claimMovement = (tag) => { const t = { tag }; claims.add(t); return () => { claims.delete(t); }; };
    bot.movementClaimed = () => claims.size > 0;
    bot.router.status = { state: "IDLE" };
    bot.host.TryGetObjectPosition = () => ({ objCellId: 0xa9b40014, x: 10, y: 10, z: 0 });
    bot.host.TryGetPlayerPose = () => ({ objCellId: 0xa9b40014, x: 40, y: 40, z: 0 });
    bot.host.MoveToPosition = () => true;
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    const walk = world.approach(bot, 0x5001, 1500);
    await new Promise((r) => setTimeout(r, 200));
    check("#3 approach claims the body and pauses the kernel", claims.size === 1 && bot.kernel.running === false, `claims=${claims.size}`);
    ctl.stop({ reason: "hud" });
    const tag = await walk;
    check("#3 claim released when the walk ends; its kernel restore is refused under the hold",
      claims.size === 0 && bot.kernel.running === false, `${tag} claims=${claims.size}`);
    ctl.resume();
    check("#3 RESUME restarts the grind the approach had paused", bot.kernel.running === true);
    bot.ai.director.dispose();
  }
  {
    // #4 — an AI-paused kernel stays off across STOP/RESUME, even while a
    // mover (a goto planned after the pause) holds a claim.
    const A = await imp("rynth", "ai", "actions.js");
    const bot = makeBot();
    bot.kernelEnabled = true;
    bot.movementClaimed = () => true;
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    const r = await A.executeAction(bot, { type: "pause" });
    check("#4 the AI pause action records pausedBy=ai", r.ok === true && bot.kernel.pausedBy === "ai" && bot.kernel.running === false, JSON.stringify(r));
    check("#4 state() reports pausedBy", ctl.state().kernel.pausedBy === "ai");
    ctl.stop({ reason: "hud" });
    ctl.resume();
    check("#4 STOP/RESUME leaves the AI-paused kernel off", bot.kernel.running === false && bot.kernel.pausedBy === "ai");
    const r2 = await A.executeAction(bot, { type: "resume" });
    check("#4 the AI's own resume runs it and clears pausedBy", r2.ok === true && bot.kernel.running === true && bot.kernel.pausedBy === null, JSON.stringify(r2));
    bot.ai.director.dispose();
  }
  {
    // #5 — STOP before the character's guid is readable: no key at all (never
    // the bare origin-wide latch); written under the scoped key once known.
    const s = makeStore();
    const bot = makeBot({ guid: 0 });
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    const st = ctl.stop({ reason: "hud" });
    check("#5 STOP with no guid writes NO key (no bare latch)", s._map.size === 0 && st.persistPending === true && st.stopped === true,
      JSON.stringify([...s._map.keys()]));
    check("#5 the stop holds in memory meanwhile", ctl.isStopped() === true && bot.kernel.operatorHeld === true);
    bot.host.guid = ME;
    for (const t of bot._ticks) t(); // the host tick flushes it (no UI polling)
    check("#5 the host tick persists it under THIS character's key", s.getItem(KEY) === "1" && s.getItem(os.BOT_STOP_KEY) === null && ctl.state().persistPending === false,
      JSON.stringify([...s._map.keys()]));
    const cfg = {};
    os.applyOperatorStopToCfg(cfg, s, ME);
    check("#5 a reboot of this character then boots held", cfg.startHeld === true);
    ctl.resume();
    check("#5 resume clears it", s.getItem(KEY) === null);
    bot.ai.director.dispose();
  }
  {
    // #5 — state() flushes too.
    const s = makeStore();
    const bot = makeBot({ guid: 0, withDirector: false });
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    ctl.stop({ reason: "hud" });
    bot.host.guid = ME;
    const st = ctl.state();
    check("#5 state() persists a pending stop once the guid resolves", s.getItem(KEY) === "1" && st.persistPending === false && st.latched.bot === true);
  }
  {
    // #5 — a LEGACY bare latch: an unresolved (or resolved) control never
    // reads it as its own stop; resume() of a bot booted held by it clears it.
    const s = makeStore({ [os.BOT_STOP_KEY]: "1" });
    const bot = makeBot({ guid: 0 });
    const ctl = os.getOperatorControl(bot, { storage: s, ...quiet });
    check("#5 an unresolved control does not self-stop on a bare key", ctl.isStopped() === false && bot.kernel.running === true);
    check("#5 director gate ignores the bare key too", os.isBotOperatorStopped(bot, s) === false);
    bot.host.guid = ME;
    check("#5 a resolved control reads only its own key", ctl.isStopped() === false);
    bot.kernel.holdForOperator(); // boot.js honoured the legacy key: booted held
    ctl.resume();
    check("#5 resume clears the legacy bare latch", s.getItem(os.BOT_STOP_KEY) === null && bot.kernel.running === true);
    bot.ai.director.dispose();
  }
  {
    // #8 — state().kernel carries the SAME kernel.status read's buffs/vitals.
    const bot = makeBot({ withDirector: false });
    let bReads = 0, vReads = 0;
    bot.kernel.buff = { enabled: true, get status() { bReads++; return { desired: 2, active: 1 }; } };
    bot.kernel.vitals = { enabled: true, get status() { vReads++; return { blocked: null }; } };
    const ctl = os.getOperatorControl(bot, { storage: makeStore(), ...quiet });
    bReads = 0; vReads = 0;
    const st = ctl.state();
    check("#8 state().kernel.buffs / vitals passthrough", st.kernel.buffs?.desired === 2 && st.kernel.vitals?.blocked === null, JSON.stringify(st.kernel));
    check("#8 exactly one buff.status and one vitals.status per state()", bReads === 1 && vReads === 1, `${bReads}/${vReads}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
