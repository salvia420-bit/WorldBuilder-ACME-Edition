#!/usr/bin/env node
// rynth_cruise_yield_test.cjs — last-command-wins integration for the
// frontier CRUISE (movement-utilization fix, 2026-07-23): a director route
// (bot.followRoute) must CANCEL an in-flight pressure cruise (a raw
// bot.travel router walk flagged via explorePressure.cruising()) and proceed
// — the same treatment doGoto/doEgress already give a raw travel() — while a
// NON-cruise raw travel keeps today's refusal ("goto active").
//
// Real modules end-to-end: createGrindBot (bot.js) + RynthWebHost + RynthRouter
// over a fake SessionHandle, rynth/ staged recursively to a type:module tmpdir
// with a FakeWorker heartbeat — the exact harness rynth_navsim_test.cjs /
// rynth_explorer_survival_test.cjs use. config.ai:false (no director/network);
// config.explorePressure:true wires the REAL ExplorePressureController so
// bot.explorePressure.cruising() is the live seam doFollowRoute consults.
//
// Run: node rynth_cruise_yield_test.cjs   (exits 1 on any FAIL)
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

// Minimal live-ish SessionHandle: pose is mutable so a leg can "arrive".
function fakeSession() {
  const s = {
    pose: { landblockId: 0x00010001, x: 10, y: 10, z: 0, heading: 0 },
    moves: [],
    isPlayerReady: () => true,
    getLocalPlayerPose: () => ({ ...s.pose }),
    moveToPosition: (lb, x, y, z) => { s.moves.push([lb >>> 0, x, y, z]); },
    cancelPursuit: () => {},
    pursuitStatus: () => 0,
    sendChat: () => {},
    nearbyEntityGuids: () => [],
  };
  return s;
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
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:cruise-yield";

(async () => {
  // Stage rynth/ recursively (bot.js dynamic-imports ai/* + goto_compose etc).
  const srcDir = path.join(__dirname, "rynth");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-cruise-yield-"));
  function copyTree(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (ent.name === "__pycache__") continue;
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      if (ent.isDirectory()) copyTree(s, d);
      else if (ent.name.endsWith(".js") || ent.name.endsWith(".json")) fs.copyFileSync(s, d);
    }
  }
  copyTree(srcDir, tmpDir);
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));

  let bot = null;
  try {
    const BOT = await import(pathToFileURL(path.join(tmpDir, "bot.js")).href);
    const session = fakeSession();
    bot = await BOT.createGrindBot(session, {
      control: false,
      ai: false,
      explorePressure: true,
      hz: 30,
      router: { log: () => {} },
      explorePressureLog: () => {},
    });
    check("boot: explorePressure controller wired", !!bot.explorePressure && typeof bot.explorePressure.cruising === "function");

    // ── A: a raw travel WITHOUT the cruise flag still refuses followRoute ──
    {
      const r = bot.travel([{ lb: 0x00010001, x: 150, y: 150, z: 0 }]); // far leg -> router WALK
      check("A: raw travel accepted", r && r.ok === true);
      await new Promise((res) => setTimeout(res, 120)); // let a heartbeat tick begin the leg
      check("A: router walking", bot.router.status.state === "WALK", bot.router.status.state);
      check("A: cruising() false for a non-cruise travel", bot.explorePressure.cruising() === false);
      const fr = await bot.followRoute([{ lb: 0x00010001, x: 10, y: 10, z: 0 }], { pollMs: 25 });
      check("A: followRoute REFUSED over a non-cruise raw travel (today's semantics)",
        fr && fr.ok === false && /goto active/.test(fr.error || ""), JSON.stringify(fr));
      bot.router.cancel(); // clean up for case B
    }

    // ── B: the SAME walk flagged as a cruise yields to followRoute ─────────
    {
      const r = bot.travel([{ lb: 0x00010001, x: 150, y: 150, z: 0 }]);
      check("B: cruise travel accepted", r && r.ok === true);
      await new Promise((res) => setTimeout(res, 120));
      check("B: router walking the cruise", bot.router.status.state === "WALK", bot.router.status.state);
      bot.explorePressure._cruiseActive = true; // what _frontierCruise stamps on issue
      // Destination = where the fake pose already stands -> arrives on the
      // first router tick after the takeover.
      const fr = await bot.followRoute([{ lb: 0x00010001, x: 10, y: 10, z: 0 }], { pollMs: 25 });
      check("B: followRoute CANCELS the cruise and completes (last command wins)",
        fr && fr.ok === true && fr.state === "DONE", JSON.stringify(fr));
      check("B: controller drops the cruise flag once the router was taken (IDLE/DONE observed)",
        bot.explorePressure.cruising() === false);
    }
  } catch (e) {
    check("integration ran without throwing", false, (e && e.stack) || String(e));
  } finally {
    try { bot?.stop(); } catch { /* teardown */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
