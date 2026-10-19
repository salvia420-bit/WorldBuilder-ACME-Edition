// tests/rynth_vt_wiring.test.mjs — the VTank layer wired into the REAL
// createGrindBot (PLAN INT-2, §5 bot.js / operator_stop.js / unwedge.js /
// control_channel.js rows; K9, D26, D36; V-1, V-6, V-7, V-9, V-11, V-21).
//
// A fake SessionHandle under the real RynthWebHost; the Worker heartbeat is a
// FakeWorker that never ticks by itself — every heartbeat is an explicit
// host._tick(), so the order of the tick closures is observable.
//   * bot.vt present by default; absent on a flat rynth/*.js copy (no vt/) and
//     with config.vt === false (the kernel then has no aux at all);
//   * the VT pre-tick runs BEFORE the kernel tick; one VT host.onEvent and two
//     VT host.onTick closures per bot (V-9);
//   * `!bot rs opt get AttackDistance` replies through the control channel;
//     `!bot rs mexec 1  +  2` reaches the dispatcher with its spacing (B9);
//   * OperatorControl.setEnabled("nav"|"meta") toggles EnableNavigation /
//     EnableMeta; cancelTravel pauses VT nav (B1) — nothing re-issues for 20
//     heartbeats — while stop()+resume() continues the route at its index;
//   * the explore-pressure gate stays closed while a VT route is enabled;
//   * doFollowRoute overrides a VT-nav-only walk and refuses other claims;
//   * unwedge escalation (recall/@teleloc) is suppressed while VT nav owns a
//     live route (D26);
//   * under an operator hold a queued delayexec and a `/ub delay` produce no
//     host action until RESUME (V-7, critic S1);
//   * a createVtLayer that never resolves lets createGrindBot return after
//     the bounded wait, and a late resolve after bot.stop() is disposed (B5);
//   * host.nearbyRangeM keeps a configured 100 (B6); acquireRangeFn is set
//     with a DEFAULT-only list (G9); bot.stop() disposes the layer;
//   * layer.library round-trips a .met fixture and a .utl fixture.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_wiring.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HW = path.resolve(HERE, "..");

class FakeWorker {
  constructor() {
    this.onmessage = null;
  }
  postMessage() {}
  terminate() {}
}
globalThis.Worker = FakeWorker;
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:vt-wiring";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};

