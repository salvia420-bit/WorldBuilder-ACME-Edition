// tests/rynth_meta_disable_release.test.mjs — RYNTH-1 (2026-10-18 review):
// a setmotion[] key is let go when the meta stops driving, not only on
// operator STOP / portal space / detach.
//
// The REAL createGrindBot + VT layer + expression runtime + MetaEngine over a
// fake session (the rynth_vt_meta_engine integration pattern). A meta presses
// forward; turning EnableMeta off (options.set, the panel's engine.enabled,
// `/vt meta disable`, a Return From Call on an empty stack), loading another
// meta or unloading it must send the all-zero SetMovementInput within one
// heartbeat, while the bot keeps RUNNING.
//
// Run from apps/holtburger-web/:  node tests/rynth_meta_disable_release.test.mjs

import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

class FakeWorker {
  constructor() {
    this.onmessage = null;
  }
  postMessage() {}
  terminate() {}
}
if (typeof globalThis.Worker !== "function") globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:vt-meta-release";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};

const { createGrindBot } = await import("../rynth/bot.js");

let ruleSeq = 0;
const R = (state, cond, act) => ({ id: `r${++ruleSeq}`, state, enabled: true, cond, act });
const expr = (e) => ({ t: "Expr", expr: e });
const doExpr = (e) => ({ t: "DoExpr", expr: e });
const meta = (name, rules) => ({ v: 1, name, source: { kind: "json" }, rules, navs: {}, warnings: [] });

// The meta under test: getvar[go] == 1 presses forward; getvar[ret] == 1 runs
// a Return From Call with an empty call stack (GUIDE:283: meta disabled).
const MOVER = meta("mover", [
  R("Default", expr("getvar[go] == 1"), doExpr("setmotion[forward, 1] && setvar[go, 0]")),
  R("Default", expr("getvar[ret] == 1"), { t: "Return" }),
]);
const OTHER = meta("other", [R("Default", { t: "Never" }, doExpr("1"))]);

async function withBot(fn) {
  const realNow = Date.now;
  const realLog = console.log;
  const realWarn = console.warn;
  let NOW = 1_760_000_000_000;
  Date.now = () => NOW;
  console.log = () => {};
  console.warn = () => {};
  let bot = null;
  try {
    const guid = 0x50000e02;
    const calls = [];
    const rec = (n) => (...a) => calls.push(`${n}(${a.join(",")})`);
    const session = {
      isPlayerReady: () => true,
      playerGuid: () => guid,
      getLocalPlayerPose: () => ({ landblockId: 0xa9b40015, x: 100, y: 100, z: 0, heading: 0, free() {} }),
      objectName: (g) => ((g >>> 0) === guid ? "Tester" : undefined),
      moveToPosition: rec("moveToPosition"),
      cancelPursuit: rec("cancelPursuit"),
      stopStick: rec("stopStick"),
      pursuitStatus: () => 0,
      sendChat: rec("sendChat"),
      sendTell: rec("sendTell"),
      nearbyEntityGuids: () => [],
      playerKnownSpells: () => [],
      setMovementInput: rec("setMovementInput"),
      turnToHeading: rec("turnToHeading"),
    };
    bot = await createGrindBot(session, { hz: 10, ai: false });
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) {
        NOW += 250;
        bot.host._tick();
      }
    };
    tick(10);
    const L = bot.vt;
    assert.ok(L, "the VT layer is attached");
    for (const m of [MOVER, OTHER]) assert.equal(L.library.importMeta(m.name, JSON.stringify(m), "json").ok, true);
    const smiSince = (k) => calls.slice(k).filter((c) => c.startsWith("setMovementInput"));
    // Load + enable the mover and let the meta press forward (a real rule).
    const press = () => {
      L.vars.set("session", "ret", 0); // session vars outlive the bot (page session)
      assert.equal(L.library.loadMeta("mover").ok, true);
      L.options.set("EnableMeta", true, { source: "ui" });
      tick(4);
      const k = calls.length;
      L.vars.set("session", "go", 1);
      tick(4);
      assert.deepEqual(smiSince(k), ["setMovementInput(1,0,0,true)"], "the meta pressed forward");
      assert.equal(Number(L.expr.evaluate("getmotion[forward]")), 1);
      return calls.length;
    };
    await fn({ bot, L, tick, press, smiSince, calls });
    bot.stop();
    bot = null;
  } finally {
    if (bot) {
      try {
        bot.stop();
      } catch (_) {
        /* best effort */
      }
    }
    Date.now = realNow;
    console.log = realLog;
    console.warn = realWarn;
  }
}

const RELEASE = "setMovementInput(0,0,0,false)";

await check("control: while the meta stays enabled and running, a pressed key stays held", async () => {
  await withBot(({ tick, press, smiSince, bot }) => {
    const k = press();
    tick(20);
    assert.deepEqual(smiSince(k), [], "nothing released while running and enabled");
    assert.equal(bot.kernel.operatorHeld, false);
  });
});

await check("EnableMeta off through options.set (panel option / /rs opt) lets go within one heartbeat, bot still running", async () => {
  await withBot(({ L, tick, press, smiSince, bot }) => {
    const k = press();
    L.options.set("EnableMeta", false, { source: "ui" });
    tick(1);
    assert.deepEqual(smiSince(k), [RELEASE]);
    assert.equal(Number(L.expr.evaluate("getmotion[forward]")), 0, "getmotion reads the release");
    assert.equal(bot.kernel.operatorHeld, false, "not a STOP");
    tick(10);
    assert.deepEqual(smiSince(k), [RELEASE], "once per edge");
  });
});

await check("the panel toggle (engine.enabled = false) and `/vt meta disable` let go", async () => {
  await withBot(({ L, tick, press, smiSince }) => {
    let k = press();
    L.meta.enabled = false;
    tick(1);
    assert.deepEqual(smiSince(k), [RELEASE], "engine.enabled = false");
    k = press();
    L.runChat("/vt meta disable", { source: "ui" });
    tick(1);
    assert.deepEqual(smiSince(k), [RELEASE], "/vt meta disable");
  });
});

await check("a Return From Call on an empty stack disables the meta and lets go", async () => {
  await withBot(({ L, tick, press, smiSince }) => {
    const k = press();
    L.vars.set("session", "ret", 1);
    tick(4);
    assert.equal(L.meta.enabled, false, "the meta disabled itself");
    assert.deepEqual(smiSince(k), [RELEASE]);
  });
});

await check("loading another meta or unloading it lets go at once", async () => {
  await withBot(({ L, press, smiSince }) => {
    let k = press();
    assert.equal(L.library.loadMeta("other").ok, true);
    assert.deepEqual(smiSince(k), [RELEASE], "load");
    k = press();
    L.meta.unload();
    assert.deepEqual(smiSince(k), [RELEASE], "unload");
  });
});

console.log(fail === 0 ? `rynth_meta_disable_release: all ${pass} checks passed` : `rynth_meta_disable_release: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
