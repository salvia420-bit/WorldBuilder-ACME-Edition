#!/usr/bin/env node
// rynth_explorer_survival_test.cjs — WP-4 explorer survival wiring
// (C5-2 + C5-3 / FM-2 + FM-3):
//   1. an explorer bot boots with combat hunting OFF and looting OFF so it
//      never picks a fight it can't win nor diverts to a corpse while
//      surveying (bot.js: persona -> combat.enabled=false + loot enabled=false);
//   2. RynthLootLoop with enabled===false issues ZERO MoveToPosition in ANY
//      state (loot_loop.js tick()/-findCorpse() gate);
//   3. the grind persona (the default) is UNCHANGED — both loops stay on.
//
// Two tiers:
//   LU* — RynthLootLoop unit tests, direct import (loot_loop.js has no
//         relative imports), fake host records MoveToPosition calls.
//   BW* — createGrindBot integration: rynth/ staged flat to a type:module
//         tmpdir + a FakeWorker heartbeat drive the real RynthWebHost, exactly
//         as rynth_navsim_test.cjs does. Staging flat means wireAiDirector's
//         ai/*.js imports fail and are swallowed by bot.js's own AI-wiring
//         try/catch (the documented survival invariant) — so the explorer bot
//         still boots with the combat/loot flags (set BEFORE AI wiring) intact,
//         with no network or director-timer risk.
//
// Run: node rynth_explorer_survival_test.cjs   (exits 1 on any FAIL)
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

// ── LU* : RynthLootLoop unit host — only what SCAN/APPROACH touch ──────────
// me at (0,0); a single corpse (wcid 21) in the SAME landblock 10m away —
// beyond REACH_M (4) but within the 30m scan radius, so an ENABLED loop issues
// exactly one MoveToPosition and enters APPROACH.
const CORPSE_GUID = 0xc0ffee;
function lootHost() {
  const moves = [];
  const me = { objCellId: 0x00010001, x: 0, y: 0, z: 0 };
  const corpsePos = { objCellId: 0x00010001, x: 10, y: 0, z: 0 };
  return {
    moves,
    IsPlayerReady: () => true,
    TryGetPlayerPose: () => me,
    NearbyGuids: () => [CORPSE_GUID],
    TryGetObjectWcid: (g) => (g === CORPSE_GUID ? 21 : 0),
    TryGetObjectPosition: (g) => (g === CORPSE_GUID ? corpsePos : null),
    MoveToPosition: (lb, x, y, z) => moves.push([lb >>> 0, x, y, z]),
    StopCompletely: () => {},
    UseObject: () => {},
    GetGroundContainerId: () => 0,
    GetContainerContents: () => [],
    GetBusyState: () => 0,
    GetPlayerId: () => 0x50000001,
  };
}

// ── BW* : minimal static SessionHandle (RynthWebHost interface) ────────────
function fakeSession() {
  return {
    isPlayerReady: () => true,
    getLocalPlayerPose: () => ({ landblockId: 0x00010001, x: 10, y: 10, z: 0, heading: 0 }),
    moveToPosition: () => {},
    cancelPursuit: () => {},
    pursuitStatus: () => 0,
    sendChat: () => {},
    nearbyEntityGuids: () => [],
  };
}

// FakeWorker: the webhost heartbeat rides this under node (mirrors navsim).
class FakeWorker {
  constructor() { this._t = null; this.onmessage = null; }
  postMessage(m) {
    clearInterval(this._t);
    if (m && m.cmd === "start") this._t = setInterval(() => this.onmessage && this.onmessage({ data: 1 }), m.ms);
  }
  terminate() { clearInterval(this._t); }
}
globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:explorer-survival";