const { createGrindBot, ExplorePressureController } = await import("../rynth/bot.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n       ") : e}`);
  }
}

// Silence the bot's own console chatter ([kernel] started, [vt] …).
const realLog = console.log;
const realWarn = console.warn;
const keep = (a) => typeof a[0] === "string" && /^ {2}(ok|FAIL) |^rynth_vt_wiring:/.test(a[0]);
console.log = (...a) => { if (keep(a)) realLog(...a); };
console.warn = () => {};

const LB = 0xa9b40015;
let nextGuid = 0x50000100;
function fakeSession({ guid = nextGuid++ } = {}) {
  const S = { guid, calls: [], sent: [], tells: [], pose: { landblockId: LB, x: 100, y: 100, z: 0, heading: 0 } };
  const rec = (n) => (...a) => { S.calls.push(n); };
  const s = {
    isPlayerReady: () => true,
    playerGuid: () => guid,
    getLocalPlayerPose: () => ({ ...S.pose }),
    objectName: (g) => (g === guid ? "Tester" : undefined),
    moveToPosition: rec("moveToPosition"),
    cancelPursuit: rec("cancelPursuit"),
    stopStick: rec("stopStick"),
    pursuitStatus: () => 0,
    sendChat: (t) => { S.calls.push("sendChat"); S.sent.push(t); },
    sendTell: (n, t) => { S.calls.push("sendTell"); S.tells.push([n, t]); },
    nearbyEntityGuids: () => [],
    playerKnownSpells: () => [],
    teleToLifestone: rec("teleToLifestone"),
    setMovementInput: rec("setMovementInput"),
    turnToHeading: rec("turnToHeading"),
  };
  return { s, S };
}
const QUIET = { hz: 10, ai: false, control: false };
const tick = (bot, n = 1) => { for (let i = 0; i < n; i++) bot.host._tick(); };
const route3 = () => ({ routeType: 1, points: [0, 1, 2].map((i) => ({ type: 0, ew: 41.6 + i * 0.05, ns: 33.6, z: 0 })) });

function copyTree(src, dst, { flat = false } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === "testdata" || ent.name === "__pycache__") continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      if (!flat) copyTree(s, d);
    } else if (/\.(js|json)$/.test(ent.name)) fs.copyFileSync(s, d);
  }
}
function stage({ flat = false, stubIndex = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-vt-wiring-"));
  copyTree(path.join(HW, "rynth"), path.join(tmp, "rynth"), { flat });
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  if (stubIndex) fs.writeFileSync(path.join(tmp, "rynth", "vt", "index.js"), stubIndex);
  return tmp;
}
function unstage(tmp) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* leave it */
  }
}

delete globalThis.__rynthVtSessions;

await check("bot.vt present by default: its aux slots in the kernel (rank order), planner detached, acquireRangeFn set (G9), stop() disposes", async () => {
  const { s } = fakeSession();
  const bot = await createGrindBot(s, { ...QUIET });
  try {
    assert.ok(bot.vt, "bot.vt");
    assert.equal(bot.vt.disposed, false);
    assert.deepEqual(bot.kernel.aux.slots.map((x) => x.name), bot.vt.auxSlotOrder);
    assert.equal(bot.combat.vt, null);
    assert.equal(typeof bot.combat.acquireRangeFn, "function");
    assert.equal(bot.combat.acquireRangeFn(40), 40);
    assert.equal(bot.unwedge.allowEscalation(), true);
    tick(bot, 5);
    assert.equal(bot.kernel.action, "Idle");
    assert.equal(Object.prototype.hasOwnProperty.call(bot.kernel.status, "aux"), false, "status shape unchanged at Default");
  } finally {
    bot.stop();
  }
  assert.equal(bot.vt.disposed, true, "bot.stop() disposes the layer");
  assert.equal(bot.combat.vt, null);
  assert.equal(bot.combat.acquireRangeFn, null);
  assert.equal(bot.kernel.aux.slots.length, 0);
});

await check("config.vt === false: no bot.vt, the kernel has NO aux (literal ladder); `!bot rs` gets the not-loaded reply", async () => {
  const { s, S } = fakeSession();
  const chat = [];
  globalThis.__appendChatLine = (t) => chat.push(String(t));
  const bot = await createGrindBot(s, { hz: 10, ai: false, vt: false });
  try {
    assert.equal(bot.vt, undefined);
    assert.equal(bot.kernel.aux, null);
    assert.equal(bot.combat.acquireRangeFn, null);
    tick(bot, 1);
    bot.host._dispatchEvent({ kind: 2, stringPayload: 'You think, "!bot rs opt get AttackDistance"', u32Payload: 0, u32Payload2: 0 });
    assert.ok(chat.some((t) => /rs unavailable — the VTank layer is not loaded/.test(t)), JSON.stringify(chat));
    assert.deepEqual(S.sent, []);
  } finally {
    bot.stop();
    delete globalThis.__appendChatLine;
  }
});

await check("flat rynth/*.js copy (no vt/): the bot boots exactly as before — no bot.vt, no aux", async () => {
  const tmp = stage({ flat: true });
  try {
    const M = await import(pathToFileURL(path.join(tmp, "rynth", "bot.js")).href);
    const { s } = fakeSession();
    const bot = await M.createGrindBot(s, { ...QUIET });
    try {
      assert.equal(bot.vt, undefined);
      assert.equal(bot.kernel.aux, null);
      assert.equal(bot.control, undefined, "no ai/ either (flat copy)");
      tick(bot, 3);
    } finally {
      bot.stop();
    }
  } finally {
    unstage(tmp);
  }
});

await check("V-9 + order: the VT pre-tick runs BEFORE the kernel tick; +1 host.onEvent and +2 host.onTick closures vs config.vt=false", async () => {
  const a = await createGrindBot(fakeSession().s, { ...QUIET, vt: false });
  const b = await createGrindBot(fakeSession().s, { ...QUIET });
  try {
    assert.equal(b.host._onEvent.length - a.host._onEvent.length, 1, "exactly one VT event subscription");
    assert.equal(b.host._onTick.length - a.host._onTick.length, 2, "the pre-tick + the post-tick closures");
    const order = [];
    const pre = b.vt.preTick;
    b.vt.preTick = (...x) => { order.push("vtPre"); return pre(...x); };
    const kt = b.kernel.tick.bind(b.kernel);
    b.kernel.tick = () => { order.push("kernel"); return kt(); };
    const post = b.vt.postTick;
    b.vt.postTick = (...x) => { order.push("vtPost"); return post(...x); };
    tick(b, 2);
    assert.deepEqual(order, ["vtPre", "kernel", "vtPost", "vtPre", "kernel", "vtPost"]);
  } finally {
    a.stop();
    b.stop();
  }
});

await check("review wiring-2: a bot booted under a persisted STOP (startHeld) and resumed via bot.control.resume() keeps vtPre → kernel → vtPost; no item reflex shares a heartbeat with the kernel leaving Idle (V-22)", async () => {
  const b = await createGrindBot(fakeSession().s, { ...QUIET, startHeld: true });
  try {
    assert.equal(b.kernel.operatorHeld, true, "booted held");
    const order = [];
    const pre = b.vt.preTick;
    b.vt.preTick = (...x) => { order.push("vtPre"); return pre(...x); };
    const kt = b.kernel.tick.bind(b.kernel);
    b.kernel.tick = () => { order.push("kernel"); return kt(); };
    const post = b.vt.postTick;
    b.vt.postTick = (...x) => { order.push("vtPost"); return post(...x); };
    tick(b, 1);
    assert.deepEqual(order, ["vtPre", "vtPost"], "held: no kernel tick");
    b.control.resume();
    assert.equal(b.kernel.running, true, "RESUME started the kernel");
    order.length = 0;
    tick(b, 2);
    assert.deepEqual(order, ["vtPre", "kernel", "vtPost", "vtPre", "kernel", "vtPost"], "§3.3 order after a held boot");
    // V-22 in the shape of the verifier's probe: the inventory reflex is a recorder, the kernel leaves
    // Idle for Buffing on a post-tick heartbeat; the reflex gate must see that heartbeat's action.
    let hb = 0;
    const events = [];
    const inv = b.vt.support.inventory.reflex;
    inv.enabled = () => true;
    inv.tick = (_t, info) => events.push({ hb, what: "reflex", saw: info.kernelAction });
    let flipAt = Infinity;
    b.kernel._buffNeeded = () => hb >= flipAt;
    b.kernel.buff = {
      enabled: true, pending: null, startedAt: 1, status: { ready: true, active: 0, desired: 0, pending: 0 },
      tick: () => events.push({ hb, what: "cast" }),
    };
    while (!events.length && hb < 20) { hb++; tick(b, 1); }
    assert.ok(events.length, "the reflex runs while Idle");
    const h0 = hb;
    flipAt = h0 + 5; // the next post-tick heartbeat
    for (let i = 0; i < 8; i++) { hb++; tick(b, 1); }
    const at = events.filter((e) => e.hb === flipAt).map((e) => e.what);
    assert.ok(at.includes("cast"), `the kernel buffs at hb ${flipAt}: ${JSON.stringify(events)}`);
    assert.ok(!at.includes("reflex"), `an item reflex in the same heartbeat as the cast: ${JSON.stringify(events)}`);
  } finally {
    b.stop();
  }
});

await check("`!bot rs opt get AttackDistance` replies via the control channel; `!bot rs mexec 1  +  2` keeps its spacing (B9)", async () => {
  const { s, S } = fakeSession();
  const chat = [];
  globalThis.__appendChatLine = (t) => chat.push(String(t));
  const bot = await createGrindBot(s, { hz: 10, ai: false });
  try {
    tick(bot, 1);
    bot.host._dispatchEvent({ kind: 2, stringPayload: 'You think, "!bot rs opt get AttackDistance"', u32Payload: 0, u32Payload2: 0 });
    assert.ok(chat.some((t) => /^\[!bot\] \[RynthSuite\] AttackDistance = 0\.1666667$/.test(t)), JSON.stringify(chat));
    assert.equal(chat.filter((t) => /AttackDistance = /.test(t)).length, 1, "printed once (the dispatcher does not print for source tell)");
    const seen = [];
    const run = bot.vt.rs.run;
    bot.vt.rs.run = (line, o) => { seen.push([line, o && o.source]); return run(line, o); };
    chat.length = 0;
    bot.host._dispatchEvent({ kind: 2, stringPayload: 'You think, "!bot rs mexec 1  +  2"', u32Payload: 0, u32Payload2: 0 });
    assert.deepEqual(seen, [["/rs mexec 1  +  2", "tell"]]);
    assert.ok(chat.some((t) => /\[Number\] 3/.test(t)), JSON.stringify(chat));
    bot.host._dispatchEvent({ kind: 2, stringPayload: 'You think, "!bot vt opt set AttackDistance 0.0833"', u32Payload: 0, u32Payload2: 0 });
    assert.ok(Math.abs(bot.combat.monsterRangeM - 19.992) < 1e-6, "`!bot vt opt set` applies");
    assert.deepEqual(S.sent, [], "nothing reaches the server");
  } finally {
    bot.stop();
    delete globalThis.__appendChatLine;
  }
});

await check("review safety-5: a non-TELL chat line that reads like a tell (an emote by a player named 'You') never runs a command; the TELL-category line does", async () => {
  const { s, S } = fakeSession();
  const chat = [];
  globalThis.__appendChatLine = (t) => chat.push(String(t));
  const bot = await createGrindBot(s, { hz: 10, ai: false });
  try {
    tick(bot, 1);
    const seen = [];
    const run = bot.vt.rs.run;
    bot.vt.rs.run = (line, o) => { seen.push(line); return run(line, o); };
    const n0 = bot.channel.commands.length;
    // src/session/messages/chat.rs EmoteText / SoulEmote: kind 2, `<name> <text>`, u32b CHAT_CATEGORY_EMOTE (4).
    // Local speech (1) and a channel line (3) are refused the same way.
    for (const cat of [4, 1, 3]) {
      bot.host._dispatchEvent({ kind: 2, stringPayload: 'You think, "!bot rs mexec 1  +  2"', u32Payload: 0, u32Payload2: cat });
      bot.host._dispatchEvent({ kind: 2, stringPayload: 'Tester tells you, "!bot pause"', u32Payload: 0, u32Payload2: cat });
    }
    assert.deepEqual(seen, [], "the dispatcher never ran");
    assert.equal(bot.channel.commands.length, n0, "no command recorded");
    assert.equal(bot.kernel.operatorHeld, false, "`!bot pause` in an emote did not pause");
    assert.deepEqual(chat.filter((t) => /^\[!bot\]/.test(t)), [], "no reply printed");
    assert.deepEqual(S.tells, [], "no reply told");
    // The same text as a real tell (CHAT_CATEGORY_TELL = 2) still runs as the character itself.
    bot.host._dispatchEvent({ kind: 2, stringPayload: 'You think, "!bot rs mexec 1  +  2"', u32Payload: 3, u32Payload2: 2 });
    assert.deepEqual(seen, ["/rs mexec 1  +  2"]);
    assert.ok(chat.some((t) => /\[Number\] 3/.test(t)), JSON.stringify(chat));
    assert.deepEqual(S.sent, [], "nothing reaches the server");
  } finally {
    bot.stop();
    delete globalThis.__appendChatLine;
  }
});

await check("OperatorControl: setEnabled('nav'|'meta') toggles EnableNavigation/EnableMeta; state().subsystems reports them", async () => {
  const bot = await createGrindBot(fakeSession().s, { ...QUIET });
  try {
    const o = bot.vt.options;
    assert.equal(bot.control.state().subsystems.nav, false);
    assert.equal(bot.control.setEnabled("nav", true).ok, true);
    assert.equal(o.getValue("EnableNavigation"), true);
    assert.equal(bot.control.state().subsystems.nav, true);
    assert.equal(bot.control.setEnabled("meta", true).ok, true);
    assert.equal(o.getValue("EnableMeta"), true);
    assert.equal(bot.control.setEnabled("nav", false).ok, true);
    assert.equal(o.getValue("EnableNavigation"), false);
  } finally {
    bot.stop();
  }
  const noVt = await createGrindBot(fakeSession().s, { ...QUIET, vt: false });
  try {
    assert.equal(noVt.control.state().subsystems.nav, null, "no layer ⇒ no nav loop");
    assert.equal(noVt.control.setEnabled("nav", true).ok, false);
  } finally {
    noVt.stop();
  }
});

await check("cancelTravel while VT nav walks ⇒ paused 'operator cancel', no new leg for 20 heartbeats; stop()+resume() continues at the same index (B1, V-21)", async () => {
  const { s } = fakeSession();
  const bot = await createGrindBot(s, { ...QUIET });
  try {
    const nav = bot.vt.nav;
    assert.equal(nav.load(route3(), { name: "lap" }).ok, true);
    nav.setActive(1);
    nav.setEnabled(true);
    tick(bot, 3);
    assert.equal(bot.kernel.action, "Navigate");
    assert.equal(nav.ownsRouterWalk(), true, "VT nav walks its leg");
    assert.equal(bot.movementClaimed(), true);
    // operator STOP + RESUME: VT pause semantics — same waypoint afterwards
    bot.control.stop({ persist: false, reason: "test" });
    tick(bot, 5);
    assert.equal(nav.ownsRouterWalk(), false, "held ⇒ our leg is yielded");
    assert.equal(nav.paused, null, "STOP does not pause VT nav");
    bot.control.resume();
    tick(bot, 3);
    assert.equal(nav.status().i, 1, "same index after RESUME");
    assert.equal(nav.ownsRouterWalk(), true, "the walk continues");
    // the HUD's "stop moving"
    bot.control.cancelTravel();
    assert.equal(nav.paused && nav.paused.reason, "operator cancel");
    let rewalked = 0;
    for (let i = 0; i < 20; i++) {
      tick(bot, 1);
      if (nav.ownsRouterWalk() || bot.router.status.state === "WALK") rewalked++;
    }
    assert.equal(rewalked, 0, "nothing re-issues the leg while paused");
    assert.equal(bot.kernel.action, "Idle");
    nav.resume();
    tick(bot, 2);
    assert.equal(nav.ownsRouterWalk(), true, "resume() / nav start re-issues");
    assert.equal(nav.status().i, 1);
  } finally {
    bot.stop();
  }
});

await check("review guide-1/wiring-1 (V-23): a due BuffItem gets the tick while a Circular VT route runs, unboosted and under Boost Nav — UseObject once, then Navigate resumes; a pinned Navigate is never preempted", async () => {
  const BEER = 0x7100beef;
  const SPELL = 9999;
  const FAM = 777;
  const DUR = 3600;
  const realNow = Date.now;
  for (const boost of [false, true]) {
    let fake = realNow();
    Date.now = () => fake;
    const { s, S } = fakeSession();
    const ench = [];
    const uses = [];
    s.getBusyState = () => 0;
    s.playerInventory = () => [{ guid: BEER, name: "Amber Ape", wcid: 4321, stackSize: 5, containerId: S.guid, itemType: 0x20 }];
    s.getSpellRecord = (id) => (id === SPELL ? { id, name: "Brew", category: FAM, duration: DUR, isBeneficial: true } : null);
    s.playerEnchantments = () => ench.map((r) => ({ ...r }));
    s.useObject = (g) => {
      uses.push(g);
      if (g === BEER && !ench.length) ench.push({ spellId: SPELL, spellCategory: FAM, startTime: 0, duration: DUR, layer: 1 });
      return true;
    };
    const bot = await createGrindBot(s, { ...QUIET });
    try {
      const L = bot.vt;
      const add = L.consumables.add({ guid: BEER, name: "Amber Ape", wcid: 4321, type: "BuffItem", spellIds: [SPELL], durationS: DUR });
      assert.equal(add.ok, true, JSON.stringify(add));
      L.nav.load(route3());
      L.options.set("EnableNavigation", true, { source: "ui" });
      if (boost) L.options.set("BoostNavPriority", true, { source: "ui" });
      assert.equal(L.nav.slot.rank(), boost ? "beforeCombat" : "beforeIdle");
      // An executor in flight (recall / portal / jump) keeps the tick even while the beer is due.
      L.nav._pinned = () => true;
      assert.equal(L.nav.slot.wants({}), true, "pinned Navigate never yields");
      fake += 100;
      tick(bot, 1);
      assert.equal(bot.kernel.action, "Navigate");
      assert.deepEqual(uses, [], "no use while Navigate is pinned");
      delete L.nav._pinned; // back to the prototype's real check
      const actions = [];
      for (let i = 0; i < 100; i++) {
        fake += 100;
        tick(bot, 1);
        actions.push(bot.kernel.action);
      }
      const first = actions.indexOf("BuffItems");
      assert.ok(first >= 0, `${boost ? "boosted" : "unboosted"}: BuffItems never got the tick: ${[...new Set(actions)]}`);
      assert.deepEqual(uses, [BEER], `${boost ? "boosted" : "unboosted"}: the beer is used exactly once`);
      assert.ok(actions.slice(first).includes("Navigate"), "Navigate resumes after the use");
      assert.equal(actions[actions.length - 1], "Navigate", "and keeps the tick once the buff is on");
      assert.equal(L.support.buffItems.slot.status.confirmed, 1, "the item buff confirmed");
    } finally {
      bot.stop();
      Date.now = realNow;
    }
  }
});

await check("explore pressure never fights VT nav: _gatesOpen is closed while a VT route is enabled", async () => {
  const host = { IsPortalSpaceActive: () => false };
  const router = { status: { state: "IDLE" } };
  const ep = new ExplorePressureController(host, router, {}, { isOperatorStopLatched: () => false }, { now: () => 10_000_000 });
  let navOn = false;
  ep.bot = {
    ai: { director: { enabled: true, isBusy: () => false } },
    movementClaimed: () => false,
    kernel: { operatorHeld: false },
    vt: { nav: { slot: { enabled: () => navOn } } },
  };
  ep._lastMoveAt = 0;
  ep._lastStepAt = 0;
  assert.equal(ep._gatesOpen(10_000_000), true, "open without a VT route");
  navOn = true;
  assert.equal(ep._gatesOpen(10_000_000), false, "closed while VT nav has an enabled route");
  ep.bot.vt = undefined;
  assert.equal(ep._gatesOpen(10_000_000), true, "a bot without the layer is unaffected");
});

await check("doFollowRoute: last command wins over a VT-nav-only walk; any other claim still refuses (D36, V-11)", async () => {
  const bot = await createGrindBot(fakeSession().s, { ...QUIET });
  try {
    const nav = bot.vt.nav;
    nav.load(route3(), { name: "lap" });
    nav.setEnabled(true);
    tick(bot, 3);
    assert.equal(nav.ownsRouterWalk(), true);
    const legs = [{ lb: LB, x: 150, y: 150, z: 0 }];
    const r = await bot.followRoute(legs, { pollMs: 5, timeoutMs: 30 });
    assert.notEqual(r.error, "goto active", "the VT walk does not block a HUD/director route");
    assert.equal(nav.ownsRouterWalk(), false, "VT nav yielded its leg");
    assert.equal(nav.status().i, 0, "index kept");
    // another mover's claim refuses as before
    const release = bot.claimMovement("ai-approach");
    tick(bot, 3);
    const r2 = await bot.followRoute(legs, { pollMs: 5, timeoutMs: 30 });
    assert.equal(r2.error, "goto active");
    release();
    // a Pause dwell's claim ("vt-nav") is VT nav's own: overridden
    nav.load({ routeType: 1, points: [{ type: 3, ew: 41.6, ns: 33.6, z: 0, pauseMs: 60_000 }] }, { name: "wait" });
    tick(bot, 3);
    assert.equal(bot.movementClaimed(), true, "the dwell holds claimMovement('vt-nav')");
    const r3 = await bot.followRoute(legs, { pollMs: 5, timeoutMs: 30 });
    assert.notEqual(r3.error, "goto active");
  } finally {
    bot.stop();
  }
});

await check("unwedge: recall/@teleloc escalation suppressed while VT nav owns a live route (D26); allowed otherwise", async () => {
  const { s, S } = fakeSession();
  const bot = await createGrindBot(s, { ...QUIET });
  try {
    const u = bot.unwedge;
    const nav = bot.vt.nav;
    nav.load(route3(), { name: "lap" });
    nav.setEnabled(true);
    assert.equal(u.allowEscalation(), false);
    u.state = "RECALL";
    u._startRecall();
    assert.equal(u.state, "MONITOR");
    assert.equal(u.lastResult && u.lastResult.why, "escalation suppressed (VT nav)");
    assert.ok(u._cooldownUntil > Date.now(), "the FAILED end arms the cooldown");
    assert.deepEqual(S.sent, [], "no @teleloc");
    nav.pause("test");
    assert.equal(u.allowEscalation(), true, "a paused route hands escalation back");
    nav.resume();
    nav.setEnabled(false);
    assert.equal(u.allowEscalation(), true);
  } finally {
    bot.stop();
  }
});

await check("unwedge ADMIN rung: no @teleloc while VT nav owns a live route, even when the recall rung already started (D26)", async () => {
  const { s, S } = fakeSession();
  const bot = await createGrindBot(s, { ...QUIET });
  try {
    const u = bot.unwedge;
    const nav = bot.vt.nav;
    u.recallTune.adminTeleWaitMs = 60;
    u.recallTune.teleportPollMs = 10;
    u.adminTeleFallback = true;
    u._crumbs = [{ cell: LB, x: 90, y: 90, z: 0, wx: 0, wy: 0, t: 0 }];
    nav.load(route3(), { name: "lap" });
    nav.setEnabled(true);
    // the RECALL rung is already past its own gate (a route enabled mid-recall)
    u.state = "RECALL";
    await u._doRecall();
    assert.equal(u.state, "MONITOR");
    assert.equal(u.lastResult && u.lastResult.why, "escalation suppressed (VT nav)");
    assert.ok(!S.sent.some((t) => /@teleloc/.test(t)), `no @teleloc: ${JSON.stringify(S.sent)}`);
  } finally {
    bot.stop();
  }
});

await check("cancelTravel without a VT route leaves VT nav unpaused (an empty route is never flagged)", async () => {
  const bot = await createGrindBot(fakeSession().s, { ...QUIET });
  try {
    assert.equal(bot.vt.nav.hasRoute(), false);
    bot.control.cancelTravel();
    assert.equal(bot.vt.nav.paused, null);
  } finally {
    bot.stop();
  }
});

await check("V-7: under an operator hold a queued delayexec and a `/ub delay` produce NO host action until RESUME (critic S1)", async () => {
  const { s, S } = fakeSession();
  const bot = await createGrindBot(s, { ...QUIET });
  try {
    tick(bot, 1);
    bot.control.stop({ persist: false, reason: "test" });
    const r = bot.vt.rs.run("/ub delay 0 /say queued-by-ub", { source: "console" });
    assert.equal(r.handled, true);
    bot.vt.expr.delay(0, "chatbox[`/say queued-by-delayexec`]");
    S.calls.length = 0;
    tick(bot, 15);
    assert.deepEqual(S.sent, [], "nothing sent while held");
    assert.deepEqual(S.calls.filter((c) => c !== "cancelPursuit" && c !== "stopStick"), [], `host actions while held: ${S.calls.join(",")}`);
    bot.control.resume();
    tick(bot, 3);
    assert.ok(S.sent.includes("/say queued-by-ub"), JSON.stringify(S.sent));
    assert.ok(S.sent.includes("/say queued-by-delayexec"), JSON.stringify(S.sent));
  } finally {
    bot.stop();
  }
});

await check("B5: a createVtLayer that never resolves lets createGrindBot return after the bounded wait; a late resolve after bot.stop() is disposed; one before attaches", async () => {
  const stub = `
    export function createAuxShell() { return { slots: [], idleHooks: [], policy: { boostLoot: () => false }, status: () => ({}) }; }
    export function createVtLayer() { return globalThis.__vtStub.promise; }
  `;
  const tmp = stage({ stubIndex: stub });
  try {
    const M = await import(pathToFileURL(path.join(tmp, "rynth", "bot.js")).href);
    const mk = () => {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      globalThis.__vtStub = { promise, resolve };
      return globalThis.__vtStub;
    };
    // (a) never resolves before stop → disposed when it lands
    const st = mk();
    const t0 = Date.now();
    const bot = await M.createGrindBot(fakeSession().s, { ...QUIET, vtBootTimeoutMs: 120 });
    const dt = Date.now() - t0;
    assert.ok(dt < 2500, `createGrindBot returned after ${dt} ms`);
    assert.equal(bot.vt, undefined);
    bot.stop();
    let disposed = 0;
    st.resolve({ dispose: () => { disposed++; }, preTick: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(disposed, 1, "a layer landing after bot.stop() is disposed");
    assert.equal(bot.vt, undefined, "and never attached");
    // (b) resolves late but before stop → attached, its pre-tick runs
    const st2 = mk();
    const bot2 = await M.createGrindBot(fakeSession().s, { ...QUIET, vtBootTimeoutMs: 60 });
    try {
      assert.equal(bot2.vt, undefined);
      let pre = 0;
      const late = { dispose: () => {}, preTick: () => { pre++; } };
      st2.resolve(late);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(bot2.vt, late, "late attach");
      tick(bot2, 2);
      assert.equal(pre, 2);
    } finally {
      bot2.stop();
    }
  } finally {
    delete globalThis.__vtStub;
    unstage(tmp);
  }
});

await check("B6: a configured host.nearbyRangeM of 100 is kept; MonsterRange edits keep it as the floor", async () => {
  const bot = await createGrindBot(fakeSession().s, { ...QUIET, nearbyRangeM: 100 });
  try {
    assert.equal(bot.host.nearbyRangeM, 100);
    bot.vt.options.set("MonsterRange", 120, { source: "ui" });
    assert.equal(bot.host.nearbyRangeM, 125);
    bot.vt.options.set("MonsterRange", 30, { source: "ui" });
    assert.equal(bot.host.nearbyRangeM, 100);
  } finally {
    bot.stop();
  }
});

await check("layer.library round-trips a .met fixture and a .utl fixture (byte/text stable)", async () => {
  const bot = await createGrindBot(fakeSession().s, { ...QUIET });
  try {
    const lib = bot.vt.library;
    const met = new Uint8Array(fs.readFileSync(path.join(HW, "rynth/testdata/vt/meta/ColRings-c3986fd7f878c745.met")));
    const im = lib.importMeta("ColRings", met, "met");
    assert.equal(im.ok, true, im.error);
    assert.ok(lib.listMetas().some((m) => m.name === "ColRings"));
    const lm = lib.loadMeta("ColRings");
    assert.equal(lm.ok, true, lm.error);
    assert.equal(bot.vt.meta.meta().rules.length, 7);
    assert.equal(bot.vt.meta.state, "Default");
    assert.equal(bot.vt.options.getRef("metaName"), "ColRings");
    const ex = lib.exportMeta("ColRings", "met");
    assert.equal(ex.ok, true, ex.error);
    assert.ok(ex.data instanceof Uint8Array);
    assert.equal(Buffer.compare(Buffer.from(ex.data), Buffer.from(met)), 0, "the .met comes back byte-identical");
    const af = lib.exportMeta("ColRings", "af");
    assert.equal(af.ok, true);
    assert.equal(typeof af.data, "string");
    const utlText = fs.readFileSync(path.join(HW, "rynth/testdata/vt/loot/Aun_Amanaualuan_the_Elder_Shaman-3d8a214f11b3acbf.utl"), "utf8");
    const iu = lib.importLoot("Aun", utlText);
    assert.equal(iu.ok, true, iu.error);
    const eu = lib.exportLoot("Aun");
    assert.equal(eu.ok, true, eu.error);
    assert.equal(eu.text, utlText, "the .utl comes back text-identical");
    assert.equal(lib.loadLoot("Aun").ok, true);
    assert.equal(typeof bot.loot.classify, "function", "a loaded loot profile binds the loot loop's classify hook");
    assert.equal(bot.vt.options.getRef("lootProfile"), "Aun");
    assert.equal(lib.clearLoot().ok, true);
    assert.equal(bot.loot.classify, null, "cleared ⇒ today's Value floor");
    assert.equal(lib.putLoot("bad", { version: 1, rules: [{ name: "x", enabled: true, priority: 0, action: "Keep", conditions: [{ type: 424242, data: [] }] }] }).ok, false);
    assert.ok(Array.isArray(lib.lootNodeTypes()) && lib.lootNodeTypes().length === 31);
    assert.equal(lib.newLoot().version, 1);
    assert.equal(lib.loadMeta("nope").ok, false);
  } finally {
    bot.stop();
  }
});

console.log = realLog;
console.warn = realWarn;
console.log(fail === 0 ? `rynth_vt_wiring: all ${pass} checks passed` : `rynth_vt_wiring: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
