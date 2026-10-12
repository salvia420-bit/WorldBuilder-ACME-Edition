#!/usr/bin/env node
// rynth_bot_wiring_test.cjs — createGrindBot's operator-control and buff wiring
// (2026-10-12 RynthSuite update):
//   BC* bot.control — the ONE stop/resume/state authority (ai/operator_stop.js)
//       is attached by createGrindBot; config.startHeld (a persisted HUD/!bot
//       STOP, set by applyOperatorStopToCfg) boots the kernel under the
//       operator hold and resume() releases it.
//   BD* bot.stop() tears the AI layer down with the bot: the director of a
//       stopped/replaced bot (the ?bot=1 takeover rebind) is disposed and can
//       never restart on the dead session (double LLM spend).
//   BH* a boot-held bot keeps its director off (deferredAutoStart) until resume.
//   BB* bot.setBuffs(ids | "auto" | []) creates/replaces the buff loop at
//       runtime and hands it to the kernel.
//
// rynth/ is staged WITH ai/ into a type:module tmpdir (the flat staging other
// tests use drops ai/, which hides bot.control). A Map-backed localStorage and a
// FakeWorker heartbeat stand in for the page; the director gets a dummy key and
// autoStart:false/true, extensions/metrics/early check-ins off — it never
// reaches its first check-in, so there is no network.
//
// Run: node rynth_bot_wiring_test.cjs   (exits 1 on any FAIL)
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

class FakeWorker {
  constructor() { this._t = null; this.onmessage = null; }
  postMessage(m) {
    clearInterval(this._t);
    if (m && m.cmd === "start") this._t = setInterval(() => this.onmessage && this.onmessage({ data: 1 }), m.ms);
  }
  terminate() { clearInterval(this._t); }
}
globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:wiring";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
  clear: () => store.clear(),
};

// Strength Self I (2) and VII (2087) are the same ladder family (category 1).
const KNOWN = [2, 1328, 2087];
const ME = 0x50000001; // fakeSession()'s character — the bot-stop latch scope
function fakeSession(guid = ME) {
  return {
    isPlayerReady: () => true,
    playerGuid: () => guid,
    getLocalPlayerPose: () => ({ landblockId: 0x00010001, x: 10, y: 10, z: 0, heading: 0 }),
    moveToPosition: () => {},
    cancelPursuit: () => {},
    stopStick: () => {},
    pursuitStatus: () => 0,
    sendChat: () => {},
    nearbyEntityGuids: () => [],
    playerKnownSpells: () => KNOWN.slice(),
  };
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === "testdata" || ent.name === "__pycache__") continue;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (/\.(js|json)$/.test(ent.name)) fs.copyFileSync(s, d);
  }
}