(async () => {
  const { RynthLootLoop } = await import(pathToFileURL(path.join(__dirname, "rynth/loot_loop.js")).href);
  const quiet = () => {};

  // ════ LU* — loot-loop enabled gate ════

  // LU1: enabled===false issues ZERO MoveToPosition from SCAN, and
  // _findCorpse() returns null (so kernel _corpseAvailable() stays false).
  {
    const h = lootHost();
    const loop = new RynthLootLoop(h, { enabled: false, log: quiet });
    check("LU1 enabled:false default flag is false", loop.enabled === false);
    check("LU1 _findCorpse() is null when disabled", loop._findCorpse() === null);
    loop.tick(); // SCAN
    check("LU1 zero MoveToPosition when disabled (SCAN)", h.moves.length === 0, `moves=${h.moves.length}`);
    check("LU1 stayed in SCAN (no transition)", loop.state === "SCAN", loop.state);
  }

  // LU2 (control): the DEFAULT (enabled) loop DOES approach the same corpse —
  // proves the gate, not the fixture, is what suppresses movement above.
  {
    const h = lootHost();
    const loop = new RynthLootLoop(h, { log: quiet }); // no opts.enabled
    check("LU2 default enabled flag is true", loop.enabled === true);
    check("LU2 _findCorpse() finds the corpse when enabled", loop._findCorpse()?.guid === CORPSE_GUID);
    loop.tick(); // SCAN -> issue MoveToPosition -> APPROACH
    check("LU2 one MoveToPosition when enabled", h.moves.length === 1, `moves=${h.moves.length}`);
    check("LU2 transitioned to APPROACH", loop.state === "APPROACH", loop.state);
  }

  // LU3: the tick() gate covers ALL states, not just SCAN — a disabled loop
  // parked mid-transaction in APPROACH still issues no MoveToPosition (the
  // APPROACH re-issue watchdog would otherwise fire).
  {
    const h = lootHost();
    const loop = new RynthLootLoop(h, { enabled: false, log: quiet });
    loop.corpse = CORPSE_GUID;
    loop._setState("APPROACH");
    for (let i = 0; i < 3; i++) loop.tick();
    check("LU3 zero MoveToPosition when disabled (APPROACH x3)", h.moves.length === 0, `moves=${h.moves.length}`);
  }

  // LU4: flag polarity — explicit enabled:true stays on; absent -> on;
  // enabled:false -> off. (`!== false` default.)
  {
    const h = lootHost();
    check("LU4 enabled:true -> true", new RynthLootLoop(h, { enabled: true, log: quiet }).enabled === true);
    check("LU4 absent -> true (grind default)", new RynthLootLoop(h, { log: quiet }).enabled === true);
    check("LU4 enabled:false -> false", new RynthLootLoop(h, { enabled: false, log: quiet }).enabled === false);
  }

  // ════ BW* — createGrindBot persona wiring ════
  const srcDir = path.join(__dirname, "rynth");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-explorer-"));
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(srcDir, f), path.join(tmpDir, f));
    }
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
    const BOT = await import(pathToFileURL(path.join(tmpDir, "bot.js")).href);

    // BW1: explorer persona -> combat hunting OFF + looting OFF at boot.
    {
      const bot = await BOT.createGrindBot(fakeSession(), {
        hz: 60, control: false, vitals: false, loot: {}, ai: { persona: "explorer" },
      });
      try {
        check("BW1 explorer: bot.kernel.combat.enabled === false", bot.kernel.combat.enabled === false);
        check("BW1 explorer: bot.loot.enabled === false", bot.loot && bot.loot.enabled === false);
      } finally { bot.stop(); }
    }

    // BW2: grind persona (default, ai off) — both loops UNCHANGED (on).
    {
      const bot = await BOT.createGrindBot(fakeSession(), {
        hz: 60, control: false, vitals: false, loot: {}, ai: false,
      });
      try {
        check("BW2 grind: bot.kernel.combat.enabled === true (unchanged)", bot.kernel.combat.enabled === true);
        check("BW2 grind: bot.loot.enabled === true (unchanged)", bot.loot && bot.loot.enabled === true);
      } finally { bot.stop(); }
    }

    // BW3: an explicit config.loot.enabled wins over the persona default
    // (director/operator override) — explorer + loot:{enabled:true} keeps loot on.
    {
      const bot = await BOT.createGrindBot(fakeSession(), {
        hz: 60, control: false, vitals: false, loot: { enabled: true }, ai: { persona: "explorer" },
      });
      try {
        check("BW3 explorer + explicit loot.enabled:true -> loot stays on", bot.loot && bot.loot.enabled === true);
        check("BW3 explorer still forces combat OFF", bot.kernel.combat.enabled === false);
      } finally { bot.stop(); }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nexplorer-survival: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