const AI_QUIET = { apiKey: "test-key-not-used", extensions: false, metrics: false, earlyCheckins: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-wiring-"));
  // Silence the bot's own [kernel]/[buff]/[rynth] console chatter.
  const realLog = console.log;
  const quietLog = (...a) => { if (typeof a[0] === "string" && /^(PASS|FAIL|\nbot-wiring)/.test(a[0])) realLog(...a); };
  try {
    copyTree(path.join(__dirname, "rynth"), path.join(tmp, "rynth"));
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
    const BOT = await import(pathToFileURL(path.join(tmp, "rynth", "bot.js")).href);
    const OS = await import(pathToFileURL(path.join(tmp, "rynth", "ai", "operator_stop.js")).href);
    console.log = quietLog;

    // BC1: a plain grind bot gets bot.control, running.
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      try {
        check("BC1 bot.control attached", !!bot.control && typeof bot.control.state === "function");
        check("BC1 getOperatorControl(bot) returns the same object", OS.getOperatorControl(bot) === bot.control);
        const st = bot.control.state();
        check("BC1 not stopped at boot", st.stopped === false, JSON.stringify(st.latched));
        check("BC1 kernel running at boot", bot.kernel.running === true);
        // stop() → hold + latch; resume() → running + latch cleared.
        bot.control.stop({ reason: "test" });
        check("BC1 stop(): kernel held", bot.kernel.operatorHeld === true && bot.kernel.running !== true);
        check("BC1 stop(): bot latch persisted for THIS character", OS.isBotStopLatched(undefined, ME) === true);
        check("BC1 stop(): no origin-wide (bare) latch written", OS.isBotStopLatched() === false);
        check("BC1 state().scope is the character guid", bot.control.state().scope === ME);
        bot.control.resume();
        check("BC1 resume(): kernel running again", bot.kernel.running === true && bot.kernel.operatorHeld !== true);
        check("BC1 resume(): latch cleared", OS.isBotStopLatched(undefined, ME) === false);
      } finally { bot.stop(); }
    }

    // BC2: config.startHeld (what applyOperatorStopToCfg sets from a persisted
    // latch) boots held; resume() starts the kernel it never ran.
    {
      store.clear();
      OS.latchBotStop(undefined, ME);
      const cfg = { hz: 60, control: false, vitals: false, loot: false, ai: false };
      const suppressed = OS.applyOperatorStopToCfg(cfg, undefined, ME); // mutates cfg; returns "AI suppressed"
      check("BC2 applyOperatorStopToCfg sets startHeld from the bot latch", cfg.startHeld === true);
      check("BC2 the bot latch alone does not suppress the AI", suppressed === false);
      const bot = await BOT.createGrindBot(fakeSession(), cfg);
      try {
        check("BC2 boot-held: kernel operatorHeld", bot.kernel.operatorHeld === true);
        check("BC2 boot-held: kernel not running", bot.kernel.running !== true);
        check("BC2 boot-held: control reports stopped", bot.control.isStopped() === true);
        check("BC2 bot.startHeld flag", bot.startHeld === true);
        bot.control.resume();
        check("BC2 resume(): kernel starts", bot.kernel.running === true);
        check("BC2 resume(): latch cleared", OS.isBotStopLatched(undefined, ME) === false);
      } finally { bot.stop(); }
    }

    // BD1: bot.stop() disposes the director; a disposed director never restarts.
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), {
        hz: 60, control: false, vitals: false, loot: false, ai: { ...AI_QUIET, autoStart: false },
      });
      const d = bot.ai && bot.ai.director;
      check("BD1 director constructed", !!d);
      bot.stop();
      check("BD1 bot.stop() disposed the director", !!d && (d.status?.disposed === true || d._disposed === true));
      try { d && d.start(); } catch (_) { /* a disposed start may throw or no-op */ }
      check("BD1 a disposed director stays off after start()", !!d && d.enabled !== true);
    }

    // BH1: boot-held + autoStart → director deferred, started by resume().
    {
      store.clear();
      OS.latchBotStop(undefined, ME);
      const cfg = { hz: 60, control: false, vitals: false, loot: false, ai: { ...AI_QUIET, autoStart: true, intervalMinutes: 60 } };
      OS.applyOperatorStopToCfg(cfg, undefined, ME);
      const bot = await BOT.createGrindBot(fakeSession(), cfg);
      try {
        const d = bot.ai && bot.ai.director;
        check("BH1 director exists", !!d);
        check("BH1 boot-held: director NOT started", !!d && d.enabled !== true);
        check("BH1 boot-held: deferredAutoStart set", bot.ai.deferredAutoStart === true);
        bot.control.resume();
        check("BH1 resume(): director started", !!d && d.enabled === true);
        check("BH1 resume(): deferredAutoStart cleared", bot.ai.deferredAutoStart === false);
      } finally { bot.stop(); }
    }

    // BB1: setBuffs creates the loop on demand and hands it to the kernel.
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      try {
        check("BB1 no buff loop without config.buffs", bot.buff === null);
        const list = await bot.setBuffs([2]);
        check("BB1 setBuffs([2]) -> loop created", !!bot.buff, JSON.stringify(list));
        check("BB1 kernel got the same loop", bot.kernel.buff === bot.buff);
        check("BB1 desired keeps the family id", Array.isArray(list) && list.includes(2), JSON.stringify(list));
        check("BB1 startedAt stamped", bot.buff.startedAt > 0);
        const loop = bot.buff;
        const none = await bot.setBuffs([]);
        check("BB1 setBuffs([]) empties the desired set on the SAME loop", bot.buff === loop && none.length === 0 && bot.buff.desired.length === 0);
        const auto = await bot.setBuffs("auto");
        check("BB1 setBuffs('auto') resolves to an array", Array.isArray(auto), typeof auto);
        // Unknown family: a spell neither in the book nor in a known family is dropped.
        const unk = await bot.setBuffs([24]); // category 115 — not in KNOWN's families
        check("BB1 an uncastable family is filtered out", Array.isArray(unk) && !unk.includes(24), JSON.stringify(unk));
      } finally { bot.stop(); }
    }

    // BB2: config.buffs list at boot uses the family-aware filter (VII known, I asked).
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false, buffs: [2, 24] });
      try {
        check("BB2 buff loop created from config.buffs", !!bot.buff);
        check("BB2 family id kept, uncastable dropped", !!bot.buff && bot.buff.rawDesired.includes(2) && !bot.buff.rawDesired.includes(24), JSON.stringify(bot.buff && bot.buff.rawDesired));
      } finally { bot.stop(); }
    }

    // BS1 (review #4): the bot-stop latch is per character — a STOP in one
    // bot tab must not stop another character's bot (shared localStorage).
    {
      store.clear();
      const OTHER = 0x50000002;
      const a = await BOT.createGrindBot(fakeSession(ME), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      const b = await BOT.createGrindBot(fakeSession(OTHER), { hz: 60, control: false, vitals: false, loot: false, ai: { ...AI_QUIET, autoStart: false } });
      try {
        a.control.stop({ reason: "test" });
        check("BS1 stopped bot reads stopped", a.control.isStopped() === true);
        check("BS1 the other character's bot is NOT stopped", b.control.isStopped() === false, JSON.stringify(b.control.state().latched));
        check("BS1 the other bot's kernel keeps running", b.kernel.running === true);
        check("BS1 the other bot's director is not operator-held", !!b.ai && b.ai.director.status.operatorHeld === false);
        check("BS1 latch key is per character", store.has(`${OS.BOT_STOP_KEY}:${ME}`) && !store.has(`${OS.BOT_STOP_KEY}:${OTHER}`) && !store.has(OS.BOT_STOP_KEY), JSON.stringify([...store.keys()]));
        a.control.resume();
        check("BS1 resume clears only that character's key", !store.has(`${OS.BOT_STOP_KEY}:${ME}`));
      } finally { a.stop(); b.stop(); }
    }

    // BS2: boot-held is per character too.
    {
      store.clear();
      OS.latchBotStop(undefined, ME);
      const cfgOther = { hz: 60, control: false, vitals: false, loot: false, ai: false };
      OS.applyOperatorStopToCfg(cfgOther, undefined, 0x50000002);
      check("BS2 another character's latch does not set startHeld", cfgOther.startHeld !== true);
      const other = await BOT.createGrindBot(fakeSession(0x50000002), cfgOther);
      try {
        check("BS2 the other character boots running", other.kernel.running === true && other.control.isStopped() === false);
      } finally { other.stop(); }
      // A boot path that does not pass the scope yet (cfg without startHeld)
      // is still caught by getOperatorControl's per-character enforcement.
      const mine = await BOT.createGrindBot(fakeSession(ME), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      try {
        check("BS2 own character: enforcement holds an unscoped boot", mine.kernel.operatorHeld === true && mine.control.isStopped() === true);
        mine.control.resume();
        check("BS2 own character: resume runs it", mine.kernel.running === true);
      } finally { mine.stop(); }
    }

    // BM1 (review #1): STOP pressed while a mover had paused the kernel for
    // its walk — resume() must start the kernel again.
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      try {
        check("BM1 kernelEnabled exposed", bot.kernelEnabled === true);
        // A mover (goto / route / AI approach / unwedge) pauses the kernel and
        // claims the body; it will restart the kernel when its walk ends.
        const wasRunning = bot.kernel.running === true;
        bot.kernel.stop();
        const release = bot.claimMovement("test-goto");
        check("BM1 the claim shows in movementClaimed()", bot.movementClaimed() === true);
        bot.control.stop({ reason: "mid-goto" });
        // The walk ends (router.cancel) — its restore is refused by the hold.
        release();
        const restored = wasRunning ? bot.kernel.start() : null;
        check("BM1 the mover's restore is refused under the hold", restored === false && bot.kernel.running !== true);
        bot.control.resume();
        check("BM1 resume() starts the kernel the mover had paused", bot.kernel.running === true);
        check("BM1 the claim was released", bot.movementClaimed() === false);
      } finally { bot.stop(); }
    }

    // BM2: a kernel-off bot (explorer / ?botKernel=off) stays off across stop/resume.
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false, kernel: false });
      try {
        check("BM2 kernelEnabled false", bot.kernelEnabled === false);
        const release = bot.claimMovement("explorer-walk");
        bot.control.stop({ reason: "test" });
        release();
        bot.control.resume();
        check("BM2 resume() leaves a kernel-off bot off", bot.kernel.running !== true);
      } finally { bot.stop(); }
    }

    // BB3 (review #10): concurrent setBuffs calls build ONE buff loop.
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      try {
        let firstLoop = null;
        const p1 = bot.setBuffs([2]).then((r) => { firstLoop = bot.buff; return r; });
        const p2 = bot.setBuffs([2087]);
        const [r1, r2] = await Promise.all([p1, p2]);
        check("BB3 first call created the loop", !!firstLoop && Array.isArray(r1) && r1.includes(2), JSON.stringify(r1));
        check("BB3 second call reused the SAME loop (no orphan loop)", bot.buff === firstLoop && bot.kernel.buff === firstLoop);
        check("BB3 the last call's list wins", Array.isArray(r2) && r2.includes(2087) && bot.buff.desired.includes(2087), JSON.stringify(r2));
        // A rejecting call doesn't poison the chain.
        let threw = false;
        await bot.setBuffs({ notIterable: true }).catch(() => { threw = true; });
        const r3 = await bot.setBuffs([2]);
        check("BB3 the chain survives a failed call", Array.isArray(r3), `threw=${threw}`);
      } finally { bot.stop(); }
    }
    // BB4 (review-2 #9): bot.buffSpec records the operator's SPEC ("auto"
    // stays "auto") — what a takeover rebind carries (boot.js).
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false, buffs: "auto" });
      try {
        check("BB4 boot with buffs:'auto' -> buffSpec 'auto'", bot.buffSpec === "auto", JSON.stringify(bot.buffSpec));
        await bot.setBuffs([2, 24]);
        check("BB4 setBuffs(list) -> buffSpec is that list", JSON.stringify(bot.buffSpec) === "[2,24]", JSON.stringify(bot.buffSpec));
        await bot.setBuffs("auto");
        check("BB4 setBuffs('auto') -> buffSpec back to 'auto'", bot.buffSpec === "auto");
        await bot.setBuffs([]);
        check("BB4 setBuffs([]) -> buffSpec [] (buffing off)", Array.isArray(bot.buffSpec) && bot.buffSpec.length === 0);
      } finally { bot.stop(); }
    }
    {
      store.clear();
      const bot = await BOT.createGrindBot(fakeSession(), { hz: 60, control: false, vitals: false, loot: false, ai: false });
      try {
        check("BB4 no config.buffs -> buffSpec null", bot.buffSpec === null);
      } finally { bot.stop(); }
    }
    await wait(20);
  } finally {
    console.log = realLog;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nbot-wiring: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log = console.log || (() => {});
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
